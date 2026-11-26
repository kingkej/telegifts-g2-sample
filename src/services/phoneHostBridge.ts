import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type FC,
  type ReactNode,
} from 'react'
import type {
  CollectionCompanion,
  CollectionFloorsResponse,
  CompanionChartRange,
  CompanionInspector,
} from '../contracts/companion.ts'
import type { CompanionToolbox } from '../contracts/tools.ts'
import { formatCompanionPrice } from '../lib/format.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import type { ResolvedGiftLink } from '../lib/giftLinkResolver.ts'
import { readJson } from '../lib/storage.ts'
import {
  getG2HardwarePreferences,
  setG2HardwarePreferences,
  subscribeG2HardwarePreferences,
} from './evenHostStorage.ts'
import {
  buildBundledHistoryCandles,
  DEFAULT_USDT_PER_GRAM,
  getBundledCatalog,
  getBundledModels,
  getCheapestVenueFloor,
  getCollectionMetrics,
  getCollectionPeriodChange,
  type GiftHistoryRange,
  type GiftHistorySource,
} from './bundledMarketData.ts'
import {
  createCollectorToolbox,
  WATCHLIST_STORAGE_KEY,
  type CollectorToolboxInstance,
  type PriceWatchRule,
  type WatchlistEntry,
} from './collectorTools.ts'
import {
  askGiftiAiQuestion,
  clearEphemeralAiToken,
  getGiftiSessionSnapshot,
  setEphemeralAiToken,
  subscribeGiftiSession,
  transcribeWithEphemeralAiOrFallback,
} from './giftiAiBridge.ts'
import { getLatestTonUsdtSnapshot } from './liveTicker.ts'
import { TelegramCompanionStore } from './telegramStore.ts'
import {
  resolveFloorTriplesPayload,
  resolveUserPortfolioPayload,
  type FloorResolveTriple,
} from './tonPortfolio.ts'

export const PUBLIC_API_ORIGIN = 'https://market.telegifts.local'

const BACKDROP_NAMES = ['Midnight', 'Emerald', 'Cobalt', 'Amber'] as const
const SYMBOL_NAMES = ['Crown', 'Star', 'Diamond', 'Bolt'] as const

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function buildModelsPricesMap(catalog: CollectionFloorsResponse) {
  const out: Record<string, { last_models_update: number; models: Record<string, Record<string, number | string | null>> }> = {}
  const nowSec = Math.floor(Date.now() / 1000)
  for (const name of Object.keys(catalog.collection_floors)) {
    const models = getBundledModels(name)
    const modelFloors: Record<string, Record<string, number | string | null>> = {}
    for (const m of models) {
      modelFloors[m.name] = { ...m.floors } as Record<string, number | string | null>
    }
    out[name] = { last_models_update: nowSec, models: modelFloors }
  }
  return out
}

function resolutionToRange(resolution: string, fromSec: number | null, toSec: number | null): GiftHistoryRange {
  if (resolution === '15') return 'hour24'
  if (resolution === '60') return 'day3'
  if (fromSec && toSec && toSec > fromSec) {
    const days = (toSec - fromSec) / 86_400
    if (days <= 9) return 'week1'
    if (days <= 18) return 'week2'
    if (days <= 38) return 'month1'
    if (days <= 70) return 'month2'
    if (days <= 110) return 'month3'
  }
  return 'month1'
}

const bridgeMarketState: {
  catalog: CollectionFloorsResponse
  isLiveCatalog: boolean
  isLiveHistory: boolean
} = {
  catalog: getBundledCatalog(),
  isLiveCatalog: false,
  isLiveHistory: false,
}

export function notifyHostBridgeRateChanged(): void {
  sharedCollectorTools?.refreshActivePage()
}

export async function hostHttpFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  let url: URL
  try {
    url = new URL(rawUrl, PUBLIC_API_ORIGIN)
  } catch {
    return fetch(input, init)
  }

  const pathname = url.pathname.replace(/^\/api-proxy\/[^/]+/, '')
  const configuredMarketApi = ((import.meta as { env?: Record<string, string> }).env?.VITE_MARKET_API_URL ?? '').trim()
  if (configuredMarketApi && url.origin === PUBLIC_API_ORIGIN) {
    try {
      const target = new URL(url.pathname + url.search, configuredMarketApi)
      const live = await fetch(target, init)
      if (live.ok) {
        if (pathname === '/api/a/api/v1/gifts/get_gifts_price_list') {
          const cloned = (await live.clone().json().catch(() => null)) as CollectionFloorsResponse | null
          if (cloned && cloned.collection_floors && typeof cloned.collection_floors === 'object') {
            bridgeMarketState.catalog = cloned
            bridgeMarketState.isLiveCatalog = true
            sharedCollectorTools?.evaluateWatches(cloned, { isLive: true })
            sharedCollectorTools?.refreshActivePage()
          }
        } else if (pathname === '/history') {
          bridgeMarketState.isLiveHistory = true
        }
        return live
      }
      if (pathname === '/api/a/api/v1/gifts/get_gifts_price_list') {
        bridgeMarketState.catalog = getBundledCatalog()
        bridgeMarketState.isLiveCatalog = false
        sharedCollectorTools?.refreshActivePage()
      } else if (pathname === '/history') {
        bridgeMarketState.isLiveHistory = false
      }
    } catch {
      if (pathname === '/api/a/api/v1/gifts/get_gifts_price_list') {
        bridgeMarketState.catalog = getBundledCatalog()
        bridgeMarketState.isLiveCatalog = false
        sharedCollectorTools?.refreshActivePage()
      } else if (pathname === '/history') {
        bridgeMarketState.isLiveHistory = false
      }
    }
  }

  if (url.origin !== PUBLIC_API_ORIGIN && !url.pathname.startsWith('/api-proxy/')) {
    return fetch(input, init)
  }

  const catalog = bridgeMarketState.catalog
  const nowSec = Math.floor(Date.now() / 1000)
  const daySec = Math.floor(nowSec / 86_400) * 86_400

  if (pathname === '/remote-settings') {
    return jsonResponse({
      enable_widget: false,
      enable_aggregator: false,
      android_review_mode: true,
    })
  }

  if (pathname.startsWith('/device/') || pathname === '/random') {
    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/b/api/v3/simple/price' || pathname === '/api/v3/simple/price') {
    const liveSnap = getLatestTonUsdtSnapshot()
    return jsonResponse({
      'the-open-network': {
        usd: liveSnap.usd || DEFAULT_USDT_PER_GRAM,
        ...(liveSnap.change24h !== null ? { usd_24h_change: liveSnap.change24h } : {}),
      },
    })
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_price_list') {
    const includeModels = url.searchParams.get('models') === 'true'
    if (includeModels) {
      return jsonResponse({
        collection_floors: catalog.collection_floors,
        models_prices: buildModelsPricesMap(catalog),
      })
    }
    return jsonResponse(catalog)
  }

  if (pathname === '/api/a/api/v1/gifts/get_unique_gifts_price_list') {
    const requested = url.searchParams.get('collection_name') ?? ''
    const allModels = buildModelsPricesMap(catalog)
    const key = Object.keys(allModels).find(k => resolveDeepLinkMatchKey(k) === resolveDeepLinkMatchKey(requested)) ?? requested
    return jsonResponse({
      collection_floors: catalog.collection_floors,
      models_prices: allModels[key] ? { [requested]: allModels[key] } : {},
    })
  }

  if (pathname === '/api/a/api/v1/gifts/get_attributes_metadata') {
    const meta: Record<string, { models: { name: string; rarityPermille?: number }[]; backdrops: { name: string }[]; symbols: { name: string }[] }> = {}
    for (const name of Object.keys(catalog.collection_floors)) {
      meta[name] = {
        models: getBundledModels(name).map(m => ({ name: m.name, rarityPermille: m.rarityPermille })),
        backdrops: BACKDROP_NAMES.map(b => ({ name: b })),
        symbols: SYMBOL_NAMES.map(s => ({ name: s })),
      }
    }
    return jsonResponse(meta)
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_backdrops_floor') {
    const out: Record<string, Record<string, number>> = {}
    for (const [name, floors] of Object.entries(catalog.collection_floors)) {
      const cheapest = getCheapestVenueFloor(floors)?.price ?? 100
      out[name] = {
        Midnight: Number((cheapest * 1.12).toFixed(2)),
        Emerald: Number((cheapest * 1.08).toFixed(2)),
        Cobalt: Number((cheapest * 1.04).toFixed(2)),
        Amber: cheapest,
      }
    }
    return jsonResponse(out)
  }

  if (pathname.startsWith('/api/a/api/v1/data/')) {
    const { createModelArtworkDataUrl, loadCollectionOrModelArtworkBlob } = await import('./artworkRegistry.ts')
    const rest = pathname.slice('/api/a/api/v1/data/'.length)
    const parts = rest.split('/').map(p => decodeURIComponent(p))
    if (parts[0] === 'original' && parts[1]) {
      const slug = parts[1].replace(/\.(png|webp|svg)$/i, '')
      const match = Object.keys(catalog.collection_floors).find(n => resolveDeepLinkMatchKey(n) === resolveDeepLinkMatchKey(slug)) ?? slug
      const blob = await loadCollectionOrModelArtworkBlob(match)
      if (blob) return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || 'image/webp' } })
    } else if (parts.length >= 3) {
      const [colSlug, assetType, rawName] = parts
      const colMatch = Object.keys(catalog.collection_floors).find(n => resolveDeepLinkMatchKey(n) === resolveDeepLinkMatchKey(colSlug!)) ?? colSlug!
      const cleanName = rawName!.replace(/\.(png|webp|svg)$/i, '')
      if (assetType === 'models') {
        const dataUrl = createModelArtworkDataUrl(colMatch, cleanName)
        return fetch(dataUrl)
      }
      const blob = await loadCollectionOrModelArtworkBlob(colMatch)
      if (blob) return new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || 'image/webp' } })
    }
  }

  if (pathname === '/market-performance') {
    const scope = (url.searchParams.get('scope') === 'models' ? 'models' : 'collections') as 'collections' | 'models'
    const metric = (url.searchParams.get('metric') === 'volume' ? 'volume' : 'floor') as 'floor' | 'volume'
    const rawPeriod = url.searchParams.get('period') ?? '24h'
    const period = (['12h', '24h', '7d', '30d'].includes(rawPeriod) ? rawPeriod : '24h') as '12h' | '24h' | '7d' | '30d'
    const changeWindow: CompanionChartRange = period === '7d' ? '7d' : period === '30d' ? '30d' : '24h'
    const generatedAt = nowSec
    const baselineCutoff = nowSec - (period === '12h' ? 43_200 : period === '24h' ? 86_400 : period === '7d' ? 7 * 86_400 : 30 * 86_400)

    const items: Array<{
      id: string
      collection: string
      model: string | null
      value: number
      previousValue: number | null
      changePercent: number | null
      floorPrice: number | null
    }> = []

    for (const [name, floors] of Object.entries(catalog.collection_floors)) {
      const floor = getCheapestVenueFloor(floors)?.price ?? null
      if (!floor || floor <= 0) continue
      const pct = getCollectionPeriodChange(name, changeWindow) ?? 0
      const metrics = getCollectionMetrics(name)
      const estVol = Math.round((metrics?.marketCapGram ?? floor * 4000) * 0.014)
      if (scope === 'collections') {
        const val = metric === 'volume' ? estVol : floor
        const prev = Number((val / (1 + pct / 100)).toFixed(2))
        items.push({
          id: `col:${name}`,
          collection: name,
          model: null,
          value: val,
          previousValue: prev > 0 ? prev : val,
          changePercent: pct,
          floorPrice: floor,
        })
      } else {
        for (const model of getBundledModels(name)) {
          const mFloor = getCheapestVenueFloor(model.floors)?.price ?? floor
          const mPct = Number((pct * 1.08).toFixed(2))
          const val = metric === 'volume' ? Number((mFloor * 4.5).toFixed(2)) : mFloor
          const prev = Number((val / (1 + mPct / 100)).toFixed(2))
          items.push({
            id: `mod:${name}::${model.name}`,
            collection: name,
            model: model.name,
            value: val,
            previousValue: prev > 0 ? prev : val,
            changePercent: mPct,
            floorPrice: mFloor,
          })
        }
      }
    }

    return jsonResponse({
      version: 1,
      scope,
      metric,
      period,
      generatedAt,
      baselineCutoff,
      items,
      hasMore: false,
      nextCursor: null,
    })
  }

  if (pathname === '/history') {
    const name = url.searchParams.get('name') ?? 'Plush Pepe'
    const source = (url.searchParams.get('source') === 'cheapest_snapshot' ? 'cheapest_snapshot' : 'sales') as GiftHistorySource
    const resolution = url.searchParams.get('resolution') ?? '1d'
    const fromParam = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : null
    const toParam = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : null
    const range = resolutionToRange(resolution, fromParam, toParam)
    const candles = buildBundledHistoryCandles(name, range, source, nowSec)
    if (!candles.length) {
      return jsonResponse({ s: 'no_data', source, t: [], o: [], h: [], l: [], c: [] })
    }
    const t = candles.map(k => Math.floor(k.date.getTime() / 1000))
    const activeUsd = getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM
    return jsonResponse({
      s: 'ok',
      source,
      t,
      o: candles.map(k => k.open),
      h: candles.map(k => k.high),
      l: candles.map(k => k.low),
      c: candles.map(k => k.close),
      tonUsdtRates: candles.map(() => activeUsd),
      tonUsdtRateTimestamps: t,
      tonUsdtRateBasis: 'spot_bucket',
    })
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_collections_emission') {
    const out: Record<string, unknown> = {}
    for (const name of Object.keys(catalog.collection_floors)) {
      const m = getCollectionMetrics(name)
      const supply = m?.emission ?? 12_000
      const upgraded = m?.upgraded ?? Math.round(supply * 0.72)
      const owners = m?.uniqueOwners ?? Math.round(upgraded * 0.58)
      out[name] = {
        emission: supply,
        upgraded,
        hidden: Math.max(0, Math.round(supply * 0.04)),
        unique_owners: owners,
        refunded: Math.max(0, Math.round(supply * 0.01)),
        deleted: Math.max(0, supply - upgraded - Math.round(supply * 0.05)),
        top_30_whales_hold: m?.whaleHoldPercent ?? 16.4,
      }
    }
    return jsonResponse(out)
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_collections_marketcap') {
    const portals: unknown[] = []
    const tonnel: unknown[] = []
    const mrkt: unknown[] = []
    const getgems: unknown[] = []
    for (const [name, floors] of Object.entries(catalog.collection_floors)) {
      const m = getCollectionMetrics(name)
      const upgraded = m?.upgraded ?? 5000
      const avail = Math.max(40, Math.round(upgraded * 0.06))
      if (typeof floors.portals === 'number') portals.push({ collection_name: name, available_gifts: avail, floor: String(floors.portals), ton_mcap: Math.round(floors.portals * upgraded) })
      if (typeof floors.tonnel === 'number') tonnel.push({ collection_name: name, available_gifts: Math.round(avail * 0.8), floor: String(floors.tonnel), ton_mcap: Math.round(floors.tonnel * upgraded) })
      if (typeof floors.mrkt === 'number') mrkt.push({ collection_name: name, available_gifts: Math.round(avail * 0.7), floor: String(floors.mrkt), ton_mcap: Math.round(floors.mrkt * upgraded) })
      if (typeof floors.getgems === 'number') getgems.push({ collection_name: name, available_gifts: Math.round(avail * 0.5), floor: String(floors.getgems), ton_mcap: Math.round(floors.getgems * upgraded) })
    }
    return jsonResponse({ portals, tonnel, mrkt, getgems })
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_collections_health_index_v2') {
    const out: Record<string, unknown> = {}
    for (const [name, floors] of Object.entries(catalog.collection_floors)) {
      const m = getCollectionMetrics(name)
      const floor = getCheapestVenueFloor(floors)?.price ?? 100
      const mcap = m?.marketCapGram ?? Math.round(floor * 5000)
      const vol = Math.round(mcap * 0.014)
      out[name] = {
        version: 2,
        collection_name: name,
        health_index: m?.healthScore ?? 78,
        liquidity: Number(Math.min(99, (vol / Math.max(1, floor)) * 2.4).toFixed(1)),
        market_cap: mcap,
        volume_24h_ton: vol,
        sales_24h: Math.max(6, Math.round(vol / Math.max(1, floor))),
        whale_concentration: m?.whaleHoldPercent ?? 14.8,
        norm_liquidity: 0.78,
        norm_market_cap: 0.82,
        norm_whale_concentration: 0.74,
        calculated_at: nowSec,
        confidence: 'high',
      }
    }
    return jsonResponse(out)
  }

  if (pathname === '/api/a/api/v1/gifts/get_gifts_collections_greed_index') {
    const out: Record<string, number> = {}
    for (const name of Object.keys(catalog.collection_floors)) {
      const m = getCollectionMetrics(name)
      out[name] = m?.greedScore ?? 64
    }
    return jsonResponse(out)
  }

  if (pathname === '/heatmap') {
    const range = url.searchParams.get('range') ?? '7d'
    const type = url.searchParams.get('type') ?? 'trade_volume'
    const win: CompanionChartRange = range === '24h' || range === '12h' ? '24h' : range === '30d' ? '30d' : '7d'
    const items = Object.entries(catalog.collection_floors).map(([collection, floors]) => {
      const floor = getCheapestVenueFloor(floors)?.price ?? 100
      const m = getCollectionMetrics(collection)
      const changePercent = getCollectionPeriodChange(collection, win) ?? 0
      const volume = Math.round((m?.marketCapGram ?? floor * 4000) * 0.014)
      const priceChange = Number(((floor * changePercent) / 100).toFixed(2))
      return { collection, volume, changePercent, priceChange }
    })
    return jsonResponse({ generatedAt: nowSec, range, type, items })
  }

  if (pathname === '/api/a/api/v1/gifts/get_providers_volumes') {
    return jsonResponse([
      { provider: 'portals', hour_revenue: 18_420, hour_sales: 142, peak_hour: '18:00 UTC', peak_hour_revenue_percent: 9.4, peak_hour_sales_percent: 8.8, total_revenue: 412_800, total_sales: 3_190 },
      { provider: 'tonnel', hour_revenue: 14_150, hour_sales: 118, peak_hour: '19:00 UTC', peak_hour_revenue_percent: 8.9, peak_hour_sales_percent: 8.5, total_revenue: 329_400, total_sales: 2_640 },
      { provider: 'mrkt', hour_revenue: 9_840, hour_sales: 86, peak_hour: '17:00 UTC', peak_hour_revenue_percent: 8.1, peak_hour_sales_percent: 7.9, total_revenue: 218_500, total_sales: 1_890 },
      { provider: 'getgems', hour_revenue: 6_210, hour_sales: 44, peak_hour: '20:00 UTC', peak_hour_revenue_percent: 7.5, peak_hour_sales_percent: 7.2, total_revenue: 145_200, total_sales: 980 },
    ])
  }

  if (pathname === '/api/v1/telegifts/ads') {
    return jsonResponse([])
  }

  if (pathname === '/api/v1/telegifts/gift-sets') {
    return jsonResponse({ items: [], total: 0, has_more: false })
  }

  if (pathname === '/api/v1/telegifts/gift-sets/detail') {
    return jsonResponse({ error: 'Gift sets disabled' }, 404)
  }

  if (pathname === '/api/v1/api/price_profile') {
    const username = url.searchParams.get('username') ?? ''
    if (!username.trim()) return jsonResponse({ error: 'Missing portfolio username' }, 400)
    const result = await resolveUserPortfolioPayload(
      username,
      url.searchParams.get('offset'),
      url.searchParams.get('limit'),
      'swift',
      catalog,
    )
    if (!result.ok) return jsonResponse({ error: result.error }, result.status)
    return jsonResponse(result.payload)
  }

  if (pathname === '/api/a/api/v1/gifts/get_user_profile_price') {
    const username = url.searchParams.get('username') ?? ''
    if (!username.trim()) return jsonResponse({ error: 'Missing portfolio username' }, 400)
    const result = await resolveUserPortfolioPayload(
      username,
      url.searchParams.get('offset'),
      url.searchParams.get('limit'),
      'legacy',
      catalog,
    )
    if (!result.ok) return jsonResponse({ error: result.error }, result.status)
    return jsonResponse(result.payload)
  }

  if (pathname === '/api/v1/api/floors/resolve') {
    let triples: FloorResolveTriple[] = []
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (Array.isArray(body?.triples)) triples = body.triples as FloorResolveTriple[]
    } catch {
      return jsonResponse({ error: 'Invalid floor resolve body' }, 400)
    }
    return jsonResponse(resolveFloorTriplesPayload(triples, catalog))
  }

  if (pathname === '/api/v1/api/actions/markets') {
    let col = 'Plush Pepe'
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (typeof body.collection === 'string' && body.collection) col = body.collection
    } catch { /* ignore */ }
    const floors = catalog.collection_floors[col]
    const base = getCheapestVenueFloor(floors)?.price ?? 250
    return jsonResponse({
      markets: [
        { provider: 'portals', number: 412, price_ton: Number((base * 0.99).toFixed(2)), date: (nowSec - 420) * 1000 },
        { provider: 'tonnel', number: 1089, price_ton: Number((base * 1.02).toFixed(2)), date: (nowSec - 1680) * 1000 },
        { provider: 'mrkt', number: 774, price_ton: Number((base * 1.01).toFixed(2)), date: (nowSec - 3900) * 1000 },
      ],
      meta: {},
    })
  }

  if (pathname === '/api/v1/api/collection_offers') {
    let col = 'Plush Pepe'
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (typeof body.collection === 'string' && body.collection) col = body.collection
    } catch { /* ignore */ }
    const floors = catalog.collection_floors[col]
    const base = getCheapestVenueFloor(floors)?.price ?? 250
    return jsonResponse({
      items: [
        { provider: 'portals', offer_id: 'b1', status: 'active', currency: 'TON', price_ton: Number((base * 0.94).toFixed(2)), quantity: 2 },
        { provider: 'tonnel', offer_id: 'b2', status: 'active', currency: 'TON', price_ton: Number((base * 0.91).toFixed(2)), quantity: 3 },
      ],
      coverage_complete: true,
    })
  }

  if (pathname === '/api/v1/api/cross_market_spread') {
    let col = 'Plush Pepe'
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (typeof body.collection === 'string' && body.collection) col = body.collection
    } catch { /* ignore */ }
    const floors = catalog.collection_floors[col] ?? {}
    const entries = Object.entries(floors)
      .filter(([k, v]) => k !== 'last_update' && typeof v === 'number' && v > 0)
      .sort((a, b) => (a[1] as number) - (b[1] as number)) as [string, number][]
    if (entries.length >= 2) {
      const [buyProv, buyP] = entries[0]!
      const [sellProv, sellP] = entries[entries.length - 1]!
      const gap = Number((sellP - buyP).toFixed(2))
      if (gap > 0) {
        return jsonResponse({
          opportunities: [{
            buy: { provider: buyProv, number: 518, total_price_ton: buyP },
            relist_reference: { provider: sellProv, seller_price_ton: sellP },
            gap_ton: gap,
            gap_percent: Number(((gap / buyP) * 100).toFixed(2)),
          }],
          scan_complete: true,
        })
      }
    }
    return jsonResponse({ opportunities: [], scan_complete: true })
  }

  if (pathname === '/analytics/indices/history') {
    const metric = url.searchParams.get('metric') ?? 'market_cap'
    const range = url.searchParams.get('range') ?? '7d'
    const count = 24
    const bucketSeconds = range === '24h' ? 3600 : 86_400
    const baseVal = metric === 'upgraded_supply' ? 485_000 : metric === 'min_price' ? 14.5 : metric === 'volume' ? 284_000 : 18_400_000
    const points = Array.from({ length: count }, (_, i) => {
      const ts = daySec - (count - 1 - i) * bucketSeconds
      const wave = 1 + Math.sin(i * 0.35) * 0.04 + (i / count) * 0.08
      return {
        timestamp: ts,
        value: Number((baseVal * wave).toFixed(2)),
        isImported: false,
        tonUsdtRate: DEFAULT_USDT_PER_GRAM,
        ...(metric === 'volume' ? { volumeAsOf: ts } : {}),
      }
    })
    return jsonResponse({
      metric,
      range,
      generatedAt: nowSec,
      bucketSeconds,
      aggregation: 'last',
      ...(metric === 'volume' ? { volumeWindowSeconds: 86_400 } : {}),
      points,
    })
  }

  if (pathname === '/analytics/indices/candles') {
    const metric = url.searchParams.get('metric') ?? 'market_cap'
    const range = url.searchParams.get('range') ?? '7d'
    const count = 20
    const bucketSeconds = 86_400
    const baseVal = metric === 'upgraded_supply' ? 485_000 : metric === 'min_price' ? 14.5 : metric === 'volume' ? 284_000 : 18_400_000
    const pts = Array.from({ length: count }, (_, i) => {
      const ts = daySec - (count - 1 - i) * bucketSeconds
      const o = Number((baseVal * (1 + i * 0.004)).toFixed(2))
      const c = Number((o * (1 + Math.sin(i * 0.7) * 0.018)).toFixed(2))
      const h = Number((Math.max(o, c) * 1.012).toFixed(2))
      const l = Number((Math.min(o, c) * 0.988).toFixed(2))
      return {
        timestamp: ts,
        open: o,
        high: h,
        low: l,
        close: c,
        sampleCount: 24,
        ...(metric === 'volume' ? { volumeAsOf: ts } : {}),
        usdt: {
          open: Number((o * DEFAULT_USDT_PER_GRAM).toFixed(2)),
          high: Number((h * DEFAULT_USDT_PER_GRAM).toFixed(2)),
          low: Number((l * DEFAULT_USDT_PER_GRAM).toFixed(2)),
          close: Number((c * DEFAULT_USDT_PER_GRAM).toFixed(2)),
          sampleCount: 24,
          coverageComplete: true,
        },
      }
    })
    return jsonResponse({
      metric,
      range,
      generatedAt: nowSec,
      bucketSeconds,
      aggregation: 'sampled_ohlc',
      ...(metric === 'volume' ? { volumeWindowSeconds: 86_400 } : {}),
      series: [{
        source: 'recorded',
        basis: 'ton',
        isImported: false,
        coverage: { sampleCount: count * 24, coveredBuckets: count, totalBuckets: count },
        points: pts,
        calendar: pts,
      }],
    })
  }

  if (pathname === '/api/a/api/v1/gifts/get_custom_collections_volumes' || pathname === '/api/a/api/v1/gifts/get_attribute_volumes') {
    const byProv: Record<string, { collections: Array<{ collection_name: string; sales_sum: number; sales_count: number }> }> = {
      portals: { collections: [] },
      tonnel: { collections: [] },
      mrkt: { collections: [] },
    }
    for (const [name, floors] of Object.entries(catalog.collection_floors)) {
      const f = getCheapestVenueFloor(floors)?.price ?? 100
      byProv.portals!.collections.push({ collection_name: name, sales_sum: Math.round(f * 14), sales_count: 14 })
      byProv.tonnel!.collections.push({ collection_name: name, sales_sum: Math.round(f * 9), sales_count: 9 })
      byProv.mrkt!.collections.push({ collection_name: name, sales_sum: Math.round(f * 6), sales_count: 6 })
    }
    return jsonResponse(byProv)
  }

  if (pathname === '/analytics/sales/counts') {
    const period = url.searchParams.get('period') === '30d' ? '30d' : '7d'
    const collection = url.searchParams.get('collection')
    const days = period === '30d' ? 30 : 7
    const points = Array.from({ length: days }, (_, i) => ({
      timestamp: daySec - (days - 1 - i) * 86_400,
      count: 42 + ((i * 7) % 19),
    }))
    return jsonResponse({
      metric: 'observed_completed_sales_count',
      period,
      ...(collection ? { collection } : {}),
      asOf: nowSec,
      generatedAt: nowSec,
      bucketSeconds: 86_400,
      series: ['portals', 'tonnel', 'mrkt'].map(provider => ({
        provider,
        availability: 'ok',
        coverage: { complete: true, observedEventCount: days * 48, coveredBuckets: days, totalBuckets: days },
        points,
      })),
    })
  }

  if (pathname === '/api/v1/api/market_search') {
    let col = 'Plush Pepe'
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      if (typeof body.collection === 'string' && body.collection) col = body.collection
    } catch { /* ignore */ }
    const floors = catalog.collection_floors[col] ?? {}
    const markets = ['portals', 'tonnel', 'mrkt', 'getgems']
    return jsonResponse({
      price_basis: 'live_total_ton',
      coverage: { complete: true, requested_markets: markets },
      marketplace_floors: markets.map(m => {
        const p = floors[m as keyof typeof floors]
        return typeof p === 'number' && p > 0
          ? { market: m, status: 'ok', listing: { totalPrice: p, listing_price_basis: 'live_total_ton' } }
          : { market: m, status: 'no_match', listing: null }
      }),
    })
  }

  if (pathname === '/api/a/api/v1/gifts/get_unique_last_sales') {
    const col = url.searchParams.get('collection_name') ?? 'Plush Pepe'
    const mod = url.searchParams.get('model_name') ?? 'Classic'
    const f = getCheapestVenueFloor(catalog.collection_floors[col])?.price ?? 200
    return jsonResponse([
      { collection_name: col, model_name: mod, price: f, provider: 'portals', telegram_gift_id: 401, unix_time: nowSec - 600 },
      { collection_name: col, model_name: mod, price: Number((f * 1.03).toFixed(2)), provider: 'tonnel', telegram_gift_id: 819, unix_time: nowSec - 2400 },
    ])
  }

  return jsonResponse({})
}

/* ============================================================================
 * Host-Backed Telegram Moderator & Collector Tools Hooks / Sheets
 * (Renders inside the real TeleGifts UI kit passed from vendor/telegifts-phone)
 * ============================================================================ */

let sharedTelegramStore: TelegramCompanionStore | null = null
let sharedTelegramInspector: CompanionInspector | undefined
let sharedCollectorTools: CollectorToolboxInstance | null = null
let latestReadCollection: (() => string | undefined) | null = null
let latestFavoriteNamesReader: (() => readonly string[]) | null = null
let hostGiftLinkOpener: ((rawInput: string) => ResolvedGiftLink | null) | null = null
let hostIrlListenStarter: ((durationMs?: number) => boolean) | null = null
let hostBrowserSpeechReader: (() => string | null) | null = null

export function registerHostGiftLinkOpener(
  opener: ((rawInput: string) => ResolvedGiftLink | null) | null,
): void {
  hostGiftLinkOpener = opener
}

export function registerHostIrlListenStarter(
  starter: ((durationMs?: number) => boolean) | null,
): void {
  hostIrlListenStarter = starter
}

export function registerHostBrowserSpeechReader(
  reader: (() => string | null) | null,
): void {
  hostBrowserSpeechReader = reader
}

export function triggerHostLiveAsk(): void {
  if (!sharedTelegramStore) return
  sharedTelegramStore.closeManagement()
  sharedTelegramStore.triggerHeadsUpQuestion()
}

export function triggerHostBurstAsks(): { queuedSilent: number; interrupted: unknown } | null {
  if (!sharedTelegramStore) return null
  sharedTelegramStore.closeManagement()
  return sharedTelegramStore.triggerBurstDemoQuestions()
}

export function openHostPendingSummary(): void {
  if (!sharedTelegramStore) return
  sharedTelegramStore.closeManagement()
  sharedTelegramStore.openPending()
}

export async function askHostGiftiPrompt(prompt: string): Promise<void> {
  await sharedCollectorTools?.submitGiftiPrompt(prompt, 'phone')
}

export function openHostGiftiVoice(): void {
  sharedCollectorTools?.open('gifti', { collection: latestReadCollection?.(), entry: 'talk' }, 'phone')
}

export function openHostResearch(collectionName?: string): void {
  if (!sharedCollectorTools) return
  sharedTelegramStore?.closeManagement()
  sharedTelegramStore?.cancelDraft()
  const col = collectionName || latestReadCollection?.() || 'Plush Pepe'
  sharedCollectorTools.open('research', { collection: col }, 'phone')
}

export function closeHostOverlays(): void {
  sharedCollectorTools?.close()
  sharedTelegramStore?.closeManagement()
  sharedTelegramStore?.cancelDraft()
}

function readHostTriageContext(): { favorites: readonly string[]; watchlist: readonly string[] } {
  const favorites = latestFavoriteNamesReader?.() ?? []
  const watchEntries = readJson<WatchlistEntry[]>(WATCHLIST_STORAGE_KEY, [])
  const watchlist = Array.isArray(watchEntries)
    ? watchEntries.map(e => (typeof e?.collection === 'string' ? e.collection : '')).filter(Boolean)
    : []
  return { favorites, watchlist }
}

function getOrCreateHostTelegramStore(inspector: CompanionInspector): TelegramCompanionStore {
  if (!sharedTelegramStore || sharedTelegramInspector !== inspector) {
    sharedTelegramInspector = inspector
    sharedTelegramStore = new TelegramCompanionStore(
      inspector,
      () => bridgeMarketState.catalog,
      () => latestReadCollection?.() ?? null,
      undefined,
      undefined,
      () => bridgeMarketState.isLiveCatalog,
      () => bridgeMarketState.isLiveHistory,
      readHostTriageContext,
      () => getGiftiSessionSnapshot().hasEphemeralKey,
    )
  }
  return sharedTelegramStore
}

export function useHostCompanionTelegram(
  host: CollectionCompanion | undefined,
  ready: boolean,
): TelegramCompanionStore | null {
  const inspector = host?.inspector
  const store = useMemo(() => {
    if (!ready || !inspector) return null
    return getOrCreateHostTelegramStore(inspector)
  }, [ready, inspector])

  useLayoutEffect(() => {
    if (!host || !store) return
    host.setTelegram?.(store)
    store.connectLiveStream()
    return () => {
      store.disconnectLiveStream()
      store.cancelDraft()
      host.setTelegram?.(null)
    }
  }, [host, store])

  return store
}

export function useHostCompanionTools(
  companion: CollectionCompanion | undefined,
  ready: boolean,
  readCollection: () => string | undefined,
): CompanionToolbox | null {
  latestReadCollection = readCollection
  latestFavoriteNamesReader = companion?.favoriteCollections
    ? () => companion.favoriteCollections!.getSnapshot().collections.map(c => c.name)
    : null
  const tools = useMemo(() => {
    if (!ready || !companion?.setTools || !companion.inspector) return null
    const tg = getOrCreateHostTelegramStore(companion.inspector)
    const voice = companion.displayConnection?.voice
    const voiceWithTranscribe = companion.displayConnection as
      | (typeof companion.displayConnection & {
          transcribeVoiceQuestion?: (pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string | null>
        })
      | undefined
    const instance = createCollectorToolbox(
      {
        getCatalog: () => bridgeMarketState.catalog,
        getFavoriteNames: () =>
          companion.favoriteCollections?.getSnapshot().collections.map(c => c.name)
          ?? ['Plush Pepe', 'Astral Shard', "Durov's Cap"],
        hasLiveCatalog: () => bridgeMarketState.isLiveCatalog,
        getUsdtRate: () => getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM,
        getUnreadQuestionCount: () => tg.getSnapshot().state?.questions.length ?? 0,
        openChart: (collection, range) => companion.openToolChart?.(collection, range) ?? false,
        openTelegramDigest: () => tg.openDigest(),
        openTelegramQuestions: () => tg.openQuestions(),
        sendTelegramCard: dispatch => tg.sendToolCardToTelegram(dispatch),
        recordVoiceQuestion: voice?.recordQuestion ? signal => voice.recordQuestion!(signal) : undefined,
        transcribeVoiceQuestion: (pcm, signal) =>
          transcribeWithEphemeralAiOrFallback(
            pcm,
            signal,
            () => hostBrowserSpeechReader?.() ?? null,
            voiceWithTranscribe?.transcribeVoiceQuestion,
          ),
        askGiftiQuestion: (question, focusedCollection, signal) =>
          askGiftiAiQuestion(question, focusedCollection, bridgeMarketState.catalog, signal),
        onSimulateWatchHit: (rule: PriceWatchRule, price: number, simulated?: boolean) => {
          tg.pushWatchDigestAlert(rule.collection, price, rule.thresholdGram, simulated)
        },
      },
      readCollection,
    )
    sharedCollectorTools = instance
    return instance
  }, [ready, companion, readCollection])

  useLayoutEffect(() => {
    if (!companion?.setTools || !tools) return
    sharedCollectorTools = tools
    companion.setTools(tools)
    return () => {
      if (sharedCollectorTools === tools) sharedCollectorTools = null
      companion.setTools?.(null)
      tools.dispose?.()
      tools.close()
    }
  }, [companion, tools])

  return tools
}

export interface TeleGiftsSheetKit {
  Sheet: FC<{
    open: boolean
    onClose(): void
    onBeforeClose?(): void
    ariaLabel?: string
    className?: string
    children?: ReactNode
  }>
  Button: FC<{
    size?: 'sm' | 'md' | 'lg'
    variant?: 'primary' | 'subtle' | 'ghost' | 'glass'
    block?: boolean
    disabled?: boolean
    onClick?(): void
    children?: ReactNode
  }>
  Input: FC<{
    value?: string
    placeholder?: string
    type?: string
    readOnly?: boolean
    onChange?(e: { target: { value: string } }): void
  }>
  PanelGroup: FC<{
    caption?: ReactNode
    padded?: boolean
    children?: ReactNode
  }>
  ListRow: FC<{
    title: ReactNode
    subtitle?: ReactNode
    value?: ReactNode
    trailing?: ReactNode
    divider?: boolean
    onClick?(): void
  }>
  ToolGroup: FC<{
    caption?: ReactNode
    footer?: ReactNode
    children?: ReactNode
  }>
  ToolRow: FC<{
    title: ReactNode
    subtitle?: ReactNode
    onClick?(): void
  }>
  CloseIcon: FC<{ size?: number }>
}

export const HostTelegramStoreContext = createContext<TelegramCompanionStore | null>(null)

export function HostTelegramActionsView({
  chart = false,
  kit,
}: {
  chart?: boolean
  kit: TeleGiftsSheetKit
}) {
  const store = useContext(HostTelegramStoreContext)
  if (!store) return null
  return createElement(HostTelegramActionsInner, { store, chart, kit })
}

function HostTelegramActionsInner({
  store,
  chart,
  kit,
}: {
  store: TelegramCompanionStore
  chart: boolean
  kit: TeleGiftsSheetKit
}) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const qCount = snap.state?.enabled && snap.state.group ? snap.state.questions.length : 0
  const digestCount = snap.state?.digest?.length ?? 0
  const isRelay = snap.state?.mode === 'relay' || Boolean(snap.relayConfig.relayUrl)

  if (chart) {
    return createElement(
      kit.ToolGroup,
      {
        footer: snap.selectedQuestion
          ? `Replying to ${snap.selectedQuestion.sender}: ${snap.selectedQuestion.text}`
          : undefined,
      },
      createElement(kit.ToolRow, {
        title: 'Share chart to Telegram DM',
        onClick: () => store.share('private'),
      }),
      createElement(kit.ToolRow, {
        title: 'Reply to selected question with chart',
        onClick: () => store.share('reply'),
      }),
      createElement(kit.ToolRow, {
        title: 'Reply with UTC daily close comparison',
        onClick: () => store.share('comparison'),
      }),
    )
  }

  return createElement(
    'div',
    { className: 'companion-telegram-actions' },
    createElement(
      kit.Button,
      { size: 'sm', variant: 'subtle', onClick: store.openManagement },
      isRelay ? 'Relay Connected' : 'Telegram Setup',
    ),
    createElement(
      kit.Button,
      { size: 'sm', variant: 'subtle', onClick: store.openQuestions },
      qCount > 0 ? `Questions (${qCount})` : 'Questions',
    ),
    createElement(
      kit.Button,
      { size: 'sm', variant: 'subtle', onClick: store.openDigest },
      digestCount > 0 ? `Digest (${digestCount})` : 'Digest',
    ),
    createElement(
      kit.Button,
      {
        size: 'sm',
        variant: 'subtle',
        onClick: () => {
          sharedCollectorTools?.open(undefined, { collection: latestReadCollection?.() }, 'phone')
        },
      },
      'Copilot',
    ),
  )
}

export function HostTelegramSheetsView({
  store,
  kit,
}: {
  store: TelegramCompanionStore
  kit: TeleGiftsSheetKit
}) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const hwPrefs = useSyncExternalStore(subscribeG2HardwarePreferences, getG2HardwarePreferences)
  const giftiSnap = useSyncExternalStore(subscribeGiftiSession, getGiftiSessionSnapshot)
  const [relayUrlInput, setRelayUrlInput] = useState(snap.relayConfig.relayUrl)
  const [relayTokenInput, setRelayTokenInput] = useState(snap.relayConfig.relayToken)
  const [giftLinkInput, setGiftLinkInput] = useState('https://t.me/nft/PlushPepe-412')
  const [giftLinkStatus, setGiftLinkStatus] = useState<string | null>(null)
  const [ephemeralKeyInput, setEphemeralKeyInput] = useState('')

  useEffect(() => {
    setRelayUrlInput(snap.relayConfig.relayUrl)
    setRelayTokenInput(snap.relayConfig.relayToken)
  }, [snap.relayConfig.relayUrl, snap.relayConfig.relayToken])

  useEffect(() => {
    if (!snap.manageOpen) setGiftLinkStatus(null)
  }, [snap.manageOpen])

  const { screen, manageOpen, state } = snap
  if (!manageOpen && screen.kind === 'idle') return null

  const isRelay = state?.mode === 'relay' || Boolean(snap.relayConfig.relayUrl)

  const wrapSheet = (title: string, open: boolean, onClose: () => void, body: ReactNode) =>
    createElement(
      kit.Sheet,
      { open, onClose, ariaLabel: title },
      createElement(
        'div',
        { className: 'sheet-content' },
        createElement(
          'div',
          { className: 'sheet-header' },
          createElement(
            'button',
            { type: 'button', className: 'icon-button', 'data-sheet-close': true, 'aria-label': 'Close', onClick: onClose },
            createElement(kit.CloseIcon, { size: 18 }),
          ),
          createElement('h2', { className: 'sheet-title' }, title),
          createElement('div', { className: 'sheet-header-spacer' }),
        ),
        createElement('div', { className: 'companion-telegram' }, body),
      ),
    )

  const questions = state?.questions ?? []

  return createElement(
    'div',
    null,
    manageOpen &&
      wrapSheet(
        'Telegram & Bot Relay',
        true,
        store.closeManagement,
        createElement(
          'div',
          { className: 'companion-telegram' },
          createElement(
            kit.PanelGroup,
            { caption: `Mode: ${isRelay ? 'Live Bot API Relay' : 'Built-in Demo Sandbox'}` },
            createElement(kit.ListRow, {
              title: 'Saved Messages (DM)',
              subtitle: state?.privateChat?.label ?? 'Not linked',
              divider: true,
              trailing: state?.privateChat
                ? createElement(kit.Button, { size: 'sm', variant: 'ghost', onClick: () => void store.unlink('private') }, 'Unlink')
                : createElement(kit.Button, { size: 'sm', variant: 'subtle', onClick: () => void store.startPairing('private') }, 'Connect'),
            }),
            createElement(kit.ListRow, {
              title: 'Collector Group / Forum',
              subtitle: state?.group?.label ?? 'Not linked',
              trailing: state?.group
                ? createElement(kit.Button, { size: 'sm', variant: 'ghost', onClick: () => void store.unlink('group') }, 'Unlink')
                : createElement(kit.Button, { size: 'sm', variant: 'subtle', onClick: () => void store.startPairing('group') }, 'Connect'),
            }),
          ),
          state?.candidate &&
            createElement(
              kit.PanelGroup,
              { caption: 'Confirm Telegram Pairing', padded: true },
              createElement(
                kit.Button,
                { variant: 'primary', block: true, onClick: () => void store.confirmCandidate(state.candidate!) },
                `Confirm ${state.candidate.label}`,
              ),
            ),
          createElement(
            kit.PanelGroup,
            { caption: 'Optional Self-Hosted Bot Relay (server/telegramRelay.mjs)', padded: true },
            createElement(
              'div',
              { className: 'companion-telegram' },
              createElement(kit.Input, {
                value: relayUrlInput,
                placeholder: 'http://localhost:8787 (leave blank for demo mode)',
                onChange: e => setRelayUrlInput(e.target.value),
              }),
              createElement(kit.Input, {
                type: 'password',
                value: relayTokenInput,
                placeholder: 'Optional RELAY_AUTH_TOKEN',
                onChange: e => setRelayTokenInput(e.target.value),
              }),
              snap.relayConfigError && createElement('p', { role: 'alert' }, snap.relayConfigError),
              createElement(
                'div',
                { className: 'companion-telegram-actions' },
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'primary',
                    onClick: () => {
                      void store.configureRelay(relayUrlInput, relayTokenInput)
                    },
                  },
                  'Save Relay',
                ),
                !isRelay &&
                  createElement(
                    kit.Button,
                    {
                      size: 'sm',
                      variant: 'subtle',
                      onClick: () => {
                        store.simulateIncomingQuestion()
                        store.closeManagement()
                        store.openQuestions()
                      },
                    },
                    '+ Simulate /ask',
                  ),
                !isRelay &&
                  createElement(
                    kit.Button,
                    {
                      size: 'sm',
                      variant: 'subtle',
                      onClick: () => {
                        store.closeManagement()
                        store.triggerHeadsUpQuestion()
                      },
                    },
                    '+ Live /ask Heads-Up',
                  ),
              ),
            ),
          ),
          createElement(
            kit.PanelGroup,
            { caption: 'Quick-Beam Telegram Gift Link (t.me/nft/...)', padded: true },
            createElement(
              'div',
              { className: 'companion-telegram' },
              createElement(kit.Input, {
                value: giftLinkInput,
                placeholder: 'https://t.me/nft/PlushPepe-412',
                onChange: e => setGiftLinkInput(e.target.value),
              }),
              giftLinkStatus && createElement('p', { role: 'status' }, giftLinkStatus),
              createElement(
                'div',
                { className: 'companion-telegram-actions' },
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'primary',
                    onClick: () => {
                      const res = hostGiftLinkOpener?.(giftLinkInput) ?? null
                      if (res) {
                        const serialTag = res.serialNumber ? ` #${res.serialNumber}` : ''
                        setGiftLinkStatus(`Beamed ${res.collection}${serialTag} 5-venue spread to G2 HUD.`)
                      } else {
                        setGiftLinkStatus('Gift collection not recognized in catalog.')
                      }
                    },
                  },
                  'Beam Spread to G2',
                ),
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'subtle',
                    onClick: () => {
                      const res = hostGiftLinkOpener?.(giftLinkInput || (latestReadCollection?.() ?? 'Plush Pepe')) ?? null
                      if (res && sharedCollectorTools) {
                        store.closeManagement()
                        sharedCollectorTools.open('research', { collection: res.collection }, 'phone')
                      } else {
                        setGiftLinkStatus('Open or enter a valid gift collection to inspect net arbitrage & rarity.')
                      }
                    },
                  },
                  'G2 Research',
                ),
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'ghost',
                    onClick: () => {
                      const bridge = (globalThis as {
                        window?: {
                          EvenAppBridge?: {
                            pickImageFromAlbum?(): Promise<unknown>
                          }
                        }
                      }).window?.EvenAppBridge
                      if (typeof bridge?.pickImageFromAlbum === 'function') {
                        void bridge
                          .pickImageFromAlbum()
                          .then(picked => {
                            if (!picked) {
                              setGiftLinkStatus('Album picker canceled.')
                              return
                            }
                            const rawName =
                              typeof picked === 'string'
                                ? picked
                                : typeof picked === 'object'
                                  ? String(
                                      (picked as { name?: unknown; fileName?: unknown; path?: unknown }).name
                                        ?? (picked as { fileName?: unknown }).fileName
                                        ?? (picked as { path?: unknown }).path
                                        ?? '',
                                    )
                                  : ''
                            const stem = rawName.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]+$/i, '').trim()
                            const res = stem ? (hostGiftLinkOpener?.(stem) ?? null) : null
                            if (res) {
                              setGiftLinkInput(`https://t.me/nft/${res.rawSlug}`)
                              setGiftLinkStatus(`Matched ${res.collection} from album filename and beamed spread to G2.`)
                            } else {
                              setGiftLinkStatus('Image selected — filename had no recognized gift name; enter slug above.')
                            }
                          })
                          .catch(() => {
                            setGiftLinkStatus('Album picker canceled or unavailable on this host.')
                          })
                      } else if (typeof document !== 'undefined') {
                        const input = document.createElement('input')
                        input.type = 'file'
                        input.accept = 'image/*'
                        input.onchange = () => {
                          const fileName = input.files?.[0]?.name?.replace(/\.[a-z0-9]+$/i, '') ?? ''
                          const res = hostGiftLinkOpener?.(fileName) ?? null
                          if (res) {
                            setGiftLinkInput(`https://t.me/nft/${res.rawSlug}`)
                            setGiftLinkStatus(`Matched ${res.collection} from "${fileName}" and beamed spread to G2.`)
                          } else {
                            setGiftLinkStatus(`Could not match "${fileName || 'image'}" to a gift collection.`)
                          }
                        }
                        input.click()
                      }
                    },
                  },
                  'Pick Image (Filename)',
                ),
              ),
            ),
          ),
          createElement(
            kit.PanelGroup,
            { caption: 'Even G2 Hardware Controls (SDK 0.0.16)' },
            createElement(kit.ListRow, {
              title: 'IMU Head-Nod Alert Triage (Experimental)',
              subtitle: 'Nod: 1-Tap Smart Reply · Shake: Dismiss on live /ask & watch alerts',
              divider: true,
              trailing: createElement(
                kit.Button,
                {
                  size: 'sm',
                  variant: hwPrefs.imuTriageEnabled ? 'primary' : 'subtle',
                  onClick: () => {
                    const bridge = (globalThis as { window?: { EvenAppBridge?: { setLocalStorage?(k: string, v: string): Promise<boolean> } } }).window?.EvenAppBridge
                    setG2HardwarePreferences({ imuTriageEnabled: !hwPrefs.imuTriageEnabled }, bridge)
                  },
                },
                hwPrefs.imuTriageEnabled ? 'On' : 'Off',
              ),
            }),
            createElement(kit.ListRow, {
              title: 'IRL Meetup Overheard Lookup',
              subtitle: 'Beam 5-venue spread when speakerRole=other names a gift',
              trailing: createElement(
                'div',
                { className: 'companion-telegram-actions' },
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'subtle',
                    onClick: () => {
                      const bridge = (globalThis as { window?: { EvenAppBridge?: { setLocalStorage?(k: string, v: string): Promise<boolean> } } }).window?.EvenAppBridge
                      if (!hwPrefs.irlOverheardEnabled) {
                        setG2HardwarePreferences({ irlOverheardEnabled: true }, bridge)
                      }
                      const started = hostIrlListenStarter?.(12_000) ?? false
                      setGiftLinkStatus(
                        started
                          ? 'G2 microphone listening for 12s IRL gift mention (auto-closes)…'
                          : 'Connect G2 display in foreground to start 12s IRL listen.',
                      )
                    },
                  },
                  '12s Listen',
                ),
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: hwPrefs.irlOverheardEnabled ? 'primary' : 'subtle',
                    onClick: () => {
                      const bridge = (globalThis as { window?: { EvenAppBridge?: { setLocalStorage?(k: string, v: string): Promise<boolean> } } }).window?.EvenAppBridge
                      setG2HardwarePreferences({ irlOverheardEnabled: !hwPrefs.irlOverheardEnabled }, bridge)
                    },
                  },
                  hwPrefs.irlOverheardEnabled ? 'On' : 'Off',
                ),
              ),
            }),
          ),
          createElement(
            kit.PanelGroup,
            {
              caption: giftiSnap.hasEphemeralKey
                ? `Gifti Live LLM: ${giftiSnap.provider?.toUpperCase()} (1-Time RAM-Only)`
                : 'Offline Gifti Analyst (Rule-Based · Unlimited)',
              padded: true,
            },
            createElement(
              'div',
              { className: 'companion-telegram' },
              createElement(kit.Input, {
                type: 'password',
                value: ephemeralKeyInput,
                placeholder: 'Optional 1-time sk-... / AIza... / gsk_... for live LLM (RAM-only)',
                onChange: e => setEphemeralKeyInput(e.target.value),
              }),
              createElement(
                'div',
                { className: 'companion-telegram-actions' },
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'primary',
                    onClick: () => {
                      if (!ephemeralKeyInput.trim()) return
                      const ok = setEphemeralAiToken(ephemeralKeyInput)
                      if (ok) {
                        setEphemeralKeyInput('')
                        setGiftLinkStatus('Applied 1-time LLM token in JS memory only (cleared on reload).')
                      } else {
                        setGiftLinkStatus(
                          getGiftiSessionSnapshot().error
                            ?? 'Unrecognized key prefix — use sk-... (OpenAI), AIza... (Gemini), or gsk_... (Groq).',
                        )
                      }
                    },
                  },
                  'Use 1-Time Key',
                ),
                giftiSnap.hasEphemeralKey &&
                  createElement(
                    kit.Button,
                    {
                      size: 'sm',
                      variant: 'ghost',
                      onClick: () => {
                        clearEphemeralAiToken()
                        setEphemeralKeyInput('')
                        setGiftLinkStatus('Cleared in-memory AI token.')
                      },
                    },
                    'Forget Key',
                  ),
                createElement(
                  kit.Button,
                  {
                    size: 'sm',
                    variant: 'subtle',
                    onClick: () => {
                      store.closeManagement()
                      openHostGiftiVoice()
                    },
                  },
                  'Speak to Gifti',
                ),
              ),
            ),
          ),
        ),
      ),
    screen.kind === 'heads-up' &&
      wrapSheet(
        'Live Telegram /ask Alert',
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          createElement(
            kit.PanelGroup,
            { caption: screen.badge, padded: true },
            createElement('strong', null, screen.headline),
            createElement('p', null, screen.detail),
          ),
          createElement(
            kit.Button,
            { variant: 'primary', block: true, onClick: () => store.activate() },
            '1-Tap Smart Reply',
          ),
          createElement(
            kit.Button,
            { variant: 'ghost', block: true, onClick: store.back },
            'Dismiss',
          ),
        ),
      ),
    screen.kind === 'questions' &&
      wrapSheet(
        'Moderator Questions',
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          questions.length > 0
            ? createElement(
                kit.PanelGroup,
                null,
                questions.map((q, i) =>
                  createElement(kit.ListRow, {
                    key: q.id,
                    title: `${q.sender}${q.topicName ? ` · ${q.topicName}` : ''}`,
                    subtitle: q.text,
                    value: q.collectionHint ?? q.chatLabel,
                    divider: i < questions.length - 1,
                    onClick: () => store.openCompose(q),
                  }),
                ),
              )
            : createElement('p', { role: 'status' }, 'Inbox clear — all collector questions answered.'),
          createElement(
            'div',
            { className: 'companion-telegram-actions' },
            createElement(kit.Button, { size: 'sm', variant: 'ghost', onClick: () => void store.refresh() }, 'Refresh'),
            !isRelay &&
              createElement(
                kit.Button,
                { size: 'sm', variant: 'subtle', onClick: () => store.simulateIncomingQuestion() },
                '+ Simulate /ask',
              ),
          ),
        ),
      ),
    screen.kind === 'question' &&
      wrapSheet(
        'Collector Question',
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          createElement(
            kit.PanelGroup,
            { caption: screen.question.topicName ? `${screen.question.chatLabel} · ${screen.question.topicName}` : screen.question.chatLabel, padded: true },
            createElement('strong', null, screen.question.sender),
            createElement('p', null, screen.question.text),
          ),
          createElement(
            kit.Button,
            { variant: 'primary', block: true, onClick: () => store.openCompose(screen.question) },
            '1-Tap Smart Reply',
          ),
          createElement(
            kit.Button,
            {
              variant: 'subtle',
              block: true,
              onClick: () => {
                store.selectQuestion(screen.question)
                store.cancelDraft()
              },
            },
            'Pick Custom Chart to Reply',
          ),
        ),
      ),
    screen.kind === 'compose' &&
      wrapSheet(
        `Smart Reply → ${screen.question.sender}`,
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          createElement(
            kit.PanelGroup,
            { caption: screen.question.text },
            screen.drafts.map((d, idx) =>
              createElement(kit.ListRow, {
                key: d.id,
                title: `${idx === screen.index ? '● ' : '○ '}${d.label}${d.attachChart ? ' (+ 7d PNG)' : d.attachSpreadChart ? ' (+ Spread PNG)' : ''}`,
                subtitle: d.text,
                divider: idx < screen.drafts.length - 1,
                onClick: () => {
                  const delta = idx - screen.index
                  const stepDir = delta > 0 ? 1 : -1
                  for (let k = 0; k < Math.abs(delta); k++) store.step(stepDir)
                },
              }),
            ),
          ),
          createElement(
            kit.Button,
            { variant: 'primary', block: true, onClick: () => store.activate() },
            'Send Reply Now',
          ),
          createElement(kit.Button, { variant: 'ghost', block: true, onClick: store.back }, 'Cancel'),
        ),
      ),
    screen.kind === 'digest' &&
      wrapSheet(
        'Channel & Watch Digest',
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          screen.items.length > 0
            ? createElement(
                kit.PanelGroup,
                null,
                screen.items.map((item, idx) =>
                  createElement(kit.ListRow, {
                    key: item.id,
                    title: `${idx === screen.index ? '● ' : ''}${item.headline}`,
                    subtitle: `${item.channel} · ${item.summary}`,
                    value: item.floorGram ? `${formatCompanionPrice(item.floorGram)} G` : 'Save DM',
                    divider: idx < screen.items.length - 1,
                    onClick: () => {
                      const delta = idx - screen.index
                      const stepDir = delta > 0 ? 1 : -1
                      for (let k = 0; k < Math.abs(delta); k++) store.step(stepDir)
                      store.activate()
                    },
                  }),
                ),
              )
            : createElement('p', { role: 'status' }, 'No channel alerts yet.'),
        ),
      ),
    (screen.kind === 'confirm' || screen.kind === 'sending' || screen.kind === 'result' || screen.kind === 'notice') &&
      wrapSheet(
        screen.kind === 'confirm'
          ? 'Confirm Telegram Share'
          : screen.kind === 'sending'
            ? 'Sending to Telegram…'
            : screen.kind === 'result'
              ? `Delivery: ${screen.status.toUpperCase()}`
              : 'Telegram Notice',
        true,
        store.back,
        createElement(
          'div',
          { className: 'companion-telegram' },
          screen.kind === 'confirm' &&
            createElement(
              kit.PanelGroup,
              null,
              createElement(kit.ListRow, { title: 'Destination', value: screen.destination, divider: true }),
              createElement(kit.ListRow, { title: screen.collection, value: screen.range, divider: true }),
              createElement(kit.ListRow, { title: 'Latest Floor', value: `${formatCompanionPrice(screen.last)} GRAM` }),
            ),
          screen.kind === 'confirm' &&
            createElement(kit.Button, { variant: 'primary', block: true, onClick: () => store.activate() }, 'Send to Telegram'),
          screen.kind === 'sending' && createElement('p', { role: 'status' }, `Delivering to ${screen.destination}…`),
          screen.kind === 'result' &&
            createElement(
              kit.PanelGroup,
              { padded: true },
              createElement('strong', null, screen.destination),
              snap.receipt?.summary && createElement('p', null, snap.receipt.summary),
            ),
          screen.kind === 'notice' &&
            createElement('p', { role: 'status' }, `Action requires ${screen.reason.replace(/_/g, ' ')}.`),
          screen.kind !== 'sending' &&
            createElement(kit.Button, { variant: 'ghost', block: true, onClick: store.back }, 'Done'),
        ),
      ),
  )
}
