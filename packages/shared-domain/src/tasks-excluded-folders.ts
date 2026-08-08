// The vault-level "exclude this folder from Tasks" list (#458). Stored in
// `.zennotes/vault.json` under `tasks.excludedFolders` as vault-relative
// directory paths exactly as they exist on disk, so remapped system folders
// (#115) need no translation: every scanner matches against a note's real
// relative path. Desktop main, the MCP server, and the iPhone bridge all
// import these helpers; the Go server mirrors them in
// internal/vault/tasks_exclude.go: change both together and keep the rules
// byte-compatible.

/** Validate one excluded-folder entry: forward slashes, no empty or dot
 *  segments, no traversal. Returns the cleaned path or null when invalid. */
export function normalizeTasksExcludedFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const parts: string[] = []
  for (const seg of value.replace(/\\/g, '/').split('/')) {
    const s = seg.trim()
    if (!s) continue
    if (s === '.' || s === '..') return null
    parts.push(s)
  }
  if (parts.length === 0) return null
  const joined = parts.join('/')
  return joined.length > 512 ? null : joined
}

/** Normalize the whole list: invalid entries drop, duplicates collapse,
 *  order is preserved. Never throws; a malformed vault.json value yields []. */
export function normalizeTasksExcludedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const cleaned = normalizeTasksExcludedFolder(entry)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

/** Whether a vault-relative POSIX path lives inside any excluded folder.
 *  Segment-prefix match, case-sensitive like the rest of the vault layer:
 *  `inbox/Books` excludes `inbox/Books/x.md` and `inbox/Books/sub/y.md`,
 *  never `inbox/Bookshelf.md`. */
export function isPathExcludedFromTasks(
  relPath: string,
  excluded: readonly string[]
): boolean {
  for (const folder of excluded) {
    if (relPath === folder || relPath.startsWith(folder + '/')) return true
  }
  return false
}
