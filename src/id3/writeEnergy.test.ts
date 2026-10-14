import { describe, expect, it } from "vitest"
import { applyEnergyToken, readEnergyFields, readId3, writeEnergy } from "./writeEnergy.ts"

const audio = [0xff, 0xfb, 0x90, 0x64, 0x49, 0x44, 0x33, 0x11, 0x22]

function syncsafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]
}

function u32(size: number): number[] {
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]
}

function chars(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0))
}

function frame(version: number, id: string, body: number[]): number[] {
  const size = version === 4 ? syncsafe(body.length) : u32(body.length)
  return [...chars(id), ...size, 0, 0, ...body]
}

function buildTag(options: {
  version?: number
  frames: number[][]
  padding?: number
  unsync?: boolean
  extended?: boolean
  footer?: boolean
  audio?: number[]
}): Uint8Array {
  const version = options.version ?? 3
  let body: number[] = []
  if (options.extended) {
    body = version === 3 ? [0, 0, 0, 6, 0, 0, 0, 0, 0, 0] : [...syncsafe(6), 1, 0]
  }
  for (const item of options.frames) body.push(...item)
  body.push(...new Array(options.padding ?? 64).fill(0))
  if (options.unsync) body = unsync(body)
  const flags = (options.unsync ? 0x80 : 0) | (options.extended ? 0x40 : 0) | (options.footer ? 0x10 : 0)
  const header = [0x49, 0x44, 0x33, version, 0, flags, ...syncsafe(body.length)]
  return Uint8Array.from([...header, ...body, ...(options.footer ? header : []), ...(options.audio ?? audio)])
}

function unsync(data: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < data.length; i++) {
    out.push(data[i])
    if (data[i] === 0xff && i + 1 < data.length) {
      const next = data[i + 1]
      if (next === 0 || next >= 0xe0) out.push(0)
    }
  }
  return out
}

function textFrame(version: number, id: string, text: string): number[] {
  return frame(version, id, [0, ...chars(text), 0])
}

function energyFrame(version: number, value: string): number[] {
  return frame(version, "TXXX", [0, ...chars("EnergyLevel"), 0, ...chars(value), 0])
}

function commentFrame(version: number, text: string): number[] {
  return frame(version, "COMM", [0, ...chars("eng"), 0, ...chars(text)])
}

function frameBody(data: Uint8Array, id: string): Uint8Array {
  const found = readId3(data).frames.find((item) => item.id === id)
  if (!found) throw new Error(`missing ${id}`)
  return found.body
}

describe("applyEnergyToken", () => {
  it("replaces an existing token and appends when there is none", () => {
    expect(applyEnergyToken("Intro | Energy 3", 7)).toBe("Intro | Energy 7")
    expect(applyEnergyToken("Energy 3", 7)).toBe("Energy 7")
    expect(applyEnergyToken("Live set", 7)).toBe("Live set | Energy 7")
    expect(applyEnergyToken("   ", 4)).toBe("Energy 4")
  })
})

describe("writeEnergy", () => {
  const geob = [0, 255, 0, 255, 224, 9, 8, 7]
  const apic = [0, 1, 2, 255, 0, 3, 4, 5]
  const replay = frame(3, "TXXX", [0, ...chars("REPLAYGAIN_TRACK_GAIN"), 0, ...chars("-6.5"), 0])
  const norm = frame(3, "COMM", [0, ...chars("eng"), ...chars("iTunNORM"), 0, ...chars("abc")])

  function libraryTag(extra: Partial<Parameters<typeof buildTag>[0]> = {}): Uint8Array {
    return buildTag({
      padding: 256,
      frames: [
        textFrame(3, "TIT2", "Song"),
        textFrame(3, "TKEY", "8A"),
        energyFrame(3, "3"),
        commentFrame(3, "Intro | Energy 3"),
        replay,
        norm,
        frame(3, "GEOB", geob),
        frame(3, "APIC", apic),
      ],
      ...extra,
    })
  }

  it("updates energy and keeps every other frame and the audio", () => {
    const input = libraryTag()
    const output = writeEnergy(input, 7)
    const fields = readEnergyFields(output)
    expect(fields.energyLevel).toBe("7")
    expect(fields.comment).toBe("Intro | Energy 7")
    expect([...frameBody(output, "GEOB")]).toEqual(geob)
    expect([...frameBody(output, "APIC")]).toEqual(apic)
    expect([...frameBody(output, "TKEY")]).toEqual([0, ...chars("8A"), 0])
    expect([...frameBody(output, "TIT2")]).toEqual([0, ...chars("Song"), 0])
    expect(readId3(output).frames.filter((item) => item.id === "TXXX")).toHaveLength(2)
    expect([...readId3(output).audio]).toEqual(audio)
    expect(output.length).toBe(input.length)
    expect([...input.slice(0, 3)]).toEqual([0x49, 0x44, 0x33])
  })

  it("replaces the energy fields again without growing the file", () => {
    const once = writeEnergy(libraryTag(), 7)
    const twice = writeEnergy(once, 8)
    expect(readEnergyFields(twice)).toEqual({ energyLevel: "8", comment: "Intro | Energy 8" })
    expect(twice.length).toBe(once.length)
    expect([...frameBody(twice, "GEOB")]).toEqual(geob)
    expect(readId3(twice).frames.filter((item) => item.id === "TXXX")).toHaveLength(2)
  })

  it("prepends a tag when the file has none", () => {
    const bare = Uint8Array.from(audio)
    const output = writeEnergy(bare, 4)
    expect(readEnergyFields(output)).toEqual({ energyLevel: "4", comment: "Energy 4" })
    expect([...readId3(output).audio]).toEqual(audio)
    expect([...bare]).toEqual(audio)
  })

  it("grows the tag when padding cannot hold the new frames", () => {
    const input = buildTag({
      padding: 0,
      frames: [textFrame(3, "TIT2", "Song"), frame(3, "GEOB", geob)],
    })
    const output = writeEnergy(input, 6)
    expect(output.length).toBeGreaterThan(input.length)
    expect([...readId3(output).audio]).toEqual(audio)
    expect([...frameBody(output, "GEOB")]).toEqual(geob)
    expect(readEnergyFields(output).comment).toBe("Energy 6")
  })

  it("reads an unsynchronised v2.3 tag and writes the marker bytes back", () => {
    const input = buildTag({
      unsync: true,
      padding: 256,
      frames: [textFrame(3, "TIT2", "Song"), frame(3, "GEOB", geob), commentFrame(3, "Live set")],
    })
    const output = writeEnergy(input, 5)
    expect([...frameBody(output, "GEOB")]).toEqual(geob)
    expect([...frameBody(output, "TIT2")]).toEqual([0, ...chars("Song"), 0])
    expect(readEnergyFields(output).comment).toBe("Live set | Energy 5")
    expect([...readId3(output).audio]).toEqual(audio)
  })

  it("keeps a title that follows an extended header", () => {
    for (const version of [3, 4]) {
      const input = buildTag({
        version,
        extended: true,
        padding: 128,
        frames: [textFrame(version, "TIT2", "Song"), frame(version, "GEOB", geob)],
      })
      const output = writeEnergy(input, 2)
      expect([...frameBody(output, "TIT2")]).toEqual([0, ...chars("Song"), 0])
      expect([...frameBody(output, "GEOB")]).toEqual(geob)
      expect([...readId3(output).audio]).toEqual(audio)
    }
  })

  it("keeps audio that sits after a v2.4 footer", () => {
    const input = buildTag({
      version: 4,
      footer: true,
      padding: 128,
      frames: [textFrame(4, "TIT2", "Song"), frame(4, "GEOB", geob)],
    })
    const output = writeEnergy(input, 9)
    expect([...readId3(output).audio]).toEqual(audio)
    expect([...frameBody(output, "GEOB")]).toEqual(geob)
    expect(readEnergyFields(output).energyLevel).toBe("9")
  })

  it("preserves a unicode comment", () => {
    const unicode = frame(3, "COMM", [
      1,
      ...chars("eng"),
      0xff, 0xfe, 0x00, 0x00,
      0xff, 0xfe, 0x71, 0x67, 0xac, 0x4e,
    ])
    const output = writeEnergy(buildTag({ padding: 256, frames: [unicode, frame(3, "GEOB", geob)] }), 7)
    expect(readEnergyFields(output).comment).toBe("東京 | Energy 7")
    expect([...frameBody(output, "GEOB")]).toEqual(geob)
  })

  it("refuses ID3v2.2 without changing the file", () => {
    const input = Uint8Array.from([0x49, 0x44, 0x33, 2, 0, 0, 0, 0, 0, 0, 0xff, 0xfb])
    const copy = input.slice()
    expect(() => writeEnergy(input, 5)).toThrow(/ID3v2\.2/)
    expect([...input]).toEqual([...copy])
  })

  it("refuses a compressed comment", () => {
    const comm = frame(3, "COMM", [0, ...chars("eng"), 0, ...chars("Hello")])
    comm[9] = 0x80
    const input = buildTag({ padding: 64, frames: [comm] })
    expect(() => writeEnergy(input, 5)).toThrow(/unchanged/)
  })
})
