export type HeadGestureKind = 'nod' | 'shake'

export interface ImuSample {
  x?: number
  y?: number
  z?: number
}

export interface ImuGestureClassifierOptions {
  /** Minimum pitch delta on Y axis to count as a nod lobe (default 4.2). */
  nodThreshold?: number
  /** Minimum yaw delta on Z axis to count as a head-shake reversal (default 4.2). */
  shakeThreshold?: number
  /** Cooldown window in ms after a recognized gesture fires (default 1400ms). */
  cooldownMs?: number
  /** Max window in ms for completing a nod return or shake reversal (default 950ms). */
  gestureWindowMs?: number
  now?: () => number
}

/**
 * Lightweight, hysteresis-debounced head-gesture detector for Even Realities G2
 * `OsEventTypeList.IMU_DATA_REPORT` (`IMU_Report_Data { x, y, z }`).
 *
 * Designed strictly for transient alert overlays (such as `LIVE /ASK` heads-up
 * interrupts):
 *  - Head nod (down-and-return pitch pulse along Y while Z stays calm) -> 'nod' (accept / open reply)
 *  - Head shake (left-right yaw reversal along Z while Y stays calm)   -> 'shake' (dismiss / snooze)
 */
export function createImuGestureClassifier(options: ImuGestureClassifierOptions = {}) {
  const nodThreshold = options.nodThreshold ?? 4.2
  const shakeThreshold = options.shakeThreshold ?? 4.2
  const cooldownMs = options.cooldownMs ?? 1_400
  const gestureWindowMs = options.gestureWindowMs ?? 950
  const now = options.now ?? (() => Date.now())

  let baselineY: number | null = null
  let baselineZ: number | null = null
  let nodPeakSign = 0
  let nodPeakAt = 0
  let shakeFirstSign = 0
  let shakeFirstAt = 0
  let lastGestureAt = -Infinity

  function reset() {
    baselineY = null
    baselineZ = null
    nodPeakSign = 0
    nodPeakAt = 0
    shakeFirstSign = 0
    shakeFirstAt = 0
  }

  function push(sample: ImuSample | undefined | null): HeadGestureKind | null {
    if (!sample) return null
    if (
      typeof sample.y !== 'number'
      || !Number.isFinite(sample.y)
      || typeof sample.z !== 'number'
      || !Number.isFinite(sample.z)
    ) {
      return null
    }
    const y = sample.y
    const z = sample.z
    const ts = now()

    if (ts - lastGestureAt < cooldownMs) {
      return null
    }

    if (baselineY === null || baselineZ === null) {
      baselineY = y
      baselineZ = z
      return null
    }

    const dy = y - baselineY
    const dz = z - baselineZ

    // Slowly adapt baseline during calm intervals
    if (Math.abs(dy) < nodThreshold * 0.45) baselineY = baselineY * 0.9 + y * 0.1
    if (Math.abs(dz) < shakeThreshold * 0.45) baselineZ = baselineZ * 0.9 + z * 0.1

    // Expire partial gestures outside window
    if (nodPeakSign !== 0 && ts - nodPeakAt > gestureWindowMs) {
      nodPeakSign = 0
    }
    if (shakeFirstSign !== 0 && ts - shakeFirstAt > gestureWindowMs) {
      shakeFirstSign = 0
    }

    // 1. Check Head Shake (alternating Z lobes: +Z -> -Z or -Z -> +Z while pitch is bounded)
    if (Math.abs(dz) >= shakeThreshold && Math.abs(dy) < nodThreshold * 0.85) {
      const sign = dz > 0 ? 1 : -1
      if (shakeFirstSign === 0) {
        shakeFirstSign = sign
        shakeFirstAt = ts
      } else if (shakeFirstSign === -sign && ts - shakeFirstAt <= gestureWindowMs) {
        lastGestureAt = ts
        reset()
        return 'shake'
      }
      return null
    }

    // 2. Check Head Nod (pronounced Y pitch excursion followed by return past neutral or opposite lobe)
    if (Math.abs(dy) >= nodThreshold && Math.abs(dz) < shakeThreshold * 0.85) {
      const sign = dy > 0 ? 1 : -1
      if (nodPeakSign === 0) {
        nodPeakSign = sign
        nodPeakAt = ts
      } else if (nodPeakSign === -sign && ts - nodPeakAt <= gestureWindowMs) {
        lastGestureAt = ts
        reset()
        return 'nod'
      }
      return null
    }

    if (
      nodPeakSign !== 0
      && ts - nodPeakAt >= 60
      && ts - nodPeakAt <= gestureWindowMs
      && Math.abs(dy) <= nodThreshold * 0.25
      && Math.abs(dz) < shakeThreshold * 0.6
    ) {
      lastGestureAt = ts
      reset()
      return 'nod'
    }

    return null
  }

  return { push, reset }
}
