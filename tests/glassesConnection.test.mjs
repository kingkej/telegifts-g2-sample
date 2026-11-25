import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { OsEventTypeList as Event } from '@evenrealities/even_hub_sdk'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { createGlassesConnection } from '../src/glassesConnection.ts'
import { connectGlasses } from '../src/glasses.ts'

// Exercise the real phone/display state and SDK page builders with a native host
// that can lose its page while leaving the phone WebView alive. Startup is one-shot
// per the Even SDK reference, and subsequent full-page writes use rebuildPageContainer.
function setup(t, sources = {}) {
  let created = false, content = '', closed = false, selected = null, favorites = false
  const listeners = new Set()
  const show = layout => {
    assert.equal(layout.textObject.filter(item => item.isEventCapture === 1).length, 1)
    content = layout.textObject[0].content
    assert.ok(content.trim())
  }
  const closePage = mode => { assert.equal(mode, 1); closed = true; content = ''; return true }
  const bridge = {
    ready: true,
    createStartUpPageContainer: t.mock.fn(async layout => {
      if (created) return 1
      created = true
      closed = false
      show(layout)
      return 0
    }),
    rebuildPageContainer: t.mock.fn(async layout => {
      if (!created) return false
      closed = false
      show(layout)
      return true
    }),
    textContainerUpgrade: t.mock.fn(async change => { assert.equal(closed, false); content = change.content; return true }),
    updateImageRawData: t.mock.fn(async () => 'success'),
    shutDownPageContainer: t.mock.fn(async mode => closePage(mode)),
    onEvenHubEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  globalThis.window = { EvenAppBridge: bridge }
  t.after(() => { delete globalThis.window })
  const display = createCollectionDisplay(() => glasses.update())
  const glasses = createGlassesConnection((onClosed, showDisplayError, onStartupRebuild) =>
    connectGlasses({ ...display, showDisplayError }, onClosed, onStartupRebuild))
  const syncFavorites = () => display.companion.favoritesChanged({ ready: true, visible: favorites, collections: [] })
  display.companion.connect({
    loadCatalog: async () => ({ collection_floors: { 'Toy Bear': { portals: 4 }, Rose: { portals: 8 } } }),
    loadArtwork: async () => null, loadFloorChart: async () => ({ points: [] }),
    loadVariants: async () => ['Blue', 'Gold'],
    ...sources,
    open(item) { selected = item; display.companion.select(item) },
    back() { if (!selected) return false; selected = null; display.companion.select(null); return true },
    setFavorite() { throw Error('Unintended save') },
    showFavorites(visible) { favorites = visible; syncFavorites() },
  })
  syncFavorites()
  const send = async eventType => {
    for (const listener of [...listeners]) listener({ sysEvent: { eventType } })
    await settle()
  }
  return { bridge, display, connection: glasses.connection, listeners, send, closePage, text: () => content }
}

test('Back unwinds a named model, empty tools, detail and Favorites to a usable Explore menu', async t => {
  const { connection, send, text, bridge } = setup(t)
  await connection.open()
  const steps = [
    [Event.SCROLL_BOTTOM_EVENT, /Toy Bear/],
    [Event.CLICK_EVENT, /Toy Bear[\s\S]*Double-tap to return/],
    [Event.LONG_PRESS_EVENT, /Models[\s\S]*Blue/],
    [Event.SCROLL_BOTTOM_EVENT, /Gold/],
    [Event.CLICK_EVENT, /Gold[\s\S]*Artwork unavailable/],
    [Event.DOUBLE_CLICK_EVENT, /Models[\s\S]*Gold/],
    [Event.DOUBLE_CLICK_EVENT, /Toy Bear[\s\S]*Swipe up for 3D/],
    [Event.SCROLL_BOTTOM_EVENT, /No floor observations/],
    [Event.DOUBLE_CLICK_EVENT, /Toy Bear[\s\S]*Swipe up for 3D/],
    [Event.DOUBLE_CLICK_EVENT, /Explore Gifts[\s\S]*Toy Bear/],
    [Event.DOUBLE_CLICK_EVENT, /TeleGifts menu[\s\S]*> Explore gifts/],
    [Event.SCROLL_BOTTOM_EVENT, /> Favorites/],
    [Event.CLICK_EVENT, /No saved collections yet/],
    [Event.DOUBLE_CLICK_EVENT, /Explore Gifts[\s\S]*Toy Bear/],
  ]
  for (const [event, expected] of steps) {
    await send(event)
    assert.match(text(), expected)
    assert.equal(connection.getSnapshot(), 'ready')
  }
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
})

test('Back works before a chart or model list loads and a late failure cannot replace the return screen', async t => {
  const chart = Promise.withResolvers(), models = Promise.withResolvers()
  const { connection, send, text, bridge } = setup(t, {
    loadFloorChart: () => chart.promise, loadVariants: () => models.promise,
  })
  await connection.open()
  await send(Event.CLICK_EVENT)
  for (const [event, wait] of [[Event.SCROLL_BOTTOM_EVENT, chart], [Event.LONG_PRESS_EVENT, models]]) {
    await send(event)
    assert.match(text(), /Loading/)
    await send(Event.DOUBLE_CLICK_EVENT)
    assert.match(text(), /Swipe up for 3D/)
    wait.reject(Error('offline'))
    await settle()
    assert.match(text(), /Swipe up for 3D/)
  }
  await send(Event.DOUBLE_CLICK_EVENT)
  assert.match(text(), /Explore Gifts/)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
})

test('an unresponsive native startup exposes phone recovery and a late response restores normal input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const startup = Promise.withResolvers()
  const start = t.mock.fn(() => startup.promise)
  const { connection } = createGlassesConnection(start)
  const opening = connection.open()
  t.mock.timers.tick(12_000)
  assert.equal(connection.getSnapshot(), 'reloadAvailable')
  void connection.open()
  assert.equal(start.mock.callCount(), 1)
  startup.resolve({ update() {}, async stop() {} })
  await opening
  assert.equal(connection.getSnapshot(), 'ready')
})

test('phone reopen after a rebuild timeout never writes over the outstanding call and can retry after a late rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const { connection, bridge, send, listeners, text } = setup(t)
  await connection.open()
  await settle()
  const rebuild = bridge.rebuildPageContainer, initialCount = rebuild.mock.callCount()
  const missing = Promise.withResolvers()
  rebuild.mock.mockImplementationOnce(() => missing.promise)
  await send(Event.CLICK_EVENT)
  assert.equal(rebuild.mock.callCount(), initialCount + 1)
  t.mock.timers.tick(12_000)
  await settle()
  assert.equal(connection.getSnapshot(), 'unavailable')
  await connection.open()
  assert.equal(connection.getSnapshot(), 'unavailable')
  assert.equal(listeners.size, 0)
  assert.equal(rebuild.mock.callCount(), initialCount + 1)
  missing.reject(Error('native host lost the reply'))
  await settle()
  assert.equal(rebuild.mock.callCount(), initialCount + 1)
  assert.equal(connection.getSnapshot(), 'unavailable')
  await connection.open()
  assert.equal(connection.getSnapshot(), 'ready')
  assert.equal(listeners.size, 1)
  assert.match(text(), /Swipe up for 3D/)
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
})

test('a missing startup rebuild releases open and preserves the one-shot create', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const { connection, bridge, text } = setup(t)
  await connection.open()
  await settle()
  const missing = Promise.withResolvers()
  const create = bridge.createStartUpPageContainer, rebuild = bridge.rebuildPageContainer
  const initialCount = rebuild.mock.callCount()
  rebuild.mock.mockImplementationOnce(() => missing.promise)
  const statuses = []
  connection.subscribe(() => statuses.push(connection.getSnapshot()))
  const opening = connection.open()
  await settle()
  assert.equal(rebuild.mock.callCount(), initialCount + 1)
  t.mock.timers.tick(12_000)
  await settle()
  assert.equal(connection.getSnapshot(), 'unavailable')
  assert.ok(!statuses.includes('reloadAvailable'), 'the phone must keep the unresolved rebuild in this WebView')
  await opening
  await connection.open()
  assert.equal(rebuild.mock.callCount(), initialCount + 1)
  missing.resolve(true)
  await settle()
  await connection.open()
  assert.equal(connection.getSnapshot(), 'ready')
  assert.match(text(), /Explore Gifts/)
  assert.equal(create.mock.callCount(), 1)
})

test('a host that refuses an in-place restart leaves the full reload action available', async t => {
  t.mock.method(console, 'warn', () => {})
  const { bridge, connection } = setup(t)
  bridge.createStartUpPageContainer.mock.mockImplementation(async () => 1)
  bridge.rebuildPageContainer.mock.mockImplementation(async () => false)
  await connection.open()
  assert.equal(connection.getSnapshot(), 'reloadAvailable')
  await connection.open()
  assert.equal(connection.getSnapshot(), 'reloadAvailable')
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  assert.equal(bridge.rebuildPageContainer.mock.callCount(), 1)
})

test('a refused startup offers reload immediately and a fresh bridge can start normally', async t => {
  t.mock.method(console, 'warn', () => {})
  const first = setup(t)
  first.bridge.createStartUpPageContainer.mock.mockImplementationOnce(async () => 3)
  await first.connection.open()
  assert.equal(first.connection.getSnapshot(), 'reloadAvailable')
  await first.connection.open()
  assert.equal(first.bridge.createStartUpPageContainer.mock.callCount(), 1)
  assert.equal(first.bridge.rebuildPageContainer.mock.callCount(), 0)
  const fresh = setup(t)
  await fresh.connection.open()
  assert.equal(fresh.connection.getSnapshot(), 'ready')
  assert.equal(fresh.bridge.createStartUpPageContainer.mock.callCount(), 1)
})

test('phone recovery accepts a request while native startup is still acknowledging an OS exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const startup = Promise.withResolvers()
  let osExit
  const discarded = { update: t.mock.fn(), stop: t.mock.fn(async () => {}) }
  const replacement = { update: t.mock.fn(), stop: t.mock.fn(async () => {}) }
  const start = t.mock.fn(async () => replacement)
  start.mock.mockImplementationOnce(onClosed => { osExit = onClosed; return startup.promise })
  const { connection } = createGlassesConnection(start)
  const opened = connection.open()
  osExit()
  assert.equal(connection.getSnapshot(), 'closed')
  void connection.open()
  assert.equal(connection.getSnapshot(), 'opening')
  t.mock.timers.tick(12_000)
  assert.equal(connection.getSnapshot(), 'reloadAvailable')
  assert.equal(start.mock.callCount(), 1)
  startup.resolve(discarded)
  await opened
  assert.equal(discarded.update.mock.callCount(), 0)
  assert.equal(discarded.stop.mock.callCount(), 1)
  assert.equal(replacement.update.mock.callCount(), 1)
  assert.equal(connection.getSnapshot(), 'ready')
})

test('a slow native exit finishes before the replacement page can open or offer a WebView reload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { bridge, connection, text, send, closePage } = setup(t)
  const exit = Promise.withResolvers()
  bridge.shutDownPageContainer.mock.mockImplementation(async mode => { await exit.promise; return closePage(mode) })
  await connection.open()
  for (const event of [Event.DOUBLE_CLICK_EVENT, Event.SCROLL_BOTTOM_EVENT, Event.SCROLL_BOTTOM_EVENT, Event.CLICK_EVENT]) await send(event)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 1)
  const reopening = connection.open()
  t.mock.timers.tick(12_000)
  assert.equal(connection.getSnapshot(), 'waitingForHost')
  void connection.open()
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  exit.resolve(true)
  await reopening
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  assert.ok(bridge.rebuildPageContainer.mock.callCount() > 0)
  assert.equal(connection.getSnapshot(), 'ready')
  assert.match(text(), /Explore Gifts/)
})

test('phone can rebuild a silently closed page and recover after an OS exit with one startup', async t => {
  t.mock.method(console, 'warn', () => {})
  const { bridge, connection, listeners, send, text } = setup(t)
  await connection.open()
  await send(Event.SCROLL_BOTTOM_EVENT)
  for (const event of [Event.DOUBLE_CLICK_EVENT, Event.SCROLL_BOTTOM_EVENT, Event.SCROLL_BOTTOM_EVENT, Event.CLICK_EVENT]) await send(event)
  assert.equal(text(), '')
  await connection.open()
  assert.equal(listeners.size, 1)
  assert.match(text(), /Explore Gifts[\s\S]*Toy Bear/)
  await send(Event.CLICK_EVENT)
  assert.match(text(), /Toy Bear[\s\S]*Swipe up for 3D/)
  await send(Event.ABNORMAL_EXIT_EVENT)
  assert.equal(listeners.size, 0)
  assert.equal(connection.getSnapshot(), 'closed')
  await connection.open()
  assert.equal(connection.getSnapshot(), 'ready')
  assert.equal(listeners.size, 1)
  assert.match(text(), /Toy Bear[\s\S]*Swipe up for 3D/)
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  await send(Event.DOUBLE_CLICK_EVENT)
  assert.match(text(), /Explore Gifts[\s\S]*Toy Bear/)
})

test('reopen waits for an older native write and repeated phone taps start one replacement session', async t => {
  const { bridge, display, connection, listeners, text, send } = setup(t)
  await connection.open()
  await send(Event.SCROLL_BOTTOM_EVENT)
  const writing = Promise.withResolvers()
  const delayedQuote = t.mock.fn(() => writing.promise)
  bridge.textContainerUpgrade.mock.mockImplementationOnce(delayedQuote)
  display.companion.rateChanged(2)
  await settle()
  assert.equal(delayedQuote.mock.callCount(), 1)
  const reopen = connection.open()
  void connection.open()
  await settle()
  assert.equal(connection.getSnapshot(), 'opening')
  assert.equal(listeners.size, 0)
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  writing.resolve(true)
  await reopen
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 1)
  assert.ok(bridge.rebuildPageContainer.mock.callCount() > 0)
  assert.equal(listeners.size, 1)
  assert.match(text(), /Toy Bear/)
  await send(Event.DOUBLE_CLICK_EVENT)
  assert.match(text(), /TeleGifts menu/)
})

test('a lost native write offers reload and a later retry drains it before reopening', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const drain = Promise.withResolvers()
  const start = t.mock.fn(async () => ({ update() {}, stop: () => drain.promise }))
  const { connection } = createGlassesConnection(start)
  await connection.open()
  const pending = connection.open()
  t.mock.timers.tick(12_000)
  assert.equal(connection.getSnapshot(), 'waitingForHost')
  t.mock.timers.tick(12_000)
  await pending
  assert.equal(connection.getSnapshot(), 'reloadAvailable')
  const retry = connection.open()
  assert.equal(start.mock.callCount(), 1)
  drain.resolve()
  await retry
  assert.equal(start.mock.callCount(), 2)
  assert.equal(connection.getSnapshot(), 'ready')
})
