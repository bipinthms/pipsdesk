export function money(value: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currencyDisplay: 'narrowSymbol',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function signedMoney(value: number, currency = 'USD'): string {
  return (value > 0 ? '+' : '') + money(value, currency)
}

export function price(value: number, digits: number): string {
  return value.toFixed(digits)
}

/** Format an MT5 server-time epoch (seconds) without applying the browser's timezone. */
export function serverTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16)
}
