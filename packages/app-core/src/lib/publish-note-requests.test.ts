import { describe, expect, it, vi } from 'vitest'
import {
  dismissPublishNoteRequest,
  getPublishNoteRequest,
  requestPublishNote,
  subscribePublishNoteRequests
} from './publish-note-requests'

describe('publish note requests', () => {
  it('opens and dismisses the shared publishing dialog request', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePublishNoteRequests(listener)
    const note = {
      path: 'Notes/Launch.md',
      title: 'Launch',
      body: '# Launch',
      assetEmbeds: []
    }

    requestPublishNote(note)
    const request = getPublishNoteRequest()

    expect(request).toEqual({ note })
    expect(listener).toHaveBeenLastCalledWith(request)

    dismissPublishNoteRequest(request!)

    expect(getPublishNoteRequest()).toBeNull()
    expect(listener).toHaveBeenLastCalledWith(null)
    unsubscribe()
  })
})
