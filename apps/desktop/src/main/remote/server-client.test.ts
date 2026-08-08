import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  connectionErrorMessage,
  RemoteConnectionError,
  RemoteRequestError,
  RemoteServerClient
} from './server-client'

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

describe('jsonRequest error typing (#499 follow-up)', () => {
  it('a refused connection surfaces as RemoteConnectionError', async () => {
    // Port 1 is never listening; fetch rejects at the network layer.
    const client = new RemoteServerClient({ baseUrl: 'http://127.0.0.1:1' })
    await expect(client.readNote('inbox/x.md')).rejects.toBeInstanceOf(RemoteConnectionError)
  })

  it('a non-2xx answer surfaces as RemoteRequestError carrying the status', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })
      const err = await client.readNote('inbox/x.md').then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(RemoteRequestError)
      expect((err as RemoteRequestError).status).toBe(404)
      expect((err as RemoteRequestError).message).toContain('404')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
