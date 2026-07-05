/**
 * Accessibility-safe ("compatible") table rendering for live preview.
 *
 * Unlike the rich `tablePlugin`, this does NOT replace the table with a
 * `contenteditable="false"` block widget — that block breaks the editable text
 * surface the OS accessibility API exposes, so tools like Grammarly stop
 * recognizing prose after the table (see data/grammarly-compatibility.md).
 *
 * Instead it keeps the table's cells as real, editable text and only *styles*
 * them with line + inline decorations: hide the `|` separators and the
 * `|---|` delimiter row, box each cell, and pin cells to a measured per-column
 * width so columns line up. Because nothing is replaced by a block widget, the
 * text stays one continuous accessibility surface. Trade-off: it's static (no
 * column-resize / drag / cell menu — those need the interactive widget).
 */
import { syntaxTree } from '@codemirror/language'
import { type Range, StateEffect } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate
} from '@codemirror/view'

interface Cell {
  /** Trimmed content range in the doc. */
  from: number
  to: number
  col: number
}
interface Row {
  lineFrom: number
  isHeader: boolean
  cells: Cell[]
  /** Doc positions of the unescaped `|` separators on this row. */
  pipes: number[]
}
interface TableInfo {
  rows: Row[]
  /** Line-start positions of delimiter (`|---|`) rows to hide. */
  delimiterLines: number[]
}

const DELIMITER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/

/** Unescaped `|` positions (doc coords) within a line's text. */
function pipePositions(lineText: string, lineFrom: number): number[] {
  const out: number[] = []
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === '|' && lineText[i - 1] !== '\\') out.push(lineFrom + i)
  }
  return out
}

/** Split a row line into cell ranges (the full text between pipes, so no stray
 *  undecorated whitespace is left between styled cells). Empty edge segments
 *  produced by a leading/trailing pipe are dropped. */
function rowCells(lineText: string, lineFrom: number, pipes: number[]): Cell[] {
  // Segment boundaries in doc coords: line start, each pipe, line end.
  const bounds = [lineFrom, ...pipes, lineFrom + lineText.length]
  const cells: Cell[] = []
  let col = 0
  for (let i = 0; i < bounds.length - 1; i++) {
    const from = i === 0 ? bounds[i]! : bounds[i]! + 1 // skip the pipe char
    const to = bounds[i + 1]!
    if (to < from) continue
    const seg = lineText.slice(from - lineFrom, to - lineFrom)
    const isEdge = i === 0 || i === bounds.length - 2
    // A leading/trailing pipe yields an empty edge segment — skip it. Interior
    // segments (even empty ones) advance the column so alignment stays correct.
    if (isEdge && seg.trim() === '') continue
    cells.push({ from, to, col })
    col++
  }
  return cells
}

/** Parse the tables intersecting the visible ranges into per-cell info. */
function parseTables(view: EditorView): TableInfo[] {
  const tables: TableInfo[] = []
  const tree = syntaxTree(view.state)
  const seen = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Table') return
        if (seen.has(node.from)) return false
        seen.add(node.from)
        const rows: Row[] = []
        const delimiterLines: number[] = []
        const firstLine = view.state.doc.lineAt(node.from).number
        const lastLine = view.state.doc.lineAt(Math.min(node.to, view.state.doc.length)).number
        for (let n = firstLine; n <= lastLine; n++) {
          const line = view.state.doc.line(n)
          if (!line.text.includes('|')) continue
          if (DELIMITER_RE.test(line.text)) {
            delimiterLines.push(line.from)
            continue
          }
          const pipes = pipePositions(line.text, line.from)
          const cells = rowCells(line.text, line.from, pipes)
          if (cells.length === 0) continue
          rows.push({ lineFrom: line.from, isHeader: rows.length === 0, cells, pipes })
        }
        if (rows.length > 0) tables.push({ rows, delimiterLines })
        return false
      }
    })
  }
  return tables
}

function buildDecorations(view: EditorView, widths: Map<number, number>): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const tables = parseTables(view)
  for (const table of tables) {
    for (const lineFrom of table.delimiterLines) {
      ranges.push(Decoration.line({ class: 'cm-stbl-delimiter' }).range(lineFrom))
    }
    for (const row of table.rows) {
      ranges.push(
        Decoration.line({ class: row.isHeader ? 'cm-stbl-row cm-stbl-head' : 'cm-stbl-row' }).range(
          row.lineFrom
        )
      )
      for (const pipe of row.pipes) {
        ranges.push(Decoration.mark({ class: 'cm-stbl-pipe' }).range(pipe, pipe + 1))
      }
      row.cells.forEach((cell, i) => {
        if (cell.to <= cell.from) return
        // Span the FULL cell range (including its markdown padding spaces,
        // e.g. the ` ` in `| Reminders |`) — matching measureColumns below,
        // which measures that same full untrimmed text. (An earlier attempt
        // trimmed this range so only the bare word was styled, leaving the
        // padding spaces as stray plain-text nodes between the inline-block
        // cells; mixing baseline-aligned bare text with top-aligned
        // inline-blocks on the same line broke the whole row's layout.)
        const px = widths.get(cell.from)
        const isLast = i === row.cells.length - 1
        ranges.push(
          Decoration.mark({
            class: isLast ? 'cm-stbl-cell cm-stbl-cell-last' : 'cm-stbl-cell',
            attributes: px != null ? { style: `--z-stbl-col: ${px}px` } : {}
          }).range(cell.from, cell.to)
        )
      })
    }
  }
  return Decoration.set(ranges, true)
}

/**
 * Obsidian's table-width rule: the table matches the note's text column width
 * when that column is wider than 500px, and holds a 500px floor below that
 * (the note scrolls horizontally rather than squeezing the table unreadably
 * narrow). Columns are then sized proportionally to their content to fill that
 * width exactly — stretching when content is narrow, shrinking (with cell text
 * wrapping) when it's wide — so the table never overflows the note.
 */
const MIN_TABLE_WIDTH = 500
/** Last-resort floor for a degenerate column (e.g. every cell empty, so it has
 *  no measured min-content width of its own) — not the normal sizing path,
 *  which derives each column's floor from its actual longest word instead. */
const MIN_COL_CONTENT = 24

/**
 * Target CONTENT width for a table row — how wide the styled table should be.
 *
 * Built only from stable, content-independent measurements so it can never
 * feed back on itself (the earlier "ratcheting / moving on resize" bug):
 *   - `.cm-scroller.clientWidth` — the pane's real width, set by the layout.
 *   - `.cm-gutters` width — a sibling flex item (line numbers) that eats into
 *     the row's usable space; 0 when off.
 *   - `.cm-content`'s max-width cap + horizontal padding — the app's centered
 *     text-column settings (`--z-editor-max-width`, box-sizing: border-box).
 * None of these depend on the table's own rendered width, so the target is
 * fixed for a given pane size and the measurement converges in one pass.
 */
function targetContentWidth(view: EditorView): number {
  const cs = getComputedStyle(view.contentDOM)
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
  const gutter = view.scrollDOM.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0
  const maxWidth = parseFloat(cs.maxWidth) // NaN for `none`
  const scrollerContent = view.scrollDOM.clientWidth - gutter - padding
  const capContent = Number.isFinite(maxWidth) ? maxWidth - padding : Infinity
  return Math.max(Math.min(scrollerContent, capContent), MIN_TABLE_WIDTH - padding)
}

/** A cell's fixed overhead (padding + border), from a live zero-content probe
 *  so it tracks the CSS rather than duplicating constants. */
function measureCellOverhead(view: EditorView): number {
  const probe = document.createElement('span')
  probe.className = 'cm-stbl-cell'
  probe.style.cssText = 'position:absolute; visibility:hidden; width:0px;'
  view.dom.appendChild(probe)
  const overhead = probe.getBoundingClientRect().width
  probe.remove()
  return overhead
}

/** Single-line text width via canvas — deliberately NOT `coordsAtPos`, which
 *  would report the wrapped (multi-line) width once cells wrap, feeding back
 *  into the sizing. Canvas measures intrinsic width regardless of layout. */
function makeTextMeasurer(view: EditorView): (text: string, bold: boolean) => number {
  const cs = getComputedStyle(view.contentDOM)
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  const size = cs.fontSize || '15px'
  const family = cs.fontFamily || 'monospace'
  return (text, bold) => {
    if (!ctx) return 0
    ctx.font = `${bold ? 600 : 400} ${size} ${family}`
    return ctx.measureText(text).width
  }
}

/** Sum an array, treating holes/undefined as 0. */
function sum(values: number[]): number {
  return values.reduce((s: number, w) => s + (w ?? 0), 0)
}

/**
 * Compute each cell's content width so every row fills `targetContentWidth`
 * exactly, the way a browser's own `<table>` auto-layout would: every column
 * is guaranteed at least its own min-content width (its longest unbreakable
 * word — text wraps between words, never inside one), and only the space
 * beyond that is distributed by content proportions.
 *
 * A naive "shrink every column by the same percentage" (the previous
 * approach) looks fine on paper but produces exactly the glitch this fixes:
 * a column whose every value is one short word (e.g. "Watch": N/A, Calendar,
 * Reminders) has near-zero slack between its natural and minimum width, so
 * ANY uniform shrink pushes it below its own longest word and wraps it — while
 * a column whose natural width is set by one long outlier row (e.g. "Mobile")
 * has plenty of slack, so the same percentage shrink barely dents its
 * everyday-row headroom. The visual result is a cramped, wrapped column right
 * next to one with lots of empty space, even though both shrank "equally."
 * Routing shrinkage through each column's own slack (natural − min) instead
 * fixes that: tight columns give up little to nothing, loose ones absorb it.
 */
function measureColumns(view: EditorView): Map<number, number> {
  const tables = parseTables(view)
  if (tables.length === 0) return new Map()
  const overhead = measureCellOverhead(view)
  const target = targetContentWidth(view)
  const measure = makeTextMeasurer(view)
  const out = new Map<number, number>()
  for (const table of tables) {
    // Natural width = the widest full RAW cell text (single line) — the
    // rendered box spans the raw, untrimmed range (see buildDecorations), so
    // this must match that, padding spaces and all (`| Reminders |` renders
    // " Reminders ", not "Reminders"). Min width = each cell's own ambient
    // leading/trailing space plus its longest single WORD (text wraps between
    // words, never inside one) — the hard floor a column can shrink to.
    // Computed per cell (not a single global word list) because the ambient
    // padding has to travel with whichever cell actually contains the
    // longest word, not get invented from a different cell's spacing. Both
    // get a small safety margin on top: canvas's text metrics and the
    // browser's own text-layout engine can differ by a fraction of a pixel,
    // and a column with exactly zero margin above its own floor has no room
    // to absorb that — the margin is what keeps "just fits" cases from
    // tipping into a wrap.
    const TEXT_MEASURE_SAFETY_PX = 2
    const colNatural: number[] = []
    const colMin: number[] = []
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.to <= cell.from) continue
        const raw = view.state.sliceDoc(cell.from, cell.to)
        const trimmed = raw.trim()
        colNatural[cell.col] = Math.max(
          colNatural[cell.col] ?? 0,
          measure(raw, row.isHeader) + TEXT_MEASURE_SAFETY_PX
        )
        const leadWidth = measure(raw.slice(0, raw.length - raw.trimStart().length), row.isHeader)
        const trailWidth = measure(raw.slice(raw.trimEnd().length), row.isHeader)
        let cellMin = leadWidth + trailWidth
        for (const token of trimmed.split(/\s+/)) {
          if (!token) continue
          cellMin = Math.max(cellMin, leadWidth + measure(token, row.isHeader) + trailWidth)
        }
        colMin[cell.col] = Math.max(colMin[cell.col] ?? 0, cellMin + TEXT_MEASURE_SAFETY_PX)
      }
    }
    const numCols = colNatural.length
    if (numCols === 0) continue
    for (let c = 0; c < numCols; c++) {
      colNatural[c] ??= 0
      // A fully-empty column has no min from the loop above; fall back to 0
      // rather than undefined so the arithmetic below stays well-defined.
      colMin[c] = Math.min(colMin[c] ?? 0, colNatural[c])
    }

    const availableForContent = Math.max(0, target - numCols * overhead)
    const naturalSum = sum(colNatural)
    const minSum = sum(colMin)

    let colWidth: number[]
    if (naturalSum <= availableForContent) {
      // Room to spare: stretch every column above its natural width,
      // proportional to its natural share.
      const extra = availableForContent - naturalSum
      colWidth = colNatural.map(
        (w) => w + extra * (naturalSum > 0 ? w / naturalSum : 1 / numCols)
      )
    } else if (minSum <= availableForContent) {
      // Must shrink below natural width, but there's enough room to honor
      // every column's own longest-word floor. Give each column that floor,
      // then hand out the leftover in proportion to its slack above the
      // floor (natural − min) — see the doc comment above for why this beats
      // a flat proportional shrink.
      const slack = colNatural.map((w, c) => Math.max(0, w - colMin[c]!))
      const slackSum = sum(slack)
      const leftover = availableForContent - minSum
      colWidth = colMin.map(
        (min, c) => min + leftover * (slackSum > 0 ? slack[c]! / slackSum : 1 / numCols)
      )
    } else {
      // Even every column's bare word-floor doesn't fit the available width.
      // Scale the floors down proportionally — a lone long word may wrap
      // here, but there's no narrower option left that avoids it.
      colWidth = colMin.map((min) =>
        minSum > 0 ? availableForContent * (min / minSum) : availableForContent / numCols
      )
    }
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.to <= cell.from) continue
        const w = colWidth[cell.col]
        if (w != null) out.set(cell.from, Math.round(Math.max(MIN_COL_CONTENT, w)))
      }
    }
  }
  return out
}

function sameWidths(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

const styledTablePing = StateEffect.define<null>()

export const styledTableExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private widths = new Map<number, number>()
    private pendingFrame = 0
    private pendingDocMeasure: ReturnType<typeof setTimeout> | null = null

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, this.widths)
      this.scheduleMeasure(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        // Remap the measured widths (keyed by cell start = the position after a
        // pipe) through the edit, so cells AFTER the caret keep their width as
        // positions shift — no auto-width shimmer while typing. Assoc -1 keeps a
        // cell start pinned right after its pipe, matching where buildDecorations
        // re-derives cell.from. The debounced re-measure still corrects sizes.
        const remapped = new Map<number, number>()
        for (const [pos, w] of this.widths) remapped.set(update.changes.mapPos(pos, -1), w)
        this.widths = remapped
      }
      if (update.docChanged || update.viewportChanged) {
        // Positions shift on edits and the visible set changes on scroll, so
        // rebuild from scratch, reusing the (remapped) widths so the table
        // doesn't flash through an unmeasured "auto width" pass.
        this.decorations = buildDecorations(update.view, this.widths)
      }
      if (update.docChanged) {
        this.scheduleDocMeasure(update.view)
      }
      if (update.viewportChanged || update.geometryChanged) {
        this.scheduleMeasure(update.view)
      }
    }

    private scheduleDocMeasure(view: EditorView): void {
      if (this.pendingDocMeasure) clearTimeout(this.pendingDocMeasure)
      // Batch rapid typing into one width measurement. This avoids dispatching
      // a measure/ping transaction on every inserted character.
      this.pendingDocMeasure = setTimeout(() => {
        this.pendingDocMeasure = null
        if (!view.dom.isConnected) return
        this.scheduleMeasure(view)
      }, 100)
    }

    private scheduleMeasure(view: EditorView): void {
      view.requestMeasure({
        key: 'zen-styled-table',
        read: () => measureColumns(view),
        write: (widths) => {
          if (sameWidths(widths, this.widths)) return
          this.widths = widths
          this.decorations = buildDecorations(view, widths)
          if (this.pendingFrame) return
          this.pendingFrame = requestAnimationFrame(() => {
            this.pendingFrame = 0
            if (!view.dom.isConnected) return
            view.dispatch({ effects: styledTablePing.of(null) })
          })
        }
      })
    }

    destroy(): void {
      if (this.pendingFrame) cancelAnimationFrame(this.pendingFrame)
      if (this.pendingDocMeasure) clearTimeout(this.pendingDocMeasure)
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
)
