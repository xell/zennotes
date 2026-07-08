import { useMemo } from 'react'
import { useStore } from '../store'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { backlinksForNote } from '../lib/wikilinks'
import { readingStats, formatReadingMinutes, type ReadingStats } from '../lib/word-count'
import { ClockIcon, LinkIcon } from './icons'

export function NoteStats({
  note,
  selection
}: {
  note: NoteContent
  /** Reading stats for the current editor selection, when the pane has a
   *  non-empty one. Present → the row shows the selection's counts (tinted
   *  to signal it's a selection, not the whole note); null → the whole note. */
  selection?: ReadingStats | null
}): JSX.Element {
  const notes = useStore((s) => s.notes)

  const noteStats = useMemo(() => readingStats(note.body), [note.body])

  const backlinks = useMemo(() => {
    return backlinksForNote(notes as NoteMeta[], note).length
  }, [note.path, notes])

  const { words, characters, minutes } = selection ?? noteStats
  const showingSelection = !!selection

  return (
    <div
      className={[
        'flex shrink-0 items-center gap-1 text-xs tabular-nums',
        showingSelection ? 'text-accent' : 'text-ink-500'
      ].join(' ')}
      title={showingSelection ? 'Selection' : undefined}
    >
      {/* Backlinks are a property of the note, not the selection — hide them
          while showing selection stats so the row reads unambiguously. */}
      {!showingSelection && backlinks > 0 && (
        <>
          <LinkIcon width={12} height={12} />
          <span>{backlinks}</span>
          <Sep />
        </>
      )}
      <span>{words.toLocaleString()}</span>
      <Sep />
      <span>{characters.toLocaleString()}</span>
      <Sep />
      <ClockIcon width={12} height={12} />
      <span>{formatReadingMinutes(minutes)}</span>
    </div>
  )
}

function Sep(): JSX.Element {
  return <span className="select-none opacity-30">|</span>
}
