// Sharing a workflow: what leaves the vault, and what is allowed back in.
//
// A workflow is a plain `.md` file, which is the entire reason this feature is
// small. Export is the file, byte for byte: no bundle, no archive, no JSON
// envelope, nothing that would need a second reader. Anything that can hold
// text (a gist, a chat message, a repo) is already a distribution channel.
//
// IMPORT is the half that needs care, and everything below exists for it. A
// workflow is executable automation over someone's notes: a file pasted from a
// forum can archive, move, retag or overwrite hundreds of files the moment it
// runs. So an import is never an install. It is a REVIEW, and the review is
// computed here, before a single byte is written:
//
//   1. It has to parse. A file that does not is refused with its diagnostics
//      rather than imported broken for the author to discover later.
//   2. It has to validate. Errors block; warnings are shown and allowed,
//      because a warning is a smell and this file is not ours to perfect.
//   3. What it WRITES is spelled out in advance, derived from the registry's
//      own `mutating` flag and each step's arguments. Deriving it is the point:
//      a hand-kept list of "dangerous steps" would go stale the first time a
//      node was added, and it would go stale silently, in the one dialog whose
//      whole job is to be true.
//   4. It arrives as `trigger: manual`, whatever the file asked for. An
//      imported file may not install itself as something that fires on its own,
//      and the change is REPORTED rather than made quietly, so a file that
//      wanted a schedule says so in the review.
//   5. A `key:` that another workflow already uses is dropped. Two workflows
//      sharing one shortcut is a bug someone loses an hour to.
//
// Nothing here writes, reads the vault, or runs anything: the review is a pure
// function of the text plus what the vault already contains. That is what lets
// the same logic serve the paste path, the file path, and (later) a preset
// gallery fed from a community index, with one set of tests behind all three.

import { NODE_DEFS, nodeDef, unquote } from './nodes'
import type { NodeDef, ParamSpec } from './nodes'
import { parseWorkflow } from './parse'
import { serializeTrigger, serializeWorkflow } from './serialize'
import { validateWorkflow } from './validate'
import type { ArgValue, Diagnostic, Workflow } from './types'

/* -------------------------------------------------------------------------- */
/*  Export                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The filename a workflow should be offered under when it is saved somewhere
 * outside the vault.
 *
 * The stem is the workflow id, because that is what an import reads back as the
 * workflow's identity when the file's frontmatter carries no name of its own.
 */
export function workflowExportFilename(id: string): string {
  const stem = id.replace(/\.md$/i, '').replace(/[/\\:]+/g, '-').trim()
  return `${stem || 'workflow'}.md`
}

/* -------------------------------------------------------------------------- */
/*  What a workflow writes                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One kind of change a workflow would make, in the words the registry uses for
 * it.
 *
 * `title` and `irreversible` come straight from the `NodeDef`, and `detail`
 * from the step's own arguments, so a new mutating node is described correctly
 * the day it is added and no second vocabulary can drift away from the first.
 */
export interface WorkflowWrite {
  /** Registry kind, e.g. `add-tag`. */
  kind: string
  /** The node's own title, e.g. `Add tag`. */
  title: string
  /** Its arguments as written, e.g. `#someday`. Empty when it takes none. */
  detail: string
  /** Nothing to roll back afterwards (notify, clipboard). */
  irreversible: boolean
  /** How many steps in the file do exactly this. */
  count: number
}

/** Params rendered inside quotes, matching how the file writes them. */
const QUOTED_TYPES: ReadonlySet<ParamSpec['type']> = new Set<ParamSpec['type']>([
  'path',
  'heading',
  'template'
])

function formatArg(spec: ParamSpec, value: ArgValue | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  if (text === '') return ''
  // Tags are stored without their `#`; every surface that shows one puts it back.
  if (spec.type === 'tag') return `#${text}`
  if (QUOTED_TYPES.has(spec.type)) return `"${unquote(text)}"`
  return text
}

function writeDetail(def: NodeDef, args: Record<string, ArgValue>): string {
  return def.params
    .map((spec) => formatArg(spec, args[spec.name]))
    .filter((part) => part !== '')
    .join(' ')
}

/**
 * Every change a workflow would make to the vault, grouped, in file order.
 *
 * Derived from `NODE_DEFS.mutating` rather than from a list kept beside it:
 * "which steps write" is a property of the registry, and asking the registry is
 * the only way this stays true as the registry grows. An unrecognized step
 * (written by a newer version) cannot be described, so it is reported as
 * exactly that rather than assumed harmless.
 */
export function summarizeWorkflowWrites(workflow: Workflow): WorkflowWrite[] {
  // File order, with repeats folded into a count: three statements that all add
  // the same tag are one fact about the workflow, not three.
  const writes: WorkflowWrite[] = []
  const seen = new Map<string, WorkflowWrite>()

  for (const statement of workflow.statements) {
    for (const step of statement.steps) {
      const def = nodeDef(step.kind)
      const write: Omit<WorkflowWrite, 'count'> | null =
        def === null
          ? {
              // A verb this version has no definition for could do anything, so
              // it counts as a write. Refusing to guess is the safe direction:
              // a workflow containing one is rejected by `validate` anyway, and
              // callers reading this summary on its own get "not provably
              // read-only" rather than a false reassurance.
              kind: step.kind,
              title: 'Step this version does not recognize',
              detail: step.kind,
              irreversible: false
            }
          : def.mutating
            ? {
                kind: def.kind,
                title: def.title,
                detail: writeDetail(def, step.args),
                irreversible: def.irreversible === true
              }
            : null
      if (write === null) continue
      const key = JSON.stringify([write.kind, write.detail])
      const existing = seen.get(key)
      if (existing) {
        existing.count += 1
        continue
      }
      const entry: WorkflowWrite = { ...write, count: 1 }
      seen.set(key, entry)
      writes.push(entry)
    }
  }

  return writes
}

/** True when running this workflow would change nothing on disk. */
export function workflowIsReadOnly(workflow: Workflow): boolean {
  return summarizeWorkflowWrites(workflow).length === 0
}

/* -------------------------------------------------------------------------- */
/*  Import review                                                             */
/* -------------------------------------------------------------------------- */

/** Why an imported file's trigger is not the one it asked for. */
export interface TriggerChange {
  /** The trigger as the file declared it, e.g. `schedule 0 9 * * *`. */
  declared: string
}

export interface WorkflowImportRequest {
  /** The file exactly as it arrived, from a clipboard or from disk. */
  raw: string
  /**
   * Filename stem the workflow would land under, which is also its id. The
   * caller resolves collisions before asking, because only it knows what the
   * vault already holds.
   */
  id: string
  /** Final name, when a collision forced a suffix. Defaults to the file's own. */
  name?: string
  /**
   * The rest of the vault's workflows, for the cross-file checks (an unknown
   * `call` target, a circular call). Omitted when there is nothing to check
   * against.
   */
  others?: Map<string, Workflow>
  /** Keybindings other workflows already use, e.g. `<leader>wr`. */
  takenKeys?: Iterable<string>
}

export interface WorkflowImportReview {
  /** May this be written? False whenever anything failed to parse or validate. */
  ok: boolean
  /** The workflow as it WOULD be stored: trigger manual, colliding key removed. */
  workflow: Workflow
  /** Its name and description, for the sentence at the top of the dialog. */
  name: string
  description: string
  /** Every change it would make, grouped. Empty for a read-only workflow. */
  writes: WorkflowWrite[]
  /** True when it writes nothing at all, which is a much smaller decision. */
  readOnly: boolean
  /** Parse and validate diagnostics, merged, worst first per line. */
  diagnostics: Diagnostic[]
  errors: number
  warnings: number
  /** Set when the file asked for a trigger other than manual. */
  triggerChanged: TriggerChange | null
  /**
   * Set when the file arrived claiming to be active. Reported for the same
   * reason the trigger change is: an import is forced to draft, and a forced
   * change the user cannot see is indistinguishable from a lie.
   */
  forcedDraft: boolean
  /** The `key:` that was dropped because another workflow already uses it. */
  keyRemoved: string | null
  /**
   * The exact bytes an accept would write. Null when the import is refused, so
   * there is no path on which a rejected file reaches disk.
   */
  text: string | null
}

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1 }

/** Merge two diagnostic lists the way the view does: by line, errors first. */
function mergeDiagnostics(a: readonly Diagnostic[], b: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>()
  const out: Diagnostic[] = []
  for (const diagnostic of [...a, ...b]) {
    const key = `${diagnostic.line}|${diagnostic.severity}|${diagnostic.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(diagnostic)
  }
  return out.sort(
    (x, y) => x.line - y.line || SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]
  )
}

/**
 * Review a workflow file someone wants to bring into their vault.
 *
 * Pure, and deliberately returns everything the dialog needs in one value: the
 * decision (`ok`), the explanation (`writes`, `diagnostics`, `triggerChanged`,
 * `keyRemoved`) and the bytes (`text`). A caller that renders the explanation
 * and then writes something else would be the one bug this whole review exists
 * to prevent, and there is nothing else here for it to write.
 */
export function reviewWorkflowImport(request: WorkflowImportRequest): WorkflowImportReview {
  const { workflow: parsed, diagnostics: parseDiagnostics } = parseWorkflow(request.raw, request.id)

  // The trigger, before it is taken away, so the review can say what the file
  // asked for. `parseWorkflow` already degrades an unrecognized trigger to
  // manual with a warning, so anything non-manual here was understood and is
  // being refused on purpose rather than for lack of support.
  const triggerChanged =
    parsed.trigger.type === 'manual' ? null : { declared: serializeTrigger(parsed.trigger) }

  const taken = new Set(request.takenKeys ?? [])
  const keyRemoved = parsed.key !== undefined && taken.has(parsed.key) ? parsed.key : null

  const workflow: Workflow = {
    ...parsed,
    name: request.name?.trim() || parsed.name,
    // Rule 5: an import may never arrive armed. Manual regardless of what the
    // file said, and the change is reported above rather than made silently.
    trigger: { type: 'manual' },
    // And never arrives able to act. A file with no `status:` line reads as
    // ACTIVE, so without this an imported workflow from a stranger would be
    // runnable the moment it landed, which is the opposite of what draft exists
    // for. Forced for the same reason as the trigger, and reported the same way.
    status: 'draft'
  }
  // Deleted rather than set to undefined, so a keyless workflow compares equal
  // to one parsed from its own serialization, which is what `parse` promises.
  if (keyRemoved !== null) delete workflow.key

  // Read off `parsed`, not `workflow`: the latter has already been forced to
  // draft, so it can no longer answer what the file asked for.
  const forcedDraft = parsed.status === 'active'
  // A `call` naming a workflow this vault does not have is a WARNING here, not
  // an error. Community workflows ship as sets, and the second half of a pair
  // legitimately names the first before you have it; blocking the file would
  // wall that off entirely. It lands as a draft, which cannot run, so an
  // unresolved call is something to fix rather than something to be protected
  // from. Everything else, including a circular call, still blocks.
  const validateDiagnostics = validateWorkflow(workflow, request.others, {
    unknownCall: 'warning'
  })
  const diagnostics = mergeDiagnostics(parseDiagnostics, validateDiagnostics)
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.length - errors
  const ok = errors === 0
  const writes = summarizeWorkflowWrites(workflow)

  return {
    ok,
    workflow,
    name: workflow.name,
    description: workflow.description,
    writes,
    readOnly: writes.length === 0,
    diagnostics,
    errors,
    warnings,
    triggerChanged,
    forcedDraft,
    keyRemoved,
    // Serialized rather than passed through, so what lands on disk is exactly
    // the workflow that was reviewed: the neutralized trigger and the dropped
    // key are in the bytes, not merely in the sentence above them.
    text: ok ? serializeWorkflow(workflow) : null
  }
}

/**
 * Every mutating step kind the registry knows, for tests and for anything that
 * wants to state the blast radius of the language itself.
 */
export function mutatingKinds(): string[] {
  return NODE_DEFS.filter((def) => def.mutating).map((def) => def.kind)
}
