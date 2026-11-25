import type { CompanionChartRange } from './contracts/companion.ts'
import type { CompanionToolName } from './contracts/tools.ts'
import type { TelegramShareTarget } from './contracts/telegram.ts'

export const toolPhrases = {
  'open research': 'research',
  'open watchlist': 'watchlist',
  'open market note': 'market-note',
  'what changed': 'summary',
  'watch asking price': 'threshold',
  'watch price': 'threshold',
  'open gift chat': 'gifti',
  'ask gifti': 'talk-gifti',
  'what changed in my favorites': 'favorite-movers',
  'open digest': 'digest',
  'channel digest': 'digest',
  'open spread radar': 'spread-radar',
  'venue spread radar': 'spread-radar',
  'record floor': 'record-floor',
  'add to watchlist': 'add-to-watchlist',
} as const satisfies Record<string, CompanionToolName | 'talk-gifti' | 'record-floor' | 'add-to-watchlist'>

export type VoiceResolution =
  | { kind: 'action'; label: string; confirm: boolean; run(signal?: AbortSignal): boolean }
  | { kind: 'choices'; labels: readonly string[]; choose(index: number): VoiceResolution }
  | { kind: 'unknown' }

type View = 'card' | 'chart' | 'preview' | 'spread'
/** A null name refers to the gift that was current when the request was resolved. */
export type VoiceCommand =
  | { kind: View | 'save'; name: string | null; range?: CompanionChartRange }
  | { kind: 'share'; target: TelegramShareTarget }
  | { kind: 'telegram-inbox' }
  | { kind: 'telegram-digest' }
  | { kind: 'tool'; target: (typeof toolPhrases)[keyof typeof toolPhrases] }
  | { kind: 'favorites' }
  | { kind: 'back' }

const unknown = { kind: 'unknown' } as const
const periods: ReadonlyArray<[CompanionChartRange, RegExp]> = [
  ['24h', /24 ?h|(?:24|twenty four) hours?|(?:one|1) day|daily/],
  ['7d', /7 ?d|(?:7|seven) days?|(?:one |1 )?week|weekly/],
  ['30d', /30 ?d|(?:30|thirty) days?|(?:one |1 )?month|monthly/],
]
const period = periods.map(([, pattern]) => pattern.source).join('|')
const view =
  '(?:(?:floor(?: price)?|price) )?chart|(?:(?:3 ?d|three d|three dimensional) )?preview|(?:(?:venue|market|marketplace) )?spread|(?:(?:gift|collection) )?card|collection'
const viewFirst = new RegExp(`^(?:the |a )?(?:(${period}) )?(${view})(?: (?:for|of) (.+))?$`)
const nameFirst = new RegExp(`^(.+?) (?:(${period}) )?(${view})$`)
const rangeSuffix = new RegExp(` (?:for|over|in) (?:the )?(?:last |past )?(${period})$`)

function words(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{Mark}/gu, '')
    .replace(/[’‘']/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^\p{Letter}\p{Number}']+/gu, ' ')
    .trim()
}

export function collectionVoiceWords(text: string): string {
  return words(text.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2'))
}

function nameWords(text: string): string {
  return collectionVoiceWords(text).replace(/'/g, '')
}

function matchNames(phrase: string, names: readonly string[], possessive: boolean) {
  const target = nameWords(phrase)
  const key = target.replaceAll(' ', '')
  // Speech recognition can render "Pepe's" as "pepes" or "Pepe s".
  const exact: string[] = [],
    fragments: string[] = []
  const fragment = nameWords(possessive ? phrase.replace(/(?:'s| s)$/, '') : phrase)
  for (const name of new Set(names)) {
    const spoken = nameWords(name)
    if (!spoken) continue
    const catalogKey = spoken.replaceAll(' ', '')
    if (catalogKey === key || (possessive && catalogKey + 's' === key)) exact.push(name)
    else if (fragment && !/^(?:a|the|my)$/.test(fragment) && (' ' + spoken + ' ').includes(' ' + fragment + ' '))
      fragments.push(name)
  }
  return exact.length ? { names: exact, exact: true } : { names: fragments, exact: false }
}

/** Resolving and choosing only bind an intent. The caller dispatches it through run(). */
export function resolveVoiceCommand(
  text: string,
  names: readonly string[],
  currentName: string | null,
  dispatch: (command: VoiceCommand, signal?: AbortSignal) => boolean,
): VoiceResolution {
  const speech = words(text)
    .replace(/^(?:please )?(?:(?:can|could|would) you )?(?:please )?/, '')
    .replace(/ please$/, '')
  function action(command: VoiceCommand, label: string): VoiceResolution {
    return { kind: 'action', label, confirm: command.kind === 'save', run: signal => !signal?.aborted && dispatch(command, signal) }
  }
  if (/^(?:go )?back$/.test(speech)) return action({ kind: 'back' }, 'Go back')
  if (/^(?:open|show) (?:(?:the|my) )?(?:inbox|questions)$/.test(speech)) {
    return action({ kind: 'telegram-inbox' }, 'Open Questions')
  }
  if (/^show (?:(?:the|my) )?(?:channel )?digest$/.test(speech)) {
    return action({ kind: 'telegram-digest' }, 'Open Channel digest')
  }
  if (speech === 'draft reply' || speech === 'smart reply') {
    return action({ kind: 'share', target: 'smart-draft' }, 'Draft smart reply')
  }
  if (speech === 'compare markets' || speech === 'compare venues') {
    return currentName ? action({ kind: 'spread', name: null }, currentName + ' venue spread') : unknown
  }
  const phrase = speech.replace(/\bwatch list\b/g, 'watchlist')
  if (Object.hasOwn(toolPhrases, phrase)) {
    return action(
      { kind: 'tool', target: toolPhrases[phrase as keyof typeof toolPhrases] },
      phrase[0]!.toUpperCase() + phrase.slice(1),
    )
  }
  if (speech === 'send this chart to my telegram' || speech === 'reply with chart' || speech === 'reply with comparison') {
    if (!currentName) return unknown
    const target = speech === 'reply with chart' ? 'reply' : speech === 'reply with comparison' ? 'comparison' : 'private'
    // share() opens the shared destination preview. Only that preview can commit a send.
    return action(
      { kind: 'share', target },
      target === 'private' ? 'Send this chart to my Telegram' : 'Reply with ' + (target === 'reply' ? 'chart' : 'comparison'),
    )
  }
  if (/^(?:(?:show|open|go to) (?:my |the )?)?favou?rites$/.test(speech)) {
    return action({ kind: 'favorites' }, 'Show Favorites')
  }
  if (
    /^(?:save (?:this|this gift|this collection|it)(?: to (?:my )?favou?rites)?|add (?:this gift|this collection|it) to (?:my )?favou?rites)$/.test(
      speech,
    )
  ) {
    return currentName ? action({ kind: 'save', name: null }, 'Save ' + currentName) : unknown
  }

  const request = /^(?:open|show(?: me)?|view) (.+)$/.exec(speech)
  if (!request) return unknown
  const subject = request[1]!
  const suffix = rangeSuffix.exec(subject)
  const body = suffix ? subject.slice(0, suffix.index) : subject
  const first = viewFirst.exec(body)
  // "Moon Chart" can be a collection name. An explicit view or range still describes a command.
  const fullName = first || suffix ? null : matchNames(body, names, false)
  const last = first || fullName?.exact ? null : nameFirst.exec(body)
  const noun = first?.[2] ?? last?.[3] ?? 'card'
  const kind: View = noun.endsWith('chart')
    ? 'chart'
    : noun.endsWith('preview')
      ? 'preview'
      : noun.endsWith('spread')
        ? 'spread'
        : 'card'
  const prefixRange = first?.[1] ?? last?.[2]
  const spokenRange = prefixRange ?? suffix?.[1]
  if (spokenRange && (kind !== 'chart' || (prefixRange && suffix))) return unknown
  const range = spokenRange ? periods.find(([, pattern]) => pattern.test(spokenRange))?.[0] : undefined
  const target = first ? first[3] : last ? last[1] : body

  function collectionAction(name: string | null): VoiceResolution {
    const label = name ?? currentName
    if (!label) return unknown
    const title =
      kind === 'card'
        ? 'Open ' + label
        : kind === 'preview'
          ? label + ' 3D preview'
          : kind === 'spread'
            ? label + ' venue spread'
            : label + (range ? ' ' + range : '') + ' floor chart'
    return action(range ? { kind, name, range } : { kind, name }, title)
  }
  if (
    !target
    || /^(?:it|its|this|this one|(?:the )?(?:this|current|selected) (?:gift|card|collection)(?:'s)?)$/.test(target)
  ) {
    return collectionAction(null)
  }

  let matches = !last && fullName ? fullName : matchNames(target, names, !!last)
  if (!matches.exact && target.startsWith('the ')) {
    const withoutArticle = matchNames(target.slice(4), names, !!last)
    if (withoutArticle.names.length) matches = withoutArticle
  }
  if (!matches.names.length) return unknown
  if (matches.exact && matches.names.length === 1) return collectionAction(matches.names[0]!)
  // A whole-word fragment can suggest choices but never dispatches a partial name.
  const candidates = Object.freeze(matches.names)
  return {
    kind: 'choices',
    labels: candidates,
    choose(index) {
      const name = Number.isInteger(index) ? candidates[index] : undefined
      return name === undefined ? unknown : collectionAction(name)
    },
  }
}
