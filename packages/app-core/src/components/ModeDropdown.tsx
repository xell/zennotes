/**
 * Edit / Split / Preview (/ Diff) mode switcher — the hover dropdown used
 * by the main editor's pane toolbar. Shared so surfaces without a pane
 * layout (the pinned reference pane, floating note windows) can present
 * and behave exactly the same way, minus the git-only Diff mode.
 */
import { useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { getKeymapDisplay, type KeymapId } from '../lib/keymaps'
import type { PaneMode } from '../lib/pane-mode'
import { DiffIcon, EyeIcon, PencilIcon, SplitColumnsIcon } from './icons'

export type ToolItem = {
  icon: JSX.Element
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
}

export const MODE_ICONS: Record<PaneMode, () => JSX.Element> = {
  edit: () => <PencilIcon />,
  split: () => <SplitColumnsIcon />,
  preview: () => <EyeIcon />,
  diff: () => <DiffIcon />
}

export const MODE_OPTIONS: Array<{
  mode: PaneMode
  label: string
  tooltipLabel: string
  keymapId?: KeymapId
  gitOnly?: boolean
}> = [
  { mode: 'edit', label: 'Edit', tooltipLabel: 'Editor mode', keymapId: 'global.modeEdit' },
  { mode: 'split', label: 'Split', tooltipLabel: 'Split mode', keymapId: 'global.modeSplit' },
  {
    mode: 'preview',
    label: 'Preview',
    tooltipLabel: 'Preview mode',
    keymapId: 'global.modePreview'
  },
  {
    mode: 'diff',
    label: 'Diff',
    tooltipLabel: 'Diff view (git index)',
    keymapId: 'global.modeDiff',
    gitOnly: true
  }
]

/** The first three modes, excluding Diff — for surfaces with no git-index
 *  concept at all (e.g. a window showing a file outside any vault, where
 *  there's no vault for `gitIsRepo`/`gitShowIndex` to resolve against). */
export const NON_DIFF_MODE_OPTIONS = MODE_OPTIONS.filter((o) => o.mode !== 'diff')

export function useHoverDropdown(openDelay = 150, closeDelay = 100) {
  const [open, setOpen] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const onEnter = () => {
    clearTimeout(closeTimer.current)
    openTimer.current = setTimeout(() => setOpen(true), openDelay)
  }
  const onLeave = () => {
    clearTimeout(openTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), closeDelay)
  }
  return { open, onEnter, onLeave }
}

export function DropdownItem({
  icon,
  title,
  onClick,
  active = false,
  disabled = false
}: ToolItem): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      className={[
        'group/item relative flex h-7 w-7 items-center justify-center rounded transition-colors',
        disabled
          ? 'cursor-not-allowed opacity-35'
          : active
            ? 'bg-paper-200 text-ink-900'
            : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
      ].join(' ')}
    >
      <span className="pointer-events-none">{icon}</span>
      <span className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 z-40 hidden whitespace-nowrap rounded-md border border-paper-300 bg-paper-50 px-2 py-1 text-xs font-medium text-ink-800 shadow-panel group-hover/item:block">
        {title}
      </span>
    </button>
  )
}

export function DropdownPanel({
  open,
  onEnter,
  onLeave,
  children
}: {
  open: boolean
  onEnter: () => void
  onLeave: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={[
        'absolute right-0 top-full z-30 pt-1 translate-x-[3px] transition-all duration-100 origin-top',
        open ? 'opacity-100 scale-100 pointer-events-auto' : 'opacity-0 scale-95 pointer-events-none'
      ].join(' ')}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="flex flex-col gap-px rounded-md border border-paper-300 bg-paper-50 p-0.5 shadow-panel">
        {children}
      </div>
    </div>
  )
}

export function ModeDropdown({
  mode,
  onChange,
  isGitRepo = false,
  options = MODE_OPTIONS
}: {
  mode: PaneMode
  onChange: (m: PaneMode) => void
  isGitRepo?: boolean
  options?: typeof MODE_OPTIONS
}): JSX.Element {
  const { open, onEnter, onLeave } = useHoverDropdown()
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const CurrentIcon = MODE_ICONS[mode]
  const currentOption = options.find((o) => o.mode === mode)

  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        type="button"
        title={currentOption?.tooltipLabel}
        aria-label={currentOption?.tooltipLabel}
        className={[
          'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          open ? 'bg-paper-200 text-ink-900' : 'text-ink-500 hover:bg-paper-200 hover:text-ink-900'
        ].join(' ')}
      >
        <CurrentIcon />
      </button>
      <DropdownPanel open={open} onEnter={onEnter} onLeave={onLeave}>
        {options.map((option) => {
          const disabled = option.gitOnly === true && !isGitRepo
          const shortcut = option.keymapId ? getKeymapDisplay(keymapOverrides, option.keymapId) : null
          const title = shortcut
            ? `${option.tooltipLabel} (${shortcut})`
            : disabled
              ? `${option.tooltipLabel} (vault is not a git repo)`
              : option.tooltipLabel
          return (
            <DropdownItem
              key={option.mode}
              icon={<>{MODE_ICONS[option.mode]()}</>}
              title={title}
              onClick={() => !disabled && onChange(option.mode)}
              active={mode === option.mode}
              disabled={disabled}
            />
          )
        })}
      </DropdownPanel>
    </div>
  )
}
