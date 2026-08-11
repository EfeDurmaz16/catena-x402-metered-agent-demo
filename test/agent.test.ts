import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runMeteredCall } from "../src/agent.js"
import { payX402 } from "../src/catena-cli.js"
import { loadConfig, moneyToMicros } from "../src/config.js"
import type { Config } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"
import { startFakeEndpoint } from "./helpers.js"

const FAKE_BIN = fileURLToPath(new URL("./fake-catena.mjs", import.meta.url))

afterEach(() => {
  vi.unstubAllEnvs()
})

function testConfig(endpointUrl: string, env: NodeJS.ProcessEnv = {}): Config {
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
    fakeResult:
      | "paid"
      | "approval"
      | "counterparty"
      | "garbage"
      | "hard-fail"
      | "retry-failed",
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

  it("maps paid+retryFailed to paid_but_error (not success)", async () => {
    const outcome = await run("retry-failed", "1")
    expect(outcome.status).toBe("paid_but_error")
    if (outcome.status === "paid_but_error") {
      expect(outcome.amountMicros).toBe(1000n)
      expect(outcome.intentId).toBe("int_test")
    }
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

  // Both refusals must happen before the CLI is ever spawned: the absent
  // args file is the proof that no payment could have been attempted.
  it.each([
    {
      why: "the cap would be exceeded",
      endpointOptions: { amount: "4000" },
      capUsd: "$0.003",
      expected: { status: "cap_reached", priceMicros: 4000n },
    },
    {
      why: "the endpoint offers the wrong network",
      endpointOptions: { network: "eip155:8453" },
      capUsd: "$0.005",
      expected: { status: "failed" },
    },
  ])("refuses the call BEFORE paying when $why", async (testCase) => {
    const endpoint = await startFakeEndpoint(testCase.endpointOptions)
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros(testCase.capUsd))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result).toMatchObject(testCase.expected)
      expect(meter.totalMicros).toBe(0n)
      expect(existsSync(argsFile)).toBe(false) // the CLI was never invoked
    } finally {
      await endpoint.close()
    }
  })

  it("refuses a quote above the per-call ceiling with an actionable reason", async () => {
    const endpoint = await startFakeEndpoint({ amount: "4000" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      // The cap has room ($0.05) but PER_CALL_MAX_USD ($0.002) does not.
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("failed")
      if (result.status === "failed") {
        expect(result.reason).toContain("PER_CALL_MAX_USD")
      }
      expect(meter.totalMicros).toBe(0n) // the reservation was handed back
      expect(existsSync(argsFile)).toBe(false)
    } finally {
      await endpoint.close()
    }
  })
})

describe("async image jobs", () => {
  it("polls a queued job with the payment's signature until delivery", async () => {
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
      if (result.status === "paid") {
        expect(JSON.stringify(result.body)).toContain("img.example/robot.png")
      }
      expect(endpoint.polledWith).toBe("sig-test") // signature on the poll
      expect(endpoint.gets).toBe(3) // 2 in_progress answers, then delivery
      expect(meter.totalMicros).toBe(21000n)
    } finally {
      await endpoint.close()
    }
  })

  // The payment signature is a bearer credential: a hostile body that names
  // another host must never receive it, however the URL is written.
  it.each([
    ["an absolute cross-origin URL", "paid-queued-cross-origin"],
    ["a protocol-relative URL", "paid-queued-protocol-relative"],
  ])("refuses to poll %s", async (_case, fakeResult) => {
    const endpoint = await startFakeEndpoint({ amount: "21000" })
    vi.stubEnv("FAKE_RESULT", fakeResult)
    try {
      const config = testConfig(endpoint.url, {
        ENDPOINT_KIND: "image",
        PER_CALL_MAX_USD: "$0.025",
      })
      // Every request the run makes is recorded, and anything leaving the
      // endpoint's origin is answered with a delivered-looking result
      // instead of reaching the network. Drop the same-origin check in
      // resolveSameOriginPollUrl and this test reports "paid" with
      // evil.example in the requested list, which is the failure it exists
      // to catch.
      const requested: string[] = []
      const origin = new URL(endpoint.url).origin
      const recordingFetch: typeof fetch = async (input, init) => {
        const url =
          input instanceof URL
            ? input.href
            : typeof input === "string"
              ? input
              : input.url
        requested.push(url)
        if (new URL(url).origin !== origin) {
          return new Response(
            JSON.stringify({
              status: "completed",
              data: [{ url: "https://img.example/stolen.png" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return fetch(input, init)
      }
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({
        config,
        meter,
        prompt: "a robot",
        fetchImpl: recordingFetch,
        pollIntervalMs: 10,
        pollMaxMs: 200,
      })
      expect(result.status).toBe("paid_but_error")
      if (result.status === "paid_but_error") {
        expect(JSON.stringify(result.body)).toContain("same-origin")
      }
      expect(requested.map((url) => new URL(url).origin)).toEqual([origin])
      expect(endpoint.polledWith).toBeUndefined() // the signature never left
      expect(endpoint.gets).toBe(0)
    } finally {
      await endpoint.close()
    }
  })

  it("reports paid_but_error when the intent read fails after paying", async () => {
    // No intent read means no payment signature, so the queued job can never
    // be polled: a charge with an unconfirmed delivery, not a success.
    const endpoint = await startFakeEndpoint({ amount: "21000" })
    vi.stubEnv("FAKE_RESULT", "paid-queued")
    vi.stubEnv("FAKE_INTENT_FAIL", "1")
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
      if (result.status === "paid_but_error") {
        expect(result.settlementStatus).toBeUndefined()
      }
      expect(endpoint.gets).toBe(0)
      expect(meter.totalMicros).toBe(21000n) // the charge is still recorded
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

  it("reports paid_but_error when polls stay in_progress until timeout", async () => {
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      queuedPolls: 1000,
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
        pollMaxMs: 80,
      })
      expect(result.status).toBe("paid_but_error")
      if (result.status === "paid_but_error") {
        expect(JSON.stringify(result.body)).toContain("timed out")
      }
    } finally {
      await endpoint.close()
    }
  })
})

describe("money-safety regressions", () => {
  it("records the authorized ceiling when the CLI omits the charged amount", async () => {
    // The CLI pays whatever the seller's own challenge asks, up to
    // --maxAmount. Falling back to the cheaper probe quote would under-count
    // and let a later call slip past the cap.
    const endpoint = await startFakeEndpoint({ amount: "1000" })
    vi.stubEnv("FAKE_RESULT", "paid-no-amount")
    try {
      const config = testConfig(endpoint.url, {
        PER_CALL_MAX_USD: "$0.002",
      })
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid")
      expect(meter.totalMicros).toBe(2000n) // the $0.002 ceiling, not the $0.001 quote
    } finally {
      await endpoint.close()
    }
  })

  it("clamps the CLI authorization to what is left of the cap", async () => {
    const endpoint = await startFakeEndpoint({ amount: "1000" })
    const argsFile = join(mkdtempSync(join(tmpdir(), "metered-")), "args.jsonl")
    vi.stubEnv("FAKE_RESULT", "paid")
    vi.stubEnv("FAKE_ARGS_FILE", argsFile)
    try {
      const config = testConfig(endpoint.url, { PER_CALL_MAX_USD: "$0.002" })
      const meter = new SpendMeter(moneyToMicros("$0.0015"))
      await runMeteredCall({ config, meter, prompt: "hi" })
      const payArgs = JSON.parse(
        readFileSync(argsFile, "utf8").trim().split("\n")[0] ?? "[]",
      ) as string[]
      // Remaining cap ($0.0015) is below the per-call ceiling ($0.002).
      expect(payArgs).toContain("--maxAmount=0.0015")
    } finally {
      await endpoint.close()
    }
  })

  it("does not report a queued body without a usable poll_url as delivered", async () => {
    const endpoint = await startFakeEndpoint({ amount: "1000" })
    vi.stubEnv("FAKE_RESULT", "paid-queued-no-url")
    try {
      const config = testConfig(endpoint.url, { ENDPOINT_KIND: "image" })
      const meter = new SpendMeter(moneyToMicros("$0.05"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("paid_but_error")
    } finally {
      await endpoint.close()
    }
  })

  it("does not report a non-ok poll response as delivered", async () => {
    // HTTP 500 whose JSON body has no error key and no status: without the
    // response.ok check this parsed as a successful delivery.
    const endpoint = await startFakeEndpoint({
      amount: "21000",
      pollHttpError: 500,
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
        prompt: "hi",
        pollIntervalMs: 10,
        pollMaxMs: 500,
      })
      expect(result.status).toBe("paid_but_error")
    } finally {
      await endpoint.close()
    }
  })

  it("surfaces a network mismatch with actionable detail", async () => {
    const endpoint = await startFakeEndpoint({ amount: "1000" })
    vi.stubEnv("FAKE_RESULT", "network-mismatch")
    try {
      const config = testConfig(endpoint.url)
      const meter = new SpendMeter(moneyToMicros("$0.005"))
      const result = await runMeteredCall({ config, meter, prompt: "hi" })
      expect(result.status).toBe("failed")
      if (result.status === "failed") {
        expect(result.reason).toContain("network mismatch")
        expect(result.reason).toContain("eip155:8453")
      }
      expect(meter.totalMicros).toBe(0n)
    } finally {
      await endpoint.close()
    }
  })

  it("reports a killed CLI as possibly in flight even with partial output", async () => {
    vi.stubEnv("FAKE_RESULT", "paid")
    vi.stubEnv("FAKE_KILL", "1")
    const outcome = await payX402({
      bin: FAKE_BIN,
      url: "http://localhost/paid",
      accountId: "acct_test",
      maxAmountUsd: "0.002",
      requestBody: { model: "m" },
    })
    expect(outcome.status).toBe("failed")
    if (outcome.status === "failed") {
      expect(outcome.reason).toContain("may already be in flight")
    }
  })
})

describe("runner setup checks", () => {
  it("exits 2 without CATENA_ACCOUNT_ID, before any CLI call", async () => {
    const script = fileURLToPath(new URL("../scripts/run.ts", import.meta.url))
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        // A bare environment: no account id, so the runner must stop at the
        // setup check rather than reaching the payment path.
        env: { PATH: process.env.PATH ?? "" },
        stdio: "ignore",
      })
      child.on("error", reject)
      child.on("exit", resolve)
    })
    expect(exitCode).toBe(2)
  })
})

describe("concurrent cap safety", () => {
  it("lets only one of two concurrent calls through a one-call cap", async () => {
    // Reserving in the same tick as the check is what makes this hold: with
    // a check-then-act meter both calls saw an empty budget and paid.
    const endpoint = await startFakeEndpoint({ amount: "1000" })
    vi.stubEnv("FAKE_RESULT", "paid")
    try {
      const config = testConfig(endpoint.url, { PER_CALL_MAX_USD: "$0.001" })
      const meter = new SpendMeter(moneyToMicros("$0.001"))
      const [first, second] = await Promise.all([
        runMeteredCall({ config, meter, prompt: "a" }),
        runMeteredCall({ config, meter, prompt: "b" }),
      ])
      const statuses = [first.status, second.status].sort()
      expect(statuses).toEqual(["cap_reached", "paid"])
      expect(meter.totalMicros).toBe(1000n)
    } finally {
      await endpoint.close()
    }
  })
})
