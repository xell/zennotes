// Where a path op puts a note, shared between the engine and the applier.
//
// The engine plans against a snapshot and must promise downstream steps a
// destination; the desktop applier performs the move and must land the file
// exactly where the plan promised (diverging only for a collision, which it
// then reports as a redirect). One copy of the target arithmetic is what keeps
// those two promises the same promise, exactly as `apply-ops` does for content
// transforms. Everything here is pure string work on vault-relative posix
// paths: no I/O, no platform separators.

/** What a workflow is allowed to write. */
export const NOTE_EXTENSIONS = ['.md', '.excalidraw']

/** Top-level folders that are containers rather than part of a note's subpath. */
export const FOLDER_ROOTS = new Set(['inbox', 'quick', 'archive', 'trash'])

/** The app's own directory: workflows, templates, settings, run ledgers. */
const INTERNAL_DIR = '.zennotes'

/** Vault-relative paths are posix in the plan, so they are compared as posix. */
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Why a workflow may not put anything at this vault-relative location, or null
 * when it may.
 *
 * The desktop applier refuses the same shapes immediately before it touches the
 * filesystem (`resolveVaultPath`), and it keeps doing so, because a plan can
 * also arrive over IPC from somewhere this code never ran. This copy is the one
 * a DRY RUN gets to see: `move "../../escape"` used to reach the canvas with no
 * diagnostic at all, so the preview drew an ordinary move and only the failed
 * run told the author otherwise. It is also the copy a Go runtime mirroring this
 * layer would inherit, which the applier's is not.
 *
 * An empty location passes here, because the empty folder is the vault root and
 * that is a real place to put a note. `notePathProblem` is the one that refuses
 * an empty path, since a note with no name is not.
 */
export function folderPathProblem(rel: string): string | null {
  // Asked before normalising, which would quietly turn `/etc/passwd.md` into a
  // vault-relative path and hide the fact that an absolute one was written.
  // Drive letters count too, so a workflow authored on Windows is refused on a
  // Mac rather than reinterpreted.
  if (/^[/\\]/.test(rel) || /^[A-Za-z]:/.test(rel)) return 'a path may not be absolute'
  const segments = normalizeRel(rel).split('/')
  if (segments.includes('..')) return 'a path may not climb out of the vault'
  if ((segments[0] ?? '').toLowerCase() === INTERNAL_DIR) {
    return `a path may not be inside ${INTERNAL_DIR}`
  }
  return null
}

/** Why a workflow may not write a note at this vault-relative path, or null
 *  when it may. `folderPathProblem` plus the two things a file has and a folder
 *  does not: a name, and a type this app can open. */
export function notePathProblem(rel: string): string | null {
  const problem = folderPathProblem(rel)
  if (problem) return problem
  const clean = normalizeRel(rel).trim()
  if (!clean) return 'a path may not be empty'
  if (!noteExtensionOf(clean)) return `a note must end in ${NOTE_EXTENSIONS.join(' or ')}`
  return null
}

export function relDirname(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut === -1 ? '' : rel.slice(0, cut)
}

export function relBasename(rel: string): string {
  const cut = rel.lastIndexOf('/')
  return cut === -1 ? rel : rel.slice(cut + 1)
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/** `.md` or `.excalidraw`, lowercased, or '' when the name carries neither. */
export function noteExtensionOf(rel: string): string {
  const lower = relBasename(rel).toLowerCase()
  return NOTE_EXTENSIONS.find((ext) => lower.endsWith(ext)) ?? ''
}

export function stripNoteExtension(name: string): string {
  const ext = noteExtensionOf(name)
  return ext ? name.slice(0, name.length - ext.length) : name
}

/**
 * Where a `move` puts a note: same filename, new folder. `to` is a folder
 * because `rename` is the op that changes a name, which is the only reason
 * these are two ops and not one.
 */
export function moveTarget(rel: string, folder: string): string {
  return joinRel(normalizeRel(folder), relBasename(rel))
}

/**
 * Where a `rename` puts a note: same folder, new name, same file type, so a
 * renamed `.excalidraw` drawing is still a drawing. The pattern may already
 * carry an extension (`{{title}}.md`), which is dropped rather than doubled.
 */
export function renameTarget(rel: string, pattern: string): string {
  const name = stripNoteExtension(normalizeRel(pattern).trim())
  if (!name) throw new Error(`Workflow rename has an empty target for ${rel}`)
  const ext = noteExtensionOf(rel) || NOTE_EXTENSIONS[0]
  return joinRel(relDirname(rel), `${name}${ext}`)
}

/** Resolved on-disk names for remapped system folders; see PlanContext. */
export type SystemFolderDirs = Partial<Record<'inbox' | 'quick' | 'archive' | 'trash', string>>

/**
 * Where `archive` and `trash` put a note: the destination folder, with the
 * source's subfolder mirrored, so `inbox/demo/X.md` lands at `archive/demo/X.md`
 * and moving it back returns it to `demo/`. This mirrors `moveBetweenFolders`
 * in `vault.ts` without depending on the vault's caches or settings.
 *
 * `dirs` carries the vault's remapped system-folder names (vault.json
 * `systemFolderPaths`): the destination uses the remapped name so a workflow's
 * `trash` files into the directory the app actually treats as Trash, and the
 * remapped names also count as system roots when mirroring the subfolder.
 */
export function folderTarget(
  folder: 'archive' | 'trash',
  rel: string,
  dirs?: SystemFolderDirs
): string {
  const segments = normalizeRel(rel).split('/')
  const file = segments.pop() ?? ''
  const roots = new Set(FOLDER_ROOTS)
  if (dirs) {
    for (const dir of Object.values(dirs)) {
      if (dir) roots.add(dir.toLowerCase())
    }
  }
  if (segments.length > 0 && roots.has((segments[0] ?? '').toLowerCase())) segments.shift()
  return [dirs?.[folder] ?? folder, ...segments, file].join('/')
}
