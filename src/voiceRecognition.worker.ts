import createModule from 'soundswallower'
import wasm from '../node_modules/soundswallower/soundswallower.web.wasm?url&no-inline'
import features from '../node_modules/soundswallower/model/en-us/feat_params.json?url&no-inline'
import definition from '../node_modules/soundswallower/model/en-us/mdef?url&no-inline'
import means from '../node_modules/soundswallower/model/en-us/means?url&no-inline'
import variances from '../node_modules/soundswallower/model/en-us/variances?url&no-inline'
import weights from '../node_modules/soundswallower/model/en-us/sendump?url&no-inline'
import transitions from '../node_modules/soundswallower/model/en-us/transition_matrices?url&no-inline'
import dictionary from '../node_modules/soundswallower/model/en-us/dict.txt?url&no-inline'
import noiseDictionary from '../node_modules/soundswallower/model/en-us/noisedict.txt?url&no-inline'
import { speechSamples } from './voiceRecognitionAudio.ts'
import { commandGrammar, overheardCollectionGrammar, verificationGrammar } from './voiceRecognitionGrammar.ts'

async function recognize(pcm: Uint8Array, names: readonly string[], mode: 'command' | 'overheard' = 'command') {
  const samples = speechSamples(pcm)
  if (!samples) return null
  const engine = await createModule({ locateFile: () => wasm })
  const decoder = new engine.Decoder({
    samprate: 16000, loglevel: 'ERROR', wip: 0.001,
    featparams: features, mdef: definition, mean: means, var: variances, sendump: weights,
    tmat: transitions, dict: dictionary, fdict: noiseDictionary,
    // 0.6.3 always probes for an optional LDA file. This model has none.
    lda: 'urn:telegifts:no-lda',
  })
  try {
    await decoder.initialize()
    const transcript = mode === 'overheard' ? overheardCollectionGrammar(decoder, names) : commandGrammar(decoder, names)
    const decode = () => {
      decoder.start()
      decoder.process_audio(samples, false, true)
      decoder.stop()
      return decoder.get_text()
    }
    const hypothesis = decode()
    const text = transcript(hypothesis)
    if (!text) return null
    // A higher word-insertion probability lets the independent phone loop
    // compete more strongly. Require extra evidence for a save or a named target.
    let wordInsertion = 0.0003
    if (text === 'save this gift') wordInsertion = 0.05
    if (text.startsWith('open ') || mode === 'overheard') wordInsertion = 0.08
    decoder.set_config('wip', wordInsertion)
    decoder.set_grammar(verificationGrammar(hypothesis))
    return decode() === hypothesis ? text : null
  } finally {
    decoder.delete()
  }
}

self.onmessage = async ({ data }: MessageEvent<{ pcm: Uint8Array; collectionNames: string[]; mode?: 'command' | 'overheard' }>) => {
  try {
    self.postMessage({ text: await recognize(data.pcm, data.collectionNames, data.mode ?? 'command') })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Speech decoder failed' })
  }
}
