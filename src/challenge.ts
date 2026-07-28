import { z } from "zod"

/**
 * Read the price of a paid endpoint WITHOUT paying: send the request unpaid,
 * expect a 402, and decode the x402 v2 challenge from the PAYMENT-REQUIRED
 * header. The runner uses this to enforce the spend cap BEFORE any money
 * moves; the actual payment is a separate, capped CLI call.
 */

const challengeSchema = z.object({
  x402Version: z.literal(2),
  accepts: z.array(
    z.looseObject({
      scheme: z.string(),
      network: z.string(),
      /** Price in atomic token units (USDC: micro-dollars). */
      amount: z.string().regex(/^\d+$/),
      asset: z.string(),
      payTo: z.string(),
    }),
  ),
})

export interface Quote {
  /** Price of one call in atomic USDC units (micro-dollars). */
  amountMicros: bigint
  payTo: string
  asset: string
}

export class ChallengeError extends Error {}

/**
 * POST the request body unpaid and return the price quoted for our network.
 * Fails closed: anything other than a 402 carrying an exact-scheme challenge
 * for the expected network is an error, never a silent zero.
 */
export async function probeQuote(options: {
  url: string
  body: unknown
  network: string
  fetchImpl?: typeof fetch
}): Promise<Quote> {
  const { url, body, network, fetchImpl = fetch } = options
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (response.status !== 402) {
    throw new ChallengeError(
      `Expected a 402 challenge from ${url}, got HTTP ${response.status}`,
    )
  }
  const header = response.headers.get("payment-required")
  if (!header) {
    throw new ChallengeError("402 response carries no PAYMENT-REQUIRED header")
  }
  let challenge
  try {
    challenge = challengeSchema.parse(
      JSON.parse(Buffer.from(header, "base64").toString("utf8")),
    )
  } catch (error) {
    throw new ChallengeError(
      `Could not decode x402 challenge: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const match = challenge.accepts.find(
    (a) => a.scheme === "exact" && a.network === network,
  )
  if (!match) {
    const offered = challenge.accepts
      .map((a) => `${a.scheme}/${a.network}`)
      .join(", ")
    throw new ChallengeError(
      `No exact-scheme challenge for ${network} (offered: ${offered})`,
    )
  }
  return {
    amountMicros: BigInt(match.amount),
    payTo: match.payTo,
    asset: match.asset,
  }
}
