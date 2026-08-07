/**
 * Store-facing lookup for a note's Typst preamble (#486).
 *
 * Kept apart from `typst-preamble.ts` (which is pure) so both render paths —
 * the reading preview and the editor's math widgets — resolve a note's
 * preamble the same way, from the same state, rather than each assembling its
 * own idea of which definitions apply.
 */
import type { NoteMeta } from '@shared/ipc'
import { resolveTypstPreamble, type TypstPreambleNote } from './typst-preamble'

export interface TypstPreambleState {
  typstTagPreambles: boolean
  mathRenderer: 'katex' | 'typst'
  typstPreambleNotes: TypstPreambleNote[]
  notes: NoteMeta[]
}

/**
 * The Typst source to prepend to every formula in `notePath`, or `''` when the
 * feature is off, the KaTeX renderer is active, or the note's tags match no
 * preamble — which is the common case, and costs one map lookup.
 */
export function selectTypstPreambleFor(
  state: TypstPreambleState,
  notePath: string | null | undefined
): string {
  if (!notePath) return ''
  if (!state.typstTagPreambles || state.mathRenderer !== 'typst') return ''
  if (state.typstPreambleNotes.length === 0) return ''
  const note = state.notes.find((n) => n.path === notePath)
  if (!note || note.tags.length === 0) return ''
  return resolveTypstPreamble(note.tags, state.typstPreambleNotes)
}
