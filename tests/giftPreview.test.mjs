import assert from 'node:assert/strict'
import { resolveObjectURL } from 'node:buffer'
import test from 'node:test'
import { createGiftPreview, createReliefPreview } from '../src/giftPreview.ts'
import { createInspector } from '../src/inspection.ts'

const W = 256, H = 144
const clear = [0, 0, 0, 0]
function artwork(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(color(x, y), 4 * (y * width + x))
  }
  return { width, height, data }
}
function gray(luminance, alpha = 255) { return [luminance, luminance, luminance, alpha] }
function bounds(frame) {
  let left = W, right = -1, top = H, bottom = -1
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!frame[y * W + x]) continue
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  }
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 }
}
function spans(frame, y) {
  const result = []
  let start = -1
  for (let x = 0; x <= W; x++) {
    if (x < W && frame[y * W + x]) {
      if (start === -1) start = x
    } else if (start !== -1) {
      result.push({ left: start, right: x - 1, width: x - start })
      start = -1
    }
  }
  return result
}
function checkFrame(frame) {
  assert.ok(frame instanceof Uint8Array)
  assert.equal(frame.byteLength, W * H)
  assert.ok(frame.every(v => v % 17 === 0))
  const box = bounds(frame)
  assert.ok(box.width > 0 && box.height > 0)
  assert.ok(box.left >= 4 && box.top >= 4 && box.right < W - 4 && box.bottom < H - 4)
  return box
}
function changedPixels(a, b, x0 = 0, y0 = 0, x1 = W, y1 = H) {
  let changes = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (a[y * W + x] !== b[y * W + x]) changes++
  }
  return changes
}

test('the relief fits opaque content, retains the illustrated side and leaves a cutout open at every tilt', () => {
  function ring(x, y) {
    if (x >= 72 || y >= 56 || (x >= 24 && x < 50 && y >= 18 && y < 38)) return clear
    return x < 22 ? [245, 220, 90, 255] : gray(88)
  }
  const tight = createReliefPreview(artwork(72, 56, ring))
  const padded = createReliefPreview(artwork(120, 90, (x, y) => x < 12 || y < 10 ? clear : ring(x - 12, y - 10)))
  assert.equal(padded.kind, 'relief')
  assert.deepEqual(padded.angles, [-50, -25, 0, 25, 50])
  assert.equal(padded.angles[padded.initialIndex], 0)
  const frames = padded.angles.map((_, i) => padded.render(i))
  for (const [i, frame] of frames.entries()) {
    checkFrame(frame)
    assert.deepEqual(frame, tight.render(i))
    const [left, right, ...extra] = spans(frame, 72)
    assert.equal(extra.length, 0)
    assert.ok(left.right < 128 && right.left > 128)
    assert.ok(frame[72 * W + left.left + Math.floor(left.width / 2)] > frame[72 * W + right.left + Math.floor(right.width / 2)])
    if (i > 0) assert.ok(changedPixels(frames[i - 1], frame) > 500)
  }
  const front = bounds(frames[padded.initialIndex])
  assert.ok(Math.abs(front.width / front.height - 72 / 56) < 0.02)
  assert.ok(Math.abs(front.left + front.right - (W - 1)) <= 1)
  assert.ok(Math.abs(front.top + front.bottom - (H - 1)) <= 1)
})

test('the rim has thickness and an interior painted highlight moves relative to the same mark at the lip', () => {
  const gift = createReliefPreview(artwork(128, 128, x => gray(x >= 64 && x < 72 ? 255 : 40)))
  function highlightX(frame, y) {
    let total = 0, weightedX = 0
    for (let x = 0; x < W; x++) {
      const weight = Math.max(0, frame[y * W + x] - 100)
      total += weight
      weightedX += weight * x
    }
    assert.ok(total > 0)
    return weightedX / total
  }
  const [left, front, right] = [0, 2, 4].map(i => gift.render(i))
  const offset = frame => highlightX(frame, 72) - highlightX(frame, 10)
  assert.ok(Math.abs(offset(front)) < 1)
  assert.ok(offset(left) < -2 && offset(right) > 2)
  const flatWidth = bounds(front).width * Math.cos(50 * Math.PI / 180)
  for (const frame of [left, right]) assert.ok(bounds(frame).width > flatWidth + 3)
})

test('alpha scales emitted light once and transparent RGB cannot bleed into the tilted walls', () => {
  const swatch = (alpha, hidden) => artwork(57, 45, (x, y) => {
    if ((x - 27) ** 2 + (y - 22) ** 2 > 22 ** 2 || (x - 22) ** 2 + (y - 22) ** 2 < 9 ** 2) return hidden
    return gray(210, alpha)
  })
  const solid = createReliefPreview(swatch(255, clear))
  const part = createReliefPreview(swatch(96, clear))
  const poisoned = createReliefPreview(swatch(96, [255, 255, 255, 0]))
  for (const [i] of solid.angles.entries()) {
    const opaque = solid.render(i), translucent = part.render(i)
    assert.ok(translucent.some(v => v > 0))
    assert.ok(translucent.every((v, p) => Math.abs(v - opaque[p] * 96 / 255) <= 17))
    assert.deepEqual(translucent, poisoned.render(i))
  }
})

// Black alignment bars keep all the strip fixtures in identical object coordinates.
function strips(left, right, alpha, leftTone = 200, rightTone = 250) {
  return createReliefPreview(artwork(128, 128, (x, y) => {
    if (y === 0 || y === 127) return gray(0)
    if (left && x >= 45 && x <= 60) return gray(leftTone, alpha)
    if (right && x >= 64 && x <= 81) return gray(rightTone, alpha)
    return clear
  }))
}

test('disjoint translucent strips composite front to back when their projected walls overlap', () => {
  const left = strips(true, false, 128), right = strips(false, true, 128), both = strips(true, true, 128)
  for (const i of [0, 4]) {
    const near = (i === 0 ? right : left).render(i)
    const far = (i === 0 ? left : right).render(i)
    const composite = both.render(i)
    let overlap = 0
    for (let x = 0; x < W; x++) {
      const p = 72 * W + x
      if (near[p] < 51 || far[p] < 51) continue
      overlap++
      assert.ok(Math.abs(composite[p] - (near[p] + 0.5 * far[p])) <= 12)
      assert.ok(composite[p] > Math.max(near[p], far[p]))
    }
    assert.ok(overlap >= 2)
  }
})

test('opaque black stays off, and a relief is available exactly when a view can light the display', () => {
  for (const color of [gray(0), gray(1), gray(255, 1)]) {
    assert.equal(createReliefPreview(artwork(16, 16, () => color)), null)
  }
  const band = createReliefPreview(artwork(96, 32, x => gray(x >= 32 && x < 64 ? 0 : 180)))
  for (const [i] of band.angles.entries()) {
    const f = band.render(i)
    assert.equal(f[72 * W + 128], 0)
    assert.ok(f[72 * W + 80] >= 85)
  }
  const faint = strips(true, true, 7, 255, 255)
  assert.equal(faint.render(faint.angles.indexOf(0)).some(Boolean), false)
  assert.ok(faint.render(faint.initialIndex).some(Boolean))
})

test('downsampling averages thin detail and maps source colors to sixteen luminance levels', () => {
  const smooth = createReliefPreview(artwork(512, 128, x => gray(x / 2)))
  const gradient = smooth.render(smooth.initialIndex)
  checkFrame(gradient)
  assert.equal(new Set(gradient).size, 16)
  const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]
  const bands = createReliefPreview(artwork(96, 32, x => colors[Math.floor(x / 32)]))
  const frame = bands.render(bands.initialIndex)
  const [red, green, blue] = [48, 128, 208].map(x => frame[72 * W + x])
  assert.ok(green > red && red > blue && blue > 0)
  const stripes = createReliefPreview(artwork(944, 128, x => x % 2 ? gray(255) : clear))
  const averaged = stripes.render(stripes.initialIndex)[72 * W + 128]
  assert.ok(averaged >= 119 && averaged <= 136)
})

test('detached tips on unusually wide and tall gifts survive framing and rotation', () => {
  for (const [w, h] of [[400, 18], [18, 400]]) {
    const gift = createReliefPreview(artwork(w, h, (x, y) => {
      const axis = w > h ? x : y
      return axis < 12 || axis >= 388 ? gray(240) : clear
    }))
    for (const [i] of gift.angles.entries()) {
      const frame = gift.render(i), box = checkFrame(frame)
      if (w > h) {
        assert.ok(box.width > 135 && box.height < 15)
        assert.equal(spans(frame, 72).length, 2)
      } else {
        assert.ok(box.height >= 120 && box.width < 16)
        assert.equal(spans(frame, 72).length, 0)
      }
    }
  }
})

test('the authored cup turns through eight distinct views with hollow handles, a narrow stem, and a front-only badge', async () => {
  let requests = 0
  const cup = await createGiftPreview('Algorithm Cup', async () => { requests++; return null })
  assert.equal(requests, 0)
  assert.equal(cup.kind, 'model')
  assert.deepEqual(cup.angles, [0, 45, 90, 135, 180, 225, 270, 315])
  assert.equal(cup.initialIndex, 0)
  const frames = cup.angles.map((_, i) => cup.render(i))
  for (const [i, frame] of frames.entries()) {
    const box = checkFrame(frame)
    assert.ok(box.height >= 120 && new Set(frame).size >= 12)
    for (let j = 0; j < i; j++) assert.ok(changedPixels(frame, frames[j]) > 100)
  }
  const [front, , side, , rear] = frames
  assert.equal(spans(front, 38).length, 3)
  assert.equal(spans(rear, 38).length, 3)
  assert.equal(spans(side, 38).length, 1)
  assert.ok(bounds(side).width < bounds(front).width * 0.75)
  assert.ok(spans(front, 122)[0].width > 3 * spans(front, 95)[0].width)
  assert.ok(changedPixels(front, rear, 114, 40, 142, 70) > 160)
  assert.ok(changedPixels(front, rear, 98, 92, 158, 138) < 10)
})

test('the enamel badge faces forward and turns right at positive yaw, with persistent vertical flutes on the bare bowl', async () => {
  const cup = await createGiftPreview('Algorithm Cup', async () => null)
  const front = cup.render(0), rear = cup.render(4)
  const rowMean = (f, x, y, n) => f.subarray(y * W + x, y * W + x + n).reduce((sum, v) => sum + v, 0) / n
  // Bright upper rim over dark enamel. The back shows uninterrupted bowl metal here.
  assert.ok(rowMean(front, 122, 44, 12) > rowMean(rear, 122, 44, 12) + 65)
  assert.ok(rowMean(front, 122, 47, 12) < rowMean(rear, 122, 47, 12) - 55)
  function badgeCenter(view, bare) {
    let weight = 0, moment = 0
    for (let y = 32; y < 70; y++) {
      for (let x = 84; x < 172; x++) {
        const contrast = Math.abs(view[y * W + x] - bare[y * W + x])
        if (contrast < 34) continue
        weight += contrast
        moment += x * contrast
      }
    }
    assert.ok(weight > 1000)
    return moment / weight
  }
  assert.ok(Math.abs(badgeCenter(front, rear) - W / 2) < 2)
  assert.ok(badgeCenter(cup.render(1), cup.render(5)) > W / 2 + 15)
  assert.ok(badgeCenter(cup.render(7), cup.render(3)) < W / 2 - 15)
  // Two ridges separated by valleys persist from the shoulder down the tapered bowl.
  for (const y of [39, 48, 54]) {
    const row = x => rowMean(rear, x - 1, y, 3)
    assert.ok(row(124) >= row(116) + 23 && row(124) >= row(133) + 23)
    assert.ok(row(140) >= row(133) + 23 && row(140) >= row(149) + 23)
  }
})

test('model rotation wraps, relief rotation stops at the illustrated limits, and callers own their frame bytes', async () => {
  const cup = await createGiftPreview('AlgorithmCup', async () => null)
  const relief = createReliefPreview(artwork(2, 3, () => gray(180)))
  assert.deepEqual(cup.render(-1), cup.render(7))
  assert.deepEqual(cup.render(8), cup.render(0))
  assert.deepEqual(relief.render(-1), relief.render(0))
  assert.deepEqual(relief.render(5), relief.render(4))
  for (const gift of [relief, cup]) {
    const pixels = gift.render(gift.initialIndex)
    pixels.fill(0)
    assert.ok(gift.render(gift.initialIndex).some(Boolean))
  }
})

// The padded fixtures use integer reduction ratios. This box filter actually
// resizes premultiplied pixels so detail lost during discovery cannot reappear by accident.
function drawRegion(source, stride, sx, sy, sw, sh, w, h) {
  const dx = sw / w, dy = sh / h, data = new Uint8ClampedArray(w * h * 4)
  assert.ok(Number.isInteger(dx) && Number.isInteger(dy))
  for (let y = 0; y < h; y++) {
    const start = 4 * ((sy + y * dy) * stride + sx)
    if (dx === 1 && dy === 1) {
      data.set(source.subarray(start, start + w * 4), y * w * 4)
      continue
    }
    for (let x = 0; x < w; x++) {
      let a = 0, r = 0, g = 0, b = 0
      for (let v = 0; v < dy; v++) {
        for (let u = 0; u < dx; u++) {
          const from = start + 4 * (v * stride + x * dx + u), opacity = source[from + 3]
          a += opacity
          r += source[from] * opacity
          g += source[from + 1] * opacity
          b += source[from + 2] * opacity
        }
      }
      if (a) data.set([r / a, g / a, b / a, a / (dx * dy)], 4 * (y * w + x))
    }
  }
  return { width: w, height: h, data }
}

// Object URLs carry RGBA blobs across the simulated WebView decode boundary.
function installCanvas(t, w, h) {
  const urls = [], draws = []
  function replace(key, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true })
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key))
  }
  replace('Image', class {
    naturalWidth = w
    naturalHeight = h
    async decode() {
      urls.push(this.src)
      const bytes = await resolveObjectURL(this.src).arrayBuffer()
      if (bytes.byteLength !== w * h * 4) throw new Error('Unreadable fixture')
      this.pixels = new Uint8ClampedArray(bytes)
    }
  })
  replace('document', { createElement(element) {
    assert.equal(element, 'canvas')
    let drawn
    const canvas = { getContext(kind) {
      assert.equal(kind, '2d')
      return {
        drawImage(image, sx, sy, sw, sh, x, y, width, height) {
          assert.deepEqual([x, y, width, height], [0, 0, canvas.width, canvas.height])
          drawn = drawRegion(image.pixels, w, sx, sy, sw, sh, width, height)
          draws.push({ sx, sy, sw, sh, drawn })
        },
        getImageData(...rect) {
          assert.deepEqual(rect, [0, 0, canvas.width, canvas.height])
          return drawn
        },
      }
    } }
    return canvas
  } })
  return { urls, draws }
}

test('named Algorithm Cup variants and ordinary gifts render the pixels selected by their own loaders', async t => {
  const { urls } = installCanvas(t, 48, 32)
  const calls = []
  const targets = [
    ['Algorithm Cup', false, artwork(48, 32, x => x < 24 ? gray(225) : gray(32))],
    ['Plush Pepe', true, artwork(48, 32, (_, y) => y < 16 ? gray(80) : gray(245))],
  ]
  for (const [name, allowFullModel, source] of targets) {
    const gift = await createGiftPreview(name, async key => {
      calls.push(key)
      return new Blob([source.data])
    }, allowFullModel)
    assert.equal(gift.kind, 'relief')
    const expected = createReliefPreview(source)
    for (const [i] of gift.angles.entries()) assert.deepEqual(gift.render(i), expected.render(i))
  }
  assert.deepEqual(calls, ['Algorithm Cup', 'Plush Pepe'])
  assert.equal(urls.length, 2)
  assert.ok(urls.every(url => resolveObjectURL(url) === undefined))
})

test('missing or transparent artwork yields no preview, while load and decode errors propagate', async t => {
  const { urls } = installCanvas(t, 8, 8)
  assert.equal(await createGiftPreview('Missing', async () => null), null)
  assert.equal(await createGiftPreview('Algorithm Cup', async () => null, false), null)
  await assert.rejects(createGiftPreview('Offline', async () => { throw new Error('offline') }), /offline/)
  assert.equal(await createGiftPreview('Empty', async () => new Blob([])), null)
  await assert.rejects(createGiftPreview('Truncated', async () => new Blob(['bad image'])), /Unreadable fixture/)
  assert.equal(await createGiftPreview('Invisible', async () => new Blob([new Uint8Array(8 * 8 * 4)])), null)
  assert.equal(urls.length, 2)
  assert.ok(urls.every(url => resolveObjectURL(url) === undefined))
})

test('a tiny illustration on a huge padded image is redrawn from its original cutouts and painted details', async t => {
  const w = 6144, h = 128, { draws } = installCanvas(t, w, h)
  const mark = artwork(27, 23, (x, y) => {
    if ((x >= 6 && x < 10 && y >= 5 && y < 16) || (x >= 16 && x < 20 && y >= 3 && y < 12)) return clear
    return gray(x === 13 || y === 18 ? 245 : 75)
  })
  const source = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < mark.height; y++) {
    const row = mark.width * 4
    source.set(mark.data.subarray(y * row, (y + 1) * row), 4 * ((y + 43) * w + 4834))
  }
  const gift = await createGiftPreview('Padded', async () => new Blob([source]))
  const expected = createReliefPreview(mark)
  const probe = drawRegion(source, w, 0, 0, w, h, 768, 16)
  const blurred = createReliefPreview(probe)
  assert.ok(changedPixels(blurred.render(2), expected.render(2)) > 1000)
  assert.ok(draws.at(-1).sx > 0 && draws.at(-1).sw < 100)
  for (const [i] of expected.angles.entries()) assert.deepEqual(gift.render(i), expected.render(i))
})

test('a faint subpixel feature lost completely in the coarse resize is located at native resolution', async t => {
  const w = 6144, h = 32, { draws } = installCanvas(t, w, h)
  const data = new Uint8ClampedArray(w * h * 4)
  data.set(gray(255, 18), 4 * (19 * w + 5027))
  const gift = await createGiftPreview('Single pearl', async () => new Blob([data]))
  const probe = drawRegion(data, w, 0, 0, w, h, 768, 4)
  assert.ok(probe.data.every((v, i) => i % 4 !== 3 || v === 0))
  assert.ok(draws.every(d => d.drawn.width <= 768 && d.drawn.height <= 768))
  assert.deepEqual(gift.render(gift.initialIndex), createReliefPreview(artwork(1, 1, () => gray(255, 18))).render(2))
})

test('a visible block cannot hide a detached faint pearl from the native artwork crop', async t => {
  const w = 6144, h = 128, { draws } = installCanvas(t, w, h)
  const mark = artwork(20, 8, (x, y) => x < 8 ? gray(255) : x === 19 && y === 3 ? gray(255, 25) : clear)
  const source = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < mark.height; y++) {
    const row = mark.width * 4
    source.set(mark.data.subarray(y * row, (y + 1) * row), 4 * ((56 + y) * w + 760))
  }
  const coarse = drawRegion(source, w, 0, 0, w, h, 768, 16)
  assert.equal(coarse.data[4 * (7 * 768 + 95) + 3], 255)
  assert.equal(coarse.data[4 * (7 * 768 + 97) + 3], 0)
  const expected = createReliefPreview(mark)
  const gift = await createGiftPreview('Block and pearl', async () => new Blob([source]))
  const front = gift.render(gift.initialIndex)
  assert.ok(Array.from({ length: H }, (_, y) => spans(front, y)).some(row => row.length === 2), 'both features must light up')
  for (const [i] of expected.angles.entries()) assert.deepEqual(gift.render(i), expected.render(i))
  assert.ok(draws.every(d => d.drawn.width <= 768 && d.drawn.height <= 768))
})

test('closing a preview during a yielded artwork scan releases the image and skips the remaining tiles', { timeout: 2000 }, async t => {
  const w = 6144, h = 32, { draws, urls } = installCanvas(t, w, h)
  const released = Promise.withResolvers()
  const revoke = URL.revokeObjectURL.bind(URL)
  t.mock.method(URL, 'revokeObjectURL', url => { revoke(url); released.resolve(url) })
  const blob = new Blob([new Uint8Array(w * h * 4)])
  const { inspector, select } = createInspector({ initialRange: () => '24h', loadArtwork: async () => blob }, () => {})
  let time = 0
  t.mock.method(performance, 'now', () => {
    if (draws.length === 2) queueMicrotask(() => inspector.back())
    return time += 20
  })
  select('Padded pearl')
  inspector.show('preview')
  assert.equal(await released.promise, urls[0])
  assert.equal(resolveObjectURL(urls[0]), undefined)
  assert.equal(draws.length, 2, 'the scan must stop after the second native tile')
  assert.deepEqual(inspector.getSnapshot(), { mode: 'overview' })
})

test('near-invisible export padding leaves the real drawing large enough to resolve its hole', async t => {
  const w = 6144, h = 96, { draws } = installCanvas(t, w, h)
  const data = new Uint8ClampedArray(w * h * 4).fill(1)
  for (let y = 0; y < 19; y++) {
    for (let x = 0; x < 19; x++) {
      if (x < 5 || y < 5 || x > 13 || y > 13) data.set(gray(240), 4 * ((y + 47) * w + x + 3813))
    }
  }
  const gift = await createGiftPreview('Padded ring', async () => new Blob([data]))
  const front = gift.render(gift.initialIndex)
  assert.ok(draws.at(-1).sw < 30)
  assert.ok(checkFrame(front).height > 110)
  assert.equal(spans(front, 72).length, 2)
})
