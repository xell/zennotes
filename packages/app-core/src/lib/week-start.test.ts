// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { localeFirstDay, resolveWeekStartDay } from './week-start'

describe('resolveWeekStartDay (#300 — shared week-start resolution)', () => {
  it('maps sunday to 0 and monday to 1', () => {
    expect(resolveWeekStartDay('sunday')).toBe(0)
    expect(resolveWeekStartDay('monday')).toBe(1)
  })

  it('maps locale to the resolved locale first day', () => {
    expect(resolveWeekStartDay('locale')).toBe(localeFirstDay())
  })

  it('localeFirstDay returns a valid weekday index (0..6)', () => {
    const day = localeFirstDay()
    expect(Number.isInteger(day)).toBe(true)
    expect(day).toBeGreaterThanOrEqual(0)
    expect(day).toBeLessThanOrEqual(6)
  })
})
