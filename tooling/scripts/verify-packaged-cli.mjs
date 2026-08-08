// Runs the built `zen` CLI the way a packaged app runs it: from a directory
// with no node_modules anywhere above it.
//
// `cli.js` and its chunks ship as extraResources, so they land outside the asar
// and outside any node_modules. A dependency left external there cannot be
// resolved at all, and the failure is invisible from a repo checkout because
// the repo's own node_modules sits a few directories up and answers every
// require. 2.20.2 shipped exactly that: `Cannot find module 'smol-toml'` on the
// CLI's first line, on every platform, reported as #524.
//
// Copying the build output somewhere isolated and running it is the whole test.
// It costs about a second and it catches every future external, which a list of
// known-bad package names never would.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const outMain = resolve(repoRoot, 'apps/desktop/out/main')
const cliEntry = join(outMain, 'cli.js')
const chunksDir = join(outMain, 'chunks')

if (!existsSync(cliEntry)) {
  console.error(
    `verify-packaged-cli: ${cliEntry} is missing. Run the desktop build before this check.`
  )
  process.exit(1)
}

// mkdtemp under the OS temp root on purpose: nothing above it has a
// node_modules, which is the property being tested. Staging inside the repo
// would let the repo's own dependencies answer the requires and pass a build
// that is broken for users.
const stage = mkdtempSync(join(tmpdir(), 'zennotes-cli-verify-'))
try {
  cpSync(cliEntry, join(stage, 'cli.js'))
  if (existsSync(chunksDir)) cpSync(chunksDir, join(stage, 'chunks'), { recursive: true })

  const result = spawnSync(process.execPath, [join(stage, 'cli.js'), '--help'], {
    cwd: stage,
    encoding: 'utf8',
    timeout: 30_000,
    // A bare env: the CLI must not need anything the packaged app would not have.
    env: { PATH: process.env.PATH ?? '', HOME: stage }
  })

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const moduleNotFound = output.includes('MODULE_NOT_FOUND') || output.includes('Cannot find module')

  if (moduleNotFound || result.status !== 0) {
    const missing = output.match(/Cannot find module '([^']+)'/)?.[1]
    console.error('verify-packaged-cli: the built CLI cannot run from a packaged layout.\n')
    if (missing) {
      console.error(
        `  Missing at runtime: ${missing}\n` +
          `  Fix: add '${missing}' to PACKAGED_CLI_RUNTIME_PACKAGES in\n` +
          `  apps/desktop/electron.vite.config.ts so it is bundled instead of externalized.\n`
      )
    }
    console.error(output.trim().split('\n').slice(0, 25).join('\n'))
    process.exit(1)
  }

  console.log('verify-packaged-cli: CLI runs with no node_modules available. OK')
} finally {
  rmSync(stage, { recursive: true, force: true })
}
