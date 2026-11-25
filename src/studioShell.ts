import type { CompanionDisplayConnection, CompanionVoiceControl } from './contracts/companion.ts'
import type { BrowserSimulatorControls } from './services/browserEvenBridge.ts'
import {
  clearEphemeralAiToken,
  getGiftiSessionSnapshot,
  setEphemeralAiToken,
  subscribeGiftiSession,
} from './services/giftiAiBridge.ts'

export interface StudioShellBindings {
  sim: BrowserSimulatorControls
  connection: CompanionDisplayConnection
  voice: CompanionVoiceControl
  runVoicePhrase(phrase: string): void
  triggerLiveAsk(): void
  askGiftiText(prompt: string): Promise<void>
  startGiftiVoice(): void
  startIrlListen(): boolean
  openResearch(): void
  closeOverlays(): void
}

export function shouldEnableJudgeStudio(hasSim: boolean): boolean {
  if (!hasSim || typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('raw') === '1' || params.get('studio') === '0') return false
  if (params.get('studio') === '1') return true
  return window.innerWidth >= 920
}

/**
 * Wraps `#root` inside a side-by-side TeleGifts Phone Bezel + Even Realities G2
 * Optical Waveguide & Voice/AI Hardware Test Bench for public GitHub Pages visitors.
 */
export function prepareJudgeStudioDom(rootEl: HTMLElement): () => void {
  document.body.classList.add('tg-g2-studio')
  const layout = document.createElement('div')
  layout.className = 'tg-studio-layout'

  const bezel = document.createElement('div')
  bezel.className = 'tg-studio-phone-bezel'
  bezel.id = 'tg-studio-bezel'

  const bench = document.createElement('div')
  bench.className = 'tg-studio-bench'
  bench.id = 'tg-studio-bench'

  rootEl.replaceWith(layout)
  bezel.appendChild(rootEl)
  layout.appendChild(bezel)
  layout.appendChild(bench)

  const syncBezelCoords = () => {
    const rect = bezel.getBoundingClientRect()
    document.body.style.setProperty('--tg-bezel-top', `${Math.round(rect.top)}px`)
    document.body.style.setProperty('--tg-bezel-left', `${Math.round(rect.left)}px`)
  }
  syncBezelCoords()
  window.addEventListener('resize', syncBezelCoords)
  window.addEventListener('scroll', syncBezelCoords, { passive: true })

  return () => {
    window.removeEventListener('resize', syncBezelCoords)
    window.removeEventListener('scroll', syncBezelCoords)
    document.body.classList.remove('tg-g2-studio')
    document.body.style.removeProperty('--tg-bezel-top')
    document.body.style.removeProperty('--tg-bezel-left')
    if (layout.parentNode) {
      layout.replaceWith(rootEl)
    }
  }
}

export function bindJudgeStudioControls(bindings: StudioShellBindings): () => void {
  const bench = document.getElementById('tg-studio-bench')
  if (!bench) return () => {}

  bench.innerHTML = `
    <div class="tg-studio-header">
      <div class="tg-studio-brand">
        <h1>TeleGifts G2 · Interactive Hardware &amp; Voice Studio</h1>
        <p>Real TeleGifts Phone Companion paired live with Even Realities G2 (576×288 4-bit HUD), R1 Ring &amp; Offline WASM / Gifti AI Voice</p>
      </div>
      <div class="tg-studio-pills">
        <button type="button" class="tg-pill tg-pill-btn tg-pill--primary" id="btnAutoTour" title="Play a 35-second guided live showcase across Phone &amp; G2 HUD">▶ Auto-Tour</button>
        <a class="tg-pill tg-pill-link" href="./telegifts-g2.ehpk" download="telegifts-g2.ehpk" title="Download Even Hub .ehpk package (SDK 0.0.16)">⬇ .ehpk</a>
        <span class="tg-pill tg-pill--red" id="tgMicPill" style="display:none"><span class="tg-dot"></span>MIC LIVE (16 kHz)</span>
        <span class="tg-pill tg-pill--amber" id="tgImuPill" style="display:none">IMU NOD/SHAKE: ON</span>
        <span class="tg-pill tg-pill--green"><span class="tg-dot"></span><span id="tgHudStatus">G2 Ready · 92%</span></span>
      </div>
    </div>

    <div class="tg-studio-card">
      <div class="tg-card-head">
        <span class="tg-card-title">Even Realities G2 Optical Waveguide · 576 × 288 (16-Shade Monochrome Green)</span>
        <div class="tg-backdrop-tabs" role="group" aria-label="Lens environment backdrop">
          <button type="button" class="is-active" data-backdrop="dark">Dark Lab</button>
          <button type="button" data-backdrop="meetup">TON Meetup</button>
          <button type="button" data-backdrop="daylight">City Walk</button>
        </div>
      </div>
      <div class="tg-lens-viewport" id="tgLensViewport" data-scene="dark">
        <canvas id="tgStudioCanvas" width="576" height="288"></canvas>
      </div>
      <div class="tg-menu-bar" id="tgStudioMenuBar"></div>
    </div>

    <div class="tg-studio-card">
      <div class="tg-card-head">
        <span class="tg-card-title">G2 Temple Touch, R1 Ring &amp; IMU Head-Gesture Controls</span>
        <span class="tg-pill">Keyboard: ↑/↓ Swipe · Enter Tap · Esc 2×Tap · Space Hold Ring</span>
      </div>
      <div class="tg-controls-grid">
        <button type="button" class="tg-btn" id="btnSwipeUp">▲ Swipe Up <span class="tg-kbd">↑</span></button>
        <button type="button" class="tg-btn" id="btnSwipeDown">▼ Swipe Down <span class="tg-kbd">↓</span></button>
        <button type="button" class="tg-btn tg-btn--green" id="btnTap">● Tap / Confirm <span class="tg-kbd">Enter</span></button>
        <button type="button" class="tg-btn" id="btnDoubleTap">↺ 2×Tap / Back <span class="tg-kbd">Esc</span></button>
        <button type="button" class="tg-btn tg-btn--primary" id="btnRingHold">💍 Hold R1 Ring (PTT)</button>
        <button type="button" class="tg-btn" id="btnImuNod">🙂 IMU Head Nod</button>
        <button type="button" class="tg-btn" id="btnImuShake">↔️ IMU Head Shake</button>
        <button type="button" class="tg-btn tg-btn--primary" id="btnLiveAsk">⚡ + Live /ask Alert</button>
      </div>
    </div>

    <div class="tg-studio-card">
      <div class="tg-card-head">
        <span class="tg-card-title">Live Microphone Voice Input &amp; Gifti AI Copilot</span>
        <span class="tg-pill tg-pill--green" id="tgGiftiQuotaPill">Gifti Demo: 20/20 free</span>
      </div>
      <div class="tg-voice-row">
        <button type="button" class="tg-btn tg-btn--green" id="btnSpeakCmd">🎤 Speak G2 Command (Real Mic)</button>
        <button type="button" class="tg-btn tg-btn--primary" id="btnSpeakGifti">🤖 Speak to Gifti AI</button>
        <button type="button" class="tg-btn" id="btnIrlListen">🗣️ 12s IRL Counterparty Mic</button>
        <div class="tg-vu-meter" title="Live 16 kHz microphone input level"><div class="tg-vu-fill" id="tgVuFill"></div></div>
      </div>

      <form class="tg-ai-form" id="tgGiftiForm">
        <input type="text" class="tg-input" id="tgGiftiInput" placeholder="Or ask Gifti anything (e.g. 'Best net arbitrage right now?' or 'Compare Plush Pepe and Astral Shard')" />
        <button type="submit" class="tg-btn tg-btn--primary">Ask Gifti</button>
      </form>

      <div class="tg-presets" id="tgVoicePresets">
        <button type="button" class="tg-preset-chip" data-voice="open Plush Pepe">🎙 "Open Plush Pepe"</button>
        <button type="button" class="tg-preset-chip" data-voice="show the seven day chart">🎙 "Show 7d chart"</button>
        <button type="button" class="tg-preset-chip" data-voice="show venue spread">🎙 "Show venue spread"</button>
        <button type="button" class="tg-preset-chip" data-voice="open inbox">🎙 "Open inbox"</button>
        <button type="button" class="tg-preset-chip" data-voice="what changed">🎙 "60s Morning brief"</button>
        <button type="button" class="tg-preset-chip" data-gifti="What is the best net arbitrage spread across venues right now?">🤖 "Best net arbitrage?"</button>
      </div>

      <details class="tg-token-details">
        <summary>🔑 Optional: Paste 1-Time AI Token (OpenAI / Gemini / Groq — RAM-only, never saved anywhere)</summary>
        <div class="tg-ai-form" style="margin-top:7px">
          <input type="password" autocomplete="off" spellcheck="false" class="tg-input" id="tgEphemeralKeyInput" placeholder="sk-... / AIza... / gsk_... (kept strictly in JS memory, cleared on reload)" />
          <button type="button" class="tg-btn tg-btn--green" id="btnApplyKey">Use for Session</button>
          <button type="button" class="tg-btn" id="btnClearKey">Forget</button>
        </div>
      </details>

      <div class="tg-status-line" id="tgStudioStatus" role="status">Ready — click 🎤 Speak G2 Command to use your real microphone (offline WASM) or 🤖 Speak to Gifti AI.</div>
    </div>
  `

  const canvas = document.getElementById('tgStudioCanvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const menuBar = document.getElementById('tgStudioMenuBar')!
  const imuPill = document.getElementById('tgImuPill')!
  const micPill = document.getElementById('tgMicPill')!
  const hudStatus = document.getElementById('tgHudStatus')!
  const vuFill = document.getElementById('tgVuFill')!
  const quotaPill = document.getElementById('tgGiftiQuotaPill')!
  const statusLine = document.getElementById('tgStudioStatus')!
  const viewport = document.getElementById('tgLensViewport')!
  const btnSpeakCmd = document.getElementById('btnSpeakCmd') as HTMLButtonElement

  let cachedUrl: string | null = null
  let cachedHash = 0
  let decodedImg: HTMLImageElement | null = null

  const hashBytes = (bytes: Uint8Array) => {
    let h = 2166136261 >>> 0
    const step = Math.max(1, Math.floor(bytes.length / 256))
    for (let i = 0; i < bytes.length; i += step) {
      h ^= bytes[i]!
      h = Math.imul(h, 16777619) >>> 0
    }
    return (h ^ bytes.length) >>> 0
  }

  const wrapLines = (text: string, maxWidth: number, font: string) => {
    ctx.font = font
    const out: string[] = []
    for (const raw of String(text || '').split('\n')) {
      if (!raw) {
        out.push('')
        continue
      }
      let cur = ''
      for (const w of raw.split(' ')) {
        const test = cur ? `${cur} ${w}` : w
        if (ctx.measureText(test).width > maxWidth && cur) {
          out.push(cur)
          cur = w
        } else {
          cur = test
        }
      }
      if (cur) out.push(cur)
    }
    return out
  }

  const paintHud = () => {
    ctx.clearRect(0, 0, 576, 288)
    ctx.fillStyle = 'rgba(2, 6, 3, 0.72)'
    ctx.fillRect(0, 0, 576, 288)

    const mirror = bindings.connection.getHudMirror?.() ?? null
    if (!mirror) return

    const hasImg = Boolean(mirror.imageBytes && mirror.imageSize)
    const large = Boolean(hasImg && mirror.imageSize!.width > 140)
    const bodyW = hasImg ? (large ? 276 : 412) : 544

    if (mirror.header) {
      ctx.fillStyle = 'rgba(116, 236, 152, 0.76)'
      ctx.font = '600 13px Consolas, monospace'
      ctx.fillText(mirror.header.slice(0, 68), 16, 24)
      ctx.strokeStyle = 'rgba(116, 236, 152, 0.2)'
      ctx.beginPath()
      ctx.moveTo(16, 34)
      ctx.lineTo(560, 34)
      ctx.stroke()
    }

    ctx.fillStyle = '#72ff9d'
    const lines = wrapLines(mirror.body, bodyW, '600 14.5px Consolas, monospace')
    let y = mirror.header ? 56 : 30
    for (const ln of lines.slice(0, 9)) {
      ctx.fillText(ln, 16, y)
      y += 20
    }

    if (hasImg && decodedImg && mirror.imageSize) {
      const w = mirror.imageSize.width
      const h = mirror.imageSize.height
      const ix = large ? 302 : 436
      const iy = large ? 54 : 52
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d')!
      octx.drawImage(decodedImg, 0, 0, w, h)
      const imgData = octx.getImageData(0, 0, w, h)
      const d = imgData.data
      for (let i = 0; i < d.length; i += 4) {
        const lum = Math.max(d[i]!, d[i + 1]!, d[i + 2]!)
        const v = lum * (d[i + 3]! / 255)
        d[i] = Math.round(v * 0.28)
        d[i + 1] = Math.min(255, Math.round(v))
        d[i + 2] = Math.round(v * 0.46)
        d[i + 3] = v > 6 ? 255 : 0
      }
      octx.putImageData(imgData, 0, 0)
      ctx.fillStyle = 'rgba(8, 22, 12, 0.72)'
      ctx.fillRect(ix - 4, iy - 4, w + 8, h + 8)
      ctx.drawImage(off, ix, iy)
      ctx.strokeStyle = 'rgba(116, 236, 152, 0.36)'
      ctx.strokeRect(ix - 4, iy - 4, w + 8, h + 8)
    }

    if (mirror.footer) {
      ctx.strokeStyle = 'rgba(116, 236, 152, 0.2)'
      ctx.beginPath()
      ctx.moveTo(16, 248)
      ctx.lineTo(560, 248)
      ctx.stroke()
      ctx.fillStyle = 'rgba(136, 244, 168, 0.9)'
      ctx.font = '500 12.5px Consolas, monospace'
      ctx.fillText(mirror.footer.slice(0, 74), 16, 270)
    }
  }

  const syncMenuAndStatus = () => {
    const mirror = bindings.connection.getHudMirror?.() ?? null
    if (mirror?.imageBytes?.length) {
      const h = hashBytes(mirror.imageBytes)
      if (h !== cachedHash) {
        cachedHash = h
        if (cachedUrl) URL.revokeObjectURL(cachedUrl)
        const nextUrl = URL.createObjectURL(new Blob([mirror.imageBytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
        cachedUrl = nextUrl
        const im = new Image()
        im.onload = () => {
          if (cachedUrl !== nextUrl) return
          decodedImg = im
          paintHud()
        }
        im.src = nextUrl
      }
    } else {
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl)
        cachedUrl = null
      }
      cachedHash = 0
      decodedImg = null
    }

    const activeMenu = bindings.sim.getActiveMenu()
    menuBar.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'tg-menu-label'
    label.textContent = activeMenu.length ? 'G2 Native Menu (Click):' : 'G2 Controls:'
    menuBar.appendChild(label)

    if (activeMenu.length) {
      for (const item of activeMenu) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'tg-menu-chip'
        chip.textContent = item.itemName
        chip.onclick = () => bindings.sim.menuSelect(item.itemName)
        menuBar.appendChild(chip)
      }
    } else {
      for (const hint of ['Swipe · Browse', 'Tap · Select', '2×Tap · Back']) {
        const span = document.createElement('span')
        span.className = 'tg-menu-chip'
        span.style.cursor = 'default'
        span.textContent = hint
        menuBar.appendChild(span)
      }
    }

    if (mirror) {
      const src = mirror.telemetry.lastInputSource ? ` · ${mirror.telemetry.lastInputSource.toUpperCase()}` : ''
      hudStatus.textContent = `${mirror.navigation}${src} · ${mirror.telemetry.batteryLevel ?? 92}%`
    }
    paintHud()
  }

  const syncGiftiUi = () => {
    const snap = getGiftiSessionSnapshot()
    if (snap.hasEphemeralKey && snap.provider) {
      quotaPill.textContent = `1-Time ${snap.provider.toUpperCase()} Key (RAM Only)`
    } else {
      quotaPill.textContent = `Gifti Demo: ${snap.freeTurnsRemaining}/${snap.freeTurnsTotal} free`
    }
    if (snap.error) {
      statusLine.textContent = snap.error
    } else if (snap.lastTranscript) {
      statusLine.textContent = `Heard: "${snap.lastTranscript}"`
    }
  }

  const unsubMirror = bindings.connection.subscribeMirror?.(syncMenuAndStatus)
  const unsubGifti = subscribeGiftiSession(syncGiftiUi)
  const unsubVoice = bindings.voice.subscribe(() => {
    const phase = bindings.voice.getSnapshot().phase
    const active = phase === 'starting' || phase === 'listening' || phase === 'processing'
    btnSpeakCmd.classList.toggle('tg-btn--recording', active)
    btnSpeakCmd.textContent = active ? `⏹ Stop / Finish (${phase}…)` : '🎤 Speak G2 Command (Real Mic)'
  })

  let irlRoleTimer: ReturnType<typeof setTimeout> | undefined
  const pollTimer = setInterval(() => {
    const micOn = bindings.sim.isMicEnabled()
    const imuOn = bindings.sim.isImuEnabled()
    micPill.style.display = micOn ? 'inline-flex' : 'none'
    imuPill.style.display = imuOn ? 'inline-flex' : 'none'
    vuFill.style.width = `${Math.round(bindings.sim.getMicLevel() * 100)}%`
  }, 80)

  // Backdrop switcher
  bench.querySelectorAll<HTMLButtonElement>('[data-backdrop]').forEach(btn => {
    btn.onclick = () => {
      bench.querySelectorAll('[data-backdrop]').forEach(b => b.classList.remove('is-active'))
      btn.classList.add('is-active')
      viewport.dataset.scene = btn.dataset.backdrop ?? 'dark'
    }
  })

  // Hardware buttons
  document.getElementById('btnSwipeUp')!.onclick = () => bindings.sim.swipe(-1)
  document.getElementById('btnSwipeDown')!.onclick = () => bindings.sim.swipe(1)
  document.getElementById('btnTap')!.onclick = () => bindings.sim.tap()
  document.getElementById('btnDoubleTap')!.onclick = () => bindings.sim.doubleTap()
  document.getElementById('btnImuNod')!.onclick = () => {
    bindings.sim.nod()
    statusLine.textContent = bindings.sim.isImuEnabled()
      ? 'IMU Head Nod dispatched → accepted active alert.'
      : 'IMU is power-gated OFF on idle screens — trigger "+ Live /ask Alert" first to test Head Nod!'
  }
  document.getElementById('btnImuShake')!.onclick = () => {
    bindings.sim.shake()
    statusLine.textContent = bindings.sim.isImuEnabled()
      ? 'IMU Head Shake dispatched → dismissed active alert.'
      : 'IMU is power-gated OFF on idle screens — trigger "+ Live /ask Alert" first to test Head Shake!'
  }
  document.getElementById('btnLiveAsk')!.onclick = () => {
    bindings.triggerLiveAsk()
    statusLine.textContent = 'Triggered LIVE /ASK interrupt — try 🙂 IMU Head Nod or ● Tap!'
  }

  const ringBtn = document.getElementById('btnRingHold')!
  let ringHeld = false
  const startRing = () => {
    if (ringHeld) return
    ringHeld = true
    ringBtn.classList.add('tg-btn--recording')
    bindings.sim.setSpeakerRole('wearer')
    bindings.sim.holdStart('RING')
  }
  const endRing = () => {
    if (!ringHeld) return
    ringHeld = false
    ringBtn.classList.remove('tg-btn--recording')
    bindings.sim.holdEnd('RING')
  }
  ringBtn.addEventListener('pointerdown', startRing)
  window.addEventListener('pointerup', endRing)

  // Voice & Gifti controls
  btnSpeakCmd.onclick = () => {
    bindings.sim.setSpeakerRole('wearer')
    const phase = bindings.voice.getSnapshot().phase
    if (phase === 'listening') {
      bindings.voice.activate('glasses')
    } else if (phase === 'idle' || phase === 'error') {
      statusLine.textContent = 'Listening on browser microphone (16 kHz → offline SoundSwallower WASM)… Say e.g. "open Plush Pepe" or "show 7 day chart".'
      bindings.voice.start('glasses')
    } else {
      bindings.voice.cancel()
    }
  }

  document.getElementById('btnSpeakGifti')!.onclick = () => {
    bindings.sim.setSpeakerRole('wearer')
    statusLine.textContent = 'Listening for your Gifti AI question on microphone… Speak naturally, then pause.'
    bindings.startGiftiVoice()
  }

  document.getElementById('btnIrlListen')!.onclick = () => {
    const ok = bindings.startIrlListen()
    if (ok) {
      bindings.sim.setSpeakerRole('other')
      clearTimeout(irlRoleTimer)
      irlRoleTimer = setTimeout(() => bindings.sim.setSpeakerRole('wearer'), 12_500)
    }
    statusLine.textContent = ok
      ? '12s IRL Counterparty Mic active (speakerRole=other) — mention any gift name like "Astral Shard"!'
      : 'Cancel active voice/overlay first to start 12s IRL listen.'
  }

  const giftiForm = document.getElementById('tgGiftiForm') as HTMLFormElement
  const giftiInput = document.getElementById('tgGiftiInput') as HTMLInputElement
  giftiForm.onsubmit = ev => {
    ev.preventDefault()
    const q = giftiInput.value.trim()
    if (!q) return
    statusLine.textContent = `Asking Gifti: "${q}"…`
    giftiInput.value = ''
    void bindings.askGiftiText(q)
  }

  document.getElementById('tgVoicePresets')!.querySelectorAll<HTMLButtonElement>('button').forEach(chip => {
    chip.onclick = () => {
      const voiceCmd = chip.dataset.voice
      const giftiPrompt = chip.dataset.gifti
      if (voiceCmd) {
        statusLine.textContent = `Voice command → "${voiceCmd}"`
        bindings.runVoicePhrase(voiceCmd)
      } else if (giftiPrompt) {
        statusLine.textContent = `Gifti AI → "${giftiPrompt}"`
        void bindings.askGiftiText(giftiPrompt)
      }
    }
  })

  const keyInput = document.getElementById('tgEphemeralKeyInput') as HTMLInputElement
  document.getElementById('btnApplyKey')!.onclick = () => {
    const val = keyInput.value.trim()
    if (!val) return
    setEphemeralAiToken(val)
    keyInput.value = ''
    const snap = getGiftiSessionSnapshot()
    statusLine.textContent = `Applied 1-time ${snap.provider?.toUpperCase()} token in RAM only (never stored anywhere).`
  }
  document.getElementById('btnClearKey')!.onclick = () => {
    clearEphemeralAiToken()
    keyInput.value = ''
    statusLine.textContent = 'Cleared in-memory AI token — back to 20 free demo messages.'
  }

  // Guided 5-stage live Auto-Tour (instantly cancellable by any user click or key)
  const btnAutoTour = document.getElementById('btnAutoTour') as HTMLButtonElement
  let tourAbort: AbortController | null = null

  const setBackdropScene = (scene: string) => {
    bench.querySelectorAll('[data-backdrop]').forEach(b => {
      b.classList.toggle('is-active', (b as HTMLElement).dataset.backdrop === scene)
    })
    viewport.dataset.scene = scene
  }

  const stopAutoTour = (manualInterrupt = false) => {
    if (!tourAbort) return
    tourAbort.abort()
    tourAbort = null
    btnAutoTour.classList.remove('tg-btn--recording')
    btnAutoTour.textContent = '▶ Auto-Tour'
    if (manualInterrupt) {
      statusLine.textContent = 'Guided tour paused — interactive controls active.'
    }
  }

  const waitStep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('tour-aborted'))
        return
      }
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = () => {
        clearTimeout(t)
        reject(new Error('tour-aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })

  const runAutoTour = async () => {
    stopAutoTour(false)
    const abort = new AbortController()
    tourAbort = abort
    btnAutoTour.classList.add('tg-btn--recording')
    btnAutoTour.textContent = '⏹ Stop Tour'

    try {
      // Stage 1: Explore & Lens Backdrop
      statusLine.textContent = 'Tour 1/5 · Multi-Venue Gift Catalog & Waveguide Lens Backdrops…'
      bindings.closeOverlays()
      setBackdropScene('dark')
      bindings.runVoicePhrase('open Plush Pepe')
      await waitStep(1_200, abort.signal)
      bindings.sim.swipe(1)
      setBackdropScene('meetup')
      await waitStep(2_200, abort.signal)
      setBackdropScene('dark')
      bindings.sim.swipe(-1)
      await waitStep(1_200, abort.signal)

      // Stage 2: 5-Venue Spread Bar Chart
      statusLine.textContent = 'Tour 2/5 · 256×144 5-Venue Spread Bar Chart (Portals, Tonnel, MRKT, Fragment, Getgems)…'
      bindings.runVoicePhrase('show venue spread for Plush Pepe')
      await waitStep(3_600, abort.signal)

      // Stage 3: Gifti AI Cross-Venue Arbitrage
      statusLine.textContent = 'Tour 3/5 · Gifti AI Copilot — Cross-Venue Net-of-Fee Arbitrage Scan…'
      await bindings.askGiftiText('What is the best net arbitrage spread across venues right now?')
      await waitStep(3_800, abort.signal)

      // Stage 4: Net-of-Fee Arbitrage, Whale Health & Rare Permille Tiers
      statusLine.textContent = 'Tour 4/5 · Collector Copilot — Net-of-Fee Arbitrage, Whale Health & Rare ‰ Tiers…'
      bindings.openResearch()
      await waitStep(3_800, abort.signal)

      // Stage 5: Live /ask SSE Interrupt -> IMU Head Nod -> 1-Tap Smart Reply
      statusLine.textContent = 'Tour 5/5 · Live Telegram /ask Interrupt → Power-Gated IMU Head-Nod → 1-Tap Smart Reply…'
      bindings.closeOverlays()
      bindings.triggerLiveAsk()
      await waitStep(2_800, abort.signal)
      bindings.sim.nod()
      await waitStep(2_400, abort.signal)
      bindings.sim.tap()
      await waitStep(2_200, abort.signal)
      bindings.closeOverlays()

      if (tourAbort === abort) {
        tourAbort = null
        btnAutoTour.classList.remove('tg-btn--recording')
        btnAutoTour.textContent = '▶ Auto-Tour'
        statusLine.textContent = 'Guided tour complete — click 🎤 Speak G2 Command or any control to test live!'
      }
    } catch {
      // Aborted cleanly by user interaction or studio teardown
    }
  }

  btnAutoTour.onclick = ev => {
    ev.stopPropagation()
    if (tourAbort) stopAutoTour(true)
    else void runAutoTour()
  }

  const onAnyManualPointerDown = (ev: PointerEvent) => {
    if (!tourAbort) return
    const target = ev.target as HTMLElement | null
    if (target?.closest('#btnAutoTour')) return
    stopAutoTour(true)
  }
  window.addEventListener('pointerdown', onAnyManualPointerDown, true)

  // Keyboard shortcuts (ignored when typing inside an input/textarea)
  const onKeyDown = (ev: KeyboardEvent) => {
    if (tourAbort) stopAutoTour(true)
    const tag = (ev.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      bindings.sim.swipe(-1)
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      bindings.sim.swipe(1)
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      bindings.sim.tap()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      bindings.sim.doubleTap()
    } else if (ev.code === 'Space' && !ev.repeat) {
      ev.preventDefault()
      startRing()
    }
  }
  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.code === 'Space') endRing()
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  syncMenuAndStatus()
  syncGiftiUi()

  return () => {
    stopAutoTour(false)
    clearInterval(pollTimer)
    clearTimeout(irlRoleTimer)
    if (cachedUrl) {
      URL.revokeObjectURL(cachedUrl)
      cachedUrl = null
    }
    unsubMirror?.()
    unsubGifti()
    unsubVoice()
    window.removeEventListener('pointerdown', onAnyManualPointerDown, true)
    window.removeEventListener('pointerup', endRing)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    bench.innerHTML = ''
  }
}
