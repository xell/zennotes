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
  it('keeps horizontal tab overflow visible without lifting tabs', () => {
    expect(editorPaneSource).toContain('workspace-tab-strip')
    // Flat tabs stay at h-10 and scroll horizontally when overflowing (no lift).
    expect(editorPaneSource).toContain(
      "tabStripOverflowing ? 'overflow-x-auto' : 'overflow-x-hidden'"
    )
    expect(editorPaneSource).toContain('items-stretch')
    // The tab strip must not HIDE its scrollbar (overflow stays visible). Scope
    // the check to the tab strip itself — unrelated surfaces such as the
    // terminal's xterm viewport legitimately style their own ::-webkit-scrollbar,
    // so a stylesheet-wide `not.toContain('::-webkit-scrollbar')` is too broad.
    expect(stylesSource).not.toMatch(
      /\.workspace-tab-strip::-webkit-scrollbar\s*\{[^}]*display:\s*none/s
    )
    expect(stylesSource).not.toMatch(
      /\.workspace-tab-strip[^{]*\{[^}]*scrollbar-width:\s*none/s
    )
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
