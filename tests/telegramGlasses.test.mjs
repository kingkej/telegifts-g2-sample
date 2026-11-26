import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { DeviceConnectType, evenHubEventFromJson, OsEventTypeList as os, validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { connectGlasses } from '../src/glasses.ts'
import { telegramPage } from '../src/telegramDisplay.ts'
import { createVoiceControl } from '../src/voiceControl.ts'

const state = {
  enabled: true, privateChat: { id: 'private', label: 'My chat' }, group: { id: 'group', label: 'Gift group' }, candidate: null,
  questions: [
    { id: 'one', sender: 'Ada', text: 'Which gift are you watching?', chatLabel: 'Gift group' },
    { id: 'two', sender: 'Ben', text: 'How did the floor change?', chatLabel: 'Gift group' },
  ],
}
const series = { from: 172800, to: 345600, interval: 86400, points: [{ time: 172800, price: 4 }, { time: 259200, price: 6.5 }] }
const menu = itemID => evenHubEventFromJson({ type: 'menuItemClickEvent', jsonData: { itemID } })
const click = (jsonData = {}) => evenHubEventFromJson({ type: 'text_event', jsonData })
const system = eventType => ({ sysEvent: { eventType } })
const calls = mock => mock.mock.calls.map(c => c.arguments)

for (const comparison of [false, true]) {
  test(`Unicode reply metadata preserves the ${comparison ? 'comparison' : 'chart'} evidence and controls`, t => {
    t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 20, 12))
    const lastTime = Date.UTC(2026, 10, 19) / 1000
    const render = (destination, sender, collection, previous = 4, last = 6.5) => {
      const question = { ...state.questions[0], sender }
      const pair = { previousTime: lastTime - 86400, previous }
      const screen = { kind: 'confirm', reply: true, destination, collection, range: '7d', last, lastTime,
        ...(comparison && { comparison: pair, destinationId: state.group.id, questionId: question.id }) }
      const inspection = { mode: 'chart', status: 'ready', collection, range: '7d', last, lastTime, comparison: pair }
      const result = telegramPage({ screen, selectedQuestion: question, state: {
        ...state, group: { ...state.group, label: destination }, questions: [question],
      } }, inspection)
      assert.ok(Buffer.byteLength(result.content) <= 999)
      return result
    }
    const title = comparison ? 'Reply with comparison' : 'Reply with chart'
    const context = comparison ? ' · Daily closes (UTC)' : ' · 7d'
    const details = comparison
      ? ['2026-11-18 · 4 GRAM', '2026-11-19 · 6.5 GRAM', 'Change +2.5 GRAM', 'Menu → Send or Cancel']
      : ['Last 6.5 GRAM', 'Bucket 2026-11-19 00:00 UTC', '', 'Menu → Send or Cancel', 'Double-tap to cancel']
    assert.deepEqual(render('Gift group', 'Ada', 'Toy Bear').content.split('\n'),
      [title, 'To Gift group', 'For Ada', 'Toy Bear' + context, ...details])

    const destination = '猫'.repeat(50)
    const family = '👩‍👩‍👧‍👧'
    const long = render(destination, family.repeat(100), '漢'.repeat(450))
    assert.equal(long.list, 'confirm')
    assert.equal(long.tapAction, null)
    const [heading, to, from, collection, ...footer] = long.content.split('\n')
    assert.equal(heading, title)
    assert.equal(to, 'To ' + destination)
    assert.match(from, /^For (?:👩‍👩‍👧‍👧)+…$/u)
    assert.ok(collection.endsWith('…' + context))
    assert.match(collection.slice(0, -context.length), /^漢+…$/u)
    assert.deepEqual(footer, details)
    if (comparison) {
      const oversized = render('Gift group', 'Ada', 'Toy Bear', 1e307, 1e308)
      assert.equal(oversized.list, 'notice')
      assert.equal(oversized.tapAction, 'telegramBack')
      assert.ok(oversized.content.endsWith('Tap or double-tap to return'))
    }
  })
}

function telegramStore(t) {
  let snapshot = { state, selectedQuestion: null, screen: { kind: 'idle' } }
  const listeners = new Set()
  function publish(patch) {
    snapshot = { ...snapshot, ...patch }
    for (const notify of listeners) notify()
  }
  const screen = next => publish({ screen: next })
  const idle = () => screen({ kind: 'idle' })
  const control = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    openQuestions: t.mock.fn(() => screen({ kind: 'questions', index: 0 })),
    step: t.mock.fn(), activate: t.mock.fn(), back: t.mock.fn(idle),
    share: t.mock.fn(), cancelDraft: t.mock.fn(idle),
  }
  return { control, publish, screen, listeners }
}

// Run the production display, inspector and voice router together. Only the Even bridge,
// phone controls, chart PNG encoder and Telegram store are replaced at their boundaries.
async function setup(t) {
  const originalWindow = globalThis.window, originalDocument = globalThis.document
  let hubEvent, deviceEvent, session, layout, covered = false, clock = 0
  const store = telegramStore(t)
  const display = createCollectionDisplay(() => session?.update())
  const bridge = {
    ready: true, audioControl: t.mock.fn(async () => true),
    createStartUpPageContainer: t.mock.fn(async p => { layout = p; return 0 }),
    rebuildPageContainer: t.mock.fn(async p => { layout = p; return true }),
    textContainerUpgrade: t.mock.fn(async p => { layout.textObject[0].content = p.content; return true }),
    updateImageRawData: t.mock.fn(async () => 'success'),
    onEvenHubEvent(fn) { hubEvent = fn; return () => { hubEvent = undefined } },
    onDeviceStatusChanged(fn) { deviceEvent = fn; return () => { deviceEvent = undefined } },
  }
  globalThis.window = Object.assign(new EventTarget(), { EvenAppBridge: bridge })
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({
      getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
      toBlob: done => done(new Blob([Uint8Array.of(1, 2, 3, 4)])),
    }),
  })
  const item = { id: 'bear', name: 'Toy Bear', floors: { mrkt: 10 } }
  const phone = {
    loadCatalog: async () => ({ collection_floors: { 'Toy Bear': item.floors } }),
    loadArtwork: async () => null, loadFloorChart: t.mock.fn(async () => series),
    canUseVoiceTarget: () => !covered, back: t.mock.fn(() => false), setFavorite: t.mock.fn(),
  }
  display.companion.setTelegram(store.control)
  const disconnect = display.companion.connect(phone)
  display.companion.marketChanged({ period: '7d', filter: 'all', observations: new Map(), browse: { status: 'catalog' }, stale: false })
  const transcribe = t.mock.fn(async () => 'reply with chart')
  const voice = createVoiceControl({ names: display.voiceNames, resolve: display.resolveVoice, transcribe, now: () => clock })
  const closed = t.mock.fn()
  async function open() {
    session = await connectGlasses({ ...display, voice, showDisplayError: t.mock.fn() }, closed)
    await settle()
  }
  t.after(async () => {
    await session?.stop()
    disconnect()
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  })
  await open()
  function itemID(label) {
    assert.ok(validateEvenHubPageContainer(layout).valid)
    const item = layout.menuObject?.menuItems.find(i => i.itemName === label)
    assert.ok(item, 'Missing native menu item ' + label)
    return item.itemID
  }
  const content = () => layout.textObject[0].content
  const prompt = (destination, reply) => {
    const { collection, range, last, lastTime } = display.inspector.getSnapshot()
    return { kind: 'confirm', destination, reply, collection, range, last, lastTime }
  }
  store.control.share.mock.mockImplementation(target => {
    const reply = target !== 'private'
    const next = prompt(reply ? state.group.label : state.privateChat.label, reply)
    if (target === 'comparison') {
      const comparison = display.inspector.getSnapshot().comparison
      if (!comparison) { store.screen({ kind: 'notice', reason: 'comparison' }); return false }
      Object.assign(next, { comparison: { ...comparison }, destinationId: state.group.id, questionId: store.control.getSnapshot().selectedQuestion?.id })
    }
    store.screen(next)
    return true
  })
  return { ...store, bridge, display, phone, voice, transcribe, input: event => hubEvent?.(event), content, itemID,
    open, closed, disconnect, device: type => deviceEvent?.({ connectType: type }),
    cover(value) { covered = value }, layout: () => layout, prompt,
    holdNextRebuild() {
      const ack = Promise.withResolvers()
      bridge.rebuildPageContainer.mock.mockImplementationOnce(async next => {
        await ack.promise
        layout = next
        return true
      })
      return ack.resolve
    },
    async chart() { display.companion.select(item); display.inspector.show('chart'); await settle() },
    async speak(start = () => voice.controls.start()) {
      start()
      await t.waitFor(() => assert.equal(voice.controls.getSnapshot().phase, 'listening'))
      const pcm = new Int16Array(20_000)
      for (let i = 0; i < 5000; i++) pcm[i] = i % 2 ? 1400 : -1400
      clock += pcm.length / 16
      hubEvent({ audioEvent: { source: 'glasses', audioPcm: new Uint8Array(pcm.buffer) } })
      await settle()
    },
  }
}

test('Questions follows the shared inbox, swipes, detail, Back and chosen reply target', async t => {
  const h = await setup(t)
  const [ada, ben] = state.questions
  h.input(system(os.DOUBLE_CLICK_EVENT))
  await settle()
  assert.match(h.content(), /Questions \(2\)/)
  for (let i = 0; i < 2; i++) { h.input(system(os.SCROLL_BOTTOM_EVENT)); await settle() }
  assert.match(h.content(), /> Questions/)
  h.input(click())
  await settle()
  assert.equal(h.control.openQuestions.mock.callCount(), 1)
  assert.match(h.content(), /Questions   1 \/ 2[\s\S]*Ada[\s\S]*Which gift/)
  const oldRow = h.layout().textObject[0].containerID
  h.control.step.mock.mockImplementationOnce(() => h.screen({ kind: 'questions', index: 1 }))
  h.input(system(os.SCROLL_BOTTOM_EVENT))
  await settle()
  h.input(system(os.SCROLL_TOP_EVENT))
  assert.deepEqual(calls(h.control.step), [[1], [-1]])
  assert.match(h.content(), /2 \/ 2[\s\S]*Ben/)
  h.input(click({ containerID: oldRow }))
  assert.equal(h.control.activate.mock.callCount(), 0)
  h.control.activate.mock.mockImplementationOnce(() => h.screen({ kind: 'question', question: ben }))
  h.input(click())
  await settle()
  assert.match(h.content(), /Ben · Gift group[\s\S]*use for reply[\s\S]*How did the floor change/)
  h.control.back.mock.mockImplementationOnce(() => h.screen({ kind: 'questions', index: 1 }))
  h.input(system(os.DOUBLE_CLICK_EVENT))
  await settle()
  assert.match(h.content(), /Questions   2 \/ 2/)
  h.screen({ kind: 'question', question: ada }) // A question opened on the phone.
  await settle()
  h.control.activate.mock.mockImplementationOnce(() => h.publish({ selectedQuestion: ada, screen: { kind: 'idle' } }))
  h.input(click())
  await settle()
  assert.match(h.content(), /Explore Gifts/)
  assert.equal(h.phone.back.mock.callCount(), 1, 'only opening the root menu delegates to the phone Back stack')
  h.input(menu(h.itemID('Questions')))
  await settle()
  h.publish({ state: { ...state, questions: [] }, screen: { kind: 'questions', index: 0 } })
  await settle()
  assert.match(h.content(), /No pending questions[\s\S]*refresh/)
  h.input(menu(h.itemID('Refresh questions')))
  assert.equal(h.control.openQuestions.mock.callCount(), 3)
  h.input(system(os.DOUBLE_CLICK_EVENT))
  await settle()
  assert.match(h.content(), /Explore Gifts/)
})

test('only the acknowledged Send menu item for this preview commits once', async t => {
  const h = await setup(t)
  await h.chart()
  const privateItem = h.itemID('Send to my Telegram'), replyItem = h.itemID('Reply with chart')
  assert.notEqual(privateItem, replyItem)
  h.input(menu(privateItem))
  await settle()
  assert.deepEqual(calls(h.control.share), [['private']])
  assert.match(h.content(), /Send chart\nTo My chat\nToy Bear · 7d\nLast 6.5 GRAM\nBucket 1970-01-04 00:00 UTC/)
  const canceled = h.itemID('Send')
  h.input(menu(h.itemID('Cancel')))
  await settle()
  assert.match(h.content(), /Collection floor · 7d/)
  h.publish({ selectedQuestion: state.questions[1] })
  await settle()
  h.input(system(os.FOREGROUND_ENTER_EVENT))
  h.input(menu(h.itemID('Reply with chart')))
  h.input(system(os.FOREGROUND_EXIT_EVENT))
  await settle()
  assert.match(h.content(), /Reply with chart\nTo Gift group\nFor Ben\nToy Bear · 7d/)
  const send = h.itemID('Send'), text = h.layout().textObject[0]
  for (const event of [click(), click({ containerID: text.containerID }), click({ containerName: text.containerName }),
    system(os.CLICK_EVENT), { ...menu(send), textEvent: {} }, menu(), menu(0), menu(canceled), menu(privateItem), menu(replyItem),
    menu(text.containerID)]) h.input(event)
  assert.equal(h.control.activate.mock.callCount(), 0)
  // The controller may still expose the old prompt during delivery handoff.
  h.input(menu(send))
  h.input(menu(send))
  assert.equal(h.control.activate.mock.callCount(), 1)
  h.screen({ kind: 'sending', destination: 'Gift group' })
  await settle()
  assert.match(h.content(), /Sending chart…\nTo Gift group/)
  assert.equal(h.layout().menuObject, undefined)
  for (const [status, label] of [['pending', 'Delivery pending'], ['unknown', 'Delivery unconfirmed'], ['failed', 'Delivery failed'], ['sent', 'Sent']]) {
    h.screen({ kind: 'result', destination: 'Gift group', status })
    await settle()
    assert.ok(h.content().startsWith(label + '\nTo Gift group'))
    if (status === 'pending' || status === 'unknown') assert.match(h.content(), /Check delivery status on your phone before sending again/)
    h.input(menu(send))
  }
  h.control.activate.mock.mockImplementationOnce(() => h.screen({ kind: 'idle' }))
  h.input(click())
  await settle()
  assert.equal(h.control.activate.mock.callCount(), 2)
  assert.match(h.content(), /Collection floor · 7d/)
})

test('a native menu or spoken comparison opens the same dated preview and only its current Send can confirm', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 20, 12))
  const h = await setup(t)
  const day = 86400, lastTime = Date.UTC(2026, 10, 19) / 1000
  const history = { from: lastTime - 6 * day, to: lastTime + day, interval: day,
    points: [{ time: lastTime - day, price: 17.12500001 }, { time: lastTime, price: 17.125 }] }
  h.phone.loadFloorChart.mock.mockImplementation(async () => history)
  await h.chart()
  h.publish({ selectedQuestion: state.questions[0] })
  await settle()
  h.input(menu(h.itemID('Reply with comparison')))
  await settle()
  const rendered = h.content()
  assert.deepEqual(rendered.split('\n'), ['Reply with comparison', 'To Gift group', 'For Ada', 'Toy Bear · Daily closes (UTC)',
    '2026-11-18 · 17.12500001 GRAM', '2026-11-19 · 17.125 GRAM', 'Change -0.00000001 GRAM', 'Menu → Send or Cancel'])
  const canceled = h.itemID('Send')
  h.input(menu(h.itemID('Cancel')))
  await settle()
  h.transcribe.mock.mockImplementation(async () => 'reply with comparison')
  await h.speak()
  assert.equal(h.content(), rendered)
  assert.deepEqual(calls(h.control.share), [['comparison'], ['comparison']])
  h.input(menu(canceled)); h.input(click())
  assert.equal(h.control.activate.mock.callCount(), 0)
  const send = h.itemID('Send')
  h.input(menu(send)); h.input(menu(send))
  assert.equal(h.control.activate.mock.callCount(), 1)

  const frozen = h.control.getSnapshot().screen
  for (const edit of [{ questionId: state.questions[1].id }, { destinationId: 'another' },
    { comparison: { ...frozen.comparison, previous: 18 } }, { comparison: { ...frozen.comparison, previousTime: lastTime - 2 * day } }]) {
    h.screen({ ...frozen, ...edit })
    await settle()
    assert.match(h.content(), /changed/)
    assert.equal(h.layout().menuObject, undefined)
    h.input(menu(send))
  }
  assert.equal(h.control.activate.mock.callCount(), 1)
  h.control.back()
  history.points[0].price = history.points[1].price
  h.display.inspector.show('overview')
  await h.chart()
  h.input(menu(h.itemID('Reply with comparison')))
  await settle()
  assert.match(h.content(), /Unchanged/)
  h.control.back()
  history.points[0].time -= day
  h.display.inspector.show('overview')
  await h.chart()
  h.input(menu(h.itemID('Reply with comparison')))
  await settle()
  assert.match(h.content(), /two consecutive daily closes.*chart.*Questions/)
  assert.equal(h.layout().menuObject, undefined)
})

test('deferred native writes cannot authorize an unseen chart or resurrect a canceled, identical preview', async t => {
  const h = await setup(t)
  const image = Promise.withResolvers()
  let acknowledge
  try {
    h.bridge.updateImageRawData.mock.mockImplementationOnce(() => image.promise)
    await h.chart()
    const share = h.itemID('Send to my Telegram')
    h.input(menu(share))
    assert.equal(h.control.share.mock.callCount(), 0)
    image.resolve('success')
    await settle()
    h.input(menu(share))
    await settle()
    const oldSend = h.itemID('Send')
    acknowledge = h.holdNextRebuild()
    h.control.back()
    h.control.share('private') // The phone opens an identical new draft before BLE settles.
    await settle()
    const attempted = h.bridge.rebuildPageContainer.mock.calls.at(-1).arguments[0]
    const newSend = attempted.menuObject.menuItems.find(item => item.itemName === 'Send').itemID
    assert.notEqual(newSend, oldSend)
    h.input(menu(oldSend))
    h.input(menu(newSend))
    assert.equal(h.control.activate.mock.callCount(), 0)
    h.input(system(os.DOUBLE_CLICK_EVENT))
    assert.equal(h.control.getSnapshot().screen.kind, 'confirm')
    acknowledge()
    await settle()
    assert.equal(h.itemID('Send'), newSend)
    h.input(menu(oldSend))
    assert.equal(h.control.activate.mock.callCount(), 0)
    h.input(system(os.DOUBLE_CLICK_EVENT))
    assert.equal(h.control.getSnapshot().screen.kind, 'idle')
    await settle()
    h.input(menu(newSend))
    h.input(menu(oldSend))
    assert.equal(h.control.activate.mock.callCount(), 0)
    assert.match(h.content(), /Collection floor · 7d/)
  } finally {
    image.resolve('success')
    acknowledge?.()
  }
})

test('a double-tap addressed to the chart cannot cancel a new phone draft', async t => {
  const h = await setup(t)
  await h.chart()
  const chart = h.layout().textObject[0]
  const doubleTapOn = target => click({ containerID: target.containerID, eventType: os.DOUBLE_CLICK_EVENT })
  const acknowledge = h.holdNextRebuild()
  try {
    h.control.share('private')
    await settle()
    h.input(doubleTapOn(chart))
    assert.equal(h.control.getSnapshot().screen.kind, 'confirm')
    assert.equal(h.control.cancelDraft.mock.callCount(), 0)
  } finally { acknowledge() }
  await settle()
  h.input(doubleTapOn(chart))
  assert.equal(h.control.getSnapshot().screen.kind, 'confirm')
  h.input(doubleTapOn(h.layout().textObject[0]))
  assert.equal(h.control.getSnapshot().screen.kind, 'idle')
  assert.equal(h.control.cancelDraft.mock.callCount(), 1)
  assert.equal(h.control.activate.mock.callCount(), 0)
})

test('a delivery lookup cannot mark Sent reviewed while the glasses still show an uncertain receipt', async t => {
  const h = await setup(t)
  const reviewed = []
  h.control.back.mock.mockImplementation(() => {
    reviewed.push(h.control.getSnapshot().screen)
    h.screen({ kind: 'idle' })
  })
  h.control.activate.mock.mockImplementation(() => h.control.back())
  for (const [status, label] of [['unknown', 'Delivery unconfirmed'], ['pending', 'Delivery pending']]) {
    h.screen({ kind: 'result', status, destination: 'Gift group' })
    await settle()
    const oldID = h.layout().textObject[0].containerID
    const sent = { kind: 'result', status: 'sent', destination: 'Gift group' }
    const reviewCount = reviewed.length
    const acknowledge = h.holdNextRebuild()
    try {
      h.screen(sent)
      await settle()
      assert.ok(h.content().startsWith(label))
      h.input(system(os.DOUBLE_CLICK_EVENT))
      h.input(click({ containerID: oldID }))
      h.input(click())
      assert.equal(reviewed.length, reviewCount)
      assert.equal(h.control.getSnapshot().screen, sent)
    } finally { acknowledge(); await settle() }
    assert.match(h.content(), /^Sent\nTo Gift group/)
    h.input(click({ containerID: oldID, eventType: os.DOUBLE_CLICK_EVENT }))
    assert.equal(reviewed.length, reviewCount)
    h.input(system(os.DOUBLE_CLICK_EVENT))
    assert.equal(reviewed.length, reviewCount + 1)
    assert.equal(reviewed.at(-1), sent)
    await settle()
  }
})

test('identical receipt text needs a fresh acknowledgment when the result screen or its controller changes', async t => {
  const h = await setup(t)
  let store = h
  const sent = { kind: 'result', status: 'sent', destination: 'My chat' }
  for (const replaceControl of [false, true]) {
    store.screen(sent)
    await settle()
    const oldID = h.layout().textObject[0].containerID
    const acknowledge = h.holdNextRebuild()
    try {
      if (replaceControl) {
        store = telegramStore(t)
        store.screen(sent)
        h.display.companion.setTelegram(store.control)
      } else store.screen({ ...sent })
      await settle()
      const before = store.control.back.mock.callCount()
      h.input(system(os.DOUBLE_CLICK_EVENT))
      h.input(click())
      assert.equal(store.control.back.mock.callCount(), before)
      assert.equal(store.control.activate.mock.callCount(), 0)
    } finally { acknowledge(); await settle() }
    assert.notEqual(h.layout().textObject[0].containerID, oldID)
    h.input(system(os.DOUBLE_CLICK_EVENT))
    assert.equal(store.control.getSnapshot().screen.kind, 'idle')
    await settle()
  }
})

test('a missing reply result explains that the original message or topic was deleted', async t => {
  const h = await setup(t)
  const failed = { kind: 'result', status: 'failed', destination: 'Gift group' }
  h.screen({ ...failed, reason: 'missing_reply' })
  await settle()
  assert.match(h.content(), /^Delivery failed\nTo Gift group\nOriginal message or topic was deleted\./)
  h.screen(failed)
  await settle()
  assert.doesNotMatch(h.content(), /was deleted/)
})

test('neither glasses-started nor phone-started speech can share a refused chart bitmap', async t => {
  t.mock.method(console, 'warn', () => {})
  const h = await setup(t)
  h.bridge.updateImageRawData.mock.mockImplementation(async () => 'sendFailed')
  h.transcribe.mock.mockImplementation(async () => 'send this chart to my telegram')
  await h.chart()
  for (const start of [() => h.input(menu(h.itemID('Voice command'))), () => h.voice.controls.start()]) {
    await h.speak(start)
    assert.equal(h.control.share.mock.callCount(), 0)
    assert.equal(h.control.getSnapshot().screen.kind, 'idle')
    assert.doesNotMatch(h.content(), /Menu → Send/)
    assert.equal(h.voice.controls.getSnapshot().reason, 'action')
    h.input(system(os.DOUBLE_CLICK_EVENT))
    await settle()
  }
})

test('a bitmap acknowledgment after recording starts cannot authorize that recording', async t => {
  const h = await setup(t)
  const upload = Promise.withResolvers(), transcript = Promise.withResolvers()
  h.bridge.updateImageRawData.mock.mockImplementationOnce(() => upload.promise)
  h.transcribe.mock.mockImplementationOnce(() => transcript.promise)
  try {
    await h.chart()
    await h.speak()
    upload.resolve('success')
    await settle()
    transcript.resolve('send this chart to my telegram')
    await settle()
    assert.equal(h.control.share.mock.callCount(), 0)
    assert.equal(h.voice.controls.getSnapshot().reason, 'action')
  } finally {
    upload.resolve('success')
    transcript.resolve(null)
  }
})

test('replacing an acknowledged frame or reopening G2 retires its pending transcript', async t => {
  const h = await setup(t)
  await h.chart()
  const original = h.display.inspector.getSnapshot().frame
  const first = Promise.withResolvers()
  h.transcribe.mock.mockImplementationOnce(() => first.promise)
  await h.speak()
  h.display.inspector.setRange('30d')
  h.display.inspector.setRange('7d')
  await settle()
  assert.notEqual(h.display.inspector.getSnapshot().frame, original)
  assert.deepEqual(h.display.inspector.getSnapshot().frame, original)
  first.resolve('send this chart to my telegram')
  await settle()
  assert.equal(h.display.resolveVoice('send this chart to my telegram', original).run(), false)
  const second = Promise.withResolvers()
  h.transcribe.mock.mockImplementationOnce(() => second.promise)
  await h.speak()
  h.device(DeviceConnectType.Disconnected)
  await h.open()
  second.resolve('reply with chart')
  await settle()
  assert.equal(h.control.share.mock.callCount(), 0)
  assert.equal(h.control.getSnapshot().screen.kind, 'idle')
})

test('chart or destination changes with a delayed controller leave only a safe way back', async t => {
  const h = await setup(t)
  await h.chart()
  h.input(menu(h.itemID('Send to my Telegram')))
  await settle()
  let send = h.itemID('Send')
  h.display.inspector.setRange('30d')
  h.input(menu(send))
  await settle()
  assert.match(h.content(), /changed[\s\S]*return/)
  assert.equal(h.layout().menuObject, undefined)
  h.input(click())
  await settle()
  assert.match(h.content(), /Collection floor · 30d/)
  h.control.share('private')
  await settle()
  send = h.itemID('Send')
  h.publish({ state: { ...state, privateChat: { id: 'new', label: 'Different chat' } } })
  h.input(menu(send))
  await settle()
  h.input(menu(send))
  h.input(click())
  await settle()
  assert.equal(h.control.activate.mock.callCount(), 0)
  assert.match(h.content(), /Collection floor · 30d/)
})

test('an unacknowledged confirmation menu can be redrawn but its Send item stays inert', async t => {
  t.mock.method(console, 'warn', () => {})
  const h = await setup(t)
  await h.chart()
  h.bridge.rebuildPageContainer.mock.mockImplementationOnce(async () => false)
  h.input(menu(h.itemID('Send to my Telegram')))
  await settle()
  const uncertain = h.bridge.rebuildPageContainer.mock.calls.at(-1).arguments[0]
  const stale = uncertain.menuObject.menuItems.find(i => i.itemName === 'Send').itemID
  h.input(menu(stale))
  await settle()
  const current = h.itemID('Send')
  assert.notEqual(stale, current)
  h.input(menu(stale))
  assert.equal(h.control.activate.mock.callCount(), 0)
  h.input(menu(current))
  assert.equal(h.control.activate.mock.callCount(), 1)
})

test('native exit, WebView hide, disconnect and reopen revoke the old draft and its input', async t => {
  const h = await setup(t)
  await h.chart()
  for (const [leave, enter] of [
    [() => h.input(system(os.FOREGROUND_EXIT_EVENT)), () => h.input(system(os.FOREGROUND_ENTER_EVENT))],
    [() => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')) },
      () => { document.hidden = false; document.dispatchEvent(new Event('visibilitychange')) }],
    [() => window.dispatchEvent(new Event('pagehide')), () => window.dispatchEvent(new Event('pageshow'))],
    [() => h.input(system(os.SYSTEM_EXIT_EVENT)), h.open],
    [() => h.device(DeviceConnectType.Disconnected), h.open],
  ]) {
    h.input(menu(h.itemID('Send to my Telegram')))
    await settle()
    const send = h.itemID('Send')
    leave()
    h.input(menu(send))
    assert.equal(h.control.getSnapshot().screen.kind, 'idle')
    await enter()
    await settle()
    h.input(menu(send))
    assert.match(h.content(), /Collection floor · 7d/)
  }
  assert.equal(h.control.activate.mock.callCount(), 0)
  assert.equal(h.closed.mock.callCount(), 2)
  assert.equal(h.phone.back.mock.callCount(), 0)
})

test('voice opens only the shared draft or notice, scoped to its originating phone, chart and question', async t => {
  const h = await setup(t)
  await h.chart()
  h.publish({ selectedQuestion: state.questions[0] })
  await settle()
  await h.speak()
  assert.deepEqual(calls(h.control.share), [['reply']])
  assert.equal(h.voice.controls.getSnapshot().phase, 'idle')
  assert.match(h.content(), /Reply with chart\nTo Gift group/)
  assert.deepEqual(h.layout().menuObject.menuItems.map(i => i.itemName), ['Send', 'Cancel'])
  h.voice.controls.start()
  assert.equal(h.voice.controls.getSnapshot().phase, 'idle')
  h.input(system(os.DOUBLE_CLICK_EVENT))
  await settle()
  h.transcribe.mock.mockImplementation(async () => 'send this chart to my Telegram')
  h.control.share.mock.mockImplementationOnce(() => { h.screen({ kind: 'notice', reason: 'connect' }); return false })
  await h.speak()
  assert.match(h.content(), /Connect your Telegram on the phone/)
  assert.equal(h.voice.controls.getSnapshot().phase, 'idle')
  h.input(system(os.DOUBLE_CLICK_EVENT))
  await settle()
  const delayed = Promise.withResolvers()
  h.transcribe.mock.mockImplementationOnce(() => delayed.promise)
  await h.speak()
  assert.equal(h.voice.controls.getSnapshot().phase, 'processing')
  h.publish({ selectedQuestion: state.questions[1] })
  h.publish({ selectedQuestion: state.questions[0] })
  delayed.resolve('reply with chart')
  await settle()
  assert.equal(h.voice.controls.getSnapshot().phase, 'idle')
  const frame = h.display.inspector.getSnapshot().frame
  const onChart = h.display.resolveVoice('reply with chart', frame)
  h.cover(true)
  assert.equal(onChart.run(), false)
  h.cover(false)
  h.display.inspector.setRange('30d')
  const whileLoading = h.display.resolveVoice('send this chart to my Telegram', frame)
  await settle()
  assert.equal(whileLoading.run(), false)
  h.display.inspector.setRange('7d')
  await settle()
  assert.equal(onChart.run(), false)
  h.display.inspector.back()
  assert.equal(h.display.resolveVoice('reply with chart').run(), false)
  assert.deepEqual(calls(h.control.share), [['reply'], ['private']])
  assert.equal(h.control.activate.mock.callCount(), 0)
  assert.equal(h.phone.setFavorite.mock.callCount(), 0)
})

test('replacing the hosted store or phone disconnects its subscription and fences deferred input', async t => {
  const h = await setup(t)
  await h.chart()
  const oldVoice = h.display.resolveVoice('send this chart to my Telegram', h.display.inspector.getSnapshot().frame)
  h.control.share('private')
  await settle()
  const oldSend = h.itemID('Send')
  const next = telegramStore(t)
  h.display.companion.setTelegram(next.control)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.control.getSnapshot().screen.kind, 'idle')
  assert.equal(next.listeners.size, 1)
  h.screen(h.prompt('My chat', false))
  h.input(menu(oldSend))
  await settle()
  assert.match(h.content(), /Collection floor · 7d/)
  assert.equal(oldVoice.run(), false)
  next.screen(h.prompt('My chat', false))
  await settle()
  const otherSend = h.itemID('Send')
  assert.notEqual(otherSend, oldSend)
  h.input(menu(oldSend))
  h.disconnect()
  h.input(menu(otherSend))
  await settle()
  assert.equal(next.listeners.size, 0)
  assert.equal(next.control.getSnapshot().screen.kind, 'idle')
  assert.equal(next.control.activate.mock.callCount(), 0)
  assert.equal(h.control.activate.mock.callCount(), 0)
  assert.match(h.content(), /Open TeleGifts on your phone/)
})

test('a failed upload for the previous chart leaves a phone-started recording active', async t => {
  const h = await setup(t)
  t.mock.method(console, 'warn', () => {})
  const upload = Promise.withResolvers()
  h.bridge.updateImageRawData.mock.mockImplementationOnce(() => upload.promise)
  try {
    await h.chart()
    assert.equal(h.bridge.updateImageRawData.mock.callCount(), 1)
    h.voice.controls.start()
    await settle()
    assert.equal(h.voice.controls.getSnapshot().phase, 'listening')
    upload.reject(new Error('lost chart acknowledgement'))
    await settle()
    assert.equal(h.voice.controls.getSnapshot().phase, 'listening')
    assert.match(h.content(), /Listening…/)
    assert.equal(h.control.share.mock.callCount(), 0)
  } finally { upload.resolve('success') }
})

test('question previews preserve emoji and long details fit a native rebuild with a phone continuation', async t => {
  const h = await setup(t)
  const q = { ...state.questions[0], text: 'a'.repeat(70) + '💚bc' }
  h.publish({ state: { ...state, questions: [q] }, screen: { kind: 'questions', index: 0 } })
  await settle()
  assert.ok(h.content().includes('a'.repeat(70) + '💚…'))
  const family = '👩‍👩‍👧‍👧'
  const long = { ...q, sender: family.repeat(100), chatLabel: family.repeat(100), text: family.repeat(400) }
  h.publish({ state: { ...state, questions: [long] } })
  await settle()
  assert.ok(h.content().length <= 1000)
  assert.ok(h.content().includes('Tap to read'))
  h.screen({ kind: 'question', question: long })
  await settle()
  assert.ok(h.content().length <= 1000)
  assert.match(h.content(), /Tap to use for reply/)
  assert.match(h.content(), /(?:👩‍👩‍👧‍👧)+…\nRead the full question on your phone\.$/)
  assert.equal(h.content().replaceAll(family, '').includes('👩'), false)
})

test('compose R1 Ring PTT supports free-form dictation (Tap-to-send only), compose commands, and offline fallback', async t => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  let hubEvent
  let layout
  let audioSeq = 0

  const bridge = {
    ready: true,
    audioControl: t.mock.fn(async () => true),
    createStartUpPageContainer: t.mock.fn(async p => { layout = p; return 0 }),
    rebuildPageContainer: t.mock.fn(async p => { layout = p; return true }),
    textContainerUpgrade: t.mock.fn(async p => { layout.textObject[0].content = p.content; return true }),
    updateImageRawData: t.mock.fn(async () => 'success'),
    onEvenHubEvent(fn) { hubEvent = fn; return () => { hubEvent = undefined } },
    onDeviceStatusChanged() { return () => {} },
  }
  globalThis.window = Object.assign(new EventTarget(), { EvenAppBridge: bridge })
  globalThis.document = Object.assign(new EventTarget(), { hidden: false })

  let snap = {
    state,
    selectedQuestion: state.questions[0],
    screen: {
      kind: 'compose',
      composeSessionId: 1,
      question: state.questions[0],
      destination: 'Gift group',
      destinationId: 'group',
      drafts: [
        { id: 'venue-spread', label: 'Venue spread', collection: 'Toy Bear', text: 'Toy Bear 10 GRAM on MRKT.' },
        { id: 'quick-ack', label: 'Quick ack', collection: 'Toy Bear', text: 'Checking Toy Bear now.' },
      ],
      index: 0,
      dictation: true,
      askerFeedback: 'seen',
    },
  }
  const listeners = new Set()
  const applyVoiceReply = t.mock.fn(() => true)
  const applyDictatedReply = t.mock.fn(text => {
    snap = {
      ...snap,
      screen: {
        ...snap.screen,
        drafts: [{ id: 'dictated-1', label: 'Dictated', text: `${text}.` }, ...snap.screen.drafts],
        index: 0,
      },
    }
    for (const l of listeners) l()
    return true
  })
  const activate = t.mock.fn()
  const store = {
    getSnapshot: () => snap,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    openQuestions: t.mock.fn(),
    step: t.mock.fn(),
    activate,
    back: t.mock.fn(),
    share: t.mock.fn(),
    cancelDraft: t.mock.fn(),
    applyVoiceReply,
    applyDictatedReply,
  }

  let session
  const display = createCollectionDisplay(() => session?.update())
  display.companion.setTelegram(store)
  const disconnect = display.companion.connect({
    loadCatalog: async () => ({ collection_floors: { 'Toy Bear': { mrkt: 10 } } }),
    loadArtwork: async () => null,
    loadFloorChart: async () => series,
    canUseVoiceTarget: () => true,
    back: () => false,
    setFavorite: () => {},
  })
  display.companion.marketChanged({ period: '7d', filter: 'all', observations: new Map(), browse: { status: 'catalog' }, stale: false })

  let dictationResponse = 'I can pick up that Toy Bear at 9.5 GRAM'
  const transcribeDictation = t.mock.fn(async () => dictationResponse)
  const transcribeOffline = t.mock.fn(async () => 'next draft')
  const voice = createVoiceControl({
    names: () => ['Toy Bear'],
    resolve: display.resolveVoice,
    transcribe: transcribeOffline,
  })
  session = await connectGlasses({ ...display, voice, transcribeDictation, showDisplayError: t.mock.fn() }, () => {})
  t.after(async () => {
    await session?.stop()
    disconnect()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  })

  await settle()
  await new Promise(r => setTimeout(r, 30))
  assert.ok(validateEvenHubPageContainer(layout).valid)
  const composeHeader = layout.textObject.find(t => t.zOrderIndex === 1)?.content ?? ''
  const composeFooter = layout.textObject.find(t => t.zOrderIndex === 3)?.content ?? ''
  assert.match(composeHeader, /· SEEN/)
  assert.match(composeFooter, /Hold R1: Dictate/)

  // Helper to simulate R1 Ring hold + voiced 16kHz PCM + release
  const emitPtt = async () => {
    hubEvent(evenHubEventFromJson({ type: 'sys_event', jsonData: { Event_Type: os.LONG_PRESS_EVENT } }))
    await new Promise(r => setTimeout(r, 20))
    for (let f = 0; f < 4; f++) {
      const pcm = new Uint8Array(3200)
      const view = new DataView(pcm.buffer)
      for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round(Math.sin((f * 1600 + i) * 0.25) * 9000), true)
      hubEvent({ audioEvent: { source: 'glasses', audioPcm: pcm, seq: ++audioSeq, speakerRole: 'self' } })
    }
    hubEvent(evenHubEventFromJson({ type: 'sys_event', jsonData: { Event_Type: os.LONG_PRESS_RELEASE_EVENT } }))
    await new Promise(r => setTimeout(r, 40))
  }

  // 1. Free-form dictation inserts Dictated draft at index 0 and NEVER auto-sends
  await emitPtt()
  assert.equal(applyDictatedReply.mock.callCount(), 1)
  assert.equal(applyDictatedReply.mock.calls[0].arguments[0], 'I can pick up that Toy Bear at 9.5 GRAM')
  assert.equal(activate.mock.callCount(), 0, 'Dictation must NEVER auto-send without explicit Tap')
  assert.equal(applyVoiceReply.mock.callCount(), 0)

  // 2. Spoken "send reply" rejected by store on dictated draft MUST NOT poison submittedComposeId for subsequent physical Tap
  applyVoiceReply.mock.mockImplementationOnce(() => false)
  dictationResponse = 'send reply'
  await emitPtt()
  assert.equal(applyVoiceReply.mock.callCount(), 1)
  assert.equal(activate.mock.callCount(), 0)
  hubEvent(evenHubEventFromJson({ type: 'text_event', jsonData: { Container_ID: layout.textObject[0].containerID, Event_Type: os.CLICK_EVENT } }))
  await settle()
  assert.equal(activate.mock.callCount(), 1, 'Physical Tap after rejected spoken send must still work')

  // 3. Spoken compose command ("next draft") routes to applyVoiceReply instead of inserting a literal dictated draft
  dictationResponse = 'next draft'
  await emitPtt()
  assert.equal(applyVoiceReply.mock.callCount(), 2)
  assert.equal(applyVoiceReply.mock.calls[1].arguments[0], 'next draft')
  assert.equal(applyDictatedReply.mock.callCount(), 1)

  // 4. Returning null from transcribeDictation (no LLM key) falls back to offline JSGF picker
  dictationResponse = null
  await emitPtt()
  assert.equal(transcribeOffline.mock.callCount(), 1)
  assert.equal(applyVoiceReply.mock.callCount(), 3)
})
