/**
 * Renderer side of custom themes + overrides.
 *
 * A custom theme is a folder of raw CSS (see `@shared/custom-themes`). We inject
 * only the *active* theme's `theme.css` — so an inactive theme's arbitrary or
 * global CSS is never present in the document — into a managed
 * `<style id="zen-active-theme">`, swapping its contents on theme switch.
 * Enabled overrides are concatenated into `<style id="zen-overrides">`, kept last
 * in <head> so they win the cascade over both built-in and custom themes.
 *
 * Light/dark is driven by `data-theme-mode` on <html> (set in App.tsx), so the
 * injected CSS reacts to mode flips without re-injection.
 */
import {
  customThemeSlugFromId,
  isCustomThemeId,
  type CustomTheme,
  type CustomThemeMode
} from '@shared/custom-themes'
import { buildTweaksCss, isOverrideEnabled, type Override } from '@shared/overrides'

export { isCustomThemeId, customThemeSlugFromId }

const ACTIVE_THEME_STYLE_ID = 'zen-active-theme'
const OVERRIDES_STYLE_ID = 'zen-overrides'
const TWEAKS_STYLE_ID = 'zen-tweaks'

/**
 * Create/update/remove a managed `<style>` by id. Empty `css` removes it.
 * Returns the element (or null when removed / no DOM).
 */
function applyManagedStyle(id: string, css: string): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  let style = document.getElementById(id) as HTMLStyleElement | null
  if (!css) {
    style?.remove()
    return null
  }
  if (!style) {
    style = document.createElement('style')
    style.id = id
    document.head.appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
  return style
}

/** Keep the managed layers in cascade order at the end of <head>: active theme →
 *  overrides → tweaks. Re-appending in this order (regardless of when each was
 *  created) guarantees the visual tweaks win, then hand overrides, over the
 *  active theme and the bundled stylesheet. */
function ensureLayerOrder(): void {
  if (typeof document === 'undefined') return
  for (const id of [ACTIVE_THEME_STYLE_ID, OVERRIDES_STYLE_ID, TWEAKS_STYLE_ID]) {
    const el = document.getElementById(id)
    if (el) document.head.appendChild(el)
  }
}

/** Inject (or clear) the active custom theme's raw CSS. Built-in themes — or a
 *  custom id with no matching/erroring theme — clear the managed style. */
export function injectActiveTheme(themeId: string, themes: CustomTheme[]): void {
  const slug = customThemeSlugFromId(themeId)
  const theme = slug ? themes.find((t) => t.slug === slug && !t.error) : undefined
  applyManagedStyle(ACTIVE_THEME_STYLE_ID, theme?.css ?? '')
  ensureLayerOrder()
}

/** Inject the enabled overrides (filename order) after the active theme. */
export function injectOverrides(
  overrides: Override[],
  enabled: Record<string, string> | undefined
): void {
  const css = overrides
    .filter((s) => !s.error && isOverrideEnabled(enabled, s.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `/* @override ${s.name} */\n${s.css.trim()}`)
    .join('\n\n')
  applyManagedStyle(OVERRIDES_STYLE_ID, css)
  ensureLayerOrder()
}

/** Inject the visual color tweaks (the picker UI) as the topmost managed layer,
 *  so an explicit pick wins over the active theme and any hand override. */
export function injectTweaks(tweaks: Record<string, string> | undefined): void {
  applyManagedStyle(TWEAKS_STYLE_ID, buildTweaksCss(tweaks))
  ensureLayerOrder()
}

/**
 * Resolve which mode a custom theme should render in. A single-mode theme pins
 * its one mode; a `both` theme follows the requested light/dark preference
 * (used for "auto" and to clamp an explicit choice the theme doesn't support).
 */
export function resolveCustomThemeMode(
  theme: Pick<CustomTheme, 'modes'> | undefined,
  prefersDark: boolean
): CustomThemeMode {
  if (theme) {
    if (theme.modes === 'light') return 'light'
    if (theme.modes === 'dark') return 'dark'
  }
  return prefersDark ? 'dark' : 'light'
}
