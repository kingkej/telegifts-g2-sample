import { DEFAULT_USDT_PER_GRAM } from './bundledMarketData.ts'

export interface TonUsdtTickerSnapshot {
  usd: number
  change24h: number | null
  source: 'live' | 'snapshot'
  updatedAt: number
}

const COINGECKO_SIMPLE_PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&include_24hr_change=true'

const CACHE_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 2_500

let cached: TonUsdtTickerSnapshot = {
  usd: DEFAULT_USDT_PER_GRAM,
  change24h: null,
  source: 'snapshot',
  updatedAt: 0,
}

let inFlight: Promise<TonUsdtTickerSnapshot> | null = null
let latestFetchSeq = 0

export function getLatestTonUsdtSnapshot(): TonUsdtTickerSnapshot {
  return cached
}

export function resetLiveTonUsdtCacheForTests(): void {
  cached = {
    usd: DEFAULT_USDT_PER_GRAM,
    change24h: null,
    source: 'snapshot',
    updatedAt: 0,
  }
  inFlight = null
  latestFetchSeq = 0
}

export async function fetchLiveTonUsdtRate(options?: {
  force?: boolean
  fetchImpl?: typeof fetch
  nowMs?: number
}): Promise<TonUsdtTickerSnapshot> {
  const now = options?.nowMs ?? Date.now()
  if (!options?.force && cached.source === 'live' && now - cached.updatedAt < CACHE_TTL_MS) {
    return cached
  }
  if (inFlight && !options?.force) return inFlight

  const fetcher = options?.fetchImpl ?? globalThis.fetch
  if (typeof fetcher !== 'function') return cached

  const seq = ++latestFetchSeq
  let run: Promise<TonUsdtTickerSnapshot> | null = null
  const promise = (async (): Promise<TonUsdtTickerSnapshot> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const res = await fetcher(COINGECKO_SIMPLE_PRICE_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return cached
      const json = (await res.json()) as {
        'the-open-network'?: { usd?: unknown; usd_24h_change?: unknown }
      }
      const rawUsd = json?.['the-open-network']?.usd
      const rawChange = json?.['the-open-network']?.usd_24h_change
      if (
        seq === latestFetchSeq
        && typeof rawUsd === 'number'
        && Number.isFinite(rawUsd)
        && rawUsd > 0
        && rawUsd < 10_000
      ) {
        cached = {
          usd: Number(rawUsd.toFixed(4)),
          change24h:
            typeof rawChange === 'number' && Number.isFinite(rawChange)
              ? Number(rawChange.toFixed(2))
              : null,
          source: 'live',
          updatedAt: options?.nowMs ?? Date.now(),
        }
      }
      return cached
    } catch {
      return cached
    } finally {
      clearTimeout(timer)
      if (inFlight === run) inFlight = null
    }
  })()

  run = promise
  inFlight = promise
  return promise
}

export function startLiveTonUsdtTicker(
  onRate: (usd: number, snapshot: TonUsdtTickerSnapshot) => void,
  options?: { intervalMs?: number; fetchImpl?: typeof fetch },
): () => void {
  let stopped = false
  const intervalMs = options?.intervalMs ?? CACHE_TTL_MS

  const tick = async (force = false) => {
    const snap = await fetchLiveTonUsdtRate({ force, fetchImpl: options?.fetchImpl })
    if (!stopped) onRate(snap.usd, snap)
  }

  onRate(cached.usd, cached)
  void tick(false)

  const timer = setInterval(() => {
    void tick(true)
  }, intervalMs)
  ;(timer as { unref?: () => void }).unref?.()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}
