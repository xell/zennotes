/**
 * Pure helpers for manual (drag-to-reorder) note ordering (#224). The custom
 * order is stored per folder, keyed by the parent directory, as an ordered list
 * of item paths (notes *and* folders share the same key space). Items not present
 * in the list fall back to their file order (`siblingOrder`), so newly added
 * items append predictably.
 */
import { naturalCompare } from './natural-sort'

/** A note or folder participating in a folder's manual order. `path` is its
 *  vault-relative identity (note path, or `vaultRelativeFolderPath`). */
export interface ManualOrderItem {
  path: string
  kind: 'folder' | 'note'
  /** Folder display name, used to keep unlisted folders in natural order. */
  name: string
  siblingOrder: number
}

/** The directory portion of a vault-relative note path (`''` for the root). */
export function parentDirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** True when two note paths live in the same folder (are reorder siblings). */
export function sameFolder(a: string, b: string): boolean {
  return parentDirOf(a) === parentDirOf(b)
}

/**
 * Move `dragged` to just before/after `target` within `ordered`. Returns a new
 * array; a no-op (same array values) if `target` isn't present.
 */
export function applyManualMove(
  ordered: readonly string[],
  dragged: string,
  target: string,
  position: 'before' | 'after'
): string[] {
  const without = ordered.filter((p) => p !== dragged)
  const idx = without.indexOf(target)
  if (idx === -1) return [...ordered]
  without.splice(position === 'before' ? idx : idx + 1, 0, dragged)
  return without
}

/**
 * Compare two sibling notes for a folder's manual order. Notes listed in
 * `order` sort first by their index; the rest follow by `siblingOrder`. A total
 * order, so `Array.sort` is stable.
 */
export function manualOrderCompare(
  order: readonly string[] | undefined,
  aPath: string,
  aSibling: number,
  bPath: string,
  bSibling: number
): number {
  const ia = order ? order.indexOf(aPath) : -1
  const ib = order ? order.indexOf(bPath) : -1
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  return aSibling - bSibling
}

/**
 * Compare two sibling items (notes or folders) for a folder's manual order.
 * Listed items sort first by their index in `order`. Unlisted items keep the
 * pre-manual look: folders before notes, folders in natural name order, notes in
 * file order. A total order, so `Array.sort` is stable.
 */
export function manualItemCompare(
  order: readonly string[] | undefined,
  a: ManualOrderItem,
  b: ManualOrderItem
): number {
  const ia = order ? order.indexOf(a.path) : -1
  const ib = order ? order.indexOf(b.path) : -1
  if (ia !== -1 && ib !== -1) return ia - ib
  if (ia !== -1) return -1
  if (ib !== -1) return 1
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  if (a.kind === 'folder') return naturalCompare(a.name, b.name)
  return a.siblingOrder - b.siblingOrder
}
