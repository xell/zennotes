import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { requestPaneMode } from '../lib/pane-mode'
import { folderForVaultRelativePath, notePathWithinFolder } from '../lib/vault-layout'
import type { GitFileEntry, GitStatusResult } from '@shared/ipc'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'

// Minimal stand-in for TerminalPanel's buildXtermTheme: this view is a
// read-only, one-shot write (no PTY, no user theme preference to honor),
// so it only needs to pick up the app's current bg/fg rather than the
// full light/dark-per-user-setting machinery the real terminal panel has.
function xtermCssTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const rgb = (name: string): string | undefined => {
    const parts = css.getPropertyValue(name).trim().split(' ').map(Number)
    return parts.length === 3 ? `rgb(${parts.join(',')})` : undefined
  }
  return { background: rgb('--z-bg'), foreground: rgb('--z-fg') }
}

// Renders a `git log --graph --color=always` blob. xterm.js already knows
// how to parse ANSI SGR color codes, so there's no need to hand-roll an
// ANSI-to-React parser — this just feeds git's raw colored output straight
// into a non-interactive Terminal instance the same way TerminalPanel does
// for the real shell, minus the PTY session and input handling.
function GitLogView({ log }: { log: string }): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      disableStdin: true,
      cursorBlink: false,
      convertEol: true,
      fontFamily: 'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", monospace',
      fontSize: 12,
      theme: xtermCssTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    term.write(log || '\x1b[2m(no commits yet)\x1b[0m')
    requestAnimationFrame(() => fit.fit())
    const ro = new ResizeObserver(() => requestAnimationFrame(() => fit.fit()))
    ro.observe(container)
    return () => {
      ro.disconnect()
      term.dispose()
    }
  }, [log])

  return <div ref={containerRef} className="h-[40vh] overflow-hidden rounded-lg border border-paper-300/70 p-1" />
}

type FileGroup = 'staged' | 'unstaged' | 'untracked'
type FileKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

interface FileRow {
  key: string
  path: string
  origPath?: string
  kind: FileKind
  group: FileGroup
  /** What clicking this row should do — null for rows with nothing sensible
   *  to open (deleted files). 'diff' needs a git-index entry to compare
   *  against (`git show :0:<path>`), which untracked files don't have (never
   *  added, nothing in the index yet) — those just open normally instead.
   *  'reveal-folder' is for untracked *directories*: git's default status
   *  behavior collapses an entirely-new folder into one `?? path/` entry
   *  instead of listing every file inside it, so that entry isn't a note at
   *  all — there's nothing to "open", just a place to jump to in the tree. */
  click: 'diff' | 'open' | 'reveal-folder' | null
}

const KIND_BADGE: Record<FileKind, { letter: string; className: string }> = {
  added: { letter: 'A', className: 'text-emerald-600' },
  modified: { letter: 'M', className: 'text-amber-600' },
  deleted: { letter: 'D', className: 'text-danger' },
  renamed: { letter: 'R', className: 'text-sky-600' },
  untracked: { letter: '?', className: 'text-ink-400' }
}

const GROUP_TITLE: Record<FileGroup, string> = {
  staged: 'Staged',
  unstaged: 'Changed',
  untracked: 'Untracked'
}

const CLICK_LABEL: Record<'diff' | 'open' | 'reveal-folder', { title: string; hint: string }> = {
  diff: { title: 'Open diff view', hint: 'View diff' },
  open: { title: 'Open note', hint: 'Open' },
  'reveal-folder': { title: 'Locate in sidebar', hint: 'Locate' }
}

function flattenStatus(status: GitStatusResult): FileRow[] {
  const rows: FileRow[] = []
  const push = (entries: GitFileEntry[], kind: FileKind, group: FileGroup, click: FileRow['click']): void => {
    for (const entry of entries) {
      rows.push({
        key: `${group}:${kind}:${entry.path}`,
        path: entry.path,
        origPath: entry.origPath,
        kind,
        group,
        click
      })
    }
  }
  push(status.staged.added, 'added', 'staged', 'diff')
  push(status.staged.modified, 'modified', 'staged', 'diff')
  push(status.staged.renamed, 'renamed', 'staged', 'diff')
  push(status.staged.deleted, 'deleted', 'staged', null)
  push(status.unstaged.modified, 'modified', 'unstaged', 'diff')
  push(status.unstaged.deleted, 'deleted', 'unstaged', null)
  // Individually (per-entry, not per-array like the pushes above): git
  // reports an entirely-untracked directory as a single trailing-slash path
  // rather than every file inside it — a "folder row" mixed in with the
  // usual file rows, not something `push`'s one-click-for-the-whole-array
  // shape can express.
  for (const entry of status.untracked) {
    const isFolder = entry.path.endsWith('/')
    rows.push({
      key: `untracked:untracked:${entry.path}`,
      path: entry.path,
      kind: 'untracked',
      group: 'untracked',
      click: isFolder ? 'reveal-folder' : 'open'
    })
  }
  return rows
}

function hasStagedChanges(status: GitStatusResult): boolean {
  return (
    status.staged.added.length > 0 ||
    status.staged.modified.length > 0 ||
    status.staged.deleted.length > 0 ||
    status.staged.renamed.length > 0
  )
}

export function GitStatusModal(): JSX.Element {
  const setGitModalOpen = useStore((s) => s.setGitModalOpen)
  const onClose = useCallback(() => setGitModalOpen(false), [setGitModalOpen])

  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loadingInitial, setLoadingInitial] = useState(true)
  const [message, setMessage] = useState('update')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [committed, setCommitted] = useState(false)
  const [log, setLog] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.zen.gitStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      setLoadingInitial(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const openRow = useCallback(
    (path: string, mode: 'diff' | 'open' | 'reveal-folder'): void => {
      if (mode === 'reveal-folder') {
        const s = useStore.getState()
        // git's trailing slash marks a directory, not a note path — strip it
        // before treating this the same as any other vault-relative path.
        const rawPath = path.replace(/\/+$/, '')
        const folder = folderForVaultRelativePath(rawPath, s.vaultSettings)
        if (!folder) return
        const subpath = notePathWithinFolder(rawPath, folder, s.vaultSettings)
        // Same "open + focus + bump the tick" shape focusSidebar() uses to
        // grab real DOM focus — sidebarOpen must flip before the reveal
        // request lands, since <Sidebar> (and the effect that consumes
        // sidebarRevealRequest) isn't even mounted while it's closed.
        useStore.setState({
          sidebarOpen: true,
          focusedPanel: 'sidebar',
          sidebarFocusTick: s.sidebarFocusTick + 1
        })
        s.requestSidebarReveal({ kind: 'folder', folder, subpath })
        setGitModalOpen(false)
        return
      }
      void useStore
        .getState()
        .selectNote(path)
        .then(() => {
          if (mode === 'open') {
            setGitModalOpen(false)
            return
          }
          // selectNote's promise resolving only means the store's activeTab/
          // content are updated — it says nothing about whether React has
          // actually committed that into EditorPane yet, and the diff effect
          // there reads the CodeMirror view from a ref (not reactive state),
          // so requesting diff mode too early can see a stale/null view,
          // silently no-op, and never retry (nothing re-triggers that effect
          // once mode/activeTab stop changing). Two rAFs guarantees at least
          // one full paint has happened since the state update, the same
          // "wait for React to settle" idiom applyPaneMode itself already
          // uses below for focus timing.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestPaneMode('diff')
              setGitModalOpen(false)
            })
          })
        })
    },
    [setGitModalOpen]
  )

  const stageAll = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      setStatus(await window.zen.gitStageAll())
    } finally {
      setBusy(false)
    }
  }

  const unstageAll = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      setStatus(await window.zen.gitUnstageAll())
    } finally {
      setBusy(false)
    }
  }

  const commitNow = async (alreadyStaged: boolean): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      if (!alreadyStaged) setStatus(await window.zen.gitStageAll())
      const result = await window.zen.gitCommit(message.trim() || 'update')
      setStatus(result.status)
      if (!result.ok) {
        setActionError(result.error ?? 'Commit failed.')
        return
      }
      setCommitted(true)
      setLog(await window.zen.gitLog())
    } finally {
      setBusy(false)
    }
  }

  if (loadingInitial) {
    return (
      <Modal size="sm" onClose={onClose} data={{ 'data-git-modal': '' }}>
        <Modal.Body>
          <div className="py-6 text-center text-sm text-ink-500">Checking for a git repository…</div>
        </Modal.Body>
      </Modal>
    )
  }

  if (!status?.isRepo) {
    return (
      <Modal size="sm" onClose={onClose} data={{ 'data-git-modal': '' }}>
        <Modal.Header title="Git" />
        <Modal.Body>
          <div className="text-sm text-ink-500">This vault is not a git repository.</div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </Modal.Footer>
      </Modal>
    )
  }

  const rows = flattenStatus(status)
  const isClean = rows.length === 0
  const staged = hasStagedChanges(status)
  const groups: FileGroup[] = ['staged', 'unstaged', 'untracked']

  return (
    <Modal
      size="sm"
      onClose={onClose}
      labelledBy="git-modal-title"
      data={{ 'data-git-modal': '' }}
    >
      <Modal.Header
        title="Git"
        titleId="git-modal-title"
        description={status.branch ? `Branch: ${status.branch}` : undefined}
      />
      <Modal.Body className="flex flex-col gap-3">
        {committed && log !== null ? (
          <GitLogView log={log} />
        ) : (
          <div className="max-h-[40vh] overflow-y-auto rounded-lg border border-paper-300/70">
            {isClean ? (
              <div className="p-4 text-center text-sm text-ink-500">Working tree clean.</div>
            ) : (
              groups.map((group) => {
                const groupRows = rows.filter((row) => row.group === group)
                if (groupRows.length === 0) return null
                return (
                  <div key={group} className="border-b border-paper-300/50 last:border-b-0">
                    <div className="px-3 py-1.5 text-2xs font-medium uppercase tracking-wide text-ink-500">
                      {GROUP_TITLE[group]} ({groupRows.length})
                    </div>
                    {groupRows.map((row) => {
                      const badge = KIND_BADGE[row.kind]
                      const label = row.origPath ? `${row.origPath} → ${row.path}` : row.path
                      const content = (
                        <>
                          <span className={`w-4 shrink-0 text-center text-xs font-semibold ${badge.className}`}>
                            {badge.letter}
                          </span>
                          <span className="min-w-0 truncate text-sm text-ink-900">{label}</span>
                        </>
                      )
                      const click = row.click
                      return click ? (
                        <button
                          key={row.key}
                          type="button"
                          onClick={() => openRow(row.path, click)}
                          className="group flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-paper-200/70"
                          title={CLICK_LABEL[click].title}
                        >
                          {content}
                          <span className="shrink-0 text-2xs text-ink-500 opacity-0 transition-opacity group-hover:opacity-100">
                            {CLICK_LABEL[click].hint}
                          </span>
                        </button>
                      ) : (
                        <div key={row.key} className="flex items-center gap-2 px-3 py-1.5 opacity-60">
                          {content}
                        </div>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        )}
        {!committed && (
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="update"
            disabled={busy}
            className="w-full rounded-md border border-paper-300 bg-paper-50 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent"
          />
        )}
        {actionError && <div className="text-xs text-danger">{actionError}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {committed ? 'Close' : 'Cancel'}
        </Button>
        {!committed && (
          <>
            <Button
              variant="secondary"
              onClick={() => void (staged ? unstageAll() : stageAll())}
              disabled={busy || isClean}
            >
              {staged ? 'Unstage all' : 'Stage all'}
            </Button>
            <Button variant="primary" onClick={() => void commitNow(staged)} disabled={busy || isClean}>
              {busy ? 'Working…' : staged ? 'Commit' : 'Stage all and commit'}
            </Button>
          </>
        )}
      </Modal.Footer>
    </Modal>
  )
}
