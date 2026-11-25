import {
  AudioInputSource,
  AudioSpeakerRole,
  EvenAppBridge,
  evenHubEventFromJson,
  EventSourceType,
  OsEventTypeList,
  validateEvenHubPageContainer,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type ImageRawDataUpdate,
  type LaunchSource,
  type RebuildPageContainer,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

export interface BrowserSimulatorControls {
  isSimulated: boolean
  tap(): void
  doubleTap(): void
  swipe(direction: -1 | 1): void
  holdStart(source?: 'GLASSES_R' | 'RING'): void
  holdEnd(source?: 'GLASSES_R' | 'RING'): void
  nod(): void
  shake(): void
  emitLaunchSource(source: LaunchSource): void
  emitAudioPcm(pcm: Uint8Array, speakerRole?: 'wearer' | 'other'): void
  setSpeakerRole(role: 'wearer' | 'other'): void
  getSpeakerRole(): 'wearer' | 'other'
  getMicLevel(): number
  consumeLastBrowserSpeechTranscript(): string | null
  isImuEnabled(): boolean
  isMicEnabled(): boolean
  menuSelect(label: string): void
  setWearing(wearing: boolean): void
  setBattery(level: number, isCharging?: boolean): void
  getActiveMenu(): readonly { itemID: number; itemName: string }[]
  restoreNativeHostBridge(): void
}

declare global {
  interface Window {
    flutter_inappwebview?: unknown
    EvenAppBridge?: unknown
    SpeechRecognition?: new () => BrowserSpeechRecognitionLike
    webkitSpeechRecognition?: new () => BrowserSpeechRecognitionLike
  }
}

interface BrowserSpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript?: string }>> }) => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

export function hasHostEvenBridge(): boolean {
  if (typeof window === 'undefined') return false
  if ('flutter_inappwebview' in window) return true
  const existing = window.EvenAppBridge
  return Boolean(existing && !(existing instanceof EvenAppBridge))
}

function downsampleFloat32ToPcm16(input: Float32Array, inputSampleRate: number, targetRate = 16_000): Uint8Array {
  if (!input.length || inputSampleRate <= 0) return new Uint8Array(0)
  const ratio = inputSampleRate / targetRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Uint8Array(outLength * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.ceil((i + 1) * ratio))
    let sum = 0
    let count = 0
    for (let j = start; j < end; j++) {
      sum += input[j]!
      count++
    }
    const sample = count > 0 ? sum / count : input[Math.min(start, input.length - 1)]!
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(i * 2, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true)
  }
  return out
}

export function installBrowserSimulatorIfStandalone(): BrowserSimulatorControls | undefined {
  if (typeof window === 'undefined' || hasHostEvenBridge()) {
    return undefined
  }

  const savedSdkBridge = window.EvenAppBridge
  let currentPage: CreateStartUpPageContainer | RebuildPageContainer | null = null
  let created = false
  let disposed = false
  let imuEnabled = false
  let micEnabled = false
  let activeSpeakerRole: 'wearer' | 'other' = 'wearer'
  let micLevel = 0
  let lastBrowserTranscript: string | null = null
  let activeWebMicCleanup: (() => void) | null = null
  let micOpenGeneration = 0

  const hostStorage = new Map<string, string>()
  const eventListeners = new Set<(event: EvenHubEvent) => void>()
  const deviceListeners = new Set<(status: Record<string, unknown>) => void>()
  const launchListeners = new Set<(source: LaunchSource) => void>()
  let deviceStatus = {
    sn: 'ER-G2-SIM-01',
    connectType: 'connected',
    isWearing: true,
    batteryLevel: 92,
    isCharging: false,
    isInCase: false,
  }

  const emitEvent = (event: EvenHubEvent) => {
    for (const listener of [...eventListeners]) listener(event)
  }

  const emitDevice = () => {
    for (const listener of [...deviceListeners]) listener({ ...deviceStatus })
  }

  const emitAudioPcm = (pcm: Uint8Array, speakerRole: 'wearer' | 'other' = activeSpeakerRole) => {
    emitEvent({
      audioEvent: {
        audioPcm: pcm,
        source: AudioInputSource.Glasses,
        speakerRole: speakerRole === 'other' ? AudioSpeakerRole.Other : AudioSpeakerRole.Self,
      },
    } as unknown as EvenHubEvent)
  }

  const stopRealBrowserMic = () => {
    micOpenGeneration++
    micLevel = 0
    if (activeWebMicCleanup) {
      const fn = activeWebMicCleanup
      activeWebMicCleanup = null
      fn()
    }
  }

  const startRealBrowserMicIfAvailable = async (): Promise<{ opened: boolean; gen: number }> => {
    stopRealBrowserMic()
    const gen = ++micOpenGeneration
    lastBrowserTranscript = null

    if (
      typeof navigator === 'undefined'
      || typeof navigator.mediaDevices?.getUserMedia !== 'function'
      || typeof AudioContext === 'undefined'
    ) {
      // Synthetic Node.js test environment without browser getUserMedia
      return { opened: true, gen }
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch {
      return { opened: false, gen }
    }

    if (disposed || !micEnabled || gen !== micOpenGeneration) {
      for (const track of stream.getTracks()) track.stop()
      return { opened: false, gen }
    }

    let audioCtx: AudioContext | null = null
    try {
      audioCtx = new AudioContext()
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => {})
      }
      const sourceNode = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(2048, 1, 1)
      const muteGain = audioCtx.createGain()
      muteGain.gain.value = 0

      let speechRec: BrowserSpeechRecognitionLike | null = null
      const SpeechCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
      if (SpeechCtor) {
        try {
          speechRec = new SpeechCtor()
          speechRec.continuous = true
          speechRec.interimResults = true
          speechRec.lang = 'en-US'
          speechRec.onresult = ev => {
            if (!micEnabled || gen !== micOpenGeneration) return
            const parts: string[] = []
            for (let i = 0; i < ev.results.length; i++) {
              const alt = ev.results[i]?.[0]
              if (alt?.transcript) parts.push(alt.transcript)
            }
            const joined = parts.join(' ').trim()
            if (joined) lastBrowserTranscript = joined
          }
          speechRec.onerror = () => {}
          speechRec.start()
        } catch {
          speechRec = null
        }
      }

      const activeCtx = audioCtx
      processor.onaudioprocess = ev => {
        if (!micEnabled || gen !== micOpenGeneration) return
        const chan = ev.inputBuffer.getChannelData(0)
        let sumSq = 0
        for (let i = 0; i < chan.length; i++) sumSq += chan[i]! * chan[i]!
        const rms = Math.sqrt(sumSq / Math.max(1, chan.length))
        micLevel = Math.min(1, rms * 5.5)

        const pcm = downsampleFloat32ToPcm16(chan, activeCtx.sampleRate, 16_000)
        if (pcm.byteLength > 0) {
          emitAudioPcm(pcm, activeSpeakerRole)
        }
      }

      sourceNode.connect(processor)
      processor.connect(muteGain)
      muteGain.connect(activeCtx.destination)

      activeWebMicCleanup = () => {
        if (speechRec) {
          speechRec.onresult = null
          speechRec.onerror = null
          try {
            speechRec.abort()
          } catch {}
        }
        try {
          processor.disconnect()
          sourceNode.disconnect()
          muteGain.disconnect()
        } catch {}
        for (const track of stream.getTracks()) {
          try {
            track.stop()
          } catch {}
        }
        void activeCtx.close().catch(() => {})
      }

      return { opened: true, gen }
    } catch {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {}
      }
      if (audioCtx) void audioCtx.close().catch(() => {})
      return { opened: false, gen }
    }
  }

  const bridge = {
    ready: true,
    async createStartUpPageContainer(page: CreateStartUpPageContainer) {
      if (disposed || created) return 1
      const check = validateEvenHubPageContainer(page)
      if (!check.valid) return 1
      created = true
      currentPage = page
      return 0
    },
    async rebuildPageContainer(page: RebuildPageContainer) {
      if (disposed) return false
      const check = validateEvenHubPageContainer(page)
      if (!check.valid) return false
      currentPage = page
      return true
    },
    async textContainerUpgrade(upgrade: TextContainerUpgrade) {
      if (!currentPage?.textObject) return false
      const target = currentPage.textObject.find(
        item => item.containerID === upgrade.containerID && item.containerName === upgrade.containerName,
      )
      if (!target) return false
      target.content = upgrade.content ?? ''
      if (upgrade.textColor !== undefined) target.textColor = upgrade.textColor
      return true
    },
    async updateImageRawData(update: ImageRawDataUpdate) {
      const target = currentPage?.imageObject?.find(
        item => item.containerID === update.containerID && update.containerName === item.containerName,
      )
      if (!target) return 'invalidImageContainer'
      return 'success'
    },
    async shutDownPageContainer() {
      stopRealBrowserMic()
      micEnabled = false
      currentPage = null
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: { Event_Type: 'SYSTEM_EXIT_EVENT' },
        }),
      )
      return true
    },
    async audioControl(isOpen?: boolean) {
      if (disposed) return false
      const next = Boolean(isOpen)
      if (!next) {
        micEnabled = false
        stopRealBrowserMic()
        return true
      }
      micEnabled = true
      const { opened, gen } = await startRealBrowserMicIfAvailable()
      if (!opened) {
        if (gen === micOpenGeneration) micEnabled = false
        return false
      }
      return true
    },
    async imuControl(isOpen: boolean) {
      imuEnabled = Boolean(isOpen)
      return true
    },
    async setLocalStorage(key: string, value: string) {
      hostStorage.set(String(key), String(value))
      return true
    },
    async getLocalStorage(key: string) {
      return hostStorage.get(String(key)) ?? ''
    },
    onLaunchSource(listener: (source: LaunchSource) => void) {
      launchListeners.add(listener)
      return () => {
        launchListeners.delete(listener)
      }
    },
    onEvenHubEvent(listener: (event: EvenHubEvent) => void) {
      eventListeners.add(listener)
      if (disposed) {
        queueMicrotask(() => {
          listener(
            evenHubEventFromJson({
              type: 'sys_event',
              jsonData: { Event_Type: 'SYSTEM_EXIT_EVENT' },
            }),
          )
        })
      }
      return () => {
        eventListeners.delete(listener)
      }
    },
    onDeviceStatusChanged(listener: (status: Record<string, unknown>) => void) {
      deviceListeners.add(listener)
      queueMicrotask(emitDevice)
      return () => {
        deviceListeners.delete(listener)
      }
    },
  }

  Object.defineProperty(window, 'EvenAppBridge', {
    value: bridge,
    configurable: true,
    writable: true,
  })

  const captureTarget = () => currentPage?.textObject?.find(t => t.isEventCapture === 1) ?? currentPage?.textObject?.[0]
  const mapSource = (source: 'GLASSES_R' | 'RING' = 'GLASSES_R') =>
    source === 'RING' ? EventSourceType.TOUCH_EVENT_FROM_RING : EventSourceType.TOUCH_EVENT_FROM_GLASSES_R

  return {
    isSimulated: true,
    tap() {
      const target = captureTarget()
      if (!target) return
      emitEvent(
        evenHubEventFromJson({
          type: 'text_event',
          jsonData: {
            Container_ID: target.containerID,
            Container_Name: target.containerName,
          },
        }),
      )
    },
    doubleTap() {
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: {
            Event_Type: OsEventTypeList.DOUBLE_CLICK_EVENT,
            Event_Source: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
          },
        }),
      )
    },
    swipe(direction) {
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: {
            Event_Type: direction < 0 ? OsEventTypeList.SCROLL_TOP_EVENT : OsEventTypeList.SCROLL_BOTTOM_EVENT,
            Event_Source: EventSourceType.TOUCH_EVENT_FROM_GLASSES_R,
          },
        }),
      )
    },
    holdStart(source = 'GLASSES_R') {
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: {
            Event_Type: OsEventTypeList.LONG_PRESS_EVENT,
            Event_Source: mapSource(source),
          },
        }),
      )
    },
    holdEnd(source = 'GLASSES_R') {
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: {
            Event_Type: OsEventTypeList.LONG_PRESS_RELEASE_EVENT,
            Event_Source: mapSource(source),
          },
        }),
      )
    },
    nod() {
      for (const sample of [
        { x: 0, y: 0, z: 0 },
        { x: 0.2, y: 6.4, z: 0.1 },
        { x: 0.1, y: -5.2, z: 0.1 },
      ]) {
        emitEvent(
          evenHubEventFromJson({
            type: 'sys_event',
            jsonData: {
              Event_Type: OsEventTypeList.IMU_DATA_REPORT,
              IMU_Data: sample,
            },
          }),
        )
      }
    },
    shake() {
      for (const sample of [
        { x: 0, y: 0, z: 0 },
        { x: 0.1, y: 0.2, z: 6.2 },
        { x: 0.1, y: 0.1, z: -6.0 },
      ]) {
        emitEvent(
          evenHubEventFromJson({
            type: 'sys_event',
            jsonData: {
              Event_Type: OsEventTypeList.IMU_DATA_REPORT,
              IMU_Data: sample,
            },
          }),
        )
      }
    },
    emitLaunchSource(source: LaunchSource) {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('evenAppLaunchSource', { detail: { launchSource: source } }))
      }
      for (const listener of [...launchListeners]) listener(source)
    },
    emitAudioPcm,
    setSpeakerRole(role: 'wearer' | 'other') {
      activeSpeakerRole = role
    },
    getSpeakerRole() {
      return activeSpeakerRole
    },
    getMicLevel() {
      return micEnabled ? micLevel : 0
    },
    consumeLastBrowserSpeechTranscript() {
      const t = lastBrowserTranscript
      lastBrowserTranscript = null
      return t
    },
    isImuEnabled() {
      return imuEnabled
    },
    isMicEnabled() {
      return micEnabled
    },
    menuSelect(label) {
      const item = currentPage?.menuObject?.menuItems?.find(m => m.itemName === label)
      if (!item || item.itemID === undefined) return
      emitEvent(evenHubEventFromJson({ type: 'sys_event', jsonData: { Event_Type: OsEventTypeList.FOREGROUND_ENTER_EVENT } }))
      emitEvent(evenHubEventFromJson({ type: 'menuItemClickEvent', jsonData: { itemID: item.itemID } }))
      emitEvent(evenHubEventFromJson({ type: 'sys_event', jsonData: { Event_Type: OsEventTypeList.FOREGROUND_EXIT_EVENT } }))
    },
    setWearing(isWearing) {
      deviceStatus = { ...deviceStatus, isWearing }
      emitDevice()
    },
    setBattery(batteryLevel, isCharging = deviceStatus.isCharging) {
      deviceStatus = { ...deviceStatus, batteryLevel, isCharging }
      emitDevice()
    },
    getActiveMenu() {
      return (currentPage?.menuObject?.menuItems ?? []).map(m => ({
        itemID: m.itemID ?? 0,
        itemName: m.itemName ?? '',
      }))
    },
    restoreNativeHostBridge() {
      disposed = true
      stopRealBrowserMic()
      micEnabled = false
      imuEnabled = false
      currentPage = null
      emitEvent(
        evenHubEventFromJson({
          type: 'sys_event',
          jsonData: { Event_Type: 'SYSTEM_EXIT_EVENT' },
        }),
      )
      if (window.EvenAppBridge === bridge) {
        Object.defineProperty(window, 'EvenAppBridge', {
          value: savedSdkBridge ?? EvenAppBridge.getInstance(),
          configurable: true,
          writable: true,
        })
      }
    },
  }
}
