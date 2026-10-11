import { describe, expect, it } from 'vitest'
import {
  lossPerLot,
  lotsForRisk,
  pendingPriceError,
  pipsBetween,
  pipSize,
  roundVolume,
  slFromPips,
  tpFromPips,
} from './trading'

const EURUSD = {
  digits: 5, point: 0.00001, tick_size: 0.00001, tick_value: 1, volume_min: 0.01, volume_max: 50,
  volume_step: 0.01, currency_base: 'EUR', contract_size: 100_000,
}
const USDJPY = { ...EURUSD, digits: 3, point: 0.001, tick_size: 0.001, tick_value: 0.6667, currency_base: 'USD' }
const XAUUSD = { ...EURUSD, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 1, currency_base: 'XAU', contract_size: 100 }
const US30 = { ...EURUSD, digits: 2, point: 0.01, tick_size: 0.01, tick_value: 0.01, currency_base: 'USD', contract_size: 1, volume_min: 0.1, volume_step: 0.1 }

describe('pipSize', () => {
  it('handles FX, JPY, metals and indices', () => {
    expect(pipSize(EURUSD)).toBeCloseTo(0.0001)
    expect(pipSize(USDJPY)).toBeCloseTo(0.01)
    expect(pipSize(XAUUSD)).toBe(0.1)
    expect(pipSize(US30)).toBe(1)
  })
})

describe('SL/TP from pips', () => {
  it('places SL on the losing side and TP on the winning side', () => {
    expect(slFromPips('buy', 1.1, 50, EURUSD)).toBe(1.095)
    expect(tpFromPips('buy', 1.1, 100, EURUSD)).toBe(1.11)
    expect(slFromPips('sell', 1.1, 50, EURUSD)).toBe(1.105)
    expect(tpFromPips('sell', 1.1, 100, EURUSD)).toBe(1.09)
  })

  it('rounds to symbol digits', () => {
    expect(slFromPips('buy', 150.123, 25.5, USDJPY)).toBe(149.868)
  })

  it('round-trips through pipsBetween', () => {
    expect(pipsBetween(1.1, slFromPips('buy', 1.1, 37, EURUSD), EURUSD)).toBeCloseTo(37)
  })
})

describe('lossPerLot', () => {
  it('EURUSD: 50 pips on 1 lot = $500', () => {
    expect(lossPerLot(EURUSD, 1.1, 1.095)).toBeCloseTo(500)
  })
  it('gold: $10 move on 1 lot (100 oz) = $1,000', () => {
    expect(lossPerLot(XAUUSD, 2400, 2390)).toBeCloseTo(1000)
  })
})

describe('lotsForRisk', () => {
  it('sizes to the risk amount, rounding down', () => {
    expect(lotsForRisk(1000, 1.1, 1.095, EURUSD)).toBe(2) // $500/lot
    expect(lotsForRisk(999, 1.1, 1.095, EURUSD)).toBe(1.99)
  })

  it('includes commission', () => {
    expect(lotsForRisk(1000, 1.1, 1.095, EURUSD, 7)).toBe(1.97) // $507/lot
  })

  it('returns 0 when even the minimum volume is too much', () => {
    expect(lotsForRisk(4, 1.1, 1.095, EURUSD)).toBe(0) // 0.01 lot risks $5
  })

  it('returns 0 for a zero-distance stop or no risk budget', () => {
    expect(lotsForRisk(1000, 1.1, 1.1, EURUSD)).toBe(0)
    expect(lotsForRisk(0, 1.1, 1.095, EURUSD)).toBe(0)
  })

  it('respects index volume steps and the maximum', () => {
    expect(lotsForRisk(1000, 42000, 41900, US30)).toBe(10) // 100 points * $1 = $100 per lot
    expect(lotsForRisk(10_000, 42000, 41900, US30)).toBe(50) // capped by volume_max
    expect(lotsForRisk(55, 42000, 41900, US30)).toBe(0.5)
  })

  it('has no floating point drift', () => {
    expect(lotsForRisk(300, 1.1, 1.0999, EURUSD)).toBe(30) // 1 pip = $10/lot
    expect(lotsForRisk(500, 1.03181, 1.03431, EURUSD)).toBe(2) // 25 pips: 1.03431 - 1.03181 = 0.0025000000001
  })
})

describe('roundVolume', () => {
  it('snaps to step and clamps', () => {
    expect(roundVolume(0.123, EURUSD)).toBe(0.12)
    expect(roundVolume(0.001, EURUSD)).toBe(0.01)
    expect(roundVolume(999, EURUSD)).toBe(50)
    expect(roundVolume(0.27, US30)).toBe(0.3)
  })
})

describe('pendingPriceError', () => {
  it('validates limit/stop placement relative to market', () => {
    expect(pendingPriceError('buy', 'limit', 1.09, 1.0998, 1.1)).toBeNull()
    expect(pendingPriceError('buy', 'limit', 1.11, 1.0998, 1.1)).toMatch(/below/)
    expect(pendingPriceError('sell', 'limit', 1.09, 1.0998, 1.1)).toMatch(/above/)
    expect(pendingPriceError('buy', 'stop', 1.09, 1.0998, 1.1)).toMatch(/above/)
    expect(pendingPriceError('sell', 'stop', 1.11, 1.0998, 1.1)).toMatch(/below/)
    expect(pendingPriceError('buy', 'market', 0, 1, 1)).toBeNull()
    expect(pendingPriceError('buy', 'limit', 0, 1, 1)).toMatch(/Enter/)
  })
})
