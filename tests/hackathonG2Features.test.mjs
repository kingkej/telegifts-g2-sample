import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import createSwallower from 'soundswallower'
import {
  EvenAppBridge,
  evenHubEventFromJson,
  EventSourceType,
  OsEventTypeList as os,
  validateEvenHubPageContainer,
} from '@evenrealities/even_hub_sdk'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { connectGlasses } from '../src/glasses.ts'
import { buildHudContainers } from '../src/hudLayout.ts'
import { renderSpreadChart } from '../src/spreadChart.ts'
import { createVoiceControl } from '../src/voiceControl.ts'
import { commandGrammar, verificationGrammar } from '../src/voiceRecognitionGrammar.ts'
import {
  buildBundledHistoryCandles,
  getBundledCatalog,
  DEFAULT_USDT_PER_GRAM,
} from '../src/services/bundledMarketData.ts'
import {
  clampSparklineOutliers,
  downsampleSparkline,
  monotonePath,
  niceDomain,
  ticks,
} from '../src/lib/chartScale.ts'
import { hostHttpFetch, PUBLIC_API_ORIGIN } from '../src/services/phoneHostBridge.ts'
import {
  createCatalogRefreshCoordinator,
  createCatalogRefreshLifecycle,
  resolveSelectedCollectionFloors,
} from '../src/services/catalogRefresh.ts'
import { installBrowserSimulatorIfStandalone } from '../src/services/browserEvenBridge.ts'
import { buildSmartReplyDrafts, detectQuestionCollection } from '../src/services/smartReplies.ts'
import { TelegramCompanionStore } from '../src/services/telegramStore.ts'
import { createCollectorToolbox } from '../src/services/collectorTools.ts'
import { resolveVoiceCommand } from '../src/voiceCommands.ts'

const palette16 = new Set(Array.from({ length: 16 }, (_, i) => i * 17))
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('real SoundSwallower WASM decoder compiles commandGrammar and verificationGrammar across all 24 catalog collections and composer commands', async () => {
  const modelDir = path.join(repoRoot, 'node_modules', 'soundswallower', 'model', 'en-us')
  const wasmPath = path.join(repoRoot, 'node_modules', 'soundswallower', 'soundswallower.web.wasm')
  const engine = await createSwallower({ locateFile: () => wasmPath })
  const decoder = new engine.Decoder({
    samprate: 16000,
    loglevel: 'ERROR',
    wip: 0.001,
    featparams: path.join(modelDir, 'feat_params.json'),
    mdef: path.join(modelDir, 'mdef'),
    mean: path.join(modelDir, 'means'),
    var: path.join(modelDir, 'variances'),
    sendump: path.join(modelDir, 'sendump'),
    tmat: path.join(modelDir, 'transition_matrices'),
    dict: path.join(modelDir, 'dict.txt'),
    fdict: path.join(modelDir, 'noisedict.txt'),
    lda: 'urn:telegifts:no-lda',
  })

  try {
    await decoder.initialize()
    const names = Object.keys(getBundledCatalog().collection_floors)
    const parseTranscript = commandGrammar(decoder, names)

    const grammarChecks = [
      'open inbox',
      'show channel digest',
      'venue spread radar',
      'watch price',
      'draft reply',
      'compare markets',
      'select floor chart draft',
      'select venue spread draft',
      'select daily utc close draft',
      'checking listings',
      'next draft',
      'previous draft',
      'send reply',
      'go back',
    ]

    for (const phrase of grammarChecks) {
      assert.equal(parseTranscript(phrase), phrase.replace(/\bwatch list\b/g, 'watchlist'), phrase)
      decoder.set_grammar(verificationGrammar(phrase))
    }
  } finally {
    decoder.delete()
  }
})

test('buildHudContainers produces SDK-valid 3-region brightness-graded layouts with unique zOrderIndex and single event capture', () => {
  const layout = buildHudContainers({
    content: 'Fallback',
    regions: {
      header: 'REPLY 1/4 · TON Gift Alpha · #floor-watch',
      body: 'Floor + 7d chart [+7d Chart]\nPlush Pepe floor is 4,820 GRAM on Portals.',
      footer: 'Tap: Send · Swipe: Drafts · Hold R1: Voice pick · 2×Tap: Back',
    },
    withArtwork: true,
    largeFrame: true,
    target: {
      body: { containerID: 10, containerName: 'tg-body' },
      header: { containerID: 11, containerName: 'tg-hdr' },
      footer: { containerID: 12, containerName: 'tg-ftr' },
      menu: new Map([
        [13, 'Send reply'],
        [14, 'Cancel'],
      ]),
    },
  })

  const validation = validateEvenHubPageContainer(layout)
  assert.equal(validation.valid, true, validation.message)
  assert.equal(layout.containerTotalNum, 4)
  assert.equal(layout.textObject.length, 3)
  assert.equal(layout.imageObject.length, 1)

  const captures = layout.textObject.filter(t => t.isEventCapture === 1)
  assert.equal(captures.length, 1)
  assert.equal(captures[0].containerID, 10)
  assert.equal(captures[0].textColor, 4)

  const header = layout.textObject.find(t => t.containerID === 11)
  const footer = layout.textObject.find(t => t.containerID === 12)
  assert.equal(header.textColor, 2)
  assert.equal(footer.textColor, 3)

  const zOrders = [...layout.textObject.map(t => t.zOrderIndex), ...layout.imageObject.map(i => i.zOrderIndex)]
  assert.equal(new Set(zOrders).size, 4)
})

test('renderSpreadChart outputs a 256 × 144 16-level grayscale bitmap highlighting the cheapest venue', () => {
  const frame = renderSpreadChart([
    { marketplace: 'Tonnel', price: 4990 },
    { marketplace: 'Portals', price: 4820 },
    { marketplace: 'MRKT', price: 5050 },
    { marketplace: 'Getgems', price: 5180 },
  ])
  assert.equal(frame.length, 256 * 144)
  for (const byte of frame) {
    assert.ok(palette16.has(byte), `Unexpected grayscale value ${byte}`)
  }
  const litPixels = frame.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0)
  const peakPixels = frame.reduce((acc, v) => acc + (v === 255 ? 1 : 0), 0)
  assert.ok(litPixels > 1200, 'Expected visible bars and labels')
  assert.ok(peakPixels > 200, 'Expected brightest fill on cheapest venue bar')

  const empty = renderSpreadChart([])
  assert.equal(empty.every(v => v === 0), true)
})

test('smartReplies detects mentioned collections, generates 4 demo drafts, and omits synthetic 7d closes in live mode', () => {
  const catalog = getBundledCatalog()
  assert.equal(
    detectQuestionCollection('Is Plush Pepe still cheaper on Portals than Tonnel?', catalog, null),
    'Plush Pepe',
  )
  const question = {
    id: 'q1',
    sender: '@mira_ton',
    chatLabel: 'TON Gift Alpha',
    topicName: '#floor-watch',
    text: 'Is Plush Pepe still cheaper on Portals than Tonnel?',
  }
  const demoDrafts = buildSmartReplyDrafts(question, catalog, null, { allowSyntheticHistory: true })
  assert.equal(demoDrafts.length, 4)
  assert.equal(demoDrafts[0].attachChart, true)
  assert.match(demoDrafts[0].text, /Plush Pepe.*Portals/)
  assert.match(demoDrafts[1].text, /spread/i)
  assert.match(demoDrafts[2].text, /UTC close/)

  // Live relay mode without a live 7d history series must never fabricate UTC daily closes
  const liveDrafts = buildSmartReplyDrafts(question, catalog, null, {
    allowSyntheticHistory: false,
    hasLiveCatalog: false,
  })
  assert.equal(liveDrafts.some(d => d.id === 'daily-delta'), false)
  assert.equal(liveDrafts.some(d => d.attachChart), false)
  assert.match(liveDrafts[0].text, /\(snapshot\)/)
})

test('expanded voice grammar resolves inbox, digest, smart reply, venue spread, and price watch intents', () => {
  const names = ['Plush Pepe', 'Astral Shard', "Durov's Cap"]
  const cases = [
    ['open inbox', { kind: 'telegram-inbox' }],
    ['show questions', { kind: 'telegram-inbox' }],
    ['show channel digest', { kind: 'telegram-digest' }],
    ['open digest', { kind: 'tool', target: 'digest' }],
    ['watch price', { kind: 'tool', target: 'threshold' }],
    ['venue spread radar', { kind: 'tool', target: 'spread-radar' }],
    ['draft reply', { kind: 'share', target: 'smart-draft' }],
    ['compare markets', { kind: 'spread', name: null }],
    ['show venue spread for Astral Shard', { kind: 'spread', name: 'Astral Shard' }],
  ]
  for (const [spoken, expected] of cases) {
    const dispatched = []
    const res = resolveVoiceCommand(spoken, names, 'Plush Pepe', cmd => {
      dispatched.push(cmd)
      return true
    })
    assert.equal(res.kind, 'action', spoken)
    assert.equal(res.run(), true, spoken)
    assert.deepEqual(dispatched, [expected], spoken)
  }
})

test('installBrowserSimulatorIfStandalone replaces unbacked SDK singleton, supports restoreNativeHostBridge, and preserves real hosts', () => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  try {
    globalThis.document = Object.assign(new EventTarget(), { readyState: 'complete' })
    const win = new EventTarget()
    globalThis.window = win
    const sdkSingleton = EvenAppBridge.getInstance()
    win.EvenAppBridge = sdkSingleton
    assert.equal(win.EvenAppBridge instanceof EvenAppBridge, true)

    const sim = installBrowserSimulatorIfStandalone()
    assert.ok(sim, 'Expected browser simulator controls when flutter_inappwebview is absent')
    assert.equal(sim.isSimulated, true)
    assert.equal(win.EvenAppBridge instanceof EvenAppBridge, false)

    // Delayed native Flutter arrival restores the SDK singleton cleanly
    sim.restoreNativeHostBridge()
    assert.equal(win.EvenAppBridge, sdkSingleton)

    // When flutter_inappwebview is present, simulator must NOT install
    const flutterWin = Object.assign(new EventTarget(), {
      flutter_inappwebview: {},
      EvenAppBridge: sdkSingleton,
    })
    globalThis.window = flutterWin
    assert.equal(installBrowserSimulatorIfStandalone(), undefined)

    // When a custom test mock bridge is pre-installed, simulator must NOT clobber it
    const customBridge = { ready: true }
    const testWin = Object.assign(new EventTarget(), { EvenAppBridge: customBridge })
    globalThis.window = testWin
    assert.equal(installBrowserSimulatorIfStandalone(), undefined)
    assert.equal(testWin.EvenAppBridge, customBridge)
  } finally {
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  }
})

test('end-to-end G2 composer, R1 Ring composeId/session fence, delayed mic enable close-safety, chart confirm frame check, and watch evaluation', async t => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  let hubEvent
  let deviceEvent
  let layout
  let micEnabled = false
  let delayAudioEnable = null
  const mirrors = []

  const bridge = {
    ready: true,
    audioControl: t.mock.fn(async enabled => {
      if (enabled && delayAudioEnable) await delayAudioEnable
      micEnabled = Boolean(enabled)
      return true
    }),
    createStartUpPageContainer: t.mock.fn(async p => {
      assert.equal(validateEvenHubPageContainer(p).valid, true)
      layout = p
      return 0
    }),
    rebuildPageContainer: t.mock.fn(async p => {
      assert.equal(validateEvenHubPageContainer(p).valid, true)
      layout = p
      return true
    }),
    textContainerUpgrade: t.mock.fn(async u => {
      const target = layout.textObject.find(item => item.containerID === u.containerID)
      if (target) target.content = u.content
      return true
    }),
    updateImageRawData: t.mock.fn(async () => 'success'),
    shutDownPageContainer: t.mock.fn(async () => true),
    onEvenHubEvent(fn) {
      hubEvent = fn
      return () => {
        hubEvent = undefined
      }
    },
    onDeviceStatusChanged(fn) {
      deviceEvent = fn
      return () => {
        deviceEvent = undefined
      }
    },
  }

  globalThis.window = Object.assign(new EventTarget(), { EvenAppBridge: bridge })
  globalThis.document = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toBlob: done => done(new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)])),
    }),
  })

  let catalog = getBundledCatalog()
  let session
  let selected = null
  const display = createCollectionDisplay(() => session?.update())
  const tgStore = new TelegramCompanionStore(
    display.inspector,
    () => catalog,
    () => selected?.name ?? null,
    '',
  )
  const toolbox = createCollectorToolbox(
    {
      getCatalog: () => catalog,
      getFavoriteNames: () => ['Plush Pepe', 'Astral Shard'],
      openChart: (col, range) => display.companion.openToolChart(col, range),
      openTelegramDigest: () => tgStore.openDigest(),
      onSimulateWatchHit: (rule, hitPrice, simulated) =>
        tgStore.pushWatchDigestAlert(rule.collection, hitPrice, rule.thresholdGram, simulated),
    },
    () => selected?.name,
  )

  const phone = {
    loadCatalog: async () => catalog,
    loadArtwork: async () => null,
    loadFloorChart: async (_name, range) => ({
      from: 0,
      to: range === '7d' ? 172800 : 1800,
      interval: range === '7d' ? 86400 : 900,
      points:
        range === '7d'
          ? [
              { time: 86400, price: 4600 },
              { time: 172800, price: 4820 },
            ]
          : [
              { time: 900, price: 4800 },
              { time: 1800, price: 4820 },
            ],
    }),
    loadVariants: async () => ['Emerald', 'Golden'],
    open(item, after) {
      selected = item
      display.companion.select(item)
      after?.()
      return true
    },
    canUseVoiceTarget: () => true,
    setFavorite() {},
    showFavorites: () => true,
    backFromInspection() {
      if (display.inspector.getSnapshot().mode !== 'overview') {
        display.inspector.back()
        return true
      }
      return false
    },
    back() {
      if (!selected) return false
      selected = null
      display.companion.select(null)
      return true
    },
  }

  display.companion.setTelegram(tgStore)
  display.companion.setTools(toolbox)
  const disconnect = display.companion.connect(phone)
  display.companion.rateChanged(DEFAULT_USDT_PER_GRAM)
  display.companion.favoritesChanged({
    ready: true,
    visible: false,
    collections: [{ id: 'Plush Pepe', name: 'Plush Pepe' }],
  })

  let nextTranscript = 'select daily utc close draft'
  let delayTranscription = null
  const voice = createVoiceControl({
    names: display.voiceNames,
    resolve: display.resolveVoice,
    transcribe: async () => {
      if (delayTranscription) await delayTranscription
      return nextTranscript
    },
  })

  session = await connectGlasses(
    {
      ...display,
      voice,
      showDisplayError: () => {},
      onMirrorChange: m => {
        if (m) mirrors.push(m)
      },
    },
    () => {},
  )
  await settle()

  t.after(async () => {
    await session.stop()
    disconnect()
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  })

  // 1. Device telemetry updates mirror
  deviceEvent({ connectType: 'connected', batteryLevel: 76, isWearing: true, isCharging: false })
  assert.equal(mirrors.at(-1).telemetry.batteryLevel, 76)

  // 2. Chart confirm frame safety: confirming 7d then switching range to 24h invalidates send ('changed')!
  phone.open({ id: 'Plush Pepe', name: 'Plush Pepe', floors: catalog.collection_floors['Plush Pepe'] }, () => {
    display.inspector.showChart('7d')
  })
  await settle()
  await settle()
  assert.equal(display.inspector.getSnapshot().mode, 'chart')
  assert.equal(display.inspector.getSnapshot().range, '7d')
  assert.equal(tgStore.share('private'), true)
  assert.equal(tgStore.getSnapshot().screen.kind, 'confirm')
  // Change chart range to 24h before committing confirm
  display.inspector.setRange('24h')
  await settle()
  await settle()
  tgStore.activate()
  assert.equal(tgStore.getSnapshot().screen.kind, 'notice')
  assert.equal(tgStore.getSnapshot().screen.reason, 'changed')
  tgStore.cancelDraft()

  // 3. Voice opens venue spread chart -> 3-region HUD + 256x144 image slot
  assert.equal(display.resolveVoice('show venue spread for Plush Pepe').run(), true)
  await settle()
  await settle()
  assert.equal(display.inspector.getSnapshot().mode, 'spread')
  assert.equal(layout.textObject.length, 3)
  assert.equal(layout.imageObject.length, 1)
  assert.deepEqual([layout.imageObject[0].width, layout.imageObject[0].height], [256, 144])

  // 4. Open Question Inbox -> Question -> Multi-container Smart Reply Composer
  display.companion.select(null)
  selected = null
  assert.equal(display.resolveVoice('open inbox').run(), true)
  await settle()
  hubEvent(evenHubEventFromJson({ type: 'text_event', jsonData: { Container_ID: layout.textObject[0].containerID } }))
  await settle()
  hubEvent(evenHubEventFromJson({ type: 'text_event', jsonData: { Container_ID: layout.textObject[0].containerID } }))
  await settle()
  assert.equal(tgStore.getSnapshot().screen.kind, 'compose')

  // 5. Short R1 hold with delayed native mic enable MUST close mic after late enable!
  let resolveSlowEnable
  delayAudioEnable = new Promise(resolve => {
    resolveSlowEnable = resolve
  })
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_RELEASE_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  // Native enable finishes AFTER release
  resolveSlowEnable()
  await settle()
  await settle()
  assert.equal(micEnabled, false, 'Late mic enable after R1 release must immediately close mic')
  delayAudioEnable = null

  // 6. R1 Ring Hold Push-To-Talk selects 'daily-delta' draft via offline grammar
  const pcm = new Int16Array(4800)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 2 ? 1500 : -1500
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  await settle()
  hubEvent({ audioEvent: { source: 'glasses', speakerRole: 'self', audioPcm: new Uint8Array(pcm.buffer) } })
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_RELEASE_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  await settle()
  await settle()
  assert.equal(mirrors.at(-1).telemetry.lastInputSource, 'ring')
  assert.equal(tgStore.getSnapshot().screen.drafts[tgStore.getSnapshot().screen.index].id, 'daily-delta')

  // 7. Delayed R1 "send reply" race fence: backing out, reopening SAME question, and picking Venue spread MUST NOT send!
  let releaseDelayed
  delayTranscription = new Promise(resolve => {
    releaseDelayed = resolve
  })
  nextTranscript = 'send reply'
  const sameQuestion = tgStore.getSnapshot().screen.question
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  await settle()
  hubEvent({ audioEvent: { source: 'glasses', speakerRole: 'self', audioPcm: new Uint8Array(pcm.buffer) } })
  hubEvent(
    evenHubEventFromJson({
      type: 'sys_event',
      jsonData: { Event_Type: os.LONG_PRESS_RELEASE_EVENT, Event_Source: EventSourceType.TOUCH_EVENT_FROM_RING },
    }),
  )
  // User backs out, reopens the SAME question, and selects Venue spread (index 1)
  tgStore.back()
  await settle()
  tgStore.openCompose(sameQuestion)
  tgStore.step(1)
  await settle()
  releaseDelayed()
  await settle()
  await settle()
  assert.equal(tgStore.getSnapshot().sentLog.length, 0, 'Delayed send reply from old compose session must not send new draft')
  assert.equal(tgStore.getSnapshot().screen.kind, 'compose')
  delayTranscription = null

  // 8. Current container ID commits once
  const activeCaptureId = layout.textObject[0].containerID
  hubEvent(evenHubEventFromJson({ type: 'text_event', jsonData: { Container_ID: activeCaptureId } }))
  await new Promise(r => setTimeout(r, 220))
  await settle()
  assert.equal(tgStore.getSnapshot().sentLog.length, 1)

  // 9. Automatic Price Watch evaluation on live catalog drop
  tgStore.back()
  await settle()
  assert.equal(toolbox.open('threshold', { collection: 'Plush Pepe' }, 'glasses'), true)
  await settle()
  toolbox.act(toolbox.getSnapshot(), 'arm')
  toolbox.close()
  await settle()

  catalog = {
    collection_floors: {
      ...catalog.collection_floors,
      'Plush Pepe': { ...catalog.collection_floors['Plush Pepe'], portals: 4490 },
    },
  }
  assert.equal(
    toolbox.evaluateWatches(catalog, { isLive: false }),
    0,
    'Bundled fallback catalog must not trigger live watch alerts',
  )
  assert.equal(toolbox.evaluateWatches(catalog, { isLive: true }), 1)
  await settle()
  assert.equal(tgStore.getSnapshot().screen.kind, 'digest')
  assert.match(layout.textObject[0].content, /Plush Pepe ask hit 4490 GRAM/)
})

test('catalog refresh coordinator resets isLive on fallback, suppresses fallback watch hits, and fences out-of-order overlapping refreshes', async () => {
  const bundled = getBundledCatalog()
  const liveHigh = {
    collection_floors: {
      ...bundled.collection_floors,
      'Plush Pepe': { portals: 6000 },
    },
  }
  const staleLow = {
    collection_floors: {
      ...bundled.collection_floors,
      'Plush Pepe': { portals: 4000 },
    },
  }

  const watchHits = []
  let publishedState = { data: bundled, isLive: false, generation: 0 }

  const watchToolbox = createCollectorToolbox(
    {
      getCatalog: () => publishedState.data,
      getFavoriteNames: () => ['Plush Pepe'],
      hasLiveCatalog: () => publishedState.isLive,
      openChart: () => true,
      openTelegramDigest() {},
      onSimulateWatchHit: (rule, price, simulated) => {
        watchHits.push({ collection: rule.collection, price, simulated })
      },
    },
    () => 'Plush Pepe',
  )

  let mode = 'live-ok'
  let releaseSlowFetch
  const slowFetchGate = new Promise(r => {
    releaseSlowFetch = r
  })
  let releaseSlowFail
  const slowFailGate = new Promise(r => {
    releaseSlowFail = r
  })

  const coordinator = createCatalogRefreshCoordinator({
    marketApiUrl: 'https://market.example.test',
    loadBundled: () => bundled,
    fetchImpl: async () => {
      if (mode === 'live-ok') {
        return new Response(JSON.stringify(liveHigh), { status: 200 })
      }
      if (mode === 'fail') {
        throw new Error('Market API unreachable')
      }
      if (mode === 'slow-stale-low') {
        await slowFetchGate
        return new Response(JSON.stringify(staleLow), { status: 200 })
      }
      if (mode === 'slow-fail') {
        await slowFailGate
        throw new Error('Delayed outage')
      }
      return new Response(JSON.stringify(liveHigh), { status: 200 })
    },
    onPublish: next => {
      publishedState = next
      watchToolbox.evaluateWatches(next.data, { isLive: next.isLive })
    },
  })

  // 1. Live refresh succeeds (6000 GRAM, isLive: true) -> relay drafts omit '(snapshot)'
  await coordinator.refresh()
  assert.equal(publishedState.isLive, true)
  const q = { id: 'q1', sender: '@u', text: 'Plush Pepe floor?', chatLabel: 'Group' }
  const liveDrafts = buildSmartReplyDrafts(q, publishedState.data, 'Plush Pepe', {
    allowSyntheticHistory: false,
    hasLiveCatalog: publishedState.isLive,
  })
  assert.equal(/\(snapshot\)/.test(liveDrafts[0].text), false)

  // Arm watch at -5% below 6000 GRAM (<= 5700 GRAM); bundled Plush Pepe is 4820 GRAM (< 5700 GRAM)!
  watchToolbox.open('threshold', { collection: 'Plush Pepe' }, 'phone')
  watchToolbox.act(watchToolbox.getSnapshot(), 'arm')
  assert.equal(watchToolbox.getWatches().get('Plush Pepe')?.thresholdGram, 5700)

  // 2. Next refresh fails -> falls back to bundled (4820 GRAM) AND resets isLive: false!
  //    Relay draft now carries '(snapshot)' AND bundled 4820 GRAM does NOT trigger the 5700 GRAM watch!
  mode = 'fail'
  await coordinator.refresh()
  assert.equal(publishedState.isLive, false)
  assert.equal(watchHits.length, 0, 'Bundled fallback after live refresh must not fire live watch alert')
  const fallbackDrafts = buildSmartReplyDrafts(q, publishedState.data, 'Plush Pepe', {
    allowSyntheticHistory: false,
    hasLiveCatalog: publishedState.isLive,
  })
  assert.match(fallbackDrafts[0].text, /\(snapshot\)/)

  // 3. Overlapping refreshes: slow earlier refresh (4000 GRAM) finishes AFTER newer refresh (6000 GRAM) -> ignored!
  mode = 'slow-stale-low'
  const slowPromise = coordinator.refresh()
  mode = 'live-ok'
  await coordinator.refresh()
  assert.equal(publishedState.isLive, true)
  assert.equal(publishedState.data.collection_floors['Plush Pepe'].portals, 6000)

  releaseSlowFetch()
  const slowResult = await slowPromise
  assert.equal(slowResult.collection_floors['Plush Pepe'].portals, 6000, 'Stale refresh returns active newer catalog')
  assert.equal(publishedState.data.collection_floors['Plush Pepe'].portals, 6000, 'Stale refresh never overwrites newer catalog')
  assert.equal(watchHits.length, 0, 'Stale out-of-order refresh never triggers watch evaluation')

  // 4. Overlapping refreshes: slow earlier failure finishes AFTER newer live refresh -> preserves live catalog & isLive: true!
  mode = 'slow-fail'
  const slowFailPromise = coordinator.refresh()
  mode = 'live-ok'
  await coordinator.refresh()
  releaseSlowFail()
  await slowFailPromise
  assert.equal(publishedState.isLive, true, 'Stale failure must not downgrade newer live catalog to snapshot')
  assert.equal(publishedState.data.collection_floors['Plush Pepe'].portals, 6000)

  // 5. Coordinator handoff / disposal: retiring an older coordinator while its refresh is in flight never overwrites newer coordinator!
  const sharedGen = { current: 10 }
  let releaseOldCoord
  const oldCoordGate = new Promise(r => {
    releaseOldCoord = r
  })
  const oldCoordinator = createCatalogRefreshCoordinator({
    marketApiUrl: 'https://market.example.test',
    loadBundled: () => bundled,
    generationCounter: sharedGen,
    fetchImpl: async () => {
      await oldCoordGate
      throw new Error('Old coordinator network error')
    },
    onPublish: next => {
      publishedState = next
    },
  })
  const newCoordinator = createCatalogRefreshCoordinator({
    marketApiUrl: 'https://market.example.test',
    loadBundled: () => bundled,
    generationCounter: sharedGen,
    fetchImpl: async () => new Response(JSON.stringify(liveHigh), { status: 200 }),
    onPublish: next => {
      publishedState = next
    },
  })

  const inFlightOld = oldCoordinator.refresh()
  oldCoordinator.dispose()
  await newCoordinator.refresh()
  assert.equal(publishedState.isLive, true)
  releaseOldCoord()
  await inFlightOld
  assert.equal(publishedState.isLive, true, 'Retired coordinator must never overwrite newer coordinator state')
  assert.equal(publishedState.data.collection_floors['Plush Pepe'].portals, 6000)

  // 6. React Strict Mode mount -> initial refresh -> cleanup -> setup replay -> replay & manual refresh!
  let fetchCalls = 0
  const publishedSnapshots = []
  let releaseFirstStrictFetch
  const firstStrictGate = new Promise(r => {
    releaseFirstStrictFetch = r
  })
  const strictLifecycle = createCatalogRefreshLifecycle({
    marketApiUrl: 'https://market.example.test',
    loadBundled: () => bundled,
    fetchImpl: async () => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        await firstStrictGate
        return new Response(JSON.stringify(staleLow), { status: 200 })
      }
      const floor = fetchCalls === 2 ? 6000 : 6150
      return new Response(
        JSON.stringify({
          collection_floors: {
            ...bundled.collection_floors,
            'Plush Pepe': { portals: floor },
          },
        }),
        { status: 200 },
      )
    },
    onPublish: next => {
      publishedSnapshots.push(next)
    },
  })

  // Mount pass 1 starts initial refresh, then Strict Mode runs cleanup & setup replay immediately
  const cleanupPass1 = strictLifecycle.setup()
  const pass1Refresh = strictLifecycle.refresh()
  cleanupPass1()

  const cleanupPass2 = strictLifecycle.setup()
  const replayData = await strictLifecycle.refresh()
  assert.equal(fetchCalls, 2, 'Strict Mode setup replay performs a real live fetch')
  assert.equal(replayData.collection_floors['Plush Pepe'].portals, 6000)
  assert.equal(publishedSnapshots.length, 1)
  assert.equal(publishedSnapshots[0].isLive, true)
  assert.equal(publishedSnapshots[0].data.collection_floors['Plush Pepe'].portals, 6000)

  // Late response from pass 1's disposed coordinator never overwrites pass 2
  releaseFirstStrictFetch()
  await pass1Refresh
  assert.equal(publishedSnapshots.length, 1)

  // Manual refresh after Strict Mode replay fetches and publishes updated live data
  const manualData = await strictLifecycle.refresh()
  assert.equal(fetchCalls, 3)
  assert.equal(manualData.collection_floors['Plush Pepe'].portals, 6150)
  assert.equal(publishedSnapshots.length, 2)
  assert.equal(publishedSnapshots[1].isLive, true)
  assert.equal(publishedSnapshots[1].data.collection_floors['Plush Pepe'].portals, 6150)

  // Open collection resolves updated venue floors dynamically as live refreshes arrive,
  // and clears stale floors to {} (preventing watch arming) when a refresh omits that collection!
  const openedSnapshot = {
    id: 'Plush Pepe',
    name: 'Plush Pepe',
    floors: bundled.collection_floors['Plush Pepe'],
  }
  const resolvedAfterManual = resolveSelectedCollectionFloors(openedSnapshot, publishedSnapshots[1].data)
  assert.equal(resolvedAfterManual.floors.portals, 6150)

  const catalogOmittingPepe = {
    collection_floors: {
      'Astral Shard': { portals: 890 },
    },
  }
  const resolvedWhenOmitted = resolveSelectedCollectionFloors(openedSnapshot, catalogOmittingPepe)
  assert.equal(resolvedWhenOmitted.name, 'Plush Pepe')
  assert.deepEqual(resolvedWhenOmitted.floors, {}, 'Omitted collection clears obsolete floors to empty object')

  publishedState = { data: catalogOmittingPepe, isLive: true, generation: 99 }
  watchToolbox.act(watchToolbox.getSnapshot(), 'clear-watch')
  watchToolbox.open('threshold', { collection: 'Plush Pepe' }, 'phone')
  assert.equal(watchToolbox.getSnapshot().actions.length, 0, 'Unpriced collection cannot arm a watch')
  watchToolbox.act(watchToolbox.getSnapshot(), 'arm')
  assert.equal(watchToolbox.getWatches().has('Plush Pepe'), false)

  cleanupPass2()
})

test('TeleGifts composable chart engine and OHLC history candles preserve monotone tangents, nice domains, and candle invariants', () => {
  const [lo, hi] = niceDomain(3683, 4863, 4)
  assert.ok(lo <= 3683 && hi >= 4863)
  const domainTicks = ticks([lo, hi], 4)
  assert.equal(domainTicks.length, 5)

  const path = monotonePath([
    { x: 0, y: 100 },
    { x: 40, y: 80 },
    { x: 80, y: 80 },
    { x: 120, y: 45 },
  ])
  assert.match(path, /^M0,100C/)
  assert.equal(path.includes('NaN'), false)

  const sampled = downsampleSparkline(
    Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i * 0.25) * 18),
    48,
  )
  assert.equal(sampled.length, 48)
  const clamped = clampSparklineOutliers([10, 11, 10.5, 11.2, 10.8, 11.1, 10.9, 950])
  assert.ok(Math.max(...clamped) < 20, 'IQR fence clamps extreme single-sample spike')

  for (const source of ['sales', 'cheapest_snapshot']) {
    for (const range of ['hour24', 'week1', 'month1', 'all']) {
      const candles = buildBundledHistoryCandles('Plush Pepe', range, source)
      assert.ok(candles.length >= 7)
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i]
        assert.ok(c.open > 0 && c.close > 0 && c.low > 0 && c.high > 0)
        assert.ok(c.high >= Math.max(c.open, c.close))
        assert.ok(c.low <= Math.min(c.open, c.close))
        if (i > 0) {
          assert.ok(c.date.getTime() > candles[i - 1].date.getTime())
        }
      }
    }
  }
})

test('phoneHostBridge serves schema-valid catalog, market-performance, history, health, emission, and heatmap payloads for the pre-built TeleGifts UI', async () => {
  const catRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/a/api/v1/gifts/get_gifts_price_list?models=true`)
  assert.equal(catRes.status, 200)
  const catJson = await catRes.json()
  assert.ok(catJson.collection_floors['Plush Pepe'])
  assert.ok(catJson.models_prices['Plush Pepe']?.models)

  const perfRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/market-performance?scope=collections&metric=floor&period=24h`)
  const perfJson = await perfRes.json()
  assert.equal(perfJson.version, 1)
  assert.equal(perfJson.hasMore, false)
  assert.equal(perfJson.nextCursor, null)
  assert.ok(perfJson.items.length >= 20)
  assert.ok(perfJson.items.every(it => it.model === null && it.value > 0 && it.floorPrice > 0))

  const histRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/history?name=Plush+Pepe&resolution=1d&source=sales&includeRates=true`)
  const histJson = await histRes.json()
  assert.equal(histJson.s, 'ok')
  assert.equal(histJson.source, 'sales')
  assert.equal(histJson.t.length, histJson.c.length)
  assert.ok(histJson.t.length >= 7)

  const healthRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/a/api/v1/gifts/get_gifts_collections_health_index_v2`)
  const healthJson = await healthRes.json()
  assert.ok(healthJson['Plush Pepe'].health_index > 0)

  const emissionRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/a/api/v1/gifts/get_gifts_collections_emission`)
  const emissionJson = await emissionRes.json()
  assert.ok(emissionJson['Plush Pepe'].emission > 0)

  const heatmapRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/heatmap?range=7d&type=trade_volume`)
  const heatmapJson = await heatmapRes.json()
  assert.equal(heatmapJson.range, '7d')
  assert.ok(heatmapJson.items.length >= 20)
})
