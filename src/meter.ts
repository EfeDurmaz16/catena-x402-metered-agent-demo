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
 */
export class SpendMeter {
  readonly capMicros: bigint
  private total = 0n
  readonly entries: MeterEntry[] = []

  constructor(capMicros: bigint) {
    if (capMicros <= 0n) throw new Error("Spend cap must be greater than 0")
    this.capMicros = capMicros
  }

  get totalMicros(): bigint {
    return this.total
  }

  /** True when paying `priceMicros` would push the total past the cap.
   * Spending exactly up to the cap is allowed. */
  wouldExceed(priceMicros: bigint): boolean {
    return this.total + priceMicros > this.capMicros
  }

  record(label: string, amountMicros: bigint): void {
    this.total += amountMicros
    this.entries.push({ label, amountMicros })
  }

  summary(): string {
    return `${microsToMoney(this.total)} of ${microsToMoney(this.capMicros)} cap across ${this.entries.length} paid call(s)`
  }
}
