/**
 * Runner: drive repeated metered calls against the paid endpoint until the
 * requested count is done or the spend cap refuses the next call.
 *
 * Usage: pnpm demo [--calls N] [--prompt "..."]
 * Exits 0 on a clean run (including a clean cap stop), 2 on setup issues,
 * 1 on anything unexpected.
 */
import { parseArgs } from "node:util"
import { parseBody, runMeteredCall } from "../src/agent.js"
import { loadConfig, microsToMoney } from "../src/config.js"
import type { Config } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

/** The delivered asset URL of a completed image job, when present. */
function deliveredUrl(body: unknown): string | undefined {
  return parseBody(body)?.data?.[0]?.url
}

let config: Config
try {
  config = loadConfig()
} catch (error) {
  console.error(
    `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
  )
  console.error(
    "Check .env against .env.example (money values look like $0.05).",
  )
  process.exit(2)
}
// missing account id is a setup problem, not an unexpected failure
if (!config.CATENA_ACCOUNT_ID) {
  console.error("CATENA_ACCOUNT_ID is required to pay (see .env.example)")
  process.exit(2)
}
let values: { calls?: string; prompt?: string }
try {
  // strict: an unknown or misspelled flag stops the run instead of being
  // silently ignored while the default spends money.
  ;({ values } = parseArgs({
    options: { calls: { type: "string" }, prompt: { type: "string" } },
    strict: true,
  }))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error('Usage: pnpm demo [--calls N] [--prompt "..."]')
  process.exit(2)
}
const calls = Number(values.calls ?? "3")
const prompt = values.prompt ?? "In one sentence: what is an x402 payment?"
if (!Number.isInteger(calls) || calls < 1) {
  console.error("--calls must be a positive integer")
  process.exit(2)
}

const meter = new SpendMeter(config.SPEND_CAP_USD)
console.log(`Endpoint: ${config.ENDPOINT_URL}`)
console.log(`Model:    ${config.MODEL}`)
console.log(
  `Cap:      ${microsToMoney(config.SPEND_CAP_USD)} total, ${microsToMoney(config.PER_CALL_MAX_USD)} per call\n`,
)

let outcome:
  | "completed"
  | "cap_reached"
  | "approval_pending"
  | "setup_required"
  | "failed" = "completed"
let chargedWithoutDelivery = false
const settleTally = new Map<string, number>()
function tally(settlementStatus: string | undefined): string {
  const settle = settlementStatus ?? "unknown"
  settleTally.set(settle, (settleTally.get(settle) ?? 0) + 1)
  return settle
}
for (let i = 1; i <= calls; i++) {
  const result = await runMeteredCall({ config, meter, prompt })
  switch (result.status) {
    case "paid": {
      const settle = tally(result.settlementStatus)
      const delivered = deliveredUrl(result.body)
      const preview =
        delivered ?? JSON.stringify(result.body ?? "").slice(0, 80)
      console.log(
        `call ${i}/${calls}: paid ${microsToMoney(result.amountMicros)} (intent ${settle}) -> ${preview}`,
      )
      break
    }
    case "paid_but_error": {
      const preview = JSON.stringify(result.body ?? "").slice(0, 80)
      const settle = tally(result.settlementStatus)
      console.log(
        `call ${i}/${calls}: authorized ${microsToMoney(result.amountMicros)} but the endpoint returned an error (intent ${settle}; a failed intent means Catena released the funds): ${preview}`,
      )
      chargedWithoutDelivery = true
      break
    }
    case "cap_reached": {
      // Clamped at zero so an over-settled meter reads as an empty budget.
      const left = meter.capMicros - meter.totalMicros
      console.log(
        `call ${i}/${calls}: REFUSED before payment: next call costs ${microsToMoney(result.priceMicros)} but only ${microsToMoney(left > 0n ? left : 0n)} of the cap remains`,
      )
      outcome = "cap_reached"
      break
    }
    case "approval_pending":
      console.log(
        `call ${i}/${calls}: PARKED for human approval (intent ${result.intentId ?? "unknown"})${result.reason ? `\n  reason: ${result.reason}` : ""}\n  Approve it in the Catena console, then re-run the same command; the retry consumes the approval.`,
      )
      outcome = "approval_pending"
      break
    case "setup_required":
      console.error(
        `call ${i}/${calls}: endpoint payTo is not a saved counterparty.\n${result.createCommand ?? "Create it in the Catena console, then re-run."}`,
      )
      console.error(
        "The --name above comes from the endpoint and is unverified; confirm it names a service you trust, or replace it, before running.",
      )
      outcome = "setup_required"
      break
    case "failed":
      console.error(`call ${i}/${calls}: FAILED: ${result.reason}`)
      console.error(
        `Common causes: the account holds no Base Sepolia USDC (check with "catena accounts balance ${config.CATENA_ACCOUNT_ID}", fund it at https://faucet.circle.com), or the wrong CLI profile is selected (check with "catena profiles current").`,
      )
      outcome = "failed"
      break
  }
  if (outcome !== "completed") break
}

const settlementLine = [...settleTally]
  .map(([status, count]) => `${count} ${status}`)
  .join(", ")
console.log(`\nSpend: ${meter.summary()}`)
console.log(`Settlement: ${settlementLine || "no payments"}`)
// Printed before the closing line: the last thing on screen must never be a
// clean DONE for a run that charged without delivering.
if (chargedWithoutDelivery) {
  console.error(
    "WARNING: at least one paid call returned an error body instead of a result; the endpoint, not the payment leg, failed. Check the intent status printed above - a failed intent means Catena released the funds.",
  )
}
switch (outcome) {
  case "completed":
    console.log(
      chargedWithoutDelivery
        ? "DONE with warnings: see the charged-without-delivery note above."
        : "DONE: all calls finished under the cap.",
    )
    break
  case "cap_reached":
    console.log(
      "DONE: cap enforced; the over-cap call was refused before any payment.",
    )
    break
  case "approval_pending":
    console.log(
      "WAITING: a call is parked for human approval; nothing was charged for it. Exit code 0: this is a normal outcome, not a failure.",
    )
    break
  case "setup_required":
    console.error("STOPPED: finish the setup step above, then re-run.")
    process.exitCode = 2
    break
  case "failed":
    console.error("STOPPED: a call failed; see the error above.")
    process.exitCode = 1
    break
}
if (chargedWithoutDelivery && process.exitCode === undefined) {
  process.exitCode = 1
}
