import type { CompanionTelegramControl, TelegramDailyComparison } from './telegram.ts'
import type { CompanionToolbox, CompanionToolSource } from './tools.ts'

export type CollectionPerformanceFilter = 'all' | 'gainers' | 'losers'

export interface ProviderFloors {
  getgems?: number | null
  portals?: number | null
  tonnel?: number | null
  mrkt?: number | null
  fragment?: number | null
  marketapp?: number | null
  last_update?: string | null
  [key: string]: unknown
}

export interface CollectionFloorsResponse {
  collection_floors: Record<string, ProviderFloors>
}

export interface CollectionItem {
  id: string
  name: string
  floors: ProviderFloors
}

export interface ModelItem {
  id: string
  name: string
  floors: ProviderFloors
  rarityPermille?: number
}

export interface CompanionFavorites {
  ready: boolean
  visible: boolean
  collections: ReadonlyArray<{ id: string; name: string }>
}

export interface CompanionFloorObservation {
  price: number
  changePercent: number | null
}

export type CompanionBrowseRow = Pick<CollectionItem, 'id' | 'name'> & { cachedFloor?: number }

export type CompanionChartRange = '24h' | '7d' | '30d'

export interface CompanionFloorSeries {
  from: number
  to: number
  interval: number
  points: readonly { time: number; price: number }[]
}

export interface VenueQuote {
  marketplace: string
  price: number
}

export type CompanionInspectionView =
  | ({ mode: 'preview'; model: string | null } & (
      | { status: 'loading' | 'empty' | 'error' }
      | {
          status: 'ready'
          frame: Uint8Array<ArrayBuffer>
          kind: 'model' | 'relief'
          angle: number
          canPrevious: boolean
          canNext: boolean
        }
    ))
  | ({ mode: 'chart'; range: CompanionChartRange } & (
      | { status: 'loading' | 'empty' | 'error' }
      | {
          status: 'ready'
          frame: Uint8Array<ArrayBuffer>
          series: CompanionFloorSeries
          low: number
          high: number
          last: number
          lastTime: number
          comparison?: TelegramDailyComparison
        }
    ))
  | ({ mode: 'spread' } & (
      | { status: 'loading' | 'empty' | 'error' }
      | {
          status: 'ready'
          frame: Uint8Array<ArrayBuffer>
          quotes: readonly VenueQuote[]
          spreadPercent: number | null
        }
    ))
  | ({ mode: 'variants' } & (
      | { status: 'loading' | 'empty' | 'error' }
      | { status: 'ready'; names: readonly string[]; index: number }
    ))

export type CompanionInspection =
  | { mode: 'overview' }
  | (CompanionInspectionView & { collection: string; fromVariants: boolean })

export interface CompanionInspector {
  getSnapshot(): CompanionInspection
  subscribe(listener: () => void): () => void
  show(mode: CompanionInspection['mode'], model?: string): void
  step(direction: -1 | 1, displayedFrame?: Uint8Array): void
  pickVariant(name?: string): void
  back(): void
  showChart?(range: CompanionChartRange): void
  setRange(range: CompanionChartRange): void
  retry(): void
}

export type CompanionDisplayStatus =
  | 'inactive'
  | 'opening'
  | 'waitingForHost'
  | 'reloadAvailable'
  | 'ready'
  | 'unavailable'
  | 'closed'

export type VoiceProblem = 'microphone' | 'micStop' | 'silence' | 'unknown' | 'recognition' | 'action'

export type CompanionVoiceState =
  | { phase: 'offline' | 'idle' | 'starting' | 'listening' | 'processing' }
  | { phase: 'error'; reason: VoiceProblem }
  | { phase: 'confirm'; label: string }
  | { phase: 'choices'; labels: readonly string[]; index: number }

export interface CompanionVoiceControl {
  getSnapshot(): CompanionVoiceState
  subscribe(listener: () => void): () => void
  start(source?: CompanionToolSource): void
  recordQuestion?(signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>
  activate(source?: CompanionToolSource): void
  step(direction: -1 | 1): void
  cancel(): void
}

export interface GlassesDeviceTelemetry {
  connected: boolean
  batteryLevel: number | null
  isCharging: boolean
  isWearing: boolean
  lastInputSource: 'glasses-r' | 'glasses-l' | 'ring' | 'phone' | null
}

export interface GlassesHudMirror {
  navigation: string
  header: string
  body: string
  footer: string
  menuItems: readonly string[]
  imageBytes: Uint8Array | null
  imageSize: { width: number; height: number } | null
  telemetry: GlassesDeviceTelemetry
}

export interface CompanionDisplayConnection {
  voice?: CompanionVoiceControl
  getSnapshot(): CompanionDisplayStatus
  getHudMirror?(): GlassesHudMirror | null
  subscribe(listener: () => void): () => void
  subscribeMirror?(listener: () => void): () => void
  open(): void
}

export interface CompanionFloorMarket {
  period: string
  filter: CollectionPerformanceFilter
  browse:
    | { status: 'rows'; rows: readonly CompanionBrowseRow[] }
    | { status: 'catalog' | 'loading' | 'error' }
  observations: ReadonlyMap<string, CompanionFloorObservation>
  stale: boolean
  retry(): void
}

export interface CollectionControls {
  loadCatalog(force?: boolean): Promise<CollectionFloorsResponse>
  loadArtwork(name: string, model?: string): Promise<Blob | null>
  loadFloorChart(name: string, range: CompanionChartRange, forceRetry?: boolean, signal?: AbortSignal): Promise<CompanionFloorSeries>
  loadVariants(name: string): Promise<readonly string[]>
  open(collection: CollectionItem, afterSelect?: () => void, voiceOrigin?: CollectionItem, signal?: AbortSignal): boolean | void
  canUseVoiceTarget?(selection: CollectionItem | null): boolean
  setFavorite(collection: CollectionItem, saved: boolean): void
  showFavorites(visible: boolean, voiceOrigin?: CollectionItem, signal?: AbortSignal): boolean | void
  backFromInspection?(): boolean
  back(): boolean
}

export interface CollectionCompanion {
  favoriteCollections?: {
    getSnapshot(): CompanionFavorites
    subscribe(listener: () => void): () => void
  }
  openToolChart?(collection: string, range: CompanionChartRange): boolean
  setTools?(tools: CompanionToolbox | null): void
  setTelegram?(control: CompanionTelegramControl | null): void
  inspector?: CompanionInspector
  displayConnection?: CompanionDisplayConnection
  connect(controls: CollectionControls): () => void
  catalogChanged(catalog: CollectionFloorsResponse): void
  marketChanged(market: CompanionFloorMarket | null): void
  rateChanged(usdtPerGram: number | null): void
  favoritesChanged(favorites: CompanionFavorites): void
  favoriteListChanged(rows: CompanionFavorites['collections'] | null): void
  select(collection: CollectionItem | null): void
}

export type MountTeleGifts = (
  root: HTMLElement,
  companion?: CollectionCompanion,
  simControls?: {
    tap(): void
    doubleTap(): void
    hold(source?: 'glasses-r' | 'ring'): void
    swipe(direction: -1 | 1): void
    menuSelect(label: string): void
  },
) => void
