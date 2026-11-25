import type { CollectionFloorsResponse, CollectionItem } from '../contracts/companion.ts'
import { getBundledCatalog } from './bundledMarketData.ts'

/**
 * Resolves an open `CollectionItem` against the latest catalog snapshot so open
 * detail sheets and price-watch presets always reflect refreshed venue floors.
 */
export function resolveSelectedCollectionFloors(
  selected: CollectionItem | null,
  catalog: CollectionFloorsResponse | null,
): CollectionItem | null {
  if (!selected) return null
  if (!catalog) return { ...selected, floors: {} }
  const latestFloors = catalog.collection_floors[selected.name]
  return { ...selected, floors: latestFloors ?? {} }
}

export interface CatalogSnapshotState {
  data: CollectionFloorsResponse
  isLive: boolean
  generation: number
}

export interface CatalogRefreshCoordinatorOptions {
  marketApiUrl?: string
  fetchImpl?: typeof fetch
  loadBundled?: () => CollectionFloorsResponse
  generationCounter?: { current: number }
  onPublish?: (next: CatalogSnapshotState) => void
}

/**
 * Coordinates market catalog refreshes with a monotonic generation fence and
 * explicit disposal so overlapping refreshes or retired coordinators never
 * publish out of order, while pairing every catalog update atomically with its
 * `isLive` provenance flag.
 */
export function createCatalogRefreshCoordinator(options: CatalogRefreshCoordinatorOptions = {}) {
  const fetchFn = options.fetchImpl ?? fetch
  const getFallback = options.loadBundled ?? getBundledCatalog
  const counter = options.generationCounter ?? { current: 0 }
  let disposed = false
  let state: CatalogSnapshotState = {
    data: getFallback(),
    isLive: false,
    generation: counter.current,
  }

  function publishIfNewest(gen: number, data: CollectionFloorsResponse, isLive: boolean): CatalogSnapshotState {
    if (disposed || gen < counter.current) {
      return state
    }
    state = { data, isLive, generation: gen }
    options.onPublish?.(state)
    return state
  }

  return {
    getState: () => state,
    dispose() {
      disposed = true
    },
    async refresh(): Promise<CollectionFloorsResponse> {
      if (disposed) return state.data
      const gen = ++counter.current
      const cleanUrl = options.marketApiUrl?.trim()
      if (cleanUrl) {
        try {
          const res = await fetchFn(`${cleanUrl.replace(/\/+$/, '')}/gifts/get_gifts_price_list`)
          if (res.ok) {
            const remote = (await res.json()) as CollectionFloorsResponse
            if (remote?.collection_floors && Object.keys(remote.collection_floors).length > 0) {
              return publishIfNewest(gen, remote, true).data
            }
          }
        } catch {
          // Fall back to deterministic bundled snapshot if still newest generation
        }
      }
      const bundled = getFallback()
      return publishIfNewest(gen, bundled, false).data
    },
  }
}

/**
 * React Strict Mode-safe lifecycle wrapper around `createCatalogRefreshCoordinator`.
 * Each effect `setup()` provisions a fresh usable coordinator sharing one monotonic
 * `generationCounter`, while cleanup disposes only that setup's coordinator so
 * Strict Mode's mount -> cleanup -> setup replay continues fetching and publishing
 * live catalog updates.
 */
export function createCatalogRefreshLifecycle(
  options: Omit<CatalogRefreshCoordinatorOptions, 'generationCounter'> = {},
) {
  const generationCounter = { current: 0 }
  const getFallback = options.loadBundled ?? getBundledCatalog
  let activeCoordinator: ReturnType<typeof createCatalogRefreshCoordinator> | null = null
  let mounted = true
  let latestState: CatalogSnapshotState = {
    data: getFallback(),
    isLive: false,
    generation: 0,
  }

  function ensureActive() {
    if (!activeCoordinator) {
      activeCoordinator = createCatalogRefreshCoordinator({
        ...options,
        generationCounter,
        onPublish: nextState => {
          if (!mounted) return
          latestState = nextState
          options.onPublish?.(nextState)
        },
      })
    }
    return activeCoordinator
  }

  return {
    setup() {
      mounted = true
      const coordinator = ensureActive()
      return () => {
        mounted = false
        generationCounter.current += 1
        coordinator.dispose()
        if (activeCoordinator === coordinator) {
          activeCoordinator = null
        }
      }
    },
    refresh(): Promise<CollectionFloorsResponse> {
      if (!mounted) {
        return Promise.resolve(latestState.data)
      }
      return ensureActive().refresh()
    },
    getState(): CatalogSnapshotState {
      return latestState
    },
  }
}
