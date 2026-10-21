import { describe, expect, it } from "vitest"
import { autoSaveAction, containingFolder, ensureWrite, grantedWriteHandle, matchByName, rememberFolder, rememberMp3Paths, writableFile } from "./library.ts"

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

describe("autoSaveAction", () => {
  const ready = {
    enabled: true,
    mp3: true,
    hasAnalysis: true,
    selected: true,
    stopped: false,
    directoryGranted: false,
    fileGranted: false,
  }

  it("writes when the folder is granted even if the listed file is only prompt", () => {
    expect(autoSaveAction({ ...ready, directoryGranted: true, fileGranted: false })).toBe("write")
  })

  it("writes a file the user already allowed on its own", () => {
    expect(autoSaveAction({ ...ready, fileGranted: true })).toBe("write")
  })

  it("waits for one folder grant when nothing is writable yet", () => {
    expect(autoSaveAction(ready)).toBe("wait")
  })

  it("skips when auto-save is off, the file is not an mp3, or the queue is stopped", () => {
    expect(autoSaveAction({ ...ready, enabled: false, directoryGranted: true })).toBe("skip")
    expect(autoSaveAction({ ...ready, mp3: false, directoryGranted: true })).toBe("skip")
    expect(autoSaveAction({ ...ready, hasAnalysis: false, directoryGranted: true })).toBe("skip")
    expect(autoSaveAction({ ...ready, selected: false, directoryGranted: true })).toBe("skip")
    expect(autoSaveAction({ ...ready, stopped: true, directoryGranted: true })).toBe("skip")
  })
})

describe("grantedWriteHandle", () => {
  it("gets a fresh handle from the folder instead of the dropped file", async () => {
    const dropped = permissionFile("song.mp3", "prompt")
    const fresh = permissionFile("song.mp3", "prompt")
    const directory = writableDirectory(fresh)
    await expect(grantedWriteHandle(directory, dropped, ["live", "song.mp3"])).resolves.toBe(fresh)
    expect(dropped.requested).toBe(false)
    expect(directory.requested).toBe(false)
  })

  it("does not open a save dialog when the folder is not already writable", async () => {
    const dropped = permissionFile("song.mp3", "prompt")
    const directory = permissionHandle("prompt")
    let opened = false
    directory.getFileHandle = async () => {
      opened = true
      return dropped
    }
    await expect(grantedWriteHandle(directory, dropped, ["song.mp3"])).resolves.toBeNull()
    expect(opened).toBe(false)
    expect(directory.requested).toBe(false)
    expect(dropped.requested).toBe(false)
  })

  it("uses a file the user already allowed", async () => {
    const file = permissionFile("song.mp3", "granted")
    await expect(grantedWriteHandle(undefined, file)).resolves.toBe(file)
    expect(file.requested).toBe(false)
  })

  it("re-fetches a listed file from a granted folder without walking or prompting", async () => {
    const listed = permissionFile("song.mp3", "prompt")
    const fresh = permissionFile("song.mp3", "prompt")
    let walked = false
    const directory = {
      kind: "directory",
      name: "Edits",
      requested: false,
      queryPermission: async () => "granted" as PermissionState,
      requestPermission: async function (this: { requested: boolean }) {
        this.requested = true
        return "granted" as PermissionState
      },
      resolve: async () => ["song.mp3"],
      getFileHandle: async () => fresh,
      values: () => {
        walked = true
        throw new Error("should not walk")
      },
    } as unknown as FileSystemDirectoryHandle & { requested: boolean }
    await expect(grantedWriteHandle(directory, listed)).resolves.toBe(fresh)
    expect(walked).toBe(false)
    expect(directory.requested).toBe(false)
    expect(listed.requested).toBe(false)
  })

  it("resolves the file through the folder when that folder can already be written", async () => {
    const dropped = permissionFile("song.mp3", "prompt")
    const fresh = permissionFile("song.mp3", "prompt")
    const directory = {
      kind: "directory",
      name: "Edits",
      requested: false,
      queryPermission: async () => "granted" as PermissionState,
      requestPermission: async function (this: { requested: boolean }) {
        this.requested = true
        return "granted" as PermissionState
      },
      resolve: async (handle: FileSystemHandle) => (handle === dropped ? ["song.mp3"] : null),
      getFileHandle: async () => fresh,
    } as unknown as FileSystemDirectoryHandle & { requested: boolean }
    await expect(writableFile(directory, dropped)).resolves.toBe(fresh)
  })
})

describe("writableFile index", () => {
  it("reuses paths from a folder that was already listed", async () => {
    const song = permissionFile("song.mp3", "granted")
    song.isSameEntry = async (other) => other === song
    let listed = false
    const directory = {
      kind: "directory",
      name: "Edits",
      resolve: async () => null,
      values: () => {
        listed = true
        throw new Error("should not list")
      },
      getFileHandle: async (name: string) => {
        if (name !== song.name) throw new Error("missing file")
        return song
      },
    } as unknown as FileSystemDirectoryHandle
    rememberMp3Paths(directory, [{ name: "song.mp3", path: ["song.mp3"] }])
    await expect(writableFile(directory, song)).resolves.toBe(song)
    expect(listed).toBe(false)
  })

  it("walks a folder once when two files are resolved from it", async () => {
    const song = permissionFile("song.mp3", "granted")
    const other = permissionFile("other.mp3", "granted")
    song.isSameEntry = async (candidate) => candidate === song
    other.isSameEntry = async (candidate) => candidate === other
    const files = new Map<string, FileSystemFileHandle>([
      ["song.mp3", song],
      ["other.mp3", other],
    ])
    let walks = 0
    const directory = {
      kind: "directory",
      name: "House",
      resolve: async () => null,
      async *values() {
        walks += 1
        yield { kind: "file", name: "song.mp3" }
        yield { kind: "file", name: "other.mp3" }
      },
      getFileHandle: async (name: string) => {
        const handle = files.get(name)
        if (!handle) throw new Error("missing file")
        return handle
      },
    } as unknown as FileSystemDirectoryHandle
    await expect(writableFile(directory, song)).resolves.toBe(song)
    await expect(writableFile(directory, other)).resolves.toBe(other)
    expect(walks).toBe(1)
  })
})

describe("containingFolder", () => {
  it("keeps the folder a file was dropped from and does not ask again", async () => {
    const directory = permissionHandle("prompt")
    const file = permissionFile("song.mp3", "prompt")
    await expect(containingFolder(file, directory, [])).resolves.toBe(directory)
    expect(directory.requested).toBe(false)
  })

  it("does not prompt remembered folders that are not already readable", async () => {
    const remembered = permissionHandle("prompt")
    remembered.values = () => {
      throw new Error("should not list")
    }
    const file = permissionFile("song.mp3", "prompt")
    await expect(containingFolder(file, undefined, [remembered])).resolves.toBeNull()
    expect(remembered.requested).toBe(false)
  })
})

function folder(name: string): FileSystemDirectoryHandle {
  return {
    kind: "directory",
    name,
    isSameEntry: async () => false,
  } as unknown as FileSystemDirectoryHandle
}

function permissionHandle(state: PermissionState, next: PermissionState = state) {
  return {
    kind: "directory",
    name: "Edits",
    requested: false,
    queryPermission: async () => state,
    requestPermission: async function (this: { requested: boolean }) {
      this.requested = true
      return next
    },
  } as unknown as FileSystemDirectoryHandle & {
    requested: boolean
    getFileHandle?: (name: string) => Promise<FileSystemFileHandle>
    values?: () => never
  }
}

function permissionFile(name: string, state: PermissionState) {
  return {
    kind: "file",
    name,
    requested: false,
    queryPermission: async () => state,
    requestPermission: async function (this: { requested: boolean }) {
      this.requested = true
      return "granted" as PermissionState
    },
    isSameEntry: async () => false,
  } as unknown as FileSystemFileHandle & { requested: boolean }
}

function writableDirectory(child: FileSystemFileHandle & { requested: boolean }) {
  const nested = {
    getFileHandle: async (name: string) => {
      if (name !== child.name) throw new Error("missing file")
      return child
    },
  }
  return {
    kind: "directory",
    name: "Edits",
    requested: false,
    queryPermission: async () => "granted" as PermissionState,
    requestPermission: async function (this: { requested: boolean }) {
      this.requested = true
      return "granted" as PermissionState
    },
    getDirectoryHandle: async (name: string) => {
      if (name !== "live") throw new Error("missing folder")
      return nested
    },
    getFileHandle: async () => {
      throw new Error("not at the top")
    },
  } as unknown as FileSystemDirectoryHandle & { requested: boolean }
}
