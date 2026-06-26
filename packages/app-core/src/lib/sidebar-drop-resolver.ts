/**
 * Pure drop-target resolver for free manual reordering in the sidebar tree
 * (Phase 2 of the #224 follow-up). Turns a pointer position over a flattened,
 * variably-indented row list into a concrete `(parentDir, before sibling)` plus
 * an indent level for the drop-line indicator, applying the structural rules:
 * notes are never parents, and a folder can't land inside its own subtree.
 *
 * The geometry (which gap, what raw depth) is computed by the caller from the
 * DOM; this module owns the structural resolution so it can be unit-tested.
 */

export interface FlatRow {
  /** Vault-relative identity: a note path, or a folder path. */
  path: string
  parentDir: string
  /** 0 = a direct child of the section root. */
  depth: number
  isFolder: boolean
  /** Folders only: whether currently expanded in the tree. */
  isExpanded: boolean
  hasChildren: boolean
}

export interface DropResolution {
  /** Parent directory the dragged item would land in. */
  parentDir: string
  /** Insert before this sibling path; null appends to the end of `parentDir`. */
  beforePath: string | null
  /** Indent level for the drop-line indicator. */
  depth: number
  /** Whether this is a legal drop target. */
  valid: boolean
}

export interface ResolveArgs {
  rows: readonly FlatRow[]
  /** Insertion gap: the item lands before rows[gapIndex] (0..rows.length). */
  gapIndex: number
  /** Raw depth from the horizontal pointer, before clamping to the legal band. */
  pointerDepth: number
  /** Vault-relative dir of the section root (parent of depth-0 rows). */
  sectionRootDir: string
  draggedPath: string
  draggedIsFolder: boolean
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n))

/** Parent dir for an item inserted at `depth` just below the gap. Walks up the
 *  rows above the gap to the nearest folder at `depth - 1`. */
function parentForDepth(
  rows: readonly FlatRow[],
  gapIndex: number,
  depth: number,
  sectionRootDir: string,
): string {
  if (depth <= 0) return sectionRootDir
  for (let i = gapIndex - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.depth === depth - 1) return r.isFolder ? r.path : sectionRootDir
    if (r.depth < depth - 1) break
  }
  return sectionRootDir
}

export function resolveDropTarget({
  rows,
  gapIndex,
  pointerDepth,
  sectionRootDir,
  draggedPath,
  draggedIsFolder,
}: ResolveArgs): DropResolution {
  const above = gapIndex > 0 ? rows[gapIndex - 1] : undefined
  const below = gapIndex < rows.length ? rows[gapIndex] : undefined

  // Legal depth band at this gap: as deep as a child of `above` (only if it's a
  // folder, since notes can't be parents), as shallow as `below`'s level.
  const maxDepth = above ? (above.isFolder ? above.depth + 1 : above.depth) : 0
  const minDepth = below ? below.depth : 0
  const depth = clamp(
    pointerDepth,
    Math.min(minDepth, maxDepth),
    Math.max(minDepth, maxDepth),
  )

  let parentDir: string
  if (above && above.isFolder && depth === above.depth + 1) {
    parentDir = above.path // into `above` as its first child
  } else {
    parentDir = parentForDepth(rows, gapIndex, depth, sectionRootDir)
  }
  const beforePath =
    below && below.parentDir === parentDir ? below.path : null

  // A folder may not land inside its own subtree (or onto itself).
  let valid = true
  if (
    draggedIsFolder &&
    (parentDir === draggedPath || parentDir.startsWith(`${draggedPath}/`))
  ) {
    valid = false
  }

  return { parentDir, beforePath, depth, valid }
}
