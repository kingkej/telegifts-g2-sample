const memoryFallback = new Map<string, string>()

function keyWithScope(key: string, scope?: string | null): string {
  return scope ? `${key}::${scope}` : key
}

export function readString(key: string, fallback = '', scope?: string | null): string {
  const fullKey = keyWithScope(key, scope)
  try {
    const value = globalThis.localStorage?.getItem(fullKey)
    if (value !== null && value !== undefined) return value
  } catch {
    // WebView or Node test context without localStorage.
  }
  return memoryFallback.get(fullKey) ?? fallback
}

export function writeString(key: string, value: string, scope?: string | null): void {
  const fullKey = keyWithScope(key, scope)
  memoryFallback.set(fullKey, value)
  try {
    globalThis.localStorage?.setItem(fullKey, value)
  } catch {
    // Keep in-memory copy for current session.
  }
}

export function readJson<T>(key: string, fallback: T, scope?: string | null): T {
  const raw = readString(key, '', scope)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown, scope?: string | null): void {
  writeString(key, JSON.stringify(value), scope)
}
