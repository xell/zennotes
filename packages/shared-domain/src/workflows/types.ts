// Core types for Workflows: user-authored pipelines over the vault.
//
// The spine of the whole feature is that a wire carries a *set of notes*, so
// every step is a function `NoteSet -> NoteSet` with optional side effects.
// Three properties fall out of that and they are why the design works:
//
//   1. Every wire knows its contents, so the editor can label each wire with a
//      live count and open it to the list of notes on it. Debugging is a
//      property of the data model rather than extra UI.
//   2. Only mutating steps write, so the whole graph can be planned without
//      touching disk. See `RunPlan`. The engine NEVER writes. It returns ops
//      and the caller applies them. Dry run is not a flag someone can forget to
//      pass, it is the shape of the API.
//   3. Layout is computed from the graph, so nothing positional is stored, so
//      the text file and the canvas are lossless projections of each other.
//
// These types are the contract shared by the parser, serializer, validator,
// engine, and layout. They deliberately contain no I/O: the engine reaches the
// vault only through `VaultReader`, which is the seam that lets the same code
// run in the renderer, in the desktop main process, and be mirrored in Go for
// server-side execution.

/* -------------------------------------------------------------------------- */
/*  Notes travelling along a wire                                             */
/* -------------------------------------------------------------------------- */

/**
 * A note as it travels along a wire.
 *
 * Metadata is always present because sources populate it in bulk. `body` is
 * loaded on demand, and `undefined` means "not read yet", NOT "empty file". Steps
 * that need content (`contains`) ask the reader for it; everything else runs
 * off metadata alone, which is what keeps a filter over 5000 notes cheap.
 */
export interface WorkflowNote {
  path: string
  title: string
  /** Vault-relative folder, e.g. `inbox` or `inbox/projects`. */
  folder: string
  /** The note's SYSTEM bucket (inbox/quick/archive/trash) as the vault
   *  classified it, when the reader knows it. `folder` is the on-disk
   *  directory, which stops naming the bucket once system folders are
   *  remapped (vault.json `systemFolderPaths`), so the working-set filter
   *  and `folder trash`/`folder archive` trust this field first. */
  system?: 'inbox' | 'quick' | 'archive' | 'trash'
  tags: string[]
  /** Flat scalar frontmatter, matching `parseFrontmatter` in template-files. */
  frontmatter: Record<string, string>
  createdAt: number
  updatedAt: number
  body?: string
}

/** The value carried by a wire. Order is meaningful: `sort` and `limit` rely on it. */
export type NoteSet = WorkflowNote[]

/* -------------------------------------------------------------------------- */
/*  The parsed workflow                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One step in a pipeline, e.g. `where rating >= 4`.
 *
 * `args` is keyed by the param names declared on the node's `NodeDef`. The
 * parser is deliberately dumb (it tokenizes) and the registry is smart (it
 * binds tokens to typed params), so adding a node never means touching the
 * parser.
 */
export interface WorkflowStep {
  /** Registry key, e.g. `where`. See `NODE_DEFS` in `./nodes`. */
  kind: string
  args: Record<string, ArgValue>
  /** 1-based line in the source body, for diagnostics and canvas focus. */
  line: number
}

export type ArgValue = string | number | boolean

/**
 * The `args` key holding raw text that could not be bound to typed params:
 * the arguments of an unknown step, or the remainder of a step whose token
 * failed coercion. The serializer writes it back verbatim, so a file survives
 * being opened and saved by a version (or an author) that does not understand
 * part of it. The `$` prefix cannot collide with a real param name.
 */
export const RAW_ARG = '$raw'

/**
 * One statement: a pipeline, optionally naming the wire it produces.
 *
 *   books   = tag #book                       name='books'  input=null
 *   good    = books | where rating >= 4       name='good'   input='books'
 *   good    | add-tag #starred                name=null     input='good'
 *
 * Fan-out is just referencing the same wire twice, which is why there is no
 * separate branch construct: `books` feeding two statements IS the branch.
 */
export interface WorkflowStatement {
  /** Wire this pipeline produces, or null for a terminal statement. */
  name: string | null
  /** Wire this pipeline reads from, or null when it opens with a source. */
  input: string | null
  steps: WorkflowStep[]
  line: number
  /**
   * Comment and blank lines that preceded this statement, verbatim and without
   * their trailing newline.
   *
   * The canvas is a projection of this file, so saving from the canvas rewrites
   * it. Without somewhere to park trivia, the first save after someone
   * documented their own workflow would silently delete every comment they
   * wrote, which is precisely the kind of quiet loss that stops people trusting
   * a round-trip. Parked here instead, and replayed by the serializer.
   */
  leading?: string[]
}

export type WorkflowEvent = 'note-created' | 'note-saved' | 'note-moved' | 'tag-added'

export type WorkflowTrigger =
  | { type: 'manual' }
  | { type: 'event'; event: WorkflowEvent; where?: string }
  | { type: 'schedule'; cron: string }

/**
 * Whether a workflow is allowed to ACT.
 *
 * "Is it written to disk" and "may it run" are two different questions, and
 * conflating them is what forced an explicit Save: a half-edited workflow must
 * never fire. Separating them makes autosave safe, because a draft can be
 * written as often as we like precisely BECAUSE a draft cannot do anything.
 *
 * The state lives in the file's own frontmatter rather than in a sidecar, so it
 * syncs with the vault, survives an export, and is visible when you read the
 * thing. See `parseWorkflow` for the compatibility rule: a file with no
 * `status:` line reads as `active`, so every workflow written before this
 * existed keeps behaving exactly as it did.
 */
export type WorkflowStatus = 'draft' | 'active'

export interface Workflow {
  /** Stable id derived from the filename stem, e.g. `reading-log`. */
  id: string
  name: string
  description: string
  trigger: WorkflowTrigger
  /**
   * Draft workflows are saved but inert: they cannot be run, and they are what
   * stops the event and schedule triggers firing. Ask `isRunnable` rather than
   * comparing this field.
   */
  status: WorkflowStatus
  /** Optional keybinding, e.g. `<leader>wr`. */
  key?: string
  statements: WorkflowStatement[]
  /**
   * Frontmatter keys we did not consume, kept verbatim so serialize(parse(x))
   * round-trips a file a future version wrote.
   */
  meta: Record<string, string>
  /** Comment and blank lines after the final statement. See `leading`. */
  trailing?: string[]
}

/**
 * May this workflow act? The one place that decides.
 *
 * Run, and later the event and schedule trigger paths, all ask here instead of
 * comparing `status` themselves. A rule spelled out once cannot be forgotten by
 * a trigger written a year from now, and forgetting it would mean a half-edited
 * workflow firing over someone's vault, which is the exact failure the draft
 * state exists to prevent.
 *
 * Takes only the field it reads, so a list row holding a summary rather than a
 * whole `Workflow` can still ask the same question of the same function.
 */
export function isRunnable(workflow: Pick<Workflow, 'status'>): boolean {
  return workflow.status === 'active'
}

/* -------------------------------------------------------------------------- */
/*  Diagnostics                                                               */
/* -------------------------------------------------------------------------- */

export interface Diagnostic {
  severity: 'error' | 'warning'
  message: string
  /** 1-based line in the source body. 0 when the problem is the file itself. */
  line: number
}

/* -------------------------------------------------------------------------- */
/*  Planned operations                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single intended change to the vault.
 *
 * Ops are pure data so they can be previewed, counted, diffed, serialized into
 * the run ledger, and mirrored by the Go engine. Inverses are NOT computed here.
 * The applier knows the before-state and records the inverse as it goes,
 * which is what makes whole-run rollback possible even when a run fails midway.
 */
export type WorkflowOp =
  | { kind: 'set-frontmatter'; path: string; field: string; value: string }
  | { kind: 'add-tag'; path: string; tag: string }
  | { kind: 'remove-tag'; path: string; tag: string }
  | { kind: 'move'; path: string; to: string }
  | { kind: 'rename'; path: string; to: string }
  | { kind: 'append'; path: string; text: string }
  | { kind: 'prepend'; path: string; text: string }
  | { kind: 'write-section'; path: string; heading: string; text: string }
  | { kind: 'write-note'; path: string; text: string }
  | { kind: 'create-note'; path: string; body: string }
  | { kind: 'apply-template'; path: string; template: string }
  | { kind: 'archive'; path: string }
  | { kind: 'trash'; path: string }
  | { kind: 'notify'; message: string }
  | { kind: 'clipboard'; text: string }

/** Ops whose effect cannot be undone by replaying an inverse. */
export const IRREVERSIBLE_OP_KINDS: ReadonlySet<WorkflowOp['kind']> = new Set([
  'notify',
  'clipboard'
])

/**
 * The result of planning a run. Contains everything the UI needs to show a dry
 * run and everything the applier needs to execute it.
 */
export interface RunPlan {
  /** In execution order. Empty for a read-only workflow. */
  ops: WorkflowOp[]
  /**
   * Wire name to its contents, for the canvas edge labels and wire inspection.
   * Terminal statements contribute an entry keyed by `#<line>` so every edge in
   * the rendered graph has a count, including unnamed ones.
   */
  wires: Record<string, NoteSet>
  diagnostics: Diagnostic[]
  /** Subset of `ops` that cannot be rolled back; surfaced before applying. */
  irreversible: WorkflowOp[]
}

/* -------------------------------------------------------------------------- */
/*  The vault seam                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read-only view of the vault, supplied by the caller.
 *
 * This is the ONLY way the engine reaches notes. Keeping it read-only is what
 * structurally guarantees that planning cannot mutate anything: there is no
 * write method to call. The desktop passes an adapter over the note cache, the
 * server passes one over its own index, and tests pass a literal array.
 */
export interface VaultReader {
  /** Every note the workflow could see. Sources filter down from here. */
  listNotes(): Promise<WorkflowNote[]>
  /** Full text of one note, for content filters. */
  readBody(path: string): Promise<string>
  /** Notes explicitly selected in the UI, for the `selection` source. */
  selection?: () => WorkflowNote[]
  /** The active note, for the `current` source. */
  current?: () => WorkflowNote | null
}

/** Resolves a `call` step to another workflow. Returns null when unknown. */
export type WorkflowResolver = (id: string) => Workflow | null

export interface PlanContext {
  reader: VaultReader
  /** Absent means `call` steps report an error rather than silently no-oping. */
  resolve?: WorkflowResolver
  /** Resolved on-disk directory names for remapped system folders (vault.json
   *  `systemFolderPaths`). Absent or empty means the defaults (`archive/`,
   *  `trash/`, …). The `archive`/`trash` steps use this to project and file
   *  notes into the folder the app actually treats as archive/trash. */
  systemFolderDirs?: Partial<Record<'inbox' | 'quick' | 'archive' | 'trash', string>>
  /** Fixed clock so `since 7d` and `{{date}}` are deterministic in tests. */
  now: number
  /**
   * Guards the dynamic half of the cycle problem. A workflow calling another
   * is checked statically (see `validate`), but a resolver that changes between
   * calls, or a deeply nested chain, still needs a runtime ceiling.
   */
  maxDepth?: number
  maxOps?: number
}

export const DEFAULT_MAX_DEPTH = 8
export const DEFAULT_MAX_OPS = 5000
