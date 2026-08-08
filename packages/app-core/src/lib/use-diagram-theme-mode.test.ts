import { describe, expect, it } from 'vitest'
import { resolveDiagramTheme } from './use-diagram-theme-mode'

const base = {
  themeId: 'dark-hard',
  themeFamily: 'gruvbox' as const,
  themeMode: 'dark' as const,
  prefersDark: true,
  customThemes: [],
  overrides: [],
  enabledOverrides: {},
  themeTweaks: {},
  textFont: null
}

describe('resolveDiagramTheme', () => {
  it('gives same-mode built-in variants different render identities', () => {
    const hard = resolveDiagramTheme(base)
    const soft = resolveDiagramTheme({ ...base, themeId: 'dark-soft' })

    expect(hard.mode).toBe('dark')
    expect(soft.mode).toBe('dark')
    expect(hard.key).not.toBe(soft.key)
  })

  it('changes identity when active custom CSS, overrides, tweaks, or text font change', () => {
    const custom = {
      ...base,
      themeId: 'custom-paper',
      themeFamily: 'custom' as const,
      customThemes: [
        {
          slug: 'paper',
          name: 'Paper',
          modes: 'dark' as const,
          css: ':root{}'
        }
      ],
      overrides: [{ name: 'accent.css', css: ':root { --z-accent: 1 2 3; }' }],
      enabledOverrides: { 'accent.css': 'on' }
    }
    const initial = resolveDiagramTheme(custom)

    expect(
      resolveDiagramTheme({
        ...custom,
        customThemes: [{ ...custom.customThemes[0], css: ':root { --z-bg: 1 2 3; }' }]
      }).key
    ).not.toBe(initial.key)
    expect(
      resolveDiagramTheme({
        ...custom,
        overrides: [{ name: 'accent.css', css: ':root { --z-accent: 4 5 6; }' }]
      }).key
    ).not.toBe(initial.key)
    expect(resolveDiagramTheme({ ...custom, themeTweaks: { accent: '#ff0000' } }).key).not.toBe(
      initial.key
    )
    expect(resolveDiagramTheme({ ...custom, textFont: 'Berkeley Mono' }).key).not.toBe(initial.key)
  })
})
