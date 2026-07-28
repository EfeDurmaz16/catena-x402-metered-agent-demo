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

/** BlockRun-style error bodies: `{"error": ...}` with no choices, or a
 * terminal job status that is not a successful delivery. */
function isErrorBody(body: unknown): boolean {
  if (typeof body === "string") {
    try {
      return isErrorBody(JSON.parse(body))
    } catch {
      return false
    }
  }
  if (typeof body !== "object" || body === null) return false
  if ("error" in body && !("choices" in body)) return true
  const status = (body as { status?: unknown }).status
  return status === "failed" || status === "cancelled" || status === "canceled"
}

/** True when a body still describes an unresolved async job. */
function isUnresolvedJob(body: unknown): boolean {
  let parsed = body
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return false
    }
  }
  if (typeof parsed !== "object" || parsed === null) return false
  if (!("status" in parsed)) return false
  return parsed.status === "queued" || parsed.status === "in_progress"
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

  if (outcome.status === "paid_but_error") {
    const amountMicros = outcome.amountMicros ?? authorizedMicros
    meter.record(config.MODEL, amountMicros)
    const settlementStatus = outcome.intentId
      ? (await readIntent(config.CATENA_BIN, outcome.intentId)).settlementStatus
      : undefined
    return {
      status: "paid_but_error",
      amountMicros,
      settlementStatus,
      body: outcome.body,
    }
  }
  if (outcome.status !== "paid") return outcome
  // Trust the CLI's reported charge; when absent, fall back to the amount we
  // AUTHORIZED (--maxAmount), not the probe quote: the CLI pays whatever the
  // seller's own challenge asks up to that ceiling, so recording the quote
  // could under-count a larger charge and let later calls slip past the cap.
  // Over-recording only makes the cap bind early, which is the safe error.
  const amountMicros = outcome.amountMicros ?? authorizedMicros
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
      const pollUrl = resolveSameOriginPollUrl(job.pollUrl, config.ENDPOINT_URL)
      if (!pollUrl) {
        body = {
          error:
            "paid job poll_url is not same-origin with the endpoint; refusing to follow it",
        }
      } else {
        body = await pollJob({
          pollUrl,
          paymentSignature,
          fetchImpl: fetchImpl ?? fetch,
          intervalMs: options.pollIntervalMs ?? 3000,
          maxMs: options.pollMaxMs ?? 180_000,
        })
      }
    }
  }

  // A queued/in_progress body that was never resolved (missing intent id or
  // signature, a body claiming queued without a usable poll_url, a
  // cross-origin poll_url, or a poll that timed out) must not read as a
  // delivered success.
  if (isUnresolvedJob(body)) {
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

/** Resolve a seller poll_url only when it stays on the endpoint's origin.
 * Absolute or protocol-relative URLs to other hosts are refused so a
 * hostile body cannot exfiltrate the payment signature via SSRF. */
function resolveSameOriginPollUrl(
  pollUrl: string,
  endpointUrl: string,
): string | undefined {
  try {
    const base = new URL(endpointUrl)
    const resolved = new URL(pollUrl, endpointUrl)
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return undefined
    }
    if (resolved.origin !== base.origin) return undefined
    return resolved.toString()
  } catch {
    return undefined
  }
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
  if (typeof parsed !== "object" || parsed === null) return undefined
  if (!("status" in parsed) || !("poll_url" in parsed)) return undefined
  if (parsed.status !== "queued" && parsed.status !== "in_progress") {
    return undefined
  }
  return typeof parsed.poll_url === "string"
    ? { pollUrl: parsed.poll_url }
    : undefined
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
    let response: Response
    try {
      response = await fetchImpl(pollUrl, {
        headers: {
          "payment-signature": paymentSignature,
          accept: "application/json",
        },
        // Bound each attempt by what is left of the deadline, so maxMs is a
        // real time limit rather than a loop-condition suggestion.
        signal: AbortSignal.timeout(
          Math.max(1, startedAt + maxMs - Date.now()),
        ),
      })
    } catch (error) {
      // A transport-level rejection after payment must not escape as an
      // unhandled error: keep polling, and if the deadline passes this body
      // reports as paid_but_error with reconciliation intact.
      const timedOut = error instanceof Error && error.name === "TimeoutError"
      last = {
        error: timedOut
          ? "poll timed out before a terminal status"
          : `poll failed: ${error instanceof Error ? error.message : String(error)}`,
      }
      continue
    }
    const parsed: unknown = await response.json().catch(() => undefined)
    // A transient gateway error (non-JSON body) is not a terminal answer:
    // keep polling until maxMs.
    if (typeof parsed !== "object" || parsed === null) {
      last = {
        error: `poll failed: HTTP ${response.status} with an unreadable body`,
      }
      continue
    }
    // A non-ok response is never a delivery, whatever its body claims: wrap
    // it so it cannot be mistaken for a result that lacks an error key.
    last = response.ok
      ? parsed
      : { error: `poll failed: HTTP ${response.status}`, body: parsed }
    const status = (parsed as { status?: unknown }).status
    if (status !== "queued" && status !== "in_progress") return last
  }
  // Still transitional at timeout: return an error body, never the last
  // in_progress object (which lacks poll_url and would look like success).
  if (isUnresolvedJob(last)) {
    return { error: "poll timed out before a terminal status" }
  }
  return last
}
