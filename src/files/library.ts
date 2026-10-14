const DB_NAME = "openkey"
const STORE = "handles"
const LIBRARY_KEY = "library"

export type LibraryAccess =
  | { ok: true; directory: FileSystemDirectoryHandle }
  | { ok: false; reason: "cancelled" | "denied" }

const listings = new WeakMap<FileSystemDirectoryHandle, Promise<Map<string, FileSystemFileHandle[]>>>()

export async function canWrite(handle: FileSystemHandle): Promise<boolean> {
  if (!handle.queryPermission) return false
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted"
}

export async function loadLibrary(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb()
  return readHandle(db)
}

export async function saveLibrary(directory: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  await writeHandle(db, directory)
}

export async function forgetLibrary(): Promise<void> {
  const db = await openDb()
  await deleteHandle(db)
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

export async function writableFile(
  directory: FileSystemDirectoryHandle,
  file: FileSystemFileHandle,
): Promise<FileSystemFileHandle | null> {
  const resolved = await fileFromDirectory(directory, file).catch(() => null)
  if (resolved) return resolved
  const index = await mp3Index(directory)
  return matchByName(index.get(file.name.toLowerCase()) ?? [], (candidate) => file.isSameEntry(candidate))
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

function mp3Index(directory: FileSystemDirectoryHandle): Promise<Map<string, FileSystemFileHandle[]>> {
  const cached = listings.get(directory)
  if (cached) return cached
  const pending = indexMp3s(directory)
  listings.set(directory, pending)
  return pending
}

async function indexMp3s(directory: FileSystemDirectoryHandle): Promise<Map<string, FileSystemFileHandle[]>> {
  const index = new Map<string, FileSystemFileHandle[]>()
  await walk(directory)
  return index

  async function walk(dir: FileSystemDirectoryHandle): Promise<void> {
    for await (const handle of dir.values()) {
      if (handle.kind === "directory") {
        try {
          await walk(handle)
        } catch {
          // Skip a folder the site cannot list.
        }
      } else if (handle.kind === "file" && handle.name.toLowerCase().endsWith(".mp3")) {
        const key = handle.name.toLowerCase()
        const list = index.get(key)
        if (list) list.push(handle)
        else index.set(key, [handle])
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
