import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { runCommandById } from './commands'

/**
 * The `zen` object handed to user JS functions (the `zen:<file>:<fn>(args)`
 * mappings). A small, CodeMirror-6-native, offset-based editor API plus a
 * `run()` escape hatch into the command registry. Designed for ZenNotes, not
 * an Obsidian-compatibility shim — it exposes what we want to support and
 * grows on demand.
 */
export interface ZenFacade {
  /** The raw CodeMirror 6 EditorView — escape hatch for power users. */
  readonly view: EditorView
  /** Full document text. */
  readonly text: string
  /** Main cursor position, as an absolute document offset. */
  readonly cursor: number
  /** Main selection range as absolute offsets. */
  readonly selection: { from: number; to: number }
  /** Path of the active note (null in standalone/external windows). */
  readonly notePath: string | null
  /** Line containing `offset`: 1-based number, range, and text. */
  lineAt(offset: number): { number: number; from: number; to: number; text: string }
  /** Move the cursor to `offset`; scrolls into view unless `scroll: false`. */
  setCursor(offset: number, opts?: { scroll?: boolean }): void
  /** Set the selection range. */
  select(from: number, to: number): void
  /** Replace [from, to) with `text`. */
  replace(from: number, to: number, text: string): void
  /** Insert `text` at the cursor and move the cursor after it. */
  insert(text: string): void
  /** Run a registry command by id, e.g. `zen.run('note.daily.today')`. */
  run(id: string): void
  /** Send text to the active terminal as if typed — no newline appended. */
  sendToTerminal(text: string): void
}

export function makeZenFacade(view: EditorView): ZenFacade {
  return {
    view,
    get text() {
      return view.state.doc.toString()
    },
    get cursor() {
      return view.state.selection.main.head
    },
    get selection() {
      const s = view.state.selection.main
      return { from: s.from, to: s.to }
    },
    get notePath() {
      return useStore.getState().activeNote?.path ?? null
    },
    lineAt(offset) {
      const line = view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length)))
      return { number: line.number, from: line.from, to: line.to, text: line.text }
    },
    setCursor(offset, opts) {
      const anchor = Math.max(0, Math.min(offset, view.state.doc.length))
      view.dispatch({ selection: { anchor }, scrollIntoView: opts?.scroll !== false })
      view.focus()
    },
    select(from, to) {
      const len = view.state.doc.length
      view.dispatch({
        selection: {
          anchor: Math.max(0, Math.min(from, len)),
          head: Math.max(0, Math.min(to, len))
        }
      })
    },
    replace(from, to, text) {
      view.dispatch({ changes: { from, to, insert: text } })
    },
    insert(text) {
      const head = view.state.selection.main.head
      view.dispatch({
        changes: { from: head, insert: text },
        selection: { anchor: head + text.length }
      })
    },
    run(id) {
      runCommandById(id)
    },
    sendToTerminal(text) {
      const w = window as Window & { __zenTerminalSend?: (t: string) => void }
      w.__zenTerminalSend?.(text)
    }
  }
}
