import type {
  CollectionCompanion,
  CollectionControls,
  CollectionFloorsResponse,
  CollectionItem,
  CompanionBrowseRow,
  CompanionChartRange,
  CompanionFavorites,
  CompanionFloorMarket,
} from './contracts/companion.ts'
import type { CompanionTelegramControl, TelegramScreen, TelegramShareTarget } from './contracts/telegram.ts'
import type { CompanionToolbox, CompanionToolName, CompanionToolPage, CompanionToolSource } from './contracts/tools.ts'
import { resolveDeepLinkMatchKey } from './lib/deepLinkMatchKey.ts'
import { parseTelegramGiftLink, type ResolvedGiftLink } from './lib/giftLinkResolver.ts'
import { resolveCompanionCollection } from './lib/resolveCompanionCollection.ts'
import { collectionQuote, rankCollections, type Screen, type Section } from './catalog.ts'
import { createInspector } from './inspection.ts'
import { resolveVoiceCommand, type VoiceResolution } from './voiceCommands.ts'

type Row = CompanionBrowseRow
const initialFavorites: CompanionFavorites = { ready: false, visible: false, collections: [] }

export function createCollectionDisplay(onChange: () => void) {
  let controls: CollectionControls | null = null
  let registration = 0
  let catalog: CollectionFloorsResponse | null = null
  let selection: CollectionItem | null = null
  let explore: readonly Row[] = []
  let favorites = initialFavorites
  const favoriteListeners = new Set<() => void>()
  let chartNavigation: { lifetime: AbortController; favorite?: Row } | undefined
  let visibleFavorites: CompanionFavorites['collections'] | null = null
  let favoriteRows: readonly Row[] = []
  let market: CompanionFloorMarket | null = null
  let usdtPerGram: number | null = null
  const focus: Record<Section, string | null> = { explore: null, favorites: null }
  let phase: 'loading' | 'empty' | 'error' = 'loading'
  let generation = 0
  let navigationRevision = 0
  let tools: CompanionToolbox | null = null
  const toolForeground = { native: true, document: true }
  let observedTools: CompanionToolbox | null = null
  let toolPage: CompanionToolPage | null = null
  let toolOrigin: CollectionItem | null = null
  let unsubscribeTools: (() => void) | undefined
  let telegram: CompanionTelegramControl | null = null
  let unsubscribeTelegram: (() => void) | undefined
  let telegramScope = ''
  let previousPrompt: TelegramScreen | undefined
  let wasChart = false
  let pendingGlassesMenuBrief = false

  const loadArtwork = async (name: string, model?: string) => controls?.loadArtwork(name, model) ?? null

  const inspection = createInspector(
    {
      loadArtwork,
      loadFloorChart(name, range, forceRetry, signal) {
        if (!controls) throw new Error('Phone disconnected')
        return controls.loadFloorChart(name, range, forceRetry, signal)
      },
      loadVariants(name) {
        if (!controls) throw new Error('Phone disconnected')
        return controls.loadVariants(name)
      },
      loadQuotes(name) {
        const resolved = resolveCompanionCollection({ id: name, name, floors: selection?.name === name ? selection.floors : {} }, catalog)
        return collectionQuote(resolved.name, resolved.floors)?.quotes ?? []
      },
      initialRange: () => (market?.period === '7d' || market?.period === '30d' ? market.period : '24h'),
    },
    () => {
      const mode = inspection.inspector.getSnapshot().mode
      const isChartOrSpread = mode === 'chart' || mode === 'spread'
      if (isChartOrSpread || wasChart) navigationRevision++
      wasChart = isChartOrSpread
      onChange()
    },
  )

  function getTelegram() {
    return controls ? telegram : null
  }
  function getTools() {
    return controls ? tools : null
  }

  function cancelChartNavigation() {
    chartNavigation?.lifetime.abort()
    chartNavigation = undefined
  }

  function setToolsForeground(source: 'native' | 'document', visible: boolean) {
    toolForeground[source] = visible
    if (!visible) cancelChartNavigation()
    tools?.setForeground?.('display', toolForeground.native && toolForeground.document)
  }

  function observeTools() {
    const store = getTools()
    if (store === observedTools) return
    unsubscribeTools?.()
    observedTools = store
    toolPage = null
    toolOrigin = null
    const changed = () => {
      const page = store?.getSnapshot() ?? null
      if (page === toolPage) return
      if (!toolPage && page) {
        cancelChartNavigation()
        toolOrigin = voiceItem()
      }
      if (!page) toolOrigin = null
      toolPage = page
      navigationRevision++
      browseChanged()
    }
    unsubscribeTools = store?.subscribe(changed)
    changed()
  }

  function browseChanged() {
    if (toolPage && tools?.getActiveTool?.() === 'gifti') {
      const gift = voiceItem()
      if (gift?.id !== toolOrigin?.id || gift?.name !== toolOrigin?.name) {
        tools?.close()
        return
      }
    }
    onChange()
  }

  function openTools(name?: CompanionToolName, source: CompanionToolSource = 'glasses', entry?: 'talk') {
    const store = getTools()
    if (
      !store
      || store.getSnapshot()
      || (name && store.supportsTool && !store.supportsTool(name))
      || !controls?.canUseVoiceTarget?.(selection)
      || (getTelegram()?.getSnapshot().screen.kind ?? 'idle') !== 'idle'
    )
      return false
    return store.open(name, { collection: voiceItem()?.name, ...(entry && { entry }) }, source)
  }

  function openToolChart(name: string, range: CompanionChartRange) {
    const store = getTools()
    const phone = controls
    const active = store?.getActiveTool?.()
    const page = store?.getSnapshot()
    if (
      !store
      || !page
      || store.getPhoneSnapshot()
      || !phone?.canUseVoiceTarget?.(selection)
      || !toolForeground.native
      || !toolForeground.document
      || (telegram?.getSnapshot().screen.kind ?? 'idle') !== 'idle'
    )
      return false
    const item =
      active === 'gifti'
        ? (voiceItem()?.name === name
            ? voiceItem()
            : catalog && Object.hasOwn(catalog.collection_floors, name)
              ? { id: name, name }
              : null)
        : active === 'favorite-movers' && favorites.ready
          ? favorites.collections.find(row => row.name === name)
          : (active === 'spread-radar'
              || active === 'summary'
              || active === 'watchlist'
              || active === 'research'
              || active === 'market-note')
            && catalog
            && Object.hasOwn(catalog.collection_floors, name)
            ? { id: name, name }
            : null
    if (!item) return false
    const target = resolveCompanionCollection({ ...item, floors: {} }, catalog)
    if (selection && voiceItem()?.name === target.name) {
      store.close()
      inspection.showChart(range)
      return true
    }
    cancelChartNavigation()
    const navigation = new AbortController()
    chartNavigation = { lifetime: navigation, favorite: active === 'favorite-movers' ? item : undefined }
    const accepted =
      phone.open(
        target,
        () => {
          if (chartNavigation?.lifetime !== navigation) return
          chartNavigation = undefined
          if (
            navigation.signal.aborted
            || controls !== phone
            || getTools() !== store
            || !selection
            || voiceItem()?.name !== resolveCompanionCollection(target, catalog).name
            || (telegram?.getSnapshot().screen.kind ?? 'idle') !== 'idle'
          )
            return
          if (store.getSnapshot() && store.getSnapshot() !== page) return
          if (store.getSnapshot() === page) store.close()
          inspection.showChart(range)
        },
        selection ?? undefined,
        navigation.signal,
      ) === true
    if (accepted && store.getSnapshot() === page) store.close()
    if (!accepted && chartNavigation?.lifetime === navigation) cancelChartNavigation()
    return accepted
  }

  function telegramChanged() {
    const snapshot = getTelegram()?.getSnapshot()
    const state = snapshot?.state
    const prompt = snapshot?.screen
    const scope = JSON.stringify([
      state?.enabled,
      state?.privateChat,
      state?.group,
      snapshot?.selectedQuestion,
      prompt,
      prompt?.kind === 'questions' ? state?.questions : undefined,
      prompt?.kind === 'digest' ? state?.digest : undefined,
    ])
    if (scope !== telegramScope || ((prompt?.kind === 'confirm' || prompt?.kind === 'compose') && prompt !== previousPrompt))
      navigationRevision++
    telegramScope = scope
    previousPrompt = prompt
    onChange()
  }

  function observeTelegram() {
    unsubscribeTelegram?.()
    unsubscribeTelegram = getTelegram()?.subscribe(telegramChanged)
    telegramChanged()
  }

  function shareChart(target: TelegramShareTarget, displayedFrame: Uint8Array | undefined): boolean {
    const store = getTelegram()
    if (!store || store.getSnapshot().screen.kind !== 'idle' || getTools()?.getSnapshot() || !controls?.canUseVoiceTarget?.(selection)) {
      return false
    }
    if (target === 'smart-draft') {
      return store.openCompose ? store.openCompose() : store.share('smart-draft')
    }
    const view = inspection.inspector.getSnapshot()
    if (
      !selection
      || view.mode !== 'chart'
      || view.status !== 'ready'
      || view.frame !== displayedFrame
      || view.collection !== voiceItem()?.name
    )
      return false
    return store.share(target) || store.getSnapshot().screen.kind !== 'idle'
  }

  function section(): Section {
    return favorites.visible ? 'favorites' : 'explore'
  }

  function rows(s: Section): readonly Row[] {
    if (s === 'favorites') return favoriteRows
    const browse = market?.browse
    if (!browse || browse.status === 'catalog') return explore
    return browse.status === 'rows' ? browse.rows : []
  }

  function updateFavoriteRows() {
    if (visibleFavorites === null) {
      favoriteRows = favorites.collections
      return
    }
    const saved = new Set(favorites.collections.map(row => row.id))
    favoriteRows = visibleFavorites.filter(row => saved.has(row.id))
  }

  function match(items: readonly Row[], item: Row) {
    const key = resolveDeepLinkMatchKey(item.name)
    return (
      items.find(row => row.id === item.id)
      ?? items.find(row => row.name === item.name)
      ?? (key ? items.find(row => resolveDeepLinkMatchKey(row.name) === key) : undefined)
    )
  }

  function keepFocus(s: Section, previous: readonly Row[]) {
    const items = rows(s)
    if (!items.length) return
    const selected = selection && s === section() && match(items, selection)
    if (selected) {
      focus[s] = selected.id
      return
    }
    if (items.some(item => item.id === focus[s])) return
    const priorIndex = previous.findIndex(item => item.id === focus[s])
    const prior = previous[priorIndex]
    const preferred = prior
      ? match(items, prior)
      : s === 'explore' && (!market || market.filter === 'all')
        ? items.find(item => item.name === 'Plush Pepe')
        : null
    focus[s] = preferred?.id ?? items[Math.max(0, Math.min(priorIndex, items.length - 1))]?.id ?? null
  }

  function current(): Screen {
    const active = section()
    if (!controls) return { status: 'waiting', section: active }
    const ranking = active === 'explore' && market ? { period: market.period, filter: market.filter } : undefined
    const items = rows(active)
    const index = items.findIndex(item => item.id === focus[active])
    const item = selection ?? items[index]
    if (!item) {
      if (active === 'favorites') {
        const status = !favorites.ready ? 'loading' : favorites.collections.length ? 'noMatches' : 'empty'
        return { status, section: active }
      }
      const status = market?.browse.status
      const emptyState = { rows: 'noMatches', loading: 'rankingLoading', error: 'rankingError', catalog: phase } as const
      return { status: status ? emptyState[status] : phase, section: active, ranking }
    }
    const resolved = resolveCompanionCollection({ ...item, floors: {} }, catalog)
    const observed = market?.observations.get(resolveDeepLinkMatchKey(resolved.name))
    const card = {
      id: item.id,
      section: active,
      detail: selection !== null,
      position: index + 1,
      total: items.length,
      saved: favorites.ready ? Boolean(match(favorites.collections, item)) : null,
      inspection: selection ? inspection.inspector.getSnapshot() : undefined,
      usdtPerGram,
      ranking,
      cachedFloor: active === 'explore' && !selection ? items[index]?.cachedFloor ?? null : null,
      observation: observed && market ? { ...observed, period: market.period, stale: market.stale } : null,
    }
    const collection = collectionQuote(resolved.name, resolved.floors)
    return collection ? { ...card, status: 'ready', collection } : { ...card, status: 'unpriced', name: resolved.name }
  }

  function acceptCatalog(response: CollectionFloorsResponse) {
    const previous = rows('explore')
    explore = rankCollections(response).map(({ name }) => ({ id: name, name }))
    generation++
    catalog = response
    keepFocus('explore', previous)
    phase = 'empty'
    if (selection) inspection.rebind(resolveCompanionCollection(selection, catalog).name)
    browseChanged()
    if (pendingGlassesMenuBrief && controls && getTools()) {
      pendingGlassesMenuBrief = false
      openTools('summary', 'glasses')
    }
  }

  async function refresh(force = false) {
    if (!controls) return
    const request = ++generation
    phase = 'loading'
    onChange()
    try {
      const response = await controls.loadCatalog(force)
      if (request === generation) acceptCatalog(response)
    } catch {
      if (request !== generation) return
      phase = 'error'
      onChange()
    }
  }

  function disconnect() {
    cancelChartNavigation()
    generation++
    controls = null
    navigationRevision++
    observeTools()
    tools?.close()
    observeTelegram()
    telegram?.cancelDraft()
    catalog = null
    explore = []
    selection = null
    inspection.select(null)
    favorites = initialFavorites
    for (const listener of favoriteListeners) listener()
    visibleFavorites = null
    favoriteRows = []
    market = null
    usdtPerGram = null
    pendingGlassesMenuBrief = false
    focus.explore = focus.favorites = null
    onChange()
  }

  const companion = {
    openToolChart,
    favoriteCollections: {
      getSnapshot: () => favorites,
      subscribe(listener) {
        favoriteListeners.add(listener)
        return () => {
          favoriteListeners.delete(listener)
        }
      },
    },
    inspector: inspection.inspector,
    setTools(next) {
      if (tools === next) return
      cancelChartNavigation()
      const previous = tools
      tools = next
      next?.setForeground?.('display', toolForeground.native && toolForeground.document)
      navigationRevision++
      observeTools()
      previous?.close()
      if (pendingGlassesMenuBrief && next && catalog && controls) {
        pendingGlassesMenuBrief = false
        openTools('summary', 'glasses')
      }
      onChange()
    },
    setTelegram(next) {
      if (telegram === next) return
      cancelChartNavigation()
      const old = telegram
      telegram = next
      navigationRevision++
      observeTelegram()
      old?.cancelDraft()
    },
    catalogChanged(response) {
      if (!controls) return
      acceptCatalog(response)
    },
    marketChanged(next) {
      const previous = rows('explore')
      const changedFilter = (market?.filter ?? 'all') !== (next?.filter ?? 'all')
      market = next
      if (changedFilter && !selection) focus.explore = rows('explore')[0]?.id ?? null
      else keepFocus('explore', previous)
      browseChanged()
    },
    rateChanged(rate) {
      usdtPerGram = rate
      onChange()
    },
    favoritesChanged(next) {
      const previous = favoriteRows
      if (favorites.visible !== next.visible) {
        navigationRevision++
        if (tools?.getSnapshot() && !tools.getPhoneSnapshot()) tools.close()
      }
      favorites = next.ready ? next : { ...next, collections: [] }
      const pending = chartNavigation?.favorite
      if (pending && !favorites.collections.some(row => row.id === pending.id && row.name === pending.name))
        cancelChartNavigation()
      updateFavoriteRows()
      if (next.ready) keepFocus('favorites', previous)
      else focus.favorites = null
      for (const listener of favoriteListeners) listener()
      browseChanged()
    },
    favoriteListChanged(next) {
      const previous = favoriteRows
      visibleFavorites = next
      updateFavoriteRows()
      keepFocus('favorites', previous)
      browseChanged()
    },
    connect(next) {
      if (controls && controls !== next) disconnect()
      const owner = ++registration
      navigationRevision++
      controls = next
      observeTools()
      observeTelegram()
      void refresh()
      return () => {
        if (registration !== owner || controls !== next) return
        disconnect()
      }
    },
    select(item) {
      if (selection?.id !== item?.id || selection?.name !== item?.name) {
        navigationRevision++
        tools?.close()
      }
      selection = item
      inspection.select(item ? resolveCompanionCollection(item, catalog).name : null)
      if (item) keepFocus(section(), rows(section()))
      onChange()
    },
  } satisfies CollectionCompanion

  function tap() {
    if (!controls) return
    if (selection) {
      if (!favorites.ready) return
      const saved = match(favorites.collections, selection)
      controls.setFavorite(saved ? { ...selection, id: saved.id } : selection, !saved)
      return
    }
    const active = section()
    const item = rows(active).find(row => row.id === focus[active])
    if (item) {
      controls.open(resolveCompanionCollection({ ...item, floors: {} }, catalog))
    } else if (active === 'explore' && market?.browse.status === 'error') {
      market.retry()
    } else if (active === 'explore' && (!market || market.browse.status === 'catalog') && (phase === 'empty' || phase === 'error')) {
      void refresh(true)
    }
  }

  function move(direction: -1 | 1) {
    if (!controls || selection) return
    const active = section()
    const items = rows(active)
    const index = items.findIndex(row => row.id === focus[active])
    const next = items[index + direction]
    if (index < 0 || !next) return
    focus[active] = next.id
    navigationRevision++
    browseChanged()
  }

  function openFavorites() {
    if (controls && !selection && !favorites.visible) controls.showFavorites(true)
  }

  function back(voice = false, signal?: AbortSignal): boolean {
    if (chartNavigation) {
      cancelChartNavigation()
      return true
    }
    if (!controls) return false
    if (inspection.inspector.getSnapshot().mode !== 'overview') {
      if (controls.backFromInspection) return controls.backFromInspection()
      if (!voice) {
        inspection.inspector.back()
        return true
      }
    }
    if (controls.back()) return true
    if (selection) return !voice
    if (!favorites.visible) return voice
    const accepted = controls.showFavorites(false, undefined, signal)
    return !voice || accepted === true
  }

  function voiceNames(): readonly string[] {
    return Object.keys(catalog?.collection_floors ?? {}).filter(name => name.trim())
  }

  function voiceItem(): CollectionItem | null {
    const active = section()
    const item = selection ?? rows(active).find(row => row.id === focus[active])
    return item ? resolveCompanionCollection({ ...item, floors: {} }, catalog) : null
  }

  function resolveVoice(text: string, displayedChart?: Uint8Array, source: CompanionToolSource = 'glasses'): VoiceResolution {
    const phone = controls
    if (!phone) return { kind: 'unknown' }
    const origin = voiceItem()
    const revision = navigationRevision
    const originStore = telegram
    const originTools = getTools()
    const shown = originTools?.getSnapshot()
    let saved = false
    return resolveVoiceCommand(text, voiceNames(), origin?.name ?? null, (command, signal) => {
      const live = voiceItem()
      if (signal?.aborted || controls !== phone || revision !== navigationRevision || live?.id !== origin?.id || live?.name !== origin?.name)
        return false
      if ((telegram?.getSnapshot().screen.kind ?? 'idle') !== 'idle') return false
      if (shown) {
        if (!originTools || getTools() !== originTools || originTools.getSnapshot() !== shown || !phone.canUseVoiceTarget?.(selection))
          return false
        if (source === 'phone' && originTools.getPhoneSnapshot() !== shown) return false
        if (command.kind === 'back') {
          originTools.back()
          return true
        }
        if (
          command.kind === 'tool'
          && command.target === 'talk-gifti'
          && source === 'glasses'
          && shown.key === 'tools'
          && shown.actions.some(action => action.id === 'gifti')
        )
          return originTools.open('gifti', { collection: live?.name, entry: 'talk' }, source)
        if (command.kind !== 'tool' || !shown.actions.some(a => a.id === command.target && !a.requiresConfirmation))
          return false
        return originTools.act(shown, command.target)
      }
      if (command.kind === 'telegram-inbox') {
        const store = getTelegram()
        if (!store || !phone.canUseVoiceTarget?.(selection)) return false
        store.openQuestions()
        return true
      }
      if (command.kind === 'telegram-digest') {
        const store = getTelegram()
        if (!store?.openDigest || !phone.canUseVoiceTarget?.(selection)) return false
        store.openDigest()
        return true
      }
      if (command.kind === 'tool') {
        if (command.target === 'talk-gifti') return source === 'glasses' && openTools('gifti', source, 'talk')
        return command.target !== 'record-floor' && command.target !== 'add-to-watchlist' && openTools(command.target, source)
      }
      if ((command.kind === 'preview' || command.kind === 'spread') && source === 'phone') return false
      if (command.kind === 'share') return shareChart(command.target, displayedChart)
      if (!phone.canUseVoiceTarget?.(selection)) return false
      if (command.kind === 'back') return back(true, signal)
      if (command.kind === 'favorites') {
        return (!selection && favorites.visible) || phone.showFavorites(true, selection ?? undefined, signal) === true
      }
      if (command.kind === 'save') {
        if (!live || !favorites.ready) return false
        if (!saved && !match(favorites.collections, live)) phone.setFavorite(live, true)
        saved = true
        return true
      }

      const name = command.name
      if (name !== null && (!catalog || !Object.hasOwn(catalog.collection_floors, name))) return false
      const target = name === null || name === live?.name ? live : resolveCompanionCollection({ id: name, name, floors: {} }, catalog)
      if (!target) return false
      function showView() {
        if (command.kind === 'chart') inspection.showChart(command.range)
        else if (command.kind === 'spread') inspection.inspector.show('spread')
        else inspection.inspector.show(command.kind === 'preview' ? 'preview' : 'overview')
      }
      if (selection && target.name === live?.name) {
        showView()
        return true
      }
      if (command.kind === 'card') return phone.open(target, undefined, selection ?? undefined, signal) === true
      return (
        phone.open(
          target,
          () => {
            if (
              !signal?.aborted
              && controls === phone
              && !getTools()?.getSnapshot()
              && telegram === originStore
              && (telegram?.getSnapshot().screen.kind ?? 'idle') === 'idle'
              && selection
              && voiceItem()?.name === resolveCompanionCollection(target, catalog).name
            )
              showView()
          },
          selection ?? undefined,
          signal,
        ) === true
      )
    })
  }

  function openGiftLink(
    rawInput: string,
    viewMode: 'spread' | 'chart' | 'card' = 'spread',
  ): ResolvedGiftLink | null {
    const phone = controls
    if (!phone || !catalog) return null
    const parsed = parseTelegramGiftLink(rawInput, catalog)
    if (!parsed) return null
    cancelChartNavigation()
    telegram?.cancelDraft()
    if (tools?.getSnapshot()) tools.close()
    const target = resolveCompanionCollection({ id: parsed.collection, name: parsed.collection, floors: {} }, catalog)
    const showRequestedView = () => {
      if (viewMode === 'spread') inspection.inspector.show('spread')
      else if (viewMode === 'chart') inspection.showChart('7d')
      else inspection.inspector.show('overview')
    }
    if (selection && voiceItem()?.name === target.name) {
      showRequestedView()
      return parsed
    }
    const accepted =
      phone.open(
        target,
        () => {
          if (controls === phone && selection && voiceItem()?.name === target.name) {
            showRequestedView()
          }
        },
        selection ?? undefined,
      ) === true
    return accepted ? parsed : null
  }

  function onGlassesMenuLaunch() {
    if (catalog && controls && getTools()) {
      pendingGlassesMenuBrief = false
      openTools('summary', 'glasses')
      return
    }
    pendingGlassesMenuBrief = true
  }

  function onOverheardTranscript(transcript: string): boolean {
    if (
      !controls
      || !catalog
      || !controls.canUseVoiceTarget?.(selection)
      || (getTelegram()?.getSnapshot().screen.kind ?? 'idle') !== 'idle'
      || Boolean(getTools()?.getSnapshot())
    ) {
      return false
    }
    const norm = resolveDeepLinkMatchKey(transcript)
    if (!norm) return false
    const matched = Object.keys(catalog.collection_floors).find(name => {
      const k = resolveDeepLinkMatchKey(name)
      return k.length >= 4 && norm.includes(k)
    })
    if (!matched) return false
    return openGiftLink(matched, 'spread') !== null
  }

  return {
    companion,
    current,
    tap,
    move,
    openFavorites,
    back,
    loadArtwork,
    inspector: inspection.inspector,
    voiceNames,
    resolveVoice,
    getTelegram,
    getTools,
    setToolsForeground,
    openTools,
    shareChart,
    openGiftLink,
    onGlassesMenuLaunch,
    onOverheardTranscript,
    inputRevision: () => navigationRevision,
  }
}
