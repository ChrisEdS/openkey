import { describe, expect, it } from "vitest"
import { readWasmError, wasmErrorMessage } from "./wasmError.ts"

function heapWith(ptr: number, address: number, text: string): { heap: Uint8Array; heap32: Int32Array } {
  const heap = new Uint8Array(4096)
  const bytes = new TextEncoder().encode(text)
  heap.set(bytes, address)
  const heap32 = new Int32Array(heap.buffer)
  heap32[(ptr + 4) >> 2] = address
  return { heap, heap32 }
}

describe("readWasmError", () => {
  it("reads the exception text and drops the algorithm dump", () => {
    const { heap, heap32 } = heapWith(64, 1200, "Value not found: 'bpm'.Available keys: [everything]")
    expect(readWasmError(heap, heap32, 64)).toBe("Value not found: 'bpm'")
  })

  it("returns null when the pointer is not a message", () => {
    expect(readWasmError(new Uint8Array(128), new Int32Array(32), 32)).toBeNull()
  })
})

describe("wasmErrorMessage", () => {
  it("turns a numeric exception into a readable failure", () => {
    const { heap, heap32 } = heapWith(64, 1200, "Descriptor name 'lags' of type std::vector<Real> not found")
    expect(wasmErrorMessage({ HEAPU8: heap, HEAP32: heap32 }, 64)).toBe("This file did not produce a key or tempo")
  })

  it("keeps an ordinary Error message", () => {
    expect(wasmErrorMessage({}, new Error("This file is too short to analyze"))).toBe("This file is too short to analyze")
  })
})
