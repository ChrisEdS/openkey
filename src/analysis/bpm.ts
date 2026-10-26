/**
 * Other tempo when half-time and double-time are both normal dance tempos.
 * About 70–100 and 140–200 share a beat, as with 87 and 174.
 * A house tempo such as 128 is left alone, so it does not grow an "also 64".
 */
const SLOW_MIN = 70
const SLOW_MAX = 100
const FAST_MIN = 140
const FAST_MAX = 200

export function formatTempo(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
}

export function tempoAlternate(bpm: number): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  const tempo = roundTempo(bpm)
  const doubled = roundTempo(tempo * 2)
  const halved = roundTempo(tempo / 2)
  if (within(tempo, SLOW_MIN, SLOW_MAX) && within(doubled, FAST_MIN, FAST_MAX)) return doubled
  if (within(tempo, FAST_MIN, FAST_MAX) && within(halved, SLOW_MIN, SLOW_MAX)) return halved
  return null
}

export function tempoListText(bpm: number): string {
  const text = formatTempo(bpm)
  const other = tempoAlternate(bpm)
  if (other == null) return text
  return `${text} (also ${formatTempo(other)})`
}

function within(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

function roundTempo(bpm: number): number {
  return Math.round(bpm * 10) / 10
}
