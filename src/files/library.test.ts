import { describe, expect, it } from "vitest"
import { matchByName } from "./library.ts"

describe("matchByName", () => {
  it("returns the candidate that is the same file", async () => {
    const other = { name: "track.mp3" }
    const wanted = { name: "track.mp3" }
    await expect(matchByName([other, wanted], async (candidate) => candidate === wanted)).resolves.toBe(wanted)
  })

  it("returns null when every candidate is a different file", async () => {
    await expect(matchByName([{ name: "track.mp3" }], async () => false)).resolves.toBeNull()
  })

  it("returns null when the folder has no file of that name", async () => {
    await expect(matchByName([], async () => true)).resolves.toBeNull()
  })
})
