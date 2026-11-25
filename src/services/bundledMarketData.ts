import type {
  CollectionFloorsResponse,
  CollectionItem,
  CompanionChartRange,
  CompanionFloorSeries,
  ModelItem,
  ProviderFloors,
} from '../contracts/companion.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'

export interface CollectionMetrics {
  healthScore: number
  greedScore: number
  marketCapGram: number
  emission: number
  upgraded: number
  uniqueOwners: number
  whaleHoldPercent: number
}

interface SeedCollection {
  name: string
  portals: number
  tonnel: number | null
  mrkt: number | null
  getgems: number | null
  fragment?: number | null
  change24h: number
  change7d: number
  change30d: number
  healthScore: number
  greedScore: number
  emission: number
  upgraded: number
  uniqueOwners: number
  whaleHoldPercent: number
  models: readonly [string, number, number][] // [name, floorMultiplier, rarityPermille]
}

// Deterministic UTC anchor aligned to 15-minute and 24-hour boundaries.
const ANCHOR_DAY_UTC = Math.floor(Date.UTC(2026, 10, 24, 0, 0, 0) / 86_400_000) * 86_400
const UPDATED_ISO = '2026-11-24T02:15:00.000Z'
export const DEFAULT_USDT_PER_GRAM = 5.42

const SEED_COLLECTIONS: readonly SeedCollection[] = [
  {
    name: 'Plush Pepe',
    portals: 4820,
    tonnel: 4990,
    mrkt: 5040,
    getgems: 5180,
    fragment: 5120,
    change24h: 6.42,
    change7d: 14.8,
    change30d: 31.5,
    healthScore: 94,
    greedScore: 76,
    emission: 3000,
    upgraded: 2861,
    uniqueOwners: 1842,
    whaleHoldPercent: 18.4,
    models: [
      ['Golden', 2.85, 8],
      ['Emerald', 1.72, 15],
      ['Cyber', 1.44, 20],
      ['Cozy Sweater', 1.18, 32],
      ['Classic Green', 1.0, 48],
      ['Pixel', 1.31, 25],
    ],
  },
  {
    name: "Durov's Cap",
    portals: 1460,
    tonnel: 1425,
    mrkt: 1490,
    getgems: 1550,
    fragment: 1510,
    change24h: 4.18,
    change7d: 9.2,
    change30d: 22.4,
    healthScore: 91,
    greedScore: 71,
    emission: 5000,
    upgraded: 4612,
    uniqueOwners: 3110,
    whaleHoldPercent: 14.2,
    models: [
      ['Obsidian', 2.1, 10],
      ['Telegram Blue', 1.48, 18],
      ['Founder Edition', 2.65, 6],
      ['Stealth Matte', 1.0, 45],
      [' Arctic White', 1.15, 35].map(v => typeof v === 'string' ? v.trim() : v) as [string, number, number],
    ],
  },
  {
    name: 'Precious Peach',
    portals: 940,
    tonnel: 968,
    mrkt: 955,
    getgems: 1010,
    change24h: -2.35,
    change7d: 5.4,
    change30d: 18.1,
    healthScore: 86,
    greedScore: 58,
    emission: 6000,
    upgraded: 5210,
    uniqueOwners: 3480,
    whaleHoldPercent: 12.9,
    models: [
      ['Crystal Nectar', 1.95, 12],
      ['Rose Gold', 1.45, 22],
      ['Sunburst', 1.12, 38],
      ['Velvet Blush', 1.0, 52],
    ],
  },
  {
    name: 'Astral Shard',
    portals: 890,
    tonnel: 942,
    mrkt: 928,
    getgems: 975,
    change24h: 11.25,
    change7d: 19.6,
    change30d: 41.0,
    healthScore: 89,
    greedScore: 81,
    emission: 4500,
    upgraded: 4090,
    uniqueOwners: 2675,
    whaleHoldPercent: 16.1,
    models: [
      ['Supernova', 2.4, 9],
      ['Nebula Core', 1.62, 17],
      ['Void Prism', 1.28, 28],
      ['Starlight', 1.0, 46],
    ],
  },
  {
    name: 'Loot Bag',
    portals: 685,
    tonnel: 672,
    mrkt: 699,
    getgems: 730,
    change24h: 3.12,
    change7d: -1.8,
    change30d: 12.6,
    healthScore: 84,
    greedScore: 62,
    emission: 10000,
    upgraded: 8740,
    uniqueOwners: 5290,
    whaleHoldPercent: 11.5,
    models: [
      ['Diamond Vault', 2.3, 10],
      ['Whale Sack', 1.55, 20],
      ['Merchant Pouch', 1.1, 40],
      ['Canvas Classic', 1.0, 55],
    ],
  },
  {
    name: 'Heroic Helmet',
    portals: 612,
    tonnel: 640,
    mrkt: 628,
    getgems: 665,
    change24h: -4.15,
    change7d: 2.9,
    change30d: 15.3,
    healthScore: 82,
    greedScore: 54,
    emission: 8000,
    upgraded: 6920,
    uniqueOwners: 4310,
    whaleHoldPercent: 13.7,
    models: [
      ['Spartan Gold', 2.2, 11],
      ['Valkyrie', 1.6, 19],
      ['Centurion', 1.2, 34],
      ['Iron Forged', 1.0, 50],
    ],
  },
  {
    name: 'Vintage Cigar',
    portals: 528,
    tonnel: 545,
    mrkt: 519,
    getgems: 565,
    change24h: 1.85,
    change7d: 7.4,
    change30d: 19.8,
    healthScore: 85,
    greedScore: 64,
    emission: 12000,
    upgraded: 10340,
    uniqueOwners: 6180,
    whaleHoldPercent: 10.8,
    models: [
      ['Habano Gold', 2.05, 12],
      ['Silver Ash', 1.38, 24],
      ['Cedar Reserve', 1.0, 49],
    ],
  },
  {
    name: 'Swiss Watch',
    portals: 474,
    tonnel: 489,
    mrkt: 482,
    getgems: 510,
    change24h: 5.04,
    change7d: 11.2,
    change30d: 24.7,
    healthScore: 88,
    greedScore: 69,
    emission: 15000,
    upgraded: 12800,
    uniqueOwners: 7940,
    whaleHoldPercent: 9.6,
    models: [
      ['Tourbillon', 2.5, 8],
      ['Chronograph Blue', 1.5, 21],
      ['Titanium', 1.15, 36],
      ['Steel Dress', 1.0, 54],
    ],
  },
  {
    name: 'Algorithm Cup',
    portals: 418,
    tonnel: 436,
    mrkt: 429,
    getgems: 452,
    change24h: 8.9,
    change7d: 16.5,
    change30d: 29.0,
    healthScore: 90,
    greedScore: 74,
    emission: 5000,
    upgraded: 4410,
    uniqueOwners: 2980,
    whaleHoldPercent: 13.1,
    models: [
      ['Champion Gold', 2.2, 9],
      ['Platinum Solver', 1.65, 16],
      ['Enamel Trophy', 1.0, 44],
    ],
  },
  {
    name: 'Gem Signet',
    portals: 386,
    tonnel: 379,
    mrkt: 395,
    getgems: 420,
    change24h: -1.42,
    change7d: 4.1,
    change30d: 14.2,
    healthScore: 83,
    greedScore: 57,
    emission: 14000,
    upgraded: 11500,
    uniqueOwners: 6820,
    whaleHoldPercent: 11.2,
    models: [
      ['Sapphire Crest', 1.9, 14],
      ['Ruby Seal', 1.45, 24],
      ['Onyx Band', 1.0, 50],
    ],
  },
  {
    name: 'Ion Gem',
    portals: 342,
    tonnel: 358,
    mrkt: 349,
    getgems: 375,
    change24h: 7.35,
    change7d: 13.0,
    change30d: 27.6,
    healthScore: 87,
    greedScore: 72,
    emission: 16000,
    upgraded: 13900,
    uniqueOwners: 8410,
    whaleHoldPercent: 9.8,
    models: [
      ['Quantum Violet', 2.1, 11],
      ['Cobalt Pulse', 1.42, 22],
      ['Clear Quartz', 1.0, 52],
    ],
  },
  {
    name: 'Signet Ring',
    portals: 295,
    tonnel: 308,
    mrkt: 301,
    getgems: 325,
    change24h: -3.28,
    change7d: -0.9,
    change30d: 9.4,
    healthScore: 79,
    greedScore: 49,
    emission: 18000,
    upgraded: 14600,
    uniqueOwners: 9120,
    whaleHoldPercent: 8.9,
    models: [
      [' Sovereign Gold'.trim(), 1.85, 15],
      ['Brushed Silver', 1.22, 32],
      ['Classic Brass', 1.0, 55],
    ],
  },
  {
    name: 'Magic Potion',
    portals: 248,
    tonnel: 241,
    mrkt: 256,
    getgems: 274,
    change24h: 4.76,
    change7d: 10.4,
    change30d: 21.3,
    healthScore: 84,
    greedScore: 66,
    emission: 22000,
    upgraded: 18400,
    uniqueOwners: 11200,
    whaleHoldPercent: 8.2,
    models: [
      ['Elixir of Luck', 2.0, 12],
      ['Mana Brew', 1.35, 26],
      ['Alchemist Vial', 1.0, 54],
    ],
  },
  {
    name: 'Perfume Bottle',
    portals: 214,
    tonnel: 224,
    mrkt: 219,
    getgems: 238,
    change24h: 2.15,
    change7d: 6.2,
    change30d: 16.0,
    healthScore: 81,
    greedScore: 60,
    emission: 24000,
    upgraded: 19800,
    uniqueOwners: 12350,
    whaleHoldPercent: 7.9,
    models: [
      ['Noir Reserve', 1.9, 13],
      ['Amber Mist', 1.3, 28],
      ['Eau Fraiche', 1.0, 56],
    ],
  },
  {
    name: 'Mini Oscar',
    portals: 192,
    tonnel: 199,
    mrkt: 188,
    getgems: 212,
    change24h: -5.4,
    change7d: -2.1,
    change30d: 8.7,
    healthScore: 77,
    greedScore: 46,
    emission: 25000,
    upgraded: 20400,
    uniqueOwners: 13100,
    whaleHoldPercent: 8.4,
    models: [
      ['24K Statuette', 2.15, 10],
      ['Red Carpet', 1.4, 24],
      ['Studio Cast', 1.0, 58],
    ],
  },
  {
    name: 'Eternal Rose',
    portals: 168,
    tonnel: 175,
    mrkt: 171,
    getgems: 185,
    change24h: 3.64,
    change7d: 8.8,
    change30d: 17.9,
    healthScore: 83,
    greedScore: 63,
    emission: 30000,
    upgraded: 24900,
    uniqueOwners: 15800,
    whaleHoldPercent: 7.1,
    models: [
      ['Glass Dome', 1.88, 14],
      ['Midnight Bloom', 1.36, 26],
      ['Crimson Petal', 1.0, 56],
    ],
  },
  {
    name: 'Kissed Frog',
    portals: 149,
    tonnel: 144,
    mrkt: 153,
    getgems: 165,
    change24h: 9.65,
    change7d: 18.2,
    change30d: 33.4,
    healthScore: 88,
    greedScore: 78,
    emission: 28000,
    upgraded: 23600,
    uniqueOwners: 14900,
    whaleHoldPercent: 7.6,
    models: [
      ['Royal Crown', 2.25, 10],
      ['Pond Emerald', 1.4, 25],
      ['Lily Pad', 1.0, 55],
    ],
  },
  {
    name: 'Genie Lamp',
    portals: 136,
    tonnel: 142,
    mrkt: 139,
    getgems: 151,
    change24h: -0.85,
    change7d: 3.5,
    change30d: 11.8,
    healthScore: 80,
    greedScore: 55,
    emission: 32000,
    upgraded: 26100,
    uniqueOwners: 16400,
    whaleHoldPercent: 6.9,
    models: [
      ['Three Wishes', 1.95, 12],
      ['Desert Brass', 1.25, 30],
      ['Oasis', 1.0, 58],
    ],
  },
  {
    name: 'Trapped Heart',
    portals: 122,
    tonnel: 128,
    mrkt: 125,
    getgems: 138,
    change24h: 1.45,
    change7d: 5.9,
    change30d: 14.5,
    healthScore: 81,
    greedScore: 59,
    emission: 35000,
    upgraded: 28400,
    uniqueOwners: 18200,
    whaleHoldPercent: 6.5,
    models: [
      ['Ruby Cage', 1.82, 15],
      ['Silver Lock', 1.28, 29],
      ['Crystal Chamber', 1.0, 56],
    ],
  },
  {
    name: 'Electric Skull',
    portals: 108,
    tonnel: 104,
    mrkt: 112,
    getgems: 121,
    change24h: -6.12,
    change7d: -3.4,
    change30d: 6.2,
    healthScore: 75,
    greedScore: 43,
    emission: 38000,
    upgraded: 30200,
    uniqueOwners: 19400,
    whaleHoldPercent: 6.8,
    models: [
      ['High Voltage', 2.05, 11],
      ['Neon Surge', 1.38, 25],
      ['Arc Frame', 1.0, 57],
    ],
  },
  {
    name: 'Crystal Ball',
    portals: 96,
    tonnel: 101,
    mrkt: 98.5,
    getgems: 109,
    change24h: 2.94,
    change7d: 7.1,
    change30d: 16.8,
    healthScore: 82,
    greedScore: 61,
    emission: 40000,
    upgraded: 32900,
    uniqueOwners: 21100,
    whaleHoldPercent: 6.1,
    models: [
      ['Oracle Mist', 1.9, 13],
      ['Astral Gaze', 1.32, 27],
      ['Clear Sphere', 1.0, 58],
    ],
  },
  {
    name: 'Scared Cat',
    portals: 84,
    tonnel: 81.5,
    mrkt: 86,
    getgems: 94,
    change24h: 5.62,
    change7d: 12.1,
    change30d: 25.0,
    healthScore: 85,
    greedScore: 68,
    emission: 42000,
    upgraded: 34800,
    uniqueOwners: 22900,
    whaleHoldPercent: 5.9,
    models: [
      ['Midnight Fur', 1.92, 12],
      ['Pumpkin Spook', 1.35, 26],
      ['Tabby', 1.0, 59],
    ],
  },
  {
    name: 'Sharp Tongue',
    portals: 74,
    tonnel: 77.5,
    mrkt: 76,
    getgems: 83,
    change24h: -1.95,
    change7d: 1.8,
    change30d: 10.2,
    healthScore: 78,
    greedScore: 52,
    emission: 45000,
    upgraded: 36500,
    uniqueOwners: 24200,
    whaleHoldPercent: 5.7,
    models: [
      ['Chrome Bite', 1.8, 15],
      ['Pop Red', 1.24, 31],
      ['Classic', 1.0, 58],
    ],
  },
  {
    name: 'Toy Bear',
    portals: 62,
    tonnel: 64.5,
    mrkt: 63,
    getgems: 69,
    change24h: 3.4,
    change7d: 8.0,
    change30d: 18.6,
    healthScore: 82,
    greedScore: 62,
    emission: 50000,
    upgraded: 41200,
    uniqueOwners: 27800,
    whaleHoldPercent: 5.2,
    models: [
      ['Patchwork Gold', 1.95, 12],
      ['Velvet Ribbon', 1.3, 28],
      ['Honey Plush', 1.0, 60],
    ],
  },
]

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function minFloor(seed: SeedCollection): number {
  const vals = [seed.portals, seed.tonnel, seed.mrkt, seed.getgems, seed.fragment ?? null].filter(
    (v): v is number => typeof v === 'number' && v > 0,
  )
  return Math.min(...vals)
}

const seedByKey = new Map<string, SeedCollection>(
  SEED_COLLECTIONS.map(seed => [resolveDeepLinkMatchKey(seed.name), seed]),
)

export function getBundledCatalog(): CollectionFloorsResponse {
  const collection_floors: Record<string, ProviderFloors> = {}
  for (const seed of SEED_COLLECTIONS) {
    collection_floors[seed.name] = {
      portals: seed.portals,
      tonnel: seed.tonnel,
      mrkt: seed.mrkt,
      getgems: seed.getgems,
      ...(seed.fragment ? { fragment: seed.fragment } : {}),
      last_update: UPDATED_ISO,
    }
  }
  return { collection_floors }
}

export function getBundledCollections(): CollectionItem[] {
  const catalog = getBundledCatalog()
  return Object.entries(catalog.collection_floors).map(([name, floors]) => ({
    id: name,
    name,
    floors,
  }))
}

export function getCheapestVenueFloor(floors: ProviderFloors | undefined): { marketplace: string; price: number } | null {
  if (!floors) return null
  const pairs: readonly [keyof ProviderFloors, string][] = [
    ['portals', 'Portals'],
    ['tonnel', 'Tonnel'],
    ['mrkt', 'MRKT'],
    ['getgems', 'Getgems'],
    ['fragment', 'Fragment'],
    ['marketapp', 'Marketapp'],
  ]
  let best: { marketplace: string; price: number } | null = null
  for (const [key, label] of pairs) {
    const raw = floors[key]
    const price = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(price) && price > 0 && (!best || price < best.price)) {
      best = { marketplace: label, price }
    }
  }
  return best
}

export function getVenueQuotes(floors: ProviderFloors | undefined): { marketplace: string; price: number }[] {
  if (!floors) return []
  const pairs: readonly [keyof ProviderFloors, string][] = [
    ['portals', 'Portals'],
    ['tonnel', 'Tonnel'],
    ['mrkt', 'MRKT'],
    ['getgems', 'Getgems'],
    ['fragment', 'Fragment'],
  ]
  const quotes: { marketplace: string; price: number }[] = []
  for (const [key, label] of pairs) {
    const raw = floors[key]
    const price = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(price) && price > 0) quotes.push({ marketplace: label, price })
  }
  return quotes.sort((a, b) => a.price - b.price)
}

export function getCollectionPeriodChange(name: string, period: CompanionChartRange): number | null {
  const seed = seedByKey.get(resolveDeepLinkMatchKey(name))
  if (!seed) return null
  return period === '24h' ? seed.change24h : period === '7d' ? seed.change7d : seed.change30d
}

export function getCollectionMetrics(name: string): CollectionMetrics | null {
  const seed = seedByKey.get(resolveDeepLinkMatchKey(name))
  if (!seed) return null
  const floor = minFloor(seed)
  return {
    healthScore: seed.healthScore,
    greedScore: seed.greedScore,
    marketCapGram: Math.round(floor * seed.upgraded),
    emission: seed.emission,
    upgraded: seed.upgraded,
    uniqueOwners: seed.uniqueOwners,
    whaleHoldPercent: seed.whaleHoldPercent,
  }
}

export function getBundledModels(collectionName: string): ModelItem[] {
  const seed = seedByKey.get(resolveDeepLinkMatchKey(collectionName))
  if (!seed) return []
  const base = minFloor(seed)
  return seed.models.map(([name, mult, rarityPermille]) => {
    const portals = Number((base * mult).toFixed(2))
    const tonnel = Number((portals * 1.035).toFixed(2))
    const mrkt = Number((portals * 1.055).toFixed(2))
    return {
      id: name,
      name,
      rarityPermille,
      floors: {
        portals,
        tonnel,
        mrkt,
        last_update: UPDATED_ISO,
      },
    }
  })
}

export function buildBundledFloorSeries(
  collectionName: string,
  range: CompanionChartRange,
  nowSeconds = Math.floor(Date.now() / 1000),
): CompanionFloorSeries {
  const seed = seedByKey.get(resolveDeepLinkMatchKey(collectionName))
  const intraday = range === '24h'
  const interval = intraday ? 900 : 86_400
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30
  const alignedEnd = Math.floor((nowSeconds > 0 ? nowSeconds : ANCHOR_DAY_UTC) / interval) * interval
  const from = alignedEnd - days * 86_400
  if (!seed) return { from, to: alignedEnd, interval, points: [] }

  const count = Math.floor((alignedEnd - from) / interval)
  const endPrice = minFloor(seed)
  const totalPct = range === '24h' ? seed.change24h : range === '7d' ? seed.change7d : seed.change30d
  const startPrice = endPrice / (1 + totalPct / 100)
  const h = hashSeed(seed.name + ':' + range)
  const phase1 = ((h & 0xff) / 255) * Math.PI * 2
  const phase2 = (((h >>> 8) & 0xff) / 255) * Math.PI * 2

  const points: { time: number; price: number }[] = []
  for (let i = 0; i < count; i++) {
    const progress = count <= 1 ? 1 : i / (count - 1)
    const trend = startPrice + (endPrice - startPrice) * progress
    const wave =
      Math.sin(progress * Math.PI * 2.4 + phase1) * 0.022
      + Math.cos(progress * Math.PI * 5.1 + phase2) * 0.011
    const raw = i === count - 1 ? endPrice : i === 0 ? startPrice : trend * (1 + wave)
    const price = Number(Math.max(0.01, raw).toFixed(2))
    points.push({ time: from + i * interval, price })
  }
  return { from, to: alignedEnd, interval, points }
}

export type GiftHistoryRange =
  | 'hour24'
  | 'day3'
  | 'week1'
  | 'week2'
  | 'month1'
  | 'month2'
  | 'month3'
  | 'all'

export type GiftHistorySource = 'sales' | 'cheapest_snapshot'

export interface GiftHistoryCandle {
  date: Date
  open: number
  high: number
  low: number
  close: number
}

const HISTORY_SPEC: Record<GiftHistoryRange, { days: number; interval: number; label: string }> = {
  hour24: { days: 1, interval: 900, label: '24h' },
  day3: { days: 3, interval: 3600, label: '3d' },
  week1: { days: 7, interval: 86_400, label: '1w' },
  week2: { days: 14, interval: 86_400, label: '2w' },
  month1: { days: 30, interval: 86_400, label: '1M' },
  month2: { days: 60, interval: 86_400, label: '2M' },
  month3: { days: 90, interval: 86_400, label: '3M' },
  all: { days: 180, interval: 86_400 * 3, label: 'All' },
}

export function giftHistoryRangeLabel(range: GiftHistoryRange): string {
  return HISTORY_SPEC[range].label
}

export function buildBundledHistoryCandles(
  collectionName: string,
  range: GiftHistoryRange,
  source: GiftHistorySource = 'sales',
  nowSeconds = Math.floor(Date.now() / 1000),
): GiftHistoryCandle[] {
  const seed = seedByKey.get(resolveDeepLinkMatchKey(collectionName))
  if (!seed) return []
  const spec = HISTORY_SPEC[range]
  const alignedEnd = Math.floor((nowSeconds > 0 ? nowSeconds : ANCHOR_DAY_UTC) / spec.interval) * spec.interval
  const from = alignedEnd - spec.days * 86_400
  const count = Math.max(2, Math.floor((alignedEnd - from) / spec.interval))

  const baseEnd = minFloor(seed)
  // Actual executed sales clear slightly around the cheapest floor ask
  const endPrice = source === 'sales' ? Number((baseEnd * 0.992).toFixed(2)) : baseEnd
  const pctScale =
    range === 'hour24'
      ? seed.change24h
      : range === 'day3'
        ? (seed.change24h + seed.change7d) * 0.5
        : range === 'week1'
          ? seed.change7d
          : range === 'week2'
            ? (seed.change7d + seed.change30d) * 0.5
            : range === 'month1'
              ? seed.change30d
              : range === 'month2'
                ? seed.change30d * 1.35
                : range === 'month3'
                  ? seed.change30d * 1.65
                  : seed.change30d * 2.1

  const startPrice = endPrice / (1 + pctScale / 100)
  const h = hashSeed(`${seed.name}:${range}:${source}`)
  const phase1 = ((h & 0xff) / 255) * Math.PI * 2
  const phase2 = (((h >>> 8) & 0xff) / 255) * Math.PI * 2
  const volatility = source === 'sales' ? 0.026 : 0.018

  const closes: number[] = []
  for (let i = 0; i < count; i++) {
    const progress = i / (count - 1)
    const trend = startPrice + (endPrice - startPrice) * progress
    const wave =
      Math.sin(progress * Math.PI * 2.8 + phase1) * volatility
      + Math.cos(progress * Math.PI * 6.3 + phase2) * (volatility * 0.52)
    const raw = i === count - 1 ? endPrice : i === 0 ? startPrice : trend * (1 + wave)
    closes.push(Number(Math.max(0.01, raw).toFixed(2)))
  }

  return closes.map((close, idx) => {
    const open = idx === 0 ? Number((close * (1 - 0.006)).toFixed(2)) : closes[idx - 1]!
    const bodyMax = Math.max(open, close)
    const bodyMin = Math.min(open, close)
    const wickJitter = ((hashSeed(`${seed.name}:${idx}:${range}`) & 0xff) / 255) * 0.014 + 0.004
    const high = Number((bodyMax * (1 + wickJitter)).toFixed(2))
    const low = Number(Math.max(0.01, bodyMin * (1 - wickJitter * 0.9)).toFixed(2))
    return {
      date: new Date((from + idx * spec.interval) * 1000),
      open,
      high,
      low,
      close,
    }
  })
}
