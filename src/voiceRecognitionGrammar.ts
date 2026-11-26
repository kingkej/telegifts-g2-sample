import type { Decoder, DictEntry } from 'soundswallower'
import { collectionVoiceWords, toolPhrases } from './voiceCommands.ts'

// Out-of-grammar speech must have a path through the search, including before
// and after a command. SoundSwallower's FSG posterior alone cannot establish this.
const phones = 'AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH'.split(' ')
const phoneWords = phones.map(phone => 'tgphone' + phone.toLowerCase())

// Product names with missing or ambiguous US dictionary pronunciations.
const pronunciations = new Map<string, string[]>([
  ['pepe', ['P EH P EY', 'P EH P IY', 'P EY P EY']],
  ['durov', ['D UH R AA V', 'D UW R AO V']],
  ['durovs', ['D UH R AA V Z', 'D UW R AO V Z']],
  ['khabib', ['K AH B IY B']],
  ['papakha', ['P AH P AA K AH']],
  ['bling', ['B L IH NG']],
  ['binky', ['B IH NG K IY']],
  ['hypno', ['HH IH P N OW']],
  ['ramen', ['R AA M AH N']],
  ['sparkler', ['S P AA R K L ER']],
  ['posy', ['P OW Z IY']],
  ['lolpop', ['L AA L P AA P']],
  ['neko', ['N EH K OW']],
  ['dogg', ['D AO G']],
  ['agaric', ['AE G ER IH K']],
  ['swag', ['S W AE G']],
  ['ufc', ['Y UW EH F S IY']],
  ['xmas', ['K R IH S M AH S', 'EH K S M AH S']],
])
const digits = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

function possessive(phonesStr: string) {
  const last = phonesStr.split(' ').at(-1)!
  if (['S', 'Z', 'SH', 'ZH', 'CH', 'JH'].includes(last)) return phonesStr + ' IH Z'
  return phonesStr + (['P', 'T', 'K', 'F', 'TH'].includes(last) ? ' S' : ' Z')
}

function namePronunciations(words: readonly string[], decoder: Decoder): string[] {
  let variants = ['']
  for (const word of words) {
    // Only internal numeric aliases enter JSGF. Skip words with no pronunciation.
    if (!/^(?:[a-z]+(?:'[a-z]+)?|[0-9])$/.test(word)) return []
    const stem = word.replace(/'s$/, '')
    const base = digits[Number(stem)] ?? stem
    let prons = pronunciations.get(base)
    if (!prons) {
      const known = decoder.lookup_word(base)
      if (!known) return []
      prons = [known]
      for (let i = 2; ; i++) {
        const alternate = decoder.lookup_word(base + '(' + i + ')')
        if (!alternate) break
        prons.push(alternate)
      }
    }
    variants = variants
      .flatMap(prefix =>
        prons.map(p => {
          const spoken = word.endsWith("'s") ? possessive(p) : p
          return prefix ? prefix + ' ' + spoken : spoken
        }),
      )
      .slice(0, 12)
  }
  return variants
}

export function commandGrammar(decoder: Decoder, names: readonly string[]) {
  const entries: DictEntry[] = phones.map(phone => ['tgphone' + phone.toLowerCase(), phone])
  if (!decoder.lookup_word('gifti')) entries.push(['gifti', 'G IH F T IY'])
  if (!decoder.lookup_word('inbox')) entries.push(['inbox', 'IH N B AA K S'])
  if (!decoder.lookup_word('pending')) entries.push(['pending', 'P EH N D IH NG'])
  if (!decoder.lookup_word('utc')) entries.push(['utc', 'Y UW T IY S IY'])
  if (!decoder.lookup_word('arbitrage')) entries.push(['arbitrage', 'AA R B AH T R AA ZH'])
  if (!decoder.lookup_word('whale')) entries.push(['whale', 'W EY L'])
  if (!decoder.lookup_word('rarity')) entries.push(['rarity', 'R EH R AH T IY'])
  if (!decoder.lookup_word('tiers')) entries.push(['tiers', 'T IH R Z'])
  if (!decoder.lookup_word('momentum')) entries.push(['momentum', 'M OW M EH N T AH M'])
  if (!decoder.lookup_word('greed')) entries.push(['greed', 'G R IY D'])
  const sounds = new Map<string, { word: string; text: string }>()
  const ambiguous = new Set<string>()
  const targets = new Set<string>()
  const owners = new Set<string>()
  function addName(pron: string, text: string, group: Set<string>) {
    let entry = sounds.get(pron)
    if (!entry) {
      entry = { word: 'collection' + sounds.size, text }
      sounds.set(pron, entry)
      entries.push([entry.word, pron])
    } else if (entry.text !== text) {
      // A second pronunciation must not let either spelling win a homophone tie.
      ambiguous.add(entry.text)
      ambiguous.add(text)
    }
    group.add(entry.word)
  }

  const catalog = [...new Set(names)].map(name => ({ name, words: collectionVoiceWords(name).split(' ') }))
  const fullNames = new Set(catalog.map(({ words }) => words.join(' ')))
  const fragments = new Map<string, number>()
  for (const { name, words } of catalog) {
    for (const pron of namePronunciations(words, decoder)) {
      addName(pron, name, targets)
      addName(possessive(pron), name + "'s", owners)
    }
    const parts = new Set<string>()
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        if (end - start < words.length) parts.add(words.slice(start, end).join(' '))
      }
    }
    for (const part of parts) fragments.set(part, (fragments.get(part) ?? 0) + 1)
  }
  for (const [part, count] of fragments) {
    if (fullNames.has(part) || /^(a|an|the|of|and|in|to)$/.test(part)) continue
    for (const pron of namePronunciations(part.split(' '), decoder)) {
      // Also let unique fragments compete acoustically, but never expand one
      // into a full collection. Shared fragments reach the resolver as spoken.
      addName(pron, part, targets)
      if (count < 2) ambiguous.add(part)
    }
  }
  decoder.add_words(...entries)
  const dictionary = new Map([...sounds.values()].map(({ word, text }) => [word, ambiguous.has(text) ? null : text]))
  // The phone loop is also a competitor inside a name or chart period. Thus an
  // unknown collection or unsupported number need not be forced onto a known one.
  const target = ['<other>', ...targets].join(' | ')
  const owner = ['<target>', ...owners].join(' | ')
  const grammar = `#JSGF V1.0;
grammar telegifts;
public <utterance> = [<other> | never | do not | don't] [please] <command> [please] [<other>] | <other>;
<other> = (${phoneWords.join(' | ')})+;
<target> = ${target};
<owner> = ${owner};
<command> = (open | show [me] | view) [the] (<target> [collection] | collection <target> | <view> [for <target>] | <owner> <view>)
          | (show | open) [my | the] (favorites | favorite | inbox | questions | pending)
          | (save | send | share | sell) (this | that | the) (gift | list | lift | shift)
          | (send | save | share) (this | that) (chart | cart) to (my | your | the) (telegram | telegraph)
          | (reply | replay) (with | without) (chart | cart | comparison)
          | draft reply | smart reply | compare markets | compare venues
          | [select] (floor [chart] | venue spread | daily [utc] close | checking listings) [draft]
          | next draft | previous draft | send reply
          | open digest | channel digest | show [channel] digest
          | open spread radar | venue spread radar | watch price
          | open research | open watch list | record floor | add to watch list
          | open market note | what changed [in my favorites] | watch asking price | open gift chat | ask gifti
          | (arbitrage | whale risk | supply health | rare models | rare tiers | floor momentum) [for <target>]
          | go (back | pack | bag | bad);
<view> = [<range>] [floor [price] | price | flour | weather] (chart | cart) | [three (d | dimensional)] preview | [venue | market] spread;
<range> = (twenty four | <number>) (hour | hours) | (one | seven | thirty | <number>) (day | days)
        | [one] (week | month) | daily | weekly | monthly;
<number> = two | three | four | five | six | eight | nine | ten | eleven | twelve | thirteen | fourteen
         | fifteen | sixteen | seventeen | eighteen | nineteen | twenty | sixty | <other>;`
  decoder.set_grammar(grammar)

  // FSG search can also end on a partial path. Accept complete supported forms
  // only, and keep catalog spelling when rendering the transcript for the caller.
  const range = '(?:(?:one|seven|thirty) days?|twenty four hours?|(?:one )?(?:week|month)|daily|weekly|monthly)'
  const view = `(?:(?:${range} )?(?:(?:floor(?: price)?|price) )?chart|(?:three (?:d|dimensional) )?preview|(?:(?:venue|market) )?spread)`
  const collection = 'collection[0-9]+'
  const validView = new RegExp(`^(?:open|show(?: me)?|view) (?:the )?(?:(?:${collection} )?${view}|${view} for ${collection})$`)
  const open = new RegExp(`^(?:open|show(?: me)?|view) (?:the )?(?:collection )?(${collection})(?: collection)?$`)
  const giftiTopic = new RegExp(`^(arbitrage|whale risk|supply health|rare models|rare tiers|floor momentum)(?: for (${collection}))?$`)
  return (raw: string): string | null => {
    const text = raw.replace(/^please /, '').replace(/ please$/, '')
    const toolPhrase = text.replace(/\bwatch list\b/g, 'watchlist')
    if (Object.hasOwn(toolPhrases, toolPhrase)) return toolPhrase
    const topicMatch = giftiTopic.exec(text)
    if (topicMatch) {
      if (!topicMatch[2]) return topicMatch[1]!
      if (!targets.has(topicMatch[2])) return null
      const matchedCol = dictionary.get(topicMatch[2])
      return matchedCol ? `${topicMatch[1]} for ${matchedCol}` : null
    }
    if (
      /^(?:go back|save this gift|send this chart to my telegram|reply with (?:chart|comparison)|draft reply|smart reply|compare (?:markets|venues)|(?:select )?(?:floor(?: chart)?|venue spread|daily(?: utc)? close|checking listings)(?: draft)?|next draft|previous draft|send reply|show (?:channel )?digest|(?:show|open) (?:(?:my|the) )?(?:favorites|inbox|questions|pending))$/.test(
        text,
      )
    )
      return text
    const card = open.exec(text)
    if (card && targets.has(card[1]!)) {
      const name = dictionary.get(card[1]!)
      return name ? 'open ' + name : null
    }
    if (!validView.test(text)) return null
    const words = text.split(' ')
    if (words.some(word => dictionary.has(word) && !dictionary.get(word))) return null
    return words.map(word => dictionary.get(word) ?? word).join(' ')
  }
}

/**
 * Grammar used strictly for `AudioSpeakerRole.Other` IRL meetup lookup so natural
 * conversational mentions (e.g. "What is Astral Shard trading at?") spot unambiguous
 * catalog collection names without relaxing wearer command strictness.
 */
export function overheardCollectionGrammar(decoder: Decoder, names: readonly string[]) {
  const entries: DictEntry[] = phones.map(phone => ['tgphone' + phone.toLowerCase(), phone])
  const sounds = new Map<string, { word: string; text: string }>()
  const ambiguous = new Set<string>()
  const targets = new Set<string>()

  for (const rawName of new Set(names)) {
    const words = collectionVoiceWords(rawName).split(' ')
    if (rawName.replace(/[^A-Za-z0-9]/g, '').length < 4) continue
    for (const pron of namePronunciations(words, decoder)) {
      let entry = sounds.get(pron)
      if (!entry) {
        entry = { word: 'collection' + sounds.size, text: rawName }
        sounds.set(pron, entry)
        entries.push([entry.word, pron])
      } else if (entry.text !== rawName) {
        ambiguous.add(entry.text)
        ambiguous.add(rawName)
      }
      targets.add(entry.word)
    }
  }

  decoder.add_words(...entries)
  const dictionary = new Map([...sounds.values()].map(({ word, text }) => [word, ambiguous.has(text) ? null : text]))
  const targetRule = ['<other>', ...targets].join(' | ')
  const grammar = `#JSGF V1.0;
grammar telegifts_overheard;
public <utterance> = [<other>] <target> [<other>] | <other>;
<other> = (${phoneWords.join(' | ')})+;
<target> = ${targetRule};`
  decoder.set_grammar(grammar)

  return (raw: string): string | null => {
    const tokens = raw.split(/\s+/).filter(Boolean)
    const collectionTokens = tokens.filter(t => /^collection\d+$/.test(t))
    if (collectionTokens.length !== 1) return null
    const token = collectionTokens[0]!
    if (!targets.has(token)) return null
    return dictionary.get(token) ?? null
  }
}

// With the command word order removed, each word must still beat freely
// ordered speech sounds and close alternatives over the entire utterance.
export function verificationGrammar(hypothesis: string) {
  const alternatives: Record<string, readonly string[]> = {
    save: ['shave', 'safe', 'shape'],
    back: ['bag', 'pack', 'black', 'bad'],
    chart: ['cart', 'forecast'],
    thirty: ['thirteen'],
    seven: ['seventeen'],
    four: ['fourteen'],
  }
  const words = new Set(phoneWords)
  for (const word of hypothesis.split(' ')) {
    words.add(word)
    for (const alternative of alternatives[word] ?? []) words.add(alternative)
  }
  return `#JSGF V1.0; grammar verify; public <speech> = (${[...words].join(' | ')})+;`
}
