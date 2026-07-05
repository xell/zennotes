import type { Extension } from '@codemirror/state'
import { livePreviewPlugin } from './cm-live-preview'
import { codeBlockFlairPlugin } from './cm-code-block-flair'
import { tablePlugin, tableVimEntry } from './cm-table'
import { styledTableExtension } from './cm-table-styled'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { hashtagExtension } from './cm-hashtags'
import { highlightExtension } from './cm-highlight'
import { wikilinkRenderExtension } from './cm-wikilink-render'
import type { TableRenderMode } from './table-render-mode'

/**
 * Live-preview ("WYSIWYG") rendering bundle: the base marker-hiding/inline
 * plugin plus block-level renderers — tables, blockquote bars, list
 * bullets, horizontal rules, fenced-code cards, hashtag chips, highlight
 * (`==mark==`), and wikilink rendering. Loaded by a livePreview
 * compartment (gated by the `livePreview` setting); cleared to `[]` when
 * off.
 *
 * Shared by the main editor (`EditorPane`) and the standalone editor
 * windows (`ExternalFileApp`, `FloatingNoteApp`) so every surface renders
 * the same set of blocks in live preview. Previously the standalone
 * windows loaded only `livePreviewPlugin`, so highlights, blockquotes,
 * rules, and tables stayed as raw markdown there.
 *
 * Ported from the WYSIWYG work in PR #185 (author: songgnqing). That PR's
 * frontmatter-properties panel is intentionally excluded — it depends on
 * the PR's breaking database restructure.
 */
export function wysiwygExtensions(tableMode: TableRenderMode): Extension[] {
  return [
    livePreviewPlugin,
    codeBlockFlairPlugin,
    // Table rendering is a three-way setting. `off` keeps tables as plain
    // editable markdown (full keyboard/Vim editing, #232); `rich` is the
    // interactive block widget; `compatible` is the accessibility-safe styled
    // renderer (see TableRenderMode above).
    ...(tableMode === 'rich'
      ? [tablePlugin, tableVimEntry]
      : tableMode === 'compatible'
        ? [styledTableExtension]
        : []),
    wysiwygBlocksPlugin,
    ...hashtagExtension,
    ...highlightExtension,
    ...wikilinkRenderExtension
  ]
}
