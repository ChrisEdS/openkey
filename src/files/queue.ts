export type QueueTrack = {
  id: string
  status: string
  directory?: { name: string }
}

export function queueFolderGroups<T extends QueueTrack>(tracks: T[]): { directory: NonNullable<T["directory"]>; tracks: T[] }[] {
  const groups: { directory: NonNullable<T["directory"]>; tracks: T[] }[] = []
  for (const track of tracks) {
    if (!track.directory) continue
    const found = groups.find((group) => group.directory === track.directory)
    if (found) found.tracks.push(track)
    else groups.push({ directory: track.directory, tracks: [track] })
  }
  return groups
}

/** Tracks still waiting in this folder. Finished tracks stay in the list. */
export function waitingIds<T extends QueueTrack>(tracks: T[], directory: NonNullable<T["directory"]>): string[] {
  return tracks
    .filter((track) => track.directory === directory && (track.status === "queued" || track.status === "analyzing"))
    .map((track) => track.id)
}
