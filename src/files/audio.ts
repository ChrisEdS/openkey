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
