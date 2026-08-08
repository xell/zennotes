import { describe, expect, it } from 'vitest'
import { createAbsenceAwareReader } from './remote-absence'

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
  }
}

/** A fake server. `files` is what exists; `missingStatus` is what it answers
 *  for everything else, which is the whole difference between generations. */
function server(options: { files: Record<string, string>; missingStatus: number }) {
  const reads: string[] = []
  const read = async (relPath: string): Promise<string> => {
    reads.push(relPath)
    const hit = options.files[relPath]
    if (hit === undefined) throw new HttpError(options.missingStatus)
    return hit
  }
  return { read, reads }
}

const statusOf = (err: unknown): number | null => (err instanceof HttpError ? err.status : null)

describe('createAbsenceAwareReader', () => {
  describe('a server that reports absence as 404 (2.20 and later)', () => {
    it('reads a present file and reports a missing one as absent', async () => {
      const s = server({ files: { 'a.csv': 'x,y' }, missingStatus: 404 })
      const readOrNull = createAbsenceAwareReader({ read: s.read, statusOf })
      expect(await readOrNull('a.csv')).toBe('x,y')
      expect(await readOrNull('gone.csv')).toBeNull()
    })

    it('surfaces a 500 instead of calling it absent', async () => {
      // The load-bearing case: openDatabase would read null as "bare CSV,
      // adopt it" and write an inferred schema over the real one.
      const read = async (relPath: string): Promise<string> => {
        if (relPath.startsWith('.zennotes-absence-probe-')) throw new HttpError(404)
        throw new HttpError(500)
      }
      const readOrNull = createAbsenceAwareReader({ read, statusOf })
      await expect(readOrNull('Db.base/schema.json')).rejects.toThrow('HTTP 500')
    })
  })

  describe('a server that answers 500 for a missing file (before 2.20)', () => {
    it('reads a missing file as absent, so creation and open work', async () => {
      const s = server({ files: { 'Db.base/data.csv': 'x,y' }, missingStatus: 500 })
      const readOrNull = createAbsenceAwareReader({ read: s.read, statusOf })
      expect(await readOrNull('Db.base/data.csv')).toBe('x,y')
      // The exact path from the bug report: the name-collision probe when
      // creating a database, which threw and made creation impossible.
      expect(await readOrNull('Untitled Database.base/data.csv')).toBeNull()
    })

    it('asks the server only once, however many reads follow', async () => {
      const s = server({ files: {}, missingStatus: 500 })
      const readOrNull = createAbsenceAwareReader({ read: s.read, statusOf })
      await readOrNull('one.csv')
      await readOrNull('two.csv')
      await readOrNull('three.csv')
      const probes = s.reads.filter((p) => p.startsWith('.zennotes-absence-probe-'))
      expect(probes).toHaveLength(1)
    })

    it('probes a path that cannot exist, so the answer describes the server', async () => {
      const s = server({ files: {}, missingStatus: 500 })
      const readOrNull = createAbsenceAwareReader({ read: s.read, statusOf })
      await readOrNull('one.csv')
      const probe = s.reads.find((p) => p.startsWith('.zennotes-absence-probe-'))
      expect(probe).toBeDefined()
      expect(probe).not.toBe('one.csv')
    })
  })


  describe('a server that says it reports absence as 404 (2.20.2 and later)', () => {
    it('takes the server at its word and never probes', async () => {
      const s = server({ files: {}, missingStatus: 500 })
      const readOrNull = createAbsenceAwareReader({
        read: s.read,
        statusOf,
        serverReportsMissingAsNotFound: () => true
      })
      await expect(readOrNull('Db.base/schema.json')).rejects.toThrow('HTTP 500')
      expect(s.reads.filter((p) => p.startsWith('.zennotes-absence-probe-'))).toHaveLength(0)
    })
  })

  it('never reads an auth failure as absence, however the server behaves', async () => {
    // A bad token answers 401 for everything, including the probe. Absence is
    // not a thing 401 can mean, so the schema is never inferred over.
    const s = server({ files: {}, missingStatus: 401 })
    const readOrNull = createAbsenceAwareReader({ read: s.read, statusOf })
    await expect(readOrNull('Db.base/schema.json')).rejects.toThrow('HTTP 401')
    expect(s.reads.filter((p) => p.startsWith('.zennotes-absence-probe-'))).toHaveLength(0)
  })

  it('never reads a failure with no status as absence', async () => {
    // A dropped socket says nothing about whether the file exists.
    const read = async (): Promise<string> => {
      throw new Error('socket hang up')
    }
    const readOrNull = createAbsenceAwareReader({ read, statusOf })
    await expect(readOrNull('Db.base/schema.json')).rejects.toThrow('socket hang up')
  })

  it('keeps the strict reading when the probe itself is uninterpretable', async () => {
    const read = async (relPath: string): Promise<string> => {
      if (relPath.startsWith('.zennotes-absence-probe-')) throw new Error('network down')
      throw new HttpError(500)
    }
    const readOrNull = createAbsenceAwareReader({ read, statusOf })
    await expect(readOrNull('Db.base/schema.json')).rejects.toThrow('HTTP 500')
  })

  it('keeps the strict reading when a path that cannot exist answers anyway', async () => {
    const read = async (): Promise<string> => 'impossible'
    const readOrNull = createAbsenceAwareReader({ read, statusOf })
    // Nothing can be inferred about a server that serves everything, so a
    // real failure must still surface rather than being called absence.
    expect(await readOrNull('Db.base/schema.json')).toBe('impossible')
  })

  it('scopes its answer to the reader, so a reconnect re-asks', async () => {
    const first = server({ files: {}, missingStatus: 500 })
    const second = server({ files: {}, missingStatus: 500 })
    await createAbsenceAwareReader({ read: first.read, statusOf })('a.csv')
    await createAbsenceAwareReader({ read: second.read, statusOf })('a.csv')
    expect(first.reads.some((p) => p.startsWith('.zennotes-absence-probe-'))).toBe(true)
    expect(second.reads.some((p) => p.startsWith('.zennotes-absence-probe-'))).toBe(true)
  })
})
