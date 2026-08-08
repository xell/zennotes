/**
 * The structured error body a ZenNotes server returns from its vault-picker
 * routes (`/fs/browse`, `/vault/select`), and the one question a client has to
 * ask about it: did a HANDLER answer, or did the request never reach one?
 *
 * It matters because 404 means two different things on those routes. A server
 * old enough not to have them answers with its router's own plain-text 404,
 * and the client should offer to upgrade it. A current server answers a
 * directory that no longer exists (or one outside the allowed browse roots)
 * with a status of its own plus `{"code": "...", "message": "..."}`, and the
 * client should show what actually went wrong. Treating every 404 as "your
 * server is too old" replaced every real error on the first-run screen with a
 * false one, which is a bad trade: the upgrade hint is a guess, the server's
 * message is the truth.
 */

export interface ServerErrorBody {
  /** Stable machine-readable reason: `not_found`, `forbidden`, `bad_request`,
   *  `conflict`, `internal_error`. */
  code: string
  /** Human-readable text; empty when the server sent none. */
  message: string
}

/** Parse a response body as the structured shape, or null when it is anything
 *  else (plain text, HTML from a proxy, an empty body). */
export function parseServerErrorBody(body: string | null | undefined): ServerErrorBody | null {
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { code, message } = parsed as { code?: unknown; message?: unknown }
  if (typeof code !== 'string' || !code) return null
  return { code, message: typeof message === 'string' ? message : '' }
}

/**
 * True when a 404 came from the router rather than from a handler: the server
 * genuinely has no such route.
 */
export function isUnknownRouteResponse(
  status: number,
  body: string | null | undefined
): boolean {
  return status === 404 && parseServerErrorBody(body) === null
}
