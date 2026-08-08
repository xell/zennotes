import { describe, expect, it } from 'vitest'
import {
  PRESET_CATEGORIES,
  WORKFLOW_PRESETS,
  hiddenPresetsInOrder,
  presetById,
  presetsByCategory,
  visiblePresetsByCategory
} from './presets'
import type { PresetCategory, WorkflowPreset } from './presets'
import { parseWorkflow } from './parse'
import { serializeWorkflow } from './serialize'
import { validateWorkflow } from './validate'
import { planWorkflow } from './engine'
import { nodeDef, stepIsMutating } from './nodes'
import type { NodeCategory } from './nodes'
import type { Diagnostic, VaultReader, WorkflowNote } from './types'

// The presets are shipped as the answer to "how do I know what to write here?",
// so their correctness is not a nice-to-have: a preset that does not parse
// teaches the syntax wrong and makes the editor look broken on a first run.
// Every assertion below exists to stop that shipping.

const parsed = (preset: WorkflowPreset) => parseWorkflow(preset.raw, preset.id)

const errorsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'error')

const warningsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((d) => d.severity === 'warning')

/** `${line}: ${message}`, so a failure names the offending line of the preset. */
const describeAll = (diagnostics: Diagnostic[]): string[] =>
  diagnostics.map((d) => `${d.line}: ${d.message}`)

describe('WORKFLOW_PRESETS: every preset is a working workflow', () => {
  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s parses with no errors',
    (_id, preset) => {
      const { diagnostics } = parsed(preset)
      expect(describeAll(errorsOf(diagnostics))).toEqual([])
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s parses with no warnings either',
    (_id, preset) => {
      // The contract only demands zero errors, but a preset is also the tutorial:
      // a warning in the gallery would teach that warnings are normal. Held at
      // zero on purpose, and this is the assertion to relax (never the error one)
      // if a future node warns for a good reason.
      const { diagnostics } = parsed(preset)
      expect(describeAll(warningsOf(diagnostics))).toEqual([])
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s validates with no errors',
    (_id, preset) => {
      // No `others` map: a preset is validated in isolation because it is
      // installed into a vault whose other workflows we cannot know.
      const diagnostics = validateWorkflow(parsed(preset).workflow)
      expect(describeAll(errorsOf(diagnostics))).toEqual([])
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s validates with no warnings either',
    (_id, preset) => {
      const diagnostics = validateWorkflow(parsed(preset).workflow)
      expect(describeAll(warningsOf(diagnostics))).toEqual([])
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s keeps its meaning through a canvas save',
    (_id, preset) => {
      // The canvas rewrites the file from the graph. Alignment padding is
      // dropped by design, so the invariant that matters is semantic: what the
      // workflow MEANS must survive, or opening a preset on the canvas and
      // saving would quietly change what it does.
      const first = parsed(preset).workflow
      const again = parseWorkflow(serializeWorkflow(first), preset.id).workflow
      expect(again).toEqual(first)
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s keeps its explanation through a canvas save',
    (_id, preset) => {
      // The comment IS the tutorial, so losing it on the first save would undo
      // the point of the gallery.
      const commentLines = preset.raw
        .split('\n')
        .filter((line) => line.startsWith('#'))
      expect(commentLines.length).toBeGreaterThan(0)
      const saved = serializeWorkflow(parsed(preset).workflow)
      for (const line of commentLines) expect(saved).toContain(line)
    }
  )
})

/* -------------------------------------------------------------------------- */
/*  A vault the presets were written for                                      */
/* -------------------------------------------------------------------------- */

// Parsing and validating prove a preset is well formed. They do not prove it
// DOES anything: `where rating >= 4` against a vault where nothing has a rating
// is valid, runs, and plans nothing, which to a first-time user is
// indistinguishable from a broken feature. So the presets are also run against
// a small vault shaped the way their comments describe.

const DAY = 86_400_000
/** Fixed clock, so `since 7d` means the same thing on every machine. */
const NOW = Date.UTC(2026, 6, 28)

const note = (path: string, over: Partial<WorkflowNote> = {}): WorkflowNote => {
  const cut = path.lastIndexOf('/')
  return {
    path,
    title: path.slice(cut + 1).replace(/\.md$/, ''),
    folder: cut === -1 ? '' : path.slice(0, cut),
    tags: [],
    frontmatter: {},
    createdAt: NOW - 60 * DAY,
    updatedAt: NOW - 40 * DAY,
    ...over
  }
}

const VAULT: readonly WorkflowNote[] = [
  note('inbox/Dune.md', { tags: ['book'], frontmatter: { rating: '5', finished: '2026-01-02' } }),
  note('inbox/Sapiens.md', { tags: ['book'], frontmatter: { rating: '2' } }),
  note('inbox/Loose thought.md'),
  note('inbox/This week.md', { updatedAt: NOW - 2 * DAY }),
  note('inbox/projects/Compiler.md', { tags: ['project'], frontmatter: { status: 'done' } }),
  note('inbox/Standup.md', { tags: ['meeting'], frontmatter: { date: '2026-07-20' } }),
  note('inbox/Chores.md', { tags: ['todo'] }),
  note('inbox/Home.md', { tags: ['area'] })
]

const BODIES: Record<string, string> = {
  'inbox/Loose thought.md': 'TODO call the bank about the mortgage\n'
}

const reader: VaultReader = {
  listNotes: async () => VAULT.map((entry) => ({ ...entry })),
  readBody: async (path) => BODIES[path] ?? ''
}

describe('WORKFLOW_PRESETS: they do something on a vault they fit', () => {
  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s runs without a single diagnostic',
    async (_id, preset) => {
      const plan = await planWorkflow(parsed(preset).workflow, { reader, now: NOW })
      expect(describeAll(plan.diagnostics)).toEqual([])
    }
  )

  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s plans at least one change',
    async (_id, preset) => {
      const plan = await planWorkflow(parsed(preset).workflow, { reader, now: NOW })
      expect(plan.ops.length).toBeGreaterThan(0)
    }
  )

  it('plans nothing that cannot be undone, so a first run is always reversible', async () => {
    for (const preset of WORKFLOW_PRESETS) {
      const plan = await planWorkflow(parsed(preset).workflow, { reader, now: NOW })
      expect(plan.irreversible).toEqual([])
    }
  })

  it('reads the reading log the way its comment says it does', async () => {
    // One preset checked end to end rather than by op count, because "it planned
    // something" would still pass if the two wires were swapped.
    const preset = presetById('reading-log')
    if (!preset) throw new Error('reading-log is missing from the gallery')
    const plan = await planWorkflow(parsed(preset).workflow, { reader, now: NOW })
    expect(plan.wires.good.map((entry) => entry.title)).toEqual(['Dune'])
    expect(plan.wires.someday.map((entry) => entry.title)).toEqual(['Sapiens'])
    expect(plan.ops).toContainEqual({ kind: 'add-tag', path: 'inbox/Sapiens.md', tag: 'someday' })
    const written = plan.ops.find((op) => op.kind === 'write-section')
    expect(written && written.kind === 'write-section' && written.text).toContain('| Dune | 5 |')
  })
})

describe('WORKFLOW_PRESETS: the mutating flag is honest', () => {
  it.each(WORKFLOW_PRESETS.map((preset) => [preset.id, preset] as const))(
    '%s agrees with the node registry',
    (_id, preset) => {
      const { workflow } = parsed(preset)
      const mutates = workflow.statements.some((statement) =>
        statement.steps.some((step) => stepIsMutating(step.kind))
      )
      expect(preset.mutating).toBe(mutates)
    }
  )

  it('every preset writes, because every sink in the registry writes', () => {
    // Documenting the state of the world rather than wishing about it: if a
    // read-only sink is ever added, this flips and the gallery gains a genuinely
    // "safe to try" tier.
    expect(WORKFLOW_PRESETS.every((preset) => preset.mutating)).toBe(true)
  })
})

describe('WORKFLOW_PRESETS: the set is a tour of the language', () => {
  const categoriesUsed = (): Set<NodeCategory> => {
    const used = new Set<NodeCategory>()
    for (const preset of WORKFLOW_PRESETS) {
      for (const statement of parsed(preset).workflow.statements) {
        for (const step of statement.steps) {
          const def = nodeDef(step.kind)
          if (def) used.add(def.category)
        }
      }
    }
    return used
  }

  // `compose` (the `call` node) is deliberately absent: a preset containing
  // `call` would name a workflow that does not exist in the user's vault, so it
  // would light up an error the moment they validated it. The other seven are
  // everything a self-contained workflow can use.
  const REQUIRED: readonly NodeCategory[] = [
    'source',
    'filter',
    'order',
    'shape',
    'mutate',
    'render',
    'sink'
  ]

  it.each(REQUIRED)('demonstrates the %s category', (category) => {
    expect([...categoriesUsed()]).toContain(category)
  })

  it('does not reach for `call`, which needs a workflow the vault may not have', () => {
    expect([...categoriesUsed()]).not.toContain('compose')
  })

  it('uses more than one node from the categories that have several', () => {
    // A tour that used `tag` six times would teach one source, not six. This is
    // a floor on variety, not a demand that every node appear.
    const kinds = new Set<string>()
    for (const preset of WORKFLOW_PRESETS) {
      for (const statement of parsed(preset).workflow.statements) {
        for (const step of statement.steps) kinds.add(step.kind)
      }
    }
    expect(kinds.size).toBeGreaterThanOrEqual(14)
  })
})

describe('WORKFLOW_PRESETS: gallery metadata', () => {
  it('ships eight presets with unique ids', () => {
    expect(WORKFLOW_PRESETS).toHaveLength(8)
    expect(new Set(WORKFLOW_PRESETS.map((preset) => preset.id)).size).toBe(8)
  })

  it('uses ids that are safe as filename stems, since the stem becomes the id', () => {
    for (const preset of WORKFLOW_PRESETS) expect(preset.id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('gives every preset a one-line description and a rationale', () => {
    for (const preset of WORKFLOW_PRESETS) {
      expect(preset.name.trim()).not.toBe('')
      expect(preset.description.trim()).not.toBe('')
      expect(preset.description).not.toContain('\n')
      expect(preset.rationale.trim()).not.toBe('')
      expect(preset.rationale).not.toContain('\n')
    }
  })

  it('fills every category tab in the gallery', () => {
    for (const category of PRESET_CATEGORIES) {
      expect(presetsByCategory(category).length).toBeGreaterThan(0)
    }
  })

  it('only uses categories the gallery knows how to show', () => {
    const known = new Set<PresetCategory>(PRESET_CATEGORIES)
    for (const preset of WORKFLOW_PRESETS) expect(known.has(preset.category)).toBe(true)
  })

  it('opens every workflow with a comment, because the preset is the tutorial', () => {
    for (const preset of WORKFLOW_PRESETS) {
      const body = preset.raw.split(/^---$/m)[2] ?? ''
      const firstLine = body.split('\n').find((line) => line.trim() !== '')
      expect(firstLine?.startsWith('#')).toBe(true)
    }
  })

  it('names itself the same way in the gallery and in the frontmatter', () => {
    for (const preset of WORKFLOW_PRESETS) {
      expect(parsed(preset).workflow.name).toBe(preset.name)
    }
  })

  it('gives each preset its own keybinding so installing two never collides', () => {
    const keys = WORKFLOW_PRESETS.map((preset) => parsed(preset).workflow.key)
    expect(keys.every((key) => typeof key === 'string' && key !== '')).toBe(true)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('triggers manually, so nothing a user installs starts writing on its own', () => {
    for (const preset of WORKFLOW_PRESETS) {
      expect(parsed(preset).workflow.trigger).toEqual({ type: 'manual' })
    }
  })

  it('avoids the em dash, which this repo does not use anywhere', () => {
    // Written as an escape rather than the character itself, so this file does
    // not become the one place in the repo that contains one.
    const EM_DASH = '\u2014'
    for (const preset of WORKFLOW_PRESETS) {
      const text = `${preset.name}${preset.description}${preset.rationale}${preset.raw}`
      expect(text).not.toContain(EM_DASH)
    }
  })
})

describe('presetById', () => {
  it('finds every shipped preset', () => {
    for (const preset of WORKFLOW_PRESETS) expect(presetById(preset.id)).toBe(preset)
  })

  it('returns null for an id that is not in the gallery', () => {
    expect(presetById('nope')).toBeNull()
    expect(presetById('')).toBeNull()
  })
})

describe('hiding presets from the gallery', () => {
  it('a hidden preset leaves its category and appears in the hidden list', () => {
    const first = WORKFLOW_PRESETS[0]
    const visible = visiblePresetsByCategory(first.category, [first.id])
    expect(visible.map((preset) => preset.id)).not.toContain(first.id)
    expect(visible).toHaveLength(presetsByCategory(first.category).length - 1)
    expect(hiddenPresetsInOrder([first.id]).map((preset) => preset.id)).toEqual([first.id])
  })

  it('hiding everything empties every category', () => {
    const all = WORKFLOW_PRESETS.map((preset) => preset.id)
    for (const category of PRESET_CATEGORIES) {
      expect(visiblePresetsByCategory(category, all)).toEqual([])
    }
    expect(hiddenPresetsInOrder(all)).toHaveLength(WORKFLOW_PRESETS.length)
  })

  it('unknown ids are ignored, not pruned and not shown', () => {
    for (const category of PRESET_CATEGORIES) {
      expect(visiblePresetsByCategory(category, ['not-a-preset'])).toEqual(
        presetsByCategory(category)
      )
    }
    expect(hiddenPresetsInOrder(['not-a-preset'])).toEqual([])
  })

  it('the hidden list reads in gallery order, not hide order', () => {
    // Hide the last preset first and the first preset second: the group must
    // come back in canonical order regardless.
    const first = WORKFLOW_PRESETS[0]
    const last = WORKFLOW_PRESETS[WORKFLOW_PRESETS.length - 1]
    const ordered = hiddenPresetsInOrder([last.id, first.id]).map((preset) => preset.id)
    expect(ordered).toEqual(
      PRESET_CATEGORIES.flatMap((category) => presetsByCategory(category))
        .filter((preset) => preset.id === first.id || preset.id === last.id)
        .map((preset) => preset.id)
    )
  })
})
