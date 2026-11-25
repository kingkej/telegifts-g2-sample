import type {
  CompanionChartRange,
  CompanionFloorSeries,
  CompanionInspection,
  CompanionInspectionView,
  CompanionInspector,
  VenueQuote,
} from './contracts/companion.ts'
import { isTelegramDailyComparison } from './contracts/telegram.ts'
import { createGiftPreview, type GiftPreview } from './giftPreview.ts'
import { chartSamples, renderFloorChart } from './floorChart.ts'
import { renderSpreadChart } from './spreadChart.ts'
import { drawLabel } from './bitmapText.ts'

export const frameWidth = 256
export const frameHeight = 144
export const chartRanges: readonly CompanionChartRange[] = ['24h', '7d', '30d']

export async function encodeFrame(pixels: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (pixels.length !== frameWidth * frameHeight) throw new Error('Invalid glasses frame dimensions')
  const canvas = document.createElement('canvas')
  canvas.width = frameWidth
  canvas.height = frameHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas unavailable')
  const image = context.createImageData(frameWidth, frameHeight)
  for (let source = 0, target = 0; source < pixels.length; source++, target += 4) {
    const shade = pixels[source]!
    image.data[target] = image.data[target + 1] = image.data[target + 2] = shade
    image.data[target + 3] = 255
  }
  context.putImageData(image, 0, 0)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not encode glasses frame')
  return new Uint8Array(await blob.arrayBuffer())
}

interface Sources {
  loadArtwork(name: string, model?: string): Promise<Blob | null>
  loadFloorChart(name: string, range: CompanionChartRange, forceRetry?: boolean, signal?: AbortSignal): Promise<CompanionFloorSeries>
  loadVariants(name: string): Promise<readonly string[]>
  loadQuotes?(name: string): readonly VenueQuote[]
  initialRange(): CompanionChartRange
}

export function createInspector(sources: Sources, onChange: () => void) {
  let name: string | null = null
  let state: CompanionInspection = { mode: 'overview' }
  let revision = 0
  let requestedPosition: { variant?: string | null; angle?: number } = {}
  let range: CompanionChartRange = '24h'
  let lastModel: string | null = null
  let activeRead: AbortController | null = null
  let variants: readonly string[] | null = null
  let variantIndex = 0
  let fromVariants = false
  let preview: GiftPreview | null = null
  let index = 0
  const frames = new Map<number, Uint8Array<ArrayBuffer>>()
  const listeners = new Set<() => void>()

  function publish(next: CompanionInspectionView | { mode: 'overview' }) {
    state = next.mode === 'overview' || !name ? { mode: 'overview' } : { ...next, collection: name, fromVariants }
    onChange()
    for (const listener of listeners) listener()
  }

  function nextRequest(position: typeof requestedPosition = {}) {
    revision++
    requestedPosition = position
    activeRead?.abort()
    activeRead = null
    return revision
  }

  async function drawAngle(gift: GiftPreview, position: number, model: string | null, request: number) {
    let frame = frames.get(position)
    if (!frame) {
      const pixels = gift.render(position)
      drawLabel(pixels, gift.angles[position] + '°', 6, 128)
      frame = await encodeFrame(pixels)
    }
    if (request !== revision) return
    frames.set(position, frame)
    publish({
      mode: 'preview',
      model,
      status: 'ready',
      frame,
      kind: gift.kind,
      angle: gift.angles[position]!,
      canPrevious: gift.kind === 'model' || position > 0,
      canNext: gift.kind === 'model' || position < gift.angles.length - 1,
    })
  }

  async function openPreview(collection: string, model: string | null, preferredAngle?: number) {
    const request = nextRequest({ angle: preferredAngle })
    const controller = new AbortController()
    activeRead = controller
    lastModel = model
    preview = null
    frames.clear()
    publish({ mode: 'preview', model, status: 'loading' })
    try {
      const gift = await createGiftPreview(
        collection,
        () => sources.loadArtwork(collection, model ?? undefined),
        !model,
        controller.signal,
      )
      if (request !== revision) return
      if (!gift) {
        publish({ mode: 'preview', model, status: 'empty' })
        return
      }
      preview = gift
      const position = preferredAngle === undefined ? -1 : gift.angles.indexOf(preferredAngle)
      index = position >= 0 ? position : gift.initialIndex
      await drawAngle(gift, index, model, request)
    } catch {
      if (request === revision) publish({ mode: 'preview', model, status: 'error' })
    } finally {
      if (activeRead === controller) activeRead = null
    }
  }

  async function openChart(collection: string, selectedRange: CompanionChartRange, forceRetry = false) {
    const request = nextRequest()
    const controller = new AbortController()
    activeRead = controller
    range = selectedRange
    publish({ mode: 'chart', range, status: 'loading' })
    try {
      const series = await sources.loadFloorChart(collection, selectedRange, forceRetry, controller.signal)
      if (request !== revision) return
      const samples = chartSamples(series)
      const latest = samples.at(-1)
      if (!latest) {
        publish({ mode: 'chart', range, status: 'empty' })
        return
      }
      const observedSeries = { ...series, points: samples.map(([time, price]) => ({ time, price })) }
      const frame = await encodeFrame(renderFloorChart(observedSeries, samples))
      if (request !== revision) return
      const [lastTime, last] = latest
      let low = last, high = last
      for (const [, price] of samples) {
        low = Math.min(low, price)
        high = Math.max(high, price)
      }
      const previous = samples.at(-2)
      const pair = previous && { previous: previous[1], previousTime: previous[0] }
      const comparable = observedSeries.interval === 86_400 && isTelegramDailyComparison(selectedRange, last, lastTime, pair)
      publish({
        mode: 'chart',
        range: selectedRange,
        status: 'ready',
        frame,
        series: observedSeries,
        low,
        high,
        last,
        lastTime,
        ...(comparable && { comparison: pair }),
      })
    } catch {
      if (request === revision) publish({ mode: 'chart', range, status: 'error' })
    } finally {
      if (activeRead === controller) activeRead = null
    }
  }

  async function openSpread(collection: string) {
    const request = nextRequest()
    publish({ mode: 'spread', status: 'loading' })
    try {
      const quotes = [...(sources.loadQuotes?.(collection) ?? [])].sort((a, b) => a.price - b.price)
      if (!quotes.length) {
        publish({ mode: 'spread', status: 'empty' })
        return
      }
      const frame = await encodeFrame(renderSpreadChart(quotes))
      if (request !== revision) return
      const first = quotes[0]!
      const last = quotes[quotes.length - 1]!
      const spreadPercent = quotes.length >= 2 ? ((last.price - first.price) / first.price) * 100 : null
      publish({ mode: 'spread', status: 'ready', frame, quotes, spreadPercent })
    } catch {
      if (request === revision) publish({ mode: 'spread', status: 'error' })
    }
  }

  async function openVariants(collection: string, preferredModel = lastModel) {
    const request = nextRequest({ variant: preferredModel })
    fromVariants = true
    try {
      if (!variants?.length) {
        publish({ mode: 'variants', status: 'loading' })
        const names = await sources.loadVariants(collection)
        if (request !== revision) return
        variants = names
      }
      if (!variants.length) {
        publish({ mode: 'variants', status: 'empty' })
        return
      }
      if (preferredModel) {
        const selected = variants.indexOf(preferredModel)
        if (selected >= 0) variantIndex = selected
      }
      publish({ mode: 'variants', status: 'ready', names: variants, index: variantIndex })
    } catch {
      if (request === revision) publish({ mode: 'variants', status: 'error' })
    }
  }

  function close() {
    nextRequest()
    lastModel = null
    fromVariants = false
    preview = null
    frames.clear()
    if (state.mode !== 'overview') publish({ mode: 'overview' })
  }

  function showChart(requestedRange = range) {
    if (name && (state.mode !== 'chart' || requestedRange !== range)) void openChart(name, requestedRange)
  }

  const inspector: CompanionInspector = {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    show(mode, model) {
      if (!name) return
      if (mode === 'overview') {
        close()
        return
      }
      if (mode === 'variants') {
        if (state.mode !== 'variants') void openVariants(name)
        return
      }
      if (mode === 'chart') {
        showChart()
        return
      }
      if (mode === 'spread') {
        if (state.mode !== 'spread') void openSpread(name)
        return
      }
      const target = model ?? (state.mode === 'chart' || state.mode === 'spread' ? lastModel : null)
      if (state.mode !== 'preview' || state.model !== target) void openPreview(name, target)
    },
    showChart,
    setRange(next) {
      if (name && state.mode === 'chart' && next !== range) void openChart(name, next)
    },
    pickVariant(model) {
      if (!name || state.mode !== 'variants' || state.status !== 'ready') return
      const next = model === undefined ? variantIndex : state.names.indexOf(model)
      if (next < 0) return
      variantIndex = next
      void openPreview(name, state.names[next]!)
    },
    back() {
      if (name && fromVariants && state.mode !== 'variants') void openVariants(name)
      else close()
    },
    step(direction, displayedFrame) {
      if (state.mode === 'variants' && state.status === 'ready') {
        const next = variantIndex + direction
        if (!state.names[next]) return
        variantIndex = next
        publish({ mode: 'variants', status: 'ready', names: state.names, index: variantIndex })
        return
      }
      if (state.mode === 'chart') {
        const next = chartRanges[chartRanges.indexOf(range) + direction]
        if (next) inspector.setRange(next)
        return
      }
      if (state.mode === 'spread') {
        showChart()
        return
      }
      if (state.mode !== 'preview' || state.status !== 'ready' || !preview) return
      if (displayedFrame && (state.frame !== displayedFrame || state.angle !== preview.angles[index])) return
      const { model } = state
      const count = preview.angles.length
      const next =
        preview.kind === 'model'
          ? (index + direction + count) % count
          : Math.max(0, Math.min(count - 1, index + direction))
      if (next === index) return
      index = next
      const request = ++revision
      void drawAngle(preview, next, model, request).catch(() => {
        if (request === revision) publish({ mode: 'preview', model, status: 'error' })
      })
    },
    retry() {
      if (!name || state.mode === 'overview' || (state.status !== 'error' && state.status !== 'empty')) return
      if (state.mode === 'preview') void openPreview(name, state.model)
      else if (state.mode === 'variants') void openVariants(name)
      else if (state.mode === 'spread') void openSpread(name)
      else void openChart(name, range, true)
    },
  }

  function select(next: string | null) {
    if (name === next) return
    name = next
    variants = null
    variantIndex = 0
    range = sources.initialRange()
    close()
  }

  function rebind(next: string) {
    if (name === next) return
    name = next
    variants = null
    variantIndex = 0
    if (state.mode === 'variants') {
      const preferred = state.status === 'ready' ? state.names[state.index] : requestedPosition.variant
      void openVariants(next, preferred)
    } else if (state.mode === 'preview') {
      const angle = state.status === 'ready' ? preview?.angles[index] ?? state.angle : requestedPosition.angle
      void openPreview(next, state.model, angle)
    } else if (state.mode === 'chart') {
      void openChart(next, state.range)
    } else if (state.mode === 'spread') {
      void openSpread(next)
    }
  }

  return { inspector, select, rebind, showChart }
}
