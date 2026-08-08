import { describe, expect, it } from 'vitest'
import {
  isPaneMode,
  paneModeForPath,
  paneModesWithPathMode,
  type PaneModesByPath
} from './pane-mode'

describe('pane mode by path', () => {
  it('defaults newly opened notes to edit mode without changing remembered notes', () => {
    let modesByPath: PaneModesByPath = {}

    modesByPath = paneModesWithPathMode(modesByPath, 'inbox/One.md', 'preview')

    expect(paneModeForPath(modesByPath, 'inbox/One.md')).toBe('preview')
    expect(paneModeForPath(modesByPath, 'inbox/Two.md')).toBe('edit')

    modesByPath = paneModesWithPathMode(modesByPath, 'inbox/Two.md', 'split')

    expect(paneModeForPath(modesByPath, 'inbox/One.md')).toBe('preview')
    expect(paneModeForPath(modesByPath, 'inbox/Two.md')).toBe('split')
    expect(paneModeForPath(modesByPath, 'inbox/Three.md')).toBe('edit')
  })
})

describe('paneModeForPath fallback (#543)', () => {
  it('opens an unremembered note in the given default mode', () => {
    expect(paneModeForPath({}, 'a.md', 'preview')).toBe('preview')
    expect(paneModeForPath({}, 'a.md', 'split')).toBe('split')
    expect(paneModeForPath({}, null, 'preview')).toBe('preview')
  })

  it('a remembered per-note mode outranks the default', () => {
    const modes = paneModesWithPathMode({}, 'a.md', 'edit')
    expect(paneModeForPath(modes, 'a.md', 'preview')).toBe('edit')
  })

  it('isPaneMode accepts only the three modes', () => {
    expect(isPaneMode('edit')).toBe(true)
    expect(isPaneMode('preview')).toBe(true)
    expect(isPaneMode('split')).toBe(true)
    expect(isPaneMode('reading')).toBe(false)
    expect(isPaneMode(undefined)).toBe(false)
  })
})
