/**
 * Standard-Markdown links to other notes — `[text](path/to/Note.md)` — should
 * navigate the same way `[[wikilinks]]` do (#201). Unlike a wikilink (resolved
 * by global note name), a Markdown link's href is a path resolved RELATIVE to
 * the note that contains it, exactly like Markdown / Obsidian's "Markdown
 * links" mode. This module holds the pure resolution so the editor (`gd`,
 * Cmd/Ctrl-click) and the rendered preview can all share it.
 */

export interface InternalNoteLink {
  /** Vault-relative path of the resolved note. */
  path: string
  /** The raw fragment carried by the link, or null: heading text for
   *  `Note.md#Heading`, `^id` for the Obsidian block form `Note.md#^id`.
   *  Callers hand it to `openWikilinkTarget` (as `#<anchor>`) so the anchor
   *  KIND is decided in one place, not per click surface. (#601) */
  anchor: string | null
}

interface NoteRef {
  path: string
  folder?: string
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return a.endsWith('/') ? `${a}${b}` : `${a}/${b}`
}

function posixNormalize(input: string): string {
  const out: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0 || out[out.length - 1] === '..') out.push('..')
      else out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

const lc = (s: string): string => s.toLowerCase()

/** External / non-note targets we must leave to their existing handlers. */
function isExternalHref(href: string): boolean {
  return (
    href.startsWith('#') || // same-note anchor
    href.startsWith('//') || // protocol-relative URL
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href) // scheme: http:, mailto:, zen-asset:, …
  )
}

function matchNote(notes: NoteRef[], target: string): string | null {
  const visible = notes.filter((n) => n.folder !== 'trash')
  // Markdown links usually carry the `.md`; tolerate links that omit it.
  const candidates = /\.md$/i.test(target) ? [target] : [`${target}.md`, target]
  for (const cand of candidates) {
    const exact = visible.find((n) => lc(n.path) === lc(cand))
    if (exact) return exact.path
  }
  // Basename fallback for a single unambiguous match — tolerates a link
  // written before the note moved, mirroring wikilink path-suffix resolution.
  const wantBase = lc(candidates[0].split('/').pop() ?? '')
  if (!wantBase) return null
  const baseMatches = visible.filter((n) => lc(n.path.split('/').pop() ?? '') === wantBase)
  return baseMatches.length === 1 ? baseMatches[0].path : null
}

/**
 * Resolve a Markdown link href to an internal note, relative to `notePath`.
 * Returns null for external links, in-page anchors, assets, or no match.
 */
export function resolveInternalNoteHref(
  notePath: string | null | undefined,
  href: string,
  notes: NoteRef[]
): InternalNoteLink | null {
  if (!notePath) return null
  const raw = href.trim()
  if (!raw || isExternalHref(raw)) return null

  const hashIdx = raw.indexOf('#')
  const rawPath = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw
  if (!rawPath) return null // pure "#heading" — same note, handled elsewhere
  const anchor = hashIdx >= 0 ? decode(raw.slice(hashIdx + 1)).trim() || null : null

  const decoded = decode(rawPath)
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  let target = decoded.startsWith('/')
    ? decoded.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decoded)
      : decoded
  target = posixNormalize(target)
  if (!target || target === '..' || target.startsWith('../')) return null

  const match = matchNote(notes, target)
  return match ? { path: match, anchor } : null
}

function unwrapMdUrl(url: string): string {
  // A destination may end in a title (`x.png "x.png"`, as Zettlr writes);
  // the title is not part of the path (#199).
  const trimmed = url.trim().replace(/\s+(?:"[^"]*"|'[^']*')$/, '')
  // Markdown wraps URLs containing spaces in angle brackets: `[x](<a b.pdf>)`.
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed.slice(1, -1)
  return trimmed
}

const LOCAL_FILE_EXT_RE =
  /\.(md|markdown|txt|png|apng|avif|gif|jpe?g|svg|webp|pdf|mp3|m4a|aac|flac|ogg|wav|mp4|m4v|mov|ogv|webm|canvas|excalidraw)$/i

// A Planner item reference: `dp<version>:<kind>:<token>`, e.g.
// `dp1:r:iuLcj68P6TCKRthO`. Planner mints and resolves these itself; ZenNotes
// only needs to recognize the shape, never interpret it. The version and kind
// segments are left open-ended (not pinned to `dp1`/`e`/`r`) so a future
// Planner format revision keeps matching without a ZenNotes code change.
const PLANNER_ITEM_REF_RE = /^dp\d+:[a-z]:[A-Za-z0-9_-]{8,}$/

/** Return a URL under the configured Planner base, or null for ordinary links. */
export function plannerLinkUrl(
  href: string,
  plannerBaseUrl: string | null | undefined
): string | null {
  const raw = (href ?? '').trim()
  const base = (plannerBaseUrl ?? '').trim()
  if (!raw || !base || raw.includes(' ')) return null
  try {
    const target = new URL(raw)
    const baseUrl = new URL(base)
    const basePath = baseUrl.pathname.replace(/\/+$/, '') || '/'

    // `/open/<ref>` links carry a portable item reference rather than a
    // location. The URL text in a note is whatever host (or even scheme)
    // Planner happened to use when the link was written (a dev port, an old
    // domain, `http:` swapped for a future `planner:` scheme), so match on
    // the reference shape alone and rebuild the link against the *current*
    // Planner URL instead of requiring the origin to still match.
    //
    // Deliberately not requiring the segment right before the reference to
    // literally be "open": for a non-special scheme written with `//`
    // (`planner://open/dp1:r:…`), the URL parser treats "open" as the host,
    // not a path segment — `target.pathname` is just `/dp1:r:…` — so pinning
    // this to a specific preceding segment would silently stop matching on a
    // scheme change alone. The reference token itself (versioned, fixed
    // charset, 8+ chars) is specific enough that matching on it anywhere at
    // the end of the path carries effectively no extra collision risk.
    const ref = target.pathname.split('/').at(-1) ?? ''
    if (PLANNER_ITEM_REF_RE.test(ref)) {
      const openBase = basePath === '/' ? '' : basePath
      return `${baseUrl.origin}${openBase}/open/${ref}${target.search}${target.hash}`
    }

    const pathMatches = basePath === '/' || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
    if (target.origin !== baseUrl.origin || !pathMatches) return null
    return target.toString()
  } catch {
    return null
  }
}

export function externalLinkUrl(href: string): string | null {
  const h = href.trim()
  if (!h) return null
  if (/^(https?:|mailto:|tel:)/i.test(h)) return h
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(h)) return null // another scheme — not ours
  if (h.startsWith('#') || h.startsWith('/') || h.startsWith('.') || h.startsWith('//')) return null
  // Bare domain heuristic: `host.tld` (one or more labels) optionally followed
  // by a /path, ?query, or #fragment — but not something that looks like a
  // local note/asset file.
  const host = h.split(/[/?#]/)[0] ?? ''
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return null
  if (LOCAL_FILE_EXT_RE.test(host)) return null
  return `https://${h}`
}

/**
 * The link at a document offset — a `[[wikilink]]` name, a Markdown link's
 * URL, or a bare URL — with its full source range in `doc` offsets. The range
 * lets pointer-driven callers confirm the mouse actually sits on the link's
 * rendered glyphs: a position alone cannot tell "on the link" from "clamped to
 * the link", which is how blank space beside a line once hovered and followed
 * a line-ending link (#587). Returns null when the offset isn't inside a link.
 */
export function linkRangeAtCursor(
  doc: string,
  pos: number
): { target: string; from: number; to: number } | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart
  const hit = (m: RegExpExecArray, target: string) =>
    col >= m.index && col < m.index + m[0].length
      ? { target, from: lineStart + m.index, to: lineStart + m.index + m[0].length }
      : null
  const wikiRe = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/g
  let m: RegExpExecArray | null
  while ((m = wikiRe.exec(line)) !== null) {
    const found = hit(m, m[1])
    if (found) return found
  }
  // Angle-bracketed URLs can contain `)` so match them specifically first.
  const mdAngleRe = /\[([^\]]*)\]\(<([^>]+)>\)/g
  while ((m = mdAngleRe.exec(line)) !== null) {
    const found = hit(m, m[2])
    if (found) return found
  }
  const mdRe = /\[([^\]]*)\]\(([^)]+)\)/g
  while ((m = mdRe.exec(line)) !== null) {
    const found = hit(m, unwrapMdUrl(m[2]))
    if (found) return found
  }
  // CommonMark's bare autolink — `<scheme:...>` — with no `[label]` in front.
  // Unlike the bare-URL fallback below, the scheme isn't restricted to
  // http(s): the angle brackets are themselves the explicit "this is a link"
  // marker, so any `scheme:` (mailto:, tel:, a future planner:, …) counts.
  const autolinkRe = /<([a-zA-Z][a-zA-Z\d+.-]{1,31}:[^\s<>]*)>/g
  while ((m = autolinkRe.exec(line)) !== null) {
    const found = hit(m, m[1])
    if (found) return found
  }
  const urlRe = /https?:\/\/[^\s)>\]]+/g
  while ((m = urlRe.exec(line)) !== null) {
    const found = hit(m, m[0])
    if (found) return found
  }
  return null
}

/**
 * The link target at a document offset — a `[[wikilink]]` name, a Markdown
 * link's URL, or a bare URL. Returns null when the offset isn't inside a link.
 */
export function extractLinkAtCursor(doc: string, pos: number): string | null {
  return linkRangeAtCursor(doc, pos)?.target ?? null
}

/**
 * The Markdown link `[label](href)` covering a document offset, with its full
 * source range. Used to follow a *rendered* link on a plain click (when the
 * selection is outside the range) while still allowing edits when the cursor is
 * inside it — mirroring how `[[wikilinks]]` behave in the editor. (#201)
 */
export function markdownLinkAt(
  doc: string,
  pos: number
): { href: string; from: number; to: number } | null {
  const lineStart = doc.lastIndexOf('\n', pos - 1) + 1
  const lineEnd = doc.indexOf('\n', pos)
  const line = doc.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
  const col = pos - lineStart
  const angleRe = /\[[^\]]*\]\(<([^>]+)>\)/g
  let m: RegExpExecArray | null
  while ((m = angleRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { href: m[1], from: lineStart + m.index, to: lineStart + m.index + m[0].length }
    }
  }
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  while ((m = re.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { href: unwrapMdUrl(m[1]), from: lineStart + m.index, to: lineStart + m.index + m[0].length }
    }
  }
  // CommonMark's bare autolink — `<scheme:...>` — with no `[label]` in front.
  // Live preview hides the `<>` the same way it hides `(url)` for a normal
  // link, so a plain click here follows the same "outside it, so its syntax
  // is hidden" rule as the patterns above.
  const autolinkRe = /<([a-zA-Z][a-zA-Z\d+.-]{1,31}:[^\s<>]*)>/g
  while ((m = autolinkRe.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) {
      return { href: m[1], from: lineStart + m.index, to: lineStart + m.index + m[0].length }
    }
  }
  return null
}
