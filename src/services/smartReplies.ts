import type { CollectionFloorsResponse, CompanionFloorSeries } from '../contracts/companion.ts'
import type { TelegramQuestion, TelegramSmartDraft } from '../contracts/telegram.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import { formatCompanionPrice, formatMarketChange } from '../lib/format.ts'
import {
  buildBundledFloorSeries,
  getCheapestVenueFloor,
  getCollectionPeriodChange,
  getVenueQuotes,
} from './bundledMarketData.ts'

export interface SmartReplyOptions {
  /**
   * True in paper/demo mode where bundled 7d curves and 24h deltas are displayed
   * for interactive evaluation. False in live Telegram relay mode unless real
   * series history is supplied via `series7d`.
   */
  allowSyntheticHistory?: boolean
  /** Optional live 7d floor series when connected to a real history feed. */
  series7d?: CompanionFloorSeries | null
  /** Whether the floor catalog came from a live market API vs bundled paper snapshot. */
  hasLiveCatalog?: boolean
}

export function detectQuestionCollection(
  questionText: string,
  catalog: CollectionFloorsResponse | null,
  fallbackCollection?: string | null,
): string | null {
  const normalizedQuestion = resolveDeepLinkMatchKey(questionText)
  const names = Object.keys(catalog?.collection_floors ?? {})
  for (const name of names) {
    const key = resolveDeepLinkMatchKey(name)
    if (key && key.length >= 4 && normalizedQuestion.includes(key)) return name
  }
  for (const name of names) {
    const words = name.toLowerCase().split(/\s+/).filter(w => w.length >= 4)
    if (words.some(w => questionText.toLowerCase().includes(w))) return name
  }
  return fallbackCollection ?? null
}

export function buildSmartReplyDrafts(
  question: TelegramQuestion,
  catalog: CollectionFloorsResponse | null,
  focusedCollection?: string | null,
  options: SmartReplyOptions = {},
): TelegramSmartDraft[] {
  const allowSynthetic = options.allowSyntheticHistory ?? true
  const snapshotNote = !allowSynthetic && options.hasLiveCatalog === false ? ' (snapshot)' : ''

  const matched =
    question.collectionHint
    ?? detectQuestionCollection(question.text, catalog, focusedCollection)
    ?? focusedCollection
    ?? 'Plush Pepe'

  const floors = catalog?.collection_floors[matched]
  const best = getCheapestVenueFloor(floors)
  const quotes = getVenueQuotes(floors)
  const change24h = allowSynthetic ? getCollectionPeriodChange(matched, '24h') : null
  const series7d = options.series7d ?? (allowSynthetic ? buildBundledFloorSeries(matched, '7d') : null)
  const closes = series7d?.points ?? []
  const prevClose = closes.at(-2)?.price
  const lastClose = closes.at(-1)?.price

  const drafts: TelegramSmartDraft[] = []

  if (best) {
    const changeTag = change24h !== null ? ` (${formatMarketChange(change24h)} 24h)` : ''
    if (series7d && closes.length > 0) {
      drafts.push({
        id: 'floor-chart',
        label: 'Floor + 7d chart',
        collection: matched,
        attachChart: true,
        text: `${matched} floor is ${formatCompanionPrice(best.price)} GRAM on ${best.marketplace}${changeTag}${snapshotNote}. Attached the 7d UTC floor chart.`,
      })
    } else {
      drafts.push({
        id: 'floor-quote',
        label: 'Lowest floor ask',
        collection: matched,
        text: `${matched} lowest ask is ${formatCompanionPrice(best.price)} GRAM on ${best.marketplace}${snapshotNote}.`,
      })
    }
  }

  if (quotes.length >= 2) {
    const first = quotes[0]!
    const second = quotes[1]!
    const highest = quotes.at(-1)!
    const spreadPct = (((second.price - first.price) / first.price) * 100).toFixed(1)
    const fullSpreadPct = (((highest.price - first.price) / first.price) * 100).toFixed(1)
    const attachSpreadChart = allowSynthetic || options.hasLiveCatalog === true
    const rangeTail =
      quotes.length >= 3 && highest.marketplace !== second.marketplace
        ? ` (${quotes.length}-venue span +${fullSpreadPct}% up to ${highest.marketplace})`
        : ''
    drafts.push({
      id: 'venue-spread',
      label: 'Venue spread',
      collection: matched,
      ...(attachSpreadChart ? { attachSpreadChart: true } : {}),
      text: `${matched} cheapest ask${snapshotNote}: ${first.marketplace} at ${formatCompanionPrice(first.price)} GRAM vs ${second.marketplace} at ${formatCompanionPrice(second.price)} GRAM (+${spreadPct}% spread)${rangeTail}.${attachSpreadChart ? ' Attached the 5-venue spread chart.' : ''}`,
    })
  }

  if (series7d && prevClose !== undefined && lastClose !== undefined) {
    const delta = lastClose - prevClose
    const formattedDelta =
      formatCompanionPrice(Math.abs(delta)) === '0'
        ? '0'
        : `${delta < 0 ? '-' : '+'}${formatCompanionPrice(Math.abs(delta))}`
    drafts.push({
      id: 'daily-delta',
      label: 'Daily UTC close',
      collection: matched,
      text: `${matched} daily UTC close moved from ${formatCompanionPrice(prevClose)} to ${formatCompanionPrice(lastClose)} GRAM (${formattedDelta} GRAM).`,
    })
  }

  drafts.push({
    id: 'quick-ack',
    label: 'Quick ack',
    collection: matched,
    text: `Saw your ${matched} question — checking current listings and model floors now.`,
  })

  return drafts
}
