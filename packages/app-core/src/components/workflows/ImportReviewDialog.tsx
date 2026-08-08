// The dialog between a workflow someone sent you and your vault.
//
// Everything on this screen exists because an imported workflow is EXECUTABLE
// AUTOMATION over the user's notes. A file from a forum post can archive, move,
// retag or overwrite hundreds of them, so the one thing this dialog may never
// be is a progress bar over a decision that already happened. It shows what the
// file would do, in the words the step registry uses for itself, and the only
// way past it is a button the user presses.
//
// The component decides nothing. `reviewWorkflowImport` in
// `@shared/workflows/share` has already parsed, validated, listed the writes,
// neutralized the trigger and dropped a colliding keybinding, and it hands over
// the exact bytes an accept would write. This file renders that answer, which
// is what keeps the rule "the dialog cannot describe one thing and write
// another" true by construction rather than by review.

import { useEffect, useRef } from 'react'

import type { WorkflowImportReview } from '@shared/workflows/share'
import type { Diagnostic } from '@shared/workflows/types'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Modal'

export interface ImportReviewDialogProps {
  /** Where the text came from, in words: `the clipboard`, `reading-log.md`. */
  source: string
  /** Vault-relative path an accept would write, e.g. `.zennotes/workflows/x.md`. */
  target: string
  review: WorkflowImportReview
  /** Null while the write is in flight, so the button cannot be pressed twice. */
  onImport: (() => void) | null
  onCancel: () => void
}

function DiagnosticRows({ diagnostics }: { diagnostics: readonly Diagnostic[] }): JSX.Element {
  return (
    <ul className="flex flex-col gap-0.5">
      {diagnostics.map((diagnostic, index) => (
        <li
          key={`${diagnostic.line}-${index}`}
          className={`flex gap-2 text-xs ${
            diagnostic.severity === 'error' ? 'text-danger' : 'text-warning'
          }`}
        >
          <span className="shrink-0 font-mono text-2xs opacity-70">
            {diagnostic.line > 0 ? `line ${diagnostic.line}` : 'file'}
          </span>
          <span className="min-w-0">{diagnostic.message}</span>
        </li>
      ))}
    </ul>
  )
}

export function ImportReviewDialog({
  source,
  target,
  review,
  onImport,
  onCancel
}: ImportReviewDialogProps): JSX.Element {
  const primaryRef = useRef<HTMLButtonElement>(null)

  // The keyboard lands on the button that decides, so Enter is an answer and
  // Escape is the other one. Never on a scroll region: this dialog is read
  // before it is answered, and stealing the arrows would stop it being read.
  useEffect(() => {
    primaryRef.current?.focus()
  }, [])

  const errors = review.diagnostics.filter((d) => d.severity === 'error')
  const warnings = review.diagnostics.filter((d) => d.severity === 'warning')

  return (
    <Modal
      size="lg"
      layer="modal"
      align="top"
      onClose={onCancel}
      labelledBy="workflow-import-title"
      data={{ 'data-workflow-import': 'true' }}
    >
      <div className="border-b border-paper-300/70 px-5 py-4">
        <div id="workflow-import-title" className="text-sm font-semibold text-ink-900">
          {review.ok ? `Import "${review.name}"?` : 'This file is not a workflow'}
        </div>
        <p className="mt-1 text-xs text-ink-500">
          From {source}. Nothing has been written to your vault yet.
        </p>
      </div>

      <div className="max-h-[56vh] overflow-y-auto px-5 py-4">
        {review.ok ? (
          <>
            {review.description !== '' && (
              <p className="text-sm text-ink-700">{review.description}</p>
            )}

            {/* The headline question, answered before the detail: a workflow
                that only reads is a far smaller decision than one that moves
                files, and the two have to LOOK different, not merely list
                different things. */}
            <div
              className={`mt-3 rounded-lg border px-3 py-2 ${
                review.readOnly
                  ? 'border-paper-300 bg-paper-50'
                  : 'border-warning/40 bg-warning/10'
              }`}
            >
              <div
                className={`text-xs font-semibold ${
                  review.readOnly ? 'text-ink-700' : 'text-warning'
                }`}
              >
                {review.readOnly
                  ? 'This workflow only reads. Running it would change nothing.'
                  : 'This workflow writes to your vault when you run it.'}
              </div>
              {!review.readOnly && (
                <ul className="mt-2 flex flex-col gap-1">
                  {review.writes.map((write) => (
                    <li
                      key={`${write.kind}-${write.detail}`}
                      className="flex items-baseline gap-2 text-xs text-ink-800"
                    >
                      <span className="shrink-0 font-medium">{write.title}</span>
                      {write.detail !== '' && (
                        <span className="min-w-0 break-all font-mono text-2xs text-ink-600">
                          {write.detail}
                        </span>
                      )}
                      {write.count > 1 && (
                        <span className="shrink-0 text-2xs text-ink-400">x{write.count}</span>
                      )}
                      {write.irreversible && (
                        <span className="shrink-0 text-2xs uppercase tracking-wide text-danger">
                          no undo
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Changes made TO the file on the way in. Stated rather than done
                quietly: a file that asked to run on its own has to say so, or
                the safest thing this dialog does is also the most invisible. */}
            <ul className="mt-3 flex flex-col gap-1">
              {/* Unconditional, because the rule is: an import ALWAYS arrives as
                  a draft, whatever the file said, exactly as it always arrives
                  as `trigger: manual`. A file from a forum post may not install
                  itself as something that is allowed to act, and a promise this
                  dialog only makes sometimes is one nobody can rely on. */}
              <li className="text-xs text-ink-600">
                It arrives as a <span className="font-mono text-2xs">draft</span>, so it is saved
                but cannot run until you activate it.
              </li>
              {review.triggerChanged !== null && (
                <li className="text-xs text-ink-600">
                  It asked to run by itself (
                  <span className="font-mono text-2xs">{review.triggerChanged.declared}</span>). It
                  is being imported as <span className="font-mono text-2xs">manual</span>, so it
                  only runs when you press Run.
                </li>
              )}
              {review.keyRemoved !== null && (
                <li className="text-xs text-ink-600">
                  Its shortcut <span className="font-mono text-2xs">{review.keyRemoved}</span> is
                  already used by another workflow, so it was removed.
                </li>
              )}
            </ul>

            {warnings.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                  {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}
                </div>
                <DiagnosticRows diagnostics={warnings} />
              </div>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-700">
              It could not be read as a workflow, so nothing was imported. Fix the file where it
              came from and try again.
            </p>
            <div className="mt-3">
              <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-500">
                {errors.length === 1 ? '1 error' : `${errors.length} errors`}
              </div>
              <DiagnosticRows diagnostics={review.diagnostics} />
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-3 border-t border-paper-300/70 bg-paper-50 px-5 py-3">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-400" title={target}>
          {review.ok ? target : 'Nothing will be written'}
        </span>
        {review.ok ? (
          <>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              ref={primaryRef}
              variant="primary"
              disabled={onImport === null}
              title="Add this workflow to your vault. It does not run."
              onClick={() => onImport?.()}
            >
              Import
            </Button>
          </>
        ) : (
          <Button ref={primaryRef} variant="secondary" onClick={onCancel}>
            Close
          </Button>
        )}
      </div>
    </Modal>
  )
}
