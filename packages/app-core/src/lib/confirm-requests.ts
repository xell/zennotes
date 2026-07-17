import type { ConfirmOptions } from '../components/ConfirmModal'

/** Tri-state result: the primary action, the optional middle action, or a
 *  cancel/dismiss. Boolean callers via `confirmApp` see 'confirm' as true. */
export type ConfirmChoice = 'confirm' | 'alt' | 'cancel'

export type ConfirmRequest = {
  options: ConfirmOptions
  resolve: (value: ConfirmChoice) => void
}

let currentRequest: ConfirmRequest | null = null
const listeners = new Set<(request: ConfirmRequest | null) => void>()

function emit(): void {
  for (const listener of listeners) listener(currentRequest)
}

export function getConfirmRequest(): ConfirmRequest | null {
  return currentRequest
}

export function subscribeConfirmRequests(
  listener: (request: ConfirmRequest | null) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Full tri-state variant. Use when the dialog has an `altLabel` (three
 *  choices, e.g. Save / Discard / Cancel). */
export function confirmAppChoice(options: ConfirmOptions): Promise<ConfirmChoice> {
  return new Promise((resolve) => {
    currentRequest = { options, resolve }
    emit()
  })
}

/** Boolean convenience: resolves true only for the primary action. */
export function confirmApp(options: ConfirmOptions): Promise<boolean> {
  return confirmAppChoice(options).then((choice) => choice === 'confirm')
}

export function settleConfirmRequest(request: ConfirmRequest, value: ConfirmChoice): void {
  const resolve = request.resolve
  if (currentRequest === request) {
    currentRequest = null
    emit()
  }
  queueMicrotask(() => resolve(value))
}
