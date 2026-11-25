import assert from 'node:assert/strict'
import test from 'node:test'
import { toolView } from '../src/toolDisplay.ts'
import { getBundledCatalog } from '../src/services/bundledMarketData.ts'
import { createCollectorToolbox } from '../src/services/collectorTools.ts'
import {
  askGiftiAiQuestion,
  clearEphemeralAiToken,
  detectAiProviderFromKey,
  getGiftiSessionSnapshot,
  pcm16ToWavBlob,
  resetGiftiSessionForTests,
  setEphemeralAiToken,
  transcribeWithEphemeralAiOrFallback,
} from '../src/services/giftiAiBridge.ts'
import { hostHttpFetch, PUBLIC_API_ORIGIN } from '../src/services/phoneHostBridge.ts'
import { fetchTonAddressGiftPortfolio, isLikelyTonAddress } from '../src/services/tonPortfolio.ts'

test('Gift Sets routes return clean empty state while Gifti AI bridge enforces 20 free turns and strictly RAM-only ephemeral tokens', async () => {
  const setsRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/v1/telegifts/gift-sets?limit=20&offset=0`)
  assert.equal(setsRes.status, 200)
  const emptySets = await setsRes.json()
  assert.deepEqual(emptySets, { items: [], total: 0, has_more: false })

  const detailRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/v1/telegifts/gift-sets/detail?set_name=Any`)
  assert.equal(detailRes.status, 404)

  // Verify provider auto-detection & RAM-only ephemeral key behavior (never touches storage)
  resetGiftiSessionForTests()
  assert.equal(detectAiProviderFromKey('sk-proj-1234567890abcdefghijklmnop'), 'openai')
  assert.equal(detectAiProviderFromKey('AIzaSyA1234567890abcdefghijklmnop'), 'gemini')
  assert.equal(detectAiProviderFromKey('gsk_1234567890abcdefghijklmnopqrstuv'), 'groq')

  // Valid 44-byte RIFF/WAVE header on 16kHz PCM
  const samplePcm = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x10, 0x00, 0x20, 0x00])
  const wav = pcm16ToWavBlob(samplePcm)
  assert.equal(wav.size, 44 + samplePcm.byteLength)
  const wavBytes = new Uint8Array(await wav.arrayBuffer())
  assert.equal(String.fromCharCode(...wavBytes.subarray(0, 4)), 'RIFF')
  assert.equal(String.fromCharCode(...wavBytes.subarray(8, 12)), 'WAVE')

  const catalog = getBundledCatalog()
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)

  // Free turn #1: best net arbitrage scan
  const arbReply = await askGiftiAiQuestion('What is the best net arbitrage spread right now?', 'Plush Pepe', catalog)
  assert.match(arbReply.title, /Best Arbitrage/)
  assert.match(arbReply.answer, /\[19\/20 free\]/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 19)

  // Free turn #2: two-gift comparison
  const cmpReply = await askGiftiAiQuestion('Compare Plush Pepe and Astral Shard', 'Plush Pepe', catalog)
  assert.match(cmpReply.title, /Plush Pepe vs Astral Shard/)
  assert.match(cmpReply.answer, /\[18\/20 free\]/)

  // Exhaust remaining 18 free turns and verify cap message on turn #21
  for (let i = 0; i < 18; i++) {
    await askGiftiAiQuestion('How is Plush Pepe doing?', 'Plush Pepe', catalog)
  }
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 0)
  const capped = await askGiftiAiQuestion('One more free turn?', 'Plush Pepe', catalog)
  assert.match(capped.title, /Demo Limit/)
  assert.match(capped.answer, /20\/20 free demo messages used/)

  // Applying a 1-time RAM-only key bypasses the free cap, calls Whisper + LLM, and never touches localStorage
  setEphemeralAiToken('gsk_test_ephemeral_session_key_1234567890')
  assert.equal(getGiftiSessionSnapshot().hasEphemeralKey, true)
  assert.equal(getGiftiSessionSnapshot().provider, 'groq')

  const mockGroqFetch = async url => {
    if (String(url).includes('/audio/transcriptions')) {
      return new Response(JSON.stringify({ text: 'How rare is Astral Shard?' }), { status: 200 })
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Astral Shard floor is 1,180 GRAM on Portals with strong 7d demand.' } }],
      }),
      { status: 200 },
    )
  }

  const spoken = await transcribeWithEphemeralAiOrFallback(
    samplePcm,
    new AbortController().signal,
    () => null,
    undefined,
    mockGroqFetch,
  )
  assert.equal(spoken, 'How rare is Astral Shard?')

  const liveAi = await askGiftiAiQuestion(spoken, 'Plush Pepe', catalog, undefined, mockGroqFetch)
  assert.equal(liveAi.collection, 'Astral Shard')
  assert.match(liveAi.answer, /1,180 GRAM/)

  // Verify Gemini sends key strictly via x-goog-api-key header (never in URL query string) and preserves free quota on error
  setEphemeralAiToken('AIzaSyTestEphemeralGeminiKey1234567890')
  assert.equal(getGiftiSessionSnapshot().provider, 'gemini')
  let geminiUrlSeen = ''
  let geminiHeadersSeen = {}
  const mockGeminiFetch = async (url, init) => {
    geminiUrlSeen = String(url)
    geminiHeadersSeen = init?.headers ?? {}
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Plush Pepe leads 5-venue liquidity at 4,820 GRAM.' }] } }],
      }),
      { status: 200 },
    )
  }
  const geminiReply = await askGiftiAiQuestion('Tell me about Plush Pepe', 'Plush Pepe', catalog, undefined, mockGeminiFetch)
  assert.equal(geminiUrlSeen.includes('key='), false, 'Gemini API key must never appear in URL query string')
  assert.equal(geminiHeadersSeen['x-goog-api-key'], 'AIzaSyTestEphemeralGeminiKey1234567890')
  assert.match(geminiReply.answer, /4,820 GRAM/)

  // Pre-aborted signal throws AbortError immediately without mutating freeTurnsRemaining
  clearEphemeralAiToken()
  resetGiftiSessionForTests()
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(() => askGiftiAiQuestion('Should abort', 'Plush Pepe', catalog, preAborted.signal))
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)
})

test('Tools -> Portfolio & Floor Resolver endpoints price @username and public TON wallet addresses (with TonAPI mapping + fallback)', async () => {
  assert.equal(isLikelyTonAddress('UQCiS2kxLhIh8f4t05QUps3ODPoN7NQe__BiY2--QaKtJw8_'), true)
  assert.equal(isLikelyTonAddress('durov.ton'), true)
  assert.equal(isLikelyTonAddress('@collector'), false)

  // 1. SwiftGifts cursor portfolio endpoint for @collector
  const profileRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/v1/api/price_profile?username=%40collector&limit=50`)
  assert.equal(profileRes.status, 200)
  const profile = await profileRes.json()
  assert.equal(profile.has_more, false)
  assert.ok(profile.gifts.length >= 4)
  assert.equal(profile.gifts[0].collection, 'Plush Pepe')
  assert.equal(profile.gifts[0].floor_tier, 'combo')
  assert.ok(profile.gifts[0].floor_ton > 0)
  assert.ok(
    !String(profile.gifts[0].image_url).startsWith('/api/a/'),
    'Portfolio gifts use bundled WebP or SVG data URLs so native <img> tags never break',
  )

  // 2. Floor resolver POST /api/v1/api/floors/resolve returns pipe-keyed provider breakdowns
  const firstGift = profile.gifts[0]
  const resolveRes = await hostHttpFetch(`${PUBLIC_API_ORIGIN}/api/v1/api/floors/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      triples: [{ collection: firstGift.collection, model: firstGift.model, backdrop: firstGift.backdrop }],
    }),
  })
  assert.equal(resolveRes.status, 200)
  const resolvedMap = await resolveRes.json()
  const lookupKey = `${firstGift.collection}|${firstGift.model}|${firstGift.backdrop}`
  assert.ok(resolvedMap[lookupKey], 'Floor resolver returns exact collection|model|backdrop key')
  assert.ok(Object.values(resolvedMap[lookupKey]).some(v => typeof v === 'number' && v > 0))

  // 3. TonAPI public wallet address mapping
  const catalog = getBundledCatalog()
  const mockTonFetch = async () =>
    new Response(
      JSON.stringify({
        nft_items: [
          {
            index: 18,
            collection: { name: 'Astral Shard' },
            metadata: {
              name: 'Astral Shard #19',
              attributes: [
                { trait_type: 'Model', value: 'Cyberpunk' },
                { trait_type: 'Backdrop', value: 'Emerald' },
                { trait_type: 'Symbol', value: 'Diamond' },
              ],
            },
          },
          {
            index: 1,
            collection: { name: 'Unrelated TON DNS' },
            metadata: { name: 'alice.ton' },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )

  const onchain = await fetchTonAddressGiftPortfolio(
    'UQCiS2kxLhIh8f4t05QUps3ODPoN7NQe__BiY2--QaKtJw8_',
    catalog,
    mockTonFetch,
  )
  assert.equal(onchain.ok, true)
  assert.equal(onchain.gifts.length, 1)
  assert.equal(onchain.gifts[0].collection, 'Astral Shard')
  assert.equal(onchain.gifts[0].number, 19)
  assert.equal(onchain.gifts[0].backdrop, 'Emerald')
})

test('CollectorToolbox research tool toggles 256x144 5-venue spread bars on G2 and dispatches spread PNG to Telegram', async () => {
  const catalog = getBundledCatalog()
  const dispatched = []
  const toolbox = createCollectorToolbox(
    {
      getCatalog: () => catalog,
      getFavoriteNames: () => ['Plush Pepe'],
      openChart: () => true,
      openTelegramDigest: () => {},
      sendTelegramCard: async payload => {
        dispatched.push(payload)
      },
    },
    () => 'Plush Pepe',
  )

  toolbox.open('research', { collection: 'Plush Pepe' }, 'glasses')
  let snap = toolbox.getSnapshot()
  assert.ok(snap.chart, 'Starts on 7d floor chart')
  assert.equal(snap.framePixels, undefined)

  toolbox.act(snap, 'toggle-spread')
  snap = toolbox.getSnapshot()
  assert.match(snap.title, /Spread Research · Plush Pepe/)
  assert.equal(snap.framePixels?.length, 256 * 144, 'Exposes 256x144 5-venue spread framePixels for G2 HUD')
  const view = toolView(snap, 0, undefined, true)
  const bodyRows = view.content.split('\n').slice(0, -2)
  for (const row of bodyRows) {
    assert.ok([...row].length <= 23, `Split-pane row "${row}" fits 23-char half-screen width`)
  }

  toolbox.act(snap, 'send-spread-dm')
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].attachKind, 'spread')
  assert.equal(dispatched[0].collection, 'Plush Pepe')

  // Also verify submitGiftiPrompt opens 'gifti' and resolves prompt into snapshot
  const submitted = await toolbox.submitGiftiPrompt('What is the venue spread for Astral Shard?', 'phone')
  assert.equal(submitted, true)
  const giftiSnap = toolbox.getSnapshot()
  assert.equal(toolbox.getActiveTool(), 'gifti')
  assert.match(giftiSnap.title, /Gifti · Astral Shard/)
})

test('Gifti handles greetings, "hello what can you do", controls/standalone help, market pulse, and off-topic questions naturally without fake Topic chrome or 22-char truncation', async () => {
  resetGiftiSessionForTests()
  const catalog = getBundledCatalog()

  // 1. "hello what can you do" returns capabilities intro, hides irrelevant chart, and does NOT burn a free turn!
  const capReply = await askGiftiAiQuestion('hello what can you do', 'Plush Pepe', catalog)
  assert.equal(capReply.title, 'Gifti · G2 Market Copilot')
  assert.equal(capReply.showChart, false)
  assert.match(capReply.answer, /I'm Gifti, your Telegram Collectible Gifts copilot on Even G2/)
  assert.doesNotMatch(capReply.answer, /Plush Pepe trades at/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20, 'Capability/greeting queries must not burn free demo turns')

  // 2. Pure greeting ("Hi!") and thanks ("thank you") also preserve quota and omit random floor dumps
  const hiReply = await askGiftiAiQuestion('Hi!', 'Plush Pepe', catalog)
  assert.equal(hiReply.title, 'Gifti · G2 Market Copilot')
  assert.equal(hiReply.showChart, false)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)

  const thxReply = await askGiftiAiQuestion('thank you!', 'Plush Pepe', catalog)
  assert.equal(thxReply.showChart, false)
  assert.match(thxReply.answer, /Happy to help/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)

  // 3. Controls & standalone question explains G2 temple/R1 Ring/offline WASM standalone operation without burning quota
  const ctrlReply = await askGiftiAiQuestion('Can this work standalone with gestures and voice commands?', 'Plush Pepe', catalog)
  assert.equal(ctrlReply.title, 'Gifti · G2 & R1 Controls')
  assert.equal(ctrlReply.showChart, false)
  assert.match(ctrlReply.answer, /standalone in Even App with zero backend/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)

  // 4. Off-topic question ("what is the weather today") gives polite Gifti scope nudge instead of Plush Pepe floor
  const offTopic = await askGiftiAiQuestion('what is the weather today?', 'Plush Pepe', catalog)
  assert.equal(offTopic.title, 'Gifti · G2 Market Copilot')
  assert.equal(offTopic.showChart, false)
  assert.match(offTopic.answer, /tuned for Telegram Collectible Gifts/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 20)

  // 5. Market-wide queries ("how is the market today / top movers" & "most expensive gift") compute real catalog leaders and DO consume a turn
  const pulseReply = await askGiftiAiQuestion('How is the market today? Any top movers?', 'Plush Pepe', catalog)
  assert.equal(pulseReply.title, 'Gifti · 24h Market Pulse')
  assert.equal(pulseReply.showChart, true)
  assert.match(pulseReply.answer, /top 24h gainers/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 19)

  const blueChip = await askGiftiAiQuestion('What is the most expensive gift collection?', 'Astral Shard', catalog)
  assert.equal(blueChip.title, 'Gifti · Blue-Chip Leaders')
  assert.equal(blueChip.showChart, true)
  assert.match(blueChip.answer, /Highest floors: 1\)/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 18)

  // 6. Greeting + real gift question ("hello what is Plush Pepe floor?") still answers the gift question!
  const greetPlusGift = await askGiftiAiQuestion('hello what is Plush Pepe floor?', 'Plush Pepe', catalog)
  assert.equal(greetPlusGift.title, 'Gifti · Plush Pepe')
  assert.equal(greetPlusGift.showChart, true)
  assert.match(greetPlusGift.answer, /Plush Pepe trades at/)
  assert.equal(getGiftiSessionSnapshot().freeTurnsRemaining, 17)

  // 7. End-to-end CollectorToolbox + G2 toolView formatting for "hello what can you do"
  const toolbox = createCollectorToolbox(
    {
      getCatalog: () => catalog,
      getFavoriteNames: () => ['Plush Pepe'],
      openChart: () => true,
      openTelegramDigest: () => {},
      askGiftiQuestion: (q, col, sig) => askGiftiAiQuestion(q, col, catalog, sig),
    },
    () => 'Plush Pepe',
  )
  await toolbox.submitGiftiPrompt('hello what can you do', 'phone')
  const qaPage = toolbox.getSnapshot()
  assert.equal(qaPage.title, 'Gifti · G2 Market Copilot', 'Must NOT append fake · 1/4 preset index')
  assert.equal(qaPage.chart, undefined, 'Must NOT attach random Plush Pepe 7d chart to capability greeting')
  assert.equal(qaPage.browse, undefined, 'Custom Q&A uses wrapped reading pages instead of 1-line compact browse truncation')
  assert.match(qaPage.lines[0], /Asked: "hello what can you do"/)
  assert.doesNotMatch(qaPage.lines.join('\n'), /Topic: Floor & 7d momentum/)

  const g2View = toolView(qaPage, 0, undefined, true)
  assert.match(g2View.content, /Gifti · G2 Market Copilot/)
  assert.match(g2View.content, /Asked: "hello what can you do"/)
  assert.doesNotMatch(g2View.content, /Topic: Floor/)

  // Clicking "Browse 4 preset topics" returns cleanly to preset 1/4 browse mode
  toolbox.act(qaPage, 'browse-topics')
  const presetPage = toolbox.getSnapshot()
  assert.match(presetPage.title, /1\/4/)
  assert.ok(presetPage.browse)
  assert.ok(presetPage.chart)
})
