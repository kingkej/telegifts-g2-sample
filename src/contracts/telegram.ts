import type { CompanionChartRange } from './companion.ts'

export type TelegramLinkKind = 'private' | 'group'
export type TelegramDeliveryStatus = 'sent' | 'failed' | 'unknown' | 'pending'
export type TelegramShareTarget = 'private' | 'reply' | 'comparison' | 'smart-draft'

export interface TelegramDailyComparison {
  previous: number
  previousTime: number
}

const daySeconds = 86_400
const fixedGram = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  minimumFractionDigits: 8,
  maximumFractionDigits: 8,
})

export const formatTelegramClose = (value: number) => fixedGram.format(value).replace(/\.?0+$/, '')

export function isTelegramDailyComparison(
  range: CompanionChartRange,
  last: number,
  lastTime: number,
  pair: TelegramDailyComparison | undefined,
  end = Date.now() / 1000,
): pair is TelegramDailyComparison {
  if (range !== '7d' || !pair || !Number.isSafeInteger(lastTime) || lastTime % daySeconds !== 0) return false
  const today = Math.floor(end / daySeconds) * daySeconds
  return (
    pair.previousTime > 0
    && pair.previousTime === lastTime - daySeconds
    && lastTime < today
    && pair.previousTime >= today - 7 * daySeconds
    && [last, pair.previous].every(
      value => Number.isFinite(value) && value > 0 && Number(formatTelegramClose(value)) === value,
    )
  )
}

export function formatTelegramChange(previous: number, last: number): string | null {
  const units = (price: number) => BigInt(fixedGram.format(price).replace('.', ''))
  const delta = units(last) - units(previous)
  if (delta === 0n) return null
  const digits = (delta < 0n ? -delta : delta).toString().padStart(9, '0')
  const magnitude = (digits.slice(0, -8) + '.' + digits.slice(-8)).replace(/\.?0+$/, '')
  return (delta < 0n ? '-' : '+') + magnitude
}

export interface TelegramDestination {
  id: string
  label: string
}

export interface TelegramLinkCandidate extends TelegramDestination {
  kind: TelegramLinkKind
  expiresAt: string
}

export interface TelegramQuestion {
  id: string
  sender: string
  text: string
  chatLabel: string
  topicName?: string
  topicId?: number
  collectionHint?: string
  askedAt?: string
}

export interface TelegramSmartDraft {
  id: string
  label: string
  text: string
  attachChart?: boolean
  attachSpreadChart?: boolean
  collection?: string
}

export interface TelegramDigestItem {
  id: string
  channel: string
  headline: string
  summary: string
  collection?: string
  floorGram?: number
  changePercent?: number
  timestamp: string
  kind: 'breakout' | 'watch-hit' | 'spread' | 'channel'
}

export interface TelegramState {
  enabled: boolean
  mode?: 'demo' | 'relay'
  privateChat: TelegramDestination | null
  group: TelegramDestination | null
  candidate: TelegramLinkCandidate | null
  questions: readonly TelegramQuestion[]
  digest?: readonly TelegramDigestItem[]
}

export type TelegramScreen =
  | { kind: 'idle' }
  | {
      kind: 'heads-up'
      alertId: string
      badge: string
      headline: string
      detail: string
      question?: TelegramQuestion
    }
  | { kind: 'questions'; index: number }
  | { kind: 'question'; question: TelegramQuestion }
  | {
      kind: 'compose'
      composeSessionId?: number
      question: TelegramQuestion
      destination: string
      destinationId: string
      drafts: readonly TelegramSmartDraft[]
      index: number
    }
  | {
      kind: 'digest'
      items: readonly TelegramDigestItem[]
      index: number
    }
  | {
      kind: 'confirm'
      destination: string
      collection: string
      range: CompanionChartRange
      last: number
      lastTime: number
      reply: boolean
      comparison?: TelegramDailyComparison
      approvedFrame?: Uint8Array
      smartText?: string
      destinationId?: string
      questionId?: string
    }
  | { kind: 'sending'; destination: string; comparison?: boolean; smartReply?: boolean }
  | {
      kind: 'result'
      requestId?: string
      seq?: number
      status: TelegramDeliveryStatus
      destination: string
      reason?: 'missing_reply'
    }
  | {
      kind: 'notice'
      reason: 'connect' | 'group' | 'question' | 'chart' | 'comparison' | 'unavailable' | 'changed' | 'empty'
    }

export interface CompanionTelegramSnapshot {
  state: TelegramState | null
  selectedQuestion: TelegramQuestion | null
  screen: TelegramScreen
}

export interface CompanionTelegramControl {
  getSnapshot(): CompanionTelegramSnapshot
  subscribe(listener: () => void): () => void
  openQuestions(): void
  openDigest?(): void
  openCompose?(question?: TelegramQuestion): boolean
  applyVoiceReply?(spokenText: string, expectedComposeId?: string): boolean
  step(direction: -1 | 1): void
  activate(): void
  back(): void
  share(target: TelegramShareTarget): boolean
  cancelDraft(): void
}
