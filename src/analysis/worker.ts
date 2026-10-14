// essentia.js is AGPL-3.0. That license applies if this app is distributed.
import Essentia from "essentia.js/dist/essentia.js-core.es.js"
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js"
import { computeEnergyFeatures, energyFromFeatures } from "./energy.ts"
import { isLowConfidence, keyLabel, mixesWith, openKeyCode } from "./openKey.ts"
import type { Analysis } from "./types.ts"

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

function analyze(samples: Float32Array, sampleRate: number): Analysis {
  if (samples.length === 0) throw new Error("This file has no audio to analyze")

  const engine = library()
  const keySignal = engine.arrayToVector(samples)
  const bpmSignal = engine.arrayToVector(samples)
  try {
    const key = engine.KeyExtractor(
      keySignal,
      true,
      4096,
      4096,
      12,
      3500,
      60,
      25,
      0.2,
      "bgate",
      sampleRate,
      0.0001,
      440,
      "cosine",
      "hann",
    )
    const tempo = engine.PercivalBpmEstimator(bpmSignal, 1024, 2048, 128, 128, 210, 50, sampleRate)
    const code = openKeyCode(key.key, key.scale)
    if (!code) throw new Error(`Unrecognized key ${key.key} ${key.scale}`)
    const strength = Number(key.strength)
    const bpm = Number(tempo.bpm)
    return {
      keyLabel: keyLabel(key.key, key.scale),
      openKey: code,
      strength,
      uncertain: isLowConfidence(strength),
      bpm: Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm * 10) / 10 : null,
      energy: energyFromFeatures(computeEnergyFeatures(samples, sampleRate)),
      mixesWith: mixesWith(code),
    }
  } finally {
    release(keySignal)
    release(bpmSignal)
  }
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
    const message = error instanceof Error ? error.message : String(error)
    scope.postMessage({ id, error: message })
  }
}
