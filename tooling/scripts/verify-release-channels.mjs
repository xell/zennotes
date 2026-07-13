#!/usr/bin/env node
// Verify that every PUBLIC distribution channel is serving the latest ZenNotes
// release. External package channels (AUR, Homebrew tap) and the website live in
// separate places from the in-repo `packaging/` source of truth, and have been
// silently left stale across releases — this check makes that impossible to miss.
//
// Usage:
//   node tooling/scripts/verify-release-channels.mjs            # check against releases/latest
//   node tooling/scripts/verify-release-channels.mjs 2.13.1     # check against an explicit version
//   ZENNOTES_SITE=https://staging.zennotes.org node scripts/verify-release-channels.mjs
//
// Exit code is non-zero if any channel is STALE or errored (NA channels do not
// fail the run).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SITE = process.env.ZENNOTES_SITE ?? 'https://zennotes.org'
const REPO = 'ZenNotes/zennotes'

// Website download routes that should 302 to a release asset carrying the
// current version. Keep in sync with DownloadController::PLATFORMS on the site.
const SITE_PLATFORMS = [
  'mac',
  'mac-intel',
  'windows',
  'linux-deb',
  'linux-pacman',
  'linux-appimage',
  'linux-rpm',
]

async function getJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'zennotes-verify-channels', ...(opts.headers ?? {}) },
    ...opts,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'zennotes-verify-channels' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// --- target version -------------------------------------------------------
async function resolveTargetVersion() {
  const arg = process.argv[2]?.replace(/^v/, '')
  if (arg) return arg
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`)
  return String(rel.tag_name).replace(/^v/, '')
}

// --- individual channel probes -------------------------------------------
// Each returns { found: string|null } — the version the channel currently
// serves, or null when the channel is not applicable yet (NA).
const CHANNELS = {
  async 'Homebrew tap'() {
    const rb = await getText(
      'https://raw.githubusercontent.com/ZenNotes/homebrew-tap/main/Casks/zennotes.rb',
    )
    const m = rb.match(/version\s+"([^"]+)"/)
    return { found: m?.[1] ?? null }
  },

  async 'AUR (zennotes-bin)'() {
    const j = await getJson(
      'https://aur.archlinux.org/rpc/v5/info?arg%5B%5D=zennotes-bin',
    )
    // AUR Version is "<pkgver>-<pkgrel>"; compare the pkgver part.
    const v = j.results?.[0]?.Version
    return { found: v ? v.split('-')[0] : null }
  },

  async Nix() {
    const data = JSON.parse(
      readFileSync(join(ROOT, 'packaging/nix/release-data.json'), 'utf8'),
    )
    return { found: data.version ?? null }
  },
}

// --- website redirect probes ---------------------------------------------
async function checkWebsite(target) {
  const rows = []
  for (const platform of SITE_PLATFORMS) {
    const url = `${SITE}/download/${platform}`
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual' })
      const loc = res.headers.get('location') ?? ''
      const ok = loc.includes(`/v${target}/`) || loc.includes(`-${target}-`)
      rows.push({
        name: `website /download/${platform}`,
        found: loc ? loc.split('/').pop() : '(no redirect)',
        status: ok ? 'OK' : loc.includes('/releases/latest') ? 'NA' : 'STALE',
      })
    } catch (err) {
      rows.push({ name: `website /download/${platform}`, found: `error: ${err.message}`, status: 'ERROR' })
    }
  }
  return rows
}

// --- run ------------------------------------------------------------------
const target = await resolveTargetVersion()
console.log(`\nVerifying all public channels serve ZenNotes v${target}\n`)

const rows = []
for (const [name, probe] of Object.entries(CHANNELS)) {
  try {
    const { found } = await probe()
    if (found === null) rows.push({ name, found: '(not published yet)', status: 'NA' })
    else rows.push({ name, found, status: found === target ? 'OK' : 'STALE' })
  } catch (err) {
    rows.push({ name, found: `error: ${err.message}`, status: 'ERROR' })
  }
}
rows.push(...(await checkWebsite(target)))

const ICON = { OK: '✓ OK   ', STALE: '✗ STALE', NA: '- NA   ', ERROR: '! ERROR' }
const pad = Math.max(...rows.map((r) => r.name.length))
for (const r of rows) {
  console.log(`  ${ICON[r.status]}  ${r.name.padEnd(pad)}  ${r.found}`)
}

const bad = rows.filter((r) => r.status === 'STALE' || r.status === 'ERROR')
console.log('')
if (bad.length) {
  console.error(
    `${bad.length} channel(s) are not serving v${target}. ` +
      `Publish them (see packaging/PUBLISHING.md) and re-run.\n`,
  )
  process.exit(1)
}
console.log(`All applicable channels serve v${target}.\n`)
