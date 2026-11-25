import type { CollectionFloorsResponse } from '../contracts/companion.ts'
import { resolveDeepLinkMatchKey } from './deepLinkMatchKey.ts'

export interface ResolvedGiftLink {
  collection: string
  serialNumber: number | null
  rawSlug: string
}

/**
 * Resolves Telegram Collectible Gift links and shorthand references:
 *  - https://t.me/nft/PlushPepe-412
 *  - t.me/nft/DurovsCap-88
 *  - tg://nft?slug=AstralShard-19
 *  - Plush Pepe #412  /  AstralShard-19
 */
export function parseTelegramGiftLink(
  rawInput: string,
  catalog: CollectionFloorsResponse | null,
): ResolvedGiftLink | null {
  const trimmed = (rawInput ?? '').trim()
  if (!trimmed) return null

  let candidateSlug = trimmed

  // 1. tg://nft?slug=...
  if (/^tg:\/\/nft\b/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      const slugParam = parsed.searchParams.get('slug')
      if (slugParam?.trim()) candidateSlug = slugParam.trim()
    } catch {
      // Fall through
    }
  } else {
    // 2. https://t.me/nft/<Slug>-<Number> or t.me/nft/<Slug>-<Number>
    const tmeMatch = /^(?:https?:\/\/)?(?:www\.)?t\.me\/nft\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/i.exec(trimmed)
    if (tmeMatch?.[1]) {
      candidateSlug = tmeMatch[1]
    } else if (/^https?:\/\//i.test(trimmed)) {
      return null
    }
  }

  // Extract optional trailing serial (#412 or -412)
  let namePart = candidateSlug
  let serialNumber: number | null = null

  const hashMatch = /^(.+?)\s*#\s*(\d{1,9})$/.exec(candidateSlug)
  const dashMatch = /^([A-Za-z0-9_ '’-]+?)-(\d{1,9})$/.exec(candidateSlug)

  if (hashMatch) {
    namePart = hashMatch[1]!.trim()
    serialNumber = Number(hashMatch[2])
  } else if (dashMatch) {
    namePart = dashMatch[1]!.trim()
    serialNumber = Number(dashMatch[2])
  }

  const targetKey = resolveDeepLinkMatchKey(namePart)
  if (!targetKey) return null

  const names = Object.keys(catalog?.collection_floors ?? {})
  const matched =
    names.find(n => resolveDeepLinkMatchKey(n) === targetKey)
    ?? names.find(n => {
      const k = resolveDeepLinkMatchKey(n)
      return k.length >= 4 && targetKey.length >= 4 && (k.startsWith(targetKey) || targetKey.startsWith(k))
    })

  if (!matched) return null

  return {
    collection: matched,
    serialNumber: serialNumber !== null && Number.isSafeInteger(serialNumber) && serialNumber > 0 ? serialNumber : null,
    rawSlug: candidateSlug,
  }
}
