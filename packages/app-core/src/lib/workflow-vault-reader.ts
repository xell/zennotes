// Adapt the app's note list to the workflow engine's read-only `VaultReader`.
//
// This is the whole seam between the renderer and `@shared/workflows/engine`:
// the engine has no file access of its own, so whatever this module hands back
// IS the vault as far as a plan is concerned. Two details carry most of the
// weight, and both are silent when wrong:
//
//   1. `WorkflowNote.folder` is a vault-relative DIRECTORY, derived from the
//      path. `NoteMeta.folder` is the system bucket (inbox/quick/archive/trash)
//      and is NOT the same thing. The engine's `folder`/`in` steps prefix-match
//      on the directory, so passing the bucket would make every folder filter
//      quietly match the wrong notes rather than fail.
//   2. Bodies are read at most once per reader. A `contains` over 200 notes,
//      followed by a `search`, must touch each file once; the engine caches too,
//      but only within a single run, and the view plans on every selection.

import type { NoteMeta } from '@shared/ipc'
import { parseFrontmatter } from '@shared/template-files'
import type { VaultReader, WorkflowNote } from '@shared/workflows/types'

/**
 * Vault-relative directory of a note: `inbox/books` for `inbox/books/Dune.md`,
 * `''` for a note at the vault root.
 *
 * Paths from the bridge are already POSIX and root-relative; the leading `./`
 * and `/` trims are there so a hand-built path in a test or a future caller
 * cannot produce a folder the engine's prefix match would never hit.
 */
function directoryOfPath(path: string): string {
  const clean = path.replace(/^\.\//, '').replace(/^\/+/, '')
  const cut = clean.lastIndexOf('/')
  return cut === -1 ? '' : clean.slice(0, cut)
}

/**
 * Project one note into the shape a wire carries.
 *
 * `body` is the raw file text, exactly what `VaultReader.readBody` returns, so
 * `contains` sees the same bytes the engine would have loaded itself. Omitting
 * the key (rather than setting it to `undefined`) keeps the engine's "not read
 * yet" and "empty file" cases distinguishable.
 */
export function toWorkflowNote(meta: NoteMeta, body?: string): WorkflowNote {
  const note: WorkflowNote = {
    path: meta.path,
    title: meta.title,
    folder: directoryOfPath(meta.path),
    // The system bucket rides along separately from the directory: with
    // remapped system folders the directory name no longer says "trash", and
    // this is what keeps `all` off the Trash on such vaults.
    system: meta.folder,
    // Copied: the engine hands these objects to user-authored steps, and the
    // array on `NoteMeta` belongs to the store.
    tags: [...meta.tags],
    // `NoteMeta` carries no frontmatter, so it can only come from the body. A
    // note whose body has not been read yet has none, which is why `where` on a
    // frontmatter field matches nothing until something loads it.
    frontmatter: body === undefined ? {} : parseFrontmatter(body).data,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt
  }
  if (body !== undefined) note.body = body
  return note
}

export interface VaultReaderOptions {
  /** Every note the workflow may see, in the order sources should observe. */
  notes: NoteMeta[]
  /** Raw file text for one vault-relative path. */
  readBody: (path: string) => Promise<string>
  /** Active note, for the `current` source. Omit where there is no such notion. */
  current?: () => NoteMeta | null
  /** Explicitly selected notes, for the `selection` source. */
  selection?: () => NoteMeta[]
}

/**
 * Build a reader over a note list.
 *
 * `current` and `selection` are left OFF the returned object when the caller
 * did not supply them, because the engine distinguishes "no note is active"
 * (an empty set) from "this context has no concept of an active note" (a
 * diagnostic). Passing a callback that always returns null would report the
 * wrong one.
 */
export function createVaultReader(opts: VaultReaderOptions): VaultReader {
  // path -> settled body. Read synchronously by `toNote`, so every note handed
  // out after a read carries its frontmatter.
  const bodies = new Map<string, string>()
  // path -> the read itself, in flight or settled. Keyed separately from
  // `bodies` so a second request joins the first read rather than starting
  // another one, and so a failed read is not retried once per step.
  const reads = new Map<string, Promise<string>>()

  const toNote = (meta: NoteMeta): WorkflowNote => toWorkflowNote(meta, bodies.get(meta.path))

  const readBody = (path: string): Promise<string> => {
    const existing = reads.get(path)
    if (existing) return existing
    const read = opts.readBody(path).then((body) => {
      bodies.set(path, body)
      return body
    })
    reads.set(path, read)
    return read
  }

  const { current, selection } = opts
  return {
    listNotes: async () => opts.notes.map((meta) => toNote(meta)),
    readBody,
    ...(current
      ? {
          current: (): WorkflowNote | null => {
            const meta = current()
            return meta ? toNote(meta) : null
          }
        }
      : {}),
    ...(selection ? { selection: (): WorkflowNote[] => selection().map((meta) => toNote(meta)) } : {})
  }
}
