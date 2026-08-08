# Database note links

Databases discover and link the vault's notes instead of hard-coding values.
Asked for in #500 ("auto discover links from base view, just like notes view").

> **Status (August 2026).** SHIPPED on v2.25.0: all three surfaces below plus
> the shared picker engine. This document records the design decisions and the
> deliberate non-choices; the shipped behavior is the first section.

## What shipped

Three surfaces, one engine:

1. **Text cells complete `[[`.** While editing a text cell, an unclosed
   `[[query` before the caret opens the same ranked note list as the editor's
   wikilink completion; Enter inserts `[[target]]` and typing continues.
2. **Select options can be note-sourced.** A select / multiSelect field can
   declare an `optionsSource` (all notes, a folder subtree, or a #tag) via the
   column menu. The cell popover then suggests matching notes live, and a
   picked note commits its title through the normal option-minting path, so
   schema.json, boards, filters, and older builds keep seeing ordinary select
   values. Discovery is a picker convenience, never a new value kind.
3. **Note link field types.** `note` / `noteMulti` cells store real wikilink
   targets. The cell editor is a searchable picker; display chips resolve to
   note titles and follow the link on click (the empty cell area edits).
   Unresolvable targets render muted rather than broken.

The engine behind all three is `lib/link-candidates.ts`: the matching,
scoring, and target-derivation extracted from `cm-wikilinks.ts`, now pure and
store-free. The editor's completion consumes it through thin CodeMirror
adapters, so every `[[` surface in the app ranks identically. Any future
surface (live-queries autocomplete, mobile) should consume it too, not fork it.

## Decisions and why

- **Cell encoding is bracket-delimited.** `note` cells hold `[[A]]`,
  `noteMulti` holds `[[A]] [[B]]` space-joined. multiSelect's comma-joined
  encoding cannot carry titles with commas ("Smith, John"); wikilink brackets
  can, and the raw CSV stays readable and Obsidian-recognizable. Parsing is
  `splitNoteLinks` / `joinNoteLinks` in shared-domain `database-transforms`,
  which tolerate aliases (`[[A|alias]]`) and surrounding prose.
- **Select values stay plain strings.** Option 2 deliberately does NOT store
  wikilinks in select cells. Groupability, filters, and old-build behavior all
  depend on select values being ordinary strings; the relation semantics live
  in the note field types instead. Consequence: a select-picked note is
  stored by title (comma-stripped, same as any option), and two notes sharing
  a title share a value. The Note link types are the answer when identity
  matters.
- **Graceful degradation is inherited, not built.** Older builds do not
  validate field types: an unknown type renders as a text cell and the schema
  round-trips untouched (verified against the sidecar parse). The one sharp
  edge was the filter menu throwing on unknown types; `opsFor` now falls back
  to text ops.
- **Record pages needed the YAML fix first.** Frontmatter scalars are quoted
  by the shared `yamlValue`, strengthened so a leading indicator
  (`[[x]]`, `- x`, `> x`, ...) is quoted while mid-value brackets stay bare.
  Without it, a wikilink cell mirrored as `Key: [[X]]` parses as a nested
  array in every YAML reader including our own.
- **Naming.** UI labels are "Note link" / "Note links" (type ids `note` /
  `noteMulti`). "Relation" was rejected: ZenNotes vocabulary is notes and
  links, and the label must carry meaning without a databases glossary.

## Deliberate non-choices (revisit only with a reason)

- **No board grouping by note fields.** Boards group by select fields only;
  grouping by a link means choosing a display key and an empty-bucket rule
  that select already answers. If demand appears, resolve titles at group
  time and treat unresolved targets as their raw text.
- **No backlink indexing from cells.** A `[[link]]` inside data.csv is not
  indexed into the note graph (backlinks panel, graph counts); only record
  pages, which are real notes, contribute. Indexing CSV cells means teaching
  every indexer (desktop main, MCP, Go, mobile) about databases: a
  cross-cutting decision for its own day.
- **No assets or databases in the cell pickers.** The editor's `[[` offers
  notes, assets, and databases; the cell pickers offer notes only. Nothing
  renders an asset embed inside a grid cell, so offering one is a trap.
  The engine already supports both if a case shows up.
- **`optionsSource.folder` matches note paths, not sidebar identity.** The
  stored value is a vault-relative path prefix. A folder rename breaks the
  scope (the field menu shows the configured path; re-pick it). Tracking
  folder identity through renames is not worth the machinery for v1.

## Follow-ups that would earn their keep

- Live re-scope: the pickers read the store's note list at open time, so new
  notes appear immediately; a "create note from query" row in the pickers
  (like the editor's link-to-missing-note flow) is the natural next step.
- `linking` / `linked-from` workflow sources (the live-queries doc wants the
  same) could then treat note-field cells as edges once cell indexing is
  decided.
- The board could render note-field chips as clickable links like the grid.
