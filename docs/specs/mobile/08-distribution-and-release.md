# 08 — Distribution & Release

## The strategic shift

ZenNotes desktop is distributed via **GitHub releases** — the desktop release process treats the GitHub release body as the only target and deliberately skips App-Store artifacts and character limits. **Mobile breaks that model.** iOS and Android can only ship through the App Store and Play Store, which means:

- App Store review and Play Store review on every release.
- Store-specific release artifacts the desktop workflow has never produced: App Store "What's New" copy (with character limits), Play Store listing + short/full descriptions, screenshots per device class, privacy nutrition labels / Data Safety form, age rating.
- A store review cycle (hours to days) between "code frozen" and "users have it" — no more instant GitHub-release publishing.

The release-docs workflow needs a **mobile track** added alongside the existing personal/GitHub-oriented one. Treat this as new surface, not an extension of the desktop release checklist.

## Bundle identifiers & signing

- **iOS**: `md.zennotes` (or the org's chosen reverse-DNS). Apple Developer Program membership, an App ID with the capabilities below, distribution certificate + provisioning profiles. Signing runs in CI (see below) — never hand-signed per release.
- **Android** (fast-follow): `md.zennotes` application id, a Play upload key + Play App Signing.

## iOS entitlements & capabilities

Requested only for what the app actually uses (each expands the privacy story and review scrutiny):

| Capability | Why |
|---|---|
| **WKWebView + JIT** | Automatic via Capacitor; the out-of-process Nitro/JIT engine is granted by the dynamic-codesigning entitlement. No special approval needed. |
| **iCloud (CloudKit/ubiquity container)** | Only if the iCloud vault tier ([03](./03-storage-and-vault.md)) is enabled. Adds an iCloud container entitlement. |
| **App Groups** | Share data between the app and the Share Extension / widget (the quick-capture pipeline in [07](./07-navigation-and-ux.md)). |
| **Keychain sharing** | Store the sync key in the Keychain so the device remembers it while the server never does ([04](./04-sync-engine.md)). |
| **Background modes** (`processing` / `fetch`) | Best-effort opportunistic sync only; foreground is the real sync path ([03](./03-storage-and-vault.md)). Justify narrowly in review. |
| **Document picker / file access** | For the advanced external-folder vault tier (security-scoped bookmarks). |

`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` if the app-container vault should be visible/editable in the Files app.

## Android permissions

- **Default (app storage)**: no storage permission required — best onboarding.
- **Advanced (shared storage)**: prefer **SAF** (`ACTION_OPEN_DOCUMENT_TREE`, per-folder grant) to avoid the heavy Play review that `MANAGE_EXTERNAL_STORAGE` ("All files access") triggers. Only pursue All-files access — under Google Play's document-management-app exemption, the way Obsidian does — if SAF performance is unacceptable on large vaults ([09](./09-roadmap-and-risks.md) open question).
- Write a `.nomedia` file in shared-storage vaults automatically to stop Google Photos from ingesting/deleting synced image attachments ([04](./04-sync-engine.md)).

## App Store review considerations

- **"Loads arbitrary user files":** this is *why* the iOS app is sandboxed to its container + iCloud folder for the default tiers; framed correctly, it's a standard document-based app. The external-folder tier uses the sanctioned document picker.
- **Interpreted code / future plugins:** ZenNotes v1 ships **no plugin platform on mobile** ([01](./01-overview.md)), so the App Review Guideline 2.5.2 concern (no downloading executable code that changes app behavior) does not arise in v1. If/when mobile plugins land, they run as interpreted JS inside the app's own WebView/JavaScriptCore — which Guideline **4.7** explicitly permits ("HTML5 and JavaScript mini apps… and plug-ins"), the same basis Obsidian relies on. Design the eventual plugin loader to fit 4.7 (interpreted-in-WebView, no native binary modification).
- **Encryption:** ZenNotes Sync uses standard cryptography — declare it (French/US export compliance: `ITSAppUsesNonExemptEncryption`), qualify for the standard exemption.
- **Privacy labels / Data Safety:** be precise and honest — data is E2E encrypted; the server holds ciphertext plus the path↔content mapping and sync metadata ([04](./04-sync-engine.md)). Don't overclaim "zero knowledge" where metadata is visible.

## CI/CD

- **Web bundle** built by Vite (`apps/mobile`), `npx cap sync` into native projects — reuses the existing Turbo graph for `build`/`typecheck`.
- **iOS**: CI (Xcode Cloud, or GitHub Actions with a macOS runner) builds, signs, and uploads to **TestFlight** for internal + external beta, then promotes to the App Store. Local iteration uses the XcodeBuild tooling available in this environment (simulator build/run, log capture, screenshots) — useful for driving the app during development and for generating store screenshots.
- **Android**: Gradle build in CI, signed with Play App Signing, uploaded to an internal testing track, promoted to production.
- **Versioning**: keep the monorepo version aligned; the mobile app carries its own build/version numbers for the stores while referencing the shared product version. Screenshots and "What's New" are generated per release as part of the mobile release track.

## Beta program

- **iOS**: TestFlight (internal for the team, external for a public beta). Mirrors how Obsidian ran a staged closed beta before its 2021 launch.
- **Android**: Play internal/closed/open testing tracks.
- A small **device matrix** for the beta (oldest supported iOS, a mid-range Android, an iPad) to catch the keyboard/IME, storage-permission, and rendering issues that only appear on-device.

## Related

- [01 — Overview & Product Goals](./01-overview.md) (business context, App Store note)
- [04 — Sync Engine](./04-sync-engine.md) (privacy disclosures)
- [09 — Roadmap & Risks](./09-roadmap-and-risks.md)
