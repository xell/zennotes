#!/usr/bin/env node
// Re-sign the built dist ZenNotes.app with a STABLE certificate and NO secure
// timestamp. TCC (the macOS permission ledger) keys the Accessibility grant to
// the app's signing identity, so a stable cert means the grant is remembered
// across rebuilds. The slow part of a normal Developer ID build is the secure
// timestamp (a network round-trip per binary), which is only needed for
// notarization/distribution — not for an app you run locally. Dropping it takes
// signing from minutes to seconds while keeping the same identity.
//
// Identity resolution: $ZEN_SIGN_IDENTITY if set, else the first "Developer ID
// Application" identity in the keychain, else the first available code-signing
// identity. A self-signed "Code Signing" cert works too — just set
// ZEN_SIGN_IDENTITY to its name (or let auto-detect find it when it is the only
// one). Local use only: non-hardened, never notarized; Gatekeeper does not
// block locally-built apps.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const app = ['mac-arm64', 'mac-x64', 'mac']
  .map((d) => resolve(repoRoot, 'dist', d, 'ZenNotes.app'))
  .find(existsSync)

if (!app) {
  console.error('No built ZenNotes.app under dist/. Build it first (pack:adhoc).')
  process.exit(1)
}

function resolveIdentity() {
  if (process.env.ZEN_SIGN_IDENTITY) return process.env.ZEN_SIGN_IDENTITY
  let out = ''
  try {
    out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
  } catch (err) {
    console.error('Could not query code-signing identities:', err.message)
    process.exit(1)
  }
  const names = [...out.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  // Prefer Developer ID (stable and the same identity install:mac[:quick] use,
  // so the Accessibility grant is shared with those builds).
  return (
    names.find((n) => n.startsWith('Developer ID Application')) ??
    names.find((n) => n.startsWith('Apple Development')) ??
    names[0] ??
    null
  )
}

const identity = resolveIdentity()
if (!identity) {
  console.error(
    'No code-signing identity found. Set ZEN_SIGN_IDENTITY, or create a\n' +
      'self-signed "Code Signing" certificate in Keychain Access ->\n' +
      'Certificate Assistant -> Create a Certificate.'
  )
  process.exit(1)
}

const codesign = (args) => execFileSync('codesign', args, { stdio: 'inherit' })

console.log(`Signing ${app}\n  identity: ${identity} (no timestamp)`)
// --deep --force re-signs every nested binary with our identity; --timestamp=none
// keeps it offline. No hardened runtime for local use (so no entitlements and no
// library-validation friction for native modules like node-pty).
codesign(['--deep', '--force', '--timestamp=none', '--sign', identity, app])
// Refuse to install a broken bundle.
codesign(['--verify', '--deep', '--strict', '--verbose=2', app])
console.log('Signed OK.')
