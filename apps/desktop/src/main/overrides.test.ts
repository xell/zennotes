import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getOverridesDir,
  ensureOverridesDir,
  listOverrides,
  deleteOverride,
  overrideRevealTarget
} from './overrides'

let tmp: string
const original = process.env.ZENNOTES_CONFIG_DIR

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'zen-sn-'))
  process.env.ZENNOTES_CONFIG_DIR = tmp
})
afterEach(async () => {
  if (original === undefined) delete process.env.ZENNOTES_CONFIG_DIR
  else process.env.ZENNOTES_CONFIG_DIR = original
  await rm(tmp, { recursive: true, force: true })
})

describe('overrides (main)', () => {
  it('seeds an example + README on first run, lists only .css', async () => {
    await ensureOverridesDir()
    const dir = getOverridesDir()
    expect(existsSync(join(dir, 'example.css'))).toBe(true)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    const list = await listOverrides()
    expect(list.map((s) => s.name)).toEqual(['example.css']) // README.md excluded
    expect(list[0].css).toContain(':root[data-theme]')
  })

  it('reveal target is the file for a valid name, the dir otherwise (no traversal)', async () => {
    await ensureOverridesDir()
    const dir = getOverridesDir()
    expect(await overrideRevealTarget('example.css')).toBe(join(dir, 'example.css'))
    expect(await overrideRevealTarget('missing.css')).toBe(dir)
    expect(await overrideRevealTarget(undefined)).toBe(dir)
    expect(await overrideRevealTarget('../secret.css')).toBe(dir)
    expect(await overrideRevealTarget('README.md')).toBe(dir) // not a .css
  })

  it('deletes only a bare .css name inside the overrides dir', async () => {
    await ensureOverridesDir()
    const dir = getOverridesDir()
    const outside = join(tmp, 'secret.css')
    await writeFile(outside, 'keep me')

    await deleteOverride('../secret.css') // traversal → no-op
    expect(existsSync(outside)).toBe(true)

    await deleteOverride('README.md') // not a .css → no-op
    expect(existsSync(join(dir, 'README.md'))).toBe(true)

    await deleteOverride('example.css')
    expect(existsSync(join(dir, 'example.css'))).toBe(false)
  })
})
