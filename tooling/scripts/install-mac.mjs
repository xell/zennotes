#!/usr/bin/env node
// Replace /Applications/ZenNotes.app with the locally built app, no Finder,
// no prompts. Quits a running instance first, copies the freshly built bundle
// with `ditto` (the macOS-native, metadata-preserving copy), then relaunches.
//
// Personal convenience helper; expects a prior `npm run pack` (or dist:mac).
// Run directly to install the last build without rebuilding:
//   node tooling/scripts/install-mac.mjs
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = 'ZenNotes'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// electron-builder names the output dir by arch (mac-arm64 / mac-x64), or just
// `mac` for a single-arch x64 build. Pick whichever exists.
const src = ['mac-arm64', 'mac-x64', 'mac']
  .map((d) => resolve(repoRoot, 'dist', d, `${APP}.app`))
  .find(existsSync)

if (!src) {
  console.error(
    `No built ${APP}.app found under dist/. Run "npm run pack" (or "npm run dist:mac") first.`
  )
  process.exit(1)
}

const dest = `/Applications/${APP}.app`
const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const quiet = (cmd) => {
  try {
    execSync(cmd, { stdio: 'ignore' })
  } catch {
    // best-effort (app may not be running)
  }
}

console.log(`Quitting ${APP} if it is running…`)
quiet(`osascript -e 'quit app "${APP}"'`)
quiet('sleep 1')

console.log(`Installing ${src}\n         → ${dest}`)
run(`rm -rf "${dest}"`)
run(`ditto "${src}" "${dest}"`)

console.log(`Relaunching ${APP}…`)
run(`open "${dest}"`)
console.log('Done.')
