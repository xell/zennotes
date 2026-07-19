/**
 * Annotations tab of the PDF side panel: every markup annotation in the open
 * document, whether made here or baked in by Preview/Acrobat — highlights,
 * underlines, strikeouts, shapes, sticky notes — with the text it covers or
 * the author's own note.
 *
 * The list is derived fresh from the document on each rebuild rather than
 * persisted, so it needs no stable per-highlight identity — which keeps it
 * independent of the parked "linkable highlight references" design. If linking
 * lands later, this becomes its UI rather than a second implementation.
 */
import { useMemo, useState } from 'react'
import { annotationLabel, type PdfAnnotationsHandle } from '../lib/pdf-annotations'

export function PdfAnnotationList({
  annotations
}: {
  annotations?: PdfAnnotationsHandle
}): JSX.Element {
  const [query, setQuery] = useState('')
  const entries = annotations?.entries ?? []
  const trimmed = query.trim().toLowerCase()

  const filtered = useMemo(() => {
    if (!trimmed) return entries
    // Match the type too, so "underline" or "note" narrows by kind — useful
    // once a document mixes markup from several tools.
    return entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(trimmed) ||
        annotationLabel(entry.subtype).toLowerCase().includes(trimmed)
    )
  }, [entries, trimmed])

  return (
    <>
      <div className="shrink-0 border-b border-paper-300/70 px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter annotations…"
          className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-400"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-ink-400">
            {annotations ? 'No annotations in this PDF yet.' : 'Loading…'}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-ink-400">No matching annotations.</div>
        ) : (
          <ul>
            {filtered.map((entry) => (
              <li key={entry.key}>
                <button
                  type="button"
                  onClick={() => annotations?.goTo(entry)}
                  className="zen-pdf-highlight-row flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-paper-200/70"
                >
                  <span
                    aria-hidden
                    className="mt-1 h-3 w-3 shrink-0 rounded-sm ring-1 ring-inset ring-black/10"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="min-w-0 flex-1">
                    {/* A highlight over a figure, or on a scanned page with no
                        text layer, legitimately has no text to show. */}
                    <span
                      className={[
                        'block text-sm leading-snug',
                        entry.text ? 'text-ink-800' : 'italic text-ink-400'
                      ].join(' ')}
                    >
                      {entry.text || 'No text'}
                    </span>
                    <span className="mt-0.5 block text-2xs uppercase tracking-wide text-ink-400">
                      {annotationLabel(entry.subtype)} · page {entry.pageNumber}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
