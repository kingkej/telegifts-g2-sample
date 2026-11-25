import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settleTurn } from 'node:timers/promises'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { createGiftiTool } from '../src/giftiTool.ts'
import { createToolbox } from '../src/toolbox.ts'

const root = { collection_floors: {
  'Plush Pepe': { portals: 4200, mrkt: 4150 }, 'Toy Bear': { mrkt: 12 }, Other: { tonnel: 5 },
} }

function phone(loadCatalog = async () => root) {
  const display = createCollectionDisplay(() => {})
  const opened = []
  const favorites = { ready: true, visible: false, collections: [] }
  const favoriteWrites = []
  const controls = {
    loadCatalog, loadArtwork: async () => null,
    open: (item, afterSelect) => {
      opened.push(item)
      display.companion.select(item)
      afterSelect?.()
      return true
    },
    canUseVoiceTarget: () => true,
    setFavorite: (item, saved) => {
      favoriteWrites.push([item.id, saved])
      favorites.collections = favorites.collections.filter(row => row.id !== item.id)
      if (saved) favorites.collections.push({ id: item.id, name: item.name })
      display.companion.favoritesChanged({ ...favorites })
    },
    showFavorites: visible => {
      favorites.visible = visible
      display.companion.favoritesChanged({ ...favorites })
      return true
    },
    back: () => {
      const screen = display.current()
      if (!screen.detail) return false
      display.companion.select(null)
      return true
    },
  }
  return { display, controls, opened, favorites, favoriteWrites }
}

test('tool voice previews use the focused collection and expire on page, installation, or native lifetime changes', async t => {
  const { display, controls, favoriteWrites } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  const chart = () => ({ key: 'task', title: 'Toy Bear', lines: [], actions: [{ id: 'record-floor', label: 'Record floor' }] })
  let page = null, listener
  const tools = { getSnapshot: () => page, subscribe(fn) { listener = fn; return () => { listener = undefined } },
    getPhoneSnapshot: () => null, open: t.mock.fn(() => true), act: t.mock.fn(() => true), back: t.mock.fn(), close: t.mock.fn() }
  display.companion.setTools(tools)
  assert.equal(display.resolveVoice('open research').run(), true)
  assert.deepEqual(tools.open.mock.calls[0].arguments, ['research', { collection: 'Plush Pepe' }, 'glasses'])
  page = chart(); listener()
  assert.equal(display.resolveVoice('record floor', undefined, 'phone').run(), false)
  const record = () => display.resolveVoice('record floor')
  const retired = record(); page = chart(); listener()
  assert.equal(retired.run(), false)
  assert.equal(record().run(AbortSignal.abort()), false)
  assert.equal(record().run(), true)
  assert.deepEqual(tools.act.mock.calls[0].arguments, [page, 'record-floor'])
  assert.equal(display.resolveVoice('save this gift').run(), false)
  assert.deepEqual(favoriteWrites, [])
  assert.equal(display.resolveVoice('go back').run(), true)
  assert.equal(tools.back.mock.callCount(), 1)
  page = { ...chart(), actions: [{ id: 'record-floor', label: 'Confirm write', requiresConfirmation: true }] }; listener()
  assert.equal(record().run(), false)
  page = { ...chart(), actions: [{ id: 'add-to-watchlist', label: 'Review add' }] }; listener()
  assert.equal(display.resolveVoice('add to watchlist').run(), true)
  assert.deepEqual(tools.act.mock.calls.at(-1).arguments, [page, 'add-to-watchlist'])
  const previousBack = display.resolveVoice('go back')
  display.companion.setTools(null)
  assert.equal(previousBack.run(), false)
  assert.equal(tools.close.mock.callCount(), 1)
})

test('open gift chat opens Gifti from the glasses or selects its current menu entry', async t => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  let page = null, changed
  const tools = {
    getSnapshot: () => page, subscribe(fn) { changed = fn; return () => {} },
    open: t.mock.fn(() => true), act: t.mock.fn(() => true),
  }
  display.companion.setTools(tools)
  const shortcut = () => display.resolveVoice('open gift chat')
  const open = shortcut()
  assert.equal(open.kind, 'action')
  assert.equal(open.confirm, false)
  assert.equal(open.run(), true)
  assert.deepEqual(tools.open.mock.calls[0].arguments, ['gifti', { collection: 'Plush Pepe' }, 'glasses'])

  page = { key: 'tools', actions: [{ id: 'gifti', label: 'Gifti' }] }
  changed()
  assert.equal(open.run(), false)
  assert.equal(shortcut().run(), true)
  assert.deepEqual(tools.act.mock.calls[0].arguments, [page, 'gifti'])
  page = { key: 'gifti', actions: [] }
  changed()
  assert.equal(shortcut().run(), false)
  assert.equal(tools.act.mock.callCount(), 1)
})

test('Ask Gifti opens lens consent and Favorites speech opens movers with the current collection', async t => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await settleTurn()
  const tools = { getSnapshot: () => null, subscribe() { return () => {} }, open: t.mock.fn(() => true) }
  display.companion.setTools(tools)
  assert.equal(display.resolveVoice('ask Gifti', undefined, 'phone').run(), false)
  assert.equal(display.resolveVoice('ask Gifti').run(), true)
  assert.equal(display.resolveVoice('what changed in my favorites').run(), true)
  assert.deepEqual(tools.open.mock.calls.map(call => call.arguments), [
    ['gifti', { collection: 'Plush Pepe', entry: 'talk' }, 'glasses'],
    ['favorite-movers', { collection: 'Plush Pepe' }, 'glasses'],
  ])
})

for (const cancel of ['native exit', 'Back', 'favorite removal']) {
  test(`mover chart handoff stops on ${cancel} before a delayed selection`, async t => {
    const { display, controls } = phone()
    let after, lifetime
    controls.open = (_item, complete, _origin, signal) => { after = complete; lifetime = signal; return true }
    controls.loadFloorChart = t.mock.fn(async () => ({ from: 0, to: 86400, interval: 900, points: [] }))
    display.companion.connect(controls)
    await settleTurn()
    const saved = { id: 'bear', name: 'Toy Bear' }
    const page = { key: 'mover', title: saved.name, lines: [], actions: [] }
    let shown = page
    const store = { getSnapshot: () => shown, getPhoneSnapshot: () => null, getActiveTool: () => 'favorite-movers',
      subscribe() { return () => {} }, close() { shown = null } }
    display.companion.setTools(store)
    assert.equal(display.companion.openToolChart(saved.name, '24h'), false)
    display.companion.favoritesChanged({ ready: true, visible: false, collections: [saved] })
    assert.equal(display.companion.openToolChart(saved.name, '24h'), true)
    if (cancel === 'native exit') display.setToolsForeground('native', false)
    else if (cancel === 'Back') assert.ok(display.back())
    else display.companion.favoritesChanged({ ready: true, visible: false, collections: [] })
    assert.ok(lifetime.aborted)
    display.companion.select({ ...saved, floors: {} })
    after()
    assert.equal(controls.loadFloorChart.mock.callCount(), 0)
    assert.equal(display.inspector.getSnapshot().mode, 'overview')
  })
}

for (const telegramOpened of [false, true]) {
  test('delayed chart selection resolves the current catalog and releases Back, Telegram open = ' + telegramOpened, async t => {
    const { display, controls } = phone()
    const saved = { id: 'bear-id', name: 'ToyBear' }
    let after, selected, screen = 'idle', page = { key: 'mover', actions: [] }
    controls.open = (item, then) => { selected = item; after = then; return true }
    controls.back = t.mock.fn(() => true)
    controls.loadFloorChart = t.mock.fn(async () => ({ from: 0, to: 86400, interval: 900, points: [] }))
    controls.loadCatalog = async () => ({ collection_floors: {} })
    display.companion.connect(controls)
    await settleTurn()
    display.companion.setTelegram({ getSnapshot: () => ({ screen: { kind: screen } }), subscribe: () => () => {} })
    display.companion.setTools({ getSnapshot: () => page, getPhoneSnapshot: () => null, getActiveTool: () => 'favorite-movers',
      subscribe: () => () => {}, close() { page = null } })
    display.companion.favoritesChanged({ ready: true, visible: false, collections: [saved] })
    assert.ok(display.companion.openToolChart(saved.name, '24h'))
    assert.equal(selected.name, 'ToyBear')
    display.companion.catalogChanged(root)
    display.companion.select(selected)
    if (telegramOpened) screen = 'questions'
    after()
    if (telegramOpened) {
      assert.equal(controls.loadFloorChart.mock.callCount(), 0)
      screen = 'idle'
      assert.ok(display.back())
      assert.equal(controls.back.mock.callCount(), 1)
    } else {
      assert.deepEqual(controls.loadFloorChart.mock.calls[0].arguments.slice(0, 2), ['Toy Bear', '24h'])
    }
  })
}

for (const phase of ['recording', 'transcribing', 'sending', 'speaking']) {
  test(`changing the Explore gift during Gifti ${phase} retires the turn and any late follow-up`, async t => {
    const { display, controls } = phone()
    display.companion.connect(controls)
    await settleTurn()
    const recording = Promise.withResolvers(), transcript = Promise.withResolvers()
    const reply = Promise.withResolvers(), playback = Promise.withResolvers()
    const chat = { accessState: { type: 'available' }, currentConversationID: 'thread', visibleMessages: [], currentInputText: '', isSending: false,
      get canSend() { return !this.isSending && this.currentInputText.trim().length > 0 } }
    const store = { prepare: async () => {}, subscribe: () => () => {}, getSnapshot: () => chat,
      canSendSuggestedQuestion: () => !chat.isSending && !chat.currentInputText,
      setCurrentInputText(text) { chat.currentInputText = text },
      sendCurrentMessage: t.mock.fn(async (_api, sent) => {
        chat.visibleMessages.push({ id: 'user', role: 'user', delivery: 'sent', chatID: 'thread', text: chat.currentInputText })
        chat.isSending = true
        chat.currentInputText = ''
        sent('user', 'reply')
        await reply.promise
        chat.isSending = false
        chat.visibleMessages.push({ id: 'reply', role: 'assistant', delivery: 'sent', chatID: 'thread', text: 'Original gift reply' })
      }) }
    const voice = { record: t.mock.fn(() => recording.promise), transcribe: t.mock.fn(() => transcript.promise), speak: t.mock.fn(() => playback.promise) }
    const gifti = createGiftiTool({ store, voice, api: {}, openPhone() {} })
    const tools = createToolbox({}, () => undefined, { gifti: async () => () => gifti })
    display.companion.setTools(tools)
    assert.equal(display.openTools('gifti'), true)
    assert.equal(tools.getActiveTool(), 'gifti')
    await settleTurn()
    assert.match(gifti.getSnapshot().lines[0], /Plush Pepe/)
    assert.ok(tools.act(tools.getSnapshot(), 'talk'))
    assert.ok(tools.act(tools.getSnapshot(), 'start-talking'))
    const signal = voice.record.mock.calls[0].arguments[0]
    if (phase !== 'recording') { recording.resolve(Uint8Array.of(1, 2)); await settleTurn() }
    if (phase === 'sending' || phase === 'speaking') { transcript.resolve('Question about Plush Pepe'); await settleTurn() }
    if (phase === 'speaking') { reply.resolve(); await settleTurn() }
    assert.match(gifti.getSnapshot().key, new RegExp('gifti-' + phase))
    if (phase === 'sending' || phase === 'speaking') {
      assert.equal(chat.visibleMessages[0].text, 'Question about Plush Pepe')
      assert.deepEqual(store.sendCurrentMessage.mock.calls[0].arguments[2], { collection: 'Plush Pepe' })
    }
    const rows = name => ({ id: name, name })
    const market = { period: '7d', filter: 'all', browse: { status: 'rows', rows: ['Toy Bear', 'Plush Pepe'].map(rows) },
      observations: new Map(), stale: false }
    display.companion.marketChanged(market)
    display.companion.catalogChanged({ collection_floors: { 'Plush Pepe': { mrkt: 70 }, 'Toy Bear': { mrkt: 45 } } })
    display.companion.rateChanged(4)
    assert.equal(tools.getSnapshot(), gifti.getSnapshot())
    assert.equal(signal.aborted, false)

    if (phase === 'transcribing') display.move(-1)
    else display.companion.marketChanged({ ...market, browse: { status: 'rows', rows: [rows('Toy Bear')] } })
    assert.equal(display.current().collection.name, 'Toy Bear')
    assert.ok(signal.aborted)
    assert.equal(tools.getSnapshot(), null)
    assert.equal(tools.getActiveTool(), undefined)
    recording.resolve(Uint8Array.of(1, 2))
    transcript.resolve('Stale transcript')
    reply.resolve()
    playback.resolve(true)
    await settleTurn()
    assert.equal(store.sendCurrentMessage.mock.callCount(), phase === 'sending' || phase === 'speaking' ? 1 : 0)
    assert.equal(voice.transcribe.mock.callCount(), phase === 'recording' ? 0 : 1)
    assert.equal(voice.speak.mock.callCount(), phase === 'speaking' ? 1 : 0)
    assert.equal(voice.record.mock.callCount(), 1)
  })
}

test('an unrelated tool survives a new browsed gift and a stale toolbox menu cannot open Gifti for the old gift', async t => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await settleTurn()
  const page = { key: 'gifti-speaking-example', title: 'Research', lines: [], actions: [] }
  const research = { getSnapshot: () => page, subscribe: () => () => {}, open() {}, back: () => false, close() {} }
  const makeGifti = t.mock.fn()
  const tools = createToolbox({}, () => undefined, { research: async () => () => research, gifti: async () => makeGifti })
  display.companion.setTools(tools)
  assert.ok(display.openTools())
  assert.ok(tools.act(tools.getSnapshot(), 'research'))
  await settleTurn()
  display.move(1)
  assert.equal(tools.getSnapshot(), page)
  tools.back()
  display.companion.connect(controls)
  assert.ok(tools.act(tools.getSnapshot(), 'gifti'))
  await settleTurn()
  assert.equal(tools.getSnapshot(), null)
  assert.equal(makeGifti.mock.callCount(), 0)
})

test('Gifti opened on collection detail stays bound to the selection when the underlying ranking changes', async t => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await settleTurn()
  display.tap()
  let page = { key: 'playback' }, notify
  const tools = { getSnapshot: () => page, getActiveTool: () => 'gifti',
    subscribe(fn) { notify = fn; return () => {} },
    close: t.mock.fn(() => { page = null; notify() }) }
  display.companion.setTools(tools)
  const bear = { id: 'Toy Bear', name: 'Toy Bear' }
  display.companion.marketChanged({ period: '7d', filter: 'gainers', observations: new Map(), browse: { status: 'rows', rows: [bear] } })
  display.companion.select({ id: 'Plush Pepe', name: 'Plush Pepe', floors: { mrkt: 65 } })
  assert.equal(tools.close.mock.callCount(), 0)
  display.companion.select({ ...bear, floors: {} })
  assert.equal(tools.close.mock.callCount(), 1)
})

test('replacing an attached toolbox inherits a native exit received before phone controls connected', t => {
  const { display, controls } = phone()
  const toolbox = () => ({ getSnapshot: () => null, subscribe: () => () => {}, close: t.mock.fn(), setForeground: t.mock.fn() })
  const first = toolbox(), replacement = toolbox()
  display.setToolsForeground('native', false)
  display.companion.setTools(first)
  assert.deepEqual(first.setForeground.mock.calls.at(-1).arguments, ['display', false])
  display.companion.connect(controls)
  display.companion.setTools(replacement)
  assert.equal(first.close.mock.callCount(), 1)
  assert.deepEqual(replacement.setForeground.mock.calls.at(-1).arguments, ['display', false])
  display.setToolsForeground('document', false)
  display.setToolsForeground('native', true)
  assert.deepEqual(replacement.setForeground.mock.calls.at(-1).arguments, ['display', false])
  display.setToolsForeground('document', true)
  assert.deepEqual(replacement.setForeground.mock.calls.at(-1).arguments, ['display', true])
})

test('a tap opens the real phone sheet and any phone selection sets the glasses detail', async () => {
  const { display, controls, opened } = phone()
  assert.equal(display.current().status, 'waiting')
  display.tap()
  assert.equal(opened.length, 0)
  display.companion.connect(controls)
  await Promise.resolve()
  assert.equal(display.current().collection.name, 'Plush Pepe')
  display.tap()
  assert.deepEqual(opened, [{ id: 'Plush Pepe', name: 'Plush Pepe', floors: root.collection_floors['Plush Pepe'] }])
  assert.equal(display.current().detail, true)
  display.companion.select({ id: 'Other', name: 'Other', floors: { tonnel: 5 } })
  assert.equal(display.current().collection.floor.price, 5)
  display.companion.select({ id: 'Empty', name: 'Empty', floors: {} })
  assert.equal(display.current().status, 'unpriced')
  assert.equal(display.current().name, 'Empty')
  assert.equal(display.current().detail, true)
  assert.equal(display.back(), true)
  assert.equal(display.current().detail, false)
  assert.equal(display.back(), false)
})

test('a late response from an unmounted app cannot replace the new app’s selection or catalog', async () => {
  const stale = Promise.withResolvers()
  const { display, controls } = phone()
  const disconnect = display.companion.connect({ ...controls, loadCatalog: () => stale.promise })
  disconnect()
  display.companion.connect(controls)
  display.companion.select({ id: 'Toy Bear', name: 'Toy Bear', floors: { mrkt: 12 } })
  stale.resolve({ collection_floors: { 'Wrong collection': { mrkt: 99 } } })
  await Promise.resolve()
  assert.equal(display.current().collection.name, 'Toy Bear')
  display.back()
  assert.equal(display.current().collection.name, 'Toy Bear')
  display.move(-1)
  assert.equal(display.current().collection.name, 'Plush Pepe')
})

test('a tap retries a failed catalog through the same phone client', async () => {
  const calls = []
  const { display, controls } = phone(async force => {
    calls.push(force)
    if (!force) throw new Error('offline')
    return root
  })
  display.companion.connect(controls)
  await Promise.resolve()
  assert.equal(display.current().status, 'error')
  display.tap()
  await Promise.resolve()
  assert.deepEqual(calls, [false, true])
  assert.equal(display.current().collection.name, 'Plush Pepe')
})

test('a fresh phone catalog updates both the selected detail and the next glasses tap', async () => {
  const stale = Promise.withResolvers()
  const { display, controls, opened } = phone(() => stale.promise)
  display.companion.connect(controls)
  display.companion.select({ id: 'Toy Bear', name: 'Toy Bear', floors: {} })
  assert.equal(display.current().status, 'unpriced')
  display.companion.catalogChanged({ collection_floors: {
    'Toy Bear': { getgems: 78 }, 'Plush Pepe': { mrkt: 4000 },
  } })
  stale.resolve(root)
  await Promise.resolve()
  assert.equal(display.current().collection.floor.price, 78)
  display.back()
  display.tap()
  assert.deepEqual(opened[0].floors, { mrkt: 4000 })
  display.companion.catalogChanged({ collection_floors: {} })
  assert.equal(display.current().status, 'unpriced')
})

test('a phone sheet such as Heatmap consumes Back even after its collection detail closes', () => {
  const { display, controls } = phone()
  let sheets = 1
  display.companion.connect({ ...controls, back: () => sheets-- > 0 })
  assert.equal(display.back(), true)
  assert.equal(display.back(), false)
})

test('browse, save, reopen Favorites and remove through the shared phone store', async () => {
  const { display, controls, favorites, favoriteWrites } = phone()
  display.companion.connect(controls)
  display.companion.favoritesChanged(favorites)
  await Promise.resolve()
  display.move(1)
  const toy = display.current()
  assert.equal(toy.collection.name, 'Toy Bear')
  assert.equal(toy.position, 2)
  display.tap()
  display.tap()
  assert.deepEqual(favoriteWrites, [['Toy Bear', true]])
  assert.equal(display.current().saved, true)
  display.back()
  display.openFavorites()
  assert.equal(display.current().section, 'favorites')
  assert.equal(display.current().total, 1)
  display.tap()
  controls.setFavorite({ id: 'Toy Bear', name: 'Toy Bear', floors: {} }, false)
  assert.equal(display.current().saved, false)
  display.back()
  assert.equal(display.current().status, 'empty')
  assert.equal(display.back(), true)
  assert.equal(display.current().collection.name, 'Toy Bear')
  assert.equal(display.back(), false)
})

test('keeps focus by identity across reorder, missing quotes, and removal of a saved row', async () => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  display.move(1)
  display.companion.catalogChanged({ collection_floors: { 'Plush Pepe': { mrkt: 1 }, 'Toy Bear': { mrkt: 900 } } })
  assert.equal(display.current().collection.name, 'Toy Bear')
  assert.equal(display.current().position, 1)
  const saved = ['Other', 'Legacy', 'Toy Bear'].map(name => ({ id: name, name }))
  display.companion.favoritesChanged({ ready: true, visible: true, collections: saved })
  display.move(1)
  assert.equal(display.current().name, 'Legacy')
  assert.equal(display.current().status, 'unpriced')
  display.companion.favoritesChanged({ ready: true, visible: true, collections: [saved[0], saved[2]] })
  assert.equal(display.current().collection.name, 'Toy Bear')
  assert.equal(display.current().position, 2)
})

test('favorites remain browsable offline and do not accept saves before hydration', async () => {
  const { display, controls, favoriteWrites } = phone(async () => { throw new Error('offline') })
  display.companion.connect(controls)
  const item = { id: 'Missing', name: 'Missing', floors: {} }
  display.companion.select(item)
  display.tap()
  assert.deepEqual(favoriteWrites, [])
  assert.equal(display.current().saved, null)
  display.companion.select(null)
  await Promise.resolve()
  display.companion.favoritesChanged({ ready: true, visible: true, collections: [item] })
  assert.equal(display.current().status, 'unpriced')
  display.tap()
  assert.equal(display.current().detail, true)
  display.tap()
  assert.deepEqual(favoriteWrites, [['Missing', false]])
})

test('Explore restores the selected row after an empty catalog and a later refresh', async () => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  display.move(1)
  display.companion.catalogChanged({ collection_floors: {} })
  assert.equal(display.current().status, 'empty')
  display.companion.catalogChanged(root)
  assert.equal(display.current().collection.name, 'Toy Bear')
  assert.equal(display.current().position, 2)
})

test('a saved spelling alias shares the verified floor and is removed under its stored identity', async () => {
  const legacy = 'Khabibs Papakha', canonical = "Khabib's Papakha"
  const { display, controls, favorites, favoriteWrites } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  favorites.collections.push({ id: legacy, name: legacy })
  controls.showFavorites(true)
  assert.equal(display.current().status, 'unpriced')
  display.companion.catalogChanged({ collection_floors: { [canonical]: { mrkt: 45 } } })
  assert.equal(display.current().collection.name, canonical)
  assert.equal(display.current().collection.floor.price, 45)
  display.tap()
  assert.equal(display.current().saved, true)
  display.tap()
  assert.deepEqual(favoriteWrites, [[legacy, false]])
  assert.equal(display.current().saved, false)
})

test('a late catalog rebinds the selected chart to its canonical collection only once', async t => {
  const legacy = 'Khabibs Papakha', canonical = "Khabib's Papakha"
  const { display, controls } = phone()
  controls.loadFloorChart = t.mock.fn(() => new Promise(() => {}))
  display.companion.connect(controls)
  await Promise.resolve()
  display.companion.select({ id: legacy, name: legacy, floors: {} })
  display.inspector.show('chart')
  display.inspector.setRange('7d')
  const prior = controls.loadFloorChart.mock.calls.at(-1).arguments
  assert.deepEqual(prior.slice(0, 2), [legacy, '7d'])
  display.companion.catalogChanged({ collection_floors: { [canonical]: { mrkt: 42 } } })
  assert.ok(prior[3].aborted)
  const current = controls.loadFloorChart.mock.calls.at(-1).arguments
  assert.deepEqual(current.slice(0, 2), [canonical, '7d'])
  assert.equal(display.inspector.getSnapshot().collection, canonical)
  display.companion.catalogChanged({ collection_floors: { [canonical]: { mrkt: 45 } } })
  assert.equal(controls.loadFloorChart.mock.callCount(), 3)
  assert.equal(current[3].aborted, false)
})

test('canonical names preserve the browsed variant, preview model and Back destination', async t => {
  const legacy = 'Khabibs Papakha', canonical = "Khabib's Papakha"
  const { display, controls } = phone()
  const firstArtwork = Promise.withResolvers()
  controls.loadVariants = t.mock.fn(async name => name === legacy ? ['A', 'B'] : ['B', 'A'])
  controls.loadArtwork = t.mock.fn(name => name === canonical ? firstArtwork.promise : Promise.resolve(null))
  display.companion.connect(controls)
  await Promise.resolve()
  display.companion.select({ id: legacy, name: legacy, floors: {} })
  display.inspector.show('variants')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  await settle()
  display.inspector.step(1)
  display.companion.catalogChanged({ collection_floors: { [canonical]: { mrkt: 45 } } })
  await settle()
  let view = display.inspector.getSnapshot()
  assert.deepEqual([view.mode, view.collection, view.names[view.index]], ['variants', canonical, 'B'])
  display.inspector.pickVariant()
  assert.deepEqual(controls.loadArtwork.mock.calls.at(-1).arguments, [canonical, 'B'])
  display.companion.catalogChanged({ collection_floors: {} })
  await settle()
  view = display.inspector.getSnapshot()
  assert.deepEqual([view.mode, view.collection, view.model, view.status, view.fromVariants], ['preview', legacy, 'B', 'empty', true])
  assert.deepEqual(controls.loadArtwork.mock.calls.at(-1).arguments, [legacy, 'B'])
  firstArtwork.reject(new Error('retired artwork request'))
  display.companion.catalogChanged({ collection_floors: {} })
  await settle()
  assert.equal(display.inspector.getSnapshot(), view)
  assert.equal(controls.loadArtwork.mock.callCount(), 2)
  display.inspector.back()
  await settle()
  view = display.inspector.getSnapshot()
  assert.deepEqual([view.mode, view.collection, view.names[view.index]], ['variants', legacy, 'B'])
})

test('the phone ranking drives Explore while details and Favorites keep the current listing floor', async () => {
  const { display, controls, favorites } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  const market = {
    period: '24h', filter: 'losers', stale: false, retry() {},
    browse: { status: 'rows', rows: [{ id: 'Toy Bear', name: 'Toy Bear' }, { id: 'Rare', name: 'Rare' }] },
    observations: new Map([['toybear', { price: 20, changePercent: -10 }], ['rare', { price: 9, changePercent: -5 }]]),
  }
  display.companion.marketChanged(market)
  display.companion.rateChanged(1.5)
  const card = display.current()
  assert.deepEqual([card.collection.name, card.position, card.total], ['Toy Bear', 1, 2])
  assert.deepEqual(card.observation, { price: 20, changePercent: -10, period: '24h', stale: false })
  display.tap()
  assert.equal(display.current().detail, true)
  assert.deepEqual(display.current().collection.floor, { marketplace: 'MRKT', price: 12 })
  display.back()
  display.move(1)
  assert.equal(display.current().name, 'Rare')
  assert.equal(display.current().observation.price, 9)
  display.tap()
  assert.equal(display.current().status, 'unpriced')
  display.back()
  favorites.collections.push({ id: 'Toy Bear', name: 'Toy Bear' })
  controls.showFavorites(true)
  assert.equal(display.current().collection.floor.price, 12)
  display.companion.rateChanged(null)
  assert.equal(display.current().usdtPerGram, null)
  display.companion.marketChanged(null)
  assert.equal(display.current().observation, null)
  assert.equal(display.current().collection.floor.price, 12)
})

test('a filtered scan never exposes unrelated catalog rows and retries the failed ranking', async () => {
  const { display, controls, opened } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  let retries = 0
  const market = { period: '24h', filter: 'gainers', stale: false, observations: new Map(), retry: () => { retries++ } }
  display.companion.marketChanged({ ...market, browse: { status: 'loading' } })
  assert.equal(display.current().status, 'rankingLoading')
  display.tap()
  display.companion.catalogChanged(root)
  assert.equal(display.current().status, 'rankingLoading')
  display.companion.marketChanged({ ...market, browse: { status: 'error' } })
  assert.equal(display.current().status, 'rankingError')
  display.tap()
  assert.equal(retries, 1)
  display.companion.marketChanged({ ...market, browse: { status: 'rows', rows: [] } })
  assert.equal(display.current().status, 'noMatches')
  display.tap()
  assert.deepEqual(opened, [])
  assert.equal(retries, 1)
  display.companion.marketChanged({ ...market, filter: 'all', browse: { status: 'catalog' } })
  assert.equal(display.current().collection.name, 'Plush Pepe')
})

test('a search in Favorites limits navigation while preserving saved membership', async () => {
  const { display, controls, opened, favorites } = phone()
  display.companion.connect(controls)
  await Promise.resolve()
  const bear = { id: 'Toy Bear', name: 'Toy Bear' }
  const pepe = { id: 'Plush Pepe', name: 'Plush Pepe' }
  favorites.collections = [pepe, bear]
  controls.showFavorites(true)
  display.companion.favoriteListChanged([bear])
  display.tap()
  assert.equal(opened.at(-1).name, 'Toy Bear')
  assert.equal(display.current().total, 1)
  display.back()
  display.companion.favoriteListChanged([])
  assert.equal(display.current().status, 'noMatches')
  display.tap()
  assert.equal(opened.length, 1)
  display.companion.select({ ...pepe, floors: {} })
  assert.equal(display.current().saved, true)
  display.back()
  display.companion.favoriteListChanged(null)
  assert.equal(display.current().total, 2)
})

test('cached search results can be opened without promoting the cached floor to a live quote', async () => {
  const { display, controls } = phone(async () => { throw new Error('offline') })
  display.companion.connect(controls)
  await Promise.resolve()
  display.companion.marketChanged({
    period: '7d', filter: 'all', stale: false, observations: new Map(), retry() {},
    browse: { status: 'rows', rows: [{ id: 'Archived', name: 'Archived', cachedFloor: 12 }] },
  })
  assert.equal(display.current().cachedFloor, 12)
  display.tap()
  assert.equal(display.current().status, 'unpriced')
  assert.equal(display.current().cachedFloor, null)
})

test('voice names follow the entire live catalog and a choice cannot open a removed collection', async () => {
  const { display, controls, opened } = phone()
  assert.deepEqual(display.voiceNames(), [])
  const disconnect = display.companion.connect(controls)
  await Promise.resolve()
  display.companion.catalogChanged({ collection_floors: {
    'B-Day Candle': {}, 'B Day Candle': { getgems: 8 }, 'Plush Pepe': { mrkt: 10 },
  } })
  assert.deepEqual(display.voiceNames(), ['B-Day Candle', 'B Day Candle', 'Plush Pepe'])
  const choices = display.resolveVoice('Open the B Day Candle card')
  assert.deepEqual(choices.labels, ['B-Day Candle', 'B Day Candle'])
  const removed = choices.choose(0), kept = choices.choose(1)
  display.companion.catalogChanged({ collection_floors: { 'Plush Pepe': { mrkt: 10 }, 'B Day Candle': { getgems: 22 } } })
  assert.equal(removed.run(), false)
  assert.equal(kept.run(), true)
  assert.deepEqual(opened, [{ id: 'B Day Candle', name: 'B Day Candle', floors: { getgems: 22 } }])
  disconnect()
  assert.deepEqual(display.voiceNames(), [])
  assert.equal(display.resolveVoice('Go back').kind, 'unknown')
})

test('a delayed phone selection opens one 7d history read and publishes the same chart on both surfaces', async () => {
  const { display, controls } = phone()
  const inspected = [], reads = [], requests = []
  const series = Promise.withResolvers()
  display.companion.inspector.subscribe(() => inspected.push(display.companion.inspector.getSnapshot()))
  let detailMounted = false
  display.companion.connect({
    ...controls,
    canUseVoiceTarget: selection => !selection || detailMounted,
    open(item, afterSelect) { requests.push({ item, afterSelect }); return true },
    loadFloorChart(name, range) { reads.push([name, range]); return series.promise },
  })
  await Promise.resolve()
  const chart = display.resolveVoice('Show Toy Bear’s seven-day floor chart')
  assert.equal(display.resolveVoice('Show the 3D preview of Other', undefined, 'phone').run(), false)
  assert.equal(requests.length, 0)
  const preview = display.resolveVoice('Show the 3D preview of Other')
  assert.equal(chart.run(), true)
  assert.equal(display.current().detail, false)
  assert.deepEqual(reads, [])
  assert.equal(requests.length, 1)
  const [request] = requests
  display.companion.select(request.item)
  assert.deepEqual(display.companion.inspector.getSnapshot(), { mode: 'overview' })
  request.afterSelect()
  assert.deepEqual(reads, [['Toy Bear', '7d']])
  assert.deepEqual(inspected, [{ mode: 'chart', collection: 'Toy Bear', range: '7d', fromVariants: false, status: 'loading' }])
  assert.equal(display.current().inspection, inspected[0])
  detailMounted = true
  series.resolve({ from: 0, to: 0, interval: 1, points: [] })
  await series.promise
  assert.equal(display.companion.inspector.getSnapshot(), display.current().inspection)
  assert.equal(display.current().inspection.status, 'empty')
  assert.equal(preview.run(), false)
  assert.equal(display.resolveVoice('show the chart').run(), true)
  assert.deepEqual(reads, [['Toy Bear', '7d']])
})

for (const sameGift of [true, false]) {
  test('deferred voice chart compares the canonical favorite with the selected gift, same gift = ' + sameGift, async t => {
    const catalog = Promise.withResolvers()
    const { display, controls } = phone(() => catalog.promise)
    const saved = { id: 'saved-papakha', name: 'Khabibs Papakha' }
    const canonical = "Khabib's Papakha"
    controls.open = t.mock.fn(() => true)
    controls.loadFloorChart = t.mock.fn(async () => ({ from: 0, to: 86400, interval: 900, points: [] }))
    display.companion.connect(controls)
    display.companion.favoritesChanged({ ready: true, visible: true, collections: [saved] })

    assert.ok(display.resolveVoice('show the seven day chart').run())
    const [requested, afterSelect] = controls.open.mock.calls[0].arguments
    assert.equal(requested.name, saved.name)
    catalog.resolve({ collection_floors: { [canonical]: {}, Other: {} } })
    await settleTurn()
    display.companion.select(sameGift ? requested : { id: 'Other', name: 'Other', floors: {} })
    afterSelect()

    const reads = controls.loadFloorChart.mock.calls.map(call => call.arguments.slice(0, 2))
    assert.deepEqual(reads, sameGift ? [[canonical, '7d']] : [])
    assert.equal(display.current().inspection.mode, sameGift ? 'chart' : 'overview')
  })
}

test('current preview and explicit chart ranges use the live inspector and preserve its selected period', async () => {
  const { display, controls } = phone()
  const reads = [], artwork = []
  display.companion.connect({
    ...controls, loadFloorChart: async (name, range) => { reads.push([name, range]); return { points: [] } },
    loadArtwork: async name => { artwork.push(name); return null },
  })
  await Promise.resolve()
  const target = { id: 'legacy-id', name: 'Toy Bear', floors: {} }
  display.companion.select(target)
  for (const [text, mode, range] of [
    ['show the three d preview', 'preview'], ['show this gift’s 30 day floor chart', 'chart', '30d'],
    ['show the 24 hour chart', 'chart', '24h'], ['show the 3d preview', 'preview'],
    ['show the chart', 'chart', '24h'], ['open this card', 'overview'],
  ]) {
    assert.equal(display.resolveVoice(text).run(), true, text)
    assert.equal(display.current().inspection.mode, mode, text)
    assert.equal(display.companion.inspector.getSnapshot().range, range, text)
  }
  assert.deepEqual(reads, [['Toy Bear', '30d'], ['Toy Bear', '24h'], ['Toy Bear', '24h']])
  assert.deepEqual(artwork, ['Toy Bear', 'Toy Bear'])
})

test('a save is bound to its gift, requires confirmation, and never toggles an existing favorite', async () => {
  const { display, controls, favorites, favoriteWrites } = phone()
  const disconnect = display.companion.connect(controls)
  await Promise.resolve()
  const save = () => display.resolveVoice('Save this gift')
  assert.equal(save().run(), false)
  display.companion.favoritesChanged(favorites)
  const onPepe = save()
  assert.equal(onPepe.confirm, true)
  assert.deepEqual(favoriteWrites, [])
  display.move(1)
  assert.equal(onPepe.run(), false)
  const onBear = save()
  assert.match(onBear.label, /Toy Bear/)
  assert.equal(onBear.run(), true)
  assert.equal(onBear.run(), true)
  assert.equal(save().run(), true)
  assert.deepEqual(favoriteWrites, [['Toy Bear', true]])
  display.tap()
  const onDetail = save()
  display.companion.select({ id: 'Other', name: 'Other', floors: {} })
  assert.equal(onDetail.run(), false)
  const beforeDisconnect = save()
  disconnect()
  display.companion.connect(controls)
  display.companion.select({ id: 'Other', name: 'Other', floors: {} })
  assert.equal(beforeDisconnect.run(), false)
  assert.deepEqual(favoriteWrites, [['Toy Bear', true]])
})

test('declined, covered and unrelated selections never inherit a requested view or write', async () => {
  const { display, controls, favoriteWrites, favorites } = phone()
  const reads = []
  let covered = false
  display.companion.connect({
    ...controls, canUseVoiceTarget: () => !covered, open: () => false,
    loadFloorChart: async (...args) => { reads.push(args); return { points: [] } },
  })
  display.companion.favoritesChanged(favorites)
  await Promise.resolve()
  assert.equal(display.resolveVoice('Show Toy Bear’s seven day floor chart').run(), false)
  display.companion.select({ id: 'Toy Bear', name: 'Toy Bear', floors: {} })
  const save = display.resolveVoice('Save this gift')
  covered = true
  assert.equal(save.run(), false)
  assert.equal(display.resolveVoice('Show the floor chart').run(), false)
  assert.equal(display.current().inspection.mode, 'overview')
  assert.deepEqual(reads, [])
  assert.deepEqual(favoriteWrites, [])
  covered = false
  assert.equal(display.resolveVoice('Open Other').run(), false)
  assert.equal(display.current().collection.name, 'Toy Bear')
})

test('voice Favorites and Back use the phone navigation stack and report rejected navigation', async () => {
  const { display, controls, favorites } = phone()
  let popSheet = true, allowFavorites = false
  const tabs = []
  display.companion.connect({
    ...controls,
    showFavorites(visible) {
      tabs.push(visible)
      return allowFavorites && controls.showFavorites(visible)
    },
    back() { if (!popSheet) return false; popSheet = false; return true },
  })
  display.companion.favoritesChanged(favorites)
  await Promise.resolve()
  assert.equal(display.resolveVoice('go back').run(), true)
  assert.equal(display.resolveVoice('go back').run(), true)
  assert.equal(display.resolveVoice('show favorites').run(), false)
  allowFavorites = true
  assert.equal(display.resolveVoice('open favorites').run(), true)
  assert.equal(display.resolveVoice('open favorites').run(), true)
  assert.equal(display.current().section, 'favorites')
  assert.equal(display.resolveVoice('back').run(), true)
  assert.deepEqual(tabs, [true, true, false])
})

test('gesture Back consumes closing Favorites with a legacy void phone callback', async () => {
  const { display, controls, favorites } = phone()
  display.companion.connect({ ...controls, showFavorites: visible => { controls.showFavorites(visible) } })
  favorites.visible = true
  display.companion.favoritesChanged(favorites)
  await Promise.resolve()
  assert.equal(display.back(), true)
  assert.equal(display.current().section, 'explore')
})

test('a refused inspection Back stays on its model, while a legacy host retains local gesture Back', async () => {
  for (const phoneOwnsBack of [true, false]) {
    const { display, controls } = phone()
    const handled = []
    display.companion.connect({ ...controls, loadVariants: async () => ['Amber'],
      back: () => { handled.push('sheet'); return false },
      ...(phoneOwnsBack && { backFromInspection: () => { handled.push('inspection'); return false } }),
    })
    display.companion.select({ id: 'Toy Bear', name: 'Toy Bear', floors: {} })
    display.inspector.show('variants')
    await Promise.resolve()
    assert.equal(display.resolveVoice('Go back').run(), false)
    assert.equal(display.back(), !phoneOwnsBack)
    assert.equal(display.inspector.getSnapshot().mode, phoneOwnsBack ? 'variants' : 'overview')
    assert.deepEqual(handled, phoneOwnsBack ? ['inspection', 'inspection'] : ['sheet'])
  }
})

test('spoken Back dismisses at an empty Explore root, while physical Back reports no navigation', async () => {
  const { display, controls } = phone(async () => ({ collection_floors: {} }))
  display.companion.connect(controls)
  await Promise.resolve()
  assert.equal(display.current().status, 'empty')
  assert.equal(display.resolveVoice('go back').run(), true)
  assert.equal(display.back(), false)
})

test('the accepted action signal follows the exact phone request and fences its deferred inspector', async () => {
  const { display, controls } = phone()
  const actions = [], reads = []
  display.companion.connect({
    ...controls,
    open(item, afterSelect, origin, signal) { actions.push({ item, afterSelect, origin, signal }); return true },
    loadFloorChart: async (...args) => { reads.push(args); return { points: [] } },
  })
  await Promise.resolve()
  const lifetime = new AbortController()
  const chart = display.resolveVoice('show the seven day chart for Toy Bear')
  assert.equal(chart.run(lifetime.signal), true)
  const [accepted] = actions
  assert.equal(accepted.signal, lifetime.signal)
  lifetime.abort()
  assert.equal(chart.run(lifetime.signal), false)
  assert.equal(actions.length, 1)
  display.companion.select(accepted.item)
  accepted.afterSelect()
  assert.equal(display.current().inspection.mode, 'overview')
  assert.deepEqual(reads, [])
})

test('a delayed voice Back cannot dismiss a foreign phone surface that leaves the glasses context unchanged', async () => {
  const { display, controls } = phone()
  let covered = false, backs = 0
  display.companion.connect({
    ...controls, canUseVoiceTarget: () => !covered, back: () => { backs++; return true },
  })
  await Promise.resolve()
  display.tap()
  const beforeForm = display.resolveVoice('Go back')
  covered = true
  assert.equal(beforeForm.run(), false)
  assert.equal(display.resolveVoice('Go back').run(), false)
  assert.equal(backs, 0)
  assert.equal(display.back(), true)
  assert.equal(backs, 1)
})

test('voice can leave its selected chart for another named chart or Favorites; taps use the ordinary route', async () => {
  const { display, controls, opened, favorites } = phone()
  const origins = []
  display.companion.connect({
    ...controls,
    open(item, afterSelect, origin) { origins.push(origin?.id); return controls.open(item, afterSelect) },
    showFavorites(visible, origin) {
      origins.push(origin?.id)
      if (origin) display.companion.select(null)
      return controls.showFavorites(visible)
    },
    loadFloorChart: async () => ({ points: [] }),
  })
  display.companion.favoritesChanged(favorites)
  await Promise.resolve()
  display.tap()
  assert.equal(display.resolveVoice('show the 7d chart').run(), true)
  assert.equal(display.resolveVoice('show the 30d chart for Toy Bear').run(), true)
  assert.equal(display.current().inspection.range, '30d')
  assert.equal(display.resolveVoice('show Favorites').run(), true)
  assert.equal(display.current().section, 'favorites')
  assert.deepEqual(opened.map(item => item.name), ['Plush Pepe', 'Toy Bear'])
  assert.deepEqual(origins, [undefined, 'Plush Pepe', 'Toy Bear'])
})

test('a malformed catalog publication leaves the current phone read eligible to finish', async () => {
  const read = Promise.withResolvers()
  const { display, controls } = phone(() => read.promise)
  display.companion.connect(controls)
  assert.throws(() => display.companion.catalogChanged({}), /Invalid collection/)
  read.resolve(root)
  await Promise.resolve()
  assert.equal(display.current().collection.name, 'Plush Pepe')
})

test('replacing controls retires the old detail, chart, favorites, focus, rate and catalog before the new read', async () => {
  const chart = Promise.withResolvers(), catalog = Promise.withResolvers(), replacement = Promise.withResolvers()
  const { display, controls, favoriteWrites } = phone()
  let chartSignal
  const retireFirst = display.companion.connect({ ...controls, loadCatalog: () => catalog.promise,
    loadFloorChart: (_name, _range, _force, signal) => { chartSignal = signal; return chart.promise },
  })
  const gift = { id: 'Toy Bear', name: 'Toy Bear', floors: {} }
  display.companion.rateChanged(3)
  display.companion.favoritesChanged({ ready: true, visible: true, collections: [gift] })
  display.companion.select(gift)
  display.inspector.show('chart')
  display.companion.connect({ ...controls, loadCatalog: () => replacement.promise })
  assert.equal(chartSignal.aborted, true)
  retireFirst()
  catalog.resolve(root)
  chart.resolve({ points: [] })
  await Promise.resolve()
  assert.equal(display.current().status, 'loading')
  assert.equal(display.current().section, 'explore')
  assert.deepEqual(display.inspector.getSnapshot(), { mode: 'overview' })
  display.tap()
  assert.deepEqual(favoriteWrites, [])
  replacement.resolve({ collection_floors: { Rose: { mrkt: 4 } } })
  await Promise.resolve()
  const card = display.current()
  assert.deepEqual([card.collection.name, card.detail, card.usdtPerGram, card.saved], ['Rose', false, null, null])
})

test('a prior registration of the same phone cannot disconnect its replacement', async () => {
  const { display, controls } = phone()
  const old = display.companion.connect(controls)
  const latest = display.companion.connect(controls)
  await settleTurn()
  old()
  assert.equal(display.current().status, 'ready')
  latest()
  assert.equal(display.current().status, 'waiting')
})

test('Favorites subscribers see matching membership and focus when the last row is removed', async () => {
  const { display, controls } = phone()
  display.companion.connect(controls)
  await settleTurn()
  const favorites = { ready: true, visible: true, collections: [{ id: 'Toy Bear', name: 'Toy Bear' }] }
  display.companion.favoritesChanged(favorites)
  let snapshot
  display.companion.favoriteCollections.subscribe(() => {
    snapshot = [display.companion.favoriteCollections.getSnapshot().collections.length, display.current().status]
  })
  display.companion.favoritesChanged({ ...favorites, collections: [] })
  assert.deepEqual(snapshot, [0, 'empty'])
})
