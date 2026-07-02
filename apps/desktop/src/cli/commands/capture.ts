/**
 * `zen capture` — Bear-style quick add. Drops a note into inbox/ (or
 * a chosen folder). Designed to be the friction-free pipe target:
 *
 *   echo "thought" | zen capture
 *   pbpaste | zen capture --tag idea
 *   zen capture "Quick idea about X"
 */

import { createNote } from '../../mcp/vault-ops.js'
import { getBool, getMany, getString, readStdin, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk, truncate } from '../format.js'

export async function cmdCapture(vault: string, args: ParsedArgs): Promise<void> {
  const positional = args.positionals.join(' ').trim()
  const stdin = process.stdin.isTTY ? '' : await readStdin()
  const body = positional || stdin.trim()
  if (!body) {
    throw new Error(
      'zen capture needs text. Pass it as a positional argument or pipe via stdin.'
    )
  }
  const folder = (getString(args, 'folder') as 'inbox' | 'quick' | 'archive' | undefined) ?? 'inbox'
  if (folder !== 'inbox' && folder !== 'quick' && folder !== 'archive') {
    throw new Error('zen capture --folder must be inbox, quick, or archive.')
  }
  const tags = getMany(args, 'tag').map((t) => t.replace(/^#/, ''))

  const titleOverride = getString(args, 'title')
  const title = titleOverride ?? deriveTitle(body)
  const composed = composeBody(title, body, tags)
  const meta = await createNote(vault, folder, title, '', composed)

  if (getBool(args, 'json')) {
    emitJson(meta)
    return
  }
  emitOk(`Captured ${meta.path}`)
  emitLine(`  ${truncate(body.replace(/\s+/g, ' ').trim(), 80)}`)
}

/** First non-empty line, stripped of its leading marker and capped at 60
 *  chars. So a captured task `- [ ] buy milk` titles the note "buy milk"
 *  (the marker still lives in the body). */
export function deriveTitle(body: string): string {
  for (const line of body.split('\n')) {
    const t = stripLeadingMarker(line.trim())
    if (t) return t.slice(0, 60)
  }
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
}

/** Strip a leading heading (`#`), list bullet (`-`/`*`/`+`, `1.`) and/or task
 *  checkbox (`[ ]`/`[x]`) so titles derived from list/task lines read cleanly. */
function stripLeadingMarker(line: string): string {
  return line
    .replace(/^#+\s*/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[[ xX]\]\s*/, '')
    .trim()
}

function composeBody(title: string, body: string, tags: string[]): string {
  const heading = `# ${title}\n\n`
  const tagLine = tags.length > 0 ? tags.map((t) => `#${t}`).join(' ') + '\n\n' : ''
  const trimmed = body.replace(/\n+$/g, '')
  return `${heading}${tagLine}${trimmed}\n`
}
