/**
 * Pure visible-set computation for the sidebar's incremental filter.
 *
 * The filter never builds its own flat result list. Instead it computes which
 * existing tree rows should stay rendered while a query is active; `Sidebar`'s
 * `SubTree` then prunes non-visible entries *after* the normal ordering
 * (including manual order) has already run. That keeps current sort order,
 * indentation, and manual order intact for free — the filter is a prune pass,
 * not a re-sort.
 *
 * Visibility rules (strict folder rule, per decision 2):
 *   - a note is visible iff its title matches
 *   - an asset is visible iff its filename (last path segment) matches
 *   - a folder is visible iff its own name matches OR it contains a visible
 *     descendant. A folder visible only by its own name renders as a bare row:
 *     its children are pruned individually, so nothing is revealed inside it.
 *
 * Operates on a minimal structural shape so it stays decoupled from
 * `Sidebar.tsx`'s `TreeNode` (which is structurally assignable) and testable
 * without any DOM.
 */
import { scoreMatch } from './fuzzy-score'

export interface FilterTreeNode {
  name: string
  /** Vault-relative folder subpath within one top-level tree ('' for root). */
  subpath: string
  notes: readonly { path: string; title: string }[]
  assets: readonly { path: string }[]
  children: readonly FilterTreeNode[]
}

export interface SidebarFilterVisibility {
  /** Note & asset paths (globally unique — they include the top-level folder). */
  leaves: Set<string>
  /** Folder subpaths to render within this tree (root '' is never included).
   *  Includes ancestor folders kept only to preserve hierarchy, so this is a
   *  superset of the folders that actually match — use `matchedFolders` to
   *  count matches. */
  folderSubpaths: Set<string>
  /** Subpaths of folders whose *own name* matches the query (the bare-row
   *  matches). A subset of `folderSubpaths` that excludes ancestors shown only
   *  for context — this is what a match count should add to the leaf count. */
  matchedFolders: Set<string>
}

/**
 * How the query text is matched against a row's label:
 *  - `substring`: plain contiguous, case-insensitive `includes` — the default,
 *    a precise "part match", which is what you want most of the time.
 *  - `fuzzy`: subsequence match (`ae` hits `a…e`), opted into with a leading
 *    space in the query. Looser, so it surfaces more — reserved for when the
 *    exact spelling is fuzzy in your head.
 */
export type SidebarFilterMode = 'substring' | 'fuzzy'

/** Decide the match mode from the *raw* (untrimmed) query: a deliberate leading
 *  space means fuzzy. Callers must check this before trimming — trimming would
 *  erase the signal. */
export function filterModeForQuery(rawQuery: string): SidebarFilterMode {
  return /^\s/.test(rawQuery) ? 'fuzzy' : 'substring'
}

/** True if `text` matches `query` under `mode`. Compared case-insensitively;
 *  `query` is expected already trimmed. Fuzzy uses the scorer only as a
 *  predicate (never as a ranker — results keep the tree's sort order). */
export function matchesQuery(
  query: string,
  text: string,
  mode: SidebarFilterMode = 'substring'
): boolean {
  if (!query) return true
  if (mode === 'fuzzy') return scoreMatch(query, text) > 0
  return text.toLowerCase().includes(query.toLowerCase())
}

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * Walk one top-level tree and collect every leaf path and folder subpath that
 * should stay visible for `query` under `mode`. Callers pass a non-empty
 * (already trimmed or trimmable) query; an empty query means "no filter" and
 * should short-circuit before reaching here.
 */
export function computeTreeVisibility(
  root: FilterTreeNode,
  query: string,
  mode: SidebarFilterMode = 'substring'
): SidebarFilterVisibility {
  const leaves = new Set<string>()
  const folderSubpaths = new Set<string>()
  const matchedFolders = new Set<string>()
  const q = query.trim()
  if (!q) return { leaves, folderSubpaths, matchedFolders }

  // Returns whether `node` should be visible (self matches or has a visible
  // descendant). Folder membership is recorded as a side effect on the way up.
  const walk = (node: FilterTreeNode, isRoot: boolean): boolean => {
    let hasVisibleDescendant = false

    for (const note of node.notes) {
      if (matchesQuery(q, note.title, mode)) {
        leaves.add(note.path)
        hasVisibleDescendant = true
      }
    }
    for (const asset of node.assets) {
      if (matchesQuery(q, basename(asset.path), mode)) {
        leaves.add(asset.path)
        hasVisibleDescendant = true
      }
    }
    for (const child of node.children) {
      // Don't short-circuit: every branch must be walked so all matching
      // leaves across the subtree are collected, not just the first.
      if (walk(child, false)) hasVisibleDescendant = true
    }

    const selfMatches = !isRoot && matchesQuery(q, node.name, mode)
    const visible = hasVisibleDescendant || selfMatches
    if (!isRoot && visible) folderSubpaths.add(node.subpath)
    if (selfMatches) matchedFolders.add(node.subpath)
    return visible
  }

  walk(root, true)
  return { leaves, folderSubpaths, matchedFolders }
}
