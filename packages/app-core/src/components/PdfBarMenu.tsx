/**
 * Click-to-open menu used by the PDF bar's two collapsed controls.
 *
 * Deliberately click-driven rather than reusing `useHoverDropdown` (the pane
 * toolbar's idiom): these panels sit directly over the page being read and one
 * of them is wide, so hover-opening would repeatedly cover the document as the
 * pointer crosses the bar. Closes on outside pointerdown and on Escape.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'

export function PdfBarMenu({
  label,
  title,
  align = 'right',
  wide = false,
  children
}: {
  /** Button content — an icon, or short text such as `Aa`. */
  label: ReactNode
  title: string
  align?: 'left' | 'right'
  /** Wide panels hold rows of controls; narrow ones a single action column. */
  wide?: boolean
  /** Receives a closer so an item can dismiss the menu after acting. */
  children: (close: () => void) => ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`zen-pdf-btn zen-pdf-btn-icon ${open ? 'zen-pdf-btn-active' : ''}`}
      >
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className={[
            'absolute top-full z-30 mt-1 rounded-lg border border-paper-300 bg-paper-50 p-1 shadow-panel',
            align === 'right' ? 'right-0' : 'left-0',
            wide ? 'w-max min-w-[19rem]' : 'min-w-[12rem]'
          ].join(' ')}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** A labelled row inside a wide menu (zoom, layout, reading mode). */
export function PdfMenuRow({
  label,
  children
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span className="w-16 shrink-0 text-2xs uppercase tracking-wide text-ink-400">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  )
}

/** A single action in a narrow menu: icon plus label, full width. */
export function PdfMenuItem({
  icon,
  label,
  onClick,
  active = false
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs',
        active ? 'bg-paper-200 text-ink-900' : 'text-ink-700 hover:bg-paper-200/70'
      ].join(' ')}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-500">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
