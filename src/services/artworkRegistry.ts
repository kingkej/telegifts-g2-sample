import collectionColors from '../assets/collection-colors.json' with { type: 'json' }
import { resolveDeepLinkMatchKey } from '../lib/deepLinkMatchKey.ts'

const globFn = (
  import.meta as {
    glob?: (pattern: string, options: Record<string, unknown>) => Record<string, string>
  }
).glob

const thumbnailModules =
  typeof globFn === 'function'
    ? globFn('../assets/collection-thumbnails/*.webp', {
        eager: true,
        import: 'default',
      })
    : {}

const thumbnailByKey = new Map<string, string>()
for (const [path, url] of Object.entries(thumbnailModules)) {
  const match = /\/([^/]+)\.webp$/i.exec(path)
  if (match?.[1]) thumbnailByKey.set(match[1].toLowerCase(), url)
}

const colorMap = collectionColors as Record<string, string>

export function getCollectionThumbnailUrl(collectionName: string): string | null {
  const key = resolveDeepLinkMatchKey(collectionName)
  return thumbnailByKey.get(key) ?? null
}

export function getCollectionAccent(collectionName: string): string | null {
  const key = resolveDeepLinkMatchKey(collectionName)
  return colorMap[key] ?? null
}

function createProceduralBadgeSvg(title: string, subtitle: string, accent: string): string {
  const safeTitle = title.replace(/[<>&"]/g, '').slice(0, 18)
  const safeSub = subtitle.replace(/[<>&"]/g, '').slice(0, 18)
  const initials = safeTitle
    .split(/\s+/)
    .map(part => part[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'TG'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="54%">
        <stop offset="0%" stop-color="${accent}" stop-opacity="0.95"/>
        <stop offset="70%" stop-color="${accent}" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <circle cx="128" cy="116" r="88" fill="url(#g)"/>
    <rect x="44" y="40" width="168" height="152" rx="42" fill="#f5f5f7" fill-opacity="0.92"/>
    <rect x="58" y="54" width="140" height="124" rx="30" fill="#18181c"/>
    <text x="128" y="128" text-anchor="middle" font-family="system-ui, sans-serif" font-size="52" font-weight="800" fill="#ffffff">${initials}</text>
    <text x="128" y="162" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="600" fill="#c4c4cc">${safeSub}</text>
  </svg>`
}

export function createModelArtworkDataUrl(collectionName: string, modelName: string): string {
  const accent = getCollectionAccent(collectionName) ?? 'rgb(56, 182, 243)'
  const svg = createProceduralBadgeSvg(modelName, collectionName, accent)
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export async function loadCollectionOrModelArtworkBlob(
  collectionName: string,
  modelName?: string,
): Promise<Blob | null> {
  const thumbUrl = getCollectionThumbnailUrl(collectionName)
  if (!modelName && thumbUrl && typeof fetch === 'function') {
    try {
      const response = await fetch(thumbUrl)
      if (response.ok) {
        const blob = await response.blob()
        if (blob.size > 0) return blob
      }
    } catch {
      // Fall back to procedural SVG badge if asset fetch is unavailable.
    }
  }
  const accent = getCollectionAccent(collectionName) ?? 'rgb(56, 182, 243)'
  const svg = createProceduralBadgeSvg(modelName ?? collectionName, modelName ? collectionName : 'TeleGifts', accent)
  return new Blob([svg], { type: 'image/svg+xml' })
}
