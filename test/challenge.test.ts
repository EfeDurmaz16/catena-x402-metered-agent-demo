import { describe, expect, it } from "vitest"
import { ChallengeError, probeQuote } from "../src/challenge.js"
import {
  startFakeEndpoint,
  TEST_NETWORK,
  TEST_PAY_TO,
  TEST_USDC,
} from "./helpers.js"
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

  // Anything but the expected network and asset fails closed, so a mainnet
  // challenge or a challenge in another token is never quoted.
  it.each([
    [
      "an unexpected asset",
      { asset: "0x000000000000000000000000000000000000beef" },
    ],
    ["a different network (e.g. mainnet)", { network: "eip155:8453" }],
  ])("rejects a challenge with %s", async (_case, endpointOptions) => {
    await withEndpoint(endpointOptions, async (endpoint) => {
      await expect(
        probeQuote({
          url: endpoint.url,
          body: BODY,
          network: TEST_NETWORK,
          asset: TEST_USDC,
        }),
      ).rejects.toThrow(/No exact-scheme challenge/)
    })
  })

  // Three ways a PAYMENT-REQUIRED header can be unreadable: not base64 JSON,
  // an older protocol version, and a price that is not atomic units.
  it.each([
    ["not base64 JSON", "!!!"],
    [
      "x402 v1",
      Buffer.from(JSON.stringify({ x402Version: 1 })).toString("base64"),
    ],
    [
      "a decimal amount",
      Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: TEST_NETWORK,
              amount: "1.5",
              asset: TEST_USDC,
              payTo: TEST_PAY_TO,
            },
          ],
        }),
      ).toString("base64"),
    ],
  ])("refuses a 402 header carrying %s", async (_case, rawHeader) => {
    await withEndpoint({ rawHeader }, async (endpoint) => {
      await expect(
        probeQuote({ url: endpoint.url, body: BODY, network: TEST_NETWORK }),
      ).rejects.toThrow(/Could not decode/)
    })
  })
})
