import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { connectGlasses } from '../src/glasses.ts'
import { createVoiceControl } from '../src/voiceControl.ts'
import { fitNativeText } from '../src/displayText.ts'
import { followUpAnswerPages, toolView } from '../src/toolDisplay.ts'
import { telegramPage } from '../src/telegramDisplay.ts'

const family = '👩‍👩‍👧‍👦'
const back = 'Double-tap to go back'
const assertFits = text => assert.ok(Buffer.byteLength(text) <= 999, `native content used ${Buffer.byteLength(text)} bytes`)

test('native fitting counts UTF-8 bytes for both the prefix and suffix', () => {
  assert.equal(fitNativeText('a'.repeat(999), 999), 'a'.repeat(999))
  assert.equal(fitNativeText('a'.repeat(1000), 999), 'a'.repeat(996) + '…')
  assert.equal(fitNativeText('漢'.repeat(900), 999), '漢'.repeat(332) + '…')
  assert.equal(fitNativeText('漢' + family + 'XYZ', 30, '終'), '漢終')
  assert.equal(fitNativeText('abc', 2, '…'), 'ab')
  assert.equal(fitNativeText(family, 0), '')
})

test('tool reading and action cursors keep every CJK and family grapheme and the final suffix', () => {
  const body = (family + '漢').repeat(173) + '読了'
  const page = { title: '調査', lines: [body], actions: [
    { id: 'first', label: '開く' }, { id: 'second', label: '確定', requiresConfirmation: true },
  ] }
  const { total } = toolView(page, 0)
  assert.ok(total > 4)
  let read = ''
  for (let i = 0; i < total; i++) {
    const { content, action, position } = toolView(page, i)
    assertFits(content)
    const rows = content.split('\n')
    assert.equal(rows.shift(), page.title)
    assert.equal(rows.pop(), back)
    assert.equal(rows.pop(), `Swipe   ${i + 1} / ${total}`)
    assert.equal(position, i)
    if (action) assert.equal(rows.pop(), i === total - 1 ? 'Menu → 確定' : 'Tap → 開く')
    for (const row of rows) assert.doesNotMatch(row.replaceAll(family, ''), /[👩👧👦\u200d]/u)
    if (i < total - 1) read += rows.join('')
  }
  assert.equal(read, body)
})

test('follow-up answer pages leave room for every recording phase and cancel', () => {
  const answer = family.repeat(130) + '回答終了'
  const pages = followUpAnswerPages('Ask Gifti', answer)
  assert.ok(pages.length > 2)
  let read = ''
  for (const [i, lines] of pages.entries()) {
    assert.equal(lines.at(-1), `Swipe to read · ${i + 1}/${pages.length}`)
    const body = lines.slice(1, -1)
    assert.ok(body.length <= 3)
    for (const row of body) assert.doesNotMatch(row.replaceAll(family, ''), /[👩👧👦\u200d]/u)
    read += body.join('')
    for (const phase of ['Opening glasses microphone…', 'Listening for your follow-up…\nPause or use Finish recording', 'Closing glasses microphone…']) {
      assertFits([...lines, phase, 'Double-tap to cancel'].join('\n'))
    }
  }
  assert.equal(read, answer)
})

test('native swipes read the entire follow-up while Finish recording stays available', async t => {
  const answer = family.repeat(130) + '完'
  const page = { key: 'gifti-recording', title: 'Ask Gifti', lines: [answer, 'Listening'], actions: [] }
  let caption, receive
  const show = layout => { caption = layout.textObject[0].content }
  globalThis.window = { EvenAppBridge: {
    ready: true, audioControl: async () => true,
    createStartUpPageContainer: async layout => { show(layout); return 0 },
    rebuildPageContainer: async layout => { show(layout); return true },
    textContainerUpgrade: async update => { caption = update.content; return true },
    onEvenHubEvent: listener => { receive = listener; return () => {} },
  } }
  t.after(() => { delete globalThis.window })
  const voice = createVoiceControl({ names: () => [], transcribe: t.mock.fn(), resolve: t.mock.fn() })
  const tools = { getActiveTool: () => 'gifti', getSnapshot: () => page, close() {} }
  const session = await connectGlasses({ current: () => ({ status: 'empty', section: 'explore' }), voice,
    getTools: () => tools, showDisplayError: failed => assert.equal(failed, false) })
  const abort = new AbortController()
  const capture = voice.controls.recordQuestion(abort.signal)
  t.after(async () => { abort.abort(); await Promise.allSettled([capture, session.stop()]) })
  await settle()
  const count = Number(caption.match(/Swipe to read · 1\/(\d+)/)?.[1])
  assert.ok(count > 2)
  let read = ''
  for (let i = 1; i <= count; i++) {
    assertFits(caption)
    const footer = `\nSwipe to read · ${i}/${count}\nListening for your follow-up…\nPause or use Finish recording\nDouble-tap to cancel`
    assert.ok(caption.startsWith('Ask Gifti\n') && caption.endsWith(footer))
    read += caption.slice('Ask Gifti\n'.length, -footer.length).replaceAll('\n', '')
    if (i < count) {
      receive({ sysEvent: { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } })
      await settle()
    }
  }
  assert.equal(read, answer)
})

test('a long question keeps its navigation and phone continuation inside the field', () => {
  const question = { id: 'q', sender: '漢'.repeat(160), chatLabel: family.repeat(40), text: family.repeat(200) }
  const state = { questions: [question] }
  const preview = telegramPage({ state, screen: { kind: 'questions', index: 0 } }).content
  const detail = telegramPage({ state, screen: { kind: 'question', question } }).content
  assertFits(preview)
  assertFits(detail)
  assert.ok(preview.endsWith('Swipe to browse · Tap to read\nDouble-tap to return'))
  assert.match(detail, /Tap to use for reply · Double-tap for Questions/)
  assert.ok(detail.endsWith(family + '…\nRead the full question on your phone.'))
  assert.doesNotMatch((preview + detail).replaceAll(family, ''), /[👩👧👦\u200d]/u)
})

test('browse retains swipe and Back when multilingual body and action labels overflow', () => {
  const page = { title: 'Browse', lines: Array(8).fill(family.repeat(43)), browse: { open: 'open', next: 'next' },
    actions: [{ id: 'open', label: '漢'.repeat(400) }] }
  const { content } = toolView(page, 0)
  assertFits(content)
  assert.match(content, /Tap →\s/)
  assert.ok(content.endsWith('Swipe to browse tasks\n' + back))
})

test('a delivery result preserves its status instruction and return control with a long destination', () => {
  const screen = { kind: 'result', status: 'unknown', destination: family.repeat(100) }
  const { content } = telegramPage({ screen })
  assertFits(content)
  assert.match(content, /Delivery unconfirmed\nTo (?:👩‍👩‍👧‍👦)+…\n/)
  assert.ok(content.endsWith('Use Check delivery status on your phone before sending again.\n\nTap or double-tap to return'))
})

test('an indivisible grapheme larger than the native field leaves its suffix readable', () => {
  const tooLarge = 'a' + '\u0301'.repeat(1000)
  const pages = followUpAnswerPages('Ask Gifti', tooLarge + '漢字')
  assert.equal(pages.flat().join('\n').includes('[Read on phone]\n漢字'), true)
  for (const lines of pages) assertFits(lines.join('\n'))
})
