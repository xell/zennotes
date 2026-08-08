import { describe, expect, it } from 'vitest'
import {
  CALENDAR_PANEL_CLOSED,
  calendarPanelOnNote,
  calendarPanelOnToggle,
  type CalendarPanelState
} from './calendar-panel-auto'

const on = (state: CalendarPanelState, isDateNote: boolean): CalendarPanelState =>
  calendarPanelOnNote(state, { isDateNote, autoEnabled: true, available: true })

describe('calendar panel auto-open provenance (#502)', () => {
  it('walks the reported repro: a periodic visit no longer reopens a closed panel', () => {
    // 1-2: on a non-periodic note the user closes the panel.
    let state: CalendarPanelState = { open: true, auto: false }
    state = calendarPanelOnToggle(state)
    // 3-4: switching between non-periodic notes preserves that.
    state = on(state, false)
    expect(state.open).toBe(false)
    // 5-6: a daily note auto-opens the panel.
    state = on(state, true)
    expect(state).toEqual({ open: true, auto: true })
    // 7: returning to the non-periodic note closes what the auto-open opened.
    state = on(state, false)
    expect(state.open).toBe(false)
  })

  it('keeps a panel the user opened themselves open across a periodic visit', () => {
    // Open by hand, browse through a daily note, come back: still open. This
    // is the sticky behaviour the pane always promised.
    let state = calendarPanelOnToggle(CALENDAR_PANEL_CLOSED)
    state = on(state, true)
    expect(state).toEqual({ open: true, auto: false })
    state = on(state, false)
    expect(state.open).toBe(true)
  })

  it('closing an auto-opened panel by hand sticks', () => {
    let state = on(CALENDAR_PANEL_CLOSED, true)
    state = calendarPanelOnToggle(state)
    expect(state.open).toBe(false)
    // Still on the same date note nothing re-opens it (the caller keys the
    // note-change transition on the note identity), and later non-date notes
    // stay closed too.
    state = on(state, false)
    expect(state.open).toBe(false)
  })

  it('re-opening by hand on the date note converts the open into a deliberate one', () => {
    let state = on(CALENDAR_PANEL_CLOSED, true)
    state = calendarPanelOnToggle(state) // closed
    state = calendarPanelOnToggle(state) // opened, by the user now
    state = on(state, false)
    expect(state.open).toBe(true)
  })

  it('consecutive periodic notes keep the auto provenance until the exit', () => {
    let state = on(CALENDAR_PANEL_CLOSED, true)
    state = on(state, true)
    expect(state).toEqual({ open: true, auto: true })
    state = on(state, false)
    expect(state.open).toBe(false)
  })

  it('does nothing automatic when the preference is off', () => {
    const state = calendarPanelOnNote(CALENDAR_PANEL_CLOSED, {
      isDateNote: true,
      autoEnabled: false,
      available: true
    })
    expect(state.open).toBe(false)
  })

  it('an unavailable calendar forces closed and clears provenance', () => {
    const state = calendarPanelOnNote(
      { open: true, auto: true },
      { isDateNote: true, autoEnabled: true, available: false }
    )
    expect(state).toEqual(CALENDAR_PANEL_CLOSED)
  })
})
