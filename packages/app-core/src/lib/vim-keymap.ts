import { Vim, getCM } from '@replit/codemirror-vim'
import type { EditorView } from '@codemirror/view'
import { useStore } from '../store'
import { runCommandById } from './commands'
import { makeZenFacade } from './zen-facade'
import { callUserScript } from './user-scripts'

/**
 * User-defined Vim key mappings, Obsidian-vimrc style.
 *
 * One mapping per line: `<command> <lhs> <rhs>`, where command is one of
 * map/noremap and the n/v/i/o mode-prefixed variants. The right-hand side can
 * be one of three kinds:
 *
 *   1. vim keys           nmap k gk
 *   2. a ZenNotes command nmap gT zen:note.daily.today
 *   3. a user JS function nmap ]] zen:tools:jumpHeading(true)
 *
 * Kind 1 applies through `Vim.map` / `Vim.noremap`. Kinds 2 and 3 register a
 * vim action (`Vim.defineAction`) bound with `Vim.mapCommand` — kind 2 runs a
 * registry command, kind 3 evals `<file>.js` from the config dir and calls
 * `<fn>(args)` with a `zen` facade in scope (gated behind `vimJsScriptsEnabled`).
 *
 * LHS keys that contain modifier prefixes (<D-> Cmd, <M->/<A-> Option, <C->
 * Ctrl, <S-> Shift) are routed through a window-level keydown handler instead
 * of the Vim layer, because codemirror-vim has no concept of the macOS Cmd key
 * and browser Alt handling is unreliable inside the vim key model.
 * Example: `nmap <D-M-k> zen:tools:copyPathRef()`
 *
 * `Vim` is a per-renderer global, so each window applies its own copy from
 * prefs (mirrors `applyVimInsertEscape`). We track what we applied so a
 * re-apply unmaps the previous set first. Invalid/unknown lines are skipped
 * with a console warning; blank lines and `"`/`#` comments are ignored.
 */

type Ctx = 'normal' | 'visual' | 'insert' | 'operatorPending'

type Rhs =
  | { kind: 'keys'; keys: string }
  | { kind: 'command'; id: string }
  | { kind: 'script'; file: string; fn: string; args: unknown[]; raw: string }

interface ParsedMapping {
  recursive: boolean
  contexts: Ctx[]
  lhs: string
  rhs: Rhs
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

// zen:<file>:<fn>(<args>) — file is a bare name, fn a JS identifier.
const SCRIPT_RE = /^([\w.-]+):([A-Za-z_$][\w$]*)\((.*)\)$/

function parseArgs(raw: string): unknown[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    // Accepts JSON literals: true/false, numbers, "double-quoted strings".
    return JSON.parse(`[${trimmed}]`) as unknown[]
  } catch {
    console.warn(`[zen:vim-keymap] could not parse arguments: (${raw})`)
    return []
  }
}

function parseRhs(rhs: string): Rhs {
  if (rhs.startsWith('zen:')) {
    const rest = rhs.slice(4)
    const m = rest.match(SCRIPT_RE)
    if (m) return { kind: 'script', file: m[1], fn: m[2], args: parseArgs(m[3]), raw: m[3] }
    return { kind: 'command', id: rest }
  }
  return { kind: 'keys', keys: rhs }
}

export function parseVimKeymap(text: string): ParsedMapping[] {
  const out: ParsedMapping[] = []
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('"') || line.startsWith('#')) continue
    // command, lhs, then rhs (rhs may contain spaces for vim-key sequences).
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
    out.push({
      recursive: spec.recursive,
      contexts: spec.contexts,
      lhs: m[2],
      rhs: parseRhs(m[3].trim())
    })
  }
  return out
}

// ─── Modifier key bindings ────────────────────────────────────────────────────
// LHS patterns like <D-M-k> or <D-Return> are not handled by codemirror-vim
// (it has no <D-> / Cmd concept). We parse them out of the user keymap and
// handle them with a window capture-phase keydown listener instead.

interface ModifierBinding {
  meta: boolean   // <D-> — Cmd on macOS (e.metaKey)
  ctrl: boolean   // <C-> — Ctrl (e.ctrlKey)
  alt: boolean    // <M-> or <A-> — Option/Alt (e.altKey)
  shift: boolean  // <S-> — Shift (e.shiftKey)
  key: string     // lowercased base key for comparison against e.key
  contexts: Ctx[]
  rhs: Rhs
}

// Named vim keys → the value returned by KeyboardEvent.key on that key.
const VIM_KEY_TO_DOM: Record<string, string> = {
  CR: 'Enter', Return: 'Enter', Enter: 'Enter',
  Space: ' ', Tab: 'Tab',
  BS: 'Backspace', Backspace: 'Backspace',
  Esc: 'Escape', Escape: 'Escape',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Del: 'Delete', Delete: 'Delete', Insert: 'Insert',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]))
}

// Matches <modifiers-key> notation.  Each modifier is a single letter
// (D/C/M/A/S, case-insensitive) followed immediately by a literal dash.
// Example captures: "<D-M-k>" → mods="D-M-", key="k"
const MODIFIER_LHS_RE = /^<((?:[DCMASDCMASDcmas]-)+)([^->]+)>$/

function parseModifierLhs(lhs: string): Omit<ModifierBinding, 'contexts' | 'rhs'> | null {
  const m = lhs.match(MODIFIER_LHS_RE)
  if (!m) return null
  const mods = m[1].toUpperCase()
  const rawKey = m[2]
  // Translate named vim keys; single characters are used as-is.
  const domKey = (VIM_KEY_TO_DOM[rawKey] ?? (rawKey.length === 1 ? rawKey : null))?.toLowerCase()
  if (!domKey) {
    console.warn(`[zen:vim-keymap] unknown key name in modifier binding: ${rawKey}`)
    return null
  }
  return {
    meta: mods.includes('D-'),
    ctrl: mods.includes('C-'),
    alt: mods.includes('M-') || mods.includes('A-'),
    shift: mods.includes('S-'),
    key: domKey
  }
}

let modifierBindings: ModifierBinding[] = []
let modifierHandler: ((e: KeyboardEvent) => void) | null = null

function getVimMode(view: EditorView): Ctx {
  if (!useStore.getState().vimMode) return 'normal'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vimState = (getCM(view) as any)?.state?.vim as
    | { insertMode?: boolean; visualMode?: boolean }
    | undefined
  if (vimState?.insertMode) return 'insert'
  if (vimState?.visualMode) return 'visual'
  return 'normal'
}

function runModifierRhs(rhs: Rhs, view: EditorView): void {
  if (rhs.kind === 'command') {
    runCommandById(rhs.id)
  } else if (rhs.kind === 'script') {
    if (!useStore.getState().vimJsScriptsEnabled) {
      console.warn('[zen:vim-keymap] modifier binding skipped — user JS scripts are disabled')
      return
    }
    void callUserScript(rhs.file, rhs.fn, rhs.args, makeZenFacade(view))
  } else {
    // Key-sequence RHS would need synthetic key injection into codemirror-vim,
    // which is non-trivial. Use a zen:command or zen:script RHS instead.
    console.warn('[zen:vim-keymap] key-sequence RHS is not supported for modifier key bindings')
  }
}

function installModifierHandler(): void {
  if (modifierHandler) {
    window.removeEventListener('keydown', modifierHandler, true)
  }
  modifierHandler = (e: KeyboardEvent): void => {
    const view = useStore.getState().editorViewRef
    if (!view?.hasFocus) return
    const mode = getVimMode(view)
    for (const binding of modifierBindings) {
      if (
        e.metaKey === binding.meta &&
        e.ctrlKey === binding.ctrl &&
        e.altKey === binding.alt &&
        e.shiftKey === binding.shift &&
        e.key.toLowerCase() === binding.key
      ) {
        if (!binding.contexts.includes(mode)) continue
        e.preventDefault()
        e.stopPropagation()
        runModifierRhs(binding.rhs, view)
        return
      }
    }
  }
  window.addEventListener('keydown', modifierHandler, true)
}

// ─── Vim-layer bindings ───────────────────────────────────────────────────────

// What we applied last, so the next apply unmaps it before remapping. Covers
// both Vim.map and Vim.mapCommand bindings (Vim.unmap removes either).
let applied: Array<{ lhs: string; ctx: Ctx }> = []

// NOTE: bracket-motion keys (]], [[, ][, []) cannot be overridden here.
// codemirror-vim handles ] and [ via a hardcoded internal state machine that
// runs before any user key map (Vim.map, Vim.noremap, Vim.mapCommand) is
// consulted. Intercepting them would require a CM6-level Prec.highest keymap
// extension with a per-view Compartment registry — too much complexity for
// this use case. Use non-bracket LHS keys instead (e.g. g], g[).
function bindAction(lhs: string, contexts: Ctx[], action: string): Ctx[] {
  const bound: Ctx[] = []
  for (const ctx of contexts) {
    try {
      Vim.mapCommand(lhs, 'action', action, {}, { context: ctx })
      bound.push(ctx)
    } catch (err) {
      console.warn(`[zen:vim-keymap] could not bind ${lhs} in ${ctx}`, err)
    }
  }
  return bound
}

export function applyVimKeymap(text: string): void {
  for (const { lhs, ctx } of applied) {
    try { Vim.unmap(lhs, ctx) } catch { /* ignore — mapping may already be gone */ }
  }
  applied = []
  modifierBindings = []

  const jsEnabled = useStore.getState().vimJsScriptsEnabled

  for (const { recursive, contexts, lhs, rhs } of parseVimKeymap(text)) {
    // Modifier key combos (<D-...>, <M-...>, etc.) bypass the Vim layer.
    const modParsed = parseModifierLhs(lhs)
    if (modParsed) {
      if (rhs.kind === 'keys') {
        console.warn(
          `[zen:vim-keymap] key-sequence RHS not supported for modifier binding: ${lhs} -> ${rhs.keys}`
        )
        continue
      }
      if (rhs.kind === 'script' && !jsEnabled) {
        console.warn(
          `[zen:vim-keymap] skipping ${lhs} -> zen:${rhs.file}:${rhs.fn}() — ` +
            'user JS scripts are disabled (enable them in Settings → Editor → Vim).'
        )
        continue
      }
      modifierBindings.push({ ...modParsed, contexts, rhs })
      continue
    }

    if (rhs.kind === 'keys') {
      for (const ctx of contexts) {
        try {
          if (recursive) Vim.map(lhs, rhs.keys, ctx)
          else Vim.noremap(lhs, rhs.keys, ctx)
          applied.push({ lhs, ctx })
        } catch (err) {
          console.warn(`[zen:vim-keymap] failed to apply: ${lhs} -> ${rhs.keys} (${ctx})`, err)
        }
      }
    } else if (rhs.kind === 'command') {
      const action = `zen:cmd:${rhs.id}`
      Vim.defineAction(action, () => runCommandById(rhs.id))
      for (const ctx of bindAction(lhs, contexts, action)) applied.push({ lhs, ctx })
    } else {
      // script
      if (!jsEnabled) {
        console.warn(
          `[zen:vim-keymap] skipping ${lhs} -> zen:${rhs.file}:${rhs.fn}() — ` +
            'user JS scripts are disabled (enable them in Settings → Editor → Vim).'
        )
        continue
      }
      const { file, fn, args } = rhs
      const action = `zen:js:${file}:${fn}:${rhs.raw}`
      Vim.defineAction(action, (cm: unknown) => {
        const view = (cm as { cm6?: EditorView } | null)?.cm6
        if (!view) return
        void callUserScript(file, fn, args, makeZenFacade(view))
      })
      for (const ctx of bindAction(lhs, contexts, action)) applied.push({ lhs, ctx })
    }
  }

  // Install (or refresh) the modifier key handler whenever the keymap changes.
  // The handler is a no-op when modifierBindings is empty, so leaving it
  // installed is harmless.
  installModifierHandler()

  // Fix: codemirror-vim's gj wraps from the last line to line 1 when the
  // last line is empty. We override gj with a guarded visual-line move.
  // Placed after the user-mapping loop so it wins even when the user has
  // `nmap j gj` — pressing j chains through gj which resolves to this action.
  Vim.defineAction('zen:smartJ', (cm: unknown) => {
    const view = (cm as { cm6?: EditorView } | null)?.cm6
    if (!view) return
    const { doc, selection } = view.state
    const head = selection.main.head
    const line = doc.lineAt(head)
    if (line.number >= doc.lines) return
    const coords = view.coordsAtPos(head)
    if (coords) {
      const next = view.posAtCoords(
        { x: coords.left, y: coords.bottom + view.defaultLineHeight / 2 },
        false
      )
      if (next != null) {
        view.dispatch({ selection: { anchor: next }, scrollIntoView: true })
        return
      }
    }
    const nextLine = doc.line(line.number + 1)
    view.dispatch({
      selection: { anchor: Math.min(nextLine.from + (head - line.from), nextLine.to) },
      scrollIntoView: true,
    })
  })
  Vim.mapCommand('gj', 'action', 'zen:smartJ', {}, { context: 'normal' })
  applied.push({ lhs: 'gj', ctx: 'normal' })
}
