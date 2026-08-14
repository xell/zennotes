import { lazy, Suspense, useEffect, useState } from 'react'
import {
  dismissPublishNoteRequest,
  getPublishNoteRequest,
  subscribePublishNoteRequests,
  type PublishNoteRequest
} from '../lib/publish-note-requests'

const PublishNoteModal = lazy(async () => {
  const module = await import('./PublishNoteModal')
  return { default: module.PublishNoteModal }
})

export function PublishNoteHost(): JSX.Element | null {
  const [request, setRequest] = useState<PublishNoteRequest | null>(getPublishNoteRequest)

  useEffect(() => subscribePublishNoteRequests(setRequest), [])

  if (!request) return null

  return (
    <Suspense fallback={null}>
      <PublishNoteModal
        note={request.note}
        onClose={() => dismissPublishNoteRequest(request)}
      />
    </Suspense>
  )
}
