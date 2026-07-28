import { payX402, readIntent } from "./catena-cli.js"
import { probeQuote } from "./challenge.js"
import { microsToMoney, moneyToMicros } from "./config.js"
import type { Config } from "./config.js"
import type { SpendMeter } from "./meter.js"

export type MeteredCallResult =
  | {
      status: "paid"
      amountMicros: bigint
      settlementStatus: string | undefined
      body: unknown
    }
  /** The x402 exchange reported paid but the endpoint returned an error
   * body. Whether funds actually moved is what settlementStatus says: a
   * failed intent means Catena released the reserved funds. Surfaced
   * distinctly so a run never reads a charged failure as success. */
  | {
      status: "paid_but_error"
      amountMicros: bigint
      settlementStatus: string | undefined
      body: unknown
    }
  | { status: "cap_reached"; priceMicros: bigint }
  | {
      status: "approval_pending"
      intentId: string | undefined
      reason: string | undefined
    }
  | { status: "setup_required"; createCommand: string | undefined }
  | { status: "failed"; reason: string }

/** BlockRun-style error bodies: `{"error": ...}` with no choices. */
function isErrorBody(body: unknown): boolean {
  if (typeof body === "string") {
    try {
      return isErrorBody(JSON.parse(body))
    } catch {
      return false
    }
  }
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    !("choices" in body)
  )
}

/**
 * One metered call: quote the price unpaid, refuse it if it would break the
 * spend cap, then pay through the Catena CLI and record the actual charge.
 * The cap check binds BEFORE money moves; --maxAmount caps the single call
 * as defense in depth even if the quote were stale.
 */
export async function runMeteredCall(options: {
  config: Config
  meter: SpendMeter
  prompt: string
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  pollMaxMs?: number
}): Promise<MeteredCallResult> {
  const { config, meter, prompt, fetchImpl } = options
  if (!config.CATENA_ACCOUNT_ID) {
    return {
      status: "failed",
      reason: "CATENA_ACCOUNT_ID is required to pay (see .env.example)",
    }
  }
  const requestBody =
    config.ENDPOINT_KIND === "image"
      ? { model: config.MODEL, prompt, size: "1024x1024" }
      : {
          model: config.MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 128,
        }

  let quote
  try {
    quote = await probeQuote({
      url: config.ENDPOINT_URL,
      body: requestBody,
      network: config.X402_NETWORK,
      asset: config.X402_ASSET,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  if (meter.wouldExceed(quote.amountMicros)) {
    return { status: "cap_reached", priceMicros: quote.amountMicros }
  }

  // Authorize the CLI for at most the smaller of the per-call ceiling and
  // the remaining run budget, so even a challenge that changed since the
  // quote cannot push the total past the cap.
  const perCallMicros = moneyToMicros(config.PER_CALL_MAX_USD)
  const remainingMicros = meter.capMicros - meter.totalMicros
  const authorizedMicros =
    perCallMicros < remainingMicros ? perCallMicros : remainingMicros
  const outcome = await payX402({
    bin: config.CATENA_BIN,
    url: config.ENDPOINT_URL,
    accountId: config.CATENA_ACCOUNT_ID,
    // CLI expects a plain USD decimal, e.g. "0.002" for $0.002.
    maxAmountUsd: microsToMoney(authorizedMicros).slice(1),
    requestBody,
  })

  if (outcome.status !== "paid") return outcome
  // Trust the CLI's reported charge; fall back to the quote when absent.
  // The meter records it either way: if settlement later fails, Catena
  // releases the reserved funds and the meter has merely been conservative.
  const amountMicros = outcome.amountMicros ?? quote.amountMicros
  meter.record(config.MODEL, amountMicros)

  // Async endpoints (image generation) answer the paid retry with a queued
  // job and a poll_url; the result is fetched by polling with the payment's
  // own signature, and the seller settles on the completing poll.
  let body = outcome.body
  const job = asQueuedJob(body)
  if (job && outcome.intentId) {
    const { paymentSignature } = await readIntent(
      config.CATENA_BIN,
      outcome.intentId,
    )
    if (paymentSignature) {
      body = await pollJob({
        pollUrl: new URL(job.pollUrl, config.ENDPOINT_URL).toString(),
        paymentSignature,
        fetchImpl: fetchImpl ?? fetch,
        intervalMs: options.pollIntervalMs ?? 3000,
        maxMs: options.pollMaxMs ?? 180_000,
      })
    }
  }

  // A queued job that was never resolved (missing intent id or signature to
  // poll with, or the poll timed out while still queued) must not read as a
  // delivered success: convert it to an error body so it reports as
  // paid_but_error and the runner exits non-zero.
  if (job && asQueuedJob(body)) {
    body = {
      error:
        "paid job result was never retrieved (missing intent/signature to poll, or poll timed out while still queued)",
    }
  }

  // Reconcile with the platform: "paid" in the x402 exchange is an
  // authorization; the intent's status says whether funds actually settled.
  const settlementStatus = outcome.intentId
    ? (await readIntent(config.CATENA_BIN, outcome.intentId)).settlementStatus
    : undefined
  if (isErrorBody(body)) {
    return { status: "paid_but_error", amountMicros, settlementStatus, body }
  }
  return { status: "paid", amountMicros, settlementStatus, body }
}

/** A 202-style queued/in-progress job body carrying a poll_url. */
function asQueuedJob(body: unknown): { pollUrl: string } | undefined {
  let parsed = body
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return undefined
    }
  }
  const job = parsed as { status?: unknown; poll_url?: unknown } | undefined
  if (
    (job?.status === "queued" || job?.status === "in_progress") &&
    typeof job.poll_url === "string"
  ) {
    return { pollUrl: job.poll_url }
  }
  return undefined
}

/** Poll an async job until it leaves queued/in_progress or time runs out.
 * Sends the payment's own signature on every poll; the seller re-verifies
 * it and settles on the completing poll. */
async function pollJob(options: {
  pollUrl: string
  paymentSignature: string
  fetchImpl: typeof fetch
  intervalMs: number
  maxMs: number
}): Promise<unknown> {
  const { pollUrl, paymentSignature, fetchImpl, intervalMs, maxMs } = options
  const startedAt = Date.now()
  let last: unknown = { error: "poll timed out before a terminal status" }
  while (Date.now() - startedAt < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    const response = await fetchImpl(pollUrl, {
      headers: {
        "payment-signature": paymentSignature,
        accept: "application/json",
      },
    })
    const parsed: unknown = await response.json().catch(() => undefined)
    // A transient gateway error (non-JSON body) is not a terminal answer:
    // keep polling until maxMs. A JSON object on a non-ok response IS the
    // seller's answer (e.g. a permanent failure) and terminates immediately;
    // isErrorBody downstream classifies it.
    if (typeof parsed !== "object" || parsed === null) {
      last = {
        error: `poll failed: HTTP ${response.status} with an unreadable body`,
      }
      continue
    }
    last = parsed
    const status = (parsed as { status?: unknown }).status
    if (status !== "queued" && status !== "in_progress") return last
  }
  return last
}
