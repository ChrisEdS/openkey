import { describe, expect, it } from "vitest"
import { isLowConfidence, keyLabel, keyLabelFromOpenKey, mixesWith, openKeyCode } from "./openKey.ts"

describe("openKeyCode", () => {
  it("maps the reference keys used by DJs", () => {
    expect(openKeyCode("A", "minor")).toBe("8A")
    expect(openKeyCode("C", "major")).toBe("8B")
    expect(openKeyCode("F#", "major")).toBe("2B")
    expect(openKeyCode("Bb", "major")).toBe("6B")
    expect(openKeyCode("Eb", "minor")).toBe("2A")
    expect(openKeyCode("G#", "minor")).toBe("1A")
    expect(openKeyCode("Db", "major")).toBe("3B")
    expect(openKeyCode("A#", "minor")).toBe("3A")
  })

  it("rejects an unknown pitch", () => {
    expect(openKeyCode("H", "major")).toBeNull()
    expect(openKeyCode("C", "dorian")).toBeNull()
  })
})

describe("keyLabelFromOpenKey", () => {
  it("uses the same wheel as the detector", () => {
    expect(keyLabelFromOpenKey("8A")).toBe("A minor")
    expect(keyLabelFromOpenKey("8B")).toBe("C major")
    expect(keyLabelFromOpenKey("2B")).toBe("F# major")
    expect(keyLabelFromOpenKey(openKeyCode("Bb", "major")!)).toBe("A# major")
    expect(keyLabelFromOpenKey("13A")).toBeNull()
  })
})

describe("mixesWith", () => {
  it("returns the previous, next, and relative codes", () => {
    expect(mixesWith("8A")).toEqual(["7A", "9A", "8B"])
    expect(mixesWith("1A")).toEqual(["12A", "2A", "1B"])
    expect(mixesWith("12B")).toEqual(["11B", "1B", "12A"])
  })
})

describe("keyLabel", () => {
  it("keeps the detector spelling", () => {
    expect(keyLabel("Bb", "major")).toBe("Bb major")
    expect(keyLabel("A", "minor")).toBe("A minor")
  })
})

describe("isLowConfidence", () => {
  it("flags weak and missing scores", () => {
    expect(isLowConfidence(0.49)).toBe(true)
    expect(isLowConfidence(0.5)).toBe(false)
    expect(isLowConfidence(Number.NaN)).toBe(true)
  })
})
