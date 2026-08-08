// Render a note as an inline-styled HTML fragment made for pasting into an
// email body.
//
// Email clients strip <style> blocks, classes and most of the document
// around a pasted fragment, so the only styling that survives is inline
// `style=` attributes on semantic tags. That is exactly what this produces:
// the note's markdown through the same remark parsers the app renders with,
// then one pass that stamps a small, self-contained style on each element.
// No app CSS, no theme variables, no scripts: the fragment must look right
// inside someone else's mail client on someone else's machine.
//
// Deliberate degradations: local images become their alt text in italics (a
// pasted email body cannot carry files on disk); math and diagram fences stay
// as code. The title is stated in the fragment via the shared export-title
// rule, so an email never starts mid-thought.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import type { Element, Root as HastRoot } from 'hast'
import { withExportTitle } from '@shared/export-title'

const MONO = "ui-monospace, 'SF Mono', Consolas, Menlo, monospace"

const TAG_STYLES: Record<string, string> = {
  h1: 'font-size:1.7em;font-weight:700;line-height:1.25;margin:0.8em 0 0.4em',
  h2: 'font-size:1.4em;font-weight:700;line-height:1.25;margin:0.9em 0 0.35em',
  h3: 'font-size:1.2em;font-weight:600;margin:0.9em 0 0.3em',
  h4: 'font-size:1.05em;font-weight:600;margin:0.9em 0 0.3em',
  h5: 'font-size:1em;font-weight:600;margin:0.9em 0 0.3em',
  h6: 'font-size:0.95em;font-weight:600;margin:0.9em 0 0.3em',
  p: 'margin:0.5em 0;line-height:1.55',
  ul: 'margin:0.5em 0;padding-left:1.5em',
  ol: 'margin:0.5em 0;padding-left:1.5em',
  li: 'margin:0.2em 0',
  blockquote: 'margin:0.6em 0;padding:0.05em 1em;border-left:3px solid #d0d0d0;color:#555555',
  pre: `background:#f5f5f5;border:1px solid #e2e2e2;border-radius:4px;padding:10px 12px;margin:0.6em 0;font-family:${MONO};font-size:0.9em;line-height:1.5;white-space:pre-wrap`,
  table: 'border-collapse:collapse;margin:0.6em 0',
  th: 'border:1px solid #cfcfcf;padding:5px 9px;text-align:left;background:#f4f4f4;font-weight:600',
  td: 'border:1px solid #cfcfcf;padding:5px 9px',
  a: 'color:#0b62c4;text-decoration:underline',
  hr: 'border:none;border-top:1px solid #d5d5d5;margin:1em 0'
}

const INLINE_CODE_STYLE = `font-family:${MONO};font-size:0.92em;background:#f5f5f5;padding:1px 4px;border-radius:3px`

function styleTree(tree: HastRoot): void {
  visit(tree, 'element', (node: Element, _index, parent) => {
    // A pasted email cannot carry a file from this disk, so an image degrades
    // to its alt text rather than a broken picture icon on the recipient's end.
    if (node.tagName === 'img') {
      const alt = typeof node.properties?.alt === 'string' ? node.properties.alt : ''
      node.tagName = 'em'
      node.properties = {}
      node.children = [{ type: 'text', value: alt ? `[${alt}]` : '[image]' }]
      return
    }
    // GFM task list checkboxes are form controls, which mail clients mangle;
    // a glyph says the same thing everywhere.
    if (node.tagName === 'input' && node.properties?.type === 'checkbox') {
      const checked = node.properties.checked === true
      node.tagName = 'span'
      node.properties = {}
      node.children = [{ type: 'text', value: checked ? '☒ ' : '☐ ' }]
      return
    }
    if (node.tagName === 'code') {
      const inPre = parent?.type === 'element' && (parent as Element).tagName === 'pre'
      if (!inPre) node.properties = { ...node.properties, style: INLINE_CODE_STYLE }
      return
    }
    const style = TAG_STYLES[node.tagName]
    if (style) node.properties = { ...node.properties, style }
  })
}

export interface EmailHtml {
  html: string
  title: string
}

/** The note as an email-ready fragment: title stated, styles inline. */
export function renderNoteEmailHtml(body: string, noteTitle: string): EmailHtml {
  const titled = withExportTitle(body, noteTitle)
  const rendered = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .use(remarkRehype)
    .use(() => styleTree)
    .use(rehypeStringify)
    .processSync(titled.markdown)
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:15px;color:#1c1c1c">${String(rendered)}</div>`
  return { html, title: titled.title }
}
