import type { LaunchSource } from '@evenrealities/even_hub_sdk'
import { readJson, writeJson } from '../lib/storage.ts'

export interface G2HardwarePreferences {
  imuTriageEnabled: boolean
  irlOverheardEnabled: boolean
}

export const HW_PREFS_STORAGE_KEY = 'telegifts_g2_hw_prefs_v1'
export const STARTER_FAVS_FLAG_KEY = 'telegifts_g2_starter_favs_only'

const DEFAULT_HW_PREFS: G2HardwarePreferences = {
  imuTriageEnabled: true,
  irlOverheardEnabled: false,
}

const SYNCED_KEYS = [
  'favorite_collections',
  'telegifts_g2_watchlist_v1',
  'telegifts_g2_relay_cfg_v1',
  HW_PREFS_STORAGE_KEY,
] as const

export interface HostStorageBridgeLike {
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  onLaunchSource?(listener: (source: LaunchSource) => void): () => void
}

const hwPrefsListeners = new Set<() => void>()
const hydrationListeners = new Set<(hydratedKeys: readonly string[]) => void>()
let cachedHwPrefs: G2HardwarePreferences | null = null
let activeHostBridge: HostStorageBridgeLike | null = null

let earlyLaunchListenerInstalled = false
let capturedLaunchSource: LaunchSource | null = null
const earlyLaunchSubscribers = new Set<(source: LaunchSource) => void>()
let patchedStorageRef: Storage | null = null
let rawStorageSetItem: ((key: string, value: string) => void) | null = null

export function installEarlyLaunchSourceCapture(): void {
  if (earlyLaunchListenerInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return
  }
  earlyLaunchListenerInstalled = true
  window.addEventListener('evenAppLaunchSource', (event: Event) => {
    const detail = (event as CustomEvent<{ launchSource?: unknown; source?: unknown } | string>).detail
    const raw =
      typeof detail === 'string'
        ? detail
        : typeof detail?.launchSource === 'string'
          ? detail.launchSource
          : typeof detail?.source === 'string'
            ? detail.source
            : ''
    if (raw === 'glassesMenu' || raw === 'appMenu') {
      if (earlyLaunchSubscribers.size > 0) {
        capturedLaunchSource = null
        for (const listener of [...earlyLaunchSubscribers]) listener(raw)
      } else {
        capturedLaunchSource = raw
      }
    }
  })
}

export function subscribeLaunchSource(
  bridge: HostStorageBridgeLike | null | undefined,
  listener: (source: LaunchSource) => void,
): () => void {
  installEarlyLaunchSourceCapture()
  let deliveredGlassesMenu = false
  const forward = (source: LaunchSource) => {
    if (source === 'glassesMenu') {
      if (deliveredGlassesMenu) return
      deliveredGlassesMenu = true
    }
    capturedLaunchSource = null
    listener(source)
  }

  earlyLaunchSubscribers.add(forward)
  const unsubBridge = bridge?.onLaunchSource?.(forward)
  if (capturedLaunchSource) {
    const pending = capturedLaunchSource
    capturedLaunchSource = null
    queueMicrotask(() => forward(pending))
  }

  return () => {
    earlyLaunchSubscribers.delete(forward)
    unsubBridge?.()
  }
}

export function installLocalStorageHostWriteThrough(): void {
  if (typeof window === 'undefined') return
  let storage: Storage
  try {
    storage = window.localStorage
  } catch {
    return
  }
  if (!storage || patchedStorageRef === storage) return
  patchedStorageRef = storage
  const origSetItem = storage.setItem.bind(storage)
  rawStorageSetItem = origSetItem

  try {
    storage.setItem = (key: string, value: string) => {
      origSetItem(key, value)
      if (key === 'favorite_collections') {
        try {
          storage.removeItem(STARTER_FAVS_FLAG_KEY)
        } catch {
          // ignore
        }
        mirrorKeyToEvenHost(key, value)
      }
    }
  } catch {
    // Ignore frozen Storage prototypes in synthetic test environments
  }
}

export function seedStarterFavoritesIfMissing(starterNames: readonly string[]): void {
  if (typeof window === 'undefined') return
  try {
    const storage = window.localStorage
    if (storage.getItem('favorite_collections') === null) {
      const write = rawStorageSetItem ?? storage.setItem.bind(storage)
      write('favorite_collections', JSON.stringify(starterNames))
      write(STARTER_FAVS_FLAG_KEY, 'true')
    }
  } catch {
    // Ignore storage restrictions
  }
}

function resolveBridge(explicit?: HostStorageBridgeLike | null): HostStorageBridgeLike | null {
  if (explicit) return explicit
  if (activeHostBridge) return activeHostBridge
  const winBridge = (globalThis as { window?: { EvenAppBridge?: HostStorageBridgeLike } }).window?.EvenAppBridge
  return winBridge ?? null
}

export function mirrorKeyToEvenHost(
  key: string,
  serializedValue: string,
  explicitBridge?: HostStorageBridgeLike | null,
): void {
  const bridge = resolveBridge(explicitBridge)
  if (bridge?.setLocalStorage) {
    void bridge.setLocalStorage(key, serializedValue).catch(() => false)
  }
}

export function subscribeHostStorageHydration(
  listener: (hydratedKeys: readonly string[]) => void,
): () => void {
  hydrationListeners.add(listener)
  return () => {
    hydrationListeners.delete(listener)
  }
}

export function getG2HardwarePreferences(): G2HardwarePreferences {
  if (!cachedHwPrefs) {
    const saved = readJson<Partial<G2HardwarePreferences> | null>(HW_PREFS_STORAGE_KEY, null)
    cachedHwPrefs = {
      imuTriageEnabled: typeof saved?.imuTriageEnabled === 'boolean' ? saved.imuTriageEnabled : DEFAULT_HW_PREFS.imuTriageEnabled,
      irlOverheardEnabled:
        typeof saved?.irlOverheardEnabled === 'boolean' ? saved.irlOverheardEnabled : DEFAULT_HW_PREFS.irlOverheardEnabled,
    }
  }
  return cachedHwPrefs
}

export function setG2HardwarePreferences(
  patch: Partial<G2HardwarePreferences>,
  bridge?: HostStorageBridgeLike | null,
): G2HardwarePreferences {
  const next: G2HardwarePreferences = {
    ...getG2HardwarePreferences(),
    ...patch,
  }
  cachedHwPrefs = next
  const serialized = JSON.stringify(next)
  writeJson(HW_PREFS_STORAGE_KEY, next)
  mirrorKeyToEvenHost(HW_PREFS_STORAGE_KEY, serialized, bridge)
  for (const notify of hwPrefsListeners) notify()
  return next
}

export function subscribeG2HardwarePreferences(listener: () => void): () => void {
  hwPrefsListeners.add(listener)
  return () => {
    hwPrefsListeners.delete(listener)
  }
}

export function resetG2HardwarePreferencesForTests(): void {
  cachedHwPrefs = null
  capturedLaunchSource = null
  earlyLaunchListenerInstalled = false
  activeHostBridge = null
}

/**
 * Hydrates missing (or starter-only) browser WebView `localStorage` keys from Even App
 * native host storage (`bridge.getLocalStorage`) without clobbering concurrent user writes,
 * and backs up existing user keys to the host (`bridge.setLocalStorage`).
 */
export async function syncEvenHostStorage(
  bridge: HostStorageBridgeLike | null | undefined,
  keys: readonly string[] = SYNCED_KEYS,
): Promise<{ hydratedKeys: string[]; backedUpKeys: string[] }> {
  const hydratedKeys: string[] = []
  const backedUpKeys: string[] = []
  if (!bridge || typeof window === 'undefined') return { hydratedKeys, backedUpKeys }
  activeHostBridge = bridge

  let storage: Storage | undefined
  try {
    storage = window.localStorage
  } catch {
    return { hydratedKeys, backedUpKeys }
  }
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    return { hydratedKeys, backedUpKeys }
  }

  const rawWrite = rawStorageSetItem ?? storage.setItem.bind(storage)

  for (const key of keys) {
    let localVal: string | null = null
    let isStarterFavOnly = false
    try {
      localVal = storage.getItem(key)
      isStarterFavOnly =
        key === 'favorite_collections' && storage.getItem(STARTER_FAVS_FLAG_KEY) === 'true'
    } catch {
      continue
    }

    const shouldCheckHost = localVal === null || localVal === '' || isStarterFavOnly
    if (shouldCheckHost && typeof bridge.getLocalStorage === 'function') {
      try {
        const hostVal = await bridge.getLocalStorage(key)
        if (typeof hostVal === 'string' && hostVal.trim().length > 0) {
          // Re-check localStorage after await so an in-flight user edit is never clobbered
          const currentLocal = storage.getItem(key)
          const stillStarterFav =
            key === 'favorite_collections' && storage.getItem(STARTER_FAVS_FLAG_KEY) === 'true'
          if (currentLocal === null || currentLocal === '' || stillStarterFav) {
            rawWrite(key, hostVal)
            if (key === 'favorite_collections') {
              storage.removeItem?.(STARTER_FAVS_FLAG_KEY)
            }
            if (key === HW_PREFS_STORAGE_KEY) cachedHwPrefs = null
            hydratedKeys.push(key)
            continue
          }
        }
      } catch {
        // Ignore unsupported host storage
      }
    }

    // Do not overwrite host storage with auto-seeded starter favorites
    if (isStarterFavOnly) continue

    const latestLocal = storage.getItem(key)
    if (latestLocal !== null && latestLocal.length > 0 && typeof bridge.setLocalStorage === 'function') {
      try {
        const ok = await bridge.setLocalStorage(key, latestLocal)
        if (ok) backedUpKeys.push(key)
      } catch {
        // Ignore unsupported host storage
      }
    }
  }

  if (hydratedKeys.includes(HW_PREFS_STORAGE_KEY)) {
    for (const notify of hwPrefsListeners) notify()
  }
  if (hydratedKeys.length > 0) {
    for (const notify of hydrationListeners) notify(hydratedKeys)
  }

  return { hydratedKeys, backedUpKeys }
}
