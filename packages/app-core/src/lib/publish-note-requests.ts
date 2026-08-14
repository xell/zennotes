import type { PublishableCloudNote } from './cloud-publishing'

export interface PublishNoteRequest {
  note: PublishableCloudNote
}

let currentRequest: PublishNoteRequest | null = null
const listeners = new Set<(request: PublishNoteRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getPublishNoteRequest(): PublishNoteRequest | null {
  return currentRequest
}

export function subscribePublishNoteRequests(
  listener: (request: PublishNoteRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function requestPublishNote(note: PublishableCloudNote): void {
  currentRequest = { note }
  emit()
}

export function dismissPublishNoteRequest(request: PublishNoteRequest): void {
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
}
