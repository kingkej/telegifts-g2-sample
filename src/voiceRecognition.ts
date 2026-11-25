type Reply = { text: string | null } | { error: string }

/** Recognize one utterance of 16 kHz mono signed, little-endian 16-bit PCM. */
export async function transcribeVoice(
  pcm: Uint8Array<ArrayBuffer>,
  collectionNames: readonly string[],
  signal: AbortSignal,
  mode: 'command' | 'overheard' = 'command',
): Promise<string | null> {
  const abortReason = () => signal.reason ?? new DOMException('Voice recognition aborted', 'AbortError')
  if (signal.aborted) throw abortReason()
  if (!pcm.byteLength || pcm.byteLength % 2) return null

  const worker = new Worker(new URL('./voiceRecognition.worker.ts', import.meta.url), {
    type: 'module', name: 'TeleGifts speech recognition',
  })
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<string | null>((resolve, reject) => {
      onAbort = () => reject(abortReason())
      signal.addEventListener('abort', onAbort, { once: true })
      worker.onmessage = ({ data }: MessageEvent<Reply>) => {
        if ('error' in data) reject(new Error(data.error))
        else resolve(data.text)
      }
      worker.onerror = event => reject(new Error(event.message || 'Voice recognition worker failed'))
      worker.onmessageerror = () => reject(new Error('Unreadable voice recognition result'))
      // Transfer only this view. The caller can still reuse its original buffer.
      const bytes = new Uint8Array(pcm)
      worker.postMessage({ pcm: bytes, collectionNames, mode }, [bytes.buffer])
    })
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
    worker.terminate()
  }
}
