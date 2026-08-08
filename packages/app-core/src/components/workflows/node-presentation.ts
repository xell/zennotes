// How a step kind is presented, wherever it is presented.
//
// The canvas, the step picker and the syntax reference all draw the same
// registry (`NODE_DEFS`) and all three need the same three answers: what is this
// category called, what is it FOR, and which chip colour marks it. Kept in one
// module because the picker and the canvas now sit in different files: a second
// copy of `CATEGORY_TITLE` would drift the first time a category is added, and
// the two surfaces would disagree about what a node is while showing it side by
// side.

import type { NodeCategory } from '@shared/workflows/nodes'

/**
 * The order a person builds a pipeline in: open it, narrow it, order it,
 * combine it, change it, render it, send it. `compose` sits last because
 * calling another workflow is a different move from writing this one.
 *
 * Declared here rather than derived from `NODE_DEFS` so the picker's groups do
 * not silently reshuffle when a node is inserted in a different place in the
 * registry.
 */
export const CATEGORY_ORDER: readonly NodeCategory[] = [
  'source',
  'filter',
  'order',
  'shape',
  'mutate',
  'render',
  'sink',
  'compose'
]

/** Human name for a category of steps, for headings. */
export const CATEGORY_TITLE: Record<NodeCategory, string> = {
  source: 'Sources',
  filter: 'Filters',
  order: 'Order',
  shape: 'Combine wires',
  mutate: 'Change notes',
  render: 'Render',
  sink: 'Send somewhere',
  compose: 'Compose'
}

/** What a whole category is FOR, which no single step's title can say. */
export const CATEGORY_BLURB: Record<NodeCategory, string> = {
  source: 'Open a pipeline. A line starts with one of these, or with the name of a wire.',
  filter: 'Narrow the notes on the wire.',
  order: 'Reorder or trim the set. The order carries on down the pipeline.',
  shape: 'Fold another wire into this one, by name.',
  mutate: 'Plan a change to every note on the wire. Nothing is written until you run it.',
  render: 'Turn the set into text for the step that follows.',
  sink: 'End the line by putting the text somewhere.',
  compose: 'Hand this wire to another workflow.'
}

/**
 * `unknown` is a step kind the registry does not have, not a real category. It
 * reads as an error because that is what it is: a verb this version cannot run.
 */
export const CATEGORY_CHIP: Record<NodeCategory | 'unknown', string> = {
  source: 'bg-accent/15 text-accent',
  filter: 'bg-paper-300/70 text-ink-600',
  order: 'bg-paper-300/70 text-ink-600',
  shape: 'bg-paper-300/70 text-ink-600',
  mutate: 'bg-warning/20 text-warning',
  render: 'bg-success/15 text-success',
  sink: 'bg-danger/15 text-danger',
  compose: 'bg-accent/10 text-accent',
  unknown: 'bg-danger/15 text-danger'
}
