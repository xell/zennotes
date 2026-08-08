# 02 — Architecture

## Summary

The mobile app is a **Capacitor shell** that hosts `packages/app-core` (the existing React UI, CodeMirror 6 editor, and all renderers) inside the platform WebView, and implements a **third `ZenBridge`** so the shared UI can reach the device filesystem, clipboard, and native capabilities. Everything above the bridge runs unmodified. This mirrors Obsidian's Electron-desktop / Capacitor-mobile split.

```text
┌─────────────────────────────────────────────────────────────┐
│ Native shell (Capacitor)                                     │
│   iOS: WKWebView (JIT-enabled JavaScriptCore)                │
│   Android: Chromium System WebView                           │
│                                                              │
│   ┌───────────────────────────────────────────────────┐     │
│   │ WebView — packages/app-core (reused verbatim)      │     │
│   │   React 18 UI · Zustand store · CodeMirror 6       │     │
│   │   unified/remark pipeline · KaTeX · Mermaid ·      │     │
│   │   function-plot · JSXGraph                         │     │
│   │                     │                              │     │
│   │              window.zen (ZenBridge)                │     │
│   └─────────────────────┼──────────────────────────────┘     │
│                         │ Capacitor Native Bridge            │
│   ┌─────────────────────┴──────────────────────────────┐     │
│   │ Native mobile ZenBridge implementation             │     │
│   │   Filesystem plugin · document picker · clipboard  │     │
│   │   share targets · secure storage · sync engine     │     │
│   └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

## Why Capacitor (and why not the alternatives)

The codebase makes this near-decided. `app-core` is a DOM/React/CodeMirror application; every renderer (KaTeX, Mermaid, function-plot, JSXGraph) is a JS/canvas library that already runs in a browser. The single abstraction the UI depends on is `ZenBridge` (`packages/bridge-contract/src/bridge.ts`), installed at `window.zen`, and the monorepo is explicitly designed so "each runtime installs its own implementation."

- **Capacitor** → write one native bridge; reuse ~100% of `app-core`. Chosen.
- **React Native** → rebuild the entire UI and re-implement the CodeMirror editor (no native equivalent) and every DOM renderer. Near-zero reuse. Rejected.
- **Fully native (SwiftUI/Kotlin)** → same as RN but twice, once per platform. Rejected.

Capacitor over bare Cordova/WKWebView-by-hand because Capacitor gives a maintained plugin ecosystem (Filesystem, Preferences, Share, Clipboard, App, Keyboard, SplashScreen), first-class Swift/Kotlin plugin authoring for the pieces we build ourselves, and a clean `window.Capacitor.Plugins` async bridge.

## New workspace: `apps/mobile`

A new workspace under `apps/`, consistent with `docs/reference/runtime-and-package-map.md`.

```text
apps/mobile/
  package.json            @zennotes/mobile
  capacitor.config.ts     appId: md.zennotes (see 08), webDir points at the built app-core bundle
  vite.config.ts          builds app-core for the WebView (mirrors apps/web)
  src/
    main.tsx              bootstrap: install the mobile ZenBridge, then renderZenNotesApp(root)
    bridge/
      mobile-bridge.ts    the ZenBridge implementation (facade over the plugins below)
      vault-fs.ts         note/folder/asset CRUD over Capacitor Filesystem  (see 03)
      watcher.ts          change notification (app foreground + sync events)  (see 03)
      clipboard.ts        Capacitor Clipboard
      pickers.ts          document/folder picker + share-import  (see 03)
      capabilities.ts     the mobile ZenCapabilities object
    sync/                 first-party sync client  (see 04)
    ui-mobile/            thin mobile-only affordances layered over app-core (see 06/07)
  ios/                    Xcode project (Capacitor-generated + native plugin code)
  android/                Gradle project (added at Android fast-follow)
  native/
    ios/                  Swift: quick-capture share extension, widget, sync helpers
    android/              Kotlin: equivalents (Android phase)
```

`apps/mobile` bootstraps the shared UI exactly like `apps/web` does — it "does not reimplement the product UI. It mounts the shared UI from `packages/app-core`."

## The third `ZenBridge`

`ZenBridge` (`packages/bridge-contract/src/bridge.ts`, ~322 lines) is the complete host contract: note/folder/asset CRUD, search, tasks, databases, templates, `onVaultChange` watcher subscription, `clipboardReadText/WriteText`, pickers/dialogs, fonts, zoom, window controls, config, themes, `renderTikz`, and MCP. The data types live in `packages/bridge-contract/src/ipc.ts` (`NoteMeta`, `NoteContent`, `NoteComment`, `NoteFolder = 'inbox' | 'quick' | 'archive' | 'trash'`).

The mobile bridge implements the same interface. Where a method has no mobile meaning, it either no-ops or is gated by a capability flag the UI already checks.

### Runtime + capability flags

`ZenAppInfo.runtime` is currently `'desktop' | 'web'`. **Add `'mobile'`.** The UI branches on this in the few places that need platform-specific affordances (and mobile-only UI in `ui-mobile/` keys off it).

`ZenCapabilities` today includes `supportsUpdater`, `supportsNativeMenus`, `supportsFloatingWindows`, `supportsLocalFilesystemPickers`, `supportsRemoteWorkspace`, `supportsCliInstall`, `supportsCustomTemplates`. Mobile values:

| Capability | Mobile | Notes |
|---|---|---|
| `supportsUpdater` | `false` | Store-managed updates. |
| `supportsNativeMenus` | `false` | No menu bar; commands via palette/toolbar. |
| `supportsFloatingWindows` | `false` | No multi-window on phones. |
| `supportsLocalFilesystemPickers` | `true` | Via `UIDocumentPicker` / SAF; see [03](./03-storage-and-vault.md). |
| `supportsRemoteWorkspace` | `true` (Phase 2) | Can still connect to a self-hosted Go server via the HTTP bridge; primary sync is first-party (see [04](./04-sync-engine.md)). |
| `supportsCliInstall` | `false` | — |
| `supportsCustomTemplates` | `true` | Templates are file-based, work on device. |

**New capability flags to add** for renderer/feature gating the UI can honor without hardcoding runtime checks:

| New flag | Mobile | Purpose |
|---|---|---|
| `supportsTikz` | `false` (v1) | Gate the TikZ code path + show the fallback affordance ([05](./05-rendering-and-content.md)). |
| `supportsFirstPartySync` | `true` | Show the Sync settings surface ([04](./04-sync-engine.md)). |
| `supportsPdfExport` | `false` | Electron-only; hide the menu item. |
| `supportsShareCapture` | `true` | OS share-sheet → quick capture ([07](./07-navigation-and-ux.md)). |

Adding flags rather than sprinkling `runtime === 'mobile'` checks keeps `app-core` platform-agnostic and lets desktop/web opt in later (e.g. web could gain `supportsFirstPartySync`).

## Reuse map (what moves, what's new)

| Layer | Source | Mobile status |
|---|---|---|
| React UI (60+ components) | `packages/app-core/src` | **Reused verbatim** in the WebView |
| Zustand store (`store.ts`, ~7.5k lines) | `packages/app-core/src/store.ts` | Reused; persistence targets the mobile bridge + `.zennotes/workspace.json` |
| CodeMirror 6 editor + all `cm-*` extensions | `packages/app-core/src/lib/cm-*.ts`, `Editor.tsx` | Reused; touch/keyboard adaptations layered in `ui-mobile/` ([06](./06-editor-and-input.md)) |
| Markdown pipeline (unified/remark/rehype) | `packages/app-core/src/lib/markdown.ts` | Reused verbatim |
| KaTeX / Mermaid / function-plot / JSXGraph | `Preview.tsx`, `diagram-renderers.ts` | Reused; lazy-loaded ([05](./05-rendering-and-content.md)) |
| Domain types/models | `packages/shared-domain`, `bridge-contract/src/ipc.ts` | Reused verbatim |
| Bridge contract | `packages/bridge-contract` | **Extended** (`'mobile'` runtime + new flags) |
| Host bridge | — | **New** (`apps/mobile/src/bridge`) |
| Vault filesystem | `apps/desktop/src/main/vault.ts` (Node `fs`) | **Reimplemented** over Capacitor Filesystem ([03](./03-storage-and-vault.md)) |
| Watcher | `apps/desktop/src/main/watcher.ts` (chokidar) | **Reimplemented** (foreground rescan + sync events) ([03](./03-storage-and-vault.md)) |
| TikZ | `apps/desktop/src/main/tikz.ts` (node-tikzjax) | **Not ported v1**; capability-gated ([05](./05-rendering-and-content.md)) |
| Sync | — (no device-to-device sync today) | **New service** ([04](./04-sync-engine.md)) |

## Tailwind / theming note

Tailwind config is currently triplicated (root + desktop + web) and the design system relies on shared token scales and the `ui/Button` + `ui/Modal` primitives in `app-core`. **Mobile must reuse the same token scales and primitives — do not fork a fourth arbitrary style system.** The mobile Tailwind config should extend the shared preset (and this is a good moment to extract a single shared Tailwind preset consumed by all shells, rather than adding a fourth copy). Mobile-specific needs (safe-area insets, touch target sizing ≥ 44pt, larger tap affordances) are added as additive utilities, not overrides of the token scale.

## Shared-code hazards to respect

- **`stripCodeContent` (code-fence stripping) is duplicated across 5 synced copies** (desktop main, MCP, app-core tags + wikilinks, Go server). The mobile bridge parses tags/wikilinks the same way `app-core` does — **reuse the `app-core` copy; do not add a sixth divergent implementation.**
- **The `attachements` (sic) legacy directory constant is intentional and load-bearing.** The mobile vault-fs must recognize it exactly as desktop does. Do not "fix" the spelling and do not add `attachments` recognition — both are known-destructive.

## Build & CI

- **Web bundle**: `apps/mobile` builds `app-core` with Vite (same as `apps/web`), output to the Capacitor `webDir`. `npx cap sync` copies it into the native projects.
- **iOS build**: Xcode project under `apps/mobile/ios`; can be driven locally via the XcodeBuild tooling available in this environment (build/run on simulator, log capture, screenshot). CI signs and uploads to TestFlight (see [08](./08-distribution-and-release.md)).
- **Turbo**: add `@zennotes/mobile` to the workspace graph with `build`/`typecheck` tasks. The native build steps live outside Turbo (Xcode/Gradle), invoked by release scripts in `tooling/scripts`.
- **Typecheck/test**: the bridge and sync client are plain TS and run under the existing `turbo run typecheck` / Vitest setup.

## Related

- [03 — Storage & Vault](./03-storage-and-vault.md)
- [04 — Sync Engine](./04-sync-engine.md)
- [05 — Rendering & Content](./05-rendering-and-content.md)
- [`docs/monorepo-architecture.md`](../../monorepo-architecture.md)
- [`docs/reference/runtime-and-package-map.md`](../../reference/runtime-and-package-map.md)
