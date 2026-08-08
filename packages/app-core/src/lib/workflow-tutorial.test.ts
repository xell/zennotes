import { describe, expect, it, vi } from 'vitest'
import { parseWorkflow } from '@shared/workflows/parse'
import { validateWorkflow } from '@shared/workflows/validate'
import { planWorkflow } from '@shared/workflows/engine'
import type { VaultReader, WorkflowNote } from '@shared/workflows/types'
import type { WorkflowFile } from '@bridge-contract/workflows'
import { extractTags } from './tags'
import {
  TUTORIAL_FOLDER,
  TUTORIAL_NOTES,
  TUTORIAL_STEPS,
  TUTORIAL_WORKFLOW_RAW,
  TUTORIAL_WORKFLOW_SLUG,
  cleanupWorkflowTutorial,
  seedWorkflowTutorial,
  type TutorialBridge
} from './workflow-tutorial'

// The tutorial teaches by example, so its example carries the same burden the
// gallery presets do: it must parse clean, validate clean, and actually DO
// something on the material it seeds. And because its whole safety story is
// "everything stays inside one folder", that claim is pinned here rather than
// trusted.

const NOW = Date.UTC(2026, 6, 28)

/** The seeds as the engine's reader would serve them, derived from the REAL
 *  seed text (real tag extractor, body served verbatim) so the fixture cannot
 *  drift from what the tutorial actually writes into a vault. */
function seededVault(): { reader: VaultReader } {
  const notes: WorkflowNote[] = TUTORIAL_NOTES.map(({ path, body }) => {
    const cut = path.lastIndexOf('/')
    return {
      path,
      title: path.slice(cut + 1).replace(/\.md$/, ''),
      folder: path.slice(0, cut),
      tags: extractTags(body),
      frontmatter: {},
      createdAt: NOW,
      updatedAt: NOW
    }
  })
  const bodies = new Map(TUTORIAL_NOTES.map(({ path, body }) => [path, body]))
  return {
    reader: {
      listNotes: async () => notes.map((note) => ({ ...note })),
      readBody: async (path) => bodies.get(path) ?? ''
    }
  }
}

describe('the tutorial workflow', () => {
  const parsed = parseWorkflow(TUTORIAL_WORKFLOW_RAW, TUTORIAL_WORKFLOW_SLUG)

  it('parses and validates with no diagnostics at all', () => {
    expect(parsed.diagnostics).toEqual([])
    expect(validateWorkflow(parsed.workflow)).toEqual([])
  })

  it('arrives as a draft, because activating it is a chapter', () => {
    expect(parsed.workflow.status).toBe('draft')
  })

  it('plans real changes on the seeded notes, and only inside its folder', async () => {
    const plan = await planWorkflow(parsed.workflow, { ...seededVault(), now: NOW })
    expect(plan.diagnostics).toEqual([])
    expect(plan.ops.length).toBeGreaterThan(0)
    for (const op of plan.ops) {
      if ('path' in op) expect(op.path.startsWith(`${TUTORIAL_FOLDER}/`)).toBe(true)
    }
  })

  it('keeps the edit-a-step chapter honest: lowering the threshold grows the wire', async () => {
    const twoOfThree = await planWorkflow(parsed.workflow, { ...seededVault(), now: NOW })
    expect(twoOfThree.wires.good).toHaveLength(2)

    const eased = parseWorkflow(
      TUTORIAL_WORKFLOW_RAW.replace('rating >= 4', 'rating >= 3'),
      TUTORIAL_WORKFLOW_SLUG
    )
    const threeOfThree = await planWorkflow(eased.workflow, { ...seededVault(), now: NOW })
    expect(threeOfThree.wires.good).toHaveLength(3)
  })
})

describe('the chapters', () => {
  it('every chapter has a title, an intro, and (except the last) detectable todos', () => {
    expect(TUTORIAL_STEPS.length).toBeGreaterThanOrEqual(8)
    TUTORIAL_STEPS.forEach((step, index) => {
      expect(step.title.length).toBeGreaterThan(0)
      expect(step.intro.length).toBeGreaterThan(0)
      if (index < TUTORIAL_STEPS.length - 1) expect(step.tasks.length).toBeGreaterThan(0)
      for (const task of step.tasks) {
        expect(task.text.length).toBeGreaterThan(0)
        // Every todo is observable: a row that cannot tick itself is prose,
        // and prose belongs in the intro.
        expect(task.doneWhen).toBeTruthy()
      }
    })
  })

  it('the detectable todos cover the whole loop, in teaching order', () => {
    const detected = TUTORIAL_STEPS.flatMap((step) => step.tasks.map((task) => task.doneWhen))
    expect(detected).toEqual([
      'select-tutorial',
      'node-inspected',
      'text-mode',
      'canvas-mode',
      'where-inspected',
      'threshold-eased',
      'workflow-active',
      'run-applied',
      'run-undone',
      'palette-opened'
    ])
  })

  it('contains no em dash anywhere', () => {
    const EM_DASH = '—'
    const text =
      TUTORIAL_STEPS.map(
        (step) => `${step.title}${step.intro}${step.tasks.map((task) => task.text).join('')}`
      ).join('') +
      TUTORIAL_WORKFLOW_RAW +
      TUTORIAL_NOTES.map((note) => note.body).join('')
    expect(text).not.toContain(EM_DASH)
  })
})

describe('seed and cleanup', () => {
  function fakeBridge(existingWorkflows: WorkflowFile[] = []): {
    bridge: TutorialBridge
    calls: Record<string, unknown[][]>
  } {
    const calls: Record<string, unknown[][]> = {}
    const record =
      (name: string, result?: unknown) =>
      (...args: unknown[]) => {
        ;(calls[name] ??= []).push(args)
        return Promise.resolve(result)
      }
    const bridge: TutorialBridge = {
      writeNote: record('writeNote', {}),
      createFolder: record('createFolder') as TutorialBridge['createFolder'],
      deleteFolder: record('deleteFolder') as TutorialBridge['deleteFolder'],
      listWorkflows: vi.fn().mockResolvedValue(existingWorkflows),
      writeWorkflow: record('writeWorkflow', {
        id: TUTORIAL_WORKFLOW_SLUG,
        sourcePath: `.zennotes/workflows/${TUTORIAL_WORKFLOW_SLUG}.md`,
        raw: TUTORIAL_WORKFLOW_RAW
      }) as TutorialBridge['writeWorkflow'],
      deleteWorkflow: record('deleteWorkflow') as TutorialBridge['deleteWorkflow'],
      deleteWorkflowRuns: record('deleteWorkflowRuns', 0) as TutorialBridge['deleteWorkflowRuns']
    }
    return { bridge, calls }
  }

  it('seed leads with cleanup, then creates the folder, the notes, the workflow', async () => {
    const { bridge, calls } = fakeBridge()
    await seedWorkflowTutorial(bridge)

    expect(calls.deleteFolder).toHaveLength(1)
    expect(calls.createFolder?.[0]).toEqual(['inbox', 'Workflow tutorial'])
    expect(calls.writeNote?.map((args) => args[0])).toEqual(TUTORIAL_NOTES.map((n) => n.path))
    expect(calls.writeWorkflow?.[0]?.[0]).toMatchObject({ slug: TUTORIAL_WORKFLOW_SLUG })
  })

  it('cleanup removes the workflow, its runs, and the whole folder', async () => {
    const tutorialFile = {
      id: TUTORIAL_WORKFLOW_SLUG,
      sourcePath: `.zennotes/workflows/${TUTORIAL_WORKFLOW_SLUG}.md`,
      raw: TUTORIAL_WORKFLOW_RAW
    } as WorkflowFile
    const { bridge, calls } = fakeBridge([tutorialFile])
    await cleanupWorkflowTutorial(bridge)

    expect(calls.deleteWorkflow?.[0]).toEqual([tutorialFile.sourcePath])
    expect(calls.deleteWorkflowRuns?.[0]).toEqual([TUTORIAL_WORKFLOW_SLUG])
    expect(calls.deleteFolder?.[0]).toEqual(['inbox', 'Workflow tutorial'])
  })

  it('cleanup of a clean vault is a quiet no-op, and never touches other workflows', async () => {
    const other = {
      id: 'reading-log',
      sourcePath: '.zennotes/workflows/reading-log.md',
      raw: ''
    } as WorkflowFile
    const { bridge, calls } = fakeBridge([other])
    await cleanupWorkflowTutorial(bridge)

    expect(calls.deleteWorkflow).toBeUndefined()
    expect(calls.deleteFolder).toHaveLength(1)
  })

  it('survives a bridge without deleteWorkflowRuns (the web shape)', async () => {
    const { bridge } = fakeBridge()
    delete (bridge as Partial<TutorialBridge>).deleteWorkflowRuns
    await expect(cleanupWorkflowTutorial(bridge)).resolves.toBeUndefined()
  })
})
