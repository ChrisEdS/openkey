import type { TrackShape } from "./energy.ts"

export type Analysis = {
  keyLabel: string
  openKey: string
  strength: number
  uncertain: boolean
  bpm: number | null
  energy: number
  brightness: number
  shape: TrackShape
  mixesWith: string[]
}
