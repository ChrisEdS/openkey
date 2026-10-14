import { analyzeFile } from "./analysis/client.ts"
import type { Analysis } from "./analysis/types.ts"
import { readEnergyFields, readId3, writeEnergy, type Id3Tag } from "./id3/writeEnergy.ts"

declare global {
  interface Window {
    __openkey?: {
      analyzeFile: (file: File) => Promise<Analysis>
      writeEnergy: (data: Uint8Array, energy: number) => Uint8Array
      readEnergyFields: (data: Uint8Array) => { energyLevel: string | null; comment: string | null }
      readId3: (data: Uint8Array) => Id3Tag
    }
  }
}

window.__openkey = { analyzeFile, writeEnergy, readEnergyFields, readId3 }
