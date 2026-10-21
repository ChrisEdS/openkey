import { describe, expect, it } from "vitest"
import { ALL_COLUMNS, trackListCsv, UNWRITTEN_COLUMNS, type TrackListRow } from "./trackList.ts"

const row: TrackListRow = {
  file: "Dr. Dre, Snoop Dogg - Still D.R.E.mp3",
  key: "Bb minor",
  openKey: "3A",
  bpm: "127.8",
  energy: "6",
  brightness: "0.31",
  shape: "B",
  mixesWith: "2A 4A 3B",
  status: "Ready",
}

describe("track list csv", () => {
  it("keeps the table columns and a spreadsheet-friendly header", () => {
    const csv = trackListCsv([row])
    expect(csv.startsWith("\uFEFF")).toBe(true)
    expect(csv).toContain("File,Key,Open Key,BPM,Energy,Brightness,Shape,Mixes with,Status")
    expect(csv).toContain('"Dr. Dre, Snoop Dogg - Still D.R.E.mp3",Bb minor,3A,127.8,6,0.31,B,2A 4A 3B,Ready')
  })

  it("quotes quotes and leaves a row without analysis blank", () => {
    const csv = trackListCsv([
      { ...row, file: 'Say "Go".wav', key: "A minor (low confidence)" },
      { file: "quiet.mp3", key: "", openKey: "", bpm: "", energy: "", brightness: "", shape: "", mixesWith: "", status: "Failed" },
    ])
    expect(csv).toContain('"Say ""Go"".wav",A minor (low confidence),3A,127.8,6,0.31,B,2A 4A 3B,Ready')
    expect(csv).toContain("quiet.mp3,,,,,,,,Failed")
  })

  it("can keep only the values that are never written into the file", () => {
    const csv = trackListCsv([row], UNWRITTEN_COLUMNS)
    expect(csv).toContain("File,Brightness,Shape,Mixes with")
    expect(csv).not.toContain("Energy")
    expect(csv).toContain('"Dr. Dre, Snoop Dogg - Still D.R.E.mp3",0.31,B,2A 4A 3B')
    expect(UNWRITTEN_COLUMNS.every((column) => ALL_COLUMNS.includes(column))).toBe(true)
  })
})
