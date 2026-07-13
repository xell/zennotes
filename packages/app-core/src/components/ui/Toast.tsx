import { useToastStore, type ToastType } from '../../lib/toast'
import { Button, IconButton } from './Button'
import { CloseIcon } from '../icons'

// Status is shown as a small colored dot + border tint (matching the app's
// AppUpdateNotice), using the semantic theme tokens rather than fixed colors.
const DOT_BY_TYPE: Record<ToastType, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  info: 'bg-accent'
}
const BORDER_BY_TYPE: Record<ToastType, string> = {
  success: 'border-success/40',
  error: 'border-danger/40',
  info: 'border-accent/30'
}

/**
 * Bottom-right transient notifications, driven by `useToastStore`. Styled to
 * match AppUpdateNotice so app-level feedback reads consistently; success/info
 * auto-dismiss while errors stay until dismissed (see toast.ts).
 */
export function ToastHost(): JSX.Element | null {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-toast flex flex-col items-end gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          aria-live="polite"
          className={`pointer-events-auto flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2.5 rounded-xl border bg-paper-50/95 px-3 py-2 text-sm text-ink-800 shadow-float backdrop-blur ${BORDER_BY_TYPE[t.type]}`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_BY_TYPE[t.type]}`} aria-hidden />
          <span className="min-w-0 font-medium">{t.message}</span>
          {t.action && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => {
                t.action?.onClick()
                removeToast(t.id)
              }}
            >
              {t.action.label}
            </Button>
          )}
          <IconButton
            size="sm"
            aria-label="Dismiss notification"
            className="shrink-0"
            onClick={() => removeToast(t.id)}
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
