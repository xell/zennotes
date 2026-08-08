// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { armMiddleClickPasteGuard } from './middle-click-paste-guard'

// jsdom has no ClipboardEvent constructor, and the guard only ever reads the
// event's name, so a plain Event is the honest double.
function firePaste(): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  document.body.dispatchEvent(event)
  return event
}

/** The guard reads the platform through `window.zen.platformSync`, the same
 *  runtime hook the keymap tests force. */
function setPlatform(platform: NodeJS.Platform | null): void {
  const host = window as Window & { zen?: { platformSync?: () => NodeJS.Platform } }
  if (platform === null) {
    Reflect.deleteProperty(host, 'zen')
    return
  }
  host.zen = { ...(host.zen ?? {}), platformSync: () => platform }
}

describe('armMiddleClickPasteGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setPlatform('linux')
  })
  afterEach(() => {
    // Drain any armed guard so one test's window cannot leak into the next.
    vi.runAllTimers()
    vi.useRealTimers()
    setPlatform(null)
  })

  it('cancels a paste that arrives inside the window', () => {
    armMiddleClickPasteGuard()
    expect(firePaste().defaultPrevented).toBe(true)
  })

  it('disarms after one paste, so the next real paste goes through', () => {
    armMiddleClickPasteGuard()
    firePaste()
    expect(firePaste().defaultPrevented).toBe(false)
  })

  it('disarms on the deadline when no paste ever arrives', () => {
    armMiddleClickPasteGuard(150)
    vi.advanceTimersByTime(151)
    expect(firePaste().defaultPrevented).toBe(false)
  })

  it('re-arming extends the window instead of stacking guards', () => {
    armMiddleClickPasteGuard(150)
    armMiddleClickPasteGuard(150)
    firePaste()
    // A second guard would have eaten this one too.
    expect(firePaste().defaultPrevented).toBe(false)
  })

  // The primary-selection paste this cancels is a Linux desktop convention.
  // Arming elsewhere could only ever eat a paste the user asked for.
  it('never arms on macOS', () => {
    setPlatform('darwin')
    armMiddleClickPasteGuard()
    expect(firePaste().defaultPrevented).toBe(false)
  })

  it('never arms on Windows', () => {
    setPlatform('win32')
    armMiddleClickPasteGuard()
    expect(firePaste().defaultPrevented).toBe(false)
  })
})
