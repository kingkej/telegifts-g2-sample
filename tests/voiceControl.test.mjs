import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as settle } from 'node:timers/promises'
import { createVoiceControl } from '../src/voiceControl.ts'

function samples(ms, sound = true, offset = 0) {
  const result = new Uint8Array(ms * 32)
  const view = new DataView(result.buffer)
  for (let i = 0; i < result.length; i += 2) {
    const signal = sound ? (i % 4 ? 1100 : -1100) : 0
    view.setInt16(i, offset + signal, true)
  }
  return result
}

// Let the native on acknowledgment settle, then advance the re-enable discard window.
async function finishRearm(t) {
  await settle()
  t.mock.timers.tick(300)
}

function setup(t, options = {}) {
  let context = 'Plush Pepe'
  let elapsed = 0
  const run = t.mock.fn(() => true)
  const microphone = t.mock.fn(options.microphone ?? (async () => true))
  const transcribe = t.mock.fn(options.transcribe ?? (async () => 'show floor chart'))
  const resolve = t.mock.fn(options.resolve ?? (() => ({ kind: 'action', label: 'Chart', confirm: false, run })))
  const voice = createVoiceControl({ transcribe, resolve, names: () => [context], now: () => elapsed })
  const detach = voice.bind({ microphone, context: () => context, available: () => true, toolPage: options.toolPage, activeTool: options.activeTool })
  t.after(() => detach())
  const { controls } = voice
  return { voice, controls, run, microphone, transcribe, resolve, detach,
    state: controls.getSnapshot, calls: () => microphone.mock.calls.map(call => call.arguments[0]),
    advance: ms => { elapsed += ms },
    change: name => { context = name; voice.syncContext() },
    listen: async () => { controls.start(); await settle() },
  }
}

test('question capture returns owned PCM only after native off; command routing stays independent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = {}
  let owner
  const h = setup(t, { toolPage: () => page, activeTool: () => owner })
  // A command can have opened the tool. Its navigation lifetime survives the capture.
  await h.listen()
  h.voice.receive(samples(220))
  h.controls.activate()
  await settle()
  const navigation = h.run.mock.calls[0].arguments[0]
  owner = 'gifti'
  const signal = new AbortController().signal
  for (const end of ['manual', 'silence']) {
    const capture = h.controls.recordQuestion(signal)
    await finishRearm(t)
    await assert.rejects(h.controls.recordQuestion(signal), /Finish the current recording/)
    h.controls.start()
    h.controls.activate('phone')
    assert.equal(h.voice.getQuestionSnapshot().phase, 'listening')
    assert.equal(h.state().phase, 'idle')
    const speech = Buffer.from(samples(250, true, 450))
    const expected = Uint8Array.from(speech)
    h.voice.receive(speech)
    speech.fill(0)
    const close = Promise.withResolvers()
    h.microphone.mock.mockImplementationOnce(() => close.promise)
    let returned = false
    void capture.then(() => { returned = true })
    const tail = samples(end === 'silence' ? 900 : 0, false, 450)
    if (end === 'manual') h.controls.activate()
    else { h.advance(900); h.voice.receive(tail) }
    await settle()
    assert.equal(h.voice.getQuestionSnapshot().phase, 'processing')
    assert.equal(returned, false)
    close.resolve(true)
    const pcm = await capture
    assert.deepEqual(pcm, new Uint8Array([...expected, ...tail]))
    assert.equal(h.voice.getQuestionSnapshot(), undefined)
    assert.equal(navigation.aborted, false)
  }
  assert.deepEqual(h.calls(), [true, false, true, false, true, false])
  assert.equal(h.transcribe.mock.callCount(), 1)
  assert.equal(h.resolve.mock.callCount(), 1)
  assert.equal(h.run.mock.callCount(), 1)
  owner = undefined
  h.controls.start()
  await finishRearm(t)
  h.voice.receive(samples(200))
  h.controls.activate()
  await settle()
  assert.equal(h.run.mock.callCount(), 2)
})

test('question capture enforces both the 25-second sample cap and the wall-clock deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = {}
  const h = setup(t, { toolPage: () => page, activeTool: () => 'gifti' })
  for (const end of ['samples', 'timer', 'no speech']) {
    const capture = h.controls.recordQuestion(new AbortController().signal)
    await settle()
    if (end === 'samples') {
      h.advance(24_950)
      h.voice.receive(samples(25_100))
      assert.equal((await capture).byteLength, 800_000)
    } else {
      t.mock.timers.tick(300)
      h.voice.receive(samples(200, end === 'timer', 600))
      t.mock.timers.tick(24_999)
      assert.equal(h.voice.getQuestionSnapshot().phase, 'listening')
      t.mock.timers.tick(1)
      if (end === 'timer') assert.equal((await capture).byteLength, 6_400)
      else await assert.rejects(capture, /No speech/)
    }
    assert.equal(h.voice.getQuestionSnapshot(), undefined)
    assert.equal(h.calls().at(-1), false)
  }
  assert.equal(h.transcribe.mock.callCount(), 0)
})

test('recording requires a live tool and an available microphone; failures leave the tool free to retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let page = null
  let owner
  const h = setup(t, { toolPage: () => page, activeTool: () => owner })
  const signal = new AbortController().signal
  await assert.rejects(h.controls.recordQuestion(signal), /connected glasses/)
  assert.deepEqual(h.calls(), [])
  page = {}
  await assert.rejects(h.controls.recordQuestion(AbortSignal.abort()), { name: 'AbortError' })
  assert.deepEqual(h.calls(), [])
  await h.listen()
  await assert.rejects(h.controls.recordQuestion(signal), /Finish the current recording/)
  assert.equal(h.state().phase, 'listening')
  h.controls.cancel()
  await settle()
  owner = 'gifti'
  h.microphone.mock.mockImplementationOnce(async () => false)
  await assert.rejects(h.controls.recordQuestion(signal), /microphone access/)
  const capture = h.controls.recordQuestion(signal)
  await finishRearm(t)
  h.voice.receive(samples(220))
  h.microphone.mock.mockImplementation(async enabled => enabled)
  h.controls.activate()
  await assert.rejects(capture, /microphone did not close/)
  assert.equal(h.state().phase, 'idle')
  h.microphone.mock.mockImplementation(async () => true)
  const retry = h.controls.recordQuestion(signal)
  await finishRearm(t)
  assert.deepEqual(h.calls().slice(-2), [false, true])
  h.voice.receive(samples(200))
  h.controls.activate()
  assert.equal((await retry).byteLength, 6_400)
  await h.detach()
  await assert.rejects(h.controls.recordQuestion(signal), /connected glasses/)
  assert.equal(h.transcribe.mock.callCount(), 0)
})

test('revocation during native enable or off never delivers canceled question audio', async t => {
  for (const phase of ['opening', 'closing']) {
    let page = {}
    const h = setup(t, { toolPage: () => page, activeTool: () => 'gifti' })
    const pending = Promise.withResolvers()
    const controller = new AbortController()
    if (phase === 'opening') h.microphone.mock.mockImplementationOnce(() => pending.promise)
    const capture = h.controls.recordQuestion(controller.signal)
    await settle()
    if (phase === 'opening') controller.abort()
    else {
      h.voice.receive(samples(220))
      h.microphone.mock.mockImplementationOnce(() => pending.promise)
      h.controls.activate()
      page = {}
      h.voice.syncContext()
    }
    await assert.rejects(capture, { name: 'AbortError' })
    pending.resolve(true)
    await settle()
    assert.equal(h.voice.getQuestionSnapshot(), undefined)
    assert.deepEqual(h.calls(), phase === 'opening' ? [true, false, false] : [true, false])
    assert.equal(h.transcribe.mock.callCount(), 0)
  }
})

test('a signal aborted as the overlay closes prevents delivery to the tool', async t => {
  const page = {}
  const h = setup(t, { toolPage: () => page, activeTool: () => 'gifti' })
  const controller = new AbortController()
  const capture = h.controls.recordQuestion(controller.signal)
  await settle()
  h.controls.subscribe(() => {
    if (!h.voice.getQuestionSnapshot()) controller.abort()
  })
  h.voice.receive(samples(220))
  h.controls.activate()
  await assert.rejects(capture, { name: 'AbortError' })
  assert.deepEqual(h.calls(), [true, false])
  assert.equal(h.transcribe.mock.callCount(), 0)
})

test('question capture needs Gifti ownership even when another tool exposes the same page', async t => {
  const page = {}
  let owner = 'research'
  const h = setup(t, { toolPage: () => page, activeTool: () => owner })
  const signal = new AbortController().signal
  for (const inactive of ['research', undefined]) {
    owner = inactive
    const capture = h.controls.recordQuestion(signal)
    const rejected = assert.rejects(capture, { name: 'AbortError' })
    await settle()
    assert.deepEqual(h.calls(), [])
    await rejected
  }
})

test('an ownership change on the same page discards captured PCM, including after native off', async t => {
  for (const boundary of ['receiving', 'closing', 'returning']) {
    await t.test(boundary, async t => {
      const page = {}
      let owner = 'gifti'
      const h = setup(t, { toolPage: () => page, activeTool: () => owner })
      const rejected = assert.rejects(h.controls.recordQuestion(new AbortController().signal), { name: 'AbortError' })
      await settle()
      h.voice.receive(samples(200))
      if (boundary === 'receiving') {
        owner = 'research'
        h.voice.receive(samples(50))
        assert.equal(h.voice.getQuestionSnapshot(), undefined)
      } else {
        const off = Promise.withResolvers()
        h.microphone.mock.mockImplementationOnce(() => off.promise)
        h.controls.activate()
        assert.equal(h.voice.getQuestionSnapshot().phase, 'processing')
        if (boundary === 'closing') owner = undefined
        else h.controls.subscribe(() => { if (!h.voice.getQuestionSnapshot()) owner = 'research' })
        off.resolve(true)
      }
      await rejected
      assert.deepEqual(h.calls(), [true, false])
      assert.equal(h.transcribe.mock.callCount(), 0)
    })
  }
})

test('only an explicit start opens the glasses microphone; trailing silence finishes one bounded utterance', async t => {
  const h = setup(t)
  h.voice.receive(samples(300))
  assert.deepEqual(h.calls(), [])
  await h.listen()
  const sound = samples(300)
  h.voice.receive(sound)
  sound.fill(0)
  h.advance(1000)
  h.voice.receive(samples(1000, false))
  await settle()
  assert.deepEqual(h.calls(), [true, false])
  assert.equal(h.transcribe.mock.callCount(), 1)
  const [audio, names] = h.transcribe.mock.calls[0].arguments
  assert.equal(audio.byteLength, 1300 * 32)
  assert.ok(audio.some(Boolean))
  assert.deepEqual(names, ['Plush Pepe'])
  assert.equal(h.run.mock.callCount(), 1)
  assert.equal(h.state().phase, 'idle')
})

test('silence, denied permission and failed recognition all allow a retry and Back', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t, { transcribe: async () => null })
  h.microphone.mock.mockImplementationOnce(async () => false)
  await h.listen()
  assert.deepEqual(h.state(), { phase: 'error', reason: 'microphone' })
  h.controls.activate()
  await finishRearm(t)
  h.advance(400)
  h.voice.receive(samples(400, false))
  h.controls.activate()
  await settle()
  assert.equal(h.state().reason, 'silence')
  assert.equal(h.transcribe.mock.callCount(), 0)
  h.controls.activate()
  await finishRearm(t)
  h.voice.receive(samples(200))
  h.controls.activate()
  await settle()
  assert.equal(h.state().reason, 'unknown')
  h.controls.cancel()
  assert.equal(h.state().phase, 'idle')
  assert.equal(h.run.mock.callCount(), 0)
})

test('constant-offset silence ends biased speech after 900 ms and cannot start an utterance by itself', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  await h.listen()
  h.voice.receive(samples(200, false, 512))
  h.controls.activate()
  await settle()
  assert.equal(h.state().reason, 'silence')
  assert.equal(h.transcribe.mock.callCount(), 0)

  h.controls.start()
  await finishRearm(t)
  h.voice.receive(samples(200, true, 512))
  h.advance(899)
  h.voice.receive(samples(899, false, 512))
  assert.equal(h.state().phase, 'listening')
  h.advance(1)
  h.voice.receive(samples(1, false, 512))
  await settle()
  assert.equal(h.state().phase, 'idle')
  assert.equal(h.transcribe.mock.callCount(), 1)
  assert.equal(h.transcribe.mock.calls[0].arguments[0].byteLength, 1100 * 32)
})

test('cancel during a slow microphone enable stops immediately and again after its acknowledgment', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opening = Promise.withResolvers()
  const h = setup(t)
  h.microphone.mock.mockImplementationOnce(() => opening.promise)
  await h.listen()
  assert.equal(h.state().phase, 'starting')
  h.controls.cancel()
  assert.deepEqual(h.calls(), [true, false])
  h.controls.start()
  await settle()
  assert.deepEqual(h.calls(), [true, false])
  opening.resolve(true)
  await finishRearm(t)
  assert.deepEqual(h.calls(), [true, false, false, true])
  assert.equal(h.state().phase, 'listening')
})

test('a late enable is closed on disconnect even when the first disable acknowledgment is lost', async t => {
  const opening = Promise.withResolvers()
  let hardwareOpen = false
  let closes = 0
  const h = setup(t, { microphone: async enabled => {
    if (enabled) await opening.promise
    hardwareOpen = enabled
    if (!enabled && ++closes === 1) return new Promise(() => {})
    return true
  } })
  await h.listen()
  const stopped = h.detach()
  assert.deepEqual(h.calls(), [true, false])
  opening.resolve()
  await settle()
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(hardwareOpen, false)
  assert.equal(await stopped, true)
  assert.equal(h.state().phase, 'offline')
})

test('a new gift cannot receive speech queued before its microphone start was acknowledged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  await h.listen()
  h.change('Toy Bear')
  const opening = Promise.withResolvers()
  h.microphone.mock.mockImplementationOnce(() => opening.promise)
  await h.listen()
  h.voice.receive(samples(800))
  h.voice.receive(samples(1200, false))
  opening.resolve(true)
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
  h.controls.activate()
  assert.equal(h.state().reason, 'silence')
  assert.equal(h.transcribe.mock.callCount(), 0)
})

test('a change of gift or Back invalidates a late transcript and frees captured audio', async t => {
  for (const action of ['change', 'cancel']) {
    const pending = Promise.withResolvers()
    const h = setup(t, { transcribe: () => pending.promise })
    await h.listen()
    h.voice.receive(samples(250))
    h.controls.activate()
    await settle()
    const signal = h.transcribe.mock.calls[0].arguments[2]
    if (action === 'change') h.change('Toy Bear')
    else h.controls.cancel()
    assert.ok(signal.aborted)
    pending.resolve('save this gift')
    await settle()
    assert.equal(h.state().phase, 'idle')
    assert.equal(h.resolve.mock.callCount(), 0)
  }
})

test('a refused microphone close is visible and Retry closes it before accepting another recording', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let allowClose = false
  const h = setup(t, { microphone: async enabled => enabled || allowClose })
  await h.listen()
  h.voice.receive(samples(250))
  h.controls.activate()
  await settle()
  assert.deepEqual(h.state(), { phase: 'error', reason: 'micStop' })
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(h.transcribe.mock.callCount(), 0)

  allowClose = true
  h.controls.activate()
  await finishRearm(t)
  assert.deepEqual(h.calls(), [true, false, false, false, true])
  assert.equal(h.state().phase, 'listening')
  h.controls.cancel()
  assert.equal(h.calls().at(-1), false)
})

test('a dropped close reply can recover on the second close before recognition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t)
  await h.listen()
  h.microphone.mock.mockImplementationOnce(() => new Promise(() => {}))
  h.voice.receive(samples(250))
  h.controls.activate()
  assert.equal(h.state().phase, 'processing')
  assert.equal(h.transcribe.mock.callCount(), 0)
  t.mock.timers.tick(2_000)
  await settle()
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(h.transcribe.mock.callCount(), 1)
  assert.equal(h.state().phase, 'idle')
})

test('choices stay bounded and a write needs an explicit confirmation for the selected gift', async t => {
  const saveToyBear = t.mock.fn(() => true), saveBerryBox = t.mock.fn(() => true)
  const choices = [
    { kind: 'action', label: 'Save Toy Bear', confirm: true, run: saveToyBear },
    { kind: 'action', label: 'Save Berry Box', confirm: true, run: saveBerryBox },
  ]
  const result = { kind: 'choices', labels: ['Toy Bear', 'Berry Box'], choose: i => choices[i] }
  const h = setup(t, { resolve: () => result })
  await h.listen()
  h.voice.receive(samples(300))
  h.controls.activate()
  await settle()
  h.controls.step(1)
  h.controls.step(1)
  h.controls.activate()
  assert.deepEqual(h.state(), { phase: 'confirm', label: 'Save Berry Box' })
  assert.equal(saveBerryBox.mock.callCount(), 0)
  h.controls.activate()
  h.controls.activate()
  assert.equal(saveBerryBox.mock.callCount(), 1)
  assert.equal(saveToyBear.mock.callCount(), 0)
  assert.equal(h.state().phase, 'idle')
})

test('accepted navigation survives its own sheet transition and is revoked on exit or a new command', async t => {
  for (const end of ['exit', 'replace', 'background']) {
    const h = setup(t)
    await h.listen()
    h.voice.receive(samples(220))
    h.controls.activate()
    await settle()
    const lifetime = h.run.mock.calls[0].arguments[0]
    assert.equal(h.state().phase, 'idle')
    assert.equal(h.transcribe.mock.calls[0].arguments[2].aborted, true)
    h.change('Next sheet')
    assert.equal(lifetime.aborted, false)
    if (end === 'exit') await h.detach()
    else if (end === 'replace') h.controls.start()
    else h.controls.cancel()
    assert.equal(lifetime.aborted, true)
  }
})

test('no packets, no answer from the recognizer and overlong audio have bounded outcomes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = setup(t, { transcribe: () => new Promise(() => {}) })
  await h.listen()
  t.mock.timers.tick(8_000)
  assert.equal(h.state().reason, 'silence')
  h.controls.activate()
  await finishRearm(t)
  h.advance(7_900)
  h.voice.receive(samples(8_100))
  await settle()
  assert.equal(h.transcribe.mock.calls[0].arguments[0].byteLength, 8 * 32_000)
  t.mock.timers.tick(25_000)
  assert.equal(h.state().reason, 'recognition')
  assert.ok(h.transcribe.mock.calls[0].arguments[2].aborted)
  h.controls.cancel()
  assert.equal(h.state().phase, 'idle')
})

test('native exit makes a fresh close after both attempts were refused', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hardwareOpen = false
  let bridgeRecovered = false
  const h = setup(t, { microphone: async enabled => {
    if (!enabled && !bridgeRecovered) return false
    hardwareOpen = enabled
    return true
  } })
  await h.listen()
  h.voice.receive(samples(250))
  h.controls.activate()
  await settle()
  assert.equal(h.state().reason, 'micStop')
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(hardwareOpen, true)
  bridgeRecovered = true
  assert.equal(await h.detach(), true)
  assert.equal(hardwareOpen, false)
  assert.deepEqual(h.calls(), [true, false, false, false])
  assert.equal(h.transcribe.mock.callCount(), 0)
  t.mock.timers.tick(30_000)
  assert.equal(await h.detach(), true)
  assert.equal(h.calls().length, 4)
})

test('a failed stop keeps retrying at the watchdog cadence until the bridge acknowledges off', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let hardwareOpen = false
  let bridgeRecovered = false
  const h = setup(t, { microphone: async enabled => {
    if (!enabled && !bridgeRecovered) return false
    hardwareOpen = enabled
    return true
  } })
  await h.listen()
  h.voice.receive(samples(250))
  h.controls.activate()
  await settle()
  assert.deepEqual(h.state(), { phase: 'error', reason: 'micStop' })
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(hardwareOpen, true)
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(h.calls().length, 3)
  t.mock.timers.tick(1)
  await settle()
  const failedAttempts = h.calls().length
  assert.ok(failedAttempts > 3)
  bridgeRecovered = true
  t.mock.timers.tick(1999)
  await settle()
  assert.equal(h.calls().length, failedAttempts)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(hardwareOpen, false)
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(h.calls().length, failedAttempts + 1)
  assert.equal(h.calls().filter(Boolean).length, 1)
  assert.equal(h.transcribe.mock.callCount(), 0)
})

for (const exit of ['direct detach', 'Back then detach']) {
  test(`a revoked on can apply without a reply after the first off, even after ${exit}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const opening = Promise.withResolvers()
    let hardwareOpen = false
    const h = setup(t, { microphone: enabled => {
      if (enabled) return opening.promise
      hardwareOpen = false
      return Promise.resolve(true)
    } })
    await h.listen()
    if (exit === 'Back then detach') {
      h.controls.cancel()
      await settle() // The early off is acknowledged before exit.
    }
    let stopSettled = false
    const stopped = h.detach().then(ok => { stopSettled = true; return ok })
    const repeatedStop = h.detach()
    await settle()
    assert.equal(stopSettled, false)
    assert.deepEqual(h.calls(), [true, false])
    hardwareOpen = true // The glasses apply the revoked command but deliver no acknowledgment.
    t.mock.timers.tick(1999)
    await settle()
    assert.equal(hardwareOpen, true)
    t.mock.timers.tick(1)
    await settle()
    assert.equal(hardwareOpen, false)
    assert.equal(await stopped, false) // The original on can still land.
    assert.equal(await repeatedStop, false)
    assert.deepEqual(h.calls(), [true, false, false])
    t.mock.timers.tick(2000)
    await settle()
    assert.deepEqual(h.calls(), [true, false, false, false])
    // Once that on actually settles, a final acknowledged off retires the watchdog.
    opening.resolve(true)
    await settle()
    assert.equal(h.calls().length, 5)
    assert.equal(h.state().phase, 'offline')
    t.mock.timers.tick(30_000)
    assert.equal(h.calls().length, 5)
  })
}

test('exit after the Back release timed out still reports an outstanding enable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opening = Promise.withResolvers()
  const h = setup(t)
  h.microphone.mock.mockImplementationOnce(() => opening.promise)
  await h.listen()
  h.controls.cancel()
  await settle()
  t.mock.timers.tick(2000)
  await settle()
  assert.deepEqual(h.state(), { phase: 'error', reason: 'micStop' })
  assert.equal(await h.detach(), false)
  const writes = h.calls().length
  opening.resolve(true)
  await settle()
  assert.equal(h.calls().length, writes + 1)
  assert.equal(h.calls().at(-1), false)
  assert.equal(h.state().phase, 'offline')
})

test('a pending early off fences the next recording even after a later off succeeded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opening = Promise.withResolvers()
  const firstOff = Promise.withResolvers()
  const h = setup(t)
  h.microphone.mock.mockImplementationOnce(() => opening.promise)
  await h.listen()
  h.microphone.mock.mockImplementationOnce(() => firstOff.promise)
  h.controls.cancel()
  h.controls.start()
  opening.resolve(true)
  await settle()
  assert.deepEqual(h.calls(), [true, false, false])
  assert.equal(h.state().phase, 'starting')
  firstOff.resolve(true)
  await finishRearm(t)
  assert.deepEqual(h.calls(), [true, false, false, true])
  assert.equal(h.state().phase, 'listening')
})

test('a timed-out off applying during a newer recording discards its audio and allows Retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const oldOff = Promise.withResolvers()
  let hardwareOpen = false
  let closes = 0
  const h = setup(t, { microphone: async enabled => {
    if (!enabled && ++closes === 1) await oldOff.promise
    hardwareOpen = enabled
    return true
  } })
  await h.listen()
  h.controls.cancel()
  h.controls.start()
  await settle()
  assert.deepEqual(h.calls(), [true, false])
  t.mock.timers.tick(2000)
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
  assert.equal(hardwareOpen, true)
  assert.equal(h.calls().filter(Boolean).length, 2)
  h.voice.receive(samples(250))

  oldOff.resolve()
  await settle()
  assert.equal(hardwareOpen, false)
  assert.deepEqual(h.state(), { phase: 'error', reason: 'microphone' })
  h.voice.receive(samples(1000, false))
  assert.equal(h.transcribe.mock.callCount(), 0)
  assert.equal(h.run.mock.callCount(), 0)

  h.controls.activate()
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
  assert.equal(hardwareOpen, true)
  h.voice.receive(samples(250))
  h.controls.activate()
  await settle()
  assert.equal(h.run.mock.callCount(), 1)
  assert.equal(hardwareOpen, false)
})

test('an explicit new start can recover from a lost on reply and a later stale on cannot own it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const opening = Promise.withResolvers()
  const h = setup(t)
  h.microphone.mock.mockImplementationOnce(() => opening.promise)
  await h.listen()
  h.controls.cancel()
  h.controls.start()
  await settle()
  assert.equal(h.state().phase, 'starting')
  t.mock.timers.tick(2000)
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
  assert.equal(h.calls().at(-1), true)
  const writes = h.calls().length
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(h.calls().length, writes) // The old watchdog must not close an authorized recording.
  opening.resolve(true)
  await settle()
  assert.equal(h.state().reason, 'microphone')
  assert.equal(h.calls().at(-1), false)
  assert.equal(h.transcribe.mock.callCount(), 0)
  h.controls.activate()
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
})

test('rearming discards a queued 200 ms packet and keeps the first speech after the listening prompt', async t => {
  for (const mode of ['command', 'question']) await t.test(mode, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const page = {}
    let owner
    const h = setup(t, { toolPage: () => page, activeTool: () => owner })
    const old = samples(200, true, 500)
    await h.listen()
    h.voice.receive(old)
    h.change('Toy Bear')
    const opening = Promise.withResolvers()
    h.microphone.mock.mockImplementationOnce(() => opening.promise)
    owner = mode === 'question' ? 'gifti' : undefined
    const capture = mode === 'question' ? h.controls.recordQuestion(new AbortController().signal) : h.controls.start()
    const phase = () => (h.voice.getQuestionSnapshot() ?? h.state()).phase
    await settle()
    t.mock.timers.tick(500)
    h.voice.receive(old)
    opening.resolve(true)
    await settle()
    assert.equal(phase(), 'starting')
    h.voice.receive(old)
    t.mock.timers.tick(299)
    h.voice.receive(old)
    assert.equal(phase(), 'starting')
    t.mock.timers.tick(1)
    assert.equal(phase(), 'listening')
    const fresh = samples(200, true, -400)
    h.voice.receive(fresh)
    h.controls.activate()
    await settle()
    if (mode === 'question') assert.deepEqual(await capture, fresh)
    else assert.deepEqual(h.transcribe.mock.calls[0].arguments[0], fresh)
    assert.deepEqual(h.calls(), [true, false, true, false])
  })
})

test('cancel during the re-enable discard window never publishes listening or releases PCM', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = {}
  let owner
  const h = setup(t, { toolPage: () => page, activeTool: () => owner })
  await h.listen()
  h.controls.cancel()
  owner = 'gifti'
  const controller = new AbortController()
  const rejected = assert.rejects(h.controls.recordQuestion(controller.signal), { name: 'AbortError' })
  await settle()
  assert.equal(h.voice.getQuestionSnapshot().phase, 'starting')
  t.mock.timers.tick(299)
  controller.abort()
  await rejected
  t.mock.timers.tick(1)
  assert.equal(h.voice.getQuestionSnapshot(), undefined)
  assert.equal(h.state().phase, 'idle')
  assert.equal(h.transcribe.mock.callCount(), 0)
  assert.deepEqual(h.calls(), [true, false, true, false])
})

test('2.53 seconds of stale PCM after a new positive on is rejected as one packet or a burst', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const packetMs of [2530, 100]) {
    const h = setup(t)
    await h.listen()
    h.advance(4100)
    h.change('Toy Bear')
    const opening = Promise.withResolvers()
    h.microphone.mock.mockImplementationOnce(() => opening.promise)
    await h.listen()
    h.advance(3000) // Time spent waiting for the new on cannot buy a PCM budget.
    opening.resolve(true)
    await finishRearm(t)
    assert.equal(h.state().phase, 'listening')
    for (let ms = 0; ms < 2530; ms += packetMs) h.voice.receive(samples(Math.min(packetMs, 2530 - ms)))
    h.voice.receive(samples(900, false))
    await settle()
    assert.deepEqual(h.state(), { phase: 'error', reason: 'unknown' })
    assert.equal(h.calls().at(-1), false)
    assert.equal(h.transcribe.mock.callCount(), 0)
    assert.equal(h.run.mock.callCount(), 0)
  }
})

test('real-time speech with buffered and back-to-back packets fits the cumulative sample budget', async t => {
  const h = setup(t)
  await h.listen()
  h.voice.receive(samples(240))
  h.advance(500)
  h.voice.receive(samples(220))
  h.voice.receive(samples(300))
  assert.equal(h.state().phase, 'listening')
  h.advance(900)
  h.voice.receive(samples(900, false))
  await settle()
  assert.equal(h.state().phase, 'idle')
  assert.equal(h.transcribe.mock.calls[0].arguments[0].byteLength, 1660 * 32)
  assert.equal(h.run.mock.callCount(), 1)
})

test('a late confirmed off clears a previous stop failure and exit sends no further command', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = Promise.withResolvers()
  const h = setup(t)
  await h.listen()
  h.microphone.mock.mockImplementationOnce(() => first.promise)
  h.controls.cancel()
  h.microphone.mock.mockImplementationOnce(async () => false)
  t.mock.timers.tick(2000)
  await settle()
  assert.equal(h.state().reason, 'micStop')
  first.resolve(true)
  await settle()
  assert.equal(await h.detach(), true)
  t.mock.timers.tick(12_000)
  assert.deepEqual(h.calls(), [true, false, false])
})

test('a delayed hardware stop also invalidates a newer transcript waiting for recognition', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = Promise.withResolvers()
  const text = Promise.withResolvers()
  const h = setup(t, { transcribe: () => text.promise })
  await h.listen()
  h.microphone.mock.mockImplementationOnce(() => first.promise)
  h.controls.cancel()
  h.controls.start()
  t.mock.timers.tick(2000)
  await finishRearm(t)
  assert.equal(h.state().phase, 'listening')
  h.voice.receive(samples(220))
  h.controls.activate()
  await settle()
  assert.equal(h.state().phase, 'processing')
  const signal = h.transcribe.mock.calls[0].arguments[2]
  first.resolve(true)
  await settle()
  assert.equal(signal.aborted, true)
  text.resolve('open Toy Bear')
  await settle()
  assert.deepEqual(h.state(), { phase: 'error', reason: 'microphone' })
  assert.equal(h.resolve.mock.callCount(), 0)
})
