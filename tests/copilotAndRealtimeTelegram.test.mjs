import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import createSwallower from 'soundswallower'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { createTelegramRelayServer } from '../server/telegramRelay.mjs'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { connectGlasses } from '../src/glasses.ts'
import { telegramPage } from '../src/telegramDisplay.ts'
import { toolView } from '../src/toolDisplay.ts'
import { commandGrammar } from '../src/voiceRecognitionGrammar.ts'
import {
  DEFAULT_USDT_PER_GRAM,
  getBundledCatalog,
} from '../src/services/bundledMarketData.ts'
import {
  computeNetVenueArbitrage,
  createCollectorToolbox,
  SUPPORTED_COLLECTOR_TOOLS,
} from '../src/services/collectorTools.ts'
import {
  fetchLiveTonUsdtRate,
  getLatestTonUsdtSnapshot,
  resetLiveTonUsdtCacheForTests,
} from '../src/services/liveTicker.ts'
import { hostHttpFetch, PUBLIC_API_ORIGIN } from '../src/services/phoneHostBridge.ts'
import { buildSmartReplyDrafts } from '../src/services/smartReplies.ts'
import { TelegramCompanionStore } from '../src/services/telegramStore.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function startTestRelay(options) {
  const relay = createTelegramRelayServer({ port: 0, host: '127.0.0.1', ...options })
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
  const addr = relay.server.address()
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return {
    relay,
    baseUrl,
    close: () =>
      new Promise(resolve => {
        relay.stopPolling()
        relay.server.close(() => resolve())
      }),
  }
}

test('CollectorToolbox supports all 9 companion tools, Gifti null/suspend/grammar safety, and Morning Brief status honesty', async t => {
  const storage = new Map()
  const originalLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
  })
  t.after(() => {
    if (originalLs) Object.defineProperty(globalThis, 'localStorage', originalLs)
    else delete globalThis.localStorage
  })

  const catalog = getBundledCatalog()
  const openedCharts = []
  const sentCards = []
  let nextSendStatus = 'failed'
  let voicePcmResolve
  let nextSpokenTranscript = 'whale risk for Astral Shard'

  const toolbox = createCollectorToolbox(
    {
      getCatalog: () => catalog,
      getFavoriteNames: () => ['Plush Pepe', 'Astral Shard'],
      hasLiveCatalog: () => false,
      getUsdtRate: () => 3.2,
      getUnreadQuestionCount: () => 2,
      openChart: (col, range) => {
        openedCharts.push([col, range])
        return true
      },
      openTelegramDigest() {},
      openTelegramQuestions() {},
      sendTelegramCard: async dispatch => {
        sentCards.push(dispatch)
        return nextSendStatus
      },
      recordVoiceQuestion: () =>
        new Promise(resolve => {
          voicePcmResolve = resolve
        }),
      transcribeVoiceQuestion: async () => nextSpokenTranscript,
    },
    () => 'Plush Pepe',
  )

  const expectedTools = [
    'summary',
    'gifti',
    'watchlist',
    'research',
    'market-note',
    'digest',
    'favorite-movers',
    'spread-radar',
    'threshold',
  ]
  assert.equal(SUPPORTED_COLLECTOR_TOOLS.size, 9)
  for (const name of expectedTools) {
    assert.equal(toolbox.supportsTool(name), true, `Expected ${name} to be supported`)
  }

  // 1. Morning Brief ('summary') — snapshot honesty tag + failed vs sent DM status reporting
  assert.equal(toolbox.open('summary', undefined, 'glasses'), true)
  assert.match(toolbox.getSnapshot().title, /Morning brief · 1\/4/)
  assert.match(toolbox.getSnapshot().lines[0], /\(snapshot\)/)
  assert.match(toolbox.getSnapshot().lines[1], /\$3\.20 USDT \(live\)/)

  toolbox.act(toolbox.getSnapshot(), 'send-brief')
  await settle()
  assert.match(toolbox.getSnapshot().lines[2], /Could not send brief/, 'Failed send must never claim brief was sent')

  nextSendStatus = 'sent'
  toolbox.act(toolbox.getSnapshot(), 'send-brief')
  await settle()
  assert.match(toolbox.getSnapshot().lines[2], /Sent morning brief to Telegram DM/)

  toolbox.act(toolbox.getSnapshot(), 'next')
  assert.match(toolbox.getSnapshot().title, /Morning brief · 2\/4/)
  assert.ok(toolbox.getSnapshot().chart, 'Card 2 embeds 7d chart for top breakout')
  toolbox.act(toolbox.getSnapshot(), 'open-breakout-chart')
  assert.equal(openedCharts.length, 1)

  // 2. Gifti Copilot ('gifti') — suspend() during recording clears 'gifti-recording', and null transcript shows clear message
  assert.equal(toolbox.open('gifti', { collection: 'Plush Pepe', entry: 'talk' }, 'glasses'), true)
  await Promise.resolve()
  assert.equal(toolbox.getSnapshot().key, 'gifti-recording')

  // Suspend while recording -> immediately exits 'gifti-recording' (never stuck!)
  toolbox.suspend()
  assert.notEqual(toolbox.getSnapshot().key, 'gifti-recording')
  voicePcmResolve(new Uint8Array([1, 2]))
  await settle()
  assert.notEqual(toolbox.getSnapshot().key, 'gifti-recording')

  // Null transcript reports unrecognized speech instead of silently substituting preset topic
  nextSpokenTranscript = null
  toolbox.act(toolbox.getSnapshot(), 'ask-voice')
  assert.equal(toolbox.getSnapshot().key, 'gifti-recording')
  voicePcmResolve(new Uint8Array([1, 2, 3, 4]))
  await t.waitFor(() => assert.notEqual(toolbox.getSnapshot().key, 'gifti-recording'))
  assert.match(toolbox.getSnapshot().lines[1], /Didn't catch a recognized question/)

  // Valid transcript resolves Fundamentals for Astral Shard
  nextSpokenTranscript = 'whale risk for Astral Shard'
  toolbox.act(toolbox.getSnapshot(), 'ask-voice')
  voicePcmResolve(new Uint8Array([1, 2, 3, 4]))
  await t.waitFor(() => assert.notEqual(toolbox.getSnapshot().key, 'gifti-recording'))
  assert.match(toolbox.getSnapshot().title, /Astral Shard Fundamentals/)
  assert.equal(toolbox.getSnapshot().chart?.collection, 'Astral Shard')

  // 3. Watchlist ('watchlist') — seeded from favorites, supports 'add-to-watchlist' & 'record-floor' voice action IDs
  assert.equal(toolbox.open('watchlist', { collection: 'Swiss Watch' }, 'glasses'), true)
  assert.equal(toolbox.getWatchlist().length, 2)
  assert.equal(toolbox.act(toolbox.getSnapshot(), 'add-to-watchlist'), true)
  assert.equal(toolbox.getWatchlist()[0].collection, 'Swiss Watch')
  assert.equal(toolbox.act(toolbox.getSnapshot(), 'record-floor'), true)

  // 4. Net Arbitrage & Rarity Research ('research') — single-card swipeHint preserved on G2!
  const arb = computeNetVenueArbitrage({ portals: 4820, getgems: 5180 })
  assert.ok(arb)
  assert.equal(arb.netProfitGram, 101)
  assert.equal(toolbox.open('research', { collection: 'Plush Pepe' }, 'glasses'), true)
  const researchLens = toolView(toolbox.getSnapshot(), 0, undefined, true)
  assert.match(researchLens.content, /Menu to share/, 'Single-card browse page preserves explicit swipeHint')

  // 5. Real SoundSwallower WASM commandGrammar compiles & accepts all Gifti voice question topics
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
    const parse = commandGrammar(decoder, Object.keys(catalog.collection_floors))
    assert.equal(parse('arbitrage for collection0'), `arbitrage for ${Object.keys(catalog.collection_floors)[0]}`)
    assert.equal(parse('whale risk'), 'whale risk')
    assert.equal(parse('rare models'), 'rare models')
    assert.equal(parse('supply health'), 'supply health')
  } finally {
    decoder.delete()
  }
})

test('collectionDisplay openToolChart supports cross-collection Gifti answers, and G2 nativeMenu reaches secondary actions on browse-mode tools', async t => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  let layout
  let hubEvent

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
  globalThis.window = Object.assign(new EventTarget(), {
    EvenAppBridge: {
      ready: true,
      audioControl: async () => true,
      createStartUpPageContainer: async p => {
        assert.equal(validateEvenHubPageContainer(p).valid, true)
        layout = p
        return 0
      },
      rebuildPageContainer: async p => {
        assert.equal(validateEvenHubPageContainer(p).valid, true)
        layout = p
        return true
      },
      textContainerUpgrade: async () => true,
      updateImageRawData: async () => 'success',
      shutDownPageContainer: async () => true,
      onEvenHubEvent(fn) {
        hubEvent = fn
        return () => {
          hubEvent = undefined
        }
      },
    },
  })
  t.after(() => {
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  })

  const catalog = getBundledCatalog()
  let session
  const display = createCollectionDisplay(() => session?.update())
  let selected = null
  const chartLoads = []
  const sentDispatches = []

  const phone = {
    loadCatalog: async () => catalog,
    loadArtwork: async () => null,
    loadFloorChart: async (name, range) => {
      chartLoads.push([name, range])
      return { from: 0, to: 86400, interval: 86400, points: [{ time: 86400, price: 890 }] }
    },
    loadVariants: async () => [],
    open(item, after) {
      selected = item
      display.companion.select(item)
      after?.()
      return true
    },
    canUseVoiceTarget: () => true,
    setFavorite() {},
    showFavorites: () => true,
    back: () => {
      if (!selected) return false
      selected = null
      display.companion.select(null)
      return true
    },
  }

  const toolbox = createCollectorToolbox(
    {
      getCatalog: () => catalog,
      getFavoriteNames: () => ['Plush Pepe'],
      openChart: (col, range) => display.companion.openToolChart(col, range),
      openTelegramDigest() {},
      sendTelegramCard: async d => {
        sentDispatches.push(d)
        return 'sent'
      },
      recordVoiceQuestion: async () => new Uint8Array([1, 2]),
      transcribeVoiceQuestion: async () => 'arbitrage for Astral Shard',
    },
    () => selected?.name ?? 'Plush Pepe',
  )

  display.companion.setTools(toolbox)
  const disconnect = display.companion.connect(phone)
  session = await connectGlasses({
    ...display,
    showDisplayError: () => {},
  })
  t.after(async () => {
    await session.stop()
    disconnect()
  })
  await settle()

  // 1. Cross-collection Gifti voice answer ('Astral Shard' while focused on 'Plush Pepe') opens Astral Shard 7d chart!
  assert.equal(display.openTools('gifti', 'glasses', 'talk'), true)
  await t.waitFor(() => assert.match(toolbox.getSnapshot()?.title ?? '', /Astral Shard Arbitrage/))
  toolbox.act(toolbox.getSnapshot(), 'show-chart')
  await settle()
  assert.equal(toolbox.getSnapshot(), null)
  assert.deepEqual(chartLoads.at(-1), ['Astral Shard', '7d'])

  // 2. Open 'market-note' on G2 -> secondary 'Post callout to Collector Group' (requiresConfirmation: true) is in nativeMenu & duplicate-fenced!
  display.companion.select(null)
  selected = null
  assert.equal(display.openTools('market-note', 'glasses'), true)
  await settle()
  await settle()
  const groupMenuEntry = layout.menuObject.menuItems.find(m => m.itemName.includes('Post callout'))
  assert.ok(groupMenuEntry, 'Expected secondary requiresConfirmation group action in G2 nativeMenu')

  // Clicking twice on same page dispatches only ONCE due to confirmation fence!
  hubEvent({ menuItemClickEvent: { itemID: groupMenuEntry.itemID, itemName: groupMenuEntry.itemName } })
  hubEvent({ menuItemClickEvent: { itemID: groupMenuEntry.itemID, itemName: groupMenuEntry.itemName } })
  await settle()
  assert.equal(sentDispatches.length, 1)
  assert.equal(sentDispatches[0].target, 'group')
})

test('SSE reconnect after empty inbox, stale heads-up/unlink fencing, market-note send-group relay delivery, private vs group inline buttons, and UTF-8 pin deduplication', async t => {
  const originalDocument = globalThis.document
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toBlob: done => done(new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)])),
    }),
  })
  t.after(() => {
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  })

  const telegramCalls = []
  const { relay, baseUrl, close } = await startTestRelay({
    botToken: 'test-bot-token',
    botUsername: 'telegifts_test_bot',
    authToken: 'sse-secret',
    initialState: {
      privateChat: { id: '1001', label: 'Saved Messages (@collector)' },
      group: { id: '-2002', label: 'TON Gift Alpha' },
      questions: [],
      digest: [],
    },
    callTelegram: async (method, payload) => {
      telegramCalls.push({ method, payload })
      return { message_id: 701 }
    },
  })
  t.after(close)

  const catalog = getBundledCatalog()
  let liveCatalogAvailable = true
  const inspector = {
    getSnapshot: () => ({ mode: 'overview' }),
    subscribe: () => () => {},
    show() {},
    showChart() {},
    setRange() {},
    step() {},
    pickVariant() {},
    retry() {},
    back() {},
  }

  const store = new TelegramCompanionStore(
    inspector,
    () => catalog,
    () => 'Plush Pepe',
    baseUrl,
    'sse-secret',
    () => liveCatalogAvailable,
    () => true,
  )
  t.after(() => store.disconnectLiveStream())

  // 1. Start with EMPTY inbox (0 questions), connect SSE, disconnect SSE, ingest /ask while disconnected, reconnect SSE -> MUST fire heads-up!
  await store.refresh()
  assert.equal(store.getSnapshot().state.questions.length, 0)
  store.connectLiveStream()
  await new Promise(r => setTimeout(r, 35))
  store.disconnectLiveStream()

  relay.ingestTelegramUpdates([
    {
      update_id: 601,
      message: {
        message_id: 910,
        message_thread_id: 14,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -2002, type: 'supergroup', title: 'TON Gift Alpha' },
        from: { username: 'mira_ton' },
        text: '/ask@telegifts_test_bot What is the venue spread on Plush Pepe right now?',
      },
    },
  ])

  store.connectLiveStream()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'heads-up'))
  const staleQuestionRef = store.getSnapshot().screen.question

  // 2. If that question is answered/removed on relay and SSE broadcasts empty questions, stale 'heads-up' auto-clears to 'idle'
  //    AND openCompose(staleQuestionRef) rejects with 'changed'!
  relay.state.questions = []
  relay.broadcastSseState()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'idle'))
  assert.equal(store.openCompose(staleQuestionRef), false)
  assert.equal(store.getSnapshot().screen.kind, 'notice')
  assert.equal(store.getSnapshot().screen.reason, 'changed')
  store.cancelDraft()

  // 3. End-to-end 'market-note' group callout ('target: group') WITH Spread PNG succeeds on live relay & includes group inline buttons!
  const groupSendStatus = await store.sendToolCardToTelegram({
    title: 'Plush Pepe Alpha Note',
    text: '5-venue spread widened.',
    collection: 'Plush Pepe',
    attachKind: 'spread',
    target: 'group',
  })
  assert.equal(groupSendStatus, 'sent')
  assert.equal(store.getSnapshot().sentLog[0].attachedChart, true)
  const groupPhotoCall = telegramCalls.at(-1)
  assert.equal(groupPhotoCall.method, 'sendPhoto')
  assert.equal(groupPhotoCall.payload.get('chat_id'), '-2002')
  const groupMarkup = JSON.parse(groupPhotoCall.payload.get('reply_markup'))
  assert.equal(groupMarkup.inline_keyboard[0].length, 2, 'Group card includes both Ask Live Floor and Pin to Digest')

  // 4. Private DM card in snapshot mode ('liveCatalogAvailable = false') omits chart honestly, marks '(snapshot)', and omits group-only Ask button!
  store.back()
  liveCatalogAvailable = false
  const dmSnapStatus = await store.sendToolCardToTelegram({
    title: 'Plush Pepe Research',
    text: 'Best ask 4,820 GRAM',
    collection: 'Plush Pepe 🌟'.repeat(8), // Multi-byte UTF-8 stress test (>64 bytes raw)
    attachKind: 'spread',
    target: 'private',
  })
  assert.equal(dmSnapStatus, 'sent')
  assert.equal(store.getSnapshot().sentLog[0].attachedChart, false, 'Snapshot mode must log attachedChart: false when chart omitted')
  assert.match(store.getSnapshot().sentLog[0].text, /\(snapshot\)/)
  assert.match(store.getSnapshot().sentLog[0].text, /chart omitted: snapshot mode/)
  const dmMsgCall = telegramCalls.at(-1)
  assert.equal(dmMsgCall.method, 'sendMessage')
  const dmMarkup = dmMsgCall.payload.reply_markup
  assert.equal(dmMarkup.inline_keyboard[0].length, 1, 'Private DM card omits group-only Ask Live Floor button')
  assert.ok(
    Buffer.byteLength(dmMarkup.inline_keyboard[0][0].callback_data, 'utf8') <= 64,
    'Multi-byte collection callback_data must stay within Telegram 64-byte UTF-8 limit',
  )

  // 5. Repeated 'tg2:pin:Plush Pepe' clicks deduplicate in-place rather than flooding digest!
  for (let i = 0; i < 5; i++) {
    relay.ingestTelegramUpdates([
      {
        update_id: 700 + i,
        callback_query: {
          id: `cb-dup-${i}`,
          from: { username: 'kairo' },
          message: { message_id: 950, chat: { id: -2002, title: 'TON Gift Alpha' } },
          data: 'tg2:pin:Plush Pepe',
        },
      },
    ])
  }
  assert.equal(relay.state.digest.length, 1, 'Repeated pin clicks for same collection deduplicate in-place')
})

test('liveTicker fences out-of-order force refreshes, caches valid CoinGecko quotes, and updates phoneHostBridge', async t => {
  resetLiveTonUsdtCacheForTests()
  t.after(() => resetLiveTonUsdtCacheForTests())

  let releaseSlowFirst
  const slowFirstGate = new Promise(r => {
    releaseSlowFirst = r
  })
  let callNum = 0

  const slowPromise = fetchLiveTonUsdtRate({
    force: true,
    nowMs: 100_000,
    fetchImpl: async () => {
      callNum++
      await slowFirstGate
      return new Response(JSON.stringify({ 'the-open-network': { usd: 1.99 } }), { status: 200 })
    },
  })

  const newerFast = await fetchLiveTonUsdtRate({
    force: true,
    nowMs: 101_000,
    fetchImpl: async () => {
      callNum++
      return new Response(
        JSON.stringify({ 'the-open-network': { usd: 3.4189, usd_24h_change: 4.726 } }),
        { status: 200 },
      )
    },
  })
  assert.equal(newerFast.usd, 3.4189)

  releaseSlowFirst()
  await slowPromise
  assert.equal(getLatestTonUsdtSnapshot().usd, 3.4189, 'Older slow fetch must never overwrite newer force-refreshed rate')
  assert.equal(callNum, 2)

  const bridgeRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/b/api/v3/simple/price`)
  const bridgeJson = await bridgeRes.json()
  assert.equal(bridgeJson['the-open-network'].usd, 3.4189)
})
