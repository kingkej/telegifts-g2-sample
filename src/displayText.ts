const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
const encoder = new TextEncoder()

// Rebuilds use textObjects.content (999 UTF-8 bytes), even for pages also sent as upgrades.
export const nativeTextBytes = 999
export const byteLength = (text: string) => encoder.encode(text).length

export function nativeMenuLabel(label: string): string {
  if (encoder.encode(label).length <= 32) return label
  let prefix = ''
  let bytes = 0
  for (const { segment } of segmenter.segment(label)) {
    bytes += encoder.encode(segment).length
    if (bytes > 29) break // Reserve three UTF-8 bytes for the ellipsis.
    prefix += segment
  }
  return prefix + '…'
}

export function characters(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment)
}

// Native text containers also impose a length limit on the complete string.
export function fitNativeText(text: string, limit: number, suffix = '…'): string {
  if (byteLength(text) <= limit) return text
  if (byteLength(suffix) > limit) suffix = ''
  let available = limit - byteLength(suffix)
  let end = 0
  for (const part of segmenter.segment(text)) {
    available -= byteLength(part.segment)
    if (available < 0) break
    end += part.segment.length
  }
  return text.slice(0, end) + suffix
}
