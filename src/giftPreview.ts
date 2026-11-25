import { resolveDeepLinkMatchKey } from './lib/deepLinkMatchKey.ts'
import { renderAlgorithmCup } from './algorithmCup.ts'

export interface GiftPreview {
  kind: 'relief' | 'model'
  angles: readonly number[]
  initialIndex: number
  /** One owned 256 × 144 plane, in row order, with luminance levels 0, 17, …, 255. */
  render(index: number): Uint8Array
}

const width = 256
const height = 144
const reliefAngles = Object.freeze([-50, -25, 0, 25, 50])
const modelAngles = Object.freeze([0, 45, 90, 135, 180, 225, 270, 315])

function preview(kind: GiftPreview['kind'], angles: readonly number[], draw: (angle: number) => Uint8Array): GiftPreview | null {
  const frames: Uint8Array[] = []
  function pixels(i: number) {
    const cached = frames[i]
    if (cached) return cached
    const frame = draw(angles[i]!)
    for (let p = 0; p < frame.length; p++) frame[p] = 17 * Math.round(frame[p]! / 17)
    frames[i] = frame
    return frame
  }
  let initialIndex = angles.indexOf(0)
  if (kind === 'relief' && !pixels(initialIndex).some(Boolean)) {
    initialIndex = angles.findIndex((_, i) => pixels(i).some(Boolean))
    if (initialIndex < 0) return null
  }
  return {
    kind,
    angles,
    initialIndex,
    render(index) {
      const step = Number.isFinite(index) ? Math.trunc(index) : initialIndex
      const i =
        kind === 'model'
          ? ((step % angles.length) + angles.length) % angles.length
          : Math.min(angles.length - 1, Math.max(0, step))
      return pixels(i).slice()
    },
  }
}

interface ArtworkPixels {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

interface Bounds { left: number; top: number; right: number; bottom: number }
const firstLitAlpha = 9

function alphaBounds(image: ArtworkPixels, minimum = 1): Bounds | null {
  let left = image.width, top = image.height, right = 0, bottom = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! < minimum) continue
      left = Math.min(left, x)
      right = Math.max(right, x + 1)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y + 1)
    }
  }
  return right > left ? { left, top, right, bottom } : null
}

function faintPadding(all: Bounds, core: Bounds) {
  return all.right - all.left > 2 * (core.right - core.left) || all.bottom - all.top > 2 * (core.bottom - core.top)
}

function frameBounds(all: Bounds, core: Bounds | null): Bounds {
  if (!core || !faintPadding(all, core)) return all
  const pad = Math.ceil(Math.max((core.right - core.left) / (width - 20), (core.bottom - core.top) / (height - 16)))
  return {
    left: Math.max(all.left, core.left - pad),
    right: Math.min(all.right, core.right + pad),
    top: Math.max(all.top, core.top - pad),
    bottom: Math.min(all.bottom, core.bottom + pad),
  }
}

export function createReliefPreview(image: ArtworkPixels): GiftPreview | null {
  if (
    !Number.isSafeInteger(image.width)
    || !Number.isSafeInteger(image.height)
    || image.width <= 0
    || image.height <= 0
    || image.data.length !== image.width * image.height * 4
  ) {
    return null
  }
  const all = alphaBounds(image)
  if (!all) return null
  const bounds = frameBounds(all, alphaBounds(image, firstLitAlpha))
  const sourceWidth = bounds.right - bounds.left, sourceHeight = bounds.bottom - bounds.top
  const fit = Math.min((width - 20) / sourceWidth, (height - 16) / sourceHeight)
  const w = Math.max(1, Math.round(sourceWidth * fit)), h = Math.max(1, Math.round(sourceHeight * fit))
  const stride = w + 2, size = stride * (h + 2)
  const alpha = new Float32Array(size), tone = new Float32Array(size), surface = new Float32Array(size)
  const span = new Uint16Array(size)
  const dx = sourceWidth / w, dy = sourceHeight / h
  const halfX = Math.max(1, dx) / 2, halfY = Math.max(1, dy) / 2

  for (let y = 0; y < h; y++) {
    const cy = bounds.top + (y + 0.5) * dy
    const y0 = Math.max(bounds.top, cy - halfY), y1 = Math.min(bounds.bottom, cy + halfY)
    for (let x = 0; x < w; x++) {
      const cx = bounds.left + (x + 0.5) * dx
      const x0 = Math.max(bounds.left, cx - halfX), x1 = Math.min(bounds.right, cx + halfX)
      let coverage = 0, luminance = 0
      for (let sy = Math.floor(y0); sy < y1; sy++) {
        const overlapY = Math.min(sy + 1, y1) - Math.max(sy, y0)
        for (let sx = Math.floor(x0); sx < x1; sx++) {
          const p = (sy * image.width + sx) * 4
          const weight = (Math.min(sx + 1, x1) - Math.max(sx, x0)) * overlapY * image.data[p + 3]!
          coverage += weight
          luminance += weight * (0.2126 * image.data[p]! + 0.7152 * image.data[p + 1]! + 0.0722 * image.data[p + 2]!)
        }
      }
      if (coverage === 0) continue
      const i = (y + 1) * stride + x + 1
      alpha[i] = coverage / (255 * (x1 - x0) * (y1 - y0))
      const gray = luminance / coverage
      tone[i] = gray * (1 + 0.25 * (1 - gray / 255))
      span[i] = span[i - 1] || x + 1
      surface[i] = 1 + Math.min(surface[i - 1]!, surface[i - stride]!)
    }
  }

  for (let y = h; y > 0; y--) {
    for (let x = w; x > 0; x--) {
      const i = y * stride + x
      surface[i] = Math.min(surface[i]!, 1 + surface[i + 1]!, 1 + surface[i + stride]!)
    }
  }
  const depth = Math.min(10, Math.max(2, 0.08 * Math.min(w, h)))
  for (let i = stride; i < size - stride; i++) {
    if (!alpha[i]) continue
    const bevel = Math.min(1, surface[i]! / (depth + 1))
    const localTone = (2 * tone[i]! + tone[i - 1]! + tone[i + 1]! + tone[i - stride]! + tone[i + stride]!) / 6
    surface[i] = depth * (0.14 + bevel * (0.32 + 0.54 * localTone / 255))
  }

  return preview('relief', reliefAngles, angle => {
    const frame = new Uint8Array(width * height)
    const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
    const lightX = -0.45 * cos - 0.8 * sin, lightZ = -0.45 * sin + 0.8 * cos
    const face = new Float32Array(size)
    const left = Math.floor((width - w) / 2), top = Math.floor((height - h) / 2)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y + 1) * stride + x + 1
        if (!alpha[i]) continue
        const nx = (surface[i - 1]! - surface[i + 1]!) / 2
        const ny = (surface[i - stride]! - surface[i + stride]!) / 2
        const diffuse = (nx * lightX - ny * 0.4 + lightZ) / Math.sqrt(1 + nx * nx + ny * ny)
        face[i] = Math.min(255, tone[i]! * (0.64 + 0.45 * Math.max(0, diffuse)))
        if (angle === 0) frame[(top + y) * width + left + x] = Math.round(alpha[i]! * face[i]!)
      }
    }
    if (angle === 0) return frame

    const back = -0.55 * depth, layers = Math.ceil((depth - back) / 0.6), dz = (depth - back) / layers
    const wallLight = 0.36 + 0.22 * Math.max(0, -Math.sign(sin) * lightX)
    const center = left + w / 2
    const halfSpan = (w + 1) * cos / 2 + depth * Math.abs(sin) + 1
    const first = Math.max(0, Math.floor(center - halfSpan)), last = Math.min(width, Math.ceil(center + halfSpan))
    for (let y = 0; y < h; y++) {
      const row = (y + 1) * stride
      for (let x = first; x < last; x++) {
        const projected = (x + 0.5 - center) / cos + (w + 1) / 2
        let remaining = 1, previousSpan = 0, spanCoverage = 0, light = 0
        for (let layer = 0; layer <= layers; layer++) {
          const z = depth - layer * dz, u = projected - z * sin / cos
          if (u < 0 || u >= w + 1) continue
          const column = Math.floor(u), i = row + column, t = u - column
          const a = (1 - t) * alpha[i]!, b = t * alpha[i + 1]!, opacity = a + b
          const front = opacity > 0 ? (a * surface[i]! + b * surface[i + 1]!) / opacity : 0
          const hit = opacity > 0 && z <= front ? span[i] || span[i + 1]! : 0
          if (hit !== previousSpan) {
            remaining *= 1 - spanCoverage
            previousSpan = hit
            spanCoverage = 0
          }
          if (!hit || opacity <= spanCoverage) continue
          const material =
            front - z < 1.4 * dz
              ? (a * face[i]! + b * face[i + 1]!) / opacity
              : wallLight * (a * tone[i]! + b * tone[i + 1]!) / opacity
          light += remaining * (opacity - spanCoverage) * material
          spanCoverage = opacity
          if (remaining * (1 - spanCoverage) < 0.0001) break
        }
        frame[(top + y) * width + x] = Math.round(light)
      }
    }
    return frame
  })
}

async function decodeArtwork(blob: Blob, signal?: AbortSignal): Promise<GiftPreview | null> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    signal?.throwIfAborted()
    const sourceWidth = image.naturalWidth, sourceHeight = image.naturalHeight
    if (!sourceWidth || !sourceHeight) return null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const limit = 768
    const read = (x: number, y: number, w: number, h: number) => {
      const scale = Math.min(1, limit / Math.max(w, h))
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height)
      return ctx.getImageData(0, 0, canvas.width, canvas.height)
    }
    if (sourceWidth <= limit && sourceHeight <= limit) return createReliefPreview(read(0, 0, sourceWidth, sourceHeight))

    const all = { left: sourceWidth, top: sourceHeight, right: 0, bottom: 0 }
    const visible = { ...all }
    function include(box: Bounds, part: Bounds | null, x: number, y: number) {
      if (!part) return
      box.left = Math.min(box.left, x + part.left)
      box.right = Math.max(box.right, x + part.right)
      box.top = Math.min(box.top, y + part.top)
      box.bottom = Math.max(box.bottom, y + part.bottom)
    }
    let batchStart = performance.now()
    for (let y = 0; y < sourceHeight; y += limit) {
      for (let x = 0; x < sourceWidth; x += limit) {
        const tile = read(x, y, Math.min(limit, sourceWidth - x), Math.min(limit, sourceHeight - y))
        const part = alphaBounds(tile)
        if (part) {
          include(all, part, x, y)
          include(visible, alphaBounds(tile, firstLitAlpha), x, y)
        }
        if (performance.now() - batchStart > 16) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          signal?.throwIfAborted()
          batchStart = performance.now()
        }
      }
    }
    if (all.right <= all.left) return null
    const bounds = frameBounds(all, visible.right > visible.left ? visible : null)
    signal?.throwIfAborted()
    return createReliefPreview(read(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function createGiftPreview(
  name: string,
  loadArtwork: (name: string) => Promise<Blob | null>,
  allowFullModel = true,
  signal?: AbortSignal,
): Promise<GiftPreview | null> {
  signal?.throwIfAborted()
  if (allowFullModel && resolveDeepLinkMatchKey(name) === 'algorithmcup') {
    return preview('model', modelAngles, angle => renderAlgorithmCup(angle, width, height))
  }
  const blob = await loadArtwork(name)
  signal?.throwIfAborted()
  return blob?.size ? decodeArtwork(blob, signal) : null
}
