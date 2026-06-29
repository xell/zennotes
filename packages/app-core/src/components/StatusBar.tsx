import { useMemo } from 'react'
import { useStore } from '../store'
import type { NoteContent, NoteMeta } from '@shared/ipc'
import { backlinksForNote } from '../lib/wikilinks'
import { countWords } from '../lib/word-count'
import { ClockIcon, LinkIcon } from './icons'

export function NoteStats({ note }: { note: NoteContent }): JSX.Element {
  const notes = useStore((s) => s.notes)

  const { words, characters, minutes } = useMemo(() => {
    const body = note.body
    const w = countWords(body)
    const c = body.length
    const m = Math.max(1, Math.round(w / 200))
    return { words: w, characters: c, minutes: m }
  }, [note.body])

  const backlinks = useMemo(() => {
    return backlinksForNote(notes as NoteMeta[], note).length
  }, [note.path, notes])

  return (
    <div className="flex shrink-0 items-center gap-1 text-xs text-ink-500 tabular-nums">
      {backlinks > 0 && (
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
      <span>{minutes}</span>
    </div>
  )
}

function Sep(): JSX.Element {
  return <span className="select-none opacity-30">|</span>
}
