import { createServer } from "node:http"
import type { Server } from "node:http"

export const TEST_NETWORK = "eip155:84532"
export const TEST_PAY_TO = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf"
export const TEST_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

/** Build the base64 PAYMENT-REQUIRED header a real x402 v2 seller sends. */
export function challengeHeader(options?: {
  network?: string
  amount?: string
  scheme?: string
}): string {
  const challenge = {
    x402Version: 2,
    accepts: [
      {
        scheme: options?.scheme ?? "exact",
        network: options?.network ?? TEST_NETWORK,
        amount: options?.amount ?? "1000",
        asset: TEST_USDC,
        payTo: TEST_PAY_TO,
        maxTimeoutSeconds: 300,
      },
    ],
  }
  return Buffer.from(JSON.stringify(challenge)).toString("base64")
}

export interface FakeEndpoint {
  url: string
  requests: number
  close: () => Promise<void>
}

/** Local stand-in for the paid endpoint: answers every POST with a 402
 * challenge, like BlockRun does for unpaid requests. */
export async function startFakeEndpoint(options?: {
  amount?: string
  network?: string
  status?: number
  omitHeader?: boolean
}): Promise<FakeEndpoint> {
  const state = { requests: 0 }
  const server: Server = createServer((_req, res) => {
    state.requests += 1
    const headers: Record<string, string> = {
      "content-type": "application/json",
    }
    if (!options?.omitHeader) {
      headers["payment-required"] = challengeHeader(options)
    }
    res.writeHead(options?.status ?? 402, headers)
    res.end(JSON.stringify({ error: "Payment Required" }))
  })
  await new Promise<void>((resolve) => {
    server.listen(0, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("Could not determine fake endpoint port")
  }
  return {
    url: `http://localhost:${address.port}/chat`,
    get requests() {
      return state.requests
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}
