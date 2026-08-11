import { describe, expect, it } from "vitest"
import { loadConfig, microsToMoney, moneyToMicros } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"

describe("money", () => {
  it("parses and renders exact micro-dollars", () => {
    expect(moneyToMicros("$0.001")).toBe(1000n)
    expect(moneyToMicros("$1")).toBe(1_000_000n)
    expect(microsToMoney(1000n)).toBe("$0.001")
    expect(microsToMoney(0n)).toBe("$0")
    expect(microsToMoney(1_000_000n)).toBe("$1")
    expect(microsToMoney(12_340_000n)).toBe("$12.34")
    expect(microsToMoney(-1000n)).toBe("-$0.001") // sign, not "-1" digits
  })

  it("rejects malformed and over-precise values", () => {
    expect(() => moneyToMicros("0.001")).toThrow()
    expect(() => moneyToMicros("$0.0000001")).toThrow()
  })
})

describe("config", () => {
  it("never defaults to mainnet and rejects a zero spend cap", () => {
    const config = loadConfig({})
    expect(config.X402_NETWORK).toBe("eip155:84532")
    // Money env values are bigint micro-dollars once parsed, defaults too.
    expect(config.SPEND_CAP_USD).toBe(50_000n)
    expect(config.PER_CALL_MAX_USD).toBe(25_000n)
    expect(() => loadConfig({ SPEND_CAP_USD: "$0" })).toThrow()
  })
})

describe("SpendMeter", () => {
  it("allows reserving exactly up to the cap and refuses past it", () => {
    const meter = new SpendMeter(3000n)
    expect(meter.reserve(1000n)).toBe(true)
    meter.settle("a", 1000n, 1000n)
    expect(meter.reserve(1000n)).toBe(true)
    meter.settle("b", 1000n, 1000n)
    expect(meter.reserve(1000n)).toBe(true) // lands exactly on the cap
    meter.settle("c", 1000n, 1000n)
    expect(meter.reserve(1n)).toBe(false)
    expect(meter.totalMicros).toBe(3000n)
    expect(meter.entries).toHaveLength(3)
    // A first call already over the cap claims nothing.
    const small = new SpendMeter(500n)
    expect(small.reserve(1000n)).toBe(false)
    expect(small.totalMicros).toBe(0n)
  })

  it("refuses to exist without a budget, or to reserve nothing", () => {
    expect(() => new SpendMeter(0n)).toThrow()
    expect(() => new SpendMeter(-1n)).toThrow()
    expect(() => new SpendMeter(1000n).reserve(0n)).toThrow()
    expect(() => new SpendMeter(1000n).reserve(-1n)).toThrow()
  })

  it("counts a reservation while the payment is in flight", () => {
    // The race the reservation exists to close: a second caller must see
    // the first caller's worst case before that call has settled.
    const meter = new SpendMeter(1000n)
    expect(meter.reserve(1000n)).toBe(true)
    expect(meter.reserve(1000n)).toBe(false)
    meter.release(1000n)
    expect(meter.reserve(1000n)).toBe(true)
  })

  it("settles to the actual charge, which may differ from the reservation", () => {
    const meter = new SpendMeter(5000n)
    meter.reserve(2000n) // authorized ceiling
    meter.settle("call", 2000n, 1200n) // seller charged less
    expect(meter.totalMicros).toBe(1200n)
    expect(meter.entries[0]?.amountMicros).toBe(1200n)
  })
})
