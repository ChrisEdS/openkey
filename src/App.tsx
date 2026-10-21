import { useEffect, useRef, useState, type DragEvent } from "react"
import { analyzeFile } from "./analysis/client.ts"
import type { Analysis } from "./analysis/types.ts"
import { audioPickerTypes, isAudioFile, isMp3Name } from "./files/audio.ts"
import { ALL_COLUMNS, trackListCsv, UNWRITTEN_COLUMNS, type TrackListRow } from "./files/trackList.ts"
import { acquireLibrary, canWrite, forgetLibrary, loadLibrary, saveLibrary, writableFile } from "./files/library.ts"
import { formatMixedInKeyComment, writeTags } from "./id3/writeEnergy.ts"
import "./App.css"

type TrackStatus = "queued" | "analyzing" | "ready" | "writing" | "written" | "error"
type StatusFilter = "all" | "working" | "ready" | "saved" | "failed"
type ListView = "unwritten" | "visible" | "all"

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
      setNotice("Open this page in Chrome or Edge to write tags back into the original MP3.")
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
      setNotice("This browser cannot save into dropped files. Choose audio in Chrome or Edge.")
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
      if (!handle || !isAudioFile(handle)) {
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
          ? `Skipped ${skipped[0]}. Only audio files can be read.`
          : `Skipped ${skipped.length} items. Only audio files can be read.`,
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
      comment: saveEnergy && saveComment,
    }
    const ready = tracksRef.current.filter(
      (track) => (track.status === "ready" || track.status === "written") && track.analysis && isMp3Name(track.name),
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

  function removeTrack(id: string) {
    queueRef.current = queueRef.current.filter((item) => item !== id)
    commit(tracksRef.current.filter((track) => track.id !== id))
  }

  function saveTrackList() {
    const source = listView === "visible" ? tracksRef.current.filter((track) => matchesFilter(track, filter)) : tracksRef.current
    const columns = listView === "unwritten" ? UNWRITTEN_COLUMNS : ALL_COLUMNS
    const csv = trackListCsv(source.map(listRow), columns)
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
    commit([])
    setFilter("all")
    setNotice("")
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
  const selection = { energy: saveEnergy, key: saveKey, openKey: saveOpenKey, bpm: saveBpm, comment: saveEnergy && saveComment }
  const readyTracks = tracks.filter(
    (track) => (track.status === "ready" || track.status === "written") && track.analysis,
  )
  const savableCount = readyTracks.filter((track) => isMp3Name(track.name)).length
  const readOnlyCount = readyTracks.length - savableCount
  const selectedNames = fieldNames(selection)
  const tally = tallyTracks(tracks)
  const visible = tracks.filter((track) => matchesFilter(track, filter))
  const failedCount = tracks.filter((track) => track.status === "error").length

  return (
    <main className={tracks.length > 0 ? "has-tracks" : undefined}>
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
        <p>{canPick ? "or drop them here" : "Open this page in Chrome or Edge to choose files"}</p>
      </div>

      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {tracks.length > 0 ? (
        <div className="workspace">
          <div className="toolbar">
            <div className="stats" role="group" aria-label="Filter by status">
              <FilterButton label="All" count={tally.total} pressed={filter === "all"} onClick={() => setFilter("all")} />
              <FilterButton label="Working" count={tally.working} pressed={filter === "working"} onClick={() => setFilter("working")} />
              <FilterButton label="Ready" count={tally.ready} pressed={filter === "ready"} onClick={() => setFilter("ready")} />
              <FilterButton label="Saved" count={tally.saved} pressed={filter === "saved"} onClick={() => setFilter("saved")} />
              <FilterButton label="Failed" count={tally.failed} pressed={filter === "failed"} onClick={() => setFilter("failed")} />
            </div>
            <div className="actions">
              <button
                type="button"
                onClick={() => void writeAll()}
                disabled={savableCount === 0 || analyzing || writing || selectedNames.length === 0}
              >
                {writing ? "Saving…" : saveButtonLabel(selectedNames, savableCount)}
              </button>
              <label className="list-view">
                <span className="sr-only">List to save</span>
                <select value={listView} onChange={(event) => setListView(event.target.value as ListView)}>
                  <option value="unwritten">Not written</option>
                  <option value="visible">This view</option>
                  <option value="all">Whole table</option>
                </select>
              </label>
              <button type="button" className="quiet" onClick={saveTrackList} title={listViewTitle(listView)}>
                Save list
              </button>
              <button type="button" className="quiet" onClick={retryFailed} disabled={failedCount === 0 || writing}>
                Retry failed
              </button>
              <button type="button" className="quiet" onClick={clearTracks} disabled={writing}>
                Clear list
              </button>
            </div>
            <p>
              {analyzing
                ? `${trackSummary(tally)} Reading tracks one at a time.`
                : selectedNames.length === 0
                  ? `${trackSummary(tally)} Select at least one field.`
                  : `${trackSummary(tally)} ${saveSummary(selectedNames, savableCount, readOnlyCount)}`}
            </p>
            <p className="legend">
              Energy is 1–10 intensity. Brightness is the share above 5 kHz. Shape is L level, B builds, D jumps. Brightness and shape are not saved.
            </p>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Analyzed tracks</caption>
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
                {visible.length === 0 ? (
                  <tr>
                    <td className="empty" colSpan={9}>
                      Nothing in this view.
                    </td>
                  </tr>
                ) : (
                  visible.map((track) => <TrackRow key={track.id} track={track} onRemove={removeTrack} />)
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <aside className="sponsor">
        <div className="sponsor-row">
          <div className="sponsor-main">
            <h2>Sponsor this project</h2>
            <a className="sponsor-person" href="https://github.com/ChrisEdS">
              <img src="/chriseds.png" alt="" width="28" height="28" />
              <span className="sponsor-login">ChrisEdS</span>
              <span className="sponsor-name">Christian Scherm</span>
            </a>
            <a className="sponsor-more" href="https://github.com/sponsors">Learn more</a>
          </div>
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
        </div>
      </aside>
    </main>
  )
}

function TrackRow({ track, onRemove }: { track: Track; onRemove: (id: string) => void }) {
  const analysis = track.analysis
  return (
    <tr>
      <td className="file" title={track.name}>{track.name}</td>
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
      <td className="code">{analysis ? analysis.brightness.toFixed(2) : "—"}</td>
      <td title={analysis ? shapeTitle(analysis.shape) : undefined}>
        {analysis ? <span className={`shape shape-${analysis.shape.toLowerCase()}`}>{analysis.shape}</span> : "—"}
      </td>
      <td>
        {analysis ? (
          <span className="mixes">
            {analysis.mixesWith.map((code) => (
              <span className="mix" key={code}>{code}</span>
            ))}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className={statusClass(track)}>
        <div className="status-cell">
          <span>{track.error ?? statusLabel(track.status)}</span>
          <button
            type="button"
            className="quiet tiny"
            onClick={() => onRemove(track.id)}
            disabled={track.status === "writing" || track.status === "analyzing"}
          >
            Remove
          </button>
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
    failed: tracks.filter((track) => track.status === "error" || Boolean(track.error)).length,
  }
}

function trackSummary(tally: ReturnType<typeof tallyTracks>): string {
  const parts = [`${tally.total} ${tally.total === 1 ? "track" : "tracks"}`]
  if (tally.working > 0) parts.push(`${tally.working} working`)
  if (tally.ready > 0) parts.push(`${tally.ready} ready`)
  if (tally.saved > 0) parts.push(`${tally.saved} saved`)
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

function statusLabel(status: TrackStatus): string {
  if (status === "queued") return "Queued"
  if (status === "analyzing") return "Analyzing"
  if (status === "ready") return "Ready"
  if (status === "writing") return "Saving"
  if (status === "written") return "Saved"
  return "Failed"
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

function listRow(track: Track): TrackListRow {
  const analysis = track.analysis
  return {
    file: track.name,
    key: analysis ? `${analysis.keyLabel}${analysis.uncertain ? " (low confidence)" : ""}` : "",
    openKey: analysis?.openKey ?? "",
    bpm: analysis?.bpm == null ? "" : formatBpm(analysis.bpm),
    energy: analysis ? String(analysis.energy) : "",
    brightness: analysis ? analysis.brightness.toFixed(2) : "",
    shape: analysis?.shape ?? "",
    mixesWith: analysis ? analysis.mixesWith.join(" ") : "",
    status: track.error ?? statusLabel(track.status),
  }
}

function messageOf(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Save was cancelled"
  if (error instanceof Error && error.message) return error.message
  return "Something went wrong"
}
