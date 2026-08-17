import { describe, expect, it } from 'vitest'
import { shouldEnforceScrollOff } from './cm-scrolloff'

// A minimal fake transaction/update — real scroll math needs DOM measurement
// jsdom can't provide (coordsAtPos, getBoundingClientRect), but the decision
// of whether to even attempt it doesn't, which is what this covers.
function fakeUpdate(opts: {
  selectionSet?: boolean
  docChanged?: boolean
  userEvents?: string[]
}): Parameters<typeof shouldEnforceScrollOff>[0] {
  const userEvents = opts.userEvents ?? []
  return {
    selectionSet: opts.selectionSet ?? false,
    docChanged: opts.docChanged ?? false,
    transactions: userEvents.map((type) => ({
      isUserEvent: (t: string) => t === type
    })) as unknown as Parameters<typeof shouldEnforceScrollOff>[0]['transactions']
  }
}

describe('shouldEnforceScrollOff', () => {
  it('ignores an update with neither a selection change nor a doc change', () => {
    expect(shouldEnforceScrollOff(fakeUpdate({}))).toBe(false)
  })

  it('reacts to an ordinary selection change (keyboard motion, programmatic)', () => {
    expect(shouldEnforceScrollOff(fakeUpdate({ selectionSet: true }))).toBe(true)
  })

  it('reacts to a selection change explicitly tagged select, like the display-line motions', () => {
    expect(
      shouldEnforceScrollOff(fakeUpdate({ selectionSet: true, userEvents: ['select'] }))
    ).toBe(true)
  })

  it('reacts to a doc change even without a selection change', () => {
    expect(shouldEnforceScrollOff(fakeUpdate({ docChanged: true }))).toBe(true)
  })

  // The bug (reported 2026-08-18): a mouse click in the margin yanked the
  // view to satisfy scrolloff even though the user placed the cursor exactly
  // where they meant to, and starting a drag-select from the margin re-ran
  // that correction on every pointermove the drag produced — a runaway loop
  // that scrolled to the start/end of the note and made selecting from the
  // margin impossible. select.pointer is CodeMirror's own tag for both the
  // click and every drag-extend, so excluding it fixes both symptoms.
  it('skips a mouse click', () => {
    expect(
      shouldEnforceScrollOff(fakeUpdate({ selectionSet: true, userEvents: ['select.pointer'] }))
    ).toBe(false)
  })

  it('skips every extend of a drag-select, not just its first event', () => {
    for (let i = 0; i < 5; i++) {
      expect(
        shouldEnforceScrollOff(fakeUpdate({ selectionSet: true, userEvents: ['select.pointer'] }))
      ).toBe(false)
    }
  })

  it('skips a mixed transaction set if any one of them is pointer-driven', () => {
    expect(
      shouldEnforceScrollOff(
        fakeUpdate({ selectionSet: true, userEvents: ['select', 'select.pointer'] })
      )
    ).toBe(false)
  })
})
