import type { VenueQuote } from './contracts/companion.ts'

const width = 256
const height = 144

// Compact 3x5 uppercase/numeric pixel font for crisp 256x144 monochrome G2 spread bars.
const smallGlyphs: Record<string, readonly number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 2, 2, 2],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  '.': [0, 0, 0, 0, 2],
  ':': [0, 2, 0, 2, 0],
  '/': [1, 1, 2, 4, 4],
  '#': [5, 7, 5, 7, 5],
  '~': [0, 3, 6, 0, 0],
  '+': [0, 2, 7, 2, 0],
  '-': [0, 0, 7, 0, 0],
  '%': [5, 1, 2, 4, 5],
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [3, 4, 4, 4, 3],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3],
  H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 2],
  K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [5, 7, 7, 7, 5],
  O: [2, 5, 5, 5, 2],
  P: [6, 5, 6, 4, 4],
  Q: [2, 5, 5, 6, 3],
  R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 2, 2],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
}

export function drawMiniText(pixels: Uint8Array, text: string, x: number, y: number, shade = 187, scale = 2) {
  let cursor = x
  for (const raw of text.toUpperCase()) {
    if (raw === ' ') {
      cursor += 3 * scale
      continue
    }
    const rows = smallGlyphs[raw]
    if (rows) {
      for (let r = 0; r < rows.length; r++) {
        const bits = rows[r]!
        for (let c = 0; c < 3; c++) {
          if (!(bits & (4 >> c))) continue
          for (let dy = 0; dy < scale; dy++) {
            const py = y + r * scale + dy
            if (py < 0 || py >= height) continue
            for (let dx = 0; dx < scale; dx++) {
              const px = cursor + c * scale + dx
              if (px >= 0 && px < width) pixels[py * width + px] = shade
            }
          }
        }
      }
    }
    cursor += 4 * scale
  }
}

export function miniTextWidth(text: string, scale = 2): number {
  return text.length ? text.length * 4 * scale - scale : 0
}

function shortVenue(name: string): string {
  const upper = name.toUpperCase()
  if (upper.startsWith('PORTAL')) return 'PRT'
  if (upper.startsWith('TONNEL')) return 'TNL'
  if (upper.startsWith('MRKT')) return 'MRK'
  if (upper.startsWith('GETGEM')) return 'GGM'
  if (upper.startsWith('FRAG')) return 'FRG'
  return upper.slice(0, 3)
}

function compactPrice(price: number): string {
  if (price >= 1000) return String(Math.round(price))
  if (price >= 10) return Number(price.toFixed(1)).toString()
  return Number(price.toPrecision(3)).toString()
}

/**
 * Renders a 256 x 144 row-major 4-bit quantized grayscale horizontal bar chart
 * comparing live GRAM listing floors across marketplaces on the Even G2 lens.
 */
export function renderSpreadChart(quotes: readonly VenueQuote[]): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(width * height)
  const sorted = [...quotes]
    .filter(q => Number.isFinite(q.price) && q.price > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 5)
  if (!sorted.length) return pixels

  const lowest = sorted[0]!.price
  const highest = sorted[sorted.length - 1]!.price
  const spreadPct = highest > lowest ? ((highest - lowest) / lowest) * 100 : 0

  drawMiniText(pixels, 'VENUE SPREAD', 6, 6, 153, 2)
  const badge = spreadPct > 0 ? `+${spreadPct.toFixed(1)}%` : '0.0%'
  drawMiniText(pixels, badge, width - 6 - miniTextWidth(badge, 2), 6, 255, 2)

  // Subtle header divider
  pixels.fill(68, 20 * width + 6, 20 * width + (width - 6))

  const barLeft = 36
  const barMaxRight = 186
  const rowHeight = Math.min(24, Math.floor(116 / sorted.length))
  const startY = 26

  for (const [idx, quote] of sorted.entries()) {
    const y = startY + idx * rowHeight
    const isBest = idx === 0
    drawMiniText(pixels, shortVenue(quote.marketplace), 6, y + 2, isBest ? 255 : 170, 2)

    const ratio = highest === lowest ? 0.72 : 0.42 + 0.58 * ((quote.price - lowest) / (highest - lowest))
    const barEnd = barLeft + Math.max(12, Math.round((barMaxRight - barLeft) * (isBest && highest > lowest ? 0.42 : ratio)))
    const fillShade = isBest ? 255 : Math.max(85, 187 - idx * 34)

    for (let by = y + 2; by <= y + 11 && by < height; by++) {
      // Background track
      pixels.fill(34, by * width + barLeft, by * width + barMaxRight)
      // Quantized value bar
      pixels.fill(fillShade, by * width + barLeft, by * width + barEnd)
    }

    const label = compactPrice(quote.price)
    drawMiniText(pixels, label, barMaxRight + 6, y + 2, isBest ? 255 : 187, 2)
  }

  return pixels
}
