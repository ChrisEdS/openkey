import { describe, expect, it } from "vitest"
import { ensureWrite, matchByName, rememberFolder } from "./library.ts"

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
  it("keeps a second folder and replaces a saved folder with the handle just chosen", async () => {
    const first = folder("Edits")
    const second = folder("House")
    const again = folder("Edits")
    first.isSameEntry = async (other) => other === first || other === again
    const both = await rememberFolder([first], second)
    const once = await rememberFolder(both, again)
    expect(once).toEqual([again, second])
  })
})

describe("ensureWrite", () => {
  it("uses a folder that is already writable", async () => {
    const handle = permissionHandle("granted")
    await expect(ensureWrite(handle)).resolves.toBe(true)
    expect(handle.requested).toBe(false)
  })

  it("asks again when the saved folder is waiting for permission", async () => {
    const handle = permissionHandle("prompt", "granted")
    await expect(ensureWrite(handle)).resolves.toBe(true)
    expect(handle.requested).toBe(true)
  })

  it("leaves a refused folder alone", async () => {
    const handle = permissionHandle("prompt", "denied")
    await expect(ensureWrite(handle)).resolves.toBe(false)
  })
})

function folder(name: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    isSameEntry: async () => false,
  } as FileSystemDirectoryHandle
}

function permissionHandle(state: PermissionState, next: PermissionState = state) {
  return {
    kind: "directory",
    name: "Edits",
    requested: false,
    queryPermission: async () => state,
    requestPermission: async function () {
      this.requested = true
      return next
    },
  } as FileSystemHandle & { requested: boolean }
}
