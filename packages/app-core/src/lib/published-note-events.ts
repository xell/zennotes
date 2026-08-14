export interface PublishedNoteChange {
  notePath: string
  url: string | null
}

const listeners = new Set<(change: PublishedNoteChange) => void>()

export function notifyPublishedNoteChanged(change: PublishedNoteChange): void {
  for (const listener of listeners) listener(change)
}

export function subscribePublishedNoteChanges(
  listener: (change: PublishedNoteChange) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
