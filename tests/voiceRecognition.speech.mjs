// Run with npm run test:voice:speech on macOS. Uses the phone project's Playwright
// and its headless Chromium. CHROMIUM_EXECUTABLE_PATH can select an existing binary.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { resolveVoiceCommand } from '../src/voiceCommands.ts'
import { exerciseTelegramApp } from './fixtures/telegramApp.mjs'

function runSpeechCommand(command, args) {
  execFileSync(command, args, { timeout: 10_000, killSignal: 'SIGKILL' })
}

async function synthesize(directory, phrase, voice = 'Samantha') {
  const aiff = join(directory, 'speech.aiff')
  const wav = join(directory, 'speech.wav')
  runSpeechCommand('say', ['-v', voice, '-o', aiff, phrase])
  runSpeechCommand('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav])
  return readPcm(wav)
}

async function readPcm(wav) {
  const bytes = await readFile(wav)
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  let pcmFormat = false
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', pos, pos + 4)
    const length = bytes.readUInt32LE(pos + 4)
    pos += 8
    assert.ok(pos + length <= bytes.length)
    if (tag === 'fmt ') {
      assert.deepEqual([bytes.readUInt16LE(pos), bytes.readUInt16LE(pos + 2),
        bytes.readUInt32LE(pos + 4), bytes.readUInt16LE(pos + 14)], [1, 1, 16000, 16])
      pcmFormat = true
    }
    if (tag === 'data') {
      assert.ok(pcmFormat && length > 3200, 'speech synthesis must produce actual samples')
      return bytes.subarray(pos, pos + length)
    }
    pos += length + length % 2
  }
  assert.fail('Missing WAVE audio')
}

const dist = process.env.TELEGIFTS_G2_DIST ? pathToFileURL(resolve(process.env.TELEGIFTS_G2_DIST) + '/') : new URL('../dist/', import.meta.url)
const telegramPhrases = [['Send this chart to my Telegram', 'private'], ['Reply with chart', 'reply']]
const recordedCommand = async (directory, spoken) => Buffer.concat([await synthesize(directory, spoken), Buffer.alloc(16000 * 2 * 0.9)])

async function speechHost(t) {
  const directory = await mkdtemp(join(tmpdir(), 'telegifts-speech-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const req = createRequire(new URL('../package.json', import.meta.url))
  const { chromium } = req('@playwright/test')
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH })
  t.after(() => browser.close())
  return { directory, browser }
}

test('packaged offline worker recognizes speech, rejects noncommands and terminates on abort', { timeout: 120_000 }, async t => {
  const { directory, browser } = await speechHost(t)
  const assets = new URL('assets/', dist)
  const files = await readdir(assets)
  const entry = files.find(name => /^voiceRecognition-[\w-]+\.js$/.test(name))
  assert.ok(entry, 'build the normal G2 production bundle first')
  const notice = await readFile(new URL('licenses/voice-recognition.txt', dist), 'utf8')
  for (const author of ['Carnegie Mellon', 'WebRTC', 'Alpha Cephei']) assert.ok(notice.includes(author))

  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' })
  const origin = 'https://telegifts.invalid'
  const unexpected = []
  const fetched = new Set()
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin && route.request().method() === 'GET') {
      if (url.pathname === '/nested/check') return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      const path = url.pathname.slice('/nested/assets/'.length)
      if (url.pathname.startsWith('/nested/assets/') && files.includes(path)) {
        fetched.add(path)
        const contentType = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
        return route.fulfill({ body: await readFile(new URL(path, assets)), contentType })
      }
    }
    unexpected.push(route.request().method() + ' ' + url)
    return route.abort()
  })

  const page = await context.newPage()
  await page.goto(origin + '/nested/check')
  await page.evaluate(async url => {
    window.transcribe = (await import(url)).transcribeVoice
    window.workerStarts = window.workerStops = 0
    window.terminatedWorkers = new WeakSet()
    window.Worker = class extends Worker {
      constructor(...args) { super(...args); window.workerStarts++ }
      postMessage(...args) {
        const posted = window.observeAbortRequest
        if (posted) {
          window.observeAbortRequest = undefined
          this.addEventListener('message', event => event.stopImmediatePropagation(), { capture: true })
        }
        super.postMessage(...args)
        posted?.(this)
      }
      terminate() { window.terminatedWorkers.add(this); window.workerStops++; super.terminate() }
    }
  }, './assets/' + entry)
  assert.deepEqual([...fetched], [entry], 'decoder and model must load only when called')
  const names = ['Plush Pepe', 'Velvet Rose', 'Durov’s Cap', 'Candy Cane', 'Candy Heart', 'Night Light', 'Knight Light']
  const decode = (bytes, catalog = names) => page.evaluate(async ([base64, collectionNames]) => {
    const pcm = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const result = await window.transcribe(pcm, collectionNames, new AbortController().signal)
    if (!pcm.byteLength) throw new Error('Caller buffer detached')
    return result
  }, [bytes.toString('base64'), catalog])

  // Replay the production capture on a cold worker. Recreate its exact voice,
  // rate and PCM format when an original recording hasn't been supplied.
  const catalog = JSON.parse(await readFile(new URL('./fixtures/voiceRecognition.catalog.json', import.meta.url), 'utf8'))
  assert.equal(catalog.length, 124)
  const chartFile = process.env.TELEGIFTS_CHART_WAV ?? join(directory, 'startup-chart.wav')
  if (!process.env.TELEGIFTS_CHART_WAV) {
    runSpeechCommand('say', ['-v', 'Samantha', '-r', '158', '--file-format=WAVE', '--data-format=LEI16@16000',
      '-o', chartFile, 'Show Plush Pepe’s seven day floor chart.'])
  }
  const chartPcm = Buffer.concat([await readPcm(chartFile), Buffer.alloc(16000 * 2 * 0.9)])
  const chartText = await decode(chartPcm, catalog)
  assert.ok(chartText)
  let chartCommand
  const chart = resolveVoiceCommand(chartText, catalog, null, command => { chartCommand = command; return true })
  assert.equal(chart.kind, 'action', chartText)
  chart.run()
  assert.deepEqual(chartCommand, { kind: 'chart', name: 'Plush Pepe', range: '7d' })
  const gifti = await decode(await recordedCommand(directory, 'Open gift chat'), catalog)
  assert.equal(gifti, 'open gift chat')
  const shortcut = resolveVoiceCommand(gifti, catalog, null, command => {
    assert.deepEqual(command, { kind: 'tool', target: 'gifti' })
    return true
  })
  assert.equal(shortcut.kind, 'action')
  assert.equal(shortcut.run(), true)
  for (const [spoken, target] of telegramPhrases) {
    const pcm = await recordedCommand(directory, spoken)
    const transcript = await decode(pcm, catalog)
    assert.equal(transcript, spoken.toLowerCase(), spoken)
    let command
    const draft = resolveVoiceCommand(transcript, catalog, 'Plush Pepe', c => { command = c; return true })
    assert.equal(draft.kind, 'action')
    assert.equal(draft.confirm, false)
    draft.run()
    assert.deepEqual(command, { kind: 'share', target })
  }
  assert.equal(await decode(await synthesize(directory, 'switch off the radio', 'Karen'), catalog), null)

  const cases = [
    ['open Plush Pepe', { kind: 'card', name: 'Plush Pepe' }],
    ['open Velvet Rose', { kind: 'card', name: 'Velvet Rose' }],
    ["open Durov's Cap", { kind: 'card', name: 'Durov’s Cap' }],
    ["show Plush Pepe's seven day floor chart", { kind: 'chart', name: 'Plush Pepe', range: '7d' }],
    ['show the floor chart', { kind: 'chart', name: null }],
    ['show the seven day chart', { kind: 'chart', name: null, range: '7d' }],
    ['show the twenty four hour chart', { kind: 'chart', name: null, range: '24h' }],
    ['show the thirty day chart for Velvet Rose', { kind: 'chart', name: 'Velvet Rose', range: '30d' }],
    ['show the three D preview', { kind: 'preview', name: null }],
    ['save this gift', { kind: 'save', name: null }],
    ['open research', { kind: 'tool', target: 'research' }],
    ['record floor', { kind: 'tool', target: 'record-floor' }],
    ['open watch list', { kind: 'tool', target: 'watchlist' }],
    ['add to watch list', { kind: 'tool', target: 'add-to-watchlist' }],
    ['open market note', { kind: 'tool', target: 'market-note' }],
    ['what changed', { kind: 'tool', target: 'summary' }],
    ['what changed in my favorites', { kind: 'tool', target: 'favorite-movers' }],
    ['ask Gifti', { kind: 'tool', target: 'talk-gifti' }],
    ['watch asking price', { kind: 'tool', target: 'threshold' }],
    ['reply with comparison', { kind: 'share', target: 'comparison' }],
    ['show favorites', { kind: 'favorites' }], ['go back', { kind: 'back' }],
  ]
  for (const [spoken, expected] of cases) {
    const transcript = await decode(await synthesize(directory, spoken))
    assert.ok(transcript, spoken)
    let actual
    const resolution = resolveVoiceCommand(transcript, names, 'Plush Pepe', command => { actual = command; return true })
    assert.equal(resolution.kind, 'action', spoken + ' → ' + transcript)
    resolution.run()
    assert.deepEqual(actual, expected, spoken)
  }

  const candy = await decode(await synthesize(directory, 'open candy'))
  assert.equal(candy?.toLowerCase(), 'open candy')
  const choices = resolveVoiceCommand(candy, names, null, () => assert.fail('fragment dispatched'))
  assert.equal(choices.kind, 'choices')
  assert.deepEqual(choices.labels, ['Candy Cane', 'Candy Heart'])
  for (const phrase of ['open night light', 'what is the weather today', "don't save this gift", 'save this list',
    'save this gift for tomorrow', 'shave this gift', 'shape this gift', 'save this gif',
    "don't send this chart to my Telegram", 'send this chart to your Telegram', 'save this chart to my Telegram',
    'send this chart to my Telegram group', 'never reply with chart', 'replay with chart', 'reply without chart', 'reply with chart tomorrow',
    'show the six day chart', 'show the thirteen day chart', 'show the flour cart', 'go pack', 'open my notebook', 'open gift chat and tell me the weather']) {
    assert.equal(await decode(await synthesize(directory, phrase)), null, phrase)
  }
  assert.equal(await decode(await synthesize(directory, 'open Velvet Rose'), []), null)
  assert.equal(await decode(Buffer.alloc(32000)), null)
  let random = 7
  const noise = Buffer.alloc(32000)
  for (let i = 0; i < noise.length; i += 2) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    noise.writeInt16LE((random >>> 18) - 8192, i)
  }
  assert.equal(await decode(noise), null)
  const clip = (await synthesize(directory, 'go back')).toString('base64')
  const abort = await page.evaluate(async base64 => {
    const controller = new AbortController()
    const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const posted = new Promise(resolve => { window.observeAbortRequest = resolve })
    const outcome = window.transcribe(data, [], controller.signal)
    const worker = await Promise.race([posted, outcome.then(() => {
      throw new Error('Transcription finished before the worker posted its request')
    })])
    controller.abort()
    const status = await outcome.then(() => 'completed', error => error.name)
    return [status, window.terminatedWorkers.has(worker)]
  }, clip)
  assert.deepEqual(abort, ['AbortError', true])
  assert.equal(await decode(Buffer.from(clip, 'base64'), []), 'go back')
  assert.ok(await page.evaluate(() => window.workerStarts > 0 && window.workerStarts === window.workerStops))
  assert.ok([...fetched].some(file => file.endsWith('.wasm')))
  assert.deepEqual(unexpected, [])
})

test('recorded private and reply commands use the live companion chart and a single native confirmation', { timeout: 60_000 }, async t => {
  const { directory, browser } = await speechHost(t)
  const recordings = new Map()
  for (const [spoken, target] of telegramPhrases) recordings.set(target, await recordedCommand(directory, spoken))
  await exerciseTelegramApp(browser, dist, recordings)
})
