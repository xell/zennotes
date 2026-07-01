/**
 * Always-visible side panel that shows a single companion note — a
 * "reference pane" writers and researchers can keep open while drafting
 * in the main editor. Lives outside the regular pane-layout tree so
 * pinning / unpinning doesn't interact with split behaviour.
 *
 * Content is shared via the store's path-keyed `noteContents`, so an
 * edit here propagates to any main-pane view on the same path (and
 * vice versa) via the same sync-effect used by `EditorPane`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  type Transaction
} from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  tooltips
} from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { unifiedMergeView } from '@codemirror/merge'
import { history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { vimAwareDefaultKeymap } from '../lib/cm-vim-default-keymap'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { resolveCodeLanguage } from '../lib/cm-code-languages'
import { markdownListIndentPlugin } from '../lib/cm-markdown-list-indent'
import {
  orderedListRenumber,
  skipOrderedListRenumber
} from '../lib/cm-ordered-list-renumber'
import { codeBlockFontPlugin } from '../lib/cm-code-block-font'
import { vimImeControl } from '../lib/cm-vim-ime'
import { appMarkdownSnippetExtension } from '../lib/markdown-snippets-config'
import { syntaxHighlighting, HighlightStyle, defaultHighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { searchKeymap } from '@codemirror/search'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useStore } from '../store'
import type { LineNumberMode } from '../store'
import { wysiwygExtensions } from '../lib/cm-wysiwyg-compose'
import { headingFolding } from '../lib/cm-heading-fold'
import { frontmatterStyle } from '../lib/cm-frontmatter'
import { slashCommandSource, slashCommandRender } from '../lib/cm-slash-commands'
import { dateShortcutSource } from '../lib/cm-date-shortcuts'
import { wikilinkSource, wikilinkHeadingSource } from '../lib/cm-wikilinks'
import { completionNavKeymap } from '../lib/cm-completion-nav'
import { classifyLocalAssetHref, type LocalAssetKind } from '../lib/local-assets'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { LazyPreview as Preview } from './LazyPreview'
import { TerminalPanel } from './TerminalPanel'
import { DocumentTextIcon, ListIcon, PinIcon, TerminalIcon } from './icons'
import { ModeDropdown } from './ModeDropdown'
import type { NoteMeta } from '@shared/ipc'
import { allLeaves } from '../lib/pane-layout'

const PINNED_REF_PANE_ID = 'pinned-ref'
export const pinnedRefPaneId = PINNED_REF_PANE_ID

const programmatic = Annotation.define<boolean>()

const paperHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.heading2, class: 'tok-heading2' },
  { tag: t.heading3, class: 'tok-heading3' },
  { tag: t.heading4, class: 'tok-heading4' },
  { tag: t.heading5, class: 'tok-heading5' },
  { tag: t.heading6, class: 'tok-heading6' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strikethrough' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.monospace, class: 'tok-monospace' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.list, class: 'tok-list' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.keyword, class: 'tok-keyword' },
  { tag: t.controlKeyword, class: 'tok-keyword' },
  { tag: t.definitionKeyword, class: 'tok-keyword' },
  { tag: t.modifier, class: 'tok-keyword' },
  { tag: t.operatorKeyword, class: 'tok-keyword' },
  { tag: t.string, class: 'tok-string' },
  { tag: t.special(t.string), class: 'tok-string' },
  { tag: t.regexp, class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: t.lineComment, class: 'tok-comment' },
  { tag: t.blockComment, class: 'tok-comment' },
  { tag: t.number, class: 'tok-number' },
  { tag: t.bool, class: 'tok-atom' },
  { tag: t.atom, class: 'tok-atom' },
  { tag: t.null, class: 'tok-atom' },
  { tag: t.self, class: 'tok-atom' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.typeName, class: 'tok-type' },
  { tag: t.className, class: 'tok-type' },
  { tag: t.namespace, class: 'tok-type' },
  { tag: t.function(t.variableName), class: 'tok-function' },
  { tag: t.function(t.definition(t.variableName)), class: 'tok-function' },
  { tag: t.definition(t.variableName), class: 'tok-variable-def' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: t.labelName, class: 'tok-label' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.bracket, class: 'tok-bracket' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' }
])

function lineNumberExtension(mode: LineNumberMode): Extension {
  if (mode === 'off') return []
  return [
    lineNumbers({
      formatNumber: (lineNo, state) => {
        if (mode === 'absolute') return String(lineNo)
        const activeLine = state.doc.lineAt(state.selection.main.head).number
        return lineNo === activeLine ? String(lineNo) : String(Math.abs(lineNo - activeLine))
      }
    }),
    highlightActiveLineGutter()
  ]
}

export function PinnedReferencePane(): JSX.Element | null {
  const globalRefPath = useStore((s) => s.pinnedRefPath)
  const globalRefKind = useStore((s) => s.pinnedRefKind)
  const noteRefs = useStore((s) => s.noteRefs)
  const selectedPath = useStore((s) => s.selectedPath)
  // Per-note pin (if any) overrides the global one.
  const noteRef = selectedPath ? noteRefs[selectedPath] : null
  const pinnedRefPath = noteRef?.path ?? globalRefPath
  const pinnedRefKind = noteRef?.kind ?? globalRefKind
  const isPerNotePin = !!noteRef
  const zenMode = useStore((s) => s.zenMode)
  const pinnedRefVisible = useStore((s) => s.pinnedRefVisible)
  const pinnedRefWidth = useStore((s) => s.pinnedRefWidth)
  const pinnedRefMode = useStore((s) => s.pinnedRefMode)
  const renderTablesInLivePreview = useStore((s) => s.renderTablesInLivePreview)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const unpinReferenceGlobal = useStore((s) => s.unpinReference)
  const unpinReferenceForNote = useStore((s) => s.unpinReferenceForNote)
  const setPinnedRefWidth = useStore((s) => s.setPinnedRefWidth)
  const setPinnedRefMode = useStore((s) => s.setPinnedRefMode)
  const unpinReference = (): void => {
    if (isPerNotePin && selectedPath) unpinReferenceForNote(selectedPath)
    else unpinReferenceGlobal()
  }
  const content = useStore((s) =>
    pinnedRefPath ? s.noteContents[pinnedRefPath] ?? null : null
  )
  const isDirty = useStore((s) =>
    pinnedRefPath ? s.noteDirty[pinnedRefPath] ?? false : false
  )
  const updateNoteBody = useStore((s) => s.updateNoteBody)
  const persistNote = useStore((s) => s.persistNote)
  const vimMode = useStore((s) => s.vimMode)
  const livePreview = useStore((s) => s.livePreview)
  const isGitRepo = useStore((s) => s.isGitRepo)
  const diffInlineDiffs = useStore((s) => s.diffInlineDiffs)
  const lineNumberMode = useStore((s) => s.lineNumberMode)
  const editorFontSize = useStore((s) => s.editorFontSize)
  const editorLineHeight = useStore((s) => s.editorLineHeight)
  const textFont = useStore((s) => s.textFont)
  const setView = useStore((s) => s.setView)

  const viewRef = useRef<EditorView | null>(null)
  const viewPathRef = useRef<string | null>(null)
  const vimCompartmentRef = useRef<Compartment | null>(null)
  const livePreviewCompartmentRef = useRef<Compartment | null>(null)
  const lineNumbersCompartmentRef = useRef<Compartment | null>(null)
  const diffCompartmentRef = useRef<Compartment | null>(null)
  const [diffStatus, setDiffStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [diffRefreshKey, setDiffRefreshKey] = useState(0)

  const rightPaneTab = useStore((s) => s.rightPaneTab)
  const setRightPaneTab = useStore((s) => s.setRightPaneTab)

  const [resizing, setResizing] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [terminalFocused, setTerminalFocused] = useState(false)

  // Dismiss the picker as soon as a note is successfully pinned.
  useEffect(() => {
    if (pinnedRefPath) setShowPicker(false)
  }, [pinnedRefPath])

  useEffect(() => {
    const onFocus = (): void => setTerminalFocused(true)
    const onBlur = (): void => setTerminalFocused(false)
    window.addEventListener('zen:terminal-focused', onFocus)
    window.addEventListener('zen:terminal-blurred', onBlur)
    return () => {
      window.removeEventListener('zen:terminal-focused', onFocus)
      window.removeEventListener('zen:terminal-blurred', onBlur)
    }
  }, [])

  // Track previous visibility to detect open/close transitions.
  const prevVisibleRef = useRef(pinnedRefVisible)
  useEffect(() => {
    const wasVisible = prevVisibleRef.current
    prevVisibleRef.current = pinnedRefVisible
    if (!wasVisible && pinnedRefVisible && rightPaneTab === 'terminal') {
      // Pane just opened with terminal tab active → focus xterm.
      requestAnimationFrame(() => window.dispatchEvent(new Event('zen:focus-terminal-input')))
    } else if (wasVisible && !pinnedRefVisible) {
      // Pane just closed → return focus to the editor.
      focusEditorNormalMode()
    }
  }, [pinnedRefVisible, rightPaneTab])

  /* -------- Mount CodeMirror view -------- */
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) {
        viewRef.current?.destroy()
        viewRef.current = null
        viewPathRef.current = null
        return
      }
      if (viewRef.current) return
      const vimCompartment = new Compartment()
      const livePreviewCompartment = new Compartment()
      const lineNumbersCompartment = new Compartment()
      const diffCompartment = new Compartment()
      vimCompartmentRef.current = vimCompartment
      livePreviewCompartmentRef.current = livePreviewCompartment
      lineNumbersCompartmentRef.current = lineNumbersCompartment
      diffCompartmentRef.current = diffCompartment
      const s0 = useStore.getState()
      const initialPath = s0.pinnedRefPath
      const initialContent = initialPath ? s0.noteContents[initialPath] ?? null : null
      const state = EditorState.create({
        doc: initialContent?.body ?? '',
        extensions: [
          appMarkdownSnippetExtension(),
          vimImeControl(),
          // Give the editable surface an accessible name so accessibility
          // clients (screen readers, proofreaders such as Grammarly) identify
          // it as a text field — mirrors EditorPane.
          EditorView.contentAttributes.of({
            'aria-label': 'Pinned reference editor'
          }),
          vimCompartment.of(s0.vimMode ? vim() : []),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage, addKeymap: true }),
          markdownListIndentPlugin,
          frontmatterStyle,
          orderedListRenumber,
          headingFolding(),
          codeBlockFontPlugin,
          syntaxHighlighting(paperHighlight),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          livePreviewCompartment.of(s0.livePreview ? wysiwygExtensions(s0.renderTablesInLivePreview) : []),
          lineNumbersCompartment.of(lineNumberExtension(s0.lineNumberMode)),
          diffCompartment.of([]),
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
            {
              key: 'Mod-f',
              run: () => {
                const state = useStore.getState()
                if (state.vimMode) return false
                state.setSearchOpen(true)
                return true
              }
            },
            indentWithTab,
            ...vimAwareDefaultKeymap(s0.vimMode),
            ...historyKeymap,
            ...searchKeymap,
            ...completionKeymap
          ]),
          EditorView.updateListener.of((upd) => {
            if (!upd.docChanged) return
            if (upd.transactions.some((tr: Transaction) => tr.annotation(programmatic))) return
            const path = viewPathRef.current
            if (!path) return
            updateNoteBody(path, upd.state.doc.toString())
          })
        ]
      })
      const view = new EditorView({ state, parent: el })
      viewRef.current = view
      viewPathRef.current = initialPath
    },
    [updateNoteBody]
  )

  /* -------- Sync external content changes into the CM doc -------- */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextPath = content?.path ?? null
    const nextBody = content?.body ?? ''
    const pathChanged = viewPathRef.current !== nextPath
    const bodyChanged = view.state.doc.toString() !== nextBody
    if (!pathChanged && !bodyChanged) return
    const sel = view.state.selection.main
    const clampedAnchor = Math.min(sel.anchor, nextBody.length)
    const clampedHead = Math.min(sel.head, nextBody.length)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: nextBody },
      annotations: [programmatic.of(true), skipOrderedListRenumber.of(true)],
      selection: pathChanged ? { anchor: 0 } : { anchor: clampedAnchor, head: clampedHead }
    })
    viewPathRef.current = nextPath
  }, [content?.body, content?.path])

  /* -------- Compartment reconfigures tracking prefs -------- */
  useEffect(() => {
    const view = viewRef.current
    const comp = vimCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(vimMode ? vim() : []) })
  }, [vimMode])
  useEffect(() => {
    const view = viewRef.current
    const comp = livePreviewCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(livePreview ? wysiwygExtensions(renderTablesInLivePreview) : []) })
  }, [livePreview, renderTablesInLivePreview])
  useEffect(() => {
    const view = viewRef.current
    const comp = lineNumbersCompartmentRef.current
    if (!view || !comp) return
    view.dispatch({ effects: comp.reconfigure(lineNumberExtension(lineNumberMode)) })
  }, [lineNumberMode])

  /* -------- Diff mode: load the git-index version and diff against it -------- */
  useEffect(() => {
    const compartment = diffCompartmentRef.current
    const view = viewRef.current
    if (pinnedRefMode !== 'diff' || !pinnedRefPath || !compartment || !view) {
      if (compartment && view && pinnedRefMode !== 'diff') {
        view.dispatch({ effects: compartment.reconfigure([]) })
        setDiffStatus('idle')
      }
      return
    }
    let cancelled = false
    view.dispatch({ effects: compartment.reconfigure([]) })
    setDiffStatus('loading')
    void window.zen.gitShowIndex(pinnedRefPath).then((original) => {
      if (cancelled) return
      if (original === null) {
        setDiffStatus('error')
        return
      }
      setDiffStatus('ready')
      view.dispatch({
        effects: compartment.reconfigure(
          unifiedMergeView({ original, allowInlineDiffs: diffInlineDiffs, collapseUnchanged: { margin: 3, minSize: 4 } })
        )
      })
    })
    return () => { cancelled = true }
  }, [pinnedRefMode, pinnedRefPath, diffRefreshKey, diffInlineDiffs])

  /* -------- Re-measure on font changes -------- */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const raf = requestAnimationFrame(() => view.requestMeasure())
    return () => cancelAnimationFrame(raf)
  }, [editorFontSize, editorLineHeight, lineNumberMode, textFont, pinnedRefWidth, pinnedRefMode])

  /* -------- Flush pending save on unmount -------- */
  const pathRef = useRef<string | null>(pinnedRefPath)
  pathRef.current = pinnedRefPath
  useEffect(() => {
    return () => {
      const path = pathRef.current
      if (!path) return
      if (useStore.getState().noteDirty[path]) void persistNote(path)
    }
  }, [persistNote])

  /* -------- Resize handle on the left edge -------- */
  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = pinnedRefWidth
      setResizing(true)
      const onMove = (ev: MouseEvent): void => {
        // Dragging left grows the pane, dragging right shrinks it.
        setPinnedRefWidth(startWidth + (startX - ev.clientX))
      }
      const onUp = (): void => {
        setResizing(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [pinnedRefWidth, setPinnedRefWidth]
  )

  const isAsset = pinnedRefKind === 'asset'
  const title = pinnedRefPath
    ? isAsset
      ? pinnedRefPath.split('/').pop() ?? pinnedRefPath
      : content?.title ??
        pinnedRefPath.split('/').pop()?.replace(/\.md$/i, '') ??
        pinnedRefPath
    : ''
  const assetUrl =
    pinnedRefPath && isAsset && vaultRoot
      ? window.zen.resolveVaultAssetUrl(vaultRoot, pinnedRefPath)
      : null
  const assetKind: LocalAssetKind | null =
    pinnedRefPath && isAsset ? classifyLocalAssetHref(pinnedRefPath) ?? 'file' : null
  const useAssetIframe = assetKind === 'pdf' || assetKind === 'file'

  // Track every asset URL the user has pinned this session. One iframe
  // per unique URL stays mounted for the life of the app — show/hide
  // via CSS rather than unmounting — so switching between references
  // (or unpinning and re-pinning) preserves each PDF viewer's page,
  // scroll, and zoom. 16-entry LRU cap keeps memory bounded if the
  // user cycles through many PDFs.
  const [seenAssetUrls, setSeenAssetUrls] = useState<string[]>([])
  useEffect(() => {
    if (!assetUrl || !useAssetIframe) return
    setSeenAssetUrls((prev) => {
      if (prev[prev.length - 1] === assetUrl) return prev
      const without = prev.filter((u) => u !== assetUrl)
      const next = [...without, assetUrl]
      while (next.length > 16) next.shift()
      return next
    })
  }, [assetUrl, useAssetIframe])

  const showEditor = pinnedRefMode !== 'preview'
  const showPreview = pinnedRefMode === 'split' || pinnedRefMode === 'preview'
  const splitMode = pinnedRefMode === 'split'
  const hidden = zenMode || !pinnedRefVisible

  const handleModeChange = useCallback(
    (nextMode: typeof pinnedRefMode) => {
      if (nextMode === 'diff' && pinnedRefMode === 'diff') {
        // Already in diff mode — bump the refresh key to re-run the diff
        // effect, which resets the compartment and re-collapses all
        // expanded sections — mirrors EditorPane's applyPaneMode.
        setDiffRefreshKey((k) => k + 1)
        return
      }
      setPinnedRefMode(nextMode)
    },
    [pinnedRefMode, setPinnedRefMode]
  )

  return (
    <section
      data-pane-id={PINNED_REF_PANE_ID}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-paper-300/70 bg-paper-50/40"
      style={{
        width: pinnedRefWidth,
        // Hide via CSS instead of unmounting so the cached asset
        // iframes below keep their internal viewer state alive across
        // pin / unpin / visibility toggles.
        display: hidden ? 'none' : 'flex'
      }}
    >
      <>
        {/* Resize handle on the left edge. */}
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startResize}
          className={[
            'group absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize select-none',
            resizing ? 'bg-accent/60' : 'hover:bg-accent/40'
          ].join(' ')}
        >
          <div className="absolute -left-1 top-0 h-full w-[9px]" />
        </div>

        <header className="glass-header flex h-10 shrink-0 items-center justify-between gap-2 border-b border-paper-300/70 px-3">
          {rightPaneTab === 'terminal' ? (
            <span className={['flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold transition-colors', terminalFocused ? 'text-accent' : 'text-ink-900'].join(' ')}>
              <TerminalIcon width={14} height={14} className="shrink-0" />
              <span className={['rounded-full px-2 py-0.5 transition-colors', terminalFocused ? 'bg-accent/10' : ''].join(' ')}>Terminal</span>
            </span>
          ) : pinnedRefPath ? (
            <button
              type="button"
              title={isAsset ? `Reveal ${title} in files` : `Reveal ${title} in the sidebar`}
              onClick={() => {
                if (isAsset) {
                  setView({ kind: 'assets' })
                  return
                }
                const parts = pinnedRefPath!.split('/')
                const top = parts[0] as 'inbox' | 'quick' | 'archive' | 'trash'
                const subpath = parts.slice(1, -1).join('/')
                setView({ kind: 'folder', folder: top, subpath })
              }}
              className="flex min-w-0 flex-1 items-center gap-2 truncate text-left text-sm font-semibold text-ink-900 hover:text-ink-700"
            >
              <PinIcon width={14} height={14} className="shrink-0 text-accent" />
              <span className="truncate">{title}</span>
              {!isAsset && isDirty && (
                <span
                  aria-label="Unsaved changes"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/80"
                />
              )}
            </button>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink-400">
              <PinIcon width={14} height={14} className="shrink-0 opacity-40" />
              No note pinned
            </span>
          )}
          <div className="flex shrink-0 items-center gap-1">
            {!isAsset && rightPaneTab === 'reference' && !!pinnedRefPath && (
              <>
                <button
                  type="button"
                  title="Change pinned note"
                  onClick={() => setShowPicker((v) => !v)}
                  className={[
                    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                    showPicker ? 'bg-paper-200 text-ink-900' : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
                  ].join(' ')}
                >
                  <ListIcon width={13} height={13} />
                </button>
                <ModeDropdown
                  mode={pinnedRefMode}
                  onChange={handleModeChange}
                  isGitRepo={isGitRepo}
                />
              </>
            )}
              <div className="flex items-center rounded-md bg-paper-200/70 p-0.5">
                <button
                  type="button"
                  title="Terminal"
                  onClick={() => {
                    setRightPaneTab('terminal')
                    requestAnimationFrame(() => window.dispatchEvent(new Event('zen:focus-terminal-input')))
                  }}
                  className={[
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    rightPaneTab === 'terminal' ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800'
                  ].join(' ')}
                >
                  <TerminalIcon width={13} height={13} />
                </button>
                <button
                  type="button"
                  title="Reference"
                  onClick={() => {
                    setRightPaneTab('reference')
                    requestAnimationFrame(() => viewRef.current?.focus())
                  }}
                  className={[
                    'flex h-6 w-6 items-center justify-center rounded transition-colors',
                    rightPaneTab === 'reference' ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800'
                  ].join(' ')}
                >
                  <DocumentTextIcon width={13} height={13} />
                </button>
              </div>
            </div>
        </header>
      </>

      {/* Terminal — always mounted so the PTY survives tab switches. */}
      <TerminalPanel visible={rightPaneTab === 'terminal' && pinnedRefVisible} />

      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={{ display: rightPaneTab === 'reference' ? 'flex' : 'none' }}
      >
        {(!pinnedRefPath || showPicker) && <OpenBuffersList />}

        {/* Note editor / preview — only mounted when the pin is a note.
            Unmount when switching to an asset so CM view isn't running
            invisibly; this half doesn't need the "preserve state" trick
            because note content is already persisted through the store. */}
        {pinnedRefPath && !showPicker && !isAsset && (
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
                  // etc.) is gated on the same `livePreview` condition that
                  // loads the wysiwyg plugins — see EditorPane.
                  livePreview ? 'cm-wysiwyg' : ''
                ].join(' ')}
              />
              {pinnedRefMode === 'diff' && diffStatus === 'loading' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-paper-50/80 text-sm text-ink-400">
                  Loading diff…
                </div>
              )}
              {pinnedRefMode === 'diff' && diffStatus === 'error' && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-paper-50/80 text-sm text-ink-400">
                  No index version — stage or commit this note to see a diff.
                </div>
              )}
            </div>
            {showPreview && content && (
              <div
                data-preview-scroll
                className={[
                  'min-h-0 min-w-0 overflow-y-auto',
                  splitMode ? 'flex flex-1 flex-col' : 'flex-1'
                ].join(' ')}
              >
                <Preview markdown={content.body} notePath={content.path} />
              </div>
            )}
          </div>
        )}

        {pinnedRefPath && !showPicker && isAsset && assetUrl && assetKind === 'image' && (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-auto bg-black/5 p-4">
            <img
              src={assetUrl}
              alt={title}
              className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
            />
          </div>
        )}

        {pinnedRefPath && !showPicker && isAsset && assetUrl && assetKind === 'video' && (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-black">
            <video
              src={assetUrl}
              controls
              className="max-h-full max-w-full"
            />
          </div>
        )}

        {pinnedRefPath && !showPicker && isAsset && assetUrl && assetKind === 'audio' && (
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-paper-100/40 p-6">
            <div className="w-full max-w-md rounded-xl border border-paper-300/70 bg-paper-50/80 p-4 shadow-sm">
              <div className="mb-3 truncate text-sm font-medium text-ink-900">{title}</div>
              <audio src={assetUrl} controls className="w-full" />
            </div>
          </div>
        )}

        {/* Asset iframe stack — ALWAYS mounted once any PDF/generic asset has been
            pinned this session, regardless of whether one is currently
            pinned or the pane is visible. This is the "preserve PDF
            page" mechanism: hiding via CSS keeps the iframe alive so
            Chromium's internal PDF viewer retains its state. */}
        {seenAssetUrls.length > 0 && (
          <div
            className="absolute inset-0"
            style={{
              display: isAsset && assetUrl && useAssetIframe ? 'block' : 'none'
            }}
          >
            {seenAssetUrls.map((url) => (
              <iframe
                key={url}
                src={url}
                title={url}
                className="absolute inset-0 h-full w-full border-0 bg-paper-50"
                style={{
                  display: url === assetUrl ? 'block' : 'none'
                }}
              />
            ))}
          </div>
        )}

        {pinnedRefPath && !showPicker && isAsset && !assetUrl && (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-400">
            Couldn't resolve asset path.
          </div>
        )}

        {/* While the resize handle is being dragged, blanket the body
            with a transparent capture layer so PDF iframes can't eat
            the mouse events the resize logic depends on. */}
        {resizing && (
          <div
            aria-hidden
            className="absolute inset-0 z-30 cursor-col-resize"
          />
        )}
      </div>
    </section>
  )
}

function OpenBuffersList(): JSX.Element {
  const paneLayout = useStore((s) => s.paneLayout)
  const notes = useStore((s) => s.notes)
  const pinReference = useStore((s) => s.pinReference)

  const openNotes = useMemo(() => {
    const byPath = new Map((notes as NoteMeta[]).map((n) => [n.path, n]))
    const seen = new Set<string>()
    const result: NoteMeta[] = []
    for (const leaf of allLeaves(paneLayout)) {
      for (const path of leaf.tabs) {
        if (!seen.has(path)) {
          seen.add(path)
          const note = byPath.get(path)
          if (note) result.push(note)
        }
      }
    }
    return result
  }, [paneLayout, notes])

  if (openNotes.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-ink-400">
        No notes open. Open a note and use<br />"Pin Active Note as Reference".
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      <p className="mb-2 px-1 text-xs font-medium text-ink-400">Select a note to pin as reference</p>
      {openNotes.map((note) => {
        const pathNoExt = note.path.replace(/\.[^.]+$/, '')
        const lastSlash = pathNoExt.lastIndexOf('/')
        const folder = lastSlash >= 0 ? pathNoExt.slice(0, lastSlash) : ''
        return (
          <button
            key={note.path}
            type="button"
            onClick={() => { void pinReference(note.path) }}
            className="flex flex-col rounded-lg px-3 py-2 text-left transition-colors hover:bg-paper-200/70 active:bg-paper-300/70"
          >
            <span className="text-sm font-medium text-ink-900">{note.title}</span>
            {folder && <span className="mt-0.5 text-xs text-ink-400">{folder}</span>}
          </button>
        )
      })}
    </div>
  )
}
