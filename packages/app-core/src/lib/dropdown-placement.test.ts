import { describe, expect, it } from "vitest";
import { computeDropdownRect, type DropdownAnchor } from "./dropdown-placement";

// A trigger 320px wide, 32px tall, at a given top in a 800px-tall viewport.
function anchorAt(top: number): DropdownAnchor {
  return { left: 100, right: 420, top, bottom: top + 32, width: 320 };
}

describe("computeDropdownRect (#407)", () => {
  it("opens below the trigger when there is room", () => {
    const r = computeDropdownRect(anchorAt(100), {
      viewportHeight: 800,
      estHeight: 200,
    });
    expect(r.top).toBe(100 + 32 + 4); // trigger bottom + gap
    expect(r.bottom).toBeUndefined();
    expect(r.maxHeight).toBeGreaterThanOrEqual(200);
  });

  it("flips above when the menu would be clipped below and there is more room above", () => {
    // Trigger near the bottom: only ~48px below, ~740px above.
    const r = computeDropdownRect(anchorAt(720), {
      viewportHeight: 800,
      estHeight: 200,
    });
    expect(r.top).toBeUndefined();
    // Anchored by the bottom edge, just above the trigger (viewportH - (top - gap)).
    expect(r.bottom).toBe(800 - (720 - 4));
    expect(r.maxHeight).toBeGreaterThan(200); // uses the large space above
  });

  it("never lets the menu exceed the space on the chosen side (no clipping)", () => {
    // Below: bottom edge stays within the viewport.
    const below = computeDropdownRect(anchorAt(120), { viewportHeight: 800 });
    expect((below.top ?? 0) + below.maxHeight).toBeLessThanOrEqual(800 - 8 + 0.001);
    // Above: top edge stays within the viewport.
    const above = computeDropdownRect(anchorAt(700), { viewportHeight: 800 });
    const topEdge = 800 - (above.bottom ?? 0) - above.maxHeight;
    expect(topEdge).toBeGreaterThanOrEqual(8 - 0.001);
  });

  it("caps the height at the max even with lots of room", () => {
    const r = computeDropdownRect(anchorAt(50), {
      viewportHeight: 2000,
      estHeight: 5000,
      maxHeight: 320,
    });
    expect(r.maxHeight).toBe(320);
  });

  it("uses at least the trigger width, honoring minWidth", () => {
    const narrow = computeDropdownRect(
      { left: 0, right: 120, top: 10, bottom: 42, width: 120 },
      { viewportHeight: 800, minWidth: 260 },
    );
    expect(narrow.width).toBe(260);
    const wide = computeDropdownRect(
      { left: 0, right: 400, top: 10, bottom: 42, width: 400 },
      { viewportHeight: 800, minWidth: 260 },
    );
    expect(wide.width).toBe(400);
  });

  it("stays below when a short menu still fits, even near the bottom", () => {
    // ~148px below, small menu (est 100) fits → no need to flip.
    const r = computeDropdownRect(anchorAt(620), {
      viewportHeight: 800,
      estHeight: 100,
    });
    expect(r.top).toBe(620 + 32 + 4);
    expect(r.bottom).toBeUndefined();
  });
});
