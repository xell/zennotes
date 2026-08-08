/**
 * Telling "this file is absent" apart from "this request failed", against a
 * server whose answer for the two might be the same.
 *
 * Databases are composed from plain file reads (see `database-ops.ts`), and a
 * read that answers "absent" is load-bearing in two directions:
 *
 *  - `openDatabase` reads an absent `schema.json` as "bare CSV, adopt it" and
 *    writes an inferred schema over whatever was there. Treating a failed read
 *    as absent can therefore DESTROY a schema.
 *  - creating a database probes candidate names for a free one. Treating an
 *    absent file as a failure therefore makes creation IMPOSSIBLE.
 *
 * So neither "trust every error as absence" nor "trust no error as absence"
 * is safe on its own; which one is correct depends on the server. Servers
 * from 2.20 on answer 404 for a missing file and reserve 500 for real
 * failures, so 404 is the only absence signal there. Servers before that
 * answered 500 for both, and a client that refuses to read 500 as absence
 * cannot create or open a single database against one (reported from a
 * self-hosted 2.19 server, whose users have no reason to have upgraded).
 *
 * Rather than guess from a version (`/capabilities` reports a hardcoded
 * string, so there is nothing to read), ask the server what it does: request
 * a path that cannot exist and look at the status. A server that answers 404
 * distinguishes, so its non-404 failures are real and must surface. A server
 * that answers the same non-404 status conflates, so absence is the only
 * available reading of that status. One extra request per connection, cached
 * for the connection's life, and it degrades safely: if the probe itself
 * cannot be interpreted, the strict reading wins and the error surfaces.
 */

/** A guaranteed-absent vault-relative path. The random suffix is what makes
 *  the guarantee hold: a user cannot have this file, so any answer describes
 *  the server's behavior rather than the vault's contents. */
function probePath(): string {
  const nonce = Math.random().toString(36).slice(2, 10)
  return `.zennotes-absence-probe-${nonce}`
}

export interface AbsenceAwareReaderOptions {
  /** Read a vault-relative path's text. Throws on any failure. */
  read(relPath: string): Promise<string>
  /** The HTTP status carried by a thrown error, or null when it carries none
   *  (a dropped socket, a DNS failure): those never mean absence. */
  statusOf(error: unknown): number | null
  /** True when the server SAYS it reports a missing file as 404 (the
   *  `reportsMissingAsNotFound` capability, 2.20.2 and later). Then its other
   *  statuses are real failures and no probe is needed or wanted. Leave unset
   *  for a server that says nothing, which is what the probe is for. */
  serverReportsMissingAsNotFound?: () => boolean
}

/**
 * Wrap a raw read into one that returns null for ABSENT and throws for
 * everything else, using the server's own answer to decide which is which.
 */
export function createAbsenceAwareReader(
  options: AbsenceAwareReaderOptions
): (relPath: string) => Promise<string | null> {
  const { read, statusOf, serverReportsMissingAsNotFound } = options
  // Cached for the life of this reader, which callers scope to a connection.
  let conflates: Promise<boolean> | null = null

  const serverConflatesAbsence = (): Promise<boolean> => {
    conflates ??= (async () => {
      try {
        await read(probePath())
        // A file that cannot exist answered anyway. Nothing about this server
        // can be inferred, so keep the strict reading.
        return false
      } catch (error) {
        const status = statusOf(error)
        if (status === null) return false
        // Only a 5xx for a path that cannot exist says "this server cannot
        // name a missing file". Anything else describes the request instead.
        return status >= 500
      }
    })().catch(() => false)
    return conflates
  }

  return async function readFileTextOrNull(relPath: string): Promise<string | null> {
    try {
      return await read(relPath)
    } catch (error) {
      const status = statusOf(error)
      if (status === 404) return null
      // No status at all means the request never got an answer: unreachable,
      // rejected, cut off. A file that may exist perfectly well.
      if (status === null) throw error
      // A server that reports absence as 404 has already answered: this is a
      // real failure. Take its word over a probe.
      if (serverReportsMissingAsNotFound?.()) throw error
      // Only a server error can be the "missing file" this server cannot
      // name. 401, 403 and friends are answers about the request, never
      // about whether the file is there.
      if (status < 500) throw error
      if (await serverConflatesAbsence()) return null
      throw error
    }
  }
}
