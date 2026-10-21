import { describe, expect, it } from "vitest"
import { resampleLinear } from "./resample.ts"

describe("resampleLinear", () => {
  it("returns the same samples when the rate does not change", () => {
    const input = Float32Array.from([0, 0.5, 1])
    expect(resampleLinear(input, 44100, 44100)).toBe(input)
  })

  it("doubles the length when the rate doubles", () => {
    const input = Float32Array.from([0, 1])
    const output = resampleLinear(input, 22050, 44100)
    expect(output.length).toBe(4)
    expect(output[0]).toBeCloseTo(0)
    expect(output[output.length - 1]).toBeCloseTo(1)
  })
})
