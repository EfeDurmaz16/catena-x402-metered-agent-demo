import { describe, expect, it } from "vitest"
import { loadConfig, microsToMoney, moneyToMicros } from "../src/config.js"
import { SpendMeter } from "../src/meter.js"

describe("money", () => {
  it("parses and renders exact micro-dollars", () => {
    expect(moneyToMicros("$0.001")).toBe(1000n)
    expect(moneyToMicros("$1")).toBe(1_000_000n)
    expect(microsToMoney(1000n)).toBe("$0.001")
    expect(microsToMoney(12_340_000n)).toBe("$12.34")
  })

  it("rejects malformed and over-precise values", () => {
    expect(() => moneyToMicros("0.001")).toThrow()
    expect(() => moneyToMicros("$0.0000001")).toThrow()
  })
})

describe("config", () => {
  it("defaults to the Base Sepolia BlockRun endpoint and a small cap", () => {
    const config = loadConfig({})
    expect(config.ENDPOINT_URL).toContain("testnet.blockrun.ai")
    expect(config.X402_NETWORK).toBe("eip155:84532")
    expect(moneyToMicros(config.SPEND_CAP_USD)).toBeGreaterThan(0n)
  })

  it("rejects a zero spend cap", () => {
    expect(() => loadConfig({ SPEND_CAP_USD: "$0" })).toThrow()
  })
})

describe("SpendMeter", () => {
  it("allows spending exactly up to the cap and refuses past it", () => {
    const meter = new SpendMeter(3000n)
    expect(meter.wouldExceed(1000n)).toBe(false)
    meter.record("a", 1000n)
    meter.record("b", 1000n)
    expect(meter.wouldExceed(1000n)).toBe(false) // lands exactly on the cap
    meter.record("c", 1000n)
    expect(meter.wouldExceed(1n)).toBe(true)
    expect(meter.totalMicros).toBe(3000n)
    expect(meter.entries).toHaveLength(3)
  })

  it("refuses a first call that is already over the cap", () => {
    const meter = new SpendMeter(500n)
    expect(meter.wouldExceed(1000n)).toBe(true)
  })
})
