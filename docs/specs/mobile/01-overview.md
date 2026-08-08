# 01 — Overview & Product Goals

## Vision

ZenNotes on mobile is the same vault, in your pocket. It is not a companion app with a reduced feature set bolted on — it is the ZenNotes product core (`packages/app-core`) running in a native shell, backed by a local-first vault that stays in sync with desktop and web through a first-party, end-to-end-encrypted sync service.

The mobile experience is optimized for the two things people actually do on a phone:

1. **Capture** — get a thought into the vault in under two seconds, from a cold start.
2. **Read** — pull up any note and see it rendered with full fidelity (math, diagrams, plots, images), anywhere.

Editing is fully supported — the CodeMirror 6 editor comes "for free" inside the WebView — but the interface is arranged around capture and reading, not around cramming the desktop's multi-pane workspace onto a 6-inch screen. That mistake ("the desktop version crammed onto a phone") is the single most common complaint about Obsidian mobile, and avoiding it is a core design constraint.

## Target users

- **Existing ZenNotes desktop users** who want their vault available on the go. This is the primary audience; their expectation is continuity — the same notes, folders, tags, wikilinks, and rendering they already have.
- **Keyboard-first / vim users** (ZenNotes' core intent is keyboard-first with vim motions everywhere) who accept that a phone is a touch device but still want power-user affordances (command palette, quick switcher, fast capture) adapted to touch, and a first-class experience when a hardware keyboard is attached (iPad + Magic Keyboard).
- **Capture-oriented users** who currently use Quick Capture / the Raycast flow on desktop and want the same "jot it down now, organize later" behavior on mobile.

## Goals (v1)

1. **Local-first, offline-always.** Every note lives on the device as a plain `.md` file. The app is fully usable with no network. This is the hard requirement that rules out a thin-client design.
2. **Reliable cross-device sync** via the first-party ZenNotes Sync service, with **no data loss** — specifically none of the failure modes documented in Obsidian mobile (startup races that overwrite fresh notes, iCloud placeholder files read as "missing," config-folder churn). See [04 — Sync Engine](./04-sync-engine.md).
3. **Full-fidelity reading.** KaTeX math, Mermaid diagrams, function-plot, JSXGraph, code highlighting, images, and PDFs render correctly on device. See [05 — Rendering & Content](./05-rendering-and-content.md).
4. **Sub-2-second capture.** A dedicated quick-capture entry point (app icon long-press / share sheet / widget / in-app FAB) that opens straight to a single text field, matching the desktop quick-capture model. See [07 — Navigation & UX](./07-navigation-and-ux.md).
5. **Feature continuity, not feature parity.** The vault model, folders, tags, wikilinks, backlinks, tasks, search, archive/trash, and daily/weekly notes all behave as on desktop because they live in `app-core`. Desktop-only *shell* features (native menus, floating windows, CLI install, updater) are gated off via capability flags.
6. **iOS first**, engineered so the Android port is a shell swap, not a rewrite.

## Non-goals (v1)

- **Not** a from-scratch native UI (SwiftUI/Kotlin/React Native). The WebView reuse is the whole point.
- **Not** full desktop workspace parity — no multi-pane split view on phones (tablets get more; see [07](./07-navigation-and-ux.md)), no floating windows, no native menu bar.
- **Not** a plugin platform on mobile in v1. ZenNotes' plugin platform is itself pre-1.0 and currently reverted (the Obsidian-style plugin work is parked in a git stash); mobile plugin support is explicitly out of scope until the desktop platform lands. Design the sync/storage layers so plugins *can* be added later without a redesign.
- **Not** TikZ rendering in v1. TikZ requires a heavy WASM TeX engine that today only runs in the Electron main process. Mobile gets a graceful fallback in v1, with server-side rendering and/or bundled WASM evaluated later. See [05 — Rendering & Content](./05-rendering-and-content.md).
- **Not** PDF *export* (a known Electron-only feature on Obsidian too). PDF *viewing* is in scope.

## Success metrics

| Metric | Target |
|---|---|
| Cold-start to editable quick-capture field | < 2.0 s on a 3-year-old device |
| Cold-start to first note visible (1,000-note vault) | < 3.0 s |
| Note-open to fully rendered (math + one Mermaid diagram) | < 500 ms |
| Sync convergence after an edit (both devices foreground) | < 5 s |
| Sync-caused data loss incidents | **0** — this is a release gate, not a target |
| Crash-free sessions | > 99.5% |
| App size (iOS, download) | < 40 MB base (renderers lazy-loaded on demand) |

## Business context

- **The App Store / Play Store is unavoidable for mobile.** This is a deliberate note: ZenNotes desktop is distributed via GitHub releases (the desktop release process treats the GitHub release body as the only target and skips App-Store artifacts). That model does **not** carry to mobile — both platforms require store distribution, store review, and store-specific release artifacts. [08 — Distribution & Release](./08-distribution-and-release.md) treats this as a new surface, and the release-docs workflow will need a mobile track (App Store "What's New", Play Store listing) that the desktop workflow has intentionally skipped.
- **ZenNotes Sync is a candidate paid service.** Building a first-party E2E sync service (decision #2) creates the natural monetization surface Obsidian uses ($4–8/mo). Whether to charge, and how to price, is an open business question tracked in [09 — Roadmap & Risks](./09-roadmap-and-risks.md); the engineering spec is written so sync works self-hosted/free *and* as a hosted paid tier.

## Related

- [02 — Architecture](./02-architecture.md)
- [09 — Roadmap & Risks](./09-roadmap-and-risks.md)
- [`docs/explanation/how-zennotes-works.md`](../../explanation/how-zennotes-works.md)
