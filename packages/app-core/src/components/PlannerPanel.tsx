import { useState } from 'react'
import { useStore } from '../store'

/**
 * Third tab of the right pane, alongside Reference and Terminal: Leo's Day
 * Planner web app, loaded in an iframe.
 *
 * Deliberately primitive for now. The URL is a setting rather than a bridge,
 * there is no communication between the page and ZenNotes, and nothing here knows what
 * a plan is — this is a viewport onto an app that happens to run beside the
 * notes, not an integration. Making it a real feature means at minimum a
 * configurable URL and deciding whether the page gets to talk to the vault (see
 * the file-broker sketch in `data/html-support.md`).
 *
 * Note this is NOT the Planner described in `data/planner.md`, which was
 * designed as a main-pane `zen://planner` tab following the Tasks pattern. That
 * decision still stands for a built-in planner; this is a shortcut to having
 * the existing web app on screen.
 *
 * Unlike TerminalPanel, which stays mounted behind `display: none` to keep its
 * PTY alive, this unmounts whenever it isn't the visible tab — so the page is
 * torn down rather than left running invisibly. A hidden iframe is NOT idle:
 * Chromium keeps the document loaded, timers firing and sockets open (only
 * `requestAnimationFrame` stops, since nothing is painted), and the window sets
 * `backgroundThrottling: false`, so even backgrounding ZenNotes wouldn't slow it
 * down. The app it hosts is under active development, so leaving a stale build
 * running in the background is worse than paying a reload. The trade is real
 * though: reopening the tab reloads the app and drops whatever in-page state it
 * held.
 */

interface Props {
  visible: boolean
}

export function PlannerPanel({ visible }: Props): JSX.Element | null {
  const plannerUrl = useStore((s) => s.plannerUrl)
  const plannerTargetUrl = useStore((s) => s.plannerTargetUrl)
  // Bumped by openPlannerUrl/goPlannerHome so re-opening the same link (or
  // hitting Home while already home) still forces the panel to reload,
  // instead of a same-value state set silently doing nothing.
  const plannerNonce = useStore((s) => s.plannerNonce)
  const goPlannerHome = useStore((s) => s.goPlannerHome)
  const plannerSrc = plannerTargetUrl ?? plannerUrl
  // Bumped to force a reload without leaving the tab — handy when the dev
  // server was not up when this opened, which otherwise leaves a blank frame.
  const [reloadKey, setReloadKey] = useState(0)

  if (!visible) return null

  return (
    <div className="zen-planner-panel flex min-h-0 min-w-0 flex-1 flex-col">
      <iframe
        key={`${plannerNonce}:${reloadKey}`}
        src={plannerSrc}
        title="Planner"
        // `allow-same-origin` — unlike the vault's HTML asset viewer, which
        // withholds it precisely so an untrusted page cannot reach other vault
        // files. This is a first-party dev app that needs its own origin to
        // work at all: storage, its HMR socket, and any call to its own backend
        // would fail from the opaque origin the asset viewer uses.
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        allow="clipboard-write"
        className="min-h-0 min-w-0 flex-1 border-0 bg-white"
      />
      <div className="zen-planner-panel-footer flex shrink-0 items-center justify-between gap-2 border-t border-paper-300/70 px-2 py-1 text-2xs text-ink-400">
        <span className="min-w-0 truncate" title={plannerSrc}>
          {plannerSrc}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={goPlannerHome}
            className="rounded px-1.5 py-0.5 text-sm leading-none text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            title="Go to the Planner home page"
            aria-label="Go to the Planner home page"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 349.805 308.35"
              className="h-3 w-3"
              fill="currentColor"
              fillOpacity="0.85"
            >
              <path
                d="M132.422 292.969L217.383 292.969L217.383 198.34C217.383 191.602 212.988 187.207 206.25 187.207L143.701 187.207C136.963 187.207 132.422 191.602 132.422 198.34ZM12.5977 156.445C16.6992 156.445 20.0684 154.248 23.1445 151.758L169.775 28.5645C171.387 27.2461 173.291 26.5137 174.902 26.5137C176.66 26.5137 178.418 27.2461 180.029 28.5645L326.807 151.758C329.736 154.248 333.105 156.445 337.207 156.445C345.117 156.445 349.805 150.732 349.805 144.727C349.805 141.357 348.486 137.842 345.117 135.205L192.48 7.03125C186.914 2.34375 180.908 0 174.902 0C168.896 0 162.891 2.34375 157.324 7.03125L4.6875 135.205C1.46484 137.842 0 141.357 0 144.727C0 150.732 4.6875 156.445 12.5977 156.445ZM270.264 78.6621L307.031 109.717L307.031 43.6523C307.031 37.207 302.93 33.1055 296.484 33.1055L280.811 33.1055C274.512 33.1055 270.264 37.207 270.264 43.6523ZM75.8789 308.057L274.072 308.057C294.873 308.057 307.031 296.191 307.031 275.684L307.031 113.379L283.447 97.4121L283.447 269.824C283.447 279.346 278.32 284.473 269.092 284.473L80.8594 284.473C71.4844 284.473 66.3574 279.346 66.3574 269.824L66.3574 97.5586L42.7734 113.379L42.7734 275.684C42.7734 296.338 54.9316 308.057 75.8789 308.057Z"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setReloadKey((n) => n + 1)}
            className="rounded px-1.5 py-0.5 text-sm leading-none text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
            title="Reload the current Planner page"
            aria-label="Reload the current Planner page"
          >
            ↻
          </button>
        </div>
      </div>
    </div>
  )
}
