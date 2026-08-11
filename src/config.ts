import { z } from "zod"

/**
 * Exact money handling: "$x.yz" strings parsed to bigint micro-dollars.
 * USDC has 6 decimals, so with the $1 peg one atomic USDC unit equals one
 * micro-dollar; challenge amounts (atomic) and caps (micro-dollars) compare
 * directly. Money never touches floats.
 */
export function moneyToMicros(money: string): bigint {
  const match = /^\$(\d+)(?:\.(\d+))?$/.exec(money)
  if (match === null) {
    throw new Error(`Invalid money string: ${money}`)
  }
  const [, whole = "0", rawFraction = ""] = match
  if (rawFraction.length > 6) {
    throw new Error(`Too many decimal places for micro-dollars: ${money}`)
  }
  const fraction = rawFraction.padEnd(6, "0")
  return BigInt(whole) * 1_000_000n + BigInt(fraction)
}

/** Render micro-dollars back to a "$x.yz" string for display. */
export function microsToMoney(micros: bigint): string {
  // Negatives never arise from a well-behaved meter, but bigint division
  // truncates toward zero and the remainder keeps the sign, which would
  // render "-1" into the fraction digits. Handle the sign up front.
  if (micros < 0n) return `-${microsToMoney(-micros)}`
  const whole = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, "0")
  return `$${whole}.${fraction}`.replace(/0+$/, "").replace(/\.$/, "")
}

/** A "$x.yz" env value, parsed to bigint micro-dollars at the boundary so no
 * money string survives past config parsing. */
const moneyMicros = (defaultUsd: string) =>
  z
    .string()
    .regex(/^\$\d+(\.\d{1,6})?$/, "expected $x.yz")
    .default(defaultUsd)
    .transform(moneyToMicros)
    .refine((micros) => micros > 0n, "must be greater than 0")

const envSchema = z.object({
  /** Catena account the CLI pays from. Required to actually pay. */
  CATENA_ACCOUNT_ID: z.string().min(1).optional(),
  /** What the paid endpoint serves; shapes the request body. */
  ENDPOINT_KIND: z.enum(["image", "chat"]).default("image"),
  /** The paid x402 endpoint the agent consumes. */
  ENDPOINT_URL: z
    .url()
    .default("https://testnet.blockrun.ai/api/v1/images/generations"),
  /** Model requested per call; testnet models are flat-priced per request. */
  MODEL: z.string().min(1).default("openai/gpt-image-1"),
  /** Total the runner may spend across all calls in one run. */
  SPEND_CAP_USD: moneyMicros("$0.05"),
  /** Per-call ceiling passed to the CLI as --maxAmount (defense in depth). */
  PER_CALL_MAX_USD: moneyMicros("$0.025"),
  /** Only Base Sepolia challenges are paid; anything else fails closed. */
  X402_NETWORK: z.literal("eip155:84532").default("eip155:84532"),
  /** Only this asset is paid (Circle's Base Sepolia USDC, 6 decimals): the
   * atomic-units-equal-micro-dollars arithmetic depends on it. */
  X402_ASSET: z
    .literal("0x036CbD53842c5426634e7929541eC2318f3dCF7e")
    .default("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
  /** Override for tests; the released Catena CLI binary otherwise. */
  CATENA_BIN: z.string().min(1).default("catena"),
})

export type Config = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env)
}
