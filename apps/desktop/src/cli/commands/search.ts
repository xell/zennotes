/**
 * Full-text search and backlink lookup. Both use vault-ops directly,
 * matching the MCP server's behavior so CLI output matches what an
 * agent would see.
 */

import { backlinks, listNotes, searchText } from '../../mcp/vault-ops.js'
import { getBool, getNumber, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, pad, truncate } from '../format.js'

export async function cmdSearch(vault: string, args: ParsedArgs): Promise<void> {
  const query = getString(args, 'query') ?? args.positionals.join(' ')
  if (!query.trim()) throw new Error('zn search requires a query.')
  const limit = getNumber(args, 'limit') ?? 50
  const matches = await searchText(vault, query.trim(), limit)
  if (getBool(args, 'json')) {
    emitJson(matches)
    return
  }
  if (matches.length === 0) {
    emitLine(`No matches for "${query}".`)
    return
  }
  for (const m of matches) {
    emitLine(`${pad(`${m.path}:${m.lineNumber}`, 48)}  ${truncate(m.lineText, 100)}`)
  }
}

export async function cmdSearchTitle(vault: string, args: ParsedArgs): Promise<void> {
  const query = getString(args, 'query') ?? args.positionals.join(' ')
  if (!query.trim()) throw new Error('zn search-title requires a query.')
  const needle = query.trim().toLowerCase()
  const limit = getNumber(args, 'limit') ?? 20
  const all = await listNotes(vault)
  const matches = all
    .filter((n) => n.folder !== 'trash' && n.title.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
  if (getBool(args, 'json')) {
    emitJson(matches)
    return
  }
  if (matches.length === 0) {
    emitLine(`No notes matching "${query}".`)
    return
  }
  for (const n of matches) emitLine(n.path)
}

export async function cmdBacklinks(vault: string, args: ParsedArgs): Promise<void> {
  const rel = getString(args, 'path') ?? args.positionals[0]
  if (!rel) throw new Error('zn backlinks requires a note path.')
  const refs = await backlinks(vault, rel)
  if (getBool(args, 'json')) {
    emitJson(refs)
    return
  }
  if (refs.length === 0) {
    emitLine(`No notes link to ${rel}.`)
    return
  }
  for (const ref of refs) emitLine(ref.path)
}
