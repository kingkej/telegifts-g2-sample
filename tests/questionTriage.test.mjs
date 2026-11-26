import assert from 'node:assert/strict'
import test from 'node:test'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { buildHudContainers } from '../src/hudLayout.ts'
import { getBundledCatalog } from '../src/services/bundledMarketData.ts'
import {
  annotateAndSortByTriage,
  classifyReplyIntent,
  summarizePending,
  triageQuestion,
} from '../src/services/questionTriage.ts'
import { TelegramCompanionStore } from '../src/services/telegramStore.ts'
import { telegramPage } from '../src/telegramDisplay.ts'

const catalog = getBundledCatalog()

const idleInspector = {
  getSnapshot: () => ({ mode: 'overview', collection: 'Plush Pepe' }),
  subscribe: () => () => {},
  show: () => {},
  setRange: () => {},
  step: () => {},
  back: () => false,
}

test('classifyReplyIntent and triageQuestion apply deterministic P1/P2/P3 scoring and spread gating', () => {
  assert.equal(classifyReplyIntent('Is Plush Pepe cheaper on Portals vs Tonnel?'), 'spread')
  assert.equal(classifyReplyIntent('How much did Loot Bag move vs yesterday UTC close?'), 'delta')
  assert.equal(classifyReplyIntent('Can you send the 7d floor chart for Astral Shard?'), 'chart')
  assert.equal(classifyReplyIntent('What is the floor price for Astral Shard?'), 'floor')
  assert.equal(classifyReplyIntent('gm everyone, how are vibes today?'), 'generic')

  const baseNow = Date.UTC(2026, 10, 25, 12, 0, 0)

  // P1: known collection (+2) + favorite (+3) + urgent (+2) + follow-up (+2) + aging (+1) -> capped at 2 tags
  const p1 = triageQuestion(
    {
      id: 'q1',
      sender: '@lena',
      chatLabel: 'TON Alpha',
      topicName: '#floor-watch',
      collectionHint: 'Plush Pepe',
      isFollowUp: true,
      askedAt: new Date(baseNow - 20 * 60_000).toISOString(),
      text: 'Plush Pepe just got swept — is Portals still cheapest right now?',
    },
    { favorites: ['Plush Pepe'], watchlist: [], catalog, spreadSignalAllowed: true, now: baseNow },
  )
  assert.equal(p1.level, 1)
  assert.equal(p1.intent, 'spread')
  assert.equal(p1.tags.length, 2)
  assert.ok(p1.tags.includes('FOLLOW-UP'))
  assert.ok(p1.tags.includes('FAV'))

  // Aging ISO timestamp > 15m adds +1 and AGING tag
  const aging = triageQuestion(
    {
      id: 'q-age',
      sender: '@old',
      chatLabel: 'TON Alpha',
      askedAt: new Date(baseNow - 25 * 60_000).toISOString(),
      text: 'hello anyone here?',
    },
    { favorites: [], watchlist: [], catalog, spreadSignalAllowed: false, now: baseNow },
  )
  assert.equal(aging.score, 1)
  assert.ok(aging.tags.includes('AGING'))

  // P3: general chatter with no collection or urgency
  const p3 = triageQuestion(
    {
      id: 'q3',
      sender: '@chatter',
      chatLabel: 'TON Alpha',
      topicName: '#general',
      askedAt: '2m ago', // non-ISO relative string must NOT add AGING
      text: 'gm everyone, how are vibes this week?',
    },
    { favorites: ['Plush Pepe'], watchlist: [], catalog, spreadSignalAllowed: true, now: baseNow },
  )
  assert.equal(p3.level, 3)
  assert.equal(p3.score, 0)
  assert.equal(p3.intent, 'generic')
  assert.deepEqual(p3.tags, [])

  // Spread signal (+2) is gated on spreadSignalAllowed
  const spreadQuestion = {
    id: 'q-spread',
    sender: '@denis',
    chatLabel: 'TON Alpha',
    collectionHint: 'Plush Pepe',
    askedAt: 'Just now',
    text: 'Check Plush Pepe please',
  }
  const withSpread = triageQuestion(spreadQuestion, {
    favorites: [],
    watchlist: [],
    catalog,
    spreadSignalAllowed: true,
    now: baseNow,
  })
  const withoutSpread = triageQuestion(spreadQuestion, {
    favorites: [],
    watchlist: [],
    catalog,
    spreadSignalAllowed: false,
    now: baseNow,
  })
  assert.equal(withSpread.tags.includes('SPREAD'), true)
  assert.equal(withoutSpread.tags.includes('SPREAD'), false)
  assert.equal(withSpread.score, withoutSpread.score + 2)

  // Watchlist (+3) elevates known collection (+2) to P1 (score 5)
  const watched = triageQuestion(spreadQuestion, {
    favorites: [],
    watchlist: ['Plush Pepe'],
    catalog,
    spreadSignalAllowed: false,
    now: baseNow,
  })
  assert.equal(watched.level, 1)
  assert.equal(watched.score, 5)
  assert.ok(watched.tags.includes('WATCH'))
})

test('annotateAndSortByTriage orders P1 -> P2 -> P3 stably and summarizePending builds 1-screen summary', () => {
  const raw = [
    { id: 'low', sender: '@a', chatLabel: 'G', topicName: '#general', text: 'gm all', askedAt: 'Just now' },
    { id: 'mid', sender: '@b', chatLabel: 'G', topicName: '#deals', collectionHint: 'Swiss Watch', text: 'lowest Swiss Watch?', askedAt: '18m ago' },
    { id: 'high', sender: '@c', chatLabel: 'G', topicName: '#floor', collectionHint: 'Plush Pepe', text: 'Plush Pepe swept right now!', askedAt: '2m ago' },
  ]
  const ctx = { favorites: ['Plush Pepe'], watchlist: [], catalog, spreadSignalAllowed: true }
  const sorted = annotateAndSortByTriage(raw, ctx)
  assert.deepEqual(sorted.map(q => q.id), ['high', 'mid', 'low'])
  assert.deepEqual(sorted.map(q => q.priority), [1, 2, 3])

  const summary = summarizePending(sorted, ctx)
  assert.equal(summary.total, 3)
  assert.equal(summary.p1Count, 1)
  assert.equal(summary.p2Count, 1)
  assert.equal(summary.p3Count, 1)
  assert.equal(summary.oldestLabel, '18m')
  assert.equal(summary.topQuestion?.id, 'high')
  assert.ok(summary.topCollections.some(c => c.name === 'Plush Pepe'))
})

test('pending and priority heads-up G2 screens pass SDK 0.0.16 validation with <=72B headers and no emoji on lens', () => {
  const ctx = { favorites: ['Plush Pepe'], watchlist: ['Astral Shard'], catalog, spreadSignalAllowed: true }
  const questions = annotateAndSortByTriage(
    [
      { id: 'q1', sender: '@lena_whale', chatLabel: 'TON Gift Alpha', topicName: '#floor-watch', collectionHint: 'Plush Pepe', text: 'Plush Pepe swept — is Portals cheapest now?', askedAt: 'Just now' },
      { id: 'q2', sender: '@chatter', chatLabel: 'TON Gift Alpha', topicName: '#general', text: 'gm vibes', askedAt: 'Just now' },
    ],
    ctx,
  )
  const summary = summarizePending(questions, ctx)
  const state = {
    enabled: true,
    mode: 'demo',
    privateChat: { id: 'dm', label: 'Saved' },
    group: { id: 'grp', label: 'TON Gift Alpha' },
    candidate: null,
    questions,
  }

  for (const screen of [
    { kind: 'pending', summary },
    {
      kind: 'heads-up',
      alertId: questions[0].id,
      badge: 'TON Gift Alpha · #floor-watch',
      headline: '@lena_whale · Plush Pepe',
      detail: questions[0].text,
      question: questions[0],
      priority: 1,
      tags: ['FAV', 'SPREAD', 'URGENT'],
    },
    {
      kind: 'compose',
      composeSessionId: 1,
      question: questions[0],
      destination: 'TON Gift Alpha · #floor-watch',
      destinationId: 'grp',
      drafts: [{ id: 'venue-spread', label: '5-Venue spread PNG', collection: 'Plush Pepe', text: 'Plush Pepe cheapest on Portals at 4,820 GRAM.' }],
      index: 0,
      dictation: true,
      askerFeedback: 'seen',
    },
  ]) {
    const page = telegramPage({ state, selectedQuestion: questions[0], screen }, idleInspector.getSnapshot())
    assert.ok(page.regions, `Expected 3-region HUD for screen ${screen.kind}`)
    assert.ok(
      Buffer.byteLength(page.regions.header, 'utf8') <= 72,
      `Header "${page.regions.header}" exceeded 72 UTF-8 bytes`,
    )
    assert.doesNotMatch(
      `${page.regions.header}\n${page.regions.body}\n${page.regions.footer}`,
      /\p{Extended_Pictographic}/u,
      `Lens screen ${screen.kind} must not contain emoji`,
    )
    const container = buildHudContainers({
      content: page.content,
      regions: page.regions,
      withArtwork: false,
      largeFrame: false,
      target: {
        body: { containerID: 1, containerName: 'body' },
        header: { containerID: 3, containerName: 'header' },
        footer: { containerID: 4, containerName: 'footer' },
        menu: new Map(),
      },
    })
    const check = validateEvenHubPageContainer(container)
    assert.equal(check.valid, true, `SDK validation failed for ${screen.kind}: ${check.message ?? ''}`)
  }
})

test('TelegramCompanionStore enforces priority interrupt policy, intent-ranked first draft, burst demo, and pending flow', () => {
  const store = new TelegramCompanionStore(
    idleInspector,
    () => catalog,
    () => 'Plush Pepe',
    '',
    '',
    () => true,
    () => true,
    () => ({ favorites: ['Plush Pepe'], watchlist: [] }),
    () => false,
  )

  // Spread question -> venue-spread is ranked first (index 0)
  const spreadQ = store.getSnapshot().state.questions.find(q => q.id === 'q-pepe-spread')
  assert.ok(spreadQ)
  assert.equal(store.openCompose(spreadQ), true)
  assert.equal(store.getSnapshot().screen.kind, 'compose')
  assert.equal(store.getSnapshot().screen.drafts[0].id, 'venue-spread')
  assert.equal(store.getSnapshot().screen.askerFeedback, 'seen')
  assert.equal(store.getSnapshot().screen.dictation, false)

  // Nothing interrupts active compose — even triggerBurstDemoQuestions keeps compose open
  const burstDuringCompose = store.triggerBurstDemoQuestions()
  assert.equal(store.getSnapshot().screen.kind, 'compose')
  assert.equal(burstDuringCompose.interrupted, null)
  assert.equal(burstDuringCompose.queuedSilent, 3)

  // Return to idle and run burst: P3 queues silently, P2 interrupts idle, P1 overrides with P1 heads-up
  store.cancelDraft()
  assert.equal(store.getSnapshot().screen.kind, 'idle')
  const burstFromIdle = store.triggerBurstDemoQuestions()
  assert.equal(burstFromIdle.queuedSilent, 1, 'P3 chatter must queue silently without interrupting')
  assert.equal(burstFromIdle.interrupted?.priority, 1)
  assert.equal(store.getSnapshot().screen.kind, 'heads-up')
  assert.equal(store.getSnapshot().screen.priority, 1)

  // Open pending summary -> Tap opens top P1 question compose; Swipe opens full queue
  store.openPending()
  assert.equal(store.getSnapshot().screen.kind, 'pending')
  assert.ok(store.getSnapshot().screen.summary.total >= 6)
  assert.ok(store.getSnapshot().screen.summary.p3Count >= 1)
  store.step(1)
  assert.equal(store.getSnapshot().screen.kind, 'questions')
  store.openPending()
  store.activate()
  assert.equal(store.getSnapshot().screen.kind, 'compose')
  assert.equal(store.getSnapshot().screen.question.priority, 1)

  // P1-1 regression: spoken "send reply" MUST NEVER send dictated text without an explicit Tap
  assert.equal(store.applyDictatedReply('I will grab that on Portals 🚀'), true)
  assert.equal(store.getSnapshot().screen.drafts[0].id.startsWith('dictated-'), true)
  assert.doesNotMatch(store.getSnapshot().screen.drafts[0].text, /\p{Extended_Pictographic}/u, 'Dictated text strips emoji for G2 lens')
  assert.equal(store.applyVoiceReply('send reply'), false, 'Spoken send reply must reject dictated draft')
  assert.equal(store.getSnapshot().screen.kind, 'compose', 'Compose stays open until explicit physical Tap')

  // P1-2 regression: triggerHeadsUpQuestion respects interrupt policy (never interrupts compose, P3 never interrupts idle)
  store.triggerHeadsUpQuestion()
  assert.equal(store.getSnapshot().screen.kind, 'compose', 'Demo Live /ask must never interrupt active compose')
  store.cancelDraft()
  assert.equal(store.getSnapshot().screen.kind, 'idle')
  store.triggerHeadsUpQuestion({
    id: 'q-explicit-p3',
    sender: '@chatter',
    chatLabel: 'TON Gift Alpha',
    topicName: '#general',
    askedAt: 'Just now',
    text: 'gm everyone, how are vibes this week?',
  })
  assert.equal(store.getSnapshot().screen.kind, 'idle', 'P3 explicit question must never raise heads-up over idle')
})
