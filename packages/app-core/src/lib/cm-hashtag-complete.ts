/**
 * Hashtag autocomplete: typing `#` followed by a letter inside a note surfaces
 * previously used tags from the vault so they can be completed with a keystroke
 * (#410). Mirrors the `@note` source in `cm-wikilinks.ts` — a single-character
 * trigger whose candidates are read from the Zustand store at completion time —
 * and reuses the tag grammar + code/heading guard from `cm-hashtags.ts` so
 * suggestions match how tags are extracted and styled everywhere else.
 */
import type {
  Completion,
  CompletionContext,
  CompletionResult
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { extractTags } from './tags'
import { isTagSkippedContext } from './cm-hashtags'

/** Completion carrying the `_icon` the shared slash renderer reads. */
type HashtagCompletion = Completion & { _icon?: string }

const MAX_SUGGESTIONS = 20

/**
 * Match a `#tag` token immediately before the cursor. The `#` must follow the
 * start of the line or whitespace (the same boundary `extractTags` uses), so a
 * heading (`# `) or a mid-word `#` never triggers. Returns the offset of the
 * `#` and the query typed after it.
 */
function hashtagMatch(context: CompletionContext): { from: number; query: string } | null {
  const { state, pos } = context
  const line = state.doc.lineAt(pos)
  const before = state.doc.sliceString(line.from, pos)
  const m = before.match(/(?:^|\s)(#[\p{L}\d_/-]*)$/u)
  if (!m) return null
  const token = m[1] // includes the leading '#'
  return { from: pos - token.length, query: token.slice(1) }
}

/**
 * Unique tags across the vault (trash excluded), counted by how many notes use
 * them. The active note is read live from its buffer so a tag just typed in the
 * same note is offered too. Mirrors the aggregation in `TagView`.
 */
function collectTagCounts(): Map<string, number> {
  const state = useStore.getState()
  const activePath = state.activeNote?.path ?? null
  const activeBody = state.activeNote?.body ?? null
  const counter = new Map<string, number>()
  for (const note of state.notes) {
    if (note.folder === 'trash') continue
    const tags =
      activePath && note.path === activePath && activeBody != null
        ? extractTags(activeBody)
        : note.tags
    for (const t of tags) counter.set(t, (counter.get(t) ?? 0) + 1)
  }
  return counter
}

export function hashtagSource(context: CompletionContext): CompletionResult | null {
  const match = hashtagMatch(context)
  // Require at least one character after `#` so a bare `#` (headings, an empty
  // token) doesn't flash the menu; suggestions appear once a tag is being typed.
  if (!match || match.query.length < 1) return null
  // Don't suggest where a `#` isn't a tag (code spans/blocks, headings).
  if (isTagSkippedContext(context.state, context.pos)) return null

  const q = match.query.toLowerCase()
  const ranked = [...collectTagCounts().entries()]
    .map(([tag, count]) => {
      const lower = tag.toLowerCase()
      // Prefix matches rank above substring matches; then by usage, then name.
      const rank = lower.startsWith(q) ? 0 : lower.includes(q) ? 1 : 2
      return { tag, lower, count, rank }
    })
    // Drop non-matches and the exact tag already typed — completing to what's
    // on screen is a no-op, and the live buffer read would otherwise suggest the
    // in-progress tag back to itself.
    .filter((t) => t.rank < 2 && t.lower !== q)
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, MAX_SUGGESTIONS)
  if (ranked.length === 0) return null

  const options: Completion[] = ranked.map(
    ({ tag, count }) =>
      ({
        label: tag,
        displayLabel: tag,
        detail: count > 1 ? `${count}` : '',
        // Rendered by the shared slash renderer's fallback (icon + label + detail).
        _icon: '#',
        apply: (view: EditorView, _completion: Completion, _from: number, to: number) => {
          // Replace the whole `#query` (from the `#`) with `#tag`.
          const insert = `#${tag}`
          view.dispatch({
            changes: { from: match.from, to, insert },
            selection: { anchor: match.from + insert.length }
          })
        }
      }) as HashtagCompletion
  )

  // Anchor just after the `#` (like the `@note` source); `apply` replaces the
  // `#` itself. `filter: false` keeps the ranking above.
  return { from: match.from + 1, options, filter: false }
}
