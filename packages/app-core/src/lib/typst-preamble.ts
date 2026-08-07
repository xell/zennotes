/**
 * Tag-driven Typst preambles (#486).
 *
 * Different subjects want the same notation to mean different things: a vector
 * is an arrow in physics and bold in maths. Rather than redefine `vec()` at the
 * top of every note, a note's **tags** select which Typst definitions get
 * prepended to its formulas.
 *
 * A preamble is an ordinary note whose title is a dotted tag path, stored in a
 * folder named `typst`:
 *
 *   inbox/typst/physics.md            → applies to `#physics` and anything under it
 *   inbox/typst/physics.mechanics.md  → applies to `#physics/mechanics`
 *
 * Keeping them as notes (rather than a hidden `.typst` directory) means they
 * sync, are editable in the app, are searchable, and work over a remote vault
 * with no new file APIs — the vault already knows how to read a note.
 *
 * Resolution for a note tagged `#physics/mechanics`:
 *   1. walk the tag from its root: `physics`, then `physics.mechanics`
 *   2. concatenate the bodies of whichever exist, general → specific, so a
 *      narrower tag redefines what a broader one set
 *   3. with several tags on the note, take them in alphabetical order, so two
 *      notes carrying the same tags always compile identically
 *
 * The result is prepended to every formula in that note, and takes part in the
 * render cache key — without that, `$vec(x)$` in a physics note and in a maths
 * note would collide on the shared (source, display) key and one of them would
 * silently render with the other's definitions.
 */

/** A preamble note: its dotted tag path and its Typst source. */
export interface TypstPreambleNote {
  /** Dotted tag path from the note title, e.g. `physics.mechanics`. */
  key: string
  /** The note body, used verbatim as Typst source. */
  body: string
}

/** Folder name that marks preamble notes, at any depth in the vault. */
export const TYPST_PREAMBLE_FOLDER = 'typst'

/**
 * True when `path` sits in a folder named `typst`, e.g.
 * `inbox/typst/physics.md` or `archive/notes/typst/maths.md`.
 */
export function isTypstPreamblePath(path: string): boolean {
  const parts = path.split('/')
  // The last part is the file itself, so look for the folder among the parents.
  return parts.slice(0, -1).some((part) => part.toLowerCase() === TYPST_PREAMBLE_FOLDER)
}

/** The dotted key a preamble note is addressed by — its title, lower-cased. */
export function preambleKeyFromTitle(title: string): string {
  return title.trim().toLowerCase()
}

/**
 * Every preamble key a tag pulls in, from the broadest to the most specific:
 * `physics/mechanics` → `['physics', 'physics.mechanics']`. Tags are matched
 * case-insensitively, matching how the rest of the app treats them.
 */
export function preambleKeysForTag(tag: string): string[] {
  const segments = tag
    .toLowerCase()
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
  const keys: string[] = []
  for (let i = 0; i < segments.length; i++) {
    keys.push(segments.slice(0, i + 1).join('.'))
  }
  return keys
}

/**
 * Assemble the Typst source that should precede every formula in a note with
 * `tags`, or `''` when no preamble applies.
 *
 * Each preamble is included at most once even when several tags reach it (a
 * note tagged both `#physics` and `#physics/mechanics` gets `physics` once),
 * because Typst would reject a duplicate `let` binding.
 */
export function resolveTypstPreamble(
  tags: readonly string[],
  preambles: readonly TypstPreambleNote[]
): string {
  if (tags.length === 0 || preambles.length === 0) return ''
  const byKey = new Map<string, string>()
  for (const preamble of preambles) {
    // First writer wins, so a duplicate title elsewhere in the vault can't
    // quietly shadow the one already found.
    if (!byKey.has(preamble.key)) byKey.set(preamble.key, preamble.body)
  }

  const ordered = [...tags].sort((a, b) => a.localeCompare(b))
  const used = new Set<string>()
  const parts: string[] = []
  for (const tag of ordered) {
    for (const key of preambleKeysForTag(tag)) {
      if (used.has(key)) continue
      const body = byKey.get(key)
      if (body === undefined) continue
      used.add(key)
      const trimmed = body.trim()
      if (trimmed) parts.push(trimmed)
    }
  }
  return parts.join('\n')
}
