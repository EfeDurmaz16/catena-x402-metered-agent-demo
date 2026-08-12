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
  /** Sum of reservations not yet released or settled. */
  private outstanding = 0n
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
    // Zero would report a hold that claims nothing; negative would hand back
    // budget that was never spent. Neither is reachable from the runner, and
    // refusing them here keeps it that way if a future caller changes.
    if (priceMicros <= 0n) {
      throw new Error("Reservation must be greater than 0")
    }
    if (this.total + priceMicros > this.capMicros) return false
    this.total += priceMicros
    this.outstanding += priceMicros
    return true
  }

  /**
   * Both exits of a reservation route through here: only a positive amount
   * that is actually outstanding may leave, so budget that was never held
   * cannot be handed back and the total can never go negative.
   */
  private takeReservation(reservedMicros: bigint): void {
    if (reservedMicros <= 0n) {
      throw new Error("Reservation to give back must be greater than 0")
    }
    if (reservedMicros > this.outstanding) {
      throw new Error("Cannot give back more than is currently reserved")
    }
    this.outstanding -= reservedMicros
  }

  /** Give a reservation back when the call did not spend it. */
  release(reservedMicros: bigint): void {
    this.takeReservation(reservedMicros)
    this.total -= reservedMicros
  }

  /**
   * Turn a reservation into a recorded charge. `actualMicros` may differ
   * from what was reserved (the seller charges what its own challenge asks,
   * up to the authorized ceiling), so the difference is settled here. An
   * actual above the reservation is recorded as-is: over-counting spend is
   * the safe direction, and the next reserve() refuses on the true total.
   */
  settle(label: string, reservedMicros: bigint, actualMicros: bigint): void {
    if (actualMicros < 0n) {
      throw new Error("Settled amount cannot be negative")
    }
    this.takeReservation(reservedMicros)
    this.total += actualMicros - reservedMicros
    this.entries.push({ label, amountMicros: actualMicros })
  }

  summary(): string {
    return `${microsToMoney(this.total)} of ${microsToMoney(this.capMicros)} cap across ${this.entries.length} paid call(s)`
  }
}
