// The starter library: eight workflows someone can read in a minute and run on
// a real vault.
//
// This file exists because of a specific failure. Workflows shipped as a blank
// textarea over a language nobody had seen, and the first question every user
// asked was "how do I know what to write here?". A reference page answers that
// question in the abstract; a gallery answers it by example, which is the only
// form of documentation people actually read. So the gallery is the front door
// and each preset is a tutorial that happens to be useful.
//
// Three rules hold this file together:
//
//   1. Every `raw` parses with zero errors and validates with zero errors. A
//      broken example is worse than no example: it teaches the syntax wrong AND
//      it makes the editor look broken on the user's first run. `presets.test.ts`
//      asserts it, so a preset cannot rot silently when a node changes.
//   2. Every `raw` opens with a `#` comment explaining the pipeline in plain
//      English. The comment survives a canvas save (see `WorkflowStatement.leading`),
//      so it stays with the workflow after the user edits it.
//   3. Together the eight cover every node category a workflow can use, so
//      reading the gallery end to end is a complete tour of the language.
//
// The presets deliberately keep their `=` signs aligned even though the
// serializer writes canonical single-space form. Columns make the shape of the
// language visible at a glance (name on the left, pipeline on the right), which
// is the whole teaching job. A canvas save reformats them, which is the
// documented behaviour of the serializer and costs nothing but padding.

/* -------------------------------------------------------------------------- */
/*  Shape                                                                     */
/* -------------------------------------------------------------------------- */

export type PresetCategory = 'Review' | 'Cleanup' | 'Capture' | 'Reporting'

export interface WorkflowPreset {
  /** Slug, also usable as the filename stem, which is what becomes a workflow id. */
  id: string
  name: string
  /** One line, plain language, what it does FOR YOU. */
  description: string
  category: PresetCategory
  /** Why you would want this, 1-2 sentences, no jargon. */
  rationale: string
  /** Complete file text including frontmatter. Parses AND validates clean. */
  raw: string
  /**
   * True when running it plans changes to the vault, so the gallery can warn
   * before the first run.
   *
   * Every preset is currently `true` and that is not an oversight: every sink in
   * `NODE_DEFS` is mutating, so a workflow that produces anything at all writes
   * something. The flag is stated per preset rather than derived so that
   * `presets.test.ts` can check it against the registry instead of restating the
   * same derivation twice.
   */
  mutating: boolean
}

/* -------------------------------------------------------------------------- */
/*  The workflows                                                             */
/* -------------------------------------------------------------------------- */

const READING_LOG = `---
name: Reading log
description: Keep the reading log in sync
status: draft
trigger: manual
key: <leader>wr
---

# Every note tagged #book goes onto the \`books\` wire, which then splits in two:
# the ones you rated 4 or better and the ones you did not. The good ones become
# a table in your reading log and the rest pick up a #someday tag so they are
# easy to find later. Two statements reading \`books\` is what makes it a fork.
books   = tag #book
good    = books | where rating >= 4 | sort finished desc
someday = books | where rating < 4

good    | render table title, rating, finished | write-section "inbox/Reading Log.md" "Finished"
someday | add-tag #someday
`

const INBOX_TRIAGE = `---
name: Inbox triage
description: Tag the inbox notes that have gone quiet
status: draft
trigger: manual
key: <leader>wi
---

# \`since 7d\` keeps the notes that WERE touched in the last week, so the way to
# say "not touched in a week" is to take the whole inbox and subtract the recent
# part. What is left, minus anything already filed, gets a #triage tag: oldest
# first and capped at 25 so the first run is a batch you can actually finish.
inbox   = folder inbox
recent  = inbox | since 7d
resting = inbox | subtract recent
loose   = resting | not-tagged #project | not-tagged #triage
batch   = loose | sort created asc | limit 25

batch | add-tag #triage
`

const WEEKLY_REVIEW = `---
name: Weekly review
description: List what changed this week in your review note
status: draft
trigger: manual
key: <leader>ww
---

# Everything in the vault that changed in the last seven days, newest first,
# written as a bullet list under one heading. \`write-section\` replaces only that
# heading's section, so the rest of the review note stays yours to write.
touched = all | since 7d | sort updated desc

touched | render list | write-section "inbox/Weekly Review.md" "Touched this week"
`

const OPEN_LOOPS = `---
name: Open loops
description: Gather every note that still says TODO
status: draft
trigger: manual
key: <leader>wo
---

# \`contains\` reads the text of each note rather than its metadata, so this one
# is slower than the rest and is worth running by hand rather than on a trigger.
# The 50 most recently changed matches are listed as links you can click through.
loose = all | contains TODO | sort updated desc | limit 50

loose | render links | write-section "inbox/Open Loops.md" "Notes with TODOs"
`

const ARCHIVE_DONE = `---
name: Archive finished projects
description: Archive the project notes marked done
status: draft
trigger: manual
key: <leader>wa
---

# \`where\` reads frontmatter, so this matches notes whose file carries
# \`status: done\`. Archiving keeps the file and moves it out of the way, and
# ZenNotes records the inverse of every run so you can put them all back.
done = tag #project | where status = done

done | archive
`

const UNFILED_NOTES = `---
name: Unfiled notes
description: Find the notes no top-level tag has claimed
status: draft
trigger: manual
key: <leader>wu
---

# \`union\` puts two wires together and \`subtract\` takes one away, so "everything
# except what is filed" is a two-step sum. This is as close to "notes nothing
# links to" as the engine gets today: it reasons about tags, not links. Change
# #project and #area to whichever tags you really file under.
projects = tag #project
areas    = tag #area
filed    = projects | union areas
unfiled  = all | subtract filed | sort updated desc | limit 50

unfiled | render list | write-section "inbox/Vault Health.md" "Unfiled"
`

const TAG_CLEANUP = `---
name: Tag cleanup
description: Merge one tag into another across the vault
status: draft
trigger: manual
key: <leader>wc
---

# The new tag is added before the old one is removed and both steps run over the
# same wire, so no note is ever left untagged in between. Swap #todo and #task
# for the pair you want to merge.
strays = tag #todo

strays | add-tag #task | remove-tag #todo
`

const MEETING_INDEX = `---
name: Meeting index
description: Keep one note listing every meeting
status: draft
trigger: manual
key: <leader>wm
---

# Meetings newest first, written as wikilinks so the index is clickable. Swap
# \`render links\` for \`render table date, title\` if you would rather read the
# dates in a column.
meetings = tag #meeting | sort date desc | limit 100

meetings | render links | write-section "inbox/Meetings.md" "All meetings"
`

/* -------------------------------------------------------------------------- */
/*  The gallery                                                               */
/* -------------------------------------------------------------------------- */

export const WORKFLOW_PRESETS: readonly WorkflowPreset[] = [
  {
    id: 'reading-log',
    name: 'Reading log',
    description: 'Turns your #book notes into a rated table in one reading log note.',
    category: 'Reporting',
    rationale:
      'You rate books as you finish them but never see them together. This keeps one note up to date so you can look back over a year of reading without hunting through tags.',
    raw: READING_LOG,
    mutating: true
  },
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    description: 'Tags the inbox notes you have not touched in a week so you can deal with them.',
    category: 'Cleanup',
    rationale:
      'Capturing is easy and filing is not, so the inbox grows quietly. This turns "my inbox is a mess" into a short list of 25 notes to work through.',
    raw: INBOX_TRIAGE,
    mutating: true
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    description: 'Lists everything you changed in the last seven days in your review note.',
    category: 'Review',
    rationale:
      'Sitting down to review the week usually starts with trying to remember what you did. This writes that list for you before you start.',
    raw: WEEKLY_REVIEW,
    mutating: true
  },
  {
    id: 'open-loops',
    name: 'Open loops',
    description: 'Collects every note that still says TODO into one list.',
    category: 'Capture',
    rationale:
      'Half-finished thoughts get left inside notes you never reopen. This gathers them in one place so nothing you meant to come back to goes missing.',
    raw: OPEN_LOOPS,
    mutating: true
  },
  {
    id: 'archive-done',
    name: 'Archive finished projects',
    description: 'Moves the project notes marked done into the archive.',
    category: 'Cleanup',
    rationale:
      'Finished projects keep turning up in searches long after they stopped mattering. Archiving clears the noise, and the whole run can be undone if you change your mind.',
    raw: ARCHIVE_DONE,
    mutating: true
  },
  {
    id: 'unfiled-notes',
    name: 'Unfiled notes',
    description: 'Finds the notes that none of your main tags have claimed.',
    category: 'Review',
    rationale:
      'Notes that belong to no project and no area are the ones that quietly disappear. This lists them in a vault health note so you can file them or let them go.',
    raw: UNFILED_NOTES,
    mutating: true
  },
  {
    id: 'tag-cleanup',
    name: 'Tag cleanup',
    description: 'Replaces one tag with another everywhere in the vault.',
    category: 'Cleanup',
    rationale:
      'Two spellings of the same tag split your notes into two piles that never meet. Change the two tag names here and one run merges them.',
    raw: TAG_CLEANUP,
    mutating: true
  },
  {
    id: 'meeting-index',
    name: 'Meeting index',
    description: 'Keeps one note listing every meeting note, newest first.',
    category: 'Reporting',
    rationale:
      'Meeting notes are easy to write and hard to find again. One index note that is always current means you never scroll a tag list looking for a date.',
    raw: MEETING_INDEX,
    mutating: true
  }
] as const

const BY_ID = new Map<string, WorkflowPreset>(WORKFLOW_PRESETS.map((preset) => [preset.id, preset]))

/** Look a preset up by id. Null rather than throwing: an id can arrive from a
 *  saved UI state or a URL, and a stale one should show the gallery, not crash. */
export function presetById(id: string): WorkflowPreset | null {
  return BY_ID.get(id) ?? null
}

/** The gallery's tab order. Stated here so the view does not invent its own. */
export const PRESET_CATEGORIES: readonly PresetCategory[] = [
  'Review',
  'Cleanup',
  'Capture',
  'Reporting'
]

export function presetsByCategory(category: PresetCategory): WorkflowPreset[] {
  return WORKFLOW_PRESETS.filter((preset) => preset.category === category)
}

/**
 * The category's presets minus the ones the user hid from the gallery.
 *
 * Hiding is a per-user taste stored as preset ids ([view]
 * `hidden_workflow_presets` in config.toml); ids that match nothing are
 * ignored here rather than pruned, so a hidden preset that disappears in one
 * version and returns in another stays hidden across the gap.
 */
export function visiblePresetsByCategory(
  category: PresetCategory,
  hidden: readonly string[]
): WorkflowPreset[] {
  const gone = new Set(hidden)
  return presetsByCategory(category).filter((preset) => !gone.has(preset.id))
}

/**
 * The hidden presets, in the gallery's canonical order (category order, then
 * declaration order) rather than the order they were hidden in, so the Hidden
 * group reads like the gallery it came from.
 */
export function hiddenPresetsInOrder(hidden: readonly string[]): WorkflowPreset[] {
  const gone = new Set(hidden)
  return PRESET_CATEGORIES.flatMap((category) =>
    presetsByCategory(category).filter((preset) => gone.has(preset.id))
  )
}
