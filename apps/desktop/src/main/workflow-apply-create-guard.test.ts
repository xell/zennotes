import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyWorkflowOps } from './workflow-apply'
const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))) })
describe('create-note guard', () => {
  it('refuses to replace an existing note and rolls back', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wf-guard-')); dirs.push(root)
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    const precious = '# Important\n\nYears of notes live here.\n'
    await writeFile(path.join(root, 'inbox', 'Existing.md'), precious)
    const r = await applyWorkflowOps(root, { workflowId: 'p', ops: [{ kind: 'create-note', path: 'inbox/Existing.md', body: '' }] })
    expect(r.rolledBack).toBeTruthy()
    expect(await readFile(path.join(root, 'inbox', 'Existing.md'), 'utf8')).toBe(precious)
  })
  it('still creates a note at a free path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'wf-guard2-')); dirs.push(root)
    await mkdir(path.join(root, 'inbox'), { recursive: true })
    const r = await applyWorkflowOps(root, { workflowId: 'p', ops: [{ kind: 'create-note', path: 'inbox/New.md', body: '# New\n' }] })
    expect(r.rolledBack).toBeUndefined()
    expect(await readFile(path.join(root, 'inbox', 'New.md'), 'utf8')).toContain('# New')
  })
})
