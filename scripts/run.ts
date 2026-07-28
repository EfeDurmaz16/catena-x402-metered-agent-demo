/**
 * Runner: drive repeated metered calls against the paid endpoint until the
 * requested count is done or the spend cap refuses the next call.
 *
 * Usage: tsx scripts/run.ts [--calls N] [--prompt "..."]
 * Exits 0 on a clean run (including a clean cap stop), 2 on setup issues,
 * 1 on anything unexpected.
 */
import { runMeteredCall } from "../src/agent.js"
import { loadConfig, microsToMoney, moneyToMicros } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"

try {
  process.loadEnvFile()
} catch {
  // no .env file; environment variables may be set directly
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const config = loadConfig()
const calls = Number(argValue("--calls") ?? "3")
const prompt =
  argValue("--prompt") ?? "In one sentence: what is an x402 payment?"
if (!Number.isInteger(calls) || calls < 1) {
  console.error("--calls must be a positive integer")
  process.exit(2)
}

const meter = new SpendMeter(moneyToMicros(config.SPEND_CAP_USD))
console.log(`Endpoint: ${config.ENDPOINT_URL}`)
console.log(`Model:    ${config.MODEL}`)
console.log(
  `Cap:      ${config.SPEND_CAP_USD} total, ${config.PER_CALL_MAX_USD} per call\n`,
)

let outcome: "completed" | "cap_reached" | "approval_pending" = "completed"
let degraded = false
for (let i = 1; i <= calls; i++) {
  const result = await runMeteredCall({ config, meter, prompt })
  switch (result.status) {
    case "paid": {
      const preview = JSON.stringify(result.body ?? "").slice(0, 80)
      const settle = result.settlementStatus ?? "unknown"
      console.log(
        `call ${i}/${calls}: paid ${microsToMoney(result.amountMicros)} (intent ${settle}) -> ${preview}`,
      )
      break
    }
    case "paid_but_error": {
      const preview = JSON.stringify(result.body ?? "").slice(0, 80)
      const settle = result.settlementStatus ?? "unknown"
      console.log(
        `call ${i}/${calls}: authorized ${microsToMoney(result.amountMicros)} but the endpoint returned an error (intent ${settle}; a failed intent means Catena released the funds): ${preview}`,
      )
      degraded = true
      break
    }
    case "cap_reached":
      console.log(
        `call ${i}/${calls}: REFUSED before payment: next call costs ${microsToMoney(result.priceMicros)} but only ${microsToMoney(meter.capMicros - meter.totalMicros)} of the cap remains`,
      )
      outcome = "cap_reached"
      break
    case "approval_pending":
      console.log(
        `call ${i}/${calls}: PARKED for human approval (intent ${result.intentId ?? "unknown"}). Approve it in the Catena console, then re-run the same command; the retry consumes the approval.`,
      )
      outcome = "approval_pending"
      break
    case "setup_required":
      console.error(
        `call ${i}/${calls}: endpoint payTo is not a saved counterparty.\n${result.createCommand ?? "Create it in the Catena console, then re-run."}`,
      )
      process.exit(2)
      break
    case "failed":
      console.error(`call ${i}/${calls}: FAILED: ${result.reason}`)
      process.exit(1)
  }
  if (outcome !== "completed") break
}

console.log(`\nSpend: ${meter.summary()}`)
console.log(
  outcome === "completed"
    ? "DONE: all calls settled under the cap."
    : outcome === "cap_reached"
      ? "DONE: cap enforced; the over-cap call was refused before any payment."
      : "WAITING: a call is parked for human approval; nothing was charged for it.",
)
if (degraded) {
  console.error(
    "WARNING: at least one settled call returned an error body (charged without delivery); the endpoint, not the payment leg, failed.",
  )
  process.exitCode = 1
}
