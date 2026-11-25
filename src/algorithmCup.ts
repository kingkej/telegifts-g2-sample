// Original TeleGifts demo geometry, authored for this preview. The bowl, handles,
// foot and raised code badge form a complete mesh and can be viewed from any azimuth.
type Point = [x: number, y: number, z: number]
type XY = [x: number, y: number]
type Triangle = [a: number, b: number, c: number, tone: number]
type Profile = [y: number, radius: number, flute?: number, bandTone?: number]
const turn = 2 * Math.PI

function makeCup() {
  const points: Point[] = [], triangles: Triangle[] = []
  function vertex(x: number, y: number, z: number) {
    return points.push([x, y, z]) - 1
  }
  function stitch(a: number[], b: number[], tone: number) {
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length
      triangles.push([a[i]!, a[j]!, b[j]!, tone], [a[i]!, b[j]!, b[i]!, tone])
    }
  }
  function cap(ring: number[], center: number, tone: number) {
    for (let i = 0; i < ring.length; i++) {
      triangles.push([ring[i]!, ring[(i + 1) % ring.length]!, center, tone])
    }
  }
  function lathe(profile: Profile[], sides: number, tone: number, phase = 0) {
    let previous: number[] | undefined
    for (const [y, radius, flute = 0, bandTone = tone] of profile) {
      const ring = Array.from({ length: sides }, (_, i) => {
        const theta = turn * i / sides + phase
        const r = radius + flute * Math.cos(12 * theta)
        return vertex(r * Math.sin(theta), y, r * Math.cos(theta))
      })
      if (previous) stitch(previous, ring, bandTone)
      previous = ring
    }
  }

  // Octagonal stepped plinth and turned metal stem.
  lathe([[-60, 0], [-60, 25], [-57, 28], [-51, 28], [-49, 25, 0, 186],
    [-49, 23], [-43, 23], [-40, 20, 0, 165], [-40, 0]], 8, 117, Math.PI / 8)
  lathe([[-40, 0], [-40, 17], [-38, 18], [-35, 13], [-32, 8], [-28, 5],
    [-19, 4.5], [-16, 6], [-14, 9], [-11, 10], [-8, 8], [-8, 0]], 36, 216)

  // Follow the outer flutes over the rolled lip and down the darker inside wall.
  lathe([[-11, 0], [-11, 8], [-6, 15, 0.4], [3, 22, 1.0], [16, 29, 1.7],
    [34, 33.5, 1.6], [44, 34.5, 0.65], [45, 34.5], [46, 37, 0, 231],
    [50, 37, 0, 222], [52, 35, 0, 243], [52, 31, 0, 219], [49, 30.7, 0, 150],
    [44, 31.4, 0, 126], [34, 30, 0, 136], [16, 25, 0, 139], [4, 15, 0, 134], [0, 0, 0, 128]], 96, 202)

  // Sweep a round tube along two joined Bézier curves for each hollow handle.
  for (const side of [-1, 1]) {
    let previous: number[] | undefined
    function bend(a: XY, b: XY, c: XY, d: XY) {
      for (let i = previous ? 1 : 0; i <= 12; i++) {
        const t = i / 12, s = 1 - t
        const x = s ** 3 * a[0] + 3 * s * s * t * b[0] + 3 * s * t * t * c[0] + t ** 3 * d[0]
        const y = s ** 3 * a[1] + 3 * s * s * t * b[1] + 3 * s * t * t * c[1] + t ** 3 * d[1]
        const dx = s * s * (b[0] - a[0]) + 2 * s * t * (c[0] - b[0]) + t * t * (d[0] - c[0])
        const dy = s * s * (b[1] - a[1]) + 2 * s * t * (c[1] - b[1]) + t * t * (d[1] - c[1])
        const length = Math.hypot(dx, dy)
        const ring = Array.from({ length: 12 }, (_, j) => {
          const theta = turn * j / 12, offset = 3.4 * Math.cos(theta) / length
          return vertex(side * (x - offset * dy), y + offset * dx, 3.4 * Math.sin(theta))
        })
        if (previous) stitch(previous, ring, 214)
        else cap(ring, vertex(side * x, y, 0), 184)
        previous = ring
      }
    }
    bend([32, 39], [44, 48], [56, 51], [56, 37])
    bend([56, 37], [56, 22], [40, 0], [19, 0])
    cap(previous!, vertex(side * 19, 0, 0), 184)
  }

  // A beveled shield follows the bowl curvature on the front (+Z) only.
  function badgeVertex(x: number, y: number, relief: number) {
    return vertex(x, 24 + y, 33.7 + 0.28 * y - 0.014 * x * x + relief)
  }
  const shield: XY[] = [[-11, 6], [-8, 10], [8, 10], [11, 6], [9, -5], [0, -12], [-9, -5]]
  function badgeRing(scale: number, relief: number) {
    return shield.map(([x, y]) => badgeVertex(x * scale, y * scale, relief))
  }
  const backing = badgeRing(1, -3), rim = badgeRing(1, 1), enamel = badgeRing(0.85, 2)
  cap(backing, badgeVertex(0, 0, -3), 115)
  stitch(backing, rim, 163)
  stitch(rim, enamel, 239)
  cap(enamel, badgeVertex(0, 0, 2), 76)

  function raisedStroke(a: XY, b: XY) {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy)
    const x = -dy / length, y = dx / length
    const corners: XY[] = [[a[0] + x, a[1] + y], [b[0] + x, b[1] + y],
      [b[0] - x, b[1] - y], [a[0] - x, a[1] - y]]
    const foot = corners.map(([u, v]) => badgeVertex(u, v, 0.5))
    const top = corners.map(([u, v]) => badgeVertex(u, v, 3.1))
    stitch(foot, top, 148)
    triangles.push([foot[0]!, foot[2]!, foot[1]!, 148], [foot[2]!, foot[0]!, foot[3]!, 148])
    triangles.push([top[0]!, top[1]!, top[2]!, 248], [top[2]!, top[3]!, top[0]!, 248])
  }
  raisedStroke([-3.5, 3.6], [-7, 0])
  raisedStroke([-7, 0], [-3.5, -3.6])
  raisedStroke([3.5, 3.6], [7, 0])
  raisedStroke([7, 0], [3.5, -3.6])
  raisedStroke([-1.4, -4.4], [1.4, 4.4])
  return { points, triangles }
}

let mesh: ReturnType<typeof makeCup> | undefined

/** Orthographic, depth-tested software rendering of the locally authored Algorithm Cup. */
export function renderAlgorithmCup(angle: number, width: number, height: number): Uint8Array {
  mesh ??= makeCup()
  const w = width * 2, h = height * 2
  const scale = Math.min(w / 148, h / 138)
  const yaw = angle * Math.PI / 180, cos = Math.cos(yaw), sin = Math.sin(yaw)
  const pitch = 14 * Math.PI / 180, up = Math.cos(pitch), tilt = Math.sin(pitch)
  const points = mesh.points.map(([x, y, z]): Point => {
    const forward = z * cos - x * sin
    return [w / 2 + scale * (x * cos + z * sin), h / 2 - scale * (3 + y * up - forward * tilt),
      scale * (y * tilt + forward * up)]
  })
  const samples = new Uint8Array(w * h)
  const depth = new Float32Array(w * h).fill(-Infinity)
  for (const [ia, ib, ic, tone] of mesh.triangles) {
    const a = points[ia]!, b = points[ib]!, c = points[ic]!
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2]
    const cx = c[0] - a[0], cy = c[1] - a[1], cz = c[2] - a[2]
    const area = bx * cy - by * cx
    if (Math.abs(area) < 0.00001) continue
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz
    const normal = Math.sign(area) / Math.hypot(nx, ny, area)
    const diffuse = Math.max(0, normal * (-0.48 * nx - 0.63 * ny + 0.61 * area))
    const highlight = Math.max(0, normal * (-0.27 * nx - 0.35 * ny + 0.897 * area))
    const light = Math.min(255, Math.round(tone * (0.32 + 0.68 * diffuse) + 78 * highlight ** 20))
    const x0 = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0]) - 0.5))
    const x1 = Math.min(w - 1, Math.floor(Math.max(a[0], b[0], c[0]) - 0.5))
    const y0 = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) - 0.5))
    const y1 = Math.min(h - 1, Math.floor(Math.max(a[1], b[1], c[1]) - 0.5))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - a[0], dy = y + 0.5 - a[1]
        const u = (dx * cy - dy * cx) / area, v = (bx * dy - by * dx) / area
        if (u < 0 || v < 0 || u + v > 1) continue
        const z = a[2] + u * bz + v * cz, i = y * w + x
        if (z <= depth[i]!) continue
        depth[i] = z
        samples[i] = light
      }
    }
  }

  // Resolve four samples per output pixel before applying the G2 palette.
  const frame = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 2 * (y * w + x)
      frame[y * width + x] = Math.round((samples[i]! + samples[i + 1]! + samples[i + w]! + samples[i + w + 1]!) / 4)
    }
  }
  return frame
}
