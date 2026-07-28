import { microsToMoney } from "./config.js"

export interface MeterEntry {
  label: string
  amountMicros: bigint
}

/**
 * Running spend total for one run, in bigint micro-dollars. The meter is
 * client-side bookkeeping so the runner can refuse a call BEFORE paying;
 * the authoritative spend controls stay on the Catena side (policy limits,
 * approval thresholds), which bind even if this process miscounts.
 *
 * Reserve, then settle or release. Checking the cap and committing to spend
 * are one synchronous step, so two calls in flight at once cannot both pass
 * a check that only one of them fits: whatever a caller reserves is already
 * counted while the payment is away.
 */
export class SpendMeter {
  readonly capMicros: bigint
  private total = 0n
  readonly entries: MeterEntry[] = []

  constructor(capMicros: bigint) {
    if (capMicros <= 0n) throw new Error("Spend cap must be greater than 0")
    this.capMicros = capMicros
  }

  /** Committed spend plus everything currently reserved. */
  get totalMicros(): bigint {
    return this.total
  }

  /**
   * Claim `priceMicros` of the remaining budget. Returns false when the cap
   * cannot cover it, in which case nothing is reserved and the caller must
   * not pay. No await may separate this from the decision it guards.
   */
  reserve(priceMicros: bigint): boolean {
    if (this.total + priceMicros > this.capMicros) return false
    this.total += priceMicros
    return true
  }

  /** Give a reservation back when the call did not spend it. */
  release(reservedMicros: bigint): void {
    this.total -= reservedMicros
  }

  /**
   * Turn a reservation into a recorded charge. `actualMicros` may differ
   * from what was reserved (the seller charges what its own challenge asks,
   * up to the authorized ceiling), so the difference is settled here.
   */
  settle(label: string, reservedMicros: bigint, actualMicros: bigint): void {
    this.total += actualMicros - reservedMicros
    this.entries.push({ label, amountMicros: actualMicros })
  }

  summary(): string {
    return `${microsToMoney(this.total)} of ${microsToMoney(this.capMicros)} cap across ${this.entries.length} paid call(s)`
  }
}
