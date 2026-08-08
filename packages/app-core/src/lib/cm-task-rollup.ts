/**
 * #512: the editor half of derived subtask progress. A parent task line with
 * subtasks gets a `2/5` chip at the end of the line, recomputed from the
 * document on every edit and never written into the text; the counting rule
 * lives in `task-rollup.ts`, shared with the reading view's remark plugin.
 *
 * WYSIWYG-only: registered via the same extension list as the metadata chips.
 */
import { syntaxTree } from '@codemirror/language'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import {
  rollupChildDone,
  rollupCountsChild,
  rollupLabel,
  rollupTaskLine,
  type ChildTaskState,
  type TaskRollup
} from './task-rollup'

type MarkdownNode = ReturnType<typeof syntaxTree>['topNode']

function taskStateForListItem(state: EditorState, item: MarkdownNode): ChildTaskState | null {
  const line = state.doc.lineAt(item.from)
  return rollupTaskLine(line.text)?.state ?? null
}

function listItemForTaskLine(
  state: EditorState,
  tree: ReturnType<typeof syntaxTree>,
  lineNumber: number
): MarkdownNode | null {
  const line = state.doc.line(lineNumber)
  const task = rollupTaskLine(line.text)
  if (!task) return null

  // Resolve from the checkbox's opening bracket, then climb to the list item
  // that Markdown assigned it to. A task-shaped line in a fence or raw block
  // has no ListItem ancestor and is therefore not a task in the rendered tree.
  const markerPos = line.from + task.bracket
  let node: MarkdownNode | null = tree.resolveInner(markerPos, 1)
  while (node && node.name !== 'ListItem') node = node.parent
  if (!node || state.doc.lineAt(node.from).number !== lineNumber) return null
  return node
}

/**
 * Compute editor rollups from CodeMirror's Markdown tree, not raw indentation.
 * Remark uses the same structural rule in the reading view: only ListItem
 * nodes in a List that is a direct child of the parent ListItem count. This
 * keeps one-space siblings, wider ordered-list markers, nested blockquotes,
 * and fenced examples from being mistaken for direct subtasks.
 */
export function computeTaskRollups(
  state: EditorState,
  firstLine: number,
  lastLine: number
): Map<number, TaskRollup> {
  const result = new Map<number, TaskRollup>()
  const tree = syntaxTree(state)

  for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
    const item = listItemForTaskLine(state, tree, lineNumber)
    if (!item) continue

    let done = 0
    let total = 0
    for (let child = item.firstChild; child; child = child.nextSibling) {
      if (child.name !== 'BulletList' && child.name !== 'OrderedList') continue
      for (let subtask = child.firstChild; subtask; subtask = subtask.nextSibling) {
        if (subtask.name !== 'ListItem') continue
        const taskState = taskStateForListItem(state, subtask)
        if (!taskState || !rollupCountsChild(taskState)) continue
        total += 1
        if (rollupChildDone(taskState)) done += 1
      }
    }
    if (total > 0) result.set(lineNumber, { done, total })
  }

  return result
}

class RollupWidget extends WidgetType {
  constructor(
    readonly done: number,
    readonly total: number
  ) {
    super()
  }
  override eq(other: RollupWidget): boolean {
    return other.done === this.done && other.total === this.total
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className =
      this.done === this.total
        ? 'cm-task-meta cm-task-rollup cm-task-rollup-complete'
        : 'cm-task-meta cm-task-rollup'
    span.textContent = `${this.done}/${this.total}`
    const label = rollupLabel({ done: this.done, total: this.total })
    span.title = label
    span.setAttribute('aria-label', label)
    return span
  }
  override ignoreEvent(): boolean {
    return true
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const doc = state.doc
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const firstLine = doc.lineAt(from).number
    const lastLine = doc.lineAt(Math.max(from, to - 1)).number
    // The line loop fills the map in ascending order, which is exactly what
    // RangeSetBuilder needs.
    const rollups = computeTaskRollups(state, firstLine, lastLine)
    for (const [n, rollup] of rollups) {
      const line = doc.line(n)
      builder.add(
        line.to,
        line.to,
        Decoration.widget({ widget: new RollupWidget(rollup.done, rollup.total), side: 1 })
      )
    }
  }
  return builder.finish()
}

const taskRollupPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (p) => p.decorations }
)

export const taskRollupExtension = [taskRollupPlugin]
