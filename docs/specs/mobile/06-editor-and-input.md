# 06 — Editor & Input

## Starting point

The editor is CodeMirror 6 (`@codemirror/*`, `codemirror` ^6) with vim mode via `@replit/codemirror-vim`, wrapped by `packages/app-core/src/components/Editor.tsx`, plus a large set of extensions in `app-core/src/lib/cm-*.ts` — live preview (`cm-live-preview.ts`), tables (`cm-table.ts`, 56 KB), wikilinks, slash commands, markdown snippets, hashtags, heading fold, WYSIWYG blocks, highlight, frontmatter, vim clipboard, and a 53 KB command registry (`commands.ts`).

**CodeMirror 6 was built for touch and is what Obsidian mobile runs on.** The editor works on mobile out of the box — text entry, selection, and the extension stack all function in the WebView. The mobile work is not "port the editor," it's "make touch input pleasant and handle the mobile keyboard." That work lives in `apps/mobile/src/ui-mobile/`, layered over the shared editor, not forked from it.

## v1 editing scope

Per the v1 UX decision (**capture + read + light edit**), the editing bar is set at "comfortable light editing," not "full desktop parity":

**In scope for v1:**
- Full text entry and selection with the soft keyboard.
- The core markdown affordances: headings, lists, checkboxes/tasks, bold/italic/highlight, links, code, quotes.
- A **mobile editing toolbar** (below, the marquee input feature).
- Live Preview mode as the default (inline rendering via `cm-live-preview.ts`), with a Reading mode and a Source mode toggle.
- Slash commands and wikilink `[[` autocomplete (they already exist; they need touch-friendly popovers).
- Tables: viewable and lightly editable; the desktop table menu (`cm-table-menu.ts`) is adapted to a compact touch menu.

**Deferred (present in the code, de-emphasized in mobile UX):**
- Full **vim mode** on the soft keyboard. Vim motions are ZenNotes' core intent, but modal editing on a touch keyboard is niche. Vim is **on by default when a hardware keyboard is attached** (iPad + Magic Keyboard is a real power-user scenario) and **off for soft-keyboard editing** unless the user explicitly enables it. See vim gating below.
- Heavy multi-pane table editing, complex WYSIWYG block manipulation — available but not optimized for small screens.

## The mobile editing toolbar

The single most important input feature (it's what makes Obsidian mobile usable, and what mobile markdown apps live or die by).

- A **horizontally scrollable icon row docked above the soft keyboard**, tracking the keyboard's show/hide and height precisely (see keyboard handling below).
- **Default actions:** indent / outdent, checkbox, bullet, heading cycle, bold, italic, highlight, inline code, link, wikilink `[[`, insert tag `#`, undo/redo, and a "more" overflow.
- **Fully customizable:** users add/remove/reorder buttons, and can bind **any registered command** from the existing `commands.ts` registry to a toolbar slot (Obsidian's "add global command" model — a proven pattern). This reuses the command registry directly, so every command is reachable.
- **"Dismiss keyboard" affordance** on the toolbar, which reveals the bottom navigation bar ([07](./07-navigation-and-ux.md)).
- The toolbar is a `ui-mobile` component; the actions it fires are all existing `app-core` commands — no editor logic is duplicated.

## Keyboard, IME, and safe-area handling

This is where WebView editors bleed engineering time (it's a recurring Obsidian bug source — the editing toolbar vanishing when a hardware keyboard connects, safe-area glitches, IME composition breaking). Budget real effort here.

- **Keyboard geometry:** use the Capacitor Keyboard plugin (`keyboardWillShow/Hide`, height, and `resize` mode) to size the editor viewport and pin the toolbar to the true keyboard top. On iOS, prefer `resize: 'native'`/`'ionic'` tuned so the caret is never hidden behind the keyboard or toolbar. Handle the iOS caret-scroll-into-view quirks explicitly.
- **Safe areas:** respect `env(safe-area-inset-*)` for notches/home indicator/rounded corners. The toolbar sits above the home indicator when the keyboard is dismissed and above the keyboard when shown.
- **IME / composition:** do not intercept keys mid-composition (CJK, dictation, autocorrect). Slash-command and `[[`/`#` triggers must not fire during an active IME composition — gate them on `compositionend`. Test dictation and CJK input explicitly.
- **Hardware keyboard:** when attached, (a) hide the soft-keyboard toolbar (or keep it as a command strip — configurable), (b) enable full keyboard shortcuts including the command palette and vim mode, (c) ensure the toolbar-disappears-on-hardware-keyboard bug class is covered by a test. iPad + Magic Keyboard should feel close to desktop.
- **Autocorrect/autocapitalize:** default sensible for prose; disable inside code blocks and frontmatter (the editor already knows these regions via `cm-frontmatter.ts` and language modes).

## Vim gating on mobile

ZenNotes' vim mode must respect the existing gating discipline: when vim is off, single-key list/editor shortcuts are disabled and only universal keys behave normally; handlers also bail when a modal/menu is open. On mobile:

- **Soft keyboard:** vim off by default (no modal editing on-screen); the toolbar provides the affordances instead.
- **Hardware keyboard:** vim on by default, honoring the user's global setting; full custom vim actions from `Editor.tsx` (`zenMoveSelectionDown`, `goToDefinition`, `zenHalfPageDown`, etc.) work as on desktop.
- Gating rules are unchanged and shared — mobile does not fork vim behavior, it only chooses the default based on input device.

## Gestures

- **Swipe from left/right screen edge** → open the corresponding sidebar drawer ([07](./07-navigation-and-ux.md)). Must not conflict with in-editor text selection or cursor drag — edge-swipe only.
- **Long-press** → context menu (selection actions, link actions). Note Obsidian's long-press menus are inconsistent across iOS/Android/Live-Preview vs Reading — implement one consistent context-menu component in `ui-mobile` used everywhere, and test it in every mode.
- **Tap a `[[wikilink]]` / `![[embed]]`** → navigate/open; **long-press a link** → peek/preview + actions. Tapping a task checkbox toggles it (reusing the existing task toggle).
- **Pinch-zoom** is reserved for Excalidraw/canvas and image viewing, not the text editor (which uses the app font-size setting).

## Excalidraw & drawing

Excalidraw runs in the WebView and is editable on touch (pinch/pan/draw). This is in scope for viewing and basic editing; Apple Pencil / stylus pressure is a nice-to-have, not v1. Canvas-style editing is fully available on mobile — do not present it as desktop-only.

## Related

- [05 — Rendering & Content](./05-rendering-and-content.md) (live-preview rendering)
- [07 — Navigation & UX](./07-navigation-and-ux.md) (where the editor sits in the IA; quick capture)
- [09 — Roadmap & Risks](./09-roadmap-and-risks.md)
