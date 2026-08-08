import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { webDistLockEnv, withWebDistLock } from './web-dist-lock.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const webDistIndex = resolve(repoRoot, 'apps/web/dist/index.html')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function fileExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function run(command, args, cwd = repoRoot, options = {}) {
  const shell = options.shell ?? false
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell,
      env: options.env ?? process.env
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
    })
    child.on('error', rejectPromise)
  })
}

// The build and the sync run under one lock. Two turbo tasks arriving at once
// would otherwise both spawn `vite build` into apps/web/dist, and vite empties
// its outDir before writing, so the loser could stage a half-written tree into
// the server bundle. The second one through finds index.html already there and
// only syncs. The child processes inherit the lock rather than wait on it.
await withWebDistLock(async (lock) => {
  const env = webDistLockEnv(lock)
  if (!(await fileExists(webDistIndex))) {
    await run(npmCommand, ['run', 'build', '--workspace', '@zennotes/web'], repoRoot, {
      shell: process.platform === 'win32',
      env
    })
  }
  await run(process.execPath, [resolve(repoRoot, 'tooling/scripts/sync-web-dist.mjs')], repoRoot, { env })
})
