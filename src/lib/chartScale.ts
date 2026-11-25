export type Scale = {
  (value: number): number
  domain: readonly [number, number]
  range: readonly [number, number]
  invert: (pixel: number) => number
}

export const linearScale = (
  domain: readonly [number, number],
  range: readonly [number, number],
): Scale => {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0 || 1

  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale
  scale.domain = domain
  scale.range = range
  scale.invert = (pixel: number) => d0 + ((pixel - r0) / (r1 - r0 || 1)) * span
  return scale
}

export const niceDomain = (
  min: number,
  max: number,
  tickCount = 4,
): [number, number] => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1
    return [min - pad, max + pad]
  }
  const raw = (max - min) / Math.max(1, tickCount)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const residual = raw / magnitude
  const step =
    (residual >= 5 ? 10 : residual >= 2.5 ? 5 : residual >= 1 ? 2.5 : 1) * magnitude
  return [Math.floor(min / step) * step, Math.ceil(max / step) * step]
}

export const ticks = (
  domain: readonly [number, number],
  count = 4,
): number[] => {
  const [min, max] = domain
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min]
  const step = (max - min) / count
  return Array.from({ length: count + 1 }, (_, i) => min + i * step)
}

export type Point = { x: number; y: number }

export const monotonePath = (points: readonly Point[]): string => {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`
  if (points.length === 2) {
    return `M${points[0]!.x},${points[0]!.y}L${points[1]!.x},${points[1]!.y}`
  }

  const n = points.length
  const dx: number[] = []
  const dy: number[] = []
  const slope: number[] = []

  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]!.x - points[i]!.x
    dy[i] = points[i + 1]!.y - points[i]!.y
    slope[i] = dx[i] === 0 ? 0 : dy[i]! / dx[i]!
  }

  const tangent: number[] = [slope[0]!]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1]! * slope[i]! <= 0) {
      tangent[i] = 0
    } else {
      tangent[i] = (slope[i - 1]! + slope[i]!) / 2
    }
  }
  tangent[n - 1] = slope[n - 2]!

  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0
      tangent[i + 1] = 0
      continue
    }
    const a = tangent[i]! / slope[i]!
    const b = tangent[i + 1]! / slope[i]!
    const h = Math.hypot(a, b)
    if (h > 3) {
      const t = 3 / h
      tangent[i] = t * a * slope[i]!
      tangent[i + 1] = t * b * slope[i]!
    }
  }

  let path = `M${points[0]!.x},${points[0]!.y}`
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i]! / 3
    path +=
      `C${points[i]!.x + third},${points[i]!.y + tangent[i]! * third}`
      + ` ${points[i + 1]!.x - third},${points[i + 1]!.y - tangent[i + 1]! * third}`
      + ` ${points[i + 1]!.x},${points[i + 1]!.y}`
  }
  return path
}

export const downsampleSparkline = (points: readonly number[], limit: number): number[] => {
  if (limit <= 0) return []
  if (points.length <= limit) return [...points]
  if (limit === 1) return [points[points.length - 1]!]
  if (limit === 2) return [points[0]!, points[points.length - 1]!]

  const interiorLimit = limit - 2
  const interiorLength = points.length - 2
  const bucketSize = interiorLength / interiorLimit
  const out: number[] = [points[0]!]
  for (let i = 0; i < interiorLimit; i++) {
    const start = 1 + Math.floor(i * bucketSize)
    const end = 1 + Math.min(interiorLength, Math.floor((i + 1) * bucketSize))
    if (end <= start) continue
    const slice = points.slice(start, end)
    const min = Math.min(...slice)
    const max = Math.max(...slice)
    const prev = out[out.length - 1] ?? slice[0]!
    out.push(Math.abs(max - prev) >= Math.abs(prev - min) ? max : min)
  }
  out.push(points[points.length - 1]!)
  return out
}

export const clampSparklineOutliers = (points: readonly number[]): number[] => {
  if (points.length < 8) return [...points]
  const sorted = [...points].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  const q1 = at(0.25)
  const q3 = at(0.75)
  const iqr = q3 - q1
  if (iqr <= 0) return [...points]
  const fence = iqr * 3
  const min = q1 - fence
  const max = q3 + fence
  return points.map(v => Math.min(max, Math.max(min, v)))
}
