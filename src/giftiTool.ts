import type { CompanionToolController, CompanionToolPage } from './contracts/tools.ts'

export interface GiftiChatMessage {
  id: string
  role: 'user' | 'assistant'
  delivery: 'sent' | 'failed' | 'pending'
  deliveryUncertain?: boolean
  chatID?: string
  text?: string
}

export interface GiftiChatSnapshot {
  accessState: {
    type: 'available' | 'idle' | 'loading' | 'botAuthRequired' | 'subscriptionRequired' | 'unavailable'
  }
  currentConversationID: string | null
  visibleMessages: readonly GiftiChatMessage[]
  currentInputText: string
  isSending?: boolean
  canSend?: boolean
  selection?: { type: 'draft' | 'thread' }
  selectedThread?: unknown
  selectedConversationTitle?: string
}

export interface GiftiChatStore {
  prepare(api: unknown): Promise<void>
  subscribe(listener: () => void): () => void
  getSnapshot(): GiftiChatSnapshot
  canSendSuggestedQuestion(): boolean
  startNewDraft?(): void
  setCurrentInputText(text: string): void
  sendCurrentMessage(
    api: unknown,
    onIds: (messageID: string, replyID: string) => void,
    context?: unknown,
  ): Promise<void>
}

export interface GiftiConnection {
  store: GiftiChatStore
  api: unknown
  openPhone(): void
  openChart?(name: string): boolean
  voice?: {
    record(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
    transcribe(pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string>
    speak(text: string, signal: AbortSignal, onPhoneTapRequired: (required: boolean) => void): Promise<boolean>
  }
}

const openPhone = { id: 'phone', label: 'Open chat on phone' }
const read = { id: 'read', label: 'Read latest reply' }
const send = { id: 'send', label: 'Send question', requiresConfirmation: true }
const talk = { id: 'talk', label: 'Talk to Gifti' }
const startTalking = { id: 'start-talking', label: 'Start talking', requiresConfirmation: true }
const back = { id: 'back', label: 'Back' }
const followUp = { id: 'follow-up', label: 'Ask a follow-up', requiresConfirmation: true }
const end = { id: 'end', label: 'End conversation' }
const showChart = { id: 'show-chart', label: 'Show chart', requiresConfirmation: true }
const voiceActions = [end, openPhone]
const noSpeech = 'No speech detected. Try again.'
const playbackHint = 'Play reply on phone'

function plainAnswer(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function lensAnswer(plain: string) {
  const letters = Array.from(plain)
  if (letters.length <= 340) return plain
  const excerpt = letters.slice(0, 339).join('')
  return excerpt.slice(0, excerpt.lastIndexOf(' ') > 260 ? excerpt.lastIndexOf(' ') : excerpt.length) + '…'
}

type Session = {
  chat: string
  controller: AbortController
  phase: 'recording' | 'transcribing' | 'sending' | 'speaking' | 'manual'
  lastAnswer?: { id: string; excerpt: string }
}

type Turn = { chat: string; stagingText?: string; messageID?: string; replyID?: string }

export function createGiftiTool({
  store,
  api,
  openPhone: navigate,
  openChart,
  voice,
}: GiftiConnection): CompanionToolController {
  const listeners = new Set<() => void>()
  let page: CompanionToolPage = {
    key: 'gifti-loading',
    title: 'Ask Gifti',
    lines: ['Opening chat…'],
    actions: [openPhone],
  }
  let stop: (() => void) | undefined
  let prepared = false
  let foreground = true
  let question = ''
  let collection: string | undefined
  let chartReplyID: string | undefined
  let latestReplyID: string | undefined
  let reading: { id: string; chartUnavailable?: boolean } | undefined
  let turn: Turn | undefined
  let session: Session | undefined
  let consent: { chat: string | null } | undefined
  let audioBusy = false

  function show(key: string, lines: string[], actions: CompanionToolPage['actions'] = [openPhone]) {
    if (page.key === key) return
    page = { key, title: 'Ask Gifti', lines, actions }
    for (const listener of listeners) listener()
  }

  function stopVoice() {
    consent = undefined
    const active = session
    if (!active) return
    session = undefined
    turn = undefined
    active.controller.abort()
  }

  function answerActions(replyID: string | undefined, actions: CompanionToolPage['actions']) {
    return replyID && replyID === chartReplyID ? [showChart, ...actions] : actions
  }

  function withLastAnswer(active: Session, status: string) {
    return active.lastAnswer ? [active.lastAnswer.excerpt, status] : [status]
  }

  function manual(active: Session, reason: string) {
    if (session !== active) return
    if (active.phase === 'sending') active.lastAnswer = undefined
    active.phase = 'manual'
    turn = undefined
    show('gifti-manual-' + reason, withLastAnswer(active, reason), [
      followUp,
      ...answerActions(active.lastAnswer?.id, voiceActions),
    ])
  }

  async function record(active: Session) {
    if (!voice || session !== active || audioBusy || !foreground || !store.canSendSuggestedQuestion()) return
    active.phase = 'recording'
    turn = undefined
    show(
      'gifti-recording',
      withLastAnswer(active, 'Listening for your question.'),
      answerActions(active.lastAnswer?.id, voiceActions),
    )
    if (session !== active) return
    const signal = active.controller.signal
    let pcm: Uint8Array<ArrayBuffer>
    audioBusy = true
    try {
      pcm = await voice.record(signal)
    } catch (error) {
      if (session !== active) return
      const name = error && typeof error === 'object' && 'name' in error ? error.name : ''
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
      if (name === 'AbortError') {
        stopVoice()
        update()
      } else if (name === 'NoSpeechError' || message.startsWith('No speech heard')) {
        manual(active, noSpeech)
      } else if (message.startsWith('Glasses microphone did not close')) {
        active.phase = 'manual'
        show('gifti-mic-stop', ['Microphone did not close. Close TeleGifts in Even if it stays on.'], voiceActions)
      } else {
        manual(active, 'Couldn’t record. Check microphone access in Even, then try again.')
      }
      return
    } finally {
      audioBusy = false
      if (session !== active) update()
    }
    if (session !== active) return
    if (!pcm.some(byte => byte !== 0)) {
      manual(active, noSpeech)
      return
    }
    active.phase = 'transcribing'
    show(
      'gifti-transcribing',
      withLastAnswer(active, 'Transcribing your question…'),
      answerActions(active.lastAnswer?.id, voiceActions),
    )
    if (session !== active) return
    let text: string
    try {
      text = (await voice.transcribe(pcm, signal)).trim()
    } catch (error) {
      if (session !== active) return
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
      if (status === 403 || status === 401) {
        stopVoice()
        show('gifti-transcription-access', ['Transcription access was denied. Check Gifti access on your phone.'])
      } else if (status === 422) {
        manual(active, noSpeech)
      } else {
        manual(
          active,
          status === 429
            ? 'Too many transcription requests. Wait before trying again.'
            : status === 503
              ? 'Transcription is temporarily unavailable. Try again later.'
              : 'Transcription failed. Try asking again.',
        )
      }
      return
    }
    if (session !== active) return
    if (!text) {
      manual(active, noSpeech)
      return
    }
    submit(text, active)
  }

  async function play(active: Session, answer: string, replyID: string) {
    if (!voice || session !== active || active.phase !== 'sending') return
    active.phase = 'speaking'
    const excerpt = lensAnswer(answer)
    active.lastAnswer = { id: replyID, excerpt }
    function showPlayback(needsTap: boolean) {
      if (session !== active || active.phase !== 'speaking' || active.lastAnswer?.id !== replyID) return
      show(
        'gifti-speaking-' + replyID + (needsTap ? '-phone' : ''),
        needsTap ? [excerpt, playbackHint] : [excerpt],
        answerActions(replyID, voiceActions),
      )
    }
    showPlayback(false)
    if (session !== active) return
    let played = false
    audioBusy = true
    try {
      played = await voice.speak(answer, active.controller.signal, showPlayback)
    } catch {
      // Keep the answer readable and let the wearer start the next recording.
    } finally {
      audioBusy = false
      if (session !== active) update()
    }
    if (session !== active) return
    if (played) void record(active)
    else manual(active, 'Playback unavailable. Start a follow-up when you’re ready.')
  }

  function offerTalk(chat: string | null) {
    consent = { chat }
    show(
      'gifti-opt-in',
      [
        'Voice assistant transcribes your questions.',
        'Hear replies on your phone or earbuds.',
        'The mic reopens after each spoken reply.',
      ],
      [startTalking, back],
    )
  }

  function update(directTalk = false) {
    if (!stop || !prepared) return
    const chat = store.getSnapshot()
    if (chat.accessState.type !== 'available') {
      stopVoice()
      chartReplyID = undefined
      reading = undefined
      const message = {
        idle: 'Checking chat access…',
        loading: 'Checking chat access…',
        botAuthRequired: 'Connect your Telegram account in Gifti on the phone.',
        subscriptionRequired: 'Gifti requires a subscription. Open chat on the phone for details.',
        unavailable: 'Gifti is unavailable. Open chat on the phone to check access.',
      }[chat.accessState.type]
      show('gifti-access-' + chat.accessState.type, [message])
      return
    }
    if (consent) {
      if (consent.chat === chat.currentConversationID && foreground && store.canSendSuggestedQuestion()) return
      consent = undefined
    }
    if (session) {
      const composerTaken =
        session.phase === 'sending'
          ? !!chat.currentInputText && chat.currentInputText !== turn?.stagingText
          : !store.canSendSuggestedQuestion()
      if (!foreground || chat.currentConversationID !== session.chat || composerTaken) stopVoice()
      else if (session.phase !== 'sending') return
    }
    if (reading) {
      const message = chat.visibleMessages.find(m => m.id === reading?.id && m.role === 'assistant')
      if (message) {
        const lines = [lensAnswer(plainAnswer(message.text ?? ''))]
        if (reading.chartUnavailable) lines.push('Chart unavailable for this gift.')
        show(
          'gifti-read-' + message.id + (reading.chartUnavailable ? '-chart-unavailable' : ''),
          lines,
          answerActions(message.id, [openPhone]),
        )
        return
      }
      reading = undefined
    }
    const active = turn
    if (active) {
      if (chat.currentConversationID !== active.chat) {
        show('gifti-switched', ['The selected conversation changed on the phone.'])
        return
      }
      const user = chat.visibleMessages.find(
        m => m.id === active.messageID && m.role === 'user' && m.chatID === active.chat,
      )
      const reply = chat.visibleMessages.find(
        m => m.id === active.replyID && m.role === 'assistant' && m.chatID === active.chat && m.delivery === 'sent',
      )
      if (user?.delivery === 'failed') {
        if (user.deliveryUncertain) {
          if (session) {
            session.lastAnswer = undefined
            session.phase = 'manual'
          }
          show(
            'gifti-unconfirmed-' + user.id,
            ['Gifti may have received your question. Check the chat on your phone.'],
            session ? voiceActions : [openPhone],
          )
        } else if (session) manual(session, 'The question failed. Check the phone chat or ask a new question.')
        else show('gifti-error', ['The question failed. Open the conversation to review or retry it.'])
      } else if (reply && user?.delivery === 'sent') {
        const answer = typeof reply.text === 'string' ? plainAnswer(reply.text) : ''
        chartReplyID = answer && collection && openChart ? reply.id : undefined
        if (session) {
          if (answer) void play(session, answer, reply.id)
          else manual(session, 'Open the phone conversation to view the reply.')
        } else {
          show(
            'gifti-reply-' + reply.id,
            [lensAnswer(answer) || 'Open the conversation to view the reply.'],
            answerActions(reply.id, [openPhone]),
          )
        }
      }
      return
    }
    latestReplyID = [...chat.visibleMessages]
      .reverse()
      .find(m => m.role === 'assistant' && m.delivery === 'sent' && !!m.text?.trim())?.id
    const handoff = latestReplyID ? [read, openPhone] : [openPhone]
    if (!store.canSendSuggestedQuestion()) {
      const reason = chat.currentInputText
        ? 'Finish your unsent message in the phone chat first.'
        : 'A chat request is already in progress.'
      show(JSON.stringify(['gifti-busy', reason, latestReplyID]), [reason], handoff)
      return
    }
    const thread = chat.selectedThread
    const destination = thread ? 'Chat · ' + (chat.selectedConversationTitle ?? '').slice(0, 48) : 'New chat'
    const canTalk = !!voice && foreground && !audioBusy
    if (directTalk && canTalk) {
      offerTalk(chat.currentConversationID)
      return
    }
    show(
      JSON.stringify(['gifti-question', chat.currentConversationID, latestReplyID, destination, canTalk]),
      [question, destination],
      [send, ...(canTalk ? [talk] : []), ...handoff],
    )
  }

  function destination() {
    if (!stop || !prepared || !store.canSendSuggestedQuestion()) return
    const current = store.getSnapshot().currentConversationID
    if (current) return current
    store.startNewDraft?.()
    const chat = store.getSnapshot()
    return chat.selection?.type === 'draft' ? chat.currentConversationID ?? undefined : undefined
  }

  function submit(text: string, conversation?: Session) {
    const subscription = stop
    const context = collection ? { collection } : 'gifti'
    if (!subscription || turn || !foreground || !store.canSendSuggestedQuestion()) return
    const chat = conversation ? store.getSnapshot().currentConversationID : destination()
    if (
      !chat
      || stop !== subscription
      || turn
      || !foreground
      || !store.canSendSuggestedQuestion()
      || (conversation && (conversation !== session || conversation.chat !== chat))
    )
      return
    const pending: Turn = { chat, stagingText: text }
    turn = pending
    if (conversation) conversation.phase = 'sending'
    show(
      'gifti-sending',
      [lensAnswer(text), 'Gifti is thinking…'],
      conversation ? answerActions(conversation.lastAnswer?.id, voiceActions) : [openPhone],
    )
    function abandon() {
      if (turn !== pending) return
      turn = undefined
      if (conversation && session === conversation) stopVoice()
      update()
    }
    if (
      turn !== pending
      || !foreground
      || store.getSnapshot().currentConversationID !== chat
      || !store.canSendSuggestedQuestion()
    )
      return abandon()
    store.setCurrentInputText(text)
    const staged = store.getSnapshot()
    if (
      turn !== pending
      || !foreground
      || staged.currentConversationID !== chat
      || staged.currentInputText !== text
      || !staged.canSend
    )
      return abandon()
    const finish = () => {
      if (turn !== pending) return
      update()
      if (turn === pending && page.key === 'gifti-sending') {
        if (conversation) manual(conversation, 'Open the phone conversation to check the message.')
        else show('gifti-error', ['Open the phone conversation to check the message.'])
      }
    }
    void store
      .sendCurrentMessage(
        api,
        (messageID, replyID) => {
          pending.stagingText = undefined
          pending.messageID = messageID
          pending.replyID = replyID
        },
        context,
      )
      .then(finish, finish)
  }

  function openAnswerChart() {
    const name = collection
    const id = chartReplyID
    if (!foreground || !name || !openChart || !id) return
    const chat = store.getSnapshot()
    if (
      chat.accessState.type !== 'available'
      || !chat.visibleMessages.some(m => m.id === id && m.role === 'assistant' && m.delivery === 'sent')
    )
      return
    const subscription = stop
    stopVoice()
    if (
      stop !== subscription
      || chartReplyID !== id
      || store.getSnapshot().currentConversationID !== chat.currentConversationID
    )
      return
    turn = undefined
    const selected = { id, chartUnavailable: false }
    reading = selected
    try {
      selected.chartUnavailable = !openChart(name)
    } catch {
      selected.chartUnavailable = true
    }
    if (stop === subscription && reading === selected) update()
  }

  function close() {
    stop?.()
    stop = undefined
    prepared = false
    stopVoice()
    turn = undefined
    reading = undefined
    latestReplyID = undefined
    chartReplyID = undefined
    collection = undefined
  }

  return {
    getSnapshot: () => page,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(context) {
      close()
      collection = context?.collection?.trim() || undefined
      const directTalk = context?.entry === 'talk'
      question = collection
        ? 'How does ' + collection + '’s listing floor compare with yesterday’s UTC close?'
        : 'What changed in the Telegram gift market over the past seven days?'
      const subscription = store.subscribe(update)
      stop = subscription
      show('gifti-loading', ['Opening chat…'])
      if (stop !== subscription) return
      void store
        .prepare(api)
        .then(() => {
          if (stop === subscription) {
            prepared = true
            update(directTalk)
          }
        })
        .catch(() => {
          if (stop === subscription) show('gifti-error', ['Open the phone conversation to check access.'])
        })
    },
    act(id) {
      if (!stop || !page.actions.some(action => action.id === id)) return
      if (id === 'read' && latestReplyID) {
        reading = { id: latestReplyID }
        update()
      }
      if (id === 'show-chart') openAnswerChart()
      if (id === 'send') submit(question)
      if (id === 'talk' && !session && voice && foreground && !audioBusy) {
        offerTalk(store.getSnapshot().currentConversationID)
      }
      if (
        id === 'start-talking'
        && consent
        && consent.chat === store.getSnapshot().currentConversationID
        && foreground
        && !audioBusy
      ) {
        consent = undefined
        const subscription = stop
        const chat = destination()
        if (chat && stop === subscription && foreground && store.canSendSuggestedQuestion()) {
          session = { chat, controller: new AbortController(), phase: 'recording' }
          void record(session)
        }
      }
      if (id === 'follow-up' && session?.phase === 'manual') void record(session)
      if (id === 'end' || id === 'back') {
        stopVoice()
        update()
      }
      if (id === 'phone') {
        stopVoice()
        update()
        navigate()
      }
    },
    back() {
      if (session || consent) {
        stopVoice()
        update()
        return true
      }
      if (!reading) return false
      reading = undefined
      update()
      return true
    },
    setForegroundAvailable(visible) {
      foreground = visible
      if (!visible) stopVoice()
      update()
    },
    close,
  }
}
