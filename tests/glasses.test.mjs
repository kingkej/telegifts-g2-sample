import { toolView } from '../src/toolDisplay.ts'
import { fitNativeText } from '../src/displayText.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { evenHubEventFromJson, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { connectGlasses } from '../src/glasses.ts'
import { createVoiceControl } from '../src/voiceControl.ts'

const doubleTap = { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }
const swipeUp = { sysEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }
const swipeDown = { sysEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }
const hold = { sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } }
const click = { textEvent: {} }
const bundled = readFileSync(new URL('../src/assets/plush-pepe-g2.png', import.meta.url))
const lastArg = mock => mock.mock.calls.at(-1)?.arguments[0]
const rebuiltText = bridge => lastArg(bridge.rebuildPageContainer).textObject[0]
const textEvent = jsonData => evenHubEventFromJson({ type: 'text_event', jsonData })
const sysEvent = jsonData => evenHubEventFromJson({ type: 'sys_event', jsonData })
const menuSelection = itemID => evenHubEventFromJson({ type: 'menuItemClickEvent', jsonData: { itemID } })

function ready(name, detail = false) {
  const floor = { marketplace: 'Portals', price: 42.5 }
  return { status: 'ready', id: name, section: 'explore', position: 1, total: 1, saved: false, detail,
    collection: { name, floor, quotes: [floor], updatedAt: '2026-11-19T12:00:00Z' } }
}

function inspected(card, inspection, fromVariants = false) {
  return { ...card, inspection: { collection: card.collection.name, fromVariants, ...inspection } }
}

function cupAt(card, angle, frame) {
  return inspected(card, { mode: 'preview', status: 'ready', model: null,
    kind: 'model', angle, frame, canPrevious: true, canNext: true })
}

function display(t, screen, loadArtwork = async () => null) {
  let update, receive
  const returns = value => t.mock.fn(async () => value)
  const bridge = {
    ready: true,
    createStartUpPageContainer: returns(0), rebuildPageContainer: returns(true),
    textContainerUpgrade: returns(true), updateImageRawData: returns('success'),
    shutDownPageContainer: returns(true),
    onEvenHubEvent(listener) {
      receive = listener
      return () => { if (receive === listener) receive = undefined }
    },
  }
  globalThis.window = { EvenAppBridge: bridge }
  t.after(() => { delete globalThis.window })
  const tap = t.mock.fn(), back = t.mock.fn(() => false), feedback = t.mock.fn(), onClosed = t.mock.fn()
  const move = t.mock.fn(), openFavorites = t.mock.fn()
  const inspector = { show: t.mock.fn(), step: t.mock.fn(), pickVariant: t.mock.fn(), back: t.mock.fn(), retry: t.mock.fn() }
  return {
    bridge, tap, back, feedback, move, openFavorites, inspector, onClosed,
    listening: () => receive !== undefined,
    input(event) { receive?.(event) },
    show(next) { screen = next; update() },
    async start(voice, extra = {}) {
      const session = await connectGlasses({ current: () => screen, tap, move, openFavorites, back,
        showDisplayError: feedback, loadArtwork, inspector, voice, ...extra }, onClosed)
      update = session.update
      await settle()
      return session
    },
  }
}

test('a research swipe shows the adjacent row and a single tap opens the visible task', async t => {
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  t.after(() => { delete globalThis.document })
  const card = ready('Toy Bear'), host = display(t, card)
  const rows = ['Check Toy Bear', 'Check Plush Pepe'].map((title, index) => ({
    key: 'row-' + index, title, lines: ['Board · Research', 'Task ' + (index + 1) + ' of 2', 'Collection'],
    browse: { open: 'open-chart', ...(index ? { previous: 'previous-task' } : { next: 'next-task' }) },
    actions: [{ id: 'open-chart', label: 'Open seven-day chart' }, { id: index ? 'previous-task' : 'next-task', label: 'Other task' }, { id: 'refresh', label: 'Refresh' }],
  }))
  let page = rows[0]
  const act = t.mock.fn((shown, id) => {
    if (id === 'next-task' || id === 'previous-task') { page = rows[id === 'next-task' ? 1 : 0]; host.show(card) }
    return shown === page
  })
  const tools = { getSnapshot: () => page, act, suspend() {}, close() {} }
  const session = await host.start(undefined, { getTools: () => tools })
  t.after(() => session.stop())
  const title = () => rebuiltText(host.bridge).content.split('\n')[0]
  host.input(swipeDown); await settle()
  assert.equal(title(), 'Check Plush Pepe')
  document.hidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Unlock your phone.*\nDouble-tap to go back/)
  assert.doesNotMatch(rebuiltText(host.bridge).content, /Tap →|Swipe to browse tasks/)
  host.input(swipeUp); host.input(click)
  assert.equal(act.mock.callCount(), 1)
  document.hidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Tap → Open seven-day chart\nSwipe to browse tasks/)
  host.input(swipeDown); host.input(click)
  assert.deepEqual(act.mock.calls.map(x => x.arguments), [[rows[0], 'next-task'], [rows[1], 'open-chart']])
  host.input(swipeUp); await settle()
  assert.equal(title(), 'Check Toy Bear')
})

function installChartCanvas(t) {
  const encode = t.mock.fn(done => done(new Blob([Uint8Array.of(1)])))
  globalThis.document = { createElement: () => ({
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    toBlob: encode,
  }) }
  t.after(() => { delete globalThis.document })
  return encode
}

test('tool charts distinguish upload failure, empty data and a successful retry', async t => {
  const card = ready('Toy Bear'), host = display(t, card)
  const encode = installChartCanvas(t)
  const series = { from: 0, to: 172800, interval: 86400, points: [{ time: 86400, price: 3 }] }
  const chart = source => ({ key: 'history', title: 'Research', lines: ['Toy Bear'], chart: { collection: 'Toy Bear', series: source }, actions: [] })
  let page = chart(series)
  const send = host.bridge.updateImageRawData
  send.mock.mockImplementationOnce(async () => 'sendFailed')
  const tools = { getSnapshot: () => page, close() {} }
  const session = await host.start(undefined, { getTools: () => tools })
  t.after(() => session.stop())
  const layout = () => lastArg(host.bridge.rebuildPageContainer)
  const hint = () => layout().textObject[0].content
  assert.match(hint(), /Menu → Retry chart/)
  assert.equal(layout().textObject[0].width, 560)
  assert.equal(layout().imageObject.length, 0)
  host.show(card)
  await settle()
  assert.equal(send.mock.callCount(), 1)
  host.input(menuSelection(layout().menuObject.menuItems.find(item => item.itemName === 'Retry chart').itemID))
  await settle()
  assert.equal(send.mock.callCount(), 2)
  assert.doesNotMatch(hint(), /Menu → Retry chart/)
  assert.equal(layout().imageObject.length, 1)
  assert.equal(layout().textObject[0].width, 286)

  const encodes = encode.mock.callCount()
  page = chart({ ...series, points: [{ time: 1, price: 0 }] })
  host.show(card)
  await settle()
  assert.match(hint(), /No floor observations/)
  assert.equal(layout().imageObject.length, 0)
  assert.equal(encode.mock.callCount(), encodes)
  assert.equal(send.mock.callCount(), 2)

  send.mock.mockImplementationOnce(async () => { throw Error('BLE disconnected') })
  page = chart({ ...series })
  host.show(card)
  await settle()
  assert.match(hint(), /Menu → Retry chart/)
  page = chart({ ...series })
  host.show(card)
  await settle()
  assert.doesNotMatch(hint(), /Menu → Retry chart|No floor observations/)
  assert.equal(layout().imageObject.length, 1)
  assert.equal(send.mock.callCount(), 4)

  const late = Promise.withResolvers()
  send.mock.mockImplementationOnce(() => late.promise)
  page = chart({ ...series })
  host.show(card)
  await settle()
  page = chart({ ...series })
  host.show(card)
  late.resolve('sendFailed')
  await settle()
  assert.equal(send.mock.callCount(), 6)
  assert.equal(layout().imageObject.length, 1)
  assert.doesNotMatch(hint(), /Menu → Retry chart/)
})

test('tool chart slot rebuild failures offer retry only for the current series', async t => {
  for (const retire of [false, true]) await t.test(retire ? 'retired rejection' : 'current refusal', async t => {
    installChartCanvas(t)
    const card = ready('Toy Bear'), host = display(t, card)
    const series = { from: 0, to: 172800, interval: 86400, points: [{ time: 86400, price: 3 }] }
    const chart = source => ({ key: 'history', title: 'Research', lines: [], chart: { collection: 'Toy Bear', series: source }, actions: [] })
    let page = chart(series)
    const tools = { getSnapshot: () => page, close() {} }
    const wait = Promise.withResolvers()
    const layouts = host.bridge.rebuildPageContainer
    layouts.mock.mockImplementationOnce(layout => {
      assert.equal(layout.imageObject.length, 1)
      return wait.promise
    })
    const session = await host.start(undefined, { getTools: () => tools })
    t.after(() => { wait.resolve(false); return session.stop() })
    assert.equal(layouts.mock.callCount(), 1)
    assert.equal(host.bridge.updateImageRawData.mock.callCount(), 0)
    if (retire) {
      page = chart({ ...series, points: [{ time: 86400, price: 9 }] })
      host.show(card)
      wait.reject(Error('lost rebuild acknowledgment'))
      await settle()
      assert.ok(layouts.mock.calls.every(({ arguments: [layout] }) => !layout.textObject[0].content.includes('Menu → Retry chart')))
    } else {
      wait.resolve(false)
      await settle()
      const fallback = lastArg(layouts)
      assert.deepEqual(fallback.imageObject, [])
      assert.equal(fallback.textObject[0].width, 560)
      assert.match(fallback.textObject[0].content, /Menu → Retry chart/)
      assert.equal(host.bridge.updateImageRawData.mock.callCount(), 0)
      const retryId = layout => layout.menuObject.menuItems.find(item => item.itemName === 'Retry chart').itemID
      const oldRetry = retryId(fallback)
      let refuseSlot = true
      layouts.mock.mockImplementation(async layout => {
        if (!layout.imageObject.length || !refuseSlot) return true
        refuseSlot = false
        return false
      })
      page = chart({ ...series, points: [{ time: 86400, price: 11 }] })
      host.show(card)
      await settle()
      const currentRetry = retryId(lastArg(layouts))
      assert.notEqual(currentRetry, oldRetry)
      const builds = layouts.mock.callCount()
      host.input(menuSelection(oldRetry))
      await settle()
      assert.equal(layouts.mock.callCount(), builds)
      assert.equal(host.bridge.updateImageRawData.mock.callCount(), 0)
      host.input(menuSelection(currentRetry))
      await settle()
    }
    assert.equal(host.bridge.updateImageRawData.mock.callCount(), 1)
    assert.equal(lastArg(layouts).imageObject.length, 1)
    assert.doesNotMatch(rebuiltText(host.bridge).content, /Menu → Retry chart/)
    assert.ok(!lastArg(layouts).menuObject.menuItems.some(item => item.itemName === 'Retry chart'))
  })
})

test('a locked phone keeps lens navigation live while audio and tool actions remain suspended', async t => {
  const card = ready('Toy Bear'), host = display(t, card)
  host.bridge.audioControl = t.mock.fn(async () => true)
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  t.after(() => { delete globalThis.document })
  let page = null
  const tools = { getSnapshot: () => page, act: t.mock.fn(), back: t.mock.fn(), suspend() {}, close() {} }
  const voice = createVoiceControl({ names: () => [], resolve: () => ({ kind: 'unknown' }), transcribe: async () => null })
  const receive = t.mock.method(voice, 'receive')
  const session = await host.start(voice, { getTools: () => tools })
  t.after(() => session.stop())
  document.hidden = true
  host.input(swipeUp)
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  host.input(swipeDown)
  host.input(click)
  host.input(hold)
  assert.deepEqual(host.move.mock.calls.map(call => call.arguments), [[-1], [1]])
  assert.equal(host.tap.mock.callCount(), 1)
  assert.equal(host.openFavorites.mock.callCount(), 1)
  host.input({ audioEvent: { source: 'glasses', audioPcm: Uint8Array.of(0, 1) } })
  assert.equal(receive.mock.callCount(), 0)
  page = { key: 'watch', title: 'Watch', lines: ['One', 'Two', 'Three', 'Four', 'Five'],
    actions: [{ id: 'start', label: 'Start' }, { id: 'stop', label: 'Stop', requiresConfirmation: true }] }
  host.show(card)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Unlock your phone.*\nSwipe   1 \/ 2\nDouble-tap to go back/)
  host.input(swipeDown)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Five\nUnlock your phone.*\nSwipe   2 \/ 2/)
  assert.doesNotMatch(rebuiltText(host.bridge).content, /Tap →|Menu →/)
  host.input(click)
  assert.equal(tools.act.mock.callCount(), 0)
  host.input({ sysEvent: doubleTap })
  assert.equal(tools.back.mock.callCount(), 1)
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
  host.input({ sysEvent: doubleTap })
  assert.equal(tools.back.mock.callCount(), 1)
})

test('reopening publishes native foreground without waiting for a new enter event', async t => {
  const host = display(t, ready('Toy Bear'))
  const setToolsForeground = t.mock.fn()
  const first = await host.start(undefined, { setToolsForeground })
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
  await first.stop()
  const second = await host.start(undefined, { setToolsForeground })
  t.after(() => second.stop())
  assert.deepEqual(setToolsForeground.mock.calls.map(call => call.arguments).filter(([source]) => source === 'native'),
    [['native', true], ['native', false], ['native', true]])
})

test('tool confirmations belong to one acknowledged preview; Back, foreground return and exit stay within the toolbox', async t => {
  const card = ready('Toy Bear', true), host = display(t, card)
  const preview = () => ({ key: 'preview', title: 'Record floor?', lines: ['Toy Bear · 12 GRAM'],
    actions: [{ id: 'record', label: 'Record in Notion', requiresConfirmation: true }, { id: 'cancel', label: 'Cancel' }] })
  let page = preview()
  const tools = { getSnapshot: () => page, act: t.mock.fn(), back: t.mock.fn(), close: t.mock.fn(), suspend: t.mock.fn() }
  const session = await host.start(undefined, { getTools: () => tools })
  t.after(() => session.stop())
  const layout = () => lastArg(host.bridge.rebuildPageContainer) ?? lastArg(host.bridge.createStartUpPageContainer)
  const item = name => layout().menuObject.menuItems.find(i => i.itemName === name).itemID
  assert.match(layout().textObject[0].content, /Menu → Record in Notion/)
  const old = item('Record in Notion')
  host.input(click)
  host.input({ ...menuSelection(old), textEvent: {} })
  const ack = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => ack.promise)
  page = preview()
  host.show(card)
  await settle()
  host.input(menuSelection(old))
  host.input(menuSelection(item('Record in Notion')))
  assert.equal(tools.act.mock.callCount(), 0)
  ack.resolve(true)
  await settle()
  const fresh = item('Record in Notion')
  assert.notEqual(old, fresh)
  host.input(menuSelection(old))
  host.input(menuSelection(fresh))
  host.input(menuSelection(fresh))
  assert.deepEqual(tools.act.mock.calls.map(c => c.arguments), [[page, 'record']])
  host.input(swipeDown)
  await settle()
  assert.match(layout().textObject[0].content, /Tap → Cancel/)
  host.input(click)
  assert.deepEqual(tools.act.mock.calls.at(-1).arguments, [page, 'cancel'])
  host.input({ sysEvent: doubleTap })
  assert.equal(tools.back.mock.callCount(), 1)
  assert.equal(host.back.mock.callCount(), 0)
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
  host.input({ sysEvent: doubleTap })
  assert.equal(tools.suspend.mock.callCount(), 1)
  assert.equal(tools.back.mock.callCount(), 1)
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }))
  await settle()
  host.input(menuSelection(item('Back')))
  assert.equal(tools.back.mock.callCount(), 2)
  host.input(sysEvent({ eventType: OsEventTypeList.SYSTEM_EXIT_EVENT }))
  assert.equal(tools.close.mock.callCount(), 1)
  assert.equal(host.listening(), false)
})

test('Talk to Gifti opens consent from a collection and a retired menu cannot open it again', async t => {
  const card = ready('Toy Bear', true), host = display(t, card)
  const microphone = host.bridge.audioControl = t.mock.fn(async () => true)
  const voice = createVoiceControl({ names: () => [], transcribe: t.mock.fn(), resolve: t.mock.fn() })
  const tools = { getSnapshot: () => null, close() {} }, openTools = t.mock.fn()
  const session = await host.start(voice, { getTools: () => tools, openTools })
  t.after(() => session.stop())
  const menu = lastArg(host.bridge.rebuildPageContainer) ?? lastArg(host.bridge.createStartUpPageContainer)
  const entry = menu.menuObject.menuItems.find(item => item.itemName === 'Talk to Gifti')
  host.input(menuSelection(entry.itemID))
  host.show(ready('Plush Pepe', true))
  await settle()
  host.input(menuSelection(entry.itemID))
  assert.deepEqual(openTools.mock.calls.map(call => call.arguments), [['gifti', 'glasses', 'talk']])
  assert.equal(microphone.mock.callCount(), 0)
})

test('recording from a live tool overlays the lens, accepts glasses audio and rejects phone audio before returning to that tool', async t => {
  const card = ready('Toy Bear'), host = display(t, card)
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })
  t.after(() => { delete globalThis.document })
  const microphone = host.bridge.audioControl = t.mock.fn(async () => true)
  const transcribe = t.mock.fn(), resolve = t.mock.fn()
  const voice = createVoiceControl({ names: () => [], transcribe, resolve })
  const talk = { id: 'talk', label: 'Record question' }
  let page = { key: 'gifti', title: 'Ask Gifti', lines: [], actions: [talk] }
  let capture
  const tools = { getSnapshot: () => page, getActiveTool: () => 'gifti', back: t.mock.fn(), suspend: t.mock.fn(), close: t.mock.fn(),
    act(shown, id) {
      assert.equal(shown, page)
      assert.equal(id, 'talk')
      page = { key: 'recording', title: 'Ask Gifti', lines: ['Question'], actions: [talk] }
      host.show(card)
      capture = voice.controls.recordQuestion(new AbortController().signal)
    } }
  const session = await host.start(voice, { getTools: () => tools })
  t.after(() => session.stop())
  const start = async () => {
    host.input(click)
    await t.waitFor(() => assert.equal(voice.getQuestionSnapshot()?.phase, 'listening'))
    await settle()
    const content = rebuiltText(host.bridge).content
    assert.match(content, /Record question[\s\S]*Listening[\s\S]*pause[\s\S]*Menu → Finish recording[\s\S]*Double-tap to cancel/)
    assert.doesNotMatch(content, /Voice command|floor chart/)
  }
  await start()
  const finish = lastArg(host.bridge.rebuildPageContainer).menuObject.menuItems.find(i => i.itemName === 'Finish recording')
  const speech = new Uint8Array(Int16Array.from({ length: 3200 }, (_, i) => i % 2 ? 1400 : -1400).buffer)
  const audioChunk = (bytes, source, speakerRole) =>
    evenHubEventFromJson({ type: 'audioEvent', jsonData: { audioPcm: [...bytes], source, speakerRole } })
  host.input(audioChunk(speech, 'phone', 'self'))
  host.input(audioChunk(speech.subarray(0, 3200), 'glasses', 'other'))
  host.input(audioChunk(speech.subarray(3200), 'glasses', 'self'))
  host.input(menuSelection(finish.itemID))
  assert.deepEqual(await capture, speech)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /^Ask Gifti/)
  await start()
  host.input(menuSelection(finish.itemID)) // An earlier recording's menu cannot finish this one.
  assert.equal(voice.getQuestionSnapshot().phase, 'listening')
  host.input({ sysEvent: doubleTap })
  await assert.rejects(capture, { name: 'AbortError' })
  await settle()
  assert.match(rebuiltText(host.bridge).content, /^Ask Gifti/)
  assert.equal(tools.back.mock.callCount(), 0)
  assert.equal(tools.suspend.mock.callCount(), 0)
  assert.equal(tools.close.mock.callCount(), 0)
  for (const source of ['native', 'document', 'disconnect']) {
    await start()
    if (source === 'native') host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
    if (source === 'document') { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')) }
    if (source === 'disconnect') host.input(sysEvent({ eventType: OsEventTypeList.SYSTEM_EXIT_EVENT }))
    await assert.rejects(capture, { name: 'AbortError' })
    if (source === 'native') host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }))
    if (source === 'document') { document.hidden = false; document.dispatchEvent(new Event('visibilitychange')) }
    await settle()
  }
  assert.equal(tools.suspend.mock.callCount(), 2)
  assert.equal(tools.close.mock.callCount(), 1)
  assert.deepEqual(microphone.mock.calls.map(c => c.arguments), Array.from({ length: 10 }, (_, i) => [i % 2 === 0, 'glasses']))
  assert.equal(transcribe.mock.callCount(), 0)
  assert.equal(resolve.mock.callCount(), 0)
})

test('the Gifti follow-up keeps the answer visible and offers Finish only while the microphone is listening', async t => {
  const host = display(t, ready('Toy Bear'))
  const opening = Promise.withResolvers(), closing = Promise.withResolvers()
  host.bridge.audioControl = t.mock.fn(enabled => enabled ? opening.promise : closing.promise)
  const voice = createVoiceControl({ names: () => [], transcribe: t.mock.fn(), resolve: t.mock.fn() })
  const answer = 'The Toy Bear floor rose.'
  const page = { key: 'gifti-recording', title: 'Ask Gifti', lines: [answer, 'Listening for your question.'],
    actions: [{ id: 'show-chart', label: 'Show chart' }] }
  const tools = { getActiveTool: () => 'gifti', getSnapshot: () => page, close() {} }
  const session = await host.start(voice, { getTools: () => tools })
  const capture = voice.controls.recordQuestion(new AbortController().signal)
  t.after(async () => {
    opening.resolve(true)
    closing.resolve(true)
    await Promise.allSettled([capture, session.stop()])
  })
  const checkPhase = (status, listening) => {
    const layout = lastArg(host.bridge.rebuildPageContainer)
    const content = layout.textObject[0].content
    assert.ok(content.includes(answer))
    assert.ok(content.includes(status))
    assert.equal(content.includes('Listening for your follow-up'), listening)
    assert.equal(content.includes('Finish recording'), listening)
    const items = layout.menuObject.menuItems
    assert.ok(items.some(item => item.itemName === 'Show chart'))
    const finish = items.find(item => item.itemName === 'Finish recording')
    assert.equal(Boolean(finish), listening)
    return finish
  }
  await settle()
  checkPhase('Opening glasses microphone', false)
  opening.resolve(true)
  await settle()
  const finish = checkPhase('Listening for your follow-up', true)
  const pcm = new Uint8Array(Int16Array.from({ length: 3200 }, (_, i) => i % 2 ? 1400 : -1400).buffer)
  voice.receive(pcm)
  host.input(menuSelection(finish.itemID))
  await settle()
  checkPhase('Closing glasses microphone', false)
  closing.resolve(true)
  assert.deepEqual(await capture, pcm)
})

test('Gifti owns the microphone across tool pages, stale native menus and programmatic command starts', async t => {
  const card = ready('Toy Bear'), host = display(t, card)
  const microphone = host.bridge.audioControl = t.mock.fn(async () => true)
  const voice = createVoiceControl({ names: () => [], transcribe: t.mock.fn(), resolve: t.mock.fn() })
  // Keep even the same page object during an ownership change. The title and key are opaque to the arbiter.
  const page = { key: 'reading', title: 'Reply', lines: [], actions: [] }
  let owner = 'research'
  const tools = { getSnapshot: () => page, getActiveTool: () => owner, close() {} }
  const session = await host.start(voice, { getTools: () => tools })
  function menuItems() {
    const layout = lastArg(host.bridge.rebuildPageContainer) ?? lastArg(host.bridge.createStartUpPageContainer)
    return layout.menuObject.menuItems
  }
  function commandItem() { return menuItems().find(item => item.itemName === 'Voice command') }
  t.after(() => session.stop())
  const old = commandItem().itemID
  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  owner = 'gifti'
  host.show(card)
  await settle()
  host.input(menuSelection(old))
  voice.controls.start()
  voice.controls.start('phone')
  await settle()
  assert.equal(microphone.mock.callCount(), 0)
  pending.resolve(true)
  await settle()
  assert.equal(commandItem(), undefined)
  host.input(menuSelection(old))
  assert.equal(voice.controls.getSnapshot().phase, 'idle')
  owner = 'research'
  host.show(card)
  await settle()
  const fresh = commandItem().itemID
  assert.notEqual(fresh, old)
  host.input(menuSelection(old))
  assert.equal(microphone.mock.callCount(), 0)
  host.input(menuSelection(fresh))
  await settle()
  assert.deepEqual(microphone.mock.calls.map(c => c.arguments), [[true, 'glasses']])
  owner = 'gifti'
  host.show(card)
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'idle')
  assert.deepEqual(microphone.mock.calls.at(-1).arguments, [false, 'glasses'])
  assert.equal(commandItem(), undefined)
})

test('native and Explore menus start glasses-only voice and Back restores the card without applying stale input', async t => {
  const host = display(t, ready('Toy Bear'))
  const mic = host.bridge.audioControl = t.mock.fn(async () => true)
  let clock = 0
  const pending = Promise.withResolvers()
  const transcribe = t.mock.fn(() => pending.promise), run = t.mock.fn(() => true)
  const voice = createVoiceControl({ names: () => ['Toy Bear'], transcribe, now: () => clock,
    resolve: () => ({ kind: 'action', label: 'Toy Bear', confirm: false, run }) })
  const session = await host.start(voice)
  t.after(() => session.stop())
  const [{ itemID, itemName }] = lastArg(host.bridge.createStartUpPageContainer).menuObject.menuItems
  assert.equal(itemName, 'Voice command')
  assert.equal(mic.mock.callCount(), 0)
  const menuEvent = evenHubEventFromJson({ type: 'menuItemClickEvent', jsonData: { itemID } })
  host.input(menuEvent)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Listening/)
  assert.deepEqual(mic.mock.calls[0].arguments, [true, 'glasses'])
  const voiced = Int16Array.from({ length: 4800 }, (_, i) => i % 2 ? 1200 : -1200)
  const pcm = [...new Uint8Array(voiced.buffer)]
  const audio = (source, speakerRole) => evenHubEventFromJson({ type: 'audioEvent', jsonData: { audioPcm: pcm, source, speakerRole } })
  host.input(audio('phone', 'self'))
  host.input(click)
  assert.equal(voice.controls.getSnapshot().phase, 'listening')
  host.input(menuSelection(lastArg(host.bridge.rebuildPageContainer).menuObject.menuItems[0].itemID))
  await settle()
  assert.match(rebuiltText(host.bridge).content, /No speech heard/)
  assert.equal(transcribe.mock.callCount(), 0)
  host.input(click)
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'error')
  const retryItem = lastArg(host.bridge.rebuildPageContainer).menuObject.menuItems[0]
  assert.equal(retryItem.itemName, 'Retry voice')
  host.input(menuSelection(retryItem.itemID))
  await t.waitFor(() => assert.equal(voice.controls.getSnapshot().phase, 'listening'))
  await settle()
  clock += 300
  host.input(audio('glasses', 'other'))
  host.input(textEvent({ containerID: rebuiltText(host.bridge).containerID }))
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Recognizing command/)
  host.input({ sysEvent: doubleTap })
  await settle()
  pending.resolve('save this gift')
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Tap for details/)
  assert.equal(run.mock.callCount(), 0)
  host.input({ sysEvent: doubleTap })
  await settle()
  for (let i = 0; i < 2; i++) { host.input(swipeDown); await settle() }
  assert.match(rebuiltText(host.bridge).content, /> Voice command/)
  host.input(click)
  await t.waitFor(() => assert.equal(voice.controls.getSnapshot().phase, 'listening'))
  host.input({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'idle')
  assert.deepEqual(mic.mock.calls.at(-1).arguments, [false, 'glasses'])
  host.input(menuEvent)
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'idle')
  assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 0)
})

test('a queued menu entry or Finish tap cannot start a different recording or confirm a save', async t => {
  const host = display(t, ready('Toy Bear'))
  const mic = host.bridge.audioControl = t.mock.fn(async () => true)
  const save = t.mock.fn(() => true)
  let clock = 0
  const voice = createVoiceControl({
    names: () => ['Crystal Ball'], transcribe: async () => 'save this gift', now: () => clock,
    resolve: () => ({ kind: 'action', label: 'Save Crystal Ball', confirm: true, run: save }),
  })
  const session = await host.start(voice)
  t.after(() => session.stop())
  const oldItem = lastArg(host.bridge.createStartUpPageContainer).menuObject.menuItems[0]
  host.show(ready('Crystal Ball'))
  await settle()
  host.input(menuSelection(oldItem.itemID))
  assert.equal(mic.mock.callCount(), 0)
  const item = () => lastArg(host.bridge.rebuildPageContainer).menuObject.menuItems[0]
  const retired = rebuiltText(host.bridge)
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }))
  host.input(menuSelection(item().itemID))
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
  await settle()
  for (const address of [{ containerID: retired.containerID }, { containerName: retired.containerName }]) {
    host.input(textEvent({ ...address, eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }))
  }
  assert.equal(voice.controls.getSnapshot().phase, 'listening')
  const finish = item()
  assert.equal(finish.itemName, 'Finish recording')
  const delayedTap = textEvent({ containerID: rebuiltText(host.bridge).containerID })
  const pcm = new Int16Array(20_000)
  for (let i = 0; i < 5000; i++) pcm[i] = i % 2 ? 1400 : -1400
  clock += pcm.length / 16
  host.input({ audioEvent: { source: 'glasses', audioPcm: new Uint8Array(pcm.buffer) } })
  await settle()
  const confirm = item()
  assert.equal(confirm.itemName, 'Confirm save')
  host.input(sysEvent({ eventType: OsEventTypeList.CLICK_EVENT }))
  host.input(click)
  host.input(delayedTap)
  host.input(menuSelection(finish.itemID))
  assert.equal(save.mock.callCount(), 0)
  host.input(menuSelection(confirm.itemID))
  host.input(menuSelection(confirm.itemID))
  assert.equal(save.mock.callCount(), 1)
})

test('foregrounding the same gift requires a new voice menu selection', async t => {
  const host = display(t, ready('Toy Bear'))
  const mic = host.bridge.audioControl = t.mock.fn(async () => true)
  const voice = createVoiceControl({ names: () => [], resolve: () => ({ kind: 'unknown' }), transcribe: async () => null })
  const session = await host.start(voice)
  t.after(() => session.stop())
  const oldMenu = lastArg(host.bridge.createStartUpPageContainer).menuObject.menuItems[0]
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }))
  host.input(sysEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }))
  host.input(menuSelection(oldMenu.itemID))
  await settle()
  const nextMenu = lastArg(host.bridge.rebuildPageContainer).menuObject.menuItems[0]
  assert.notEqual(nextMenu.itemID, oldMenu.itemID)
  host.input(menuSelection(oldMenu.itemID))
  assert.equal(mic.mock.callCount(), 0)
  host.input(menuSelection(nextMenu.itemID))
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'listening')
})

function serveBundledArtwork(t) {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.match(url.pathname, /\/assets\/plush-pepe-g2\.png$/)
    return new Response(bundled)
  })
}

test('a WebView reload reuses a surviving page and reports genuine startup failures', async t => {
  const host = display(t, { status: 'waiting' })
  host.bridge.createStartUpPageContainer.mock.mockImplementationOnce(async () => 1)
  const first = await host.start()
  assert.equal(host.bridge.rebuildPageContainer.mock.callCount(), 1)
  await first.stop()
  const fresh = display(t, { status: 'waiting' })
  fresh.bridge.createStartUpPageContainer.mock.mockImplementationOnce(async () => 2)
  await assert.rejects(fresh.start(), /page creation returned 2/)
  assert.equal(fresh.listening(), false)
  assert.equal(fresh.bridge.rebuildPageContainer.mock.callCount(), 0)
})

test('display recovery keeps browsing and exit usable without enabling the glasses microphone', async t => {
  for (const invalid of [true, false]) await t.test(invalid ? 'invalid create' : 'unconfirmed create', async t => {
    const host = display(t, ready('Toy Bear'))
    const mic = host.bridge.audioControl = t.mock.fn(async () => true)
    const voice = createVoiceControl({ names: () => [], resolve: () => ({ kind: 'unknown' }), transcribe: async () => null })
    const bind = t.mock.method(voice, 'bind')
    host.bridge.createStartUpPageContainer.mock.mockImplementationOnce(async () => {
      if (invalid) return 1
      throw Error('lost startup acknowledgment')
    })
    if (!invalid) await assert.rejects(host.start(voice), /lost startup acknowledgment/)
    const recovered = await host.start(voice)
    const menuItems = () => lastArg(host.bridge.rebuildPageContainer).menuObject?.menuItems ?? []
    assert.ok(!menuItems().some(item => item.itemName === 'Voice command'))
    const stale = lastArg(host.bridge.createStartUpPageContainer).menuObject.menuItems[0]
    host.input(menuSelection(stale.itemID))
    voice.controls.start()
    host.input(swipeDown)
    assert.equal(host.move.mock.callCount(), 1)
    host.input({ sysEvent: doubleTap })
    await settle()
    assert.match(rebuiltText(host.bridge).content, /Voice unavailable.*relaunch TeleGifts in the Even app/)
    assert.doesNotMatch(rebuiltText(host.bridge).content, /Voice command/)
    for (let i = 0; i < 2; i++) { host.input(swipeDown); await settle() }
    assert.match(rebuiltText(host.bridge).content, /> Exit TeleGifts/)
    host.input(click)
    await settle()
    assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 1)
    await recovered.stop()
    const reopened = await host.start(voice)
    t.after(() => reopened.stop())
    voice.controls.start()
    assert.equal(voice.controls.getSnapshot().phase, 'offline')
    assert.equal(bind.mock.callCount(), 0)
    assert.equal(mic.mock.callCount(), 0)
    assert.equal(host.bridge.createStartUpPageContainer.mock.callCount(), 1)
    assert.ok(!menuItems().some(item => item.itemName === 'Voice command'))
  })
})

test('only a confirmed startup on this audio-capable bridge binds voice, including on reopen', async t => {
  const host = display(t, ready('Toy Bear'))
  const mic = host.bridge.audioControl = t.mock.fn(async () => true)
  const voice = createVoiceControl({ names: () => [], resolve: () => ({ kind: 'unknown' }), transcribe: async () => null })
  const creation = Promise.withResolvers()
  host.bridge.createStartUpPageContainer.mock.mockImplementationOnce(() => creation.promise)
  const opening = host.start(voice)
  await settle()
  voice.controls.start()
  assert.equal(voice.controls.getSnapshot().phase, 'offline')
  assert.equal(mic.mock.callCount(), 0)
  creation.resolve(0)
  const first = await opening
  await first.stop()
  const second = await host.start(voice)
  voice.controls.start()
  await settle()
  assert.equal(voice.controls.getSnapshot().phase, 'listening')
  assert.deepEqual(mic.mock.calls[0].arguments, [true, 'glasses'])
  assert.equal(host.bridge.createStartUpPageContainer.mock.callCount(), 1)
  await second.stop()

  const other = display(t, ready('Toy Bear'))
  const silent = await other.start(voice)
  t.after(() => silent.stop())
  voice.controls.start()
  assert.equal(voice.controls.getSnapshot().phase, 'offline')
  assert.equal(lastArg(other.bridge.createStartUpPageContainer).menuObject, undefined)
  other.input({ sysEvent: doubleTap })
  await settle()
  assert.match(rebuiltText(other.bridge).content, /microphone unavailable on this host/)
})

test('a browse tap delivered after a different detail is acknowledged cannot save that gift', async t => {
  const host = display(t, ready('Toy Bear')), { bridge } = host
  await host.start()
  const toy = lastArg(bridge.createStartUpPageContainer).textObject[0]
  const delayed = textEvent({ Container_ID: toy.containerID, Container_Name: toy.containerName, Event_Type: 0 })
  const rose = ready('Rose', true)
  host.show(rose)
  await settle()
  host.input(delayed)
  assert.equal(host.tap.mock.callCount(), 0)
  const save = rebuiltText(bridge)
  assert.match(save.content, /Rose[\s\S]*Tap to add to Favorites/)
  assert.notEqual(toy.containerID, save.containerID)
  assert.notEqual(toy.containerName, save.containerName)
  for (const target of [
    { Container_ID: toy.containerID }, { Container_Name: toy.containerName },
    { Container_ID: save.containerID, Container_Name: toy.containerName },
    { Container_ID: toy.containerID, Container_Name: save.containerName },
    { Container_ID: null }, { Container_Name: null },
  ]) host.input({ ...textEvent(target), sysEvent: {} })
  assert.equal(host.tap.mock.callCount(), 0)
  // Either identifier alone can address the current text container. Protobuf omits click zero.
  host.input(textEvent({ Container_ID: save.containerID }))
  host.input(textEvent({ Container_Name: save.containerName }))
  assert.equal(host.tap.mock.callCount(), 2)
})

test('a quote refresh keeps its capture target while an action change, rollback or reopen retires it', async t => {
  const rose = ready('Rose', true), host = display(t, rose), { bridge } = host
  const session = await host.start()
  const save = lastArg(bridge.createStartUpPageContainer).textObject[0]
  const originalSave = textEvent({ containerID: save.containerID, containerName: save.containerName })
  host.show({ ...rose, usdtPerGram: 3 })
  await settle()
  assert.equal(bridge.rebuildPageContainer.mock.callCount(), 0)
  assert.equal(lastArg(bridge.textContainerUpgrade).containerID, save.containerID)
  host.input(originalSave)
  assert.equal(host.tap.mock.callCount(), 1)
  host.show({ ...rose, saved: true })
  await settle()
  host.input(originalSave)
  host.show(rose)
  await settle()
  host.input(originalSave)
  assert.equal(host.tap.mock.callCount(), 1)
  const restored = rebuiltText(bridge)
  host.input(textEvent({ Container_ID: restored.containerID }))
  assert.equal(host.tap.mock.callCount(), 2)
  await session.stop()
  await host.start()
  host.input(textEvent({ Container_Name: restored.containerName }))
  assert.equal(host.tap.mock.callCount(), 2)
})

test('explicit unknown native event types cannot save or exit while omitted click zero still works', async t => {
  const host = display(t, ready('Toy Bear', true))
  await host.start()
  const unknown = sysEvent({ eventType: 11 })
  assert.equal(unknown.sysEvent.eventType, undefined)
  assert.equal(unknown.jsonData.eventType, 11)
  const invalid = [unknown, textEvent({ Event_Type: 'NO_OP' }), sysEvent({ event_type: null }),
    sysEvent({ Event__Type: 11 }), textEvent({ eve_nt_t_ype: 'NO_OP' })]
  for (const event of invalid) host.input(event)
  host.input({ sysEvent: { eventType: OsEventTypeList.IMU_DATA_REPORT }, textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 0)
  host.input(sysEvent({}))
  assert.equal(host.tap.mock.callCount(), 1)

  host.show(ready('Toy Bear'))
  await settle()
  for (const event of [{ sysEvent: doubleTap }, swipeDown, swipeDown]) {
    host.input(event)
    await settle()
  }
  for (const event of invalid) host.input(event)
  assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 0)
  host.input(textEvent({}))
  assert.deepEqual(host.bridge.shutDownPageContainer.mock.calls.map(call => call.arguments), [[1]])
})

test('native exit wins over a late create or reuse acknowledgment and leaves no gesture listener', async t => {
  for (const operation of ['create', 'refused create', 'reuse']) {
    const host = display(t, ready('Toy Bear', true)), { bridge } = host
    const native = Promise.withResolvers()
    if (operation !== 'reuse') bridge.createStartUpPageContainer.mock.mockImplementationOnce(() => native.promise)
    else {
      bridge.createStartUpPageContainer.mock.mockImplementationOnce(async () => 1)
      bridge.rebuildPageContainer.mock.mockImplementationOnce(() => native.promise)
    }
    const starting = host.start()
    await settle()
    host.input(sysEvent({}))
    assert.equal(host.tap.mock.callCount(), 0)
    const exit = sysEvent({ Event_Type: operation === 'reuse' ? 'ABNORMAL_EXIT_EVENT' : 'SYSTEM_EXIT_EVENT' })
    host.input({ ...exit, textEvent: { containerID: 99 } })
    host.input(exit)
    assert.equal(host.onClosed.mock.callCount(), 1)
    assert.equal(host.listening(), false)
    const session = await starting
    let drained = false
    const drain = session.stop().then(() => { drained = true })
    await settle()
    assert.equal(drained, false)
    if (operation === 'reuse') native.reject(new Error('lost reuse acknowledgment'))
    else native.resolve(operation === 'create' ? 0 : 1)
    await drain
    session.update()
    host.input(sysEvent({}))
    await settle()
    assert.equal(host.tap.mock.callCount(), 0)
    assert.equal(host.listening(), false)
    assert.equal(host.feedback.mock.callCount(), 0)
    assert.equal(bridge.rebuildPageContainer.mock.callCount(), operation === 'reuse' ? 1 : 0)
  }
})

test('an exit replayed while subscribing skips native create and detaches the listener', async t => {
  const host = display(t, ready('Toy Bear', true)), { bridge } = host
  const unsubscribe = t.mock.fn()
  bridge.onEvenHubEvent = listener => {
    listener(sysEvent({ Event_Type: 'SYSTEM_EXIT_EVENT' }))
    return unsubscribe
  }
  const session = await host.start()
  session.update()
  await session.stop()
  assert.equal(bridge.createStartUpPageContainer.mock.callCount(), 0)
  assert.equal(host.onClosed.mock.callCount(), 1)
  assert.equal(unsubscribe.mock.callCount(), 1)
})

test('onboarding has no catalog actions, and an unpriced detail recovers an unacknowledged return', async t => {
  t.mock.method(console, 'warn', () => {})
  const host = display(t, { status: 'waiting' }, async () => { throw new Error('missing artwork') })
  const { bridge } = host
  await host.start()
  const startup = lastArg(bridge.createStartUpPageContainer)
  assert.match(startup.textObject[0].content, /Open TeleGifts on your phone/)
  assert.equal(startup.textObject[0].isEventCapture, 1)
  host.input({ textEvent: {} })
  host.input({ sysEvent: doubleTap })
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(host.back.mock.callCount(), 0)
  await settle()
  assert.match(rebuiltText(bridge).content, /> Continue setup on phone/)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)

  host.show({ status: 'unpriced', name: 'Toy Bear', detail: true })
  await settle()
  assert.match(rebuiltText(bridge).content, /Toy Bear[\s\S]*Floor unavailable[\s\S]*Double-tap/)
  bridge.rebuildPageContainer.mock.mockImplementationOnce(async () => false)
  host.show(ready('Toy Bear'))
  await settle()
  assert.equal(lastArg(host.feedback), true)
  host.input({ textEvent: doubleTap })
  await settle()
  assert.equal(host.back.mock.callCount(), 0)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
  assert.match(rebuiltText(bridge).content, /Tap for details/)
  assert.equal(lastArg(host.feedback), false)

  host.input({ audioEvent: {} })
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 1)
  host.input({ sysEvent: doubleTap })
  await settle()
  assert.match(rebuiltText(bridge).content, /TeleGifts menu[\s\S]*> Explore gifts/)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
})

test('double-click and the default menu choice keep every Explore state visible and interactive', async t => {
  const host = display(t, ready('Toy Bear'))
  await host.start()
  const text = () => rebuiltText(host.bridge).content
  const double = { sysEvent: doubleTap, textEvent: {} }
  for (const screen of [ready('Toy Bear'), ...['loading', 'empty', 'error', 'noMatches', 'rankingLoading', 'rankingError']
    .map(status => ({ status, section: 'explore' }))]) {
    host.show(screen)
    await settle()
    host.input(double)
    await settle()
    assert.match(text(), /TeleGifts menu[\s\S]*> Explore gifts[\s\S]*Exit TeleGifts/)
    host.input(double)
    await settle()
    assert.match(text(), /Explore Gifts[\s\S]*Double-tap for menu/)
    host.input(double)
    await settle()
    host.input(click)
    await settle()
    assert.match(text(), /Explore Gifts[\s\S]*Double-tap for menu/)
  }
  assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 0)
  assert.equal(host.tap.mock.callCount(), 0)
  host.show(ready('Toy Bear'))
  await settle()
  host.input(click)
  assert.equal(host.tap.mock.callCount(), 1)
  host.back.mock.mockImplementationOnce(() => true) // A sheet owned by the phone takes precedence.
  host.input(double)
  await settle()
  assert.match(text(), /Toy Bear/)
  host.input(double)
  await settle()
  host.input(swipeDown)
  await settle()
  assert.match(text(), /> Favorites/)
  host.input(click)
  assert.equal(host.openFavorites.mock.callCount(), 1)
})

test('only an acknowledged Exit selection requests the system dialog and a rejected exit leaves Back usable', async t => {
  const host = display(t, ready('Toy Bear'))
  await host.start()
  const { bridge } = host
  host.input({ textEvent: doubleTap })
  await settle()
  host.input(swipeDown)
  await settle()
  const favorites = rebuiltText(bridge)
  const writing = Promise.withResolvers()
  bridge.rebuildPageContainer.mock.mockImplementationOnce(() => writing.promise)
  host.input(swipeDown)
  await settle()
  host.input(click)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
  writing.resolve(true)
  await settle()
  assert.match(rebuiltText(bridge).content, /> Exit TeleGifts/)
  host.input(textEvent({ Container_ID: favorites.containerID, Container_Name: favorites.containerName }))
  host.input({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }, textEvent: {} })
  host.input(click)
  host.input(sysEvent({}))
  host.input({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }, textEvent: {} })
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
  const exiting = Promise.withResolvers()
  bridge.shutDownPageContainer.mock.mockImplementationOnce(() => exiting.promise)
  host.input(click)
  host.input(click)
  assert.deepEqual(bridge.shutDownPageContainer.mock.calls.map(call => call.arguments), [[1]])
  exiting.resolve(false)
  await settle()
  assert.equal(lastArg(host.feedback), true)
  host.input({ textEvent: doubleTap })
  await settle()
  assert.match(rebuiltText(bridge).content, /Toy Bear[\s\S]*Tap for details/)
  host.input(click)
  assert.equal(host.tap.mock.callCount(), 1)
})

test('bundled art retries a rejected upload; a rejected page rebuild preserves the acknowledged detail', async t => {
  serveBundledArtwork(t)
  t.mock.method(console, 'warn', () => {})
  const load = t.mock.fn(async () => null)
  const host = display(t, ready('Plush Pepe', true), load)
  const { bridge } = host
  bridge.updateImageRawData.mock.mockImplementationOnce(async () => 'imageToGray4Failed')
  await host.start()
  assert.equal(load.mock.callCount(), 0)
  const page = lastArg(bridge.rebuildPageContainer)
  assert.match(page.textObject[0].content, /42.5 GRAM[\s\S]*Portals[\s\S]*Collection updated/)
  assert.equal(page.textObject[0].isEventCapture, 1)
  assert.equal(page.containerTotalNum, 2)
  const slot = page.imageObject[0]
  assert.deepEqual([slot.width, slot.height], [120, 120])
  const upload = lastArg(bridge.updateImageRawData)
  assert.equal(upload.containerID, slot.containerID)
  assert.equal(upload.containerName, slot.containerName)
  assert.deepEqual(Buffer.from(upload.imageData), bundled)
  assert.equal(lastArg(host.feedback), true)
  host.show(ready('Plush Pepe', true))
  await settle()
  assert.equal(bridge.updateImageRawData.mock.callCount(), 2)
  assert.equal(lastArg(host.feedback), false)

  bridge.rebuildPageContainer.mock.mockImplementationOnce(async () => false)
  host.show(ready('Heart Locket'))
  await settle()
  assert.equal(lastArg(host.feedback), true)
  host.input({ sysEvent: doubleTap })
  await settle()
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
  const recovered = lastArg(bridge.rebuildPageContainer)
  assert.deepEqual(recovered.imageObject, [])
  assert.match(recovered.textObject[0].content, /Heart Locket[\s\S]*42.5 GRAM/)
  assert.equal(recovered.textObject[0].isEventCapture, 1)
  assert.equal(lastArg(host.feedback), false)
})

test('a pending return consumes Back without closing another phone sheet or exiting', async t => {
  const host = display(t, ready('Toy Bear', true))
  const { bridge } = host
  await host.start()
  const returned = Promise.withResolvers()
  bridge.rebuildPageContainer.mock.mockImplementationOnce(() => returned.promise)
  host.show({ status: 'loading' })
  await settle()
  host.input({ sysEvent: doubleTap })
  assert.equal(host.back.mock.callCount(), 0)
  assert.equal(bridge.shutDownPageContainer.mock.callCount(), 0)
  returned.resolve(true)
  host.show({ status: 'error' })
  await settle()
  assert.match(rebuiltText(bridge).content, /Tap to retry/)
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 1)
  host.input({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } })
  host.show(ready('Toy Bear'))
  host.input({ sysEvent: {} })
  await settle()
  assert.match(rebuiltText(bridge).content, /Tap to retry/)
  assert.equal(host.tap.mock.callCount(), 1)
})

test('rapid selection retires the old frame, fits the newest blob, and ignores a late artwork response', async t => {
  serveBundledArtwork(t)
  const draw = t.mock.fn()
  const encoded = Uint8Array.of(1, 2, 3)
  globalThis.Image = class { naturalWidth = 600; naturalHeight = 300; async decode() {} }
  globalThis.document = {
    createElement() {
      return {
        getContext: () => ({ fillRect() {}, drawImage: draw }),
        toBlob(callback, type) {
          assert.deepEqual([this.width, this.height, type], [120, 120, 'image/png'])
          callback(new Blob([encoded], { type }))
        },
      }
    },
  }
  t.after(() => { delete globalThis.Image; delete globalThis.document })
  const late = Promise.withResolvers()
  const slowSend = Promise.withResolvers()
  const host = display(t, ready('Plush Pepe'), name => name === 'Late' ? late.promise : Promise.resolve(new Blob(['gift'])))
  const { bridge } = host
  bridge.updateImageRawData.mock.mockImplementationOnce(() => slowSend.promise)
  await host.start()
  host.show(ready('Late'))
  host.show(ready('Latest', true))
  await settle()
  assert.equal(bridge.updateImageRawData.mock.callCount(), 1)
  assert.equal(bridge.rebuildPageContainer.mock.callCount(), 1)
  slowSend.resolve('success')
  await settle()
  const pages = bridge.rebuildPageContainer.mock.calls.map(call => call.arguments[0])
  assert.deepEqual(pages.map(page => page.imageObject.length), [1, 0, 1])
  assert.match(pages[1].textObject[0].content, /Latest/)
  assert.match(pages[2].textObject[0].content, /Latest/)
  assert.deepEqual(draw.mock.calls[0].arguments.slice(1), [0, 30, 120, 60])
  assert.deepEqual(lastArg(bridge.updateImageRawData).imageData, encoded)
  late.resolve(new Blob(['obsolete']))
  host.show(ready('Latest'))
  await settle()
  assert.equal(draw.mock.callCount(), 1)
  // The fresh event target has a new layout, so re-upload the already fitted bitmap.
  const uploads = bridge.updateImageRawData.mock.calls.map(call => call.arguments[0].imageData)
  assert.deepEqual(uploads, [new Uint8Array(bundled), encoded, encoded])
  assert.match(rebuiltText(bridge).content, /Tap for details/)
})

test('dispatches scroll and hold once and waits for the displayed Save action to match the phone', async t => {
  const host = display(t, ready('Toy Bear'))
  await host.start()
  host.input({ textEvent: {}, sysEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
  host.input({ textEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } })
  host.input({ sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } })
  host.input({ sysEvent: {}, textEvent: { eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT } })
  assert.deepEqual(host.move.mock.calls.map(call => call.arguments), [[1], [-1]])
  assert.equal(host.openFavorites.mock.callCount(), 1)
  assert.equal(host.tap.mock.callCount(), 0)
  host.show(ready('Toy Bear', true))
  await settle()
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 1)
  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  host.show({ ...ready('Toy Bear', true), saved: true })
  await settle()
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 1)
  pending.resolve(true)
  await settle()
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 2)
})

test('an in-flight Remove label cannot trigger Save when the phone reverts before acknowledgment', async t => {
  const unsaved = ready('Toy Bear', true)
  const host = display(t, unsaved)
  await host.start()
  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  host.show({ ...unsaved, saved: true })
  await settle()
  host.show(unsaved)
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 0)
  pending.resolve(true)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Tap to add to Favorites/)
  host.input({ textEvent: {} })
  assert.equal(host.tap.mock.callCount(), 1)
})

test('swipe, hold and Back act only when the displayed and current cards agree', async t => {
  const host = display(t, ready('Toy Bear'))
  await host.start()
  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  host.show(ready('Heart Locket'))
  await settle()
  const swipe = { sysEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } }
  const hold = { sysEvent: { eventType: OsEventTypeList.LONG_PRESS_EVENT } }
  host.input(swipe)
  host.show(ready('Toy Bear'))
  host.input(swipe)
  host.input(hold)
  host.input({ sysEvent: doubleTap })
  assert.equal(host.move.mock.callCount(), 0)
  assert.equal(host.openFavorites.mock.callCount(), 0)
  assert.equal(host.back.mock.callCount(), 0)
  assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 0)
  pending.resolve(true)
  await settle()
  host.input(swipe)
  host.input(hold)
  host.input({ sysEvent: doubleTap })
  assert.equal(host.move.mock.callCount(), 1)
  assert.equal(host.openFavorites.mock.callCount(), 1)
  assert.equal(host.back.mock.callCount(), 1)
})

test('a swipe waits for the updated position even when the collection ID stays the same', async t => {
  const card = { ...ready('Toy Bear'), total: 2 }
  const host = display(t, card)
  await host.start()
  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  host.show({ ...card, position: 2 })
  await settle()
  const previous = { sysEvent: { eventType: OsEventTypeList.SCROLL_TOP_EVENT } }
  host.input(previous)
  assert.equal(host.move.mock.callCount(), 0)
  pending.resolve(true)
  await settle()
  host.input(previous)
  assert.deepEqual(host.move.mock.calls[0].arguments, [-1])
})

test('market cards use the selected period and convert the price actually shown on each screen', async t => {
  const card = { ...ready('Toy Bear'), ranking: { period: '24h', filter: 'losers' }, usdtPerGram: 2,
    observation: { price: 40, period: '24h', changePercent: -3.25, stale: false } }
  const host = display(t, card)
  await host.start()
  const initial = lastArg(host.bridge.createStartUpPageContainer).textObject[0].content
  assert.match(initial, /24h Losers[\s\S]*40 GRAM\n≈ 80\.00 USDT\n24h floor change -3\.25%/)
  host.show({ ...card, detail: true })
  await settle()
  const detail = rebuiltText(host.bridge).content
  assert.match(detail, /Listing floor: 42.5 GRAM\n≈ 85.00 USDT/)
  assert.match(detail, /Marketplace: Portals/)
  host.show({ ...card, usdtPerGram: null, observation: { ...card.observation, period: '7d', changePercent: null, stale: true } })
  await settle()
  const missing = rebuiltText(host.bridge).content
  assert.match(missing, /7d floor change — \(cached\)/)
  assert.doesNotMatch(missing, /USDT|0\.00%/)
  host.show({ ...card, observation: { ...card.observation, changePercent: 0 } })
  await settle()
  assert.match(lastArg(host.bridge.textContainerUpgrade).content, /24h floor change \+0\.00%/)
})

test('detail gestures inspect artwork and collection history without saving or dismissing the phone sheet', async t => {
  const detail = ready('Toy Bear', true)
  const host = display(t, detail)
  await host.start()
  host.input(swipeUp)
  host.input(swipeDown)
  assert.deepEqual(host.inspector.show.mock.calls.map(call => call.arguments), [['preview'], ['chart']])

  const frame = Uint8Array.of(8, 5, 1)
  host.show(inspected(detail, { mode: 'preview', status: 'ready', model: 'Blue', kind: 'relief',
    angle: 25, frame, canNext: true, canPrevious: true }, true))
  await settle()
  const large = lastArg(host.bridge.rebuildPageContainer)
  assert.deepEqual([large.imageObject[0].width, large.imageObject[0].height], [256, 144])
  assert.match(large.textObject[0].content, /Blue\nToy Bear\nArtwork relief\n/)
  assert.match(large.textObject[0].content, /Double-tap for models/)
  assert.doesNotMatch(large.textObject[0].content, /°/)
  assert.deepEqual(lastArg(host.bridge.updateImageRawData).imageData, frame)
  host.input(swipeUp)
  assert.deepEqual(host.inspector.step.mock.calls[0].arguments, [-1, frame])
  host.input({ textEvent: {} })
  assert.deepEqual(host.inspector.show.mock.calls.at(-1).arguments, ['chart'])
  host.input({ sysEvent: doubleTap })
  assert.equal(host.back.mock.callCount(), 1)
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(host.inspector.back.mock.callCount(), 0)

  host.show(inspected(detail, { mode: 'chart', range: '7d', status: 'empty' }))
  await settle()
  assert.match(lastArg(host.bridge.rebuildPageContainer).textObject[0].content, /Collection floor · 7d[\s\S]*No floor observations/)
  assert.equal(lastArg(host.bridge.rebuildPageContainer).imageObject.length, 0)
  host.input({ textEvent: {} })
  assert.equal(host.inspector.retry.mock.callCount(), 1)
})

test('a failed rotation retries the same labeled bitmap and takes the next swipe only after native acceptance', async t => {
  t.mock.method(console, 'warn', () => {})
  const card = ready('Algorithm Cup', true)
  const first = cupAt(card, 0, Uint8Array.of(1)), next = cupAt(card, 45, Uint8Array.of(2))
  const host = display(t, first)
  await host.start()
  host.bridge.updateImageRawData.mock.mockImplementationOnce(async () => 'sendFailed')
  host.show(next)
  await settle()
  assert.equal(lastArg(host.feedback), true)
  const retry = Promise.withResolvers()
  host.bridge.updateImageRawData.mock.mockImplementationOnce(() => retry.promise)
  host.input(swipeDown)
  await settle()
  host.input(swipeUp)
  assert.equal(host.inspector.step.mock.callCount(), 0)
  assert.deepEqual(host.bridge.updateImageRawData.mock.calls.map(c => c.arguments[0].imageData),
    [first.inspection.frame, next.inspection.frame, next.inspection.frame])
  retry.resolve('success')
  await settle()
  assert.equal(lastArg(host.feedback), false)
  assert.equal(host.bridge.textContainerUpgrade.mock.callCount(), 0)
  assert.equal(host.bridge.rebuildPageContainer.mock.callCount(), 1)
  const caption = lastArg(host.bridge.rebuildPageContainer).textObject[0].content
  assert.match(caption, /3D model\n/)
  assert.doesNotMatch(caption, /°/)
  host.input(swipeDown)
  assert.deepEqual(host.inspector.step.mock.calls.map(c => c.arguments), [[1, next.inspection.frame]])
})

test('swipes wait for the first native frame and for a late rotation to be replaced after the phone reverts', async t => {
  const card = ready('Algorithm Cup', true)
  const first = cupAt(card, 0, Uint8Array.of(1)), second = cupAt(card, 45, Uint8Array.of(2))
  const host = display(t, first), send = host.bridge.updateImageRawData
  const startup = Promise.withResolvers(), turning = Promise.withResolvers(), restoring = Promise.withResolvers()
  send.mock.mockImplementationOnce(() => startup.promise)
  await host.start()
  host.input(swipeDown)
  assert.equal(host.inspector.step.mock.callCount(), 0)
  startup.resolve('success')
  await settle()
  host.input(swipeDown)
  assert.deepEqual(host.inspector.step.mock.calls[0].arguments, [1, first.inspection.frame])

  send.mock.mockImplementationOnce(() => turning.promise)
  host.show(second)
  await settle()
  host.input(swipeDown)
  host.show(first)
  host.input(swipeDown)
  assert.equal(host.inspector.step.mock.callCount(), 1)
  assert.equal(send.mock.callCount(), 2)
  send.mock.mockImplementationOnce(() => restoring.promise)
  turning.resolve('success')
  await settle()
  assert.strictEqual(lastArg(send).imageData, first.inspection.frame)
  host.input(swipeUp)
  assert.equal(host.inspector.step.mock.callCount(), 1)
  restoring.resolve('success')
  await settle()
  host.input(swipeUp)
  assert.deepEqual(host.inspector.step.mock.calls[1].arguments, [-1, first.inspection.frame])
  assert.equal(host.bridge.textContainerUpgrade.mock.callCount(), 0)
})

test('a missing rebuild reply reports failure, then restores only the latest page after the native write settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(console, 'warn', () => {})
  const original = ready('Toy Bear'), host = display(t, original)
  const session = await host.start()
  const { rebuildPageContainer: rebuild, textContainerUpgrade, updateImageRawData } = host.bridge
  const native = Promise.withResolvers(), restored = Promise.withResolvers()
  let lens = original.collection.name
  const delayedWrite = gate => async layout => {
    await gate.promise
    lens = layout.textObject[0].content
    return true
  }
  rebuild.mock.mockImplementationOnce(delayedWrite(native))
  host.show(ready('Rose', true))
  await settle()
  const staleTarget = rebuiltText(host.bridge).containerID
  host.show(ready('Berry Box'))
  t.mock.timers.tick(11_999)
  await settle()
  assert.equal(host.feedback.mock.callCount(), 0)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(lastArg(host.feedback), true)

  // Even a rollback to the originally acknowledged page needs a fresh capture target.
  host.show(original)
  host.input(click)
  await settle()
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(rebuild.mock.callCount(), 1)
  assert.equal(textContainerUpgrade.mock.callCount(), 0)
  assert.equal(updateImageRawData.mock.callCount(), 0)

  rebuild.mock.mockImplementationOnce(delayedWrite(restored))
  native.resolve()
  await settle()
  assert.match(lens, /Rose/)
  assert.equal(rebuild.mock.callCount(), 2)
  assert.match(rebuiltText(host.bridge).content, /Toy Bear/)
  assert.notEqual(rebuiltText(host.bridge).containerID, staleTarget)
  host.input(click)
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(lastArg(host.feedback), true)
  restored.resolve()
  await settle()
  assert.match(lens, /Toy Bear/)
  assert.equal(lastArg(host.feedback), false)
  host.input(textEvent({ containerID: staleTarget }))
  assert.equal(host.tap.mock.callCount(), 0)
  host.input(click)
  assert.equal(host.tap.mock.callCount(), 1)
  await session.stop()
})

test('an uncertain native write is acknowledged again even when the phone restores the previous frame', async t => {
  t.mock.method(console, 'warn', () => {})
  const card = ready('Algorithm Cup', true), first = cupAt(card, 0, Uint8Array.of(1))
  const host = display(t, first), send = host.bridge.updateImageRawData
  await host.start()
  const inFlight = Promise.withResolvers(), restored = Promise.withResolvers()
  send.mock.mockImplementationOnce(() => inFlight.promise)
  host.show(cupAt(card, 45, Uint8Array.of(2)))
  await settle()
  host.show(first)
  send.mock.mockImplementationOnce(() => restored.promise)
  inFlight.reject(new Error('native acknowledgment lost'))
  await settle()
  host.input(swipeDown)
  assert.equal(host.inspector.step.mock.callCount(), 0)
  assert.strictEqual(lastArg(send).imageData, first.inspection.frame)
  restored.resolve('success')
  await settle()
  host.input(swipeDown)
  assert.deepEqual(host.inspector.step.mock.calls.map(c => c.arguments), [[1, first.inspection.frame]])
})

test('the variant picker acts on the acknowledged name through a pending reorder and a same-index rollback', async t => {
  const card = ready('Toy Bear', true), host = display(t, card)
  const picker = (names, index) => inspected(card, { mode: 'variants', status: 'ready', names, index }, true)
  const gold = picker(['Gold', 'Blue'], 0), blue = picker(['Blue', 'Gold'], 0)
  await host.start()
  host.input(hold)
  assert.deepEqual(host.inspector.show.mock.calls.at(-1).arguments, ['variants'])
  host.show(gold)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Models   1 \/ 2[\s\S]*Gold/)
  host.input(click)
  assert.deepEqual(host.inspector.pickVariant.mock.calls.map(c => c.arguments), [['Gold']])

  const pending = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => pending.promise)
  host.show(blue)
  host.input(click)
  await settle()
  host.input(click)
  host.show(gold)
  host.input(click)
  host.input(swipeDown)
  assert.equal(host.inspector.pickVariant.mock.callCount(), 1)
  assert.equal(host.inspector.step.mock.callCount(), 0)
  pending.resolve(true)
  await settle()
  host.show(blue)
  await settle()
  host.input(click)
  assert.deepEqual(host.inspector.pickVariant.mock.calls.at(-1).arguments, ['Blue'])
  host.input(swipeDown)
  assert.deepEqual(host.inspector.step.mock.calls[0].arguments, [1])
  host.show(picker(['Blue', 'Gold'], 1))
  await settle()
  host.input(swipeUp)
  host.input(click)
  assert.deepEqual(host.inspector.step.mock.calls[1].arguments, [-1])
  assert.deepEqual(host.inspector.pickVariant.mock.calls.at(-1).arguments, ['Gold'])
  assert.equal(host.tap.mock.callCount(), 0)
})

test('a picker label with a lost acknowledgment is rewritten before a tap can select the restored name', async t => {
  t.mock.method(console, 'warn', () => {})
  const card = ready('Toy Bear', true)
  const picker = name => inspected(card, { mode: 'variants', status: 'ready', names: [name], index: 0 }, true)
  const old = picker('Gold'), host = display(t, old)
  await host.start()
  const change = Promise.withResolvers(), restore = Promise.withResolvers()
  const label = host.bridge.rebuildPageContainer
  label.mock.mockImplementationOnce(() => change.promise)
  host.show(picker('Blue'))
  await settle()
  host.show(old)
  label.mock.mockImplementationOnce(() => restore.promise)
  change.reject(new Error('label acknowledgment lost'))
  await settle()
  host.input(click)
  assert.equal(host.inspector.pickVariant.mock.callCount(), 0)
  assert.match(rebuiltText(host.bridge).content, /Gold/)
  restore.resolve(true)
  await settle()
  host.input(click)
  assert.deepEqual(host.inspector.pickVariant.mock.calls.map(c => c.arguments), [['Gold']])
})

test('double-tap waits for the displayed return destination when a preview changes its origin', async t => {
  const card = ready('Toy Bear', true)
  const view = { mode: 'preview', status: 'ready', kind: 'relief', model: 'Blue',
    angle: 0, frame: Uint8Array.of(1), canNext: true, canPrevious: true }
  const host = display(t, inspected(card, view))
  await host.start()
  assert.match(lastArg(host.bridge.rebuildPageContainer).textObject[0].content, /Double-tap for details/)
  const changing = Promise.withResolvers()
  host.bridge.rebuildPageContainer.mock.mockImplementationOnce(() => changing.promise)
  host.show(inspected(card, view, true))
  await settle()
  host.input({ sysEvent: doubleTap, textEvent: {} })
  assert.equal(host.back.mock.callCount(), 0)
  changing.resolve(true)
  await settle()
  assert.match(rebuiltText(host.bridge).content, /Double-tap for models/)
  host.input({ sysEvent: doubleTap, textEvent: {} })
  assert.equal(host.back.mock.callCount(), 1)
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(host.inspector.back.mock.callCount(), 0)
})

test('replacing an inspection caption and bitmap clears the old pair before sending the new image', async t => {
  t.mock.method(console, 'warn', () => {})
  const card = ready('Toy Bear', true)
  const chart = (last, frame) => inspected(card, { mode: 'chart', range: '7d', status: 'ready',
    frame, last, high: last + 2, low: last - 2, lastTime: 1000 })
  const first = chart(11, Uint8Array.of(1)), next = chart(21, Uint8Array.of(2))
  const host = display(t, first), { rebuildPageContainer: rebuild, updateImageRawData: send } = host.bridge
  await host.start()
  const clear = Promise.withResolvers()
  rebuild.mock.mockImplementationOnce(() => clear.promise)
  host.show(next)
  await settle()
  assert.match(lastArg(rebuild).textObject[0].content, /Last 21 GRAM/)
  assert.equal(lastArg(rebuild).imageObject.length, 0)
  assert.equal(send.mock.callCount(), 1)
  clear.resolve(false)
  await settle()
  assert.equal(lastArg(host.feedback), true)
  assert.equal(send.mock.callCount(), 1)
  host.show(next)
  await settle()
  assert.deepEqual(rebuild.mock.calls.map(c => c.arguments[0].imageObject.length), [1, 0, 0, 1])
  assert.strictEqual(lastArg(send).imageData, next.inspection.frame)
  assert.equal(host.bridge.textContainerUpgrade.mock.callCount(), 0)
})

test('variant loading, empty and error states route only their available gestures and double-tap asks the phone to go back', async t => {
  const card = ready('Toy Bear', true)
  const state = status => inspected(card, { mode: 'variants', status }, true)
  const host = display(t, state('loading'))
  await host.start()
  assert.match(lastArg(host.bridge.createStartUpPageContainer).textObject[0].content, /Loading models/)
  host.input(click)
  host.input(swipeDown)
  host.input({ sysEvent: doubleTap })
  assert.equal(host.inspector.retry.mock.callCount(), 0)
  assert.equal(host.back.mock.callCount(), 1)
  for (const status of ['empty', 'error']) {
    host.show(state(status))
    await settle()
    const caption = status === 'empty' ? rebuiltText(host.bridge).content : lastArg(host.bridge.textContainerUpgrade).content
    assert.match(caption, status === 'empty' ? /No models available/ : /Models unavailable/)
    assert.match(caption, /Tap to retry[\s\S]*Double-tap for details/)
    host.input(swipeUp)
    host.input(click)
    host.input({ textEvent: doubleTap, sysEvent: {} })
  }
  assert.equal(host.inspector.retry.mock.callCount(), 2)
  assert.equal(host.back.mock.callCount(), 3)
  assert.equal(host.inspector.pickVariant.mock.callCount(), 0)
  assert.equal(host.inspector.step.mock.callCount(), 0)
  assert.equal(host.tap.mock.callCount(), 0)
  assert.equal(host.inspector.back.mock.callCount(), 0)
  assert.equal(host.bridge.shutDownPageContainer.mock.callCount(), 0)
})

test('tool text wraps and truncates only at grapheme boundaries at both native widths', () => {
  assert.equal(fitNativeText('abc', 1, '…!'), 'a')
  assert.equal(fitNativeText('👩🏽‍💻abc', 1, '…!'), '')
  assert.equal(fitNativeText('abc', 2, '…'), 'ab')
  assert.equal(fitNativeText('abcde', 4, '…'), 'a…')
  const emoji = '👩🏽‍💻'
  const page = { title: 'Research', lines: ['a'.repeat(22) + emoji + 'b'], chart: {}, actions: [] }
  const lines = toolView(page, 0).content.split('\n')
  assert.deepEqual(lines.slice(1, 3), ['a'.repeat(22) + emoji, 'b'])
  delete page.chart
  page.browse = { open: 'item' }
  page.lines = ['a'.repeat(41) + emoji + 'xy']
  assert.equal(toolView(page, 0).content.split('\n')[1], 'a'.repeat(41) + emoji + '…')
})

test('long browse data and confirmation labels fit the native text container and preserve Back', () => {
  const emoji = '👩🏽‍💻'
  const action = { id: 'open', label: emoji.repeat(250), requiresConfirmation: true }
  const page = { title: 'Research', lines: Array(32).fill(emoji.repeat(40)), actions: [action] }
  const open = { ...action, label: 'Open chart', requiresConfirmation: false }
  const browse = toolView({ ...page, browse: { open: 'open', next: 'next' }, actions: [open] }, 0)
  assert.match(browse.content, /Tap → Open chart/)
  assert.match(browse.content, /Swipe to browse tasks/)
  assert.equal(browse.action, open)

  const { total } = toolView(page, 0)
  assert.ok(total > 1)
  const views = Array.from({ length: total }, (_, i) => toolView(page, i))
  for (const [i, view] of views.entries()) {
    assert.equal(view.position, i)
    assert.equal(view.content.split('\n').at(-2), `Swipe   ${i + 1} / ${total}`)
    assert.equal(view.action, i === total - 1 ? action : undefined)
  }
  assert.match(views.at(-1).content, /Menu →\s/)
  for (const view of [browse, ...views]) {
    assert.ok(Buffer.byteLength(view.content) <= 999)
    assert.ok(view.content.startsWith(page.title))
    assert.ok(view.content.endsWith('Double-tap to go back'))
    assert.doesNotMatch(view.content.replaceAll(emoji, ''), /[👩🏽💻\u200d]/u)
  }
})

test('generated native menu labels fit 32 UTF-8 bytes and dispatch the original confirmation', async t => {
  const host = display(t, ready('Toy Bear', true))
  const emoji = '👩🏽‍💻'
  const label = 'Record ' + emoji.repeat(4)
  const page = { key: 'preview', title: 'Record floor', lines: [], actions: [{ id: 'record', label, requiresConfirmation: true }] }
  const tools = { getSnapshot: () => page, act: t.mock.fn(), close() {} }
  const session = await host.start(undefined, { getTools: () => tools })
  t.after(() => session.stop())
  const native = lastArg(host.bridge.rebuildPageContainer) ?? lastArg(host.bridge.createStartUpPageContainer)
  const item = native.menuObject.menuItems[0]
  assert.ok(Buffer.byteLength(item.itemName) <= 32)
  assert.equal(item.itemName, 'Record ' + emoji + '…')
  assert.ok(native.textObject[0].content.includes(label))
  host.input(menuSelection(item.itemID))
  assert.deepEqual(tools.act.mock.calls.map(c => c.arguments), [[page, 'record']])
})
