import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isTabStripOverflowing } from './tab-strip-overflow'

const editorPaneSource = readFileSync(
  new URL('../components/EditorPane.tsx', import.meta.url),
  'utf8'
)
const settingsSource = readFileSync(
  new URL('../components/SettingsModal.tsx', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(new URL('../store.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

describe('workspace tab strip overflow styles', () => {
  it('scrolls horizontal tab overflow without lifting tabs, with the scrollbar widget hidden', () => {
    expect(editorPaneSource).toContain('workspace-tab-strip')
    // Flat tabs stay at h-[var(--z-tab-height)] and scroll horizontally when
    // overflowing (no lift/wrap unless "Wrap note tabs" is on).
    expect(editorPaneSource).toContain(
      "tabStripOverflowing ? 'overflow-x-auto' : 'overflow-x-hidden'"
    )
    expect(editorPaneSource).toContain('items-stretch')
    // The scrollbar WIDGET is hidden — trackpad/wheel scroll still works via
    // overflow-x-auto above, but a visible bar in a row this short only masks
    // tab content. Scope the check to the tab strip itself — unrelated
    // surfaces such as the terminal's xterm viewport legitimately style
    // their own ::-webkit-scrollbar too.
    expect(stylesSource).toMatch(
      /\.workspace-tab-strip::-webkit-scrollbar\s*\{[^}]*display:\s*none/s
    )
    // Upstream #421 instead keeps a slim 6px bar visible and asserts the
    // opposite of the rule above. This fork hides the widget outright (both the
    // standard `scrollbar-width` and the WebKit pseudo-element), which makes
    // #421's clipping bug unreachable — no visible bar can eat the tab title —
    // so the hidden-scrollbar design stays and upstream's 6px rule is dropped.
    expect(stylesSource).toMatch(
      /\.workspace-tab-strip[^{]*\{[^}]*scrollbar-width:\s*none/s
    )
  })

  it('does not force the no-wrap tab to the strip height, so the scrollbar cannot clip it (#421)', () => {
    // `min-h-8` only belongs in wrap mode (a floor for wrapped rows). In no-wrap
    // the tab must be free to size to the scroll area so the horizontal scrollbar
    // never overlaps the title in Compact density.
    expect(editorPaneSource).toContain("wrapTabs ? 'min-h-8' : ''")
    expect(editorPaneSource).not.toMatch(/h-full min-h-8 min-w-0/)
  })

  it('persists a setting for wrapping tabs onto additional rows', () => {
    expect(storeSource).toContain('wrapTabs: boolean')
    expect(storeSource).toContain('setWrapTabs')
    expect(settingsSource).toContain('Wrap note tabs')
    expect(editorPaneSource).toContain('wrapTabs')
    expect(editorPaneSource).toContain('flex-wrap')
  })

  it('detects horizontal overflow with a small rounding tolerance', () => {
    expect(isTabStripOverflowing({ scrollWidth: 100, clientWidth: 100 })).toBe(false)
    expect(isTabStripOverflowing({ scrollWidth: 100.5, clientWidth: 100 })).toBe(false)
    expect(isTabStripOverflowing({ scrollWidth: 102, clientWidth: 100 })).toBe(true)
  })
})
