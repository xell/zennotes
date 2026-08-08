/**
 * Keep a note's leading `# Heading` in step with its filename (#455).
 *
 * A new note is created as `# <title>` followed by an empty body, so the
 * heading and the filename start out identical. Renaming the file used to
 * leave the heading behind — every rename meant a second, manual edit of
 * line one. With the "Sync title heading on rename" setting on, a rename
 * rewrites that heading too.
 *
 * The rule is deliberately narrow: rewrite an existing leading `# ` heading,
 * never invent one. A note whose first line is prose, a list, a quote, or a
 * deeper heading is left byte-identical — deleting the H1 is how you opt a
 * single note out, and no rename can put it back.
 *
 * This lives in shared-domain because every rename path needs it, not just
 * the renderer's two: the MCP server's `rename_note` renames the same files
 * on the same disk, and a heading that syncs only when a human clicks is a
 * setting that half works.
 */
import { FRONTMATTER_BLOCK_RE } from './frontmatter'

/** A level-1 ATX heading: up to three spaces of indent (CommonMark's limit),
 *  one `#`, then either end-of-line or the heading text. `##` never matches. */
const H1_LINE_RE = /^( {0,3})#(?:[ \t].*)?$/

/**
 * Return `body` with its leading `# Heading` retitled to `title`, or `body`
 * unchanged when there is nothing to retitle.
 *
 * Leading frontmatter and blank lines are skipped, so a note that opens with
 * a `---` block still gets its heading found. Everything outside the heading
 * line — including CRLF endings and the note's original indentation — is
 * preserved exactly.
 */
export function retitleLeadingHeading(body: string, title: string): string {
  // A title with a line break would split the heading in two. Filename
  // sanitizing strips control chars, so this is belt-and-braces.
  if (!title || /[\r\n]/.test(title)) return body

  const fm = FRONTMATTER_BLOCK_RE.exec(body)
  let lineStart = fm ? fm[0].length : 0

  while (lineStart < body.length) {
    const nl = body.indexOf('\n', lineStart)
    const lineEnd = nl === -1 ? body.length : nl
    const raw = body.slice(lineStart, lineEnd)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim()) {
      const m = H1_LINE_RE.exec(line)
      if (!m) return body
      const next = `${m[1]}# ${title}`
      if (next === line) return body
      return body.slice(0, lineStart) + next + body.slice(lineStart + line.length)
    }
    if (nl === -1) break
    lineStart = nl + 1
  }
  return body
}
