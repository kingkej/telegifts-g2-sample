const sampleRate = 16_000
const frameSamples = sampleRate / 50

/** Mean-square power after removing the DC offset in a nonempty PCM window. */
export function acPower(bytes: DataView, start: number, end: number): number {
  let sum = 0
  let squares = 0
  for (let i = start; i < end; i++) {
    const value = bytes.getInt16(2 * i, true)
    sum += value
    squares += value * value
  }
  const length = end - start
  return squares / length - (sum / length) ** 2
}

/** Measure in 20 ms windows so one click or a DC offset cannot look like speech. */
export function speechSamples(pcm: Uint8Array): Float32Array | null {
  const samples = pcm.byteLength / 2
  if (!Number.isInteger(samples) || samples < frameSamples * 8) return null
  const bytes = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let first = samples
  let last = 0
  let active = 0
  for (let start = 0; start < samples; start += frameSamples) {
    const end = Math.min(samples, start + frameSamples)
    const length = end - start
    if (acPower(bytes, start, end) < (32768 * 0.004) ** 2) continue
    first = Math.min(first, start)
    last = end
    active += length
  }
  if (active < frameSamples * 8) return null
  // Retain quiet consonants, and give the acoustic front end silence on both sides.
  const start = Math.max(0, first - frameSamples * 6)
  const end = Math.min(samples, last + frameSamples * 6)
  const padding = sampleRate / 5
  const audio = new Float32Array(end - start + padding * 2)
  for (let i = start; i < end; i++) audio[padding + i - start] = bytes.getInt16(2 * i, true) / 32768
  return audio
}
