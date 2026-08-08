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

// The installer asks the user's LOGIN shell for its PATH (#528), which would
// otherwise drag this suite back onto the developer's own machine setup, the
// exact dependence the PATH override below exists to remove. Tests drive it
// through `loginShellPathDirs` instead.
const loginShellPathDirs = vi.hoisted(() => ({ value: [] as string[] }))
vi.mock('./login-shell-path', () => ({
  resolveLoginShellPathDirs: async () => loginShellPathDirs.value,
  resolveCommandViaLoginShell: async () => null
}))

import { getCliInstallStatus, migrateLegacyCliLink, removeManagedLinks } from './cli-install'

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

let realPath: string | undefined

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-ud-'))
  home = await mkdtemp(path.join(os.tmpdir(), 'zn-cli-home-'))
  tempDirs.push(userDataDir, home)
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  // Candidate-directory discovery walks the REAL $PATH as well as the home
  // dirs, so a developer who has actually installed the CLI (which every
  // ZenNotes user now has, since the app heals the link on launch) would see
  // `migrateLegacyCliLink` correctly decline against their own `zn` and this
  // suite fail on their machine but not in CI. Point PATH at the temp home so
  // the discovery can only find what a test put there.
  realPath = process.env.PATH
  process.env.PATH = path.join(home, '.local', 'bin')
  loginShellPathDirs.value = []
  await writeFile(wrapperLoc().wrapperPath, '#!/bin/sh\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (realPath === undefined) delete process.env.PATH
  else process.env.PATH = realPath
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

describe('migrateLegacyCliLink — heal pre-2.10 installs on launch', () => {
  // The heal is a symlink operation over POSIX bin dirs; `migrateLegacyCliLink`
  // deliberately declines off darwin/linux (a pre-2.10 symlink install never
  // existed on Windows), so the positive path is asserted where it can run and
  // the platform gate is pinned separately below.
  it.skipIf(process.platform === 'win32')(
    'replaces a managed `zen` with `zn` in the same directory',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))

      const linkPath = await migrateLegacyCliLink(wrapperLoc())

      expect(linkPath).toBe(path.join(bin, 'zn'))
      expect(await readlink(path.join(bin, 'zn'))).toBe(wrapperLoc().wrapperPath)
      // The legacy name is gone, so `zen` stops shadowing anything (#126).
      expect(await linkExists(path.join(bin, 'zen'))).toBe(false)
    }
  )

  it.runIf(process.platform === 'win32')(
    'declines on Windows even with a managed legacy link present',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))

      expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
      expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
    }
  )

  it('does nothing when `zn` already exists', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zen'))
    await symlink(wrapperLoc().wrapperPath, path.join(bin, 'zn'))

    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
    // In particular the legacy link is left alone: migration is one atomic
    // pair of steps or nothing, never a delete on its own.
    expect(await linkExists(path.join(bin, 'zen'))).toBe(true)
  })

  it('never touches a foreign `zen` (Zen Browser)', async () => {
    const bin = path.join(home, '.local', 'bin')
    await mkdir(bin, { recursive: true })
    const foreign = path.join(userDataDir, 'zen-browser')
    await writeFile(foreign, '#!/bin/sh\n')
    await symlink(foreign, path.join(bin, 'zen'))

    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
    expect(await readlink(path.join(bin, 'zen'))).toBe(foreign)
    expect(await linkExists(path.join(bin, 'zn'))).toBe(false)
  })

  it('is a no-op on a machine with nothing installed', async () => {
    expect(await migrateLegacyCliLink(wrapperLoc())).toBeNull()
  })
})

describe('PATH detection follows the user\'s shell, not the app\'s (#528)', () => {
  // A Finder / Dock launch on macOS inherits launchd's minimal PATH and never
  // reads the user's profile, so `process.env.PATH` says ~/.local/bin is
  // missing while the user's terminal has had it all along. Reading only that
  // produced a warning, and a pointless `export PATH=...` snippet, for a
  // directory that was already set up correctly.
  const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

  it.skipIf(process.platform === 'win32')(
    'reports a dir as on PATH when only the login shell knows about it',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = LAUNCHD_PATH
      loginShellPathDirs.value = ['/opt/homebrew/bin', bin, '/usr/bin', '/bin']

      const status = await getCliInstallStatus()

      expect(status.defaultTarget).toBe(path.join(bin, 'zn'))
      expect(status.targetOnPath).toBe(true)
      // Nothing to tell the user to add: it is already there.
      expect(status.pathHint).toBeNull()
      expect(status.requiresSudo).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'still warns when the dir really is missing from both',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = LAUNCHD_PATH
      // Only root-owned dirs on PATH, so no candidate is both on PATH and
      // writable and the installer has to fall back to creating ~/.local/bin.
      // (/opt/homebrew/bin would be a legitimate pick where it exists, which is
      // the installer working, not the warning path under test.)
      loginShellPathDirs.value = ['/usr/bin', '/bin']

      const status = await getCliInstallStatus()

      expect(status.defaultTarget).toBe(path.join(bin, 'zn'))
      expect(status.targetOnPath).toBe(false)
      expect(status.pathHint).toContain(bin)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'falls back to the process PATH when no shell answers',
    async () => {
      const bin = path.join(home, '.local', 'bin')
      await mkdir(bin, { recursive: true })
      process.env.PATH = bin
      loginShellPathDirs.value = []

      const status = await getCliInstallStatus()

      expect(status.targetOnPath).toBe(true)
      expect(status.pathHint).toBeNull()
    }
  )
})
