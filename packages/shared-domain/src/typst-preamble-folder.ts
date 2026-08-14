// The vault-level Typst preamble folder (#486, configurable since #562).
// Stored in `.zennotes/vault.json` under `typstPreambles.folder` as a single
// directory NAME matched at any depth, so `inbox/typst/physics.md` and
// `archive/notes/typst/maths.md` are both preambles. A name rather than a
// vault-relative path because that is the shape the feature shipped with, and
// it means remapped system folders (#115) need no translation.
//
// Why it is configurable at all: a preamble note is Typst source, not prose.
// `#let vec(x) = bold(x)` and the `#var` references inside formulas are
// variables, and every tag scanner read them as hashtags, so a vault using the
// feature grew a tag list full of `let` and variable names (#562). Preambles
// are therefore left out of the tag index everywhere, which makes the folder
// name load-bearing: someone keeping ordinary notes in a folder they happen to
// have called `typst` can point the preamble folder somewhere else instead of
// losing their tags.
//
// Tags are the ONLY thing skipped. Preambles stay ordinary notes: they sync,
// they are searchable, they keep their excerpt and wikilinks, which is the
// property #486 chose them for. Tags never took part in resolving a preamble
// either way (a preamble is addressed by its title), so nothing is lost.
//
// Desktop main, the MCP server and the renderer import these helpers; the Go
// server mirrors them in internal/vault/typst_preamble.go. Change one, change
// both, and keep the validation rules byte-compatible.

/** Folder name used when the vault says nothing. */
export const DEFAULT_TYPST_PREAMBLE_FOLDER = 'typst'

const MAX_FOLDER_LENGTH = 128

// Same character rules as a system folder path (#115): one directory name, no
// separators, nothing that needs escaping on any platform we ship to.
const INVALID_CHARS_RE = /[\\/:*?"<>|#^[\]]/

/** Validate a configured folder name: exactly one directory segment, no
 *  traversal, no dotfiles. Returns the cleaned name, or null when the value is
 *  unusable and the caller should fall back to the default. */
export function normalizeTypstPreambleFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_FOLDER_LENGTH) return null
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('.')) return null
  if (INVALID_CHARS_RE.test(trimmed)) return null
  return trimmed
}

/** The folder name in effect, given `typstPreambles.folder` straight off
 *  vault.json. Never throws: anything malformed resolves to the default. */
export function resolveTypstPreambleFolder(value: unknown): string {
  return normalizeTypstPreambleFolder(value) ?? DEFAULT_TYPST_PREAMBLE_FOLDER
}

/**
 * Carry the Typst preamble settings through a vault.json round-trip. Returns
 * undefined for the default folder so an untouched vault.json never grows an
 * empty stub, matching how the Tasks settings normalize.
 */
export function normalizeTypstPreambleSettings(
  raw: unknown
): { folder: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const folder = normalizeTypstPreambleFolder((raw as { folder?: unknown }).folder)
  if (!folder || folder === DEFAULT_TYPST_PREAMBLE_FOLDER) return undefined
  return { folder }
}

/**
 * Whether a vault-relative POSIX path is a preamble note, i.e. sits in a
 * directory with the configured name at any depth. Case-insensitive, matching
 * how the rest of the preamble layer treats tags and titles.
 *
 * `folder` is required rather than defaulting: a caller that has not read the
 * vault's setting would silently classify against `typst` and disagree with
 * the scanners, which is exactly the drift this module exists to prevent.
 */
export function isTypstPreamblePath(path: string, folder: string): boolean {
  const name = folder.toLowerCase()
  if (!name) return false
  const parts = path.split('/')
  // The last part is the file itself, so look for the folder among the parents.
  return parts.slice(0, -1).some((part) => part.trim().toLowerCase() === name)
}
