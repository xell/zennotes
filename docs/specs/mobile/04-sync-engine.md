# 04 — Sync Engine (ZenNotes Sync)

> This is the spec with the most new surface area. Storage & sync was the decision that expanded v1 scope: rather than lean on OS file providers (iCloud/SAF) like Obsidian's free tier, ZenNotes builds a first-party, end-to-end-encrypted sync service. The payoff is that we **own the failure modes** — every data-loss class documented in Obsidian mobile is something we can design out.

## Goals

1. **Local-first.** The device vault is the source of truth for the user; sync is a background reconciliation, never a gate on editing. The app is fully usable offline.
2. **Zero data loss.** This is a release gate. No silent overwrite of a note the user just wrote; no "disappearing files"; no placeholder-file corruption.
3. **Convergent.** Given the same set of operations, every device reaches the same vault state.
4. **End-to-end encrypted.** The server stores ciphertext; it cannot read note contents. Lost password = unrecoverable (state this plainly to users, as Obsidian does).
5. **Efficient on mobile.** Delta-based, resumable, attachment-aware, and respectful of foreground-only execution and metered connections.
6. **Deployable two ways.** The same protocol runs against a **self-hosted** ZenNotes server (free, extends `apps/server`) and a **hosted** ZenNotes Sync service (candidate paid tier). No protocol fork between them.

## What exists today (and what doesn't)

There is **no device-to-device sync, CRDT, or merge in ZenNotes today.** The closest existing thing is *remote workspace* mode: a single desktop/web client talks to one Go server over HTTP + WebSocket, and the server's fsnotify watcher pushes live changes. That is a single-vault client/server model, not multi-device sync, and it is **not** offline-capable.

ZenNotes Sync is therefore genuinely new. It reuses the Go server (`apps/server`) as the deployment vehicle and the existing session/auth flow, but adds a sync-specific protocol and storage model.

## Architecture

```text
Device A (mobile)         Device B (desktop)         Device C (web)
  local .md vault            local .md vault             (server-backed)
  sync client                sync client                     │
      │                          │                            │
      └──────────────┬───────────┴────────────────────────────┘
                     │  HTTPS (delta protocol) + WebSocket (live push)
              ┌──────┴───────┐
              │ Sync service  │   stores encrypted blobs + version DAG
              │ (apps/server  │   knows paths↔content mapping (metadata)
              │  extension)   │   NEVER sees plaintext note bodies
              └───────────────┘
```

The sync client lives in `apps/mobile/src/sync` (and a shared core in a new `packages/sync-core` so desktop/web can adopt the same client later). The service is a new module in `apps/server` (Go), reusing chi routing, the websocket library, and the existing auth/session layer.

## Data model

The unit of sync is a **vault entry** (a note or an asset), identified by a stable **entry id** (not the path — paths change on rename/move). Each entry has a version history.

```
Entry {
  id: uuid                     // stable across renames/moves
  path: string                 // current vault-relative POSIX path (encrypted at rest on server)
  kind: 'note' | 'asset'
  contentHash: sha256          // of plaintext; used for dedup + change detection
  versions: VersionRef[]       // append-only version DAG
  deleted: bool                // tombstone (soft delete; supports trash + undo)
}

VersionRef {
  versionId: uuid
  parentIds: uuid[]            // usually 1; 2+ marks a merge
  deviceId: string
  logicalClock: hybrid-logical-clock   // (physical time ⊕ counter) for causal ordering
  blobId: string              // pointer to the encrypted content blob
}
```

- **Stable ids solve the rename problem.** A note moved from `inbox/A.md` to `archive/A.md` is the same entry; sync ships a path change, not a delete + create. This is what makes link-aware behavior and clean archive/trash possible.
- **Hybrid logical clocks (HLC)** give a total causal order without trusting wall-clock skew between devices — the mechanism behind the startup-race fix below.
- Entry ids are stored in `.zennotes/` sidecar metadata mapping `entryId ↔ path` (this metadata syncs, but see the config-churn note below).

## Protocol

Delta-based pull/push over HTTPS, with a WebSocket channel for live push when foregrounded.

1. **Handshake.** Client sends its last-known server cursor (a monotonic vector/cursor) and device id.
2. **Pull.** Server returns the set of entry/version changes since that cursor (metadata only — ids, paths, version DAG, blob pointers). Small payload; blobs fetched separately and lazily.
3. **Fetch blobs.** Client downloads encrypted blobs it needs (notes eagerly; assets per selective-sync policy — see below). Resumable, content-addressed, dedup by `contentHash`.
4. **Apply.** Client reconciles remote versions against local (see conflict resolution) and writes the vault, emitting `VaultChangeEvent`s so `app-core` updates live.
5. **Push.** Client uploads new local versions (encrypted blobs + metadata), advancing the server cursor.
6. **Live.** While foregrounded, the WebSocket pushes new-version notifications so step 2 fires within seconds; step 5 pushes local edits promptly. Offline/backgrounded, everything queues and replays on next foreground.

All steps are **idempotent and resumable** — a killed sync (app backgrounded, network dropped) resumes from the last acknowledged cursor with no duplication.

## Conflict resolution

Three tiers, matching content type:

1. **Markdown notes → 3-way text merge.** When two versions share a common ancestor in the DAG, merge with a diff/patch algorithm (Google `diff-match-patch`, as Obsidian uses). Non-overlapping edits merge cleanly. This is the common case and it converges silently.
2. **Overlapping / unmergeable markdown → conflict file, never overwrite.** If the merge is ambiguous, keep the local version at its path and write the other as `Note (conflict 2026-07-02 from <device>).md` next to it, then surface a non-blocking banner. **The user never loses either side.** (Obsidian added exactly this choice in 1.9.7 after years of silent last-writer-wins.)
3. **Assets & binaries → last-writer-wins by HLC, with the losing version retained** as a versioned blob (restorable from history) rather than deleted.

**Link-awareness.** Because entries have stable ids and renames are first-class, when a note is renamed/moved on one device, the sync applies the path change on others *without* breaking `[[wikilinks]]` or `![[embeds]]` — the id is what's referenced internally, resolved to the current path at render time. This is the "deterministic, link-aware conflict handling" that Obsidian's path-based model can't guarantee.

## The failure modes we explicitly design out

Each of these is a documented Obsidian-mobile data-loss bug; the design must make each impossible, and each gets a regression test.

| Obsidian failure | ZenNotes design defense |
|---|---|
| **Startup race**: create a note locally, sync pulls a remote version within ~2 min and the remote wins un-merged, deleting the fresh note. | Local edits are committed to the version DAG *before* any pull applies. A pulled version can never overwrite a local version that isn't its ancestor — it can only merge (tier 1) or fork a conflict file (tier 2). HLC ordering means "fresh local note" is causally concurrent, not "older," so it is never silently discarded. |
| **iCloud/OneDrive placeholder files read as "missing"**, then treated as deletions. | We don't rely on OS file providers for the synced tier. The vault is real local bytes; the sync client, not the OS, decides what's present. Selective-sync "not downloaded" assets are explicit tombstone-free placeholders the client understands — never confused with a delete. |
| **`.obsidian` config churn** — the config folder syncs and thrashes `workspace.json` between devices. | `.zennotes/workspace.json` and other per-device UI state are **excluded from content sync by default**; only genuinely shared vault settings sync, and they're stored as a mergeable structured document, not a whole-file overwrite. Per-device profiles avoid cross-device thrash. |
| **Android Google Photos deletes synced image attachments.** | Default tier is app-storage (not indexed by the media scanner); for shared-storage tier, write a `.nomedia` file automatically, as the Obsidian troubleshooting guide recommends. |
| **Running two sync systems corrupts the vault** (Sync + iCloud). | First-run and settings actively prevent enabling ZenNotes Sync and an OS-provider tier (iCloud/SAF shared) on the *same* vault; the UI explains why and offers to migrate. |
| **Attachment cap halts all sync** (version history + attachments share the quota). | Notes and attachments have independent quotas/policies; hitting an attachment limit degrades to "attachments paused," never "notes paused." Note sync always takes priority. |

## End-to-end encryption

- **Key derivation:** a user-chosen password → key via a memory-hard KDF (Argon2id preferred; scrypt acceptable, matching Obsidian's baseline). The derived key never leaves the device.
- **Content encryption:** per-blob AEAD (XChaCha20-Poly1305 or AES-256-GCM). Content blobs are opaque to the server.
- **What the server *can* see (be honest in the security doc):** entry ids, the path↔content *mapping* and version DAG metadata, blob sizes, upload/delete timing. Note bodies, titles, and asset contents are encrypted. (This mirrors the Obsidian Sync disclosure that path mapping and upload metadata are not E2E; we document it rather than overclaim.)
- **Recovery:** none by design — a lost password means unrecoverable data. Surfaced prominently at setup, with an option to store the key in the platform keychain (iOS Keychain / Android Keystore, via a secure-storage Capacitor plugin) so the *device* remembers it while the *server* never does.
- Reuses ZenNotes' existing at-rest-encryption and security thinking (see [`docs/how-to/at-rest-encryption.md`](../../how-to/at-rest-encryption.md) and [`docs/explanation/security-model.md`](../../explanation/security-model.md)); this extends it to E2E in transit + at rest on the server.

## Selective sync

- **Notes**: always synced (small, high-value).
- **Attachments**: policy per vault — `all`, `recent`, `on-demand`, or `wifi-only`. Default `on-demand` on mobile so a 13 GB image library never lands on the phone (the exact scenario that crashes Obsidian mobile). An un-downloaded asset renders as a tap-to-download placeholder, not a broken embed.
- **`.zennotes/` metadata**: only shared vault settings; per-device UI state excluded (see config-churn defense above).

## Server component (`apps/server` extension)

- New Go module: encrypted-blob store (content-addressed), version-DAG store, per-user quota accounting, WebSocket push, and the delta endpoints (`/api/sync/*`).
- Reuses existing chi routing, `coder/websocket`, and the session/auth flow already in `internal/httpserver`.
- **Self-hosted**: ships in the same Docker image as today; a self-hoster gets free multi-device sync pointed at their own server. Documented alongside [`docs/how-to/self-host-with-docker.md`](../../how-to/self-host-with-docker.md).
- **Hosted (candidate paid)**: same binary + auth/storage/quota/billing layer. Pricing is a [business open question](./09-roadmap-and-risks.md); the engineering does not assume it.

## Relationship to existing remote-workspace mode

Remote-workspace mode (connect a client directly to one Go server, no local copy) still exists and `supportsRemoteWorkspace` stays `true` on mobile — useful for a self-hoster who wants a pure thin client. But it is **not** the mobile default and is not offline. ZenNotes Sync (local-first) is the default and the recommended path. The two are mutually exclusive per vault, like the OS-provider tiers.

## Testing & validation

- A deterministic **multi-device simulator** (two+ sync clients against one in-process server) that replays adversarial timelines: the startup race, offline-then-conflict, rename-during-remote-edit, attachment-cap-hit, placeholder-read. Each documented Obsidian failure is a named test that must stay green.
- Property-based convergence test: random operation interleavings across N clients must reach identical vault state.
- These run in CI under the existing Vitest (client) + Go test (server) harnesses.

## Related

- [03 — Storage & Vault](./03-storage-and-vault.md)
- [08 — Distribution & Release](./08-distribution-and-release.md) (App Store data-handling / privacy disclosures)
- [09 — Roadmap & Risks](./09-roadmap-and-risks.md)
- [`docs/explanation/security-model.md`](../../explanation/security-model.md)
