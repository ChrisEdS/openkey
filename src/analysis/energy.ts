/**
 * Fixed 1–10 intensity score.
 * Retune the ranges below after listening to real tracks.
 * Same features always produce the same integer.
 */
const HF_LOW = 0.04
const HF_HIGH = 0.28
const ONSET_LOW = 1
const ONSET_HIGH = 7
const CENTROID_LOW = 900
const CENTROID_HIGH = 3200

const FRAME = 2048
const HOP = 1024
const HF_HZ = 5000

export type EnergyFeatures = {
  hfRatio: number
  onsetsPerSec: number
  centroidHz: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function scale(value: number, low: number, high: number): number {
  return clamp((value - low) / (high - low), 0, 1)
}

export function energyFromFeatures(features: EnergyFeatures): number {
  const hf = scale(features.hfRatio, HF_LOW, HF_HIGH)
  const drive = scale(features.onsetsPerSec, ONSET_LOW, ONSET_HIGH)
  const brightness = scale(features.centroidHz, CENTROID_LOW, CENTROID_HIGH)
  const score = 0.4 * hf + 0.35 * drive + 0.25 * brightness
  return clamp(Math.round(1 + score * 9), 1, 10)
}

const hann = new Float32Array(FRAME)
for (let i = 0; i < FRAME; i++) {
  hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FRAME - 1)))
}

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const swapRe = re[i]
      re[i] = re[j]
      re[j] = swapRe
      const swapIm = im[i]
      im[i] = im[j]
      im[j] = swapIm
    }
  }

  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const wlenRe = Math.cos(angle)
    const wlenIm = Math.sin(angle)
    for (let i = 0; i < n; i += length) {
      let wRe = 1
      let wIm = 0
      const half = length >> 1
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + half] = uRe - vRe
        im[i + j + half] = uIm - vIm
        const nextRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nextRe
      }
    }
  }
}

function countOnsets(flux: number[], sampleRate: number): number {
  if (flux.length === 0) return 0
  let mean = 0
  for (const value of flux) mean += value
  mean /= flux.length
  let variance = 0
  for (const value of flux) {
    const delta = value - mean
    variance += delta * delta
  }
  const deviation = Math.sqrt(variance / flux.length)
  const threshold = mean + 1.5 * deviation
  const minGap = Math.max(1, Math.round((0.05 * sampleRate) / HOP))
  let count = 0
  let last = -minGap
  for (let i = 1; i < flux.length - 1; i++) {
    const value = flux[i]
    if (value > threshold && value >= flux[i - 1] && value > flux[i + 1] && i - last >= minGap) {
      count += 1
      last = i
    }
  }
  return count
}

export function computeEnergyFeatures(input: Float32Array, sampleRate: number): EnergyFeatures {
  if (input.length === 0 || sampleRate <= 0) {
    return { hfRatio: 0, onsetsPerSec: 0, centroidHz: 0 }
  }

  const samples = input.length >= FRAME ? input : padded(input)
  const re = new Float32Array(FRAME)
  const im = new Float32Array(FRAME)
  const previous = new Float32Array(FRAME / 2)
  const binHz = sampleRate / FRAME
  const hfBin = Math.min(FRAME / 2, Math.max(1, Math.ceil(HF_HZ / binHz)))
  let centroidSum = 0
  let hfSum = 0
  let frames = 0
  const flux: number[] = []

  for (let start = 0; start + FRAME <= samples.length; start += HOP) {
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[start + i] * hann[i]
      im[i] = 0
    }
    fft(re, im)

    let magnitudeSum = 0
    let weighted = 0
    let lowPower = 0
    let highPower = 0
    let frameFlux = 0
    for (let bin = 1; bin < FRAME / 2; bin++) {
      const magnitude = Math.hypot(re[bin], im[bin])
      const power = magnitude * magnitude
      magnitudeSum += magnitude
      weighted += magnitude * bin * binHz
      if (bin >= hfBin) highPower += power
      else lowPower += power
      const rise = magnitude - previous[bin]
      if (rise > 0) frameFlux += rise
      previous[bin] = magnitude
    }
    const totalPower = lowPower + highPower
    if (magnitudeSum > 1e-8) {
      centroidSum += weighted / magnitudeSum
      hfSum += totalPower > 0 ? highPower / totalPower : 0
    }
    flux.push(frameFlux)
    frames += 1
  }

  const duration = samples.length / sampleRate
  return {
    hfRatio: frames > 0 ? hfSum / frames : 0,
    centroidHz: frames > 0 ? centroidSum / frames : 0,
    onsetsPerSec: duration > 0 ? countOnsets(flux, sampleRate) / duration : 0,
  }
}

function padded(input: Float32Array): Float32Array {
  const samples = new Float32Array(FRAME)
  samples.set(input)
  return samples
}
