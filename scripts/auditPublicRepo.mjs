import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.vite', 'dist'])
const BINARY_EXTS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.ico', '.wasm', '.bin', '.ehpk', '.woff', '.woff2', '.mp4'])
const FORBIDDEN_FILE_EXTS = new Set(['.keystore', '.jks', '.pem', '.key', '.p12', '.pfx', '.map'])

const FORBIDDEN_PATTERNS = [
  { name: 'Private purchase endpoint', regex: /\/api\/c\//i },
  { name: 'Android keystore reference', regex: /[\w-]+-(?:release|upload)\.keystore/i },
  { name: 'Live Telegram bot token literal', regex: /\b\d{8,12}:[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Non-empty TELEGRAM_BOT_TOKEN assignment', regex: /^TELEGRAM_BOT_TOKEN=\S+/m },
  { name: 'Non-empty RELAY_AUTH_TOKEN assignment', regex: /^RELAY_AUTH_TOKEN=\S+/m },
  { name: 'Private cryptographic key block', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Out-of-track Alpaca integration', regex: /alpaca\.markets/i },
  { name: 'Out-of-track Notion API', regex: /api\.notion\.com/i },
  { name: 'Build-time relay token variable', regex: /VITE_TELEGRAM_RELAY_TOKEN/ },
]

// SHA-256 prefixes (24 hex chars) + exact lengths of private internal identifiers
// checked across every sliding window inside word-character runs (standalone or embedded).
const FORBIDDEN_HASH_ENTRIES = [
  { len: 15, hash: 'fc36ae5a9d4a45d8f9427423', label: 'Internal private workspace identifier' },
  { len: 10, hash: 'd65d0f47240cc1fd8e64f9fb', label: 'Internal private swap domain' },
  { len: 14, hash: 'deb6845ce6664f1b51c288fa', label: 'Internal private bot handle' },
]

export function sha256Prefix(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 24)
}

export function findForbiddenHashedTokens(content, entries = FORBIDDEN_HASH_ENTRIES) {
  if (!entries.length) return []
  const byLength = new Map()
  let minLen = Infinity
  for (const entry of entries) {
    if (entry.len < minLen) minLen = entry.len
    let map = byLength.get(entry.len)
    if (!map) {
      map = new Map()
      byLength.set(entry.len, map)
    }
    map.set(entry.hash, entry.label)
  }

  const hits = new Set()
  const seenWindows = new Set()
  for (const match of content.matchAll(/[a-z0-9_]+/gi)) {
    const run = match[0].toLowerCase()
    if (run.length < minLen) continue
    for (const [len, hashes] of byLength) {
      if (run.length < len) continue
      for (let i = 0; i <= run.length - len; i++) {
        const sub = run.slice(i, i + len)
        if (seenWindows.has(sub)) continue
        seenWindows.add(sub)
        const label = hashes.get(sha256Prefix(sub))
        if (label) hits.add(label)
      }
    }
  }
  return [...hits]
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walk(full)))
    } else {
      files.push(full)
    }
  }
  return files
}

async function main() {
  const violations = []
  const files = await walk(ROOT)

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll('\\', '/')
    if (rel === 'scripts/auditPublicRepo.mjs') continue
    const base = basename(rel)
    const dot = base.lastIndexOf('.')
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : ''

    if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') {
      violations.push(`${rel}: forbidden environment secret file present in workspace`)
      continue
    }
    if (FORBIDDEN_FILE_EXTS.has(ext)) {
      violations.push(`${rel}: forbidden key or sourcemap file (${ext}) present in workspace`)
      continue
    }
    if (BINARY_EXTS.has(ext) || /(?:^|\/)(?:means|variances|sendump|mdef)-[\w-]+\.?$/.test(rel)) continue

    const info = await stat(file)
    if (info.size > 15 * 1024 * 1024) continue

    const content = await readFile(file, 'utf8')
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.regex.test(content)) {
        violations.push(`${rel}: matched forbidden pattern "${rule.name}"`)
      }
    }

    for (const label of findForbiddenHashedTokens(content)) {
      violations.push(`${rel}: matched forbidden internal identifier (${label})`)
    }
  }

  // Validate app.json manifest
  const appJson = JSON.parse(await readFile(join(ROOT, 'app.json'), 'utf8'))
  if (!appJson.package_id || !appJson.version || !appJson.entrypoint) {
    violations.push('app.json: missing required Even Hub manifest fields')
  }
  const whitelist = appJson.permissions?.find(p => p.name === 'network')?.whitelist ?? []
  if (whitelist.includes('https://api.telegram.org')) {
    violations.push('app.json: https://api.telegram.org must stay server-side in server/telegramRelay.mjs')
  }

  // Ensure vendor bundle license notice is present
  try {
    await stat(join(ROOT, 'vendor/telegifts-phone/NOTICE'))
  } catch {
    violations.push('vendor/telegifts-phone/NOTICE: missing license notice for pre-built companion bundle')
  }

  if (violations.length > 0) {
    console.error('Public repo hygiene audit FAILED:')
    for (const v of violations) console.error(' - ' + v)
    process.exit(1)
  }

  console.log(`Public repo hygiene audit PASSED (${files.length} workspace files scanned, 0 secret/scope violations).`)
}

const isEntrypoint = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
if (isEntrypoint) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
