import { describe, expect, it } from 'vitest'
import { priorityLevel, scanTaskMetadata } from './task-metadata-tokens'

const kinds = (text: string): string[] =>
  scanTaskMetadata(text).map((t) => `${t.kind}:${t.text}`)

describe('scanTaskMetadata (#454, #479)', () => {
  it('finds the three token kinds in document order', () => {
    expect(kinds('Ship it !high due:2026-07-20 @waiting')).toEqual([
      'priority:!high',
      'due:due:2026-07-20',
      'field:@waiting'
    ])
  })

  it('maps every priority spelling onto its level', () => {
    expect(['!high', '!h', '!HIGH'].map(priorityLevel)).toEqual(['high', 'high', 'high'])
    expect(['!med', '!medium', '!m'].map(priorityLevel)).toEqual(['med', 'med', 'med'])
    expect(['!low', '!l'].map(priorityLevel)).toEqual(['low', 'low'])
  })

  it('only matches tokens that start a word', () => {
    // Glued to a preceding word these are not metadata, they are prose.
    expect(scanTaskMetadata('wow!high and mail@waiting and overdue:2026-01-01')).toEqual([])
  })

  it('ignores a due token whose date is not a real ISO date', () => {
    expect(kinds('Bad date due:soon and due:2026-13')).toEqual([])
    expect(kinds('Good due:2026-01-31')).toEqual(['due:due:2026-01-31'])
  })

  it('reports offsets that bracket the token text exactly', () => {
    const text = 'Ship it !high now'
    const [token] = scanTaskMetadata(text)
    expect(text.slice(token.start, token.end)).toBe('!high')
  })

  it('carries the ISO date on due tokens for the overdue decision', () => {
    const [due] = scanTaskMetadata('Renew due:2026-07-20')
    expect(due.kind).toBe('due')
    expect(due.date).toBe('2026-07-20')
  })
})
