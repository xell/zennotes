import { describe, expect, it } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { checkboxToggleChange } from './cm-toggle-checkbox'

/** Apply the per-line change to a single-line doc and return the result. */
function toggled(line: string): string {
  const change = checkboxToggleChange(line, 0)
  if (change === null) return line
  const state = EditorState.create({ doc: line })
  return state.update({ changes: change }).state.doc.toString()
}

describe('checkboxToggleChange', () => {
  it('turns plain text into an unchecked task', () => {
    expect(toggled('call the bank')).toBe('- [ ] call the bank')
  })

  it('keeps indentation when converting plain text', () => {
    expect(toggled('    call the bank')).toBe('    - [ ] call the bank')
  })

  it('keeps an existing bullet marker', () => {
    expect(toggled('- call the bank')).toBe('- [ ] call the bank')
    expect(toggled('* call the bank')).toBe('* [ ] call the bank')
    expect(toggled('+ call the bank')).toBe('+ [ ] call the bank')
  })

  it('keeps an ordered-list marker', () => {
    expect(toggled('12. call the bank')).toBe('12. [ ] call the bank')
    expect(toggled('3) call the bank')).toBe('3) [ ] call the bank')
  })

  it('keeps a blockquote prefix', () => {
    expect(toggled('> call the bank')).toBe('> - [ ] call the bank')
    expect(toggled('> - call the bank')).toBe('> - [ ] call the bank')
    expect(toggled('> > - [ ] call the bank')).toBe('> > - [x] call the bank')
  })

  it('checks an unchecked task and unchecks a checked one', () => {
    expect(toggled('- [ ] call the bank')).toBe('- [x] call the bank')
    expect(toggled('- [x] call the bank')).toBe('- [ ] call the bank')
    expect(toggled('- [X] call the bank')).toBe('- [ ] call the bank')
  })

  it('checks off an in-progress task', () => {
    expect(toggled('- [/] call the bank')).toBe('- [x] call the bank')
  })

  it('leaves forwarded and cancelled tasks alone', () => {
    expect(toggled('- [>] call the bank')).toBe('- [>] call the bank')
    expect(toggled('- [-] call the bank')).toBe('- [-] call the bank')
  })

  it('turns an empty line into an empty task', () => {
    expect(toggled('')).toBe('- [ ] ')
  })

  it('toggles a bare marker with no text after it', () => {
    expect(toggled('- [ ]')).toBe('- [x]')
    expect(toggled('- ')).toBe('- [ ] ')
  })

  it('treats a non-marker bracket as plain list text', () => {
    expect(toggled('- [link] to somewhere')).toBe('- [ ] [link] to somewhere')
  })

  it('reports a minimal single-character change for state flips', () => {
    // The cursor must not move when a state char is swapped in place.
    const change = checkboxToggleChange('- [ ] call the bank', 100)
    expect(change).toEqual({ from: 103, to: 104, insert: 'x' })
  })
})

describe('selection mapping through the insert', () => {
  it('keeps the cursor on the same text after converting a line', () => {
    // Cursor after "call" (offset 4); the inserted "- [ ] " is 6 chars.
    const state = EditorState.create({
      doc: 'call the bank',
      selection: EditorSelection.cursor(4)
    })
    const change = checkboxToggleChange('call the bank', 0)!
    const next = state.update({ changes: change }).state
    expect(next.doc.toString()).toBe('- [ ] call the bank')
    expect(next.selection.main.head).toBe(10)
  })
})
