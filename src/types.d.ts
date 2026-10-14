declare module "essentia.js/dist/essentia.js-core.es.js" {
  const Essentia: unknown
  export default Essentia
}

declare module "essentia.js/dist/essentia-wasm.es.js" {
  export const EssentiaWASM: unknown
}

interface OpenFilePickerOptions {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  mode?: "read" | "readwrite"
  types?: Array<{
    description?: string
    accept: Record<string, string[]>
  }>
}

interface Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
}

interface DataTransferItem {
  getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
}

interface FileSystemHandle {
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>
}

