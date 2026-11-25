import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { createTelegramRelayServer } from '../server/telegramRelay.mjs'
import { getBundledCatalog, buildBundledFloorSeries } from '../src/services/bundledMarketData.ts'
import {
  canonicalizeRelayUrl,
  getTelegramReceiptStorageKey,
  getTelegramSentLogStorageKey,
  TelegramCompanionStore,
} from '../src/services/telegramStore.ts'

async function startTestRelay(options) {
  const relay = createTelegramRelayServer({ port: 0, host: '127.0.0.1', ...options })
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
  const addr = relay.server.address()
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return {
    relay,
    baseUrl,
    close: () =>
      new Promise(resolve => {
        relay.stopPolling()
        relay.server.close(() => resolve())
      }),
  }
}

test('relay refuses non-loopback host without RELAY_AUTH_TOKEN, supports ::1 IPv6 host, and enforces Bearer auth', async t => {
  assert.throws(
    () => createTelegramRelayServer({ host: '0.0.0.0', authToken: '' }),
    /RELAY_AUTH_TOKEN is required/,
  )

  // IPv6 loopback ::1 constructs valid bracketed request URLs
  const ipv6Relay = createTelegramRelayServer({ host: '::1', port: 0, botToken: 'tok', botUsername: 'bot' })
  await new Promise((resolve, reject) => {
    ipv6Relay.server.once('error', reject)
    ipv6Relay.server.listen(0, '::1', resolve)
  }).then(async () => {
    const port = ipv6Relay.server.address().port
    const res = await fetch(`http://[::1]:${port}/g2/telegram/state`)
    assert.equal(res.status, 200)
    await new Promise(resolve => ipv6Relay.server.close(resolve))
  }).catch(() => {
    // Ignore only if OS has IPv6 disabled
  })

  const { baseUrl, close } = await startTestRelay({
    botToken: 'test-bot-token',
    botUsername: 'telegifts_test_bot',
    authToken: 'secret-relay-token',
  })
  t.after(close)

  const unauth = await fetch(`${baseUrl}/g2/telegram/state`)
  assert.equal(unauth.status, 401)

  const ok = await fetch(`${baseUrl}/g2/telegram/state`, {
    headers: {
      Authorization: 'Bearer secret-relay-token',
      Origin: 'http://localhost:3000',
    },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:3000')
  const state = await ok.json()
  assert.equal(state.enabled, true)

  // Bearer-protected relay allows an explicitly allowlisted cross-site phone origin (preflight + authenticated request)
  const crossSiteAuthRelay = await startTestRelay({
    botToken: 'test-bot-token',
    botUsername: 'telegifts_test_bot',
    authToken: 'secret-relay-token',
    allowedOrigin: 'https://phone.telegifts.example',
  })
  t.after(crossSiteAuthRelay.close)

  const csPreflight = await fetch(`${crossSiteAuthRelay.baseUrl}/g2/telegram/state`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://phone.telegifts.example',
      'Sec-Fetch-Site': 'cross-site',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  })
  assert.equal(csPreflight.status, 204)
  assert.equal(csPreflight.headers.get('access-control-allow-origin'), 'https://phone.telegifts.example')

  const csAuthedGet = await fetch(`${crossSiteAuthRelay.baseUrl}/g2/telegram/state`, {
    headers: {
      Origin: 'https://phone.telegifts.example',
      'Sec-Fetch-Site': 'cross-site',
      Authorization: 'Bearer secret-relay-token',
    },
  })
  assert.equal(csAuthedGet.status, 200)
  assert.equal(csAuthedGet.headers.get('access-control-allow-origin'), 'https://phone.telegifts.example')

  const csUnlistedGet = await fetch(`${crossSiteAuthRelay.baseUrl}/g2/telegram/state`, {
    headers: {
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site',
      Authorization: 'Bearer secret-relay-token',
    },
  })
  assert.equal(csUnlistedGet.status, 403)

  // Disallowed browser origins and non-JSON POST content types are rejected before dispatch (even on tokenless loopback)
  let tokenlessTelegramCalls = 0
  const tokenless = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'Group' },
      questions: [],
    },
    callTelegram: async () => {
      tokenlessTelegramCalls += 1
      return { message_id: 1 }
    },
  })
  t.after(tokenless.close)

  for (const badOrigin of ['https://evil.example', 'null']) {
    const deniedGet = await fetch(`${tokenless.baseUrl}/g2/telegram/state`, {
      headers: { Origin: badOrigin },
    })
    assert.equal(deniedGet.status, 403)
    assert.equal(deniedGet.headers.get('access-control-allow-origin'), null)

    const preflight = await fetch(`${tokenless.baseUrl}/g2/telegram/reply`, {
      method: 'OPTIONS',
      headers: { Origin: badOrigin },
    })
    assert.equal(preflight.status, 403)
    assert.equal(preflight.headers.get('access-control-allow-origin'), null)

    const crossSitePost = await fetch(`${tokenless.baseUrl}/g2/telegram/reply`, {
      method: 'POST',
      headers: { Origin: badOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: `csrf-${badOrigin}`, destinationId: '1001', text: 'csrf' }),
    })
    assert.equal(crossSitePost.status, 403)

    const crossSiteUnlink = await fetch(`${tokenless.baseUrl}/g2/telegram/unlink`, {
      method: 'POST',
      headers: { Origin: badOrigin, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ kind: 'private', destinationId: '1001' }),
    })
    assert.equal(crossSiteUnlink.status, 403)
  }

  // Sec-Fetch-Site: cross-site is rejected independently even when Origin is allowlisted
  const crossFetchSite = await fetch(`${tokenless.baseUrl}/g2/telegram/reply`, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requestId: 'csrf-sec-fetch', destinationId: '1001', text: 'csrf' }),
  })
  assert.equal(crossFetchSite.status, 403)
  assert.equal(crossFetchSite.headers.get('access-control-allow-origin'), null)

  // Wildcard RELAY_ALLOWED_ORIGIN=* on tokenless loopback never accepts cross-origin, Origin: null, or Sec-Fetch-Site: cross-site
  const wildcardTokenless = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    allowedOrigin: '*',
  })
  t.after(wildcardTokenless.close)

  const wildcardNull = await fetch(`${wildcardTokenless.baseUrl}/g2/telegram/state`, {
    headers: { Origin: 'null' },
  })
  assert.equal(wildcardNull.status, 403)

  const wildcardCrossSite = await fetch(`${wildcardTokenless.baseUrl}/g2/telegram/state`, {
    headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
  })
  assert.equal(wildcardCrossSite.status, 403)

  const wildcardRemoteOrigin = await fetch(`${wildcardTokenless.baseUrl}/g2/telegram/state`, {
    headers: { Origin: 'https://evil.example' },
  })
  assert.equal(wildcardRemoteOrigin.status, 403)

  assert.equal(tokenlessTelegramCalls, 0)
  assert.equal(tokenless.relay.state.privateChat?.id, '1001')

  const badContentType = await fetch(`${tokenless.baseUrl}/g2/telegram/unlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ kind: 'private', destinationId: '1001' }),
  })
  assert.equal(badContentType.status, 415)
  assert.equal(tokenless.relay.state.privateChat?.id, '1001')

  // Empty, array, and scalar JSON bodies on POST routes are rejected with 400 before route logic runs
  for (const invalidJsonBody of ['', '   ', '[]', '"scalar"', '123', 'null']) {
    const invalidRes = await fetch(`${tokenless.baseUrl}/g2/telegram/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: invalidJsonBody,
    })
    assert.equal(invalidRes.status, 400, `Expected 400 for body: ${invalidJsonBody}`)
  }
  assert.equal(tokenless.relay.state.pendingTokens.size, 0)

  // DNS-rebinding defense: originless GET with untrusted Host header is rejected with 403 on tokenless loopback
  const tokenlessPort = new URL(tokenless.baseUrl).port
  const sendRawHttp = rawRequest =>
    new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: Number(tokenlessPort) }, () => {
        sock.write(rawRequest)
      })
      let chunks = ''
      sock.setEncoding('utf8')
      sock.on('data', d => {
        chunks += d
      })
      sock.on('end', () => resolve(chunks))
      sock.on('error', reject)
    })

  const dnsRebindRaw = await sendRawHttp(
    `GET /g2/telegram/state HTTP/1.1\r\nHost: evil-rebind.example:${tokenlessPort}\r\nConnection: close\r\n\r\n`,
  )
  assert.match(dnsRebindRaw, /^HTTP\/1\.1 403 /)
  assert.equal(dnsRebindRaw.includes('@collector'), false, 'DNS-rebound Host must never disclose paired state')

  // Malformed request URL / invalid percent-encoding returns 400 cleanly without crashing the relay process
  const malformedUrlRaw = await sendRawHttp(
    `GET http://[::1/bad HTTP/1.1\r\nHost: 127.0.0.1:${tokenlessPort}\r\nConnection: close\r\n\r\n`,
  )
  assert.match(malformedUrlRaw, /^HTTP\/1\.1 400 /)

  const badPercentEncoding = await fetch(`${tokenless.baseUrl}/g2/telegram/delivery/%E0%A4%A`)
  assert.equal(badPercentEncoding.status, 400)

  // Documented default localhost quickstart (http://localhost:3000 -> http://localhost:<port>, Sec-Fetch-Site: same-site) succeeds
  const defaultLocalhostRelay = createTelegramRelayServer({ port: 0, botToken: 'tok', botUsername: 'bot' })
  await new Promise(resolve => defaultLocalhostRelay.server.listen(0, defaultLocalhostRelay.host, resolve))
  t.after(() => new Promise(resolve => defaultLocalhostRelay.server.close(resolve)))
  const lhPort = defaultLocalhostRelay.server.address().port
  const lhRes = await fetch(`http://localhost:${lhPort}/g2/telegram/state`, {
    headers: {
      Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'same-site',
    },
  })
  assert.equal(lhRes.status, 200)
  assert.equal(lhRes.headers.get('access-control-allow-origin'), 'http://localhost:3000')
})

test('relay deduplicates concurrent requestIds, rejects whitespace/stale questionIds, records transport loss as unknown, and clears on unlink', async t => {
  const calls = []
  let releaseSlowSend
  let mode = 'slow-ok'
  const slowGate = new Promise(resolve => {
    releaseSlowSend = resolve
  })

  const { relay, baseUrl, close } = await startTestRelay({
    botToken: 'test-bot-token',
    botUsername: 'telegifts_test_bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'TON Gift Alpha' },
      questions: [
        {
          id: '-2002:55',
          chatId: '-2002',
          messageId: 55,
          topicId: 14,
          topicName: 'Topic #14',
          sender: '@mira_ton',
          text: 'Is Plush Pepe cheaper on Portals?',
          chatLabel: 'TON Gift Alpha',
          askedAt: '2026-11-24T00:00:00Z',
        },
      ],
    },
    callTelegram: async (method, payload) => {
      if (mode === 'transport-drop') {
        const err = new Error('HTTP 502: thread not found')
        err.telegramDescription = 'thread not found'
        err.isTransportUncertain = true
        throw err
      }
      calls.push({ method, payload })
      if (mode === 'slow-ok') await slowGate
      return { message_id: 999 }
    },
  })
  t.after(close)

  // Whitespace-only questionId on send-comparison MUST be rejected with missing_reply (never fall through to privateChat!)
  const wsComparison = await fetch(`${baseUrl}/g2/telegram/send-comparison`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-ws-comparison',
      questionId: '   ',
      collection: 'Plush Pepe',
      previous: 4600,
      last: 4820,
    }),
  })
  assert.deepEqual(await wsComparison.json(), { status: 'failed', reason: 'missing_reply' })
  assert.equal(calls.length, 0)

  // Transport drop (including 502 gateway body mentioning thread not found) MUST record status: 'unknown' and keep question!
  mode = 'transport-drop'
  const dropRes = await fetch(`${baseUrl}/g2/telegram/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-transport-drop',
      destinationId: '-2002',
      questionId: '-2002:55',
      text: 'Checking transport uncertainty',
    }),
  })
  assert.deepEqual(await dropRes.json(), { status: 'unknown' })
  assert.equal(relay.state.questions.length, 1, '5xx/transport uncertainty must never delete the question')

  mode = 'slow-ok'
  const body = JSON.stringify({
    requestId: 'req-concurrent-1',
    destinationId: '-2002',
    questionId: '-2002:55',
    text: 'Plush Pepe lowest ask is 4,820 GRAM on Portals.',
  })

  const p1 = fetch(`${baseUrl}/g2/telegram/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const p2 = fetch(`${baseUrl}/g2/telegram/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  await new Promise(r => setTimeout(r, 25))
  const pendingRes = await fetch(`${baseUrl}/g2/telegram/delivery/req-concurrent-1`)
  assert.deepEqual(await pendingRes.json(), { status: 'pending' })

  releaseSlowSend()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.deepEqual(await r1.json(), { status: 'sent' })
  assert.deepEqual(await r2.json(), { status: 'sent' })
  assert.equal(calls.length, 1, 'Concurrent duplicate requestId must call Telegram only once')

  // Missing questionId MUST fail with missing_reply without posting top-level!
  const missingRes = await fetch(`${baseUrl}/g2/telegram/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: 'req-stale-question',
      destinationId: '-2002',
      questionId: '-2002:55',
      text: 'Late duplicate to different requestId',
    }),
  })
  assert.deepEqual(await missingRes.json(), { status: 'failed', reason: 'missing_reply' })
  assert.equal(calls.length, 1)

  relay.ingestTelegramUpdates([
    {
      update_id: 10,
      message: {
        message_id: 77,
        date: 1763942400,
        chat: { id: -2002, type: 'supergroup', title: 'TON Gift Alpha' },
        from: { username: 'vasya' },
        text: '/ask@telegifts_test_bot Floor on Astral Shard?',
      },
    },
  ])
  assert.equal(relay.state.questions.length, 1)

  // Stale unlink with outdated destinationId returns 409 and preserves current group + questions
  relay.state.group = { id: '-3003', label: 'Replacement Group' }
  const staleUnlink = await fetch(`${baseUrl}/g2/telegram/unlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'group', destinationId: '-2002' }),
  })
  assert.equal(staleUnlink.status, 409)
  assert.equal(relay.state.group?.id, '-3003')
  assert.equal(relay.state.questions.length, 1)

  const matchingUnlink = await fetch(`${baseUrl}/g2/telegram/unlink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'group', destinationId: '-3003' }),
  })
  assert.equal(matchingUnlink.status, 200)
  assert.equal(relay.state.group, null)
  assert.equal(relay.state.questions.length, 0)
})

test('TelegramCompanionStore prevents cross-collection synthetic series leaks in live mode, handles failed/retry & sendPhoto, and preserves watch alerts across refresh', async t => {
  const originalDocument = globalThis.document
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({
      getContext: () => ({
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData() {},
      }),
      toBlob: done => done(new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)])),
    }),
  })
  t.after(() => {
    if (originalDocument) globalThis.document = originalDocument
    else delete globalThis.document
  })

  let failNextTelegramSend = true
  const telegramCalls = []
  const { relay, baseUrl, close } = await startTestRelay({
    botToken: 'test-bot-token',
    botUsername: 'telegifts_test_bot',
    authToken: 'client-token',
    initialState: {
      privateChat: { id: '1001', label: 'Saved Messages (@collector)' },
      group: { id: '-2002', label: 'TON Gift Alpha' },
      questions: [
        {
          id: '-2002:88',
          chatId: '-2002',
          messageId: 88,
          topicId: 22,
          topicName: '#deals-radar',
          sender: '@kairo',
          text: 'Anyone tracking Astral Shard 7d floor closes?',
          chatLabel: 'TON Gift Alpha',
          askedAt: '1m ago',
        },
        {
          id: '-2002:89',
          chatId: '-2002',
          messageId: 89,
          topicId: 22,
          topicName: '#deals-radar',
          sender: '@mira',
          text: 'Drop Plush Pepe 7d floor chart?',
          chatLabel: 'TON Gift Alpha',
          askedAt: '1m ago',
        },
      ],
      digest: [],
    },
    callTelegram: async (method, payload) => {
      if (failNextTelegramSend) {
        const err = new Error('Bad Request: chat write forbidden')
        err.telegramDescription = 'Bad Request: chat write forbidden'
        err.isDefinitiveTelegramError = true
        throw err
      }
      telegramCalls.push({ method, payload })
      return { message_id: 321 }
    },
  })
  t.after(close)

  const catalog = getBundledCatalog()
  const plushSeries7d = buildBundledFloorSeries('Plush Pepe', '7d')
  let liveHistoryAvailable = false
  const inspector = {
    getSnapshot: () => ({
      mode: 'chart',
      status: 'ready',
      collection: 'Plush Pepe',
      range: '7d',
      series: plushSeries7d,
      last: plushSeries7d.points.at(-1).price,
      lastTime: plushSeries7d.points.at(-1).time,
      high: 5000,
      low: 4500,
      frame: Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      fromVariants: false,
    }),
    subscribe: () => () => {},
    show() {},
    showChart() {},
    setRange() {},
    step() {},
    pickVariant() {},
    retry() {},
    back() {},
  }

  const store = new TelegramCompanionStore(
    inspector,
    () => catalog,
    () => 'Plush Pepe',
    baseUrl,
    'client-token',
    () => true,
    () => liveHistoryAvailable,
  )
  await store.refresh()

  // 1. Asking about Astral Shard while Plush Pepe's 7d chart is open MUST NEVER leak Plush Pepe's 4,820 GRAM close
  //    in EITHER smart composer OR direct Reply with chart!
  const astralQuestion = store.getSnapshot().state.questions[0]
  store.selectQuestion(astralQuestion)
  assert.equal(store.share('reply'), false, 'Direct chart reply must reject bundled history when liveHistoryAvailable is false')
  assert.equal(store.openCompose(astralQuestion), true)
  const astralDrafts = store.getSnapshot().screen.drafts
  assert.equal(astralDrafts.some(d => d.id === 'daily-delta'), false)
  assert.equal(astralDrafts.some(d => /4,820/.test(d.text)), false)
  assert.match(astralDrafts[0].text, /Astral Shard.*890 GRAM/)

  // Custom note edits allocate distinct draft IDs so an old composeId never sends replacement note text!
  store.applyCustomNote('First custom note')
  const firstNoteComposeId = `${store.getSnapshot().screen.composeSessionId}:${astralQuestion.id}:${store.getSnapshot().screen.drafts[0].id}:0`
  store.applyCustomNote('Second replacement note')
  assert.equal(store.applyVoiceReply('send reply', firstNoteComposeId), false)
  store.cancelDraft()

  // Even when liveHistoryAvailable is true, direct Reply with chart rejects replying to Astral Shard with Plush Pepe's chart,
  // including when catalog is unavailable (unresolved collection)!
  liveHistoryAvailable = true
  store.selectQuestion(astralQuestion)
  assert.equal(store.share('reply'), false)
  assert.equal(store.getSnapshot().screen.kind, 'notice')
  assert.equal(store.getSnapshot().screen.reason, 'changed')
  store.cancelDraft()

  const nullCatalogStore = new TelegramCompanionStore(
    inspector,
    () => null,
    () => 'Plush Pepe',
    baseUrl,
    'client-token',
    () => false,
    () => true,
  )
  await nullCatalogStore.refresh()
  nullCatalogStore.selectQuestion(nullCatalogStore.getSnapshot().state.questions[0])
  assert.equal(nullCatalogStore.share('reply'), false, 'Unresolved question collection must reject direct chart reply')
  const pepeQuestion = store.getSnapshot().state.questions[1]
  assert.equal(store.openCompose(pepeQuestion), true)
  assert.equal(store.getSnapshot().screen.drafts[0].attachChart, true)
  store.activate()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  assert.equal(store.getSnapshot().screen.status, 'failed')
  assert.equal(store.getSnapshot().state.questions.length, 2)

  failNextTelegramSend = false
  store.back()
  assert.equal(store.openCompose(pepeQuestion), true)
  store.activate()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  assert.equal(store.getSnapshot().screen.status, 'sent')
  assert.equal(telegramCalls.length, 1)
  assert.equal(telegramCalls[0].method, 'sendPhoto')
  assert.match(telegramCalls[0].payload.get('caption'), /Plush Pepe.*Attached the 7d UTC floor chart/)

  // 3. Local watch alerts survive store.refresh() and Save to DM posts via relay
  store.pushWatchDigestAlert('Astral Shard', 845, 850, false)
  await store.refresh()
  assert.equal(store.getSnapshot().state.digest.length, 1)
  assert.match(store.getSnapshot().state.digest[0].headline, /Astral Shard ask hit 845 GRAM/)

  store.openDigest()
  store.activate()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  assert.equal(store.getSnapshot().screen.status, 'sent')
  assert.equal(telegramCalls.length, 2)
  assert.equal(telegramCalls[1].method, 'sendMessage')
  assert.equal(telegramCalls[1].payload.chat_id, '1001')

  // 4. openQuestions() immediately after fresh relay store construction resolves to questions on FIRST call
  const freshStore = new TelegramCompanionStore(inspector, () => catalog, () => null, baseUrl, 'client-token', () => true)
  freshStore.openQuestions()
  await t.waitFor(() => assert.equal(freshStore.getSnapshot().state?.enabled, true))
  assert.equal(freshStore.getSnapshot().screen.kind, 'questions')
})

test('late checkDelivery(A) clears only question A without clobbering B, and in-flight relay sends never write into demo mode', async t => {
  const storage = new Map()
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
  })
  t.after(() => {
    if (originalDescriptor) Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
    else delete globalThis.localStorage
  })

  let holdDeliveryCheck = null
  let holdRelayReply = null
  const { relay, baseUrl, close } = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'Group' },
      questions: [
        { id: 'qA', chatId: '-2002', messageId: 1, sender: '@a', text: 'Plush Pepe?', chatLabel: 'Group' },
        { id: 'qB', chatId: '-2002', messageId: 2, sender: '@b', text: 'Astral Shard?', chatLabel: 'Group' },
      ],
    },
    callTelegram: async () => {
      if (holdRelayReply) await holdRelayReply
      const err = new Error('network reset')
      err.isTransportUncertain = true
      throw err
    },
  })
  t.after(close)

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/g2/telegram/delivery/') && holdDeliveryCheck) {
      await holdDeliveryCheck
    }
    return originalFetch(url, init)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const catalog = getBundledCatalog()
  const inspector = {
    getSnapshot: () => ({ mode: 'overview' }),
    subscribe: () => () => {},
    show() {},
    showChart() {},
    setRange() {},
    step() {},
    pickVariant() {},
    retry() {},
    back() {},
  }
  const store = new TelegramCompanionStore(inspector, () => catalog, () => null, baseUrl, '')
  await store.refresh()

  // Send A -> unknown
  const qA = store.getSnapshot().state.questions[0]
  store.openCompose(qA)
  store.activate()
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  const reqIdA = store.getSnapshot().receipt.requestId
  assert.equal(store.getSnapshot().receipt.status, 'unknown')

  // Relay later discovers A was missing_reply
  relay.state.receipts.set(reqIdA, { status: 'failed', reason: 'missing_reply' })
  let releaseCheckA
  holdDeliveryCheck = new Promise(r => {
    releaseCheckA = r
  })
  const checkPromiseA = store.checkDelivery(reqIdA)

  // Before checkA resolves, user sends B -> unknown
  store.back()
  const qB = store.getSnapshot().state.questions[1]
  store.openCompose(qB)
  store.activate()
  await t.waitFor(() => assert.equal(store.getSnapshot().receipt?.questionId, 'qB'))
  assert.equal(store.getSnapshot().screen.kind, 'result')
  assert.equal(store.getSnapshot().screen.status, 'unknown')

  // Now checkA resolves with missing_reply -> qA is removed, qB stays, and B's result screen stays 'unknown'!
  releaseCheckA()
  await checkPromiseA
  holdDeliveryCheck = null
  assert.deepEqual(store.getSnapshot().state.questions.map(q => q.id), ['qB'])
  assert.equal(store.getSnapshot().receipt.questionId, 'qB')
  assert.equal(store.getSnapshot().screen.status, 'unknown')

  // Denied (401) delivery lookup preserves unknown status on both displayed result and receipt!
  const authRelay = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    authToken: 'expected-secret',
  })
  t.after(authRelay.close)
  const originalRelayUrl = store.getSnapshot().relayConfig.relayUrl
  // Temporarily point fetch for /delivery/ to return 401 so checkDelivery() encounters an unauthorized lookup
  let force401Lookup = true
  const prevFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (force401Lookup && String(url).includes('/g2/telegram/delivery/')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return prevFetch(url, init)
  }
  const deniedLookupResult = await store.checkDelivery()
  force401Lookup = false
  globalThis.fetch = prevFetch
  assert.equal(deniedLookupResult, null)
  assert.equal(store.getSnapshot().receipt.status, 'unknown', '401 delivery lookup must preserve unknown receipt status')
  assert.equal(store.getSnapshot().screen.kind, 'result')
  assert.equal(store.getSnapshot().screen.status, 'unknown', '401 delivery lookup must preserve unknown result screen')
  assert.equal(store.getSnapshot().relayConfig.relayUrl, originalRelayUrl)

  // Overlapping checkDelivery() calls: slow earlier 'pending' response MUST NOT revert a confirmed 'sent' receipt!
  let releasePendingLookup
  const pendingLookupGate = new Promise(r => {
    releasePendingLookup = r
  })
  let lookupCallCount = 0
  const prevOverlapFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/g2/telegram/delivery/')) {
      lookupCallCount += 1
      if (lookupCallCount === 1) {
        await pendingLookupGate
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ status: 'sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return prevOverlapFetch(url, init)
  }
  const slowPendingCheck = store.checkDelivery()
  const fastSentCheck = store.checkDelivery()
  assert.equal(await fastSentCheck, 'sent')
  assert.equal(store.getSnapshot().receipt.status, 'sent')
  assert.equal(store.getSnapshot().screen.status, 'sent')
  releasePendingLookup()
  assert.equal(await slowPendingCheck, 'sent', 'Stale pending lookup returns confirmed status without regressing')
  globalThis.fetch = prevOverlapFetch
  assert.equal(store.getSnapshot().receipt.status, 'sent', 'Receipt stays sent after stale pending check resolves')
  assert.equal(store.getSnapshot().screen.status, 'sent', 'Result screen stays sent after stale pending check resolves')
  assert.equal(
    store.getSnapshot().sentLog.find(e => e.id === store.getSnapshot().receipt.requestId)?.status,
    'sent',
    'Sent log stays sent after stale pending check resolves',
  )

  // Start an in-flight relay send, then switch to demo before it settles -> demo sentLog stays clean!
  let releaseRelaySend
  holdRelayReply = new Promise(r => {
    releaseRelaySend = r
  })
  store.back()
  store.openCompose(qB)
  store.activate()
  await store.configureRelay('', '')
  assert.equal(store.getSnapshot().state.mode, 'demo')
  assert.equal(store.getSnapshot().sentLog.length, 0)
  releaseRelaySend()
  await new Promise(r => setTimeout(r, 40))
  assert.equal(store.getSnapshot().state.mode, 'demo')
  assert.equal(store.getSnapshot().sentLog.length, 0, 'Late relay send must not pollute demo sentLog')
  holdRelayReply = null

  // Switch-away-and-back persistence + out-of-order receipt seq guard:
  // Start demo send 1, switch demo -> relay -> demo, let demo send 1 finish, then send demo 2 -> BOTH entries remain!
  store.openDigest()
  store.activate() // Starts demo send 1 (140ms)
  await store.configureRelay(baseUrl, '')
  await store.configureRelay('', '')
  await new Promise(r => setTimeout(r, 170))
  assert.equal(store.getSnapshot().sentLog.length, 1, 'Late completion after switching away and back merges into log')

  store.openDigest()
  store.step(1)
  store.activate() // Starts demo send 2
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  assert.equal(store.getSnapshot().sentLog.length, 2, 'Subsequent send preserves earlier switch-away-and-back log entry')

  // Out-of-order relay completions: older slow request must NOT overwrite newer persisted receipt!
  let releaseOlder
  const olderGate = new Promise(r => {
    releaseOlder = r
  })
  let callIdx = 0
  const oooRelay = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'Group' },
      questions: [],
      digest: [
        { id: 'd1', channel: '@ch', headline: 'First', summary: 'One', timestamp: 'now', kind: 'channel' },
        { id: 'd2', channel: '@ch', headline: 'Second', summary: 'Two', timestamp: 'now', kind: 'channel' },
      ],
    },
    callTelegram: async () => {
      callIdx += 1
      if (callIdx === 1) await olderGate
      return { message_id: callIdx }
    },
  })
  t.after(oooRelay.close)

  await store.configureRelay(oooRelay.baseUrl, '')
  const priorRelayLogCount = store.getSnapshot().sentLog.length
  store.openDigest()
  store.activate() // Older request (seq N, held)
  store.openDigest()
  store.step(1)
  store.activate() // Newer request (seq N+1, fast)
  await t.waitFor(() => assert.equal(store.getSnapshot().screen.kind, 'result'))
  const newerReceiptId = store.getSnapshot().receipt.requestId
  releaseOlder()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(store.getSnapshot().receipt.requestId, newerReceiptId, 'Active receipt stays newer')
  const persistedRelayReceipt = JSON.parse(storage.get(getTelegramReceiptStorageKey(oooRelay.baseUrl, '')))
  assert.equal(persistedRelayReceipt.requestId, newerReceiptId, 'Persisted receipt is not overwritten by older completion')
  assert.equal(store.getSnapshot().sentLog.length, priorRelayLogCount + 2)

  // Overlapping store instances: recreate a second store while first store's send is still in flight!
  let releaseInstance1
  const instance1Gate = new Promise(r => {
    releaseInstance1 = r
  })
  let instanceCall = 0
  const overlapRelay = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'Group' },
      questions: [],
      digest: [
        { id: 'od1', channel: '@ch', headline: 'OldInst', summary: 'One', timestamp: 'now', kind: 'channel' },
        { id: 'od2', channel: '@ch', headline: 'NewInst', summary: 'Two', timestamp: 'now', kind: 'channel' },
      ],
    },
    callTelegram: async () => {
      instanceCall += 1
      if (instanceCall === 1) await instance1Gate
      return { message_id: instanceCall }
    },
  })
  t.after(overlapRelay.close)

  const storeInst1 = new TelegramCompanionStore(inspector, () => catalog, () => null, overlapRelay.baseUrl, '')
  await storeInst1.refresh()
  storeInst1.openDigest()
  storeInst1.activate() // Starts send in instance 1 (reserves seq K in SEQ_KEY, held)

  const storeInst2 = new TelegramCompanionStore(inspector, () => catalog, () => null, overlapRelay.baseUrl, '')
  await storeInst2.refresh()
  storeInst2.openDigest()
  storeInst2.step(1)
  storeInst2.activate() // Starts send in instance 2 (reserves seq K+1, completes first)
  await t.waitFor(() => assert.equal(storeInst2.getSnapshot().screen.kind, 'result'))
  const inst2ReceiptId = storeInst2.getSnapshot().receipt.requestId

  releaseInstance1()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(storeInst1.getSnapshot().screen.kind, 'idle', 'Older overlapped instance exits sending screen cleanly')
  const overlapReceiptKey = getTelegramReceiptStorageKey(overlapRelay.baseUrl, '')
  const finalPersistedReceipt = JSON.parse(storage.get(overlapReceiptKey))
  assert.equal(finalPersistedReceipt.requestId, inst2ReceiptId, 'Recreated store receipt is not overwritten by older instance')

  // Stale result dismissal on an older store instance must NOT clobber newer persisted receipt in back()!
  const storeInst3 = new TelegramCompanionStore(inspector, () => catalog, () => null, overlapRelay.baseUrl, '')
  await storeInst3.refresh()
  storeInst3.openDigest()
  storeInst3.activate()
  await t.waitFor(() => assert.equal(storeInst3.getSnapshot().screen.kind, 'result'))
  const inst3ReceiptId = storeInst3.getSnapshot().receipt.requestId

  const storeInst4 = new TelegramCompanionStore(inspector, () => catalog, () => null, overlapRelay.baseUrl, '')
  await storeInst4.refresh()
  storeInst4.openDigest()
  storeInst4.step(1)
  storeInst4.activate()
  await t.waitFor(() => assert.equal(storeInst4.getSnapshot().screen.kind, 'result'))
  const inst4ReceiptId = storeInst4.getSnapshot().receipt.requestId
  assert.notEqual(inst3ReceiptId, inst4ReceiptId)

  // Dismiss stale result on storeInst3 AFTER storeInst4 already persisted inst4ReceiptId
  storeInst3.back()
  assert.equal(storeInst3.getSnapshot().screen.kind, 'idle')
  assert.equal(storeInst3.getSnapshot().receipt.requestId, inst4ReceiptId, 'Older store adopts newer receipt on back()')
  const afterStaleBack = JSON.parse(storage.get(overlapReceiptKey))
  assert.equal(afterStaleBack.requestId, inst4ReceiptId, 'Stale back() must not overwrite newer persisted receipt')
  assert.equal(afterStaleBack.reviewed, false, 'Stale back() must not mark newer unreviewed receipt reviewed')

  // Dismissing active result on storeInst4 marks inst4ReceiptId reviewed
  storeInst4.back()
  const afterActiveBack = JSON.parse(storage.get(overlapReceiptKey))
  assert.equal(afterActiveBack.requestId, inst4ReceiptId)
  assert.equal(afterActiveBack.reviewed, true)

  // Three-send ordering: Store A send 1 pending -> Store A send 2 fails (displayed) -> Store B send 3 sent (persisted)
  // -> Store A send 1 settles -> Store A dismisses its failed result -> Store B's receipt stays unreviewed!
  let releaseTriA1
  const triA1Gate = new Promise(r => {
    releaseTriA1 = r
  })
  let triCall = 0
  const triRelay = await startTestRelay({
    botToken: 'tok',
    botUsername: 'bot',
    initialState: {
      privateChat: { id: '1001', label: '@collector' },
      group: { id: '-2002', label: 'Group' },
      questions: [],
      digest: [
        { id: 'td1', channel: '@ch', headline: 'A1', summary: 'One', timestamp: 'now', kind: 'channel' },
        { id: 'td2', channel: '@ch', headline: 'A2', summary: 'Two', timestamp: 'now', kind: 'channel' },
        { id: 'td3', channel: '@ch', headline: 'B3', summary: 'Three', timestamp: 'now', kind: 'channel' },
      ],
    },
    callTelegram: async () => {
      triCall += 1
      if (triCall === 1) {
        await triA1Gate
        return { message_id: 101 }
      }
      if (triCall === 2) {
        const err = new Error('Bad Request: chat write forbidden')
        err.telegramDescription = 'Bad Request: chat write forbidden'
        err.isDefinitiveTelegramError = true
        throw err
      }
      return { message_id: 103 }
    },
  })
  t.after(triRelay.close)

  const triStoreA = new TelegramCompanionStore(inspector, () => catalog, () => null, triRelay.baseUrl, '')
  const triStoreB = new TelegramCompanionStore(inspector, () => catalog, () => null, triRelay.baseUrl, '')
  await triStoreA.refresh()
  await triStoreB.refresh()

  // 1. Store A starts send 1 (held)
  triStoreA.openDigest()
  triStoreA.activate()

  // 2. Store A starts send 2 -> displays failed result
  triStoreA.openDigest()
  triStoreA.step(1)
  triStoreA.activate()
  await t.waitFor(() => assert.equal(triStoreA.getSnapshot().screen.kind, 'result'))
  assert.equal(triStoreA.getSnapshot().screen.status, 'failed')

  // 3. Store B starts send 3 -> persists sent receipt (reviewed: false)
  triStoreB.openDigest()
  triStoreB.step(1)
  triStoreB.step(1)
  triStoreB.activate()
  await t.waitFor(() => assert.equal(triStoreB.getSnapshot().screen.kind, 'result'))
  const triBReceiptId = triStoreB.getSnapshot().receipt.requestId

  // 4. Store A's send 1 finally settles while Store A still displays send 2's result
  const triA2RequestId = triStoreA.getSnapshot().screen.requestId
  releaseTriA1()
  await t.waitFor(() => assert.equal(triStoreA.getSnapshot().receipt?.requestId, triBReceiptId))
  assert.equal(triStoreA.getSnapshot().screen.kind, 'result')
  assert.equal(triStoreA.getSnapshot().screen.status, 'failed')
  assert.equal(triStoreA.getSnapshot().screen.requestId, triA2RequestId)

  // No-arg checkDelivery() on Store A targets displayed send 2 (not Store B's send 3)
  let checkedUrl = ''
  const origTriFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/g2/telegram/delivery/')) checkedUrl = String(url)
    return origTriFetch(url, init)
  }
  await triStoreA.checkDelivery()
  globalThis.fetch = origTriFetch
  assert.equal(checkedUrl.endsWith(`/${encodeURIComponent(triA2RequestId)}`), true)

  // 5. Dismissing Store A's failed result MUST NOT mark Store B's unseen receipt reviewed!
  triStoreA.back()
  assert.equal(triStoreA.getSnapshot().screen.kind, 'idle')
  const triReceiptKey = getTelegramReceiptStorageKey(triRelay.baseUrl, '')
  const triStoredAfterABack = JSON.parse(storage.get(triReceiptKey))
  assert.equal(triStoredAfterABack.requestId, triBReceiptId)
  assert.equal(triStoredAfterABack.reviewed, false, 'Dismissing Store A failed result must not review Store B receipt')

  // Relay A -> Relay B isolation: switching relays never exposes Relay A history or publishes Relay A late completions into Relay B!
  let releaseRelayAInFlight
  const relayAInFlightGate = new Promise(r => {
    releaseRelayAInFlight = r
  })
  let relayACalls = 0
  const isolatedRelayA = await startTestRelay({
    botToken: 'tok',
    botUsername: 'botA',
    initialState: {
      privateChat: { id: '1001', label: '@alice_dm' },
      group: null,
      questions: [],
      digest: [
        { id: 'ra1', channel: '@chA', headline: 'RelayA First', summary: 'One', timestamp: 'now', kind: 'channel' },
        { id: 'ra2', channel: '@chA', headline: 'RelayA InFlight', summary: 'Two', timestamp: 'now', kind: 'channel' },
      ],
    },
    callTelegram: async () => {
      relayACalls += 1
      if (relayACalls === 2) await relayAInFlightGate
      return { message_id: relayACalls }
    },
  })
  t.after(isolatedRelayA.close)

  const isolatedRelayB = await startTestRelay({
    botToken: 'tok',
    botUsername: 'botB',
    initialState: {
      privateChat: { id: '9009', label: '@bob_dm' },
      group: null,
      questions: [],
      digest: [{ id: 'rb1', channel: '@chB', headline: 'RelayB Item', summary: 'Three', timestamp: 'now', kind: 'channel' }],
    },
    callTelegram: async () => ({ message_id: 500 }),
  })
  t.after(isolatedRelayB.close)

  const switchStore = new TelegramCompanionStore(inspector, () => catalog, () => null, isolatedRelayA.baseUrl, '')
  await switchStore.refresh()
  switchStore.openDigest()
  switchStore.activate()
  await t.waitFor(() => assert.equal(switchStore.getSnapshot().screen.kind, 'result'))
  assert.equal(switchStore.getSnapshot().sentLog.length, 1)

  // Start pairing on Relay A -> pairingUrl set -> switching to Relay B clears pairing, pairingUrl, and pairingKind!
  await switchStore.startPairing('private')
  assert.match(switchStore.getSnapshot().pairingUrl ?? '', /botA/)
  assert.equal(switchStore.getSnapshot().pairingKind, 'private')

  // Start second send on Relay A (held in flight), then switch to Relay B
  switchStore.openDigest()
  switchStore.step(1)
  switchStore.activate()
  await switchStore.configureRelay(isolatedRelayB.baseUrl, '')
  assert.equal(switchStore.getSnapshot().pairing, false, 'Relay switch clears pairing flag')
  assert.equal(switchStore.getSnapshot().pairingUrl, null, 'Relay switch clears previous bot pairingUrl')
  assert.equal(switchStore.getSnapshot().pairingKind, null, 'Relay switch clears previous bot pairingKind')
  assert.equal(switchStore.getSnapshot().receipt, null, 'Relay B starts with isolated null receipt')
  assert.equal(switchStore.getSnapshot().sentLog.length, 0, 'Relay B starts with isolated empty sentLog')

  // Let Relay A's in-flight send finish -> Relay B stays untouched while Relay A's storage records both items
  releaseRelayAInFlight()
  await new Promise(r => setTimeout(r, 50))
  assert.equal(switchStore.getSnapshot().receipt, null, 'Relay A late completion must not publish receipt into Relay B')
  assert.equal(switchStore.getSnapshot().sentLog.length, 0, 'Relay A late completion must not publish sentLog into Relay B')
  assert.equal(storage.get(getTelegramSentLogStorageKey(isolatedRelayB.baseUrl, '')), undefined)

  const relayALog = JSON.parse(storage.get(getTelegramSentLogStorageKey(isolatedRelayA.baseUrl, '')))
  assert.equal(relayALog.length, 2, 'Relay A scoped sentLog records both Relay A sends')

  // Switching back to Relay A restores Relay A's 2 items
  await switchStore.configureRelay(isolatedRelayA.baseUrl, '')
  assert.equal(switchStore.getSnapshot().sentLog.length, 2)
  assert.match(switchStore.getSnapshot().receipt?.destination ?? '', /@alice_dm/)

  // Relative relay URLs resolve against base origin while preserving case-sensitive pathnames (/RelayA !== /relaya)
  assert.equal(
    canonicalizeRelayUrl('/RelayA/', 'https://App.Example.com/index.html'),
    'https://app.example.com/RelayA',
  )
  assert.equal(
    canonicalizeRelayUrl('/relaya/', 'https://App.Example.com/index.html'),
    'https://app.example.com/relaya',
  )
  assert.notEqual(
    getTelegramReceiptStorageKey('/RelayA', '', 'https://app.example.com/index.html'),
    getTelegramReceiptStorageKey('/relaya', '', 'https://app.example.com/index.html'),
    'Case-distinct relative relay paths produce distinct storage keys',
  )
  for (const rejectedUrl of [
    'javascript:alert(1)',
    '/RelayA?',
    '/RelayA#',
    'https://app.example.com/RelayA?',
    'https://app.example.com/RelayA#',
    'https://user:pass@app.example.com/RelayA',
  ]) {
    assert.equal(
      canonicalizeRelayUrl(rejectedUrl, 'https://app.example.com/'),
      null,
      `Expected ${rejectedUrl} to be rejected`,
    )
  }

  // Invalid nonblank relay save rejects BEFORE modifying storage, token, or active relay state!
  await switchStore.configureRelay(isolatedRelayA.baseUrl, 'valid-token-a')
  const savedCfgBeforeInvalid = storage.get('telegifts_g2_relay_cfg_v1')
  for (const invalidSaveUrl of ['javascript:alert(1)', '/RelayA?', '/RelayA#']) {
    const accepted = await switchStore.configureRelay(invalidSaveUrl, 'should-never-be-saved')
    assert.equal(accepted, false)
    assert.equal(storage.get('telegifts_g2_relay_cfg_v1'), savedCfgBeforeInvalid, 'Invalid save must not touch storage')
    assert.equal(switchStore.getSnapshot().relayConfig.relayUrl, isolatedRelayA.baseUrl)
    assert.equal(switchStore.getSnapshot().relayConfig.relayToken, 'valid-token-a')
    assert.ok(switchStore.getSnapshot().relayConfigError)
  }

  // Explicit blank save switches to demo mode, clears any saved token, and persists explicitDemo so reload stays in demo
  const switchedToDemo = await switchStore.configureRelay('', 'discarded-token')
  assert.equal(switchedToDemo, true)
  assert.equal(switchStore.getSnapshot().state?.mode, 'demo')
  assert.equal(switchStore.getSnapshot().relayConfig.relayToken, '')
  const savedDemoCfg = JSON.parse(storage.get('telegifts_g2_relay_cfg_v1'))
  assert.deepEqual(savedDemoCfg, { relayUrl: '', relayToken: '', explicitDemo: true })
})
