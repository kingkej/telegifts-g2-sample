import type { CompanionFloorSeries } from './contracts/companion.ts'
import { drawLabel, textWidth } from './bitmapText.ts'

const width = 256, height = 144
const top = 9, bottom = 117, right = width - 5
const axis = 68, stroke = 221, highlight = 255

function priceLabel(price: number) {
  const [mantissa, exponent] = price.toExponential(3).split('e')
  const power = Number(exponent)
  if (power < -3 || power > 6) return Number(mantissa) + 'e' + power
  return String(Number(price.toPrecision(4)))
}

function timeLabel(date: Date, intraday: boolean) {
  const two = (n: number) => String(n).padStart(2, '0')
  const day = two(date.getUTCMonth() + 1) + '/' + two(date.getUTCDate())
  return intraday ? day + ' ' + two(date.getUTCHours()) + ':' + two(date.getUTCMinutes()) : day
}

export function chartSamples(series: CompanionFloorSeries): [number, number][] {
  if (!series || !Array.isArray(series.points)) return []
  const { from, to, interval } = series
  if (
    (interval !== 900 && interval !== 86_400)
    || !Number.isSafeInteger(from)
    || !Number.isSafeInteger(to)
    || from < 0
    || to <= from
    || to > 253_402_300_799
    || from % interval !== 0
    || to % interval !== 0
  ) {
    return []
  }

  const closes = new Map<number, number>()
  for (const point of series.points) {
    if (
      point
      && Number.isSafeInteger(point.time)
      && point.time >= from
      && point.time <= to - interval
      && point.time % interval === 0
      && Number.isFinite(point.price)
      && point.price > 0
    ) {
      closes.set(point.time, point.price)
    }
  }
  return [...closes].sort(([a], [b]) => a - b)
}

/** Row-major 8-bit luminance. Black is off and every ink is a multiple of 17. */
export function renderFloorChart(series: CompanionFloorSeries, samples = chartSamples(series)): Uint8Array<ArrayBuffer> {
  const pixels = new Uint8Array(width * height)
  if (!samples.length) return pixels
  const { from, to, interval } = series
  const start = new Date(from * 1000), end = new Date(to * 1000)
  let low = Infinity, high = 0, lowTime = 0, highTime = 0
  for (const [time, price] of samples) {
    if (price < low) { low = price; lowTime = time }
    if (price > high) { high = price; highTime = time }
  }

  const flat = high === low
  const padding = flat ? 0 : Math.max(0, high * 0.02 - (high - low)) / 2
  const upper = Math.min(Number.MAX_VALUE, high + padding), lower = low - padding
  const highLabel = priceLabel(upper), lowLabel = priceLabel(lower)
  const left = 9 + Math.max(textWidth(highLabel), textWidth(lowLabel))
  const mid = (top + bottom) / 2
  const axisY = bottom + 6
  for (let y = top; y <= axisY; y++) pixels[y * width + left - 3] = axis
  pixels.fill(axis, axisY * width + left - 3, axisY * width + right + 1)
  for (const x of [left, Math.round((left + right) / 2), right]) {
    for (let y = axisY + 1; y <= axisY + 3; y++) pixels[y * width + x] = axis
  }
  for (const y of flat ? [mid] : [top, mid, bottom]) {
    pixels.fill(axis, y * width + left - 5, y * width + left - 2)
  }
  drawLabel(pixels, highLabel, left - 8 - textWidth(highLabel), (flat ? mid : top) - 5)
  if (!flat) drawLabel(pixels, lowLabel, left - 8 - textWidth(lowLabel), bottom - 5)
  const first = timeLabel(start, interval < 86_400), last = timeLabel(end, interval < 86_400) + ' UTC'
  drawLabel(pixels, first, Math.max(1, left - Math.floor(textWidth(first) / 2)), 131)
  drawLabel(pixels, last, right + 1 - textWidth(last), 131)

  function ink(x: number, y: number, value: number) {
    const index = y * width + x
    pixels[index] = Math.max(pixels[index]!, value)
  }
  function trace(x: number, y: number) {
    ink(x, y, stroke)
    ink(x, y - 1, 102)
    ink(x, y + 1, 102)
  }
  const dxPerBucket = interval / (to - from) * (right - left)
  const markerRadius = Math.min(2, Math.floor(dxPerBucket / 3))
  let previous: { time: number; x: number; y: number } | undefined
  for (const [index, [time, price]] of samples.entries()) {
    const x = left + Math.round((time - from) / (to - from) * (right - left))
    const y = flat ? mid : top + Math.round((upper - price) / (upper - lower) * (bottom - top))
    const connected = previous?.time === time - interval
    if (previous && connected) {
      const dx = x - previous.x, dy = y - previous.y
      const steps = Math.max(1, dx, Math.abs(dy))
      for (let step = 0; step <= steps; step++) {
        const px = previous.x + Math.round(dx * step / steps)
        const py = previous.y + Math.round(dy * step / steps)
        trace(px, py)
        // Subtle 16-level area glow below joined price segments (stays < 200 threshold).
        for (let ay = py + 2; ay < axisY; ay += 2) {
          const depth = (ay - py) / Math.max(1, axisY - py)
          const shade = depth < 0.35 ? 34 : depth < 0.7 ? 17 : 0
          if (shade) ink(px, ay, shade)
        }
      }
    } else {
      trace(x, y)
    }
    const isolated = !connected && samples[index + 1]?.[0] !== time + interval
    if (isolated || (!flat && (time === lowTime || time === highTime))) {
      for (let offset = -2; offset <= 2; offset++) ink(x, y + offset, highlight)
      for (let offset = -markerRadius; offset <= markerRadius; offset++) ink(x + offset, y, highlight)
    }
    previous = { time, x, y }
  }
  return pixels
}
