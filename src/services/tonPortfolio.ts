import type { CollectionFloorsResponse, ProviderFloors } from '../contracts/companion.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import { readJson } from '../lib/storage.ts'
import { createModelArtworkDataUrl, getCollectionThumbnailUrl } from './artworkRegistry.ts'
import { getBundledModels, getCheapestVenueFloor } from './bundledMarketData.ts'
import { WATCHLIST_STORAGE_KEY, type WatchlistEntry } from './collectorTools.ts'

export interface FloorResolveTriple {
  collection: string
  model: string
  backdrop: string
}

export interface MaterializedPortfolioGift {
  giftId: string
  slug: string
  telegramUrl: string
  collection: string
  number: number
  model: string
  backdrop: string
  symbol: string
  imageUrl: string
  updatedAt: string
  floorTon: number
  floorSource: string
  collectionFloors: Record<string, number>
  modelFloors: Record<string, number>
  comboFloors: Record<string, number>
}

const BACKDROP_NAMES = ['Midnight', 'Emerald', 'Cobalt', 'Amber'] as const
const SYMBOL_NAMES = ['Crown', 'Star', 'Diamond', 'Bolt'] as const
const BACKDROP_MULT: Record<string, number> = {
  Midnight: 1.12,
  Emerald: 1.08,
  Cobalt: 1.04,
  Amber: 1.0,
}

export function isLikelyTonAddress(input: string): boolean {
  const clean = input.trim().replace(/^@+/, '')
  if (/^(?:EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(clean)) return true
  if (/^-?[0-9]+:[0-9a-fA-F]{64}$/.test(clean)) return true
  if (/^[a-z0-9-]{3,64}\.ton$/i.test(clean)) return true
  return false
}

function numericProviderMap(floors: ProviderFloors | undefined | null, scale = 1): Record<string, number> {
  const out: Record<string, number> = {}
  if (!floors) return out
  for (const key of ['portals', 'tonnel', 'mrkt', 'getgems', 'fragment'] as const) {
    const val = floors[key]
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      out[key] = Number((val * scale).toFixed(2))
    }
  }
  return out
}

function matchCatalogCollection(rawName: string, catalog: CollectionFloorsResponse): string | null {
  const trimmed = rawName.trim()
  if (!trimmed) return null
  if (Object.hasOwn(catalog.collection_floors, trimmed)) return trimmed
  const key = resolveDeepLinkMatchKey(trimmed)
  if (!key || key.length < 3) return null
  return (
    Object.keys(catalog.collection_floors).find(c => resolveDeepLinkMatchKey(c) === key)
    ?? Object.keys(catalog.collection_floors).find(c => {
      const ck = resolveDeepLinkMatchKey(c)
      return ck.length >= 4 && (ck.startsWith(key) || key.startsWith(ck))
    })
    ?? null
  )
}

function buildPricedGiftItem(
  params: {
    collection: string
    serial: number
    model?: string
    backdrop?: string
    symbol?: string
    customImageUrl?: string
  },
  catalog: CollectionFloorsResponse,
  nowIso: string,
): MaterializedPortfolioGift {
  const models = getBundledModels(params.collection)
  const chosenModel =
    (params.model
      ? models.find(m => resolveDeepLinkMatchKey(m.name) === resolveDeepLinkMatchKey(params.model!))
      : undefined)
    ?? models[params.serial % Math.max(1, models.length)]
  const modelName = chosenModel?.name ?? params.model ?? 'Classic'
  const backdropName = params.backdrop || BACKDROP_NAMES[params.serial % BACKDROP_NAMES.length]!
  const symbolName = params.symbol || SYMBOL_NAMES[params.serial % SYMBOL_NAMES.length]!
  const mult = BACKDROP_MULT[backdropName] ?? 1.02

  const colFloors = numericProviderMap(catalog.collection_floors[params.collection], 1)
  const modFloors = chosenModel ? numericProviderMap(chosenModel.floors, 1) : colFloors
  const comboFloors = numericProviderMap(chosenModel?.floors ?? catalog.collection_floors[params.collection], mult)
  const cheapest = getCheapestVenueFloor(comboFloors as ProviderFloors)
    ?? getCheapestVenueFloor(modFloors as ProviderFloors)
    ?? getCheapestVenueFloor(colFloors as ProviderFloors)
    ?? { marketplace: 'Portals', price: 50 }

  const slugBase = params.collection.replace(/[^A-Za-z0-9]+/g, '')
  const slug = `${slugBase}-${params.serial}`
  const imageUrl =
    params.customImageUrl
    || getCollectionThumbnailUrl(params.collection)
    || createModelArtworkDataUrl(params.collection, modelName)

  return {
    giftId: `${slug.toLowerCase()}`,
    slug,
    telegramUrl: `https://t.me/nft/${slug}`,
    collection: params.collection,
    number: params.serial,
    model: modelName,
    backdrop: backdropName,
    symbol: symbolName,
    imageUrl,
    updatedAt: nowIso,
    floorTon: cheapest.price,
    floorSource: cheapest.marketplace.toLowerCase(),
    collectionFloors: colFloors,
    modelFloors: modFloors,
    comboFloors,
  }
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function buildDeterministicCollectorGifts(
  username: string,
  catalog: CollectionFloorsResponse,
  nowIso: string,
): MaterializedPortfolioGift[] {
  const clean = username.trim().replace(/^@+/, '').toLowerCase() || 'collector'
  const seed = hashSeed(clean)

  const watchlist = readJson<WatchlistEntry[] | null>(WATCHLIST_STORAGE_KEY, null) ?? []
  const favorites = readJson<string[] | null>('favorite_collections', null) ?? []
  const priorityNames: string[] = []

  for (const w of watchlist) {
    if (w?.collection && Object.hasOwn(catalog.collection_floors, w.collection) && !priorityNames.includes(w.collection)) {
      priorityNames.push(w.collection)
    }
  }
  for (const f of favorites) {
    if (typeof f === 'string' && Object.hasOwn(catalog.collection_floors, f) && !priorityNames.includes(f)) {
      priorityNames.push(f)
    }
  }
  for (const fallback of ['Plush Pepe', 'Astral Shard', "Durov's Cap", 'Loot Bag', 'Precious Peach', 'Swiss Watch']) {
    if (Object.hasOwn(catalog.collection_floors, fallback) && !priorityNames.includes(fallback)) {
      priorityNames.push(fallback)
    }
  }

  const count = Math.min(priorityNames.length, 6)
  const serialSeeds = [412, 19, 88, 205, 64, 311]
  return priorityNames.slice(0, count).map((col, idx) => {
    const serial =
      clean === 'collector' || clean === 'ton_alpha'
        ? serialSeeds[idx]!
        : ((seed + idx * 137) % 1800) + 12
    const models = getBundledModels(col)
    const model = models[(seed + idx) % Math.max(1, models.length)]?.name
    const backdrop = BACKDROP_NAMES[(seed + idx) % BACKDROP_NAMES.length]
    const symbol = SYMBOL_NAMES[(seed + idx * 2) % SYMBOL_NAMES.length]
    return buildPricedGiftItem({ collection: col, serial, model, backdrop, symbol }, catalog, nowIso)
  })
}

interface TonApiNftItem {
  address?: string
  index?: number
  collection?: { name?: string }
  metadata?: {
    name?: string
    image?: string
    attributes?: Array<{ trait_type?: string; value?: unknown }>
  }
}

export async function fetchTonAddressGiftPortfolio(
  address: string,
  catalog: CollectionFloorsResponse,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; gifts: MaterializedPortfolioGift[] }> {
  const clean = address.trim().replace(/^@+/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_500)
  const nowIso = new Date().toISOString()

  try {
    const res = await fetchImpl(`https://tonapi.io/v2/accounts/${encodeURIComponent(clean)}/nfts?limit=100`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, gifts: [] }
    const data = (await res.json()) as { nft_items?: TonApiNftItem[] }
    if (!Array.isArray(data?.nft_items)) return { ok: false, gifts: [] }

    const mapped: MaterializedPortfolioGift[] = []
    for (let i = 0; i < data.nft_items.length; i++) {
      const nft = data.nft_items[i]!
      const rawTitle = nft.collection?.name || nft.metadata?.name || ''
      const nameWithoutSerial = rawTitle.replace(/\s*#\s*\d+$/, '').trim()
      const matchedCol = matchCatalogCollection(nameWithoutSerial, catalog)
      if (!matchedCol) continue

      const serialMatch = /#\s*(\d+)/.exec(nft.metadata?.name ?? rawTitle)
      const serial = serialMatch ? Number(serialMatch[1]) : (typeof nft.index === 'number' ? nft.index + 1 : i + 1)

      let model: string | undefined
      let backdrop: string | undefined
      let symbol: string | undefined
      for (const attr of nft.metadata?.attributes ?? []) {
        const trait = (attr.trait_type ?? '').toLowerCase()
        const val = typeof attr.value === 'string' ? attr.value.trim() : ''
        if (!val) continue
        if (trait === 'model') model = val
        else if (trait === 'backdrop' || trait === 'background') backdrop = val
        else if (trait === 'symbol' || trait === 'pattern') symbol = val
      }

      mapped.push(
        buildPricedGiftItem(
          {
            collection: matchedCol,
            serial: Number.isSafeInteger(serial) && serial > 0 ? serial : i + 1,
            model,
            backdrop,
            symbol,
          },
          catalog,
          nowIso,
        ),
      )
    }

    return { ok: true, gifts: mapped }
  } catch {
    return { ok: false, gifts: [] }
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveUserPortfolioPayload(
  usernameOrAddress: string,
  offsetStr: string | null,
  limitStr: string | null,
  mode: 'swift' | 'legacy',
  catalog: CollectionFloorsResponse,
  fetchImpl: typeof fetch = fetch,
) {
  const clean = usernameOrAddress.trim().replace(/^@+/, '')
  const offset = Math.max(0, Number.parseInt(offsetStr ?? '0', 10) || 0)
  const limit = Math.min(100, Math.max(1, Number.parseInt(limitStr ?? '50', 10) || 50))
  const nowIso = new Date().toISOString()

  let allGifts: MaterializedPortfolioGift[]
  if (isLikelyTonAddress(clean)) {
    const live = await fetchTonAddressGiftPortfolio(clean, catalog, fetchImpl)
    allGifts = live.ok ? live.gifts : buildDeterministicCollectorGifts(clean, catalog, nowIso)
  } else {
    allGifts = buildDeterministicCollectorGifts(clean, catalog, nowIso)
  }

  const pageGifts = allGifts.slice(offset, offset + limit)
  const hasMore = offset + pageGifts.length < allGifts.length
  const nextOffset = hasMore ? String(offset + pageGifts.length) : undefined

  const totalCollectionPrice: Record<string, number> = {}
  const totalModelPrice: Record<string, number> = {}
  for (const g of allGifts) {
    for (const [p, val] of Object.entries(g.collectionFloors)) {
      totalCollectionPrice[p] = Number(((totalCollectionPrice[p] ?? 0) + val).toFixed(2))
    }
    for (const [p, val] of Object.entries(g.modelFloors)) {
      totalModelPrice[p] = Number(((totalModelPrice[p] ?? 0) + val).toFixed(2))
    }
  }

  if (mode === 'swift') {
    return {
      total: allGifts.length,
      has_more: hasMore,
      ...(nextOffset ? { next_offset: nextOffset } : {}),
      gifts: pageGifts.map(g => ({
        gift_id: g.giftId,
        slug: g.slug,
        telegram_url: g.telegramUrl,
        collection: g.collection,
        number: g.number,
        model: g.model,
        backdrop: g.backdrop,
        symbol: g.symbol,
        image_url: g.imageUrl,
        updated_at: g.updatedAt,
        floor_tier: Object.keys(g.comboFloors).length > 0 ? 'combo' : 'model',
        floor_ton: g.floorTon,
        floor_source: g.floorSource,
        floor_sources: Object.keys(g.comboFloors).length > 0 ? g.comboFloors : g.modelFloors,
      })),
    }
  }

  return {
    total: allGifts.length,
    gifts_count: allGifts.length,
    total_collection_price: totalCollectionPrice,
    total_model_price: totalModelPrice,
    gifts: pageGifts.map((g, idx) => ({
      name: `${g.collection} #${g.number}`,
      collection_name: g.collection,
      model_name: g.model,
      backdrop_name: g.backdrop,
      collection_prices: g.collectionFloors,
      model_prices: g.modelFloors,
      combination_prices: g.comboFloors,
      data: {
        id: offset + idx + 1,
        telegram_gift_name: g.slug,
        telegram_nft_url: g.telegramUrl,
        telegram_gift_title: g.collection,
        telegram_gift_number: g.number,
        media_preview: g.imageUrl,
        last_updated_at: g.updatedAt,
        attributes: {
          model: { name: g.model },
          backdrop: { name: g.backdrop },
          symbol: { name: g.symbol },
        },
      },
    })),
  }
}

export function resolveFloorTriplesPayload(
  triples: readonly FloorResolveTriple[],
  catalog: CollectionFloorsResponse,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const t of triples) {
    if (!t || typeof t.collection !== 'string' || typeof t.model !== 'string' || typeof t.backdrop !== 'string') {
      continue
    }
    const key = `${t.collection.trim()}|${t.model.trim()}|${t.backdrop.trim()}`
    const colName = matchCatalogCollection(t.collection, catalog)
    if (!colName) continue
    const models = getBundledModels(colName)
    const matchedModel = models.find(m => resolveDeepLinkMatchKey(m.name) === resolveDeepLinkMatchKey(t.model))
    const mult = BACKDROP_MULT[t.backdrop.trim()] ?? 1.03
    const prices = numericProviderMap(matchedModel?.floors ?? catalog.collection_floors[colName], mult)
    if (Object.keys(prices).length > 0) {
      out[key] = prices
    }
  }
  return out
}
