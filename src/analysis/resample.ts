/** Linear resample used when Essentia's Resample algorithm is not in this build. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (input.length === 0 || fromRate <= 0 || toRate <= 0) return new Float32Array(0)
  if (Math.round(fromRate) === Math.round(toRate)) return input
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate))
  const output = new Float32Array(outLength)
  const scale = fromRate / toRate
  const last = input.length - 1
  for (let index = 0; index < outLength; index++) {
    const position = index * scale
    const left = Math.min(last, Math.floor(position))
    const right = Math.min(last, left + 1)
    const fraction = position - left
    output[index] = input[left]! + (input[right]! - input[left]!) * fraction
  }
  return output
}
