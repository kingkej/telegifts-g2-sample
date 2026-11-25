const width = 256, label = 170

// Three bits per row, drawn 2× so numeric axis labels are legible on the G2.
const glyphs: Record<string, readonly number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7], '7': [7, 1, 2, 2, 2], '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7], '.': [0, 0, 0, 0, 2], '-': [0, 0, 7, 0, 0],
  'e': [0, 0, 7, 6, 7], ':': [0, 2, 0, 2, 0], '/': [1, 1, 2, 4, 4],
  '°': [2, 5, 2, 0, 0], 'U': [5, 5, 5, 5, 7], 'T': [7, 2, 2, 2, 2], 'C': [7, 4, 4, 4, 7],
}

export const textWidth = (text: string) => 8 * text.length - 2

export function drawLabel(pixels: Uint8Array, text: string, x: number, y: number) {
  for (const char of text) {
    for (const [row, bits] of (glyphs[char] ?? []).entries()) {
      for (let col = 0; col < 3; col++) {
        if (!(bits & (4 >> col))) continue
        const index = (y + 2 * row) * width + x + 2 * col
        pixels.fill(label, index, index + 2)
        pixels.fill(label, index + width, index + width + 2)
      }
    }
    x += 8
  }
}
