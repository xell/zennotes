# 05 — Rendering & Content

> This spec answers the original question directly: **how do math, Mermaid, and the other rich renderers work on mobile?** Short answer: all of them run in the WebView unchanged **except TikZ**, which needs a special decision.

## How rendering works today

Markdown is rendered by a unified/remark/rehype pipeline in `packages/app-core/src/lib/markdown.ts`, sanitized with DOMPurify. The chain: `remark-parse` → `remark-frontmatter` (yaml + toml) → `remark-gfm` → `remark-breaks` → `remark-math` → custom `remarkWikilinks/Hashtags/Highlight/Callouts` → `remark-rehype` → `rehype-raw` → `rehype-katex` → `rehype-highlight` → `rehype-stringify`. Fenced diagram blocks become placeholder `<div>`s that `packages/app-core/src/components/Preview.tsx` and `packages/app-core/src/lib/diagram-renderers.ts` hydrate **after** render.

Every stage of this is pure JS/DOM/canvas. A mobile WebView (WKWebView on iOS with JIT; Chromium WebView on Android) runs it identically to the desktop/web build.

## Per-renderer status on mobile

| Renderer | Library | Runs where | Mobile v1 |
|---|---|---|---|
| **Math** | KaTeX via `rehype-katex` | In-browser at parse time | ✅ Works unchanged |
| **Mermaid** | `mermaid` ^11 (lazy import) | In-browser, `Preview.tsx` | ✅ Works unchanged |
| **function-plot** | `function-plot` (d3, lazy) | In-browser, `diagram-renderers.ts` | ✅ Works unchanged |
| **JSXGraph** | `jsxgraph` (lazy, binds to a DOM id) | In-browser, `diagram-renderers.ts` | ✅ Works unchanged |
| **Code highlighting** | `rehype-highlight` (highlight.js) | In-browser at parse time | ✅ Works unchanged |
| **Callouts / highlight / wikilinks / hashtags** | custom remark plugins | In-browser | ✅ Works unchanged |
| **Images / SVG / video / audio** | native embeds, `![[asset]]` resolution | WebView + asset bytes | ✅ Works; asset bytes are selective-synced (see below) |
| **PDF** | (viewer) | WebView | ✅ View only; **no export** (Electron-only) |
| **Excalidraw** | Excalidraw React | In-browser | ✅ Works; touch drawing is a UX task ([06](./06-editor-and-input.md)) |
| **TikZ** | `node-tikzjax` (WASM TeX) | **Electron main process only** | ❌ **Not in v1** — capability-gated fallback |

### KaTeX (math) — a quiet advantage

ZenNotes uses **KaTeX**; Obsidian uses **MathJax**. KaTeX is smaller and synchronous, which is *better* on mobile (no async typesetting pass, lower memory). Two things to verify on device:

- **Font loading.** KaTeX ships its own web fonts. Bundle them with the app (don't fetch from a CDN) so math renders offline and instantly. Preload the KaTeX font subset used most (main + math italic).
- **Macro parity.** KaTeX supports a narrower macro/package set than MathJax (e.g. `mhchem` needs the KaTeX extension). This only matters for *importing Obsidian vaults* that used MathJax-only constructs — document the difference; don't try to match MathJax.

### Mermaid — a reliability differentiator

Obsidian's Mermaid has been genuinely flaky on older iOS (non-rendering on iOS < 17, `mermaid is not defined`, specific chart types failing). Because we control the WebView bundle and Mermaid version, we can make it reliable:

- Bundle Mermaid ^11 with the app (no runtime CDN), initialize once, render on demand when a note becomes visible.
- Guard the lazy import + init behind a try/catch that renders the raw code block with an error affordance instead of a blank space (never fail silently — a blank diagram reads as data loss).
- Test the common chart types (flowchart, sequence, gantt, class, state, pie) on the oldest supported iOS in CI-driven simulator screenshots. **Reliable on-device Mermaid is a concrete edge over Obsidian** — call it out in launch material.

### Images, embeds, and PDFs

- `![[image.png]]` / `![[note]]` resolution is already Obsidian-compatible in `app-core`; it works on mobile with the vault-fs asset resolver ([03](./03-storage-and-vault.md)).
- **Never eagerly decode image bytes** — attachments are the #1 crash/perf driver on mobile. Generate and cache thumbnails lazily; decode full-res only on tap/zoom.
- PDF viewing uses the WebView's capabilities; expect the same limitations Obsidian has (embedded-PDF zoom is weaker than a native viewer). Acceptable for v1. **PDF export stays desktop-only** (`supportsPdfExport: false`).

## The TikZ decision

TikZ is the one renderer with no client-side path today. `apps/desktop/src/main/tikz.ts` runs `node-tikzjax` — a ~5 MB precompiled TeX + WASM engine — in the Electron **main** process, exposed to the UI as `window.zen.renderTikz(source) → SVG`, hash-cached. On the web build it's already a **no-op** that returns `TikZ rendering is not available in the web build yet.` The share-viewer sidesteps it by shipping **pre-rendered** TikZ SVGs from the desktop app.

### v1: graceful fallback (chosen)

- Set `supportsTikz: false` in the mobile capabilities ([02](./02-architecture.md)). The TikZ code path in `diagram-renderers.ts` (`renderTikzBlock` → `window.zen.renderTikz`) checks the flag and, instead of a blank/broken block, renders:
  - the **raw TikZ source** in a labeled code block, and
  - if a **pre-rendered SVG** for that block exists (synced from a desktop/web render, keyed by source hash — the same mechanism the share-viewer already relies on), display it instead.
- This means: a TikZ diagram authored on desktop and synced to mobile **shows as an image** (because desktop cached its render), while a TikZ block authored *only* on mobile shows its source with a "renders on desktop" note. No blank spaces, no crashes.

### Later options (evaluated in [09](./09-roadmap-and-risks.md), not v1)

1. **Server-side rendering.** Add a TikZ endpoint to `apps/server` (run `node-tikzjax` server-side) so `renderTikz` works whenever the vault is server-connected or ZenNotes Sync is active. Natural fit — the sync service already round-trips content, and the server can cache SVGs by source hash for every device. This is the most promising path.
2. **WASM in the WebView.** Ship `node-tikzjax`'s WASM into the mobile bundle and run it in a Web Worker. Pro: fully offline. Con: ~5 MB added download, heavy memory/CPU on device, and app-size budget pressure ([01](./01-overview.md) targets < 40 MB). Evaluate only if server-side proves insufficient.

## Rendering performance on device

- **Lazy everything.** The existing lazy imports (Mermaid, function-plot, JSXGraph load on first use) are essential on mobile — they keep the base bundle small and cold-start fast. Preserve pay-for-what-you-use.
- **Render only what's visible.** Hydrate diagrams for the active note only; defer off-screen and background-tab rendering (DeferredView pattern, [03](./03-storage-and-vault.md)).
- **Cache rendered output** by content hash where cheap (Mermaid/TikZ SVG), so re-opening a note doesn't re-render.
- **Budget-check the heavy ones.** A note with many Mermaid diagrams or a large JSXGraph board can jank a phone. Render incrementally (one block at a time, yielding to the main thread) and show a lightweight placeholder until each block resolves.

## Related

- [03 — Storage & Vault](./03-storage-and-vault.md) (asset selective sync, thumbnails)
- [06 — Editor & Input](./06-editor-and-input.md) (live-preview rendering inside the editor)
- [09 — Roadmap & Risks](./09-roadmap-and-risks.md) (TikZ follow-up, perf validation)
