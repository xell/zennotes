/**
 * Convert clipboard HTML (Word, Pages, a web page) into Markdown.
 *
 * Built on the same unified stack the app already renders Markdown with, so a
 * pasted table or strikethrough round-trips the way this editor treats it:
 * rehype-parse → rehype-remark → remark-stringify, with remark-gfm on the
 * Markdown side for tables, strikethrough and task lists.
 *
 * The cleanup passes below are a port of Leo's `cliphtml.swift` (PopClip
 * 2markdown). They matter because Word's HTML is not really HTML for reading:
 * it is a dump of the document model, carrying `mso-` styles, conditional
 * comments, a stylesheet, and every run wrapped in its own `<span>`. Feeding
 * that straight to a converter yields Markdown full of stray emphasis and
 * empty paragraphs.
 *
 * NOT imported at module load — see `htmlToMarkdown`'s dynamic import in the
 * paste handler. The unified chain is ~100KB that no launch needs.
 */

/** Scripts and stylesheets. */
function stripNonContentBlocks(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
}

/**
 * Word's two conditional-comment syntaxes, WITH their contents.
 *
 * The content is not incidental: for a list paragraph it is the bullet glyph
 * and its padding (`&middot;&nbsp;&nbsp;&nbsp;`), injected as literal text
 * because Word is describing how it PAINTED the list, not that a list exists.
 * Keeping it leaves a stray `·` at the head of every item.
 */
const WORD_CONDITIONAL_RE =
  /<!--\[if[^\]]*\]-->[\s\S]*?<!--\[endif\]-->|<!\[if[^\]]*\]>[\s\S]*?<!\[endif\]>/gi

/** `<span style='mso-list:Ignore'>` holds the same painted marker. */
const MSO_IGNORE_SPAN_RE = /<span[^>]*mso-list\s*:\s*Ignore[^>]*>[\s\S]*?<\/span>/gi

/** The list level Word hides in the paragraph's style: `mso-list:l0 level2`. */
const MSO_LIST_LEVEL_RE = /mso-list\s*:\s*l\d+\s+level(\d+)/i

/** An ordered marker painted by Word: `1.`, `a)`, `iv.` — anything else is a bullet. */
function markerIsOrdered(marker: string): boolean {
  return /^\s*(?:\d+|[a-z]{1,3}|[ivxlcdm]{1,5})\s*[.)]/i.test(
    marker.replace(/&[a-z]+;|&#\d+;|<[^>]*>|\s/gi, ' ').trim()
  )
}

interface WordListItem {
  level: number
  ordered: boolean
  inner: string
}

/**
 * Rebuild real `<ul>`/`<ol>` from Word's flat list paragraphs.
 *
 * MUST run before attributes are stripped — the level lives in the very
 * `style` attribute the cleanup deletes. Consecutive list paragraphs are
 * grouped, and a level change opens or closes nesting. Anything that is not a
 * list paragraph passes through untouched.
 */
export function rebuildWordLists(html: string): string {
  const out: string[] = []
  let pending: WordListItem[] = []

  /** Close the open run of list paragraphs, emitting properly nested lists. */
  const flush = (): void => {
    if (pending.length === 0) return
    const openOrdered: boolean[] = []
    for (const item of pending) {
      while (openOrdered.length > item.level) out.push(openOrdered.pop() ? '</ol>' : '</ul>')
      while (openOrdered.length < item.level) {
        out.push(item.ordered ? '<ol>' : '<ul>')
        openOrdered.push(item.ordered)
      }
      out.push(`<li>${item.inner}</li>`)
    }
    while (openOrdered.length > 0) out.push(openOrdered.pop() ? '</ol>' : '</ul>')
    pending = []
  }

  const paragraph = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = paragraph.exec(html)) !== null) {
    const [full, attrs = '', inner = ''] = match
    const gap = html.slice(cursor, match.index)
    cursor = match.index + full.length
    const level = attrs.match(MSO_LIST_LEVEL_RE)

    if (!level) {
      // Real content between items ends the run.
      flush()
      out.push(gap, full)
      continue
    }
    // Whitespace between consecutive list paragraphs is layout, not content;
    // anything else means the run genuinely ended.
    if (gap.trim()) {
      flush()
      out.push(gap)
    } else if (pending.length === 0) {
      out.push(gap)
    }

    // Read the painted marker BEFORE removing it — it is the only signal for
    // ordered vs bulleted, since Word records how it drew the list, not what
    // kind of list it was.
    const marker = inner.match(WORD_CONDITIONAL_RE)?.[0] ?? inner.match(MSO_IGNORE_SPAN_RE)?.[0] ?? ''
    pending.push({
      level: Math.max(1, Number(level[1]) || 1),
      ordered: markerIsOrdered(marker),
      inner: inner.replace(WORD_CONDITIONAL_RE, '').replace(MSO_IGNORE_SPAN_RE, '')
    })
  }
  flush()
  out.push(html.slice(cursor))
  return out.join('')
}

/**
 * Strip the attributes that carry Word's formatting noise, and nothing else.
 * `href`, `src`, `colspan` and friends survive, so links, images and table
 * shape are kept.
 */
function stripNoisyAttributes(html: string): string {
  return html.replace(
    /\s(?:style|class|id|lang|dir|(?:data|aria)-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    ''
  )
}

/**
 * Unwrap `<span>` only. Word wraps every run in one, and they carry no
 * structure once their attributes are gone. `div`/`p`/`br` are deliberately
 * left alone: they are what the converter reads as block boundaries.
 */
function unwrapSpans(html: string): string {
  return html.replace(/<span[^>]*>/gi, '').replace(/<\/span>/gi, '')
}

/** Word emits `<o:p>`, `<w:...>` and other Office-namespaced tags. */
function stripOfficeNamespacedTags(html: string): string {
  return html.replace(/<\/?[a-z]+:[^>]*>/gi, '')
}

/** Ordinary comments, after the conditional blocks have had their turn. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '')
}

/** The full clean-up, exported for its own tests. */
export function cleanClipboardHtml(html: string): string {
  // Order is load-bearing: rebuildWordLists reads the mso-list level out of the
  // style attribute that stripNoisyAttributes then deletes.
  const structured = rebuildWordLists(stripNonContentBlocks(html))
  return unwrapSpans(
    stripOfficeNamespacedTags(stripNoisyAttributes(stripComments(structured)))
  ).trim()
}

/**
 * True when the HTML carries structure worth converting. A clipboard whose
 * HTML is only a wrapper around bare text (or a lone `<img>`, which is what a
 * browser image copy looks like) is better pasted as plain text than run
 * through a converter that would just re-escape it.
 */
export function htmlWorthConverting(html: string): boolean {
  const cleaned = cleanClipboardHtml(html)
  if (!cleaned) return false
  // A lone image is the browser-image-copy shape; let the image path have it.
  if (/^<img\b[^>]*>$/i.test(cleaned)) return false
  return /<(a|b|strong|i|em|u|s|strike|del|h[1-6]|ul|ol|li|table|tr|td|th|blockquote|pre|code|img)\b/i.test(
    cleaned
  )
}

/**
 * Clipboard HTML → Markdown. Returns null when there is nothing worth
 * converting, so the caller can fall through to the normal plain-text paste.
 */
export async function htmlToMarkdown(html: string): Promise<string | null> {
  if (!htmlWorthConverting(html)) return null

  const [{ unified }, rehypeParse, rehypeRemark, remarkGfm, remarkStringify] = await Promise.all([
    import('unified'),
    import('rehype-parse'),
    import('rehype-remark'),
    import('remark-gfm'),
    import('remark-stringify')
  ])

  const file = await unified()
    .use(rehypeParse.default, { fragment: true })
    .use(rehypeRemark.default)
    .use(remarkGfm.default)
    .use(remarkStringify.default, {
      bullet: '-',
      emphasis: '*',
      strong: '*',
      fences: true,
      rule: '-'
    })
    .process(cleanClipboardHtml(html))

  const markdown = String(file).trim()
  return markdown.length > 0 ? markdown : null
}
