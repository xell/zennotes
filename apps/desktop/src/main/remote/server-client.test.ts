import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
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

describe('watchVaultChanges reconnect', () => {
  type WatchServer = { server: http.Server; wss: WebSocketServer; close: () => Promise<void> }

  async function startWatchServer(port: number, payload: object): Promise<WatchServer> {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    wss.on('connection', (socket) => {
      socket.send(JSON.stringify(payload))
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    return {
      server,
      wss,
      close: async () => {
        for (const socket of wss.clients) socket.terminate()
        await new Promise((resolve) => wss.close(resolve))
        await new Promise((resolve) => server.close(resolve))
      }
    }
  }

  async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('survives a server restart: resubscribes and reports the gap', async () => {
    // Grab a free port first so the restarted server can reuse it.
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise((resolve) => probe.close(resolve))

    let watchServer = await startWatchServer(port, { kind: 'add', path: 'a.md', folder: 'inbox' })
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const events: string[] = []
    let reconnects = 0
    const stop = client.watchVaultChanges(
      (ev) => events.push(ev.path),
      { onReconnect: () => (reconnects += 1) }
    )
    try {
      await waitFor(() => events.includes('a.md'), 5_000, 'first event')
      expect(reconnects).toBe(0)

      // Server dies mid-session. The old client crashed the main process
      // here (unhandled 'error') and never resubscribed.
      await watchServer.close()
      watchServer = await startWatchServer(port, { kind: 'add', path: 'b.md', folder: 'inbox' })

      await waitFor(() => events.includes('b.md'), 15_000, 'event after restart')
      expect(reconnects).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
      await watchServer.close()
    }
  }, 30_000)

  it('a peer that accepts the upgrade and instantly drops it backs off instead of hammering', async () => {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    let connections = 0
    wss.on('connection', (socket) => {
      connections += 1
      socket.close()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = (server.address() as AddressInfo)
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const stop = client.watchVaultChanges(() => {})
    try {
      // The old client reset the backoff on every 'open', so a handshake
      // that immediately dies reconnected on a flat 1s forever: ~6
      // connections in this window. Growing backoff (1s, 2s, 4s) allows 4
      // at most.
      await new Promise((resolve) => setTimeout(resolve, 6_000))
      expect(connections).toBeGreaterThanOrEqual(2)
      expect(connections).toBeLessThanOrEqual(4)
    } finally {
      stop()
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    }
  }, 15_000)

  it('a connection that stays up long enough resets the backoff for the next gap', async () => {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/api/watch' })
    const connectedAt: number[] = []
    wss.on('connection', () => {
      connectedAt.push(Date.now())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = (server.address() as AddressInfo)
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const stop = client.watchVaultChanges(() => {}, { stableAfterMs: 100 })
    try {
      // Three kill/reconnect cycles, each after the socket outlived the
      // stability window. With the reset every gap retries at the base 1s;
      // without it the third gap would wait 4s.
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await waitFor(() => connectedAt.length === cycle, 5_000, `connection ${cycle}`)
        await new Promise((resolve) => setTimeout(resolve, 400))
        for (const socket of wss.clients) socket.terminate()
      }
      await waitFor(() => connectedAt.length === 4, 5_000, 'connection 4')
      expect(connectedAt[3] - connectedAt[2]).toBeLessThan(3_000)
    } finally {
      stop()
      for (const socket of wss.clients) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    }
  }, 30_000)

  it('a stopped watch does not keep reconnecting', async () => {
    const watchServer = await startWatchServer(0, { kind: 'add', path: 'x.md', folder: 'inbox' })
    const { port } = watchServer.server.address() as AddressInfo
    const client = new RemoteServerClient({ baseUrl: `http://127.0.0.1:${port}` })

    const events: string[] = []
    const stop = client.watchVaultChanges((ev) => events.push(ev.path))
    try {
      await waitFor(() => events.length > 0, 5_000, 'first event')
      stop()
      const connectionsAfterStop = () =>
        [...watchServer.wss.clients].filter((s) => s.readyState === s.OPEN).length
      // The backoff starts at 1s; give a runaway reconnect time to show up.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(connectionsAfterStop()).toBe(0)
    } finally {
      stop()
      await watchServer.close()
    }
  }, 15_000)

  it('an unreachable server neither throws nor crashes, and stop cancels the retry loop', async () => {
    // Port 1 is never listening. The connection error must stay inside the
    // client (an unhandled ws 'error' event would crash the process, which
    // vitest would surface as an unhandled exception).
    const client = new RemoteServerClient({ baseUrl: 'http://127.0.0.1:1' })
    const stop = client.watchVaultChanges(() => {})
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }, 10_000)
})
