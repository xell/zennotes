import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKDOWN_FILE_EXTENSIONS = ['.md', '.markdown'] as const

export function isMarkdownFilePath(candidate: string): boolean {
  const trimmed = candidate.trim()
  if (!trimmed) return false
  const ext = path.extname(trimmed).toLowerCase()
  return (MARKDOWN_FILE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Vault-relative, POSIX-separated note path for `absPath`, or null when
 * `absPath` is not strictly inside `vaultRoot`. Notes are addressed
 * relative to a vault root everywhere in the app, so this is how an
 * absolute file from the OS gets mapped onto an open vault.
 */
export function vaultRelativeNotePath(vaultRoot: string, absPath: string): string | null {
  const root = path.resolve(vaultRoot)
  const target = path.resolve(absPath)
  if (target === root) return null
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const segments = rel.split(path.sep)
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

export type MarkdownOpenTarget =
  | { kind: 'vault'; vaultRoot: string; relPath: string }
  | { kind: 'external'; absPath: string }

/**
 * Decide how to open a markdown file: as a note inside the most
 * specific known vault that already contains it, or as a standalone
 * external file when it lives outside every known vault.
 */
export function resolveMarkdownOpenTarget(
  absPath: string,
  knownVaultRoots: readonly string[]
): MarkdownOpenTarget {
  const target = path.resolve(absPath)
  let best: { root: string; rel: string } | null = null
  for (const candidate of knownVaultRoots) {
    const rel = vaultRelativeNotePath(candidate, target)
    if (!rel) continue
    const resolvedRoot = path.resolve(candidate)
    // Prefer the deepest matching vault so a note inside a nested vault
    // opens against that vault rather than an ancestor.
    if (!best || resolvedRoot.length > best.root.length) {
      best = { root: resolvedRoot, rel }
    }
  }
  if (best) return { kind: 'vault', vaultRoot: best.root, relPath: best.rel }
  return { kind: 'external', absPath: target }
}

/**
 * Pull candidate markdown file paths out of a process argv array. Used
 * for Windows/Linux file-association launches (and `second-instance`
 * relaunches), where the path arrives as a CLI argument rather than the
 * macOS `open-file` event. Skips the executable entry, flags, and
 * `zennotes:` deep links handled elsewhere.
 */
export function markdownPathsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    let candidate = arg
    if (arg.includes('://')) {
      // Same file:// decoding as `candidatePathsFromArgv`: a Linux file
      // manager's `%U` hand-off wraps the path in a URL.
      const decoded = pathFromFileUrl(arg)
      if (!decoded) continue
      candidate = decoded
    }
    if (!isMarkdownFilePath(candidate)) continue
    out.push(candidate)
  }
  return out
}

/**
 * Like {@link markdownPathsFromArgv} but keeps non-markdown path args too, so a
 * directory can be opened as a temporary folder session (drag a folder onto the
 * app / `zn open <dir>`). The caller stats each path to decide what to do: a
 * markdown file opens a note, a directory opens a temporary session, and
 * anything else (e.g. the launcher's own script path) is ignored.
 */
export function candidatePathsFromArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg || arg.startsWith('-')) continue
    if (arg.includes('://')) {
      // Linux file managers launch us through the .desktop's `Exec=… %U`,
      // which hands paths over as file:// URLs. Dropping those made "Open
      // with ZenNotes" on a folder a silent no-op; decode them instead.
      // Other schemes (zennotes:// deep links) stay with their own handler.
      const decoded = pathFromFileUrl(arg)
      if (decoded) out.push(decoded)
      continue
    }
    out.push(arg)
  }
  return out
}

/** `file:///a/b` → `/a/b`, or null for anything malformed or non-file. */
function pathFromFileUrl(arg: string): string | null {
  if (!arg.startsWith('file://')) return null
  // A bare `file://` decodes to `/` rather than throwing, and nothing that
  // hands us a URL means "open the filesystem root by default".
  if (arg.length <= 'file://'.length) return null
  try {
    return fileURLToPath(arg)
  } catch {
    return null
  }
}
