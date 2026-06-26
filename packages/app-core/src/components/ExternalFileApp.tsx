/**
 * Standalone editor window mounted when the renderer boots with
 * `?externalFile=<abs>`. Spawned by the main process when the user opens
 * a markdown file that lives outside any vault (Finder "Open With", a
 * double-click, etc.).
 *
 * It mirrors the floating-note window — header + edit/preview toggle +
 * CodeMirror / Preview — but reads and writes the file by its absolute
 * path through the external-file IPCs rather than a vault-relative path,
 * and offers a "Move to Vault" action to pull the file into the active
 * vault.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Annotation, Compartment, EditorState, type Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { vimAwareDefaultKeymap } from '../lib/cm-vim-default-keymap'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { applyVimInsertEscape } from '../lib/vim-insert-escape'
import { applyVimKeymap } from '../lib/vim-keymap'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import { vimImeControl } from '../lib/cm-vim-ime'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import type { ExternalFileContent } from '@shared/ipc'
import { wysiwygExtensions } from '../lib/cm-wysiwyg-compose'
import { useStore } from '../store'
import { headingFolding } from '../lib/cm-heading-fold'
import { LazyPreview as Preview } from './LazyPreview'
import { CloseIcon, InboxIcon } from './icons'
import {
  applyTheme,
  lineNumberExtension,
  loadFloatingPrefs,
  paperHighlight
} from './FloatingNoteApp'

const SAVE_DEBOUNCE_MS = 350
const programmatic = Annotation.define<boolean>()

function titleFromName(name: string): string {
  return name.replace(/\.(md|markdown)$/i, '') || name
}

export function ExternalFileApp(): JSX.Element {
  const prefs = useMemo(() => loadFloatingPrefs(), [])
  const [content, setContent] = useState<ExternalFileContent | null>(null)
  const [dirty, setDirty] = useState(false)
  // Three explicit modes — Edit (raw source), Live (WYSIWYG live preview),
  // Preview (rendered HTML). Default to Live when the user keeps live
  // preview on globally, otherwise raw Edit, so the window opens matching
  // their usual editing surface.
  const [mode, setMode] = useState<'edit' | 'live' | 'preview'>(
    prefs.livePreview ? 'live' : 'edit'
  )
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Source of truth for the body: seeded on load and updated on every
  // edit. The editor is recreated on each edit/preview toggle, so it must
  // re-seed from here — `content` is captured stale in setContainerRef.
  const bodyRef = useRef<string | null>(null)
  // Live-preview lives in its own compartment so toggling Edit <-> Live
  // reconfigures the plugin in place (keeping undo history + cursor)
  // rather than tearing the editor down.
  const livePreviewCompartment = useMemo(() => new Compartment(), [])
  // Line numbers + word wrap live in compartments so a settings refresh
  // (Cmd/Ctrl+Shift+,) can re-apply them in place without rebuilding.
  const lineNumbersCompartment = useMemo(() => new Compartment(), [])
  const wordWrapCompartment = useMemo(() => new Compartment(), [])
  // Mirror the current mode into a ref so the deps-light editor-mount
  // callback can read it without going stale across remounts.
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Latest prefs actually applied to this window. Seeded from the mount
  // snapshot; updated by refreshSettings so editor remounts pick up the
  // refreshed values for the compartments' initial config.
  const appliedPrefsRef = useRef(prefs)

  // Apply theme + font vars before paint.
  useEffect(() => {
    applyTheme(prefs)
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    if (prefs.themeMode === 'auto') {
      const onChange = (): void => applyTheme(prefs)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    return undefined
  }, [prefs])

  // Initial load.
  useEffect(() => {
    let alive = true
    void window.zen
      .readExternalFile()
      .then((c) => {
        if (!alive) return
        bodyRef.current = c.body
        setContent(c)
      })
      .catch((err) => {
        console.error('readExternalFile failed', err)
      })
    return () => {
      alive = false
    }
  }, [])

  const persist = useCallback(async (body: string) => {
    try {
      await window.zen.writeExternalFile(body)
      setDirty(false)
    } catch (err) {
      console.error('writeExternalFile failed', err)
    }
  }, [])

  // Mount CodeMirror once content is loaded.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        return
      }
      if (viewRef.current) return
      const state = EditorState.create({
        // Read the live ref, not `content`: this callback's deps omit
        // `content`, so its closure is stale (null) after load. Using the
        // ref keeps the current text when the editor remounts on toggles.
        doc: bodyRef.current ?? '',
        extensions: [
          appMarkdownSnippetExtension(),
          vimImeControl(),
          new Compartment().of(prefs.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          wordWrapCompartment.of(
            appliedPrefsRef.current.wordWrap ? EditorView.lineWrapping : []
          ),
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          markdownListIndentPlugin,
          headingFolding(),
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreviewCompartment.of(
            modeRef.current === 'live'
              ? wysiwygExtensions(useStore.getState().renderTablesInLivePreview)
              : []
          ),
          lineNumbersCompartment.of(lineNumberExtension(appliedPrefsRef.current.lineNumberMode)),
          keymap.of([
            indentWithTab,
            ...vimAwareDefaultKeymap(prefs.vimMode),
            ...historyKeymap,
            ...searchKeymap
          ]),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const next = upd.state.doc.toString()
            bodyRef.current = next
            setDirty(true)
            setMoveError(null)
            if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
            saveTimerRef.current = setTimeout(() => {
              saveTimerRef.current = null
              const body = bodyRef.current
              if (body != null) void persist(body)
            }, SAVE_DEBOUNCE_MS)
          })
        ]
      })
      viewRef.current = new EditorView({ state, parent: el })
      // Focus the editor on mount (and on every edit/preview toggle that
      // remounts it) so vim motions work immediately, matching the main
      // editor. Without this the window opens with focus on the body and
      // no keystrokes reach CodeMirror until the user clicks into the text.
      viewRef.current.focus()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist, livePreviewCompartment, prefs.vimMode]
  )

  // Toggle live preview in place when switching Edit <-> Live so the
  // editor isn't rebuilt (preserves undo history, cursor, scroll).
  useEffect(() => {
    const view = viewRef.current
    if (!view || mode === 'preview') return
    view.dispatch({
      effects: livePreviewCompartment.reconfigure(
        mode === 'live'
          ? wysiwygExtensions(useStore.getState().renderTablesInLivePreview)
          : []
      )
    })
  }, [mode, livePreviewCompartment])

  // Pull the latest settings from the shared prefs blob and apply them to
  // this window without a reload. The main window writes prefs to
  // localStorage on every change, so re-reading here is always current.
  // Theme/fonts/sizes go through applyTheme (CSS vars); line numbers and
  // word wrap reconfigure their compartments in place. Bound to
  // Cmd/Ctrl+Shift+, in the shortcut handler below.
  const refreshSettings = useCallback(() => {
    const next = loadFloatingPrefs()
    appliedPrefsRef.current = next
    applyTheme(next)
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        lineNumbersCompartment.reconfigure(lineNumberExtension(next.lineNumberMode)),
        wordWrapCompartment.reconfigure(next.wordWrap ? EditorView.lineWrapping : [])
      ]
    })
  }, [lineNumbersCompartment, wordWrapCompartment])

  // Seed the live CM view the first time content arrives.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !content) return
    if (view.state.doc.toString() === content.body) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.body },
      annotations: programmatic.of(true)
    })
  }, [content])

  // Flush pending save before unload.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        const body = bodyRef.current
        if (body != null) void persist(body)
      }
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [persist])

  // Window-level shortcuts: Cmd/Ctrl+W closes the window, Cmd/Ctrl+4/5/6
  // switch modes to match the main window's Edit/Split/Preview bindings
  // (no Split here, so 5 maps to the middle Live mode), and
  // Cmd/Ctrl+Shift+, pulls the latest settings from the main window.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'w') {
        event.preventDefault()
        window.zen.windowClose()
        return
      }
      // Re-read and apply settings without reloading the window.
      // event.code is layout-robust (Shift+',' prints '<' on US layouts).
      if (event.shiftKey && event.code === 'Comma') {
        event.preventDefault()
        refreshSettings()
        return
      }
      if (event.shiftKey) return
      if (key === '4') {
        event.preventDefault()
        setMode('edit')
      } else if (key === '5') {
        event.preventDefault()
        setMode('live')
      } else if (key === '6') {
        event.preventDefault()
        setMode('preview')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [refreshSettings])

  const currentBody = useCallback((): string => {
    return viewRef.current?.state.doc.toString() ?? bodyRef.current ?? content?.body ?? ''
  }, [content])

  const moveToVault = useCallback(async () => {
    if (moving) return
    setMoving(true)
    setMoveError(null)
    try {
      // Persist the latest edits to the original path first so the move
      // carries them over.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      await persist(currentBody())
      await window.zen.moveExternalFileToVault()
      // On success the main process opens the note in a vault window and
      // closes this one.
    } catch (err) {
      setMoving(false)
      setMoveError(err instanceof Error ? err.message : 'Could not move this file into a vault.')
    }
  }, [currentBody, moving, persist])

  // Vim ex commands scoped to this window.
  useEffect(() => {
    externalFileHandlers.persist = async (): Promise<void> => {
      await persist(currentBody())
    }
    externalFileHandlers.close = (): void => window.zen.windowClose()
    registerExternalFileVimCommands()
    applyVimInsertEscape(prefs.vimInsertEscape)
    applyVimKeymap(prefs.vimKeymap)
  }, [persist, currentBody, prefs.vimInsertEscape, prefs.vimKeymap])

  const title = useMemo(() => (content ? titleFromName(content.name) : 'Untitled'), [content])

  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <div className="flex h-screen w-screen flex-col bg-paper-100 text-ink-900">
      <header
        className="glass-header flex h-12 shrink-0 items-center justify-between gap-2 border-b border-paper-300/70 px-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-16">
          <span className="truncate text-sm font-semibold text-ink-900">{title}</span>
          {dirty && (
            <span
              aria-label="Unsaved changes"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80"
            />
          )}
          <span className="truncate text-xs text-ink-400">Not in a vault</span>
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={moveToVault}
            disabled={moving}
            title="Move this file into your vault"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-600 hover:bg-paper-200 hover:text-ink-900 disabled:opacity-50"
          >
            <InboxIcon width={13} height={13} />
            {moving ? 'Moving…' : 'Move to Vault'}
          </button>
          <div className="flex items-center gap-1 rounded-md bg-paper-200/70 p-0.5 text-xs">
            {(
              [
                { m: 'edit', label: 'Edit', title: 'Raw Markdown source' },
                { m: 'live', label: 'Live', title: 'Live preview — render inline while editing' },
                { m: 'preview', label: 'Preview', title: 'Fully rendered preview' }
              ] as const
            ).map(({ m, label, title }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={title}
                className={[
                  'rounded px-1.5 py-0.5 transition-colors',
                  mode === m
                    ? 'bg-paper-50 text-ink-900 shadow-sm'
                    : 'text-ink-500 hover:text-ink-800'
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="Close window"
            onClick={() => window.zen.windowClose()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-500 hover:bg-paper-200 hover:text-ink-900"
          >
            <CloseIcon width={14} height={14} />
          </button>
        </div>
      </header>

      {moveError && (
        <div className="shrink-0 border-b border-paper-300/70 bg-rose-500/10 px-4 py-1.5 text-xs text-rose-600">
          {moveError}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {mode !== 'preview' ? (
          <div ref={setContainerRef} className="min-h-0 min-w-0 flex-1" />
        ) : content ? (
          <div data-preview-scroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <Preview markdown={currentBody()} notePath={content.name} />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">Loading…</div>
        )}
      </div>
    </div>
  )
}

// Module-scoped handler slots so the Vim ex callbacks always see the
// latest `persist` closure (mirrors the floating-note window).
const externalFileHandlers: {
  persist: null | (() => Promise<void>)
  close: null | (() => void)
} = { persist: null, close: null }

let externalFileVimRegistered = false

function deferredClose(): void {
  setTimeout(() => externalFileHandlers.close?.(), 0)
}

function registerExternalFileVimCommands(): void {
  if (externalFileVimRegistered) return
  externalFileVimRegistered = true

  Vim.defineEx('write', 'w', () => {
    void externalFileHandlers.persist?.()
  })
  Vim.defineEx('quit', 'q', () => {
    deferredClose()
  })
  Vim.defineEx('wq', 'wq', () => {
    void externalFileHandlers.persist?.().then(deferredClose)
  })
  Vim.defineEx('x', 'x', () => {
    void externalFileHandlers.persist?.().then(deferredClose)
  })
}
