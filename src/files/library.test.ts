import { describe, expect, it } from "vitest"
import { matchByName, rememberFolder } from "./library.ts"

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

describe("rememberFolder", () => {
  it("keeps a second folder and ignores the same folder chosen again", async () => {
    const first = folder("Edits")
    const second = folder("House")
    const again = folder("Edits")
    first.isSameEntry = async (other) => other === first || other === again
    const both = await rememberFolder([first], second)
    const once = await rememberFolder(both, again)
    expect(once.map((item) => item.name)).toEqual(["Edits", "House"])
  })
})

function folder(name: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    isSameEntry: async () => false,
  } as FileSystemDirectoryHandle
}
