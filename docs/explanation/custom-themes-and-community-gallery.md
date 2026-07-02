# Custom Themes & the Community Gallery

> **Status:** Phase 1 (custom CSS themes + overrides) **shipped in v2.9.0**. Phase 2
> (the community gallery) is **proposed — not yet implemented**.
> **Last updated:** 2026-06-26
> **Scope:** How user-authored theming works in ZenNotes today, and the design for an
> eventual community theme gallery — submit a theme on the website, an admin approves
> it, and the desktop app browses and one-click-installs it (like community.obsidian.md).

This document is the durable design record. The *implemented* Phase 1 is also covered in
the in-app **Help → How-to guides** and on the website docs (`/docs#custom-themes`); the
*proposed* Phase 2 below is the spec to build from when the gallery is greenlit — it
should not be re-derived from scratch.

---

## 1. What shipped: custom themes + overrides (v2.9.0)

ZenNotes has two CSS-based layers of user theming, both plain files under
`~/.config/zennotes/` that apply live and sync with the user's dotfiles.

**Themes** are folders: `themes/<slug>/` with a `manifest.json` (name, author, version,
description, `modes`, optional `preview` swatch) and a `theme.css` (arbitrary CSS).
Key architecture:

- **Only the active theme's CSS is injected** into a managed `<style id="zen-active-theme">`
  (an inactive theme's arbitrary/global CSS must never be in the document).
- **Light/dark** is a single id `custom-<slug>` on `data-theme` plus a resolved
  `data-theme-mode="light|dark"` attribute on `<html>`, so authors write unscoped
  `:root {}` / `:root[data-theme-mode="dark"] {}` and never hardcode their slug.
- **Colors** are the app's `--z-*` design tokens (space-separated RGB triplets).
- **Assets** (fonts/images) ship beside `theme.css` and load via a sandboxed
  `zen-theme://<slug>/<file>` protocol (mirrors `zen-asset://`; traversal/symlink
  guarded). Remote `http(s)` URLs are never loaded.
- **Migration:** earlier `themes/*.toml` palettes are converted once to folders on
  launch (`scaffoldThemeCss`), and the source is renamed `*.toml.migrated`.

**Overrides** are small `.css` files in `overrides/`, toggled in Settings → Appearance →
Overrides. Enabled overrides inject into a second managed `<style id="zen-overrides">`
*after* the active theme, so they win the cascade — target `:root[data-theme] {}` to beat
both built-in and custom themes. The enabled set persists in the portable config
(`[overrides]` table / `enabledOverrides`). A seeded `example.css` cookbook lists the tokens.

**Quick tweaks** are the no-code companion to overrides: a small panel (Settings → Appearance →
Quick tweaks) that adjusts a curated, readability-safe set of tokens without writing CSS. Two
kinds of control: **color** swatches (accent + the six syntax/diagnostic hues) and **presets**
(segmented pickers). The presets are **Density** — Compact / Default / Comfortable, which scales the
editor tab strip *and* the sidebar / note-list rows together — and **Corners** — Square / Default /
Rounded, the `--z-radius-scale` global multiplier that squares or softens every corner at once. Picks are stored as a `themeTweaks` slug→value map (portable
config `[tweaks]`) and injected as the **topmost** managed layer (`<style id="zen-tweaks">`, after
overrides) so an explicit pick always wins. A small live **preview** inside the panel (mock tabs +
rows + accent chip) reflects each change instantly, so you don't have to close the modal to see it.
Density is the one tweak that also reaches into JS: the list virtualizers read the same `DENSITY`
numbers the preset emits as CSS vars, so the windowing math can't drift from the painted row
heights (and compact note rows drop to a single excerpt line so they don't clip). Background/text
are intentionally excluded — their derived scales make a one-token change look broken, so those
belong to a full custom theme. Renderer + config only, so it works on web too.

Supporting affordances: a **New theme** scaffold button, a **Developer tools** button (opens
the inspector so authors can find tokens/classes — works in shipped builds), and the in-app +
website authoring guide.

**Where the code lives (for future work):** `packages/shared-domain/src/custom-themes.ts`
+ `overrides.ts` (types, token derivation, scaffold); `packages/app-core/src/lib/custom-themes.ts`
(injection); `apps/desktop/src/main/custom-themes.ts` + `overrides.ts` (loaders, watcher,
`zen-theme://`); plus the usual store / `App.tsx` / `SettingsModal.tsx` / bridge-contract / preload
wiring.

---

## 2. Community gallery (proposed, build-later)

Users submit themes on the website, an admin approves them, and the app can browse and
install approved themes. **Phase 1 above is the prerequisite** — the folder/`theme.css`
loader and recursive watcher are what an installed community theme drops into.

### 2.1 Where it lives

The companion Laravel app (`~/Developer/Laravel/zennotes`: Laravel 13, Livewire 4 + Flux +
Fortify). It currently has **no** domain models beyond `User` (only auth + a
`DownloadController`), so the gallery is its **first domain feature** and establishes the
patterns. The app↔server precedent to mirror on the desktop side is
`apps/desktop/src/main/remote/server-client.ts` (`RemoteServerClient`), and there is a
`zennotes:` deep-link scheme to extend for a web "Install" button.

### 2.2 Moderation model

**Direct-upload + Laravel admin review** (recommended over an Obsidian-style GitHub-PR
flow): native to the existing auth + DB + Livewire stack, and it gives byte-level control —
re-lint, sha256 pinning, and instant suspend. Add `users.is_admin` + a `review-themes` Gate
(there is no roles system to reuse). Keep the door open to a later "import from a GitHub
URL" submission mode, but the canonical store is the DB + disk.

### 2.3 Distribution & format

The unit is a **ZIP of the theme folder** (`manifest.json` + `theme.css` + optional
`assets/`). Hard caps enforced server- and client-side: zip ≤ 3 MB, `theme.css` ≤ 256 KB,
≤ 8 asset files, an asset type allow-list (`woff2,woff,ttf,otf,png,jpg,jpeg,webp,svg`).
Manifest: required `name / slug / version (semver) / author / modes`; recommended
`description / license / minAppVersion / homepage / repo / screenshot`. **Previews are
author-uploaded screenshots** — never server-render arbitrary CSS to an image.

### 2.4 Database schema (Laravel migrations)

Three tables now, two deferred:

- **`themes`** — listing identity: `user_id` (author), `slug` (unique), name/summary/
  description, `modes`, `preview_path`, `current_version_id`, `status`
  (`unlisted | listed | suspended`), denormalized `installs_count` / `average_rating`,
  `min_app_version`. Public iff `status = listed` and `current_version_id` set.
- **`theme_versions`** — the review unit: `theme_id`, `version`, `manifest` (json snapshot),
  `archive_path`, `archive_size`, `archive_sha256`, `lint_report` (json),
  `review_status` (`pending | approved | rejected`), reviewer fields; unique
  `(theme_id, version)`.
- **`theme_screenshots`** — `theme_id`, `path`, `thumb_path`, dimensions, sort, caption.
- **Deferred (later):** `theme_ratings`, `theme_reports`.

Lifecycle: author creates a theme + first `pending` version → admin approves (sets
`current_version_id`, `status = listed`) or rejects (with reason) → a new version of a
listed theme is a fresh `pending` row while the theme stays on the last approved version →
**suspend** flips it out of the API instantly.

### 2.5 Web pages (Livewire SFC)

- `/themes/submit` (auth) — zip + screenshot upload → server lint → create unlisted theme
  + pending version.
- `/themes/mine` — author dashboard (statuses, rejection reasons, submit new version).
- `/admin/themes` (gated `can:review-themes`) — review queue: lint report, read-only CSS
  viewer, Approve / Reject / Suspend.
- Public `/themes` (search + mode/popularity filters) and `/themes/{slug}` (detail,
  screenshots, "Install in ZenNotes" deep link + `.zip` fallback).

### 2.6 Public API (`/api/v1`, public, cached, throttled)

- `GET /themes` — paginated summaries.
- `GET /themes/{slug}` — detail incl. `current_version.archive_sha256`.
- `GET /themes/{slug}/download[/{version?}]` — streams the zip with
  `X-Theme-Sha256` / `X-Theme-Version`, bumps the download counter.
- `GET /themes/manifest` — lightweight `{slug, version, sha256}` index for update checks.

### 2.7 In-app browse + install (desktop)

A new Settings → Appearance **"Community themes"** sub-tab, plus a new
`apps/desktop/src/main/community-themes.ts` module. `CommunityThemesClient` mirrors
`RemoteServerClient`. `installCommunityTheme(slug, version)` runs a progress-broadcasting
pipeline (mirror `updater.ts`'s `AppUpdateState` / `broadcastUpdateState` → a new
`ThemeInstallState` + IPC channel):

1. fetch detail → get expected `sha256`, `size`, `min_app_version` (reject if it exceeds the
   running app version).
2. download the zip to a temp file with progress.
3. **verify** sha256 + size.
4. **inspect the zip in memory before writing** — traversal / zip-bomb guards, required
   files present, manifest + asset-type validation.
5. **client re-lint** `theme.css` (the same deny-list as the server).
6. extract to a temp dir, then atomic-rename into `themes/<slug>/` (reuse the existing
   bare-slug / traversal guard); write a `.source.json` marker `{source, slug, version, sha256}`.
7. the recursive watcher refreshes the list and the theme appears.

Plus `updateCommunityTheme` / `uninstallCommunityTheme`, update checks via `/manifest`
(semver diff against installed `.source.json`), and a `themes-install` action on the
`zennotes:` deep link for the website "Install" button.

### 2.8 Safety chain & residual risk

Community themes are **arbitrary CSS that runs in the user's renderer**, so safety is a
four-gate chain: **server lint on submit → admin manual review → client re-lint before
install → sandboxed, size-capped extraction.**

A canonical **deny-list** is defined once and implemented in both PHP and TS (they cannot
share code across languages): no remote assets (`@import`, `url(http(s)/​//…)`, remote
`@font-face`), no active content (`javascript:`, `expression(`, `behavior:`, `-moz-binding`,
`<script>`), and `data:` limited to `font/*` + `image/*`.

**Residual risk, stated plainly:** Chromium ignores legacy CSS-exec vectors
(`expression()` / `behavior:` / `-moz-binding`), so CSS cannot execute JS — the worst case
is **not RCE; it is visual UI-spoofing / redress and attribute-selector exfiltration**,
which stay closed only as long as the no-remote-`url()` rule holds (hence the client
re-lint). The backstop for anything the lint does not anticipate is manual review plus
**instant server-side suspend** (flips the theme out of the API immediately).

### 2.9 Rollout stages

Recommended order (within this Phase 2 effort):

- **Stage 0** — the v2.9.0 theme/override loader (done — the prerequisite).
- **Stage 1** — curated / maintainer-seeded themes + the read-only API + the full in-app
  **install pipeline** (download → client lint → sha256 verify → sandboxed extraction).
  Deliberately ships the dangerous download-and-apply path under tight control *before*
  opening submissions.
- **Stage 2** — open auth'd submissions + the admin moderation queue + per-version updates
  + the deep-link "Install" button.
- **Stage 3** — community signals: ratings, reports/abuse, install counts, featured
  collections, optional "import from GitHub URL".

---

## 3. Why these choices

- **Palette → CSS themes:** users wanted Obsidian-level flexibility (fonts/images, arbitrary
  styling), which a constrained color-palette format could not express.
- **Direct-upload over GitHub-PR moderation:** matches the existing Laravel auth + DB stack,
  and byte-level control (re-lint, sha256 pin, instant suspend) is worth more than the
  cheaper hosting of an index-only model.
- **Author screenshots over server-rendered previews:** rendering untrusted CSS to an image
  re-introduces the sandbox problem and is visually unreliable.
- **Ship the install pipeline before submissions (Stage 1 first):** the genuinely dangerous
  part is downloading and applying third-party CSS; prove the four-gate chain under curation
  before the floodgates open.
