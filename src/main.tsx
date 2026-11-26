import '@telegifts/phone/style.css'
import './studioShell.css'
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { mountTeleGifts } from '@telegifts/phone'
import { createCollectionDisplay } from './collectionDisplay.ts'
import { connectGlasses } from './glasses.ts'
import { createGlassesConnection } from './glassesConnection.ts'
import {
  hasHostEvenBridge,
  installBrowserSimulatorIfStandalone,
  type BrowserSimulatorControls,
} from './services/browserEvenBridge.ts'
import {
  installEarlyLaunchSourceCapture,
  installLocalStorageHostWriteThrough,
  seedStarterFavoritesIfMissing,
  syncEvenHostStorage,
  type HostStorageBridgeLike,
} from './services/evenHostStorage.ts'
import {
  getGiftiSessionSnapshot,
  transcribeFreeformWithEphemeralAi,
} from './services/giftiAiBridge.ts'
import { startLiveTonUsdtTicker } from './services/liveTicker.ts'
import {
  askHostGiftiPrompt,
  closeHostOverlays,
  notifyHostBridgeRateChanged,
  openHostGiftiVoice,
  openHostPendingSummary,
  openHostResearch,
  registerHostBrowserSpeechReader,
  registerHostGiftLinkOpener,
  registerHostIrlListenStarter,
  triggerHostBurstAsks,
  triggerHostLiveAsk,
} from './services/phoneHostBridge.ts'
import {
  bindJudgeStudioControls,
  mountMobileStudioBanner,
  prepareJudgeStudioDom,
  shouldEnableJudgeStudio,
  shouldShowMobileStudioBanner,
} from './studioShell.ts'
import { createVoiceControl } from './voiceControl.ts'

// Capture one-shot `evenAppLaunchSource` before async page startup and mirror runtime Favorites writes
installEarlyLaunchSourceCapture()
installLocalStorageHostWriteThrough()

// Ensure first-time launches open directly onto Explore (and never get stuck on removed "sets" tab)
try {
  if (window.localStorage.getItem('hasCompletedOnboarding') === null) {
    window.localStorage.setItem('hasCompletedOnboarding', 'true')
  }
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i)
    if (k && k.startsWith('explore_section')) {
      const v = window.localStorage.getItem(k)
      if (v === 'sets' || v === '"sets"') {
        window.localStorage.setItem(k, v === '"sets"' ? '"gifts"' : 'gifts')
      }
    }
  }
  if (window.history.state && window.history.state.__exploreSection === 'sets') {
    window.history.replaceState({ ...window.history.state, __exploreSection: 'gifts' }, '')
  }
} catch {
  // Ignore storage restrictions in private WebViews
}

// Protect GitHub Pages subpath deployments (e.g. /<repo>/) when phone deep-link cleanup calls history.replaceState(..., '/')
try {
  const initialPathname = window.location.pathname || '/'
  const initialBaseDir = initialPathname.endsWith('/')
    ? initialPathname
    : initialPathname.slice(0, initialPathname.lastIndexOf('/') + 1) || '/'
  if (initialBaseDir !== '/') {
    const rawReplaceState = window.history.replaceState.bind(window.history)
    window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
      if (url !== undefined && url !== null) {
        try {
          const parsed = new URL(String(url), window.location.origin)
          if (parsed.origin === window.location.origin && parsed.pathname === '/') {
            parsed.pathname = initialBaseDir
            rawReplaceState(data, unused, `${parsed.pathname}${parsed.search}${parsed.hash}`)
            return
          }
        } catch {}
      }
      rawReplaceState(data, unused, url)
    }
  }
} catch {}
seedStarterFavoritesIfMissing(['Plush Pepe', 'Astral Shard', "Durov's Cap", 'Kissed Frog'])

let initialSimControls: BrowserSimulatorControls | undefined = installBrowserSimulatorIfStandalone()

const display = createCollectionDisplay(() => glasses.update())

const voice = createVoiceControl({
  names: display.voiceNames,
  resolve: display.resolveVoice,
  transcribe: async (pcm, names, signal) => (await import('./voiceRecognition.ts')).transcribeVoice(pcm, names, signal),
})

const glasses = createGlassesConnection((onClosed, showDisplayError, onStartupRebuild, onMirrorChange) =>
  connectGlasses(
    {
      ...display,
      voice,
      transcribeOverheard: async (pcm, names, signal) =>
        (await import('./voiceRecognition.ts')).transcribeVoice(pcm, names, signal, 'overheard'),
      transcribeDictation: async (pcm, signal) => {
        if (!getGiftiSessionSnapshot().hasEphemeralKey) return null
        return (await transcribeFreeformWithEphemeralAi(pcm, signal))?.text ?? null
      },
      showDisplayError,
      onMirrorChange,
    },
    onClosed,
    onStartupRebuild,
  ),
)

const appCompanion = {
  ...display.companion,
  displayConnection: {
    ...glasses.connection,
    voice: voice.controls,
    transcribeVoiceQuestion: (pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal) => voice.transcribePcm(pcm, signal),
  },
}

registerHostGiftLinkOpener((rawInput: string) => display.openGiftLink(rawInput, 'spread'))
registerHostIrlListenStarter((durationMs?: number) => glasses.startIrlListen(durationMs))

startLiveTonUsdtTicker(usd => {
  display.companion.rateChanged(usd)
  notifyHostBridgeRateChanged()
})

const runVoicePhrase = (phrase: string) => {
  const res = display.resolveVoice(phrase, undefined, 'glasses')
  if (res.kind === 'action') res.run()
}

if (initialSimControls) {
  registerHostBrowserSpeechReader(() => initialSimControls?.consumeLastBrowserSpeechTranscript() ?? null)
  ;(window as { __TELEGIFTS_SIM__?: unknown }).__TELEGIFTS_SIM__ = {
    controls: initialSimControls,
    connection: glasses.connection,
    companion: appCompanion,
    startIrlListen: (durationMs?: number) => glasses.startIrlListen(durationMs),
    triggerLiveAsk: triggerHostLiveAsk,
    triggerBurstAsks: triggerHostBurstAsks,
    openPending: openHostPendingSummary,
    askGiftiText: askHostGiftiPrompt,
    startGiftiVoice: openHostGiftiVoice,
    openResearch: () => openHostResearch('Plush Pepe'),
    closeOverlays: closeHostOverlays,
    runVoicePhrase,
  }
}

let studioDomDisposer: (() => void) | null = null
let studioControlsDisposer: (() => void) | null = null
let mobileBannerDisposer: (() => void) | null = null

async function bootstrapCompanionUi() {
  if (hasHostEvenBridge()) {
    await Promise.race([
      waitForEvenAppBridge()
        .then(b => syncEvenHostStorage(b as unknown as HostStorageBridgeLike))
        .catch(() => null),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 400)),
    ])
  }

  const rootEl = document.getElementById('root')!
  const studioActive = Boolean(initialSimControls && shouldEnableJudgeStudio(true))
  if (studioActive) {
    studioDomDisposer = prepareJudgeStudioDom(rootEl)
  } else if (initialSimControls && shouldShowMobileStudioBanner(true)) {
    mobileBannerDisposer = mountMobileStudioBanner()
  }

  mountTeleGifts(rootEl, appCompanion)

  if (studioActive && initialSimControls) {
    studioControlsDisposer = bindJudgeStudioControls({
      sim: initialSimControls,
      connection: glasses.connection,
      voice: voice.controls,
      runVoicePhrase,
      triggerLiveAsk: triggerHostLiveAsk,
      triggerBurstAsks: triggerHostBurstAsks,
      openPending: openHostPendingSummary,
      askGiftiText: askHostGiftiPrompt,
      startGiftiVoice: openHostGiftiVoice,
      startIrlListen: () => glasses.startIrlListen(12_000),
      openResearch: () => openHostResearch('Plush Pepe'),
      closeOverlays: closeHostOverlays,
    })
  }

  if (initialSimControls || hasHostEvenBridge()) {
    void glasses.connection.open()
  }
}

void bootstrapCompanionUi()

// Listen for delayed native Flutter InAppWebView initialization:
// tear down the standalone browser simulator bridge and connect to the real Even host.
window.addEventListener(
  'flutterInAppWebViewPlatformReady',
  () => {
    studioControlsDisposer?.()
    studioControlsDisposer = null
    studioDomDisposer?.()
    studioDomDisposer = null
    mobileBannerDisposer?.()
    mobileBannerDisposer = null
    if (initialSimControls) {
      const activeSim = initialSimControls
      initialSimControls = undefined
      registerHostBrowserSpeechReader(null)
      delete (window as { __TELEGIFTS_SIM__?: unknown }).__TELEGIFTS_SIM__
      activeSim.restoreNativeHostBridge()
    }
    queueMicrotask(() => {
      void glasses.connection.open()
    })
  },
  { once: true },
)
