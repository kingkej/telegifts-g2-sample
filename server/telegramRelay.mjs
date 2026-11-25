import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * Self-hosted Telegram Bot Relay for TeleGifts Even G2 Companion.
 *
 * Keeps TELEGRAM_BOT_TOKEN strictly server-side (never exposed to browser bundles).
 * Supports:
 *  - Deep-link pairing (/start pair_private_<token> or /start pair_group_<token>)
 *  - Topic-aware group question capture (/ask@<bot> <question>)
 *  - Channel post digest ingestion
 *  - 1-tap text replies & daily comparisons (sendMessage with reply_parameters)
 *  - Monochrome G2 floor chart PNG sharing (multipart sendPhoto with custom or default caption)
 *  - Server-side destination resolution, missing-reply fencing, and in-flight idempotent receipts
 */

function isLoopbackHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
}

function parseHostHeaderHostname(rawHostHeader) {
  if (typeof rawHostHeader !== 'string') return null
  const trimmed = rawHostHeader.trim()
  if (!trimmed || /[\s/\\@]/.test(trimmed)) return null
  try {
    const parsed = new URL(`http://${trimmed}`)
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

function formatHostForUrl(host) {
  const clean = String(host ?? 'localhost').trim() || 'localhost'
  return clean.includes(':') && !clean.startsWith('[') ? `[${clean}]` : clean
}

function validBearerToken(headerValue, expectedToken) {
  if (!expectedToken) return true
  const raw = String(headerValue ?? '')
  if (!raw.startsWith('Bearer ')) return false
  const provided = Buffer.from(raw.slice('Bearer '.length).trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

export function createTelegramRelayServer(options = {}) {
  const botToken = String(options.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
  const botUsername = String(options.botUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? '')
    .trim()
    .replace(/^@/, '')
  const host = String(options.host ?? process.env.RELAY_HOST ?? 'localhost').trim() || 'localhost'
  const urlHost = formatHostForUrl(host)
  const port = Number(options.port ?? process.env.RELAY_PORT ?? 8787)
  const authToken = String(options.authToken ?? process.env.RELAY_AUTH_TOKEN ?? '').trim()
  const allowedOrigins = String(
    options.allowedOrigin ?? process.env.RELAY_ALLOWED_ORIGIN ?? 'http://localhost:3000,http://127.0.0.1:3000',
  )
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const rawAllowedChannels = Array.isArray(options.allowedChannels)
    ? options.allowedChannels.join(',')
    : String(options.allowedChannels ?? process.env.RELAY_ALLOWED_CHANNELS ?? '')
  const allowedChannels = new Set(
    rawAllowedChannels
      .split(',')
      .map(s => s.trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean),
  )

  const MAX_RECEIPTS = 500
  const MAX_PENDING_TOKENS = 200

  function purgeExpiredPendingTokens(now = Date.now()) {
    for (const [token, info] of state.pendingTokens) {
      if (Date.parse(info.expiresAt) <= now) {
        state.pendingTokens.delete(token)
      }
    }
    while (state.pendingTokens.size > MAX_PENDING_TOKENS) {
      const oldest = state.pendingTokens.keys().next().value
      if (oldest === undefined) break
      state.pendingTokens.delete(oldest)
    }
  }

  function storeReceipt(requestId, receipt) {
    if (state.receipts.has(requestId)) {
      state.receipts.delete(requestId)
    }
    state.receipts.set(requestId, receipt)
    while (state.receipts.size > MAX_RECEIPTS) {
      const oldest = state.receipts.keys().next().value
      if (oldest === undefined) break
      state.receipts.delete(oldest)
    }
  }

  function isAllowedChannelPost(chat) {
    if (!chat) return false
    const idKey = String(chat.id ?? '').trim().toLowerCase()
    const userKey = String(chat.username ?? '').trim().replace(/^@/, '').toLowerCase()
    if (allowedChannels.size > 0) {
      return (idKey && allowedChannels.has(idKey)) || (userKey && allowedChannels.has(userKey))
    }
    // Without explicit RELAY_ALLOWED_CHANNELS, reject arbitrary third-party channels so
    // strangers cannot add the bot to a channel and inject headlines onto the user's HUD.
    return false
  }

  if (!isLoopbackHost(host) && !authToken) {
    throw new Error('RELAY_AUTH_TOKEN is required when binding RELAY_HOST outside loopback (127.0.0.1 / ::1).')
  }

  const state = {
    privateChat: options.initialState?.privateChat ?? null,
    group: options.initialState?.group ?? null,
    candidate: options.initialState?.candidate ?? null,
    pendingTokens: new Map(), // token -> { kind, expiresAt }
    questions: [...(options.initialState?.questions ?? [])],
    digest: [...(options.initialState?.digest ?? [])],
    receipts: new Map(), // requestId -> { status, reason? }
    inFlight: new Map(), // requestId -> Promise<{ status, reason? }>
    updateOffset: 0,
  }

  const callTelegram =
    options.callTelegram
    ?? (async (method, payload, isFormData = false) => {
      if (!botToken) {
        const cfgErr = new Error('TELEGRAM_BOT_TOKEN is not configured')
        cfgErr.isDefinitiveTelegramError = true
        throw cfgErr
      }
      let response
      try {
        response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
          method: 'POST',
          ...(isFormData
            ? { body: payload }
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              }),
        })
      } catch (networkErr) {
        networkErr.isTransportUncertain = true
        throw networkErr
      }
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) {
        const desc = String(data?.description ?? `HTTP ${response.status}`)
        const error = new Error(desc)
        error.telegramDescription = desc
        // 4xx JSON error from Bot API means Telegram definitively rejected the request before delivery.
        // 5xx or non-JSON gateway responses leave delivery unconfirmed ('unknown').
        if (response.status >= 400 && response.status < 500 && response.status !== 429 && data && data.ok === false) {
          error.isDefinitiveTelegramError = true
        } else {
          error.isTransportUncertain = true
        }
        throw error
      }
      return data.result
    })

  let pollingStopped = false
  let pollTimer = null
  const sseClients = new Set()

  function publicStatePayload() {
    return {
      enabled: Boolean(botToken && botUsername),
      privateChat: state.privateChat,
      group: state.group,
      candidate: state.candidate,
      questions: state.questions.map(({ chatId: _c, messageId: _m, ...publicFields }) => publicFields),
      digest: state.digest,
    }
  }

  function broadcastSseState() {
    if (!sseClients.size) return
    const frame = `event: state\ndata: ${JSON.stringify(publicStatePayload())}\n\n`
    for (const client of [...sseClients]) {
      try {
        client.res.write(frame)
      } catch {
        clearInterval(client.keepAlive)
        sseClients.delete(client)
      }
    }
  }

  function closeSseClients() {
    for (const client of [...sseClients]) {
      clearInterval(client.keepAlive)
      try {
        client.res.end()
      } catch {
        // Ignore already-closed sockets
      }
    }
    sseClients.clear()
  }

  function fitUtf8Bytes(input, maxBytes) {
    let out = ''
    for (const ch of String(input ?? '')) {
      if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break
      out += ch
    }
    return out.trim()
  }

  function buildInlineKeyboard(collection, chatKind = 'group') {
    const clean = fitUtf8Bytes(String(collection ?? '').replace(/[\r\n]/g, ' '), 48)
    if (!clean) return undefined
    const row =
      chatKind === 'group'
        ? [
            { text: '🔄 Ask Live Floor', callback_data: `tg2:ask:${clean}` },
            { text: '📌 Pin to Digest', callback_data: `tg2:pin:${clean}` },
          ]
        : [{ text: '📌 Pin to Digest', callback_data: `tg2:pin:${clean}` }]
    return { inline_keyboard: [row] }
  }

  function ingestTelegramUpdates(updates) {
    purgeExpiredPendingTokens()
    let changed = false
    for (const update of updates) {
      state.updateOffset = Math.max(state.updateOffset, update.update_id + 1)
      const msg = update.message
      if (msg && typeof msg.text === 'string') {
        const startMatch = /^\/start(?:@\S+)?\s+(pair_(?:private|group)_[a-z0-9-]+)$/i.exec(msg.text.trim())
        if (startMatch) {
          const token = startMatch[1]
          const pending = state.pendingTokens.get(token)
          if (pending && Date.parse(pending.expiresAt) > Date.now()) {
            const chatMatchesKind = pending.kind === 'private' ? msg.chat.type === 'private' : msg.chat.type !== 'private'
            if (chatMatchesKind) {
              const label =
                msg.chat.type === 'private'
                  ? `@${msg.from?.username || msg.from?.first_name || 'user'}`
                  : msg.chat.title || 'Telegram Group'
              state.candidate = {
                id: String(msg.chat.id),
                label,
                kind: pending.kind,
                expiresAt: pending.expiresAt,
              }
              state.pendingTokens.delete(token)
              changed = true
            }
          }
          continue
        }

        const askMatch = /^\/ask(?:@([a-z0-9_]+))?\s+(.+)$/is.exec(msg.text.trim())
        if (askMatch && state.group && String(msg.chat.id) === state.group.id) {
          const addressed = askMatch[1]
          if (!addressed || !botUsername || addressed.toLowerCase() === botUsername.toLowerCase()) {
            const sender = msg.from?.username ? `@${msg.from.username}` : msg.from?.first_name || 'Member'
            const topicId = typeof msg.message_thread_id === 'number' ? msg.message_thread_id : undefined
            state.questions.unshift({
              id: `${msg.chat.id}:${msg.message_id}`,
              chatId: String(msg.chat.id),
              messageId: msg.message_id,
              topicId,
              topicName: topicId ? `Topic #${topicId}` : undefined,
              sender,
              text: askMatch[2].trim(),
              chatLabel: msg.chat.title || state.group.label,
              askedAt: new Date(msg.date * 1000).toISOString(),
            })
            state.questions = state.questions.slice(0, 30)
            changed = true
          }
        }
      }

      const post = update.channel_post
      if (post && typeof post.text === 'string' && post.text.trim()) {
        if (!isAllowedChannelPost(post.chat)) {
          const chRef = post.chat?.username ? `@${post.chat.username}` : String(post.chat?.id ?? 'unknown')
          console.warn(
            `[telegram-relay] Ignored channel_post from unallowlisted channel ${chRef} (set RELAY_ALLOWED_CHANNELS to enable)`,
          )
        } else {
          const lines = post.text.trim().split('\n')
          state.digest.unshift({
            id: `ch-${post.chat.id}-${post.message_id}`,
            channel: post.chat.username ? `@${post.chat.username}` : post.chat.title || 'Channel',
            headline: lines[0].slice(0, 96),
            summary: lines.slice(1).join(' ').slice(0, 180) || lines[0],
            timestamp: new Date(post.date * 1000).toISOString(),
            kind: 'channel',
          })
          state.digest = state.digest.slice(0, 20)
          changed = true
        }
      }

      const cb = update.callback_query
      if (cb && typeof cb.data === 'string' && cb.message?.chat) {
        const chatIdStr = String(cb.message.chat.id)
        const sender = cb.from?.username ? `@${cb.from.username}` : cb.from?.first_name || 'Collector'
        const isPairedGroup = Boolean(state.group && chatIdStr === state.group.id)
        const isPairedPrivate = Boolean(state.privateChat && chatIdStr === state.privateChat.id)

        if (cb.data.startsWith('tg2:ask:') && isPairedGroup) {
          const col = cb.data.slice('tg2:ask:'.length).trim()
          if (col) {
            const topicId = typeof cb.message.message_thread_id === 'number' ? cb.message.message_thread_id : undefined
            const qid = `cb:${chatIdStr}:${cb.id}`
            if (!state.questions.some(q => q.id === qid)) {
              state.questions.unshift({
                id: qid,
                chatId: chatIdStr,
                messageId: cb.message.message_id,
                topicId,
                topicName: topicId ? `Topic #${topicId}` : undefined,
                collectionHint: col,
                sender,
                text: `Live floor & venue spread update for ${col}?`,
                chatLabel: cb.message.chat.title || state.group.label,
                askedAt: new Date().toISOString(),
              })
              state.questions = state.questions.slice(0, 30)
              changed = true
            }
            if (botToken) {
              void callTelegram('answerCallbackQuery', {
                callback_query_id: cb.id,
                text: `Queued ${col} check on G2 HUD`,
              }).catch(() => {})
            }
          }
        } else if (cb.data.startsWith('tg2:pin:') && (isPairedGroup || isPairedPrivate)) {
          const col = cb.data.slice('tg2:pin:'.length).trim()
          if (col) {
            const pinKey = `pin-col:${col.toLowerCase()}`
            const existingIdx = state.digest.findIndex(d => d.id === pinKey)
            const entry = {
              id: pinKey,
              channel: sender,
              headline: `${col} pinned from Telegram`,
              summary: `Pinned via inline bot card in ${cb.message.chat.title || 'Telegram'} for G2 tracking.`,
              collection: col,
              timestamp: new Date().toISOString(),
              kind: 'channel',
            }
            if (existingIdx >= 0) {
              state.digest.splice(existingIdx, 1)
            }
            state.digest.unshift(entry)
            state.digest = state.digest.slice(0, 20)
            changed = true
            if (botToken) {
              void callTelegram('answerCallbackQuery', {
                callback_query_id: cb.id,
                text: `Pinned ${col} to G2 Digest`,
              }).catch(() => {})
            }
          }
        } else if (cb.data.startsWith('tg2:') && (isPairedGroup || isPairedPrivate) && botToken) {
          void callTelegram('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Action only available in paired collector group',
          }).catch(() => {})
        }
      }
    }
    if (changed) broadcastSseState()
  }

  async function pollTelegramUpdates() {
    if (!botToken || pollingStopped) return
    let nextDelayMs = 0
    try {
      const updates = await callTelegram('getUpdates', {
        offset: state.updateOffset,
        timeout: 15,
        allowed_updates: ['message', 'channel_post', 'callback_query'],
      })
      ingestTelegramUpdates(updates)
    } catch (err) {
      nextDelayMs = 1200
      console.warn('[telegram-relay] Poll error:', err.message)
    } finally {
      if (botToken && !pollingStopped) {
        pollTimer = setTimeout(pollTelegramUpdates, nextDelayMs)
      }
    }
  }

  function evaluateOrigin(req) {
    const rawOrigin = req.headers.origin
    if (Array.isArray(rawOrigin)) {
      return { allowed: false, allowOriginHeader: null }
    }
    const reqOrigin = typeof rawOrigin === 'string' ? rawOrigin.trim() : ''
    const fetchSite = String(req.headers['sec-fetch-site'] ?? '').trim().toLowerCase()

    // Always reject opaque 'null' origins (sandboxed iframes / data URLs), even when '*' is configured
    if (reqOrigin.toLowerCase() === 'null') {
      return { allowed: false, allowOriginHeader: null }
    }

    // Tokenless loopback independently rejects all cross-site browser requests before checking the Origin allowlist.
    // Bearer-authenticated relays permit cross-site requests only when a non-empty Origin header matches the allowlist.
    if (fetchSite === 'cross-site' && (!authToken || !reqOrigin)) {
      return { allowed: false, allowOriginHeader: null }
    }

    // Wildcard '*' is only permitted when Bearer auth is enabled; tokenless loopback requires explicit local origins
    const wildcardAllowed = Boolean(authToken) && allowedOrigins.includes('*')

    if (reqOrigin) {
      if (wildcardAllowed) {
        return { allowed: true, allowOriginHeader: '*' }
      }
      if (allowedOrigins.includes(reqOrigin)) {
        return { allowed: true, allowOriginHeader: reqOrigin }
      }
      return { allowed: false, allowOriginHeader: null }
    }

    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
      return { allowed: false, allowOriginHeader: null }
    }

    return { allowed: true, allowOriginHeader: null }
  }

  function hasJsonContentType(req) {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase()
    const mediaType = ct.split(';')[0].trim()
    return mediaType === 'application/json'
  }

  function setCors(req, res, originDecision = evaluateOrigin(req)) {
    if (originDecision.allowOriginHeader) {
      res.setHeader('Access-Control-Allow-Origin', originDecision.allowOriginHeader)
      if (originDecision.allowOriginHeader !== '*') {
        res.setHeader('Vary', 'Origin')
      }
    } else {
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization')
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let total = 0
      req.on('data', chunk => {
        total += chunk.length
        if (total > 2 * 1024 * 1024) {
          reject(new Error('Payload too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8').trim()
          if (!raw) {
            reject(new Error('Empty request body'))
            return
          }
          const parsed = JSON.parse(raw)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            reject(new Error('Expected JSON object'))
            return
          }
          resolve(parsed)
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  function sendJson(req, res, code, data, originDecision = evaluateOrigin(req)) {
    setCors(req, res, originDecision)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }

  function normalizeRequestId(raw) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    return id.length > 0 && id.length <= 128 ? id : null
  }

  function classifyTelegramError(err, question) {
    if (err?.isTransportUncertain) {
      return { status: 'unknown' }
    }
    const desc = String(err?.telegramDescription ?? '')
    const missing = /message to be replied not found|thread not found/i.test(desc)
    if (missing) {
      if (question) state.questions = state.questions.filter(q => q.id !== question.id)
      return { status: 'failed', reason: 'missing_reply' }
    }
    if (err?.isDefinitiveTelegramError || desc) {
      return { status: 'failed' }
    }
    return { status: 'unknown' }
  }

  function resolveAuthorizedTarget(body, requireReplyQuestion = false) {
    const hasQuestionField = body.questionId !== undefined && body.questionId !== null
    if (requireReplyQuestion || hasQuestionField) {
      const qid = typeof body.questionId === 'string' ? body.questionId.trim() : String(body.questionId ?? '').trim()
      if (!qid) {
        return { ok: false, receipt: { status: 'failed', reason: 'missing_reply' } }
      }
      if (!state.group || (body.destinationId && String(body.destinationId) !== state.group.id)) {
        return { ok: false, receipt: { status: 'failed', reason: 'missing_reply' } }
      }
      const question = state.questions.find(q => q.id === qid && q.chatId === state.group.id)
      if (!question) {
        return { ok: false, receipt: { status: 'failed', reason: 'missing_reply' } }
      }
      return { ok: true, chatId: state.group.id, question, chatKind: 'group' }
    }

    if (body.targetKind === 'group') {
      if (!state.group || (body.destinationId && String(body.destinationId) !== state.group.id)) {
        return { ok: false, receipt: { status: 'failed' } }
      }
      return { ok: true, chatId: state.group.id, question: null, chatKind: 'group' }
    }

    if (!state.privateChat || (body.destinationId && String(body.destinationId) !== state.privateChat.id)) {
      return { ok: false, receipt: { status: 'failed' } }
    }
    return { ok: true, chatId: state.privateChat.id, question: null, chatKind: 'private' }
  }

  async function executeIdempotent(requestId, action) {
    const cached = state.receipts.get(requestId)
    if (cached) return cached
    const existingPromise = state.inFlight.get(requestId)
    if (existingPromise) return await existingPromise

    const promise = (async () => {
      try {
        const receipt = await action()
        storeReceipt(requestId, receipt)
        return receipt
      } finally {
        state.inFlight.delete(requestId)
      }
    })()

    state.inFlight.set(requestId, promise)
    return await promise
  }

  function isAllowedHostHeader(req) {
    const reqHostname = parseHostHeaderHostname(req.headers.host)
    if (!reqHostname) return false
    if (!authToken) {
      return isLoopbackHost(reqHostname)
    }
    return true
  }

  const server = createServer(async (req, res) => {
    const deniedDecision = { allowed: false, allowOriginHeader: null }
    if (!isAllowedHostHeader(req)) {
      sendJson(req, res, 403, { error: 'Forbidden host' }, deniedDecision)
      return
    }

    const originDecision = evaluateOrigin(req)
    if (!originDecision.allowed) {
      sendJson(req, res, 403, { error: 'Forbidden origin' }, originDecision)
      return
    }
    setCors(req, res, originDecision)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (!validBearerToken(req.headers.authorization, authToken)) {
      sendJson(req, res, 401, { error: 'Unauthorized' }, originDecision)
      return
    }

    if (req.method === 'POST' && !hasJsonContentType(req)) {
      sendJson(req, res, 415, { error: 'Content-Type must be application/json' }, originDecision)
      return
    }

    try {
      const url = new URL(req.url ?? '/', `http://${urlHost}:${port || 8787}`)
      if (req.method === 'GET' && url.pathname === '/g2/telegram/state') {
        sendJson(req, res, 200, publicStatePayload())
        return
      }

      if (req.method === 'GET' && url.pathname === '/g2/telegram/events') {
        setCors(req, res, originDecision)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write(`event: state\ndata: ${JSON.stringify(publicStatePayload())}\n\n`)
        const keepAlive = setInterval(() => {
          try {
            res.write(': keepalive\n\n')
          } catch {
            clearInterval(keepAlive)
          }
        }, 15_000)
        keepAlive.unref?.()
        const client = { res, keepAlive }
        sseClients.add(client)
        req.on('close', () => {
          clearInterval(keepAlive)
          sseClients.delete(client)
        })
        return
      }

      if (req.method === 'GET' && url.pathname.startsWith('/g2/telegram/delivery/')) {
        const requestId = decodeURIComponent(url.pathname.slice('/g2/telegram/delivery/'.length))
        if (state.inFlight.has(requestId)) {
          sendJson(req, res, 200, { status: 'pending' })
          return
        }
        const receipt = state.receipts.get(requestId)
        if (!receipt) {
          sendJson(req, res, 404, { error: 'Receipt not found' })
          return
        }
        sendJson(req, res, 200, receipt)
        return
      }

      if (req.method === 'POST' && url.pathname === '/g2/telegram/link') {
        const body = await readBody(req)
        const kind = body.kind === 'private' ? 'private' : body.kind === 'group' ? 'group' : null
        if (!kind) {
          sendJson(req, res, 400, { error: 'Invalid kind' }, originDecision)
          return
        }
        if (!botToken || !botUsername) {
          sendJson(req, res, 503, { error: 'Configure TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME first' }, originDecision)
          return
        }
        purgeExpiredPendingTokens()
        const token = `pair_${kind}_${randomUUID().slice(0, 8)}`
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
        state.pendingTokens.set(token, { kind, expiresAt })
        purgeExpiredPendingTokens()
        const param = kind === 'group' ? `startgroup=${token}` : `start=${token}`
        sendJson(req, res, 200, {
          id: token,
          url: `https://t.me/${botUsername}?${param}`,
          expiresAt,
        })
        return
      }

      if (req.method === 'POST' && url.pathname === '/g2/telegram/confirm-link') {
        const body = await readBody(req)
        if (!state.candidate || state.candidate.id !== body.id || Date.parse(state.candidate.expiresAt) <= Date.now()) {
          sendJson(req, res, 409, { error: 'Candidate changed or expired' })
          return
        }
        const dest = { id: state.candidate.id, label: state.candidate.label }
        if (state.candidate.kind === 'private') {
          state.privateChat = dest
        } else {
          if (state.group?.id !== dest.id) state.questions = []
          state.group = dest
        }
        state.candidate = null
        broadcastSseState()
        sendJson(req, res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/g2/telegram/unlink') {
        const body = await readBody(req)
        const kind = body.kind === 'private' ? 'private' : body.kind === 'group' ? 'group' : null
        const expectedId = typeof body.destinationId === 'string' ? body.destinationId.trim() : ''
        if (!kind || !expectedId) {
          sendJson(req, res, 400, { error: 'Missing kind or destinationId' })
          return
        }
        const activeBinding = kind === 'private' ? state.privateChat : state.group
        if (!activeBinding || activeBinding.id !== expectedId) {
          sendJson(req, res, 409, { error: 'Destination binding changed' })
          return
        }
        if (kind === 'private') {
          state.privateChat = null
          state.group = null
          state.questions = []
          state.candidate = null
        } else {
          state.group = null
          state.questions = []
          if (state.candidate?.kind === 'group') state.candidate = null
        }
        broadcastSseState()
        sendJson(req, res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && (url.pathname === '/g2/telegram/reply' || url.pathname === '/g2/telegram/send-comparison')) {
        const body = await readBody(req)
        const requestId = normalizeRequestId(body.requestId)
        if (!requestId) {
          sendJson(req, res, 400, { error: 'Missing requestId' })
          return
        }

        const isComparison = url.pathname === '/g2/telegram/send-comparison'
        const receipt = await executeIdempotent(requestId, async () => {
          const resolved = resolveAuthorizedTarget(body, isComparison)
          if (!resolved.ok) return resolved.receipt

          const { chatId, question, chatKind } = resolved
          const text =
            typeof body.text === 'string' && body.text.trim()
              ? body.text.trim()
              : `${body.collection} 7d UTC daily closes: ${body.previous} -> ${body.last} GRAM`
          const inlineMarkup =
            body.includeInlineActions === true ? buildInlineKeyboard(body.collection, chatKind) : undefined

          try {
            await callTelegram('sendMessage', {
              chat_id: chatId,
              text,
              ...(question?.topicId ? { message_thread_id: question.topicId } : {}),
              ...(question?.messageId ? { reply_parameters: { message_id: question.messageId } } : {}),
              ...(inlineMarkup ? { reply_markup: inlineMarkup } : {}),
            })
            if (question) {
              state.questions = state.questions.filter(q => q.id !== question.id)
              broadcastSseState()
            }
            return { status: 'sent' }
          } catch (err) {
            const classified = classifyTelegramError(err, question)
            if (classified.reason === 'missing_reply') broadcastSseState()
            return classified
          }
        })

        sendJson(req, res, 200, receipt)
        return
      }

      if (req.method === 'POST' && url.pathname === '/g2/telegram/send') {
        const body = await readBody(req)
        const requestId = normalizeRequestId(body.requestId)
        if (!requestId) {
          sendJson(req, res, 400, { error: 'Missing requestId' })
          return
        }

        const receipt = await executeIdempotent(requestId, async () => {
          const resolved = resolveAuthorizedTarget(body, false)
          if (!resolved.ok) return resolved.receipt

          const { chatId, question, chatKind } = resolved
          let form
          try {
            const pngBytes = Buffer.from(String(body.pngBase64 ?? ''), 'base64')
            if (pngBytes.length < 8) return { status: 'failed' }
            const isSpread = body.chartKind === 'spread' || body.range === 'spread'
            const caption =
              typeof body.caption === 'string' && body.caption.trim()
                ? body.caption.trim().slice(0, 1024)
                : isSpread
                  ? `${body.collection} · 5-Venue Spread · Best ${body.last} GRAM`
                  : `${body.collection} (${body.range}) · Floor ${body.last} GRAM · ${new Date(Number(body.lastTime) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
            form = new FormData()
            form.append('chat_id', String(chatId))
            form.append('caption', caption)
            if (question?.topicId) form.append('message_thread_id', String(question.topicId))
            if (question?.messageId) form.append('reply_parameters', JSON.stringify({ message_id: question.messageId }))
            const inlineMarkup =
              body.includeInlineActions === true ? buildInlineKeyboard(body.collection, chatKind) : undefined
            if (inlineMarkup) form.append('reply_markup', JSON.stringify(inlineMarkup))
            const photoFilename = isSpread ? 'venue-spread.png' : 'floor-chart.png'
            form.append('photo', new Blob([pngBytes], { type: 'image/png' }), photoFilename)
          } catch {
            return { status: 'failed' }
          }

          try {
            await callTelegram('sendPhoto', form, true)
            if (question) {
              state.questions = state.questions.filter(q => q.id !== question.id)
              broadcastSseState()
            }
            return { status: 'sent' }
          } catch (err) {
            const classified = classifyTelegramError(err, question)
            if (classified.reason === 'missing_reply') broadcastSseState()
            return classified
          }
        })

        sendJson(req, res, 200, receipt)
        return
      }

      sendJson(req, res, 404, { error: 'Not found' })
    } catch {
      sendJson(req, res, 400, { error: 'Malformed request body' })
    }
  })

  server.on('close', closeSseClients)

  return {
    server,
    state,
    host,
    port,
    ingestTelegramUpdates,
    broadcastSseState,
    closeSseClients,
    startPolling() {
      if (botToken && botUsername) void pollTelegramUpdates()
    },
    stopPolling() {
      pollingStopped = true
      if (pollTimer) clearTimeout(pollTimer)
      closeSseClients()
    },
  }
}

const isEntrypoint = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
if (isEntrypoint) {
  const relay = createTelegramRelayServer()
  relay.server.listen(relay.port, relay.host, () => {
    console.log(`[telegifts-g2-relay] Listening on http://${formatHostForUrl(relay.host)}:${relay.port}`)
    if (!process.env.TELEGRAM_BOT_TOKEN?.trim() || !process.env.TELEGRAM_BOT_USERNAME?.trim()) {
      console.log('[telegifts-g2-relay] Set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME to enable live bot polling.')
    } else {
      relay.startPolling()
    }
  })
}
