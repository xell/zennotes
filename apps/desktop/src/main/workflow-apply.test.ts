// Tests for the workflow applier, journal and undo.
//
// Everything here runs against a real temp vault, because the whole point of
// this module is what ends up on a filesystem: a fake would only prove the
// mocks agree with each other. The recurring assertion is a hash snapshot of
// every file in the vault, since "byte-identical afterwards" is the actual
// promise a rollback makes and a content comparison is the only thing that
// checks it.
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowRunReceipt, WorkflowRunSummary } from '@zennotes/bridge-contract/workflows'
import type { WorkflowOp } from '@shared/workflows/types'
import {
  applyWorkflowOps,
  deleteWorkflowRuns,
  listWorkflowRuns,
  MAX_RETAINED_RUNS,
  parseWorkflowOp,
  pruneRunLedgers,
  recoverInterruptedRuns,
  undoWorkflowRun,
  type WorkflowRunLedger
} from './workflow-apply'

/**
 * Paths whose atomic write should fail, so the "the rollback itself failed"
 * branch can be exercised without a real broken disk. Hoisted because
 * `vi.mock` factories run before the module body.
 */
const injected = vi.hoisted(() => ({
  failingWrites: new Set<string>(),
  // path -> how many writes to let through before failing. This is what makes a
  // GENUINELY incomplete rollback expressible: the op's write has to succeed so
  // the file really is holding this run's bytes, and only the restore afterwards
  // may fail. Failing every write to a path instead produces a file that was
  // never modified, which is a clean rollback, not an incomplete one.
  failAfterWrites: new Map<string, number>(),
  writeCounts: new Map<string, number>(),
  // Called just before each write lands, which is the only moment a test can
  // observe the vault mid-run: it is where the crash journal has to already be
  // on disk, and where a killed process would have left one.
  beforeWrite: null as null | ((abs: string) => Promise<void> | void)
}))

vi.mock('./vault', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./vault')>()
  return {
    ...actual,
    writeFileAtomic: async (abs: string, data: string): Promise<void> => {
      if (injected.beforeWrite) await injected.beforeWrite(abs)
      if (injected.failingWrites.has(abs)) throw new Error('simulated disk failure')
      const allowed = injected.failAfterWrites.get(abs)
      if (allowed !== undefined) {
        const seen = injected.writeCounts.get(abs) ?? 0
        injected.writeCounts.set(abs, seen + 1)
        if (seen >= allowed) throw new Error('simulated disk failure')
      }
      await actual.writeFileAtomic(abs, data)
    }
  }
})

const tempDirs: string[] = []

async function makeVault(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zennotes-workflow-apply-'))
  tempDirs.push(dir)
  // Every vault has these; a few tests rely on them existing before the run.
  await mkdir(path.join(dir, 'inbox'), { recursive: true })
  return dir
}

async function seed(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
}

async function readOrNull(root: string, rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(root, rel), 'utf8')
  } catch {
    return null
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Every note in the vault mapped to its content hash, ignoring `.zennotes`. */
async function snapshot(
  root: string,
  dir = root,
  out: Record<string, string> = {}
): Promise<Record<string, string>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.zennotes') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) await snapshot(root, abs, out)
    else out[path.relative(root, abs)] = sha256(await readFile(abs, 'utf8'))
  }
  return out
}

function runsDirOf(root: string): string {
  return path.join(root, '.zennotes', 'workflows', '.runs')
}

async function ledgerFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(runsDirOf(root))).sort()
  } catch {
    return []
  }
}

async function readLedger(root: string, runId: string): Promise<WorkflowRunLedger> {
  const raw = await readFile(path.join(runsDirOf(root), `${runId}.json`), 'utf8')
  return JSON.parse(raw) as WorkflowRunLedger
}

function apply(
  root: string,
  ops: WorkflowOp[],
  workflowId = 'test-flow'
): Promise<WorkflowRunReceipt> {
  return applyWorkflowOps(root, { workflowId, ops })
}

/** The crash journal a run keeps while it applies; see decision 5. */
function journalPath(root: string, runId: string): string {
  return path.join(runsDirOf(root), `${runId}.journal.jsonl`)
}

async function journalNames(root: string): Promise<string[]> {
  return (await ledgerFiles(root)).filter((name) => name.endsWith('.journal.jsonl'))
}

/** The journal parsed the way recovery reads it: header line, then entries. */
function journalLines(raw: string): Record<string, unknown>[] {
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function isSymlink(abs: string): Promise<boolean> {
  return (await lstat(abs)).isSymbolicLink()
}

/**
 * Whether two paths differing only in case are one file here. macOS and Windows
 * say yes, which is the whole reason the journal folds its keys; on Linux those
 * are two files and the behaviour under test does not exist.
 */
const oneCaseFolder = process.platform === 'darwin' || process.platform === 'win32'

afterEach(async () => {
  injected.failingWrites.clear()
  injected.failAfterWrites.clear()
  injected.writeCounts.clear()
  injected.beforeWrite = null
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/* -------------------------------------------------------------------------- */
/*  Refusing to write outside the vault                                       */
/* -------------------------------------------------------------------------- */

describe('containment', () => {
  it('aborts the whole run before any write when an op path escapes the vault', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'one\n')
    const before = await snapshot(root)

    await expect(
      apply(root, [
        { kind: 'append', path: 'inbox/A.md', text: 'appended' },
        { kind: 'append', path: '../outside.md', text: 'nope' }
      ])
    ).rejects.toThrow(/escapes the vault/)

    // The first op is valid and comes first, so this is the assertion that
    // proves validation happens before execution rather than during it.
    expect(await snapshot(root)).toEqual(before)
    expect(await ledgerFiles(root)).toEqual([])
  })

  it('rejects an absolute path outside the vault', async () => {
    const root = await makeVault()
    await expect(
      apply(root, [{ kind: 'write-note', path: '/tmp/evil.md', text: 'x' }])
    ).rejects.toThrow(/escapes the vault/)
  })

  it('rejects a destination that escapes even when the source is fine', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'one\n')
    await expect(
      apply(root, [{ kind: 'move', path: 'inbox/A.md', to: '../..' }])
    ).rejects.toThrow(/escapes the vault/)
    expect(await readOrNull(root, 'inbox/A.md')).toBe('one\n')
  })

  it('refuses to write inside .zennotes, where its own records live', async () => {
    const root = await makeVault()
    await expect(
      apply(root, [{ kind: 'write-note', path: '.zennotes/workflows/evil.md', text: 'x' }])
    ).rejects.toThrow(/inside \.zennotes/)
  })

  it('refuses a target that is not a note, so assets cannot be truncated', async () => {
    const root = await makeVault()
    await seed(root, 'assets/logo.png', 'binary-ish')
    await expect(
      apply(root, [{ kind: 'write-note', path: 'assets/logo.png', text: 'x' }])
    ).rejects.toThrow(/not a note/)
    expect(await readOrNull(root, 'assets/logo.png')).toBe('binary-ish')
  })

  it('rejects a malformed op before anything runs', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'one\n')
    const before = await snapshot(root)
    await expect(
      applyWorkflowOps(root, {
        workflowId: 'test-flow',
        ops: [{ kind: 'append', path: 'inbox/A.md', text: 'ok' }, { kind: 'frobnicate' }]
      })
    ).rejects.toThrow(/op 1 is not a valid operation/)
    expect(await snapshot(root)).toEqual(before)
  })

  it('rejects an op missing a required field', async () => {
    const root = await makeVault()
    await expect(
      applyWorkflowOps(root, {
        workflowId: 'test-flow',
        ops: [{ kind: 'append', path: 'inbox/A.md' }]
      })
    ).rejects.toThrow(/op 0 is not a valid operation/)
  })

  it('drops fields that were not part of the op when narrowing', () => {
    const op = parseWorkflowOp({ kind: 'add-tag', path: 'inbox/A.md', tag: 'x', extra: 'junk' })
    expect(op).toEqual({ kind: 'add-tag', path: 'inbox/A.md', tag: 'x' })
  })

  it('rejects an empty path', async () => {
    const root = await makeVault()
    await expect(apply(root, [{ kind: 'append', path: '', text: 'x' }])).rejects.toThrow(
      /empty path/
    )
  })

  it('rejects a rename with nothing to rename to', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const before = await snapshot(root)

    await expect(apply(root, [{ kind: 'rename', path: 'inbox/A.md', to: '  ' }])).rejects.toThrow(
      /empty target/
    )
    expect(await snapshot(root)).toEqual(before)
  })

  it('a pre-flight rejection leaves no record and does not wedge the vault', async () => {
    // Every refusal above happens before the run has an id, a journal or a
    // ledger, so what it must leave behind is nothing at all: no half-run to
    // recover, and a queue the next run still gets through.
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    await expect(apply(root, [{ kind: 'rename', path: 'inbox/A.md', to: '  ' }])).rejects.toThrow(
      /empty target/
    )
    expect(await ledgerFiles(root)).toEqual([])

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'ok' }])

    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\nok\n')
    expect((await listWorkflowRuns(root)).map((run) => run.runId)).toEqual([receipt.runId])
  })
})

/* -------------------------------------------------------------------------- */
/*  Applying                                                                  */
/* -------------------------------------------------------------------------- */

describe('applyWorkflowOps', () => {
  it('applies a single op and reports it on the receipt', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'one\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'appended' }
    ])

    expect(receipt.applied).toBe(1)
    expect(receipt.paths).toEqual(['inbox/A.md'])
    expect(receipt.irreversible).toBe(0)
    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'inbox/A.md')).toContain('appended')
  })

  it('applies several ops across several files, in order', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'first' },
      { kind: 'append', path: 'inbox/B.md', text: 'second' },
      { kind: 'create-note', path: 'inbox/C.md', body: 'third' }
    ])

    expect(receipt.applied).toBe(3)
    expect(receipt.paths).toEqual(['inbox/A.md', 'inbox/B.md', 'inbox/C.md'])
    expect(await readOrNull(root, 'inbox/A.md')).toContain('first')
    expect(await readOrNull(root, 'inbox/B.md')).toContain('second')
    expect(await readOrNull(root, 'inbox/C.md')).toContain('third')
  })

  it('journals a file once, keeping the pre-run bytes when two ops hit it', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'original\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'first' },
      { kind: 'append', path: 'inbox/A.md', text: 'second' }
    ])
    const ledger = await readLedger(root, receipt.runId)

    expect(receipt.applied).toBe(2)
    expect(receipt.paths).toEqual(['inbox/A.md'])
    expect(ledger.journal).toEqual([{ path: 'inbox/A.md', before: 'original\n' }])
    // The second op must not have overwritten the entry with what the first op
    // produced, or undo would restore a half-applied run.
    expect(ledger.journal[0]?.before).not.toContain('first')
  })

  it('creates a note and undo removes it again', async () => {
    const root = await makeVault()
    const receipt = await apply(root, [
      { kind: 'create-note', path: 'inbox/New.md', body: 'hello' }
    ])
    expect(await readOrNull(root, 'inbox/New.md')).toContain('hello')

    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo).toEqual({ runId: receipt.runId, restored: 1, driftedPaths: [] })
    expect(await readOrNull(root, 'inbox/New.md')).toBeNull()
  })

  it('prunes a directory the undone note left empty, but keeps the folder', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Keep.md', 'keep\n')

    const receipt = await apply(root, [
      { kind: 'create-note', path: 'inbox/2026/report.md', body: 'x' }
    ])
    await undoWorkflowRun(root, receipt.runId)

    expect(await readOrNull(root, 'inbox/2026/report.md')).toBeNull()
    expect(await readdir(path.join(root, 'inbox'))).toEqual(['Keep.md'])
  })

  it('writes nothing when an op would not change the file', async () => {
    const root = await makeVault()
    const op: WorkflowOp = { kind: 'write-note', path: 'inbox/Report.md', text: 'same' }
    await apply(root, [op])

    const second = await apply(root, [op])
    const ledger = await readLedger(root, second.runId)

    // The op ran, it just had nothing to write: an mtime bump would be a sync
    // round trip and a watcher event for a change that did not happen.
    expect(second.applied).toBe(1)
    expect(second.paths).toEqual([])
    expect(ledger.journal).toEqual([])
  })

  it('counts notify and clipboard as irreversible without journalling them', async () => {
    const root = await makeVault()
    const receipt = await apply(root, [
      { kind: 'notify', message: 'done' },
      { kind: 'clipboard', text: 'copied' }
    ])
    const ledger = await readLedger(root, receipt.runId)

    expect(receipt.applied).toBe(0)
    expect(receipt.irreversible).toBe(2)
    expect(receipt.paths).toEqual([])
    expect(ledger.journal).toEqual([])
    const [run] = await listWorkflowRuns(root)
    expect(run?.undoable).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Path operations                                                           */
/* -------------------------------------------------------------------------- */

describe('path operations', () => {
  it('moves a note into another folder and records both ends', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')

    const receipt = await apply(root, [{ kind: 'move', path: 'inbox/Note.md', to: 'archive' }])
    const ledger = await readLedger(root, receipt.runId)

    expect(receipt.paths).toEqual(['inbox/Note.md', 'archive/Note.md'])
    expect(await readOrNull(root, 'inbox/Note.md')).toBeNull()
    expect(await readOrNull(root, 'archive/Note.md')).toBe('body\n')
    expect(ledger.journal).toEqual([
      { path: 'inbox/Note.md', before: 'body\n' },
      { path: 'archive/Note.md', before: null }
    ])
  })

  it('undoes a move by restoring both recorded paths', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')
    const before = await snapshot(root)

    const receipt = await apply(root, [{ kind: 'move', path: 'inbox/Note.md', to: 'archive' }])
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.restored).toBe(2)
    expect(await snapshot(root)).toEqual(before)
  })

  it('never clobbers a note already sitting at the destination', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'moving\n')
    await seed(root, 'archive/Note.md', 'existing\n')

    const receipt = await apply(root, [{ kind: 'move', path: 'inbox/Note.md', to: 'archive' }])

    expect(receipt.paths).toEqual(['inbox/Note.md', 'archive/Note 2.md'])
    expect(await readOrNull(root, 'archive/Note.md')).toBe('existing\n')
    expect(await readOrNull(root, 'archive/Note 2.md')).toBe('moving\n')
  })

  it('renames within the same folder', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/demo/Old.md', 'body\n')

    await apply(root, [{ kind: 'rename', path: 'inbox/demo/Old.md', to: 'New Name' }])

    expect(await readOrNull(root, 'inbox/demo/Old.md')).toBeNull()
    expect(await readOrNull(root, 'inbox/demo/New Name.md')).toBe('body\n')
  })

  it('keeps the file type when renaming a drawing', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Sketch.excalidraw', '{}\n')

    await apply(root, [{ kind: 'rename', path: 'inbox/Sketch.excalidraw', to: 'Plan' }])

    expect(await readOrNull(root, 'inbox/Plan.excalidraw')).toBe('{}\n')
  })

  it('mirrors the subfolder when archiving', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/demo/X.md', 'x\n')

    await apply(root, [{ kind: 'archive', path: 'inbox/demo/X.md' }])

    expect(await readOrNull(root, 'archive/demo/X.md')).toBe('x\n')
  })

  it('trashes a note from the top level', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/X.md', 'x\n')

    await apply(root, [{ kind: 'trash', path: 'inbox/X.md' }])

    expect(await readOrNull(root, 'trash/X.md')).toBe('x\n')
    expect(await readOrNull(root, 'inbox/X.md')).toBeNull()
  })

  it('does nothing when the note is already where the op would put it', async () => {
    const root = await makeVault()
    await seed(root, 'trash/Old.md', 'old\n')

    const receipt = await apply(root, [{ kind: 'trash', path: 'trash/Old.md' }])
    const ledger = await readLedger(root, receipt.runId)

    expect(receipt.paths).toEqual([])
    expect(ledger.journal).toEqual([])
    expect(await readOrNull(root, 'trash/Old.md')).toBe('old\n')
  })

  it('journals the pre-run bytes when an edit and a move hit the same note', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'original\n')
    const before = await snapshot(root)

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edited' },
      { kind: 'archive', path: 'inbox/A.md' }
    ])
    const ledger = await readLedger(root, receipt.runId)

    expect(ledger.journal[0]).toEqual({ path: 'inbox/A.md', before: 'original\n' })
    expect(await readOrNull(root, 'archive/A.md')).toContain('edited')

    await undoWorkflowRun(root, receipt.runId)
    expect(await snapshot(root)).toEqual(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  Rollback                                                                  */
/* -------------------------------------------------------------------------- */

describe('rollback', () => {
  it('leaves every file byte-identical when an op fails mid-run', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')
    const before = await snapshot(root)

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'first' },
      { kind: 'append', path: 'inbox/B.md', text: 'second' },
      { kind: 'move', path: 'inbox/Gone.md', to: 'archive' }
    ])

    expect(receipt.rolledBack?.reason).toMatch(/missing/)
    expect(receipt.rolledBack?.reason).toMatch(/vault is unchanged/)
    expect(receipt.applied).toBe(0)
    expect(receipt.paths).toEqual([])
    expect(await snapshot(root)).toEqual(before)
  })

  it('removes files the failed run created', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const before = await snapshot(root)

    await apply(root, [
      { kind: 'create-note', path: 'inbox/Created.md', body: 'new' },
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'archive', path: 'inbox/Gone.md' }
    ])

    expect(await readOrNull(root, 'inbox/Created.md')).toBeNull()
    expect(await snapshot(root)).toEqual(before)
  })

  it('puts a completed move back before failing later in the run', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')
    const before = await snapshot(root)

    await apply(root, [
      { kind: 'archive', path: 'inbox/Note.md' },
      { kind: 'trash', path: 'inbox/Missing.md' }
    ])

    expect(await snapshot(root)).toEqual(before)
    expect(await readOrNull(root, 'archive/Note.md')).toBeNull()
  })

  it('keeps no run record when the rollback was clean', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'trash', path: 'inbox/Missing.md' }
    ])

    // Nothing landed, so a run offering an undo would describe changes that are
    // not there.
    expect(await ledgerFiles(root)).toEqual([])
    expect(await listWorkflowRuns(root)).toEqual([])
  })

  it('reports a clean rollback when the only failed write left the file untouched', async () => {
    // A path is journalled BEFORE its write is attempted, so a write that fails
    // leaves a journal entry for a file nobody changed. Restoring it is a no-op,
    // and reporting ROLLBACK INCOMPLETE for it would contradict the headline the
    // user reads while the vault is in fact pristine.
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    injected.failingWrites.add(path.join(root, 'inbox', 'A.md'))

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    expect(receipt.rolledBack?.reason).toMatch(/rolled back/i)
    expect(receipt.rolledBack?.reason).not.toMatch(/ROLLBACK INCOMPLETE/)
    expect(receipt.applied).toBe(0)
    expect(receipt.paths).toEqual([])
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
    // A clean rollback changed nothing, so there is no run to offer an undo for.
    expect(await listWorkflowRuns(root)).toEqual([])
  })

  it('says so loudly when the rollback itself cannot finish', async () => {
    // The genuine incomplete case: A's write SUCCEEDS so the file really holds
    // this run's bytes, B fails to force the rollback, and A's restore is what
    // cannot be written.
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')
    injected.failAfterWrites.set(path.join(root, 'inbox', 'A.md'), 1)
    injected.failingWrites.add(path.join(root, 'inbox', 'B.md'))

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'append', path: 'inbox/B.md', text: 'edit' }
    ])

    expect(receipt.rolledBack?.reason).toMatch(/ROLLBACK INCOMPLETE/)
    expect(receipt.rolledBack?.reason).toMatch(/inbox\/A\.md/)
    expect(receipt.applied).toBe(0)
    expect(receipt.paths).toEqual(['inbox/A.md'])
    // A really is still holding the run's bytes, which is why this is loud.
    expect(await readOrNull(root, 'inbox/A.md')).not.toBe('a\n')
  })

  it('keeps the journal on disk when the rollback could not finish, so undo can retry', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')
    injected.failAfterWrites.set(path.join(root, 'inbox', 'A.md'), 1)
    injected.failingWrites.add(path.join(root, 'inbox', 'B.md'))

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'append', path: 'inbox/B.md', text: 'edit' }
    ])
    const [run] = await listWorkflowRuns(root)
    expect(run?.runId).toBe(receipt.runId)
    expect(run?.undoable).toBe(true)

    injected.failingWrites.clear()
    injected.failAfterWrites.clear()
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.restored).toBeGreaterThanOrEqual(1)
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
    expect(await readOrNull(root, 'inbox/B.md')).toBe('b\n')
  })

  it('rolls the run back rather than leave changes it could not record', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const before = await snapshot(root)
    // The run's own ledger is what makes it undoable, so a run that cannot be
    // recorded must not survive. A plain file where the runs directory belongs
    // makes every ledger write fail, whatever the run ends up being called.
    await mkdir(path.dirname(runsDirOf(root)), { recursive: true })
    await writeFile(runsDirOf(root), 'not a directory', 'utf8')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    expect(receipt.rolledBack?.reason).toMatch(/could not be recorded/)
    expect(receipt.applied).toBe(0)
    expect(await snapshot(root)).toEqual(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  The ledger                                                                */
/* -------------------------------------------------------------------------- */

describe('run ledger', () => {
  it('records the run, its ops, its journal and its hashes', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const ops: WorkflowOp[] = [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'notify', message: 'done' }
    ]

    const receipt = await apply(root, ops, 'reading-log')
    const ledger = await readLedger(root, receipt.runId)

    expect(ledger.version).toBe(1)
    expect(ledger.runId).toBe(receipt.runId)
    expect(ledger.workflowId).toBe('reading-log')
    expect(ledger.startedAt).toBe(receipt.startedAt)
    expect(ledger.finishedAt).toBeGreaterThanOrEqual(ledger.startedAt)
    expect(ledger.applied).toBe(1)
    expect(ledger.irreversible).toBe(1)
    expect(ledger.paths).toEqual(['inbox/A.md'])
    expect(ledger.ops).toEqual(ops)
    expect(ledger.journal).toEqual([{ path: 'inbox/A.md', before: 'a\n' }])
    expect(ledger.undone).toBe(false)
  })

  it('hashes what the run left at each path', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    const ledger = await readLedger(root, receipt.runId)
    const written = await readOrNull(root, 'inbox/A.md')

    expect(ledger.hashes['inbox/A.md']).toBe(sha256(written ?? ''))
  })

  it('records a null hash for a path the run emptied', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')

    const receipt = await apply(root, [{ kind: 'archive', path: 'inbox/Note.md' }])
    const ledger = await readLedger(root, receipt.runId)

    expect(ledger.hashes['inbox/Note.md']).toBeNull()
    expect(ledger.hashes['archive/Note.md']).toBe(sha256('body\n'))
  })

  it('records why an incomplete rollback left files behind', async () => {
    // Needs a genuinely stuck rollback: A's write lands, B forces the unwind,
    // and A's restore is the one that cannot be written. A run whose only write
    // failed rolls back cleanly and deliberately leaves no ledger at all.
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')
    injected.failAfterWrites.set(path.join(root, 'inbox', 'A.md'), 1)
    injected.failingWrites.add(path.join(root, 'inbox', 'B.md'))

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'append', path: 'inbox/B.md', text: 'edit' }
    ])
    const ledger = await readLedger(root, receipt.runId)

    expect(ledger.rolledBack?.reason).toMatch(/ROLLBACK INCOMPLETE/)
    expect(ledger.applied).toBe(0)
    expect(ledger.journal).toContainEqual({ path: 'inbox/A.md', before: 'a\n' })
  })

  it('keeps the history bounded, since every ledger holds a copy of the old bytes', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await mkdir(runsDirOf(root), { recursive: true })
    for (let n = 0; n < MAX_RETAINED_RUNS; n += 1) {
      const runId = `17000000000${String(n).padStart(2, '0')}-001-aaaaaaaa`
      await writeFile(
        path.join(runsDirOf(root), `${runId}.json`),
        JSON.stringify({ version: 1, runId, journal: [] }),
        'utf8'
      )
    }

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    const files = await ledgerFiles(root)

    expect(files.length).toBe(MAX_RETAINED_RUNS)
    expect(files).toContain(`${receipt.runId}.json`)
    // The oldest went, not the newest.
    expect(files).not.toContain('1700000000000-001-aaaaaaaa.json')
  })

  it('names runs so they sort chronologically without randomness', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const first = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: '1' }])
    const second = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: '2' }])

    expect(first.runId).toMatch(/^\d{13}-\d{3}-[0-9a-f]{8}$/)
    expect(second.runId > first.runId).toBe(true)
    expect(await ledgerFiles(root)).toEqual([`${first.runId}.json`, `${second.runId}.json`])
  })

  it('gives two runs of the same ops in the same millisecond different ids', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const first = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'x' }])
    const second = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'x' }])

    expect(second.runId).not.toBe(first.runId)
    expect((await ledgerFiles(root)).length).toBe(2)
  })
})

/* -------------------------------------------------------------------------- */
/*  Undo                                                                      */
/* -------------------------------------------------------------------------- */

describe('undoWorkflowRun', () => {
  it('restores the recorded bytes of every touched file', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')
    const before = await snapshot(root)

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: '1' },
      { kind: 'write-note', path: 'inbox/B.md', text: 'replaced' },
      { kind: 'create-note', path: 'inbox/C.md', body: 'new' }
    ])
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.restored).toBe(3)
    expect(await snapshot(root)).toEqual(before)
  })

  it('restores bytes rather than replaying an inverse, even after edits outside the run', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    // Someone types in the note after the run. Undo is a restore of the recorded
    // pre-run bytes, so this is what it takes the file back to.
    await seed(root, 'inbox/A.md', 'typed by hand\n')
    await undoWorkflowRun(root, receipt.runId)

    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
  })

  it('errors on an unknown run instead of quietly succeeding', async () => {
    const root = await makeVault()
    await expect(undoWorkflowRun(root, '1700000000000-001-deadbeef')).rejects.toThrow(
      /Unknown workflow run/
    )
  })

  it('errors on a second undo of the same run', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    await undoWorkflowRun(root, receipt.runId)

    await expect(undoWorkflowRun(root, receipt.runId)).rejects.toThrow(/already undone/)
  })

  it('refuses a run id that is really a path', async () => {
    const root = await makeVault()
    await expect(undoWorkflowRun(root, '../../etc/passwd')).rejects.toThrow(
      /Invalid workflow run id/
    )
  })

  it('refuses to restore a journal entry pointing outside the vault', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    // A ledger is a file in the vault, so it can be edited (or arrive over
    // sync). It must never become a way to write anywhere on the filesystem.
    const ledgerPath = path.join(runsDirOf(root), `${receipt.runId}.json`)
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as WorkflowRunLedger
    ledger.journal = [{ path: '../escaped.md', before: 'owned' }]
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8')

    await expect(undoWorkflowRun(root, receipt.runId)).rejects.toThrow(/incomplete/)
    expect(await readOrNull(root, '../escaped.md')).toBeNull()
  })

  it('leaves the run undoable when the restore could not finish', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    injected.failingWrites.add(path.join(root, 'inbox', 'A.md'))
    await expect(undoWorkflowRun(root, receipt.runId)).rejects.toThrow(/try again/)

    // Restoring recorded bytes is idempotent, so the honest recovery (retry) is
    // also the correct one.
    injected.failingWrites.clear()
    expect((await undoWorkflowRun(root, receipt.runId)).restored).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/*  History                                                                   */
/* -------------------------------------------------------------------------- */

describe('listWorkflowRuns', () => {
  it('is empty for a vault that has never run a workflow', async () => {
    const root = await makeVault()
    expect(await listWorkflowRuns(root)).toEqual([])
  })

  it('lists runs newest first', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const first = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: '1' }], 'one')
    const second = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: '2' }], 'two')
    const runs = await listWorkflowRuns(root)

    expect(runs.map((run) => run.runId)).toEqual([second.runId, first.runId])
    expect(runs[0]?.workflowId).toBe('two')
  })

  it('reports what a run touched', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')

    const receipt = await apply(root, [{ kind: 'move', path: 'inbox/Note.md', to: 'archive' }])
    const [run] = await listWorkflowRuns(root)

    expect(run).toEqual({
      runId: receipt.runId,
      workflowId: 'test-flow',
      startedAt: receipt.startedAt,
      applied: 1,
      paths: ['inbox/Note.md', 'archive/Note.md'],
      undoable: true
    })
  })

  it('stops offering undo once a run has been undone', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    await undoWorkflowRun(root, receipt.runId)
    const [run] = await listWorkflowRuns(root)

    expect(run?.runId).toBe(receipt.runId)
    expect(run?.undoable).toBe(false)
  })

  it('skips an unreadable ledger instead of hiding the rest of the history', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await writeFile(path.join(runsDirOf(root), '1700000000000-002-cafebabe.json'), '{ broken', 'utf8')

    const runs = await listWorkflowRuns(root)

    expect(runs.map((run) => run.runId)).toEqual([receipt.runId])
  })

  it('ignores files in the runs directory that are not ledgers', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    await writeFile(path.join(runsDirOf(root), 'README.txt'), 'notes', 'utf8')

    expect((await listWorkflowRuns(root)).length).toBe(1)
  })
})

describe('ops after a path op follow the note', () => {
  it('applies a text op to the destination the move promised', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'body\n')

    const receipt = await apply(root, [
      { kind: 'move', path: 'inbox/A.md', to: 'archive' },
      { kind: 'add-tag', path: 'archive/A.md', tag: 'filed' }
    ])

    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'inbox/A.md')).toBeNull()
    expect(await readOrNull(root, 'archive/A.md')).toContain('#filed')
  })

  it('refuses a per-note text op whose target is gone, and rolls the run back', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'body\n')
    const before = await snapshot(root)

    // A plan from a stale wire: the second op names the pre-move path. Writing
    // '' + tag there would materialize a phantom note; the honest outcome is a
    // failed, fully rolled-back run.
    const receipt = await apply(root, [
      { kind: 'move', path: 'inbox/A.md', to: 'archive' },
      { kind: 'append', path: 'inbox/A.md', text: 'ghost' }
    ])

    expect(receipt.rolledBack?.reason).toContain('the note is missing')
    expect(receipt.applied).toBe(0)
    expect(await snapshot(root)).toEqual(before)
  })

  it('sinks may still create their target file', async () => {
    const root = await makeVault()
    const receipt = await apply(root, [
      { kind: 'write-note', path: 'inbox/Report.md', text: 'fresh\n' }
    ])
    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'inbox/Report.md')).toBe('fresh\n')
  })

  it('follows the forwarding address when a collision diverted the move', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'moved one\n')
    await seed(root, 'archive/A.md', 'already here\n')

    // Op 1 promises archive/A.md but must land at `archive/A 2.md`; op 2 sends
    // the pre-existing note away; op 3 names the promised path, which is now a
    // gap only this run knows the forwarding address for.
    const receipt = await apply(root, [
      { kind: 'move', path: 'inbox/A.md', to: 'archive' },
      { kind: 'trash', path: 'archive/A.md' },
      { kind: 'append', path: 'archive/A.md', text: 'found you' }
    ])

    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'archive/A 2.md')).toBe('moved one\nfound you\n')
    expect(await readOrNull(root, 'trash/A.md')).toBe('already here\n')
    expect(await readOrNull(root, 'archive/A.md')).toBeNull()
  })

  it('the stated path wins over a forwarding address while the file exists', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'moved one\n')
    await seed(root, 'archive/A.md', 'already here\n')

    // The redirect for archive/A.md exists after op 1, but the op names a note
    // that is really there: the redirect must not hijack it.
    const receipt = await apply(root, [
      { kind: 'move', path: 'inbox/A.md', to: 'archive' },
      { kind: 'append', path: 'archive/A.md', text: ' tagged' }
    ])

    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'archive/A.md')).toBe('already here\n tagged\n')
    expect(await readOrNull(root, 'archive/A 2.md')).toBe('moved one\n')
  })

  it('a chained move keeps the collision suffix rather than reclaiming the promised name', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'moved one\n')
    await seed(root, 'quick/A.md', 'blocker\n')

    // Move 1 diverts to `quick/A 2.md`; move 2 names the promised quick/A.md,
    // which still exists (the blocker), so the blocker moves and the diverted
    // file stays put under its real name.
    const receipt = await apply(root, [
      { kind: 'move', path: 'inbox/A.md', to: 'quick' },
      { kind: 'move', path: 'quick/A.md', to: 'archive' }
    ])

    expect(receipt.rolledBack).toBeUndefined()
    expect(await readOrNull(root, 'quick/A 2.md')).toBe('moved one\n')
    expect(await readOrNull(root, 'archive/A.md')).toBe('blocker\n')
  })
})

describe('one run at a time per vault', () => {
  it('concurrent applies serialize instead of interleaving read-modify-write', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Log.md', 'start\n')

    // Each append is a read + an awaited write; fired together WITHOUT the
    // per-vault queue, later reads race earlier writes and lines vanish.
    const lines = Array.from({ length: 12 }, (_, n) => `line ${n}`)
    const receipts = await Promise.all(
      lines.map((text) =>
        apply(root, [{ kind: 'append', path: 'inbox/Log.md', text }], `flow-${text}`)
      )
    )

    for (const receipt of receipts) expect(receipt.rolledBack).toBeUndefined()
    const body = (await readOrNull(root, 'inbox/Log.md')) ?? ''
    for (const text of lines) expect(body).toContain(text)
  })

  it('an undo queued behind a run sees the run completed, not half of it', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const first = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'one' }])
    // Fire the second run and the undo of the first together: the undo must
    // not run inside the second run's read-write window.
    const [second, undone] = await Promise.all([
      apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'two' }]),
      undoWorkflowRun(root, first.runId)
    ])

    expect(second.rolledBack).toBeUndefined()
    expect(undone.restored).toBeGreaterThan(0)
    // Enqueue order is the call order: the second run appends, THEN the undo
    // restores the first run's recorded pre-run bytes, which by the journal's
    // documented byte-restore contract also takes the second append with it.
    // Coherent, in queue order, and every receipt above told the truth. The
    // interleaved failure this test exists to rule out looks different: the
    // undo's read-compare-write lands inside the second run's read-write
    // window and 'two' vanishes while `second` still reports it applied.
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
  })
})

/* -------------------------------------------------------------------------- */
/*  Symlinked notes                                                           */
/* -------------------------------------------------------------------------- */

describe('symlinked notes', () => {
  it('writes through the link instead of replacing it', async () => {
    const root = await makeVault()
    await seed(root, 'sources/Real.md', 'real\n')
    await symlink(path.join(root, 'sources', 'Real.md'), path.join(root, 'inbox', 'Link.md'))

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/Link.md', text: 'added' }])

    expect(receipt.rolledBack).toBeUndefined()
    // The point of the fix: a temp-file rename would have left a regular file
    // here and detached the note from the file it is a view of.
    expect(await isSymlink(path.join(root, 'inbox', 'Link.md'))).toBe(true)
    expect(await readOrNull(root, 'sources/Real.md')).toBe('real\nadded\n')
  })

  it('undo puts the bytes back through the link, which is still a link', async () => {
    const root = await makeVault()
    await seed(root, 'sources/Real.md', 'real\n')
    await symlink(path.join(root, 'sources', 'Real.md'), path.join(root, 'inbox', 'Link.md'))

    const receipt = await apply(root, [
      { kind: 'write-note', path: 'inbox/Link.md', text: 'replaced\n' }
    ])
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.restored).toBe(1)
    expect(await isSymlink(path.join(root, 'inbox', 'Link.md'))).toBe(true)
    expect(await readOrNull(root, 'sources/Real.md')).toBe('real\n')
  })

  it('creates the target of a dangling link, and undo takes only that away', async () => {
    const root = await makeVault()
    await symlink(path.join(root, 'sources', 'Missing.md'), path.join(root, 'inbox', 'Link.md'))

    const receipt = await apply(root, [
      { kind: 'write-note', path: 'inbox/Link.md', text: 'fresh\n' }
    ])
    expect(await readOrNull(root, 'sources/Missing.md')).toBe('fresh\n')

    await undoWorkflowRun(root, receipt.runId)

    // Back to a link pointing at nothing, which is exactly how it was found.
    expect(await readOrNull(root, 'sources/Missing.md')).toBeNull()
    expect(await isSymlink(path.join(root, 'inbox', 'Link.md'))).toBe(true)
  })

  it('leaves a created note as a regular file', async () => {
    const root = await makeVault()
    await apply(root, [{ kind: 'create-note', path: 'inbox/New.md', body: 'hello' }])
    expect(await isSymlink(path.join(root, 'inbox', 'New.md'))).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Surviving the process                                                     */
/* -------------------------------------------------------------------------- */

describe('crash journal', () => {
  it('is on disk before the write it protects', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    let midRun: Record<string, unknown>[] = []
    injected.beforeWrite = async (abs) => {
      if (!abs.endsWith('A.md') || midRun.length > 0) return
      const [name] = await journalNames(root)
      if (name) midRun = journalLines(await readFile(path.join(runsDirOf(root), name), 'utf8'))
    }

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    expect(midRun[0]?.runId).toBe(receipt.runId)
    expect(midRun[0]?.workflowId).toBe('test-flow')
    expect(midRun[1]).toEqual({ path: 'inbox/A.md', before: 'a\n' })
  })

  it('a finished run leaves none behind', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])

    expect(await ledgerFiles(root)).toEqual([`${receipt.runId}.json`])
  })

  it('a rolled-back run leaves none behind either', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'trash', path: 'inbox/Missing.md' }
    ])

    expect(await ledgerFiles(root)).toEqual([])
  })

  it('turns the journal a dead process left into an undoable run', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    // Copy the journal exactly as it is while the run is applying: that file is
    // what a killed process leaves behind.
    let crashName = ''
    let crashRaw = ''
    injected.beforeWrite = async (abs) => {
      if (!abs.endsWith('A.md') || crashName) return
      const [name] = await journalNames(root)
      if (name) {
        crashName = name
        crashRaw = await readFile(path.join(runsDirOf(root), name), 'utf8')
      }
    }
    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    injected.beforeWrite = null
    // The process died here: the write is on disk, the ledger never was.
    await rm(path.join(runsDirOf(root), `${receipt.runId}.json`))
    await writeFile(path.join(runsDirOf(root), crashName), crashRaw, 'utf8')

    const runs = await listWorkflowRuns(root)

    expect(runs.map((run) => run.runId)).toEqual([receipt.runId])
    expect(runs[0]?.interrupted).toBe(true)
    expect(runs[0]?.undoable).toBe(true)
    // The journal became the ledger, so recovery does not run twice.
    expect(await ledgerFiles(root)).toEqual([`${receipt.runId}.json`])

    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.restored).toBe(1)
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
  })

  it('recovers before a new run rather than waiting for someone to look', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'half applied\n')
    const orphan = '1700000000000-001-aaaaaaaa'
    await mkdir(runsDirOf(root), { recursive: true })
    await writeFile(
      journalPath(root, orphan),
      `${JSON.stringify({ version: 1, runId: orphan, workflowId: 'dead', startedAt: 1700000000000 })}\n` +
        `${JSON.stringify({ path: 'inbox/A.md', before: 'original\n' })}\n`,
      'utf8'
    )

    const receipt = await apply(root, [{ kind: 'create-note', path: 'inbox/B.md', body: 'b' }])

    expect(await ledgerFiles(root)).toEqual([`${orphan}.json`, `${receipt.runId}.json`].sort())
    const recovered = (await listWorkflowRuns(root)).find((run) => run.runId === orphan)
    expect(recovered?.interrupted).toBe(true)
    await undoWorkflowRun(root, orphan)
    expect(await readOrNull(root, 'inbox/A.md')).toBe('original\n')
  })

  it('keeps the entries before a line the crash cut in half', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'changed by the dead run\n')
    const orphan = '1700000000000-001-aaaaaaaa'
    await mkdir(runsDirOf(root), { recursive: true })
    await writeFile(
      journalPath(root, orphan),
      `${JSON.stringify({ version: 1, runId: orphan, workflowId: 'dead', startedAt: 1700000000000 })}\n` +
        `${JSON.stringify({ path: 'inbox/A.md', before: 'original\n' })}\n` +
        '{"path":"inbox/B.md","bef',
      'utf8'
    )

    expect(await recoverInterruptedRuns(root)).toEqual([orphan])

    const ledger = await readLedger(root, orphan)
    expect(ledger.journal).toEqual([{ path: 'inbox/A.md', before: 'original\n' }])
    await undoWorkflowRun(root, orphan)
    expect(await readOrNull(root, 'inbox/A.md')).toBe('original\n')
  })

  it('drops a journal with nothing in it, since that run never wrote', async () => {
    const root = await makeVault()
    const orphan = '1700000000000-001-aaaaaaaa'
    await mkdir(runsDirOf(root), { recursive: true })
    await writeFile(
      journalPath(root, orphan),
      `${JSON.stringify({ version: 1, runId: orphan, workflowId: 'dead', startedAt: 1 })}\n`,
      'utf8'
    )

    expect(await recoverInterruptedRuns(root)).toEqual([])
    expect(await ledgerFiles(root)).toEqual([])
  })

  it('never takes a live run for an interrupted one', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    // Reading the history WHILE the run is writing: the journal is on disk and
    // has no ledger yet, which is exactly what an abandoned run looks like. The
    // per-vault queue is what tells them apart, so this waits behind the run
    // rather than recovering it out from under itself.
    const pending: Promise<WorkflowRunSummary[]>[] = []
    injected.beforeWrite = (abs) => {
      if (abs.endsWith('A.md') && pending.length === 0) pending.push(listWorkflowRuns(root))
    }

    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    const [runs] = await Promise.all(pending)

    expect(runs?.map((run) => run.runId)).toEqual([receipt.runId])
    expect(runs?.[0]?.interrupted).toBeUndefined()
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\nedit\n')
  })

  it('drops a journal whose run already has a ledger, without touching it', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    const receipt = await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'edit' }])
    await writeFile(
      journalPath(root, receipt.runId),
      `${JSON.stringify({ version: 1, runId: receipt.runId, workflowId: 'test-flow', startedAt: 1 })}\n` +
        `${JSON.stringify({ path: 'inbox/A.md', before: 'not what really happened\n' })}\n`,
      'utf8'
    )

    expect(await recoverInterruptedRuns(root)).toEqual([])

    const ledger = await readLedger(root, receipt.runId)
    expect(ledger.journal).toEqual([{ path: 'inbox/A.md', before: 'a\n' }])
    expect(ledger.interrupted).toBeUndefined()
    expect(await journalNames(root)).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  One file, two spellings                                                   */
/* -------------------------------------------------------------------------- */

describe('journal keys on a case-insensitive filesystem', () => {
  it.skipIf(!oneCaseFolder)(
    'journals one entry when two ops name the same file in different cases',
    async () => {
      const root = await makeVault()
      await seed(root, 'inbox/A.md', 'original\n')
      const before = await snapshot(root)

      const receipt = await apply(root, [
        { kind: 'append', path: 'inbox/A.md', text: 'first' },
        { kind: 'append', path: 'inbox/a.md', text: 'second' }
      ])
      const ledger = await readLedger(root, receipt.runId)

      // Two entries would mean the second recorded what the first op had just
      // written, and undo would restore a half-applied run.
      expect(ledger.journal).toEqual([{ path: 'inbox/A.md', before: 'original\n' }])
      await undoWorkflowRun(root, receipt.runId)
      expect(await snapshot(root)).toEqual(before)
    }
  )

  it.skipIf(!oneCaseFolder)('reports one path when two ops name one file in two cases', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'original\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'first' },
      { kind: 'append', path: 'inbox/a.md', text: 'second' }
    ])
    const ledger = await readLedger(root, receipt.runId)

    expect(receipt.paths).toEqual(['inbox/A.md'])
    // Two hashes would leave the journalled spelling holding the hash of the
    // FIRST write, and undo would then report a file as drifted because of the
    // run's own second op.
    expect(Object.keys(ledger.hashes)).toEqual(['inbox/A.md'])
    expect((await undoWorkflowRun(root, receipt.runId)).driftedPaths).toEqual([])
  })

  it.skipIf(!oneCaseFolder)('undoes a rename that only changes case', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/note.md', 'body\n')
    const before = await snapshot(root)

    const receipt = await apply(root, [{ kind: 'rename', path: 'inbox/note.md', to: 'Note' }])
    // Destination and source are the same file here, so the collision suffix
    // takes it rather than the note replacing itself.
    expect(receipt.paths).toEqual(['inbox/note.md', 'inbox/Note 2.md'])

    await undoWorkflowRun(root, receipt.runId)

    expect(await snapshot(root)).toEqual(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  What undo overwrote                                                       */
/* -------------------------------------------------------------------------- */

describe('undo drift', () => {
  it('reports nothing for a run nobody has touched since', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'create-note', path: 'inbox/B.md', body: 'new' },
      { kind: 'move', path: 'inbox/A.md', to: 'archive' }
    ])
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.driftedPaths).toEqual([])
  })

  it('names a note edited since the run, and restores it anyway', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await seed(root, 'inbox/B.md', 'b\n')

    const receipt = await apply(root, [
      { kind: 'append', path: 'inbox/A.md', text: 'edit' },
      { kind: 'append', path: 'inbox/B.md', text: 'edit' }
    ])
    await seed(root, 'inbox/B.md', 'typed by hand\n')
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.driftedPaths).toEqual(['inbox/B.md'])
    // The overwrite is the documented contract; the report is what makes it
    // honest rather than silent.
    expect(await readOrNull(root, 'inbox/B.md')).toBe('b\n')
    expect(await readOrNull(root, 'inbox/A.md')).toBe('a\n')
  })

  it('counts a note put back at a path the run had emptied', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/Note.md', 'body\n')

    const receipt = await apply(root, [{ kind: 'move', path: 'inbox/Note.md', to: 'archive' }])
    await seed(root, 'inbox/Note.md', 'something new\n')
    const undo = await undoWorkflowRun(root, receipt.runId)

    expect(undo.driftedPaths).toEqual(['inbox/Note.md'])
  })

  it('says nothing about a recovered run, which never claimed how it left things', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'half applied\n')
    const orphan = '1700000000000-001-aaaaaaaa'
    await mkdir(runsDirOf(root), { recursive: true })
    await writeFile(
      journalPath(root, orphan),
      `${JSON.stringify({ version: 1, runId: orphan, workflowId: 'dead', startedAt: 1 })}\n` +
        `${JSON.stringify({ path: 'inbox/A.md', before: 'original\n' })}\n`,
      'utf8'
    )
    await recoverInterruptedRuns(root)

    expect((await undoWorkflowRun(root, orphan)).driftedPaths).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  Retention                                                                 */
/* -------------------------------------------------------------------------- */

describe('pruneRunLedgers', () => {
  async function seedLedger(root: string, runId: string, bytes: number): Promise<void> {
    await mkdir(runsDirOf(root), { recursive: true })
    await writeFile(
      path.join(runsDirOf(root), `${runId}.json`),
      JSON.stringify({
        version: 1,
        runId,
        journal: [{ path: 'inbox/A.md', before: 'x'.repeat(bytes) }]
      }),
      'utf8'
    )
  }

  it('drops the oldest ledgers once the retained bytes exceed the cap', async () => {
    const root = await makeVault()
    const ids = ['1700000000001-001-aaaaaaaa', '1700000000002-001-bbbbbbbb', '1700000000003-001-cccccccc']
    for (const runId of ids) await seedLedger(root, runId, 4000)

    // Room for two of them: the third is what the byte cap is for, since a
    // count cap alone would keep all three whatever they weigh.
    await pruneRunLedgers(root, MAX_RETAINED_RUNS, 9 * 1024)

    expect(await ledgerFiles(root)).toEqual([`${ids[1]}.json`, `${ids[2]}.json`])
  })

  it('keeps the most recent run even when it alone is over the cap', async () => {
    const root = await makeVault()
    await seedLedger(root, '1700000000001-001-aaaaaaaa', 4000)
    await seedLedger(root, '1700000000002-001-bbbbbbbb', 4000)

    await pruneRunLedgers(root, MAX_RETAINED_RUNS, 10)

    // Dropping it would take the undo away from the run the user was just shown.
    expect(await ledgerFiles(root)).toEqual(['1700000000002-001-bbbbbbbb.json'])
  })

  it('still drops by count, whatever the ledgers weigh', async () => {
    const root = await makeVault()
    await seedLedger(root, '1700000000001-001-aaaaaaaa', 10)
    await seedLedger(root, '1700000000002-001-bbbbbbbb', 10)

    await pruneRunLedgers(root, 1)

    expect(await ledgerFiles(root)).toEqual(['1700000000002-001-bbbbbbbb.json'])
  })
})

describe('deleteWorkflowRuns', () => {
  it('removes only the named workflow\'s ledgers and reports the count', async () => {
    const root = await makeVault()
    await seed(root, 'inbox/A.md', 'a\n')
    await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'one' }], 'tutorial')
    await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'two' }], 'tutorial')
    await apply(root, [{ kind: 'append', path: 'inbox/A.md', text: 'three' }], 'keeper')

    const removed = await deleteWorkflowRuns(root, 'tutorial')

    expect(removed).toBe(2)
    const runs = await listWorkflowRuns(root)
    expect(runs.map((run) => run.workflowId)).toEqual(['keeper'])
  })

  it('a vault with no runs answers zero', async () => {
    const root = await makeVault()
    expect(await deleteWorkflowRuns(root, 'tutorial')).toBe(0)
  })
})
