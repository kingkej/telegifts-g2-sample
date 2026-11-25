import type { CompanionToolName, CompanionToolPage, CompanionToolSource } from './contracts/tools.ts'
import type { CompanionVoiceControl, CompanionVoiceState, VoiceProblem } from './contracts/companion.ts'
import type { VoiceResolution } from './voiceCommands.ts'
import { acPower } from './voiceRecognitionAudio.ts'

// Even supplies 16 kHz, mono, signed 16-bit little-endian PCM.
const sampleRate = 16_000
const commandSeconds = 8
const questionSeconds = 25
const packetSlackMs = 300
const commandWaitMs = 2_000

export class Utterance {
  private readonly maxSamples: number
  private chunks: Uint8Array[] = []
  samples = 0
  voiced = 0
  quiet = 0

  constructor(seconds: number) {
    this.maxSamples = seconds * sampleRate
  }

  append(pcm: Uint8Array) {
    const count = Math.min(Math.floor(pcm.byteLength / 2), this.maxSamples - this.samples)
    if (!count) return
    const bytes = new Uint8Array(pcm.subarray(0, count * 2))
    this.chunks.push(bytes)
    this.samples += count
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset < count; offset += 320) {
      const end = Math.min(count, offset + 320)
      if (acPower(view, offset, end) > (0.008 * 32768) ** 2) {
        this.voiced += end - offset
        this.quiet = 0
      } else this.quiet += end - offset
    }
  }

  get hasSpeech() {
    return this.voiced >= sampleRate * 0.15
  }
  get complete() {
    return this.samples >= this.maxSamples || (this.hasSpeech && this.quiet >= sampleRate * 0.9)
  }

  take(): Uint8Array<ArrayBuffer> {
    const result = new Uint8Array(this.samples * 2)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.chunks = []
    return result
  }
}

interface VoiceInput {
  microphone(enabled: boolean): Promise<boolean>
  context(): string
  available(): boolean
  toolPage?(): CompanionToolPage | null
  activeTool?(): CompanionToolName | undefined
  displayedChart?(): Uint8Array | undefined
}

interface Session {
  input: VoiceInput
  origin: string
  source: CompanionToolSource
  displayedChart?: Uint8Array
  abort: AbortController
  utterance: Utterance | null
  openingFence?: Promise<boolean>
  openPending?: boolean
  micRevision?: number
  listeningSince?: number
  disabled?: Promise<boolean>
  result?: VoiceResolution
  question?: {
    page: CompanionToolPage
    signal: AbortSignal
    resolve(pcm: Uint8Array<ArrayBuffer>): void
    reject(reason: Error): void
  }
}

interface Commands {
  /** Monotonic milliseconds, measured on the host receiving the PCM. */
  now?(): number
  names(): readonly string[]
  resolve(text: string, displayedChart?: Uint8Array, source?: CompanionToolSource): VoiceResolution
  transcribe(pcm: Uint8Array<ArrayBuffer>, names: readonly string[], signal: AbortSignal): Promise<string | null>
}

export function createVoiceControl({ names, resolve, transcribe, now = () => performance.now() }: Commands) {
  const idle = { phase: 'idle' } as const
  let state: CompanionVoiceState = { phase: 'offline' }
  let revision = 0
  let bound: VoiceInput | null = null
  let current: Session | null = null
  let acceptedAction: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  // Native commands can take effect after a timeout or after another command.
  // Keep the desired hardware owner independent of the current UI session.
  let micOwner: Session | null = null
  let stopInput: VoiceInput | null = null
  let stopRevision = 0
  let stopping: Promise<boolean> | null = null
  let releaseInFlight: Promise<boolean> | null = null
  let pendingOpens = 0
  let microphoneRequested = false
  const fences = new Set<Promise<boolean>>()
  let pendingCloses = 0
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()

  function publish(next: CompanionVoiceState) {
    state = next
    revision++
    for (const notify of listeners) notify()
  }

  function setDeadline(ms: number, fire: () => void) {
    clearTimeout(timer)
    timer = setTimeout(fire, ms)
  }

  async function setMic(input: VoiceInput, enabled: boolean) {
    try {
      return await input.microphone(enabled)
    } catch {
      return false
    }
  }

  function fence(raw: Promise<boolean>) {
    const bounded = new Promise<boolean>(res => {
      const deadline = setTimeout(() => res(false), commandWaitMs)
      void raw.then(ok => {
        clearTimeout(deadline)
        res(ok)
      })
    })
    fences.add(bounded)
    void bounded.then(() => fences.delete(bounded))
    return bounded
  }

  function needStop(input: VoiceInput) {
    stopRevision++
    stopInput = input
    stopping = null
  }

  function interruptNewerRecording(version: number) {
    if (current?.micRevision !== undefined && current.micRevision > version && !current.abort.signal.aborted) {
      problem(current, 'microphone')
    }
  }

  function closeMic(input: VoiceInput) {
    const version = stopRevision
    pendingCloses++
    return fence(
      setMic(input, false).then(ok => {
        pendingCloses--
        if (ok) interruptNewerRecording(version)
        if (ok && version === stopRevision && !pendingOpens) {
          stopInput = null
          watchPendingStop()
        }
        return ok
      }),
    )
  }

  function ensureStopped(input = stopInput): Promise<boolean> {
    if (micOwner) return Promise.resolve(false)
    if (stopping) return stopping
    if (!input) return Promise.resolve(true)
    stopInput = input
    const version = stopRevision
    const stop = async () => {
      let ok = await closeMic(input)
      if (!ok && version === stopRevision && stopInput) ok = await closeMic(input)
      if (version !== stopRevision) return false
      stopping = null
      return ok || !stopInput
    }
    stopping = stop()
    watchPendingStop()
    return stopping
  }

  function watchPendingStop() {
    if (micOwner || !stopInput) {
      clearTimeout(watchdog)
      watchdog = undefined
    } else if (watchdog === undefined) {
      watchdog = setTimeout(() => {
        watchdog = undefined
        void ensureStopped()
        watchPendingStop()
      }, commandWaitMs)
    }
  }

  function release(session: Session) {
    if (session.disabled) return session.disabled
    if (micOwner !== session) return Promise.resolve(true)
    micOwner = null
    needStop(session.input)
    const immediate = ensureStopped()
    const closed =
      session.openPending && session.openingFence
        ? session.openingFence.then(() => (session.openPending ? false : ensureStopped()))
        : immediate
    session.disabled = closed.then(ok => {
      if (releaseInFlight === session.disabled) releaseInFlight = null
      if (!ok && !session.question && stopInput && bound === session.input && (!current || current === session)) {
        publish({ phase: 'error', reason: 'micStop' })
      }
      return ok
    })
    releaseInFlight = session.disabled
    return session.disabled
  }

  function discard(reason?: Error) {
    clearTimeout(timer)
    const old = current
    current = null
    if (old) {
      old.abort.abort()
      old.utterance = null
      void release(old)
      old.question?.reject(reason ?? new DOMException('Question recording canceled.', 'AbortError'))
    }
  }

  function stopAcceptedAction() {
    acceptedAction?.abort()
    acceptedAction = null
  }

  function dismiss(reason?: Error) {
    if (!micOwner && stopInput && !stopping) void ensureStopped(bound ?? stopInput)
    if (!current && (state.phase === 'idle' || state.phase === 'offline')) return
    discard(reason)
    publish({ phase: bound ? 'idle' : 'offline' })
  }

  function cancel() {
    stopAcceptedAction()
    dismiss()
  }

  function ownsQuestion(input: VoiceInput, page: CompanionToolPage) {
    return input.activeTool?.() === 'gifti' && input.toolPage?.() === page
  }

  function sameContext(session: Session) {
    return (
      bound === session.input
      && bound.available()
      && session.origin === bound.context()
      && (session.question ? ownsQuestion(bound, session.question.page) : bound.activeTool?.() !== 'gifti')
    )
  }

  function matches(session: Session) {
    if (current !== session || session.abort.signal.aborted) return false
    if (!sameContext(session)) {
      cancel()
      return false
    }
    return true
  }

  function problem(session: Session, reason: VoiceProblem) {
    if (current !== session) return
    if (session.question) {
      const message =
        reason === 'silence'
          ? 'No speech heard. Try recording your question again.'
          : reason === 'microphone'
            ? 'Check glasses microphone access in Even and try again.'
            : reason === 'micStop'
              ? 'Glasses microphone did not close. Close TeleGifts in Even if it stays on.'
              : 'Question audio was interrupted. Try recording again.'
      dismiss(new Error(message))
      return
    }
    clearTimeout(timer)
    session.abort.abort()
    session.utterance = null
    void release(session)
    publish({ phase: 'error', reason })
  }

  function apply(session: Session, result: VoiceResolution, confirmed = false) {
    if (!matches(session)) return
    session.result = result
    if (result.kind === 'unknown') {
      problem(session, 'unknown')
      return
    }
    if (result.kind === 'choices') {
      publish({ phase: 'choices', labels: result.labels, index: 0 })
    } else if (result.confirm && !confirmed) {
      publish({ phase: 'confirm', label: result.label })
    } else {
      discard()
      stopAcceptedAction()
      const action = new AbortController()
      acceptedAction = action
      publish({ phase: 'idle' })
      let accepted = false
      try {
        accepted = result.run(action.signal)
      } catch {
        /* Keep the previous screen available for Retry or Back. */
      }
      if (!accepted && !action.signal.aborted && !current && bound) {
        stopAcceptedAction()
        publish({ phase: 'error', reason: 'action' })
      }
    }
  }

  async function finish(session: Session) {
    if (!matches(session) || state.phase !== 'listening' || !session.utterance) return
    if (!session.utterance.hasSpeech) {
      problem(session, 'silence')
      return
    }
    const pcm = session.utterance.take()
    session.utterance = null
    publish({ phase: 'processing' })
    if (!matches(session)) return
    setDeadline(6_000, () => problem(session, 'micStop'))
    try {
      if (!(await release(session))) {
        problem(session, 'micStop')
        return
      }
      if (!matches(session)) return
      if (session.question) {
        clearTimeout(timer)
        current = null
        publish(idle)
        session.question.resolve(pcm)
        return
      }
      setDeadline(25_000, () => problem(session, 'recognition'))
      const text = await transcribe(pcm, names(), session.abort.signal)
      if (!matches(session)) return
      clearTimeout(timer)
      if (!text?.trim()) {
        problem(session, 'unknown')
        return
      }
      apply(session, resolve(text, session.displayedChart, session.source))
    } catch {
      if (matches(session)) problem(session, 'recognition')
    }
  }

  async function enable(session: Session) {
    await Promise.all([...fences])
    if (!matches(session)) return
    if (stopping) await stopping
    if (!matches(session)) return
    if (stopInput || pendingCloses || pendingOpens) {
      if (!(await ensureStopped(session.input))) {
        problem(session, 'micStop')
        return
      }
      if (!matches(session)) return
    }
    micOwner = session
    needStop(session.input)
    const version = stopRevision
    session.micRevision = version
    session.openPending = true
    pendingOpens++
    watchPendingStop()
    const rearming = microphoneRequested
    const opening = Promise.resolve()
      .then(() => {
        if (micOwner !== session || !matches(session)) return false
        microphoneRequested = true
        return setMic(session.input, true)
      })
      .then(ok => {
        session.openPending = false
        pendingOpens--
        if (micOwner !== session) {
          const hadOwner = micOwner !== null
          if (ok) interruptNewerRecording(version)
          if (!hadOwner) {
            needStop(bound ?? session.input)
            void ensureStopped()
          }
        }
        return ok
      })
    session.openingFence = fence(opening)
    const ok = await opening
    if (!matches(session)) return
    if (!ok) {
      problem(session, 'microphone')
      return
    }
    const listen = () => {
      if (!matches(session)) return
      session.listeningSince = now()
      publish({ phase: 'listening' })
      if (matches(session))
        setDeadline((session.question ? questionSeconds : commandSeconds) * 1000, () => void finish(session))
    }
    if (rearming) setDeadline(packetSlackMs, listen)
    else listen()
  }

  function begin(input: VoiceInput, source: CompanionToolSource, question?: Session['question']) {
    discard()
    const session: Session = {
      input,
      source,
      origin: input.context(),
      question,
      displayedChart: question ? undefined : input.displayedChart?.(),
      abort: new AbortController(),
      utterance: new Utterance(question ? questionSeconds : commandSeconds),
    }
    current = session
    publish({ phase: 'starting' })
    if (!matches(session)) return
    setDeadline(6_000, () => problem(session, session.openingFence ? 'microphone' : 'micStop'))
    void enable(session)
  }

  function start(source: CompanionToolSource = 'glasses') {
    if (!bound || !bound.available() || (state.phase !== 'idle' && state.phase !== 'error')) return
    if (bound.activeTool?.() === 'gifti') return
    stopAcceptedAction()
    begin(bound, source)
  }

  async function recordQuestion(signal: AbortSignal) {
    signal.throwIfAborted()
    const input = bound
    const page = input?.toolPage?.()
    if (!input || !input.available() || !page) throw new Error('Open the tool on connected glasses to record a question.')
    if (state.phase !== 'idle' && state.phase !== 'error') throw new Error('Finish the current recording first.')
    if (!ownsQuestion(input, page)) throw new DOMException('Question recording canceled.', 'AbortError')
    const origin = input.context()
    const onAbort = () => {
      if (current?.question?.signal === signal) dismiss()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const pcm = await new Promise<Uint8Array<ArrayBuffer>>((res, rej) =>
        begin(input, 'glasses', { page, signal, resolve: res, reject: rej }),
      )
      signal.throwIfAborted()
      if (bound !== input || !input.available() || input.context() !== origin || !ownsQuestion(input, page)) {
        throw new DOMException('Question recording canceled.', 'AbortError')
      }
      return pcm
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const controls: CompanionVoiceControl = {
    getSnapshot: () => (current?.question ? idle : state),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    cancel,
    recordQuestion,
    activate(source) {
      if (current?.question && source === 'phone') return
      if (state.phase === 'error') {
        start(source)
        return
      }
      if (!current || !matches(current)) return
      if (state.phase === 'listening') void finish(current)
      else if (state.phase === 'confirm' && current.result) apply(current, current.result, true)
      else if (state.phase === 'choices' && current.result?.kind === 'choices')
        apply(current, current.result.choose(state.index))
    },
    step(direction) {
      if (state.phase !== 'choices' || !current || !matches(current)) return
      const index = state.index + direction
      if (index >= 0 && index < state.labels.length) publish({ ...state, index })
    },
  }
  return {
    controls,
    transcribePcm: (pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal) => transcribe(pcm, names(), signal),
    getQuestionSnapshot: () => (current?.question ? state : undefined),
    backFromOverlay: () => (current?.question ? dismiss() : cancel()),
    revision: () => revision,
    bind(input: VoiceInput) {
      stopAcceptedAction()
      bound = input
      discard()
      publish({ phase: 'idle' })
      let detached: Promise<boolean> | undefined
      return () => {
        if (detached) return detached
        if (bound !== input) return Promise.resolve(true)
        bound = null
        stopAcceptedAction()
        discard()
        publish({ phase: 'offline' })
        const stopped = releaseInFlight ?? (stopInput ? ensureStopped(input) : Promise.resolve(true))
        detached = stopped.then(ok => ok && !stopInput)
        return detached
      }
    },
    syncContext() {
      if (current && !sameContext(current)) cancel()
    },
    receive(pcm: Uint8Array) {
      if (state.phase !== 'listening' || !current?.utterance || current.listeningSince === undefined) return
      if (current.question && !matches(current)) return
      const available = ((Math.max(0, now() - current.listeningSince) + packetSlackMs) * sampleRate) / 1000
      if (current.utterance.samples + Math.floor(pcm.byteLength / 2) > available) {
        problem(current, 'unknown')
        return
      }
      current.utterance.append(pcm)
      if (current.utterance.complete) void finish(current)
    },
  }
}

export type GlassesVoice = ReturnType<typeof createVoiceControl>
