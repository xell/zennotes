import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend } from '../backend'
import type { ParsedArgs } from '../args'
import { cmdBaseAdd, cmdBaseCreate, cmdBaseGet, cmdBaseList, cmdBaseRows, cmdBaseSet } from './base'

function makeArgs(positionals: string[], flags: Array<[string, string]> = []): ParsedArgs {
  const map = new Map<string, string[]>()
  for (const [k, v] of flags) map.set(k, [...(map.get(k) ?? []), v])
  return { positionals, flags: map }
}

let tmpDir: string
let root: string
let dbDir: string
let out: string[]

const lastJson = (): Record<string, unknown> => JSON.parse(out.join('')) as Record<string, unknown>

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-base-cli-'))
  root = path.join(tmpDir, 'vault')
  dbDir = path.join(root, 'inbox', 'Meetings.base')
  for (const d of ['inbox', 'quick', 'archive', 'trash']) {
    await fsp.mkdir(path.join(root, d), { recursive: true })
  }
  await fsp.mkdir(dbDir, { recursive: true })
  await fsp.writeFile(
    path.join(dbDir, 'data.csv'),
    'id,Name,Project,Ref\nrow-1,Kickoff,,\n'
  )
  await fsp.writeFile(
    path.join(dbDir, 'schema.json'),
    JSON.stringify({
      version: 1,
      idFieldId: 'f_id',
      fields: [
        { id: 'f_id', name: 'id', type: 'text', hidden: true },
        { id: 'f_name', name: 'Name', type: 'text' },
        { id: 'f_project', name: 'Project', type: 'select', options: [] },
        { id: 'f_ref', name: 'Ref', type: 'note' }
      ],
      views: [{ id: 'v1', name: 'Table', type: 'table', filters: [], sorts: [] }],
      activeViewId: 'v1'
    })
  )
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  out = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
})

const backend = (): ReturnType<typeof createBackend> => createBackend({ kind: 'local', root })

describe('zn base', () => {
  it('lists databases', async () => {
    await cmdBaseList(backend(), makeArgs([], [['json', 'true']]))
    const rows = JSON.parse(out.join('')) as Array<{ title: string; path: string }>
    expect(rows.map((d) => d.title)).toContain('Meetings')
  })

  it('adds a row with grid semantics: select options mint, a body makes a page', async () => {
    await cmdBaseAdd(
      backend(),
      makeArgs(
        ['Meetings'],
        [
          ['set', 'Name=Retro'],
          ['set', 'Project=Acme'],
          ['set', 'Ref=[[Some Note]]'],
          ['body', 'Summary of the retro.'],
          ['json', 'true']
        ]
      )
    )
    const added = lastJson()
    expect(added.ok).toBe(true)
    expect((added.cells as Record<string, string>).Project).toBe('Acme')

    const csv = await fsp.readFile(path.join(dbDir, 'data.csv'), 'utf8')
    expect(csv).toContain('Retro,Acme,[[Some Note]]')

    const schema = JSON.parse(await fsp.readFile(path.join(dbDir, 'schema.json'), 'utf8')) as {
      fields: Array<{ name: string; options?: Array<{ value: string }> }>
      pages?: Record<string, string>
    }
    expect(schema.fields.find((f) => f.name === 'Project')?.options?.map((o) => o.value)).toEqual([
      'Acme'
    ])
    expect(Object.values(schema.pages ?? {})).toContain('Retro.md')

    const page = await fsp.readFile(path.join(dbDir, 'Retro.md'), 'utf8')
    expect(page).toContain('Project: Acme')
    expect(page).toContain('Ref: "[[Some Note]]"')
    expect(page).toContain('# Retro')
    expect(page).toContain('Summary of the retro.')
  })

  it('resolves rows by title and reports them', async () => {
    await cmdBaseGet(backend(), makeArgs(['Meetings', 'Retro'], [['json', 'true']]))
    const row = lastJson()
    expect((row.cells as Record<string, string>).Project).toBe('Acme')
    expect(row.page).toBeTruthy()

    out = []
    await cmdBaseRows(backend(), makeArgs(['inbox/Meetings.base'], [['json', 'true']]))
    const rows = JSON.parse(out.join('')) as Array<{ title: string }>
    expect(rows.map((r) => r.title)).toEqual(['Kickoff', 'Retro'])
  })

  it('sets fields and re-mirrors the page frontmatter, preserving the body', async () => {
    await cmdBaseSet(
      backend(),
      makeArgs(['Meetings', 'Retro'], [
        ['set', 'Project=Beta'],
        ['json', 'true']
      ])
    )
    const updated = lastJson()
    expect((updated.cells as Record<string, string>).Project).toBe('Beta')

    const schema = JSON.parse(await fsp.readFile(path.join(dbDir, 'schema.json'), 'utf8')) as {
      fields: Array<{ name: string; options?: Array<{ value: string }> }>
    }
    expect(
      schema.fields.find((f) => f.name === 'Project')?.options?.map((o) => o.value)
    ).toEqual(['Acme', 'Beta'])

    const page = await fsp.readFile(path.join(dbDir, 'Retro.md'), 'utf8')
    expect(page).toContain('Project: Beta')
    expect(page).toContain('Summary of the retro.')
  })

  it('creates a database and rejects unknown fields helpfully', async () => {
    await cmdBaseCreate(backend(), makeArgs(['Logbook'], [['json', 'true']]))
    const created = lastJson()
    expect(created.path).toBe('inbox/Logbook.base/data.csv')

    await expect(
      cmdBaseSet(backend(), makeArgs(['Meetings', 'Retro'], [['set', 'Nope=1']]))
    ).rejects.toThrow(/No field named "Nope"/)
  })
})
