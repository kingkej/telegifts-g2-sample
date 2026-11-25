import test from 'node:test'
import assert from 'node:assert/strict'
import { transcribeVoice } from '../src/voiceRecognition.ts'
import { speechSamples } from '../src/voiceRecognitionAudio.ts'

test('reads signed little-endian samples from an unaligned subview', () => {
  const bytes = new Uint8Array(2 * 4800 + 3).fill(0xff)
  const pcm = bytes.subarray(1, -2)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  for (let i = 0; i < 4800; i++) view.setInt16(i * 2, i % 2 ? 0x1234 : -0x4321, true)
  const samples = speechSamples(pcm)
  assert.equal(Math.max(...samples), 0x1234 / 32768)
  assert.equal(Math.min(...samples), -0x4321 / 32768)
})

test('rejects silence, DC, isolated impulses and incomplete samples', () => {
  const bytes = new Uint8Array(32000)
  assert.equal(speechSamples(bytes), null)
  bytes.fill(128)
  assert.equal(speechSamples(bytes), null)
  bytes.fill(0)
  bytes.set([0xff, 0x7f], 4000)
  assert.equal(speechSamples(bytes), null)
  assert.equal(speechSamples(bytes.subarray(1)), null)
})

test('an aborted or malformed utterance never needs a worker', async () => {
  const reason = new DOMException('Recording ended', 'AbortError')
  const pcm = new Uint8Array(32000)
  await assert.rejects(transcribeVoice(pcm, [], AbortSignal.abort(reason)), error => error === reason)
  assert.equal(await transcribeVoice(pcm.subarray(1), [], new AbortController().signal), null)
})
