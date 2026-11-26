import type { CollectionFloorsResponse, CompanionFloorSeries, CompanionInspector } from '../contracts/companion.ts'
import {
  isTelegramDailyComparison,
  type CompanionTelegramControl,
  type CompanionTelegramSnapshot,
  type TelegramDeliveryStatus,
  type TelegramDestination,
  type TelegramDigestItem,
  type TelegramLinkCandidate,
  type TelegramLinkKind,
  type TelegramQuestion,
  type TelegramScreen,
  type TelegramShareTarget,
  type TelegramSmartDraft,
  type TelegramState,
} from '../contracts/telegram.ts'
import { renderFloorChart } from '../floorChart.ts'
import { renderSpreadChart } from '../spreadChart.ts'
import { encodeFrame } from '../inspection.ts'
import { readJson, writeJson } from '../lib/storage.ts'
import {
  buildBundledFloorSeries,
  DEFAULT_USDT_PER_GRAM,
  getCheapestVenueFloor,
  getVenueQuotes,
} from './bundledMarketData.ts'
import { mirrorKeyToEvenHost, subscribeHostStorageHydration } from './evenHostStorage.ts'
import { buildAiReplyDraft, getGiftiSessionSnapshot } from './giftiAiBridge.ts'
import { getLatestTonUsdtSnapshot } from './liveTicker.ts'
import {
  annotateAndSortByTriage,
  classifyReplyIntent,
  summarizePending,
  triageQuestion,
  type TriageContext,
} from './questionTriage.ts'
import { buildSmartReplyDrafts, detectQuestionCollection } from './smartReplies.ts'

export interface TelegramReceipt {
  requestId: string
  seq?: number
  destination: string
  status: TelegramDeliveryStatus
  summary?: string
  sentAt: string
  questionId?: string
  reason?: 'missing_reply'
  reviewed?: boolean
}

export interface SentTelegramLogItem {
  id: string
  seq?: number
  destination: string
  topic?: string
  replyToSender?: string
  text: string
  attachedChart?: boolean
  sentAt: string
  status: TelegramDeliveryStatus
}

export interface RelayRuntimeConfig {
  relayUrl: string
  relayToken: string
  explicitDemo?: boolean
}

export interface TelegramHubViewSnapshot extends CompanionTelegramSnapshot {
  manageOpen: boolean
  pairing: boolean
  pairingUrl: string | null
  pairingKind: TelegramLinkKind | null
  receipt: TelegramReceipt | null
  sentLog: readonly SentTelegramLogItem[]
  relayConfig: RelayRuntimeConfig
  relayConfigError?: string | null
}

const RECEIPT_KEY_DEMO = 'telegifts_g2_tg_receipt_demo_v2'
const SENT_LOG_KEY_DEMO = 'telegifts_g2_tg_sent_demo_v2'
const RECEIPT_KEY_RELAY = 'telegifts_g2_tg_receipt_relay_v2'
const SENT_LOG_KEY_RELAY = 'telegifts_g2_tg_sent_relay_v2'
const SEQ_KEY = 'telegifts_g2_tg_seq_v2'
const RELAY_CFG_KEY = 'telegifts_g2_relay_cfg_v1'

export function canonicalizeRelayUrl(
  raw: string | null | undefined,
  baseHref?: string,
): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  if (trimmed.includes('?') || trimmed.includes('#')) return null
  const effectiveBase =
    baseHref
    ?? (typeof globalThis.location?.href === 'string' && /^https?:\/\//i.test(globalThis.location.href)
      ? globalThis.location.href
      : 'http://localhost/')
  try {
    const parsed = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)
      ? new URL(trimmed)
      : new URL(trimmed, effectiveBase)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null
    }
    const pathname = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}`
  } catch {
    return null
  }
}

function hashRelayAuthTag(token: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function getTelegramReceiptStorageKey(
  relayUrl?: string | null,
  relayToken = '',
  baseHref?: string,
): string {
  const norm = canonicalizeRelayUrl(relayUrl, baseHref)
  if (!norm) return RECEIPT_KEY_DEMO
  const cleanTok = relayToken.trim()
  const authTag = cleanTok ? hashRelayAuthTag(cleanTok) : 'open'
  return `${RECEIPT_KEY_RELAY}:${norm}:${authTag}`
}

export function getTelegramSentLogStorageKey(
  relayUrl?: string | null,
  relayToken = '',
  baseHref?: string,
): string {
  const norm = canonicalizeRelayUrl(relayUrl, baseHref)
  if (!norm) return SENT_LOG_KEY_DEMO
  const cleanTok = relayToken.trim()
  const authTag = cleanTok ? hashRelayAuthTag(cleanTok) : 'open'
  return `${SENT_LOG_KEY_RELAY}:${norm}:${authTag}`
}

interface StorageScope {
  modeGen: number
  isRelay: boolean
  relayUrl: string | null
  relayHeadersJson: Record<string, string>
  relayHeadersGet: Record<string, string>
  receiptKey: string
  sentLogKey: string
}

const INITIAL_QUESTIONS: TelegramQuestion[] = [
  {
    id: 'q-pepe-spread',
    sender: '@mira_ton',
    chatLabel: 'TON Gift Alpha',
    topicName: '#floor-watch',
    topicId: 14,
    collectionHint: 'Plush Pepe',
    askedAt: '2m ago',
    text: 'Is Plush Pepe still cheaper on Portals than Tonnel after the morning sweep?',
  },
  {
    id: 'q-astral-breakout',
    sender: '@kairo_collects',
    chatLabel: 'TON Gift Alpha',
    topicName: '#deals-radar',
    topicId: 22,
    collectionHint: 'Astral Shard',
    askedAt: '9m ago',
    text: 'Anyone tracking Astral Shard 7d floor closes? Wondering if this +11% move holds.',
  },
  {
    id: 'q-cap-models',
    sender: '@vasya_gifts',
    chatLabel: 'TON Gift Alpha',
    topicName: '#model-checks',
    topicId: 31,
    collectionHint: "Durov's Cap",
    askedAt: '18m ago',
    text: "What's the current spread on Durov's Cap across venues right now?",
  },
]

const INITIAL_DIGEST: TelegramDigestItem[] = [
  {
    id: 'dig-1',
    channel: '@TeleGiftsPulse',
    headline: 'Astral Shard +11.25% 24h breakout',
    summary: 'Portals holds cheapest ask at 890 GRAM (-5.5% below Tonnel) on rising collector volume.',
    collection: 'Astral Shard',
    floorGram: 890,
    changePercent: 11.25,
    timestamp: '4m ago',
    kind: 'breakout',
  },
  {
    id: 'dig-2',
    channel: '@GiftFloorRadar',
    headline: 'Plush Pepe venue spread widened to 3.5%',
    summary: 'Portals 4,820 GRAM vs Tonnel 4,990 GRAM. 7d floor up +14.8%.',
    collection: 'Plush Pepe',
    floorGram: 4820,
    changePercent: 6.42,
    timestamp: '12m ago',
    kind: 'spread',
  },
  {
    id: 'dig-3',
    channel: '@GiftFloorRadar',
    headline: 'Kissed Frog surged +9.65% over 24h',
    summary: 'Tonnel leads at 144 GRAM vs Portals 149 GRAM. Royal Crown rare tier tightened.',
    collection: 'Kissed Frog',
    floorGram: 144,
    changePercent: 9.65,
    timestamp: '26m ago',
    kind: 'channel',
  },
]

const DEMO_QUESTION_POOL: Omit<TelegramQuestion, 'id' | 'askedAt'>[] = [
  {
    sender: '@lena_whale',
    chatLabel: 'TON Gift Alpha',
    topicName: '#floor-watch',
    topicId: 14,
    collectionHint: 'Plush Pepe',
    text: 'Plush Pepe just got swept — is Portals still cheapest right now?',
  },
  {
    sender: '@denis_mint',
    chatLabel: 'TON Gift Alpha',
    topicName: '#deals-radar',
    topicId: 22,
    collectionHint: 'Swiss Watch',
    text: 'Where is the lowest Swiss Watch ask listed?',
  },
  {
    sender: '@ton_curator',
    chatLabel: 'TON Gift Alpha',
    topicName: '#model-checks',
    topicId: 31,
    collectionHint: 'Loot Bag',
    text: 'How much did Loot Bag move vs yesterday UTC close?',
  },
]

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  }
  return btoa(chunks.join(''))
}

export class TelegramCompanionStore implements CompanionTelegramControl {
  private listeners = new Set<() => void>()
  private relayUrl: string | null
  private relayToken: string
  private modeGeneration = 1
  private hasLiveCatalogSource: () => boolean
  private hasLiveHistorySource: () => boolean
  private questionCounter = 0
  private requestCounter = 0
  private activeSendingSeq = 0
  private composeSessionCounter = 0
  private localWatchAlerts: TelegramDigestItem[] = []
  private requestQuestions = new Map<string, string>() // requestId -> questionId
  private deliveryCheckSeq = new Map<string, number>() // requestId -> monotonic lookup seq
  private streamAbort: AbortController | null = null
  private streamReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private streamConnected = false
  private seenQuestionsInitialized = false
  private seenQuestionIds = new Set<string>()
  private unsubscribeHydration: (() => void) | null = null
  private view: TelegramHubViewSnapshot
  private inspector: CompanionInspector
  private getCatalog: () => CollectionFloorsResponse | null
  private getFocusedCollection: () => string | null
  private getTriageContext?: () => { favorites?: readonly string[]; watchlist?: readonly string[] }
  private isDictationAvailable: () => boolean
  private activeAiDraftAbort: AbortController | null = null

  constructor(
    inspector: CompanionInspector,
    getCatalog: () => CollectionFloorsResponse | null,
    getFocusedCollection: () => string | null,
    explicitRelayUrl?: string,
    explicitRelayToken?: string,
    hasLiveCatalogSource: () => boolean = () =>
      Boolean(((import.meta as { env?: Record<string, string> }).env?.VITE_MARKET_API_URL ?? '').trim()),
    hasLiveHistorySource: () => boolean = () => false,
    getTriageContext?: () => { favorites?: readonly string[]; watchlist?: readonly string[] },
    isDictationAvailable: () => boolean = () => getGiftiSessionSnapshot().hasEphemeralKey,
  ) {
    this.inspector = inspector
    this.getCatalog = getCatalog
    this.getFocusedCollection = getFocusedCollection
    this.hasLiveCatalogSource = hasLiveCatalogSource
    this.hasLiveHistorySource = hasLiveHistorySource
    this.getTriageContext = getTriageContext
    this.isDictationAvailable = isDictationAvailable

    const savedCfg = readJson<RelayRuntimeConfig | null>(RELAY_CFG_KEY, null)
    const envUrl = ((import.meta as { env?: Record<string, string> }).env?.VITE_TELEGRAM_RELAY_URL ?? '').trim()

    // Relay bearer token is strictly per-device runtime config (or explicit test parameter),
    // never read from a build-time VITE_* env variable that could be embedded in a public .ehpk,
    // and never paired with VITE_TELEGRAM_RELAY_URL when no valid saved relayUrl exists.
    if (explicitRelayUrl !== undefined) {
      const canonicalExplicit = canonicalizeRelayUrl(explicitRelayUrl)
      this.relayUrl = canonicalExplicit
      this.relayToken = canonicalExplicit ? (explicitRelayToken ?? savedCfg?.relayToken ?? '').trim() : ''
    } else if (savedCfg?.explicitDemo) {
      this.relayUrl = null
      this.relayToken = ''
    } else if (savedCfg?.relayUrl) {
      const canonicalSaved = canonicalizeRelayUrl(savedCfg.relayUrl)
      this.relayUrl = canonicalSaved
      this.relayToken = canonicalSaved ? (explicitRelayToken ?? savedCfg.relayToken ?? '').trim() : ''
    } else {
      const canonicalEnv = canonicalizeRelayUrl(envUrl)
      this.relayUrl = canonicalEnv
      this.relayToken = canonicalEnv && explicitRelayToken !== undefined ? explicitRelayToken.trim() : ''
    }

    const demoReceipt = readJson<TelegramReceipt | null>(RECEIPT_KEY_DEMO, null)
    const demoLog = readJson<SentTelegramLogItem[]>(SENT_LOG_KEY_DEMO, [])
    const activeReceiptKey = getTelegramReceiptStorageKey(this.relayUrl, this.relayToken)
    const activeSentKey = getTelegramSentLogStorageKey(this.relayUrl, this.relayToken)
    const savedReceipt = this.relayUrl ? readJson<TelegramReceipt | null>(activeReceiptKey, null) : demoReceipt
    const savedSent = this.relayUrl ? readJson<SentTelegramLogItem[]>(activeSentKey, []) : demoLog
    const persistedSeq = readJson<number>(SEQ_KEY, 0)
    this.requestCounter = Math.max(
      0,
      Number.isInteger(persistedSeq) ? persistedSeq : 0,
      demoReceipt?.seq ?? 0,
      savedReceipt?.seq ?? 0,
      ...demoLog.map(i => i.seq ?? 0),
      ...savedSent.map(i => i.seq ?? 0),
    )

    if (savedReceipt?.questionId) {
      this.requestQuestions.set(savedReceipt.requestId, savedReceipt.questionId)
    }
    const initialQuestions = this.relayUrl ? [] : this.triageQuestions(INITIAL_QUESTIONS, true)
    this.view = {
      state: this.relayUrl
        ? null
        : {
            enabled: true,
            mode: 'demo',
            privateChat: { id: 'dm-collector', label: 'Saved Messages (@collector)' },
            group: { id: 'grp-alpha', label: 'TON Gift Alpha' },
            candidate: null,
            questions: initialQuestions,
            digest: INITIAL_DIGEST,
          },
      selectedQuestion: this.relayUrl ? null : (initialQuestions[0] ?? null),
      screen: { kind: 'idle' },
      manageOpen: false,
      pairing: false,
      pairingUrl: null,
      pairingKind: null,
      receipt: savedReceipt,
      sentLog: savedSent,
      relayConfig: {
        relayUrl: this.relayUrl ?? '',
        relayToken: this.relayToken,
      },
      relayConfigError: null,
    }
    if (explicitRelayUrl === undefined) {
      this.unsubscribeHydration = subscribeHostStorageHydration(hydratedKeys => {
        if (!hydratedKeys.includes(RELAY_CFG_KEY)) return
        const hydratedCfg = readJson<RelayRuntimeConfig | null>(RELAY_CFG_KEY, null)
        if (!hydratedCfg) return
        if (hydratedCfg.explicitDemo) {
          if (this.relayUrl !== null || this.relayToken !== '') void this.configureRelay('', '')
        } else if (
          hydratedCfg.relayUrl
          && (hydratedCfg.relayUrl !== (this.relayUrl ?? '') || (hydratedCfg.relayToken ?? '') !== this.relayToken)
        ) {
          void this.configureRelay(hydratedCfg.relayUrl, hydratedCfg.relayToken ?? '')
        }
      })
    }
    if (this.relayUrl) void this.refresh()
  }

  private receiptStorageKey(relayUrl = this.relayUrl, relayToken = this.relayToken): string {
    return getTelegramReceiptStorageKey(relayUrl, relayToken)
  }

  private sentLogStorageKey(relayUrl = this.relayUrl, relayToken = this.relayToken): string {
    return getTelegramSentLogStorageKey(relayUrl, relayToken)
  }

  private captureScope(): StorageScope {
    const isRelay = Boolean(this.relayUrl)
    return {
      modeGen: this.modeGeneration,
      isRelay,
      relayUrl: this.relayUrl,
      relayHeadersJson: this.relayHeaders(true),
      relayHeadersGet: this.relayHeaders(false),
      receiptKey: this.receiptStorageKey(this.relayUrl, this.relayToken),
      sentLogKey: this.sentLogStorageKey(this.relayUrl, this.relayToken),
    }
  }

  private mergeDigestWithLocalWatches(remoteDigest: readonly TelegramDigestItem[] = []): TelegramDigestItem[] {
    if (!this.localWatchAlerts.length) return [...remoteDigest]
    const seen = new Set(this.localWatchAlerts.map(a => a.id))
    return [...this.localWatchAlerts, ...remoteDigest.filter(d => !seen.has(d.id))]
  }

  getSnapshot = (): TelegramHubViewSnapshot => this.view

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  configureRelay = async (relayUrl: string, relayToken: string): Promise<boolean> => {
    const trimmedInput = relayUrl.trim()
    if (trimmedInput.length > 0) {
      const canonicalUrl = canonicalizeRelayUrl(trimmedInput)
      if (!canonicalUrl) {
        this.emit({
          relayConfigError: 'Invalid relay URL. Use HTTP(S) or a clean relative path without query, hash, or credentials.',
        })
        return false
      }
      const cleanToken = relayToken.trim()
      const nextCfg = { relayUrl: canonicalUrl, relayToken: cleanToken, explicitDemo: false }
      writeJson(RELAY_CFG_KEY, nextCfg)
      mirrorKeyToEvenHost(RELAY_CFG_KEY, JSON.stringify(nextCfg))
      const wasStreaming = this.streamConnected
      this.disconnectLiveStream()
      this.modeGeneration += 1
      this.relayUrl = canonicalUrl
      this.relayToken = cleanToken
      this.localWatchAlerts = []
      this.seenQuestionsInitialized = false
      this.seenQuestionIds.clear()

      const receipt = readJson<TelegramReceipt | null>(this.receiptStorageKey(), null)
      if (receipt?.questionId) {
        this.requestQuestions.set(receipt.requestId, receipt.questionId)
      }
      const sentLog = readJson<SentTelegramLogItem[]>(this.sentLogStorageKey(), [])
      this.requestCounter = Math.max(this.requestCounter, receipt?.seq ?? 0, ...sentLog.map(i => i.seq ?? 0))

      this.emit({
        relayConfig: { relayUrl: canonicalUrl, relayToken: cleanToken, explicitDemo: false },
        relayConfigError: null,
        pairing: false,
        pairingUrl: null,
        pairingKind: null,
        receipt,
        sentLog,
        selectedQuestion: null,
        screen: { kind: 'idle' },
        state: null,
      })
      await this.refresh()
      if (wasStreaming) this.connectLiveStream()
      return true
    }

    // Blank URL explicitly switches to built-in demo mode and clears any stored token
    const demoCfg = { relayUrl: '', relayToken: '', explicitDemo: true }
    writeJson(RELAY_CFG_KEY, demoCfg)
    mirrorKeyToEvenHost(RELAY_CFG_KEY, JSON.stringify(demoCfg))
    this.disconnectLiveStream()
    this.modeGeneration += 1
    this.relayUrl = null
    this.relayToken = ''
    this.localWatchAlerts = []
    this.seenQuestionsInitialized = false
    this.seenQuestionIds.clear()

    const receipt = readJson<TelegramReceipt | null>(this.receiptStorageKey(), null)
    if (receipt?.questionId) {
      this.requestQuestions.set(receipt.requestId, receipt.questionId)
    }
    const sentLog = readJson<SentTelegramLogItem[]>(this.sentLogStorageKey(), [])
    this.requestCounter = Math.max(this.requestCounter, receipt?.seq ?? 0, ...sentLog.map(i => i.seq ?? 0))
    const demoQuestions = this.triageQuestions(INITIAL_QUESTIONS, true)

    this.emit({
      relayConfig: { relayUrl: '', relayToken: '', explicitDemo: true },
      relayConfigError: null,
      pairing: false,
      pairingUrl: null,
      pairingKind: null,
      receipt,
      sentLog,
      selectedQuestion: demoQuestions[0] ?? null,
      screen: { kind: 'idle' },
      state: {
        enabled: true,
        mode: 'demo',
        privateChat: { id: 'dm-collector', label: 'Saved Messages (@collector)' },
        group: { id: 'grp-alpha', label: 'TON Gift Alpha' },
        candidate: null,
        questions: demoQuestions,
        digest: INITIAL_DIGEST,
      },
    })
    return true
  }

  private nextRequest(prefix: string): { requestId: string; seq: number } {
    const persistedSeq = readJson<number>(SEQ_KEY, 0)
    const seq = Math.max(this.requestCounter, Number.isInteger(persistedSeq) ? persistedSeq : 0) + 1
    this.requestCounter = seq
    writeJson(SEQ_KEY, seq)
    return { requestId: `${prefix}-${Date.now()}-${seq}`, seq }
  }

  private relayHeaders(jsonBody = false): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (jsonBody) headers['Content-Type'] = 'application/json'
    if (this.relayToken) headers['Authorization'] = `Bearer ${this.relayToken}`
    return headers
  }

  private async parseRelayReceipt(
    res: Response,
  ): Promise<{ status: TelegramDeliveryStatus; reason?: 'missing_reply' }> {
    const data = (await res.json().catch(() => null)) as
      | { status?: unknown; reason?: unknown }
      | null
    if (res.ok && data && typeof data.status === 'string') {
      const reason = data.reason === 'missing_reply' ? ('missing_reply' as const) : undefined
      if (data.status === 'sent') return { status: 'sent' }
      if (data.status === 'failed') return { status: 'failed', ...(reason ? { reason } : {}) }
      if (data.status === 'pending') return { status: 'pending' }
      return { status: 'unknown' }
    }
    if (res.status >= 500 || res.status === 429) return { status: 'unknown' }
    if (!res.ok) return { status: 'failed' }
    return { status: 'unknown' }
  }

  private emit(patch: Partial<TelegramHubViewSnapshot>) {
    this.view = { ...this.view, ...patch }
    for (const listener of this.listeners) listener()
  }

  private buildTriageContext(isDemo: boolean): TriageContext {
    const extra = this.getTriageContext?.()
    return {
      favorites: extra?.favorites ?? [],
      watchlist: extra?.watchlist ?? [],
      catalog: this.getCatalog(),
      spreadSignalAllowed: isDemo || this.hasLiveCatalogSource(),
    }
  }

  private triageQuestions(questions: readonly TelegramQuestion[], isDemo: boolean): TelegramQuestion[] {
    if (!questions.length) return []
    return annotateAndSortByTriage(questions, this.buildTriageContext(isDemo))
  }

  private shouldInterruptScreen(priority: 1 | 2 | 3, screen: TelegramScreen): boolean {
    const effectiveKind = screen.kind
    if (effectiveKind === 'compose' || effectiveKind === 'confirm' || effectiveKind === 'sending') {
      return false
    }
    if (priority === 1) {
      if (effectiveKind === 'heads-up') {
        return (screen.priority ?? 2) > 1
      }
      return (
        effectiveKind === 'idle'
        || effectiveKind === 'questions'
        || effectiveKind === 'digest'
        || effectiveKind === 'pending'
        || effectiveKind === 'notice'
        || effectiveKind === 'result'
      )
    }
    if (priority === 2) {
      return effectiveKind === 'idle'
    }
    return false
  }

  private reconcileQuestionScreen(
    questions: readonly TelegramQuestion[],
    hasGroup: boolean,
  ): TelegramScreen | undefined {
    const { screen } = this.view
    if (screen.kind === 'heads-up') {
      if (!hasGroup || (screen.question && !questions.some(q => q.id === screen.question!.id))) {
        return { kind: 'idle' }
      }
    } else if (screen.kind === 'question' || screen.kind === 'compose') {
      if (!hasGroup || !questions.some(q => q.id === screen.question.id)) {
        return { kind: 'notice', reason: 'changed' }
      }
    } else if ((screen.kind === 'questions' || screen.kind === 'pending') && !hasGroup) {
      return { kind: 'idle' }
    }
    return undefined
  }

  async refresh(): Promise<void> {
    const scope = this.captureScope()
    if (!scope.relayUrl) {
      this.emit({})
      return
    }
    try {
      const response = await fetch(`${scope.relayUrl}/g2/telegram/state`, {
        headers: scope.relayHeadersGet,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const remote = (await response.json()) as TelegramState
      if (this.modeGeneration !== scope.modeGen) return
      const sortedQuestions = this.triageQuestions(remote.questions, false)
      for (const q of sortedQuestions) this.seenQuestionIds.add(q.id)
      this.seenQuestionsInitialized = true
      const selected =
        sortedQuestions.find(q => q.id === this.view.selectedQuestion?.id) ?? sortedQuestions[0] ?? null
      const nextScreen = this.reconcileQuestionScreen(sortedQuestions, Boolean(remote.group))
      this.emit({
        state: {
          ...remote,
          questions: sortedQuestions,
          mode: 'relay',
          digest: this.mergeDigestWithLocalWatches(remote.digest ?? []),
        },
        selectedQuestion: selected,
        ...(nextScreen ? { screen: nextScreen } : {}),
      })
    } catch {
      if (this.modeGeneration !== scope.modeGen) return
      if (!this.view.state) {
        this.emit({
          state: {
            enabled: false,
            mode: 'relay',
            privateChat: null,
            group: null,
            candidate: null,
            questions: [],
            digest: this.mergeDigestWithLocalWatches([]),
          },
        })
      }
    }
  }

  async checkDelivery(explicitRequestId?: string): Promise<TelegramDeliveryStatus | null> {
    const scope = this.captureScope()
    const requestId =
      explicitRequestId
      ?? (this.view.screen.kind === 'result' ? this.view.screen.requestId : undefined)
      ?? this.view.receipt?.requestId
    if (!scope.relayUrl || !requestId) return null
    const checkSeq = (this.deliveryCheckSeq.get(requestId) ?? 0) + 1
    this.deliveryCheckSeq.set(requestId, checkSeq)
    const isTerminal = (s: TelegramDeliveryStatus | undefined): boolean => s === 'sent' || s === 'failed'
    const capturedQuestionId =
      this.requestQuestions.get(requestId)
      ?? (this.view.receipt?.requestId === requestId ? this.view.receipt.questionId : undefined)

    try {
      const res = await fetch(`${scope.relayUrl}/g2/telegram/delivery/${encodeURIComponent(requestId)}`, {
        headers: scope.relayHeadersGet,
      })
      if (!res.ok) return null
      const data = (await res.json().catch(() => null)) as
        | { status?: unknown; reason?: unknown }
        | null
      if (
        !data
        || typeof data !== 'object'
        || (data.status !== 'sent' && data.status !== 'failed' && data.status !== 'pending' && data.status !== 'unknown')
      ) {
        return null
      }
      if (this.deliveryCheckSeq.get(requestId) !== checkSeq) {
        const currentStored = readJson<TelegramReceipt | null>(scope.receiptKey, null)
        if (currentStored?.requestId === requestId) return currentStored.status
        if (this.view.receipt?.requestId === requestId) return this.view.receipt.status
        return data.status
      }

      const parsed: { status: TelegramDeliveryStatus; reason?: 'missing_reply' } = {
        status: data.status,
        ...(data.status === 'failed' && data.reason === 'missing_reply' ? { reason: 'missing_reply' } : {}),
      }

      const storedReceipt = readJson<TelegramReceipt | null>(scope.receiptKey, null)
      if (storedReceipt && storedReceipt.requestId === requestId) {
        if (!isTerminal(storedReceipt.status) || isTerminal(parsed.status)) {
          writeJson(scope.receiptKey, {
            ...storedReceipt,
            status: parsed.status,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
          })
        }
      }
      const storedLog = readJson<SentTelegramLogItem[]>(scope.sentLogKey, [])
      const updatedStoredLog = storedLog.map(entry =>
        entry.id === requestId && (!isTerminal(entry.status) || isTerminal(parsed.status))
          ? { ...entry, status: parsed.status }
          : entry,
      )
      writeJson(scope.sentLogKey, updatedStoredLog)

      if (this.modeGeneration !== scope.modeGen) return parsed.status

      const isActiveReceipt = this.view.receipt?.requestId === requestId
      const canAdvanceReceipt =
        isActiveReceipt
        && this.view.receipt
        && (!isTerminal(this.view.receipt.status) || isTerminal(parsed.status))
      const updatedReceipt = canAdvanceReceipt && this.view.receipt
        ? {
            ...this.view.receipt,
            status: parsed.status,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
          }
        : this.view.receipt

      const isDisplayedResult =
        this.view.screen.kind === 'result'
        && (this.view.screen.requestId ?? this.view.receipt?.requestId) === requestId
      const canAdvanceScreen =
        isDisplayedResult
        && this.view.screen.kind === 'result'
        && (!isTerminal(this.view.screen.status) || isTerminal(parsed.status))

      const nextLog = this.view.sentLog.map(entry =>
        entry.id === requestId && (!isTerminal(entry.status) || isTerminal(parsed.status))
          ? { ...entry, status: parsed.status }
          : entry,
      )

      const shouldClearQuestion = parsed.status === 'sent' || parsed.reason === 'missing_reply'
      const questionIdToClear = shouldClearQuestion ? capturedQuestionId : undefined
      const remainingQuestions = questionIdToClear
        ? (this.view.state?.questions ?? []).filter(q => q.id !== questionIdToClear)
        : (this.view.state?.questions ?? [])

      this.emit({
        receipt: updatedReceipt,
        sentLog: nextLog,
        state: this.view.state ? { ...this.view.state, questions: remainingQuestions } : null,
        selectedQuestion:
          questionIdToClear && this.view.selectedQuestion?.id === questionIdToClear
            ? (remainingQuestions[0] ?? null)
            : this.view.selectedQuestion,
        ...(canAdvanceScreen && this.view.screen.kind === 'result'
          ? {
              screen: {
                ...this.view.screen,
                status: parsed.status,
                ...(parsed.reason ? { reason: parsed.reason } : {}),
              },
            }
          : {}),
      })
      if (isActiveReceipt && updatedReceipt) return updatedReceipt.status
      return parsed.status
    } catch {
      return 'unknown'
    }
  }

  selectQuestion = (question: TelegramQuestion) => {
    this.emit({ selectedQuestion: question })
  }

  openManagement = () => {
    this.cancelDraft()
    this.emit({ manageOpen: true })
  }

  closeManagement = () => {
    this.emit({ manageOpen: false, pairingUrl: null, pairingKind: null, relayConfigError: null })
  }

  async startPairing(kind: TelegramLinkKind): Promise<void> {
    const scope = this.captureScope()
    if (scope.relayUrl) {
      this.emit({ pairing: true })
      try {
        const res = await fetch(`${scope.relayUrl}/g2/telegram/link`, {
          method: 'POST',
          headers: scope.relayHeadersJson,
          body: JSON.stringify({ kind }),
        })
        if (!res.ok) throw new Error('Pairing unavailable')
        const data = (await res.json()) as { url: string }
        if (this.modeGeneration === scope.modeGen) {
          this.emit({ pairing: false, pairingUrl: data.url, pairingKind: kind })
        }
      } catch {
        if (this.modeGeneration === scope.modeGen) this.emit({ pairing: false })
      }
      return
    }
    const candidate: TelegramLinkCandidate = {
      id: kind === 'private' ? 'dm-collector' : 'grp-alpha',
      label: kind === 'private' ? 'Saved Messages (@collector)' : 'TON Gift Alpha',
      kind,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }
    this.emit({
      pairingUrl: `https://t.me/telegifts_g2_demo_bot?start=pair_${kind}`,
      pairingKind: kind,
      state: this.view.state ? { ...this.view.state, candidate } : null,
    })
  }

  async confirmCandidate(candidate: TelegramLinkCandidate): Promise<void> {
    const scope = this.captureScope()
    if (scope.relayUrl) {
      await fetch(`${scope.relayUrl}/g2/telegram/confirm-link`, {
        method: 'POST',
        headers: scope.relayHeadersJson,
        body: JSON.stringify({ id: candidate.id, kind: candidate.kind }),
      }).catch(() => undefined)
      if (this.modeGeneration !== scope.modeGen) return
      await this.refresh()
      if (this.modeGeneration === scope.modeGen) {
        this.emit({ pairingUrl: null, pairingKind: null })
      }
      return
    }
    if (!this.view.state) return
    const dest: TelegramDestination = { id: candidate.id, label: candidate.label }
    this.emit({
      pairingUrl: null,
      pairingKind: null,
      state: {
        ...this.view.state,
        candidate: null,
        ...(candidate.kind === 'private' ? { privateChat: dest } : { group: dest }),
      },
    })
  }

  async unlink(kind: TelegramLinkKind): Promise<void> {
    const scope = this.captureScope()
    if (scope.relayUrl) {
      const current = kind === 'private' ? this.view.state?.privateChat : this.view.state?.group
      if (current) {
        await fetch(`${scope.relayUrl}/g2/telegram/unlink`, {
          method: 'POST',
          headers: scope.relayHeadersJson,
          body: JSON.stringify({ kind, destinationId: current.id }),
        }).catch(() => undefined)
        if (this.modeGeneration === scope.modeGen) {
          this.seenQuestionsInitialized = false
          this.seenQuestionIds.clear()
          await this.refresh()
        }
      }
      return
    }
    if (!this.view.state) return
    this.seenQuestionsInitialized = false
    this.seenQuestionIds.clear()
    const nextScreen = this.reconcileQuestionScreen([], false)
    this.emit({
      selectedQuestion: null,
      ...(kind === 'private' ? { screen: { kind: 'idle' } } : nextScreen ? { screen: nextScreen } : {}),
      state: {
        ...this.view.state,
        questions: [],
        ...(kind === 'private' ? { privateChat: null, group: null } : { group: null }),
      },
    })
  }

  disconnectLiveStream = () => {
    this.streamConnected = false
    if (this.activeAiDraftAbort) {
      this.activeAiDraftAbort.abort()
      this.activeAiDraftAbort = null
    }
    if (this.streamReconnectTimer) {
      clearTimeout(this.streamReconnectTimer)
      this.streamReconnectTimer = null
    }
    if (this.streamAbort) {
      this.streamAbort.abort()
      this.streamAbort = null
    }
  }

  connectLiveStream = () => {
    this.streamConnected = true
    if (!this.relayUrl || this.streamAbort) return
    const scope = this.captureScope()
    if (!scope.relayUrl) return

    const abort = new AbortController()
    this.streamAbort = abort

    const applyPushedState = (remote: TelegramState) => {
      if (this.modeGeneration !== scope.modeGen || abort.signal.aborted) return
      const sortedQuestions = this.triageQuestions(remote.questions, false)
      let newestArrival: TelegramQuestion | undefined
      if (!this.seenQuestionsInitialized) {
        for (const q of sortedQuestions) this.seenQuestionIds.add(q.id)
        this.seenQuestionsInitialized = true
      } else {
        for (const q of sortedQuestions) {
          if (!this.seenQuestionIds.has(q.id)) {
            this.seenQuestionIds.add(q.id)
            if (!newestArrival || (q.priority ?? 3) < (newestArrival.priority ?? 3)) {
              newestArrival = q
            }
          }
        }
      }

      const reconciledScreen = this.reconcileQuestionScreen(sortedQuestions, Boolean(remote.group))
      const effectiveScreen = reconciledScreen ?? this.view.screen
      const effectiveKind = effectiveScreen.kind
      const arrivalPriority = newestArrival?.priority ?? 2
      const shouldInterrupt = Boolean(
        newestArrival && remote.group && this.shouldInterruptScreen(arrivalPriority, effectiveScreen),
      )
      const selected =
        (shouldInterrupt ? newestArrival : undefined)
        ?? sortedQuestions.find(q => q.id === this.view.selectedQuestion?.id)
        ?? sortedQuestions[0]
        ?? null
      const badge = newestArrival
        ? newestArrival.topicName
          ? `${newestArrival.chatLabel} · ${newestArrival.topicName}`
          : newestArrival.chatLabel
        : ''

      this.emit({
        state: {
          ...remote,
          questions: sortedQuestions,
          mode: 'relay',
          digest: this.mergeDigestWithLocalWatches(remote.digest ?? []),
        },
        selectedQuestion: selected,
        ...(shouldInterrupt && newestArrival
          ? {
              screen: {
                kind: 'heads-up',
                alertId: newestArrival.id,
                badge,
                headline: `${newestArrival.sender}${newestArrival.collectionHint ? ` · ${newestArrival.collectionHint}` : ''}`,
                detail: newestArrival.text,
                question: newestArrival,
                priority: arrivalPriority,
                tags: newestArrival.triageTags,
              },
            }
          : reconciledScreen
            ? { screen: reconciledScreen }
            : effectiveKind === 'pending'
              ? { screen: { kind: 'pending', summary: summarizePending(sortedQuestions, this.buildTriageContext(false)) } }
              : {}),
      })
    }

    void (async () => {
      try {
        const res = await fetch(`${scope.relayUrl}/g2/telegram/events`, {
          headers: {
            ...scope.relayHeadersGet,
            Accept: 'text/event-stream',
          },
          signal: abort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!abort.signal.aborted) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const rawEvent = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')
            const lines = rawEvent.split(/\r?\n/)
            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of lines) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (eventName === 'state' && dataLines.length > 0) {
              try {
                const parsed = JSON.parse(dataLines.join('\n')) as TelegramState
                if (parsed && Array.isArray(parsed.questions)) applyPushedState(parsed)
              } catch {
                // Ignore malformed frame
              }
            }
          }
        }
      } catch {
        // Reconnect below if still active
      } finally {
        if (this.streamAbort === abort) {
          this.streamAbort = null
          if (this.streamConnected && this.modeGeneration === scope.modeGen && this.relayUrl) {
            this.streamReconnectTimer = setTimeout(() => {
              this.streamReconnectTimer = null
              if (this.streamConnected && this.modeGeneration === scope.modeGen) {
                this.connectLiveStream()
              }
            }, 3_000)
            ;(this.streamReconnectTimer as { unref?: () => void }).unref?.()
          }
        }
      }
    })()
  }

  triggerHeadsUpQuestion = (explicitQuestion?: TelegramQuestion): TelegramQuestion | null => {
    if (!this.view.state) return null
    const isDemo = !this.relayUrl && (this.view.state.mode ?? 'demo') === 'demo'
    const ctx = this.buildTriageContext(isDemo)
    if (!explicitQuestion) {
      const template = DEMO_QUESTION_POOL[this.questionCounter++ % DEMO_QUESTION_POOL.length]!
      const raw: TelegramQuestion = {
        ...template,
        id: `q-sim-${Date.now()}-${this.questionCounter}`,
        askedAt: 'Just now',
      }
      const triaged = triageQuestion(raw, ctx)
      const target: TelegramQuestion = {
        ...raw,
        ...(triaged.collection && !raw.collectionHint ? { collectionHint: triaged.collection } : {}),
        priority: triaged.level,
        triageTags: triaged.tags,
        replyIntent: triaged.intent,
      }
      const questions = this.triageQuestions([target, ...this.view.state.questions], isDemo)
      this.seenQuestionIds.add(target.id)
      const canInterrupt = this.shouldInterruptScreen(triaged.level, this.view.screen)
      const badge = target.topicName ? `${target.chatLabel} · ${target.topicName}` : target.chatLabel
      this.emit({
        state: { ...this.view.state, questions },
        ...(canInterrupt
          ? {
              selectedQuestion: target,
              screen: {
                kind: 'heads-up',
                alertId: target.id,
                badge,
                headline: `${target.sender}${target.collectionHint ? ` · ${target.collectionHint}` : ''}`,
                detail: target.text,
                question: target,
                priority: target.priority,
                tags: target.triageTags,
              },
            }
          : {}),
      })
      return target
    }
    const triaged = triageQuestion(explicitQuestion, ctx)
    const priority = explicitQuestion.priority ?? triaged.level
    const enriched: TelegramQuestion = {
      ...explicitQuestion,
      priority,
      triageTags: explicitQuestion.triageTags ?? triaged.tags,
      replyIntent: explicitQuestion.replyIntent ?? triaged.intent,
    }
    if (!this.shouldInterruptScreen(priority, this.view.screen)) {
      return enriched
    }
    const badge = enriched.topicName ? `${enriched.chatLabel} · ${enriched.topicName}` : enriched.chatLabel
    this.emit({
      selectedQuestion: enriched,
      screen: {
        kind: 'heads-up',
        alertId: enriched.id,
        badge,
        headline: `${enriched.sender}${enriched.collectionHint ? ` · ${enriched.collectionHint}` : ''}`,
        detail: enriched.text,
        question: enriched,
        priority: enriched.priority,
        tags: enriched.triageTags,
      },
    })
    return enriched
  }

  /**
   * Injects a 3-message demo burst (P3 quiet chatter -> P2 spread ask -> P1 urgent favorite)
   * so judges immediately see silent P3 queueing vs. P1 heads-up interruption.
   */
  triggerBurstDemoQuestions = (): { queuedSilent: number; interrupted: TelegramQuestion | null } => {
    if (!this.view.state) return { queuedSilent: 0, interrupted: null }
    const isDemo = !this.relayUrl && (this.view.state.mode ?? 'demo') === 'demo'
    const ctx = this.buildTriageContext(isDemo)
    const now = Date.now()
    const batch: TelegramQuestion[] = [
      {
        id: `q-burst-p3-${now}-${++this.questionCounter}`,
        sender: '@chatter_dev',
        chatLabel: 'TON Gift Alpha',
        topicName: '#general',
        topicId: 2,
        askedAt: 'Just now',
        text: 'gm everyone, how are vibes in the group this week?',
      },
      {
        id: `q-burst-p2-${now}-${++this.questionCounter}`,
        sender: '@denis_mint',
        chatLabel: 'TON Gift Alpha',
        topicName: '#deals-radar',
        topicId: 22,
        collectionHint: 'Swiss Watch',
        askedAt: 'Just now',
        text: 'Where is the lowest Swiss Watch ask listed?',
      },
      {
        id: `q-burst-p1-${now}-${++this.questionCounter}`,
        sender: '@lena_whale',
        chatLabel: 'TON Gift Alpha',
        topicName: '#floor-watch',
        topicId: 14,
        collectionHint: 'Plush Pepe',
        askedAt: 'Just now',
        text: 'Plush Pepe just got swept — is Portals still cheapest right now?',
      },
    ]

    let queuedSilent = 0
    let interrupted: TelegramQuestion | null = null
    let questions = [...this.view.state.questions]
    let currentScreen = this.view.screen

    for (const raw of batch) {
      const t = triageQuestion(raw, ctx)
      const q: TelegramQuestion = {
        ...raw,
        ...(t.collection && !raw.collectionHint ? { collectionHint: t.collection } : {}),
        priority: t.level,
        triageTags: t.tags,
        replyIntent: t.intent,
      }
      this.seenQuestionIds.add(q.id)
      questions = this.triageQuestions([q, ...questions], isDemo)
      if (this.shouldInterruptScreen(t.level, currentScreen)) {
        const badge = q.topicName ? `${q.chatLabel} · ${q.topicName}` : q.chatLabel
        interrupted = q
        currentScreen = {
          kind: 'heads-up',
          alertId: q.id,
          badge,
          headline: `${q.sender}${q.collectionHint ? ` · ${q.collectionHint}` : ''}`,
          detail: q.text,
          question: q,
          priority: t.level,
          tags: t.tags,
        }
      } else {
        queuedSilent++
      }
    }

    const preservedSelected = questions.find(q => q.id === this.view.selectedQuestion?.id) ?? null
    this.emit({
      state: { ...this.view.state, questions },
      selectedQuestion: interrupted ?? preservedSelected ?? questions[0] ?? null,
      screen: currentScreen,
    })
    return { queuedSilent, interrupted }
  }

  openPending = () => {
    const state = this.view.state
    if (!state?.enabled) {
      this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
      return
    }
    if (!state.group) {
      this.emit({ screen: { kind: 'notice', reason: 'group' } })
      return
    }
    const isDemo = !this.relayUrl && (state.mode ?? 'demo') === 'demo'
    const summary = summarizePending(state.questions, this.buildTriageContext(isDemo))
    this.emit({ screen: { kind: 'pending', summary } })
  }

  simulateIncomingQuestion = (): TelegramQuestion | null => {
    if (!this.view.state) return null
    const template = DEMO_QUESTION_POOL[this.questionCounter++ % DEMO_QUESTION_POOL.length]!
    const created: TelegramQuestion = {
      ...template,
      id: `q-sim-${Date.now()}-${this.questionCounter}`,
      askedAt: 'Just now',
    }
    const questions = [created, ...this.view.state.questions]
    this.emit({
      state: { ...this.view.state, questions },
      selectedQuestion: created,
      screen: { kind: 'questions', index: 0 },
    })
    return created
  }

  pushWatchDigestAlert = (
    collection: string,
    observedPrice: number,
    thresholdGram: number,
    simulated = false,
  ) => {
    if (!this.view.state) return
    const alert: TelegramDigestItem = {
      id: `watch-${Date.now()}-${++this.requestCounter}`,
      channel: simulated ? 'Price Watch (Demo)' : 'Price Watch Alert',
      headline: `${collection} ask hit ${observedPrice} GRAM (≤ ${thresholdGram} GRAM)`,
      summary: simulated
        ? `Simulated watch trigger. Open 24h chart or save alert to Saved Messages.`
        : `Observed listing floor crossed watch threshold. Open 24h chart or save alert to Saved Messages.`,
      collection,
      floorGram: observedPrice,
      timestamp: 'Just now',
      kind: 'watch-hit',
    }
    this.localWatchAlerts = [alert, ...this.localWatchAlerts].slice(0, 15)
    const currentDigest = this.view.state.digest ?? (this.relayUrl ? [] : INITIAL_DIGEST)
    const digest = [alert, ...currentDigest.filter(d => d.id !== alert.id)]
    this.emit({
      state: { ...this.view.state, digest },
      screen: { kind: 'digest', items: digest, index: 0 },
    })
  }

  openQuestions = () => {
    const state = this.view.state
    const readyNow = Boolean(state?.enabled && state.privateChat && state.group)

    if (this.relayUrl) {
      const gen = this.modeGeneration
      this.emit({ screen: { kind: 'questions', index: 0 } })
      void this.refresh().then(() => {
        if (this.modeGeneration !== gen || this.view.screen.kind !== 'questions') return
        const latest = this.view.state
        if (!latest?.enabled) this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
        else if (!latest.privateChat) this.emit({ screen: { kind: 'notice', reason: 'connect' } })
        else if (!latest.group) this.emit({ screen: { kind: 'notice', reason: 'group' } })
      })
      return
    }

    if (!readyNow) {
      if (!state?.enabled) this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
      else if (!state.privateChat) this.emit({ screen: { kind: 'notice', reason: 'connect' } })
      else this.emit({ screen: { kind: 'notice', reason: 'group' } })
      return
    }
    this.emit({ screen: { kind: 'questions', index: 0 } })
  }

  openQuestion = (question: TelegramQuestion) => {
    this.emit({
      selectedQuestion: question,
      screen: { kind: 'question', question },
    })
  }

  openDigest = () => {
    const items = this.view.state
      ? (this.view.state.digest ?? [])
      : this.relayUrl
        ? [...this.localWatchAlerts]
        : INITIAL_DIGEST
    this.emit({ screen: { kind: 'digest', items, index: 0 } })
  }

  private verifiedSeriesForCollection(collectionName: string, allowSynthetic: boolean): CompanionFloorSeries | null {
    const snap = this.inspector.getSnapshot()
    if (snap.mode === 'chart' && snap.status === 'ready' && snap.range === '7d' && snap.collection === collectionName) {
      if (allowSynthetic || this.hasLiveHistorySource()) {
        return snap.series
      }
    }
    return null
  }

  private questionExpectedCollection(question: TelegramQuestion): string | null {
    return question.collectionHint ?? detectQuestionCollection(question.text, this.getCatalog(), null)
  }

  private currentComposeId(): string | null {
    const screen = this.view.screen
    if (screen.kind !== 'compose') return null
    const draft = screen.drafts[screen.index]
    if (!draft) return null
    return `${screen.composeSessionId ?? 0}:${screen.question.id}:${draft.id}:${screen.index}`
  }

  openCompose = (explicitQuestion?: TelegramQuestion): boolean => {
    const state = this.view.state
    if (!state?.enabled) {
      this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
      return false
    }
    if (!state.privateChat) {
      this.emit({ screen: { kind: 'notice', reason: 'connect' } })
      return false
    }
    if (!state.group) {
      this.emit({ screen: { kind: 'notice', reason: 'group' } })
      return false
    }
    const candidate = explicitQuestion ?? this.view.selectedQuestion ?? state.questions[0]
    if (!candidate) {
      this.emit({ screen: { kind: 'notice', reason: 'empty' } })
      return false
    }
    const question = state.questions.find(q => q.id === candidate.id)
    if (!question) {
      this.emit({ screen: { kind: 'notice', reason: 'changed' } })
      return false
    }
    const isDemo = !this.relayUrl && (state.mode ?? 'demo') === 'demo'
    const catalog = this.getCatalog()
    const focused = this.getFocusedCollection()
    const combinedText = question.contextText ? `${question.text} ${question.contextText}` : question.text
    const resolvedCollection =
      question.collectionHint
      ?? detectQuestionCollection(combinedText, catalog, focused)
      ?? focused
      ?? 'Plush Pepe'

    const intent = question.replyIntent ?? classifyReplyIntent(question.text)
    const drafts = buildSmartReplyDrafts(question, catalog, resolvedCollection, {
      allowSyntheticHistory: isDemo,
      hasLiveCatalog: isDemo ? true : this.hasLiveCatalogSource(),
      series7d: this.verifiedSeriesForCollection(resolvedCollection, isDemo),
      intent,
    })
    const topicSuffix = question.topicName ? ` · ${question.topicName}` : ''
    const composeSessionId = ++this.composeSessionCounter
    const dictation = this.isDictationAvailable()

    if (this.activeAiDraftAbort) {
      this.activeAiDraftAbort.abort()
      this.activeAiDraftAbort = null
    }

    this.emit({
      selectedQuestion: question,
      screen: {
        kind: 'compose',
        composeSessionId,
        question,
        destination: `${state.group.label}${topicSuffix}`,
        destinationId: state.group.id,
        drafts,
        index: 0,
        dictation,
        ...(isDemo ? { askerFeedback: 'seen' as const } : {}),
      },
    })

    // Telegram Live Loop: fire-and-forget 👀 ack + typing/upload_photo indicator on explicit Tap into compose
    const scope = this.captureScope()
    if (scope.relayUrl) {
      const firstDraft = drafts[0]
      const chartKind = firstDraft?.attachSpreadChart ? 'spread' : firstDraft?.attachChart ? 'chart' : 'none'
      void fetch(`${scope.relayUrl}/g2/telegram/ack`, {
        method: 'POST',
        headers: scope.relayHeadersJson,
        body: JSON.stringify({ questionId: question.id, destinationId: state.group.id, chartKind }),
      })
        .then(res => (res.ok ? res.json() : null))
        .then((data: { reaction?: string } | null) => {
          if (this.modeGeneration !== scope.modeGen) return
          const cur = this.view.screen
          if (cur.kind !== 'compose' || cur.composeSessionId !== composeSessionId) return
          if (data?.reaction === 'set') {
            this.emit({ screen: { ...cur, askerFeedback: 'seen' } })
          }
        })
        .catch(() => {})
    }

    // Optional AI reply draft (strictly number-grounded, appended at END so index 0 and composeId never shift)
    if (dictation) {
      const aiAbort = new AbortController()
      this.activeAiDraftAbort = aiAbort
      void buildAiReplyDraft(question, drafts, aiAbort.signal)
        .then(aiResult => {
          if (this.activeAiDraftAbort === aiAbort) this.activeAiDraftAbort = null
          if (!aiResult || aiAbort.signal.aborted) return
          const cur = this.view.screen
          if (cur.kind !== 'compose' || cur.composeSessionId !== composeSessionId) return
          if (cur.drafts.some(d => d.id === 'ai-draft')) return
          const providerLabel = aiResult.provider.charAt(0).toUpperCase() + aiResult.provider.slice(1)
          const aiDraft: TelegramSmartDraft = {
            id: 'ai-draft',
            label: `AI draft (${providerLabel})`,
            collection: resolvedCollection,
            text: aiResult.text,
          }
          this.emit({ screen: { ...cur, drafts: [...cur.drafts, aiDraft] } })
        })
        .catch(() => {
          if (this.activeAiDraftAbort === aiAbort) this.activeAiDraftAbort = null
        })
    }

    return true
  }

  applyVoiceReply = (spokenText: string, expectedComposeId?: string): boolean => {
    const screen = this.view.screen
    if (screen.kind !== 'compose') return false
    if (expectedComposeId && this.currentComposeId() !== expectedComposeId) return false
    const clean = spokenText.trim()
    if (!clean) return false
    const lower = clean.toLowerCase()

    if (lower === 'next draft') {
      const next = (screen.index + 1) % Math.max(1, screen.drafts.length)
      this.emit({ screen: { ...screen, index: next } })
      return true
    }
    if (lower === 'previous draft') {
      const prev = (screen.index - 1 + screen.drafts.length) % Math.max(1, screen.drafts.length)
      this.emit({ screen: { ...screen, index: prev } })
      return true
    }
    if (lower === 'send reply') {
      const focusedDraft = screen.drafts[screen.index]
      if (
        !focusedDraft
        || focusedDraft.id.startsWith('dictated-')
        || focusedDraft.id === 'ai-draft'
        || focusedDraft.id.startsWith('phone-custom-')
      ) {
        // Free-form dictated, AI-generated, or custom drafts ALWAYS require an explicit physical Tap to send.
        return false
      }
      this.activate()
      return true
    }
    if (lower.includes('spread') || lower.includes('venue')) {
      const idx = screen.drafts.findIndex(d => d.id === 'venue-spread')
      if (idx >= 0) {
        this.emit({ screen: { ...screen, index: idx } })
        return true
      }
    }
    if (lower.includes('chart') || lower.includes('floor') || lower.includes('seven') || lower.includes('7d')) {
      const idx = screen.drafts.findIndex(d => d.id === 'floor-chart' || d.id === 'floor-quote')
      if (idx >= 0) {
        this.emit({ screen: { ...screen, index: idx } })
        return true
      }
    }
    if (lower.includes('daily') || lower.includes('yesterday') || lower.includes('close')) {
      const idx = screen.drafts.findIndex(d => d.id === 'daily-delta')
      if (idx >= 0) {
        this.emit({ screen: { ...screen, index: idx } })
        return true
      }
    }
    if (lower.includes('checking') || lower.includes('listing')) {
      const idx = screen.drafts.findIndex(d => d.id === 'quick-ack')
      if (idx >= 0) {
        this.emit({ screen: { ...screen, index: idx } })
        return true
      }
    }
    return false
  }

  private insertCustomDraft(rawText: string, idPrefix: 'phone-custom-' | 'dictated-', label: string): boolean {
    const screen = this.view.screen
    if (screen.kind !== 'compose') return false
    const clean = rawText
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200d\ufe0e\ufe0f]/gu, '')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 280)
    if (!clean) return false
    const formatted = clean[0]!.toUpperCase() + clean.slice(1) + (/[.!?]$/.test(clean) ? '' : '.')
    const customDraft: TelegramSmartDraft = {
      id: `${idPrefix}${++this.requestCounter}`,
      label,
      collection: screen.drafts[0]?.collection,
      text: formatted,
    }
    const nextDrafts = [customDraft, ...screen.drafts.filter(d => !d.id.startsWith(idPrefix))]
    this.emit({ screen: { ...screen, drafts: nextDrafts, index: 0 } })
    return true
  }

  applyCustomNote = (noteText: string): boolean => {
    return this.insertCustomDraft(noteText, 'phone-custom-', 'Custom note')
  }

  applyDictatedReply = (dictatedText: string, expectedComposeId?: string): boolean => {
    const screen = this.view.screen
    if (screen.kind !== 'compose') return false
    if (expectedComposeId && this.currentComposeId() !== expectedComposeId) return false
    return this.insertCustomDraft(dictatedText, 'dictated-', 'Dictated')
  }

  step = (direction: -1 | 1) => {
    const { screen, state } = this.view
    if (screen.kind === 'pending') {
      const questions = state?.questions ?? []
      if (questions.length > 0) {
        this.emit({ screen: { kind: 'questions', index: 0 } })
      }
      return
    }
    if (screen.kind === 'questions') {
      const questions = state?.questions ?? []
      const next = screen.index + direction
      if (questions[next]) this.emit({ screen: { kind: 'questions', index: next } })
      return
    }
    if (screen.kind === 'compose') {
      const next = screen.index + direction
      if (screen.drafts[next]) this.emit({ screen: { ...screen, index: next } })
      return
    }
    if (screen.kind === 'digest') {
      const next = screen.index + direction
      if (screen.items[next]) this.emit({ screen: { ...screen, index: next } })
    }
  }

  activate = () => {
    const { screen, state } = this.view
    if (screen.kind === 'pending') {
      if (screen.summary.topQuestion) this.openCompose(screen.summary.topQuestion)
      else this.openQuestions()
      return
    }
    if (screen.kind === 'heads-up') {
      if (screen.question) this.openCompose(screen.question)
      else this.openQuestions()
      return
    }
    if (screen.kind === 'questions') {
      const q = state?.questions[screen.index]
      if (!q) {
        this.emit({ screen: { kind: 'notice', reason: 'empty' } })
        return
      }
      this.openQuestion(q)
      return
    }
    if (screen.kind === 'question') {
      this.openCompose(screen.question)
      return
    }
    if (screen.kind === 'compose') {
      const draft = screen.drafts[screen.index]
      if (draft) void this.sendSmartDraft(screen.question, screen.destination, screen.destinationId, draft)
      return
    }
    if (screen.kind === 'digest') {
      const item = screen.items[screen.index]
      if (item && state?.privateChat) {
        void this.sendDigestBookmark(item, state.privateChat)
      } else {
        this.back()
      }
      return
    }
    if (screen.kind === 'confirm') {
      void this.commitChartConfirm(screen)
      return
    }
    if (screen.kind === 'result' || screen.kind === 'notice') {
      this.back()
    }
  }

  back = () => {
    const { screen, state, receipt } = this.view
    if (screen.kind === 'result') {
      const dismissedRequestId = screen.requestId ?? receipt?.requestId
      const dismissedSeq = screen.seq ?? (receipt?.requestId === dismissedRequestId ? (receipt?.seq ?? 0) : 0)
      const key = this.receiptStorageKey()
      const stored = readJson<TelegramReceipt | null>(key, null)

      if (dismissedRequestId && stored && stored.requestId === dismissedRequestId) {
        const toWrite: TelegramReceipt = { ...stored, reviewed: true }
        writeJson(key, toWrite)
        this.emit({ receipt: toWrite, screen: { kind: 'idle' } })
        return
      }

      if (
        dismissedRequestId
        && receipt
        && receipt.requestId === dismissedRequestId
        && (!stored || dismissedSeq > (stored.seq ?? 0))
      ) {
        const toWrite: TelegramReceipt = { ...receipt, reviewed: true }
        writeJson(key, toWrite)
        this.emit({ receipt: toWrite, screen: { kind: 'idle' } })
        return
      }

      this.emit({
        ...(stored ? { receipt: stored } : {}),
        screen: { kind: 'idle' },
      })
      return
    }
    if (screen.kind === 'compose') {
      if (this.activeAiDraftAbort) {
        this.activeAiDraftAbort.abort()
        this.activeAiDraftAbort = null
      }
      this.emit({ screen: { kind: 'question', question: screen.question } })
      return
    }
    if (screen.kind === 'question') {
      const idx = Math.max(0, state?.questions.findIndex(q => q.id === screen.question.id) ?? 0)
      this.emit({ screen: { kind: 'questions', index: idx } })
      return
    }
    this.emit({ screen: { kind: 'idle' } })
  }

  cancelDraft = () => {
    if (this.activeAiDraftAbort) {
      this.activeAiDraftAbort.abort()
      this.activeAiDraftAbort = null
    }
    if (this.view.screen.kind !== 'idle') this.emit({ screen: { kind: 'idle' } })
  }

  share = (target: TelegramShareTarget): boolean => {
    if (target === 'smart-draft') return this.openCompose()
    const { state, selectedQuestion } = this.view
    if (!state?.enabled) {
      this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
      return false
    }
    if (!state.privateChat) {
      this.emit({ screen: { kind: 'notice', reason: 'connect' } })
      return false
    }
    const destination = target === 'private' ? state.privateChat : state.group
    if (!destination) {
      this.emit({ screen: { kind: 'notice', reason: 'group' } })
      return false
    }
    if (target !== 'private' && !selectedQuestion) {
      this.emit({ screen: { kind: 'notice', reason: 'question' } })
      return false
    }
    const snap = this.inspector.getSnapshot()
    if (snap.mode !== 'chart' || snap.status !== 'ready') {
      this.emit({ screen: { kind: 'notice', reason: 'chart' } })
      return false
    }
    const isDemo = !this.relayUrl && (state.mode ?? 'demo') === 'demo'
    if (!isDemo && !this.hasLiveHistorySource()) {
      this.emit({ screen: { kind: 'notice', reason: 'chart' } })
      return false
    }
    if (target !== 'private' && selectedQuestion) {
      const expectedCollection = this.questionExpectedCollection(selectedQuestion)
      if (!expectedCollection || expectedCollection !== snap.collection) {
        this.emit({ screen: { kind: 'notice', reason: 'changed' } })
        return false
      }
    }
    if (target === 'comparison') {
      if (!selectedQuestion || !isTelegramDailyComparison(snap.range, snap.last, snap.lastTime, snap.comparison)) {
        this.emit({ screen: { kind: 'notice', reason: 'comparison' } })
        return false
      }
      this.emit({
        screen: {
          kind: 'confirm',
          destination: destination.label,
          destinationId: destination.id,
          questionId: selectedQuestion.id,
          collection: snap.collection,
          range: snap.range,
          last: snap.last,
          lastTime: snap.lastTime,
          reply: true,
          comparison: { ...snap.comparison },
        },
      })
      return true
    }
    this.emit({
      screen: {
        kind: 'confirm',
        destination: destination.label,
        destinationId: destination.id,
        questionId: target === 'reply' ? selectedQuestion?.id : undefined,
        collection: snap.collection,
        range: snap.range,
        last: snap.last,
        lastTime: snap.lastTime,
        approvedFrame: snap.frame,
        reply: target === 'reply',
      },
    })
    return true
  }

  private recordSentInScope(
    scope: StorageScope,
    entry: Omit<SentTelegramLogItem, 'id' | 'seq' | 'sentAt' | 'status'>,
    status: TelegramDeliveryStatus,
    requestId: string,
    seq: number,
    options?: { questionId?: string; reason?: 'missing_reply' },
  ) {
    const sentAt = new Date().toISOString()
    if (options?.questionId) {
      this.requestQuestions.set(requestId, options.questionId)
    }
    const candidateReceipt: TelegramReceipt = {
      requestId,
      seq,
      destination: entry.destination,
      status,
      summary: entry.text,
      sentAt,
      ...(options?.questionId ? { questionId: options.questionId } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
      reviewed: false,
    }
    const logItem: SentTelegramLogItem = {
      ...entry,
      id: requestId,
      seq,
      sentAt,
      status,
    }

    const storedLog = readJson<SentTelegramLogItem[]>(scope.sentLogKey, [])
    const sameActiveStorage = this.receiptStorageKey() === scope.receiptKey
    const combined = [
      logItem,
      ...storedLog.filter(item => item.id !== requestId),
      ...(sameActiveStorage
        ? this.view.sentLog.filter(item => item.id !== requestId && !storedLog.some(s => s.id === item.id))
        : []),
    ]
    combined.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    const nextLog = combined.slice(0, 25)
    writeJson(scope.sentLogKey, nextLog)

    const existingStoredReceipt = readJson<TelegramReceipt | null>(scope.receiptKey, null)
    const isNewestReceipt =
      !existingStoredReceipt?.seq
      || seq > existingStoredReceipt.seq
      || existingStoredReceipt.requestId === requestId
    const effectiveReceipt = isNewestReceipt ? candidateReceipt : existingStoredReceipt!
    if (isNewestReceipt) {
      writeJson(scope.receiptKey, candidateReceipt)
    }

    if (sameActiveStorage && this.modeGeneration !== scope.modeGen) {
      this.emit({
        sentLog: nextLog,
        ...(isNewestReceipt ? { receipt: effectiveReceipt } : {}),
      })
    }

    return { receipt: effectiveReceipt, nextLog, isNewestReceipt }
  }

  private settledSendScreen(
    seq: number,
    isNewestReceipt: boolean,
    resultScreen: Extract<TelegramScreen, { kind: 'result' }>,
  ): { screen?: TelegramScreen } {
    if (this.activeSendingSeq !== seq) return {}
    if (isNewestReceipt) return { screen: resultScreen }
    if (this.view.screen.kind === 'sending') return { screen: { kind: 'idle' } }
    return {}
  }

  private async renderAttached7dChartPng(
    collectionName: string,
    allowSynthetic: boolean,
  ): Promise<{ pngBytes: Uint8Array; last: number; lastTime: number } | null> {
    try {
      const series =
        this.verifiedSeriesForCollection(collectionName, allowSynthetic)
        ?? (allowSynthetic ? buildBundledFloorSeries(collectionName, '7d') : null)
      const lastPoint = series?.points.at(-1)
      if (!series || !lastPoint) return null
      const pixels = renderFloorChart(series)
      const pngBytes = await encodeFrame(pixels)
      return { pngBytes, last: lastPoint.price, lastTime: lastPoint.time }
    } catch {
      return null
    }
  }

  private async renderAttachedSpreadChartPng(
    collectionName: string,
  ): Promise<{ pngBytes: Uint8Array; bestPrice: number } | null> {
    try {
      const floors = this.getCatalog()?.collection_floors[collectionName]
      const quotes = getVenueQuotes(floors)
      if (quotes.length < 2) return null
      const pixels = renderSpreadChart(quotes)
      const pngBytes = await encodeFrame(pixels)
      return { pngBytes, bestPrice: quotes[0]!.price }
    } catch {
      return null
    }
  }

  sendToolCardToTelegram = async (opts: {
    title: string
    text: string
    collection?: string
    attachKind?: '7d' | 'spread'
    target?: 'private' | 'group'
  }): Promise<TelegramDeliveryStatus> => {
    const { state } = this.view
    if (!state?.enabled) {
      this.emit({ screen: { kind: 'notice', reason: 'unavailable' } })
      return 'failed'
    }
    const targetKind = opts.target ?? 'private'
    const destinationObj = targetKind === 'group' ? state.group : state.privateChat
    if (!destinationObj) {
      this.emit({ screen: { kind: 'notice', reason: targetKind === 'group' ? 'group' : 'connect' } })
      return 'failed'
    }

    const scope = this.captureScope()
    const { requestId, seq } = this.nextRequest('tool')
    this.activeSendingSeq = seq
    this.emit({ screen: { kind: 'sending', destination: destinationObj.label, smartReply: true } })
    const isDemo = !scope.isRelay

    let pngBytes: Uint8Array | null = null
    let lastPrice = 0
    let lastTime = Math.floor(Date.now() / 1000)
    if (opts.attachKind === '7d' && opts.collection && (isDemo || this.hasLiveHistorySource())) {
      const rendered = await this.renderAttached7dChartPng(opts.collection, isDemo || this.hasLiveHistorySource())
      if (rendered) {
        pngBytes = rendered.pngBytes
        lastPrice = rendered.last
        lastTime = rendered.lastTime
      }
    } else if (opts.attachKind === 'spread' && opts.collection && (isDemo || this.hasLiveCatalogSource())) {
      const rendered = await this.renderAttachedSpreadChartPng(opts.collection)
      if (rendered) {
        pngBytes = rendered.pngBytes
        lastPrice = rendered.bestPrice
      }
    }

    const needsSnapshotTag = !isDemo && !this.hasLiveCatalogSource() && !/\(snapshot/i.test(opts.text)
    const omittedChartNote = opts.attachKind && !pngBytes && !isDemo ? ' (chart omitted: snapshot mode)' : ''
    const fullText = `[${opts.title}]${needsSnapshotTag ? ' (snapshot)' : ''} ${opts.text}${omittedChartNote}`

    let status: TelegramDeliveryStatus = 'sent'
    let reason: 'missing_reply' | undefined

    if (scope.relayUrl) {
      try {
        if (pngBytes && opts.collection) {
          const res = await fetch(`${scope.relayUrl}/g2/telegram/send`, {
            method: 'POST',
            headers: scope.relayHeadersJson,
            body: JSON.stringify({
              requestId,
              targetKind,
              destinationId: destinationObj.id,
              collection: opts.collection,
              range: opts.attachKind === 'spread' ? 'spread' : '7d',
              chartKind: opts.attachKind,
              last: lastPrice,
              lastTime,
              caption: fullText,
              includeInlineActions: true,
              pngBase64: bytesToBase64(pngBytes),
            }),
          })
          const parsed = await this.parseRelayReceipt(res)
          status = parsed.status
          reason = parsed.reason
        } else {
          const res = await fetch(`${scope.relayUrl}/g2/telegram/reply`, {
            method: 'POST',
            headers: scope.relayHeadersJson,
            body: JSON.stringify({
              requestId,
              targetKind,
              destinationId: destinationObj.id,
              text: fullText,
              collection: opts.collection ?? null,
              includeInlineActions: Boolean(opts.collection),
            }),
          })
          const parsed = await this.parseRelayReceipt(res)
          status = parsed.status
          reason = parsed.reason
        }
      } catch {
        status = 'unknown'
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 140))
    }

    const { receipt, nextLog, isNewestReceipt } = this.recordSentInScope(
      scope,
      {
        destination: destinationObj.label,
        text: fullText,
        attachedChart: Boolean(pngBytes),
      },
      status,
      requestId,
      seq,
      { reason },
    )
    if (this.modeGeneration === scope.modeGen) {
      this.emit({
        receipt,
        sentLog: nextLog,
        ...this.settledSendScreen(seq, isNewestReceipt, {
          kind: 'result',
          requestId,
          seq,
          status,
          destination: destinationObj.label,
          ...(reason ? { reason } : {}),
        }),
      })
    }
    return status
  }

  private async sendSmartDraft(
    question: TelegramQuestion,
    destination: string,
    destinationId: string,
    draft: TelegramSmartDraft,
  ) {
    const scope = this.captureScope()
    const { requestId, seq } = this.nextRequest('reply')
    this.activeSendingSeq = seq
    this.emit({ screen: { kind: 'sending', destination, smartReply: true } })
    const isDemo = !scope.isRelay

    let chartAttachment: { pngBytes: Uint8Array; last: number; lastTime: number; kind: '7d' | 'spread' } | null = null
    if (draft.attachChart || draft.attachSpreadChart) {
      if (draft.attachChart && draft.collection) {
        const c7 = await this.renderAttached7dChartPng(draft.collection, isDemo)
        if (c7) chartAttachment = { ...c7, kind: '7d' }
      } else if (draft.attachSpreadChart && draft.collection && (isDemo || this.hasLiveCatalogSource())) {
        const sp = await this.renderAttachedSpreadChartPng(draft.collection)
        if (sp) chartAttachment = { pngBytes: sp.pngBytes, last: sp.bestPrice, lastTime: Math.floor(Date.now() / 1000), kind: 'spread' }
      }
      if (!chartAttachment) {
        const { receipt, nextLog, isNewestReceipt } = this.recordSentInScope(
          scope,
          {
            destination,
            topic: question.topicName,
            replyToSender: question.sender,
            text: draft.text,
            attachedChart: false,
          },
          'failed',
          requestId,
          seq,
          { questionId: question.id },
        )
        if (this.modeGeneration === scope.modeGen) {
          this.emit({
            receipt,
            sentLog: nextLog,
            ...this.settledSendScreen(seq, isNewestReceipt, {
              kind: 'result',
              requestId,
              seq,
              status: 'failed',
              destination,
            }),
          })
        }
        return
      }
    }

    let status: TelegramDeliveryStatus = 'sent'
    let reason: 'missing_reply' | undefined

    if (scope.relayUrl) {
      try {
        if (chartAttachment && draft.collection) {
          const res = await fetch(`${scope.relayUrl}/g2/telegram/send`, {
            method: 'POST',
            headers: scope.relayHeadersJson,
            body: JSON.stringify({
              requestId,
              destinationId,
              questionId: question.id,
              collection: draft.collection,
              range: chartAttachment.kind === 'spread' ? 'spread' : '7d',
              chartKind: chartAttachment.kind,
              last: chartAttachment.last,
              lastTime: chartAttachment.lastTime,
              caption: draft.text,
              includeInlineActions: true,
              pngBase64: bytesToBase64(chartAttachment.pngBytes),
            }),
          })
          const parsed = await this.parseRelayReceipt(res)
          status = parsed.status
          reason = parsed.reason
        } else {
          const res = await fetch(`${scope.relayUrl}/g2/telegram/reply`, {
            method: 'POST',
            headers: scope.relayHeadersJson,
            body: JSON.stringify({
              requestId,
              destinationId,
              questionId: question.id,
              topicId: question.topicId ?? null,
              text: draft.text,
              collection: draft.collection ?? null,
              includeInlineActions: Boolean(draft.collection),
            }),
          })
          const parsed = await this.parseRelayReceipt(res)
          status = parsed.status
          reason = parsed.reason
        }
      } catch {
        status = 'unknown'
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 180))
    }

    const { receipt, nextLog, isNewestReceipt } = this.recordSentInScope(
      scope,
      {
        destination,
        topic: question.topicName,
        replyToSender: question.sender,
        text: draft.text,
        attachedChart: Boolean(chartAttachment),
      },
      status,
      requestId,
      seq,
      { questionId: question.id, reason },
    )

    if (this.modeGeneration !== scope.modeGen) return

    const remainingQuestions =
      status === 'sent' || reason === 'missing_reply'
        ? (this.view.state?.questions ?? []).filter(q => q.id !== question.id)
        : (this.view.state?.questions ?? [])

    this.emit({
      receipt,
      sentLog: nextLog,
      state: this.view.state ? { ...this.view.state, questions: remainingQuestions } : null,
      selectedQuestion: remainingQuestions[0] ?? null,
      ...this.settledSendScreen(seq, isNewestReceipt, {
        kind: 'result',
        requestId,
        seq,
        status,
        destination,
        ...(reason ? { reason } : {}),
      }),
    })
  }

  private async sendDigestBookmark(item: TelegramDigestItem, privateChat: TelegramDestination) {
    const scope = this.captureScope()
    const { requestId, seq } = this.nextRequest('dm')
    this.activeSendingSeq = seq
    this.emit({ screen: { kind: 'sending', destination: privateChat.label, smartReply: true } })
    const text = `[${item.channel}] ${item.headline} — ${item.summary}`
    let status: TelegramDeliveryStatus = 'sent'
    let reason: 'missing_reply' | undefined

    if (scope.relayUrl) {
      try {
        const res = await fetch(`${scope.relayUrl}/g2/telegram/reply`, {
          method: 'POST',
          headers: scope.relayHeadersJson,
          body: JSON.stringify({
            requestId,
            destinationId: privateChat.id,
            text,
            collection: item.collection ?? null,
          }),
        })
        const parsed = await this.parseRelayReceipt(res)
        status = parsed.status
        reason = parsed.reason
      } catch {
        status = 'unknown'
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 140))
    }

    const { receipt, nextLog, isNewestReceipt } = this.recordSentInScope(
      scope,
      { destination: privateChat.label, text },
      status,
      requestId,
      seq,
      { reason },
    )
    if (this.modeGeneration !== scope.modeGen) return

    this.emit({
      receipt,
      sentLog: nextLog,
      ...this.settledSendScreen(seq, isNewestReceipt, {
        kind: 'result',
        requestId,
        seq,
        status,
        destination: privateChat.label,
        ...(reason ? { reason } : {}),
      }),
    })
  }

  private async commitChartConfirm(confirm: Extract<TelegramScreen, { kind: 'confirm' }>) {
    const scope = this.captureScope()
    const isDemo = !scope.isRelay
    if (!isDemo && !this.hasLiveHistorySource()) {
      this.emit({ screen: { kind: 'notice', reason: 'chart' } })
      return
    }
    if (confirm.reply && confirm.questionId) {
      const targetQuestion = this.view.state?.questions.find(q => q.id === confirm.questionId)
      if (!targetQuestion) {
        this.emit({ screen: { kind: 'notice', reason: 'changed' } })
        return
      }
      const expectedCollection = this.questionExpectedCollection(targetQuestion)
      if (!expectedCollection || expectedCollection !== confirm.collection) {
        this.emit({ screen: { kind: 'notice', reason: 'changed' } })
        return
      }
    }

    const snap = this.inspector.getSnapshot()
    const comparisonMatches = confirm.comparison
      ? Boolean(
          snap.mode === 'chart'
            && snap.status === 'ready'
            && snap.comparison
            && snap.comparison.previous === confirm.comparison.previous
            && snap.comparison.previousTime === confirm.comparison.previousTime,
        )
      : snap.mode === 'chart' && snap.status === 'ready' && snap.frame === confirm.approvedFrame

    if (
      snap.mode !== 'chart'
      || snap.status !== 'ready'
      || snap.collection !== confirm.collection
      || snap.range !== confirm.range
      || snap.last !== confirm.last
      || snap.lastTime !== confirm.lastTime
      || !comparisonMatches
    ) {
      this.emit({ screen: { kind: 'notice', reason: 'changed' } })
      return
    }

    const approvedFrame = confirm.approvedFrame ?? snap.frame
    const { requestId, seq } = this.nextRequest('chart')
    this.activeSendingSeq = seq
    this.emit({
      screen: {
        kind: 'sending',
        destination: confirm.destination,
        comparison: Boolean(confirm.comparison),
      },
    })

    let status: TelegramDeliveryStatus = 'sent'
    let reason: 'missing_reply' | undefined
    if (scope.relayUrl) {
      try {
        const endpoint = confirm.comparison ? '/g2/telegram/send-comparison' : '/g2/telegram/send'
        const res = await fetch(`${scope.relayUrl}${endpoint}`, {
          method: 'POST',
          headers: scope.relayHeadersJson,
          body: JSON.stringify({
            requestId,
            destinationId: confirm.destinationId ?? '',
            destinationLabel: confirm.destination,
            questionId: confirm.questionId ?? null,
            collection: confirm.collection,
            range: confirm.range,
            last: confirm.last,
            lastTime: confirm.lastTime,
            ...(confirm.comparison
              ? confirm.comparison
              : { pngBase64: bytesToBase64(approvedFrame) }),
          }),
        })
        const parsed = await this.parseRelayReceipt(res)
        status = parsed.status
        reason = parsed.reason
      } catch {
        status = 'unknown'
      }
    } else {
      await new Promise(resolve => setTimeout(resolve, 180))
    }

    const summary = confirm.comparison
      ? `${confirm.collection} 7d daily comparison → ${confirm.destination}`
      : `${confirm.collection} (${confirm.range}) floor chart · ${confirm.last} GRAM`

    const { receipt, nextLog, isNewestReceipt } = this.recordSentInScope(
      scope,
      {
        destination: confirm.destination,
        text: summary,
        attachedChart: !confirm.comparison,
      },
      status,
      requestId,
      seq,
      { questionId: confirm.questionId, reason },
    )

    if (this.modeGeneration !== scope.modeGen) return

    const remainingQuestions =
      (status === 'sent' || reason === 'missing_reply') && confirm.questionId
        ? (this.view.state?.questions ?? []).filter(q => q.id !== confirm.questionId)
        : (this.view.state?.questions ?? [])

    this.emit({
      receipt,
      sentLog: nextLog,
      state: this.view.state ? { ...this.view.state, questions: remainingQuestions } : null,
      selectedQuestion: remainingQuestions[0] ?? null,
      ...this.settledSendScreen(seq, isNewestReceipt, {
        kind: 'result',
        requestId,
        seq,
        status,
        destination: confirm.destination,
        ...(reason ? { reason } : {}),
      }),
    })
  }
}
