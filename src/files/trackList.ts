export type TrackListColumn = "file" | "key" | "openKey" | "bpm" | "energy" | "brightness" | "shape" | "mixesWith" | "status"

export type TrackListRow = Record<TrackListColumn, string>

const HEADER: Record<TrackListColumn, string> = {
  file: "File",
  key: "Key",
  openKey: "Open Key",
  bpm: "BPM",
  energy: "Energy",
  brightness: "Brightness",
  shape: "Shape",
  mixesWith: "Mixes with",
  status: "Status",
}

/** Brightness, shape, and mixes-with are shown in the table and never written into the file. */
export const UNWRITTEN_COLUMNS: TrackListColumn[] = ["file", "brightness", "shape", "mixesWith"]

export const ALL_COLUMNS: TrackListColumn[] = ["file", "key", "openKey", "bpm", "energy", "brightness", "shape", "mixesWith", "status"]

export function trackListCsv(rows: TrackListRow[], columns: TrackListColumn[] = ALL_COLUMNS): string {
  const lines = [columns.map((column) => HEADER[column]), ...rows.map((row) => columns.map((column) => row[column]))]
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(",")).join("\r\n")}\r\n`
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`
  return value
}
