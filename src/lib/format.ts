const marketPrecision = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  roundingMode: 'halfEven',
} as const

const companionUsdt = new Intl.NumberFormat('en-US', marketPrecision)
const companionGram = new Intl.NumberFormat('en-US', { ...marketPrecision, minimumFractionDigits: 0 })
const changeFormat = new Intl.NumberFormat('en-US', {
  ...marketPrecision,
  signDisplay: 'always',
  useGrouping: false,
})
const standardPrice = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})
const compactTenths = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const compactWhole = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 })

export function formatPriceNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return standardPrice.format(value)
}

export function formatCompactPrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 100) return formatPriceNumber(value)
  const whole = Math.round(value)
  if (whole < 1000) return String(whole)
  const oneDecimal = compactTenths.format(whole)
  return oneDecimal.length <= 5 ? oneDecimal : compactWhole.format(whole)
}

export function formatCompanionPrice(amount: number): string {
  if (!Number.isFinite(amount)) return '—'
  return amount > 0 && amount < 0.01 ? '<0.01' : companionGram.format(amount)
}

export function formatCompanionUsdtEstimate(
  tonAmount: number | null | undefined,
  tonPriceUsd: number | null | undefined,
): string {
  if (tonAmount === null || tonAmount === undefined || tonPriceUsd === null || tonPriceUsd === undefined) return '--'
  if (!Number.isFinite(tonAmount) || !Number.isFinite(tonPriceUsd)) return '--'
  const usdtAmount = tonAmount * tonPriceUsd
  if (!Number.isFinite(usdtAmount)) return '--'
  return companionUsdt.format(usdtAmount)
}

export function formatMarketChange(percent: number, digits: 1 | 2 = 2): string {
  if (!Number.isFinite(percent)) return '—'
  return digits === 2 ? changeFormat.format(percent) + '%' : `${percent < 0 ? '' : '+'}${percent.toFixed(1)}%`
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`
  return standardPrice.format(value)
}
