import type { Extension } from '@codemirror/state'
import { livePreviewPlugin } from './cm-live-preview'
import { codeBlockFlairPlugin } from './cm-code-block-flair'
import { tablePlugin, tableVimEntry } from './cm-table'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { hashtagExtension } from './cm-hashtags'
import { highlightExtension } from './cm-highlight'
import { wikilinkRenderExtension } from './cm-wikilink-render'

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
export function wysiwygExtensions(renderTables: boolean): Extension[] {
  return [
    livePreviewPlugin,
    codeBlockFlairPlugin,
    // Table widgets are gated on a setting — off keeps tables as plain editable
    // markdown for full keyboard/Vim editing (#232).
    ...(renderTables ? [tablePlugin, tableVimEntry] : []),
    wysiwygBlocksPlugin,
    ...hashtagExtension,
    ...highlightExtension,
    ...wikilinkRenderExtension
  ]
}
