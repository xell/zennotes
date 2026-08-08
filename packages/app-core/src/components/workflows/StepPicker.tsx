// The step picker: "what can go here?", answered as a list you can insert from.
//
// This is the canvas half of what the completion popup does for text. The same
// registry answers both, and the same rule decides what is offered: only the
// kinds that are LEGAL at the position being filled. Offering `tag` after a pipe
// and then marking the result red would teach the grammar by punishment; the
// caller works out the legal set and this component never second-guesses it.
//
// Keyboard first, like every list in this app: the filter field owns the keys,
// arrows (and Ctrl+N/P/J/K) move, Enter inserts, Escape closes. Unlike the
// gallery the field is a REAL text input, because filtering by name is the
// fastest way through forty verbs, so j/k are typed characters here and only the
// chorded motions move the cursor.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import type { NodeCategory, NodeDef } from '@shared/workflows/nodes'
import { paramSignature } from '@shared/workflows/suggest'
import { isPaletteNextKey, isPalettePreviousKey } from '../../lib/palette-nav'
import { Modal } from '../ui/Modal'
import { CATEGORY_BLURB, CATEGORY_CHIP, CATEGORY_ORDER, CATEGORY_TITLE } from './node-presentation'

/** `where field op value`: how a step is written, derived from its params. */
function stepSignature(def: NodeDef): string {
  const params = paramSignature(def)
  return params === '' ? def.kind : `${def.kind} ${params}`
}

/**
 * Does this definition match what has been typed?
 *
 * Matched against the kind, the title AND the description, because someone who
 * does not know the language yet types what they want ("delete", "date") rather
 * than the verb they have never seen. A substring test rather than a fuzzy one:
 * the list is short enough that ranking would be a lie dressed as intelligence.
 */
function matches(def: NodeDef, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return (
    def.kind.toLowerCase().includes(needle) ||
    def.title.toLowerCase().includes(needle) ||
    def.description.toLowerCase().includes(needle)
  )
}

export interface StepPickerProps {
  /** What this insertion will do, e.g. "Add a step after `where`". */
  title: string
  /** The one sentence that says where the step will land. */
  subtitle: string
  /** The kinds that are legal here. Worked out by the caller; never filtered again. */
  defs: readonly NodeDef[]
  onPick: (def: NodeDef) => void
  onClose: () => void
}

export function StepPicker({
  title,
  subtitle,
  defs,
  onPick,
  onClose
}: StepPickerProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Grouped by category in `CATEGORY_ORDER`, with empty groups dropped so a
  // filtered list never shows a heading over nothing.
  const groups = useMemo(() => {
    const out: { category: NodeCategory; defs: NodeDef[] }[] = []
    for (const category of CATEGORY_ORDER) {
      const items = defs.filter((def) => def.category === category && matches(def, query))
      if (items.length > 0) out.push({ category, defs: items })
    }
    return out
  }, [defs, query])

  // One flat index across the groups: the cursor moves through rows, never
  // through headings.
  const flat = useMemo(() => groups.flatMap((group) => group.defs), [groups])
  const starts = useMemo(() => {
    let next = 0
    return groups.map((group) => {
      const start = next
      next += group.defs.length
      return start
    })
  }, [groups])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Refiltering can shorten the list under a cursor that was walked down it, so
  // the highlight goes back to the best match rather than off the end.
  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-picker-index="${cursor}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    const move = (delta: number): void => {
      event.preventDefault()
      event.stopPropagation()
      setCursor((index) => Math.max(0, Math.min(flat.length - 1, index + delta)))
    }
    if (isPaletteNextKey(event)) {
      move(1)
      return
    }
    if (isPalettePreviousKey(event)) {
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      const def = flat[cursor]
      if (def) onPick(def)
    }
  }

  return (
    <Modal size="2xl" layer="modal" align="top" onClose={onClose} labelledBy="workflow-picker-title">
      <div className="border-b border-paper-300/70 px-5 py-4">
        <div id="workflow-picker-title" className="text-sm font-semibold text-ink-900">
          {title}
        </div>
        <p className="mt-1 text-xs text-ink-500">{subtitle}</p>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="workflow-picker-list"
          aria-activedescendant={`workflow-picker-option-${cursor}`}
          aria-label="Filter steps"
          placeholder="Type to filter…"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="mt-3 w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        />
      </div>
      <div
        ref={listRef}
        id="workflow-picker-list"
        role="listbox"
        aria-label="Steps"
        className="max-h-[50vh] overflow-y-auto px-2 py-2"
      >
        {flat.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-ink-400">
            Nothing here matches “{query}”.
          </p>
        )}
        {groups.map((group, groupIndex) => (
          <div key={group.category} className="mb-2 last:mb-0">
            <div className="px-3 pt-1 text-2xs font-semibold uppercase tracking-wide text-ink-400">
              {CATEGORY_TITLE[group.category]}
            </div>
            <p className="mb-1 px-3 text-2xs text-ink-400">{CATEGORY_BLURB[group.category]}</p>
            {group.defs.map((def, itemIndex) => {
              const index = starts[groupIndex] + itemIndex
              return (
                <button
                  key={def.kind}
                  id={`workflow-picker-option-${index}`}
                  data-picker-index={index}
                  type="button"
                  role="option"
                  aria-selected={index === cursor}
                  // Focus stays on the field that owns the keys, so a click and
                  // then an arrow still moves this list instead of stranding
                  // the keyboard on a button.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(def)}
                  onMouseMove={() => setCursor(index)}
                  className={`mb-1 flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
                    index === cursor ? 'bg-paper-200' : 'hover:bg-paper-200/60'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium text-ink-900">
                      {def.title}
                    </span>
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide ${CATEGORY_CHIP[def.category]}`}
                    >
                      {def.category}
                    </span>
                    {def.mutating && (
                      <span
                        title="Running this plans changes to your notes. You confirm them first, and can undo them after."
                        className="shrink-0 rounded bg-warning/20 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-warning"
                      >
                        writes
                      </span>
                    )}
                  </span>
                  {/* The description is the only place the language is
                      explained, so it is never truncated away here. */}
                  <span className="text-xs text-ink-600">{def.description}</span>
                  <span className="font-mono text-2xs text-ink-400">{stepSignature(def)}</span>
                  <span className="whitespace-pre-wrap break-words rounded bg-paper-200/70 px-1.5 py-1 font-mono text-2xs text-ink-700">
                    {def.example}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-4 border-t border-paper-300/70 bg-paper-50 px-5 py-2 text-2xs text-ink-500">
        <span>
          <kbd className="rounded bg-paper-200 px-1">↑↓</kbd> move
        </span>
        <span>
          <kbd className="rounded bg-paper-200 px-1">↵</kbd> insert
        </span>
        <span>
          <kbd className="rounded bg-paper-200 px-1">esc</kbd> cancel
        </span>
      </div>
    </Modal>
  )
}
