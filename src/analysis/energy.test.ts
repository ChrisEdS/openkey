import { describe, expect, it } from "vitest"
import { brightnessFromRatio, energyFromFeatures, highFrequencyRatio, shapeFromOnsetRates } from "./energy.ts"

const quiet = { hfRatio: 0, onsetsPerSec: 0, danceability: 0, dynamicComplexity: 0 }

describe("energyFromFeatures", () => {
  it("maps the bottom and top of the fixed ranges", () => {
    expect(energyFromFeatures(quiet)).toBe(1)
    expect(
      energyFromFeatures({ hfRatio: 0.18, onsetsPerSec: 5.5, danceability: 2.2, dynamicComplexity: 10 }),
    ).toBe(10)
  })

  it("clamps values outside the ranges", () => {
    expect(energyFromFeatures({ hfRatio: 1, onsetsPerSec: 20, danceability: 3, dynamicComplexity: 30 })).toBe(10)
  })

  it("ignores a danceability value blown up by a flat signal", () => {
    expect(energyFromFeatures({ ...quiet, danceability: 12 })).toBe(1)
    expect(energyFromFeatures({ ...quiet, danceability: 400 })).toBe(1)
  })

  it("places a peak-time club track near 7 and a sparser groove near 4", () => {
    const peak = energyFromFeatures({
      hfRatio: 0.11,
      onsetsPerSec: 4.2,
      danceability: 1.7,
      dynamicComplexity: 5,
    })
    const groove = energyFromFeatures({
      hfRatio: 0.06,
      onsetsPerSec: 2.2,
      danceability: 1,
      dynamicComplexity: 3,
    })
    expect(peak).toBe(7)
    expect(groove).toBe(4)
    expect(peak).toBe(energyFromFeatures({
      hfRatio: 0.11,
      onsetsPerSec: 4.2,
      danceability: 1.7,
      dynamicComplexity: 5,
    }))
  })
})

describe("brightness and shape", () => {
  it("maps the high-frequency range onto 0–1", () => {
    expect(brightnessFromRatio(0.03)).toBe(0)
    expect(brightnessFromRatio(0.105)).toBe(0.5)
    expect(brightnessFromRatio(0.18)).toBe(1)
    expect(brightnessFromRatio(1)).toBe(1)
  })

  it("labels a level track, a build, and a drop", () => {
    expect(shapeFromOnsetRates([3, 3.2, 3.1, 3])).toBe("L")
    expect(shapeFromOnsetRates([1.5, 2.2, 2.8, 2.4])).toBe("B")
    expect(shapeFromOnsetRates([0.8, 1.2, 5.5, 2])).toBe("D")
    expect(shapeFromOnsetRates([4])).toBe("L")
  })
})

describe("highFrequencyRatio", () => {
  it("keeps a low sine below bright noise", () => {
    const sampleRate = 44100
    const sine = new Float32Array(sampleRate)
    for (let i = 0; i < sine.length; i++) {
      sine[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
    }
    const noise = new Float32Array(sampleRate)
    let seed = 1
    for (let i = 0; i < noise.length; i++) {
      seed = (seed + 0x6d2b79f5) | 0
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
      noise[i] = (((value ^ (value >>> 14)) >>> 0) / 4294967296) * 2 - 1
    }

    const sineRatio = highFrequencyRatio(sine, sampleRate)
    const noiseRatio = highFrequencyRatio(noise, sampleRate)
    expect(energyFromFeatures({ ...quiet, hfRatio: sineRatio })).toBe(1)
    expect(noiseRatio).toBeGreaterThan(sineRatio)
  })
})
