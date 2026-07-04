import { describe, expect, it } from 'vitest'
import { renderHelp, renderVersion } from './help'

// Strip ANSI color codes so assertions run on plain text.
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('CLI renders the `zn` command name, never legacy `zen` (#126)', () => {
  it('USAGE, examples, and hints use `zn`', () => {
    const help = plain(renderHelp())
    expect(help).toContain('zn <command>')
    expect(help).toContain('Install `zn`')
    expect(help).toContain('Run `zn <command>`')
    // No bare legacy command anywhere (case-sensitive: leaves ZENNOTES_*, ZenNotes).
    expect(help).not.toMatch(/\bzen\b/)
  })

  it('version line is `zn vX.Y.Z`', () => {
    expect(plain(renderVersion())).toMatch(/^zn v\d/)
  })
})
