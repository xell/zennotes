# Settings Reference

This document describes the main settings groups and what they control.

It is not a change log. It is a reference for the current settings model.

## Appearance

Appearance controls the app chrome and high-level presentation.

Current options include:

- theme family and mode
- sidebar presentation controls
- window/chrome visual behavior
- `Sidebar arrows`

### Sidebar arrows

Controls whether disclosure arrows are shown in the sidebar tree.

When arrows are hidden:

- folders and files should stay aligned
- folders remain expandable and collapsible
- the glyph is removed, not the behavior

## Editor

Editor settings control the writing workflow.

Current options include:

- editor behavior
- search backend preference
- Quick Note naming behavior
- custom code languages in desktop builds

### Custom code languages

The desktop app can install a self-contained TextMate JSON grammar from
`Settings → Editor → Languages`. During import you choose a primary fenced-code
tag and optional aliases, then verify highlighting against an editable sample
before installing it.

Installed languages apply to Edit, Split, and Preview and can be enabled,
disabled, replaced, revealed on disk, or removed from the same screen. Packs are
stored machine-wide under the ZenNotes config directory in
`languages/<id>/`, with a `manifest.json` and `grammar.tmLanguage.json`.

Custom languages provide syntax highlighting only. They do not add completion,
formatting, indentation rules, or language-server support. Built-in language and
diagram tags are reserved, and the initial importer accepts only self-contained
grammars without external TextMate scope dependencies.

### Vault text search backend

ZenNotes can use:

- built-in search
- `ripgrep`
- `fzf`

The runtime backend depends on what is available on the system and the configured tool paths.

### Date-titled Quick Notes

When enabled:

- new Quick Notes use `YYYY-MM-DD`

When disabled:

- new Quick Notes use a timestamp-style title

### Quick Note prefix

Used when generating new Quick Note names.

Examples:

- prefix `Quick Note` plus timestamp mode -> `Quick Note 2026-04-22 1658`
- blank prefix plus timestamp mode -> `2026-04-22 1658`
- prefix `Capture` plus date mode -> `Capture 2026-04-22`

## Keymap

Keymap settings let you inspect and override bindings.

The app includes grouped key definitions for:

- global actions
- editing/navigation actions
- note and pane actions
- zoom actions

You can:

- inspect current bindings
- override individual bindings
- reset them

ZenNotes also exposes Vim-oriented flows in the shared UI.

Important current examples:

- `Export note as PDF` defaults to `Shift+Mod+E`
- `Zoom in` defaults to `Mod+=`
- `Zoom out` defaults to `Mod+-`
- `Reset zoom` defaults to `Mod+0`

These shortcuts are editable from Settings instead of being hard-coded renderer-only behavior.

### Picker navigation

Command-driven pickers use the shared keymap model and also support Vim-style list movement.

In the command palette, search palette, buffer picker, outline picker, and vault text search picker, you can move through results with:

- `ArrowDown`
- `ArrowUp`
- `Ctrl+N`
- `Ctrl+P`

That behavior works in both desktop and browser builds while the picker input is focused.

## Typography

Typography settings control readability and editor density.

Current options include:

- interface font
- text font
- monospace font
- editor and preview text size
- line height
- editor width

These settings affect the feel of both editing and reading.

## Vault

Vault settings describe how ZenNotes interprets and presents the current vault.

### Vault location

In local mode:

- shows the local vault directory

In remote mode:

- shows `Remote workspace`
- shows the connected server URL
- offers remote-specific actions like `Change Remote Vault...`

### Saved remote workspaces

Desktop builds can store multiple remote workspace profiles.

Each saved remote can include:

- an optional label
- a server URL
- an optional vault path
- credential presence

You can:

- create a new remote
- connect to a saved remote
- edit it
- remove it

### Primary notes location

Controls where ZenNotes treats the main notes area as living.

Options:

- `Inbox`
- `Vault root`

`Inbox` keeps the original lifecycle-first ZenNotes layout.

`Vault root` surfaces top-level vault notes and folders directly, which is better for flat vaults and many imported Obsidian setups.

### Daily notes

Daily notes are optional.

Related settings include:

- enable/disable daily notes
- daily notes directory pattern
- daily note naming pattern
- daily note locale

The directory pattern is stored inside the primary notes area. The default is `Daily Notes`.

The naming pattern is used as the daily note title and filename. The default is `yyyy-MM-dd`.

Supported pattern tokens:

| Token | Example | Meaning |
| --- | --- | --- |
| `yyyy` | `2026` | 4-digit year; ISO week-year for weekly notes |
| `yy` | `26` | 2-digit year |
| `M` | `6` | month |
| `MM` | `06` | padded month |
| `MMM` | `Jun` | short month name |
| `MMMM` | `June` | full month name |
| `d` | `9` | day of month |
| `dd` | `09` | padded day of month |
| `EEE` | `Tue` | short weekday name |
| `EEEE` | `Tuesday` | full weekday name |
| `w` | `24` | ISO week number |
| `ww` | `24` | padded ISO week number |

Wrap literal text in single quotes, for example `'Daily Notes'/yyyy/MM-MMM`.

The locale controls localized month and weekday names. Use `system`, `en-US`, `pt-BR`, or another BCP 47 locale.

For example, directory `yyyy/MM-MMM`, naming `yyyy-MM-dd-EEE`, and locale `en-US` creates a note like `2026/06-Jun/2026-06-09-Tue.md`.

### Weekly notes

Weekly notes are optional.

Related settings include:

- enable/disable weekly notes
- weekly notes directory pattern
- weekly note naming pattern
- weekly note locale

The directory pattern is stored inside the primary notes area. The default is `Weekly Notes`.

The naming pattern is used as the weekly note title and filename. The default is `yyyy-'W'ww`.

Weekly notes use the same pattern tokens as daily notes, plus `w` and `ww` for ISO week numbers. Weekly date tokens render from the ISO week's Monday, and `yyyy` is the ISO week-year.

For example, directory `yyyy/MM-MMM`, naming `yyyy-'W'ww-EEE`, and locale `en-US` creates a note like `2026/06-Jun/2026-W24-Mon.md`.

### Quick Notes label

Lets you rename the user-facing label for the Quick Notes section without changing its underlying system meaning.

### Folder icons

Folders can have custom sidebar icons.

The current icon system supports:

- built-in system icons
- a growing set of semantic icons
- theme-compatible rendering through `currentColor`

Folder icons are intended to adapt to themes instead of carrying fixed hard-coded colors.

### PDF export

ZenNotes can export the current note as a PDF.

Behavior depends on runtime:

- desktop saves a PDF directly through the native save flow
- browser opens a print-friendly rendered note view so you can use the browser's `Save as PDF`

PDF export uses the rendered Markdown view rather than raw Markdown source, and the export surface uses a white paper-style background.

## CLI and launcher integrations

Desktop builds expose a `CLI` settings page for installing the `zn` command-line companion.

### Install Command-Line Tool

The installer creates a symlink named `zn` that points to the wrapper bundled with the app.
The command was named `zen` before 2.10.0; it was renamed because `zen` collides with Zen Browser on PATH. Installing `zn` removes a ZenNotes-managed `zen` symlink if one is left over.
Packaged desktop releases include the CLI runtime dependencies, so `zn`, `zn mcp`, and launcher integrations use the app bundle instead of depending on the development build directory.

Install behavior:

- prefers a user-writable directory that is already on PATH
- can create `~/.local/bin` or `~/bin` and show a PATH snippet when needed
- falls back to `/usr/local/bin` with an admin prompt only when no user-writable target is available
- refuses to overwrite an unmanaged `zn` binary

The status panel shows:

- whether `zn` is installed
- the current or planned install path
- whether the install is managed by ZenNotes
- any PATH command you need to run after install

### Quick reference

The CLI can list, read, create, capture, search, append, prepend, rename, move, archive, trash, restore, delete, duplicate, manage folders, inspect tags, list/toggle tasks, and start the MCP server.

For note paths with spaces, quote the path or use `--path`.

Examples:

```bash
zn list --tag idea
zn read "inbox/Project.md"
zn read --path "hellointerview/system design.md"
zn search "deadline" --json
zn mcp
```

### Choosing a vault or a server

Every command runs against one vault: a folder on this machine, or a vault behind a self-hosted ZenNotes server.

| Flag | Meaning |
| --- | --- |
| `--vault <name\|path>` | A local vault by name or directory, or a saved server by name |
| `--server <name\|url>` | A ZenNotes server, by saved name or URL. Wins over `--vault` |
| `--token <token>` | Auth token for `--server`, overriding a saved one |

Server names come from the same profiles the desktop app saves under Settings → Vault → "Connect to Server...", so a server set up in the app is immediately usable from the terminal. `zn vault list` shows local vaults and servers together.

A bare `host:port` gets `http://` filled in. If a local vault and a server share a name, `--vault` reports the ambiguity instead of choosing.

Environment equivalents, for CI and headless machines where nothing should be written to disk:

| Variable | Meaning |
| --- | --- |
| `ZENNOTES_VAULT` | Default vault root when `--vault` is not given |
| `ZENNOTES_SERVER` | Default server when neither `--vault` nor `--server` is given |
| `ZENNOTES_REMOTE_TOKEN` | Auth token for a server |
| `ZENNOTES_CONFIG_DIR` | Override the ZenNotes config directory |

Token precedence is `--token`, then `ZENNOTES_REMOTE_TOKEN`, then the saved profile.

```bash
zn list --server home
zn capture "from my laptop" --server home --tag work
zn list --server 192.168.1.10:7878 --token "$TOKEN"

ZENNOTES_SERVER=notes.example.com:7878 ZENNOTES_REMOTE_TOKEN="$TOKEN" zn capture "from CI"
```

Differences against a server:

- `zn open` hands file paths to the desktop app, so it needs a local vault. Use `zn read` to print a remote note.
- `zn search` runs the server's search engine rather than the CLI's own scan, so ordering can differ. `--limit` is applied after the server responds.

See [Connect Desktop to a Remote ZenNotes Server](../how-to/connect-desktop-to-remote-server.md) for the full guide.

### Raycast

On macOS, the Raycast integration is installed from the `CLI` settings page.
It requires:

- Raycast installed on the Mac
- the ZenNotes CLI installed as `zn`
- Node.js 22.14 or newer
- npm 7 or newer

ZenNotes does not require the Raycast Store version. The app copies its bundled
Raycast extension source into app data, installs dependencies, builds the local
extension, and imports it into Raycast.

The Raycast command calls `zn list --json`, then opens selected notes through
`zennotes://open` or `zennotes://open-window`.

Raycast actions include:

- open in ZenNotes
- open in a floating window
- archive or unarchive
- move to Trash
- reveal in Finder
- copy note path
- copy wikilink

The settings panel shows whether Raycast, Node, and npm were found, whether the
local extension is installed, whether it matches the current ZenNotes version,
and the local extension path. When ZenNotes ships a newer bundled extension, the
same button changes from `Reinstall` to `Update`.

Read [Use ZenNotes with Raycast on macOS](../how-to/use-raycast.md) for setup and troubleshooting.

## Remote/session behavior

Relevant settings-like runtime behaviors:

- browser self-hosted login now uses a session cookie instead of a URL token
- desktop remote connections are handled by the main process
- desktop saved remote profiles should not expose raw credentials to the renderer

## Notes on persistence

Some settings are app-scoped.

Some are vault-scoped.

The practical rule is:

- visual/editor preferences usually belong to the app/user
- vault behavior belongs to the vault

Kanban column title overrides are app-scoped display preferences. They are edited directly from the Tasks Kanban column headers, not from the Settings modal. For the exact behavior, read the [Tasks Reference](./tasks-reference.md).

If you are trying to understand that boundary in more detail, read:

- [Vault and Folder Model](./vault-and-folder-model.md)
- [How ZenNotes Works](../explanation/how-zennotes-works.md)
