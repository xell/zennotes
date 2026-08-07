import { describe, expect, it } from 'vitest'
import { connectionErrorMessage } from './server-client'

describe('connectionErrorMessage (#481)', () => {
  const url = 'https://zennotes.lan:8443'

  it('names the server and carries the underlying reason', () => {
    const msg = connectionErrorMessage(url, new TypeError('fetch failed'), 'linux')
    expect(msg).toContain(url)
    expect(msg).toContain('Could not reach the server: fetch failed.')
  })

  it('points macOS users at the Local Network permission', () => {
    // macOS 15+ blocks local-network connections outright when the permission
    // is off — no packets, no error beyond "fetch failed" — so the message has
    // to name the setting or the user has nothing to go on.
    const msg = connectionErrorMessage(url, new TypeError('fetch failed'), 'darwin')
    expect(msg).toContain('Privacy & Security → Local Network')
  })

  it('leaves that hint out on platforms without the permission', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(connectionErrorMessage(url, new Error('boom'), platform)).not.toContain(
        'Local Network'
      )
    }
  })

  it('still reads as a sentence when the failure carries no message', () => {
    const msg = connectionErrorMessage(url, {}, 'linux')
    expect(msg).toBe(
      `Could not connect to the ZenNotes server at ${url}. Make sure the server is running and the URL is correct.`
    )
  })
})
