import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import { useStore } from '../store'

/**
 * Vim IME lifecycle controller (macOS).
 *
 * When a CJK user leaves insert mode, their input method often stays active,
 * so normal-mode keys (j/k/d/w) get swallowed as composition input. This
 * controller switches the system input source to English (ABC) on InsertLeave
 * and restores whatever source was active during the previous insert session
 * on InsertEnter — driven by the user's configured switcher binary (e.g.
 * `macism`), executed in the main process via `window.zen.{get,set}InputSource`.
 *
 * It self-disables unless an `imeSwitcherBinaryPath` is configured, so it's a
 * no-op for everyone who hasn't opted in (and on web, where the bridge can't
 * touch the OS input source).
 */

const DEFAULT_ENGLISH_LAYOUT = 'com.apple.keylayout.ABC'

interface VimModeChangeEvent {
  mode: string
  subMode?: string
}

interface CmInstance {
  on(event: 'vim-mode-change', handler: (e: VimModeChangeEvent) => void): void
  off(event: 'vim-mode-change', handler: (e: VimModeChangeEvent) => void): void
}

class VimImeController {
  /** Input source last seen active during insert mode; restored on re-entry. */
  private savedIME: string | null = null
  private wasInInsert = false
  /** Serialized FIFO queue so a fast Esc→i can't race the OS read/write. */
  private queue: Promise<unknown> = Promise.resolve()
  private cm: CmInstance | null = null
  private readonly handler = (e: VimModeChangeEvent): void => this.onModeChange(e.mode)

  constructor(private readonly view: EditorView) {
    this.attach()
  }

  /** Vim may not be wired up at plugin-construction time (the vim extension
   *  lives in a compartment that can reconfigure in). Returns true once the
   *  listener is attached. */
  private attach(): boolean {
    if (this.cm) return true
    const cm = getCM(this.view) as unknown as CmInstance | null
    if (!cm) return false
    this.cm = cm
    cm.on('vim-mode-change', this.handler)
    return true
  }

  private config(): { bin: string; english: string } | null {
    const s = useStore.getState()
    const bin = s.imeSwitcherBinaryPath?.trim()
    if (!bin) return null
    const english = s.imeEnglishLayoutId?.trim() || DEFAULT_ENGLISH_LAYOUT
    return { bin, english }
  }

  private onModeChange(mode: string): void {
    const isInsert = mode === 'insert' || mode === 'replace'

    // The system input source is global; only the focused editor should drive
    // it, so two open windows don't fight over it.
    if (!this.view.hasFocus) {
      this.wasInInsert = isInsert
      return
    }

    const cfg = this.config()
    if (cfg) {
      if (this.wasInInsert && !isInsert) {
        // InsertLeave: remember whatever source was active while inserting,
        // then force English so normal-mode commands aren't eaten by the IME.
        this.enqueue(async () => {
          const current = await window.zen.getInputSource(cfg.bin)
          this.savedIME = current || null
          if (current && current !== cfg.english) {
            await window.zen.setInputSource(cfg.bin, cfg.english)
          }
        })
      } else if (!this.wasInInsert && isInsert) {
        // InsertEnter: restore the source last used in insert mode. Skip when
        // it was already English (we're still on English from normal mode).
        const saved = this.savedIME
        if (saved && saved !== cfg.english) {
          this.enqueue(async () => {
            await window.zen.setInputSource(cfg.bin, saved)
          })
        }
      }
    }

    this.wasInInsert = isInsert
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.queue = this.queue.then(task).catch((err) => {
      console.error('[zen:ime] task failed', err)
    })
  }

  update(): void {
    // Attach lazily once Vim becomes available (e.g. after the vim compartment
    // reconfigures in on a mode toggle).
    if (!this.cm) this.attach()
  }

  destroy(): void {
    if (this.cm) {
      try {
        this.cm.off('vim-mode-change', this.handler)
      } catch {
        /* ignore */
      }
      this.cm = null
    }
  }
}

/** Editor extension that wires the macOS Vim IME controller. Safe to include
 *  unconditionally: it no-ops when vim is off or no switcher binary is set. */
export function vimImeControl(): Extension {
  return ViewPlugin.fromClass(VimImeController)
}
