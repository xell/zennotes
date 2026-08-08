# 03 — Storage & Vault

## Principle

The vault model does not change on mobile. A ZenNotes vault is "a normal directory on a filesystem"; notes are plain Markdown files; there is no proprietary database (see [`docs/reference/vault-and-folder-model.md`](../../reference/vault-and-folder-model.md)). Mobile preserves this contract exactly — the difference is only *how* the bytes are read and written, because there is no Node `fs` in a WebView.

On desktop, `apps/desktop/src/main/vault.ts` (~3.8k lines) owns the filesystem: atomic writes (temp file → `fs.rename`, with `.bak`), `gray-matter` frontmatter, YAML + TOML support, the `assets/` directory (legacy `attachements/` and `_assets/` recognized), and `.zennotes/` metadata. The mobile bridge reimplements the **same behavior and the same on-disk layout** over the Capacitor Filesystem plugin.

## On-device vault location

The vault is a real directory the OS lets us read/write. Two storage tiers, chosen at first-run (mirroring how Obsidian frames it, but with sync as the default cross-device story rather than iCloud):

### iOS

| Tier | Path | Survives uninstall | Visible in Files app | Notes |
|---|---|---|---|---|
| **App container (default)** | `<App>/Documents/ZenNotes/<vault>` | No | Yes, if `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` are set | Fast, no permission friction. Recommended default; cross-device via ZenNotes Sync. |
| **iCloud Drive** | `iCloud Drive/ZenNotes/<vault>` (app-owned ubiquity container) | Yes | Yes | Optional. **Sync via iCloud is offered but not required and not combined with first-party Sync on the same vault** (running two sync systems on one vault causes duplication/corruption — a documented Obsidian failure). |
| **External folder (advanced)** | User-picked via `UIDocumentPickerViewController` + security-scoped bookmark | Depends | Yes | Lets power users point at a Working-Copy / git folder. Requires persisting the security-scoped bookmark and `startAccessingSecurityScopedResource` around every access. |

**iOS reality check:** unlike desktop, iOS cannot casually open an arbitrary folder and watch the whole tree. Obsidian confines itself to its container + a dedicated iCloud folder for exactly this reason. We accept the same constraint for the default/iCloud tiers and expose the external-folder tier only as an advanced option with the document-picker + bookmark machinery.

### Android (fast-follow)

| Tier | Path | Survives uninstall | Notes |
|---|---|---|---|
| **App storage (default)** | `/Android/data/md.zennotes/files/<vault>` | No | Private sandbox, no permission prompt. Recommended default; cross-device via ZenNotes Sync. |
| **Shared device storage (advanced)** | User-picked folder | Yes | Enables third-party sync (Syncthing/FolderSync). Requires either SAF (`ACTION_OPEN_DOCUMENT_TREE`, per-folder grant) **or** the broad `MANAGE_EXTERNAL_STORAGE` ("All files") permission. |

**Android decision — SAF vs All-files.** Obsidian requests broad `MANAGE_EXTERNAL_STORAGE` (under Google Play's document-management exemption) because it needs the whole tree at once and SAF's per-file access is slow. For ZenNotes:

- Default tier uses **app storage** → no permission at all, best onboarding.
- Advanced tier: **start with SAF** (`ACTION_OPEN_DOCUMENT_TREE`) to avoid the Play Store "All files access" review scrutiny; only pursue `MANAGE_EXTERNAL_STORAGE` if SAF performance on large vaults proves unacceptable (it may — this is an [open question](./09-roadmap-and-risks.md)). Because the default is app-storage + ZenNotes Sync, most users never hit this.

## Filesystem access: `vault-fs.ts`

Implements the file-facing subset of `ZenBridge` over `@capacitor/filesystem`, preserving the desktop guarantees:

- **Atomic writes.** Write to `<name>.md.tmp`, then rename over the target; keep one `.bak` as desktop does. Capacitor Filesystem supports write + rename; on iOS/Android the rename is atomic within the same directory.
- **Frontmatter.** Reuse the same YAML + TOML parsing app-core uses (`gray-matter` + `smol-toml` are pure JS and run in the WebView — no native dependency). `NoteContent.body` remains the raw markdown **including** frontmatter, per the existing contract.
- **Assets.** Same unified `assets/` dir; recognize legacy `attachements/` (intentional typo — **do not change**) and `_assets/`, and `deleted-assets/`. New referenced files default to the vault root, matching desktop.
- **Path contract.** POSIX, vault-relative paths (`NoteMeta.path`) exactly as today. The bridge translates to platform URIs internally; the UI never sees a native path. Honor the "trust the `path` other tools return" rule end-to-end.
- **System areas.** The four lifecycle areas (`inbox`, `quick`, `archive`, `trash`) and `primaryNotesLocation: 'inbox' | 'root'` behave identically — they're just directories.
- **Metadata.** `.zennotes/workspace.json` and vault settings are written the same way. Note `.zennotes/` participates in sync selectively (see [04](./04-sync-engine.md)) to avoid the config-churn problem Obsidian has with `.obsidian`.

## Indexing & the "don't load the whole vault" rule

**This is the most important mobile-specific design point in storage.** Obsidian loads and indexes the *entire* vault into memory on every launch; on large vaults with image attachments this means 40–70s cold starts and repeatable crashes, and lazy loading has been an open request for years. ZenNotes must not repeat this.

Design:

1. **Persisted index, not full-content load.** Maintain a lightweight index (`.zennotes/index.db` via SQLite through a Capacitor SQLite plugin, or a compact JSON/msgpack index for smaller vaults) holding `NoteMeta` for every note — path, title, folder, timestamps, size, tags, wikilinks, asset embeds, excerpt. This is what the sidebar/search/quick-switcher read. Note *bodies* are loaded only when a note is opened.
2. **Incremental updates.** On launch, stat the tree and only re-parse notes whose `mtime`/size changed since the last index write. First launch parses everything once (with a progress indicator); subsequent launches are near-instant.
3. **Virtualized lists.** The sidebar already supports windowing large flat note lists via inert placeholders that preserve the DOM/`data-attr` contract; that virtualization carries to mobile and is essential here.
4. **Attachments are the crash driver, not note count.** Never eagerly load image/PDF bytes. Thumbnails are generated lazily and cached; full assets load on view. Selective sync (see [04](./04-sync-engine.md)) keeps large binaries off the device until needed.
5. **DeferredView-style rendering.** Only render the active pane/tab; defer preview hydration (Mermaid/plots) until a note is actually visible. `app-core`'s lazy renderer imports already support pay-for-what-you-use loading.

## Watcher (`watcher.ts`)

Desktop uses chokidar to emit `VaultChangeEvent`s so the UI live-updates; the web app gets the same events over a WebSocket from the Go server's fsnotify watcher. On mobile there is no persistent file watcher (and no background execution — see below), so `onVaultChange` is fed by three sources:

1. **Sync events** — the sync client (see [04](./04-sync-engine.md)) emits `VaultChangeEvent` when it applies a remote change. This is the primary "something changed" signal on mobile.
2. **App-foreground rescan** — on resume, run the incremental index update (stat + re-parse changed files) and emit events for anything that changed while backgrounded (e.g. a Files-app edit, or an iCloud tier update).
3. **In-app writes** — local edits emit events directly, as today.

The `VaultChangeEvent` shape and `onVaultChange` subscription API are unchanged, so `app-core` consumes them identically across runtimes.

## Background execution limits

Neither iOS nor Android permits reliable long-running background sync (Obsidian sync is foreground-only for exactly this reason). Consequences the storage/sync layers must handle:

- Sync runs while the app is foregrounded, plus short OS-granted background windows (iOS `BGProcessingTask` / background fetch; Android `WorkManager`) on a best-effort basis — treat these as opportunistic, never guaranteed.
- On resume after time away, expect a reconnect + reconciliation pass before the vault is current; the UI shows a non-blocking "syncing…" state and never lets a stale remote silently overwrite a fresh local note (the startup-race protection in [04](./04-sync-engine.md)).

## Related

- [02 — Architecture](./02-architecture.md)
- [04 — Sync Engine](./04-sync-engine.md)
- [`docs/reference/vault-and-folder-model.md`](../../reference/vault-and-folder-model.md)
