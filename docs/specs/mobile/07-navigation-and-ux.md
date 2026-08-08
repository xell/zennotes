# 07 — Navigation & UX

## Design principle

Do **not** port the desktop's multi-pane workspace onto a phone. The most common Obsidian-mobile complaint is "the desktop version crammed onto a phone" — powerful but overwhelming. ZenNotes mobile is arranged around **capture** and **reading** first, with editing and organization one tap away but never in the foreground. This maps directly to ZenNotes' capture-oriented, keyboard-first identity, translated to touch.

## Information architecture (phone)

A phone shows **one active pane** at a time (no split view on phones — that's tablet/desktop; see below). The frame:

```text
┌───────────────────────────────┐
│  ⟵  Note title        ⋯  ◱     │   top bar: back · title · actions · view-mode switch
│                               │
│                               │
│      active pane              │   note (read/edit), search, tasks, a folder, etc.
│      (note / list / view)     │
│                               │
│                               │
├───────────────────────────────┤
│   ‹   ›      ⊕      ▤     ☰    │   bottom nav: back · fwd · capture/new · tabs · menu
└───────────────────────────────┘
   ⟵ swipe                swipe ⟶
   left drawer            right drawer
```

- **Left drawer (swipe from left edge):** file explorer / vault tree, search, and quick switcher entry; vault switcher and settings at the bottom. This is the primary navigation surface.
- **Right drawer (swipe from right edge):** contextual to the current note — backlinks, outline, outgoing links, tags. Secondary; power-user oriented.
- **Bottom navigation bar** (shown when not editing): back/forward history, a center **capture/new** action, a **tabs** button (open-notes switcher), and a **menu** button that replaces the desktop's ribbon/menu bar (there is no menu bar on mobile). Tabs exist but there's no tab stacking.
- **Top bar:** back, note title, an actions overflow (`⋯`), and the **view-mode switch** (Reading / Live Preview / Source).

There is intentionally no persistent sidebar taking screen space — content is full-width; navigation is a swipe or tap away.

## Quick capture (the hero flow)

ZenNotes' capture model on desktop is a single-field quick capture (Raycast-replacement style: first line becomes the title, renames in place, no separate title input). Mobile must make this **the fastest path in the app**, reachable from a cold start in under 2 seconds. Four entry points:

1. **Bottom-nav center button (`⊕`)** → opens straight into a single text field in the `quick` area. No template picker, no folder chooser, no title field — just type. First line becomes the title, exactly as desktop.
2. **OS share sheet** → "Share to ZenNotes" appends selected text / URL / image to a new quick-capture note (iOS Share Extension / Android share target; `supportsShareCapture: true`). Handles the "save this while browsing" case without opening the full app.
3. **Home-screen widget / quick action** → tap goes directly to the capture field (iOS widget + App Shortcuts; Android app shortcut / widget). Obsidian ships mobile widgets + a Quick Action for exactly this; match it.
4. **App-icon long-press shortcut** → "New quick note."

Capture notes are ordinary `.md` files in the `quick` area, honoring the existing configurable naming (timestamp/date, optional prefix). They sync like any other note. **Do not re-introduce a title input** — the single-field model is deliberate.

## Command palette & quick switcher on touch

- **Command palette** — the existing `commands.ts` registry surfaced as a searchable list (fuzzy match). Reachable from the menu button and, with a hardware keyboard, the desktop shortcut. This is how power users reach anything not on the toolbar.
- **Quick switcher** — fuzzy note open by title, backed by the persisted index ([03](./03-storage-and-vault.md)) so it's instant even on large vaults. Entry from the left drawer and the capture button's long-press.
- Both reuse `app-core` logic; mobile only provides touch-appropriate presentation (bottom-sheet style, large tap targets, keyboard-aware).

## Reading experience

- Full-width, comfortable typographic defaults (respect the app font-size / theme settings; themes are shared from `app-core`).
- Full-fidelity rendering (math/diagrams/plots/images) per [05](./05-rendering-and-content.md).
- Tap a wikilink/embed to navigate; back/forward history in the bottom nav; long-press a link to peek.
- Reading mode is a first-class, distraction-free surface — this is half the reason the app exists on a phone.

## Tablet / iPad layout

Tablets get a **more desktop-like layout**, unlocked by screen size (the same way Obsidian distinguishes phones from larger tablets):

- **Split view**: sidebar + note, or two notes side by side, on iPad in landscape / large tablets.
- Persistent left sidebar instead of a drawer when there's room.
- Full keyboard-shortcut + vim support when a hardware keyboard is attached ([06](./06-editor-and-input.md)).
- Layout is driven by available width (responsive breakpoints), not a hardcoded device check, so foldables and Stage Manager resize gracefully.

## Theming, design system, and touch sizing

- Reuse the shared design tokens and the `ui/Button` + `ui/Modal` primitives from `app-core`; **no arbitrary `text-[Npx]` / `rounded-[Npx]`** — stay on the token scales ([02](./02-architecture.md) covers the Tailwind-preset consolidation).
- Add **touch sizing** as additive rules: minimum 44×44 pt tap targets, larger hit areas on nav/toolbar controls, bottom-sheet patterns for menus, and safe-area-aware padding.
- Dark mode and custom themes (the Obsidian-style CSS theme folders + snippets ZenNotes now uses) apply on mobile via the same `data-theme-mode` mechanism; verify theme CSS that assumes hover/desktop chrome degrades gracefully on touch.

## Navigation state & deep links

- Support deep links (`zennotes://note/<id>` and universal/app links) so widgets, share results, and future notifications can open a specific note. Uses the stable entry ids from [04](./04-sync-engine.md), not paths, so links survive renames.

## Related

- [01 — Overview & Product Goals](./01-overview.md) (capture + read emphasis)
- [06 — Editor & Input](./06-editor-and-input.md)
- [`docs/reference/vault-and-folder-model.md`](../../reference/vault-and-folder-model.md) (quick notes, system areas)
