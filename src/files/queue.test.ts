import { describe, expect, it } from "vitest"
import { queueFolderGroups, waitingIds, type QueueTrack } from "./queue.ts"

describe("queue folders", () => {
  it("groups tracks by the folder they came from and skips loose files", () => {
    const edits = { name: "Edits" }
    const house = { name: "House" }
    const tracks: QueueTrack[] = [
      { id: "a", status: "queued", directory: edits },
      { id: "b", status: "ready", directory: edits },
      { id: "c", status: "queued", directory: house },
      { id: "d", status: "queued" },
    ]
    const groups = queueFolderGroups(tracks)
    expect(groups.map((group) => group.directory.name)).toEqual(["Edits", "House"])
    expect(groups[0]?.tracks.map((track) => track.id)).toEqual(["a", "b"])
    expect(waitingIds(tracks, edits)).toEqual(["a"])
    expect(waitingIds(tracks, house)).toEqual(["c"])
  })
})
