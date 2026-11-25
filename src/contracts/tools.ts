import type { CompanionFloorSeries } from './companion.ts'

export interface CompanionToolPage {
  key: string
  title: string
  lines: readonly string[]
  actions: readonly { id: string; label: string; requiresConfirmation?: boolean }[]
  browse?: { open: string; previous?: string; next?: string; swipeHint?: string }
  chart?: { collection: string; series: CompanionFloorSeries }
  framePixels?: Uint8Array
}

export interface CompanionToolContext {
  collection?: string
  entry?: 'talk'
}

export interface CompanionToolController {
  getSnapshot(): CompanionToolPage
  subscribe(listener: () => void): () => void
  open(context?: CompanionToolContext): void
  act(id: string): void
  back(): boolean
  suspend?(): void
  setForegroundAvailable?(visible: boolean): void
  close(): void
}

export type CompanionToolName =
  | 'digest'
  | 'favorite-movers'
  | 'threshold'
  | 'spread-radar'
  | 'gifti'
  | 'research'
  | 'watchlist'
  | 'market-note'
  | 'summary'

export type CompanionToolSource = 'glasses' | 'phone'

export interface CompanionToolbox {
  getSnapshot(): CompanionToolPage | null
  getActiveTool?(): CompanionToolName | undefined
  supportsTool?(name: CompanionToolName): boolean
  getPhoneSnapshot(): CompanionToolPage | null
  subscribe(listener: () => void): () => void
  open(name?: CompanionToolName, context?: CompanionToolContext, source?: CompanionToolSource): boolean
  act(page: CompanionToolPage, id: string): boolean
  back(): void
  suspend(): void
  setForeground?(source: 'display' | 'document', visible: boolean): void
  close(): void
}
