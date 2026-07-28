import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

const execFileAsync = promisify(execFile)

/**
 * Payment surface: the released Catena CLI (`catena x402 --json`), consumed
 * as a customer would. Payments draw from a Catena-governed account, so the
 * platform's own policy engine (counterparty allowlist, spend limits,
 * approval thresholds) rules every spend; this repo never reimplements any
 * of that.
 */

/** Shapes documented by `catena guide`; unknown fields pass through. */
const resultSchema = z.looseObject({
  paid: z.boolean().optional(),
  payment: z
    .looseObject({
      intentId: z.string().optional(),
      amountAtomicUsdc: z.string().optional(),
      payTo: z.string().optional(),
    })
    .optional(),
  approvalPending: z
    .looseObject({
      intentId: z.string().optional(),
      expiresAt: z.string().optional(),
      reasons: z.array(z.string()).optional(),
    })
    .optional()
    .nullable(),
  counterpartyNotFound: z
    .looseObject({
      payTo: z.string().optional(),
      createCommand: z.string().optional(),
    })
    .optional()
    .nullable(),
  networkMismatch: z.unknown().optional().nullable(),
  body: z.unknown().optional(),
  error: z.unknown().optional(),
})

export type PayOutcome =
  | {
      status: "paid"
      amountMicros: bigint | undefined
      intentId: string | undefined
      body: unknown
    }
  | {
      status: "approval_pending"
      intentId: string | undefined
      reason: string | undefined
    }
  | { status: "setup_required"; createCommand: string | undefined }
  | { status: "failed"; reason: string }

export interface PayOptions {
  bin: string
  url: string
  accountId: string
  /** Refuse challenges above this, e.g. "0.002" (USD decimal, no $). */
  maxAmountUsd: string
  requestBody: unknown
}

/** Pay one x402 challenge from the Catena account. Never throws on a policy
 * or payment refusal: every known outcome maps to a typed status the runner
 * can act on, and anything unrecognized fails closed as "failed". */
export async function payX402(options: PayOptions): Promise<PayOutcome> {
  const { bin, url, accountId, maxAmountUsd, requestBody } = options
  const args = [
    "x402",
    `--url=${url}`,
    `--account=${accountId}`,
    `--maxAmount=${maxAmountUsd}`,
    `--data=${JSON.stringify(requestBody)}`,
    "--json",
  ]
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(bin, args, { timeout: 120_000 }))
  } catch (error) {
    // Non-zero exit still prints the JSON result (e.g. approvalPending);
    // fall through to parsing when stdout is present.
    const failed = error as { stdout?: string; stderr?: string }
    if (!failed.stdout) {
      return {
        status: "failed",
        reason: failed.stderr?.trim() ?? String(error),
      }
    }
    stdout = failed.stdout
  }
  let result
  try {
    result = resultSchema.parse(JSON.parse(stdout))
  } catch {
    return {
      status: "failed",
      reason: `Unrecognized CLI output: ${stdout.slice(0, 200)}`,
    }
  }
  if (result.approvalPending) {
    return {
      status: "approval_pending",
      intentId: result.approvalPending.intentId,
      reason: result.approvalPending.reasons?.[0],
    }
  }
  if (result.counterpartyNotFound) {
    return {
      status: "setup_required",
      createCommand: result.counterpartyNotFound.createCommand,
    }
  }
  if (result.networkMismatch) {
    return { status: "failed", reason: "network mismatch (see CLI output)" }
  }
  if (result.paid) {
    const amount = result.payment?.amountAtomicUsdc
    return {
      status: "paid",
      amountMicros: amount && /^\d+$/.test(amount) ? BigInt(amount) : undefined,
      intentId: result.payment?.intentId,
      body: result.body,
    }
  }
  return {
    status: "failed",
    reason: `CLI reported no payment: ${JSON.stringify(result.error ?? result).slice(0, 200)}`,
  }
}

export interface IntentView {
  /** Settlement truth: the inner transaction's status (pending until the
   * seller settles on-chain, failed when it never does), falling back to
   * the intent's own status. */
  settlementStatus: string | undefined
  /** The PAYMENT-SIGNATURE header value of this payment, re-readable while
   * the authorization is still valid. Async endpoints (202 + poll_url)
   * require it on every poll. */
  paymentSignature: string | undefined
}

/**
 * Reconcile a payment with the platform's record: the x402 exchange saying
 * "paid" is not the same as the funds settling (a seller can fail after the
 * authorization, in which case Catena marks the intent failed and releases
 * the reserved funds). Never throws; unreadable fields come back undefined.
 */
export async function readIntent(
  bin: string,
  intentId: string,
): Promise<IntentView> {
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["intents", "get", intentId, "--json"],
      { timeout: 60_000 },
    )
    const intent = z
      .looseObject({
        status: z.string().optional(),
        data: z
          .looseObject({
            x402: z
              .looseObject({
                paymentSignature: z.string().optional(),
                transaction: z
                  .looseObject({ status: z.string().optional() })
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .parse(JSON.parse(stdout))
    return {
      settlementStatus: intent.data?.x402?.transaction?.status ?? intent.status,
      paymentSignature: intent.data?.x402?.paymentSignature,
    }
  } catch {
    return { settlementStatus: undefined, paymentSignature: undefined }
  }
}
