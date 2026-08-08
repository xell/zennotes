import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { TUTORIAL_STEPS } from '../../lib/workflow-tutorial'
import type { TutorialSignal } from '../../lib/workflow-tutorial'
import { Button, IconButton } from '../ui/Button'
import { CheckIcon, CloseIcon } from '../icons'

/**
 * The guided tutorial's chapter card, docked over the Workflows view.
 *
 * A docked card and not a modal, deliberately: every chapter asks the user to
 * DO something in the view underneath, so the tutorial must never own the
 * keyboard or block a click. It is draggable by its header for the same
 * reason: whatever it happens to cover is exactly what some chapter will ask
 * the user to press.
 *
 * Each chapter is an intro plus a todo list. Todos with a `doneWhen` signal
 * tick themselves off; the rest are tap-to-tick. A chapter auto-advances only
 * when one of its detectable todos happened WHILE the chapter was showing: a
 * condition that was already true on arrival (the workflow was selected three
 * chapters ago) shows as ticked but never skips the page, which is the
 * difference between "it noticed me" and "it flipped two pages at once".
 *
 * Like everything in components/workflows, this renders what it is handed and
 * subscribes to nothing.
 */
export function TutorialPanel({
  step,
  signals,
  onStepChange,
  onFinish
}: {
  step: number
  /** Which detectable conditions currently hold, per the view. */
  signals: Partial<Record<TutorialSignal, boolean>>
  onStepChange: (step: number) => void
  /** Finish AND abandon: both remove every trace the tutorial seeded. */
  onFinish: () => void
}): JSX.Element | null {
  const total = TUTORIAL_STEPS.length
  const clamped = Math.max(0, Math.min(step, total - 1))
  const current = TUTORIAL_STEPS[clamped]
  const last = clamped >= total - 1

  /* ----- Dragging: an offset from the bottom-right anchor, kept across
   *  chapters so the card stays where the user parked it. ----- */
  const panelRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseX: number
    baseY: number
  } | null>(null)

  const clampOffset = (next: { x: number; y: number }): { x: number; y: number } => {
    const panel = panelRef.current
    const parent = panel?.offsetParent as HTMLElement | null
    if (!panel || !parent) return next
    // Anchored bottom-right, so valid offsets are negative-or-zero, down to
    // wherever keeps the card fully inside the view (16px margins).
    const minX = -(parent.clientWidth - panel.offsetWidth - 32)
    const minY = -(parent.clientHeight - panel.offsetHeight - 32)
    return {
      x: Math.min(0, Math.max(Math.min(minX, 0), next.x)),
      y: Math.min(0, Math.max(Math.min(minY, 0), next.y))
    }
  }

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // The close button stays a button; only bare header surface drags.
    if ((event.target as HTMLElement).closest('button')) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setOffset(
      clampOffset({
        x: drag.baseX + event.clientX - drag.startX,
        y: drag.baseY + event.clientY - drag.startY
      })
    )
  }
  const onHeaderPointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  /* ----- Todo state for the CURRENT chapter ----- */
  // Tasks are detected in order. A task ARMS once every earlier task is done;
  // at arming its signal is snapshotted, and a signal that was already true at
  // that instant ticks the row without earning advance credit. Only a signal
  // that came true AFTER arming is something the user just did, and only that
  // may turn the page: `done` is latched (undoing a step later never un-ticks
  // history), and a chapter arrived-at fully satisfied waits for Next.
  interface TaskState {
    done: boolean
    credited: boolean
    armSnap: boolean | null
  }
  const [taskStates, setTaskStates] = useState<TaskState[]>([])

  useEffect(() => {
    setTaskStates([])
  }, [clamped])

  useEffect(() => {
    setTaskStates((prev) => {
      const tasks = current?.tasks ?? []
      const next = tasks.map((_, i) => prev[i] ?? { done: false, credited: false, armSnap: null })
      let changed = prev.length !== next.length
      for (let i = 0; i < tasks.length; i++) {
        const state = next[i]
        if (state.done) continue
        const armed = next.slice(0, i).every((earlier) => earlier.done)
        if (!armed) continue
        const value = signals[tasks[i].doneWhen] === true
        if (state.armSnap === null) {
          next[i] = { done: value, credited: false, armSnap: value }
          changed = true
          continue
        }
        if (value) {
          next[i] = { ...state, done: true, credited: true }
          changed = true
        }
      }
      return changed ? next : prev
    })
    // `signals` is a fresh object every parent render; the updater bails with
    // the previous array when nothing actually changed, so this cannot loop.
  }, [signals, clamped, current])

  const taskDone = (index: number): boolean => taskStates[index]?.done === true

  const shouldAdvance =
    !last &&
    (current?.tasks.length ?? 0) > 0 &&
    (current?.tasks ?? []).every((_, i) => taskStates[i]?.done) &&
    taskStates.some((state) => state.credited)

  useEffect(() => {
    if (!shouldAdvance) return
    // A beat of delay so the user sees their tick land before the page turns.
    const timer = window.setTimeout(() => onStepChange(clamped + 1), 900)
    return () => window.clearTimeout(timer)
  }, [shouldAdvance, clamped, onStepChange])

  if (!current) return null
  return (
    <div
      ref={panelRef}
      data-workflow-tutorial
      role="complementary"
      aria-label="Workflows tutorial"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      className="absolute bottom-4 right-4 z-30 w-96 max-w-[calc(100%-2rem)] rounded-2xl border border-paper-300/70 bg-paper-50 shadow-lg"
    >
      <div
        className="flex cursor-grab touch-none select-none items-center gap-2 border-b border-paper-300/60 px-4 py-2.5 active:cursor-grabbing"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerEnd}
        onPointerCancel={onHeaderPointerEnd}
        title="Drag to move"
      >
        <span className="text-2xs font-semibold uppercase tracking-wide text-ink-400">
          Tutorial · {clamped + 1} of {total}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">
          {current.title}
        </span>
        <IconButton
          size="sm"
          aria-label="Leave the tutorial"
          title="Leave the tutorial"
          onClick={onFinish}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      <div className="px-4 py-3">
        <p className="text-xs leading-5 text-ink-600">{current.intro}</p>
        {current.tasks.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {current.tasks.map((task, index) => {
              const done = taskDone(index)
              return (
                <li
                  key={task.text}
                  className="flex items-start gap-2"
                  role="checkbox"
                  aria-checked={done}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      done
                        ? 'border-accent bg-accent text-paper-50'
                        : 'border-paper-300 bg-paper-100 text-transparent'
                    }`}
                  >
                    <CheckIcon className="h-2.5 w-2.5" />
                  </span>
                  <span
                    className={`text-xs leading-5 ${
                      done ? 'text-ink-400 line-through decoration-ink-300' : 'text-ink-700'
                    }`}
                  >
                    {task.text}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-paper-300/60 px-4 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={clamped === 0}
          onClick={() => onStepChange(clamped - 1)}
        >
          Back
        </Button>
        {shouldAdvance ? (
          <span className="text-2xs text-ink-400">Nice, moving on…</span>
        ) : (
          <span aria-hidden className="flex items-center gap-1">
            {TUTORIAL_STEPS.map((entry, index) => (
              <span
                key={entry.title}
                className={`h-1.5 w-1.5 rounded-full ${
                  index === clamped ? 'bg-accent' : 'bg-paper-300'
                }`}
              />
            ))}
          </span>
        )}
        {last ? (
          <Button variant="primary" size="sm" onClick={onFinish}>
            Finish
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={() => onStepChange(clamped + 1)}>
            Next
          </Button>
        )}
      </div>
    </div>
  )
}
