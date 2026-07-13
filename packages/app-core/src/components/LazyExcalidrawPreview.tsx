import { lazy, Suspense } from 'react'
import type { ExcalidrawPreviewProps } from './ExcalidrawPreview'

const ExcalidrawPreviewImpl = lazy(() =>
  import('./ExcalidrawPreview').then((mod) => ({ default: mod.ExcalidrawPreview }))
)

/**
 * Lazy boundary for the Excalidraw preview image. Keeps the Excalidraw export
 * bundle (pulled in dynamically by excalidraw-preview.ts) out of the main
 * editor/preview chunks until a drawing embed is actually shown.
 */
export function LazyExcalidrawPreview({
  path,
  width,
  height,
  className,
  onClick
}: ExcalidrawPreviewProps): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ExcalidrawPreviewImpl
        path={path}
        width={width}
        height={height}
        className={className}
        onClick={onClick}
      />
    </Suspense>
  )
}
