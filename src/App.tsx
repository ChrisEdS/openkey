import { useEffect, useRef, useState, type DragEvent } from "react"
import { analyzeFile } from "./analysis/client.ts"
import type { Analysis } from "./analysis/types.ts"
import { acquireLibrary, canWrite, forgetLibrary, loadLibrary, saveLibrary, writableFile } from "./files/library.ts"
import { writeTags } from "./id3/writeEnergy.ts"
import "./App.css"

type TrackStatus = "queued" | "analyzing" | "ready" | "writing" | "written" | "error"

type Track = {
  id: string
  name: string
  handle: FileSystemFileHandle
  status: TrackStatus
  error?: string
  analysis?: Analysis
}

const pickerOptions = {
  multiple: true,
  excludeAcceptAllOption: true,
  types: [{ description: "MP3 audio", accept: { "audio/mpeg": [".mp3"] } }],
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
  const tracksRef = useRef<Track[]>([])
  const queueRef = useRef<string[]>([])
  const runningRef = useRef(false)
  const libraryRef = useRef<FileSystemDirectoryHandle | null>(null)
  const canPick = typeof window.showOpenFilePicker === "function"

  useEffect(() => {
    let active = true
    void loadLibrary()
      .then((handle) => {
        if (active && handle && !libraryRef.current) libraryRef.current = handle
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
        const id = queueRef.current.shift()
        if (!id) break
        const track = tracksRef.current.find((item) => item.id === id)
        if (!track) continue
        patch(id, { status: "analyzing", error: undefined })
        try {
          const file = await track.handle.getFile()
          const analysis = await analyzeFile(file)
          patch(id, { status: "ready", analysis })
        } catch (error) {
          patch(id, { status: "error", error: messageOf(error) })
        }
      }
    } finally {
      runningRef.current = false
      if (queueRef.current.length > 0) void pump()
    }
  }

  async function chooseFiles() {
    if (!window.showOpenFilePicker) {
      setNotice("Open this page in Chrome or Edge to write energy back into the original MP3.")
      return
    }
    try {
      const handles = await pickMp3s()
      await acceptHandles(handles.map((handle) => Promise.resolve(handle)))
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      setNotice(messageOf(error))
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    const items = [...event.dataTransfer.items].filter((item) => item.kind === "file")
    if (items.length === 0) return
    if (items.some((item) => !item.getAsFileSystemHandle)) {
      setNotice("This browser cannot save into dropped files. Choose MP3s in Chrome or Edge.")
      return
    }
    const handles = items.map((item) => item.getAsFileSystemHandle!())
    void acceptHandles(handles)
  }

  async function acceptHandles(pendingHandles: Array<Promise<FileSystemHandle | null>>) {
    const skipped: string[] = []
    const accepted: Track[] = []
    for (const pending of pendingHandles) {
      const handle = await pending
      if (!handle || !isMp3File(handle)) {
        if (handle) skipped.push(handle.name)
        continue
      }
      accepted.push({
        id: crypto.randomUUID(),
        name: handle.name,
        handle,
        status: "queued",
      })
    }
    if (skipped.length > 0) {
      setNotice(
        skipped.length === 1
          ? `Skipped ${skipped[0]}. Only MP3 files can be tagged.`
          : `Skipped ${skipped.length} items. Only MP3 files can be tagged.`,
      )
    } else {
      setNotice("")
    }
    if (accepted.length > 0) enqueue(accepted)
  }

  async function writeAll() {
    const selection = {
      energy: saveEnergy,
      key: saveKey,
      openKey: saveOpenKey,
      bpm: saveBpm,
    }
    const ready = tracksRef.current.filter(
      (track) => (track.status === "ready" || track.status === "written") && track.analysis,
    )
    if (ready.length === 0 || writing || !hasSelection(selection)) return
    setWriting(true)
    setNotice("")
    try {
      let needsFolder = false
      for (const track of ready) {
        if (!(await canWrite(track.handle))) {
          needsFolder = true
          break
        }
      }
      let directory: FileSystemDirectoryHandle | null = null
      if (needsFolder) {
        const access = await acquireLibrary(libraryRef.current)
        if (!access.ok) {
          setNotice(
            access.reason === "cancelled"
              ? "Save was cancelled"
              : "Allow the music folder once. Chrome can then save every MP3 in it.",
          )
          return
        }
        directory = access.directory
        libraryRef.current = directory
        await saveLibrary(directory).catch(() => undefined)
      }

      let missing = 0
      for (const track of ready) {
        patch(track.id, { status: "writing", error: undefined })
        try {
          let handle = track.handle
          if (!(await canWrite(handle))) {
            if (!directory) throw new Error("Allow the music folder once. Chrome can then save every MP3 in it.")
            const writable = await writableFile(directory, handle)
            if (!writable) {
              missing += 1
              throw new Error("Not in the chosen folder")
            }
            handle = writable
            patch(track.id, { handle })
          }
          const file = await handle.getFile()
          const bytes = new Uint8Array(await file.arrayBuffer())
          const tagged = writeTags(bytes, fieldsFor(track.analysis!, selection))
          const writable = await handle.createWritable()
          await writable.write(new Blob([bytesOf(tagged)]))
          await writable.close()
          patch(track.id, { status: "written" })
        } catch (error) {
          patch(track.id, { status: "ready", error: messageOf(error) })
        }
      }
      if (directory && missing === ready.length) {
        libraryRef.current = null
        await forgetLibrary().catch(() => undefined)
        setNotice("None of these files are in that folder. Choose the folder that contains them, then save again.")
      }
    } finally {
      setWriting(false)
    }
  }

  const analyzing = tracks.some((track) => track.status === "queued" || track.status === "analyzing")
  const selection = { energy: saveEnergy, key: saveKey, openKey: saveOpenKey, bpm: saveBpm }
  const savableCount = tracks.filter(
    (track) => (track.status === "ready" || track.status === "written") && track.analysis,
  ).length
  const selectedNames = fieldNames(selection)

  return (
    <main>
      <header>
        <p className="wordmark">openkey</p>
        <h1>Key and energy for your MP3s</h1>
        <p className="lede">
          Drop a track to read its musical key, Open Key code, tempo, and a 1–10 energy score.
          Choose which of those to save into the file. The audio bytes stay as they are.
        </p>
      </header>

      <fieldset className="writes">
        <legend>Save into the MP3</legend>
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
          Choose MP3s
        </button>
        <p>{canPick ? "or drop them here" : "Open this page in Chrome or Edge to choose files"}</p>
      </div>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {tracks.length > 0 ? (
        <>
          <div className="toolbar">
            <button
              type="button"
              onClick={() => void writeAll()}
              disabled={savableCount === 0 || analyzing || writing || selectedNames.length === 0}
            >
              {writing ? "Saving…" : saveButtonLabel(selectedNames, savableCount)}
            </button>
            <p>
              {analyzing
                ? "Reading tracks one at a time."
                : selectedNames.length === 0
                  ? "Select at least one field."
                  : `Writes ${selectedNames.join(", ")}. Other tags stay as they are. The music folder is approved once for every file.`}
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Analyzed MP3s</caption>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Key</th>
                  <th>Open Key</th>
                  <th>BPM</th>
                  <th>Energy</th>
                  <th>Mixes with</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((track) => (
                  <TrackRow key={track.id} track={track} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </main>
  )
}

function TrackRow({ track }: { track: Track }) {
  const analysis = track.analysis
  return (
    <tr>
      <td className="file">{track.name}</td>
      <td>
        {analysis ? (
          <>
            {analysis.keyLabel}
            {analysis.uncertain ? <span className="flag">Low confidence</span> : null}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="code">{analysis?.openKey ?? "—"}</td>
      <td className="code">{analysis ? formatBpm(analysis.bpm) : "—"}</td>
      <td>
        {analysis ? (
          <span className="energy">
            <strong>{analysis.energy}</strong>
            <span className="meter" aria-hidden="true">
              {Array.from({ length: 10 }, (_, index) => (
                <i key={index} className={index < analysis.energy ? "on" : ""} />
              ))}
            </span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="code">{analysis ? analysis.mixesWith.join("  ") : "—"}</td>
      <td className={track.error ? "status bad" : "status"}>{track.error ?? statusLabel(track.status)}</td>
    </tr>
  )
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
}

function hasSelection(selection: SaveSelection): boolean {
  return selection.energy || selection.key || selection.openKey || selection.bpm
}

function fieldNames(selection: SaveSelection): string[] {
  return [
    selection.energy ? "energy" : "",
    selection.key ? "key" : "",
    selection.openKey ? "Open Key" : "",
    selection.bpm ? "BPM" : "",
  ].filter((name) => name !== "")
}

function fieldsFor(analysis: Analysis, selection: SaveSelection) {
  const onlyBpm = selection.bpm && !selection.energy && !selection.key && !selection.openKey
  if (onlyBpm && analysis.bpm == null) throw new Error("No BPM detected for this track")
  return {
    energy: selection.energy ? analysis.energy : undefined,
    keyLabel: selection.key ? analysis.keyLabel : undefined,
    openKey: selection.openKey ? analysis.openKey : undefined,
    bpm: selection.bpm && analysis.bpm != null ? analysis.bpm : undefined,
  }
}

function isMp3File(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === "file" && handle.name.toLowerCase().endsWith(".mp3")
}

function bytesOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

async function pickMp3s(): Promise<FileSystemFileHandle[]> {
  const picker = window.showOpenFilePicker
  if (!picker) throw new Error("Open this page in Chrome or Edge to write energy back into the original MP3.")
  try {
    return await picker({ ...pickerOptions, mode: "readwrite" })
  } catch (error) {
    if (error instanceof TypeError) return picker(pickerOptions)
    throw error
  }
}

function statusLabel(status: TrackStatus): string {
  if (status === "queued") return "Queued"
  if (status === "analyzing") return "Analyzing"
  if (status === "ready") return "Ready"
  if (status === "writing") return "Saving"
  if (status === "written") return "Saved"
  return "Failed"
}

function formatBpm(bpm: number | null): string {
  if (bpm == null) return "—"
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
}

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Save was cancelled"
  if (error instanceof Error && error.message) return error.message
  return "Something went wrong"
}
