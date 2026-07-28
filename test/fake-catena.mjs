#!/usr/bin/env node
/**
 * Stand-in for the Catena CLI in tests. Echoes the canned JSON result named
 * by FAKE_RESULT and exits with FAKE_EXIT (default 0). Records its argv to
 * FAKE_ARGS_FILE so tests can assert how the real CLI would be invoked.
 */
import { appendFileSync } from "node:fs"

const results = {
  paid: {
    paid: true,
    payment: {
      intentId: "int_test",
      amountAtomicUsdc: "1000",
      payTo: "0xpayto",
    },
    body: { choices: [{ message: { content: "hello from the paid model" } }] },
  },
  approval: {
    paid: false,
    approvalPending: {
      intentId: "int_approval",
      expiresAt: "2026-01-01T00:00:00Z",
      reasons: ["approval threshold exceeded: amount $0.021 against $0.015"],
    },
  },
  counterparty: {
    paid: false,
    counterpartyNotFound: {
      payTo: "0xpayto",
      createCommand: "catena counterparties create wallet --name '<name>' ...",
    },
  },
  "paid-queued": {
    paid: true,
    payment: {
      intentId: "int_test",
      amountAtomicUsdc: "21000",
      payTo: "0xpayto",
    },
    body: JSON.stringify({
      status: "queued",
      poll_url: "/poll/job1",
    }),
  },
  "paid-error": {
    paid: true,
    payment: {
      intentId: "int_test",
      amountAtomicUsdc: "1000",
      payTo: "0xpayto",
    },
    body: JSON.stringify({
      error: "Unexpected error",
      message: "upstream model failed after payment",
    }),
  },
  "retry-failed": {
    paid: true,
    retryFailed: true,
    payment: {
      intentId: "int_test",
      amountAtomicUsdc: "1000",
      payTo: "0xpayto",
    },
    error: "paid HTTP retry threw before a body came back",
  },
  "paid-queued-no-url": {
    paid: true,
    payment: {
      intentId: "int_test",
      amountAtomicUsdc: "1000",
      payTo: "0xpayto",
    },
    body: JSON.stringify({ status: "queued" }),
  },
  "paid-no-amount": {
    paid: true,
    payment: { intentId: "int_test", payTo: "0xpayto" },
    body: { choices: [{ message: { content: "ok" } }] },
  },
  "network-mismatch": {
    paid: false,
    networkMismatch: {
      requiredNetworks: ["base"],
      requiredNetworkIds: ["eip155:8453"],
    },
  },
  garbage: "not json at all",
}

if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(
    process.env.FAKE_ARGS_FILE,
    JSON.stringify(process.argv.slice(2)) + "\n",
  )
}
if (process.argv[2] === "intents") {
  console.log(
    JSON.stringify({
      id: process.argv[4] ?? "int_test",
      status: "completed",
      data: {
        x402: {
          paymentSignature: "sig-test",
          transaction: {
            status: process.env.FAKE_INTENT_STATUS ?? "completed",
          },
        },
      },
    }),
  )
  process.exit(0)
}

const key = process.env.FAKE_RESULT ?? "paid"
if (process.env.FAKE_KILL) {
  // Print partial output, then die by signal: models a killed CLI that may
  // already have submitted the payment.
  process.stdout.write('{"paid":true,')
  process.kill(process.pid, "SIGKILL")
}
if (key === "hard-fail") {
  // Non-zero exit with NO stdout: models the CLI dying before any result.
  process.stderr.write(process.env.FAKE_STDERR ?? "catena: not logged in")
  process.exit(1)
}
const result = results[key]
console.log(typeof result === "string" ? result : JSON.stringify(result))
process.exit(Number(process.env.FAKE_EXIT ?? "0"))
