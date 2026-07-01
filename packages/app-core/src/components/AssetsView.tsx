import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssetMeta } from '@shared/ipc'
import { useStore } from '../store'
import { assetTabPath } from '../lib/asset-tabs'
import { confirmMoveToTrash } from '../lib/confirm-trash'
import { confirmApp } from '../lib/confirm-requests'
import { promptApp } from '../lib/prompt-requests'
import { naturalCompare } from '../lib/natural-sort'
import { findAssetReferenceHrefs, resolveAssetVaultRelativePath } from '../lib/local-assets'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { DocumentIcon, ImageIcon, PaperclipIcon, SearchIcon, TrashIcon } from './icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatDate(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric'
  })
}

// Shared column template for the header + every row, so columns line up:
// name (flex) · used · type · size · modified · action.
const ASSET_ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_4rem_5rem_5rem_1.75rem] items-center gap-4'

function AssetGlyph({ kind }: { kind: AssetMeta['kind'] }): JSX.Element {
  if (kind === 'image') return <ImageIcon width={15} height={15} />
  if (kind === 'pdf') return <DocumentIcon width={15} height={15} />
  return <PaperclipIcon width={15} height={15} />
}

/**
 * The built-in Assets view: browse every asset in the vault in one place
 * (images, PDFs, attachments), independent of the notes tree.
 */
export function AssetsView(): JSX.Element {
  const assetFiles = useStore((s) => s.assetFiles)
  const openNoteInTab = useStore((s) => s.openNoteInTab)
  const openNoteAndLocateText = useStore((s) => s.openNoteAndLocateText)
  const deleteAsset = useStore((s) => s.deleteAsset)
  const renameAssetAndRewriteReferences = useStore((s) => s.renameAssetAndRewriteReferences)
  const pinAssetReference = useStore((s) => s.pinAssetReference)
  const pinAssetReferenceForNote = useStore((s) => s.pinAssetReferenceForNote)
  const activeNote = useStore((s) => s.activeNote)
  const pendingAssetLocate = useStore((s) => s.pendingAssetLocate)
  const clearPendingAssetLocate = useStore((s) => s.clearPendingAssetLocate)
  const notes = useStore((s) => s.notes)
  const vaultRoot = useStore((s) => s.vault?.root ?? null)
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; asset: AssetMeta } | null>(null)
  const [locateHighlightPath, setLocateHighlightPath] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const locateHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const assets = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q
      ? assetFiles.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q))
      : assetFiles
    return [...matched].sort((a, b) => naturalCompare(a.name, b.name))
  }, [assetFiles, filter])

  // assetPath → note paths that embed it (resolved via relative-path + the
  // unique-basename fallback, matching how embeds render). (#185)
  const usage = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const note of notes) {
      for (const href of note.assetEmbeds ?? []) {
        const resolved = resolveAssetVaultRelativePath(vaultRoot, note.path, href)
        if (!resolved) continue
        const arr = map.get(resolved)
        if (arr) {
          if (!arr.includes(note.path)) arr.push(note.path)
        } else {
          map.set(resolved, [note.path])
        }
      }
    }
    return map
  }, [notes, vaultRoot, assetFiles])

  const notesByPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes])

  // Consume a pending "locate this asset" request (from an image embed's
  // locate button): clear a filter that would hide it, then once it's in
  // the rendered list, scroll it into view and flash-highlight the row.
  useEffect(() => {
    if (!pendingAssetLocate) return
    if (!assets.some((a) => a.path === pendingAssetLocate)) {
      if (filter) {
        setFilter('')
        return
      }
      clearPendingAssetLocate()
      return
    }
    const raf = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-asset-path="${CSS.escape(pendingAssetLocate)}"]`
      )
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setLocateHighlightPath(pendingAssetLocate)
      if (locateHighlightTimerRef.current) clearTimeout(locateHighlightTimerRef.current)
      locateHighlightTimerRef.current = setTimeout(() => {
        setLocateHighlightPath(null)
        locateHighlightTimerRef.current = null
      }, 1400)
      clearPendingAssetLocate()
    })
    return () => cancelAnimationFrame(raf)
  }, [pendingAssetLocate, assets, filter, clearPendingAssetLocate])

  useEffect(() => {
    return () => {
      if (locateHighlightTimerRef.current) clearTimeout(locateHighlightTimerRef.current)
    }
  }, [])

  const copyEmbed = (asset: AssetMeta): void => {
    void navigator.clipboard?.writeText(`![[${asset.name}]]`)
  }

  const renameAsset = async (asset: AssetMeta): Promise<void> => {
    if (typeof window.zen.renameAsset !== 'function') return
    const ext = asset.name.includes('.') ? asset.name.slice(asset.name.lastIndexOf('.')) : ''
    const base = ext ? asset.name.slice(0, -ext.length) : asset.name
    const next = await promptApp({
      title: 'Rename asset',
      initialValue: base,
      okLabel: 'Rename',
      validate: (v) => (v.includes('/') ? 'Use only a name' : null)
    })
    if (!next) return
    const clean = next.trim()
    const nextName = `${clean}${ext}`
    if (!clean || nextName === asset.name) return

    // The exact href string(s) each referencing note used to embed this
    // asset — resolved here (not inside the store action) because
    // resolveAssetVaultRelativePath reads live store state and importing it
    // into store.ts would create a circular import.
    const referenceHrefsByNote = findAssetReferenceHrefs(notes, vaultRoot, asset.path)

    if (referenceHrefsByNote.size > 5) {
      const confirmed = await confirmApp({
        title: `Update references in ${referenceHrefsByNote.size} notes?`,
        description: `Renaming "${asset.name}" to "${nextName}" will rewrite its reference in ${referenceHrefsByNote.size} notes that use it.`,
        confirmLabel: 'Rename and Update'
      })
      if (!confirmed) return
    }

    try {
      await renameAssetAndRewriteReferences(asset.path, nextName, referenceHrefsByNote)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err))
    }
  }

  // The href in `note.assetEmbeds` that resolves to `asset` — used to locate
  // the cursor at the first occurrence of the actual embed text, rather than
  // just opening the note. Falls back to the bare filename if no matching
  // embed href is found (e.g. stale metadata).
  const openAssetUsage = (asset: AssetMeta, notePath: string): void => {
    const href = (notesByPath.get(notePath)?.assetEmbeds ?? []).find(
      (h) => resolveAssetVaultRelativePath(vaultRoot, notePath, h) === asset.path
    )
    void openNoteAndLocateText(notePath, href ?? asset.name)
  }

  const menuItems = (asset: AssetMeta): ContextMenuItem[] => {
    const usedNotePaths = usage.get(asset.path) ?? []
    return [
      { label: 'Open', onSelect: () => void openNoteInTab(assetTabPath(asset.path)) },
      { label: 'Copy embed', onSelect: () => copyEmbed(asset) },
      ...(usedNotePaths.length > 0
        ? [
            { kind: 'separator' as const },
            { label: `Used in (${usedNotePaths.length})`, disabled: true },
            ...usedNotePaths.map((notePath) => ({
              label: notesByPath.get(notePath)?.title ?? notePath,
              onSelect: () => openAssetUsage(asset, notePath)
            }))
          ]
        : []),
      { kind: 'separator' as const },
      ...(activeNote
        ? [
            {
              label: 'Open as Reference (This Note)',
              onSelect: () => pinAssetReferenceForNote(activeNote.path, asset.path)
            }
          ]
        : []),
      {
        label: 'Open as Reference (Global)',
        onSelect: () => pinAssetReference(asset.path)
      },
      { label: 'Reveal in file manager', onSelect: () => void window.zen.revealNote(asset.path) },
      { label: 'Rename…', onSelect: () => void renameAsset(asset) },
      {
        label: 'Move to Trash',
        danger: true,
        onSelect: async () => {
          if (await confirmMoveToTrash(asset.name)) await deleteAsset(asset.path)
        }
      }
    ]
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-paper-100 text-ink-900">
      <header className="glass-header flex h-12 shrink-0 items-center gap-2 px-4">
        <PaperclipIcon className="h-4 w-4 shrink-0 text-ink-500" />
        <h2 className="text-sm font-semibold text-ink-900">Assets</h2>
        <span className="shrink-0 text-xs text-ink-500">{assetFiles.length}</span>
        <div className="ml-auto flex items-center gap-1.5 rounded-md bg-paper-200/60 px-2 py-1">
          <SearchIcon className="h-3.5 w-3.5 text-ink-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter assets"
            className="w-40 bg-transparent text-xs text-ink-900 outline-none placeholder:text-ink-400"
          />
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {assets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-ink-400">
            {assetFiles.length === 0 ? 'No assets yet.' : 'No assets match your filter.'}
          </div>
        ) : (
          <>
            <div className={`${ASSET_ROW_GRID} sticky top-0 z-10 border-b border-paper-300/60 bg-paper-100 px-3 py-1.5 text-2xs font-medium uppercase tracking-wide text-ink-400`}>
              <span>Name</span>
              <span className="text-right">Used</span>
              <span className="text-right">Type</span>
              <span className="text-right">Size</span>
              <span className="text-right">Modified</span>
              <span />
            </div>
            <ul className="flex flex-col py-1">
              {assets.map((asset) => {
                const usedIn = usage.get(asset.path)?.length ?? 0
                const open = (): void => void openNoteInTab(assetTabPath(asset.path))
                return (
                  <li key={asset.path}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          open()
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, asset })
                      }}
                      data-asset-path={asset.path}
                      className={[
                        ASSET_ROW_GRID,
                        'group cursor-pointer px-3 py-1.5 outline-none hover:bg-paper-200/40 focus-visible:bg-paper-200/40',
                        locateHighlightPath === asset.path ? 'asset-row-locate-highlight' : ''
                      ].join(' ')}
                      title={asset.path}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="shrink-0 text-ink-500">
                          <AssetGlyph kind={asset.kind} />
                        </span>
                        <span className="min-w-0 truncate text-sm text-ink-900">{asset.name}</span>
                      </div>
                      <span
                        className={[
                          'truncate text-right text-2xs',
                          usedIn === 0 ? 'text-ink-400/70' : 'text-ink-500'
                        ].join(' ')}
                        title={
                          usedIn === 0
                            ? 'Not referenced by any note'
                            : (usage.get(asset.path) ?? []).join('\n')
                        }
                      >
                        {usedIn === 0 ? 'unused' : `used in ${usedIn}`}
                      </span>
                      <span className="text-right text-2xs uppercase tracking-wide text-ink-400">
                        {asset.kind}
                      </span>
                      <span className="text-right text-xs tabular-nums text-ink-500">
                        {formatBytes(asset.size)}
                      </span>
                      <span className="text-right text-xs tabular-nums text-ink-500">
                        {formatDate(asset.updatedAt)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete ${asset.name}`}
                        title="Move to Trash"
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (await confirmMoveToTrash(asset.name)) await deleteAsset(asset.path)
                        }}
                        className="flex h-6 w-6 items-center justify-center justify-self-end rounded text-ink-400 opacity-0 transition hover:bg-paper-300/60 hover:text-danger group-hover:opacity-100"
                      >
                        <TrashIcon width={14} height={14} />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.asset)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
