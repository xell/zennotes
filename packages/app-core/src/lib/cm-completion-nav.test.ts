import { completionKeymap } from '@codemirror/autocomplete'
import { describe, expect, it } from 'vitest'
import { completionKeymapForEditor, completionNavDirection } from './cm-completion-nav'

function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init
  } as KeyboardEvent
}

describe('completionNavDirection', () => {
  it('maps Ctrl+N and Ctrl+J to next', () => {
    expect(completionNavDirection(key({ key: 'n', ctrlKey: true }))).toBe('next')
    expect(completionNavDirection(key({ key: 'j', ctrlKey: true }))).toBe('next')
    expect(completionNavDirection(key({ key: 'J', ctrlKey: true }))).toBe('next')
  })

  it('maps Ctrl+P and Ctrl+K to previous', () => {
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true }))).toBe('previous')
    expect(completionNavDirection(key({ key: 'k', ctrlKey: true }))).toBe('previous')
    expect(completionNavDirection(key({ key: 'K', ctrlKey: true }))).toBe('previous')
  })

  it('only fires for a bare Ctrl chord', () => {
    expect(completionNavDirection(key({ key: 'p' }))).toBeNull()
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, metaKey: true }))).toBeNull()
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, altKey: true }))).toBeNull()
    // Shift is left alone so Ctrl+Shift+P still reaches the command palette.
    expect(completionNavDirection(key({ key: 'p', ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('ignores keys it does not own', () => {
    expect(completionNavDirection(key({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(completionNavDirection(key({ key: 'ArrowDown' }))).toBeNull()
    expect(completionNavDirection(key({ key: 'ArrowUp' }))).toBeNull()
  })
})

describe('completionKeymapForEditor (#429 — mac AltGr text entry)', () => {
  const macBindings = completionKeymapForEditor.map((b) => b.mac).filter(Boolean)

  it('drops the mac-only Alt-` and Alt-i completion triggers', () => {
    // They swallow the printable char AltGr-style mac layouts emit on those combos.
    expect(macBindings).not.toContain('Alt-`')
    expect(macBindings).not.toContain('Alt-i')
    // Sanity: the stock keymap really did have them (so the filter is doing work).
    expect(completionKeymap.map((b) => b.mac)).toContain('Alt-`')
    expect(completionKeymap.map((b) => b.mac)).toContain('Alt-i')
  })

  it('keeps Ctrl-Space and every non-Alt binding (only two removed)', () => {
    expect(completionKeymapForEditor.some((b) => b.key === 'Ctrl-Space')).toBe(true)
    expect(completionKeymapForEditor.some((b) => b.key === 'Escape')).toBe(true)
    expect(completionKeymapForEditor.some((b) => b.key === 'Enter')).toBe(true)
    expect(completionKeymapForEditor).toHaveLength(completionKeymap.length - 2)
  })
})
