import { useEffect } from 'react'
import { useStore } from '../store'
import { IsolateIcon } from './icons'
import { isTasksTabPath } from '@shared/tasks'
import { isTagsTabPath } from '@shared/tags'
import { isHelpTabPath } from '@shared/help'
import { isArchiveTabPath } from '@shared/archive'
import { isTrashTabPath } from '@shared/trash'
import { isQuickNotesTabPath } from '@shared/quick-notes'
import { resolveSystemFolderLabels } from '../lib/system-folder-labels'

export function TitleBar(): JSX.Element {
  const vault = useStore((s) => s.vault)
  const activeNote = useStore((s) => s.activeNote)
  const isolatedRoot = useStore((s) => s.isolatedRoot)
  const selectedPath = useStore((s) => s.selectedPath)
  const systemFolderLabels = useStore((s) => s.systemFolderLabels)
  const workspaceMode = useStore((s) => s.workspaceMode)
  const windowChrome = useStore((s) => s.windowChrome)
  const isMaximized = useStore((s) => !!s.maximizedPaneId)
  const isMac = window.zen.platformSync() === 'darwin'
  const labels = resolveSystemFolderLabels(systemFolderLabels)

  const maximizeGlyph = isMaximized ? <span className="mr-1">▣</span> : null

  let titleContent: JSX.Element
  let titleText: string

  if (activeNote && vault) {
    const pathNoExt = activeNote.path.replace(/\.[^.]+$/, '')
    const lastSlash = pathNoExt.lastIndexOf('/')
    const folderPart = lastSlash >= 0 ? pathNoExt.slice(0, lastSlash + 1) : ''
    const filenamePart = lastSlash >= 0 ? pathNoExt.slice(lastSlash + 1) : pathNoExt

    titleText = `${vault.name} | ${folderPart}${filenamePart}`
    titleContent = (
      <span className="truncate">
        {maximizeGlyph}
        {vault.name}
        <span className="mx-1.5 opacity-40">|</span>
        {folderPart}
        <span className="font-medium text-ink-700">{filenamePart}</span>
      </span>
    )
  } else {
    const text = activeNote
      ? activeNote.title
      : isQuickNotesTabPath(selectedPath)
        ? labels.quick
        : isTasksTabPath(selectedPath)
          ? labels.tasks
          : isTagsTabPath(selectedPath)
            ? 'Tags'
            : isHelpTabPath(selectedPath)
              ? 'Help'
              : isArchiveTabPath(selectedPath)
                ? labels.archive
                : isTrashTabPath(selectedPath)
                  ? labels.trash
                  : vault
                    ? vault.name
                    : 'ZenNotes'
    titleText = text
    titleContent = (
      <span className="truncate">
        {maximizeGlyph}
        {text}
      </span>
    )
  }

  // The native title is what a tab shows as its label (and what Mission
  // Control / Cmd+Tab / the Dock menu show) — keep it in sync with whatever
  // this bar is actually displaying, tabbed or not. The tab label can't be
  // styled (plain OS text, no color/icons), so isolated mode gets a glyph
  // prefix instead of the accent-colored badge the custom title bar shows.
  // The maximize marker only matters here for a merged window — the native
  // tab label is the only visible "title" in that state (see the early
  // return below); a standalone window shows it in titleContent instead.
  const isolatePrefix = isolatedRoot ? '◎ ' : ''
  const maximizePrefix = isMaximized && windowChrome.tabBarVisible ? '▣ ' : ''
  useEffect(() => {
    window.zen.setWindowTitle(maximizePrefix + isolatePrefix + titleText)
  }, [titleText, isolatePrefix, maximizePrefix])

  // Whenever AppKit is actually drawing a native tab bar — merged with
  // another window, or a lone window with it manually shown via Window >
  // Toggle Tab Bar — it draws its own opaque title/tab bar (with real
  // traffic lights) over the top of the content view. hiddenInset never
  // shrinks the content view to make room for it, that's the whole point of
  // hiddenInset, so nothing pushes the rest of the UI down on its own. The
  // native tab's label already shows the title set above, so there's no
  // content to show here — just leave blank space of the same height so the
  // sidebar/pane headers don't render underneath it. `drag-region` matters
  // even though it's blank: Electron content isn't draggable by default, and
  // without it this band would be dead space you can't grab to move the
  // window (unlike Safari, where the equivalent strip is native chrome and
  // draggable automatically).
  if (windowChrome.tabBarVisible) {
    return <div className="drag-region shrink-0" style={{ height: windowChrome.topInset }} />
  }

  return (
    <div
      className="drag-region glass-titlebar flex h-11 shrink-0 items-center px-4 text-xs text-ink-500"
      style={{ paddingLeft: isMac ? 80 : 12 }}
    >
      {isolatedRoot && (
        <div
          className="mr-2 flex max-w-[40%] shrink-0 items-center gap-1 rounded-md bg-accent/12 px-2 py-0.5 text-2xs font-medium text-accent"
          title={`Isolated to ${isolatedRoot.subpath}`}
        >
          <IsolateIcon width={12} height={12} />
          <span className="truncate">{isolatedRoot.subpath}</span>
        </div>
      )}
      <div className="flex flex-1 items-center justify-center gap-2 text-center tracking-wide">
        {titleContent}
        {workspaceMode === 'remote' && (
          <span className="rounded-full border border-paper-300/70 bg-paper-100/80 px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.14em] text-ink-700">
            Remote
          </span>
        )}
      </div>
      {!isMac && (
        <div className="flex items-center gap-1">
          <WinButton onClick={() => window.zen.windowMinimize()} label="–" />
          <WinButton onClick={() => window.zen.windowToggleMaximize()} label="▢" />
          <WinButton
            onClick={() => window.zen.windowClose()}
            label="✕"
            className="hover:bg-red-500/90 hover:text-white"
          />
        </div>
      )}
    </div>
  )
}

function WinButton({
  onClick,
  label,
  className
}: {
  onClick: () => void
  label: string
  className?: string
}): JSX.Element {
  return (
    <button
      className={`no-drag flex h-8 w-10 items-center justify-center rounded-md text-ink-600 hover:bg-paper-200 ${className ?? ''}`}
      onClick={onClick}
      aria-label={label}
    >
      {label}
    </button>
  )
}
