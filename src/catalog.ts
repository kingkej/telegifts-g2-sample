import type { CompanionFloorMarket, CompanionFloorObservation, CompanionInspection } from './contracts/companion.ts'
import { formatCompanionPrice } from './lib/format.ts'

const marketplaces = [
  ['getgems', 'Getgems'],
  ['portals', 'Portals'],
  ['tonnel', 'Tonnel'],
  ['mrkt', 'MRKT'],
  ['fragment', 'Fragment'],
  ['marketapp', 'Marketapp'],
] as const

export interface Quote {
  marketplace: string
  price: number
}

export interface Collection {
  name: string
  floor: Quote
  quotes: Quote[]
  updatedAt: string | null
}

export type Section = 'explore' | 'favorites'

interface Card {
  id: string
  section: Section
  detail: boolean
  position: number
  total: number
  saved: boolean | null
  usdtPerGram: number | null
  observation: (CompanionFloorObservation & { period: string; stale: boolean }) | null
  cachedFloor: number | null
  inspection?: CompanionInspection
}

export type Screen = { section: Section; ranking?: Pick<CompanionFloorMarket, 'period' | 'filter'> } & (
  | { status: 'waiting' | 'loading' | 'empty' | 'error' | 'noMatches' | 'rankingLoading' | 'rankingError' }
  | (Card & { status: 'unpriced'; name: string })
  | (Card & { status: 'ready'; collection: Collection })
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectionQuote(name: string, entry: unknown): Collection | null {
  if (!name.trim() || !isRecord(entry)) return null
  const quotes: Quote[] = []
  for (const [key, marketplace] of marketplaces) {
    const raw = entry[key]
    const price = typeof raw === 'string' ? Number(raw) : raw
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      quotes.push({ marketplace, price })
    }
  }
  quotes.sort((a, b) => a.price - b.price)
  const floor = quotes[0]
  if (!floor) return null
  const updatedAt =
    typeof entry.last_update === 'string' && Number.isFinite(Date.parse(entry.last_update))
      ? entry.last_update
      : null
  return { name, floor, quotes, updatedAt }
}

export function rankCollections(payload: unknown): Collection[] {
  if (!isRecord(payload) || !isRecord(payload.collection_floors)) {
    throw new Error('Invalid collection price response')
  }

  const collections: Collection[] = []
  for (const [name, entry] of Object.entries(payload.collection_floors)) {
    const collection = collectionQuote(name, entry)
    if (!collection) continue
    if (collection.quotes.length === 1 && collection.floor.marketplace === 'Getgems') continue
    collections.push(collection)
  }
  return collections.sort((a, b) => b.floor.price - a.floor.price || a.name.localeCompare(b.name))
}

export function formatPrice(price: number): string {
  return formatCompanionPrice(price) + ' GRAM'
}

export function formatObservedAt(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
}
