import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  type: ToastType
  action?: ToastAction
}

interface ToastStore {
  toasts: Toast[]
  addToast: (message: string, type?: ToastType, action?: ToastAction) => void
  removeToast: (id: string) => void
}

function nextToastId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

const AUTO_DISMISS_MS = 4000

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  addToast: (message, type = 'info', action?: ToastAction) => {
    const id = nextToastId()
    set((s) => ({ toasts: [...s.toasts, { id, message, type, action }] }))
    // Errors replace a blocking alert, so they stay until dismissed; success and
    // info toasts auto-dismiss.
    if (type !== 'error') setTimeout(() => get().removeToast(id), AUTO_DISMISS_MS)
  },
  removeToast: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
