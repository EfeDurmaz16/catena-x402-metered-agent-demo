import { z } from "zod"
import { payX402, readIntent } from "./catena-cli.js"
import { probeQuote } from "./challenge.js"
import type { Quote } from "./challenge.js"
import { microsToMoney } from "./config.js"
import type { Config } from "./config.js"
import type { SpendMeter } from "./meter.js"

/** What a charged call reports, whatever the endpoint did with the money. */
interface Charged {
  amountMicros: bigint
  settlementStatus: string | undefined
  body: unknown
}

export type MeteredCallResult =
  | ({ status: "paid" } & Charged)
  /** The x402 exchange reported paid but the endpoint returned an error
   * body. Whether funds actually moved is what settlementStatus says: a
   * failed intent means Catena released the reserved funds. Surfaced
   * distinctly so a run never reads a charged failure as success. */
  | ({ status: "paid_but_error" } & Charged)
  | { status: "cap_reached"; priceMicros: bigint }
  | {
      status: "approval_pending"
      intentId: string | undefined
      reason: string | undefined
    }
  | {
      status: "setup_required"
      createCommand: string | undefined
      serviceName: string | undefined
      nameIsPlaceholder: boolean | undefined
    }
  | { status: "failed"; reason: string }

/**
 * The one shape every endpoint body is read through. Async job bodies arrive
 * from the CLI as a JSON string and from a poll already parsed, so the string
 * case is decoded first. Field-level `.catch` keeps an odd value in one field
 * from failing the whole parse: a body carrying `error` must still read as an
 * error when its `data` is malformed.
 */
const bodySchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value
    try {
      const decoded: unknown = JSON.parse(value)
      return decoded
    } catch {
      return value
    }
  },
  z.looseObject({
    status: z.string().optional().catch(undefined),
    poll_url: z.string().optional().catch(undefined),
    error: z.unknown().optional(),
    choices: z.unknown().optional(),
    data: z
      .array(z.looseObject({ url: z.string().optional() }))
      .optional()
      .catch(undefined),
  }),
)

/** Read an endpoint body; undefined when it is not a JSON object at all. */
export function parseBody(
  body: unknown,
): z.infer<typeof bodySchema> | undefined {
  const parsed = bodySchema.safeParse(body)
  return parsed.success ? parsed.data : undefined
}

/** BlockRun-style error bodies: `{"error": ...}` with no choices, or a
 * terminal job status that is not a successful delivery. */
function isErrorBody(body: unknown): boolean {
  const parsed = parseBody(body)
  if (!parsed) return false
  if (parsed.error !== undefined && parsed.choices === undefined) return true
  const { status } = parsed
  return status === "failed" || status === "cancelled" || status === "canceled"
}

/** True when a body still describes an unresolved async job. */
function isUnresolvedJob(body: unknown): boolean {
  const status = parseBody(body)?.status
  return status === "queued" || status === "in_progress"
}

export interface RunMeteredCallOptions {
  config: Config
  meter: SpendMeter
  prompt: string
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  pollMaxMs?: number
}

/**
 * One metered call: quote the price unpaid, refuse it if it would break the
 * spend cap, then pay through the Catena CLI and record the actual charge.
 * The cap check binds BEFORE money moves; --maxAmount caps the single call
 * as defense in depth even if the quote were stale.
 */
export async function runMeteredCall(
  options: RunMeteredCallOptions,
): Promise<MeteredCallResult> {
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

  let quote: Quote
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

  // Authorize the CLI for at most the smaller of the per-call ceiling and
  // the remaining run budget, so even a challenge that changed since the
  // quote cannot push the total past the cap. Reserving that ceiling (not
  // the quote) in the same tick as the check means a concurrent call sees
  // the worst case this one could spend, and no await sits between the two.
  const perCallMicros = config.PER_CALL_MAX_USD
  // Clamped at zero: a meter that settled above what it authorized must read
  // as "nothing left", never as a negative budget to authorize against.
  const remaining = meter.capMicros - meter.totalMicros
  const remainingMicros = remaining > 0n ? remaining : 0n
  const authorizedMicros =
    perCallMicros < remainingMicros ? perCallMicros : remainingMicros
  if (
    remainingMicros <= 0n ||
    remainingMicros < quote.amountMicros ||
    !meter.reserve(authorizedMicros)
  ) {
    return { status: "cap_reached", priceMicros: quote.amountMicros }
  }
  // The cap has room but the per-call ceiling does not: the CLI would refuse
  // this challenge at --maxAmount and report a generic failure, so name the
  // knob here instead. Checked after the cap so a genuine cap stop still
  // reports as one.
  if (quote.amountMicros > authorizedMicros) {
    meter.release(authorizedMicros)
    return {
      status: "failed",
      reason: `quoted price ${microsToMoney(quote.amountMicros)} exceeds PER_CALL_MAX_USD ${microsToMoney(perCallMicros)}; raise PER_CALL_MAX_USD`,
    }
  }

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
    meter.settle(config.MODEL, authorizedMicros, amountMicros)
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
  if (outcome.status !== "paid") {
    // Nothing was charged: hand the reservation back.
    meter.release(authorizedMicros)
    return outcome
  }
  // Trust the CLI's reported charge; when absent, fall back to the amount we
  // AUTHORIZED (--maxAmount), not the probe quote: the CLI pays whatever the
  // seller's own challenge asks up to that ceiling, so recording the quote
  // could under-count a larger charge and let later calls slip past the cap.
  // Over-recording only makes the cap bind early, which is the safe error.
  const amountMicros = outcome.amountMicros ?? authorizedMicros
  meter.settle(config.MODEL, authorizedMicros, amountMicros)

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

  // An image body that never decoded as JSON cannot be searched for the
  // delivered asset or for an error key, so it must not read as a delivery.
  if (
    config.ENDPOINT_KIND === "image" &&
    typeof body === "string" &&
    parseBody(body) === undefined
  ) {
    body = {
      error: "paid job body was not readable JSON; delivery unconfirmed",
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
  // Read AFTER the poll: the seller settles on the completing poll, so a
  // pre-poll read always reports pre-settlement status.
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
  const pollUrl = parseBody(body)?.poll_url
  return isUnresolvedJob(body) && pollUrl !== undefined
    ? { pollUrl }
    : undefined
}

interface PollJobOptions {
  pollUrl: string
  paymentSignature: string
  fetchImpl: typeof fetch
  intervalMs: number
  maxMs: number
}

/** Poll an async job until it leaves queued/in_progress or time runs out.
 * Sends the payment's own signature on every poll; the seller re-verifies
 * it and settles on the completing poll. */
async function pollJob(options: PollJobOptions): Promise<unknown> {
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
    if (!isUnresolvedJob(parsed)) return last
  }
  // Still transitional at timeout: return an error body, never the last
  // in_progress object (which lacks poll_url and would look like success).
  if (isUnresolvedJob(last)) {
    return { error: "poll timed out before a terminal status" }
  }
  return last
}
