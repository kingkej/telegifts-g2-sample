import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveVoiceCommand } from '../src/voiceCommands.ts'

const names = ['Plush Pepe', 'Toy Bear', 'B-Day Candle', "Khabib's Papakha"]

test('English requests bind the view, target and range without executing during recognition', () => {
  for (const [text, expected] of [
    ['Please show Plush Pepe’s seven-day floor chart.', { kind: 'chart', name: 'Plush Pepe', range: '7d' }],
    ['show plush pepes seven day floor chart', { kind: 'chart', name: 'Plush Pepe', range: '7d' }],
    ['Show the floor chart for B Day Candle for the past 24 hours', { kind: 'chart', name: 'B-Day Candle', range: '24h' }],
    ['Show me the thirty day chart', { kind: 'chart', name: null, range: '30d' }],
    ['Show this gift’s 7d chart', { kind: 'chart', name: null, range: '7d' }],
    ['Show the floor chart', { kind: 'chart', name: null }],
    ['Could you show the 3D preview, please?', { kind: 'preview', name: null }],
    ['show the three d preview of toy bear', { kind: 'preview', name: 'Toy Bear' }],
    ['Show Toy Bear’s preview', { kind: 'preview', name: 'Toy Bear' }],
    ['Open the card for khabibs papakha', { kind: 'card', name: "Khabib's Papakha" }],
    ['Open Plush Pepe', { kind: 'card', name: 'Plush Pepe' }],
    ['Open the Plush Pepe collection', { kind: 'card', name: 'Plush Pepe' }],
    ['Open this gift', { kind: 'card', name: null }],
    ['Save this gift!', { kind: 'save', name: null }],
    ['Send this chart to my Telegram.', { kind: 'share', target: 'private' }],
    ['Reply with chart', { kind: 'share', target: 'reply' }],
    ['Reply with comparison', { kind: 'share', target: 'comparison' }],
    ['Add this collection to my favourites', { kind: 'save', name: null }],
    ['Show Favorites', { kind: 'favorites' }],
    ['Go back', { kind: 'back' }],
  ]) {
    const calls = []
    const result = resolveVoiceCommand(text, names, 'Toy Bear', command => { calls.push(command); return true })
    assert.equal(result.kind, 'action', text)
    assert.equal(result.confirm, expected.kind === 'save', text)
    assert.deepEqual(calls, [], text)
    if (expected.kind === 'save') assert.match(result.label, /Toy Bear/)
    assert.equal(result.run(), true)
    assert.deepEqual(calls, [expected], text)
  }
})

test('identical spellings deduplicate, distinct spoken-name collisions retain their exact catalog identities', () => {
  const catalog = ['B-Day Candle', 'B Day Candle', 'B-Day Candle', 'Birthday Candle']
  const calls = []
  const resolve = text => resolveVoiceCommand(text, catalog, 'Other', command => { calls.push(command); return false })
  const result = resolve('Show the 30d chart for B Day Candle')
  assert.equal(result.kind, 'choices')
  assert.deepEqual(result.labels, ['B-Day Candle', 'B Day Candle'])
  const first = result.choose(0), second = result.choose(1)
  assert.deepEqual(result.choose(-1), { kind: 'unknown' })
  assert.deepEqual(result.choose(2), { kind: 'unknown' })
  assert.deepEqual(result.choose(0.5), { kind: 'unknown' })
  const otherRequest = resolve('Open Birthday Candle')
  assert.deepEqual(calls, [])
  assert.equal(otherRequest.run(), false)
  assert.equal(second.run(), false)
  assert.equal(first.run(), false)
  assert.deepEqual(calls, [
    { kind: 'card', name: 'Birthday Candle' },
    { kind: 'chart', name: 'B Day Candle', range: '30d' },
    { kind: 'chart', name: 'B-Day Candle', range: '30d' },
  ])
  assert.deepEqual(resolve('Show the Candle card').labels, ['B-Day Candle', 'B Day Candle', 'Birthday Candle'])
  assert.deepEqual(resolve('Open Birthday').labels, ['Birthday Candle'])
  assert.deepEqual(resolveVoiceCommand("show Plush Pepe's chart", ['Plush Pepe', 'Plush Pepes'], null, () => false).labels,
    ['Plush Pepe', 'Plush Pepes'])
  const card = resolveVoiceCommand('open Birthday Card', ['Birthday Card', 'Birthday'], null, command => command.name === 'Birthday Card')
  assert.equal(card.run(), true)
})

test('a full gift name takes precedence over a trailing view noun while explicit chart requests keep their target', () => {
  const catalog = ['Moon', 'Moon Chart', 'Moon Preview', 'Toy Bear']
  for (const [text, expected] of [
    ['open Moon Chart', { kind: 'card', name: 'Moon Chart' }],
    ['open Moon Preview', { kind: 'card', name: 'Moon Preview' }],
    ['show chart for Moon', { kind: 'chart', name: 'Moon' }],
    ['show chart for Moon Chart', { kind: 'chart', name: 'Moon Chart' }],
    ['show Moon chart for the past seven days', { kind: 'chart', name: 'Moon', range: '7d' }],
    ['open Toy Bear chart', { kind: 'chart', name: 'Toy Bear' }],
  ]) {
    const calls = []
    const result = resolveVoiceCommand(text, catalog, null, command => { calls.push(command); return true })
    assert.equal(result.kind, 'action', text)
    assert.ok(result.run())
    assert.deepEqual(calls, [expected], text)
  }
})

test('irrelevant speech, contradictions, unsupported ranges and misspellings never execute', () => {
  const resolve = (text, current = 'Plush Pepe') => resolveVoiceCommand(text, names, current, () => assert.fail(text))
  for (const text of [
    '', '   ', 'Plush Pepe', 'I heard someone say save this gift', 'do not save this gift', 'save this gift and go back',
    'Could you buy Plush Pepe?', 'show the price of Toy Bear', 'show the floor chart for Missing Gift',
    'show the 90 day chart', 'show the 7 day preview', 'show the 7d chart for the last thirty days',
    'open toy beer', 'open lus', 'open Toy Bear and Plush Pepe', 'go back tomorrow', 'show my calendar',
    "don't send this chart to my Telegram", 'send this chart to your Telegram', 'send this chart', 'send this gift',
    'save this chart to my Telegram', 'never reply with chart', 'reply with chart tomorrow', 'replay with chart',
    'open gift chat and tell me the floor price', 'ask gift chat how much this costs',
    'reply without chart', 'reply with cart', 'send this chart to my Telegram or reply with chart',
  ]) assert.deepEqual(resolve(text), { kind: 'unknown' }, text)
  for (const text of ['open this gift', 'show the floor chart', 'show the 3D preview', 'save this gift',
    'send this chart to my Telegram', 'reply with chart']) {
    assert.equal(resolve(text, null).kind, 'unknown', text)
  }
  assert.equal(resolve('Open Plush Pepe', null).kind, 'action')
  assert.equal(resolve('Show Favorites', null).kind, 'action')
})

test('tool phrases open the intended workflow or its preview without committing a provider write', () => {
  const cases = [ ['open research', 'research'], ['open watchlist', 'watchlist'], ['record floor', 'record-floor'],
    ['add to watchlist', 'add-to-watchlist'], ['what changed', 'summary'], ['watch asking price', 'threshold'], ['open market note', 'market-note'],
    ['open gift chat', 'gifti'] ]
  for (const [phrase, target] of cases) {
    const dispatched = []
    const result = resolveVoiceCommand(phrase, [], 'Toy Bear', command => { dispatched.push(command); return true })
    assert.equal(result.kind, 'action', phrase)
    assert.equal(result.run(AbortSignal.abort()), false)
    assert.deepEqual(dispatched, [])
    assert.equal(result.run(), true)
    assert.deepEqual(dispatched, [{ kind: 'tool', target }])
  }
})

test('catalog camel-case words participate in the same ambiguous voice fragment', () => {
  let selected
  const result = resolveVoiceCommand('open candle', ['LoveCandle', 'Eternal Candle'], null,
    command => { selected = command.name; return true })
  assert.equal(result.kind, 'choices')
  assert.deepEqual([...result.labels].sort(), ['Eternal Candle', 'LoveCandle'])
  assert.ok(result.choose(result.labels.indexOf('LoveCandle')).run())
  assert.equal(selected, 'LoveCandle')
})
