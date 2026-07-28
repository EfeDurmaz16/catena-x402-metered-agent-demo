import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runMeteredCall } from "../src/agent.js"
import { payX402 } from "../src/catena-cli.js"
import { loadConfig, moneyToMicros } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"
import { startFakeEndpoint } from "./helpers.js"

const FAKE_BIN = fileURLToPath(new URL("./fake-catena.mjs", import.meta.url))

afterEach(() => {
  vi.unstubAllEnvs()
})

function testConfig(endpointUrl: string, env: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    CATENA_ACCOUNT_ID: "acct_test",
    ENDPOINT_URL: endpointUrl,
    ENDPOINT_KIND: "chat",
    PER_CALL_MAX_USD: "$0.002",
    CATENA_BIN: FAKE_BIN,
    ...env,
  })
}

describe("payX402 result mapping", () => {
  function run(
    fakeResult: "paid" | "approval" | "counterparty" | "garbage" | "hard-fail",
    exit: "0" | "1" = "0",
  ) {
    vi.stubEnv("FAKE_RESULT", fakeResult)
    vi.stubEnv("FAKE_EXIT", exit)
    return payX402({
      bin: FAKE_BIN,
      url: "http://localhost/paid",
      accountId: "acct_test",
      maxAmountUsd: "0.002",
      requestBody: { model: "m" },
    })
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
    vi.stubEnv("FAKE_RESULT", "paid")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid")
      expect(meter.totalMicros).toBe(1000n)
      // The CLI must be driven with the per-call ceiling and the account,
      // then re-invoked to reconcile the intent's settlement status.
      const invocations = readFileSync(argsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
      expect(invocations).toHaveLength(2)
      const [payArgs = [], reconcileArgs = []] = invocations
      expect(payArgs).toContain("--account=acct_test")
      expect(payArgs).toContain("--maxAmount=0.002")
      expect(payArgs).toContain("--json")
      expect(reconcileArgs.slice(0, 2)).toEqual(["intents", "get"])
      if (result.status === "paid") {
        expect(result.settlementStatus).toBe("completed")
      }
    } finally {
      await endpoint.close()
    }
  })

  it("refuses the call BEFORE paying when the cap would be exceeded", async () => {
    const endpoint = await startFakeEndpoint({ amount: "4000" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.003"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result).toMatchObject({
        status: "cap_reached",
        priceMicros: 4000n,
      })
      expect(meter.totalMicros).toBe(0n)
      expect(existsSync(argsFile)).toBe(false) // the CLI was never invoked
    } finally {
      await endpoint.close()
    }
  })

  it("fails without paying when the endpoint offers the wrong network", async () => {
    const endpoint = await startFakeEndpoint({ network: "eip155:8453" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("failed")
      expect(meter.totalMicros).toBe(0n)
      expect(existsSync(argsFile)).toBe(false) // the CLI was never invoked
    } finally {
      await endpoint.close()
    }
  })
})

describe("async image jobs", () => {
  it("polls a queued job with the payment's signature until delivery", async () => {
    const endpoint = await startFakeEndpoint({ amount: "21000" })
    vi.stubEnv("FAKE_RESULT", "paid-queued")
    try {
      const config = testConfig(endpoint.url, {
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
      await endpoint.close()
    }
  })
})

describe("charged-but-not-delivered and settlement reporting", () => {
  it("reports paid_but_error when the endpoint errors after payment", async () => {
    const endpoint = await startFakeEndpoint()
    vi.stubEnv("FAKE_RESULT", "paid-error")
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid_but_error")
      expect(meter.totalMicros).toBe(1000n) // the charge is still recorded
    } finally {
      await endpoint.close()
    }
  })

  it("surfaces a failed settlement from intent reconciliation", async () => {
    const endpoint = await startFakeEndpoint()
    vi.stubEnv("FAKE_RESULT", "paid")
    vi.stubEnv("FAKE_INTENT_STATUS", "failed")
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid")
      if (result.status === "paid") {
        expect(result.settlementStatus).toBe("failed")
      }
    } finally {
      await endpoint.close()
    }
  })

  it("maps a hard CLI failure (no stdout) to failed with the stderr reason", async () => {
    vi.stubEnv("FAKE_RESULT", "hard-fail")
    vi.stubEnv("FAKE_STDERR", "catena: not logged in")
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
  })
})

describe("poll resilience", () => {
  it("keeps polling through in_progress answers until delivery", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      queuedPolls: 2,
    })
    vi.stubEnv("FAKE_RESULT", "paid-queued")
    try {
      const config = testConfig(endpoint.url, {
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
      await endpoint.close()
    }
  })

  it("treats a transient non-JSON poll response as retryable, not delivered", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      brokenPolls: 1,
    })
    vi.stubEnv("FAKE_RESULT", "paid-queued")
    try {
      const config = testConfig(endpoint.url, {
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
      await endpoint.close()
    }
  })

  it("reports paid_but_error when every poll fails", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      brokenPolls: 1000,
    })
    vi.stubEnv("FAKE_RESULT", "paid-queued")
    try {
      const config = testConfig(endpoint.url, {
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
      await endpoint.close()
    }
  })
})
