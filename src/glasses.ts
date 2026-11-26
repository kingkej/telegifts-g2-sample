import {
  AudioInputSource,
  AudioSpeakerRole,
  CreateStartUpPageContainer,
  DeviceConnectType,
  EventSourceType,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ImuReportPace,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { formatObservedAt, formatPrice, type Screen } from './catalog.ts'
import { formatCompanionUsdtEstimate, formatMarketChange } from './lib/format.ts'
import type {
  CompanionInspection,
  CompanionInspector,
  GlassesDeviceTelemetry,
  GlassesHudMirror,
} from './contracts/companion.ts'
import type { CompanionTelegramControl, TelegramScreen, TelegramShareTarget } from './contracts/telegram.ts'
import type { CompanionToolbox, CompanionToolName, CompanionToolPage, CompanionToolSource } from './contracts/tools.ts'
import { Utterance, type GlassesVoice } from './voiceControl.ts'
import { encodeFrame, frameHeight, frameWidth } from './inspection.ts'
import { chartSamples, renderFloorChart } from './floorChart.ts'
import { GlassesRebuildPending, GlassesReloadRequired } from './glassesConnection.ts'
import { followUpAnswerPages, toolView } from './toolDisplay.ts'
import { nativeMenuLabel } from './displayText.ts'
import { telegramPage } from './telegramDisplay.ts'
import { artworkSize, buildHudContainers, imageContainer, type HudRegions } from './hudLayout.ts'
import { createImuGestureClassifier } from './imuGestureTriage.ts'
import {
  getG2HardwarePreferences,
  subscribeG2HardwarePreferences,
  subscribeLaunchSource,
  syncEvenHostStorage,
} from './services/evenHostStorage.ts'

const startupState = new WeakMap<object, 'unconfirmed' | 'created' | 'recovered' | 'refused'>()
const rebuilding = new WeakSet<object>()
const rebuildTimeoutMs = 12_000

type NativeMenuItem =
  | NonNullable<GlassPage['voiceMenuItem']>
  | 'Voice command'
  | 'Questions'
  | 'Channel digest'
  | 'Venue spread'
  | 'Send to my Telegram'
  | 'Reply with chart'
  | 'Reply with comparison'
  | 'Send'
  | 'Send reply'
  | 'Save to DM'
  | 'Cancel'
  | 'Refresh questions'
  | 'Companion tools'
  | 'Talk to Gifti'
  | 'Show chart'
  | 'Back'
  | 'Refresh tasks'
  | 'Refresh movers'
  | 'Retry chart'
  | { id: string; label: string }

let nextCaptureID = 3 + Math.floor(Math.random() * 0x40000000)

function nativeMenuAvailable(item: NativeMenuItem, phoneVisible: boolean) {
  return phoneVisible || item === 'Back' || item === 'Cancel' || item === 'Retry chart'
}

function newCaptureTarget(page: GlassPage, hasVoice: boolean) {
  const containerID = nextCaptureID++
  const headerID = nextCaptureID++
  const footerID = nextCaptureID++
  const menu = new Map<number, NativeMenuItem>()
  for (const item of nativeMenu(page, hasVoice)) {
    if (nativeMenuAvailable(item, page.phoneVisible !== false)) menu.set(nextCaptureID++, item)
  }
  return {
    text: { containerID, containerName: 'tg-' + containerID.toString(36) },
    header: { containerID: headerID, containerName: 'tgh-' + headerID.toString(36) },
    footer: { containerID: footerID, containerName: 'tgf-' + footerID.toString(36) },
    menu,
  }
}

type CaptureTarget = ReturnType<typeof newCaptureTarget>

interface GlassPage {
  name: string | null
  id: string | null
  list: string
  position?: number
  total?: number
  variantName?: string
  fromVariants?: boolean
  foregroundRevision?: number
  phoneVisible?: boolean
  telegram?: CompanionTelegramControl
  telegramRevision?: number
  telegramPrompt?: Extract<TelegramScreen, { kind: 'confirm' | 'result' }>
  tools?: CompanionToolbox
  toolName?: CompanionToolName
  toolPage?: CompanionToolPage
  retryChartSeries?: NonNullable<CompanionToolPage['chart']>['series'] | Uint8Array
  toolAction?: CompanionToolPage['actions'][number]
  voiceMenuItem?: 'Finish recording' | 'Retry voice' | 'Confirm save' | 'Choose gift'
  navigation:
    | 'waiting'
    | 'root'
    | 'favorites'
    | 'detail'
    | 'preview'
    | 'chart'
    | 'spread'
    | 'variants'
    | 'menu'
    | 'voice'
    | 'telegram'
    | 'tool'
  tapAction:
    | 'open'
    | 'save'
    | 'remove'
    | 'retry'
    | 'retryMarket'
    | 'preview'
    | 'chart'
    | 'spread'
    | 'pickVariant'
    | 'retryInspection'
    | 'resume'
    | 'favorites'
    | 'exit'
    | 'startVoice'
    | 'voiceAction'
    | 'questions'
    | 'digest'
    | 'telegramActivate'
    | 'telegramBack'
    | 'telegramComposeSend'
    | 'tools'
    | null
  inspectionFrame?: Uint8Array
  regions?: HudRegions
  content: string
}

type NavigationMenu = { origin: 'root' | 'waiting'; index: number }
const exploreMenu = [
  { label: 'Explore gifts', action: 'resume' },
  { label: 'Favorites', action: 'favorites' },
  { label: 'Exit TeleGifts', action: 'exit' },
] as const
const setupMenu = [{ label: 'Continue setup on phone', action: 'resume' }, exploreMenu[2]] as const

function menuPage(
  { origin, index }: NavigationMenu,
  hasVoice: boolean,
  questionCount?: number,
  hasDigest = false,
  hasTools = false,
): GlassPage {
  const items =
    origin === 'waiting'
      ? setupMenu
      : [
          exploreMenu[0],
          exploreMenu[1],
          ...(questionCount === undefined
            ? []
            : [{ label: questionCount ? 'Questions (' + questionCount + ')' : 'Questions', action: 'questions' } as const]),
          ...(hasDigest ? [{ label: 'Channel digest', action: 'digest' } as const] : []),
          ...(hasTools ? [{ label: 'Companion tools', action: 'tools' } as const] : []),
          ...(hasVoice ? [{ label: 'Voice command', action: 'startVoice' } as const] : []),
          exploreMenu[2],
        ]
  index = Math.min(index, items.length - 1)
  const lines = items.map((item, i) => (i === index ? '> ' : '  ') + item.label)
  return {
    navigation: 'menu',
    name: null,
    id: null,
    list: origin,
    position: index,
    total: items.length,
    tapAction: items[index]!.action,
    content: ['TeleGifts menu', '', ...lines, '', 'Swipe to choose · Tap to select', 'Double-tap to return'].join('\n'),
  }
}

function voicePage(voice: GlassesVoice, tool: CompanionToolPage | null, answerCursor: number): GlassPage | null {
  const question = voice.getQuestionSnapshot()
  const state = question ?? voice.controls.getSnapshot()
  if (state.phase === 'offline' || state.phase === 'idle') return null
  const followUp = question && tool?.key === 'gifti-recording' && tool.lines.length > 1 ? tool : undefined
  const lines: string[] = []
  let total: number | undefined
  if (followUp) {
    const pages = followUpAnswerPages(followUp.title, followUp.lines[0]!)
    total = pages.length
    answerCursor = Math.max(0, Math.min(answerCursor, total - 1))
    lines.push(...pages[answerCursor]!)
  } else lines.push(question ? 'Record question' : 'Voice command', '')
  let tapAction: GlassPage['tapAction'] = 'voiceAction'
  let voiceMenuItem: GlassPage['voiceMenuItem']
  switch (state.phase) {
    case 'starting':
      lines.push('Opening glasses microphone…')
      tapAction = null
      break
    case 'listening':
      voiceMenuItem = 'Finish recording'
      if (followUp) lines.push('Listening for your follow-up…', 'Pause or use Finish recording')
      else
        lines.push(
          'Listening…',
          question ? 'Speak, then pause to finish (25s max).' : 'Try “show the floor chart”',
          '',
          'Menu → Finish recording',
        )
      break
    case 'processing':
      lines.push(question ? 'Closing glasses microphone…' : 'Recognizing command…')
      tapAction = null
      break
    case 'error': {
      const messages = {
        microphone: 'Check microphone access in Even.',
        micStop: 'Microphone did not close.\nClose TeleGifts in Even if it stays on.',
        silence: 'No speech heard.',
        unknown: 'Command not recognized.',
        recognition: 'Speech recognition unavailable.',
        action: 'Unavailable on this screen.',
      }
      voiceMenuItem = 'Retry voice'
      lines.push(messages[state.reason], 'Try “show the floor chart”', '', 'Menu → Retry voice')
      break
    }
    case 'confirm':
      voiceMenuItem = 'Confirm save'
      lines.push(state.label, '', 'Menu → Confirm save')
      break
    case 'choices':
      voiceMenuItem = 'Choose gift'
      lines.push(
        'Which collection?',
        state.labels[state.index] ?? '',
        state.index + 1 + ' / ' + state.labels.length,
        '',
        'Swipe to browse · Menu → Choose gift',
      )
      break
  }
  lines.push(question ? 'Double-tap to cancel' : 'Double-tap to return')
  return {
    navigation: 'voice',
    tapAction,
    voiceMenuItem,
    list: 'voice-' + voice.revision(),
    id: null,
    name: null,
    content: lines.join('\n'),
    toolPage: followUp,
    position: followUp ? answerCursor : undefined,
    total,
  }
}

function inspectionPage(
  name: string,
  id: string,
  view: Exclude<CompanionInspection, { mode: 'overview' }>,
  hasTelegram: boolean,
): GlassPage {
  if (view.mode === 'variants') {
    const ready = view.status === 'ready' && view.names[view.index] !== undefined
    const variantName = ready ? view.names[view.index] : undefined
    const retryable = view.status === 'empty' || view.status === 'error'
    const lines = [name, 'Models' + (ready ? '   ' + (view.index + 1) + ' / ' + view.names.length : ''), '']
    if (variantName !== undefined) lines.push(variantName, '', 'Swipe to browse · Tap for 3D preview')
    else lines.push(view.status === 'loading' ? 'Loading models…' : view.status === 'error' ? 'Models unavailable' : 'No models available')
    if (retryable) lines.push('Tap to retry')
    lines.push('Double-tap for details')
    return {
      name,
      id,
      list: 'variants',
      navigation: 'variants',
      variantName,
      content: lines.join('\n'),
      position: ready ? view.index : undefined,
      total: ready ? view.names.length : undefined,
      tapAction: ready ? 'pickVariant' : retryable ? 'retryInspection' : null,
    }
  }

  if (view.mode === 'spread') {
    const header = `SPREAD · ${name}`
    const bodyLines: string[] = []
    let tapAction: GlassPage['tapAction'] = null
    if (view.status === 'ready') {
      const best = view.quotes[0]
      const high = view.quotes.at(-1)
      if (best) bodyLines.push(`Best: ${best.marketplace} ${formatPrice(best.price)}`)
      if (high && view.quotes.length >= 2 && view.spreadPercent !== null) {
        bodyLines.push(`High: ${high.marketplace} ${formatPrice(high.price)} (+${view.spreadPercent.toFixed(1)}%)`)
      }
      bodyLines.push(`${view.quotes.length} active venues`)
      tapAction = 'chart'
    } else if (view.status === 'loading') {
      bodyLines.push('Loading venue quotes…')
    } else {
      bodyLines.push('Venue quotes unavailable')
      tapAction = 'retryInspection'
    }
    const footer =
      tapAction === 'retryInspection'
        ? 'Tap: Retry · 2×Tap: Details'
        : 'Tap: Floor chart · Swipe: Floor chart · 2×Tap: Details'
    const content = [header, ...bodyLines, '', footer].join('\n')
    return {
      name,
      id,
      list: JSON.stringify([name, 'spread']),
      navigation: 'spread',
      tapAction,
      content,
      fromVariants: view.fromVariants,
      inspectionFrame: view.status === 'ready' ? view.frame : undefined,
      regions: { header, body: bodyLines.join('\n'), footer },
    }
  }

  const model = view.mode === 'preview' ? view.model : null
  const lines = [model ?? name]
  if (model) lines.push(name)
  let tapAction: GlassPage['tapAction'] = null
  if (view.mode === 'chart') {
    lines.push('Collection floor · ' + view.range + ' UTC')
    if (view.status === 'ready') {
      lines.push('Last ' + formatPrice(view.last), 'High ' + formatPrice(view.high), 'Low ' + formatPrice(view.low))
      tapAction = 'preview'
    }
  } else if (view.status === 'ready') {
    lines.push(view.kind === 'model' ? '3D model' : 'Artwork relief')
    tapAction = 'chart'
  } else lines.push('3D preview')
  if (view.status === 'loading') lines.push('Loading…')
  if (view.status === 'empty' || view.status === 'error') {
    lines.push(
      view.mode === 'preview' ? 'Artwork unavailable' : view.status === 'empty' ? 'No floor observations' : 'History unavailable',
    )
    tapAction = 'retryInspection'
  }
  lines.push('')
  if (view.mode === 'chart') {
    lines.push('Swipe to change range')
    if (view.status === 'ready' && hasTelegram) lines.push('Menu to share')
  } else if (view.status === 'ready') lines.push('Swipe to rotate')
  if (tapAction)
    lines.push(tapAction === 'retryInspection' ? 'Tap to retry' : tapAction === 'chart' ? 'Tap for floor chart' : 'Tap for 3D preview')
  if (view.mode === 'preview' && !view.fromVariants) lines.push('Hold for models')
  lines.push(view.fromVariants ? 'Double-tap for models' : 'Double-tap for details')
  return {
    name,
    id,
    list: JSON.stringify([name, view.mode, view.mode === 'chart' ? view.range : model]),
    navigation: view.mode,
    tapAction,
    content: lines.join('\n'),
    fromVariants: view.fromVariants,
    inspectionFrame: view.status === 'ready' ? view.frame : undefined,
  }
}

const inspecting = (page: GlassPage) =>
  page.navigation === 'preview'
  || page.navigation === 'chart'
  || page.navigation === 'spread'
  || page.navigation === 'variants'
const usesFrame = (page: GlassPage) => inspecting(page) || Boolean(page.toolPage?.chart || page.toolPage?.framePixels)

function sameRegions(a: GlassPage, b: GlassPage) {
  return Boolean(a.regions?.header) === Boolean(b.regions?.header) && Boolean(a.regions?.footer) === Boolean(b.regions?.footer)
}

function sameActions(a: GlassPage, b: GlassPage) {
  return (
    a.navigation === b.navigation
    && a.id === b.id
    && a.name === b.name
    && a.tapAction === b.tapAction
    && a.list === b.list
    && a.position === b.position
    && a.total === b.total
    && a.variantName === b.variantName
    && a.fromVariants === b.fromVariants
    && a.foregroundRevision === b.foregroundRevision
    && a.telegram === b.telegram
    && a.telegramRevision === b.telegramRevision
    && a.telegramPrompt === b.telegramPrompt
    && a.tools === b.tools
    && a.toolName === b.toolName
    && a.toolPage === b.toolPage
    && a.toolAction?.id === b.toolAction?.id
    && a.retryChartSeries === b.retryChartSeries
    && sameRegions(a, b)
    && (a.navigation !== 'telegram' || a.content === b.content)
    && (a.navigation !== 'chart' || !a.telegram || a.inspectionFrame === b.inspectionFrame)
  )
}

function glassPage(screen: Screen, hasTelegram = false): GlassPage {
  const favorites = screen.section === 'favorites'
  const ranking = screen.ranking
  let title = favorites ? 'Favorites' : 'Explore Gifts'
  if (!favorites && ranking && ranking.filter !== 'all') {
    title = ranking.period + (ranking.filter === 'gainers' ? ' Gainers' : ' Losers')
  }
  const navigation = favorites ? 'favorites' : 'root'
  if (screen.status === 'ready' || screen.status === 'unpriced') {
    const name = screen.status === 'ready' ? screen.collection.name : screen.name
    const id = screen.id
    if (screen.detail && screen.inspection && screen.inspection.mode !== 'overview' && screen.inspection.collection === name) {
      return inspectionPage(name, id, screen.inspection, hasTelegram)
    }
    const floor = screen.status === 'ready' ? screen.collection.floor : null
    const observed = screen.observation
    const price = !screen.detail && !favorites ? observed?.price ?? screen.cachedFloor ?? floor?.price ?? null : floor?.price ?? null
    const estimate = formatCompanionUsdtEstimate(price, screen.usdtPerGram)
    const marketLines: string[] = []
    if (estimate !== '--') marketLines.push('≈ ' + estimate + ' USDT')
    if (observed) {
      const change = observed.changePercent === null ? '—' : formatMarketChange(observed.changePercent)
      marketLines.push(observed.period + ' floor change ' + change + (observed.stale ? ' (cached)' : ''))
    }
    if (!screen.detail) {
      const content = [
        title + '   ' + screen.position + ' / ' + screen.total,
        '',
        name,
        price !== null ? (screen.cachedFloor != null ? 'Cached floor: ' : '') + formatPrice(price) : 'Floor unavailable',
        ...marketLines,
        '',
        screen.total > 1 ? 'Swipe to browse · Tap for details' : 'Tap for details',
        favorites ? 'Double-tap for Explore' : 'Hold for Favorites · Double-tap for menu',
      ].join('\n')
      return { name, id, list: title, position: screen.position, total: screen.total, navigation, tapAction: 'open', content }
    }
    const lines = [name]
    if (floor) lines.push('Listing floor: ' + formatPrice(floor.price))
    else lines.push('Floor unavailable')
    lines.push(...marketLines)
    if (floor) lines.push('Marketplace: ' + floor.marketplace)
    if (screen.status === 'ready' && screen.collection.updatedAt) {
      lines.push('Collection updated ' + formatObservedAt(screen.collection.updatedAt))
    }
    const tapAction = screen.saved === null ? null : screen.saved ? 'remove' : 'save'
    const hint = { save: 'Tap to add to Favorites', remove: 'Saved to Favorites · Tap to remove' }
    lines.push(
      tapAction ? hint[tapAction] : 'Loading Favorites…',
      'Swipe up for 3D · Down for chart',
      'Hold for models',
      'Double-tap to return',
    )
    return { name, id, list: title, navigation: 'detail', tapAction, content: lines.join('\n') }
  }
  const messages = {
    waiting: 'Open TeleGifts on your phone',
    loading: favorites ? 'Loading saved collections…' : 'Loading collection prices…',
    empty: favorites
      ? 'No saved collections yet.\n\nOpen a collection in Explore, then tap to save it.'
      : 'No collection floors available.\n\nTap to refresh',
    error: 'Collection prices unavailable.\n\nTap to retry',
    noMatches: 'No matching collections.\n\nAdjust ' + (favorites ? 'Favorites' : 'Explore') + ' filters on your phone.',
    rankingLoading: 'Loading collection rankings…',
    rankingError: 'Collection rankings unavailable.\n\nTap to retry',
  }
  const lines = [title, '', messages[screen.status]]
  lines.push(
    '',
    screen.status === 'waiting'
      ? 'Double-tap for menu'
      : favorites
        ? 'Double-tap for Explore'
        : 'Hold for Favorites · Double-tap for menu',
  )
  return {
    name: null,
    id: null,
    list: title,
    navigation: screen.status === 'waiting' ? 'waiting' : navigation,
    tapAction:
      screen.status === 'rankingError'
        ? 'retryMarket'
        : !favorites && (screen.status === 'empty' || screen.status === 'error')
          ? 'retry'
          : null,
    content: lines.join('\n'),
  }
}

function nativeMenu(page: GlassPage, hasVoice: boolean): NativeMenuItem[] {
  if (page.navigation === 'waiting' || (page.navigation === 'menu' && page.list === 'waiting')) return []
  if (page.navigation === 'voice') {
    const actions: NativeMenuItem[] = page.voiceMenuItem ? [page.voiceMenuItem] : []
    if (page.toolPage?.actions.some(action => action.id === 'show-chart')) actions.push('Show chart')
    return actions
  }
  if (page.navigation === 'tool') {
    const actions: NativeMenuItem[] = []
    if (page.retryChartSeries) actions.push('Retry chart')
    if (page.toolAction?.requiresConfirmation) actions.push(page.toolAction)
    if (page.toolPage?.browse) {
      const browseIds = new Set([
        page.toolPage.browse.open,
        page.toolPage.browse.previous,
        page.toolPage.browse.next,
        'refresh',
      ])
      let extraCount = 0
      for (const extra of page.toolPage.actions) {
        if (!browseIds.has(extra.id) && extraCount < 4) {
          extraCount++
          actions.push({ id: extra.id, label: extra.label })
        }
      }
    }
    if (page.toolPage?.browse && page.toolPage.actions.some(action => action.id === 'refresh' && !action.requiresConfirmation))
      actions.push(page.toolName === 'favorite-movers' ? 'Refresh movers' : 'Refresh tasks')
    if (hasVoice && page.toolName !== 'gifti') actions.push('Voice command')
    actions.push('Back')
    return actions
  }
  if (page.navigation === 'telegram') {
    if (page.list === 'confirm') return ['Send', 'Cancel']
    if (page.list.startsWith('compose-')) return ['Send reply', 'Cancel']
    if (page.list.startsWith('digest-')) return ['Save to DM', 'Cancel']
    return page.list === 'questions' ? ['Refresh questions'] : []
  }
  const items: NativeMenuItem[] = hasVoice ? ['Voice command'] : []
  if (hasVoice && page.tools && page.tools.supportsTool?.('gifti') !== false && page.navigation === 'detail') {
    items.unshift('Talk to Gifti')
  }
  if (page.tools) items.push('Companion tools')
  if ((page.tools || page.telegram) && (page.navigation === 'detail' || page.navigation === 'chart')) {
    items.push('Venue spread')
  }
  if (page.telegram) {
    if (page.navigation === 'root' || page.navigation === 'favorites') {
      items.push('Questions')
      if (page.telegram.openDigest) items.push('Channel digest')
    }
    if (page.navigation === 'chart' && page.inspectionFrame) {
      items.push('Send to my Telegram', 'Reply with chart', 'Reply with comparison')
    }
  }
  return items
}

function containers(page: GlassPage, withArtwork: boolean, target: CaptureTarget) {
  return buildHudContainers({
    content: page.content,
    regions: page.regions,
    withArtwork,
    largeFrame: usesFrame(page),
    target: {
      body: target.text,
      header: target.header,
      footer: target.footer,
      menu: target.menu,
    },
  })
}

async function fitArtwork(blob: Blob): Promise<Uint8Array | null> {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) return null

    const canvas = document.createElement('canvas')
    canvas.width = artworkSize
    canvas.height = artworkSize
    const context = canvas.getContext('2d')
    if (!context) return null
    const scale = artworkSize / Math.max(image.naturalWidth, image.naturalHeight)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    context.fillStyle = 'black'
    context.fillRect(0, 0, artworkSize, artworkSize)
    context.drawImage(image, Math.floor((artworkSize - width) / 2), Math.floor((artworkSize - height) / 2), width, height)
    const png = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
    return png && new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface ArtworkRequest {
  name: string
  bytes: Uint8Array | null
}

export interface GlassesControls {
  voice?: GlassesVoice
  getTelegram?(): CompanionTelegramControl | null
  getTools?(): CompanionToolbox | null
  setToolsForeground?(source: 'native' | 'document', visible: boolean): void
  openTools?(name?: CompanionToolName, source?: CompanionToolSource, entry?: 'talk'): boolean
  shareChart?(target: TelegramShareTarget, displayedFrame: Uint8Array): boolean
  inputRevision?(): number
  inspector: CompanionInspector
  current(): Screen
  tap(): void
  move(direction: -1 | 1): void
  openFavorites(): void
  back(): boolean
  showDisplayError(failed: boolean): void
  loadArtwork(name: string): Promise<Blob | null>
  voiceNames?(): readonly string[]
  transcribeOverheard?(
    pcm: Uint8Array<ArrayBuffer>,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<string | null>
  transcribeDictation?(
    pcm: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<string | null>
  onGlassesMenuLaunch?(): void
  onOverheardTranscript?(transcript: string): void
  onMirrorChange?(mirror: GlassesHudMirror | null): void
}

export async function connectGlasses(
  {
    current,
    tap,
    move,
    openFavorites,
    back,
    showDisplayError,
    loadArtwork,
    inspector,
    voice: configuredVoice,
    voiceNames,
    transcribeOverheard,
    transcribeDictation,
    getTelegram,
    shareChart,
    getTools,
    setToolsForeground,
    openTools,
    inputRevision,
    onGlassesMenuLaunch,
    onOverheardTranscript,
    onMirrorChange,
  }: GlassesControls,
  onClosed: () => void = () => {},
  onStartupRebuild?: () => void,
) {
  const bridge = await waitForEvenAppBridge()
  if (rebuilding.has(bridge)) throw new GlassesRebuildPending()
  const previousStartup = startupState.get(bridge)
  let voice =
    typeof bridge.audioControl === 'function' && (!previousStartup || previousStartup === 'created')
      ? configuredVoice
      : undefined
  let started = false
  let menuOverlayOpen = false
  let foreground = true
  let foregroundRevision = 0
  let pageHidden = false
  let menu: NavigationMenu | null = null
  let submittedPrompt: TelegramScreen | undefined
  let submittedComposeId: string | null = null
  let visibleTool: CompanionToolPage | null = null
  let toolCursor = 0
  let answerCursor = 0
  type ToolFrameSource = NonNullable<CompanionToolPage['chart']>['series'] | Uint8Array
  let toolChart: { source: ToolFrameSource; frame?: Uint8Array; issue?: 'empty' | 'failed' } | undefined
  let submittedTool: CompanionToolPage | undefined

  const telemetry: GlassesDeviceTelemetry = {
    connected: true,
    batteryLevel: null,
    isCharging: false,
    isWearing: true,
    lastInputSource: null,
  }

  let composePtt: {
    composeId: string
    utterance: Utterance
    abort: AbortController
  } | null = null
  let activeComposeTranscribe: {
    composeId: string
    abort: AbortController
  } | null = null
  let pttWantMicOpen = false
  let pttMicOpenConfirmed = false
  let pttMicChain: Promise<boolean> = Promise.resolve(true)

  const initial = currentPage()
  let target = newCaptureTarget(initial, Boolean(voice))
  let acknowledged = initial
  let textConfirmed = true
  let desired = initial
  let writingPage: GlassPage | null = null
  let hasImageContainer = false
  let artwork: ArtworkRequest | null = null
  let uploaded: Uint8Array | null = null
  let renderFailed = false
  let closed = false
  let exitRequest: Promise<void> | null = null
  let unbindVoice: (() => Promise<boolean>) | undefined
  let unsubscribeVoice: (() => void) | undefined
  let unsubscribeLaunchSource: (() => void) | undefined
  let unsubscribeHwPrefs: (() => void) | undefined
  let imuStreamDesired = false
  let imuStreamConfirmed = false
  let imuSyncInFlight = false
  let imuChain: Promise<void> = Promise.resolve()
  const imuClassifier = createImuGestureClassifier()
  let overheardUtterance: Utterance | null = null
  let activeOverheardAbort: AbortController | null = null
  let irlListenSession: { timer: ReturnType<typeof setTimeout>; abort: AbortController } | null = null

  function isImuAlertPage(page: GlassPage): boolean {
    return (
      page.navigation === 'telegram'
      && (page.list.startsWith('heads-up-') || page.list.startsWith('digest-watch-'))
    )
  }

  function syncImuStream() {
    if (typeof bridge.imuControl !== 'function') return
    const want =
      !closed
      && started
      && foreground
      && documentVisible()
      && getG2HardwarePreferences().imuTriageEnabled
      && isImuAlertPage(acknowledged)
    if (want === imuStreamDesired && want === imuStreamConfirmed && !imuSyncInFlight) return
    imuStreamDesired = want
    if (!want) imuClassifier.reset()
    imuSyncInFlight = true
    imuChain = imuChain.then(async () => {
      try {
        if (imuStreamDesired === imuStreamConfirmed) return
        if (imuStreamDesired) {
          imuStreamConfirmed = true
          const opened = await bridge.imuControl(true, ImuReportPace.P200).catch(() => false)
          if (!opened) {
            imuStreamConfirmed = false
            return
          }
          if (!imuStreamDesired) {
            let closedLate = await bridge.imuControl(false).catch(() => false)
            if (!closedLate && !imuStreamDesired) {
              closedLate = await bridge.imuControl(false).catch(() => false)
            }
            if (closedLate) imuStreamConfirmed = false
          }
        } else {
          let closedOk = await bridge.imuControl(false).catch(() => false)
          if (!closedOk && !imuStreamDesired) {
            closedOk = await bridge.imuControl(false).catch(() => false)
          }
          if (closedOk) imuStreamConfirmed = false
        }
      } finally {
        imuSyncInFlight = false
      }
    })
  }

  function isWearerVoiceBusy(): boolean {
    if (composePtt || activeComposeTranscribe) return true
    if (!voice) return false
    if (voice.getQuestionSnapshot()) return true
    return voice.controls.getSnapshot().phase !== 'idle'
  }

  function stopIrlListen(abortTranscription = true) {
    overheardUtterance = null
    if (abortTranscription && activeOverheardAbort) {
      activeOverheardAbort.abort()
      activeOverheardAbort = null
    }
    if (irlListenSession) {
      clearTimeout(irlListenSession.timer)
      irlListenSession.abort.abort()
      irlListenSession = null
      if (!composePtt) void enqueuePttMicClose()
    }
  }

  function startIrlListen(durationMs = 12_000): boolean {
    if (
      closed
      || !started
      || !inputVisible()
      || isWearerVoiceBusy()
      || !onOverheardTranscript
      || (!transcribeOverheard && !voice)
      || typeof bridge.audioControl !== 'function'
    ) {
      return false
    }
    stopIrlListen(true)
    const boundedMs = Math.min(20_000, Math.max(1_000, Math.trunc(durationMs)))
    const abort = new AbortController()
    const timer = setTimeout(() => {
      if (irlListenSession?.abort === abort) {
        stopIrlListen(false)
      }
    }, boundedMs)
    const sessionObj = { timer, abort }
    irlListenSession = sessionObj
    overheardUtterance = new Utterance(Math.ceil(boundedMs / 1000))
    pttWantMicOpen = true
    pttMicChain = pttMicChain.then(async () => {
      if (!pttWantMicOpen || irlListenSession !== sessionObj || abort.signal.aborted || isWearerVoiceBusy()) {
        return false
      }
      pttMicOpenConfirmed = true
      const opened = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false)
      if (!opened) {
        pttMicOpenConfirmed = false
        if (irlListenSession === sessionObj) {
          clearTimeout(sessionObj.timer)
          irlListenSession = null
        }
        return false
      }
      if (!pttWantMicOpen || irlListenSession !== sessionObj || abort.signal.aborted || isWearerVoiceBusy()) {
        let closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
        if (!closedLate) closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
        if (closedLate) pttMicOpenConfirmed = false
        return false
      }
      return true
    })
    return true
  }

  function emitMirror() {
    if (!onMirrorChange) return
    if (closed) {
      onMirrorChange({ ...buildMirror(acknowledged), telemetry: { ...telemetry, connected: false } })
      return
    }
    onMirrorChange(buildMirror(acknowledged))
  }

  function buildMirror(page: GlassPage): GlassesHudMirror {
    const menuItems = Array.from(target.menu.values()).map(item =>
      nativeMenuLabel(typeof item === 'string' ? item : item.label),
    )
    const large = usesFrame(page)
    return {
      navigation: page.navigation,
      header: page.regions?.header ?? '',
      body: page.regions?.body ?? page.content,
      footer: page.regions?.footer ?? '',
      menuItems,
      imageBytes: hasImageContainer ? uploaded : null,
      imageSize: hasImageContainer && uploaded ? { width: large ? frameWidth : artworkSize, height: large ? frameHeight : artworkSize } : null,
      telemetry: { ...telemetry },
    }
  }

  function enqueuePttMicClose(): Promise<boolean> {
    pttWantMicOpen = false
    if (typeof bridge.audioControl !== 'function') return Promise.resolve(true)
    pttMicChain = pttMicChain.then(async () => {
      if (pttWantMicOpen) return false
      if (!pttMicOpenConfirmed) return true
      let closedOk = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
      if (!closedOk && !pttWantMicOpen) {
        closedOk = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
      }
      if (closedOk) pttMicOpenConfirmed = false
      return closedOk
    })
    return pttMicChain
  }

  function stopComposePtt() {
    if (composePtt) {
      composePtt.abort.abort()
      composePtt = null
    }
    if (activeComposeTranscribe) {
      activeComposeTranscribe.abort.abort()
      activeComposeTranscribe = null
    }
    void enqueuePttMicClose()
  }

  function currentPage(): GlassPage {
    const screen = current()
    const phoneVisible = documentVisible()
    const telegram = screen.status === 'waiting' ? undefined : getTelegram?.() ?? undefined
    const tools = screen.status === 'waiting' ? undefined : getTools?.() ?? undefined
    const tool = tools?.getSnapshot() ?? null
    if (tool !== visibleTool) {
      visibleTool = tool
      toolCursor = 0
      answerCursor = 0
    }
    const page = glassPage(screen, Boolean(telegram))
    const snapshot = telegram?.getSnapshot()
    const overlay =
      snapshot && telegramPage(snapshot, page.navigation === 'chart' && 'inspection' in screen ? screen.inspection : undefined)
    if (menu && (page.navigation !== menu.origin || overlay || tool)) menu = null
    const listening = voice && voicePage(voice, tool, answerCursor)
    const toolFrameSource = tool?.framePixels ?? tool?.chart?.series
    const chartIssue = toolFrameSource && toolChart?.source === toolFrameSource ? toolChart?.issue : undefined
    const lens = tool && toolView(tool, toolCursor, chartIssue, phoneVisible)
    const visible: GlassPage = overlay
      ? { ...overlay, navigation: 'telegram', name: null }
      : listening
        || (tool && lens
          ? {
              navigation: 'tool',
              name: null,
              id: null,
              list: tool.key,
              content: lens.content,
              position: lens.position,
              total: lens.total,
              toolName: tools?.getActiveTool?.(),
              toolPage: tool,
              toolAction: lens.action,
              retryChartSeries: chartIssue === 'failed' ? toolChart?.source : undefined,
              tapAction: null,
              inspectionFrame: toolFrameSource && toolChart?.source === toolFrameSource ? toolChart?.frame : undefined,
            }
          : menu
            ? menuPage(
                menu,
                Boolean(voice) && phoneVisible,
                snapshot && phoneVisible ? snapshot.state?.questions.length ?? 0 : undefined,
                Boolean(telegram?.openDigest) && phoneVisible,
                Boolean(tools) && phoneVisible,
              )
            : page)
    const prompt = snapshot?.screen
    if (visible.navigation === 'menu' && configuredVoice && !voice && menu?.origin === 'root') {
      visible.content +=
        typeof bridge.audioControl === 'function'
          ? '\nVoice unavailable. Close and relaunch TeleGifts in the Even app for voice.'
          : '\nGlasses microphone unavailable on this host.'
    }
    if (
      (composePtt && (!visible.list.startsWith('compose-') || visible.id !== composePtt.composeId))
      || (activeComposeTranscribe && (!visible.list.startsWith('compose-') || visible.id !== activeComposeTranscribe.composeId))
    ) {
      stopComposePtt()
    }
    return {
      ...visible,
      phoneVisible,
      foregroundRevision,
      tools,
      telegram,
      telegramRevision: telegram || tools ? inputRevision?.() : undefined,
      telegramPrompt: prompt?.kind === 'confirm' || prompt?.kind === 'result' ? prompt : undefined,
    }
  }

  function displayedChart(page: GlassPage) {
    if (page.navigation !== 'chart' || !textConfirmed || !hasImageContainer || writingPage || renderFailed) return
    const frame = page.inspectionFrame
    if (frame && frame === uploaded && frame === acknowledged.inspectionFrame && sameActions(acknowledged, page)) return frame
  }

  async function writeLayout(layout: RebuildPageContainer) {
    if (rebuilding.has(bridge)) throw new GlassesRebuildPending()
    if (!started) onStartupRebuild?.()
    const native = bridge.rebuildPageContainer(layout)
    rebuilding.add(bridge)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        native.finally(() => {
          rebuilding.delete(bridge)
          if (timedOut && started && !closed) scheduleRender()
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new GlassesRebuildPending())
          }, rebuildTimeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async function rebuild(page: GlassPage, withArtwork: boolean, nextTarget = target) {
    try {
      const ok = await writeLayout(new RebuildPageContainer(containers(page, withArtwork, nextTarget)))
      if (!ok) throw new Error('G2 refused the page rebuild')
    } catch (error) {
      textConfirmed = false
      if (!(error instanceof GlassesRebuildPending) && withArtwork && recoverToolChart(page)) return false
      throw error
    }
    target = nextTarget
    hasImageContainer = withArtwork
    uploaded = null
    return true
  }

  function recoverToolChart(page: GlassPage) {
    const frameSource = page.toolPage?.framePixels ?? page.toolPage?.chart?.series
    if (!frameSource || !page.inspectionFrame) return false
    if (!closed && toolChart?.frame === page.inspectionFrame && toolChart.source === frameSource) {
      toolChart.frame = undefined
      toolChart.issue = 'failed'
      update()
    }
    return true
  }

  async function sendImage(bytes: Uint8Array, page: GlassPage) {
    uploaded = null
    try {
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({ ...imageContainer, imageData: bytes }))
      if (result !== ImageRawDataUpdateResult.success) throw new Error('G2 artwork upload returned ' + result)
    } catch (error) {
      if (!recoverToolChart(page)) throw error
      return
    }
    uploaded = bytes
  }

  async function render(next: GlassPage) {
    if (closed || rebuilding.has(bridge)) return
    const replaceTarget = !textConfirmed || !sameActions(next, acknowledged) || next.phoneVisible !== acknowledged.phoneVisible
    const textChanged =
      next.content !== acknowledged.content
      || next.regions?.header !== acknowledged.regions?.header
      || next.regions?.body !== acknowledged.regions?.body
      || next.regions?.footer !== acknowledged.regions?.footer
    const removeArtwork =
      hasImageContainer
      && (acknowledged.name !== next.name
        || usesFrame(acknowledged) !== usesFrame(next)
        || (usesFrame(next)
          && (acknowledged.list !== next.list || !next.inspectionFrame || (textChanged && next.inspectionFrame !== uploaded))))
    const bytes = usesFrame(next) ? next.inspectionFrame : artwork?.bytes
    if (usesFrame(next) && hasImageContainer && !removeArtwork && !replaceTarget && bytes && bytes !== uploaded) {
      writingPage = next
      try {
        await sendImage(bytes, next)
      } finally {
        writingPage = null
      }
      if (closed || next !== desired) return
    }
    const writePage = replaceTarget || removeArtwork || textChanged
    if (writePage) {
      writingPage = next
      try {
        if (replaceTarget || removeArtwork) {
          const withArtwork = textConfirmed && !removeArtwork && Boolean(bytes)
          if (!(await rebuild(next, withArtwork, replaceTarget ? newCaptureTarget(next, Boolean(voice)) : target))) return
        } else if (next.regions && (next.regions.header || next.regions.footer)) {
          if (next.regions.body !== acknowledged.regions?.body) {
            const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...target.text, content: next.regions.body }))
            if (!ok) throw new Error('G2 refused the focal text update')
          }
          if (next.regions.header && next.regions.header !== acknowledged.regions?.header) {
            const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...target.header, content: next.regions.header }))
            if (!ok) throw new Error('G2 refused the header text update')
          }
          if (next.regions.footer && next.regions.footer !== acknowledged.regions?.footer) {
            const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...target.footer, content: next.regions.footer }))
            if (!ok) throw new Error('G2 refused the footer text update')
          }
        } else {
          const ok = await bridge.textContainerUpgrade(new TextContainerUpgrade({ ...target.text, content: next.content }))
          if (!ok) throw new Error('G2 refused the text update')
        }
        textConfirmed = true
      } catch (error) {
        textConfirmed = false
        throw error
      } finally {
        writingPage = null
      }
    }
    acknowledged = next
    syncImuStream()

    if (closed || next !== desired) return
    if (bytes && bytes !== uploaded) {
      if (!hasImageContainer && !(await rebuild(next, true))) return
      if (closed || next !== desired) return
      await sendImage(bytes, next)
    } else if (!writePage && !renderFailed) {
      emitMirror()
      return
    }
    if (!closed && next === desired) {
      renderFailed = false
      showDisplayError(false)
      syncImuStream()
      emitMirror()
    }
  }

  let pending = Promise.resolve()
  let queued = false
  function scheduleRender() {
    if (closed || queued) return
    queued = true
    pending = pending.then(async () => {
      queued = false
      const next = desired
      try {
        await render(next)
      } catch (error) {
        if (closed) return
        renderFailed = true
        syncImuStream()
        if (next.navigation === 'voice' && sameActions(next, currentPage())) voice?.backFromOverlay()
        console.warn('Could not update the G2 display', error)
        showDisplayError(true)
      }
    })
  }

  async function prepareArtwork(request: ArtworkRequest) {
    let bytes: Uint8Array | null
    if (request.name === 'Plush Pepe') {
      const response = await fetch(new URL('./assets/plush-pepe-g2.png', import.meta.url))
      if (!response.ok) return
      bytes = new Uint8Array(await response.arrayBuffer())
    } else {
      const blob = await loadArtwork(request.name)
      if (!blob || closed || artwork !== request) return
      bytes = await fitArtwork(blob)
    }
    if (closed || artwork !== request || !bytes) return
    request.bytes = bytes
    scheduleRender()
  }

  function update() {
    if (closed) return
    voice?.syncContext()
    desired = currentPage()
    const source: ToolFrameSource | undefined = desired.toolPage?.framePixels ?? desired.toolPage?.chart?.series
    if (source !== toolChart?.source) {
      toolChart = source ? { source } : undefined
      const request = toolChart
      if (request) {
        if (request.source instanceof Uint8Array) {
          void encodeFrame(request.source)
            .then(frame => {
              if (toolChart === request) {
                request.frame = frame
                update()
              }
            })
            .catch(() => {
              if (toolChart === request) {
                request.issue = 'failed'
                update()
              }
            })
        } else {
          const samples = chartSamples(request.source)
          if (!samples.length) {
            request.issue = 'empty'
            desired = currentPage()
          } else {
            void encodeFrame(renderFloorChart(request.source, samples))
              .then(frame => {
                if (toolChart === request) {
                  request.frame = frame
                  update()
                }
              })
              .catch(() => {
                if (toolChart === request) {
                  request.issue = 'failed'
                  update()
                }
              })
          }
        }
      }
    }
    const artworkName = usesFrame(desired) ? null : desired.name
    if (artworkName !== (artwork?.name ?? null)) {
      artwork = artworkName === null ? null : { name: artworkName, bytes: null }
      if (artwork) {
        void prepareArtwork(artwork).catch(() => {})
      }
    }
    scheduleRender()
  }

  function requestExit() {
    if (exitRequest) return
    exitRequest = bridge
      .shutDownPageContainer(1)
      .then(ok => {
        if (!closed) showDisplayError(!ok)
      })
      .catch(() => {
        if (!closed) showDisplayError(true)
      })
      .finally(() => {
        exitRequest = null
      })
  }

  let unsubscribe = () => {}
  let unsubscribeDevice: (() => void) | undefined
  let finishOnEarlyExit: (() => void) | undefined
  const earlyExit = new Promise<void>(resolve => {
    finishOnEarlyExit = resolve
  })

  function retireInput() {
    stopComposePtt()
    stopIrlListen(true)
    if (voice || getTelegram?.() || getTools?.()) foregroundRevision++
    voice?.controls.cancel()
    getTelegram?.()?.cancelDraft()
    getTools?.()?.suspend()
  }

  function documentVisible() {
    return !pageHidden && (typeof document === 'undefined' || !document.hidden)
  }

  const inputVisible = () => foreground && !closed && documentVisible()

  function notifyForeground(source: 'native' | 'document') {
    if (setToolsForeground) setToolsForeground(source, source === 'native' ? foreground : documentVisible())
    else getTools?.()?.setForeground?.('display', inputVisible())
  }

  const onHidden = () => {
    notifyForeground('document')
    syncImuStream()
    if (!documentVisible()) retireInput()
    if (started) update()
  }
  const onPageHide = () => {
    pageHidden = true
    onHidden()
  }
  const onPageShow = () => {
    pageHidden = false
    onHidden()
  }

  async function stop() {
    if (!closed) {
      closed = true
      stopComposePtt()
      stopIrlListen(true)
      syncImuStream()
      if (foreground) {
        foreground = false
        notifyForeground('native')
      }
      unsubscribe()
      unsubscribeDevice?.()
      unsubscribeVoice?.()
      unsubscribeLaunchSource?.()
      unsubscribeHwPrefs?.()
      void unbindVoice?.()
      getTelegram?.()?.cancelDraft()
      getTools?.()?.close()
      if (typeof document !== 'undefined') {
        document.removeEventListener?.('visibilitychange', onHidden)
        window.removeEventListener?.('pagehide', onPageHide)
        window.removeEventListener?.('pageshow', onPageShow)
      }
      emitMirror()
    }
    await Promise.all([pending, exitRequest, imuChain, pttMicChain])
  }

  function nativeClosed() {
    if (closed) return
    void stop()
    finishOnEarlyExit?.()
    onClosed()
  }

  unsubscribe = bridge.onEvenHubEvent(event => {
    if (closed) return
    const rawSource = event.sysEvent?.eventSource
    const parsedSource = rawSource !== undefined ? EventSourceType.fromJson(rawSource) : undefined
    if (parsedSource === EventSourceType.TOUCH_EVENT_FROM_RING || String(rawSource) === 'RING') {
      telemetry.lastInputSource = 'ring'
    } else if (parsedSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L || String(rawSource) === 'GLASSES_L') {
      telemetry.lastInputSource = 'glasses-l'
    } else if (parsedSource === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R || String(rawSource) === 'GLASSES_R') {
      telemetry.lastInputSource = 'glasses-r'
    }

    const types = [event.sysEvent?.eventType, event.textEvent?.eventType]
    if (types.includes(OsEventTypeList.SYSTEM_EXIT_EVENT) || types.includes(OsEventTypeList.ABNORMAL_EXIT_EVENT)) {
      nativeClosed()
      return
    }
    if (types.includes(OsEventTypeList.FOREGROUND_EXIT_EVENT)) {
      if (menuOverlayOpen) {
        menuOverlayOpen = false
        return
      }
      foreground = false
      syncImuStream()
      notifyForeground('native')
      retireInput()
      return
    }
    if (types.includes(OsEventTypeList.FOREGROUND_ENTER_EVENT)) {
      menuOverlayOpen = foreground
      foreground = true
      syncImuStream()
      notifyForeground('native')
      if (started) update()
      return
    }
    if (!started || !foreground) return
    if (types.includes(OsEventTypeList.IMU_DATA_REPORT)) {
      if (
        imuStreamDesired
        && documentVisible()
        && textConfirmed
        && !writingPage
        && isImuAlertPage(acknowledged)
      ) {
        const live = currentPage()
        if (sameActions(acknowledged, live)) {
          const gesture = imuClassifier.push(event.sysEvent?.imuData)
          if (gesture === 'nod') {
            live.telegram?.activate()
          } else if (gesture === 'shake') {
            live.telegram?.back()
          }
        }
      }
      return
    }

    const phoneVisible = documentVisible()
    if (event.audioEvent) {
      const audio = event.audioEvent
      if (phoneVisible && audio.source === AudioInputSource.Glasses) {
        // When an explicit wearer voice/PTT/question session is active, feed all glasses PCM
        // regardless of heuristic speakerRole so beamforming misclassification never drops wearer speech.
        if (isWearerVoiceBusy()) {
          if (composePtt) composePtt.utterance.append(audio.audioPcm)
          else voice?.receive(audio.audioPcm)
        } else if (
          audio.speakerRole === AudioSpeakerRole.Other
          && (transcribeOverheard || voice)
          && onOverheardTranscript
          && !activeOverheardAbort
          && (Boolean(irlListenSession) || getG2HardwarePreferences().irlOverheardEnabled)
        ) {
          if (!overheardUtterance) overheardUtterance = new Utterance(8)
          overheardUtterance.append(audio.audioPcm)
          if (overheardUtterance.complete) {
            const hasSpeech = overheardUtterance.hasSpeech
            const pcm = overheardUtterance.take()
            overheardUtterance = null
            const wasIrlSession = Boolean(irlListenSession)
            const micClosed = wasIrlSession ? (stopIrlListen(false), pttMicChain) : Promise.resolve(true)
            if (hasSpeech) {
              const abort = new AbortController()
              activeOverheardAbort = abort
              const names = voiceNames?.() ?? []
              void micClosed
                .then(ok => {
                  if (!ok || closed || abort.signal.aborted || isWearerVoiceBusy()) return null
                  return transcribeOverheard
                    ? transcribeOverheard(pcm, names, abort.signal)
                    : voice!.transcribePcm(pcm, abort.signal)
                })
                .then(transcript => {
                  if (activeOverheardAbort === abort) activeOverheardAbort = null
                  if (!closed && !abort.signal.aborted && !isWearerVoiceBusy() && transcript?.trim()) {
                    onOverheardTranscript(transcript.trim())
                  }
                })
                .catch(() => {
                  if (activeOverheardAbort === abort) activeOverheardAbort = null
                })
            }
          }
        }
      }
      return
    }
    if (event.menuItemClickEvent) {
      if (exitRequest) return
      const live = currentPage()
      const action = target.menu.get(event.menuItemClickEvent.itemID ?? 0)
      if (!action) {
        if (!textConfirmed) update()
        return
      }
      if (!nativeMenuAvailable(action, phoneVisible)) return
      if (!textConfirmed || !sameActions(acknowledged, live) || (writingPage && !sameActions(writingPage, live))) {
        update()
        return
      }
      if (typeof action === 'object') {
        const page = live.toolPage
        const matchedAction = page?.actions.find(item => item.id === action.id)
        const isBrowseExtra = Boolean(
          page?.browse
          && matchedAction
          && action.id !== page.browse.open
          && action.id !== page.browse.previous
          && action.id !== page.browse.next
          && action.id !== 'refresh',
        )
        const isCursorConfirm = Boolean(live.toolAction?.id === action.id && live.toolAction.requiresConfirmation)
        if (
          !event.sysEvent
          && !event.textEvent
          && !event.listEvent
          && page
          && (isCursorConfirm || isBrowseExtra)
          && (!matchedAction?.requiresConfirmation || page !== submittedTool)
          && live.tools?.getSnapshot() === page
        ) {
          if (matchedAction?.requiresConfirmation) submittedTool = page
          live.tools.act(page, action.id)
        }
        return
      }
      switch (action) {
        case 'Retry chart':
          if (live.retryChartSeries && live.retryChartSeries === toolChart?.source) {
            toolChart = undefined
            update()
          }
          break
        case 'Companion tools':
          openTools?.()
          break
        case 'Venue spread':
          inspector.show('spread')
          break
        case 'Talk to Gifti':
          openTools?.('gifti', 'glasses', 'talk')
          break
        case 'Show chart':
          if (!event.sysEvent && !event.textEvent && !event.listEvent && live.toolPage) live.tools?.act(live.toolPage, 'show-chart')
          break
        case 'Back':
          live.tools?.back()
          break
        case 'Refresh tasks':
        case 'Refresh movers':
          if (live.toolPage?.browse) live.tools?.act(live.toolPage, 'refresh')
          break
        case 'Questions':
        case 'Refresh questions':
          live.telegram?.openQuestions()
          break
        case 'Channel digest':
          live.telegram?.openDigest?.()
          break
        case 'Send to my Telegram':
        case 'Reply with chart':
        case 'Reply with comparison': {
          const frame = displayedChart(live)
          if (frame)
            shareChart?.(action === 'Send to my Telegram' ? 'private' : action === 'Reply with chart' ? 'reply' : 'comparison', frame)
          else update()
          break
        }
        case 'Cancel':
          live.telegram?.back()
          break
        case 'Send reply':
          if (!event.sysEvent && !event.textEvent && !event.listEvent && live.id && live.id !== submittedComposeId) {
            submittedComposeId = live.id
            live.telegram?.activate()
          }
          break
        case 'Save to DM':
          if (!event.sysEvent && !event.textEvent && !event.listEvent) {
            live.telegram?.activate()
          }
          break
        case 'Send':
          if (
            !event.sysEvent
            && !event.textEvent
            && !event.listEvent
            && live.telegramPrompt?.kind === 'confirm'
            && live.telegramPrompt !== submittedPrompt
          ) {
            submittedPrompt = live.telegramPrompt
            live.telegram?.activate()
          }
          break
        case 'Voice command':
          voice?.controls.start()
          break
        default:
          voice?.controls.activate()
      }
      return
    }
    if (!event.sysEvent && !event.textEvent) return

    const raw = event.jsonData ?? {}
    const keys = Object.keys(raw)
    const wireKey = (field: string) => keys.find(key => key.replace(/[_\s-]/g, '').toLowerCase() === field)
    const typeKey = wireKey('eventtype')
    if (typeKey !== undefined && !Number.isInteger(OsEventTypeList.fromJson(raw[typeKey]))) return
    const omittedClick = typeKey === undefined && types.every(type => type === undefined)

    const live = currentPage()
    const doubleTap = types.includes(OsEventTypeList.DOUBLE_CLICK_EVENT)
    const text = event.textEvent
    if (text) {
      const hasID = text.containerID !== undefined || wireKey('containerid') !== undefined
      const hasName = text.containerName !== undefined || wireKey('containername') !== undefined
      if ((hasID && text.containerID !== target.text.containerID) || (hasName && text.containerName !== target.text.containerName))
        return
    }
    if (live.navigation === 'voice' && doubleTap) {
      if (
        (text?.containerID !== undefined || text?.containerName !== undefined)
        && (!textConfirmed || !sameActions(acknowledged, live) || (writingPage && !sameActions(writingPage, live)))
      )
        return
      voice?.backFromOverlay()
      return
    }
    const isComposePttRelease =
      Boolean(composePtt)
      && live.navigation === 'telegram'
      && live.list.startsWith('compose-')
      && live.id === composePtt!.composeId
      && types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)
    if (!isComposePttRelease && (!textConfirmed || !sameActions(acknowledged, live) || (writingPage && !sameActions(writingPage, live)))) {
      update()
      return
    }
    if (doubleTap) {
      stopComposePtt()
      if (live.telegramPrompt?.kind === 'confirm') {
        live.telegram?.cancelDraft()
        return
      }
      if (live.navigation === 'telegram') {
        live.telegram?.back()
        return
      }
      if (live.navigation === 'tool') {
        live.tools?.back()
        return
      }
      if (menu) {
        menu = null
        update()
        return
      }
      const returned = live.navigation !== 'waiting' && back()
      if (!returned && (live.navigation === 'root' || live.navigation === 'waiting')) {
        menu = { origin: live.navigation, index: 0 }
      }
      update()
      return
    }
    if (live.navigation === 'waiting') return
    if (live.navigation === 'tool') {
      const direction = types.includes(OsEventTypeList.SCROLL_TOP_EVENT)
        ? -1
        : types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)
          ? 1
          : 0
      if (direction) {
        const page = live.toolPage
        if (page?.browse) {
          const action = direction < 0 ? page.browse.previous : page.browse.next
          if (phoneVisible && action && page.actions.some(item => item.id === action && !item.requiresConfirmation))
            live.tools?.act(page, action)
          return
        }
        toolCursor = Math.max(0, Math.min((live.position ?? 0) + direction, (live.total ?? 1) - 1))
        update()
      } else if (
        phoneVisible
        && (omittedClick || types.includes(OsEventTypeList.CLICK_EVENT))
        && live.toolPage
        && live.toolAction
        && !live.toolAction.requiresConfirmation
      ) {
        live.tools?.act(live.toolPage, live.toolAction.id)
      }
      return
    }
    if (!phoneVisible && (live.navigation === 'telegram' || live.navigation === 'voice')) return
    if (live.navigation === 'telegram') {
      const swipable =
        live.list === 'questions'
        || live.list === 'pending'
        || live.list.startsWith('compose-')
        || live.list.startsWith('digest-')
      if (swipable && types.includes(OsEventTypeList.SCROLL_TOP_EVENT)) {
        stopComposePtt()
        live.telegram?.step(-1)
      } else if (swipable && types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
        stopComposePtt()
        live.telegram?.step(1)
      } else if (live.list.startsWith('compose-') && types.includes(OsEventTypeList.LONG_PRESS_EVENT)) {
        const composeId = live.id ?? ''
        if (!composePtt && composeId && typeof bridge.audioControl === 'function') {
          stopIrlListen(true)
          if (activeComposeTranscribe) {
            activeComposeTranscribe.abort.abort()
            activeComposeTranscribe = null
          }
          const ptt = {
            composeId,
            utterance: new Utterance(12),
            abort: new AbortController(),
          }
          composePtt = ptt
          pttWantMicOpen = true
          pttMicChain = pttMicChain.then(async () => {
            if (!pttWantMicOpen || composePtt !== ptt || ptt.abort.signal.aborted) return false
            pttMicOpenConfirmed = true
            const opened = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false)
            if (!opened) {
              pttMicOpenConfirmed = false
              if (composePtt === ptt) composePtt = null
              return false
            }
            if (!pttWantMicOpen || composePtt !== ptt || ptt.abort.signal.aborted) {
              let closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
              if (!closedLate) closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
              if (closedLate) pttMicOpenConfirmed = false
              return false
            }
            return true
          })
        }
      } else if (live.list.startsWith('compose-') && types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
        const ptt = composePtt
        if (ptt) {
          composePtt = null
          const hasSpeech = ptt.utterance.hasSpeech
          const pcm = ptt.utterance.take()
          const micClosedPromise = enqueuePttMicClose()
          const activeVoice = voice
          if (hasSpeech && (activeVoice || transcribeDictation)) {
            const pendingTranscribe = { composeId: ptt.composeId, abort: ptt.abort }
            activeComposeTranscribe = pendingTranscribe
            const composeCommandRe =
              /^(?:next draft|previous draft|send reply|(?:select )?(?:floor(?: chart)?|venue spread|daily(?: utc)? close|checking listings)(?: draft)?)$/i
            void micClosedPromise
              .then(async micClosedOk => {
                if (!micClosedOk || closed || ptt.abort.signal.aborted) return null
                if (transcribeDictation) {
                  const dictated = (await transcribeDictation(pcm, ptt.abort.signal))?.trim() ?? null
                  if (dictated) return { text: dictated, fromDictation: true as const }
                }
                if (!activeVoice) return null
                const cmdText = (await activeVoice.transcribePcm(pcm, ptt.abort.signal))?.trim() ?? null
                return cmdText ? { text: cmdText, fromDictation: false as const } : null
              })
              .then(result => {
                if (activeComposeTranscribe === pendingTranscribe) activeComposeTranscribe = null
                const clean = result?.text
                if (!clean || closed || ptt.abort.signal.aborted) return
                const latestPage = currentPage()
                if (!latestPage.list.startsWith('compose-') || latestPage.id !== ptt.composeId) return
                const tg = getTelegram?.()
                const normalizedCmd = clean.replace(/[.!?]+$/g, '').trim()
                if (result.fromDictation && !composeCommandRe.test(normalizedCmd)) {
                  // Dictated free-form text NEVER auto-sends — user must inspect on G2 and explicitly Tap!
                  tg?.applyDictatedReply?.(clean, ptt.composeId)
                  return
                }
                if (normalizedCmd.toLowerCase() === 'send reply') {
                  if (latestPage.id === submittedComposeId) return
                  const accepted = tg?.applyVoiceReply?.(normalizedCmd, ptt.composeId)
                  if (accepted) submittedComposeId = latestPage.id
                  return
                }
                tg?.applyVoiceReply?.(normalizedCmd, ptt.composeId)
              })
              .catch(() => {
                if (activeComposeTranscribe === pendingTranscribe) activeComposeTranscribe = null
              })
          }
        }
      } else if (omittedClick || types.includes(OsEventTypeList.CLICK_EVENT)) {
        if (live.tapAction === 'telegramComposeSend') {
          if (live.id && live.id !== submittedComposeId) {
            submittedComposeId = live.id
            live.telegram?.activate()
          }
        } else if (live.tapAction === 'telegramActivate') {
          live.telegram?.activate()
        } else if (live.tapAction === 'telegramBack') {
          live.telegram?.back()
        }
      }
      return
    }
    if (live.navigation === 'voice') {
      const direction = types.includes(OsEventTypeList.SCROLL_TOP_EVENT)
        ? -1
        : types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)
          ? 1
          : 0
      if (direction && live.toolPage && live.total) {
        answerCursor = Math.max(0, Math.min(answerCursor + direction, live.total - 1))
        update()
      } else if (direction) voice?.controls.step(direction)
      else if (
        live.tapAction
        && (text?.containerID === target.text.containerID || text?.containerName === target.text.containerName)
        && (omittedClick || types.includes(OsEventTypeList.CLICK_EVENT))
      ) {
        voice?.controls.activate()
      }
      return
    }
    if (types.includes(OsEventTypeList.LONG_PRESS_EVENT)) {
      if (live.navigation === 'root') openFavorites()
      else if (live.navigation === 'detail' || live.navigation === 'preview') inspector.show('variants')
    } else if (types.includes(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) {
      return
    } else if (types.includes(OsEventTypeList.SCROLL_TOP_EVENT) || types.includes(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      const direction = types.includes(OsEventTypeList.SCROLL_TOP_EVENT) ? -1 : 1
      if (menu) {
        const index = (live.position ?? 0) + direction
        if (index >= 0 && index < (live.total ?? 0)) {
          menu.index = index
          update()
        }
      } else if (live.navigation === 'preview') {
        const frame = live.inspectionFrame
        if (!frame || frame !== uploaded || frame !== acknowledged.inspectionFrame || writingPage || renderFailed) {
          update()
          return
        }
        inspector.step(direction, frame)
      } else if (live.navigation === 'variants') {
        if (live.variantName !== undefined) inspector.step(direction)
      } else if (live.navigation === 'chart' || live.navigation === 'spread') {
        inspector.step(direction)
      } else if (live.navigation === 'detail') {
        inspector.show(direction === -1 ? 'preview' : 'chart')
      } else move(direction)
    } else if (omittedClick || types.includes(OsEventTypeList.CLICK_EVENT)) {
      if (!live.tapAction) {
        update()
        return
      }
      if (menu) {
        if (live.tapAction === 'exit') {
          requestExit()
          return
        }
        menu = null
        if (live.tapAction === 'startVoice') voice?.controls.start()
        else if (live.tapAction === 'favorites') openFavorites()
        else if (live.tapAction === 'questions') live.telegram?.openQuestions()
        else if (live.tapAction === 'digest') live.telegram?.openDigest?.()
        else if (live.tapAction === 'tools') openTools?.()
        update()
      } else if (live.tapAction === 'retryInspection') inspector.retry()
      else if (live.tapAction === 'pickVariant') inspector.pickVariant(acknowledged.variantName)
      else if (live.tapAction === 'preview' || live.tapAction === 'chart' || live.tapAction === 'spread')
        inspector.show(live.tapAction)
      else tap()
    }
    emitMirror()
  })

  async function createPage() {
    const layout = containers(initial, false, target)
    const previous = startupState.get(bridge)
    if (previous === 'refused') throw new GlassesReloadRequired('Reload TeleGifts to start a new glasses page')
    if (previous) {
      const ok = await writeLayout(new RebuildPageContainer(layout))
      if (ok && previous === 'unconfirmed') startupState.set(bridge, 'recovered')
      else if (!closed && previous === 'unconfirmed') {
        startupState.set(bridge, 'refused')
        throw new GlassesReloadRequired('G2 could not recover an unconfirmed startup')
      }
      if (!closed && !ok) throw new Error('G2 refused to reopen the page')
      return
    }
    startupState.set(bridge, 'unconfirmed')
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(layout))
    if (result === StartUpPageCreateResult.success) {
      startupState.set(bridge, 'created')
      return
    }
    if (result === StartUpPageCreateResult.invalid) {
      if (closed) return
      voice = undefined
      const recovered = currentPage()
      const capture = newCaptureTarget(recovered, false)
      if (await writeLayout(new RebuildPageContainer(containers(recovered, false, capture)))) {
        startupState.set(bridge, 'recovered')
        target = capture
        acknowledged = recovered
        return
      }
    }
    startupState.set(bridge, 'refused')
    if (!closed) throw new GlassesReloadRequired('G2 page creation returned ' + result)
  }

  if (!closed)
    unsubscribeDevice = bridge.onDeviceStatusChanged?.(status => {
      if (status.connectType === DeviceConnectType.Disconnected || status.connectType === DeviceConnectType.ConnectionFailed) {
        nativeClosed()
        return
      }
      if (typeof status.batteryLevel === 'number') telemetry.batteryLevel = status.batteryLevel
      if (typeof status.isCharging === 'boolean') telemetry.isCharging = status.isCharging
      if (typeof status.isWearing === 'boolean') telemetry.isWearing = status.isWearing
      emitMirror()
    })

  if (closed) {
    unsubscribe()
    unsubscribeDevice?.()
  } else {
    const creation = createPage()
    pending = creation.catch(() => {})
    try {
      await Promise.race([creation, earlyExit])
    } catch (error) {
      await stop()
      throw error
    } finally {
      finishOnEarlyExit = undefined
    }
    if (!closed) {
      started = true
      const storageBridge = bridge as {
        getLocalStorage?(k: string): Promise<string>
        setLocalStorage?(k: string, v: string): Promise<boolean>
        onLaunchSource?(l: (source: 'appMenu' | 'glassesMenu') => void): () => void
      }
      void syncEvenHostStorage(storageBridge)
      unsubscribeLaunchSource = subscribeLaunchSource(storageBridge, source => {
        if (!closed && source === 'glassesMenu') {
          onGlassesMenuLaunch?.()
        }
      })
      unsubscribeHwPrefs = subscribeG2HardwarePreferences(() => {
        if (!closed) {
          syncImuStream()
          if (!getG2HardwarePreferences().irlOverheardEnabled && !irlListenSession) {
            stopIrlListen(true)
          }
        }
      })
      if (setToolsForeground) notifyForeground('document')
      notifyForeground('native')
      if (voice && startupState.get(bridge) === 'created') {
        unbindVoice = voice.bind({
          microphone: enabled => {
            if (enabled) {
              stopIrlListen(true)
              pttWantMicOpen = true
              pttMicChain = pttMicChain.then(async () => {
                if (!pttWantMicOpen || closed) return false
                pttMicOpenConfirmed = true
                const opened = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false)
                if (!opened) {
                  pttMicOpenConfirmed = false
                  return false
                }
                if (!pttWantMicOpen || closed) {
                  let closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
                  if (!closedLate) closedLate = await bridge.audioControl(false, AudioInputSource.Glasses).catch(() => false)
                  if (closedLate) pttMicOpenConfirmed = false
                  return false
                }
                return true
              })
              return pttMicChain
            }
            return enqueuePttMicClose()
          },
          toolPage: () => getTools?.()?.getSnapshot() ?? null,
          activeTool: () => getTools?.()?.getActiveTool?.(),
          displayedChart: () => displayedChart(currentPage()),
          available: () =>
            inputVisible()
            && !exitRequest
            && current().status !== 'waiting'
            && (getTelegram?.()?.getSnapshot().screen.kind ?? 'idle') === 'idle',
          context: () => {
            const p = glassPage(current())
            return JSON.stringify([inputRevision?.(), p.navigation, p.id, p.name, p.list, p.variantName, p.fromVariants])
          },
        })
        unsubscribeVoice = voice.controls.subscribe(() => {
          if (isWearerVoiceBusy()) stopIrlListen(true)
          update()
        })
      }
      if (typeof document !== 'undefined') {
        document.addEventListener?.('visibilitychange', onHidden)
        window.addEventListener?.('pagehide', onPageHide)
        window.addEventListener?.('pageshow', onPageShow)
      }
      emitMirror()
      update()
    }
  }
  return { update, stop, startIrlListen }
}
