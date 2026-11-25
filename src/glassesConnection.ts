import type {
  CompanionDisplayConnection,
  CompanionDisplayStatus,
  GlassesHudMirror,
} from './contracts/companion.ts'

export class GlassesReloadRequired extends Error {}
export class GlassesRebuildPending extends Error {
  constructor() {
    super('G2 has not acknowledged the page rebuild')
  }
}

export interface DisplaySession {
  update(): void
  stop(): Promise<void>
  startIrlListen?(durationMs?: number): boolean
}

/** The phone can open the current gift again even if the native page stopped capturing input. */
export function createGlassesConnection(
  start: (
    onClosed: () => void,
    onDisplayError: (failed: boolean) => void,
    onStartupRebuild: () => void,
    onMirrorChange?: (mirror: GlassesHudMirror | null) => void,
  ) => Promise<DisplaySession>,
) {
  let session: DisplaySession | null = null
  let status: CompanionDisplayStatus = 'inactive'
  let mirror: GlassesHudMirror | null = null
  let opening = false
  let requestAfterClose: (() => void) | null = null
  const listeners = new Set<() => void>()
  const mirrorListeners = new Set<() => void>()

  function publish(next: CompanionDisplayStatus) {
    if (next === status) return
    status = next
    for (const notify of listeners) notify()
  }

  function publishMirror(next: GlassesHudMirror | null) {
    mirror = next
    for (const notify of mirrorListeners) notify()
  }

  async function open() {
    if (opening) {
      if (status === 'closed') requestAfterClose?.()
      return
    }
    const reopening = status !== 'inactive'
    opening = true
    publish('opening')
    const previous = session
    session = null
    let drainDeadline: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let reopen = false
    let slow: ReturnType<typeof setTimeout> | undefined
    const onDelay = (next: 'waitingForHost' | 'reloadAvailable') =>
      setTimeout(() => {
        if (status === 'opening') publish(next)
      }, 12_000)
    try {
      if (previous) {
        slow = onDelay('waitingForHost')
        try {
          const deadline = new Promise<never>((_, reject) => {
            drainDeadline = setTimeout(() => reject(new Error('G2 did not acknowledge the previous session')), 24_000)
          })
          await Promise.race([previous.stop(), deadline])
        } catch (error) {
          session = previous
          throw error
        }
        clearTimeout(slow)
        publish('opening')
      }
      slow = onDelay('reloadAvailable')
      requestAfterClose = () => {
        reopen = true
        publish('opening')
        clearTimeout(slow)
        slow = onDelay('reloadAvailable')
      }
      session = await start(
        () => {
          closed = true
          publish('closed')
        },
        failed => {
          if (!closed) publish(failed ? 'unavailable' : 'ready')
        },
        () => {
          clearTimeout(slow)
          if (!closed) publish('opening')
        },
        publishMirror,
      )
      if (!closed) {
        if (status === 'opening' || status === 'reloadAvailable') publish('ready')
        session.update()
      }
    } catch (error) {
      console.warn('Could not open the G2 display', error)
      if (!closed) {
        const reload = !(error instanceof GlassesRebuildPending) && (reopening || error instanceof GlassesReloadRequired)
        publish(reload ? 'reloadAvailable' : 'unavailable')
      }
    } finally {
      clearTimeout(drainDeadline)
      clearTimeout(slow)
      requestAfterClose = null
      opening = false
    }
    if (reopen) await open()
  }

  const connection: CompanionDisplayConnection = {
    getSnapshot: () => status,
    getHudMirror: () => mirror,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeMirror(listener) {
      mirrorListeners.add(listener)
      return () => {
        mirrorListeners.delete(listener)
      }
    },
    open,
  }
  return {
    connection,
    update: () => session?.update(),
    startIrlListen: (durationMs?: number) => session?.startIrlListen?.(durationMs) ?? false,
    publishMirror,
  }
}
