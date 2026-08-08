// The title an exported note carries, and how it gets into the export.
//
// In the app, a note's title lives in its chrome: the tab, the breadcrumb, the
// sidebar row. An export has no chrome, so a note whose body never states its
// own title (the frontmatter-title style, or a plain filename-titled note)
// used to export as a document that starts mid-thought. The fix is to state
// the title IN the exported markdown, as a leading `#` heading, so it flows
// through the ordinary rendering pipeline and matches the note's typography
// in every export format that builds on this module (PDF, Word, HTML copy).
//
// The rule mirrors the #455 heading-sync philosophy from the other direction:
// a body that already opens with an H1 is stating its own title, and gets
// nothing added; everything else gets one heading, never two.
import { FRONTMATTER_BLOCK_RE } from './frontmatter'
import { parseFrontmatter } from './template-files'

/** A level-1 ATX heading, CommonMark's shape (up to three spaces of indent). */
const H1_LINE_RE = /^ {0,3}#(?:[ \t]|$)/

/** True when the body's first non-blank line after frontmatter is an H1. */
export function hasLeadingH1(body: string): boolean {
  const fm = FRONTMATTER_BLOCK_RE.exec(body)
  let at = fm ? fm[0].length : 0
  while (at < body.length) {
    const nl = body.indexOf('\n', at)
    const end = nl === -1 ? body.length : nl
    const line = body.slice(at, end).replace(/\r$/, '')
    if (line.trim()) return H1_LINE_RE.test(line)
    if (nl === -1) break
    at = nl + 1
  }
  return false
}

/** Escape the inline-markdown characters that could reformat a title rendered
 *  as heading text. A title is prose, not markup. */
function escapeInlineMarkdown(title: string): string {
  return title.replace(/([\\`*_[\]<>~])/g, '\\$1')
}

export interface ExportTitled {
  /** The markdown to render: the body, with one `#` title inserted after any
   *  frontmatter when the body does not state its own. */
  markdown: string
  /** The document title (window title, PDF metadata, docx properties). */
  title: string
}

/**
 * Resolve the export title and, when the body does not open with an H1,
 * insert it as one.
 *
 * Precedence: a body-stated H1 wins outright (visible content beats
 * metadata), then frontmatter `title:`, then the note's own title (its
 * filename). The heading goes AFTER the frontmatter block, because inserting
 * above it would demote real frontmatter into a horizontal rule and body text.
 */
export function withExportTitle(body: string, noteTitle: string): ExportTitled {
  const { data } = parseFrontmatter(body)
  const stated = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null
  const title = stated ?? noteTitle
  if (hasLeadingH1(body) || !title.trim()) {
    return { markdown: body, title: title.trim() || noteTitle }
  }
  const fm = FRONTMATTER_BLOCK_RE.exec(body)
  const cut = fm ? fm[0].length : 0
  const heading = `# ${escapeInlineMarkdown(title)}\n\n`
  return { markdown: body.slice(0, cut) + heading + body.slice(cut), title }
}
