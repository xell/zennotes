import { describe, expect, it } from 'vitest'
import { isUnknownRouteResponse, parseServerErrorBody } from './server-error-shape'

describe('parseServerErrorBody', () => {
  it('reads the code and message a handler wrote', () => {
    expect(
      parseServerErrorBody('{"code":"not_found","message":"no such directory: /gone"}')
    ).toEqual({ code: 'not_found', message: 'no such directory: /gone' })
  })

  it('tolerates a body with no message', () => {
    expect(parseServerErrorBody('{"code":"forbidden"}')).toEqual({
      code: 'forbidden',
      message: ''
    })
  })

  it('is null for the router plain-text 404 an older server sends', () => {
    expect(parseServerErrorBody('404 page not found\n')).toBeNull()
  })

  it('is null for an empty body, valid JSON without a code, and a proxy error page', () => {
    expect(parseServerErrorBody('')).toBeNull()
    expect(parseServerErrorBody(null)).toBeNull()
    expect(parseServerErrorBody('{"error":"nope"}')).toBeNull()
    expect(parseServerErrorBody('{"code":""}')).toBeNull()
    expect(parseServerErrorBody('null')).toBeNull()
    expect(parseServerErrorBody('<html><body>502 Bad Gateway</body></html>')).toBeNull()
  })
})

// The whole point: the web client only claims "your server is running an older
// build" for a 404 the router produced. A structured 404 is a real answer from
// a route that ran, and replacing it with an upgrade hint hid the actual error.
describe('isUnknownRouteResponse', () => {
  it('is true for a bare 404 (the route does not exist on that server)', () => {
    expect(isUnknownRouteResponse(404, '404 page not found\n')).toBe(true)
    expect(isUnknownRouteResponse(404, '')).toBe(true)
  })

  it('is false for a structured 404 (the directory is simply gone)', () => {
    expect(
      isUnknownRouteResponse(404, '{"code":"not_found","message":"no such directory"}')
    ).toBe(false)
  })

  it('is false for any other status', () => {
    expect(isUnknownRouteResponse(403, 'forbidden')).toBe(false)
    expect(isUnknownRouteResponse(500, 'internal server error')).toBe(false)
  })
})
