import { useEffect, useRef, useState, type DragEvent } from "react"
import { analyzeFile } from "./analysis/client.ts"
import type { Analysis } from "./analysis/types.ts"
import { mixesWith } from "./analysis/openKey.ts"
import { audioPickerTypes, collectAudioEntries, isAudioFile, isMp3Name } from "./files/audio.ts"
import { ALL_COLUMNS, trackListCsv, UNWRITTEN_COLUMNS, type TrackListRow } from "./files/trackList.ts"
import { autoSaveAction, canWrite, containingFolder, ensureWrite, grantedWriteHandle, loadLibraries, mergeFolders, pickFolder, rememberFolder, rememberMp3Paths, saveLibraries, type LibraryAccess } from "./files/library.ts"
import { queueFolderGroups, waitingIds } from "./files/queue.ts"
import { formatMixedInKeyComment, isBulkRescanTarget, mergeShown, readStoredKeyFile, shouldSkipAnalysis, writeTags, type StoredKey } from "./id3/writeEnergy.ts"
import "./App.css"

type TrackStatus = "queued" | "analyzing" | "ready" | "writing" | "written" | "error" | "skipped"
type StatusFilter = "all" | "working" | "ready" | "saved" | "failed"
type ListView = "unwritten" | "visible" | "all"

type Track = {
  id: string
  name: string
  handle: FileSystemFileHandle
  directory?: FileSystemDirectoryHandle
  path?: string[]
  status: TrackStatus
  error?: string
  analysis?: Analysis
  stored?: StoredKey
  rescan?: boolean
}

const LIST_PREVIEW = 20
const NEEDS_EDIT = "Allow editing in the music folder once. openkey will then save every MP3 in it."

const pickerOptions = {
  multiple: true,
  excludeAcceptAllOption: true,
  types: audioPickerTypes,
}

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState("")
  const [writing, setWriting] = useState(false)
  const [saveEnergy, setSaveEnergy] = useState(true)
  const [saveKey, setSaveKey] = useState(false)
  const [saveOpenKey, setSaveOpenKey] = useState(false)
  const [saveBpm, setSaveBpm] = useState(false)
  const [saveComment, setSaveComment] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>("all")
  const [listView, setListView] = useState<ListView>("unwritten")
  const [listExpanded, setListExpanded] = useState(false)
  const [autoSave, setAutoSave] = useState(readAutoSave)
  const autoSaveRef = useRef(autoSave)
  autoSaveRef.current = autoSave
  const selectionRef = useRef<SaveSelection>({ energy: true, key: false, openKey: false, bpm: false, comment: true })
  selectionRef.current = {
    energy: saveEnergy,
    key: saveKey,
    openKey: saveOpenKey,
    bpm: saveBpm,
    comment: saveEnergy && saveComment,
  }
  const tracksRef = useRef<Track[]>([])
  const queueRef = useRef<string[]>([])
  const runningRef = useRef(false)
  const stoppedRef = useRef(false)
  const [stopped, setStopped] = useState(false)
  const foldersRef = useRef<FileSystemDirectoryHandle[]>([])
  const noticeRef = useRef("")
  const writingRef = useRef(false)
  const savingRef = useRef(new Set<string>())
  const saveQueueRef = useRef<string[]>([])
  const saveLoopRef = useRef(false)
  const canPick = typeof window.showOpenFilePicker === "function"
  const canPickFolder = typeof window.showDirectoryPicker === "function"

  useEffect(() => {
    let active = true
    void loadLibraries()
      .then(async (folders) => {
        if (!active) return
        foldersRef.current = await mergeFolders(foldersRef.current, folders)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  function commit(next: Track[]) {
    tracksRef.current = next
    setTracks(next)
  }

  function patch(id: string, partial: Partial<Track>) {
    commit(tracksRef.current.map((track) => (track.id === id ? { ...track, ...partial } : track)))
  }

  function showNotice(text: string) {
    if (noticeRef.current === text) return
    noticeRef.current = text
    setNotice(text)
  }

  function enqueue(incoming: Track[]) {
    commit([...tracksRef.current, ...incoming])
    queueRef.current.push(...incoming.map((track) => track.id))
    void pump()
  }

  async function pump() {
    if (runningRef.current) return
    runningRef.current = true
    try {
      for (;;) {
        if (stoppedRef.current) break
        const id = queueRef.current.shift()
        if (!id) break
        const track = tracksRef.current.find((item) => item.id === id)
        if (!track) continue
        patch(id, { status: "analyzing", error: undefined })
        try {
          const file = await track.handle.getFile()
          let stored = track.stored
          if (isMp3Name(track.name)) {
            const read = await readStoredKeyFile(file).catch(() => null)
            if (read) {
              stored = read
              patch(id, { stored: read })
            }
          }
          if (shouldSkipAnalysis(track.analysis, track.rescan)) {
            const status = track.status === "written" ? "written" : "ready"
            patch(id, { status, stored, rescan: false })
            if (status === "ready") queueReadySave(id)
            continue
          }
          const analysis = await analyzeFile(file)
          if (!tracksRef.current.some((item) => item.id === id)) continue
          patch(id, { status: "ready", analysis, stored, rescan: false })
          queueReadySave(id)
        } catch (error) {
          patch(id, { status: "error", error: messageOf(error) })
        }
      }
    } finally {
      runningRef.current = false
      if (!stoppedRef.current && queueRef.current.length > 0) void pump()
      else if (!stoppedRef.current) queueFinishedSaves()
    }
  }

  async function chooseFiles() {
    if (!window.showOpenFilePicker) {
      showNotice("Open this page in Chrome or Edge to write tags back into the original MP3.")
      return
    }
    try {
      const handles = await pickMp3s()
      await acceptHandles(handles.map((handle) => Promise.resolve(handle)))
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      showNotice(messageOf(error))
    }
  }

  async function chooseFolders() {
    const picker = window.showDirectoryPicker
    if (!picker) {
      showNotice("Open this page in Chrome or Edge to choose folders.")
      return
    }
    for (;;) {
      let directory: FileSystemDirectoryHandle
      try {
        directory = await picker({ mode: "readwrite", id: "openkey-folders", startIn: "music" })
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        showNotice(messageOf(error))
        return
      }
      try {
        showNotice(`Reading ${directory.name}…`)
        await remember(directory)
        const entries = await collectAudioEntries(directory)
        rememberMp3Paths(directory, entries)
        const accepted = await newTracks(entries.map((entry) => ({ handle: entry.handle, directory, path: entry.path })))
        if (accepted.length > 0) enqueue(accepted)
        if (entries.length === 0) showNotice(`${directory.name} has no audio files. Choose another folder, or cancel.`)
        else if (accepted.length === 0) showNotice(`${directory.name} is already in the list. Choose another folder, or cancel.`)
        else showNotice(`Added ${accepted.length} from ${directory.name}. Choose another folder, or cancel.`)
      } catch (error) {
        showNotice(messageOf(error))
        return
      }
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const items = [...event.dataTransfer.items].filter((item) => item.kind === "file")
    if (items.length === 0) return
    if (items.some((item) => !item.getAsFileSystemHandle)) {
      showNotice("This browser cannot save into dropped files. Choose audio in Chrome or Edge.")
      return
    }
    const handles = items.map((item) => item.getAsFileSystemHandle!())
    void acceptHandles(handles)
  }

  async function acceptHandles(pendingHandles: Array<Promise<FileSystemHandle | null>>) {
    const skipped: string[] = []
    const emptyFolders: string[] = []
    const needsEdit: string[] = []
    const files: Array<{ handle: FileSystemFileHandle; directory?: FileSystemDirectoryHandle; path?: string[] }> = []
    for (const pending of pendingHandles) {
      const handle = await pending
      if (!handle) continue
      if (isDirectoryHandle(handle)) {
        const canEdit = await ensureWrite(handle)
        await remember(handle)
        const found = await collectAudioEntries(handle)
        rememberMp3Paths(handle, found)
        if (found.length === 0) emptyFolders.push(handle.name)
        else files.push(...found.map((entry) => ({ handle: entry.handle, directory: handle, path: entry.path })))
        if (!canEdit && found.length > 0) needsEdit.push(handle.name)
        continue
      }
      if (!isAudioFile(handle)) {
        skipped.push(handle.name)
        continue
      }
      files.push({ handle })
    }
    const accepted = await newTracks(files)
    const notes: string[] = []
    if (emptyFolders.length === 1) notes.push(`${emptyFolders[0]} has no audio files.`)
    else if (emptyFolders.length > 1) notes.push(`${emptyFolders.length} folders have no audio files.`)
    if (skipped.length === 1) notes.push(`Skipped ${skipped[0]}. Only audio files can be read.`)
    else if (skipped.length > 1) notes.push(`Skipped ${skipped.length} items. Only audio files can be read.`)
    if (needsEdit.length === 1) notes.push(`Allow editing in ${needsEdit[0]} when you save tags.`)
    else if (needsEdit.length > 1) notes.push("Allow editing in the dropped folders when you save tags.")
    showNotice(notes.join(" "))
    if (accepted.length > 0) enqueue(accepted)
  }

  async function newTracks(
    files: Array<{ handle: FileSystemFileHandle; directory?: FileSystemDirectoryHandle; path?: string[] }>,
  ): Promise<Track[]> {
    const accepted: Track[] = []
    for (const file of files) {
      if (await alreadyListed(file.handle)) continue
      accepted.push({
        id: crypto.randomUUID(),
        name: file.handle.name,
        handle: file.handle,
        directory: file.directory,
        path: file.path,
        status: "queued",
      })
    }
    return accepted
  }

  async function remember(directory: FileSystemDirectoryHandle) {
    foldersRef.current = await rememberFolder(foldersRef.current, directory)
    await saveLibraries(foldersRef.current).catch(() => undefined)
  }

  async function alreadyListed(handle: FileSystemFileHandle): Promise<boolean> {
    for (const track of tracksRef.current) {
      if (track.name !== handle.name) continue
      try {
        if (await handle.isSameEntry(track.handle)) return true
      } catch {
        // A failed identity check still lets a different file with the same name through.
      }
    }
    return false
  }

  function currentSelection(): SaveSelection {
    return {
      energy: saveEnergy,
      key: saveKey,
      openKey: saveOpenKey,
      bpm: saveBpm,
      comment: saveEnergy && saveComment,
    }
  }

  function tracksToSave(includeWritten: boolean): Track[] {
    return tracksRef.current.filter(
      (track) =>
        Boolean(track.analysis) &&
        isMp3Name(track.name) &&
        (track.status === "ready" || (includeWritten && track.status === "written")),
    )
  }

  async function writeAll() {
    await saveListed(true)
  }

  async function allowEditing() {
    await saveListed(false)
  }

  async function saveListed(includeWritten: boolean) {
    if (writingRef.current) return
    const selection = currentSelection()
    const ready = tracksToSave(includeWritten)
    if (ready.length === 0 || !hasSelection(selection)) return
    const folders: FileSystemDirectoryHandle[] = []
    for (const track of ready) {
      if (track.directory && !folders.includes(track.directory)) folders.push(track.directory)
    }
    for (const folder of folders) {
      if (await canWrite(folder)) continue
      if (await ensureWrite(folder)) continue
      showNotice(NEEDS_EDIT)
      return
    }
    writingRef.current = true
    setWriting(true)
    showNotice("")
    const readyIds = new Set(ready.map((track) => track.id))
    commit(tracksRef.current.map((track) => (readyIds.has(track.id) ? { ...track, error: undefined } : track)))
    try {
      await saveBatch(tracksToSave(includeWritten), selection)
      if (!stoppedRef.current) await writeAlreadyAllowed(selection)
      clearNeedsEdit()
    } finally {
      writingRef.current = false
      setWriting(false)
      if (!stoppedRef.current) void drainAutoSave()
    }
  }

  function toggleAutoSave(on: boolean) {
    autoSaveRef.current = on
    setAutoSave(on)
    try {
      localStorage.setItem("openkey-autosave", on ? "1" : "0")
    } catch {
      // The choice still applies until the page is closed.
    }
    if (on) {
      setFilter((current) => (current === "ready" ? "all" : current))
      void saveListed(true)
    }
  }

  function queueReadySave(id: string) {
    const track = tracksRef.current.find((item) => item.id === id)
    if (!track?.analysis || !isMp3Name(track.name)) return
    if (stoppedRef.current || !autoSaveRef.current) return
    if (!saveQueueRef.current.includes(id)) saveQueueRef.current.push(id)
    void drainAutoSave()
  }

  function queueFinishedSaves() {
    if (stoppedRef.current || !autoSaveRef.current) return
    for (const track of tracksRef.current) {
      if (track.status !== "ready" || !track.analysis || !isMp3Name(track.name)) continue
      if (!saveQueueRef.current.includes(track.id)) saveQueueRef.current.push(track.id)
    }
    if (saveQueueRef.current.length > 0) void drainAutoSave()
  }

  async function drainAutoSave() {
    if (saveLoopRef.current) return
    saveLoopRef.current = true
    try {
      while (!stoppedRef.current) {
        if (writingRef.current) break
        const id = saveQueueRef.current.shift()
        if (!id) break
        const track = tracksRef.current.find((item) => item.id === id)
        if (!track) continue
        try {
          const deferred = await saveIfWritable(track)
          if (deferred) {
            if (!saveQueueRef.current.includes(id)) saveQueueRef.current.unshift(id)
            break
          }
        } catch (error) {
          const row = rowWriteMessage(error)
          patch(id, { status: "ready", error: row })
          if (!row) showNotice(NEEDS_EDIT)
        }
      }
      if (stoppedRef.current) saveQueueRef.current = []
    } finally {
      saveLoopRef.current = false
      if (!stoppedRef.current && !writingRef.current && saveQueueRef.current.length > 0) void drainAutoSave()
    }
  }

  /** True when the save was deferred because a manual write is in progress. The id stays queued. */
  async function saveIfWritable(track: Track): Promise<boolean> {
    if (writingRef.current) return true
    const selection = selectionRef.current
    const current = tracksRef.current.find((item) => item.id === track.id)
    if (!current?.analysis && !track.analysis) return false
    if (!current) return false
    if (current.status === "written") return false
    if (current.status === "writing" && savingRef.current.has(current.id)) return false
    const analysis = current.analysis ?? track.analysis
    if (!analysis) return false
    let folder = current.directory ?? null
    if (!folder) {
      try {
        folder = await containingFolder(current.handle, undefined, foldersRef.current)
      } catch {
        folder = null
      }
    }
    if (writingRef.current) return true
    let directoryGranted = false
    let fileGranted = false
    try {
      directoryGranted = folder ? await canWrite(folder) : false
      fileGranted = directoryGranted ? false : await canWrite(current.handle)
    } catch {
      directoryGranted = false
      fileGranted = false
    }
    const action = autoSaveAction({
      enabled: autoSaveRef.current,
      mp3: isMp3Name(current.name),
      hasAnalysis: true,
      selected: hasSelection(selection),
      stopped: stoppedRef.current,
      directoryGranted,
      fileGranted,
    })
    if (action === "skip") return false
    if (action === "wait") {
      patch(current.id, { status: "ready", error: undefined, directory: folder ?? current.directory })
      showNotice(NEEDS_EDIT)
      return false
    }
    const saved = await writeTrack({ ...current, analysis, directory: folder ?? current.directory }, selection)
    if (saved) clearNeedsEdit()
    return false
  }

  async function saveBatch(ready: Track[], selection: SaveSelection) {
    const groups = await groupTracks(ready)
    for (const group of groups.known) {
      if (stoppedRef.current) return
      const allowed = (await canWrite(group.folder)) || (await ensureWrite(group.folder))
      if (!allowed) {
        showNotice(NEEDS_EDIT)
        continue
      }
      for (const track of group.tracks) {
        if (stoppedRef.current) return
        await writeTrack({ ...track, directory: group.folder }, selection)
      }
    }

    let remaining = groups.unknown
    while (remaining.length > 0) {
      if (stoppedRef.current) return
      showNotice(
        foldersRef.current.length > 0
          ? "These files are not in the folders already added. Choose the folder that contains them, or cancel."
          : remaining.length === ready.length
            ? "Choose the folder that contains these files."
            : `${remaining.length} ${remaining.length === 1 ? "file is" : "files are"} in another folder. Choose that folder, or cancel.`,
      )
      const access = await chooseSaveFolder()
      if (!access.ok) {
        showNotice(
          access.reason === "cancelled"
            ? remaining.length === ready.length
              ? "Save was cancelled"
              : `Saved the files from the chosen folders. ${remaining.length} ${remaining.length === 1 ? "is" : "are"} still in another folder.`
            : NEEDS_EDIT,
        )
        return
      }
      await remember(access.directory)
      if (!(await canWrite(access.directory))) {
        showNotice(NEEDS_EDIT)
        return
      }
      const still: Track[] = []
      let wrote = 0
      for (const track of remaining) {
        if (stoppedRef.current) return
        const handle = await grantedWriteHandle(access.directory, track.handle)
        if (!handle) {
          still.push(track)
          continue
        }
        if (await writeTrack({ ...track, directory: access.directory }, selection)) wrote += 1
      }
      if (wrote === 0) {
        showNotice("None of the remaining files are in that folder.")
        return
      }
      remaining = still
    }
  }

  async function chooseSaveFolder(): Promise<LibraryAccess> {
    try {
      return await pickFolder()
    } catch (error) {
      showNotice(messageOf(error))
      return { ok: false, reason: "denied" }
    }
  }

  async function groupTracks(tracks: Track[]): Promise<{
    known: Array<{ folder: FileSystemDirectoryHandle; tracks: Track[] }>
    unknown: Track[]
  }> {
    const known: Array<{ folder: FileSystemDirectoryHandle; tracks: Track[] }> = []
    const unknown: Track[] = []
    for (const track of tracks) {
      const folder = await containingFolder(track.handle, track.directory, foldersRef.current)
      if (!folder) {
        unknown.push(track)
        continue
      }
      let group = known.find((item) => item.folder === folder)
      if (!group) {
        for (const item of known) {
          try {
            if (await item.folder.isSameEntry(folder)) {
              group = item
              break
            }
          } catch {
            // Keep both folders when identity cannot be checked.
          }
        }
      }
      if (!group) {
        group = { folder, tracks: [] }
        known.push(group)
      }
      group.tracks.push({ ...track, directory: folder })
    }
    return { known, unknown }
  }

  async function writeAlreadyAllowed(selection: SaveSelection) {
    const waiting = tracksRef.current.filter((track) => track.status === "ready" && track.analysis && isMp3Name(track.name))
    for (const track of waiting) {
      if (stoppedRef.current) return
      const folder = await containingFolder(track.handle, track.directory, foldersRef.current)
      if (folder) {
        if (!(await canWrite(folder))) continue
        await writeTrack({ ...track, directory: folder }, selection)
      } else if (await canWrite(track.handle)) {
        await writeTrack(track, selection)
      }
    }
  }

  function clearNeedsEdit() {
    const held = tracksRef.current.some((track) => track.status === "ready" && track.analysis && isMp3Name(track.name))
    if (!held && noticeRef.current === NEEDS_EDIT) showNotice("")
  }

  async function writeTrack(track: Track, selection: SaveSelection): Promise<boolean> {
    if (!track.analysis || savingRef.current.has(track.id)) return false
    const handle = await grantedWriteHandle(track.directory, track.handle, track.path)
    if (!handle) {
      patch(track.id, { status: "ready", error: undefined, directory: track.directory })
      showNotice(NEEDS_EDIT)
      return false
    }
    savingRef.current.add(track.id)
    patch(track.id, { status: "writing", error: undefined, directory: track.directory })
    try {
      const file = await handle.getFile()
      const bytes = new Uint8Array(await file.arrayBuffer())
      const tagged = writeTags(bytes, fieldsFor(track.analysis, selection))
      const writable = await handle.createWritable()
      await writable.write(new Blob([bytesOf(tagged)]))
      await writable.close()
      patch(track.id, { status: "written", error: undefined, directory: track.directory })
      return true
    } catch (error) {
      const row = rowWriteMessage(error)
      if (!row) showNotice(NEEDS_EDIT)
      patch(track.id, { status: "ready", error: row, directory: track.directory })
      return false
    } finally {
      savingRef.current.delete(track.id)
    }
  }

  function rescanTrack(id: string) {
    if (writingRef.current) return
    const track = tracksRef.current.find((item) => item.id === id)
    if (!track || track.status === "analyzing" || track.status === "writing") return
    commit(tracksRef.current.map((item) => (item.id === id ? { ...item, status: "queued", error: undefined, rescan: true } : item)))
    if (!queueRef.current.includes(id)) queueRef.current.push(id)
    void pump()
  }

  function rescanTagged() {
    if (writingRef.current || tracksRef.current.some((track) => track.status === "writing")) return
    const ids = tracksRef.current.filter((track) => isBulkRescanTarget(track)).map((track) => track.id)
    if (ids.length === 0) return
    const idSet = new Set(ids)
    commit(
      tracksRef.current.map((track) =>
        idSet.has(track.id) ? { ...track, status: "queued", error: undefined, rescan: true } : track,
      ),
    )
    for (const id of ids) {
      if (!queueRef.current.includes(id)) queueRef.current.push(id)
    }
    void pump()
  }

  function stopQueue() {
    stoppedRef.current = true
    setStopped(true)
  }

  function resumeQueue() {
    stoppedRef.current = false
    setStopped(false)
    void pump()
    queueFinishedSaves()
  }

  function removeFolder(directory: FileSystemDirectoryHandle) {
    const dropped = new Set(waitingIds(tracksRef.current, directory))
    if (dropped.size === 0) return
    queueRef.current = queueRef.current.filter((id) => !dropped.has(id))
    commit(tracksRef.current.filter((track) => !dropped.has(track.id)))
  }

  function removeTrack(id: string) {
    queueRef.current = queueRef.current.filter((item) => item !== id)
    commit(tracksRef.current.filter((track) => track.id !== id))
  }

  function saveTrackList() {
    const columns = listView === "unwritten" ? UNWRITTEN_COLUMNS : ALL_COLUMNS
    const active = autoSaveRef.current && filter === "ready" ? "all" : filter
    const source = listView === "visible" ? tracksRef.current.filter((track) => matchesFilter(track, active)) : tracksRef.current
    const csv = trackListCsv(source.map((track) => listRow(track, autoSaveRef.current)), columns)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = listView === "unwritten" ? "openkey-not-written.csv" : "openkey-tracks.csv"
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  function clearTracks() {
    if (writing) return
    queueRef.current = []
    saveQueueRef.current = []
    stoppedRef.current = false
    setStopped(false)
    commit([])
    setFilter("all")
    showNotice("")
  }

  function retryFailed() {
    const failed = tracksRef.current.filter((track) => track.status === "error")
    if (failed.length === 0 || writing) return
    commit(
      tracksRef.current.map((track) =>
        track.status === "error" ? { ...track, status: "queued", error: undefined } : track,
      ),
    )
    queueRef.current.push(...failed.map((track) => track.id))
    void pump()
  }

  const analyzing = tracks.some((track) => track.status === "queued" || track.status === "analyzing")
  const reading = writing || tracks.some((track) => track.status === "analyzing" || track.status === "writing")
  const selection = { energy: saveEnergy, key: saveKey, openKey: saveOpenKey, bpm: saveBpm, comment: saveEnergy && saveComment }
  const readyTracks = tracks.filter(
    (track) => (track.status === "ready" || track.status === "written") && track.analysis,
  )
  const savableCount = readyTracks.filter((track) => isMp3Name(track.name)).length
  const readOnlyCount = readyTracks.length - savableCount
  const selectedNames = fieldNames(selection)
  const tally = tallyTracks(tracks)
  const viewFilter: StatusFilter = autoSave && filter === "ready" ? "all" : filter
  const visible = tracks.filter((track) => matchesFilter(track, viewFilter))
  const shown = listExpanded ? visible : visible.slice(0, LIST_PREVIEW)
  const folderGroups = queueFolderGroups(tracks)
  const failedCount = tracks.filter((track) => track.status === "error").length
  const taggedCount = tracks.filter((track) => isBulkRescanTarget(track)).length
  const savingNow = writing || tracks.some((track) => track.status === "writing")
  const heldCount = tracks.filter((track) => track.status === "ready" && track.analysis && isMp3Name(track.name)).length

  return (
    <main>
      <header>
        <div className="topbar">
          <p className="wordmark">
            <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
              <circle cx="16" cy="16" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M16 3v6M16 23v6M3 16h6M23 16h6" stroke="currentColor" strokeWidth="2" />
            </svg>
            openkey
          </p>
          <a className="donate" href="https://github.com/sponsors/ChrisEdS">Donate</a>
        </div>
        <h1>Key and energy for your tracks</h1>
        <p className="lede">
          Drop a track to read its musical key, Open Key code, tempo, and a 1–10 energy score.
          Choose which of those to save into the file. The audio bytes stay as they are.
        </p>
      </header>

      <fieldset className="writes">
        <legend>Save into the MP3</legend>
        <div className="write-options">
          <label>
            <input type="checkbox" checked={saveEnergy} onChange={(event) => setSaveEnergy(event.target.checked)} />
            Energy
          </label>
          <label>
            <input type="checkbox" checked={saveKey} onChange={(event) => setSaveKey(event.target.checked)} />
            Key
          </label>
          <label>
            <input type="checkbox" checked={saveOpenKey} onChange={(event) => setSaveOpenKey(event.target.checked)} />
            Open Key
          </label>
          <label>
            <input type="checkbox" checked={saveBpm} onChange={(event) => setSaveBpm(event.target.checked)} />
            BPM
          </label>
        </div>
        <div className={saveEnergy ? "energy-detail" : "energy-detail off"}>
          <p className="write-hint">In the energy tag</p>
          <div className="comment-line">
            <label>
              <input
                type="checkbox"
                checked={saveEnergy && saveComment}
                disabled={!saveEnergy}
                onChange={(event) => setSaveComment(event.target.checked)}
              />
              Comment
            </label>
            <div className={saveEnergy && !saveComment ? "comment-formula off" : "comment-formula"}>
              <span className="comment-value key">8A</span>
              <span className="comment-caption key">Open Key</span>
              <span className="comment-dash" aria-hidden="true">-</span>
              <span className="comment-value energy">Energy 7</span>
              <span className="comment-caption energy">Energy</span>
              <span className="comment-note">in front of the existing comment</span>
            </div>
          </div>
        </div>
        <label className="auto-save">
          <input
            type="checkbox"
            checked={autoSave}
            onChange={(event) => toggleAutoSave(event.target.checked)}
            title="Writes the checked tags into each MP3 as soon as it is ready. Other audio stays read-only."
          />
          Auto-save each ready MP3
        </label>
      </fieldset>

      <div
        className={dragging ? "drop dragging" : "drop"}
        onDragEnter={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <button type="button" onClick={() => void chooseFiles()} disabled={!canPick || writing}>
          Choose audio
        </button>
        <button type="button" className="quiet" onClick={() => void chooseFolders()} disabled={!canPickFolder || writing}>
          Choose folders
        </button>
        <p>{canPick || canPickFolder ? "or drop files and folders here" : "Open this page in Chrome or Edge to choose files"}</p>
      </div>

      {notice && notice !== NEEDS_EDIT ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      {notice === NEEDS_EDIT ? (
        <p className="notice calm" role="status">
          <span>{NEEDS_EDIT}</span>
          {autoSave && heldCount > 0 ? (
            <button type="button" className="quiet" onClick={() => void allowEditing()} disabled={writing}>
              Allow editing
            </button>
          ) : null}
        </p>
      ) : null}

      {folderGroups.length > 0 ? (
        <ul className="folders" aria-label="Folders in the queue">
          {folderGroups.map((group) => {
            const waiting = waitingIds(group.tracks, group.directory).length
            const done = group.tracks.length - waiting
            return (
              <li key={group.tracks[0]?.id ?? group.directory.name}>
                <span className="folder-name" title={group.directory.name}>{group.directory.name}</span>
                <span className="folder-count">{folderQueueLabel(waiting, done)}</span>
                <button
                  type="button"
                  className="quiet tiny"
                  disabled={waiting === 0 || writing}
                  onClick={() => removeFolder(group.directory)}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}

      {tracks.length > 0 ? (
        <div className="workspace">
          <div className="toolbar">
            <div className="stats" role="group" aria-label="Filter by status">
              <FilterButton label="All" count={tally.total} pressed={viewFilter === "all"} onClick={() => setFilter("all")} />
              <FilterButton label="Working" count={tally.working} pressed={viewFilter === "working"} onClick={() => setFilter("working")} />
              {autoSave ? null : (
                <FilterButton label="Ready" count={tally.ready} pressed={viewFilter === "ready"} onClick={() => setFilter("ready")} />
              )}
              <FilterButton label="Saved" count={tally.saved} pressed={viewFilter === "saved"} onClick={() => setFilter("saved")} />
              <FilterButton label="Failed" count={tally.failed} pressed={viewFilter === "failed"} onClick={() => setFilter("failed")} />
            </div>
            <div className="actions">
              <div className="actions-main">
                {analyzing || writing || stopped ? (
                  <button
                    type="button"
                    className="quiet"
                    onClick={stopped ? resumeQueue : stopQueue}
                    title={stopped ? "Continue the queue." : "Finish the current file, then leave the drive alone."}
                  >
                    {stopped ? "Resume" : "Stop"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void writeAll()}
                  disabled={savableCount === 0 || analyzing || writing || selectedNames.length === 0}
                >
                  {writing ? "Saving…" : saveButtonLabel(selectedNames, savableCount)}
                </button>
              </div>
              <div className="actions-side">
                <div className="save-list">
                  <button type="button" className="quiet" onClick={saveTrackList} title={listViewTitle(listView)}>
                    {saveListLabel(listView)}
                  </button>
                  <select
                    aria-label="Which list to save"
                    value={listView}
                    title={listViewTitle(listView)}
                    onChange={(event) => setListView(event.target.value as ListView)}
                  >
                    <option value="unwritten">Not written</option>
                    <option value="visible">This view</option>
                    <option value="all">Whole table</option>
                  </select>
                </div>
                <button
                  type="button"
                  className="quiet"
                  onClick={rescanTagged}
                  disabled={taggedCount === 0 || savingNow}
                  title="Analyze every tagged file in the list again. Tags are written only if auto-save is already allowed."
                >
                  {taggedCount > 0 ? `Rescan tagged ${taggedCount}` : "Rescan tagged"}
                </button>
                <button type="button" className="quiet" onClick={retryFailed} disabled={failedCount === 0 || writing}>
                  Retry failed
                </button>
                <button type="button" className="quiet" onClick={clearTracks} disabled={writing}>
                  Clear list
                </button>
              </div>
            </div>
            <p>
              {analyzing
                ? `${trackSummary(tally, autoSave)} Reading tracks one at a time.`
                : selectedNames.length === 0
                  ? `${trackSummary(tally, autoSave)} Select at least one field.`
                  : `${trackSummary(tally, autoSave)} ${saveSummary(selectedNames, savableCount, readOnlyCount)}`}
            </p>
            <p className="legend">
              Energy is 1–10 intensity. Brightness is the share above 5 kHz. Shape is L level, B builds, D jumps. Brightness and shape are not saved.
            </p>
            {stopped ? (
              <p className="drive" role="status">
                {reading
                  ? "Stopping after this file. Do not eject the drive yet."
                  : "Nothing is reading or writing the drive. Eject it in Finder. This page cannot eject a drive. If macOS still says it is in use, close this tab."}
              </p>
            ) : null}
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Analyzed tracks</caption>
              <colgroup>
                <col className="col-file" />
                <col className="col-key" />
                <col className="col-open" />
                <col className="col-bpm" />
                <col className="col-energy" />
                <col className="col-brightness" />
                <col className="col-shape" />
                <col className="col-mixes" />
                <col className="col-status" />
              </colgroup>
              <thead>
                <tr>
                  <th className="file">File</th>
                  <th>Key</th>
                  <th>Open Key</th>
                  <th>BPM</th>
                  <th title="1–10 intensity. A steady club track is about 7.">Energy</th>
                  <th title="Share of the sound above 5 kHz. 0 is dark, 1 is bright.">Brightness</th>
                  <th title="L stays level, B builds, D jumps.">Shape</th>
                  <th>Mixes with</th>
                  <th className="status">Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className="empty" colSpan={9}>
                      Nothing in this view.
                    </td>
                  </tr>
                ) : (
                  shown.map((track) => (
                    <TrackRow
                      key={track.id}
                      track={track}
                      autoSave={autoSave}
                      canSave={hasSelection(selection)}
                      onRemove={removeTrack}
                      onRescan={rescanTrack}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
          {visible.length > LIST_PREVIEW ? (
            <button type="button" className="quiet list-fold" onClick={() => setListExpanded((open) => !open)}>
              {listExpanded ? `Show ${LIST_PREVIEW}` : `Show all ${visible.length}`}
            </button>
          ) : null}
        </div>
      ) : null}

      <aside className="sponsor">
        <div className="sponsor-row">
          <div className="sponsor-lead">
            <a className="sponsor-heart" href="https://github.com/sponsors/ChrisEdS" aria-label="Sponsor ChrisEdS">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                d="M12 19.4c-4.6-2.8-7.2-5.5-7.2-8.6A3.9 3.9 0 0 1 12 8.1a3.9 3.9 0 0 1 7.2 2.7c0 3.1-2.6 5.8-7.2 8.6Z"
              />
            </svg>
            </a>
            <h2>Sponsor this project</h2>
          </div>
          <div className="sponsor-main">
            <a className="sponsor-person" href="https://github.com/ChrisEdS">
              <img src="/chriseds.png" alt="" width="28" height="28" />
              <span className="sponsor-login">ChrisEdS</span>
              <span className="sponsor-name">Christian Scherm</span>
            </a>
            <a className="sponsor-more" href="https://github.com/sponsors">Learn more</a>
          </div>
        </div>
      </aside>
    </main>
  )
}

function TrackRow({
  track,
  autoSave,
  canSave,
  onRemove,
  onRescan,
}: {
  track: Track
  autoSave: boolean
  canSave: boolean
  onRemove: (id: string) => void
  onRescan: (id: string) => void
}) {
  const shown = shownOf(track)
  const canRescan = track.status !== "analyzing" && track.status !== "writing" && (track.status === "skipped" || track.analysis != null)
  return (
    <tr>
      <td className="file" title={track.name}>{track.name}</td>
      <td className="key" title={shown?.keyLabel ?? undefined}>
        {shown?.keyLabel ? (
          <span className="key-line">
            {shown.keyLabel}
            {shown.uncertain ? <span className="flag">Low confidence</span> : null}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="code">{shown?.openKey || "—"}</td>
      <td className="code">{shown ? formatBpm(shown.bpm) : "—"}</td>
      <td>
        {shown?.energy != null ? (
          <span className="energy">
            <strong>{shown.energy}</strong>
            <span className="meter" aria-hidden="true">
              {Array.from({ length: 10 }, (_, index) => (
                <i key={index} className={index < shown.energy! ? "on" : ""} />
              ))}
            </span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="code">{shown?.brightness != null ? shown.brightness.toFixed(2) : "—"}</td>
      <td title={shown?.shape ? shapeTitle(shown.shape) : undefined}>
        {shown?.shape ? <span className={`shape shape-${shown.shape.toLowerCase()}`}>{shown.shape}</span> : "—"}
      </td>
      <td>
        {shown && shown.mixesWith.length > 0 ? (
          <span className="mixes">
            {shown.mixesWith.map((code) => (
              <span className="mix" key={code}>{code}</span>
            ))}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className={statusClass(track)}>
        <div className="status-cell">
          <span className="status-label" title={track.error ?? statusLabel(track, autoSave, canSave)}>
            {track.error ?? statusLabel(track, autoSave, canSave)}
          </span>
          <span className="row-actions">
            <button
              type="button"
              className={canRescan ? "quiet tiny" : "quiet tiny reserve"}
              onClick={() => onRescan(track.id)}
              tabIndex={canRescan ? 0 : -1}
              aria-hidden={canRescan ? undefined : true}
              disabled={!canRescan}
              title="Analyze this file again. Tags are written only if auto-save is already allowed."
            >
              Rescan
            </button>
            <button
              type="button"
              className="quiet tiny"
              onClick={() => onRemove(track.id)}
              disabled={track.status === "writing" || track.status === "analyzing"}
            >
              Remove
            </button>
          </span>
        </div>
      </td>
    </tr>
  )
}

function FilterButton({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string
  count: number
  pressed: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className="quiet" aria-pressed={pressed} onClick={onClick}>
      {label} {count}
    </button>
  )
}

function tallyTracks(tracks: Track[]) {
  return {
    total: tracks.length,
    working: tracks.filter((track) => track.status === "queued" || track.status === "analyzing" || track.status === "writing").length,
    ready: tracks.filter((track) => track.status === "ready" && !track.error).length,
    saved: tracks.filter((track) => track.status === "written").length,
    skipped: tracks.filter((track) => track.status === "skipped").length,
    failed: tracks.filter((track) => track.status === "error" || Boolean(track.error)).length,
  }
}

function trackSummary(tally: ReturnType<typeof tallyTracks>, autoSave: boolean): string {
  const parts = [`${tally.total} ${tally.total === 1 ? "track" : "tracks"}`]
  if (tally.working > 0) parts.push(`${tally.working} working`)
  if (!autoSave && tally.ready > 0) parts.push(`${tally.ready} ready`)
  if (tally.saved > 0) parts.push(`${tally.saved} saved`)
  if (tally.skipped > 0) parts.push(`${tally.skipped} already tagged`)
  if (tally.failed > 0) parts.push(`${tally.failed} failed`)
  return `${parts.join(" · ")}.`
}

function matchesFilter(track: Track, filter: StatusFilter): boolean {
  if (filter === "all") return true
  if (filter === "working") return track.status === "queued" || track.status === "analyzing" || track.status === "writing"
  if (filter === "ready") return track.status === "ready" && !track.error
  if (filter === "saved") return track.status === "written"
  return track.status === "error" || Boolean(track.error)
}

function statusClass(track: Track): string {
  if (track.error || track.status === "error") return "status bad"
  if (track.status === "written") return "status good"
  if (track.status === "queued" || track.status === "analyzing" || track.status === "writing") return "status busy"
  return "status"
}

function saveButtonLabel(names: string[], count: number): string {
  if (names.length === 0) return "Choose what to save"
  const fileWord = count === 1 ? "file" : "files"
  return `Write ${names.join(", ")} to ${count} ${fileWord}`
}

type SaveSelection = {
  energy: boolean
  key: boolean
  openKey: boolean
  bpm: boolean
  comment: boolean
}

function hasSelection(selection: SaveSelection): boolean {
  return selection.energy || selection.key || selection.openKey || selection.bpm || selection.comment
}

function fieldNames(selection: SaveSelection): string[] {
  return [
    selection.energy ? "energy" : "",
    selection.key ? "key" : "",
    selection.openKey ? "Open Key" : "",
    selection.bpm ? "BPM" : "",
    selection.comment ? "comment" : "",
  ].filter((name) => name !== "")
}

function fieldsFor(analysis: Analysis, selection: SaveSelection) {
  const onlyBpm = selection.bpm && !selection.energy && !selection.key && !selection.openKey && !selection.comment
  if (onlyBpm && analysis.bpm == null) throw new Error("No BPM detected for this track")
  return {
    energy: selection.energy ? analysis.energy : undefined,
    keyLabel: selection.key ? analysis.keyLabel : undefined,
    openKey: selection.openKey ? analysis.openKey : undefined,
    bpm: selection.bpm && analysis.bpm != null ? analysis.bpm : undefined,
    comment: selection.comment ? formatMixedInKeyComment(analysis.openKey, analysis.energy) : undefined,
  }
}

function saveSummary(names: string[], mp3Count: number, readOnlyCount: number): string {
  const readOnly = readOnlyCount > 0 ? " Other audio is analyzed only." : ""
  if (mp3Count === 0) return `Tags are written into MP3s.${readOnly}`
  return `Writes ${names.join(", ")} into ${mp3Count === 1 ? "the MP3" : "MP3s"}.${readOnly} Other tags stay as they are.`
}

function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

async function pickMp3s(): Promise<FileSystemFileHandle[]> {
  const picker = window.showOpenFilePicker
  if (!picker) throw new Error("Open this page in Chrome or Edge to write tags back into the original MP3.")
  try {
    return await picker({ ...pickerOptions, mode: "readwrite" })
  } catch (error) {
    if (error instanceof TypeError) return picker(pickerOptions)
    throw error
  }
}

function shapeTitle(shape: "L" | "B" | "D"): string {
  if (shape === "L") return "Linear. The drive stays level."
  if (shape === "B") return "Building. The drive rises through the track."
  return "Dramatic. Quiet sections and peaks sit far apart."
}

function statusLabel(track: Track, autoSave: boolean, canSave = true): string {
  if (track.status === "queued") return "Queued"
  if (track.status === "analyzing") return "Analyzing"
  if (track.status === "ready" && autoSave) return isMp3Name(track.name) && canSave ? "Waiting to save" : "Analyzed"
  if (track.status === "ready") return "Ready"
  if (track.status === "writing") return "Saving"
  if (track.status === "written") return "Saved"
  if (track.status === "skipped") return "Already tagged"
  return "Failed"
}

function rowWriteMessage(error: unknown): string | undefined {
  if (error instanceof DOMException) return undefined
  if (error instanceof Error && /user activation|not allowed|permission/i.test(error.message)) return undefined
  if (error instanceof Error && error.message) return error.message
  return "Could not save this file."
}

type Shown = {
  keyLabel: string | null
  openKey: string | null
  bpm: number | null
  energy: number | null
  brightness: number | null
  shape: Analysis["shape"] | null
  mixesWith: string[]
  uncertain: boolean
}

function shownOf(track: Track): Shown | null {
  const merged = mergeShown(track.analysis, track.stored)
  if (!merged) return null
  return {
    ...merged,
    mixesWith: track.analysis?.mixesWith ?? (merged.openKey ? mixesWith(merged.openKey) : []),
    uncertain: track.analysis?.uncertain ?? false,
  }
}

function saveListLabel(view: ListView): string {
  if (view === "unwritten") return "Save not written"
  if (view === "visible") return "Save this view"
  return "Save whole table"
}

function listViewTitle(view: ListView): string {
  if (view === "unwritten") return "Download file, brightness, shape, and mixes with. These are not written into the file."
  if (view === "visible") return "Download the rows in the current filter."
  return "Download every track and every column."
}

function formatBpm(bpm: number | null): string {
  if (bpm == null) return "—"
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
}

function listRow(track: Track, autoSave: boolean): TrackListRow {
  const shown = shownOf(track)
  return {
    file: track.name,
    key: shown?.keyLabel ? `${shown.keyLabel}${shown.uncertain ? " (low confidence)" : ""}` : "",
    openKey: shown?.openKey ?? "",
    bpm: shown?.bpm == null ? "" : formatBpm(shown.bpm),
    energy: shown?.energy == null ? "" : String(shown.energy),
    brightness: shown?.brightness == null ? "" : shown.brightness.toFixed(2),
    shape: shown?.shape ?? "",
    mixesWith: shown ? shown.mixesWith.join(" ") : "",
    status: track.error ?? statusLabel(track, autoSave),
  }
}

function folderQueueLabel(waiting: number, done: number): string {
  if (waiting === 0) return `${done} done`
  if (done === 0) return `${waiting} waiting`
  return `${waiting} waiting · ${done} done`
}

function readAutoSave(): boolean {
  try {
    return localStorage.getItem("openkey-autosave") === "1"
  } catch {
    return false
  }
}

function isDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
  return handle.kind === "directory"
}

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Save was cancelled"
  if (error instanceof Error && /user activation/i.test(error.message)) return "Allow editing in this folder, then save again."
  if (error instanceof Error && error.message) return error.message
  return "Something went wrong"
}
