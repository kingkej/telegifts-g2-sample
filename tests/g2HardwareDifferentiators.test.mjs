import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { createCollectionDisplay } from '../src/collectionDisplay.ts'
import { connectGlasses } from '../src/glasses.ts'
import { createImuGestureClassifier } from '../src/imuGestureTriage.ts'
import { parseTelegramGiftLink } from '../src/lib/giftLinkResolver.ts'
import { createVoiceControl } from '../src/voiceControl.ts'
import { getBundledCatalog } from '../src/services/bundledMarketData.ts'
import { installBrowserSimulatorIfStandalone } from '../src/services/browserEvenBridge.ts'
import { createCollectorToolbox } from '../src/services/collectorTools.ts'
import {
  getG2HardwarePreferences,
  HW_PREFS_STORAGE_KEY,
  installEarlyLaunchSourceCapture,
  resetG2HardwarePreferencesForTests,
  seedStarterFavoritesIfMissing,
  setG2HardwarePreferences,
  syncEvenHostStorage,
} from '../src/services/evenHostStorage.ts'
import { TelegramCompanionStore } from '../src/services/telegramStore.ts'

test('parseTelegramGiftLink resolves t.me/nft slugs, tg://nft URIs, and shorthand serials while rejecting spoofed hosts and 1-char prefixes', () => {
  const catalog = getBundledCatalog()

  assert.deepEqual(parseTelegramGiftLink('https://t.me/nft/PlushPepe-412', catalog), {
    collection: 'Plush Pepe',
    serialNumber: 412,
    rawSlug: 'PlushPepe-412',
  })

  assert.deepEqual(parseTelegramGiftLink('t.me/nft/DurovsCap-88', catalog), {
    collection: "Durov's Cap",
    serialNumber: 88,
    rawSlug: 'DurovsCap-88',
  })

  assert.deepEqual(parseTelegramGiftLink('tg://nft?slug=AstralShard-19', catalog), {
    collection: 'Astral Shard',
    serialNumber: 19,
    rawSlug: 'AstralShard-19',
  })

  assert.deepEqual(parseTelegramGiftLink('Kissed Frog #7', catalog), {
    collection: 'Kissed Frog',
    serialNumber: 7,
    rawSlug: 'Kissed Frog #7',
  })

  assert.equal(parseTelegramGiftLink('https://test.me/nft/PlushPepe-412', catalog), null)
  assert.equal(parseTelegramGiftLink('p', catalog), null)
  assert.equal(parseTelegramGiftLink('a', catalog), null)
  assert.equal(parseTelegramGiftLink('https://t.me/nft/NonExistentCollection-99', catalog), null)
  assert.equal(parseTelegramGiftLink('   ', catalog), null)
})

test('createImuGestureClassifier distinguishes pitch nod from yaw shake, enforces cooldown, and ignores partial samples', () => {
  let clock = 1_000
  const classifier = createImuGestureClassifier({ now: () => clock })

  // Incomplete samples without finite y & z are ignored
  assert.equal(classifier.push({ x: 0, y: 6.5 }), null)
  assert.equal(classifier.push({ x: 0, z: -6.5 }), null)

  // Calm baseline
  assert.equal(classifier.push({ x: 0, y: 0, z: 0 }), null)
  clock += 80
  // Downward pitch lobe + return -> 'nod'
  assert.equal(classifier.push({ x: 0.1, y: 6.2, z: 0.2 }), null)
  clock += 120
  assert.equal(classifier.push({ x: 0.1, y: -5.0, z: 0.1 }), 'nod')

  // During 1400ms cooldown, further spikes are ignored without corrupting baseline
  clock += 200
  assert.equal(classifier.push({ x: 0, y: 0, z: 6.5 }), null)
  clock += 100
  assert.equal(classifier.push({ x: 0, y: 0, z: -6.5 }), null)

  // After cooldown expires, left-right yaw reversal -> 'shake'
  clock += 1_500
  assert.equal(classifier.push({ x: 0, y: 0, z: 0 }), null)
  clock += 90
  assert.equal(classifier.push({ x: 0, y: 0.2, z: 6.0 }), null)
  clock += 110
  assert.equal(classifier.push({ x: 0, y: 0.1, z: -5.8 }), 'shake')
})

test('syncEvenHostStorage hydrates host favorites over auto-seeded starter defaults and backs up user keys without clobbering concurrent writes', async t => {
  const localMap = new Map()
  const hostMap = new Map([
    ['favorite_collections', JSON.stringify(['Swiss Watch', 'Loot Bag'])],
    [HW_PREFS_STORAGE_KEY, JSON.stringify({ imuTriageEnabled: false, irlOverheardEnabled: true })],
  ])
  localMap.set('telegifts_g2_watchlist_v1', JSON.stringify([{ collection: 'Plush Pepe', recordedFloor: 4820, addedAt: 'now' }]))

  const originalWindow = globalThis.window
  const originalLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storageObj = {
    getItem: k => (localMap.has(k) ? localMap.get(k) : null),
    setItem: (k, v) => localMap.set(k, String(v)),
    removeItem: k => localMap.delete(k),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storageObj })
  globalThis.window = Object.assign(new EventTarget(), { localStorage: storageObj })
  resetG2HardwarePreferencesForTests()

  t.after(() => {
    resetG2HardwarePreferencesForTests()
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalLs) Object.defineProperty(globalThis, 'localStorage', originalLs)
    else delete globalThis.localStorage
  })

  // Seed starter favorites first (as main.tsx does on cleared WebView cache)
  seedStarterFavoritesIfMissing(['Plush Pepe', 'Astral Shard'])
  assert.deepEqual(JSON.parse(localMap.get('favorite_collections')), ['Plush Pepe', 'Astral Shard'])

  const mockBridge = {
    getLocalStorage: async k => hostMap.get(k) ?? '',
    setLocalStorage: async (k, v) => {
      hostMap.set(k, v)
      return true
    },
  }

  const result = await syncEvenHostStorage(mockBridge)
  assert.ok(result.hydratedKeys.includes('favorite_collections'), 'Host favorites replace starter-only defaults')
  assert.deepEqual(JSON.parse(localMap.get('favorite_collections')), ['Swiss Watch', 'Loot Bag'])
  assert.ok(result.hydratedKeys.includes(HW_PREFS_STORAGE_KEY))
  assert.ok(result.backedUpKeys.includes('telegifts_g2_watchlist_v1'))
  assert.equal(getG2HardwarePreferences().imuTriageEnabled, false)
  assert.equal(getG2HardwarePreferences().irlOverheardEnabled, true)
  assert.ok(hostMap.get('telegifts_g2_watchlist_v1')?.includes('Plush Pepe'))
})

test('end-to-end G2 hardware differentiators: early glassesMenu capture, power-gated IMU nod/shake triage, Gift Link overlay dismissal, and 12s speakerRole=other IRL audioEvent pipeline', async t => {
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const localMap = new Map()
  const originalLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const storageObj = {
    getItem: k => (localMap.has(k) ? localMap.get(k) : null),
    setItem: (k, v) => localMap.set(k, String(v)),
    removeItem: k => localMap.delete(k),
  }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storageObj })

  globalThis.document = Object.assign(new EventTarget(), {
    readyState: 'complete',
    hidden: false,
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toBlob: done => done(new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)])),
    }),
  })
  globalThis.window = Object.assign(new EventTarget(), { localStorage: storageObj })
  resetG2HardwarePreferencesForTests()
  installEarlyLaunchSourceCapture()

  // Simulate one-shot evenAppLaunchSource arriving BEFORE connectGlasses starts (using SDK's detail.launchSource shape)!
  globalThis.window.dispatchEvent(new CustomEvent('evenAppLaunchSource', { detail: { launchSource: 'glassesMenu' } }))

  const sim = installBrowserSimulatorIfStandalone()
  assert.ok(sim)

  const catalog = getBundledCatalog()
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
    },
    () => selected?.name,
  )

  const phone = {
    loadCatalog: async () => catalog,
    loadArtwork: async () => null,
    loadFloorChart: async () => ({ from: 0, to: 86400, interval: 86400, points: [{ time: 86400, price: 890 }] }),
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

  let overheardCalls = 0
  const voice = createVoiceControl({
    names: display.voiceNames,
    resolve: display.resolveVoice,
    transcribe: async () => 'open Plush Pepe',
  })

  display.companion.setTelegram(tgStore)
  display.companion.setTools(toolbox)
  const disconnect = display.companion.connect(phone)

  session = await connectGlasses({
    ...display,
    voice,
    transcribeOverheard: async () => {
      overheardCalls++
      return 'Astral Shard'
    },
    showDisplayError: () => {},
  })
  await settle()
  await settle()

  t.after(async () => {
    resetG2HardwarePreferencesForTests()
    await session.stop()
    disconnect()
    sim.restoreNativeHostBridge()
    if (originalWindow) globalThis.window = originalWindow
    else delete globalThis.window
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
    if (originalLs) Object.defineProperty(globalThis, 'localStorage', originalLs)
    else delete globalThis.localStorage
  })

  // 1. Pre-startup one-shot 'glassesMenu' event replayed into connectGlasses -> Morning Brief ('summary')!
  assert.equal(toolbox.getActiveTool(), 'summary')
  assert.match(toolbox.getSnapshot().title, /Morning brief · 1\/4/)
  toolbox.close()
  await settle()

  // 2. IMU is OFF during idle browsing AND during manual Channel Digest browsing ('digest-dig-*')!
  assert.equal(sim.isImuEnabled(), false)
  tgStore.openDigest()
  await settle()
  await settle()
  assert.equal(sim.isImuEnabled(), false, 'Manual Channel Digest browsing must NOT enable IMU')
  tgStore.back()
  await settle()

  // 3. Watch-hit alert ('digest-watch-*') DOES enable IMU, and Shake dismisses & turns IMU OFF!
  setG2HardwarePreferences({ imuTriageEnabled: true })
  tgStore.pushWatchDigestAlert('Plush Pepe', 4750, 4800, true)
  await settle()
  await settle()
  assert.equal(sim.isImuEnabled(), true, 'Watch-hit alert enables IMU')
  sim.shake()
  await settle()
  await settle()
  assert.equal(sim.isImuEnabled(), false, 'Dismissing watch alert turns IMU off immediately')

  // 4. Next LIVE /ASK Heads-Up + Head Nod opens 1-Tap Smart Reply composer (and turns IMU back OFF on compose)!
  await new Promise(r => setTimeout(r, 1450))
  tgStore.triggerHeadsUpQuestion()
  await settle()
  await settle()
  assert.equal(tgStore.getSnapshot().screen.kind, 'heads-up')
  assert.equal(sim.isImuEnabled(), true)

  sim.nod()
  await settle()
  await settle()
  assert.equal(tgStore.getSnapshot().screen.kind, 'compose', 'Head nod opens 1-Tap Smart Reply composer')
  assert.equal(sim.isImuEnabled(), false, 'IMU disables once user enters compose')

  // 5. Quick-Beam t.me/nft/DurovsCap-88 dismisses active Telegram compose overlay and projects 5-Venue Spread!
  const beamed = display.openGiftLink('https://t.me/nft/DurovsCap-88', 'spread')
  await settle()
  assert.equal(tgStore.getSnapshot().screen.kind, 'idle', 'openGiftLink cancels active Telegram overlay')
  assert.equal(beamed?.collection, "Durov's Cap")
  assert.equal(beamed?.serialNumber, 88)
  assert.equal(display.inspector.getSnapshot().mode, 'spread')
  assert.equal(display.inspector.getSnapshot().collection, "Durov's Cap")

  // 6. Bounded 12s IRL Meetup Listen opens G2 mic, processes speakerRole=other audioEvent, closes mic, and beams Astral Shard!
  display.companion.select(null)
  selected = null
  await settle()

  const voicedSamples = Int16Array.from({ length: 4800 }, (_, i) => (i % 2 ? 1800 : -1800))
  const quietSamples = new Int16Array(16_000) // 1.0s silence finishes utterance
  const fullPcm = new Uint8Array((voicedSamples.length + quietSamples.length) * 2)
  fullPcm.set(new Uint8Array(voicedSamples.buffer), 0)
  fullPcm.set(new Uint8Array(quietSamples.buffer), voicedSamples.byteLength)

  assert.equal(sim.isMicEnabled(), false)
  assert.equal(session.startIrlListen(12_000), true)
  await settle()
  assert.equal(sim.isMicEnabled(), true, 'startIrlListen opens G2 hardware microphone')

  // Feed actual speakerRole='other' PCM through EvenAppBridge audioEvent
  sim.emitAudioPcm(fullPcm, 'other')
  await settle()
  await settle()
  await settle()

  assert.equal(sim.isMicEnabled(), false, 'G2 microphone auto-closes immediately after overheard utterance completes')
  assert.equal(overheardCalls, 1)
  assert.equal(display.inspector.getSnapshot().mode, 'spread')
  assert.equal(display.inspector.getSnapshot().collection, 'Astral Shard')

  // 7. Starting a wearer voice command cancels IRL listen and ignores speakerRole='other' frames!
  session.startIrlListen(12_000)
  await settle()
  voice.controls.start()
  await settle()
  sim.emitAudioPcm(fullPcm, 'other')
  await settle()
  assert.equal(overheardCalls, 1, 'Overheard pipeline must never run during an active wearer voice session')
  voice.controls.cancel()
  await settle()

  assert.equal(
    validateEvenHubPageContainer({
      containerTotalNum: 1,
      textObject: [{ containerID: 1, containerName: 't', width: 560, height: 276, xPosition: 8, yPosition: 6, isEventCapture: 1, content: 'ok' }],
    }).valid,
    true,
  )
})
