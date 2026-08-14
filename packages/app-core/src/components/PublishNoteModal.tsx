import { useEffect, useState } from 'react'
import { getZenBridge, type ZenBridge } from '@zennotes/bridge-contract/bridge'
import type { CloudPublishedNote } from '@zennotes/bridge-contract/cloud-sync'
import { publishCloudNoteWithFeedback, type PublishableCloudNote } from '../lib/cloud-publishing'
import { notifyPublishedNoteChanged } from '../lib/published-note-events'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

export function PublishNoteModal({
  note,
  onClose,
  bridge = getZenBridge()
}: {
  note: PublishableCloudNote
  onClose: () => void
  bridge?: ZenBridge
}): JSX.Element {
  const [existing, setExisting] = useState<CloudPublishedNote | null>(null)
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    void bridge.listCloudPublishedNotes()
      .then((notes) => {
        if (cancelled) return
        const published = notes.find((candidate) => candidate.note_path === note.path) ?? null
        setExisting(published)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load publishing settings.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [bridge, note.path])

  const publish = async (): Promise<void> => {
    setPublishing(true)
    setError(null)

    try {
      const outcome = await publishCloudNoteWithFeedback(note, bridge)
      notifyPublishedNoteChanged({ notePath: note.path, url: outcome.url })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not publish this note.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Modal size="md" layer="modal" align="center" onClose={onClose}>
      <Modal.Header
        title={existing ? 'Update public note' : 'Publish note'}
        description={existing
          ? 'Update the public copy with the latest content from this note.'
          : 'Add this note to your public publication. Its link stays the same when you update it.'}
      />
      <Modal.Body className="space-y-3">
        <p className="text-sm leading-6 text-ink-500">
          Theme and logo are managed for your full publication in ZenNotes Cloud.
        </p>
        {error && (
          <div role="alert" className="rounded-lg border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" disabled={publishing} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={loading || publishing} onClick={() => void publish()}>
          {publishing ? 'Publishing…' : existing ? 'Update note' : 'Publish note'}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
