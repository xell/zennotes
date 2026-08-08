import { describe, expect, it, vi } from 'vitest'
import type { NoteMeta } from '@shared/ipc'
import { createVaultReader, toWorkflowNote } from './workflow-vault-reader'

function meta(path: string, over: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path,
    title: path.split('/').pop()?.replace(/\.md$/i, '') ?? path,
    folder: 'inbox',
    siblingOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    size: 0,
    tags: [],
    wikilinks: [],
    assetEmbeds: [],
    hasAttachments: false,
    excerpt: '',
    ...over
  }
}

describe('toWorkflowNote folder derivation', () => {
  it('gives a root-level note an empty folder', () => {
    expect(toWorkflowNote(meta('Dune.md')).folder).toBe('')
  })

  it('uses the directory, not the file name, for a note one level deep', () => {
    expect(toWorkflowNote(meta('inbox/Dune.md')).folder).toBe('inbox')
  })

  it('keeps every segment of a nested directory', () => {
    expect(toWorkflowNote(meta('inbox/books/scifi/Dune.md')).folder).toBe('inbox/books/scifi')
  })

  it('derives the folder for a note in the quick bucket', () => {
    expect(toWorkflowNote(meta('quick/Idea.md', { folder: 'quick' })).folder).toBe('quick')
  })

  it('derives the folder for a note in the archive bucket', () => {
    expect(toWorkflowNote(meta('archive/2024/Old.md', { folder: 'archive' })).folder).toBe(
      'archive/2024'
    )
  })

  it('derives the folder for a note in the trash bucket', () => {
    expect(toWorkflowNote(meta('trash/Gone.md', { folder: 'trash' })).folder).toBe('trash')
  })

  it('ignores the system bucket when the path disagrees with it', () => {
    // The bucket is `inbox` but the note lives under `Projects/Alpha`, which is
    // what `in Projects/Alpha` has to match. Reading `NoteMeta.folder` here
    // would make every folder filter silently wrong.
    const note = toWorkflowNote(meta('Projects/Alpha/Spec.md', { folder: 'inbox' }))
    expect(note.folder).toBe('Projects/Alpha')
  })

  it('normalizes a leading ./ or / so the prefix match still hits', () => {
    expect(toWorkflowNote(meta('./inbox/books/Dune.md')).folder).toBe('inbox/books')
    expect(toWorkflowNote(meta('/inbox/Dune.md')).folder).toBe('inbox')
  })
})

describe('toWorkflowNote fields', () => {
  it('carries title, tags and timestamps across', () => {
    const note = toWorkflowNote(
      meta('inbox/Dune.md', { title: 'Dune', tags: ['book', 'scifi'], createdAt: 10, updatedAt: 20 })
    )
    expect(note).toMatchObject({
      path: 'inbox/Dune.md',
      title: 'Dune',
      tags: ['book', 'scifi'],
      createdAt: 10,
      updatedAt: 20
    })
  })

  it('copies the tag array so a step cannot reach back into the store', () => {
    const source = meta('inbox/Dune.md', { tags: ['book'] })
    const note = toWorkflowNote(source)
    note.tags.push('mutated')
    expect(source.tags).toEqual(['book'])
  })

  it('extracts flat frontmatter from the body', () => {
    const note = toWorkflowNote(meta('inbox/Dune.md'), '---\nrating: 5\nfinished: 2026-01-02\n---\nbody\n')
    expect(note.frontmatter).toEqual({ rating: '5', finished: '2026-01-02' })
  })

  it('leaves frontmatter empty when the body has none', () => {
    const note = toWorkflowNote(meta('inbox/Dune.md'), 'just prose\n')
    expect(note.frontmatter).toEqual({})
  })

  it('leaves frontmatter empty when no body has been read', () => {
    const note = toWorkflowNote(meta('inbox/Dune.md'))
    expect(note.frontmatter).toEqual({})
  })

  it('omits body entirely when unread, so the engine can tell it from an empty file', () => {
    expect('body' in toWorkflowNote(meta('inbox/Dune.md'))).toBe(false)
    expect(toWorkflowNote(meta('inbox/Dune.md'), '').body).toBe('')
  })

  it('keeps the raw file text as the body, frontmatter included', () => {
    const raw = '---\nrating: 5\n---\nDune is good\n'
    expect(toWorkflowNote(meta('inbox/Dune.md'), raw).body).toBe(raw)
  })
})

describe('createVaultReader listNotes', () => {
  it('returns one workflow note per note, in order', async () => {
    const reader = createVaultReader({
      notes: [meta('a.md'), meta('inbox/b.md')],
      readBody: async () => ''
    })
    const notes = await reader.listNotes()
    expect(notes.map((n) => n.path)).toEqual(['a.md', 'inbox/b.md'])
    expect(notes.map((n) => n.folder)).toEqual(['', 'inbox'])
  })

  it('exposes frontmatter for notes whose body was already read', async () => {
    const reader = createVaultReader({
      notes: [meta('inbox/Dune.md'), meta('inbox/Emma.md')],
      readBody: async (path) => (path.includes('Dune') ? '---\nrating: 5\n---\n' : 'no fm\n')
    })
    await reader.readBody('inbox/Dune.md')
    const [dune, emma] = await reader.listNotes()
    expect(dune.frontmatter).toEqual({ rating: '5' })
    // Unread: `where rating >= 4` cannot match this one yet, by design.
    expect(emma.frontmatter).toEqual({})
  })
})

describe('createVaultReader body cache', () => {
  it('reads a path at most once however often it is asked for', async () => {
    const readBody = vi.fn(async () => 'text')
    const reader = createVaultReader({ notes: [meta('a.md')], readBody })
    expect(await reader.readBody('a.md')).toBe('text')
    expect(await reader.readBody('a.md')).toBe('text')
    expect(await reader.readBody('a.md')).toBe('text')
    expect(readBody).toHaveBeenCalledTimes(1)
  })

  it('joins concurrent requests for one path into a single read', async () => {
    const readBody = vi.fn(async () => 'text')
    const reader = createVaultReader({ notes: [meta('a.md')], readBody })
    const results = await Promise.all([reader.readBody('a.md'), reader.readBody('a.md')])
    expect(results).toEqual(['text', 'text'])
    expect(readBody).toHaveBeenCalledTimes(1)
  })

  it('reads each distinct path once', async () => {
    const readBody = vi.fn(async (path: string) => `body of ${path}`)
    const reader = createVaultReader({ notes: [meta('a.md'), meta('b.md')], readBody })
    await reader.readBody('a.md')
    await reader.readBody('b.md')
    await reader.readBody('a.md')
    expect(readBody).toHaveBeenCalledTimes(2)
    expect(readBody.mock.calls.map((c) => c[0])).toEqual(['a.md', 'b.md'])
  })

  it('does not retry a read that failed', async () => {
    const readBody = vi.fn(async () => {
      throw new Error('gone')
    })
    const reader = createVaultReader({ notes: [meta('a.md')], readBody })
    await expect(reader.readBody('a.md')).rejects.toThrow('gone')
    await expect(reader.readBody('a.md')).rejects.toThrow('gone')
    expect(readBody).toHaveBeenCalledTimes(1)
  })
})

describe('createVaultReader current and selection', () => {
  it('projects the active note', () => {
    const active = meta('inbox/books/Dune.md')
    const reader = createVaultReader({
      notes: [active],
      readBody: async () => '',
      current: () => active
    })
    expect(reader.current?.()).toMatchObject({ path: 'inbox/books/Dune.md', folder: 'inbox/books' })
  })

  it('returns null when nothing is active', () => {
    const reader = createVaultReader({ notes: [], readBody: async () => '', current: () => null })
    expect(reader.current?.()).toBeNull()
  })

  it('leaves current off the reader when the caller has no active note concept', () => {
    const reader = createVaultReader({ notes: [], readBody: async () => '' })
    // Absent, not "always null": the engine reports the two differently.
    expect(reader.current).toBeUndefined()
  })

  it('projects the selection', () => {
    const picked = [meta('inbox/a.md'), meta('inbox/b.md')]
    const reader = createVaultReader({
      notes: picked,
      readBody: async () => '',
      selection: () => picked
    })
    expect(reader.selection?.().map((n) => n.path)).toEqual(['inbox/a.md', 'inbox/b.md'])
  })

  it('leaves selection off the reader when the caller has no selection concept', () => {
    const reader = createVaultReader({ notes: [], readBody: async () => '' })
    expect(reader.selection).toBeUndefined()
  })

  it('re-reads the callbacks on every call rather than snapshotting them', () => {
    let active: NoteMeta | null = null
    const reader = createVaultReader({
      notes: [],
      readBody: async () => '',
      current: () => active
    })
    expect(reader.current?.()).toBeNull()
    active = meta('inbox/Later.md')
    expect(reader.current?.()?.path).toBe('inbox/Later.md')
  })

  it('gives current and selection the frontmatter of any body already read', async () => {
    const active = meta('inbox/Dune.md')
    const reader = createVaultReader({
      notes: [active],
      readBody: async () => '---\nrating: 5\n---\n',
      current: () => active,
      selection: () => [active]
    })
    expect(reader.current?.()?.frontmatter).toEqual({})
    await reader.readBody('inbox/Dune.md')
    expect(reader.current?.()?.frontmatter).toEqual({ rating: '5' })
    expect(reader.selection?.()[0].frontmatter).toEqual({ rating: '5' })
  })
})
