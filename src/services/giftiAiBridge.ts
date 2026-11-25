import type { CollectionFloorsResponse } from '../contracts/companion.ts'
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'
import { formatCompanionPrice, formatMarketChange } from '../lib/format.ts'
import {
  DEFAULT_USDT_PER_GRAM,
  getBundledModels,
  getCheapestVenueFloor,
  getCollectionMetrics,
  getCollectionPeriodChange,
  getVenueQuotes,
} from './bundledMarketData.ts'
import { getLatestTonUsdtSnapshot } from './liveTicker.ts'

export type EphemeralAiProvider = 'openai' | 'gemini' | 'groq'

export interface GiftiSessionSnapshot {
  hasEphemeralKey: boolean
  provider: EphemeralAiProvider | null
  lastTranscript: string | null
  busy: boolean
  error: string | null
}

function configuredModel(envKey: string, fallback: string): string {
  const raw = (import.meta as { env?: Record<string, string> }).env?.[envKey]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
}

// Strictly in-memory RAM variables — NEVER written to localStorage, sessionStorage, cookies, URL, or EvenAppBridge!
let ephemeralApiKey = ''
let ephemeralProvider: EphemeralAiProvider | null = null
let lastTranscript: string | null = null
let inFlightCount = 0
let lastError: string | null = null
const sessionListeners = new Set<() => void>()

let cachedSessionSnapshot: GiftiSessionSnapshot = {
  hasEphemeralKey: false,
  provider: null,
  lastTranscript: null,
  busy: false,
  error: null,
}

function rebuildCachedSnapshot() {
  cachedSessionSnapshot = {
    hasEphemeralKey: ephemeralApiKey.length > 0,
    provider: ephemeralProvider,
    lastTranscript,
    busy: inFlightCount > 0,
    error: lastError,
  }
}

function emitSession() {
  rebuildCachedSnapshot()
  for (const listener of sessionListeners) listener()
}

export function detectAiProviderFromKey(rawKey: string): EphemeralAiProvider | null {
  const trimmed = rawKey.trim()
  if (/^AIza[0-9A-Za-z_-]{12,}$/.test(trimmed)) return 'gemini'
  if (/^gsk_[0-9A-Za-z_-]{12,}$/.test(trimmed)) return 'groq'
  if (/^sk-(?!ant-|or-)[0-9A-Za-z_-]{12,}$/.test(trimmed)) return 'openai'
  return null
}

/**
 * Sets a one-time AI API key strictly in JS RAM closure for the current page session.
 * Never persisted anywhere on disk or storage.
 */
export function setEphemeralAiToken(rawKey: string, explicitProvider?: EphemeralAiProvider): boolean {
  const clean = rawKey.trim()
  if (!clean) {
    ephemeralApiKey = ''
    ephemeralProvider = null
    lastError = null
    emitSession()
    return true
  }
  const resolved = explicitProvider ?? detectAiProviderFromKey(clean)
  if (!resolved) {
    lastError = 'Unrecognized key prefix — expected OpenAI (sk-...), Gemini (AIza...), or Groq (gsk_...).'
    emitSession()
    return false
  }
  ephemeralApiKey = clean
  ephemeralProvider = resolved
  lastError = null
  emitSession()
  return true
}

export function clearEphemeralAiToken(): void {
  ephemeralApiKey = ''
  ephemeralProvider = null
  lastError = null
  emitSession()
}

export function getGiftiSessionSnapshot(): GiftiSessionSnapshot {
  return cachedSessionSnapshot
}

export function subscribeGiftiSession(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => {
    sessionListeners.delete(listener)
  }
}

export function resetGiftiSessionForTests(): void {
  ephemeralApiKey = ''
  ephemeralProvider = null
  lastTranscript = null
  inFlightCount = 0
  lastError = null
  emitSession()
}

/** Wraps 16 kHz mono signed 16-bit little-endian PCM bytes into a standard 44-byte RIFF/WAVE Blob. */
export function pcm16ToWavBlob(pcm: Uint8Array): Blob {
  const byteLen = pcm.byteLength - (pcm.byteLength % 2)
  const buffer = new ArrayBuffer(44 + byteLen)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + byteLen, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format = 1
  view.setUint16(22, 1, true) // Mono = 1 channel
  view.setUint32(24, 16_000, true) // Sample rate = 16 kHz
  view.setUint32(28, 32_000, true) // Byte rate = 16000 * 2
  view.setUint16(32, 2, true) // Block align = 2
  view.setUint16(34, 16, true) // Bits per sample = 16
  writeAscii(36, 'data')
  view.setUint32(40, byteLen, true)

  new Uint8Array(buffer, 44).set(pcm.subarray(0, byteLen))
  return new Blob([buffer], { type: 'audio/wav' })
}

function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then(buf => {
    const bytes = new Uint8Array(buf)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }
    return btoa(bin)
  })
}

export async function transcribeWithEphemeralAiOrFallback(
  pcm: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  fallbackBrowserTranscript: () => string | null,
  fallbackWasmTranscribe?: (pcm: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  signal.throwIfAborted()
  const key = ephemeralApiKey
  const provider = ephemeralProvider

  if (key && provider) {
    try {
      const wav = pcm16ToWavBlob(pcm)
      if (provider === 'openai' || provider === 'groq') {
        const endpoint =
          provider === 'groq'
            ? 'https://api.groq.com/openai/v1/audio/transcriptions'
            : 'https://api.openai.com/v1/audio/transcriptions'
        const form = new FormData()
        form.append('file', wav, 'speech.wav')
        form.append(
          'model',
          provider === 'groq'
            ? configuredModel('VITE_GROQ_WHISPER_MODEL', 'whisper-large-v3-turbo')
            : configuredModel('VITE_OPENAI_WHISPER_MODEL', 'whisper-1'),
        )
        form.append('language', 'en')
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}` },
          body: form,
          signal,
        })
        if (res.ok) {
          const data = (await res.json()) as { text?: string }
          if (data.text?.trim()) {
            lastTranscript = data.text.trim()
            emitSession()
            return lastTranscript
          }
        }
      } else if (provider === 'gemini') {
        const b64 = await blobToBase64(wav)
        const geminiModel = configuredModel('VITE_GEMINI_MODEL', 'gemini-2.5-flash')
        const res = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key,
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    { text: 'Transcribe this spoken English question about Telegram Collectible Gifts verbatim. Output only the spoken words.' },
                    { inlineData: { mimeType: 'audio/wav', data: b64 } },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: 120,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal,
          },
        )
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
          }
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
          if (text) {
            lastTranscript = text
            emitSession()
            return text
          }
        }
      }
    } catch (err) {
      if (signal.aborted) throw err
      lastError = 'Token audio transcription failed — fell back to local speech decoder.'
      emitSession()
    }
  }

  // Zero-token path: prefer live browser SpeechRecognition sentence if captured, then offline SoundSwallower WASM
  const browserSpeech = fallbackBrowserTranscript()?.trim()
  if (browserSpeech) {
    lastTranscript = browserSpeech
    emitSession()
    return browserSpeech
  }

  if (fallbackWasmTranscribe) {
    const wasmText = (await fallbackWasmTranscribe(pcm, signal))?.trim() ?? null
    if (wasmText) {
      lastTranscript = wasmText
      emitSession()
      return wasmText
    }
  }

  return null
}

export interface GiftiAnswerResult {
  title: string
  answer: string
  collection: string
  /** Whether a collection 7d chart should accompany this answer (false for greetings, capability help, and off-topic replies). */
  showChart?: boolean
}

const SELLER_FEES: Record<string, number> = {
  Portals: 2.5,
  MRKT: 2.5,
  Tonnel: 3.0,
  Fragment: 5.0,
  Getgems: 5.0,
}

const CAPABILITY_OR_HELP_RE =
  /\b(what can you do|what do you do|who are you|what are you|what is gifti|how (?:do i|can i|to) use|how does (?:this|it|gifti) work|capabilities|commands|features|\bhelp\b|what should i ask)\b/i

const PURE_GREETING_RE =
  /^\s*(hi|hello|hey|yo|sup|hola|howdy|greetings|good\s+(morning|afternoon|evening)|gm|gn)(\s+(gifti|there|bot|ai|friend))?[!.,?\s]*$/i

const PURE_THANKS_RE =
  /^\s*(thanks|thank you|thx|ty|cool|nice|awesome|great|got it)(\s+gifti)?[!.,?\s]*$/i

const CONTROLS_OR_STANDALONE_RE =
  /\b(gesture|gestures|swipe|double[- ]?tap|head[- ]?nod|head[- ]?shake|\bimu\b|r1 ring|\bring\b|temple|how to control|voice command|voice commands|offline|standalone|without phone)\b/i

const MARKET_ANALYSIS_SIGNAL_RE =
  /\b(arb|arbitrage|spread|spreads|flip|flips|deal|deals|venue|venues|marketplace|marketplaces|fee|fees|cheap|cheapest|under|starter|affordable|budget|expensive|priciest|blue[- ]?chip|blue[- ]?chips|highest|lowest|rare|rarest|model|models|tier|tiers|variant|variants|grail|grails|permille|whale|whales|holder|holders|supply|emission|upgraded|health|greed|safe|risk|floor|floors|price|prices|worth|cost|chart|charts|trend|trending|momentum|gainer|gainers|loser|losers|mover|movers|dip|dipped|drop|dropped|pump|pumping|market|overview|summary|pulse|buy|buying|sell|selling|hold|holding|compare|vs|versus|stats|metrics|doing|perform|performance|hot)\b/i

export function classifyNonMarketGiftiIntent(
  question: string,
  hasMentionedCollection: boolean,
): 'capability' | 'thanks' | 'controls' | 'off-topic' | null {
  if (hasMentionedCollection) return null
  const trimmed = question.trim()
  if (!trimmed) return 'capability'
  if (PURE_THANKS_RE.test(trimmed)) return 'thanks'
  if (CONTROLS_OR_STANDALONE_RE.test(trimmed) && !MARKET_ANALYSIS_SIGNAL_RE.test(trimmed)) {
    return 'controls'
  }
  if (PURE_GREETING_RE.test(trimmed) || CAPABILITY_OR_HELP_RE.test(trimmed)) {
    // If the user greeted AND asked a concrete market question (e.g. "hello what is best arbitrage?"), let market routing handle it unless they asked what Gifti can do.
    if (!CAPABILITY_OR_HELP_RE.test(trimmed) && MARKET_ANALYSIS_SIGNAL_RE.test(trimmed)) return null
    return 'capability'
  }
  const hasBudgetNumber = /(\d+(?:\.\d+)?)\s*(ton|gram|usd|usdt|\$)/i.test(trimmed) || /\$\s*\d+/.test(trimmed)
  if (!hasBudgetNumber && !MARKET_ANALYSIS_SIGNAL_RE.test(trimmed)) {
    return 'off-topic'
  }
  return null
}

function buildGroundedMarketBriefing(catalog: CollectionFloorsResponse | null, focused: string): string {
  if (!catalog) return 'Catalog unavailable.'
  const usdt = getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM
  const names = Object.keys(catalog.collection_floors)
  const prioritized = [focused, ...names.filter(n => n !== focused)].slice(0, 10)

  const rows = prioritized.map(name => {
    const quotes = getVenueQuotes(catalog.collection_floors[name])
    const best = quotes[0]
    const high = quotes.at(-1)
    const ch24 = getCollectionPeriodChange(name, '24h') ?? 0
    const ch7 = getCollectionPeriodChange(name, '7d') ?? 0
    const m = getCollectionMetrics(name)
    const feePct = high ? (SELLER_FEES[high.marketplace] ?? 5) : 5
    const netArb =
      best && high && quotes.length >= 2
        ? Number((high.price * (1 - feePct / 100) - best.price).toFixed(2))
        : 0
    return `${name}: floor ${best?.price ?? 0} GRAM ($${best ? (best.price * usdt).toFixed(0) : 0}) on ${best?.marketplace ?? '?'}, 24h ${ch24 >= 0 ? '+' : ''}${ch24}%, 7d ${ch7 >= 0 ? '+' : ''}${ch7}%, netArb ${netArb >= 0 ? '+' : ''}${netArb} GRAM (${best?.marketplace ?? '?'}->${high?.marketplace ?? '?'}), health ${m?.healthScore ?? 80}/100, whales ${m?.whaleHoldPercent ?? 15}%`
  })

  return `Spot TON/GRAM = $${usdt.toFixed(2)} USDT.\nFocused gift: ${focused}.\n${rows.join('\n')}`
}

export function buildFreeDemoGiftiReply(
  question: string,
  defaultCollection: string,
  catalog: CollectionFloorsResponse | null,
  options?: { includeModeTag?: boolean },
): GiftiAnswerResult {
  const names = Object.keys(catalog?.collection_floors ?? {})
  const qNorm = resolveDeepLinkMatchKey(question)
  const lower = question.toLowerCase()
  const usdt = getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM
  const includeModeTag = options?.includeModeTag !== false

  const mentioned = names.filter(n => {
    const k = resolveDeepLinkMatchKey(n)
    return k.length >= 4 && qNorm.includes(k)
  })
  const primary = mentioned[0] ?? (names.includes(defaultCollection) ? defaultCollection : names[0] ?? 'Plush Pepe')
  const metaIntent = classifyNonMarketGiftiIntent(question, mentioned.length > 0)

  if (metaIntent === 'capability') {
    return {
      title: 'Gifti · Offline Analyst',
      collection: primary,
      showChart: false,
      answer:
        "Hi! I'm Gifti, your rule-based offline Telegram Gifts analyst on Even G2 (paste an optional OpenAI/Gemini/Groq key for live LLM). Ask me: 1) best 5-venue arbitrage, 2) top 24h movers or market pulse, 3) compare two gifts, or 4) rare ‰ tiers, whale risk & budget picks.",
    }
  }

  if (metaIntent === 'thanks') {
    return {
      title: 'Gifti · Offline Analyst',
      collection: primary,
      showChart: false,
      answer:
        'Happy to help! Ask anytime about gift floors, 5-venue net arbitrage, top 24h movers, rare ‰ model tiers, or whale concentration.',
    }
  }

  if (metaIntent === 'controls') {
    return {
      title: 'Gifti · G2 & R1 Controls',
      collection: primary,
      showChart: false,
      answer:
        'Swipe G2 temple or R1 Ring to browse, Tap to inspect, 2×Tap to go back, Hold Ring to speak (offline WASM), and Head-Nod/Shake on live /ask alerts (experimental). All 24 snapshot collections & speech run locally with zero backend.',
    }
  }

  if (metaIntent === 'off-topic') {
    return {
      title: 'Gifti · Offline Analyst',
      collection: primary,
      showChart: false,
      answer:
        "I'm tuned for Telegram Collectible Gifts on Even G2 — try asking about a gift floor (e.g. Plush Pepe), best 5-venue arbitrage, top 24h movers, whale health, or rare ‰ model tiers.",
    }
  }

  const tag = includeModeTag ? ' [rule-based]' : ''

  // 1. Two-collection comparison
  if (mentioned.length >= 2) {
    const [a, b] = [mentioned[0]!, mentioned[1]!]
    const fa = getCheapestVenueFloor(catalog?.collection_floors[a])
    const fb = getCheapestVenueFloor(catalog?.collection_floors[b])
    const ca = getCollectionPeriodChange(a, '7d') ?? 0
    const cb = getCollectionPeriodChange(b, '7d') ?? 0
    return {
      title: `Gifti · ${a} vs ${b}`,
      collection: a,
      showChart: true,
      answer: `${a}: ${formatCompanionPrice(fa?.price ?? 0)} GRAM (${fa?.marketplace ?? 'Portals'}, 7d ${formatMarketChange(ca)}) vs ${b}: ${formatCompanionPrice(fb?.price ?? 0)} GRAM (${fb?.marketplace ?? 'Portals'}, 7d ${formatMarketChange(cb)}).${tag}`,
    }
  }

  // 2. Cross-catalog best arbitrage scan (explicit "best/top/any/find arb" or market-wide arb query with no single gift named)
  if (
    /\b(best|top|highest|any|find|scan|good)\b.*\b(arb|arbitrage|spread|flip|flips|deal|deals)\b/.test(lower)
    || (mentioned.length === 0 && /\b(arb|arbitrage|flip|flips)\b/.test(lower) && !/\bvenue spread arbitrage\b/.test(lower))
  ) {
    let bestPick = { name: primary, net: -Infinity, buyV: 'Portals', buyP: 0, sellV: 'Fragment', sellP: 0 }
    for (const name of names) {
      const quotes = getVenueQuotes(catalog?.collection_floors[name])
      if (quotes.length < 2) continue
      const buy = quotes[0]!
      const sell = quotes.at(-1)!
      const fee = SELLER_FEES[sell.marketplace] ?? 5
      const net = Number((sell.price * (1 - fee / 100) - buy.price).toFixed(2))
      if (net > bestPick.net) {
        bestPick = { name, net, buyV: buy.marketplace, buyP: buy.price, sellV: sell.marketplace, sellP: sell.price }
      }
    }
    return {
      title: `Gifti · Best Arbitrage`,
      collection: bestPick.name,
      showChart: true,
      answer: `Top net spread is ${bestPick.name}: buy ${bestPick.buyV} @ ${formatCompanionPrice(bestPick.buyP)} GRAM, list ${bestPick.sellV} @ ${formatCompanionPrice(bestPick.sellP)} GRAM (+${formatCompanionPrice(Math.max(0, bestPick.net))} GRAM net of fees).${tag}`,
    }
  }

  // 3. Marketplace fee schedule comparison (when no specific gift is requested)
  if (mentioned.length === 0 && /\b(fee|fees|lowest fee|cheapest marketplace|which marketplace|which venue)\b/.test(lower)) {
    return {
      title: 'Gifti · 5-Venue Seller Fees',
      collection: primary,
      showChart: false,
      answer: `TON Gift marketplace seller fees: Portals 2.5%, MRKT 2.5%, Tonnel 3.0%, Fragment 5.0%, Getgems 5.0%. Always subtract seller fee before flipping.${tag}`,
    }
  }

  // 4. Most expensive / blue-chip collections across the market
  if (
    mentioned.length === 0
    && /\b(most expensive|priciest|highest floor|top floor|blue[- ]?chip|blue[- ]?chips|top collections)\b/.test(lower)
  ) {
    const rankedByFloor = names
      .map(n => ({ name: n, best: getCheapestVenueFloor(catalog?.collection_floors[n]) }))
      .filter((x): x is { name: string; best: NonNullable<typeof x.best> } => Boolean(x.best))
      .sort((a, b) => b.best.price - a.best.price)
    if (rankedByFloor.length >= 3) {
      const [c1, c2, c3] = [rankedByFloor[0]!, rankedByFloor[1]!, rankedByFloor[2]!]
      return {
        title: 'Gifti · Blue-Chip Leaders',
        collection: c1.name,
        showChart: true,
        answer: `Highest floors: 1) ${c1.name} ${formatCompanionPrice(c1.best.price)} GRAM (${c1.best.marketplace}), 2) ${c2.name} ${formatCompanionPrice(c2.best.price)} GRAM, 3) ${c3.name} ${formatCompanionPrice(c3.best.price)} GRAM.${tag}`,
      }
    }
  }

  // 5. Market-wide pulse / top movers / gainers / pullbacks (when no single gift is named)
  if (
    mentioned.length === 0
    && /\b(market|overview|summary|pulse|mover|movers|gainer|gainers|trending|hot|loser|losers|dip|dipped|drop|dropped|what changed)\b/.test(lower)
  ) {
    const ranked24h = names
      .map(n => ({
        name: n,
        best: getCheapestVenueFloor(catalog?.collection_floors[n]),
        ch24: getCollectionPeriodChange(n, '24h') ?? 0,
        health: getCollectionMetrics(n)?.healthScore ?? 80,
      }))
      .filter(x => Boolean(x.best))
      .sort((a, b) => b.ch24 - a.ch24)

    if (ranked24h.length >= 2) {
      if (/\b(loser|losers|dip|dipped|drop|dropped)\b/.test(lower)) {
        const d1 = ranked24h.at(-1)!
        const d2 = ranked24h.at(-2)!
        return {
          title: 'Gifti · 24h Pullbacks',
          collection: d1.name,
          showChart: true,
          answer: `Biggest 24h pullbacks across ${ranked24h.length} gifts: ${d1.name} (${formatMarketChange(d1.ch24)} @ ${formatCompanionPrice(d1.best!.price)} GRAM) and ${d2.name} (${formatMarketChange(d2.ch24)} @ ${formatCompanionPrice(d2.best!.price)} GRAM).${tag}`,
        }
      }
      const g1 = ranked24h[0]!
      const g2 = ranked24h[1]!
      const d1 = ranked24h.at(-1)!
      const avgHealth = Math.round(ranked24h.reduce((s, x) => s + x.health, 0) / ranked24h.length)
      return {
        title: 'Gifti · 24h Market Pulse',
        collection: g1.name,
        showChart: true,
        answer: `Tracking ${ranked24h.length} gifts (avg Health ${avgHealth}/100): top 24h gainers ${g1.name} (${formatMarketChange(g1.ch24)}, ${formatCompanionPrice(g1.best!.price)} GRAM) & ${g2.name} (${formatMarketChange(g2.ch24)}); sharpest dip ${d1.name} (${formatMarketChange(d1.ch24)}).${tag}`,
      }
    }
  }

  // 6. Budget / cheap entry recommendation
  const budgetMatch = /(\d+(?:\.\d+)?)\s*(ton|gram|usd|usdt|\$)/i.exec(question) ?? /\$\s*(\d+(?:\.\d+)?)/i.exec(question)
  if (budgetMatch || (mentioned.length === 0 && /\b(cheap|cheapest|under|starter|affordable|budget)\b/.test(lower))) {
    const rawAmt = budgetMatch ? Number(budgetMatch[1]) : 100
    const isUsd = budgetMatch ? (/usd|\$/i.test(budgetMatch[2] ?? '') || question.includes('$')) : false
    const capGram = isUsd ? rawAmt / usdt : rawAmt
    const candidates = names
      .map(n => ({ name: n, best: getCheapestVenueFloor(catalog?.collection_floors[n]), ch7: getCollectionPeriodChange(n, '7d') ?? 0 }))
      .filter(x => x.best && x.best.price <= capGram)
      .sort((a, b) => b.ch7 - a.ch7)
    if (candidates.length > 0) {
      const pick = candidates[0]!
      return {
        title: `Gifti · Under ${Math.round(capGram)} GRAM`,
        collection: pick.name,
        showChart: true,
        answer: `Best momentum under ${Math.round(capGram)} GRAM: ${pick.name} at ${formatCompanionPrice(pick.best!.price)} GRAM ($${formatCompanionPrice(Number((pick.best!.price * usdt).toFixed(2)))}) on ${pick.best!.marketplace} (${formatMarketChange(pick.ch7)} 7d).${tag}`,
      }
    }
  }

  // 7. Focused collection deep answer (arbitrage / rarity / whale / floor & momentum)
  const quotes = getVenueQuotes(catalog?.collection_floors[primary])
  const best = quotes[0]
  const high = quotes.at(-1)
  const m = getCollectionMetrics(primary)
  const ch24 = getCollectionPeriodChange(primary, '24h') ?? 0
  const ch7 = getCollectionPeriodChange(primary, '7d') ?? 0

  if (/\b(arb|arbitrage|spread|venue|venues|compare|flip)\b/.test(lower) && best && high && quotes.length >= 2) {
    const feePct = SELLER_FEES[high.marketplace] ?? 5
    const netGram = Number((high.price * (1 - feePct / 100) - best.price).toFixed(2))
    const grossPct = Number((((high.price - best.price) / best.price) * 100).toFixed(2))
    const edge =
      netGram > 0
        ? `net +${formatCompanionPrice(netGram)} GRAM after ${feePct}% ${high.marketplace} fee`
        : `fee-locked (${formatCompanionPrice(netGram)} GRAM after ${feePct}% fee vs +${grossPct}% gross)`
    return {
      title: `Gifti · ${primary} Arbitrage`,
      collection: primary,
      showChart: true,
      answer: `${primary} across ${quotes.length} venues: lowest ${formatCompanionPrice(best.price)} GRAM on ${best.marketplace} vs ${formatCompanionPrice(high.price)} GRAM on ${high.marketplace} — ${edge}.${tag}`,
    }
  }

  if (/\b(rare|rarest|model|models|tier|tiers|variant|variants|grail|permille)\b/.test(lower)) {
    const rarest = [...getBundledModels(primary)].sort((a, b) => (a.rarityPermille ?? 99) - (b.rarityPermille ?? 99))[0]
    const rf = rarest ? getCheapestVenueFloor(rarest.floors) : null
    return {
      title: `Gifti · ${primary} Rare Tiers`,
      collection: primary,
      showChart: true,
      answer: rarest && rf
        ? `${primary} grail tier is ${rarest.name} (${rarest.rarityPermille ?? 5}‰) at ${formatCompanionPrice(rf.price)} GRAM on ${rf.marketplace} (${best ? (rf.price / best.price).toFixed(2) : '1.5'}× base floor).${tag}`
        : `${primary} base floor is ${formatCompanionPrice(best?.price ?? 0)} GRAM on ${best?.marketplace ?? 'Portals'}.${tag}`,
    }
  }

  if (/\b(whale|whales|holder|holders|supply|emission|upgraded|health|greed|safe|risk)\b/.test(lower)) {
    return {
      title: `Gifti · ${primary} Fundamentals`,
      collection: primary,
      showChart: true,
      answer: `${primary} Health ${m?.healthScore ?? 82}/100, Greed ${m?.greedScore ?? 65}/100. Top-30 whales hold ${m?.whaleHoldPercent ?? 15}% across ${formatCompanionPrice(m?.uniqueOwners ?? 4200)} owners.${tag}`,
    }
  }

  const spreadPart =
    best && high && quotes.length >= 2
      ? ` Best venue: ${best.marketplace} (${formatCompanionPrice(best.price)} GRAM) vs ${high.marketplace} (${formatCompanionPrice(high.price)} GRAM).`
      : ''
  return {
    title: `Gifti · ${primary}`,
    collection: primary,
    showChart: true,
    answer: `${primary} trades at ${formatCompanionPrice(best?.price ?? 0)} GRAM (≈ $${formatCompanionPrice(Number(((best?.price ?? 0) * usdt).toFixed(2)))}) — 24h ${formatMarketChange(ch24)}, 7d ${formatMarketChange(ch7)}.${spreadPart}${tag}`,
  }
}

export async function askGiftiAiQuestion(
  question: string,
  defaultCollection: string,
  catalog: CollectionFloorsResponse | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<GiftiAnswerResult> {
  signal?.throwIfAborted()
  const cleanQuestion = question.trim()
  lastTranscript = cleanQuestion || lastTranscript
  inFlightCount++
  lastError = null
  emitSession()

  const names = Object.keys(catalog?.collection_floors ?? {})
  const qNorm = resolveDeepLinkMatchKey(cleanQuestion)
  const explicitMention = names.find(n => {
    const k = resolveDeepLinkMatchKey(n)
    return k.length >= 4 && qNorm.includes(k)
  })
  const matchedCollection =
    explicitMention ?? (names.includes(defaultCollection) ? defaultCollection : names[0] ?? 'Plush Pepe')
  const metaIntent = classifyNonMarketGiftiIntent(cleanQuestion, Boolean(explicitMention))

  try {
    if (ephemeralApiKey && ephemeralProvider) {
      const activeKey = ephemeralApiKey
      const activeProvider = ephemeralProvider
      const systemPrompt =
        'You are Gifti, the Telegram Collectible Gifts AI copilot displayed on Even Realities G2 smart glasses (576x288 HUD) and R1 Ring. ' +
        'If the user greets you or asks what you can do, introduce yourself warmly in 1-2 crisp sentences and mention your capabilities: scanning 5-venue net arbitrage (Portals, Tonnel, MRKT, Fragment, Getgems), comparing gift floors & 24h/7d momentum, checking rare permille (‰) model tiers & whale health, and beaming charts to Telegram. ' +
        'For market questions, answer in 1-2 crisp sentences (max 210 characters) using exact GRAM/USDT prices and venue names from the provided market context. Never invent prices.\n\n' +
        buildGroundedMarketBriefing(catalog, matchedCollection)

      const liveTitle = metaIntent ? 'Gifti AI · G2 Copilot' : `Gifti AI · ${matchedCollection}`
      const liveShowChart = !metaIntent

      if (activeProvider === 'openai' || activeProvider === 'groq') {
        const endpoint =
          activeProvider === 'groq'
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : 'https://api.openai.com/v1/chat/completions'
        const model =
          activeProvider === 'groq'
            ? configuredModel('VITE_GROQ_MODEL', 'llama-3.3-70b-versatile')
            : configuredModel('VITE_OPENAI_MODEL', 'gpt-4o-mini')
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 160,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: cleanQuestion },
            ],
          }),
          signal,
        })
        if (!res.ok) throw new Error(`${activeProvider.toUpperCase()} HTTP ${res.status}`)
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const reply = data.choices?.[0]?.message?.content?.trim()
        if (!reply) throw new Error(`${activeProvider.toUpperCase()} returned empty reply`)
        return {
          title: liveTitle,
          collection: matchedCollection,
          showChart: liveShowChart,
          answer: reply,
        }
      } else if (activeProvider === 'gemini') {
        const geminiModel = configuredModel('VITE_GEMINI_MODEL', 'gemini-2.5-flash')
        const res = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': activeKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: cleanQuestion }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 200,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal,
          },
        )
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`)
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
        if (!reply) throw new Error('Gemini returned empty reply')
        return {
          title: liveTitle,
          collection: matchedCollection,
          showChart: liveShowChart,
          answer: reply,
        }
      }
    }

    return buildFreeDemoGiftiReply(cleanQuestion, matchedCollection, catalog)
  } catch (err) {
    if (signal?.aborted) throw err
    lastError = err instanceof Error ? `${err.message} (using offline rule-based Gifti analyst)` : 'AI request failed'
    return buildFreeDemoGiftiReply(cleanQuestion, matchedCollection, catalog)
  } finally {
    inFlightCount = Math.max(0, inFlightCount - 1)
    emitSession()
  }
}
