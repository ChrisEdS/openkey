import { describe, expect, it } from "vitest"
import { id3PrefixLength, isBulkRescanTarget, mergeShown, readStoredKey, readStoredKeyFile, shouldSkipAnalysis, shouldSkipStoredKey } from "./writeEnergy.ts"

const audio = [0xff, 0xfb, 0x90, 0x64]

function syncsafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]
}

function chars(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0))
}

function frame(id: string, body: number[]): number[] {
  const size = [(body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff]
  return [...chars(id), ...size, 0, 0, ...body]
}

function textFrame(id: string, text: string): number[] {
  return frame(id, [0, ...chars(text), 0])
}

function tag(frames: number[][], extraAudio: number[] = audio): Uint8Array {
  const body = frames.flat()
  const padding = new Array(16).fill(0)
  const payload = [...body, ...padding]
  const header = [0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(payload.length)]
  return Uint8Array.from([...header, ...payload, ...extraAudio])
}

describe("shouldSkipStoredKey", () => {
  it("recognizes a stored key and ignores an untagged file", () => {
    expect(shouldSkipStoredKey({ keyLabel: "A minor", openKey: "8A" })).toBe(true)
    expect(shouldSkipStoredKey({ keyLabel: null, openKey: null })).toBe(false)
  })
})

describe("shouldSkipAnalysis", () => {
  const finished = { brightness: 0.42, shape: "L" }

  it("still analyzes a key tag because brightness and shape are not in the file", () => {
    expect(shouldSkipAnalysis(undefined)).toBe(false)
    expect(shouldSkipAnalysis(null)).toBe(false)
    expect(shouldSkipAnalysis({ brightness: null, shape: null })).toBe(false)
  })

  it("skips a file this session already finished unless it is a rescan", () => {
    expect(shouldSkipAnalysis(finished)).toBe(true)
    expect(shouldSkipAnalysis(finished, true)).toBe(false)
  })
})

describe("mergeShown", () => {
  it("shows a stored key immediately and leaves brightness and shape empty until analysis", () => {
    expect(mergeShown(null, { keyLabel: "F minor", openKey: "4A", bpm: null, energy: null })).toEqual({
      keyLabel: "F minor",
      openKey: "4A",
      bpm: null,
      energy: null,
      brightness: null,
      shape: null,
    })
  })

  it("keeps a stored tempo when analysis does not find one", () => {
    expect(
      mergeShown(
        {
          keyLabel: "F minor",
          openKey: "4A",
          bpm: null,
          energy: 6,
          brightness: 0.31,
          shape: "B",
        },
        { keyLabel: "F minor", openKey: "4A", bpm: 122, energy: 7 },
      ),
    ).toMatchObject({ bpm: 122, energy: 6, brightness: 0.31, shape: "B" })
  })
})

describe("isBulkRescanTarget", () => {
  const tagged = { keyLabel: "F minor", openKey: "4A" }

  it("includes every tagged or skipped file and leaves a file that is being read or written", () => {
    expect(isBulkRescanTarget({ status: "skipped", stored: null })).toBe(true)
    expect(isBulkRescanTarget({ status: "ready", stored: tagged })).toBe(true)
    expect(isBulkRescanTarget({ status: "queued", stored: tagged })).toBe(true)
    expect(isBulkRescanTarget({ status: "analyzing", stored: tagged })).toBe(false)
    expect(isBulkRescanTarget({ status: "writing", stored: tagged })).toBe(false)
    expect(isBulkRescanTarget({ status: "ready", stored: { keyLabel: null, openKey: null } })).toBe(false)
  })
})

describe("readStoredKey", () => {
  it("finds no key in an untagged mp3", () => {
    const bare = Uint8Array.from(audio)
    const stored = readStoredKey(bare)
    expect(shouldSkipStoredKey(stored)).toBe(false)
    expect(stored).toEqual({ keyLabel: null, openKey: null, energy: null, bpm: null })
  })

  it("finds no key when the tag has a title but no key", () => {
    const stored = readStoredKey(tag([textFrame("TIT2", "Song")]))
    expect(shouldSkipStoredKey(stored)).toBe(false)
    expect(stored.keyLabel).toBeNull()
    expect(stored.openKey).toBeNull()
  })

  it("reads an Open Key written in TKEY", () => {
    const stored = readStoredKey(tag([textFrame("TKEY", "8A"), textFrame("TBPM", "126")]))
    expect(shouldSkipStoredKey(stored)).toBe(true)
    expect(stored.openKey).toBe("8A")
    expect(stored.keyLabel).toBe("A minor")
    expect(stored.bpm).toBe(126)
  })

  it("reads a musical key written in TKEY", () => {
    const stored = readStoredKey(tag([textFrame("TKEY", "F#m")]))
    expect(stored.keyLabel).toBe("F# minor")
    expect(stored.openKey).toBe("11A")
    expect(shouldSkipStoredKey(stored)).toBe(true)
  })

  it("reads MusicalKey, energy, and a Mixed In Key comment", () => {
    const musical = frame("TXXX", [0, ...chars("MusicalKey"), 0, ...chars("A minor"), 0])
    const energy = frame("TXXX", [0, ...chars("EnergyLevel"), 0, ...chars("7"), 0])
    const comment = frame("COMM", [0, ...chars("eng"), 0, ...chars("8A - Energy 7 Intro")])
    const stored = readStoredKey(tag([musical, energy, comment]))
    expect(stored.keyLabel).toBe("A minor")
    expect(stored.openKey).toBe("8A")
    expect(stored.energy).toBe(7)
    expect(shouldSkipStoredKey(stored)).toBe(true)
  })

  it("does not treat energy or tempo alone as a scanned key", () => {
    const energy = frame("TXXX", [0, ...chars("EnergyLevel"), 0, ...chars("7"), 0])
    const stored = readStoredKey(tag([energy, textFrame("TBPM", "122.4"), textFrame("TKEY", "Off")]))
    expect(shouldSkipStoredKey(stored)).toBe(false)
    expect(stored.energy).toBe(7)
    expect(stored.bpm).toBe(122.4)
    expect(stored.openKey).toBeNull()
  })

  it("reads a Mixed In Key comment when TKEY was not written", () => {
    const comment = frame("COMM", [0, ...chars("eng"), 0, ...chars("11A - Energy 4 Intro")])
    const stored = readStoredKey(tag([comment]))
    expect(stored.openKey).toBe("11A")
    expect(stored.keyLabel).toBe("F# minor")
    expect(shouldSkipStoredKey(stored)).toBe(true)
  })
})

describe("id3PrefixLength", () => {
  it("stops at the tag and leaves the audio unread", async () => {
    const bytes = tag([textFrame("TKEY", "8A")], new Array(4000).fill(1))
    const length = id3PrefixLength(bytes)
    expect(length).toBeLessThan(bytes.length)
    expect(readStoredKey(bytes.slice(0, length!)).openKey).toBe("8A")
    let sliced = 0
    const blob = {
      size: bytes.length,
      slice(start?: number, end?: number) {
        sliced = Math.max(sliced, end ?? bytes.length)
        return new Blob([bytes.slice(start, end)])
      },
    } as Blob
    await expect(readStoredKeyFile(blob)).resolves.toMatchObject({ openKey: "8A", keyLabel: "A minor" })
    expect(sliced).toBe(length)
  })
})
