import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { runMeteredCall } from "../src/agent.js"
import { payX402 } from "../src/catena-cli.js"
import { loadConfig, moneyToMicros } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"
import { startFakeEndpoint } from "./helpers.js"

const FAKE_BIN = fileURLToPath(new URL("./fake-catena.mjs", import.meta.url))

function testConfig(endpointUrl: string, env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    CATENA_ACCOUNT_ID: "acct_test",
    ENDPOINT_URL: endpointUrl,
    ENDPOINT_KIND: "chat",
    PER_CALL_MAX_USD: "$0.002",
    CATENA_BIN: process.execPath, // node; fake script passed via args below
    ...env,
  })
}

describe("payX402 result mapping", () => {
  async function run(fakeResult: string, exit = "0") {
    process.env.FAKE_RESULT = fakeResult
    process.env.FAKE_EXIT = exit
    try {
      return await payX402({
        bin: FAKE_BIN,
        url: "http://localhost/paid",
        accountId: "acct_test",
        maxAmountUsd: "0.002",
        requestBody: { model: "m" },
      })
    } finally {
      delete process.env.FAKE_RESULT
      delete process.env.FAKE_EXIT
    }
  }

  it("maps a successful payment with its settled amount", async () => {
    const outcome = await run("paid")
    expect(outcome).toMatchObject({ status: "paid", amountMicros: 1000n })
  })

  it("maps a parked approval even on a non-zero exit", async () => {
    const outcome = await run("approval", "1")
    expect(outcome).toMatchObject({
      status: "approval_pending",
      intentId: "int_approval",
    })
    if (outcome.status === "approval_pending") {
      expect(outcome.reason).toContain("approval threshold")
    }
  })

  it("maps a missing counterparty to setup_required with the create command", async () => {
    const outcome = await run("counterparty", "1")
    expect(outcome.status).toBe("setup_required")
    if (outcome.status === "setup_required") {
      expect(outcome.createCommand).toContain("counterparties create")
    }
  })

  it("fails closed on unrecognized output", async () => {
    const outcome = await run("garbage")
    expect(outcome.status).toBe("failed")
  })
})

describe("runMeteredCall", () => {
  it("quotes, pays via the CLI, and records the settled amount", async () => {
    const endpoint = await startFakeEndpoint()
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    process.env.FAKE_RESULT = "paid"
    process.env.FAKE_ARGS_FILE = argsFile
    try {
      const config = testConfig(endpoint.url, { CATENA_BIN: FAKE_BIN })
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid")
      expect(meter.totalMicros).toBe(1000n)
      // The CLI must be driven with the per-call ceiling and the account,
      // then re-invoked to reconcile the intent's settlement status.
      const lines = readFileSync(argsFile, "utf8").trim().split("\n")
      const args = JSON.parse(lines[0] ?? "[]") as string[]
      expect(args).toContain("--account=acct_test")
      expect(args).toContain("--maxAmount=0.002")
      expect(args).toContain("--json")
      const reconcile = JSON.parse(lines[1] ?? "[]") as string[]
      expect(reconcile.slice(0, 2)).toEqual(["intents", "get"])
      if (result.status === "paid") {
        expect(result.settlementStatus).toBe("completed")
      }
    } finally {
      delete process.env.FAKE_RESULT
      delete process.env.FAKE_ARGS_FILE
      await endpoint.close()
    }
  })

  it("refuses the call BEFORE paying when the cap would be exceeded", async () => {
    const endpoint = await startFakeEndpoint({ amount: "4000" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    process.env.FAKE_ARGS_FILE = argsFile
    try {
      const config = testConfig(endpoint.url, { CATENA_BIN: FAKE_BIN })
      const meter = new SpendMeter(moneyToMicros("$0.003"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result).toMatchObject({
        status: "cap_reached",
        priceMicros: 4000n,
      })
      expect(meter.totalMicros).toBe(0n)
      expect(existsSync(argsFile)).toBe(false) // the CLI was never invoked
    } finally {
      delete process.env.FAKE_ARGS_FILE
      await endpoint.close()
    }
  })

  it("fails without paying when the endpoint offers the wrong network", async () => {
    const endpoint = await startFakeEndpoint({ network: "eip155:8453" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    process.env.FAKE_ARGS_FILE = argsFile
    try {
      const config = testConfig(endpoint.url, { CATENA_BIN: FAKE_BIN })
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("failed")
      expect(meter.totalMicros).toBe(0n)
      expect(existsSync(argsFile)).toBe(false) // the CLI was never invoked
    } finally {
      delete process.env.FAKE_ARGS_FILE
      await endpoint.close()
    }
  })
})

describe("async image jobs", () => {
  it("polls a queued job with the payment's signature until delivery", async () => {
    const endpoint = await startFakeEndpoint({ amount: "21000" })
    process.env.FAKE_RESULT = "paid-queued"
    try {
      const config = testConfig(endpoint.url, {
        CATENA_BIN: FAKE_BIN,
        ENDPOINT_KIND: "image",
        PER_CALL_MAX_USD: "$0.025",
      })
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({
        config,
        meter,
        prompt: "a robot",
        pollIntervalMs: 10,
        pollMaxMs: 2000,
      })
      expect(result.status).toBe("paid")
      if (result.status === "paid") {
        expect(JSON.stringify(result.body)).toContain("img.example/robot.png")
      }
      expect(endpoint.polledWith).toBe("sig-test") // signature on the poll
      expect(meter.totalMicros).toBe(21000n)
    } finally {
      delete process.env.FAKE_RESULT
      await endpoint.close()
    }
  })
})

describe("charged-but-not-delivered and settlement reporting", () => {
  it("reports paid_but_error when the endpoint errors after payment", async () => {
    const endpoint = await startFakeEndpoint()
    process.env.FAKE_RESULT = "paid-error"
    try {
      const config = testConfig(endpoint.url, { CATENA_BIN: FAKE_BIN })
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid_but_error")
      expect(meter.totalMicros).toBe(1000n) // the charge is still recorded
    } finally {
      delete process.env.FAKE_RESULT
      await endpoint.close()
    }
  })

  it("surfaces a failed settlement from intent reconciliation", async () => {
    const endpoint = await startFakeEndpoint()
    process.env.FAKE_RESULT = "paid"
    process.env.FAKE_INTENT_STATUS = "failed"
    try {
      const config = testConfig(endpoint.url, { CATENA_BIN: FAKE_BIN })
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid")
      if (result.status === "paid") {
        expect(result.settlementStatus).toBe("failed")
      }
    } finally {
      delete process.env.FAKE_RESULT
      delete process.env.FAKE_INTENT_STATUS
      await endpoint.close()
    }
  })

  it("maps a hard CLI failure (no stdout) to failed with the stderr reason", async () => {
    process.env.FAKE_RESULT = "hard-fail"
    process.env.FAKE_STDERR = "catena: not logged in"
    try {
      const outcome = await payX402({
        bin: FAKE_BIN,
        url: "http://localhost/paid",
        accountId: "acct_test",
        maxAmountUsd: "0.002",
        requestBody: { model: "m" },
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status === "failed") {
        expect(outcome.reason).toContain("not logged in")
      }
    } finally {
      delete process.env.FAKE_RESULT
      delete process.env.FAKE_STDERR
    }
  })
})

describe("poll resilience", () => {
  it("keeps polling through in_progress answers until delivery", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      queuedPolls: 2,
    })
    process.env.FAKE_RESULT = "paid-queued"
    try {
      const config = testConfig(endpoint.url, {
        CATENA_BIN: FAKE_BIN,
        ENDPOINT_KIND: "image",
        PER_CALL_MAX_USD: "$0.025",
      })
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({
        config,
        meter,
        prompt: "a robot",
        pollIntervalMs: 10,
        pollMaxMs: 2000,
      })
      expect(result.status).toBe("paid")
      expect(endpoint.gets).toBe(3) // 2 in_progress + 1 completed
    } finally {
      delete process.env.FAKE_RESULT
      await endpoint.close()
    }
  })

  it("treats a transient non-JSON poll response as retryable, not delivered", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      brokenPolls: 1,
    })
    process.env.FAKE_RESULT = "paid-queued"
    try {
      const config = testConfig(endpoint.url, {
        CATENA_BIN: FAKE_BIN,
        ENDPOINT_KIND: "image",
        PER_CALL_MAX_USD: "$0.025",
      })
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({
        config,
        meter,
        prompt: "a robot",
        pollIntervalMs: 10,
        pollMaxMs: 2000,
      })
      expect(result.status).toBe("paid") // survived the 502 blip
      if (result.status === "paid") {
        expect(JSON.stringify(result.body)).toContain("img.example")
      }
    } finally {
      delete process.env.FAKE_RESULT
      await endpoint.close()
    }
  })

  it("reports paid_but_error when every poll fails", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      brokenPolls: 1000,
    })
    process.env.FAKE_RESULT = "paid-queued"
    try {
      const config = testConfig(endpoint.url, {
        CATENA_BIN: FAKE_BIN,
        ENDPOINT_KIND: "image",
        PER_CALL_MAX_USD: "$0.025",
      })
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({
        config,
        meter,
        prompt: "a robot",
        pollIntervalMs: 10,
        pollMaxMs: 200,
      })
      expect(result.status).toBe("paid_but_error")
    } finally {
      delete process.env.FAKE_RESULT
      await endpoint.close()
    }
  })
})
