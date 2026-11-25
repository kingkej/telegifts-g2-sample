import type {
  CompanionToolbox,
  CompanionToolContext,
  CompanionToolController,
  CompanionToolName,
  CompanionToolPage,
  CompanionToolSource,
} from './contracts/tools.ts'
import { createGiftiTool, type GiftiConnection } from './giftiTool.ts'

export function isPhoneTool(name: CompanionToolName) {
  return name === 'market-note' || name === 'summary'
}

export interface StandaloneToolHost {
  gifti?: GiftiConnection
  [key: string]: unknown
}

type Factory = (host: StandaloneToolHost) => CompanionToolController

const defaultFactories: Partial<Record<CompanionToolName, () => Promise<Factory>>> = {
  gifti: () =>
    Promise.resolve(host => {
      if (!host.gifti) throw new Error('Gifti is unavailable.')
      return createGiftiTool(host.gifti)
    }),
}

const entries = [
  { id: 'digest' as const, label: 'Channel & deal digest' },
  { id: 'favorite-movers' as const, label: 'What changed in my Favorites?' },
  { id: 'spread-radar' as const, label: 'Venue spread radar' },
  { id: 'threshold' as const, label: 'Watch an asking price' },
  { id: 'research' as const, label: 'Research queue' },
  { id: 'watchlist' as const, label: 'Paper watchlist' },
  { id: 'market-note' as const, label: 'Signed market note' },
  { id: 'summary' as const, label: 'What changed?' },
  { id: 'gifti' as const, label: 'Ask Gifti' },
]

export function createToolbox(
  host: StandaloneToolHost,
  collection: () => string | undefined,
  loaders: Partial<Record<CompanionToolName, () => Promise<Factory>>> = defaultFactories,
  readLensSurface?: () => HTMLElement | null,
): CompanionToolbox & { checkNavigation(): void } {
  const listeners = new Set<() => void>()
  let page: CompanionToolPage | null = null
  let current: CompanionToolController | null = null
  let unsubscribe: (() => void) | undefined
  let generation = 0
  let context: CompanionToolContext = {}
  let fromMenu = false
  let source: CompanionToolSource = 'glasses'
  const foreground = { display: true, document: true }
  let originSurface: HTMLElement | null = null
  let activeName: CompanionToolName | undefined

  function publish(next: CompanionToolPage | null) {
    if (page === next) return
    page = next
    for (const listener of listeners) listener()
  }

  function detach() {
    generation++
    unsubscribe?.()
    unsubscribe = undefined
    current?.close()
    current = null
  }

  function menu() {
    detach()
    activeName = undefined
    const name = context.collection
    const actions = entries.filter(({ id }) =>
      source === 'phone'
        ? isPhoneTool(id)
        : !!name
          || id === 'digest'
          || id === 'spread-radar'
          || id === 'research'
          || id === 'watchlist'
          || id === 'gifti'
          || id === 'favorite-movers',
    )
    publish({
      key: 'tools',
      title: 'Companion tools',
      lines: [name ?? 'Open a collection for its market note, floor summary and asking-price watch.'],
      actions,
    })
  }

  function start(name: CompanionToolName) {
    detach()
    activeName = name
    const revision = generation
    const title = entries.find(e => e.id === name)?.label ?? name
    publish({ key: 'opening-' + name, title, lines: ['Opening…'], actions: [] })
    const loader = loaders[name] ?? defaultFactories[name]
    if (!loader) {
      publish({
        key: 'load-error',
        title,
        lines: ['This tool could not open.'],
        actions: [{ id: 'retry-tool', label: 'Retry' }],
      })
      return
    }
    void loader()
      .then(make => {
        checkNavigation()
        if (generation !== revision) return
        const tool = make(host)
        current = tool
        const refresh = () => {
          if (current === tool) publish(tool.getSnapshot())
        }
        unsubscribe = tool.subscribe(refresh)
        tool.setForegroundAvailable?.(foreground.display && foreground.document)
        tool.open(context)
        refresh()
      })
      .catch(() => {
        if (generation !== revision) return
        detach()
        publish({
          key: 'load-error',
          title,
          lines: ['This tool could not open.'],
          actions: [{ id: 'retry-tool', label: 'Retry' }],
        })
      })
  }

  function close() {
    detach()
    activeName = undefined
    originSurface = null
    publish(null)
  }

  function checkNavigation() {
    if (page && originSurface && readLensSurface?.() !== originSurface) close()
  }

  return {
    getSnapshot: () => page,
    getActiveTool: () => activeName,
    getPhoneSnapshot: () => (source === 'phone' ? page : null),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    open(name, next, origin = 'glasses') {
      const target = next ?? { collection: collection() }
      if (origin === 'phone' && (!target.collection || (name && !isPhoneTool(name)))) return false
      const surface = origin === 'glasses' ? readLensSurface?.() : null
      if (origin === 'glasses' && readLensSurface && !surface) return false
      originSurface = surface ?? null
      source = origin
      context = target
      fromMenu = !name
      if (name) start(name)
      else menu()
      return true
    },
    act(shown, id) {
      checkNavigation()
      if (
        (source === 'glasses' && (!foreground.display || !foreground.document))
        || shown !== page
        || !shown.actions.some(action => action.id === id)
      )
        return false
      if (current) current.act(id)
      else if (shown.key === 'tools') {
        const entry = entries.find(item => item.id === id)
        if (!entry) return false
        start(entry.id)
      } else if (activeName && id === 'retry-tool') start(activeName)
      else return false
      return true
    },
    back() {
      if (current?.back()) return
      if (fromMenu && activeName) menu()
      else close()
    },
    suspend() {
      if (current?.suspend) {
        current.suspend()
        return
      }
      close()
    },
    setForeground(src, visible) {
      if (foreground[src] === visible) return
      foreground[src] = visible
      current?.setForegroundAvailable?.(foreground.display && foreground.document)
    },
    close,
    checkNavigation,
  }
}
