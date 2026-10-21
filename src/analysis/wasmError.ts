type WasmHeap = {
  HEAPU8?: Uint8Array
  HEAP32?: Int32Array
}

/** Reads the text Essentia stores beside a numeric WebAssembly exception. */
export function readWasmError(heap: Uint8Array, heap32: Int32Array, ptr: number): string | null {
  if (ptr <= 0 || ptr + 64 >= heap.length) return null
  const start = ptr >> 2
  if (start + 16 >= heap32.length) return null

  let best = ""
  for (let offset = 0; offset <= 64; offset += 4) {
    const address = heap32[start + (offset >> 2)]
    if (address <= 1024 || address >= heap.length - 8) continue
    let text = ""
    const limit = Math.min(heap.length, address + 240)
    for (let index = address; index < limit; index++) {
      const byte = heap[index]!
      if (byte === 0 || byte < 32 || byte > 126) break
      text += String.fromCharCode(byte)
    }
    if (text.length > best.length && /[A-Za-z]{4,}/.test(text)) best = text
  }
  if (!best) return null
  const sentence = best.split(".Available")[0] ?? best
  return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence
}

export function wasmErrorMessage(wasm: WasmHeap, error: unknown): string {
  if (error instanceof Error && error.message && !/^\d+$/.test(error.message)) return friendly(error.message)
  const ptr = typeof error === "number" ? error : Number(error instanceof Error ? error.message : NaN)
  if (!Number.isInteger(ptr) || ptr <= 0) return "Analysis failed"
  const heap = wasm.HEAPU8
  const heap32 = wasm.HEAP32
  if (!heap || !heap32 || heap.byteLength === 0) return "Analysis failed"
  const text = readWasmError(heap, heap32, ptr)
  return text ? friendly(text) : "Analysis failed"
}

function friendly(message: string): string {
  if (message.startsWith("Value not found") || message.startsWith("Descriptor name")) {
    return "This file did not produce a key or tempo"
  }
  if (message.includes("not found in registry")) return "This file could not be analyzed"
  return message
}
