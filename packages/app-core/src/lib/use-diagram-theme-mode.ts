/**
 * Resolved diagram palette plus an identity for every setting that can change
 * the CSS variables Mermaid reads while building its SVG.
 *
 * Light/dark alone is not enough: two dark built-in variants have different
 * colours, and custom theme CSS, enabled overrides, tweaks, and the text font
 * can all change without flipping the mode. The identity makes those changes
 * invalidate rendered diagrams in both Preview and the editor's live preview.
 */
import { useEffect, useMemo, useState } from 'react'

import type { CustomTheme } from '@shared/custom-themes'
import { customThemeSlugFromId } from '@shared/custom-themes'
import type { Override } from '@shared/overrides'
import { isOverrideEnabled } from '@shared/overrides'
import { useStore } from '../store'
import { resolveCustomThemeMode } from './custom-themes'
import { findTheme, resolveAuto, type ThemeFamily, type ThemeMode } from './themes'

export interface DiagramTheme {
  mode: 'light' | 'dark'
  key: string
}

export interface DiagramThemeInput {
  themeId: string
  themeFamily: ThemeFamily
  themeMode: ThemeMode
  prefersDark: boolean
  customThemes: readonly CustomTheme[]
  overrides: readonly Override[]
  enabledOverrides: Record<string, string>
  themeTweaks: Record<string, string>
  textFont: string | null
}

function sortedEntries(values: Record<string, string>): [string, string][] {
  return Object.entries(values).sort(([a], [b]) => a.localeCompare(b))
}

/** Pure resolver kept separate from the hook so cache invalidation is easy to
 * exercise without mounting React. */
export function resolveDiagramTheme(input: DiagramThemeInput): DiagramTheme {
  const customSlug = customThemeSlugFromId(input.themeId)
  const customTheme = customSlug
    ? input.customThemes.find((theme) => theme.slug === customSlug)
    : undefined
  const requestedDark = input.themeMode === 'auto' ? input.prefersDark : input.themeMode === 'dark'
  const resolvedId = customSlug
    ? input.themeId
    : input.themeMode === 'auto'
      ? resolveAuto(input.themeFamily, input.prefersDark, input.themeId)
      : input.themeId
  const mode = customSlug
    ? resolveCustomThemeMode(customTheme, requestedDark)
    : findTheme(resolvedId).mode
  const activeCustomCss = customTheme && !customTheme.error ? customTheme.css : ''
  const activeOverrides = input.overrides
    .filter(
      (override) =>
        !override.error && isOverrideEnabled(input.enabledOverrides, override.name)
    )
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((override) => [override.name, override.css])

  return {
    mode,
    key: JSON.stringify([
      resolvedId,
      mode,
      activeCustomCss,
      activeOverrides,
      sortedEntries(input.themeTweaks),
      input.textFont
    ])
  }
}

function prefersDarkNow(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function useDiagramTheme(): DiagramTheme {
  const themeId = useStore((s) => s.themeId)
  const themeFamily = useStore((s) => s.themeFamily)
  const themeMode = useStore((s) => s.themeMode)
  const customThemes = useStore((s) => s.customThemes)
  const overrides = useStore((s) => s.overrides)
  const enabledOverrides = useStore((s) => s.enabledOverrides)
  const themeTweaks = useStore((s) => s.themeTweaks)
  const textFont = useStore((s) => s.textFont)
  const [prefersDark, setPrefersDark] = useState(prefersDarkNow)

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event: MediaQueryListEvent): void => setPrefersDark(event.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return useMemo(
    () =>
      resolveDiagramTheme({
        themeId,
        themeFamily,
        themeMode,
        prefersDark,
        customThemes,
        overrides,
        enabledOverrides,
        themeTweaks,
        textFont
      }),
    [
      themeId,
      themeFamily,
      themeMode,
      prefersDark,
      customThemes,
      overrides,
      enabledOverrides,
      themeTweaks,
      textFont
    ]
  )
}

/** Resolve the initial editor extension outside React. */
export function documentDiagramTheme(): DiagramTheme {
  const state = useStore.getState()
  return resolveDiagramTheme({
    themeId: state.themeId,
    themeFamily: state.themeFamily,
    themeMode: state.themeMode,
    prefersDark: prefersDarkNow(),
    customThemes: state.customThemes,
    overrides: state.overrides,
    enabledOverrides: state.enabledOverrides,
    themeTweaks: state.themeTweaks,
    textFont: state.textFont
  })
}
