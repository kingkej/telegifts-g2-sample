import type { CollectionFloorsResponse, CollectionItem } from '../contracts/companion.ts'
import { resolveDeepLinkMatchKey } from './deepLinkMatchKey.ts'

export function resolveCompanionCollection(
  item: CollectionItem,
  catalog: CollectionFloorsResponse | null | undefined,
): CollectionItem {
  const map = catalog?.collection_floors
  if (!map) return item
  if (Object.hasOwn(map, item.name)) {
    return { id: item.id, name: item.name, floors: map[item.name] ?? {} }
  }
  const target = resolveDeepLinkMatchKey(item.name)
  if (!target) return item
  const matches = Object.entries(map).filter(([name]) => resolveDeepLinkMatchKey(name) === target)
  if (matches.length !== 1) return item
  const [canonicalName, floors] = matches[0]!
  return { id: item.id, name: canonicalName, floors: floors ?? {} }
}

export function resolveFavoriteCollections(
  ids: ReadonlySet<string>,
  snapshots: ReadonlyMap<string, { id: string; name: string }>,
  catalog: CollectionFloorsResponse | null | undefined,
): CollectionItem[] {
  const result: CollectionItem[] = []
  for (const id of ids) {
    const snap = snapshots.get(id)
    const name = snap?.name ?? id
    result.push(resolveCompanionCollection({ id, name, floors: {} }, catalog))
  }
  return result
}
