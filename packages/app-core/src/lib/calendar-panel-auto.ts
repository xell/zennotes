// Who opened the calendar panel: the user, or the auto-open?
//
// The panel is one sticky flag per pane, Obsidian-style: whatever you set
// stays while you browse. The auto-open for daily/weekly notes wrote into
// that same flag, so a visit to a periodic note turned into "the panel is now
// open on every note" and a close the user made earlier was quietly undone
// (#502). The distinction that fixes it is provenance: an open the APP made
// is scoped to the calendar's own territory and closes on the way out, while
// an open the USER made keeps the documented stickiness. One extra bit,
// `auto`, carries that provenance; these transitions are the only writers.

export interface CalendarPanelState {
  open: boolean
  /** True while the current `open` came from the auto-open, not the user. */
  auto: boolean
}

export const CALENDAR_PANEL_CLOSED: CalendarPanelState = { open: false, auto: false }

/**
 * The pane landed on a (possibly different) note.
 *
 * Auto-open only ever fires on a transition to open: a panel the user already
 * has open on a date note is theirs and keeps `auto: false`, so leaving the
 * date note keeps it open, which is exactly the browse-through behaviour the
 * sticky flag was built for. Leaving the calendar's territory closes only what
 * the auto-open itself opened.
 */
export function calendarPanelOnNote(
  state: CalendarPanelState,
  input: { isDateNote: boolean; autoEnabled: boolean; available: boolean }
): CalendarPanelState {
  if (!input.available) return CALENDAR_PANEL_CLOSED
  if (input.isDateNote) {
    if (input.autoEnabled && !state.open) return { open: true, auto: true }
    return state
  }
  if (state.auto && state.open) return CALENDAR_PANEL_CLOSED
  return state
}

/**
 * The user pressed the toggle. Whatever the result, it is theirs now: closing
 * an auto-opened panel must stick, and re-opening it by hand converts it into
 * a deliberate open that survives leaving the date note.
 */
export function calendarPanelOnToggle(state: CalendarPanelState): CalendarPanelState {
  return { open: !state.open, auto: false }
}
