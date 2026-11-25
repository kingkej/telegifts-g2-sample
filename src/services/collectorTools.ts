import type { CollectionFloorsResponse, CompanionChartRange } from '../contracts/companion.ts'
import type {
  CompanionToolbox,
  CompanionToolContext,
  CompanionToolController,
  CompanionToolName,
  CompanionToolPage,
  CompanionToolSource,
} from '../contracts/tools.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import { formatCompanionPrice, formatMarketChange } from '../lib/format.ts'
import { readJson, writeJson } from '../lib/storage.ts'
import {
  buildBundledFloorSeries,
  DEFAULT_USDT_PER_GRAM,
  getBundledModels,
  getCheapestVenueFloor,
  getCollectionMetrics,
  getCollectionPeriodChange,
  getVenueQuotes,
} from './bundledMarketData.ts'
import { mirrorKeyToEvenHost, subscribeHostStorageHydration } from './evenHostStorage.ts'
import { getLatestTonUsdtSnapshot } from './liveTicker.ts'
import { renderSpreadChart } from '../spreadChart.ts'

export interface PriceWatchRule {
  collection: string
  thresholdGram: number
  presetLabel: string
  createdAt: string
  lastTriggeredFloor?: number
}

export interface WatchlistEntry {
  collection: string
  recordedFloor: number
  addedAt: string
}

export interface TelegramToolDispatch {
  title: string
  text: string
  collection?: string
  attachKind?: '7d' | 'spread'
  target?: 'private' | 'group'
}

export interface CollectorToolDeps {
  getCatalog(): CollectionFloorsResponse | null
  getFavoriteNames(): readonly string[]
  hasLiveCatalog?(): boolean
  getUsdtRate?(): number | null
  getUnreadQuestionCount?(): number
  openChart(collection: string, range: CompanionChartRange): boolean
  openTelegramDigest(): void
  openTelegramQuestions?(): void
  sendTelegramCard?(dispatch: TelegramToolDispatch): Promise<unknown>
  recordVoiceQuestion?(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
  transcribeVoiceQuestion?(pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string | null>
  askGiftiQuestion?(
    question: string,
    focusedCollection: string,
    signal: AbortSignal,
  ): Promise<{ title: string; answer: string; collection: string }>
  onWatchArmed?(rule: PriceWatchRule): void
  onSimulateWatchHit?(rule: PriceWatchRule, observedPrice: number, simulated?: boolean): void
}

export const WATCHLIST_STORAGE_KEY = 'telegifts_g2_watchlist_v1'

const VENUE_SELLER_FEE_PCT: Record<string, number> = {
  Portals: 2.5,
  MRKT: 2.5,
  Tonnel: 3.0,
  Fragment: 5.0,
  Getgems: 5.0,
}

export const SUPPORTED_COLLECTOR_TOOLS = new Set<CompanionToolName>([
  'summary',
  'gifti',
  'watchlist',
  'research',
  'market-note',
  'digest',
  'favorite-movers',
  'spread-radar',
  'threshold',
])

function resolveEffectiveUsdtRate(deps: CollectorToolDeps): number {
  const explicit = deps.getUsdtRate?.()
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  return getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM
}

function resolveCollectionName(catalog: CollectionFloorsResponse | null, candidate?: string): string {
  const names = Object.keys(catalog?.collection_floors ?? {})
  if (candidate?.trim()) {
    const trimmed = candidate.trim()
    if (names.includes(trimmed)) return trimmed
    const key = resolveDeepLinkMatchKey(trimmed)
    const match = names.find(n => resolveDeepLinkMatchKey(n) === key)
    if (match) return match
    return trimmed
  }
  return names.includes('Plush Pepe') ? 'Plush Pepe' : (names[0] ?? 'Plush Pepe')
}

export function computeNetVenueArbitrage(floors: CollectionFloorsResponse['collection_floors'][string] | undefined) {
  const quotes = getVenueQuotes(floors)
  if (quotes.length < 2) return null
  const buy = quotes[0]!
  const sell = quotes[quotes.length - 1]!
  const grossGap = sell.price - buy.price
  const grossPct = (grossGap / buy.price) * 100
  const feePct = VENUE_SELLER_FEE_PCT[sell.marketplace] ?? 3.5
  const netProceeds = sell.price * (1 - feePct / 100)
  const netProfitGram = Number((netProceeds - buy.price).toFixed(2))
  const netRoiPct = Number(((netProfitGram / buy.price) * 100).toFixed(2))
  return {
    buy,
    sell,
    venueCount: quotes.length,
    grossPct: Number(grossPct.toFixed(1)),
    sellerFeePct: feePct,
    netProfitGram,
    netRoiPct,
  }
}

function createMorningBriefController(
  deps: CollectorToolDeps,
  watches: ReadonlyMap<string, PriceWatchRule>,
): CompanionToolController {
  const listeners = new Set<() => void>()
  let index = 0
  let sentNotice: string | null = null

  function notify() {
    for (const listener of listeners) listener()
  }

  function snapshot(): CompanionToolPage {
    const catalog = deps.getCatalog()
    const entries = Object.entries(catalog?.collection_floors ?? {})
    const usdtRate = resolveEffectiveUsdtRate(deps)
    const ticker = getLatestTonUsdtSnapshot()
    const unreadQuestions = deps.getUnreadQuestionCount?.() ?? 0

    let totalHealth = 0
    let totalGreed = 0
    let metricCount = 0
    let topMover = { name: 'Plush Pepe', floor: 4820, change: 6.42, venue: 'Portals' }
    let bestMove = -Infinity
    let topArb: ({ name: string } & NonNullable<ReturnType<typeof computeNetVenueArbitrage>>) | null = null

    for (const [name, floors] of entries) {
      const m = getCollectionMetrics(name)
      if (m) {
        totalHealth += m.healthScore
        totalGreed += m.greedScore
        metricCount++
      }
      const best = getCheapestVenueFloor(floors)
      const chg = getCollectionPeriodChange(name, '24h')
      if (best && chg !== null && chg > bestMove) {
        bestMove = chg
        topMover = { name, floor: best.price, change: chg, venue: best.marketplace }
      }
      const arb = computeNetVenueArbitrage(floors)
      if (arb && (!topArb || arb.netRoiPct > topArb.netRoiPct)) {
        topArb = { name, ...arb }
      }
    }

    const avgHealth = metricCount ? Math.round(totalHealth / metricCount) : 81
    const avgGreed = metricCount ? Math.round(totalGreed / metricCount) : 66
    const explicitRate = deps.getUsdtRate?.()
    const rateSource =
      typeof explicitRate === 'number' && explicitRate !== ticker.usd
        ? 'live'
        : ticker.source
    const isSnapshotCatalog = deps.hasLiveCatalog ? !deps.hasLiveCatalog() : false
    const snapTag = isSnapshotCatalog ? ' (snapshot)' : ''
    const rateLabel = `1 GRAM ≈ $${usdtRate.toFixed(2)} USDT (${rateSource})`

    const cards: CompanionToolPage[] = [
      {
        key: `summary-pulse-${sentNotice ?? 'idle'}-${usdtRate}`,
        title: 'Morning brief · 1/4',
        lines: [
          `Market Pulse${snapTag}: Health ${avgHealth}/100 · Greed ${avgGreed}/100`,
          `${entries.length} gift collections · ${rateLabel}`,
          sentNotice ?? `Moderator queue: ${unreadQuestions} open · ${watches.size} price watches`,
        ],
        actions: [
          { id: 'next', label: 'Next: Top breakout' },
          ...(deps.sendTelegramCard ? [{ id: 'send-brief', label: 'Send brief to Telegram DM' }] : []),
        ],
        browse: {
          open: deps.sendTelegramCard ? 'send-brief' : 'next',
          next: 'next',
          swipeHint: 'Swipe 4-card brief · Tap to DM brief',
        },
      },
      {
        key: `summary-breakout-${topMover.name}`,
        title: 'Morning brief · 2/4',
        lines: [
          `Top 24h Breakout: ${topMover.name}`,
          `Floor: ${formatCompanionPrice(topMover.floor)} GRAM on ${topMover.venue} (${formatMarketChange(topMover.change)})`,
          `Est. $${formatCompanionPrice(Number((topMover.floor * usdtRate).toFixed(2)))} USDT`,
        ],
        actions: [
          { id: 'open-breakout-chart', label: 'Open 7d chart' },
          { id: 'prev', label: 'Previous' },
          { id: 'next', label: 'Next: Arbitrage' },
        ],
        browse: {
          open: 'open-breakout-chart',
          previous: 'prev',
          next: 'next',
          swipeHint: 'Swipe brief · Tap for 7d chart',
        },
        chart: {
          collection: topMover.name,
          series: buildBundledFloorSeries(topMover.name, '7d'),
        },
      },
      {
        key: `summary-arb-${topArb?.name ?? 'none'}`,
        title: 'Morning brief · 3/4',
        lines: topArb
          ? [
              `Best Arbitrage: ${topArb.name}`,
              `Buy ${topArb.buy.marketplace} ${formatCompanionPrice(topArb.buy.price)} → Sell ${topArb.sell.marketplace} ${formatCompanionPrice(topArb.sell.price)} GRAM`,
              topArb.netProfitGram > 0
                ? `Net after ${topArb.sellerFeePct}% fee: +${formatCompanionPrice(topArb.netProfitGram)} GRAM (+${topArb.netRoiPct}%)`
                : `Gross +${topArb.grossPct}% (${formatCompanionPrice(topArb.netProfitGram)} GRAM after ${topArb.sellerFeePct}% fee)`,
            ]
          : ['Arbitrage scan', 'Need 2+ active venues to compute net edge.'],
        actions: [
          ...(topArb ? [{ id: 'open-arb-chart', label: 'Open 7d chart' }] : []),
          { id: 'prev', label: 'Previous' },
          { id: 'next', label: 'Next: Queue & watches' },
        ],
        browse: {
          open: topArb ? 'open-arb-chart' : 'next',
          previous: 'prev',
          next: 'next',
          swipeHint: 'Swipe brief · Tap for 7d chart',
        },
        ...(topArb
          ? {
              chart: {
                collection: topArb.name,
                series: buildBundledFloorSeries(topArb.name, '7d'),
              },
            }
          : {}),
      },
      {
        key: `summary-queue-${unreadQuestions}-${watches.size}`,
        title: 'Morning brief · 4/4',
        lines: [
          `Unread /ask questions: ${unreadQuestions}`,
          `Armed floor watches: ${watches.size}`,
          watches.size > 0
            ? `Active: ${Array.from(watches.keys()).slice(0, 3).join(', ')}`
            : 'Open Watch asking price on any gift to arm a -5% dip alert.',
        ],
        actions: [
          ...(deps.openTelegramQuestions && unreadQuestions > 0 ? [{ id: 'open-questions', label: 'Open Moderator Inbox' }] : []),
          { id: 'open-digest', label: 'Open Channel Digest' },
          { id: 'prev', label: 'Previous' },
        ],
        browse: {
          open: deps.openTelegramQuestions && unreadQuestions > 0 ? 'open-questions' : 'open-digest',
          previous: 'prev',
          swipeHint: 'Swipe brief · Tap to open inbox/digest',
        },
      },
    ]

    return cards[Math.max(0, Math.min(index, cards.length - 1))]!
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open() {
      index = 0
      sentNotice = null
      notify()
    },
    act(id) {
      if (id === 'prev' && index > 0) {
        index--
        notify()
      } else if (id === 'next' && index < 3) {
        index++
        notify()
      } else if (id === 'open-breakout-chart' || id === 'open-arb-chart') {
        const snap = snapshot()
        if (snap.chart) deps.openChart(snap.chart.collection, '7d')
      } else if (id === 'open-questions') {
        deps.openTelegramQuestions?.()
      } else if (id === 'open-digest') {
        deps.openTelegramDigest()
      } else if (id === 'send-brief' && deps.sendTelegramCard) {
        const pulse = snapshot()
        sentNotice = 'Sending morning brief to Saved Messages…'
        notify()
        void deps
          .sendTelegramCard({
            title: 'G2 Morning Brief',
            text: pulse.lines.slice(0, 2).join(' · '),
            target: 'private',
          })
          .then(status => {
            sentNotice =
              status === 'sent'
                ? 'Sent morning brief to Telegram DM.'
                : status === 'unknown'
                  ? 'Delivery unconfirmed — check Telegram.'
                  : 'Could not send brief — check Telegram setup.'
            notify()
          })
          .catch(() => {
            sentNotice = 'Could not send brief — check Telegram setup.'
            notify()
          })
      }
    },
    back: () => false,
    close() {},
  }
}

function answerGiftiQuery(
  rawQuery: string,
  focusedCollection: string,
  deps: CollectorToolDeps,
): { title: string; answer: string; collection: string } {
  const catalog = deps.getCatalog()
  const names = Object.keys(catalog?.collection_floors ?? {})
  const qLower = rawQuery.toLowerCase()
  const matchedName =
    names.find(n => {
      const k = resolveDeepLinkMatchKey(n)
      return k.length >= 4 && resolveDeepLinkMatchKey(rawQuery).includes(k)
    }) ?? focusedCollection

  const floors = catalog?.collection_floors[matchedName]
  const best = getCheapestVenueFloor(floors)
  const usdtRate = resolveEffectiveUsdtRate(deps)
  const change24h = getCollectionPeriodChange(matchedName, '24h')
  const change7d = getCollectionPeriodChange(matchedName, '7d')
  const metrics = getCollectionMetrics(matchedName)
  const arb = computeNetVenueArbitrage(floors)
  const models = getBundledModels(matchedName)

  if (qLower.includes('spread') || qLower.includes('arbitrage') || qLower.includes('venue') || qLower.includes('compare')) {
    if (arb) {
      const edge =
        arb.netProfitGram > 0
          ? `net +${formatCompanionPrice(arb.netProfitGram)} GRAM (+${arb.netRoiPct}%) after ${arb.sellerFeePct}% ${arb.sell.marketplace} fee`
          : `fee-locked (${formatCompanionPrice(arb.netProfitGram)} GRAM after ${arb.sellerFeePct}% fee despite +${arb.grossPct}% gross spread)`
      return {
        title: `Gifti · ${matchedName} Arbitrage`,
        collection: matchedName,
        answer: `${matchedName} trades across ${arb.venueCount} venues: lowest ask ${formatCompanionPrice(arb.buy.price)} GRAM on ${arb.buy.marketplace} vs ${formatCompanionPrice(arb.sell.price)} GRAM on ${arb.sell.marketplace} — ${edge}.`,
      }
    }
  }

  if (qLower.includes('model') || qLower.includes('rare') || qLower.includes('variant') || qLower.includes('tier')) {
    const rarest = [...models].sort((a, b) => (a.rarityPermille ?? 99) - (b.rarityPermille ?? 99))[0]
    const rarestFloor = rarest ? getCheapestVenueFloor(rarest.floors)?.price : null
    const mult = rarestFloor && best ? (rarestFloor / best.price).toFixed(2) : null
    return {
      title: `Gifti · ${matchedName} Rare Tiers`,
      collection: matchedName,
      answer: rarest && rarestFloor
        ? `${matchedName} rarest tracked tier is ${rarest.name} (${rarest.rarityPermille ?? 5}‰ rarity) at ${formatCompanionPrice(rarestFloor)} GRAM${mult ? ` (${mult}× collection floor)` : ''}.`
        : `${matchedName} model tier floors are loading.`,
    }
  }

  if (qLower.includes('whale') || qLower.includes('supply') || qLower.includes('health') || qLower.includes('greed')) {
    const upgPct = metrics ? Math.round((metrics.upgraded / Math.max(1, metrics.emission)) * 100) : 72
    return {
      title: `Gifti · ${matchedName} Fundamentals`,
      collection: matchedName,
      answer: `${matchedName} Health ${metrics?.healthScore ?? 80}/100, Greed ${metrics?.greedScore ?? 65}/100. ${upgPct}% upgraded supply with top-30 whales holding ${metrics?.whaleHoldPercent ?? 15.2}%.`,
    }
  }

  const floorStr = best ? `${formatCompanionPrice(best.price)} GRAM ($${formatCompanionPrice(Number((best.price * usdtRate).toFixed(2)))}) on ${best.marketplace}` : 'unavailable'
  const move24 = change24h !== null ? formatMarketChange(change24h) : 'flat'
  const move7 = change7d !== null ? formatMarketChange(change7d) : 'flat'
  return {
    title: `Gifti · ${matchedName}`,
    collection: matchedName,
    answer: `${matchedName} floor is ${floorStr}. 24h ${move24}, 7d ${move7}${arb ? `, ${arb.venueCount}-venue spread +${arb.grossPct}%` : ''}.`,
  }
}

function createGiftiCopilotController(
  deps: CollectorToolDeps,
): CompanionToolController & { submitPrompt(prompt: string): Promise<void> } {
  const listeners = new Set<() => void>()
  let collection = 'Plush Pepe'
  let topicIndex = 0
  let isOpen = false
  let talkLaunchSeq = 0
  let recordingAbort: AbortController | null = null
  let promptAbort: AbortController | null = null
  let isRecording = false
  let foregroundAvailable = true
  let lastAnswer: { title: string; answer: string; collection: string } | null = null

  const topics = [
    { id: 'momentum', label: 'Floor & 7d momentum', query: 'floor chart momentum' },
    { id: 'arbitrage', label: 'Net-of-fee arbitrage', query: 'venue spread arbitrage' },
    { id: 'fundamentals', label: 'Supply & whale risk', query: 'whale supply health greed' },
    { id: 'rarity', label: 'Rare model floor tiers', query: 'rare model variant tier' },
  ] as const

  function notify() {
    for (const listener of listeners) listener()
  }

  function computeActiveAnswer() {
    if (lastAnswer) return lastAnswer
    return answerGiftiQuery(topics[topicIndex]!.query, collection, deps)
  }

  function cancelVoiceTurn(shouldNotify: boolean) {
    talkLaunchSeq++
    const wasRecording = isRecording
    recordingAbort?.abort()
    recordingAbort = null
    promptAbort?.abort()
    promptAbort = null
    isRecording = false
    if (shouldNotify && wasRecording) notify()
  }

  async function resolveQuestionAnswer(
    question: string,
    signal: AbortSignal,
  ): Promise<{ title: string; answer: string; collection: string }> {
    if (deps.askGiftiQuestion) {
      const res = await deps.askGiftiQuestion(question, collection, signal)
      return {
        title: res.title,
        answer: res.answer,
        collection: resolveCollectionName(deps.getCatalog(), res.collection || collection),
      }
    }
    return answerGiftiQuery(question, collection, deps)
  }

  async function submitPrompt(rawPrompt: string): Promise<void> {
    const trimmed = rawPrompt.trim()
    if (!trimmed) return
    cancelVoiceTurn(false)
    if (!deps.askGiftiQuestion) {
      lastAnswer = answerGiftiQuery(trimmed, collection, deps)
      collection = lastAnswer.collection
      notify()
      return
    }
    const abort = new AbortController()
    promptAbort = abort
    lastAnswer = {
      title: `Gifti · Thinking…`,
      collection,
      answer: `Analyzing "${trimmed.slice(0, 72)}" across 5 TON marketplaces…`,
    }
    notify()
    try {
      const resolved = await resolveQuestionAnswer(trimmed, abort.signal)
      if (abort.signal.aborted || promptAbort !== abort) return
      promptAbort = null
      lastAnswer = resolved
      collection = resolved.collection
      notify()
    } catch {
      if (!abort.signal.aborted && promptAbort === abort) {
        promptAbort = null
        lastAnswer = {
          title: `Gifti · ${collection}`,
          collection,
          answer: 'Could not reach Gifti right now — please try again.',
        }
        notify()
      }
    }
  }

  function startVoiceTurn(expectedSeq?: number) {
    if (!isOpen || !foregroundAvailable || !deps.recordVoiceQuestion) return
    if (expectedSeq !== undefined && expectedSeq !== talkLaunchSeq) return
    recordingAbort?.abort()
    promptAbort?.abort()
    promptAbort = null
    const abort = new AbortController()
    recordingAbort = abort
    isRecording = true
    notify()

    void deps
      .recordVoiceQuestion(abort.signal)
      .then(async pcm => {
        if (abort.signal.aborted || recordingAbort !== abort) return
        const spoken = deps.transcribeVoiceQuestion ? await deps.transcribeVoiceQuestion(pcm, abort.signal) : null
        if (abort.signal.aborted || recordingAbort !== abort) return
        isRecording = false
        const trimmed = spoken?.trim() ?? ''
        if (!trimmed) {
          recordingAbort = null
          lastAnswer = {
            title: `Gifti · ${collection}`,
            collection,
            answer: "Didn't catch a recognized question — try 'arbitrage', 'rare models', 'whale risk', or 'floor momentum'.",
          }
          notify()
          return
        }
        const resolved = await resolveQuestionAnswer(trimmed, abort.signal)
        if (abort.signal.aborted || recordingAbort !== abort) return
        recordingAbort = null
        lastAnswer = resolved
        collection = resolved.collection
        notify()
      })
      .catch(() => {
        if (recordingAbort === abort) {
          recordingAbort = null
          isRecording = false
          notify()
        }
      })
  }

  function snapshot(): CompanionToolPage {
    const active = computeActiveAnswer()
    if (isRecording) {
      return {
        key: 'gifti-recording',
        title: active.title,
        lines: [active.answer, 'Listening on G2 microphone…'],
        actions: [{ id: 'show-chart', label: 'Show 7d chart' }],
      }
    }

    const promptLabel = topics[topicIndex]!.label
    return {
      key: `gifti-${active.collection}-${topicIndex}-${lastAnswer ? 'voice' : 'preset'}`,
      title: `${active.title} · ${topicIndex + 1}/${topics.length}`,
      lines: [
        `Topic: ${promptLabel}`,
        active.answer,
      ],
      actions: [
        { id: 'show-chart', label: 'Open 7d chart' },
        ...(topicIndex > 0 ? [{ id: 'prev', label: 'Previous topic' }] : []),
        ...(topicIndex < topics.length - 1 ? [{ id: 'next', label: 'Next topic' }] : []),
        ...(deps.recordVoiceQuestion ? [{ id: 'ask-voice', label: 'Ask via G2 mic' }] : []),
        ...(deps.sendTelegramCard ? [{ id: 'send-dm', label: 'Send to Telegram DM' }] : []),
      ],
      browse: {
        open: 'show-chart',
        previous: topicIndex > 0 ? 'prev' : undefined,
        next: topicIndex < topics.length - 1 ? 'next' : undefined,
        swipeHint: 'Swipe Gifti insights · Tap for 7d chart',
      },
      chart: {
        collection: active.collection,
        series: buildBundledFloorSeries(active.collection, '7d'),
      },
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(ctx) {
      isOpen = true
      collection = resolveCollectionName(deps.getCatalog(), ctx?.collection)
      topicIndex = 0
      lastAnswer = null
      isRecording = false
      const seq = ++talkLaunchSeq
      if (ctx?.entry === 'talk' && deps.recordVoiceQuestion && foregroundAvailable) {
        notify()
        queueMicrotask(() => startVoiceTurn(seq))
      } else {
        notify()
      }
    },
    act(id) {
      if (id === 'prev' && topicIndex > 0) {
        lastAnswer = null
        topicIndex--
        notify()
      } else if (id === 'next' && topicIndex < topics.length - 1) {
        lastAnswer = null
        topicIndex++
        notify()
      } else if (id === 'show-chart') {
        const active = computeActiveAnswer()
        deps.openChart(active.collection, '7d')
      } else if (id === 'ask-voice') {
        startVoiceTurn()
      } else if (id === 'send-dm' && deps.sendTelegramCard) {
        const active = computeActiveAnswer()
        void deps.sendTelegramCard({
          title: active.title,
          text: active.answer,
          collection: active.collection,
          attachKind: '7d',
          target: 'private',
        })
      }
    },
    back: () => {
      if (isRecording) {
        cancelVoiceTurn(true)
        return true
      }
      return false
    },
    suspend() {
      cancelVoiceTurn(true)
    },
    setForegroundAvailable(visible) {
      foregroundAvailable = visible
      if (!visible) cancelVoiceTurn(true)
    },
    close() {
      isOpen = false
      cancelVoiceTurn(false)
    },
    submitPrompt,
  }
}

function createWatchlistController(
  deps: CollectorToolDeps,
  getWatchlist: () => WatchlistEntry[],
  setWatchlist: (next: WatchlistEntry[]) => void,
): CompanionToolController {
  const listeners = new Set<() => void>()
  let index = 0
  let focused = ''

  function notify() {
    for (const listener of listeners) listener()
  }

  function snapshot(): CompanionToolPage {
    const list = getWatchlist()
    const catalog = deps.getCatalog()
    const usdtRate = resolveEffectiveUsdtRate(deps)

    if (!list.length) {
      return {
        key: 'watchlist-empty',
        title: 'Watchlist valuation',
        lines: [
          'No collections in watchlist yet.',
          focused ? `Tap below to add ${focused} at current floor.` : 'Open a collection to record its entry floor.',
        ],
        actions: focused ? [{ id: 'add-to-watchlist', label: `Add ${focused} to Watchlist` }] : [],
      }
    }

    const safeIdx = Math.max(0, Math.min(index, list.length - 1))
    const item = list[safeIdx]!
    const currentFloor = getCheapestVenueFloor(catalog?.collection_floors[item.collection])?.price ?? item.recordedFloor
    const deltaPct = item.recordedFloor > 0 ? ((currentFloor - item.recordedFloor) / item.recordedFloor) * 100 : 0

    const totalGram = list.reduce((sum, entry) => {
      const f = getCheapestVenueFloor(catalog?.collection_floors[entry.collection])?.price ?? entry.recordedFloor
      return sum + f
    }, 0)
    const totalUsdt = Number((totalGram * usdtRate).toFixed(2))
    const focusedInList = focused ? list.some(e => e.collection === focused) : false

    return {
      key: `watchlist-${item.collection}-${safeIdx}-${item.recordedFloor}`,
      title: `Watchlist · ${safeIdx + 1}/${list.length}`,
      lines: [
        `${item.collection}: ${formatCompanionPrice(currentFloor)} GRAM ($${formatCompanionPrice(Number((currentFloor * usdtRate).toFixed(2)))})`,
        `Recorded baseline: ${formatCompanionPrice(item.recordedFloor)} GRAM (${formatMarketChange(Number(deltaPct.toFixed(2)))})`,
        `Total (${list.length}): ${formatCompanionPrice(Number(totalGram.toFixed(2)))} GRAM (≈ $${formatCompanionPrice(totalUsdt)})`,
      ],
      actions: [
        { id: 'open-chart', label: 'Open 7d chart' },
        ...(safeIdx > 0 ? [{ id: 'prev', label: 'Previous' }] : []),
        ...(safeIdx < list.length - 1 ? [{ id: 'next', label: 'Next' }] : []),
        { id: 'record-floor', label: 'Record current floor' },
        ...(focused && !focusedInList ? [{ id: 'add-to-watchlist', label: `Add ${focused}` }] : []),
        { id: 'remove-current', label: `Remove ${item.collection}` },
        ...(deps.sendTelegramCard ? [{ id: 'send-dm', label: 'Send valuation to Telegram DM' }] : []),
      ],
      browse: {
        open: 'open-chart',
        previous: safeIdx > 0 ? 'prev' : undefined,
        next: safeIdx < list.length - 1 ? 'next' : undefined,
        swipeHint: 'Swipe watchlist · Tap for 7d chart',
      },
      chart: {
        collection: item.collection,
        series: buildBundledFloorSeries(item.collection, '7d'),
      },
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(ctx) {
      const catalog = deps.getCatalog()
      focused = ctx?.collection ? resolveCollectionName(catalog, ctx.collection) : ''
      const list = getWatchlist()
      if (focused) {
        const found = list.findIndex(e => e.collection === focused)
        if (found >= 0) index = found
      }
      index = Math.max(0, Math.min(index, Math.max(0, list.length - 1)))
      notify()
    },
    act(id) {
      const list = [...getWatchlist()]
      const catalog = deps.getCatalog()
      if (id === 'prev' && index > 0) {
        index--
        notify()
      } else if (id === 'next' && index < list.length - 1) {
        index++
        notify()
      } else if (id === 'open-chart' && list[index]) {
        deps.openChart(list[index]!.collection, '7d')
      } else if (id === 'record-floor' && list[index]) {
        const target = list[index]!
        const liveFloor = getCheapestVenueFloor(catalog?.collection_floors[target.collection])?.price ?? target.recordedFloor
        list[index] = { ...target, recordedFloor: liveFloor, addedAt: new Date().toISOString() }
        setWatchlist(list)
        notify()
      } else if (id === 'add-to-watchlist' && focused && !list.some(e => e.collection === focused)) {
        const liveFloor = getCheapestVenueFloor(catalog?.collection_floors[focused])?.price ?? 100
        list.unshift({ collection: focused, recordedFloor: liveFloor, addedAt: new Date().toISOString() })
        index = 0
        setWatchlist(list)
        notify()
      } else if (id === 'remove-current' && list[index]) {
        list.splice(index, 1)
        index = Math.max(0, Math.min(index, Math.max(0, list.length - 1)))
        setWatchlist(list)
        notify()
      } else if (id === 'send-dm' && deps.sendTelegramCard) {
        const snap = snapshot()
        void deps.sendTelegramCard({
          title: 'Watchlist Valuation',
          text: snap.lines.join(' · '),
          collection: list[index]?.collection,
          attachKind: '7d',
          target: 'private',
        })
      }
    },
    back: () => false,
    close() {},
  }
}

function createResearchController(deps: CollectorToolDeps): CompanionToolController {
  const listeners = new Set<() => void>()
  let collection = 'Plush Pepe'
  let showSpreadFrame = false

  function notify() {
    for (const listener of listeners) listener()
  }

  function snapshot(): CompanionToolPage {
    const catalog = deps.getCatalog()
    const floors = catalog?.collection_floors[collection]
    const quotes = getVenueQuotes(floors)
    const best = getCheapestVenueFloor(floors)
    const arb = computeNetVenueArbitrage(floors)
    const m = getCollectionMetrics(collection)
    const models = getBundledModels(collection)
    const rarest = [...models].sort((a, b) => (a.rarityPermille ?? 99) - (b.rarityPermille ?? 99))[0]
    const rarestFloor = rarest ? getCheapestVenueFloor(rarest.floors)?.price : null
    const mult = rarestFloor && best ? `${(rarestFloor / best.price).toFixed(2)}×` : '—'
    const upgPct = m ? Math.round((m.upgraded / Math.max(1, m.emission)) * 100) : 72

    const arbLine = arb
      ? arb.netProfitGram > 0
        ? `Arbitrage: +${formatCompanionPrice(arb.netProfitGram)} GRAM net (+${arb.netRoiPct}% after ${arb.sellerFeePct}% ${arb.sell.marketplace} fee)`
        : `Spread: +${arb.grossPct}% gross (${arb.buy.marketplace} → ${arb.sell.marketplace}, fee-neutral)`
      : 'Single-venue listing'

    const spreadPixels = showSpreadFrame && quotes.length > 0 ? renderSpreadChart(quotes) : undefined

    return {
      key: `research-${collection}-${showSpreadFrame ? 'spread' : 'chart'}`,
      title: showSpreadFrame ? `Spread Research · ${collection}` : `Research · ${collection}`,
      lines: [
        best ? `Best ask: ${formatCompanionPrice(best.price)} GRAM (${best.marketplace})` : 'Floor unavailable',
        arbLine,
        `Health ${m?.healthScore ?? 80} · Greed ${m?.greedScore ?? 65} · ${upgPct}% upgraded · Whales ${m?.whaleHoldPercent ?? 15}%`,
        rarest && rarestFloor
          ? `Rare tier: ${rarest.name} (${rarest.rarityPermille ?? 5}‰) @ ${formatCompanionPrice(rarestFloor)} GRAM (${mult})`
          : 'Rare tier metadata synced',
      ],
      actions: [
        { id: 'open-chart', label: 'Open 7d chart' },
        ...(quotes.length >= 2
          ? [{ id: 'toggle-spread', label: showSpreadFrame ? 'Show 7d chart frame' : 'Show 5-venue spread bars' }]
          : []),
        ...(deps.sendTelegramCard
          ? [
              { id: 'send-dm', label: 'Send research + 7d PNG to DM' },
              { id: 'send-spread-dm', label: 'Send research + Spread PNG to DM' },
            ]
          : []),
      ],
      browse: {
        open: 'open-chart',
        swipeHint: showSpreadFrame ? '5-venue spread · Tap for 7d chart' : 'Tap for 7d chart · Menu to share',
      },
      ...(spreadPixels
        ? { framePixels: spreadPixels }
        : {
            chart: {
              collection,
              series: buildBundledFloorSeries(collection, '7d'),
            },
          }),
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(ctx) {
      collection = resolveCollectionName(deps.getCatalog(), ctx?.collection)
      showSpreadFrame = false
      notify()
    },
    act(id) {
      if (id === 'open-chart') {
        deps.openChart(collection, '7d')
      } else if (id === 'toggle-spread') {
        showSpreadFrame = !showSpreadFrame
        notify()
      } else if ((id === 'send-dm' || id === 'send-spread-dm') && deps.sendTelegramCard) {
        const snap = snapshot()
        void deps.sendTelegramCard({
          title: `${collection} Research`,
          text: snap.lines.slice(0, 3).join(' · '),
          collection,
          attachKind: id === 'send-spread-dm' ? 'spread' : '7d',
          target: 'private',
        })
      }
    },
    back: () => false,
    close() {},
  }
}

function createMarketNoteController(deps: CollectorToolDeps): CompanionToolController {
  const listeners = new Set<() => void>()
  let collection = 'Plush Pepe'
  let templateIndex = 0

  function notify() {
    for (const listener of listeners) listener()
  }

  function buildTemplates() {
    const catalog = deps.getCatalog()
    const floors = catalog?.collection_floors[collection]
    const best = getCheapestVenueFloor(floors)
    const chg24 = getCollectionPeriodChange(collection, '24h') ?? 0
    const chg7 = getCollectionPeriodChange(collection, '7d') ?? 0
    const arb = computeNetVenueArbitrage(floors)
    const m = getCollectionMetrics(collection)
    const usdt = resolveEffectiveUsdtRate(deps)
    const floorGram = best?.price ?? 100
    const venue = best?.marketplace ?? 'Portals'

    return [
      {
        id: 'momentum-note',
        label: 'Momentum + 7d PNG',
        attachKind: '7d' as const,
        text: `${collection} floor check: ${formatCompanionPrice(floorGram)} GRAM ($${formatCompanionPrice(Number((floorGram * usdt).toFixed(2)))}) on ${venue} (${formatMarketChange(chg24)} 24h, ${formatMarketChange(chg7)} 7d).`,
      },
      {
        id: 'spread-note',
        label: 'Spread + Venue PNG',
        attachKind: 'spread' as const,
        text: arb
          ? `${collection} ${arb.venueCount}-venue spread: ${arb.buy.marketplace} ${formatCompanionPrice(arb.buy.price)} GRAM vs ${arb.sell.marketplace} ${formatCompanionPrice(arb.sell.price)} GRAM (+${arb.grossPct}% gross, net ${arb.netProfitGram >= 0 ? '+' : ''}${formatCompanionPrice(arb.netProfitGram)} GRAM).`
          : `${collection} trading at ${formatCompanionPrice(floorGram)} GRAM on ${venue}.`,
      },
      {
        id: 'whale-note',
        label: 'Whale & Supply Memo',
        attachKind: undefined,
        text: `${collection} structure: Health ${m?.healthScore ?? 80}/100, Greed ${m?.greedScore ?? 65}/100, top-30 whales hold ${m?.whaleHoldPercent ?? 15}%.`,
      },
    ]
  }

  function snapshot(): CompanionToolPage {
    const templates = buildTemplates()
    const active = templates[templateIndex]!
    return {
      key: `market-note-${collection}-${templateIndex}`,
      title: `Market note · ${templateIndex + 1}/${templates.length}`,
      lines: [
        active.label,
        active.text,
      ],
      actions: [
        ...(deps.sendTelegramCard
          ? [
              { id: 'send-dm', label: 'Send note to Saved Messages' },
              { id: 'send-group', label: 'Post callout to Collector Group', requiresConfirmation: true },
            ]
          : [{ id: 'open-chart', label: 'Open 7d chart' }]),
        ...(templateIndex > 0 ? [{ id: 'prev', label: 'Previous template' }] : []),
        ...(templateIndex < templates.length - 1 ? [{ id: 'next', label: 'Next template' }] : []),
      ],
      browse: {
        open: deps.sendTelegramCard ? 'send-dm' : 'open-chart',
        previous: templateIndex > 0 ? 'prev' : undefined,
        next: templateIndex < templates.length - 1 ? 'next' : undefined,
        swipeHint: 'Swipe callout templates · Tap to save to DM',
      },
      chart: {
        collection,
        series: buildBundledFloorSeries(collection, '7d'),
      },
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    open(ctx) {
      collection = resolveCollectionName(deps.getCatalog(), ctx?.collection)
      templateIndex = 0
      notify()
    },
    act(id) {
      const templates = buildTemplates()
      const active = templates[templateIndex]!
      if (id === 'prev' && templateIndex > 0) {
        templateIndex--
        notify()
      } else if (id === 'next' && templateIndex < templates.length - 1) {
        templateIndex++
        notify()
      } else if (id === 'open-chart') {
        deps.openChart(collection, '7d')
      } else if ((id === 'send-dm' || id === 'send-group') && deps.sendTelegramCard) {
        void deps.sendTelegramCard({
          title: `${collection} Alpha Note`,
          text: active.text,
          collection,
          attachKind: active.attachKind,
          target: id === 'send-group' ? 'group' : 'private',
        })
      }
    },
    back: () => false,
    close() {},
  }
}

function createFavoriteMoversController(deps: CollectorToolDeps): CompanionToolController {
  const listeners = new Set<() => void>()
  let index = 0
  let rows: { name: string; floor: number; change: number | null }[] = []

  function rebuild() {
    const catalog = deps.getCatalog()
    const names = deps.getFavoriteNames()
    rows = names
      .map(name => {
        const best = getCheapestVenueFloor(catalog?.collection_floors[name])
        const change = getCollectionPeriodChange(name, '24h')
        return { name, floor: best?.price ?? 0, change }
      })
      .sort((a, b) => Math.abs(b.change ?? -1) - Math.abs(a.change ?? -1))
    index = Math.max(0, Math.min(index, Math.max(0, rows.length - 1)))
  }

  function snapshot(): CompanionToolPage {
    if (!rows.length) {
      return {
        key: 'movers-empty',
        title: 'Favorites movers',
        lines: ['No saved collections yet.', 'Open any gift and tap to save it to Favorites.'],
        actions: [],
      }
    }
    const row = rows[index]!
    const changeLabel = row.change === null ? 'No 24h baseline' : `24h move: ${formatMarketChange(row.change)}`
    return {
      key: `movers-${row.name}-${index}`,
      title: `Favorites movers · ${index + 1}/${rows.length}`,
      lines: [
        row.name,
        row.floor > 0 ? `Listing floor: ${formatCompanionPrice(row.floor)} GRAM` : 'Floor unavailable',
        changeLabel,
      ],
      actions: [
        { id: 'open-chart', label: 'Open 24h chart' },
        ...(index > 0 ? [{ id: 'prev', label: 'Previous' }] : []),
        ...(index < rows.length - 1 ? [{ id: 'next', label: 'Next' }] : []),
        { id: 'refresh', label: 'Refresh movers' },
      ],
      browse: {
        open: 'open-chart',
        previous: index > 0 ? 'prev' : undefined,
        next: index < rows.length - 1 ? 'next' : undefined,
        swipeHint: rows.length > 1 ? 'Swipe to browse saved movers' : undefined,
      },
      chart: row.floor > 0 ? { collection: row.name, series: buildBundledFloorSeries(row.name, '24h') } : undefined,
    }
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(ctx) {
      rebuild()
      if (ctx?.collection) {
        const found = rows.findIndex(r => r.name === ctx.collection)
        if (found >= 0) index = found
      }
      notify()
    },
    act(id) {
      if (id === 'prev' && index > 0) {
        index--
        notify()
      } else if (id === 'next' && index < rows.length - 1) {
        index++
        notify()
      } else if (id === 'refresh') {
        rebuild()
        notify()
      } else if (id === 'open-chart' && rows[index]) {
        deps.openChart(rows[index]!.name, '24h')
      }
    },
    back: () => false,
    close() {},
  }
}

function createPriceWatchController(
  deps: CollectorToolDeps,
  watches: Map<string, PriceWatchRule>,
): CompanionToolController {
  const listeners = new Set<() => void>()
  let collection = ''
  let presetIndex = 1 // Default -5%
  const presets = [
    { pct: 3, label: '-3% below floor' },
    { pct: 5, label: '-5% below floor' },
    { pct: 10, label: '-10% below floor' },
  ] as const

  function notify() {
    for (const listener of listeners) listener()
  }

  function currentFloor(): number | null {
    const catalog = deps.getCatalog()
    return getCheapestVenueFloor(catalog?.collection_floors[collection])?.price ?? null
  }

  function snapshot(): CompanionToolPage {
    if (!collection) {
      return {
        key: 'watch-none',
        title: 'Price watch',
        lines: ['Focus or open a gift collection first to set a 1-tap price alert.'],
        actions: [],
      }
    }
    const floor = currentFloor()
    const active = watches.get(collection)
    if (active) {
      return {
        key: `watch-armed-${collection}-${active.thresholdGram}`,
        title: `Price watch · Armed`,
        lines: [
          collection,
          `Alert below ${formatCompanionPrice(active.thresholdGram)} GRAM (${active.presetLabel})`,
          floor !== null ? `Current floor: ${formatCompanionPrice(floor)} GRAM` : 'Current floor: unavailable',
        ],
        actions: [
          { id: 'test-alert', label: 'Simulate hit (demo)' },
          { id: 'clear-watch', label: 'Stop watching' },
        ],
      }
    }
    if (floor === null) {
      return {
        key: `watch-unpriced-${collection}`,
        title: 'Price watch',
        lines: [collection, 'Current floor unavailable in latest catalog — refresh before arming watch.'],
        actions: [],
      }
    }
    const preset = presets[presetIndex]!
    const targetGram = Number((floor * (1 - preset.pct / 100)).toFixed(2))
    return {
      key: `watch-preset-${collection}-${presetIndex}`,
      title: `Price watch · ${presetIndex + 1}/${presets.length}`,
      lines: [
        collection,
        `Target: ≤ ${formatCompanionPrice(targetGram)} GRAM (${preset.label})`,
        `Current floor: ${formatCompanionPrice(floor)} GRAM`,
      ],
      actions: [
        { id: 'arm', label: `Watch ≤ ${formatCompanionPrice(targetGram)} GRAM` },
        ...(presetIndex > 0 ? [{ id: 'prev', label: 'Tighter (-%)' }] : []),
        ...(presetIndex < presets.length - 1 ? [{ id: 'next', label: 'Wider (-%)' }] : []),
      ],
      browse: {
        open: 'arm',
        previous: presetIndex > 0 ? 'prev' : undefined,
        next: presetIndex < presets.length - 1 ? 'next' : undefined,
        swipeHint: 'Swipe for -3% / -5% / -10% · Tap to arm',
      },
    }
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(ctx) {
      collection = ctx?.collection?.trim() ?? ''
      presetIndex = 1
      notify()
    },
    act(id) {
      if (id === 'prev' && presetIndex > 0) {
        presetIndex--
        notify()
      } else if (id === 'next' && presetIndex < presets.length - 1) {
        presetIndex++
        notify()
      } else if (id === 'arm' && collection) {
        const floor = currentFloor()
        if (floor === null) return
        const preset = presets[presetIndex]!
        const thresholdGram = Number((floor * (1 - preset.pct / 100)).toFixed(2))
        const rule: PriceWatchRule = {
          collection,
          thresholdGram,
          presetLabel: preset.label,
          createdAt: new Date().toISOString(),
        }
        watches.set(collection, rule)
        deps.onWatchArmed?.(rule)
        notify()
      } else if (id === 'clear-watch' && collection) {
        watches.delete(collection)
        notify()
      } else if (id === 'test-alert' && collection) {
        const rule = watches.get(collection)
        if (rule) {
          const hitPrice = Number((rule.thresholdGram * 0.985).toFixed(2))
          deps.onSimulateWatchHit?.(rule, hitPrice, true)
        }
      }
    },
    back: () => false,
    close() {},
  }
}

function createSpreadRadarController(deps: CollectorToolDeps): CompanionToolController {
  const listeners = new Set<() => void>()
  let index = 0
  let spreads: { name: string; low: { marketplace: string; price: number }; high: { marketplace: string; price: number }; pct: number }[] = []

  function rebuild() {
    const catalog = deps.getCatalog()
    spreads = Object.entries(catalog?.collection_floors ?? {})
      .flatMap(([name, floors]) => {
        const quotes = getVenueQuotes(floors)
        if (quotes.length < 2) return []
        const low = quotes[0]!
        const high = quotes[quotes.length - 1]!
        const pct = ((high.price - low.price) / low.price) * 100
        return [{ name, low, high, pct }]
      })
      .sort((a, b) => b.pct - a.pct)
    index = Math.max(0, Math.min(index, Math.max(0, spreads.length - 1)))
  }

  function snapshot(): CompanionToolPage {
    if (!spreads.length) {
      return {
        key: 'spread-empty',
        title: 'Venue spread radar',
        lines: ['No multi-venue quotes available.'],
        actions: [],
      }
    }
    const item = spreads[index]!
    return {
      key: `spread-${item.name}-${index}`,
      title: `Spread radar · ${index + 1}/${spreads.length}`,
      lines: [
        item.name,
        `Best: ${item.low.marketplace} ${formatCompanionPrice(item.low.price)} GRAM`,
        `High: ${item.high.marketplace} ${formatCompanionPrice(item.high.price)} GRAM (+${item.pct.toFixed(1)}%)`,
      ],
      actions: [
        { id: 'open-chart', label: 'Open 7d chart' },
        ...(index > 0 ? [{ id: 'prev', label: 'Previous' }] : []),
        ...(index < spreads.length - 1 ? [{ id: 'next', label: 'Next' }] : []),
        { id: 'refresh', label: 'Refresh radar' },
      ],
      browse: {
        open: 'open-chart',
        previous: index > 0 ? 'prev' : undefined,
        next: index < spreads.length - 1 ? 'next' : undefined,
        swipeHint: 'Swipe top venue spreads · Tap for 7d chart',
      },
    }
  }

  function notify() {
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(ctx) {
      rebuild()
      if (ctx?.collection) {
        const found = spreads.findIndex(s => s.name === ctx.collection)
        if (found >= 0) index = found
      }
      notify()
    },
    act(id) {
      if (id === 'prev' && index > 0) {
        index--
        notify()
      } else if (id === 'next' && index < spreads.length - 1) {
        index++
        notify()
      } else if (id === 'refresh') {
        rebuild()
        notify()
      } else if (id === 'open-chart' && spreads[index]) {
        deps.openChart(spreads[index]!.name, '7d')
      }
    },
    back: () => false,
    close() {},
  }
}

export type CollectorToolboxInstance = CompanionToolbox & {
  getWatches(): ReadonlyMap<string, PriceWatchRule>
  getWatchlist(): readonly WatchlistEntry[]
  addToWatchlist(collectionName: string): boolean
  recordFloor(collectionName: string): boolean
  submitGiftiPrompt(prompt: string, origin?: CompanionToolSource): Promise<boolean>
  refreshActivePage(): void
  evaluateWatches(nextCatalog?: CollectionFloorsResponse | null, options?: { isLive?: boolean }): number
  dispose?(): void
}

export function createCollectorToolbox(
  deps: CollectorToolDeps,
  getFocusedCollection: () => string | undefined,
): CollectorToolboxInstance {
  const listeners = new Set<() => void>()
  const watches = new Map<string, PriceWatchRule>()
  let watchlistCache: WatchlistEntry[] | null = null
  let page: CompanionToolPage | null = null
  let current: CompanionToolController | null = null
  let unsubscribe: (() => void) | undefined
  let activeName: CompanionToolName | undefined
  let source: CompanionToolSource = 'glasses'
  let fromMenu = false
  let foregroundVisible = true
  let context: CompanionToolContext = {}

  const entries: readonly { id: CompanionToolName; label: string }[] = [
    { id: 'summary', label: '60s Morning market brief' },
    { id: 'gifti', label: 'Ask Gifti copilot' },
    { id: 'watchlist', label: 'Watchlist & USDT valuation' },
    { id: 'research', label: 'Net arbitrage & rarity research' },
    { id: 'market-note', label: 'Draft Telegram alpha note' },
    { id: 'digest', label: 'Channel & deal digest' },
    { id: 'favorite-movers', label: 'What changed in Favorites?' },
    { id: 'spread-radar', label: 'Venue spread radar' },
    { id: 'threshold', label: 'Watch asking price' },
  ]

  function ensureWatchlist(): WatchlistEntry[] {
    if (watchlistCache) return watchlistCache
    const stored = readJson<WatchlistEntry[] | null>(WATCHLIST_STORAGE_KEY, null)
    if (Array.isArray(stored) && stored.length > 0) {
      watchlistCache = stored.filter(
        e => e && typeof e.collection === 'string' && typeof e.recordedFloor === 'number' && e.recordedFloor > 0,
      )
      return watchlistCache
    }
    const catalog = deps.getCatalog()
    const favs = deps.getFavoriteNames()
    watchlistCache = favs
      .map(name => {
        const best = getCheapestVenueFloor(catalog?.collection_floors[name])
        return best ? { collection: name, recordedFloor: best.price, addedAt: new Date().toISOString() } : null
      })
      .filter((x): x is WatchlistEntry => x !== null)
    return watchlistCache
  }

  function saveWatchlist(next: WatchlistEntry[]) {
    watchlistCache = next
    writeJson(WATCHLIST_STORAGE_KEY, next)
    mirrorKeyToEvenHost(WATCHLIST_STORAGE_KEY, JSON.stringify(next))
  }

  const unsubscribeHydration = subscribeHostStorageHydration(hydratedKeys => {
    if (hydratedKeys.includes(WATCHLIST_STORAGE_KEY) || hydratedKeys.includes('favorite_collections')) {
      watchlistCache = null
      if (page && current) {
        page = current.getSnapshot()
        for (const listener of listeners) listener()
      }
    }
  })

  function addToWatchlist(collectionName: string): boolean {
    const catalog = deps.getCatalog()
    const resolved = resolveCollectionName(catalog, collectionName)
    const floor = getCheapestVenueFloor(catalog?.collection_floors[resolved])?.price
    if (!floor) return false
    const currentList = [...ensureWatchlist()]
    const existingIdx = currentList.findIndex(e => e.collection === resolved)
    if (existingIdx >= 0) return true
    currentList.unshift({ collection: resolved, recordedFloor: floor, addedAt: new Date().toISOString() })
    saveWatchlist(currentList)
    return true
  }

  function recordFloor(collectionName: string): boolean {
    const catalog = deps.getCatalog()
    const resolved = resolveCollectionName(catalog, collectionName)
    const floor = getCheapestVenueFloor(catalog?.collection_floors[resolved])?.price
    if (!floor) return false
    const currentList = [...ensureWatchlist()]
    const existingIdx = currentList.findIndex(e => e.collection === resolved)
    if (existingIdx >= 0) {
      currentList[existingIdx] = { collection: resolved, recordedFloor: floor, addedAt: new Date().toISOString() }
    } else {
      currentList.unshift({ collection: resolved, recordedFloor: floor, addedAt: new Date().toISOString() })
    }
    saveWatchlist(currentList)
    return true
  }

  function publish(next: CompanionToolPage | null) {
    if (page === next) return
    page = next
    for (const listener of listeners) listener()
  }

  function detach() {
    unsubscribe?.()
    unsubscribe = undefined
    current?.close()
    current = null
  }

  function showMenu() {
    detach()
    activeName = undefined
    const col = context.collection
    publish({
      key: 'tools',
      title: 'Collector Copilot',
      lines: [col ? `Focused: ${col}` : 'Morning brief, Gifti AI copilot, net arbitrage research, watchlist & watches.'],
      actions: entries,
    })
  }

  function startTool(name: CompanionToolName) {
    if (!SUPPORTED_COLLECTOR_TOOLS.has(name)) return
    if (name === 'digest') {
      close()
      deps.openTelegramDigest()
      return
    }
    detach()
    activeName = name
    const controller =
      name === 'summary'
        ? createMorningBriefController(deps, watches)
        : name === 'gifti'
          ? createGiftiCopilotController(deps)
          : name === 'watchlist'
            ? createWatchlistController(deps, ensureWatchlist, saveWatchlist)
            : name === 'research'
              ? createResearchController(deps)
              : name === 'market-note'
                ? createMarketNoteController(deps)
                : name === 'favorite-movers'
                  ? createFavoriteMoversController(deps)
                  : name === 'spread-radar'
                    ? createSpreadRadarController(deps)
                    : createPriceWatchController(deps, watches)
    current = controller
    controller.setForegroundAvailable?.(foregroundVisible)
    unsubscribe = controller.subscribe(() => {
      if (current === controller) publish(controller.getSnapshot())
    })
    controller.open(context)
    publish(controller.getSnapshot())
  }

  function close() {
    detach()
    activeName = undefined
    publish(null)
  }

  function evaluateWatches(
    nextCatalog?: CollectionFloorsResponse | null,
    options?: { isLive?: boolean },
  ): number {
    const isLive = options?.isLive ?? deps.hasLiveCatalog?.() ?? true
    if (!isLive) return 0
    const activeCatalog = nextCatalog ?? deps.getCatalog()
    if (!activeCatalog) return 0
    let triggered = 0
    for (const [collectionName, rule] of watches) {
      const best = getCheapestVenueFloor(activeCatalog.collection_floors[collectionName])
      if (!best) continue
      if (best.price <= rule.thresholdGram && rule.lastTriggeredFloor !== best.price) {
        rule.lastTriggeredFloor = best.price
        triggered++
        deps.onSimulateWatchHit?.(rule, best.price, false)
      }
    }
    return triggered
  }

  return {
    getWatches: () => watches,
    getWatchlist: () => ensureWatchlist(),
    addToWatchlist,
    recordFloor,
    async submitGiftiPrompt(prompt, origin = 'phone') {
      const trimmed = prompt.trim()
      if (!trimmed) return false
      source = origin
      if (activeName !== 'gifti' || !current) {
        context = { collection: getFocusedCollection() }
        fromMenu = false
        startTool('gifti')
      }
      const giftiCtrl = current as (CompanionToolController & { submitPrompt?(q: string): Promise<void> }) | null
      if (!giftiCtrl?.submitPrompt) return false
      await giftiCtrl.submitPrompt(trimmed)
      return true
    },
    refreshActivePage() {
      if (current) publish(current.getSnapshot())
    },
    evaluateWatches,
    dispose() {
      unsubscribeHydration()
      close()
    },
    supportsTool: name => SUPPORTED_COLLECTOR_TOOLS.has(name),
    getSnapshot: () => page,
    getActiveTool: () => activeName,
    getPhoneSnapshot: () => (source === 'phone' ? page : null),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(name, next, origin = 'glasses') {
      if (name && !SUPPORTED_COLLECTOR_TOOLS.has(name)) return false
      source = origin
      context = next ?? { collection: getFocusedCollection() }
      fromMenu = !name
      if (name) startTool(name)
      else showMenu()
      return true
    },
    act(shown, id) {
      if (shown !== page || !shown.actions.some(a => a.id === id)) return false
      if (current) {
        current.act(id)
        return true
      }
      if (shown.key === 'tools') {
        const entry = entries.find(e => e.id === id)
        if (!entry) return false
        startTool(entry.id)
        return true
      }
      return false
    },
    back() {
      if (current?.back()) return
      if (fromMenu && activeName) showMenu()
      else close()
    },
    suspend() {
      if (current?.suspend) current.suspend()
      else close()
    },
    setForeground(fgSource, visible) {
      if (fgSource === 'display') {
        foregroundVisible = visible
        current?.setForegroundAvailable?.(visible)
      }
    },
    close,
  }
}
