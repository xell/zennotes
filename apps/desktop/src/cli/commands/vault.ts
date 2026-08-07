/**
 * `zn vault info` — print the resolved vault + a small sanity snapshot.
 * Useful as a sanity check after install (`zn vault info` should match what
 * the GUI shows), and after `--server` (it should name the server).
 *
 * `zn vault list` — every vault and every ZenNotes server the app knows
 * about, the default marked with `*`. Point any other command at one with
 * `--vault <name|path>` or `--server <name|url>`.
 */

import path from 'node:path'
import {
  readKnownVaultsFromConfig,
  readRemoteProfilesFromConfig,
  resolveVaultRoot
} from '../../mcp/vault-ops.js'
import { getBool, type ParsedArgs } from '../args.js'
import type { VaultBackend } from '../backend.js'
import { emitJson, emitLine, formatRelativeAge, pad } from '../format.js'

export async function cmdVaultInfo(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const [notes, subfolders] = await Promise.all([vault.listNotes(), vault.listFolders()])
  const counts = {
    inbox: 0,
    quick: 0,
    archive: 0,
    trash: 0
  }
  for (const n of notes) counts[n.folder] += 1

  const summary = {
    vaultRoot: vault.label,
    kind: vault.kind,
    counts,
    subfolderCount: subfolders.length
  }
  if (getBool(args, 'json')) {
    emitJson(summary)
    return
  }
  emitLine(`${vault.kind === 'remote' ? 'Server' : 'Vault'}: ${vault.label}`)
  emitLine(`  inbox:   ${counts.inbox}`)
  emitLine(`  quick:   ${counts.quick}`)
  emitLine(`  archive: ${counts.archive}`)
  emitLine(`  trash:   ${counts.trash}`)
  emitLine(`  subfolders: ${subfolders.length}`)
}

/** `kind` and `baseUrl` are additive: a local entry still carries the `root`
 *  key it always has, so scripts reading `zn vault list --json` keep working
 *  now that servers appear in the same list (#493). */
interface VaultListEntry {
  name: string
  kind: 'local' | 'remote'
  root?: string
  baseUrl?: string
  lastOpenedAt: number | null
  isDefault: boolean
}

export async function cmdVaultList(args: ParsedArgs): Promise<void> {
  const [known, profiles] = await Promise.all([
    readKnownVaultsFromConfig(),
    readRemoteProfilesFromConfig()
  ])
  // The vault commands without --vault / --server would use this one — mark it.
  const defaultRoot = await resolveVaultRoot().catch(() => null)

  const entries: VaultListEntry[] = [
    ...known.map((vault) => ({
      name: vault.name,
      kind: 'local' as const,
      root: vault.root,
      lastOpenedAt: vault.lastOpenedAt,
      isDefault: defaultRoot !== null && path.resolve(vault.root) === defaultRoot
    })),
    ...profiles.map((profile) => ({
      name: profile.name,
      kind: 'remote' as const,
      baseUrl: profile.baseUrl,
      lastOpenedAt: profile.lastConnectedAt,
      isDefault: false
    }))
  ]

  if (getBool(args, 'json')) {
    emitJson(entries)
    return
  }

  if (entries.length === 0) {
    emitLine('No vaults known yet. Open one in ZenNotes, or pass --vault <path>.')
    return
  }

  const nameWidth = Math.max(...entries.map((entry) => entry.name.length), 4)
  const kindWidth = entries.some((entry) => entry.kind === 'remote') ? 6 : 0
  for (const entry of entries) {
    const marker = entry.isDefault ? '*' : ' '
    const age = entry.lastOpenedAt != null ? formatRelativeAge(entry.lastOpenedAt) : ''
    // The kind column only appears once a server is saved, so a purely local
    // setup keeps the output it has always had.
    const kind = kindWidth ? `${pad(entry.kind, kindWidth)}  ` : ''
    const location = entry.root ?? entry.baseUrl ?? ''
    emitLine(`${marker} ${pad(entry.name, nameWidth)}  ${kind}${pad(age, 8)}  ${location}`)
  }
}
