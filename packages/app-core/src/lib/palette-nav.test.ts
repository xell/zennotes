import type { KeyboardEvent } from 'react'
import { describe, expect, it } from 'vitest'
import { isPaletteNextKey, isPalettePreviousKey, paletteJumpIndexFromEvent } from './palette-nav'

function key(init: Partial<KeyboardEvent<HTMLElement>>): KeyboardEvent<HTMLElement> {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init
  } as KeyboardEvent<HTMLElement>
}

// Mirrors keymaps.test.ts's withPlatform helper — isMacPlatform() reads
// window.zen.platformSync() when present, so tests stay deterministic
// regardless of the machine actually running them.
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const host = globalThis as typeof globalThis & {
    window?: { zen?: { platformSync?: () => NodeJS.Platform } }
  }
  const previousWindow = host.window
  Object.defineProperty(host, 'window', {
    value: {
      ...(previousWindow ?? {}),
      zen: { ...(previousWindow?.zen ?? {}), platformSync: () => platform }
    },
    configurable: true
  })
  try {
    return run()
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(host, 'window')
    } else {
      Object.defineProperty(host, 'window', { value: previousWindow, configurable: true })
    }
  }
}

describe('isPaletteNextKey', () => {
  it('matches ArrowDown', () => {
    expect(isPaletteNextKey(key({ key: 'ArrowDown' }))).toBe(true)
  })

  it('matches Ctrl+N and the vim-style Ctrl+J', () => {
    expect(isPaletteNextKey(key({ key: 'n', ctrlKey: true }))).toBe(true)
    expect(isPaletteNextKey(key({ key: 'j', ctrlKey: true }))).toBe(true)
    expect(isPaletteNextKey(key({ key: 'J', ctrlKey: true }))).toBe(true)
  })

  it('ignores the chord when Meta or Alt is also held', () => {
    expect(isPaletteNextKey(key({ key: 'j', ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'n', ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('does not match the previous-item keys', () => {
    expect(isPaletteNextKey(key({ key: 'k', ctrlKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'p', ctrlKey: true }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'ArrowUp' }))).toBe(false)
  })

  it('requires Ctrl for the letter chords', () => {
    expect(isPaletteNextKey(key({ key: 'j' }))).toBe(false)
    expect(isPaletteNextKey(key({ key: 'n' }))).toBe(false)
  })
})

describe('isPalettePreviousKey', () => {
  it('matches ArrowUp', () => {
    expect(isPalettePreviousKey(key({ key: 'ArrowUp' }))).toBe(true)
  })

  it('matches Ctrl+P and the vim-style Ctrl+K', () => {
    expect(isPalettePreviousKey(key({ key: 'p', ctrlKey: true }))).toBe(true)
    expect(isPalettePreviousKey(key({ key: 'k', ctrlKey: true }))).toBe(true)
    expect(isPalettePreviousKey(key({ key: 'K', ctrlKey: true }))).toBe(true)
  })

  it('ignores the chord when Meta or Alt is also held', () => {
    expect(isPalettePreviousKey(key({ key: 'k', ctrlKey: true, metaKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'p', ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('does not match the next-item keys', () => {
    expect(isPalettePreviousKey(key({ key: 'j', ctrlKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'n', ctrlKey: true }))).toBe(false)
    expect(isPalettePreviousKey(key({ key: 'ArrowDown' }))).toBe(false)
  })
})

describe('paletteJumpIndexFromEvent', () => {
  it('maps Cmd+1..9 to a 0-based index on Mac', () => {
    withPlatform('darwin', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '1', metaKey: true }))).toBe(0)
      expect(paletteJumpIndexFromEvent(key({ key: '9', metaKey: true }))).toBe(8)
    })
  })

  it('maps Ctrl+1..9 to a 0-based index off Mac', () => {
    withPlatform('linux', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '1', ctrlKey: true }))).toBe(0)
      expect(paletteJumpIndexFromEvent(key({ key: '9', ctrlKey: true }))).toBe(8)
    })
  })

  it('ignores the platform-wrong modifier', () => {
    withPlatform('darwin', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '1', ctrlKey: true }))).toBeNull()
    })
    withPlatform('linux', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '1', metaKey: true }))).toBeNull()
    })
  })

  it('ignores Mod+0 and non-digit keys', () => {
    withPlatform('darwin', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '0', metaKey: true }))).toBeNull()
      expect(paletteJumpIndexFromEvent(key({ key: 'a', metaKey: true }))).toBeNull()
    })
  })

  it('ignores the chord when Shift or Alt is also held (e.g. Cmd+Shift+1)', () => {
    withPlatform('darwin', () => {
      expect(
        paletteJumpIndexFromEvent(key({ key: '1', metaKey: true, shiftKey: true }))
      ).toBeNull()
      expect(
        paletteJumpIndexFromEvent(key({ key: '1', metaKey: true, altKey: true }))
      ).toBeNull()
    })
  })

  it('ignores plain digits with no modifier', () => {
    withPlatform('darwin', () => {
      expect(paletteJumpIndexFromEvent(key({ key: '1' }))).toBeNull()
    })
  })
})
