import assert from 'node:assert/strict'
import test from 'node:test'
import { renderFloorChart } from '../src/floorChart.ts'

const width = 256, height = 144, interval = 900
const from = Date.parse('2026-02-28T00:00:00Z') / 1000
function series(bars, buckets = 12) {
  return { from, to: from + buckets * interval, interval,
    points: bars.map(([bucket, price]) => ({ time: from + bucket * interval, price })) }
}

// Read the data ink separately from the dimmer axes and numeric labels.
function bands(frame, threshold = 200) {
  const result = []
  let band
  for (let x = 0; x < width; x++) {
    let top = height, bottom = -1
    for (let y = 0; y < height; y++) {
      if (frame[y * width + x] < threshold) continue
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
    if (bottom < 0) { band = undefined; continue }
    if (!band) {
      band = { left: x, right: x, top, bottom }
      result.push(band)
    }
    band.right = x
    band.top = Math.min(band.top, top)
    band.bottom = Math.max(band.bottom, bottom)
  }
  return result
}
const centerX = band => (band.left + band.right) / 2
const centerY = band => (band.top + band.bottom) / 2

test('returns one 256 × 144 row-major luminance plane on the 16-level grayscale palette', () => {
  const frame = renderFloorChart(series([[1, 2], [2, 3], [3, 5], [4, 4]]))
  assert.ok(frame instanceof Uint8Array)
  assert.equal(frame.byteLength, width * height)
  assert.ok(frame.every(pixel => pixel % 17 === 0))
  assert.equal(frame[0], 0)
  assert.ok(frame.includes(255))
  assert.ok(frame.some(pixel => pixel > 0 && pixel < 200))
  assert.ok(frame.subarray(130 * width).some(pixel => pixel > 0), 'window endpoint labels')
})

test('no plottable data or an invalid window gives an entirely off plane', () => {
  const valid = series([[4, 6]])
  const blank = new Uint8Array(width * height)
  for (const bad of [null, series([]), { ...valid, from: NaN }, { ...valid, to: valid.from },
    { ...valid, interval: -1 }, { ...valid, interval: 0.5 }, { ...valid, points: null },
    series([[-1, 10], [12, 1], [2.5, 1], [2, NaN], [3, 0], [7, Infinity]])]) {
    assert.deepEqual(renderFloorChart(bad), blank)
  }
})

test('rejects shifted UTC axes, unsupported intervals and millisecond time fields before drawing', () => {
  const data = series([[2, 3], [4, 5]], 96)
  const shifted = { from: data.from + 1, to: data.to + 1, interval,
    points: data.points.map(p => ({ time: p.time + 1, price: p.price })) }
  const milliseconds = { from: data.from * 1000, to: data.to * 1000, interval: interval * 1000,
    points: data.points.map(p => ({ time: p.time * 1000, price: p.price })) }
  const blank = new Uint8Array(width * height)
  for (const invalid of [shifted, { ...data, to: data.to + 1 }, { ...data, interval: 1800 }, milliseconds,
    { ...milliseconds, interval }, { ...data, from: -interval },
    { from: data.from + interval, to: data.from + interval + 7 * 86_400, interval: 86_400,
      points: [{ time: data.from + interval, price: 2 }] }]) {
    assert.deepEqual(renderFloorChart(invalid), blank)
  }
  assert.deepEqual(renderFloorChart({ ...data, points: shifted.points }), blank)
})

test('places sparse closes in elapsed time and linear price, with blank leading and trailing history', () => {
  const frame = renderFloorChart(series([[1, 4], [4, 5], [10, 6]]))
  const observations = bands(frame)
  assert.equal(observations.length, 3)
  const [a, b, c] = observations
  assert.ok(a.left > 20 && c.right < width - 15)
  assert.ok(Math.abs((centerX(c) - centerX(b)) - 2 * (centerX(b) - centerX(a))) <= 2)
  assert.ok(centerY(a) > centerY(b) && centerY(b) > centerY(c))
  assert.ok(Math.abs(centerY(b) - (centerY(a) + centerY(c)) / 2) <= 1)
  assert.ok(c.top < 20 && a.bottom > 100)
})

test('only adjacent buckets join, including at the dense 24h resolution', () => {
  const data = series([[0, 3], [1, 5], [2, 4], [4, 2], [5, 2], [62, 4], [63, 3]], 96)
  const [first, second, third, extra] = bands(renderFloorChart(data))
  assert.equal(extra, undefined)
  assert.ok(first.bottom - first.top > 50)
  assert.ok(second.left - first.right >= 2, 'one missing bucket retains an unpainted column')
  assert.ok(third.left - second.right > 100)
  assert.ok(third.right < width - 50, 'the old quote stops at its recorded time')
})

test('adjacent UTC daily closes join for both long ranges and a missing day splits the line', () => {
  const day = 86_400
  for (const days of [7, 30]) {
    const frame = renderFloorChart({ from, to: from + days * day, interval: day,
      points: [1, 2, 4].map((offset, index) => ({ time: from + offset * day, price: [4, 6, 5][index] })) })
    const runs = bands(frame)
    assert.equal(runs.length, 2)
    assert.ok(runs[0].bottom - runs[0].top > 80)
    assert.ok(runs[1].right - runs[1].left <= 4)
    assert.ok(runs[1].right < width - 70)
  }
})

test('a single observation is a point and a flat run stays level only over the observed interval', () => {
  const [dot] = bands(renderFloorChart(series([[6, 3.5]])))
  assert.ok(dot.right - dot.left <= 4 && dot.bottom - dot.top <= 4)
  assert.ok(centerX(dot) > 105 && centerX(dot) < 150)
  assert.ok(centerY(dot) > 45 && centerY(dot) < 83)
  const flat = bands(renderFloorChart(series([[4, 3.5], [5, 3.5], [6, 3.5]])))
  assert.equal(flat.length, 1)
  assert.ok(flat[0].right - flat[0].left > 25)
  assert.equal(flat[0].top, flat[0].bottom)
  assert.equal(centerY(flat[0]), centerY(dot))
})

test('keeps tiny nonzero price changes proportionate and retains a real one-bucket spike', () => {
  const [nearFlat] = bands(renderFloorChart(series([[3, 0.004], [4, 0.00400001], [5, 0.004]])))
  assert.ok(nearFlat.bottom - nearFlat.top <= 6)
  const frame = renderFloorChart(series([[0, 0.00000002], [1, 10000], [2, 0.00000003], [3, 0.00000001], [4, 1]]))
  const extrema = bands(frame, 255)
  assert.equal(extrema.length, 2)
  assert.ok(extrema[0].top < 20 && extrema[1].bottom > 100)
  assert.ok(extrema[0].right < extrema[1].left)
})

test('ignores out-of-window and invalid samples without letting them change the price scale', () => {
  const expected = series([[1, 2], [2, 4], [7, 8]])
  const unordered = series([[7, 8], [2, 3000], [2.1, 1000], [-1, 500], [12, 800], [2, 4], [1, 2]])
  unordered.points.push(null, { time: from * 1000, price: 9000 }, { time: from + 2 * interval, price: -1 })
  Object.freeze(unordered.points)
  assert.deepEqual(renderFloorChart(unordered), renderFloorChart(expected))
})

test('UTC endpoint labels follow the window while the same relative observations retain their shape', () => {
  const first = series([[1, 4], [2, 5], [4, 3]])
  const shift = 86_400
  const later = { ...first, from: first.from + shift, to: first.to + shift,
    points: first.points.map(p => ({ ...p, time: p.time + shift })) }
  const a = renderFloorChart(first), b = renderFloorChart(later)
  assert.deepEqual(bands(a), bands(b))
  assert.notDeepEqual(a.subarray(130 * width), b.subarray(130 * width))
})
