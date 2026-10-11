import { describe, expect, it } from 'vitest'
import { price, serverTime } from './format'

describe('format', () => {
  it('formats prices to symbol digits', () => {
    expect(price(1.2, 5)).toBe('1.20000')
    expect(price(2412.456, 2)).toBe('2412.46')
  })

  it('renders server time verbatim, ignoring the browser timezone', () => {
    expect(serverTime(1_791_734_400)).toBe('2026-10-11 16:00')
  })
})
