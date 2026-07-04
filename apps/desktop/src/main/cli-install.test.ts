import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// cli-install.ts imports electron's `app` at module load; give it a stub, and
// point HOME at a temp dir so candidateDirs() scans our sandbox, not real bins.
let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userDataDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
    getName: () => 'ZenNotes'
  }
}))

import { removeManagedLinks } from './cli-install'

let home = ''
const tempDirs: string[] = []

/** Existence of the link/file itself (does not follow symlinks). */
const linkExists = async (p: string): Promise<boolean> => {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

const wrapperLoc = (): { wrapperPath: string; cliJsPath: string } => ({
  wrapperPath: path.join(userDataDir, 'zen'),
  cliJsPath: path.join(userDataDir, 'cli.js')
})

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-ud-'))
  home = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-home-'))
  tempDirs.push(userDataDir, home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  await writeFile(wrapperLoc().wrapperPath, '#!/bin/sh\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('removeManagedLinks — migrate off `zen`, spare foreign (#126)', () => {
  it('removes our own zen and zn symlinks', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zn'))

    const removed = await removeManagedLinks(['zen', 'zn'], wrapperLoc())

    expect(await linkExists(path.join(bin, 'zen'))).toBe(false)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(false)
    expect(removed).toEqual(
      expect.arrayContaining([path.join(bin, 'zen'), path.join(bin, 'zn')])
    )
  })

  it('never removes a foreign `zen` (e.g. Zen Browser) or a real file', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const foreign = path.join(userDataDir, 'zen-browser')
    await writeFile(foreign, '#!/bin/sh\n')
    // A foreign `zen` symlink pointing at something that is NOT our wrapper.
    await symlink(foreign, path.join(bin, 'zen'))
    // A real file (not a symlink) named `zn`.
    await writeFile(path.join(bin, 'zn'), '#!/bin/sh\n')

    const removed = await removeManagedLinks(['zen', 'zn'], wrapperLoc())

    expect(removed).not.toContain(path.join(bin, 'zen'))
    expect(removed).not.toContain(path.join(bin, 'zn'))
    expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
    expect(await readlink(path.join(bin, 'zen'))).toBe(foreign)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(true)
  })
})
