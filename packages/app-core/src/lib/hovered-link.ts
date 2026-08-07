import { create } from 'zustand'

/**
 * The target of the link the mouse is currently over, shown in the status bar
 * (browser-style). Kept in its own tiny store so hover churn never re-renders
 * anything but the status bar's link slot. `null` when the pointer isn't over a
 * link.
 */
interface HoveredLinkStore {
  href: string | null
  setHref: (href: string | null) => void
}

export const useHoveredLinkStore = create<HoveredLinkStore>((set, get) => ({
  href: null,
  setHref: (href) => {
    const next = href && href.trim() ? href.trim() : null
    if (get().href === next) return
    set({ href: next })
  }
}))

/** Imperative setter for non-React callers (editor / preview DOM handlers). */
export function setHoveredLink(href: string | null): void {
  useHoveredLinkStore.getState().setHref(href)
}
