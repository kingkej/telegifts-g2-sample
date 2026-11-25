import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { createInspector } from '../src/inspection.ts'

function canvasEncoder(t) {
  const original = globalThis.document
  globalThis.document = { createElement: () => {
    let image
    return {
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: data => { image = data },
      }),
      toBlob(done) { done(new Blob([image.data])) },
    }
  } }
  t.after(() => { if (original) globalThis.document = original; else delete globalThis.document })
}

test('chart range changes and selection changes retire late reads; retry recovers from an empty range', async t => {
  canvasEncoder(t)
  const reads = []
  const { inspector, select } = createInspector({
    loadArtwork: async () => null, initialRange: () => '24h',
    loadFloorChart(name, range, forceRetry, signal) {
      const wait = Promise.withResolvers()
      reads.push({ name, range, forceRetry, signal, wait })
      return wait.promise
    },
  }, () => {})
  const from = 20000 * 86400
  const completed = { from, to: from + 7 * 86400, interval: 86400, points: [{ time: from, price: 6 }, { time: from + 86400, price: 4 }] }
  select('Alpha')
  inspector.show('chart')
  inspector.step(1)
  assert.deepEqual(reads.map(r => [r.name, r.range]), [['Alpha', '24h'], ['Alpha', '7d']])
  assert.equal(reads[0].signal.reason?.name, 'AbortError')
  assert.equal(reads[1].signal.aborted, false)
  reads[0].wait.resolve(completed)
  reads[1].wait.resolve({ ...completed, points: [{ time: completed.to, price: 99 }] })
  await settle()
  assert.deepEqual(inspector.getSnapshot(), { mode: 'chart', collection: 'Alpha', fromVariants: false, range: '7d', status: 'empty' })
  inspector.retry()
  assert.equal(reads[2].forceRetry, true)
  reads[2].wait.reject(new Error('offline'))
  await settle()
  assert.equal(inspector.getSnapshot().status, 'error')
  inspector.retry()
  reads[3].wait.resolve(completed)
  await settle()
  const chart = inspector.getSnapshot()
  assert.deepEqual([chart.status, chart.low, chart.high, chart.last, chart.lastTime], ['ready', 4, 6, 4, from + 86400])
  assert.ok(chart.frame.some((value, offset) => offset % 4 === 0 && value > 0))
  assert.deepEqual(chart.series, completed)
  inspector.step(1)
  select('Beta')
  assert.equal(reads[4].signal.reason?.name, 'AbortError')
  reads[4].wait.resolve(completed)
  await settle()
  assert.deepEqual(inspector.getSnapshot(), { mode: 'overview' })
})

test('only publishes the two newest adjacent, completed UTC closes in the current 7d window', async t => {
  canvasEncoder(t)
  const day = 86400, to = Math.floor(Date.now() / 1000 / day) * day, from = to - 7 * day
  const point = offset => ({ time: to + offset * day, price: 20 + offset })
  let series = { from, to, interval: day, points: [point(-1), { ...point(-2), price: 999 }, point(-5), point(-2), point(0)] }
  const { inspector, select } = createInspector({ initialRange: () => '7d', loadFloorChart: async () => series }, () => {})
  select('Plush Pepe')
  inspector.show('chart')
  await settle()
  assert.deepEqual(inspector.getSnapshot().comparison, { previousTime: to - 2 * day, previous: 18 })
  const latest = inspector.getSnapshot()
  assert.deepEqual(latest.series, { from, to, interval: day, points: [point(-5), point(-2), point(-1)] })
  assert.deepEqual([latest.lastTime, latest.last, latest.low, latest.high], [to - day, 19, 15, 19])
  for (const gap of [
    { points: [point(-5), point(-4), point(-1)] }, { points: [point(-1)] }, { points: [point(-1), point(0)] },
    { points: [point(-9), point(-8)], from: to - 10 * day, to: to - 7 * day },
    { from: to - day }, { to: to - day }, { interval: 900 },
  ]) {
    series = { from, to, interval: day, points: [point(-2), point(-1)], ...gap }
    inspector.back()
    inspector.show('chart')
    await settle()
    assert.equal(inspector.getSnapshot().status, 'ready')
    assert.equal(inspector.getSnapshot().comparison, undefined)
  }
  series = { from: to - 30 * day, to, interval: day, points: [point(-2), point(-1)] }
  inspector.setRange('30d')
  await settle()
  const monthly = inspector.getSnapshot()
  assert.deepEqual([monthly.range, monthly.status, monthly.lastTime, monthly.comparison], ['30d', 'ready', to - day, undefined])
})

test('a complete model wraps at 360°, and a named variant requests its own artwork', async t => {
  canvasEncoder(t)
  const pending = Promise.withResolvers(), art = t.mock.fn(() => pending.promise)
  const { inspector, select } = createInspector({ loadArtwork: art, initialRange: () => '24h' }, () => {})
  select('Algorithm Cup')
  inspector.show('preview')
  await settle()
  const first = inspector.getSnapshot()
  assert.equal(first.kind, 'model')
  assert.equal(first.angle, 0)
  // The native gesture includes the displayed PNG. Another swipe during encoding
  // must wait until the glasses can acknowledge the new frame and its label.
  inspector.step(-1, first.frame)
  inspector.step(-1, first.frame)
  await settle()
  assert.equal(inspector.getSnapshot().angle, 315)
  assert.notDeepEqual(inspector.getSnapshot().frame, first.frame)
  assert.equal(first.frame[(128 * 256 + 6) * 4], 170)
  inspector.step(-1, first.frame)
  await settle()
  assert.equal(inspector.getSnapshot().angle, 315)
  inspector.step(1)
  await settle()
  assert.equal(inspector.getSnapshot().frame, first.frame)
  inspector.show('preview', 'Limited Edition')
  assert.deepEqual(art.mock.calls.at(-1).arguments, ['Algorithm Cup', 'Limited Edition'])
  inspector.show('chart')
  inspector.show('preview')
  assert.deepEqual(art.mock.calls.at(-1).arguments, ['Algorithm Cup', 'Limited Edition'])
  inspector.show('overview')
  pending.resolve(null)
  await settle()
  assert.deepEqual(inspector.getSnapshot(), { mode: 'overview' })
})

test('resolving the selected name retains the angle of an open 3D model', async t => {
  canvasEncoder(t)
  const { inspector, select, rebind } = createInspector({ initialRange: () => '24h' }, () => {})
  select('AlgorithmCup')
  inspector.show('preview')
  await settle()
  inspector.step(1)
  await settle()
  rebind('Algorithm Cup')
  await settle()
  const view = inspector.getSnapshot()
  assert.deepEqual([view.collection, view.kind, view.angle], ['Algorithm Cup', 'model', 45])
})

test('consecutive name rebinds retain the highlighted variant by name until the latest list arrives', async () => {
  const firstReload = Promise.withResolvers(), latestReload = Promise.withResolvers()
  const lists = [Promise.resolve(['A', 'B', 'C']), firstReload.promise, latestReload.promise,
    Promise.resolve(['C', 'B', 'A']), Promise.resolve(['B', 'C']), Promise.resolve(['C', 'B', 'A'])]
  const { inspector, select, rebind } = createInspector({ initialRange: () => '24h', loadVariants: () => lists.shift() }, () => {})
  const highlight = () => {
    const list = inspector.getSnapshot()
    assert.equal(list.status, 'ready')
    return list.names[list.index]
  }
  select('Gift')
  inspector.show('variants')
  await settle()
  inspector.step(1)
  assert.equal(highlight(), 'B')
  rebind('Gift alias')
  rebind('Gift')
  assert.equal(inspector.getSnapshot().status, 'loading')
  latestReload.resolve(['C', 'A', 'B'])
  await settle()
  assert.equal(highlight(), 'B')
  firstReload.resolve(['Old'])
  await settle()
  assert.equal(highlight(), 'B')
  inspector.step(-1)
  rebind('Gift alias')
  await settle()
  assert.equal(highlight(), 'A')
  rebind('Gift')
  await settle()
  assert.equal(highlight(), 'B') // A is absent in this list.
  select('New gift')
  inspector.show('variants')
  await settle()
  assert.equal(highlight(), 'C')
})

test('consecutive name rebinds retain the rotated preview while loading and a new inspection starts at its initial angle', async t => {
  canvasEncoder(t)
  const { inspector, select, rebind } = createInspector({ initialRange: () => '24h' }, () => {})
  select('AlgorithmCup')
  inspector.show('preview')
  await settle()
  inspector.step(1)
  await settle()
  assert.equal(inspector.getSnapshot().angle, 45)
  rebind('Algorithm Cup')
  assert.equal(inspector.getSnapshot().status, 'loading')
  rebind('AlgorithmCup')
  await settle()
  assert.equal(inspector.getSnapshot().angle, 45)
  inspector.step(1)
  rebind('Algorithm Cup')
  rebind('AlgorithmCup')
  await settle()
  assert.equal(inspector.getSnapshot().angle, 90)
  rebind('Algorithm Cup')
  inspector.back()
  inspector.show('preview')
  await settle()
  assert.equal(inspector.getSnapshot().angle, 0)
})

test('the model picker uses collection artwork names, retains its position on Back and retires replaced reads', async t => {
  const names = Promise.withResolvers()
  const loadVariants = t.mock.fn(() => names.promise)
  const loadArtwork = t.mock.fn(async () => null)
  const { inspector, select } = createInspector({ loadVariants, loadArtwork, initialRange: () => '24h' }, () => {})
  select('A')
  inspector.show('variants')
  assert.equal(inspector.getSnapshot().status, 'loading')
  select('B')
  names.resolve(['Previous collection model'])
  await settle()
  assert.deepEqual(inspector.getSnapshot(), { mode: 'overview' })
  loadVariants.mock.mockImplementationOnce(async () => [])
  inspector.show('variants')
  await settle()
  assert.equal(inspector.getSnapshot().status, 'empty')
  loadVariants.mock.mockImplementationOnce(async () => { throw Error('offline') })
  inspector.retry()
  await settle()
  assert.equal(inspector.getSnapshot().status, 'error')
  loadVariants.mock.mockImplementationOnce(async () => ['Listed', 'Unlisted'])
  inspector.retry()
  await settle()
  inspector.step(1)
  inspector.pickVariant()
  assert.deepEqual(loadArtwork.mock.calls.at(-1).arguments, ['B', 'Unlisted'])
  await settle()
  assert.equal(inspector.getSnapshot().fromVariants, true)
  inspector.back()
  assert.deepEqual(inspector.getSnapshot(), {
    mode: 'variants', status: 'ready', collection: 'B', fromVariants: true, names: ['Listed', 'Unlisted'], index: 1,
  })
  inspector.step(-1)
  inspector.pickVariant('Unlisted')
  assert.equal(inspector.getSnapshot().model, 'Unlisted')
  inspector.back()
  inspector.back()
  assert.deepEqual(inspector.getSnapshot(), { mode: 'overview' })
  assert.equal(loadVariants.mock.callCount(), 4)
})
