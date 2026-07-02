import { describe, expect, it } from 'vitest'
import { getString, parse } from './args'

// A markdown task passed to `zen capture "- [ ] task"` arrives as one token
// that starts with `-`; it must stay positional, not be parsed as a flag.
describe('cli args parse — leading-dash text', () => {
  it('keeps a markdown task as a positional, not a flag', () => {
    const { positionals, flags } = parse(['capture', '- [ ] buy milk'])
    expect(positionals).toEqual(['capture', '- [ ] buy milk'])
    expect(flags.size).toBe(0)
  })

  it('keeps list items and negative numbers positional', () => {
    expect(parse(['- a list item']).positionals).toEqual(['- a list item'])
    expect(parse(['-5']).positionals).toEqual(['-5'])
  })

  it('still parses real short and long flags', () => {
    expect(parse(['-h']).flags.has('h')).toBe(true)
    expect(getString(parse(['--tag', 'idea']), 'tag')).toBe('idea')
  })

  it('honors `--` to force the rest positional', () => {
    expect(parse(['--', '--not-a-flag']).positionals).toEqual(['--not-a-flag'])
  })
})
