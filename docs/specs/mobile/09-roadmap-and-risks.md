# 09 — Roadmap & Risks

## Phasing philosophy

Ship the smallest thing that proves the architecture, then layer. The two highest-risk bets — (a) `app-core` runs well in a mobile WebView, and (b) first-party sync converges without data loss — get validated earliest, on iOS, before any Android work.

## Phase 0 — Spike (proof of architecture)

**Goal:** confirm the reuse thesis on a real device.

- Scaffold `apps/mobile` with Capacitor; point `webDir` at a Vite build of `app-core` (mirroring `apps/web`).
- Implement a **minimal read-only `ZenBridge`**: `vault-fs.ts` over Capacitor Filesystem for note/folder listing + read, `capabilities.ts`, and `runtime: 'mobile'` added to `bridge-contract`.
- Load a sample vault into the app container; open notes; confirm KaTeX, Mermaid, function-plot, JSXGraph, code highlighting, and images all render on a physical iPhone.
- **Exit criteria:** a real note with math + a Mermaid diagram renders correctly on device; cold start is reasonable; no WebView blockers found. This de-risks the entire approach in days, not weeks.

## Phase 1 — iOS v1 (capture + read + light edit + sync MVP)

**Goal:** a shippable iOS app for existing desktop users.

- **Full `ZenBridge`** over the device vault: write (atomic), folders, assets, search, tasks, clipboard, pickers, watcher (foreground rescan + sync events).
- **Persisted incremental index** ([03](./03-storage-and-vault.md)) so large vaults open fast — built in from the start, not retrofitted.
- **Quick capture**: bottom-nav button + Share Extension + widget/App-Shortcut ([07](./07-navigation-and-ux.md)).
- **Mobile navigation**: drawers, bottom nav, command palette, quick switcher; reading mode; light editing with the **mobile toolbar** and keyboard/IME/safe-area handling ([06](./06-editor-and-input.md)).
- **ZenNotes Sync MVP** ([04](./04-sync-engine.md)): local-first, delta protocol, E2E encryption, 3-tier conflict resolution, and the full set of "designed-out failure" regression tests green. Ships against the self-hosted Go server first; hosted service can follow.
- **TikZ**: capability-gated fallback (source + synced pre-rendered SVG) ([05](./05-rendering-and-content.md)).
- **Distribution**: TestFlight beta → App Store, with the new mobile release track ([08](./08-distribution-and-release.md)).

**Exit criteria:** an existing desktop user installs the app, their vault syncs down with no data loss across a week of two-device use, they can capture in < 2 s, and every rich note reads correctly.

## Phase 2 — Android fast-follow

- Add the `android/` Capacitor project and Kotlin equivalents of the native pieces (share target, widget, secure storage).
- Storage tiers: app-storage default; SAF advanced tier; `.nomedia` handling.
- Android keyboard/IME + WebView quirks pass; device-matrix QA.
- Same sync client and protocol — no fork.
- **Exit criteria:** Android reaches iOS feature parity for capture/read/light-edit/sync; Play Store release.

## Phase 3 — Power features & polish

- **Hosted ZenNotes Sync** as a managed (candidate paid) tier, if the business decides to offer it.
- **TikZ server-side rendering** via `apps/server` ([05](./05-rendering-and-content.md)) so TikZ works on device for synced/server-connected vaults.
- Deeper tablet/iPad experience: split view, richer hardware-keyboard + vim support.
- Full table editing, more of the desktop editor surface where it earns its place on touch.
- Excalidraw/canvas touch polish (stylus, pressure).
- Evaluate mobile plugin support — **only after** the desktop plugin platform ships (currently parked); design the loader to fit App Store Guideline 4.7 ([08](./08-distribution-and-release.md)).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Sync data loss** despite the design | Medium | Critical | The failure-mode regression suite + multi-device simulator ([04](./04-sync-engine.md)) is a release gate. Local-first means the device copy is never destroyed by a pull. Beta hard on two-device workflows before GA. |
| **Large-vault cold start / crashes** (Obsidian's headline weakness) | Medium | High | Persisted incremental index + lazy body/asset loading + list virtualization from Phase 1, not later. Validate with the existing perf harness adapted to device. |
| **WebView keyboard/IME/safe-area friction** eats schedule | High | Medium | Isolate in `ui-mobile`; treat keyboard geometry, IME composition, and hardware-keyboard handling as explicit Phase 1 work items with device tests, not incidental polish. |
| **CodeMirror touch editing feels worse than native** | Medium | Medium | Live Preview + toolbar tuned for touch; set editing expectations at "light edit" for v1; lean on reading/capture as the hero flows. |
| **TikZ gap disappoints math/academic users** | Low–Med | Medium | Fallback shows synced desktop renders (not blanks); prioritize server-side rendering in Phase 3; communicate clearly. |
| **App Store / Play review friction** (file access, encryption, background modes) | Medium | Medium | Request minimal entitlements; default to sandboxed storage; honest privacy labels; no mobile plugins in v1 (removes the 2.5.2 concern). |
| **Android shared-storage performance** forces `MANAGE_EXTERNAL_STORAGE` | Medium | Medium | Default app-storage + Sync avoids it for most users; SAF first; only escalate to All-files under the Play exemption if measured necessary. |
| **Sync scope balloons v1 timeline** | High | High | Sync MVP is deliberately minimal (delta + E2E + 3-tier conflict + regression suite); hosted service, advanced selective-sync policies, and cross-runtime `packages/sync-core` adoption are Phase 2/3. |
| **Adding a 4th Tailwind config / 6th `stripCodeContent` copy** (drift) | Medium | Low | Consolidate to a shared Tailwind preset; reuse the `app-core` tag/wikilink parsing — flagged in [02](./02-architecture.md). |

## Open questions

These need a decision before or during the phase noted:

1. **Is ZenNotes Sync a paid service?** If so, pricing tiers, free self-host vs. hosted split, and quota model. (Before Phase 3; the engineering doesn't assume it.)
2. **iCloud vault tier — offer it or not?** It's a convenience for iOS-only users but carries the placeholder-file and "two sync systems" risks. Leaning: offer as an alternative to ZenNotes Sync, never alongside it on the same vault. (Phase 1.)
3. **Android shared-storage: SAF vs. All-files** — resolve empirically with a large-vault performance test. (Phase 2.)
4. **TikZ: server-side vs. WASM-in-WebView** — server-side is favored ([05](./05-rendering-and-content.md)); confirm once the sync/server round-trip exists. (Phase 3.)
5. **`packages/sync-core` extraction** — build the sync client shared from day one, or mobile-only first and extract later? Extracting later risks divergence; building shared first costs a bit more up front. (Phase 1 decision.)
6. **Minimum supported OS versions** — sets the WebView floor (e.g. regex lookbehind needs iOS 16.4+, Mermaid reliability improves markedly on newer iOS). Pick a floor and put the oldest supported version in the beta device matrix. (Phase 1.)

## How to start (concrete next step)

Kick off Phase 0 as a throwaway spike on a branch:

1. `apps/mobile` + Capacitor + a Vite build of `app-core` in the `webDir`.
2. Add `'mobile'` to `ZenAppInfo.runtime` and a minimal read-only `vault-fs.ts` + `capabilities.ts`.
3. Side-load a sample vault, run on an iPhone simulator/device via the XcodeBuild tooling, and open a note containing KaTeX + Mermaid.

If that renders cleanly on device, the reuse thesis holds and Phase 1 is derisked. If it doesn't, we've learned the one thing that would have sunk the plan — cheaply, and first.

## Related

- [01 — Overview & Product Goals](./01-overview.md)
- [02 — Architecture](./02-architecture.md)
- [04 — Sync Engine](./04-sync-engine.md)
