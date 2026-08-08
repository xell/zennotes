import { lazy, Suspense } from 'react'

// WorkflowsView drags in React Flow (plus its stylesheet and its own zustand),
// none of which belongs anywhere near the boot path for a feature that ships
// off by default. Same seam as LazyPreview: the chunk is fetched the first
// time a Workflows tab actually renders. The vite configs deliberately have NO
// manualChunks rule for @xyflow, for the reason documented on the mermaid
// comment there: naming a chunk for dynamic-only code is what hoists it back
// into the entry's static graph.
const WorkflowsViewImpl = lazy(() =>
  import('./WorkflowsView').then((mod) => ({ default: mod.WorkflowsView }))
)

export function LazyWorkflowsView(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <WorkflowsViewImpl />
    </Suspense>
  )
}
