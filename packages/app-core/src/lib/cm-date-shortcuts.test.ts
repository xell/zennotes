import { describe, expect, it } from 'vitest'
import { formatClockTime } from './cm-date-shortcuts'

const at = (h: number, m: number) => new Date(2026, 0, 1, h, m)

describe('formatClockTime', () => {
  it('formats 24-hour with zero-padding', () => {
    expect(formatClockTime(at(14, 30), '24h')).toBe('14:30')
    expect(formatClockTime(at(9, 5), '24h')).toBe('09:05')
    expect(formatClockTime(at(0, 0), '24h')).toBe('00:00')
    expect(formatClockTime(at(23, 59), '24h')).toBe('23:59')
  })

  it('formats 12-hour with AM/PM and no leading-zero hour', () => {
    expect(formatClockTime(at(14, 30), '12h')).toBe('2:30 PM')
    expect(formatClockTime(at(9, 5), '12h')).toBe('9:05 AM')
    expect(formatClockTime(at(0, 0), '12h')).toBe('12:00 AM')
    expect(formatClockTime(at(12, 0), '12h')).toBe('12:00 PM')
    expect(formatClockTime(at(23, 59), '12h')).toBe('11:59 PM')
  })
})
