export type Analysis = {
  keyLabel: string
  openKey: string
  strength: number
  uncertain: boolean
  bpm: number | null
  energy: number
  mixesWith: string[]
}
