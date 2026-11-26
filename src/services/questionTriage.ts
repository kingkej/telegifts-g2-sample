import type { CollectionFloorsResponse } from '../contracts/companion.ts'
import type { PendingTriageSummary, TelegramQuestion } from '../contracts/telegram.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import { getVenueQuotes } from './bundledMarketData.ts'
import { detectQuestionCollection } from './smartReplies.ts'

export type ReplyIntent = 'spread' | 'floor' | 'chart' | 'delta' | 'generic'
export type TriagePriority = 1 | 2 | 3

export interface TriageContext {
  favorites?: readonly string[]
  watchlist?: readonly string[]
  catalog?: CollectionFloorsResponse | null
  spreadSignalAllowed?: boolean
  now?: number
}

export interface QuestionTriageResult {
  level: TriagePriority
  score: number
  tags: readonly string[]
  intent: ReplyIntent
  collection: string | null
}

const DELTA_INTENT_RE = /\b(vs yesterday|yesterday|daily close|utc close|daily delta|day over day|move vs|compared to yesterday)\b/i
const SPREAD_INTENT_RE = /\b(spread|spreads|cheaper|cheapest|venue|venues|portals|tonnel|mrkt|fragment|getgems|compare|arbitrage|\barb\b|difference)\b/i
const CHART_INTENT_RE = /\b(7d|7-day|seven day|30d|24h|chart|graph|history|trend)\b/i
const FLOOR_INTENT_RE = /\b(floor|price|ask|lowest|worth|cost)\b/i
const URGENCY_RE = /\b(now|asap|urgent|quick|sweep|swept|dump|selling|right now|today)\b/i
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T/

export function classifyReplyIntent(text: string): ReplyIntent {
  const clean = text.trim()
  if (!clean) return 'generic'
  if (DELTA_INTENT_RE.test(clean)) return 'delta'
  if (SPREAD_INTENT_RE.test(clean)) return 'spread'
  if (CHART_INTENT_RE.test(clean)) return 'chart'
  if (FLOOR_INTENT_RE.test(clean)) return 'floor'
  return 'generic'
}

function normalizedSet(items?: readonly string[]): Set<string> {
  const out = new Set<string>()
  if (!items) return out
  for (const item of items) {
    const k = resolveDeepLinkMatchKey(item)
    if (k) out.add(k)
  }
  return out
}

function parseIsoAgeMinutes(askedAt: string | undefined, nowMs: number): number | null {
  if (!askedAt || !ISO_TS_RE.test(askedAt.trim())) return null
  const parsed = Date.parse(askedAt)
  if (!Number.isFinite(parsed) || parsed > nowMs) return null
  return Math.floor((nowMs - parsed) / 60_000)
}

export function triageQuestion(question: TelegramQuestion, ctx: TriageContext = {}): QuestionTriageResult {
  const nowMs = ctx.now ?? Date.now()
  const catalog = ctx.catalog ?? null
  const combinedText = question.contextText ? `${question.text} ${question.contextText}` : question.text
  const collection =
    question.collectionHint
    ?? detectQuestionCollection(combinedText, catalog, null)
    ?? null

  const colKey = collection ? resolveDeepLinkMatchKey(collection) : ''
  const favSet = normalizedSet(ctx.favorites)
  const watchSet = normalizedSet(ctx.watchlist)

  let score = 0
  const rawTags: string[] = []

  if (collection) {
    score += 2
  }
  if (question.isFollowUp) {
    score += 2
    rawTags.push('FOLLOW-UP')
  }
  if (colKey && favSet.has(colKey)) {
    score += 3
    rawTags.push('FAV')
  }
  if (colKey && watchSet.has(colKey)) {
    score += 3
    rawTags.push('WATCH')
  }
  if (URGENCY_RE.test(question.text)) {
    score += 2
    rawTags.push('URGENT')
  }
  if (ctx.spreadSignalAllowed && collection && catalog) {
    const quotes = getVenueQuotes(catalog.collection_floors[collection])
    if (quotes.length >= 2 && quotes[0]!.price > 0) {
      const spreadPct = ((quotes.at(-1)!.price - quotes[0]!.price) / quotes[0]!.price) * 100
      if (spreadPct >= 3) {
        score += 2
        rawTags.push('SPREAD')
      }
    }
  }
  const ageMin = parseIsoAgeMinutes(question.askedAt, nowMs)
  if (ageMin !== null && ageMin > 15) {
    score += 1
    rawTags.push('AGING')
  }

  const level: TriagePriority = score >= 5 ? 1 : score >= 2 ? 2 : 3
  const intent = classifyReplyIntent(question.text)

  return {
    level,
    score,
    tags: rawTags.slice(0, 2),
    intent,
    collection,
  }
}

export function annotateAndSortByTriage(
  questions: readonly TelegramQuestion[],
  ctx: TriageContext = {},
): TelegramQuestion[] {
  const evaluated = questions.map((q, index) => {
    const result = triageQuestion(q, ctx)
    return {
      question: {
        ...q,
        ...(result.collection && !q.collectionHint ? { collectionHint: result.collection } : {}),
        priority: result.level,
        triageTags: result.tags,
        replyIntent: result.intent,
      },
      level: result.level,
      index,
    }
  })

  evaluated.sort((a, b) => (a.level !== b.level ? a.level - b.level : a.index - b.index))
  return evaluated.map(item => item.question)
}

function parseDisplayAgeMinutes(askedAt: string | undefined, nowMs: number): number | null {
  const iso = parseIsoAgeMinutes(askedAt, nowMs)
  if (iso !== null) return iso
  const clean = (askedAt ?? '').trim().toLowerCase()
  if (!clean) return null
  if (clean === 'just now' || clean === 'now') return 0
  const m = /^(\d+)\s*(m|min|mins|h|hr|hrs|d)\b/.exec(clean)
  if (!m) return null
  const val = Number(m[1])
  if (!Number.isFinite(val)) return null
  if (m[2]!.startsWith('d')) return val * 1440
  if (m[2]!.startsWith('h')) return val * 60
  return val
}

export function summarizePending(
  questions: readonly TelegramQuestion[],
  ctx: TriageContext = {},
): PendingTriageSummary {
  const nowMs = ctx.now ?? Date.now()
  const sorted = annotateAndSortByTriage(questions, ctx)
  let p1Count = 0
  let p2Count = 0
  let p3Count = 0
  let oldestMin: number | null = null
  const counts = new Map<string, number>()

  for (const q of sorted) {
    const lvl = q.priority ?? 3
    if (lvl === 1) p1Count++
    else if (lvl === 2) p2Count++
    else p3Count++

    const col = q.collectionHint ?? detectQuestionCollection(q.text, ctx.catalog ?? null, null)
    if (col) counts.set(col, (counts.get(col) ?? 0) + 1)

    const ageMin = parseDisplayAgeMinutes(q.askedAt, nowMs)
    if (ageMin !== null && (oldestMin === null || ageMin > oldestMin)) {
      oldestMin = ageMin
    }
  }

  const topCollections = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }))

  const oldestLabel =
    oldestMin !== null
      ? oldestMin >= 60
        ? `${Math.floor(oldestMin / 60)}h`
        : oldestMin === 0
          ? 'now'
          : `${oldestMin}m`
      : null

  const topQuestion = sorted[0] ?? null
  return {
    total: sorted.length,
    p1Count,
    p2Count,
    p3Count,
    oldestLabel,
    topCollections,
    topQuestion,
  }
}
