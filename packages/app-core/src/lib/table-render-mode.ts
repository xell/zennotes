/**
 * How Markdown tables render in live preview. Kept in its own leaf module (no
 * imports) so both `store.ts` and the wysiwyg/table extensions can share it
 * without an import cycle.
 *
 *  - `off`        — plain editable Markdown source (no styling).
 *  - `rich`       — the interactive block-widget table (resize, drag, cell nav).
 *                   Prettiest, but its `contenteditable="false"` block breaks
 *                   the accessibility text surface, so tools like Grammarly stop
 *                   recognizing prose after the table.
 *  - `compatible` — a CSS-styled table that keeps cells as real editable text
 *                   (no block widget), so the accessibility surface stays
 *                   continuous and Grammarly works through it. Static: no
 *                   resize / drag / cell menu.
 */
export const TABLE_RENDER_MODES = ['off', 'rich', 'compatible'] as const

export type TableRenderMode = (typeof TABLE_RENDER_MODES)[number]

export function isTableRenderMode(value: unknown): value is TableRenderMode {
  return value === 'off' || value === 'rich' || value === 'compatible'
}
