const DB_NAME = "openkey"
const STORE = "handles"
const LIBRARY_KEY = "library"
const LIBRARIES_KEY = "libraries"

export type LibraryAccess =
  | { ok: true; directory: FileSystemDirectoryHandle }
  | { ok: false; reason: "cancelled" | "denied" }

const listings = new WeakMap<FileSystemDirectoryHandle, Promise<Map<string, string[][]>>>()

export async function canWrite(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission) return false
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted"
}

/** True when the site can already look inside this folder. Does not prompt. */
export async function canRead(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission) return false
  try {
    if ((await handle.queryPermission({ mode: "read" })) === "granted") return true
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted"
  } catch {
    return false
  }
}

/** Restores write access on a folder the site already knows. One prompt names that folder. */
export async function ensureWrite(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission) return false
  const options = { mode: "readwrite" } as const
  try {
    const state = await handle.queryPermission(options)
    if (state === "granted") return true
    if (state !== "prompt" || !handle.requestPermission) return false
    return (await handle.requestPermission(options)) === "granted"
  } catch {
    return false
  }
}

export async function loadLibrary(): Promise<FileSystemDirectoryHandle | null> {
  const folders = await loadLibraries()
  return folders[0] ?? null
}

export async function loadLibraries(): Promise<FileSystemDirectoryHandle[]> {
  const db = await openDb()
  const stored = await readHandles(db)
  const legacy = await readHandle(db)
  return mergeFolders(stored, legacy ? [legacy] : [])
}

export async function saveLibrary(directory: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  await writeHandle(db, directory)
}

export async function saveLibraries(directories: FileSystemDirectoryHandle[]): Promise<void> {
  const db = await openDb()
  await writeHandles(db, directories)
}

export async function forgetLibrary(): Promise<void> {
  const db = await openDb()
  await deleteHandle(db)
}

export async function rememberFolder(
  folders: FileSystemDirectoryHandle[],
  folder: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle[]> {
  for (let index = 0; index < folders.length; index++) {
    const existing = folders[index]
    if (!existing) continue
    try {
      if (await existing.isSameEntry(folder)) {
        if (existing === folder) return folders
        const next = folders.slice()
        next[index] = folder
        return next
      }
    } catch {
      // A failed identity check is not a reason to drop a folder the site can still use.
    }
  }
  return [...folders, folder]
}

export async function mergeFolders(
  current: FileSystemDirectoryHandle[],
  extra: FileSystemDirectoryHandle[],
): Promise<FileSystemDirectoryHandle[]> {
  let next = current
  for (const folder of extra) next = await rememberFolder(next, folder)
  return next
}

/** Asks for one folder. Call it again for a track that lives somewhere else. */
export async function pickFolder(): Promise<LibraryAccess> {
  const picker = window.showDirectoryPicker
  if (!picker) return { ok: false, reason: "denied" }
  try {
    const directory = await picker({ mode: "readwrite", id: "openkey-folders", startIn: "music" })
    return { ok: true, directory }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { ok: false, reason: "cancelled" }
    throw error
  }
}

export async function acquireLibrary(saved: FileSystemDirectoryHandle | null): Promise<LibraryAccess> {
  if (saved) {
    const state = await saved.queryPermission?.({ mode: "readwrite" })
    if (state === "granted") return { ok: true, directory: saved }
    if (state === "prompt" && saved.requestPermission) {
      const next = await saved.requestPermission({ mode: "readwrite" })
      if (next === "granted") return { ok: true, directory: saved }
      return { ok: false, reason: "denied" }
    }
  }

  const picker = window.showDirectoryPicker
  if (!picker) return { ok: false, reason: "denied" }
  try {
    const directory = await picker({ mode: "readwrite", id: "openkey", startIn: "music" })
    return { ok: true, directory }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { ok: false, reason: "cancelled" }
    throw error
  }
}

/**
 * A file handle obtained from a folder that already has readwrite permission.
 * Dropped file handles are not returned: createWritable on those opens a save dialog per file.
 */
export async function grantedWriteHandle(
  directory: FileSystemDirectoryHandle | undefined,
  file: FileSystemFileHandle,
  path?: readonly string[],
): Promise<FileSystemFileHandle | null> {
  try {
    if (directory) {
      if (!(await canWrite(directory))) return null
      if (path && path.length > 0) {
        const located = await fileAtPath(directory, path)
        if (located) return located
      }
      return await writableFile(directory, file)
    }
    if (await canWrite(file)) return file
    return null
  } catch {
    return null
  }
}

/** The folder this file was taken from, or a remembered folder the site can already read. Does not prompt. */
export async function containingFolder(
  file: FileSystemFileHandle,
  directory: FileSystemDirectoryHandle | undefined,
  remembered: readonly FileSystemDirectoryHandle[],
): Promise<FileSystemDirectoryHandle | null> {
  if (directory) return directory
  for (const folder of remembered) {
    try {
      if (!(await canRead(folder))) continue
      const found = await writableFile(folder, file)
      if (found) return folder
    } catch {
      // A folder the site cannot search is not a reason to ask for every library.
    }
  }
  return null
}

export async function fileAtPath(
  directory: FileSystemDirectoryHandle,
  path: readonly string[],
): Promise<FileSystemFileHandle | null> {
  if (path.length === 0) return null
  try {
    let current = directory
    for (let index = 0; index < path.length - 1; index++) {
      const name = path[index]
      if (!name) return null
      current = await current.getDirectoryHandle(name)
    }
    const name = path[path.length - 1]
    if (!name) return null
    return await current.getFileHandle(name)
  } catch {
    return null
  }
}

/** Remember MP3 paths from a folder walk that already happened, so later saves do not walk it again. */
export function rememberMp3Paths(
  directory: FileSystemDirectoryHandle,
  files: ReadonlyArray<{ path: readonly string[]; name?: string; handle?: { name: string } }>,
): void {
  if (listings.has(directory)) return
  const index = new Map<string, string[][]>()
  for (const file of files) {
    const name = file.name ?? file.handle?.name ?? ""
    if (!name.toLowerCase().endsWith(".mp3")) continue
    const key = name.toLowerCase()
    const path = [...file.path]
    const list = index.get(key)
    if (list) list.push(path)
    else index.set(key, [path])
  }
  listings.set(directory, Promise.resolve(index))
}

export async function writableFile(
  directory: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
): Promise<FileSystemFileHandle | null> {
  const cached = listings.get(directory)
  if (cached) {
    const found = await handleFromIndex(directory, file, await cached)
    if (found) return found
  }
  const resolved = await fileFromDirectory(directory, file).catch(() => null)
  if (resolved) return resolved
  const index = await mp3Index(directory)
  return handleFromIndex(directory, file, index)
}

async function handleFromIndex(
  directory: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
  index: Map<string, string[][]>,
): Promise<FileSystemFileHandle | null> {
  const paths = index.get(file.name.toLowerCase()) ?? []
  for (const path of paths) {
    const handle = await fileAtPath(directory, path)
    if (!handle) continue
    try {
      if (await file.isSameEntry(handle)) return handle
    } catch {
      // A failed identity check is not a reason to overwrite a different file.
    }
  }
  return null
}

export async function matchByName<T>(
  candidates: T[],
  sameAs: (candidate: T) => Promise<boolean>,
): Promise<T | null> {
  for (const candidate of candidates) {
    try {
      if (await sameAs(candidate)) return candidate
    } catch {
      // A failed identity check is not a reason to overwrite a different file.
    }
  }
  return null
}

async function fileFromDirectory(
  directory: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
): Promise<FileSystemFileHandle | null> {
  const parts = await directory.resolve(file)
  if (!parts || parts.length === 0) return null
  let current = directory
  for (let index = 0; index < parts.length - 1; index++) {
    current = await current.getDirectoryHandle(parts[index]!)
  }
  const name = parts[parts.length - 1]
  if (!name) return null
  return current.getFileHandle(name)
}

function mp3Index(directory: FileSystemDirectoryHandle): Promise<Map<string, string[][]>> {
  const cached = listings.get(directory)
  if (cached) return cached
  const pending = indexMp3s(directory)
  listings.set(directory, pending)
  return pending
}

async function indexMp3s(directory: FileSystemDirectoryHandle): Promise<Map<string, string[][]>> {
  const index = new Map<string, string[][]>()
  await walk(directory, [])
  return index

  async function walk(dir: FileSystemDirectoryHandle, prefix: string[]): Promise<void> {
    for await (const handle of dir.values()) {
      if (handle.kind === "directory") {
        try {
          await walk(handle, [...prefix, handle.name])
        } catch {
          // Skip a folder the site cannot list.
        }
      } else if (handle.kind === "file" && handle.name.toLowerCase().endsWith(".mp3")) {
        const key = handle.name.toLowerCase()
        const path = [...prefix, handle.name]
        const list = index.get(key)
        if (list) list.push(path)
        else index.set(key, [path])
      }
    }
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function readHandles(db: IDBDatabase): Promise<FileSystemDirectoryHandle[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(LIBRARIES_KEY)
    request.onsuccess = () => {
      const stored = request.result as FileSystemDirectoryHandle[] | undefined
      resolve(Array.isArray(stored) ? stored : [])
    }
    request.onerror = () => reject(request.error)
  })
}

function writeHandles(db: IDBDatabase, directories: FileSystemDirectoryHandle[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(directories, LIBRARIES_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function readHandle(db: IDBDatabase): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(LIBRARY_KEY)
    request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

function writeHandle(db: IDBDatabase, directory: FileSystemDirectoryHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(directory, LIBRARY_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function deleteHandle(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).delete(LIBRARY_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
