# Live Queries

Dataview-style embedded views: a fenced block in any note that renders a live,
read-only view over the vault.

> **Status (August 2026).** Design document, nothing shipped. Written from an
> investigation of obsidian-dataview against what ZenNotes already has. The
> single most important finding is that the hard 80% of this feature already
> exists in the repo and ships today inside Workflows; what remains is a
> read-only rendering surface for it.

## Problem Statement

**How might we** let a note answer a question about the vault, and keep
answering it as the vault changes, without a database, a plugin platform, or a
second query language?

Obsidian's Dataview is the canonical answer in that ecosystem and one of its
most-installed plugins. What people actually build with it is remarkably
consistent:

- A project hub: every note tagged `#project/acme`, as a table with a status
  frontmatter column.
- A reading log: `#book` notes where `rating >= 4`, sorted, as a table.
- A dashboard: recently edited notes, notes missing a field, orphans.
- A task rollup: open tasks across a set of notes, in one place.

ZenNotes' current answers each miss the target from a different side:

| Surface                            | What it gives               | What it misses                                                       |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Tasks / Tags / Archive views       | Live, vault-wide            | Fixed queries, app-level, not embeddable in a note                   |
| Databases (`.csv`)                 | Tables, views, typed fields | A separate data file you fill in, not a view derived from your notes |
| Workflows `render table` + `write` | The exact query semantics   | A manual run that materializes text once; stale a minute later       |

The workflows design doc names the missing piece in its own problem statement:
"every note tagged #book with rating 4 or higher, in a table in my reading
log" and then answers it with a pipeline that has to be run by hand. A live
query is that pipeline running itself.

## What the repo already has

This design is mostly an inventory. The engine, the language, the reader, and
the render styles all exist and are tested:

- **The language.** Workflow statements: sources (`all`, `folder`, `tag`,
  `search`, `current`, `selection`), filters (`where`, `tagged`, `not-tagged`,
  `in`, `matching`, `contains`, `since`), shaping (`sort`, `limit`, `dedupe`,
  `union`, `subtract`), and a terminal `render table|list|count|links` that
  turns a NoteSet into markdown. `where`/`sort`/`render table` share one field
  vocabulary: `title`, `path`, `folder`, `created`, `updated`, plus any flat
  frontmatter key.
- **The engine.** `planWorkflow` in `@shared/workflows/engine` is structurally
  read-only (`VaultReader` has no write method), returns per-wire NoteSets and
  rendered text, and reports author mistakes through a real diagnostics
  channel. The `matching` regex subset is RE2-compatible on purpose.
- **The reader.** `createVaultReader` in app-core adapts the store's note list
  to the engine, reads bodies at most once per reader, and parses frontmatter
  from bodies on demand. It runs in the renderer today, which means it runs in
  the web client too.
- **The rendering pattern.** Inline mermaid (#530) established how a fenced
  block renders as a widget in the editor: decoration over the fence, cursor
  enters to reveal source, and the block publishes line ranges so arrow keys
  and Vim's `j`/`k` can step into it. The subtask rollup established the other
  rule: one implementation feeds both the editor widget and the reading-view
  remark plugin, so the two renderers cannot disagree.

Dataview's remaining surface, and the deliberate answer to each:

| Dataview feature                        | This design                                                                                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DQL (`TABLE x FROM #tag WHERE ...`)     | Not adopted for authoring; two query languages in one app is a bug. Imported blocks render through a translator when they translate completely (see Coming from Dataview below). |
| `dataviewjs`                            | Never. It is a plugin platform by another name, and that platform was built and reverted on purpose. A migration docs page maps the common recipes to queries or workflows.      |
| Inline fields (`key:: value`)           | Read-compat only, inside the query engine (see Coming from Dataview). ZenNotes' own vocabulary stays frontmatter + `#tags` + task `@key:value`.                                  |
| TASK view                               | Phase 2, joined against the existing vault task index.                                                                                                                           |
| CALENDAR view                           | Out. The Tasks calendar exists; a per-note calendar renderer is a lot of surface for little demand.                                                                              |
| Inline expressions (`= this.file.name`) | Out for now. Templates already cover the creation-time cases.                                                                                                                    |

## Recommended Direction

**A live query is a read-only workflow pipeline, rendered in place.**

````markdown
```query
tag #book | where rating >= 4 | sort rating desc | render table title, rating
```
````

In the editor that fence draws as the resulting table (mermaid-style widget,
cursor enters to edit the source). In Preview, Split, exports, and shared
notes it renders through the remark plugin. When the vault changes, it
re-renders. That is the entire feature; everything below is consequences.

**One language, one engine, zero new copies.** The block body parses with the
workflow parser and plans with the workflow engine against the renderer's
existing `VaultReader`. New pure logic lands in shared-domain, importable by
every surface including MCP. Nothing about parsing is duplicated.

**Read-only is enforced by the registry, not by convention.** A statement
using a mutating step (`add-tag`, `move`, ...), a sink (`write`,
`create-each`, ...), or `call` renders as a diagnostic panel, the same way the
workflows canvas surfaces an invalid step: "queries are views; to change
notes, make this a workflow." The engine's own principle carries over: an
errored statement contributes nothing, so a broken query renders an error
card, never a half-result.

**Liveness rides the store.** The engine plans against the store's note index,
and the store already refreshes on watcher events. Re-plan queries for the
visible note, debounced, keyed by (block source, notes revision). A plan over
metadata-only steps is cheap at 5000 notes by the engine's own design; steps
marked `needsBody` (`search`, `where`, `contains`, `sort`) load bodies for the
set that reaches them, which is why the docs and the insert template both put
a narrowing source first (`tag #book | where ...`, not `all | where ...`).

**Results are notes.** Every rendered row or list entry links to its note:
click opens it, and the widget participates in keyboard navigation the same
way rendered mermaid does. A query block is a saved search you can stand on.

### What this is not

- **Not Databases.** A database is structured rows you edit in place; a query
  is a derived view over notes you write normally. The docs should say this
  sentence, because every Notion refugee will ask.
- **Not a plugin escape hatch.** No script execution in blocks, full stop.

## Product case, honestly

Expected usage: a minority feature by daily use, a majority feature by
perception. Dataview is a checklist item when people evaluate leaving
Obsidian; for existing users the value concentrates in hubs, logs, and
dashboards, which are exactly the notes that create retention. Since the
engine is already paid for, the value-to-cost ratio is unusually good.

The real product risk is overlap confusion: Databases, Queries, and Workflows
are three table-shaped things. The one-sentence story goes everywhere the
features do: **databases are rows you edit, queries are views you read,
workflows are changes you run.** Told that way it is one system, not three
features, and the query-to-workflow bridge below is the part no competitor
has.

What makes it land, beyond the mechanism:

- **Smart folders (sidebar saved queries).** A saved query pinned under Quick
  access ("Reading list", "This week", "Waiting on others") is the same
  engine wearing a normal-person UI. Fences serve power users; smart folders
  serve everyone. Likely the highest-leverage enhancement in this document.
- **Convert to workflow.** A widget action that promotes a query's pipeline
  into a workflow when the user wants to act on the set. Dataview can see but
  never touch; here viewing and acting share one language, so "see it, then
  do something about it" is one click. This is the differentiator to market,
  not parity.
- **First five minutes.** `/query` inserts a working query (current folder,
  rendered as a list), never an empty fence. A preset gallery like workflows
  has: Reading log, Project hub, Recently edited, Orphans, Notes missing a
  field. In-block autocomplete for tags, folders, and frontmatter keys
  discovered across the vault, which Dataview never offered.
- **Trust details.** A footer ("12 notes · 4ms"), clickable column headers
  for ephemeral re-sort, honest empty states, and the existing right-click
  menus on result rows.
- **The unlisted dependency.** Queries make frontmatter valuable, so metadata
  entry has to get easier in step: frontmatter-key autocomplete in the editor
  at minimum, a properties panel as its own future feature. `where rating >= 4`
  assumes someone enjoyed typing that YAML.

## Coming from Dataview

The governing constraint: during a migration people run Obsidian and ZenNotes
on the same vault, so nothing may rewrite their files uninvited. Three tiers:

1. **Render on read, zero rewrite.** Real-world Dataview blocks are
   overwhelmingly a simple subset: `TABLE`/`LIST`/`TASK`, `FROM #tag` or
   `"folder"` or `[[note]]`, `WHERE` comparisons with and/or, `SORT`,
   `LIMIT`. A DQL translator for exactly that subset renders ```dataview
   fences live, in place, without touching the file, when and only when the
   block translates completely. Anything partial (GROUP BY, FLATTEN,
   functions, js) renders the info card instead: executing half of someone's
   query is worse than declining. Their dashboards just work in both apps,
   which is the migration demo that sells itself.
2. **Convert on commit.** A "Convert Dataview blocks" command for users done
   with Obsidian: scans the vault, presents a review list in the workflows
   dry-run style, converts per block or all, and preserves the original DQL
   as a comment line inside the fence so nothing is ever lost. The same
   review-first treatment covers lifting inline `key:: value` metadata into
   frontmatter and `[due:: ...]` task annotations into ZenNotes task tokens
   (the task parsers themselves never learn `::`; the command rewrites, the
   parsers stay put).
3. **Inline fields, read-compat only.** Dataview users' metadata lives in
   bodies as `key:: value`. The query engine can honor it without the
   synced-parser tax, because field extraction happens in exactly one place
   (the engine's body parse in shared-domain), unlike tags and tasks, which
   are indexed on five-plus surfaces. So queries read Dataview inline fields
   as a compatibility layer, ZenNotes' own vocabulary stays frontmatter +
   tags + task tokens, and no other surface ever learns the `::` syntax.

`dataviewjs` is an honest no, with a "Coming from Dataview" docs page mapping
the common recipes to queries or workflows: that page is cheap and is exactly
what a switcher searches for first.

## Build plan

**Phase 1, the feature.**

1. `packages/shared-domain/src/workflows/` grows a small `query.ts`: parse a
   block body as statements, validate the read-only subset (allowlist over
   `NODE_DEFS` categories), plan, return rendered markdown + diagnostics. Pure,
   tested, shared.
2. One engine adjustment: `render table` with frontmatter columns must load
   bodies for the final set (today only `where`/`sort`/`search`/`contains`
   declare `needsBody`, so a pure `tag X | render table title, rating` shows
   empty cells). Conditional: load only when a column is not a pseudo-field.
   This fixes a latent workflows quirk too.
3. Editor widget in app-core following the mermaid pattern exactly, including
   the nav-range publication (the #530 lesson: a block widget without it is
   mouse-only). Reading-view remark plugin fed by the same evaluation.
4. Insertion paths, per the keyboard-first rule: `/query` slash command,
   "Insert Query Block" palette command, and a Vim leader slot in VimNav.
5. Docs on both surfaces, plus the "not Databases" positioning sentence.

**Phase 2, tasks and the migration pack.**

- `render tasks`: a new render style joining the note set against the vault
  task index, with live checkboxes that write to the source line through the
  same path reading-view checkboxes use. This is Dataview's TASK view, and
  probably the second-most-wanted shape ("all open tasks across #project/acme
  in the project hub").
- The DQL subset translator: render-on-read for complete translations, the
  review-first convert command, and the "Coming from Dataview" docs page (see
  Coming from Dataview above). This is the growth lever, which is why it is
  phase 2 and not phase 3.
- Keyboard navigation inside results (j/k across rows, Enter opens).
- A `linking`/`linked-from` source node pair (the store already indexes
  wikilinks), which benefits workflows equally and covers Dataview's
  `FROM [[note]]`.

**Phase 3, the system pieces.**

- Smart folders: saved queries pinned to the sidebar as first-class rows.
  Listed late only because it needs its own UX pass (creation, naming,
  counts, vim navigation); the engine work is already done by then.
- Convert-to-workflow from the query widget.
- Inline `key:: value` read-compat in the engine's field lookup.
- Static rendering of query results at share time so public links show the
  table (the share viewer cannot evaluate queries, and should not).
- Go-side evaluation only if a server-rendered surface ever needs it; the web
  client evaluates in app-core today, so nothing requires it.

## Open questions (maintainer calls)

1. **The name.** `query` as fence and "Live queries" as the feature name is
   this doc's proposal. Whatever wins must appear on a UI surface, per the
   vocabulary rule.
2. **Share links.** Render-at-share-time snapshot, or strip query blocks from
   shared notes? Snapshot is more honest to what the author saw.
3. **Whether `current` should mean "the note containing the block"** (it
   should; it makes `current | linked-from | render list` a backlinks panel in
   a note) and whether that needs a distinct name like `this`.
4. **Re-render cadence.** Debounce interval, and whether body-needing queries
   re-read on every vault change or only when a note in their current result
   set changes. Phase 1 can ship with coarse invalidation and a cheap cache;
   the perf harness gets a query-block scenario either way.

## Why not just use Dataview's design?

Because ZenNotes already paid for a better one. Dataview grew a language, an
index, and a JS runtime because Obsidian gave it nothing to stand on. ZenNotes
has a tested vault-query engine with diagnostics, an RE2-safe matcher, a
body-loading strategy designed for 5000-note vaults, and a rendering pattern
for live blocks in both editors. The cost of this feature is a rendering
surface and a read-only gate. The cost of adopting Dataview's design would be
all of that, again, in a second dialect.
