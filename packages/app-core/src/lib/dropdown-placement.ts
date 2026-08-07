// Placement for portal-rendered dropdown menus (Settings pickers, etc.).
//
// The menu opens below its trigger, but flips above (anchored by its bottom
// edge, so there is no gap to the trigger) and caps its height to the room on
// the chosen side when it would otherwise be clipped by the window edge (#407).

export type DropdownRect = {
  left: number;
  width: number;
  maxHeight: number;
  /** Set when placed below the trigger. */
  top?: number;
  /** Set when flipped above the trigger (distance from the viewport bottom). */
  bottom?: number;
};

export type DropdownAnchor = {
  /** Trigger geometry in viewport coordinates (getBoundingClientRect). */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
};

export interface DropdownPlacementOptions {
  /** Viewport height in px (window.innerHeight). */
  viewportHeight: number;
  /** Estimated natural menu height in px; used to prefer below when it fits. */
  estHeight?: number;
  /** Hard cap on the menu height. */
  maxHeight?: number;
  /** Minimum menu width; the menu is at least this wide or the trigger width. */
  minWidth?: number;
  /** Gap between the trigger and the menu. */
  gap?: number;
  /** Keep this much space from the viewport edge. */
  margin?: number;
}

export function computeDropdownRect(
  anchor: DropdownAnchor,
  options: DropdownPlacementOptions,
): DropdownRect {
  const {
    viewportHeight,
    estHeight = 320,
    maxHeight: cap = 320,
    minWidth = 260,
    gap = 4,
    margin = 8,
  } = options;

  const spaceBelow = viewportHeight - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const wanted = Math.min(cap, estHeight);
  // Prefer below; flip up only when below can't fit the menu and above has more.
  const below = spaceBelow >= wanted || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(cap, Math.max(0, below ? spaceBelow : spaceAbove));
  const base = {
    left: anchor.left,
    width: Math.max(minWidth, anchor.width),
    maxHeight,
  };
  return below
    ? { ...base, top: anchor.bottom + gap }
    : { ...base, bottom: viewportHeight - (anchor.top - gap) };
}

/** Convenience for callers holding a live element. */
export function dropdownRectForElement(
  el: HTMLElement,
  opts: Omit<DropdownPlacementOptions, "viewportHeight"> = {},
): DropdownRect {
  const r = el.getBoundingClientRect();
  return computeDropdownRect(r, {
    ...opts,
    viewportHeight: window.innerHeight,
  });
}
