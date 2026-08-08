import { EditorSelection, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export type TextReplacements = Record<string, string>

export const MAX_TEXT_REPLACEMENTS = 100
export const MAX_TEXT_REPLACEMENT_TRIGGER_LENGTH = 64
export const MAX_TEXT_REPLACEMENT_VALUE_LENGTH = 4_000

export function normalizeTextReplacements(value: unknown): TextReplacements {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const normalized: TextReplacements = {}
  for (const [rawTrigger, rawReplacement] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (typeof rawReplacement !== 'string') continue
    const trigger = rawTrigger.trim()
    if (!trigger || trigger.length > MAX_TEXT_REPLACEMENT_TRIGGER_LENGTH) continue
    normalized[trigger] = rawReplacement.slice(0, MAX_TEXT_REPLACEMENT_VALUE_LENGTH)
    if (Object.keys(normalized).length >= MAX_TEXT_REPLACEMENTS) break
  }
  return normalized
}

function matchingTrigger(
  state: EditorState,
  from: number,
  text: string,
  replacements: TextReplacements
): string | null {
  const triggers = Object.keys(replacements).sort((left, right) => right.length - left.length)
  if (triggers.length === 0) return null
  const maxLength = triggers[0]?.length ?? 0
  const before = state.sliceDoc(Math.max(0, from - Math.max(0, maxLength - 1)), from)
  const combined = before + text
  return triggers.find((trigger) => combined.endsWith(trigger)) ?? null
}

export function textReplacementInputTransaction(
  state: EditorState,
  from: number,
  to: number,
  text: string,
  replacements: TextReplacements
): TransactionSpec | null {
  if (from !== to || !text || !state.selection.main.empty) return null
  const trigger = matchingTrigger(state, from, text, replacements)
  if (!trigger) return null

  const replacement = replacements[trigger]
  if (replacement === undefined) return null
  const triggerFromDocument = Math.max(0, trigger.length - text.length)
  const insertedPrefixLength = Math.max(0, text.length - trigger.length)
  const insert = text.slice(0, insertedPrefixLength) + replacement
  const changeFrom = from - triggerFromDocument

  return {
    changes: { from: changeFrom, to, insert },
    selection: EditorSelection.cursor(changeFrom + insert.length),
    userEvent: 'input.type'
  }
}

export interface TextReplacementExtensionConfig {
  replacements: (view: EditorView) => TextReplacements
  shouldHandle?: (view: EditorView) => boolean
}

export function textReplacementExtension(config: TextReplacementExtensionConfig): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (config.shouldHandle && !config.shouldHandle(view)) return false
    const transaction = textReplacementInputTransaction(
      view.state,
      from,
      to,
      text,
      config.replacements(view)
    )
    if (!transaction) return false
    view.dispatch(transaction)
    return true
  })
}
