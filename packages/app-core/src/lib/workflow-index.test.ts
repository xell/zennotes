import { describe, expect, it } from 'vitest'
import { buildWorkflowIndex } from './workflow-index'

describe('buildWorkflowIndex', () => {
  it('summarizes name, status, and whether any step writes', () => {
    const files = [
      {
        id: 'reading-log',
        sourcePath: '.zennotes/workflows/reading-log.md',
        raw: '---\nname: Reading log\ndescription: Sync it\n---\n\nbooks = tag #book\nbooks | add-tag #x\n'
      },
      {
        id: 'peek',
        sourcePath: '.zennotes/workflows/peek.md',
        raw: '---\nstatus: draft\n---\n\nnotes = all\n'
      }
    ]
    expect(buildWorkflowIndex(files)).toEqual([
      {
        id: 'reading-log',
        name: 'Reading log',
        description: 'Sync it',
        status: 'active',
        mutates: true
      },
      // The name falls back to the id and a missing status reads as the
      // parser's default, so the index answers for every file the view lists.
      { id: 'peek', name: 'peek', description: '', status: 'draft', mutates: false }
    ])
  })

  it('still indexes a file with broken lines', () => {
    const files = [
      {
        id: 'wonky',
        sourcePath: '.zennotes/workflows/wonky.md',
        raw: '---\nname: Wonky\n---\n\nnot-a-verb something\n'
      }
    ]
    expect(buildWorkflowIndex(files)[0]).toMatchObject({ id: 'wonky', name: 'Wonky' })
  })
})
