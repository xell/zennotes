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
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  tooltips
} from '@codemirror/view'
import { Vim, vim } from '@replit/codemirror-vim'
import { history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { vimAwareDefaultKeymap } from '../lib/cm-vim-default-keymap'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { applyVimInsertEscape } from '../lib/vim-insert-escape'
import { applyVimKeymap } from '../lib/vim-keymap'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import {
  orderedListRenumber,
  skipOrderedListRenumber
} from '../lib/cm-ordered-list-renumber'
import { codeBlockFontPlugin } from '../lib/cm-code-block-font'
import { vimImeControl } from '../lib/cm-vim-ime'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { slashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkSource, wikilinkHeadingSource } from '../lib/cm-wikilinks'
import { completionNavKeymap } from '../lib/cm-completion-nav'
import type { ExternalFileContent } from '@shared/ipc'
import { wysiwygExtensions } from '../lib/cm-wysiwyg-compose'
import { useStore } from '../store'
import { headingFolding } from '../lib/cm-heading-fold'
import { frontmatterStyle } from '../lib/cm-frontmatter'
import { LazyPreview as Preview } from './LazyPreview'
import { CloseIcon, InboxIcon } from './icons'
import { ModeDropdown, NON_DIFF_MODE_OPTIONS } from './ModeDropdown'
import type { PaneMode } from '../lib/pane-mode'
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
  // Same three modes as the main editor's toolbar — Edit / Split / Preview.
  // No Diff here: this file lives outside any vault, so there's no vault for
  // gitIsRepo/gitShowIndex to resolve against — it can never apply.
  const [mode, setMode] = useState<PaneMode>('edit')
  // Mirrors appliedPrefsRef.current.livePreview as React state (refs don't
  // trigger re-renders) so the `.cm-wysiwyg` class stays in sync after a
  // settings refresh — see FloatingNoteApp for the identical pattern.
  const [livePreviewOn, setLivePreviewOn] = useState(prefs.livePreview)
  const [moving, setMoving] = useState(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Source of truth for the body: seeded on load and updated on every edit.
  const bodyRef = useRef<string | null>(null)
  // Live-preview lives in its own compartment so toggling it reconfigures
  // the plugin in place (keeping undo history + cursor) rather than
  // tearing the editor down.
  const livePreviewCompartment = useMemo(() => new Compartment(), [])
  // Line numbers + word wrap live in compartments so a settings refresh
  // (Cmd/Ctrl+Shift+,) can re-apply them in place without rebuilding.
  const lineNumbersCompartment = useMemo(() => new Compartment(), [])
  const wordWrapCompartment = useMemo(() => new Compartment(), [])
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
        // `content`, so its closure is stale (null) after load.
        doc: bodyRef.current ?? '',
        extensions: [
          appMarkdownSnippetExtension(),
          vimImeControl(),
          // Give the editable surface an accessible name so accessibility
          // clients (screen readers, proofreaders such as Grammarly) identify
          // it as a text field — mirrors EditorPane.
          EditorView.contentAttributes.of({
            'aria-label': 'External file editor'
          }),
          new Compartment().of(prefs.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          wordWrapCompartment.of(
            appliedPrefsRef.current.wordWrap ? EditorView.lineWrapping : []
          ),
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          markdownListIndentPlugin,
          frontmatterStyle,
          orderedListRenumber,
          headingFolding(),
          codeBlockFontPlugin,
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreviewCompartment.of(
            appliedPrefsRef.current.livePreview
              ? wysiwygExtensions(useStore.getState().renderTablesInLivePreview)
              : []
          ),
          lineNumbersCompartment.of(lineNumberExtension(appliedPrefsRef.current.lineNumberMode)),
          tooltips({ parent: document.body }),
          autocompletion({
            override: [slashCommandSource, dateShortcutSource, wikilinkSource, wikilinkHeadingSource],
            addToOptions: [{ render: slashCommandRender.render, position: 0 }],
            icons: false,
            optionClass: (completion) =>
              (completion as { _kind?: string })._kind === 'wikilink'
                ? 'wikilink-cmd-option'
                : 'slash-cmd-option'
          }),
          completionNavKeymap,
          keymap.of([
            indentWithTab,
            ...vimAwareDefaultKeymap(prefs.vimMode),
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap
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
      // Focus the editor on mount so vim motions work immediately, matching
      // the main editor. The editor stays mounted across mode toggles (see
      // the mode-change effect below), so this only fires once per window.
      viewRef.current.focus()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist, livePreviewCompartment, prefs.vimMode]
  )

  // The editor stays mounted (hidden via CSS) across Edit/Split/Preview
  // toggles, so refocus it explicitly on the way back in — mirrors the
  // main editor's applyPaneMode behavior.
  useEffect(() => {
    if (mode === 'preview') return
    viewRef.current?.focus()
  }, [mode])

  // Pull the latest settings from the shared prefs blob and apply them to
  // this window without a reload. The main window writes prefs to
  // localStorage on every change, so re-reading here is always current.
  // Theme/fonts/sizes go through applyTheme (CSS vars); line numbers and
  // word wrap reconfigure their compartments in place. Bound to
  // Cmd/Ctrl+Shift+, in the shortcut handler below.
  const refreshSettings = useCallback(() => {
    const next = loadFloatingPrefs()
    appliedPrefsRef.current = next
    setLivePreviewOn(next.livePreview)
    applyTheme(next)
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        lineNumbersCompartment.reconfigure(lineNumberExtension(next.lineNumberMode)),
        wordWrapCompartment.reconfigure(next.wordWrap ? EditorView.lineWrapping : []),
        livePreviewCompartment.reconfigure(
          next.livePreview ? wysiwygExtensions(useStore.getState().renderTablesInLivePreview) : []
        )
      ]
    })
  }, [lineNumbersCompartment, livePreviewCompartment, wordWrapCompartment])

  // Seed the live CM view the first time content arrives.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !content) return
    if (view.state.doc.toString() === content.body) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content.body },
      annotations: [programmatic.of(true), skipOrderedListRenumber.of(true)]
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
  // (no Diff here — this file is outside any vault, no git index to diff
  // against), and Cmd/Ctrl+Shift+, pulls the latest settings from the main
  // window.
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
        setMode('split')
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

  const showEditor = mode !== 'preview'
  const showPreview = mode === 'split' || mode === 'preview'
  const splitMode = mode === 'split'

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
          <ModeDropdown mode={mode} onChange={setMode} options={NON_DIFF_MODE_OPTIONS} />
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
        <div
          className={[
            'min-h-0 min-w-0 flex-1 overflow-hidden',
            splitMode ? 'flex flex-row' : 'flex flex-col'
          ].join(' ')}
        >
          <div
            className={[
              'relative min-h-0 min-w-0',
              splitMode
                ? 'flex flex-[1.05] flex-col border-r border-paper-300/70'
                : 'flex flex-1 flex-col'
            ].join(' ')}
            style={{ display: showEditor ? 'flex' : 'none' }}
          >
            <div
              ref={setContainerRef}
              className={[
                'min-h-0 min-w-0 flex-1',
                // WYSIWYG styling (tables, blockquotes, code-block cards,
                // etc.) is gated on the same live-preview condition that
                // loads the wysiwyg plugins — see EditorPane.
                livePreviewOn ? 'cm-wysiwyg' : ''
              ].join(' ')}
            />
          </div>
          {showPreview &&
            (content ? (
              <div
                data-preview-scroll
                className={[
                  'min-h-0 min-w-0 overflow-y-auto',
                  splitMode ? 'flex flex-1 flex-col' : 'flex-1'
                ].join(' ')}
              >
                <Preview markdown={currentBody()} notePath={content.name} />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-ink-400">
                Loading…
              </div>
            ))}
        </div>
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
