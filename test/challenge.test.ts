import { describe, expect, it } from "vitest"
import { ChallengeError, probeQuote } from "../src/challenge.js"
import { startFakeEndpoint, TEST_NETWORK, TEST_PAY_TO } from "./helpers.js"
import type { FakeEndpoint } from "./helpers.js"

const BODY = { model: "m", messages: [{ role: "user", content: "hi" }] }

async function withEndpoint(
  options: Parameters<typeof startFakeEndpoint>[0],
  run: (endpoint: FakeEndpoint) => Promise<void>,
): Promise<void> {
  const endpoint = await startFakeEndpoint(options)
  try {
    await run(endpoint)
  } finally {
    await endpoint.close()
  }
}

describe("probeQuote", () => {
  it("decodes the price, payTo and asset from a 402 challenge", async () => {
    await withEndpoint({}, async (endpoint) => {
      const quote = await probeQuote({
        url: endpoint.url,
        body: BODY,
        network: TEST_NETWORK,
      })
      expect(quote.amountMicros).toBe(1000n)
      expect(quote.payTo).toBe(TEST_PAY_TO)
    })
  })

  it("rejects a non-402 response", async () => {
    await withEndpoint({ status: 200 }, async (endpoint) => {
      await expect(
        probeQuote({ url: endpoint.url, body: BODY, network: TEST_NETWORK }),
      ).rejects.toThrow(ChallengeError)
    })
  })

  it("rejects a 402 without a challenge header", async () => {
    await withEndpoint({ omitHeader: true }, async (endpoint) => {
      await expect(
        probeQuote({ url: endpoint.url, body: BODY, network: TEST_NETWORK }),
      ).rejects.toThrow(/no PAYMENT-REQUIRED/)
    })
  })

  it("rejects a challenge for a different network (e.g. mainnet)", async () => {
    await withEndpoint({ network: "eip155:8453" }, async (endpoint) => {
      await expect(
        probeQuote({ url: endpoint.url, body: BODY, network: TEST_NETWORK }),
      ).rejects.toThrow(/No exact-scheme challenge/)
    })
  })
})
