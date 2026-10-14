import { describe, expect, it } from "vitest"
import { computeEnergyFeatures, energyFromFeatures } from "./energy.ts"

describe("energyFromFeatures", () => {
  it("maps the bottom and top of the fixed ranges", () => {
    expect(energyFromFeatures({ hfRatio: 0.04, onsetsPerSec: 1, centroidHz: 900 })).toBe(1)
    expect(energyFromFeatures({ hfRatio: 0.28, onsetsPerSec: 7, centroidHz: 3200 })).toBe(10)
  })

  it("clamps values outside the ranges", () => {
    expect(energyFromFeatures({ hfRatio: 0, onsetsPerSec: 0, centroidHz: 100 })).toBe(1)
    expect(energyFromFeatures({ hfRatio: 1, onsetsPerSec: 20, centroidHz: 8000 })).toBe(10)
  })

  it("returns a stable mid score", () => {
    const features = { hfRatio: 0.16, onsetsPerSec: 4, centroidHz: 2050 }
    expect(energyFromFeatures(features)).toBe(6)
    expect(energyFromFeatures(features)).toBe(energyFromFeatures(features))
  })
})

describe("computeEnergyFeatures", () => {
  it("scores a low sine below bright noise", () => {
    const sampleRate = 44100
    const sine = new Float32Array(sampleRate * 2)
    for (let i = 0; i < sine.length; i++) {
      sine[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate)
    }
    const noise = new Float32Array(sampleRate * 2)
    let seed = 1
    for (let i = 0; i < noise.length; i++) {
      seed = (seed + 0x6d2b79f5) | 0
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
      noise[i] = (((value ^ (value >>> 14)) >>> 0) / 4294967296) * 2 - 1
    }

    const sineEnergy = energyFromFeatures(computeEnergyFeatures(sine, sampleRate))
    const noiseEnergy = energyFromFeatures(computeEnergyFeatures(noise, sampleRate))
    expect(sineEnergy).toBe(1)
    expect(noiseEnergy).toBeGreaterThan(sineEnergy)
  })
})
