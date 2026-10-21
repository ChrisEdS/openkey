// essentia.js is AGPL-3.0. That license applies if this app is distributed.
import Essentia from "essentia.js/dist/essentia.js-core.es.js"
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js"
import { brightnessFromRatio, energyFromFeatures, highFrequencyRatio, shapeFromOnsetRates } from "./energy.ts"
import { isLowConfidence, keyLabel, mixesWith, openKeyCode } from "./openKey.ts"
import { resampleLinear } from "./resample.ts"
import type { Analysis } from "./types.ts"
import { wasmErrorMessage } from "./wasmError.ts"

type VectorFloat = { delete?: () => void }
type EssentiaModule = {
  arrayToVector(input: Float32Array): VectorFloat
  KeyExtractor(
    audio: VectorFloat,
    averageDetuningCorrection: boolean,
    frameSize: number,
    hopSize: number,
    hpcpSize: number,
    maxFrequency: number,
    maximumSpectralPeaks: number,
    minFrequency: number,
    pcpThreshold: number,
    profileType: string,
    sampleRate: number,
    spectralPeaksThreshold: number,
    tuningFrequency: number,
    weightType: string,
    windowType: string,
  ): { key: string; scale: string; strength: number }
  PercivalBpmEstimator(
    signal: VectorFloat,
    frameSize: number,
    frameSizeOSS: number,
    hopSize: number,
    hopSizeOSS: number,
    maxBPM: number,
    minBPM: number,
    sampleRate: number,
  ): { bpm: number }
  OnsetRate(signal: VectorFloat): { onsetRate: number; onsets?: VectorFloat }
  Danceability(
    signal: VectorFloat,
    maxTau: number,
    minTau: number,
    sampleRate: number,
    tauMultiplier: number,
  ): { danceability: number; dfa?: VectorFloat }
  DynamicComplexity(signal: VectorFloat, frameSize: number, sampleRate: number): { dynamicComplexity: number; loudness?: number }
}

const EssentiaCtor = Essentia as unknown as new (wasm: unknown) => EssentiaModule
let essentia: EssentiaModule | null = null

function library(): EssentiaModule {
  essentia ??= new EssentiaCtor(EssentiaWASM)
  return essentia
}

function release(vector: VectorFloat | null): void {
  try {
    vector?.delete?.()
  } catch {
    // The wasm vector is already gone.
  }
}

const KEY_FRAME = 4096
const SILENCE = 1e-5

function analyze(samples: Float32Array, sampleRate: number): Analysis {
  prepareSamples(samples)
  if (samples.length === 0 || peak(samples) < SILENCE) throw new Error("This file has no audible audio")
  if (samples.length < KEY_FRAME) throw new Error("This file is too short to analyze")

  const engine = library()
  const key = estimateKey(engine, samples, sampleRate)
  const code = openKeyCode(key.key, key.scale)
  if (!code) throw new Error(`Unrecognized key ${key.key} ${key.scale}`)
  const strength = Number(key.strength)
  const portrait = trackPortrait(engine, samples, sampleRate)
  return {
    keyLabel: keyLabel(key.key, key.scale),
    openKey: code,
    strength,
    uncertain: isLowConfidence(strength),
    bpm: estimateBpm(engine, samples, sampleRate),
    energy: portrait.energy,
    brightness: portrait.brightness,
    shape: portrait.shape,
    mixesWith: mixesWith(code),
  }
}

function prepareSamples(samples: Float32Array): void {
  for (let index = 0; index < samples.length; index++) {
    if (!Number.isFinite(samples[index]!)) samples[index] = 0
  }
}

function peak(samples: Float32Array): number {
  let max = 0
  for (let index = 0; index < samples.length; index++) {
    const value = Math.abs(samples[index]!)
    if (value > max) max = value
  }
  return max
}

function estimateKey(engine: EssentiaModule, samples: Float32Array, sampleRate: number): { key: string; scale: string; strength: number } {
  const signal = engine.arrayToVector(samples)
  try {
    return engine.KeyExtractor(signal, true, KEY_FRAME, KEY_FRAME, 12, 3500, 60, 25, 0.2, "bgate", sampleRate, 0.0001, 440, "cosine", "hann")
  } catch (error) {
    throw new Error(wasmErrorMessage(EssentiaWASM as { HEAPU8?: Uint8Array; HEAP32?: Int32Array }, error))
  } finally {
    release(signal)
  }
}

function estimateBpm(engine: EssentiaModule, samples: Float32Array, sampleRate: number): number | null {
  const signal = engine.arrayToVector(samples)
  try {
    const tempo = engine.PercivalBpmEstimator(signal, 1024, 2048, 128, 128, 210, 50, sampleRate)
    const bpm = Number(tempo.bpm)
    return Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm * 10) / 10 : null
  } catch {
    // A missing tempo still leaves key and energy. The thrown value is a wasm pointer.
    return null
  } finally {
    release(signal)
  }
}

const SECTION_MARKS = [0, 0.35, 0.5, 0.75]
const SECTION_SECONDS = 15

function trackPortrait(engine: EssentiaModule, samples: Float32Array, sampleRate: number): {
  energy: number
  brightness: number
  shape: ReturnType<typeof shapeFromOnsetRates>
} {
  const hfRatio = highFrequencyRatio(samples, sampleRate)
  const rhythm = { onsetsPerSec: 0, danceability: 0, dynamicComplexity: 0 }
  let prepared: PreparedSignal | null = null
  try {
    prepared = signalAt44100(engine, samples, sampleRate)
    const onsets = engine.OnsetRate(prepared.signal)
    rhythm.onsetsPerSec = finite(onsets.onsetRate)
    release(onsets.onsets ?? null)
    const dance = engine.Danceability(prepared.signal, 8800, 310, 44100, 1.1)
    rhythm.danceability = finite(dance.danceability)
    release(dance.dfa ?? null)
    const dynamics = engine.DynamicComplexity(prepared.signal, 0.2, 44100)
    rhythm.dynamicComplexity = finite(dynamics.dynamicComplexity)
  } catch {
    // A missing rhythm estimate still leaves the spectral ratio.
  } finally {
    prepared?.release()
  }
  return {
    energy: energyFromFeatures({ hfRatio, ...rhythm }),
    brightness: brightnessFromRatio(hfRatio),
    shape: shapeFromOnsetRates(sectionOnsetRates(engine, samples, sampleRate)),
  }
}

function sectionOnsetRates(engine: EssentiaModule, samples: Float32Array, sampleRate: number): number[] {
  const windowSamples = Math.floor(SECTION_SECONDS * sampleRate)
  const rates: number[] = []
  for (const mark of SECTION_MARKS) {
    const start = Math.min(samples.length, Math.floor(mark * samples.length))
    const end = Math.min(samples.length, start + windowSamples)
    if (end - start < sampleRate) continue
    const prepared = signalAt44100(engine, samples.slice(start, end), sampleRate)
    try {
      const onsets = engine.OnsetRate(prepared.signal)
      rates.push(finite(onsets.onsetRate))
      release(onsets.onsets ?? null)
    } catch {
      // One short section can fail without hiding the others.
    } finally {
      prepared.release()
    }
  }
  return rates
}

type PreparedSignal = {
  signal: VectorFloat
  release: () => void
}

function signalAt44100(engine: EssentiaModule, samples: Float32Array, sampleRate: number): PreparedSignal {
  const atRate = Math.round(sampleRate) === 44100 ? samples : resampleLinear(samples, sampleRate, 44100)
  const signal = engine.arrayToVector(atRate)
  return { signal, release: () => release(signal) }
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

type WorkerScope = {
  onmessage: ((event: MessageEvent<{ id: number; samples: Float32Array; sampleRate: number }>) => void) | null
  postMessage(message: unknown): void
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  const { id, samples, sampleRate } = event.data
  try {
    scope.postMessage({ id, result: analyze(samples, sampleRate) })
  } catch (error) {
    scope.postMessage({ id, error: wasmErrorMessage(EssentiaWASM as { HEAPU8?: Uint8Array; HEAP32?: Int32Array }, error) })
  }
}
