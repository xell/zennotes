/**
 * Notion-style paste menu: paste a URL onto an empty line and a small menu
 * offers to turn it into an **Embed** (player/iframe), a **Bookmark** (rich link
 * card), or keep it as a plain **URL**. The URL is inserted immediately; the
 * choice just rewrites it, so choosing URL (or typing) leaves the plain link.
 *
 * The trigger is mechanism-agnostic: the DOM `paste` handler covers Cmd/Ctrl+V,
 * and a transactionExtender catches the same single-URL-on-an-empty-line insert
 * from vim's `p`/`P` (which never fires a DOM paste event) or any programmatic
 * paste. Both converge on the one `setPasteMenu` effect.
 *
 * Scoped to the empty-line case so a fence always lands on its own lines and we
 * never hijack a paste into the middle of a sentence.
 */
import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view'

interface PasteMenu {
  from: number
  to: number
  url: string
}

const setPasteMenu = StateEffect.define<PasteMenu | null>()

/**
 * The open menu's keyboard controller, so the editor keymap (j/k/arrows/Enter)
 * can drive the tooltip's highlight without rebuilding it. One entry per view;
 * the tooltip installs it on create and removes it on destroy.
 */
interface MenuController {
  active: number
  setActive: (index: number) => void
  activate: () => void
}
const controllers = new WeakMap<EditorView, MenuController>()

function isSingleUrl(text: string): boolean {
  if (/\s/.test(text)) return false
  if (!/^https?:\/\/\S+$/i.test(text)) return false
  try {
    new URL(text)
    return true
  } catch {
    return false
  }
}

function replaceWithFence(view: EditorView, menu: PasteMenu, lang: 'embed' | 'bookmark'): void {
  const line = view.state.doc.lineAt(menu.from)
  const insert = `\`\`\`${lang}\n${menu.url}\n\`\`\``
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + insert.length },
    effects: setPasteMenu.of(null)
  })
  view.focus()
}

function menuTooltip(menu: PasteMenu): Tooltip {
  return {
    pos: menu.from,
    above: false,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const dom = document.createElement('div')
      dom.className = 'cm-url-paste-menu'

      const header = document.createElement('div')
      header.className = 'cm-url-paste-header'
      header.textContent = 'Paste as'
      dom.appendChild(header)

      const items: HTMLButtonElement[] = []
      const actions: Array<() => void> = []
      const mk = (label: string, sub: string, onClick: () => void): void => {
        const index = items.length
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'cm-url-paste-item'
        btn.innerHTML = `<span class="cm-url-paste-label">${label}</span><span class="cm-url-paste-sub">${sub}</span>`
        btn.addEventListener('mousedown', (e) => e.preventDefault())
        btn.addEventListener('mouseenter', () => controller.setActive(index))
        btn.addEventListener('click', (e) => {
          e.preventDefault()
          onClick()
        })
        items.push(btn)
        actions.push(onClick)
        dom.appendChild(btn)
      }
      mk('Embed', 'Video or interactive player', () => replaceWithFence(view, menu, 'embed'))
      mk('Bookmark', 'Rich link preview card', () => replaceWithFence(view, menu, 'bookmark'))
      // "URL" keeps the pasted link as a plain (already auto-linked) URL, matching
      // Notion's wording; nothing to rewrite, so it just closes the menu.
      mk('URL', 'Keep as a plain link', () => view.dispatch({ effects: setPasteMenu.of(null) }))

      // Keyboard controller: j/k/arrows move the highlight, Enter picks it. Driven
      // by the editor keymap below via the per-view registry, so navigating never
      // rebuilds the tooltip (no dispatch, just class toggles).
      const controller: MenuController = {
        active: 0,
        setActive(index: number) {
          const n = items.length
          this.active = ((index % n) + n) % n
          items.forEach((b, i) => b.classList.toggle('cm-url-paste-active', i === this.active))
        },
        activate() {
          actions[this.active]?.()
        }
      }
      controller.setActive(0)
      controllers.set(view, controller)

      return {
        dom,
        destroy() {
          if (controllers.get(view) === controller) controllers.delete(view)
        }
      }
    }
  }
}

const pasteMenuField = StateField.define<PasteMenu | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPasteMenu)) return e.value
    if (!value) return null
    // Close as soon as the user edits (typing past the URL) or moves the caret
    // out of the pasted URL — the menu is a transient just-pasted affordance.
    if (tr.docChanged) return null
    if (tr.selection) {
      const head = tr.state.selection.main.head
      if (head < value.from || head > value.to) return null
    }
    return value
  },
  provide: (f) => showTooltip.from(f, (menu) => (menu ? menuTooltip(menu) : null))
})

const pasteHandler = EditorView.domEventHandlers({
  paste: (event, view) => {
    const text = event.clipboardData?.getData('text/plain')?.trim()
    if (!text || !isSingleUrl(text)) return false
    const sel = view.state.selection.main
    if (!sel.empty) return false
    const line = view.state.doc.lineAt(sel.head)
    if (line.text.trim() !== '') return false // only on an otherwise-empty line
    event.preventDefault()
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: { anchor: line.from + text.length },
      effects: setPasteMenu.of({ from: line.from, to: line.from + text.length, url: text })
    })
    return true
  }
})

/**
 * Catch pastes that don't fire a DOM `paste` event, chiefly vim `p`/`P`, which
 * insert the register through a plain document change. When a single transaction
 * drops one URL onto an otherwise-empty line, attach the menu effect so the same
 * Notion menu appears. Transactions that already carry the effect (the Cmd/Ctrl+V
 * path, or the fence rewrite / close) are left alone, so nothing double-fires.
 */
const pasteMenuExtender = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged) return null
  if (tr.effects.some((e) => e.is(setPasteMenu))) return null

  const inserts: Array<{ fromB: number; raw: string }> = []
  tr.changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    inserts.push({ fromB, raw: inserted.toString() })
  })
  if (inserts.length !== 1) return null

  const { fromB, raw } = inserts[0]
  const url = raw.trim()
  if (!isSingleUrl(url)) return null

  // Require the URL to own its whole line in the result. This is what makes it a
  // block-worthy paste (vim `p` line-wise, or a paste onto an empty line) and
  // rejects a URL dropped inline mid-sentence. It also excludes typing, which
  // arrives one character per transaction (never a whole URL at once). The
  // inserted text may carry a leading/trailing newline for a line-wise register,
  // so locate the URL within it rather than assuming it starts at fromB.
  const urlStart = fromB + raw.indexOf(url)
  const line = tr.state.doc.lineAt(urlStart)
  if (line.text.trim() !== url) return null

  return { effects: setPasteMenu.of({ from: urlStart, to: urlStart + url.length, url }) }
})

/** True while the menu is open and its controller is installed for this view. */
function menuOpen(view: EditorView): MenuController | null {
  if (!view.state.field(pasteMenuField, false)) return null
  return controllers.get(view) ?? null
}

// Highest precedence so the menu owns j/k/arrows/Enter while it's open, ahead of
// vim and the default editing keymaps. Every handler no-ops (returns false) when
// the menu is closed, so normal typing and motions are untouched otherwise.
const menuKeymap = Prec.highest(
  keymap.of([
    {
      key: 'ArrowDown',
      run: (view) => {
        const c = menuOpen(view)
        if (!c) return false
        c.setActive(c.active + 1)
        return true
      }
    },
    {
      key: 'ArrowUp',
      run: (view) => {
        const c = menuOpen(view)
        if (!c) return false
        c.setActive(c.active - 1)
        return true
      }
    },
    {
      key: 'j',
      run: (view) => {
        const c = menuOpen(view)
        if (!c) return false
        c.setActive(c.active + 1)
        return true
      }
    },
    {
      key: 'k',
      run: (view) => {
        const c = menuOpen(view)
        if (!c) return false
        c.setActive(c.active - 1)
        return true
      }
    },
    {
      key: 'Enter',
      run: (view) => {
        const c = menuOpen(view)
        if (!c) return false
        c.activate()
        return true
      }
    },
    {
      key: 'Escape',
      run: (view) => {
        if (!view.state.field(pasteMenuField, false)) return false
        view.dispatch({ effects: setPasteMenu.of(null) })
        return true
      }
    }
  ])
)

export const urlPasteMenuExtension: Extension = [
  pasteMenuField,
  pasteHandler,
  pasteMenuExtender,
  menuKeymap
]
