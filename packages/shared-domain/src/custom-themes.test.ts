import { describe, it, expect } from 'vitest'
import {
  parseColor,
  deriveThemeTokens,
  parseThemeManifest,
  scaffoldThemeCss,
  readTomlPalettes,
  customThemeId,
  isCustomThemeId,
  customThemeSlugFromId,
  customThemeSupportsMode
} from './custom-themes'

describe('parseColor', () => {
  it('parses #rrggbb, #rgb, rgb(), and bare triplets', () => {
    expect(parseColor('#eee6dd')).toEqual([238, 230, 221])
    expect(parseColor('eee6dd')).toEqual([238, 230, 221])
    expect(parseColor('#fff')).toEqual([255, 255, 255])
    expect(parseColor('rgb(48, 52, 70)')).toEqual([48, 52, 70])
    expect(parseColor('48 52 70')).toEqual([48, 52, 70])
  })

  it('rejects garbage and out-of-range values', () => {
    expect(parseColor('not-a-color')).toBeNull()
    expect(parseColor('300 0 0')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor(undefined)).toBeNull()
  })
})

describe('deriveThemeTokens', () => {
  it('maps a palette onto the full --z-* token set as RGB triplets', () => {
    const tokens = deriveThemeTokens({ bg: '#eee6dd', text: '#575279', accent: '#1a7da4' }, 'light')
    expect(tokens).not.toBeNull()
    expect(tokens!['--z-bg']).toBe('238 230 221')
    expect(tokens!['--z-fg-1']).toBe('87 82 121')
    expect(tokens!['--z-accent']).toBe('26 125 164')
    expect(tokens!['color-scheme']).toBe('light')
    for (const value of Object.values(tokens!)) {
      if (value === 'light' || value === 'dark') continue
      if (!/^\d/.test(value)) continue
      for (const n of value.split(' ').map(Number)) {
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThanOrEqual(255)
      }
    }
  })

  it('maps the optional chrome color to --z-bg-softer (else derives it)', () => {
    const withChrome = deriveThemeTokens(
      { bg: '#303446', chrome: '#292c3c', text: '#c6ceef', accent: '#85c1dc' },
      'dark'
    )
    expect(withChrome!['--z-bg']).toBe('48 52 70') // #303446
    expect(withChrome!['--z-bg-softer']).toBe('41 44 60') // #292c3c
    const without = deriveThemeTokens({ bg: '#303446', text: '#c6ceef', accent: '#85c1dc' }, 'dark')
    expect(without!['--z-bg-softer']).toMatch(/^\d+ \d+ \d+$/)
  })

  it('uses the dark glass alphas in dark mode', () => {
    const tokens = deriveThemeTokens({ bg: '#303446', text: '#c6ceef', accent: '#8caaee' }, 'dark')
    expect(tokens!['color-scheme']).toBe('dark')
    expect(tokens!['--z-glass-a1']).toBe('0.58')
  })

  it('returns null when a required color is missing or invalid', () => {
    expect(deriveThemeTokens({ bg: '#fff', text: '#000', accent: 'nope' }, 'light')).toBeNull()
    // @ts-expect-error — exercising the missing-required path
    expect(deriveThemeTokens({ bg: '#fff', text: '#000' }, 'light')).toBeNull()
  })
})

describe('custom theme ids', () => {
  it('formats and round-trips a single id', () => {
    expect(customThemeId('soft-paper')).toBe('custom-soft-paper')
    expect(isCustomThemeId('custom-soft-paper')).toBe(true)
    expect(isCustomThemeId('dark-hard')).toBe(false)
    expect(customThemeSlugFromId('custom-soft-paper')).toBe('soft-paper')
    expect(customThemeSlugFromId('dark-hard')).toBeNull()
    // A slug ending in -dark is preserved (no legacy stripping here).
    expect(customThemeSlugFromId('custom-my-dark')).toBe('my-dark')
  })
})

describe('parseThemeManifest', () => {
  it('reads fields and falls back to the slug for the name', () => {
    const m = parseThemeManifest(
      { name: 'Soft Paper', author: 'Nick', version: '1.0.0', modes: 'both' },
      'soft-paper'
    )
    expect(m.name).toBe('Soft Paper')
    expect(m.author).toBe('Nick')
    expect(m.modes).toBe('both')

    expect(parseThemeManifest({}, 'my-theme').name).toBe('my-theme')
    expect(parseThemeManifest(null, 'x').name).toBe('x')
  })

  it('normalizes modes (string or array) and defaults to both', () => {
    expect(parseThemeManifest({ modes: 'dark' }, 's').modes).toBe('dark')
    expect(parseThemeManifest({ modes: ['light', 'dark'] }, 's').modes).toBe('both')
    expect(parseThemeManifest({ modes: ['dark'] }, 's').modes).toBe('dark')
    expect(parseThemeManifest({ modes: 'nonsense' }, 's').modes).toBe('both')
    expect(parseThemeManifest({}, 's').modes).toBe('both')
  })

  it('keeps a preview only when it has at least one color', () => {
    expect(parseThemeManifest({ preview: { light: '#fff', dark: '#000' } }, 's').preview).toEqual({
      light: '#fff',
      dark: '#000'
    })
    expect(parseThemeManifest({ preview: {} }, 's').preview).toBeUndefined()
  })
})

describe('customThemeSupportsMode', () => {
  it('honors single-mode and both', () => {
    expect(customThemeSupportsMode({ modes: 'both' }, 'light')).toBe(true)
    expect(customThemeSupportsMode({ modes: 'both' }, 'dark')).toBe(true)
    expect(customThemeSupportsMode({ modes: 'dark' }, 'light')).toBe(false)
    expect(customThemeSupportsMode({ modes: 'dark' }, 'dark')).toBe(true)
    expect(customThemeSupportsMode({ modes: 'light' }, 'dark')).toBe(false)
  })
})

describe('scaffoldThemeCss', () => {
  it('emits :root + dark-mode blocks from palettes', () => {
    const css = scaffoldThemeCss({
      name: 'T',
      slug: 't',
      light: { bg: '#ffffff', text: '#000000', accent: '#0000ff' },
      dark: { bg: '#000000', text: '#ffffff', accent: '#00aaff' }
    })
    expect(css).toContain(':root {')
    expect(css).toContain(':root[data-theme-mode="dark"] {')
    expect(css).toContain('--z-bg: 255 255 255;')
    expect(css).toContain('--z-bg: 0 0 0;')
    // Header teaches the theme-relative asset URL using the slug.
    expect(css).toContain('zen-theme://t/')
  })

  it('omits the dark block when only a light palette is given', () => {
    const css = scaffoldThemeCss({ name: 'L', light: { bg: '#fff', text: '#000', accent: '#00f' } })
    expect(css).toContain(':root {')
    expect(css).not.toContain(':root[data-theme-mode="dark"] {')
  })
})

describe('readTomlPalettes', () => {
  it('extracts name + light/dark palettes (snake_case keys)', () => {
    const out = readTomlPalettes({
      name: 'Soft Paper',
      light: { bg: '#eee6dd', text: '#575279', accent: '#1a7da4', accent_soft: '#56949f' },
      dark: { bg: '#303446', text: '#c6ceef', accent: '#8caaee' }
    })
    expect(out.name).toBe('Soft Paper')
    expect(out.light?.accentSoft).toBe('#56949f')
    expect(out.dark?.bg).toBe('#303446')
  })

  it('omits a palette table missing a required color', () => {
    const out = readTomlPalettes({ light: { bg: '#fff' }, dark: { bg: '#111', text: '#eee', accent: '#0af' } })
    expect(out.light).toBeUndefined()
    expect(out.dark).toBeDefined()
  })
})
