import type { NoteFolder } from '@zennotes/bridge-contract/ipc'

export type SystemFolderPaths = Partial<Record<NoteFolder, string>>

export const DEFAULT_FOLDER_PATHS: Record<NoteFolder, string> = {
  inbox: 'inbox',
  quick: 'quick',
  archive: 'archive',
  trash: 'trash'
}

const FOLDER_IDS: NoteFolder[] = ['inbox', 'quick', 'archive', 'trash']

const MAX_PATH_LENGTH = 128

const RESERVED_ROOT_NAMES = new Set([
  'assets',
  '.zennotes',
  'attachements',
  '_assets',
  'deleted-assets',
  'comments'
])

const INVALID_CHARS_RE = /[\\:*?"<>|#^\[\]<>]/

function normalizeSystemFolderPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > MAX_PATH_LENGTH) return null
  if (trimmed.includes('/') || trimmed.includes('\\')) return null
  if (trimmed.startsWith('/')) return null
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null
  if (INVALID_CHARS_RE.test(trimmed)) return null
  return trimmed
}

export function normalizeSystemFolderPaths(
  value: unknown
): SystemFolderPaths {
  if (!value || typeof value !== 'object') return {}
  const raw = value as Partial<Record<NoteFolder, unknown>>
  const next: SystemFolderPaths = {}
  for (const key of FOLDER_IDS) {
    const p = normalizeSystemFolderPath(raw[key])
    if (!p || p === DEFAULT_FOLDER_PATHS[key]) continue
    // Never let a folder claim ANOTHER folder's default name, even when that
    // other folder has moved out of the way: `{inbox:'archive',
    // archive:'inbox'}` resolves without collision, and the swap it describes
    // reads backwards on every surface that classifies a path by its top
    // segment (and in every other app looking at the same directory).
    if (FOLDER_IDS.some((other) => other !== key && p.toLowerCase() === DEFAULT_FOLDER_PATHS[other])) {
      continue
    }
    next[key] = p
  }
  let changed = true
  while (changed) {
    changed = false
    for (const key of FOLDER_IDS) {
      if (!next[key]) continue
      const resolved = resolveFolderPath(key, next)
      const lower = resolved.toLowerCase()
      if (RESERVED_ROOT_NAMES.has(lower)) {
        delete next[key]
        changed = true
        continue
      }
      for (const other of FOLDER_IDS) {
        if (other === key) continue
        const otherResolved = resolveFolderPath(other, next).toLowerCase()
        if (lower === otherResolved) {
          delete next[key]
          changed = true
          break
        }
      }
    }
  }
  return next
}

export function resolveFolderPath(
  folder: NoteFolder,
  overrides?: SystemFolderPaths | null
): string {
  return overrides?.[folder] ?? DEFAULT_FOLDER_PATHS[folder]
}

/**
 * The system folder that owns a top-level directory name, or null when the
 * name belongs to no system folder (an ordinary user folder, an assets dir,
 * anything else).
 *
 * This is THE classification rule for a path's first segment: every surface
 * that asks "is this inbox/quick/archive/trash?" must go through it, because
 * only the RESOLVED name of each folder counts. With `inbox` remapped to
 * `01 - Entry`, `01 - Entry/` is the inbox and a directory literally named
 * `inbox/` is just a user folder. Treating the default name as the system
 * folder anyway is how listings (which walk the remapped directory) and
 * classification (which read the literal one) came to disagree about the same
 * vault. Case-insensitive, since macOS and Windows preserve whatever case the
 * directory was created with.
 */
export function systemFolderForDirName(
  name: string,
  overrides?: SystemFolderPaths | null
): NoteFolder | null {
  const lower = name.toLowerCase()
  for (const folder of FOLDER_IDS) {
    if (resolveFolderPath(folder, overrides).toLowerCase() === lower) return folder
  }
  return null
}

export function buildReverseFolderMap(
  overrides?: SystemFolderPaths | null
): Map<string, NoteFolder> {
  const map = new Map<string, NoteFolder>()
  for (const folder of FOLDER_IDS) {
    const p = resolveFolderPath(folder, overrides)
    if (p !== DEFAULT_FOLDER_PATHS[folder]) {
      map.set(p.toLowerCase(), folder)
    }
  }
  return map
}
