import { describe, expect, it } from "vitest"
import { isAudioFile, isAudioName, isMp3Name } from "./audio.ts"

describe("audio file names", () => {
  it("accepts the formats the browser can decode", () => {
    for (const name of ["track.mp3", "Track.WAV", "song.aiff", "live.flac", "mix.ogg", "tape.m4a", "voice.aac", "clip.opus"]) {
      expect(isAudioName(name)).toBe(true)
    }
  })

  it("rejects files that are not audio", () => {
    expect(isAudioName("notes.txt")).toBe(false)
    expect(isAudioName("cover.jpg")).toBe(false)
    expect(isAudioFile({ kind: "file", name: "cover.jpg" } as FileSystemHandle)).toBe(false)
    expect(isAudioFile({ kind: "directory", name: "track.mp3" } as FileSystemHandle)).toBe(false)
  })

  it("treats only mp3 as writable", () => {
    expect(isMp3Name("Track.MP3")).toBe(true)
    expect(isMp3Name("track.wav")).toBe(false)
  })
})
