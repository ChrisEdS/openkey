const AUDIO_EXTENSIONS = [".mp3", ".wav", ".aif", ".aiff", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac"]

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXTENSIONS.includes(extensionOf(name))
}

export function isMp3Name(name: string): boolean {
  return extensionOf(name) === ".mp3"
}

export function isAudioFile(handle: FileSystemHandle): handle is FileSystemFileHandle {
  return handle.kind === "file" && isAudioName(handle.name)
}

export type AudioEntry = {
  handle: FileSystemFileHandle
  /** Path inside the chosen folder, including the file name. */
  path: string[]
}

/** Audio files in this folder and its subfolders. A folder that cannot be listed is skipped. */
export async function collectAudioEntries(directory: FileSystemDirectoryHandle): Promise<AudioEntry[]> {
  const files: AudioEntry[] = []
  await walk(directory, [], files)
  return files

  async function walk(dir: FileSystemDirectoryHandle, prefix: string[], into: AudioEntry[]): Promise<void> {
    for await (const handle of dir.values()) {
      if (handle.kind === "directory") {
        try {
          await walk(handle, [...prefix, handle.name], into)
        } catch {
          // Skip a folder the site cannot list.
        }
      } else if (isAudioFile(handle)) {
        into.push({ handle, path: [...prefix, handle.name] })
      }
    }
  }
}

export async function collectAudioFiles(directory: FileSystemDirectoryHandle): Promise<FileSystemFileHandle[]> {
  const entries = await collectAudioEntries(directory)
  return entries.map((entry) => entry.handle)
}

export const audioPickerTypes = [
  {
    description: "Audio",
    accept: {
      "audio/mpeg": [".mp3"],
      "audio/wav": [".wav"],
      "audio/aiff": [".aiff", ".aif"],
      "audio/flac": [".flac"],
      "audio/ogg": [".ogg", ".oga", ".opus"],
      "audio/mp4": [".m4a", ".aac"],
    },
  },
]
