import { Vim } from '@replit/codemirror-vim'

/**
 * User-defined Vim key mappings, Obsidian-vimrc style.
 *
 * One mapping per line: `<command> <lhs> <rhs>`, where command is one of
 * map/noremap and the n/v/i/o mode-prefixed variants. We parse each line and
 * apply it through `@replit/codemirror-vim`'s `Vim.map` / `Vim.noremap`
 * (recursive vs non-recursive), tracking what we applied so a re-apply can
 * cleanly unmap the previous set first. `Vim` is a per-renderer global, so
 * each window applies its own copy from prefs (mirrors `applyVimInsertEscape`).
 *
 * Invalid or unknown lines are skipped with a console warning. Blank lines and
 * lines starting with `"` (vimrc comment) or `#` are ignored.
 *
 * Future "layer 2" (mapping to ZenNotes commands) can ride the same field by
 * registering ex-commands via `Vim.defineEx` and allowing `:Command` on the rhs.
 */

/** Seeded default mappings (display-line j/k, end-of-line on `-`). */
export const DEFAULT_VIM_KEYMAP = [
  'nmap k gk',
  'nmap j gj',
  'nnoremap - $',
  'vnoremap - $'
].join('\n')

type Ctx = 'normal' | 'visual' | 'insert' | 'operatorPending'

interface ParsedMapping {
  recursive: boolean
  contexts: Ctx[]
  lhs: string
  rhs: string
}

// A bare map/noremap (no mode prefix) applies to normal, visual and
// operator-pending in Vim — expand it so we never pass an undefined context.
const ALL: Ctx[] = ['normal', 'visual', 'operatorPending']

const COMMANDS: Record<string, { contexts: Ctx[]; recursive: boolean }> = {
  map: { contexts: ALL, recursive: true },
  noremap: { contexts: ALL, recursive: false },
  nmap: { contexts: ['normal'], recursive: true },
  nnoremap: { contexts: ['normal'], recursive: false },
  vmap: { contexts: ['visual'], recursive: true },
  vnoremap: { contexts: ['visual'], recursive: false },
  imap: { contexts: ['insert'], recursive: true },
  inoremap: { contexts: ['insert'], recursive: false },
  omap: { contexts: ['operatorPending'], recursive: true },
  onoremap: { contexts: ['operatorPending'], recursive: false }
}

export function parseVimKeymap(text: string): ParsedMapping[] {
  const out: ParsedMapping[] = []
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('"') || line.startsWith('#')) continue
    // command, lhs, then rhs (rhs may contain spaces).
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/)
    if (!m) {
      console.warn(`[zen:vim-keymap] skipping unparseable line: ${rawLine}`)
      continue
    }
    const spec = COMMANDS[m[1].toLowerCase()]
    if (!spec) {
      console.warn(`[zen:vim-keymap] skipping unknown command: ${rawLine}`)
      continue
    }
    out.push({ recursive: spec.recursive, contexts: spec.contexts, lhs: m[2], rhs: m[3].trim() })
  }
  return out
}

// What we applied last, so the next apply unmaps it before remapping.
let applied: Array<{ lhs: string; ctx: Ctx }> = []

export function applyVimKeymap(text: string): void {
  for (const { lhs, ctx } of applied) {
    try {
      Vim.unmap(lhs, ctx)
    } catch {
      /* ignore — mapping may already be gone */
    }
  }
  applied = []

  for (const { recursive, contexts, lhs, rhs } of parseVimKeymap(text)) {
    for (const ctx of contexts) {
      try {
        if (recursive) Vim.map(lhs, rhs, ctx)
        else Vim.noremap(lhs, rhs, ctx)
        applied.push({ lhs, ctx })
      } catch (err) {
        console.warn(`[zen:vim-keymap] failed to apply: ${lhs} -> ${rhs} (${ctx})`, err)
      }
    }
  }
}
