import { byteLength, characters, fitNativeText, nativeTextBytes } from './displayText.ts'
import type { CompanionInspection } from './contracts/companion.ts'
import {
  formatTelegramChange,
  formatTelegramClose,
  isTelegramDailyComparison,
  type CompanionTelegramSnapshot,
  type TelegramDeliveryStatus,
  type TelegramScreen,
} from './contracts/telegram.ts'
import { formatPrice } from './catalog.ts'
import type { HudRegions } from './hudLayout.ts'

type Notice = Extract<TelegramScreen, { kind: 'notice' }>['reason']
const notices: Record<Notice, string> = {
  connect: 'Connect your Telegram on the phone.',
  group: 'Link a Telegram group on the phone.',
  question: 'Open Questions and choose a question to reply to.',
  chart: 'Open a collection floor chart and wait for it to load.',
  comparison: 'The 7d chart needs two consecutive daily closes. Return to the chart or choose another question in Questions.',
  unavailable: 'Telegram is unavailable. Check the companion on your phone.',
  changed: 'The chart, destination or question changed. Open a fresh preview.',
  empty: 'No pending questions. Check again after someone asks in your group.',
}
const results: Record<TelegramDeliveryStatus, string> = {
  sent: 'Sent',
  failed: 'Delivery failed',
  unknown: 'Delivery unconfirmed',
  pending: 'Delivery pending',
}

function singleLine(text: string) {
  return text.replace(/[\u202a-\u202e\u2066-\u2069]/gu, '').replace(/\s+/gu, ' ').trim()
}
const label = (text: string) => fitNativeText(singleLine(text), 160)

export interface TelegramPage {
  list: string
  id: string | null
  content: string
  regions?: HudRegions
  tapAction: 'telegramActivate' | 'telegramBack' | 'telegramComposeSend' | null
}

export function telegramPage(
  { state, selectedQuestion, screen }: CompanionTelegramSnapshot,
  inspection?: CompanionInspection,
): TelegramPage | null {
  const page = (
    lines: string[],
    tapAction: TelegramPage['tapAction'],
    id: string | null = null,
    list: string = screen.kind,
    regions?: HudRegions,
  ): TelegramPage => {
    let content = lines.join('\n')
    if (byteLength(content) > nativeTextBytes) {
      const perLine = Math.floor((nativeTextBytes - lines.length + 1) / lines.length)
      content = lines.map(line => fitNativeText(line, perLine)).join('\n')
    }
    return { list, id, tapAction, content, regions }
  }
  const dismiss = 'Tap or double-tap to return'

  switch (screen.kind) {
    case 'idle':
      return null

    case 'heads-up': {
      const pri = screen.priority ?? screen.question?.priority
      const tags = screen.tags ?? screen.question?.triageTags ?? []
      const prefix = pri
        ? [`P${pri}`, ...tags.slice(0, 2)].join(' · ')
        : 'LIVE /ASK'
      const header = fitNativeText(`${prefix} · ${singleLine(screen.badge)}`, 72)
      const bodyLines = [
        fitNativeText(singleLine(screen.headline), 180),
        fitNativeText(singleLine(screen.detail), 360),
      ]
      const footer = 'Tap: 1-Tap Smart Reply · 2×Tap: Dismiss'
      return page(
        [header, ...bodyLines, '', footer],
        'telegramActivate',
        screen.alertId,
        `heads-up-${screen.alertId}`,
        { header, body: bodyLines.join('\n'), footer },
      )
    }

    case 'pending': {
      const s = screen.summary
      const oldestPart = s.oldestLabel ? ` · oldest ${singleLine(s.oldestLabel)}` : ''
      const header = fitNativeText(
        `${s.total} WAITING · ${s.p1Count} P1${oldestPart}`,
        72,
      )
      if (!s.topQuestion) {
        const body = 'All caught up. No pending /ask questions.'
        const footer = 'Tap: Check inbox · 2×Tap: Back'
        return page([header, body, '', footer], 'telegramActivate', 'pending-empty', 'pending', {
          header,
          body,
          footer,
        })
      }
      const colSummary = s.topCollections.length
        ? s.topCollections.map(c => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(' · ')
        : 'General group questions'
      const topLetters = characters(singleLine(s.topQuestion.text))
      const topPreview = topLetters.length > 52 ? topLetters.slice(0, 51).join('') + '…' : topLetters.join('')
      const bodyLines = [
        fitNativeText(colSummary, 160),
        fitNativeText(`Top: ${singleLine(s.topQuestion.sender)} "${topPreview}"`, 220),
      ]
      const footer = 'Tap: Reply top · Swipe: Browse · 2×Tap: Back'
      return page(
        [header, ...bodyLines, '', footer],
        'telegramActivate',
        `pending-${s.topQuestion.id}`,
        'pending',
        { header, body: bodyLines.join('\n'), footer },
      )
    }

    case 'questions': {
      const questions = state?.questions ?? []
      const q = questions[screen.index]
      if (!q) {
        return page(
          ['Questions', '', state ? 'No pending questions' : 'Checking for questions…', '', 'Tap for status · Menu to refresh', 'Double-tap to return'],
          'telegramActivate',
        )
      }
      const letters = characters(singleLine(q.text))
      const preview = letters.length > 72 ? letters.slice(0, 71).join('') + '…' : letters.join('')
      const chatWithTopic = q.topicName ? `${q.chatLabel} · ${q.topicName}` : q.chatLabel
      const priSuffix = q.priority ? ` · P${q.priority}` : ''
      const tagSuffix = q.triageTags?.length ? ` · ${q.triageTags[0]}` : ''
      const heading = [
        `Questions   ${screen.index + 1} / ${questions.length}${priSuffix}${tagSuffix}`,
        '',
        label(q.sender),
        label(chatWithTopic),
      ]
      const hints = ['', 'Swipe to browse · Tap to read', 'Double-tap to return']
      const available = nativeTextBytes - byteLength([...heading, '', ...hints].join('\n'))
      return page([...heading, fitNativeText(preview, available), ...hints], 'telegramActivate', q.id)
    }

    case 'question': {
      const q = screen.question
      const chatWithTopic = q.topicName ? `${q.chatLabel} · ${q.topicName}` : q.chatLabel
      const heading = label(q.sender) + ' · ' + label(chatWithTopic)
      const prefix = heading + '\nTap to use for reply · Double-tap for Questions\n\n'
      const body = fitNativeText(singleLine(q.text), nativeTextBytes - byteLength(prefix), '…\nRead the full question on your phone.')
      return page([prefix + body], 'telegramActivate', q.id)
    }

    case 'compose': {
      const draft = screen.drafts[screen.index]
      if (!draft) {
        return page(['Telegram', '', notices.changed, '', dismiss], 'telegramBack', null, 'changed')
      }
      const seenTag = screen.askerFeedback === 'seen' ? ' · SEEN' : ''
      const header = fitNativeText(
        `REPLY ${screen.index + 1}/${screen.drafts.length}${seenTag} · ${singleLine(screen.question.sender)} · ${singleLine(screen.destination)}`,
        72,
      )
      const attachmentBadge = draft.attachChart
        ? ' [+7d Chart]'
        : draft.attachSpreadChart
          ? ' [+Spread PNG]'
          : ''
      const bodyLines = [
        `${draft.label}${attachmentBadge}`,
        fitNativeText(singleLine(draft.text), 420),
      ]
      const sessionId = screen.composeSessionId ?? 0
      const ringHint = screen.dictation ? 'Hold R1: Dictate' : 'Hold R1: Voice pick'
      const footer = `Tap: Send · Swipe: Drafts · ${ringHint} · 2×Tap: Back`
      return page(
        [header, ...bodyLines, '', footer],
        'telegramComposeSend',
        `${sessionId}:${screen.question.id}:${draft.id}:${screen.index}`,
        `compose-${sessionId}-${screen.question.id}-${draft.id}-${screen.index}`,
        { header, body: bodyLines.join('\n'), footer },
      )
    }

    case 'digest': {
      const item = screen.items[screen.index]
      if (!item) {
        return page(['Channel digest', '', 'No channel alerts right now.', '', dismiss], 'telegramBack', null, 'digest-empty')
      }
      const header = fitNativeText(
        `DIGEST ${screen.index + 1}/${screen.items.length} · ${singleLine(item.channel)} · ${singleLine(item.timestamp)}`,
        180,
      )
      const bodyLines = [
        fitNativeText(singleLine(item.headline), 180),
        fitNativeText(singleLine(item.summary), 360),
      ]
      const footer = 'Tap: Save to DM · Swipe: Next alert · 2×Tap: Back'
      return page(
        [header, ...bodyLines, '', footer],
        'telegramActivate',
        item.id,
        `digest-${item.id}`,
        { header, body: bodyLines.join('\n'), footer },
      )
    }

    case 'confirm': {
      const bucket = new Date(screen.lastTime * 1000)
      const destination = screen.reply ? state?.group : state?.privateChat
      if (
        inspection?.mode !== 'chart'
        || inspection.status !== 'ready'
        || inspection.collection !== screen.collection
        || inspection.range !== screen.range
        || inspection.last !== screen.last
        || inspection.lastTime !== screen.lastTime
        || !Number.isFinite(bucket.getTime())
        || !state?.enabled
        || destination?.label !== screen.destination
        || (screen.reply && (!selectedQuestion || !state.questions.some(q => q.id === selectedQuestion.id)))
      ) {
        return page(['Telegram', '', notices.changed, '', dismiss], 'telegramBack', null, 'changed')
      }
      const confirm = (title: string, context: string, details: string[]) => {
        const labels = [singleLine(screen.destination), singleLine(screen.collection)]
        if (screen.reply && selectedQuestion) labels.push(singleLine(selectedQuestion.sender))
        const lines = ([to, collection, sender]: string[]) => [
          title,
          'To ' + to,
          ...(sender === undefined ? [] : ['For ' + sender]),
          collection + ' · ' + context,
          ...details,
        ]
        const full = lines(labels)
        if (byteLength(full.join('\n')) <= nativeTextBytes) return page(full, null)
        let remaining = nativeTextBytes - byteLength(lines(labels.map(() => '')).join('\n'))
        if (remaining < labels.length * byteLength('…')) {
          return page(['Telegram', '', 'This chart is too large to preview on the glasses.', '', dismiss], 'telegramBack', null, 'notice')
        }
        const bySize = labels.map((value, index) => ({ index, bytes: byteLength(value) })).sort((a, b) => a.bytes - b.bytes)
        for (const [i, { index }] of bySize.entries()) {
          labels[index] = fitNativeText(labels[index]!, Math.floor(remaining / (bySize.length - i)))
          remaining -= byteLength(labels[index]!)
        }
        return page(lines(labels), null)
      }
      if (screen.comparison) {
        const pair = inspection.comparison
        if (
          !screen.reply
          || destination.id !== screen.destinationId
          || !selectedQuestion
          || selectedQuestion.id !== screen.questionId
          || !isTelegramDailyComparison(screen.range, screen.last, screen.lastTime, pair)
          || pair.previous !== screen.comparison.previous
          || pair.previousTime !== screen.comparison.previousTime
        ) {
          return page(['Telegram', '', notices.changed, '', dismiss], 'telegramBack', null, 'changed')
        }
        const change = formatTelegramChange(pair.previous, screen.last)
        return confirm('Reply with comparison', 'Daily closes (UTC)', [
          new Date(pair.previousTime * 1000).toISOString().slice(0, 10) + ' · ' + formatTelegramClose(pair.previous) + ' GRAM',
          bucket.toISOString().slice(0, 10) + ' · ' + formatTelegramClose(screen.last) + ' GRAM',
          change ? 'Change ' + change + ' GRAM' : 'Unchanged',
          'Menu → Send or Cancel',
        ])
      }
      return confirm(screen.reply ? 'Reply with chart' : 'Send chart', screen.range, [
        'Last ' + formatPrice(screen.last),
        'Bucket ' + bucket.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        '',
        'Menu → Send or Cancel',
        'Double-tap to cancel',
      ])
    }

    case 'sending':
      return page(
        [
          screen.smartReply ? 'Sending reply…' : screen.comparison ? 'Sending comparison…' : 'Sending chart…',
          'To ' + singleLine(screen.destination),
          '',
          'Double-tap to return',
        ],
        null,
      )

    case 'result':
      return page(
        [
          results[screen.status],
          'To ' + singleLine(screen.destination),
          ...(screen.reason === 'missing_reply' ? ['Original message or topic was deleted.'] : []),
          ...(screen.status === 'unknown' || screen.status === 'pending'
            ? ['Use Check delivery status on your phone before sending again.']
            : []),
          '',
          dismiss,
        ],
        'telegramActivate',
      )

    case 'notice':
      return page(['Telegram', '', notices[screen.reason], '', dismiss], 'telegramActivate')
  }
}
