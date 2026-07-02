import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSameFileHeadingLink, wikilinkHeadingAnchor } from './wikilinks'

// Drive openWikilinkHeading against a fake store so we can assert exactly where
// the click lands, without a real editor/layout.
const openNoteAtOffset = vi.fn().mockResolvedValue(undefined)
const selectNote = vi.fn().mockResolvedValue(undefined)
let noteContents: Record<string, { body: string }> = {}

vi.mock('../store', () => ({
  useStore: { getState: () => ({ noteContents, openNoteAtOffset, selectNote }) }
}))
vi.mock('./database-links', () => ({
  listDatabaseLinkTargets: () => [],
  resolveDatabaseWikilink: () => null
}))

const { openWikilinkHeading } = await import('./wikilink-navigation')

afterEach(() => {
  openNoteAtOffset.mockClear()
  selectNote.mockClear()
  noteContents = {}
})

describe('[[#heading]] same-file navigation (#291)', () => {
  const currentNote = 'inbox/Current.md'
  const body = 'Intro.\n\nMore text.\n\n## My Heading\n\nBody under the heading.'

  it('simulates a full [[#My Heading]] click: resolves to THIS note and scrolls to the heading', async () => {
    noteContents = { [currentNote]: { body } }
    const target = '#My Heading'

    // Exactly what Preview / cm-wikilink-render do for a wikilink with no note
    // part: treat it as a heading in the current note.
    expect(isSameFileHeadingLink(target)).toBe(true)
    const path = isSameFileHeadingLink(target) ? currentNote : null
    const anchor = wikilinkHeadingAnchor(target)
    expect(path).toBe(currentNote)
    expect(anchor).toBe('My Heading')

    await openWikilinkHeading(path as string, anchor as string)

    expect(selectNote).not.toHaveBeenCalled()
    expect(openNoteAtOffset).toHaveBeenCalledTimes(1)
    const [calledPath, offset, opts] = openNoteAtOffset.mock.calls[0]
    expect(calledPath).toBe(currentNote)
    // The offset lands exactly on the heading line.
    expect(body.slice(offset)).toMatch(/^#+\s*My Heading/)
    expect(opts).toMatchObject({ scrollMode: 'start' })
  })

  it('matches the heading case-insensitively (like Obsidian)', async () => {
    noteContents = { [currentNote]: { body } }
    await openWikilinkHeading(currentNote, 'MY HEADING')
    expect(openNoteAtOffset).toHaveBeenCalledTimes(1)
    expect(body.slice(openNoteAtOffset.mock.calls[0][1])).toMatch(/^#+\s*My Heading/)
  })

  it('falls back to opening the note at the top when the heading is missing', async () => {
    noteContents = { [currentNote]: { body } }
    await openWikilinkHeading(currentNote, 'Nonexistent')
    expect(openNoteAtOffset).not.toHaveBeenCalled()
    expect(selectNote).toHaveBeenCalledWith(currentNote)
  })
})
