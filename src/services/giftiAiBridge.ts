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
  freeTurnsRemaining: number
  freeTurnsTotal: number
  lastTranscript: string | null
  busy: boolean
  error: string | null
}

const FREE_DEMO_TURNS_TOTAL = 20

// Strictly in-memory RAM variables — NEVER written to localStorage, sessionStorage, cookies, URL, or EvenAppBridge!
let ephemeralApiKey = ''
let ephemeralProvider: EphemeralAiProvider | null = null
let freeTurnsRemaining = FREE_DEMO_TURNS_TOTAL
let lastTranscript: string | null = null
let inFlightCount = 0
let lastError: string | null = null
const sessionListeners = new Set<() => void>()

let cachedSessionSnapshot: GiftiSessionSnapshot = {
  hasEphemeralKey: false,
  provider: null,
  freeTurnsRemaining: FREE_DEMO_TURNS_TOTAL,
  freeTurnsTotal: FREE_DEMO_TURNS_TOTAL,
  lastTranscript: null,
  busy: false,
  error: null,
}

function rebuildCachedSnapshot() {
  cachedSessionSnapshot = {
    hasEphemeralKey: ephemeralApiKey.length > 0,
    provider: ephemeralProvider,
    freeTurnsRemaining,
    freeTurnsTotal: FREE_DEMO_TURNS_TOTAL,
    lastTranscript,
    busy: inFlightCount > 0,
    error: lastError,
  }
}

function emitSession() {
  rebuildCachedSnapshot()
  for (const listener of sessionListeners) listener()
}

export function detectAiProviderFromKey(rawKey: string): EphemeralAiProvider {
  const trimmed = rawKey.trim()
  if (/^AIza[0-9A-Za-z_-]{12,}$/.test(trimmed)) return 'gemini'
  if (/^gsk_[0-9A-Za-z_-]{12,}$/.test(trimmed)) return 'groq'
  return 'openai'
}

/**
 * Sets a one-time AI API key strictly in JS RAM closure for the current page session.
 * Never persisted anywhere on disk or storage.
 */
export function setEphemeralAiToken(rawKey: string, explicitProvider?: EphemeralAiProvider): void {
  const clean = rawKey.trim()
  if (!clean) {
    ephemeralApiKey = ''
    ephemeralProvider = null
    lastError = null
    emitSession()
    return
  }
  ephemeralApiKey = clean
  ephemeralProvider = explicitProvider ?? detectAiProviderFromKey(clean)
  lastError = null
  emitSession()
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
  freeTurnsRemaining = FREE_DEMO_TURNS_TOTAL
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
        form.append('model', provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1')
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
        const res = await fetchImpl(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
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

const SELLER_FEES: Record<string, number> = {
  Portals: 2.5,
  MRKT: 2.5,
  Tonnel: 3.0,
  Fragment: 5.0,
  Getgems: 5.0,
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

function buildFreeDemoGiftiReply(
  question: string,
  defaultCollection: string,
  catalog: CollectionFloorsResponse | null,
  options?: { consumeFreeTurn?: boolean },
): { title: string; answer: string; collection: string } {
  const names = Object.keys(catalog?.collection_floors ?? {})
  const qNorm = resolveDeepLinkMatchKey(question)
  const lower = question.toLowerCase()
  const usdt = getLatestTonUsdtSnapshot().usd || DEFAULT_USDT_PER_GRAM
  const consumeTurn = options?.consumeFreeTurn !== false

  const mentioned = names.filter(n => {
    const k = resolveDeepLinkMatchKey(n)
    return k.length >= 4 && qNorm.includes(k)
  })
  const primary = mentioned[0] ?? (names.includes(defaultCollection) ? defaultCollection : names[0] ?? 'Plush Pepe')

  if (consumeTurn && freeTurnsRemaining <= 0) {
    return {
      title: 'Gifti · Demo Limit',
      collection: primary,
      answer: '20/20 free demo messages used in this session. Paste a 1-time OpenAI, Gemini, or Groq key (RAM-only, never saved) for unlimited live AI turns.',
    }
  }

  if (consumeTurn) {
    freeTurnsRemaining = Math.max(0, freeTurnsRemaining - 1)
  }
  const tag = consumeTurn ? `[${freeTurnsRemaining}/${FREE_DEMO_TURNS_TOTAL} free]` : '[local fallback]'

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
      answer: `${a}: ${formatCompanionPrice(fa?.price ?? 0)} GRAM (${fa?.marketplace ?? 'Portals'}, 7d ${formatMarketChange(ca)}) vs ${b}: ${formatCompanionPrice(fb?.price ?? 0)} GRAM (${fb?.marketplace ?? 'Portals'}, 7d ${formatMarketChange(cb)}). ${tag}`,
    }
  }

  // 2. Cross-catalog best arbitrage scan
  if (/\b(best|top|highest)\b.*\b(arb|spread|flip|deal)\b/.test(lower)) {
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
      answer: `Top net spread is ${bestPick.name}: buy ${bestPick.buyV} @ ${formatCompanionPrice(bestPick.buyP)} GRAM, list ${bestPick.sellV} @ ${formatCompanionPrice(bestPick.sellP)} GRAM (+${formatCompanionPrice(Math.max(0, bestPick.net))} GRAM net of fees). ${tag}`,
    }
  }

  // 3. Budget / cheap entry recommendation
  const budgetMatch = /(\d+(?:\.\d+)?)\s*(ton|gram|usd|usdt|\$)/i.exec(question)
  if (budgetMatch || /\b(cheap|under|starter|affordable|budget)\b/.test(lower)) {
    const rawAmt = budgetMatch ? Number(budgetMatch[1]) : 100
    const isUsd = budgetMatch ? /usd|\$/i.test(budgetMatch[2]!) : false
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
        answer: `Best momentum under ${Math.round(capGram)} GRAM: ${pick.name} at ${formatCompanionPrice(pick.best!.price)} GRAM ($${formatCompanionPrice(Number((pick.best!.price * usdt).toFixed(2)))}) on ${pick.best!.marketplace} (${formatMarketChange(pick.ch7)} 7d). ${tag}`,
      }
    }
  }

  // 4. Focused collection deep answer (rarity / whale / spread / general)
  const quotes = getVenueQuotes(catalog?.collection_floors[primary])
  const best = quotes[0]
  const high = quotes.at(-1)
  const m = getCollectionMetrics(primary)
  const ch24 = getCollectionPeriodChange(primary, '24h') ?? 0
  const ch7 = getCollectionPeriodChange(primary, '7d') ?? 0

  if (/\b(rare|model|tier|variant|grail)\b/.test(lower)) {
    const rarest = [...getBundledModels(primary)].sort((a, b) => (a.rarityPermille ?? 99) - (b.rarityPermille ?? 99))[0]
    const rf = rarest ? getCheapestVenueFloor(rarest.floors) : null
    return {
      title: `Gifti · ${primary}`,
      collection: primary,
      answer: rarest && rf
        ? `${primary} grail tier is ${rarest.name} (${rarest.rarityPermille ?? 5}‰) at ${formatCompanionPrice(rf.price)} GRAM on ${rf.marketplace} (${best ? (rf.price / best.price).toFixed(2) : '1.5'}× base floor). ${tag}`
        : `${primary} base floor is ${formatCompanionPrice(best?.price ?? 0)} GRAM on ${best?.marketplace ?? 'Portals'}. ${tag}`,
    }
  }

  if (/\b(whale|holder|supply|health|greed|safe|risk)\b/.test(lower)) {
    return {
      title: `Gifti · ${primary}`,
      collection: primary,
      answer: `${primary} Health ${m?.healthScore ?? 82}/100, Greed ${m?.greedScore ?? 65}/100. Top-30 whales hold ${m?.whaleHoldPercent ?? 15}% across ${formatCompanionPrice(m?.uniqueOwners ?? 4200)} owners. ${tag}`,
    }
  }

  const spreadPart =
    best && high && quotes.length >= 2
      ? ` Best venue: ${best.marketplace} (${formatCompanionPrice(best.price)} GRAM) vs ${high.marketplace} (${formatCompanionPrice(high.price)} GRAM).`
      : ''
  return {
    title: `Gifti · ${primary}`,
    collection: primary,
    answer: `${primary} trades at ${formatCompanionPrice(best?.price ?? 0)} GRAM (≈ $${formatCompanionPrice(Number(((best?.price ?? 0) * usdt).toFixed(2)))}) — 24h ${formatMarketChange(ch24)}, 7d ${formatMarketChange(ch7)}.${spreadPart} ${tag}`,
  }
}

export async function askGiftiAiQuestion(
  question: string,
  defaultCollection: string,
  catalog: CollectionFloorsResponse | null,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ title: string; answer: string; collection: string }> {
  signal?.throwIfAborted()
  const cleanQuestion = question.trim()
  lastTranscript = cleanQuestion || lastTranscript
  inFlightCount++
  lastError = null
  emitSession()

  const names = Object.keys(catalog?.collection_floors ?? {})
  const qNorm = resolveDeepLinkMatchKey(cleanQuestion)
  const matchedCollection =
    names.find(n => {
      const k = resolveDeepLinkMatchKey(n)
      return k.length >= 4 && qNorm.includes(k)
    })
    ?? (names.includes(defaultCollection) ? defaultCollection : names[0] ?? 'Plush Pepe')

  const hadEphemeralKey = Boolean(ephemeralApiKey && ephemeralProvider)

  try {
    if (ephemeralApiKey && ephemeralProvider) {
      const activeKey = ephemeralApiKey
      const activeProvider = ephemeralProvider
      const systemPrompt =
        'You are Gifti, a concise Telegram Collectible Gifts analyst displayed on Even Realities G2 smart glasses (576x288 HUD). ' +
        'Answer in 1-2 crisp sentences (max 210 characters) using exact GRAM/USDT prices and venue names from the provided market context. Never invent prices.\n\n' +
        buildGroundedMarketBriefing(catalog, matchedCollection)

      if (activeProvider === 'openai' || activeProvider === 'groq') {
        const endpoint =
          activeProvider === 'groq'
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : 'https://api.openai.com/v1/chat/completions'
        const model = activeProvider === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini'
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
          title: `Gifti AI · ${matchedCollection}`,
          collection: matchedCollection,
          answer: reply,
        }
      } else if (activeProvider === 'gemini') {
        const res = await fetchImpl(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
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
          title: `Gifti AI · ${matchedCollection}`,
          collection: matchedCollection,
          answer: reply,
        }
      }
    }

    return buildFreeDemoGiftiReply(cleanQuestion, matchedCollection, catalog, { consumeFreeTurn: true })
  } catch (err) {
    if (signal?.aborted) throw err
    lastError = err instanceof Error ? `${err.message} (using built-in Gifti analyst)` : 'AI request failed'
    return buildFreeDemoGiftiReply(cleanQuestion, matchedCollection, catalog, {
      consumeFreeTurn: !hadEphemeralKey,
    })
  } finally {
    inFlightCount = Math.max(0, inFlightCount - 1)
    emitSession()
  }
}
