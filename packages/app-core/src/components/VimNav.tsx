import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { isTagsViewActive, isTasksViewActive, useStore, type SidebarRevealTarget } from '../store'
import { noteFolderSubpath, vaultRelativeFolderPath } from '../lib/vault-layout'
import { csvPathForFormDir, isFormDirName } from '@shared/databases'
import { parentDirOf } from '../lib/manual-order'
import { HintOverlay } from './HintOverlay'
import { WhichKeyOverlay, type WhichKeyItem } from './WhichKeyOverlay'
import {
  clearEditorPendingVimStatus,
  getVisiblePanels,
  hintTargetOpensNote,
  isEditorInsertMode,
  isEditorFocused,
  isVimAwaitingArgument,
  resolveNextPanel,
  shouldYieldToHomeNav
} from '../lib/vim-nav'
import { focusPaneInDirection } from '../lib/pane-nav'
import { findLeaf } from '../lib/pane-layout'
import { boundedIndexCount, clampIndex, moveIndex } from '../lib/index-navigation'
import {
  advanceSequence,
  getKeymapBinding,
  getKeymapDisplay,
  getSequenceTokens,
  matchesSequenceToken,
  matchesShortcutBinding,
  sequenceTokenFromEvent,
  type KeymapId
} from '../lib/keymaps'
import { toggleWrap, wrapLink } from '../lib/cm-format'
import {
  ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT,
  dispatchKeyboardContextMenu,
  findTabContextMenuTarget
} from '../lib/keyboard-context-menu'
import { navigateActiveBuffer } from '../lib/buffer-navigation'
import { focusEditorNormalMode } from '../lib/editor-focus'
import { goUpIsolationWithConfirm } from '../lib/sidebar-isolation'

function escapeForAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

type IndexedDatasetKey = 'sidebarIdx' | 'notelistIdx' | 'connectionsIdx' | 'commentsIdx'

/**
 * Global vim-style keyboard navigation layer.
 *
 * Uses refs (not React state) for all internal flags so the capture-phase
 * keydown handler always reads the latest values — no stale closures, no
 * dependency on React re-renders between keystrokes.
 */
// #309: how quickly a Space press+release inside an Excalidraw canvas counts as
// a "tap" (arm the leader) rather than a hold (let Excalidraw's Hand tool pan).
// Tuned so a deliberate hold-to-pan clears it while a natural tap stays under it.
const EXCALIDRAW_LEADER_TAP_MS = 250

export function VimNav(): JSX.Element | null {
  const vimMode = useStore((s) => s.vimMode)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  // All control-flow flags are refs so the handler never stales.
  const ctrlWPending = useRef(false)
  const jumpTopPending = useRef(0)
  const previousBufferPending = useRef(0)
  const nextBufferPending = useRef(0)
  const leaderPending = useRef<'leader' | 'leader-l' | 'leader-s' | null>(null)
  // Sidebar `z`-prefixed folder-nav family (zM/zR/zk/zj): they share one
  // first token, so — unlike jumpTop's single "g g" binding — this tracks
  // *which* first token is pending, not just a token count.
  const zFolderNavPending = useRef<string | null>(null)
  // In-flight retry loop from zM's post-collapse cursor re-anchor (see
  // reanchorSidebarCursor) — cancelled if a new one starts before it settles.
  const collapseAllReanchorRaf = useRef(0)
  const ctrlWTimer = useRef<ReturnType<typeof setTimeout>>()
  const jumpTopTimer = useRef<ReturnType<typeof setTimeout>>()
  const zFolderNavTimer = useRef<ReturnType<typeof setTimeout>>()
  const previousBufferTimer = useRef<ReturnType<typeof setTimeout>>()
  const nextBufferTimer = useRef<ReturnType<typeof setTimeout>>()
  const leaderTimer = useRef<ReturnType<typeof setTimeout>>()
  // #309: timestamp of the last Space keydown observed inside an Excalidraw
  // canvas (or null). A quick keyup after it arms the leader; a longer hold was
  // a pan and arms nothing.
  const excalidrawSpaceDownAt = useRef<number | null>(null)

  // Hint mode needs a render (to mount HintOverlay), so it's state.
  const [hintActive, setHintActive] = useState(false)
  const [whichKeyState, setWhichKeyState] = useState<{
    stage: 'leader' | 'leader-l' | 'leader-s'
    allowEditorActions: boolean
  } | null>(null)
  const hintRef = useRef(false)
  const setHint = useCallback((v: boolean) => {
    hintRef.current = v
    setHintActive(v)
  }, [])
  const exitHints = useCallback(
    (activated?: HTMLElement) => {
      setHint(false)
      // #100: if the hint opened a note — a sidebar note row or a note tab —
      // land in the editor instead of the sidebar row / tab you clicked.
      if (hintTargetOpensNote(activated)) focusEditorNormalMode()
    },
    [setHint]
  )
  const focusEditor = useCallback(() => {
    const state = useStore.getState()
    state.setFocusedPanel('editor')
    state.editorViewRef?.focus()
  }, [])
  const focusTabs = useCallback(() => {
    const state = useStore.getState()
    const leaf = findLeaf(state.paneLayout, state.activePaneId)
    if (!leaf?.activeTab || leaf.tabs.length === 0 || !state.tabsEnabled || state.zenMode) {
      return false
    }
    state.setFocusedPanel('tabs')
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    requestAnimationFrame(() => {
      const target = findTabContextMenuTarget(leaf.id, leaf.activeTab ?? '')
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return true
  }, [])
  const jumpNoteHistory = useCallback((direction: 'back' | 'forward') => {
    const state = useStore.getState()
    const previewEl = getPreviewScrollElement()
    const activeTarget = document.activeElement as HTMLElement | null
    const keepPreviewFocus = previewEl
      ? isPreviewNavigationActive(previewEl, state, activeTarget)
      : false
    const jump =
      direction === 'back' ? state.jumpToPreviousNote : state.jumpToNextNote
    void jump().then(() => {
      const latest = useStore.getState()
      if (!latest.activeNote) return
      latest.setFocusedPanel('editor')
      requestAnimationFrame(() => {
        if (keepPreviewFocus) {
          getPreviewScrollElement()?.focus()
          return
        }
        useStore.getState().editorViewRef?.focus()
      })
    })
  }, [])
  const cancelHints = useCallback(() => {
    setHint(false)
    focusEditor()
  }, [focusEditor, setHint])
  const whichKeyHintsPref = useStore((s) => s.whichKeyHints)
  const whichKeyHintMode = useStore((s) => s.whichKeyHintMode)
  const whichKeyHintTimeoutMs = useStore((s) => s.whichKeyHintTimeoutMs)
  const whichKeyHintsEnabled = vimMode && whichKeyHintsPref
  const stickyWhichKeyHints = whichKeyHintsEnabled && whichKeyHintMode === 'sticky'
  const canSwitchVaults =
    window.zen.getAppInfo().runtime === 'desktop' &&
    (window.zen.getCapabilities().supportsLocalFilesystemPickers ||
      window.zen.getCapabilities().supportsRemoteWorkspace)
  const resetLeader = useCallback(() => {
    leaderPending.current = null
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
    setWhichKeyState(null)
  }, [])
  const armLeader = useCallback(
    (stage: 'leader' | 'leader-l' | 'leader-s', allowEditorActions: boolean) => {
      leaderPending.current = stage
      setWhichKeyState({ stage, allowEditorActions })
      if (leaderTimer.current) clearTimeout(leaderTimer.current)
      if (!stickyWhichKeyHints) {
        leaderTimer.current = setTimeout(() => {
          leaderPending.current = null
          setWhichKeyState(null)
        }, whichKeyHintTimeoutMs)
      }
    },
    [stickyWhichKeyHints, whichKeyHintTimeoutMs]
  )

  const whichKeyItems: WhichKeyItem[] = (() => {
    if (!whichKeyState) return []
    if (whichKeyState.stage === 'leader-l') {
      return [
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderFormatNote'),
        label: 'Format note',
        detail: 'Run markdown formatting on the active note.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderCopyMarkdown'),
        label: 'Copy as Markdown',
        detail: "Copy the whole note's Markdown to the clipboard."
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderToggleFavorite'),
        label: 'Toggle favorite',
        detail: 'Add or remove the active note from Favorites.'
      }
      ]
    }
    if (whichKeyState.stage === 'leader-s') {
      return [
        {
          keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderSearchVaultText'),
          label: 'Search vault text',
          detail: 'Fuzzy-search note contents across the vault.'
        }
      ]
    }

    const items: WhichKeyItem[] = [
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderOpenBuffers'),
        label: 'Open buffers',
        detail: 'Show the active pane’s open buffers in a searchable list.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderSearchNotes'),
        label: 'Search notes',
        detail: 'Open the vault-wide note search palette.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderSearchGroup'),
        label: 'Search…',
        detail: 'Open the search group — then `t` for vault text search.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.hintMode'),
        label: 'Hint mode',
        detail: 'Show jump labels to click any button or link by keyboard.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderToggleSidebar'),
        label: 'Toggle sidebar',
        detail: 'Show or hide the left sidebar.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderNoteOutline'),
        label: 'Note outline',
        detail: 'Jump to any heading in the active note.'
      },
      ...(canSwitchVaults
        ? [
            {
              keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderSwitchVault'),
              label: 'Switch vault',
              detail: 'Open the command palette vault switcher for local and remote vaults.'
            }
          ]
        : []),
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderQuickCapture'),
        label: 'Quick capture',
        detail: 'Open the floating capture window.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderTemplatePicker'),
        label: 'New from template',
        detail: 'Create a note from a built-in or custom template.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderInsertTemplate'),
        label: 'Insert template into note',
        detail: 'Render a template into the current note.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderDailyNote'),
        label: "Today's daily note",
        detail: 'Open or create the daily note for today.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderWeeklyNote'),
        label: "This week's note",
        detail: 'Open or create the weekly note for this week.'
      },
      {
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderCalendar'),
        label: 'Toggle calendar',
        detail: 'Show or hide the calendar for the active daily/weekly note.'
      }
    ]
    if (whichKeyState.allowEditorActions) {
      items.push({
        keyLabel: getKeymapDisplay(keymapOverrides, 'vim.leaderNoteActions'),
        label: 'Note actions',
        detail: 'Open the note-local leader group. `f` formats the current note.'
      })
    }
    return items
  })()

  useEffect(() => {
    if (vimMode) return
    ctrlWPending.current = false
    jumpTopPending.current = 0
    previousBufferPending.current = 0
    nextBufferPending.current = 0
    zFolderNavPending.current = null
    if (collapseAllReanchorRaf.current) cancelAnimationFrame(collapseAllReanchorRaf.current)
    if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)
    if (jumpTopTimer.current) clearTimeout(jumpTopTimer.current)
    if (zFolderNavTimer.current) clearTimeout(zFolderNavTimer.current)
    if (previousBufferTimer.current) clearTimeout(previousBufferTimer.current)
    if (nextBufferTimer.current) clearTimeout(nextBufferTimer.current)
    if (leaderTimer.current) clearTimeout(leaderTimer.current)
    resetLeader()
    setHint(false)
  }, [resetLeader, setHint, vimMode])

  useEffect(() => {
    if (!vimMode) return
    const handler = (e: KeyboardEvent): void => {
      const state = useStore.getState()
      const overrides = state.keymapOverrides
      const leaderToken = getSequenceTokens(overrides, 'vim.leaderPrefix')[0] ?? 'Space'
      const panePrefixToken = getSequenceTokens(overrides, 'vim.panePrefix')[0] ?? 'Ctrl+W'

      // Skip when modals / overlays are open
      if (
        state.searchOpen ||
        state.vaultTextSearchOpen ||
        state.settingsOpen ||
        state.commandPaletteOpen ||
        state.bufferPaletteOpen
      ) return
      if (
        document.querySelector('[data-ctx-menu]') ||
        document.querySelector('[data-prompt-modal]') ||
        document.querySelector('[data-confirm-modal]')
      ) return

      // Hint mode — handled entirely by HintOverlay's own listener
      if (hintRef.current) return

      // `e.target` is only an HTMLElement for real DOM-dispatched events.
      // Synthetic events fired at `window`/`document` (e.g. programmatic
      // shortcuts) have a non-Element target, so narrow with `instanceof`
      // before touching Element-only methods like `.closest()`.
      const target = e.target instanceof HTMLElement ? e.target : null
      const tag = target?.tagName
      // Never steal keys from normal text-entry fields such as the
      // inline note title, prompt inputs, or textarea-based controls.
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      // The selection format toolbar handles its own keyboard navigation
      // (arrows / Enter / Esc) once focused — yield to it entirely.
      if (target?.closest('[data-selection-toolbar]')) return
      // The home view owns its own roving-focus navigation (↑/↓/j/k/Enter), but
      // it does not handle the leader key — so the leader (and any pending leader
      // sequence) must fall through to VimNav, or Space-as-leader is swallowed
      // while the home view is focused (no note open). (#273)
      if (
        shouldYieldToHomeNav(
          target,
          sequenceTokenFromEvent(e) === leaderToken,
          !!leaderPending.current
        )
      ) {
        return
      }
      // CodeMirror's editor surface is contenteditable; keep global
      // hint/navigation bindings working there. Only skip other
      // unrelated contenteditable widgets.
      // The pinned-ref pane is also a CM contenteditable outside editorViewRef —
      // let Ctrl+W and leader sequences through (same pattern as data-zen-db-grid
      // above), but block everything else so Vim's own j/k/h/l cursor movement
      // stays with the pinned-ref editor.
      const inPinnedRef = !!target?.closest('[data-pane-id="pinned-ref"]')
      // Compute pinned-ref insert mode once; reused in Ctrl+W and leader guards.
      let pinnedRefInInsertMode = false
      if (inPinnedRef && state.vimMode) {
        const cmEl = target?.closest('.cm-editor') as HTMLElement | null
        if (cmEl) {
          const pv = EditorView.findFromDOM(cmEl)
          if (pv) pinnedRefInInsertMode = isEditorInsertMode(pv, state.vimMode)
        }
      }
      if (
        target?.isContentEditable &&
        (!state.editorViewRef || !state.editorViewRef.dom.contains(target))
      ) {
        const isCtrlWRelated = ctrlWPending.current || sequenceTokenFromEvent(e) === panePrefixToken
        const isLeaderRelated = leaderPending.current !== null || sequenceTokenFromEvent(e) === leaderToken
        if (!inPinnedRef || (!isCtrlWRelated && !isLeaderRelated)) {
          return
        }
      }
      // #285: when focus is inside the calendar panel, stand down entirely — it
      // owns its keys (h/j/k/l + arrows for day navigation, Escape to leave) via
      // its own focus-gated capture handler. Without this the pane-nav/leader
      // routing below would hijack the arrows. We don't consume the event, so
      // the panel's handler (and any global app shortcut) still sees it.
      const calendarPanelEl = document.querySelector('[data-calendar-panel]')
      if (calendarPanelEl && target && calendarPanelEl.contains(target)) return
      // #309: In an Excalidraw canvas, hold-Space pans (the Hand tool). Don't
      // swallow the Space keydown as the leader — let it reach Excalidraw so
      // panning works, and arm the leader only on a quick TAP (see the keyup
      // handler). Record the press time here and yield; other keys fall through
      // to normal routing. Skip while a leader sequence is already pending so its
      // follow-up key still routes as a leader command.
      if (
        sequenceTokenFromEvent(e) === leaderToken &&
        !leaderPending.current &&
        target?.closest('[data-excalidraw-view]')
      ) {
        if (!e.repeat) excalidrawSpaceDownAt.current = Date.now()
        return
      }
      const previewEl = getPreviewScrollElement()
      const hoverPreviewEl = getHoverPreviewScrollElement()

      // Inline-format shortcuts (Bold/Italic/Strike/Highlight/Code/Math/Link)
      // mirror the selection toolbar. Handled here — in the window capture
      // handler — so they work on every platform and beat Vim's own Ctrl
      // chords (e.g. <C-b>) in normal/visual mode on Linux/Windows. `Mod`
      // resolves to ⌘ on macOS and Ctrl elsewhere.
      const fmtView = state.editorViewRef
      if (fmtView && isEditorFocused(fmtView)) {
        // Focus the selection toolbar (when shown) for keyboard navigation.
        if (matchesShortcutBinding(e, 'Mod+/')) {
          const firstItem = document.querySelector<HTMLElement>(
            '[data-selection-toolbar] [data-toolbar-item]'
          )
          if (firstItem) {
            e.preventDefault()
            e.stopImmediatePropagation()
            firstItem.focus()
            return
          }
        }
        // Bindings in canonical modifier order (Shift before Mod), matching
        // `normalizeShortcutBinding` so `matchesShortcutBinding` compares equal.
        const formats: Array<[string, () => void]> = [
          ['Mod+B', () => toggleWrap(fmtView, '**')],
          ['Mod+I', () => toggleWrap(fmtView, '*')],
          ['Mod+E', () => toggleWrap(fmtView, '`')],
          ['Shift+Mod+S', () => toggleWrap(fmtView, '~~')],
          ['Shift+Mod+H', () => toggleWrap(fmtView, '==')],
          ['Shift+Mod+M', () => toggleWrap(fmtView, '$')],
          ['Mod+K', () => wrapLink(fmtView)]
        ]
        for (const [binding, run] of formats) {
          if (matchesShortcutBinding(e, binding)) {
            e.preventDefault()
            e.stopImmediatePropagation()
            run()
            return
          }
        }
      }

      const wantsJumpBack = matchesSequenceToken(e, overrides, 'vim.historyBack')
      const wantsJumpForward = matchesSequenceToken(e, overrides, 'vim.historyForward')
      if (
        (wantsJumpBack || wantsJumpForward) &&
        !isEditorInsertMode(state.editorViewRef, state.vimMode)
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        jumpNoteHistory(wantsJumpBack ? 'back' : 'forward')
        return
      }

      if (
        !leaderPending.current &&
        !(
          isEditorFocused(state.editorViewRef) &&
          isEditorInsertMode(state.editorViewRef, state.vimMode)
        )
      ) {
        const consumeBufferKey = (): void => {
          e.preventDefault()
          e.stopImmediatePropagation()
        }
        if (
          advanceSequence(
            e,
            getKeymapBinding(overrides, 'vim.bufferPrevious'),
            previousBufferPending,
            previousBufferTimer,
            () => navigateActiveBuffer(useStore.getState(), -1),
            consumeBufferKey
          )
        ) {
          return
        }
        if (
          advanceSequence(
            e,
            getKeymapBinding(overrides, 'vim.bufferNext'),
            nextBufferPending,
            nextBufferTimer,
            () => navigateActiveBuffer(useStore.getState(), 1),
            consumeBufferKey
          )
        ) {
          return
        }
      }

      // Surfaces that run their own keyboard loop, so past this point (leader +
      // the sidebar/note-list/connections navigation below) yield to them —
      // otherwise their Space / arrows / j/k/h/l etc. would be stolen as list
      // navigation or the leader key:
      //   - the database/table view's vim-style motion grid
      //   - the media player pane (Space play/pause, arrows seek/volume, m mute)
      // Placed AFTER the global shortcuts above (buffer nav, jump history,
      // inline-format) on purpose: those don't collide with any of these keys,
      // so they must keep working while the surface is focused instead of it
      // being a black hole. Ctrl+W (and its pending direction key) is still let
      // through so the surface hands off to pane/tab navigation like every
      // other one.
      if (
        target?.closest('[data-zen-db-grid], [data-zen-media-player]') &&
        !ctrlWPending.current &&
        sequenceTokenFromEvent(e) !== panePrefixToken
      ) {
        return
      }

      // ------- Ctrl+w pending → resolve panel / pane switch ------------
      if (ctrlWPending.current) {
        e.preventDefault()
        e.stopImmediatePropagation()
        ctrlWPending.current = false
        if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)
        clearEditorPendingVimStatus(state.editorViewRef)
        const editorHasFocus = isEditorFocused(state.editorViewRef)

        // <C-w>v / <C-w>s → vim-style splits. Clones the active pane's
        // current tab into a new pane. Works for any tab, including the
        // virtual Tasks tab (no CM editor required to fire `:vs`/`:sp`).
        if (
          matchesSequenceToken(e, overrides, 'vim.paneSplitRight') ||
          matchesSequenceToken(e, overrides, 'vim.paneSplitDown')
        ) {
          const activePath = state.selectedPath
          if (activePath) {
            void state.splitPaneWithTab({
              targetPaneId: state.activePaneId,
              edge: matchesSequenceToken(e, overrides, 'vim.paneSplitRight') ? 'right' : 'bottom',
              path: activePath
            })
          }
          return
        }

        // When focus is in the editor and we have multiple panes in the
        // split tree, try pane-internal navigation first. If a neighbor
        // pane exists in the requested direction, jump to it and stop.
        // Falling through to panel nav only happens at the tree edge.
        const paneDir =
          matchesSequenceToken(e, overrides, 'vim.paneFocusLeft') || e.key === 'ArrowLeft'
            ? 'h'
            : matchesSequenceToken(e, overrides, 'vim.paneFocusRight') || e.key === 'ArrowRight'
              ? 'l'
              : matchesSequenceToken(e, overrides, 'vim.paneFocusDown') || e.key === 'ArrowDown'
                ? 'j'
                : matchesSequenceToken(e, overrides, 'vim.paneFocusUp') || e.key === 'ArrowUp'
                  ? 'k'
                  : null
        if (
          paneDir === 'k' &&
          (editorHasFocus ||
            state.focusedPanel === 'editor' ||
            state.focusedPanel === null) &&
          focusTabs()
        ) {
          return
        }

        if (paneDir === 'j' && state.focusedPanel === 'tabs') {
          focusEditor()
          return
        }

        if (
          paneDir &&
          (editorHasFocus ||
            state.focusedPanel === 'editor' ||
            state.focusedPanel === 'tabs' ||
            state.focusedPanel === null) &&
          focusPaneInDirection(paneDir)
        ) {
          return
        }

        const panels = getVisiblePanels(
          state.sidebarOpen,
          state.noteListOpen,
          state.unifiedSidebar,
          document.querySelector('[data-connections-panel]') !== null,
          document.querySelector('[data-comments-panel]') !== null,
          isTasksViewActive(state),
          document.querySelector('[data-calendar-panel]') !== null
        )
        const direction =
          matchesSequenceToken(e, overrides, 'vim.paneFocusLeft') ||
          matchesSequenceToken(e, overrides, 'vim.paneFocusUp') ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowUp'
            ? 'left'
            : matchesSequenceToken(e, overrides, 'vim.paneFocusRight') ||
                matchesSequenceToken(e, overrides, 'vim.paneFocusDown') ||
                e.key === 'ArrowRight' ||
                e.key === 'ArrowDown'
              ? 'right'
              : null
        const currentPanel = editorHasFocus
          ? 'editor'
          : state.focusedPanel === 'tabs'
            ? 'editor'
          : state.focusedPanel === 'hoverpreview'
            ? 'connections'
            : state.focusedPanel
        const next = direction ? resolveNextPanel(currentPanel, direction, panels) : null
        if (!next) return

        if (next === 'sidebar' && !state.sidebarOpen) state.toggleSidebar()
        state.setFocusedPanel(next)
        if (next === 'editor') {
          state.editorViewRef?.focus()
        } else if (next === 'tasks') {
          // Tasks panel doesn't own a single focusable element — its
          // keyboard handler fires off window keydown. Just blur whatever
          // had DOM focus so the sidebar/notelist stop intercepting keys.
          ;(document.activeElement as HTMLElement)?.blur()
        } else if (next === 'comments') {
          ;(document.activeElement as HTMLElement)?.blur()
          requestAnimationFrame(() => {
            focusCommentsPanel(state)
          })
        } else if (next === 'calendar') {
          // Focus the calendar so its own handler takes over; the CalendarPanel
          // also focuses itself via its focusedPanel effect as a backstop. (#285)
          ;(document.activeElement as HTMLElement)?.blur()
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLElement>('[data-calendar-panel]')
              ?.focus({ preventScroll: true })
          })
        } else if (next === 'sidebar' && state.activeNote) {
          // Landing on the sidebar: reveal the note being edited (retry-based,
          // so it survives the render race) instead of scrolling to a stale
          // cursor row — same behaviour as the Focus Sidebar command.
          ;(document.activeElement as HTMLElement)?.blur()
          state.requestSidebarReveal({ kind: 'leaf', path: state.activeNote.path })
        } else {
          // Steal focus away from the editor so it stops processing keys
          ;(document.activeElement as HTMLElement)?.blur()
          requestAnimationFrame(() => {
            const selector =
              next === 'sidebar'
                ? '[data-sidebar-idx]'
                : next === 'notelist'
                  ? '[data-notelist-idx]'
                  : '[data-connections-idx]'
            const datasetKey =
              next === 'sidebar'
                ? 'sidebarIdx' as const
                : next === 'notelist'
                  ? 'notelistIdx' as const
                  : 'connectionsIdx' as const
            const cursorIndex =
              next === 'sidebar'
                ? state.sidebarCursorIndex
                : next === 'notelist'
                  ? state.noteListCursorIndex
                  : state.connectionsCursorIndex
            const setIndex =
              next === 'sidebar'
                ? state.setSidebarCursorIndex
                : next === 'notelist'
                  ? state.setNoteListCursorIndex
                  : state.setConnectionsCursorIndex
            const items = getIndexedElements(selector, datasetKey)
            if (items.length > 0) {
              const pos = findPositionByIndex(items, datasetKey, cursorIndex)
              scrollToIndexedElement(items[pos], datasetKey, setIndex)
            }
          })
        }
        return
      }

      // ------- Ctrl+w initiation ----------------------------------------
      if (sequenceTokenFromEvent(e) === panePrefixToken) {
        if (isEditorFocused(state.editorViewRef) && isEditorInsertMode(state.editorViewRef, state.vimMode)) return
        if (pinnedRefInInsertMode) return
        e.preventDefault()
        e.stopImmediatePropagation()
        // Mark focusedPanel='editor' for both main editor and pinned-ref so the
        // resolution block below can always call focusPaneInDirection correctly,
        // even when focus arrived by click (leaving focusedPanel stale).
        if (isEditorFocused(state.editorViewRef) || inPinnedRef) state.setFocusedPanel('editor')
        clearEditorPendingVimStatus(state.editorViewRef)
        ctrlWPending.current = true
        if (ctrlWTimer.current) clearTimeout(ctrlWTimer.current)
        ctrlWTimer.current = setTimeout(() => {
          ctrlWPending.current = false
          clearEditorPendingVimStatus(useStore.getState().editorViewRef)
        }, 800)
        return
      }

      // Cancel a pending leader sequence on Escape or a second leader press.
      if (leaderPending.current && e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        resetLeader()
        return
      }
      if (
        leaderPending.current &&
        sequenceTokenFromEvent(e) === leaderToken
      ) {
        e.preventDefault()
        e.stopImmediatePropagation()
        resetLeader()
        return
      }
      // ------- Tasks / Tag view active → defer to its own window handler
      // Both panels install capture-phase window keydowns that handle
      // j/k/gg/G/Enter/x/Esc/etc. themselves, so we bail and let them — with
      // one exception: leader input. The leader (Space) and any in-progress
      // leader sequence fall through to the leader logic below so <leader>h
      // (hint mode) and every other leader command work in these panels too.
      // VimNav consumes the leader keypress before TasksView sees it, so the
      // leader no longer collides with Space-to-toggle. (#151)
      const panelViewActive = isTasksViewActive(state) || isTagsViewActive(state)
      if (
        panelViewActive &&
        !leaderPending.current &&
        sequenceTokenFromEvent(e) !== leaderToken
      ) {
        return
      }

      // ------- Global leader handling -----------------------------------
      // Runs before per-panel routing so <Space>-prefixed shortcuts work
      // from any focus context (sidebar, note list, editor, …). Editor-
      // specific leader chains (leader-l-f for format) still require an
      // editor in normal mode; the others are purely UI actions.
      const editorNormalMode =
        isEditorFocused(state.editorViewRef) &&
        !isEditorInsertMode(state.editorViewRef, state.vimMode)
      const editorInsertMode =
        isEditorFocused(state.editorViewRef) &&
        isEditorInsertMode(state.editorViewRef, state.vimMode)

      if (leaderPending.current === 'leader') {
        if (matchesSequenceToken(e, overrides, 'vim.leaderSearchGroup')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          armLeader('leader-s', editorNormalMode)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderSearchNotes')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setSearchOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderOpenBuffers')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setBufferPaletteOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.hintMode')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          setHint(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderToggleSidebar')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.toggleSidebar()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderNoteOutline')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setOutlinePaletteOpen(true)
          return
        }
        if (canSwitchVaults && matchesSequenceToken(e, overrides, 'vim.leaderSwitchVault')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setCommandPaletteOpen(true, 'vault')
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderNoteActions') && editorNormalMode) {
          e.preventDefault()
          e.stopImmediatePropagation()
          armLeader('leader-l', true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderQuickCapture')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void window.zen.toggleQuickCapture()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderTemplatePicker')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setTemplatePaletteOpen(true)
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderInsertTemplate')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.openTemplatePaletteForInsert()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderDailyNote')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.openTodayDailyNote()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderWeeklyNote')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.openThisWeekWeeklyNote()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderCalendar')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          // If the calendar is opening (not already shown), move focus into it
          // once it mounts — the CalendarPanel focuses itself when it sees
          // focusedPanel === 'calendar'. If it's closing, leave focus alone. (#285)
          const wasOpen = document.querySelector('[data-calendar-panel]') !== null
          window.dispatchEvent(new Event('zen:toggle-calendar'))
          if (!wasOpen) state.setFocusedPanel('calendar')
          return
        }
        // Any other key cancels leader and falls through to normal routing.
        resetLeader()
      }

      if (leaderPending.current === 'leader-l') {
        if (matchesSequenceToken(e, overrides, 'vim.leaderFormatNote') && editorNormalMode) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.formatActiveNote()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderCopyMarkdown')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.copyActiveNoteAsMarkdown()
          return
        }
        if (matchesSequenceToken(e, overrides, 'vim.leaderToggleFavorite')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          void state.toggleFavoriteActiveNote()
          return
        }
        resetLeader()
      }

      if (leaderPending.current === 'leader-s') {
        if (matchesSequenceToken(e, overrides, 'vim.leaderSearchVaultText')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          resetLeader()
          state.setVaultTextSearchOpen(true)
          return
        }
        resetLeader()
      }

      // In the tasks/tags panels, only leader input is handled above; hand
      // every other key (including a just-reset leader sequence) back to the
      // panel's own capture handler. (#151)
      if (panelViewActive && sequenceTokenFromEvent(e) !== leaderToken) {
        return
      }

      if (
        sequenceTokenFromEvent(e) === leaderToken &&
        !editorInsertMode &&
        !pinnedRefInInsertMode &&
        // While Vim is mid-command in the focused editor (e.g. after f/t/r or an
        // operator), Space is the command's argument (r<Space>, f<Space>), not
        // the leader — let it fall through to codemirror-vim. (#147)
        !(isEditorFocused(state.editorViewRef) && isVimAwaitingArgument(state.editorViewRef))
      ) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault()
          e.stopImmediatePropagation()
          armLeader('leader', editorNormalMode)
          return
        }
      }

      // ------- Half-page scroll (universal) -----------------------------
      // Ctrl+D / Ctrl+U scroll the visible preview regardless of which
      // panel currently owns focus. Without this, clicking into the
      // sidebar or note list would silently disable these Vim motions
      // because the panel-specific handlers below don\u2019t know about
      // them. Exceptions: don\u2019t hijack when the user is typing in
      // an input/textarea, when the editor is in insert mode, or when
      // a leader sequence is pending.
      {
        const wantsHalf =
          matchesSequenceToken(e, overrides, 'nav.halfPageDown') ||
          matchesSequenceToken(e, overrides, 'nav.halfPageUp')
        if (wantsHalf && previewEl && !leaderPending.current && !editorInsertMode) {
          const tag = (e.target as HTMLElement | null)?.tagName
          if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
            e.preventDefault()
            e.stopImmediatePropagation()
            const step = getPreviewPageStep(previewEl)
            const down = matchesSequenceToken(e, overrides, 'nav.halfPageDown')
            scrollPreviewBy(previewEl, down ? step : -step)
            return
          }
        }
      }

      const wantsEditorTextContextMenu =
        isEditorFocused(state.editorViewRef) &&
        !editorInsertMode &&
        !state.editorViewRef?.state.selection.main.empty &&
        (matchesSequenceToken(e, overrides, 'nav.contextMenu') || wantsNativeContextMenuKey(e))
      if (wantsEditorTextContextMenu) {
        e.preventDefault()
        e.stopImmediatePropagation()
        window.dispatchEvent(new Event(ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT))
        return
      }

      // A focused breadcrumb folder crumb (e.g. reached via hint mode) owns the
      // context-menu key — open *its* create menu, not the sidebar item's.
      {
        const activeCrumb = document.activeElement as HTMLElement | null
        if (
          activeCrumb?.hasAttribute('data-crumb-menu') &&
          (matchesSequenceToken(e, overrides, 'nav.contextMenu') || wantsNativeContextMenuKey(e))
        ) {
          e.preventDefault()
          e.stopImmediatePropagation()
          const rect = activeCrumb.getBoundingClientRect()
          activeCrumb.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: Math.round(rect.left),
              clientY: Math.round(rect.bottom + 2)
            })
          )
          return
        }
      }

      // ------- Sidebar navigation (explicit) -----------------------------
      // When focusedPanel is 'sidebar', always handle here — even if the
      // editor still holds stale DOM focus from a previous interaction.
      if (state.focusedPanel === 'sidebar') {
        handleSidebarKey(e, state)
        return
      }

      if (state.focusedPanel === 'connections') {
        handleConnectionsKey(e, state)
        return
      }

      if (state.focusedPanel === 'comments') {
        handleCommentsKey(e, state)
        return
      }

      if (state.focusedPanel === 'tabs') {
        handleTabsKey(e, state)
        return
      }

      if (hoverPreviewEl && state.focusedPanel === 'hoverpreview') {
        handleHoverPreviewKey(e, hoverPreviewEl, state)
        return
      }

      // ------- Editor focused -------------------------------------------
      if (isEditorFocused(state.editorViewRef)) {
        if (isEditorInsertMode(state.editorViewRef, state.vimMode)) {
          resetLeader()
        }

        const hasEditorSelection = !state.editorViewRef?.state.selection.main.empty
        const wantsTextContextMenu =
          hasEditorSelection &&
          !isEditorInsertMode(state.editorViewRef, state.vimMode) &&
          (matchesSequenceToken(e, overrides, 'nav.contextMenu') || wantsNativeContextMenuKey(e))
        if (wantsTextContextMenu) {
          e.preventDefault()
          e.stopImmediatePropagation()
          window.dispatchEvent(new Event(ZEN_OPEN_EDITOR_CONTEXT_MENU_EVENT))
          return
        }

        if (wantsNativeContextMenuKey(e) && openActiveTabContextMenu(state)) {
          e.preventDefault()
          e.stopImmediatePropagation()
          return
        }

        // `f` (and operator+motion sequences like df/cf/yf) are Vim find-char
        // motions here — hint mode lives on the leader (<leader>h) so it never
        // hijacks them. (#107)
        return
      }

      resetLeader()

      // ------- Preview navigation --------------------------------------
      const wantsPreviewTabMenu =
        wantsNativeContextMenuKey(e) &&
        previewEl &&
        isPreviewNavigationActive(previewEl, state, target)
      if (wantsPreviewTabMenu && openActiveTabContextMenu(state)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }

      if (previewEl && isPreviewNavigationActive(previewEl, state, target)) {
        handlePreviewKey(e, previewEl, state)
        return
      }

      // ------- NoteList navigation --------------------------------------
      if (state.focusedPanel === 'notelist') {
        handleNoteListKey(e, state)
        return
      }

      // ------- Sidebar navigation — editor doesn't have DOM focus, so
      //         route to sidebar whenever it's open (regardless of
      //         focusedPanel, which can get stale via focus events) --------
      if (state.sidebarOpen) {
        handleSidebarKey(e, state)
        return
      }

    }

    // #309: arm the leader on a quick Space TAP inside an Excalidraw canvas. The
    // keydown was let through (above) so hold-Space pans; a fast release (under
    // the tap window) means the user tapped rather than held, so enter leader
    // mode. A longer hold was a pan and arms nothing.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (excalidrawSpaceDownAt.current == null) return
      const leaderToken =
        getSequenceTokens(useStore.getState().keymapOverrides, 'vim.leaderPrefix')[0] ?? 'Space'
      if (sequenceTokenFromEvent(e) !== leaderToken) return
      const downAt = excalidrawSpaceDownAt.current
      excalidrawSpaceDownAt.current = null
      const target = e.target instanceof HTMLElement ? e.target : null
      if (!target?.closest('[data-excalidraw-view]')) return
      if (Date.now() - downAt < EXCALIDRAW_LEADER_TAP_MS) {
        armLeader('leader', false)
      }
    }

    window.addEventListener('keydown', handler, true)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('keyup', onKeyUp, true)
      previousBufferPending.current = 0
      nextBufferPending.current = 0
      if (previousBufferTimer.current) clearTimeout(previousBufferTimer.current)
      if (nextBufferTimer.current) clearTimeout(nextBufferTimer.current)
      resetLeader()
    }
  }, [
    armLeader,
    jumpNoteHistory,
    resetLeader,
    setHint,
    stickyWhichKeyHints,
    vimMode,
    whichKeyHintTimeoutMs
  ]) // ← stable dep, handler never re-registers unnecessarily

  // ---- Key handlers (called from the single persistent handler) --------

  function handleSidebarKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    if (state.focusedPanel !== 'sidebar') state.setFocusedPanel('sidebar')
    // Isolated-mode "go up" ('-' by default). Acts on isolatedRoot, not the
    // cursor row, so it works from any row and even in an empty isolated folder
    // — handle it before the item-count guards below. Only claimed when
    // isolated, so '-' stays free otherwise.
    if (state.isolatedRoot && matchesSequenceToken(e, overrides, 'nav.isolateUp')) {
      e.preventDefault()
      e.stopImmediatePropagation()
      void goUpIsolationWithConfirm()
      return
    }
    let items = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
    // Quicklook constrains the cursor to rows that actually have a preview —
    // notes, assets, and folders — so j/k can't wander onto the vault header,
    // tags, System rows, or the bottom toolbar (which have nothing to show).
    if (state.quicklookActive) {
      const previewable = items.filter((el) => {
        const t = el.dataset.sidebarType
        return t === 'note' || t === 'asset' || t === 'folder'
      })
      if (previewable.length > 0) items = previewable
    }
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'sidebarIdx', state.sidebarCursorIndex)
    const wantsContextMenu =
      matchesSequenceToken(e, overrides, 'nav.contextMenu') ||
      key === 'ContextMenu' ||
      (e.shiftKey && key === 'F10')
    // Pure peek (no state mutation) for the wantsHandledKey gate below: would
    // this keystroke start, continue, or complete a z-folder-nav sequence?
    // The actual state machine runs later, in handleFolderZSequence.
    const zPeekToken = sequenceTokenFromEvent(e)
    const wantsFolderZKey =
      !!zPeekToken &&
      (zFolderNavPending.current !== null ||
        FOLDER_Z_IDS.some(
          (id) => getKeymapBinding(overrides, id).split(/\s+/)[0] === zPeekToken
        ))

    // Always consume single-char nav keys when sidebar is focused,
    // even if the sidebar is empty — prevents them leaking to the editor.
    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.toggleFolder') ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      matchesSequenceToken(e, overrides, 'nav.pageUp') ||
      matchesSequenceToken(e, overrides, 'nav.pageDown') ||
      wantsFolderZKey ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      wantsContextMenu
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return // not a nav key, let it through
    }

    if (count === 0) return // nothing to navigate

    // Must run before moveDown/moveUp: while a z-sequence is pending, its
    // second key (k/j for jumpFolderUp/Down) is *also* the plain move
    // binding — if move claimed it first, the z-sequence could never
    // complete and would just time out instead.
    if (handleFolderZSequence(e, state, items, currentPos)) {
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollToIndexedElement(items[Math.min(currentPos + 1, max)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollToIndexedElement(items[Math.max(currentPos - 1, 0)], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollToIndexedElement(items[max], 'sidebarIdx', state.setSidebarCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollToIndexedElement(items[0], 'sidebarIdx', state.setSidebarCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.pageUp')) {
      pageScrollSidebar(-1, state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.pageDown')) {
      pageScrollSidebar(1, state)
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      activateSidebarItem(items[currentPos], state, key === 'Enter')
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
      collapseSidebarItem(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.toggleFolder')) {
      toggleSidebarItem(items[currentPos], state)
      return
    }
    if (key === 'Escape') {
      // Second Escape while the filter is open (input already blurred to the
      // panel by the first Escape): exit and keep the picked row centered in
      // the restored tree. Otherwise Escape leaves the sidebar for the editor.
      const filter = state.sidebarFilter
      if (filter.active && filter.query.trim() !== '') {
        const el = items[currentPos]
        const type = el?.dataset.sidebarType
        let reveal: SidebarRevealTarget | null = null
        if ((type === 'note' || type === 'asset') && el?.dataset.sidebarPath) {
          reveal = { kind: 'leaf', path: el.dataset.sidebarPath }
        } else if (type === 'folder' && el?.dataset.sidebarFolder != null) {
          reveal = {
            kind: 'folder',
            folder: el.dataset.sidebarFolder,
            subpath: el.dataset.sidebarSubpath ?? ''
          }
        }
        state.requestSidebarReveal(reveal)
        state.closeSidebarFilter()
        state.setFocusedPanel('sidebar')
        return
      }
      focusEditor()
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      // `/` opens (or re-focuses) the sidebar's own incremental filter. Global
      // search stays on Mod+P and the leader. The focus effect in Sidebar moves
      // focus into the input.
      state.openSidebarFilter()
      return
    }
    if (wantsContextMenu) {
      openContextMenuForIndexedElement(items[currentPos])
      return
    }
  }

  // zM/zR/zk/zj all share "z" as their first token, so (unlike jumpTop's
  // single "g g" binding) advanceSequence's one-binding-per-call shape
  // doesn't fit — this fans a single pending "z" out to whichever of the
  // four completes on the next keystroke.
  const FOLDER_Z_IDS: KeymapId[] = [
    'nav.collapseAll',
    'nav.expandAll',
    'nav.jumpFolderUp',
    'nav.jumpFolderDown'
  ]

  /** Re-locates the sidebar cursor to whatever `resolveTarget()` currently
   *  returns, retrying across frames until its idx holds steady. Mirrors the
   *  sidebarRevealRequest effect's step loop (Sidebar.tsx) — same reason:
   *  `data-sidebar-idx` keeps getting reassigned for a few frames while a
   *  big collapse/expand settles, and pinning to a value read only once
   *  strands the cursor on whatever row later inherits that same number (a
   *  footer button, in practice). Re-invoking `resolveTarget` every frame
   *  (rather than a fixed selector) also lets a caller pick "whichever of
   *  these candidates currently sorts last," which depends on the live DOM
   *  and can't be precomputed once up front. */
  function reanchorSidebarCursor(
    resolveTarget: () => HTMLElement | null,
    state: ReturnType<typeof useStore.getState>
  ): void {
    if (collapseAllReanchorRaf.current) cancelAnimationFrame(collapseAllReanchorRaf.current)
    let waits = 0
    let frames = 0
    let stableFrames = 0
    let lastIdx = -1
    const step = (): void => {
      const el = resolveTarget()
      if (!el) {
        if (waits++ < 12) collapseAllReanchorRaf.current = requestAnimationFrame(step)
        return
      }
      const idx = Number(el.dataset.sidebarIdx)
      if (Number.isFinite(idx)) {
        state.setSidebarCursorIndex(idx)
        if (idx !== lastIdx) {
          el.scrollIntoView({ block: 'nearest' })
          lastIdx = idx
          stableFrames = 0
        } else {
          stableFrames++
        }
      }
      if (stableFrames < 3 && frames++ < 30) collapseAllReanchorRaf.current = requestAnimationFrame(step)
    }
    collapseAllReanchorRaf.current = requestAnimationFrame(step)
  }

  /** A CSS selector for the row the cursor should land on after collapse-all:
   *  `el` itself if it's already top-level, otherwise its top-level ancestor
   *  folder. Collapsing reassigns every row's idx (fewer rows get counted
   *  ahead of anything after a now-collapsed folder), so even an unmoved,
   *  already-top-level row needs re-locating by identity — its *old* idx
   *  number generally points at something else once the tree shrinks.
   *
   *  For notes, `data-sidebar-path` is `note.path` verbatim, which — unlike
   *  folder paths — drops the "inbox/" section prefix entirely when the
   *  vault has notes-at-root enabled (`vaultRelativeFolderPath`'s same
   *  special case). So the section and subpath must come from the note's
   *  real metadata (`noteFolderSubpath`), not by splitting the raw path on
   *  "/" — that misreads the first folder segment as the section name.
   *  Null only when `el` isn't a note/folder row, or the note can't be
   *  found (shouldn't happen for a row that's currently rendered). */
  function collapseAllTargetSelector(
    el: HTMLElement | undefined,
    state: ReturnType<typeof useStore.getState>
  ): string | null {
    if (!el) return null
    const type = el.dataset.sidebarType
    if (type === 'folder') {
      const folder = el.dataset.sidebarFolder
      const subpath = el.dataset.sidebarSubpath ?? ''
      if (!folder) return null
      const top = subpath ? subpath.split('/')[0] : ''
      return `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(top)}"]`
    }
    if (type === 'note') {
      const path = el.dataset.sidebarPath
      if (!path) return null
      const note = state.notes.find((n) => n.path === path)
      if (!note) return null
      const subpath = noteFolderSubpath(note, state.vaultSettings)
      if (!subpath) {
        // Already at the section root — notes aren't hidden by
        // folder-collapse, so target the note's own row.
        return `[data-sidebar-type="note"][data-sidebar-path="${escapeForAttr(path)}"]`
      }
      const top = subpath.split('/')[0]
      return `[data-sidebar-type="folder"][data-sidebar-folder="${note.folder}"][data-sidebar-subpath="${escapeForAttr(top)}"]`
    }
    return null
  }

  /** Resolves a sidebar row element to its vault-relative identity path
   *  (a note's `.path`, or a folder's `vaultRelativeFolderPath`), using real
   *  metadata rather than parsing the DOM path string — see
   *  collapseAllTargetSelector's note for why that matters under
   *  notes-at-root. Null for anything that isn't a note/folder row. */
  function pathOfSidebarEl(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): string | null {
    if (!el) return null
    const type = el.dataset.sidebarType
    if (type === 'note') return el.dataset.sidebarPath ?? null
    if (type === 'folder') {
      const folder = el.dataset.sidebarFolder as 'inbox' | 'quick' | 'archive' | 'trash' | undefined
      const subpath = el.dataset.sidebarSubpath ?? ''
      if (!folder) return null
      return vaultRelativeFolderPath(folder, subpath, state.vaultSettings) || folder
    }
    return null
  }

  /** The vault-relative paths of `parentDir`'s direct children — as a plain
   *  *set*, in no particular order. Deliberately not sorted here: the real
   *  visual order depends on whatever sort mode is active (manual, name,
   *  date, or file order), and `manualNoteOrder` only reflects one of those
   *  (Manual) — using it unconditionally would silently disagree with the
   *  sidebar whenever a different sort mode is active but the vault still
   *  has leftover manual-order data from once having used Manual sort.
   *  Ordering among this set is instead read live off the rendered DOM (see
   *  lastByDomOrder below), which is always correct for whichever sort mode
   *  is actually in effect. */
  function unorderedSiblingPaths(parentDir: string, state: ReturnType<typeof useStore.getState>): string[] {
    const result: string[] = []
    for (const n of state.notes) {
      if (parentDirOf(n.path) === parentDir) result.push(n.path)
    }
    for (const f of state.folders) {
      if (!f.subpath) continue
      const path = vaultRelativeFolderPath(f.folder, f.subpath, state.vaultSettings)
      if (path && parentDirOf(path) === parentDir) result.push(path)
    }
    return result
  }

  /** Among `paths` that are currently rendered, whichever is visually last
   *  under the active sort mode right now. Ordered by actual screen
   *  position (getIndexedElements' own sort), not by comparing
   *  `data-sidebar-idx` numbers directly — idx is only a stable per-row
   *  identifier here, not a reliable ordering key: a folder row gets its
   *  idx lazily (assigned inside its own SubTree component, when React
   *  renders it), while a note row's idx is assigned immediately, inline,
   *  during the *parent's* render pass — so a note can end up with a lower
   *  idx than folders that visually come before it. j/k's own move-up/down
   *  already accounts for this the same way (see getIndexedElements' sort
   *  comparator). Null if none of `paths` are currently visible (e.g. a
   *  folder whose children haven't rendered yet after an expand). */
  function lastByDomOrder(paths: string[], state: ReturnType<typeof useStore.getState>): HTMLElement | null {
    const pathSet = new Set(paths)
    const allRows = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
    let best: HTMLElement | null = null
    for (const row of allRows) {
      const path = pathOfSidebarEl(row, state)
      if (path && pathSet.has(path)) best = row // last match wins — allRows is in screen-position order
    }
    return best
  }

  /** Shared "next sibling by screen position, else bubble up to the
   *  parent's position and repeat" used by zj for both an empty folder and
   *  a last-in-level note: both cases reduce to "this item has nothing
   *  further at its own level, so treat its enclosing folder as the item
   *  and try again one level up." All levels involved are already visible
   *  (we could see `itemPath` itself), so ordering can be read directly off
   *  the live DOM without needing anything expanded first. Ordered by
   *  screen position for the same reason as lastByDomOrder above. */
  function nextSiblingOrBubbleUp(
    itemPath: string,
    itemParentDir: string,
    state: ReturnType<typeof useStore.getState>
  ): HTMLElement | null {
    const allRows = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
    const rowPaths = allRows.map((row) => pathOfSidebarEl(row, state))
    let currentItem = itemPath
    let currentParent = itemParentDir
    for (let depth = 0; depth < 64; depth++) {
      const candidateSet = new Set(unorderedSiblingPaths(currentParent, state))
      const levelIndices: number[] = []
      for (let i = 0; i < allRows.length; i++) {
        const p = rowPaths[i]
        if (p && candidateSet.has(p)) levelIndices.push(i)
      }
      const posInLevel = levelIndices.findIndex((i) => rowPaths[i] === currentItem)
      if (posInLevel !== -1 && posInLevel < levelIndices.length - 1) {
        return allRows[levelIndices[posInLevel + 1]]
      }
      if (!currentParent) return null // at a section root with nothing after — nowhere further to bubble
      const grandParent = parentDirOf(currentParent)
      if (grandParent === currentParent) return null // safety net against a malformed dir string
      currentItem = currentParent // the enclosing folder becomes the item to place next-of
      currentParent = grandParent
    }
    return null
  }

  function dispatchFolderZAction(
    id: KeymapId,
    state: ReturnType<typeof useStore.getState>,
    items: HTMLElement[],
    currentPos: number
  ): void {
    if (id === 'nav.collapseAll') {
      // Collapsing reshuffles idx values throughout the tree — leave the
      // cursor's stored index untouched and it resolves to some unrelated
      // row (or the last row) once the tree shrinks. Re-locate it by
      // identity instead: the collapsed item's top-level ancestor folder, or
      // itself if it was already top-level.
      const targetSelector = collapseAllTargetSelector(items[currentPos], state)
      state.collapseAllFolders()
      if (targetSelector) {
        reanchorSidebarCursor(() => document.querySelector<HTMLElement>(targetSelector), state)
      }
      return
    }
    if (id === 'nav.expandAll') {
      state.expandAllFolders()
      return
    }
    if (id === 'nav.jumpFolderUp') {
      for (let i = currentPos - 1; i >= 0; i--) {
        if (items[i].dataset.sidebarType === 'folder') {
          scrollToIndexedElement(items[i], 'sidebarIdx', state.setSidebarCursorIndex)
          return
        }
      }
      return
    }
    if (id === 'nav.jumpFolderDown') {
      const sourceEl = items[currentPos]
      const sourcePath = pathOfSidebarEl(sourceEl, state)
      if (!sourcePath) return
      const sourceKind = sourceEl?.dataset.sidebarType === 'folder' ? 'folder' : 'note'

      if (sourceKind === 'folder') {
        // "Has children" is a plain existence check (order doesn't matter
        // here), so it's safe to ask before anything is necessarily
        // rendered/expanded.
        const childPaths = unorderedSiblingPaths(sourcePath, state)
        if (childPaths.length > 0) {
          // Descending into the source folder's own children — they won't
          // be rendered yet if it's currently collapsed. Expand, then let
          // the resolver re-evaluate "whichever child currently sorts last"
          // each frame until the children have rendered and settled.
          const collapseKey = sourceEl?.dataset.sidebarKey
          if (collapseKey && state.collapsedFolders.includes(collapseKey)) {
            state.toggleCollapseFolder(collapseKey)
          }
          reanchorSidebarCursor(() => lastByDomOrder(childPaths, state), state)
          return
        }
        const bubbled = nextSiblingOrBubbleUp(sourcePath, parentDirOf(sourcePath), state)
        if (bubbled) reanchorSidebarCursor(() => bubbled, state)
        return
      }

      // note
      const parentDir = parentDirOf(sourcePath)
      const siblingPaths = unorderedSiblingPaths(parentDir, state)
      const sourceIdx = Number(sourceEl?.dataset.sidebarIdx)
      const last = lastByDomOrder(siblingPaths, state)
      if (last && Number.isFinite(sourceIdx) && Number(last.dataset.sidebarIdx) !== sourceIdx) {
        // Not already the last of its level — jump straight there.
        reanchorSidebarCursor(() => lastByDomOrder(siblingPaths, state), state)
        return
      }
      const bubbled = nextSiblingOrBubbleUp(sourcePath, parentDir, state)
      if (bubbled) reanchorSidebarCursor(() => bubbled, state)
    }
  }

  /** Returns true if this keystroke was consumed by the z-folder-nav family
   *  (either starting a pending sequence or completing/abandoning one). */
  function handleFolderZSequence(
    e: KeyboardEvent,
    state: ReturnType<typeof useStore.getState>,
    items: HTMLElement[],
    currentPos: number
  ): boolean {
    const overrides = state.keymapOverrides
    const tokensFor = (id: KeymapId): string[] =>
      getKeymapBinding(overrides, id)
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean)
    const token = sequenceTokenFromEvent(e)
    if (!token) return false

    const reset = (): void => {
      zFolderNavPending.current = null
      if (zFolderNavTimer.current) clearTimeout(zFolderNavTimer.current)
      zFolderNavTimer.current = undefined
    }

    if (zFolderNavPending.current) {
      const first = zFolderNavPending.current
      reset()
      const matchedId = FOLDER_Z_IDS.find((id) => {
        const tokens = tokensFor(id)
        return tokens.length === 2 && tokens[0] === first && tokens[1] === token
      })
      if (matchedId) dispatchFolderZAction(matchedId, state, items, currentPos)
      // Whether matched or abandoned, this keystroke was the second half of
      // a z-sequence — consume it either way (simpler than replicating vim's
      // fall-through-to-a-fresh-command semantics for a rare mistyped case).
      return true
    }

    const startsSequence = FOLDER_Z_IDS.some((id) => {
      const tokens = tokensFor(id)
      return tokens.length === 2 && tokens[0] === token
    })
    if (startsSequence) {
      zFolderNavPending.current = token
      // Generously long: unlike "gg" (same bare key twice), zM/zR need a
      // modifier switch (holding Shift) between the two keys, which takes
      // longer — and there's little cost to waiting, since nothing else
      // claims a lone "z" in the sidebar.
      zFolderNavTimer.current = setTimeout(reset, 2000)
      return true
    }
    return false
  }

  /** Ctrl+j/Ctrl+k: scroll the sidebar by roughly a page, then move the
   *  cursor to whatever row ends up at the top of the new view. */
  function pageScrollSidebar(direction: 1 | -1, state: ReturnType<typeof useStore.getState>): void {
    const container = document.querySelector<HTMLElement>('[data-sidebar-scroll-container]')
    if (!container) return
    container.scrollTop += direction * container.clientHeight
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const rows = getIndexedElements('[data-sidebar-idx]', 'sidebarIdx')
        if (rows.length === 0) return
        const containerTop = container.getBoundingClientRect().top
        const topRow =
          rows.find((row) => row.getBoundingClientRect().top >= containerTop - 1) ??
          rows[rows.length - 1]
        scrollToIndexedElement(topRow, 'sidebarIdx', state.setSidebarCursorIndex)
      })
    })
  }

  function handleNoteListKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const items = getIndexedElements('[data-notelist-idx]', 'notelistIdx')
    const count = getNoteListItemCount(items.length)
    const max = count - 1
    const currentIndex = clampIndex(state.noteListCursorIndex, count)
    const wantsContextMenu =
      matchesSequenceToken(e, overrides, 'nav.contextMenu') ||
      wantsNativeContextMenuKey(e)

    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      wantsContextMenu
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) return

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollToIndexedIndex(
        items,
        'notelistIdx',
        moveIndex(currentIndex, count, 1),
        state.setNoteListCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollToIndexedIndex(
        items,
        'notelistIdx',
        moveIndex(currentIndex, count, -1),
        state.setNoteListCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollToIndexedIndex(items, 'notelistIdx', max, state.setNoteListCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollToIndexedIndex(items, 'notelistIdx', 0, state.setNoteListCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      const el = getIndexedElementByIndex(items, 'notelistIdx', currentIndex)
      if (!el) {
        scrollToIndexedIndex(items, 'notelistIdx', currentIndex, state.setNoteListCursorIndex)
        return
      }
      const path = el?.dataset.notelistPath
      if (path) {
        void state.selectNote(path)
        focusEditor()
      }
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
      if (state.sidebarOpen) state.setFocusedPanel('sidebar')
      return
    }
    if (key === 'Escape') {
      focusEditor()
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }
    if (wantsContextMenu) {
      const el = getIndexedElementByIndex(items, 'notelistIdx', currentIndex)
      if (!el) {
        scrollToIndexedIndex(items, 'notelistIdx', currentIndex, state.setNoteListCursorIndex)
        return
      }
      openContextMenuForIndexedElement(el)
      return
    }
  }

  function handleConnectionsKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const items = getIndexedElements('[data-connections-idx]', 'connectionsIdx')
    const count = items.length
    const max = count - 1
    const currentPos = findPositionByIndex(items, 'connectionsIdx', state.connectionsCursorIndex)
    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.peekPreview') ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight'
    if (wantsHandledKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (count === 0) {
      if (key === 'Escape' || matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
        state.setConnectionPreview(null)
        focusEditor()
      }
      return
    }

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.min(currentPos + 1, max)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      state.setConnectionPreview(null)
      scrollToIndexedElement(
        items[Math.max(currentPos - 1, 0)],
        'connectionsIdx',
        state.setConnectionsCursorIndex
      )
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      state.setConnectionPreview(null)
      scrollToIndexedElement(items[max], 'connectionsIdx', state.setConnectionsCursorIndex)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          state.setConnectionPreview(null)
          scrollToIndexedElement(items[0], 'connectionsIdx', state.setConnectionsCursorIndex)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (key === 'Enter' || matchesSequenceToken(e, overrides, 'nav.openSideItem') || key === 'ArrowRight') {
      state.setConnectionPreview(null)
      activateConnectionItem(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.peekPreview')) {
      openConnectionPreview(items[currentPos], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft' || key === 'Escape') {
      state.setConnectionPreview(null)
      focusEditor()
      return
    }
  }

  function handleCommentsKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const target = e.target instanceof HTMLElement ? e.target : null
    const nativeButtonActivation =
      !!target?.closest('[data-comment-card-control]') &&
      (key === 'Enter' || key === ' ')
    if (nativeButtonActivation) return

    const items = getCommentItems()
    const count = items.length
    const max = count - 1
    const currentPos = findCommentPosition(items, state.activeCommentId)
    const wantsHandledKey =
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem') ||
      matchesSequenceToken(e, overrides, 'nav.back') ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      key === 'Enter' ||
      key === 'o' ||
      key === 'e' ||
      key === 'r' ||
      key === 'd' ||
      key === 'n' ||
      key === '+' ||
      key === 'Backspace' ||
      key === 'Delete' ||
      key === 'Escape' ||
      key === 'ArrowDown' ||
      key === 'ArrowUp' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight'
    if (!wantsHandledKey) return

    e.preventDefault()
    e.stopImmediatePropagation()
    if (state.focusedPanel !== 'comments') state.setFocusedPanel('comments')
    document.querySelector<HTMLElement>('[data-comments-panel]')?.focus({ preventScroll: true })

    if (key === 'Escape' || matchesSequenceToken(e, overrides, 'nav.back') || key === 'ArrowLeft') {
      focusEditor()
      return
    }
    if (key === 'n' || key === '+') {
      document.querySelector<HTMLElement>('[data-comments-new]')?.click()
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }

    if (count === 0) return

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollToCommentElement(items[Math.min(currentPos + 1, max)], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollToCommentElement(items[Math.max(currentPos - 1, 0)], state)
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollToCommentElement(items[max], state)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollToCommentElement(items[0], state)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }

    const current = items[currentPos]
    if (
      key === 'Enter' ||
      key === 'o' ||
      key === 'ArrowRight' ||
      matchesSequenceToken(e, overrides, 'nav.openSideItem')
    ) {
      activateCommentItem(current)
      return
    }
    if (key === 'e') {
      clickCommentAction(current, 'edit')
      return
    }
    if (key === 'r') {
      clickCommentAction(current, 'resolve')
      return
    }
    if (key === 'd' || key === 'Backspace' || key === 'Delete') {
      clickCommentAction(current, 'delete')
    }
  }

  function handleTabsKey(e: KeyboardEvent, state: ReturnType<typeof useStore.getState>): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const leaf = findLeaf(state.paneLayout, state.activePaneId)
    if (!leaf?.activeTab || leaf.tabs.length === 0 || !state.tabsEnabled || state.zenMode) {
      focusEditor()
      return
    }

    const wantsContextMenu =
      matchesSequenceToken(e, overrides, 'nav.contextMenu') ||
      wantsNativeContextMenuKey(e)
    const wantsHandledKey =
      key === 'h' ||
      key === 'l' ||
      key === 'j' ||
      key === 'Enter' ||
      key === 'Escape' ||
      key === 'ArrowLeft' ||
      key === 'ArrowRight' ||
      key === 'ArrowDown' ||
      wantsContextMenu
    if (!wantsHandledKey) return

    e.preventDefault()
    e.stopImmediatePropagation()

    const currentIdx = Math.max(0, leaf.tabs.indexOf(leaf.activeTab))
    const scrollActiveTab = (): void => {
      requestAnimationFrame(() => {
        const target = findTabContextMenuTarget(leaf.id, useStore.getState().selectedPath ?? '')
        target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    }

    if (key === 'h' || key === 'ArrowLeft') {
      const next = leaf.tabs[Math.max(0, currentIdx - 1)]
      if (next) {
        void state.focusTabInPane(leaf.id, next)
        scrollActiveTab()
      }
      return
    }
    if (key === 'l' || key === 'ArrowRight') {
      const next = leaf.tabs[Math.min(leaf.tabs.length - 1, currentIdx + 1)]
      if (next) {
        void state.focusTabInPane(leaf.id, next)
        scrollActiveTab()
      }
      return
    }
    if (key === 'j' || key === 'ArrowDown' || key === 'Enter' || key === 'Escape') {
      focusEditor()
      return
    }
    if (wantsContextMenu) {
      openActiveTabContextMenu(state)
    }
  }

  function handleHoverPreviewKey(
    e: KeyboardEvent,
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>
  ): void {
    if (
      e.key === 'Escape' ||
      matchesSequenceToken(e, state.keymapOverrides, 'nav.back') ||
      e.key === 'ArrowLeft'
    ) {
      e.preventDefault()
      e.stopImmediatePropagation()
      state.setConnectionPreview(null)
      state.setFocusedPanel('connections')
      requestAnimationFrame(() => {
        const items = getIndexedElements('[data-connections-idx]', 'connectionsIdx')
        const pos = findPositionByIndex(items, 'connectionsIdx', state.connectionsCursorIndex)
        scrollToIndexedElement(items[pos], 'connectionsIdx', state.setConnectionsCursorIndex)
      })
      return
    }
    handlePreviewKey(e, previewEl, state, 'hoverpreview')
  }

  function handlePreviewKey(
    e: KeyboardEvent,
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>,
    panel: 'editor' | 'hoverpreview' = 'editor'
  ): void {
    const key = e.key
    const overrides = state.keymapOverrides
    const navKeys = new Set([
      'ArrowDown',
      'ArrowUp',
      'PageDown',
      'PageUp',
      'Home',
      'End'
    ])
    const wantsHalfPageDown = matchesSequenceToken(e, overrides, 'nav.halfPageDown')
    const wantsHalfPageUp = matchesSequenceToken(e, overrides, 'nav.halfPageUp')
    const wantsContextMenu =
      (matchesSequenceToken(e, overrides, 'nav.contextMenu') ||
        wantsNativeContextMenuKey(e)) &&
      !!getActiveTabContextMenuTarget(state)

    if (
      navKeys.has(key) ||
      wantsHalfPageDown ||
      wantsHalfPageUp ||
      matchesSequenceToken(e, overrides, 'nav.moveDown') ||
      matchesSequenceToken(e, overrides, 'nav.moveUp') ||
      matchesSequenceToken(e, overrides, 'nav.jumpBottom') ||
      sequenceTokenFromEvent(e) === getSequenceTokens(overrides, 'nav.jumpTop')[0] ||
      matchesSequenceToken(e, overrides, 'nav.filter') ||
      wantsContextMenu
    ) {
      e.preventDefault()
      e.stopImmediatePropagation()
    } else {
      return
    }

    if (state.focusedPanel !== panel) state.setFocusedPanel(panel)

    if (matchesSequenceToken(e, overrides, 'nav.moveDown') || key === 'ArrowDown') {
      scrollPreviewBy(previewEl, getPreviewLineStep(previewEl))
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.moveUp') || key === 'ArrowUp') {
      scrollPreviewBy(previewEl, -getPreviewLineStep(previewEl))
      return
    }
    if (key === 'PageDown' || wantsHalfPageDown) {
      scrollPreviewBy(previewEl, getPreviewPageStep(previewEl))
      return
    }
    if (key === 'PageUp' || wantsHalfPageUp) {
      scrollPreviewBy(previewEl, -getPreviewPageStep(previewEl))
      return
    }
    if (key === 'Home') {
      scrollPreviewTo(previewEl, 0)
      return
    }
    if (key === 'End' || matchesSequenceToken(e, overrides, 'nav.jumpBottom')) {
      scrollPreviewTo(previewEl, previewEl.scrollHeight)
      return
    }
    if (
      advanceSequence(
        e,
        getKeymapBinding(overrides, 'nav.jumpTop'),
        jumpTopPending,
        jumpTopTimer,
        () => {
          scrollPreviewTo(previewEl, 0)
        },
        () => {
          e.preventDefault()
          e.stopImmediatePropagation()
        },
        300
      )
    ) {
      return
    }
    if (matchesSequenceToken(e, overrides, 'nav.filter')) {
      state.setSearchOpen(true)
      return
    }
    if (wantsContextMenu) {
      openActiveTabContextMenu(state)
      return
    }
  }

  // ---- Helpers ---------------------------------------------------------

  function getPreviewScrollElement(): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-preview-scroll]')].find(
      (el) => el.getClientRects().length > 0
    ) ?? null
  }

  function getHoverPreviewScrollElement(): HTMLElement | null {
    return [...document.querySelectorAll<HTMLElement>('[data-hover-preview-scroll]')].find(
      (el) => el.getClientRects().length > 0
    ) ?? null
  }

  function isPreviewNavigationActive(
    previewEl: HTMLElement,
    state: ReturnType<typeof useStore.getState>,
    target: HTMLElement | null
  ): boolean {
    if (isEditorFocused(state.editorViewRef)) return false
    if (target && previewEl.contains(target)) return true
    const active = document.activeElement as HTMLElement | null
    if (active && previewEl.contains(active)) return true
    return state.focusedPanel === 'editor'
  }

  function getPreviewLineStep(previewEl: HTMLElement): number {
    const content = previewEl.querySelector<HTMLElement>('[data-preview-content]')
    const style = window.getComputedStyle(content ?? previewEl)
    const lineHeight = Number.parseFloat(style.lineHeight)
    if (Number.isFinite(lineHeight)) return Math.max(20, lineHeight)
    const fontSize = Number.parseFloat(style.fontSize)
    if (Number.isFinite(fontSize)) return Math.max(20, fontSize * 1.6)
    return 28
  }

  function getPreviewPageStep(previewEl: HTMLElement): number {
    return Math.max(96, Math.round(previewEl.clientHeight * 0.5))
  }

  function scrollPreviewBy(previewEl: HTMLElement, delta: number): void {
    // Clamp explicitly instead of relying on the browser. scrollBy
    // with `behavior: 'smooth'` can occasionally overshoot-then-snap
    // on Chromium when two scroll requests collide (e.g. with the
    // split-mode scroll sync), which reads as "jumped to the top"
    // to the user at the end of the document.
    const maxTop = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight)
    const epsilon = 1
    const currentTop = Math.max(0, Math.min(maxTop, previewEl.scrollTop))
    const nextTop = Math.max(0, Math.min(maxTop, currentTop + delta))
    if (Math.abs(nextTop - currentTop) < epsilon) {
      const settledTop = nextTop <= epsilon ? 0 : maxTop
      // Chromium can keep a stale smooth-scroll animation alive at the
      // boundary; settle the element explicitly so repeated Ctrl+D /
      // Ctrl+U presses stop cleanly instead of appearing to wrap.
      previewEl.scrollTo({ top: settledTop, behavior: 'auto' })
      return
    }
    const smooth = useStore.getState().previewSmoothScroll
    const hitsBoundary = nextTop <= epsilon || nextTop >= maxTop - epsilon
    previewEl.scrollTo({
      top: nextTop,
      behavior: smooth && !hitsBoundary ? 'smooth' : 'auto'
    })
  }

  function scrollPreviewTo(previewEl: HTMLElement, top: number): void {
    const maxTop = Math.max(0, previewEl.scrollHeight - previewEl.clientHeight)
    const clamped = Math.max(0, Math.min(maxTop, top))
    previewEl.scrollTo({ top: clamped, behavior: 'auto' })
  }

  function getIndexedElements(
    selector: string,
    datasetKey: IndexedDatasetKey
  ): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((el) => el.getClientRects().length > 0)
      .sort((a, b) => {
        const aRect = a.getBoundingClientRect()
        const bRect = b.getBoundingClientRect()
        const rowDelta = aRect.top - bRect.top

        // Follow the actual rendered row order first, then fall back
        // to the assigned index for stable ordering within the same row.
        if (Math.abs(rowDelta) > 2) return rowDelta

        const colDelta = aRect.left - bRect.left
        if (Math.abs(colDelta) > 2) return colDelta

        return getIndexedValue(a, datasetKey) - getIndexedValue(b, datasetKey)
      })
  }

  function getIndexedValue(
    el: HTMLElement | null,
    datasetKey: IndexedDatasetKey
  ): number {
    const value = Number(el?.dataset[datasetKey] ?? -1)
    return Number.isFinite(value) ? value : -1
  }

  function getIndexedElementByIndex(
    items: HTMLElement[],
    datasetKey: IndexedDatasetKey,
    index: number
  ): HTMLElement | undefined {
    return items.find((item) => getIndexedValue(item, datasetKey) === index)
  }

  function getNoteListItemCount(renderedCount: number): number {
    const raw = document.querySelector<HTMLElement>('[data-notelist-count]')?.dataset.notelistCount
    const total = raw == null ? null : Number(raw)
    return boundedIndexCount(renderedCount, total != null && Number.isFinite(total) ? total : null)
  }

  /** Find position in sorted items array by stored cursor index (no DOM focus dependency). */
  function findPositionByIndex(
    items: HTMLElement[],
    datasetKey: IndexedDatasetKey,
    cursorIndex: number
  ): number {
    const exact = items.findIndex((item) => getIndexedValue(item, datasetKey) === cursorIndex)
    if (exact >= 0) return exact
    // Index not found (e.g. collapsed parent removed children) — clamp to valid range
    return items.length === 0 ? 0 : Math.max(0, Math.min(cursorIndex, items.length - 1))
  }

  /** Update the cursor index and scroll the element into view. */
  function scrollToIndexedElement(
    el: HTMLElement | undefined,
    datasetKey: IndexedDatasetKey,
    setIndex: (idx: number) => void
  ): void {
    if (!el) return
    const idx = getIndexedValue(el, datasetKey)
    if (idx < 0) return
    setIndex(idx)
    el.scrollIntoView({ block: 'nearest' })
  }

  function scrollToIndexedIndex(
    items: HTMLElement[],
    datasetKey: IndexedDatasetKey,
    index: number,
    setIndex: (idx: number) => void
  ): void {
    const target = getIndexedElementByIndex(items, datasetKey, index)
    setIndex(index)
    target?.scrollIntoView({ block: 'nearest' })
  }

  function getCommentItems(): HTMLElement[] {
    return getIndexedElements('[data-comments-idx]', 'commentsIdx')
  }

  function findCommentPosition(items: HTMLElement[], activeCommentId: string | null): number {
    if (items.length === 0) return 0
    if (!activeCommentId) return 0
    const exact = items.findIndex((item) => item.dataset.commentId === activeCommentId)
    return exact >= 0 ? exact : 0
  }

  function scrollToCommentElement(
    el: HTMLElement | undefined,
    state: ReturnType<typeof useStore.getState>
  ): void {
    if (!el) return
    const commentId = el.dataset.commentId
    if (commentId) state.setActiveCommentId(commentId)
    el.scrollIntoView({ block: 'nearest' })
  }

  function focusCommentsPanel(state: ReturnType<typeof useStore.getState>): void {
    const panel = document.querySelector<HTMLElement>('[data-comments-panel]')
    panel?.focus({ preventScroll: true })
    const items = getCommentItems()
    if (items.length === 0) return
    const pos = findCommentPosition(items, state.activeCommentId)
    scrollToCommentElement(items[pos], state)
  }

  function activateCommentItem(el: HTMLElement | undefined): void {
    if (!el) return
    el.click()
  }

  function clickCommentAction(el: HTMLElement | undefined, action: string): void {
    el?.querySelector<HTMLElement>(`[data-comment-action="${action}"]`)?.click()
  }

  function openContextMenuForIndexedElement(el: HTMLElement | undefined): void {
    if (!el) return
    dispatchKeyboardContextMenu(el)
  }

  function wantsNativeContextMenuKey(e: KeyboardEvent): boolean {
    return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
  }

  function getActiveTabContextMenuTarget(
    state: ReturnType<typeof useStore.getState>
  ): HTMLElement | null {
    const leaf = findLeaf(state.paneLayout, state.activePaneId)
    if (!leaf?.activeTab) return null
    return findTabContextMenuTarget(leaf.id, leaf.activeTab)
  }

  function openActiveTabContextMenu(
    state: ReturnType<typeof useStore.getState>
  ): boolean {
    const target = getActiveTabContextMenuTarget(state)
    if (!target) return false
    state.setFocusedPanel('editor')
    dispatchKeyboardContextMenu(target)
    return true
  }

  function activateSidebarItem(
    el: HTMLElement | undefined,
    state: ReturnType<typeof useStore.getState>,
    // True only for Enter. `l`/ArrowRight also route here but mean "descend
    // into the tree" — the difference matters for a database folder, where
    // Enter opens the grid but `l`/Right must just expand like any folder.
    isEnter: boolean
  ): void {
    if (!el) return
    // #301: Daily/Weekly date groups aren't real folders — `l`/Enter/Right
    // expands them via the store's date-nav state instead of navigating (which
    // snapped the cursor to the parent) with a no-op collapse toggle.
    const dateNavKey = el.dataset.sidebarDatenavKey
    if (dateNavKey) {
      state.expandDateNav(dateNavKey)
      return
    }
    // The Favorites heading acts like a folder for vim purposes but isn't
    // one — `l`/Enter/Right only ever expands (mirrors the real-folder
    // branch below, which also only toggles when currently collapsed).
    if (el.dataset.sidebarFavoritesHeading === 'true') {
      if (state.favoritesCollapsed) state.toggleFavoritesCollapsed()
      return
    }
    const itemType = el.dataset.sidebarType
    if (itemType === 'folder') {
      const folder = el.dataset.sidebarFolder as 'inbox' | 'quick' | 'archive' | 'trash'
      const subpath = el.dataset.sidebarSubpath ?? ''
      // A `<Name>.base` folder is a database. Enter opens its grid in the
      // editor pane, matching the row's click handler (which never touches
      // the collapse state either). `l`/ArrowRight, though, mean "expand into
      // the tree" — they fall through to the plain-folder branch below so the
      // database's record-page notes reveal like any folder's children.
      if (isEnter && isFormDirName(subpath)) {
        const csvPath = csvPathForFormDir(
          vaultRelativeFolderPath(folder, subpath, state.vaultSettings)
        )
        void state.openDatabase(csvPath)
        return
      }
      // A favorited inbox folder activates into isolation, matching its click.
      if (el.dataset.sidebarFavorite === 'true' && folder === 'inbox' && subpath) {
        state.enterIsolation('inbox', subpath)
        return
      }
      state.setView({ kind: 'folder', folder, subpath })
      const collapseKey = el.dataset.sidebarKey
      if (collapseKey && state.collapsedFolders.includes(collapseKey)) {
        state.toggleCollapseFolder(collapseKey)
      }
    } else if (itemType === 'note') {
      const path = el.dataset.sidebarPath
      if (path) {
        state.setFocusedPanel('editor')
        void state.selectNote(path).then(() => {
          // Focus after the note loads and the editor becomes visible
          requestAnimationFrame(() => {
            useStore.getState().editorViewRef?.focus()
          })
        })
      }
    } else if (itemType === 'tag') {
      const tag = el.dataset.sidebarTag
      if (tag) void state.openTagView(tag)
    } else if (itemType === 'vault') {
      openContextMenuForIndexedElement(el)
    } else if (itemType === 'tasks') {
      // Tasks is a top-level sidebar row that opens the vault-wide Tasks
      // tab in the active pane. Matches clicking the row.
      void state.openTasksView()
    } else if (itemType === 'help') {
      void state.openHelpView()
    } else if (itemType === 'settings') {
      state.setSettingsOpen(true)
    } else if (itemType === 'archive') {
      void state.openArchiveView()
    } else if (itemType === 'trash') {
      void state.openTrashView()
    } else if (itemType === 'assets') {
      void state.openAssetsView()
    }
  }

  function activateConnectionItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return
    const type = el.dataset.connectionsType
    if (type === 'note') {
      const path = el.dataset.connectionsPath
      if (!path) return
      state.setConnectionPreview(null)
      state.setFocusedPanel('editor')
      void state.selectNote(path).then(() => {
        requestAnimationFrame(() => {
          useStore.getState().editorViewRef?.focus()
        })
      })
      return
    }
    if (type === 'missing') {
      el.click()
    }
  }

  function openConnectionPreview(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el || el.dataset.connectionsType !== 'note') return
    const path = el.dataset.connectionsPath
    if (!path) return
    const note = state.notes.find((item) => item.path === path)
    if (!note) return
    const rect = el.getBoundingClientRect()
    state.setConnectionPreview({
      path: note.path,
      title: note.title,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    })
    state.setFocusedPanel('hoverpreview')
    requestAnimationFrame(() => {
      const previewEl = getHoverPreviewScrollElement()
      if (previewEl) {
        previewEl.focus({ preventScroll: true })
        return
      }
      requestAnimationFrame(() => {
        getHoverPreviewScrollElement()?.focus({ preventScroll: true })
      })
    })
  }

  function collapseSidebarItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return
    // #301: collapse a Daily/Weekly date group via the store's date-nav state.
    const dateNavKey = el.dataset.sidebarDatenavKey
    if (dateNavKey) {
      state.collapseDateNav(dateNavKey)
      return
    }
    // The Favorites heading acts like a folder for vim purposes but isn't
    // one — `h`/Left only ever collapses (no parent to fall back to, so
    // it's a no-op rather than moving focus when already collapsed).
    if (el.dataset.sidebarFavoritesHeading === 'true') {
      if (!state.favoritesCollapsed) state.toggleFavoritesCollapsed()
      return
    }

    const collapseFolder = (folderEl: HTMLElement | null): void => {
      if (!folderEl) return
      const collapseKey = folderEl.dataset.sidebarKey
      const focusFolderRow = (): void => {
        const freshFolderEl = collapseKey
          ? document.querySelector<HTMLElement>(
              `[data-sidebar-type="folder"][data-sidebar-key="${escapeForAttr(collapseKey)}"]`
            )
          : folderEl
        if (!freshFolderEl) return
        scrollToIndexedElement(freshFolderEl, 'sidebarIdx', state.setSidebarCursorIndex)
      }

      if (collapseKey && !state.collapsedFolders.includes(collapseKey)) {
        state.toggleCollapseFolder(collapseKey)
        requestAnimationFrame(() => {
          focusFolderRow()
        })
        return
      }

      focusFolderRow()
    }

    if (el.dataset.sidebarType === 'folder') {
      collapseFolder(el)
      return
    }

    if (el.dataset.sidebarType !== 'note') return
    const path = el.dataset.sidebarPath
    if (!path) return

    const parts = path.split('/')
    const folder = parts[0]
    const subpath = parts.slice(1, -1).join('/')
    const parentFolderEl = document.querySelector<HTMLElement>(
      `[data-sidebar-type="folder"][data-sidebar-folder="${folder}"][data-sidebar-subpath="${escapeForAttr(subpath)}"]`
    )
    collapseFolder(parentFolderEl)
  }

  function toggleSidebarItem(el: HTMLElement | undefined, state: ReturnType<typeof useStore.getState>): void {
    if (!el) return
    // #301: toggle a Daily/Weekly date group via the store's date-nav state.
    const dateNavKey = el.dataset.sidebarDatenavKey
    if (dateNavKey) {
      state.toggleDateNav(dateNavKey)
      return
    }
    if (el.dataset.sidebarFavoritesHeading === 'true') {
      state.toggleFavoritesCollapsed()
      return
    }
    if (el.dataset.sidebarType !== 'folder') return
    const collapseKey = el.dataset.sidebarKey
    if (collapseKey) state.toggleCollapseFolder(collapseKey)
  }

  if (!vimMode) return null

  if (hintActive) {
    return <HintOverlay onActivate={exitHints} onCancel={cancelHints} />
  }

  if (whichKeyHintsEnabled && whichKeyState) {
    const leaderDisplay = getKeymapDisplay(keymapOverrides, 'vim.leaderPrefix')
    const noteActionsDisplay = getKeymapDisplay(keymapOverrides, 'vim.leaderNoteActions')
    const searchGroupDisplay = getKeymapDisplay(keymapOverrides, 'vim.leaderSearchGroup')
    const subPrefix =
      whichKeyState.stage === 'leader-s' ? searchGroupDisplay : noteActionsDisplay
    return (
      <WhichKeyOverlay
        prefix={whichKeyState.stage === 'leader' ? leaderDisplay : `${leaderDisplay} ${subPrefix}`}
        title={
          whichKeyState.stage === 'leader'
            ? 'Leader'
            : whichKeyState.stage === 'leader-s'
              ? 'Leader · Search'
              : 'Leader · Note Actions'
        }
        detail={
          stickyWhichKeyHints
            ? `Press a key to continue. Press ${leaderDisplay} again or Esc to close.`
            : 'Press a key to continue or Esc to cancel.'
        }
        items={whichKeyItems}
      />
    )
  }

  return null
}
