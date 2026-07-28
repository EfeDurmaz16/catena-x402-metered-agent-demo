import { payX402 } from "./catena-cli.js"
import { probeQuote } from "./challenge.js"
import type { Config } from "./config.js"
import type { SpendMeter } from "./meter.js"

export type MeteredCallResult =
  | { status: "paid"; amountMicros: bigint; body: unknown }
  | { status: "cap_reached"; priceMicros: bigint }
  | { status: "approval_pending"; intentId: string | undefined }
  | { status: "setup_required"; createCommand: string | undefined }
  | { status: "failed"; reason: string }

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
}): Promise<MeteredCallResult> {
  const { config, meter, prompt, fetchImpl } = options
  if (!config.CATENA_ACCOUNT_ID) {
    return {
      status: "failed",
      reason: "CATENA_ACCOUNT_ID is required to pay (see .env.example)",
    }
  }
  const requestBody = {
    model: config.MODEL,
    messages: [{ role: "user", content: prompt }],
  }

  let quote
  try {
    quote = await probeQuote({
      url: config.ENDPOINT_URL,
      body: requestBody,
      network: config.X402_NETWORK,
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

  const outcome = await payX402({
    bin: config.CATENA_BIN,
    url: config.ENDPOINT_URL,
    accountId: config.CATENA_ACCOUNT_ID,
    // CLI expects a plain USD decimal, e.g. "0.002" for $0.002.
    maxAmountUsd: config.PER_CALL_MAX_USD.slice(1),
    requestBody,
  })

  if (outcome.status !== "paid") return outcome
  // Trust the CLI's reported charge; fall back to the quote when absent.
  const amountMicros = outcome.amountMicros ?? quote.amountMicros
  meter.record(config.MODEL, amountMicros)
  return { status: "paid", amountMicros, body: outcome.body }
}
