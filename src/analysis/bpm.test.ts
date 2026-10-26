import { describe, expect, it } from "vitest"
import { formatTempo, tempoAlternate, tempoListText } from "./bpm.ts"

describe("tempoAlternate", () => {
  it("names the other tempo when both octaves are normal dance tempos", () => {
    expect(tempoAlternate(174)).toBe(87)
    expect(tempoAlternate(87)).toBe(174)
    expect(tempoAlternate(174.4)).toBe(87.2)
    expect(tempoAlternate(87.2)).toBe(174.4)
    expect(tempoAlternate(140)).toBe(70)
    expect(tempoAlternate(70)).toBe(140)
    expect(tempoAlternate(160)).toBe(80)
    expect(tempoAlternate(80)).toBe(160)
    expect(tempoAlternate(100)).toBe(200)
    expect(tempoAlternate(200)).toBe(100)
    expect(tempoAlternate(72.5)).toBe(145)
  })

  it("stays quiet for a tempo with only one normal dance reading", () => {
    expect(tempoAlternate(128)).toBeNull()
    expect(tempoAlternate(124)).toBeNull()
    expect(tempoAlternate(64)).toBeNull()
    expect(tempoAlternate(110)).toBeNull()
    expect(tempoAlternate(135)).toBeNull()
    expect(tempoAlternate(105)).toBeNull()
    expect(tempoAlternate(210)).toBeNull()
    expect(tempoAlternate(69.9)).toBeNull()
    expect(tempoAlternate(200.1)).toBeNull()
  })

  it("rejects a tempo that is not a positive number", () => {
    expect(tempoAlternate(Number.NaN)).toBeNull()
    expect(tempoAlternate(0)).toBeNull()
    expect(tempoAlternate(-87)).toBeNull()
    expect(tempoAlternate(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("tempoListText", () => {
  it("keeps one decimal and notes the other reading", () => {
    expect(formatTempo(126)).toBe("126")
    expect(tempoListText(122.36)).toBe("122.4")
    expect(tempoListText(174)).toBe("174 (also 87)")
    expect(tempoListText(87.2)).toBe("87.2 (also 174.4)")
    expect(tempoListText(128)).toBe("128")
  })
})
