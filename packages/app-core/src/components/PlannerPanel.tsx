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
  // Bumped to force a reload without leaving the tab — handy when the dev
  // server was not up when this opened, which otherwise leaves a blank frame.
  const [reloadKey, setReloadKey] = useState(0)

  if (!visible) return null

  return (
    <div className="zen-planner-panel flex min-h-0 min-w-0 flex-1 flex-col">
      <iframe
        key={reloadKey}
        src={plannerUrl}
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
        <span className="truncate" title={plannerUrl}>
          {plannerUrl}
        </span>
        <button
          type="button"
          onClick={() => setReloadKey((n) => n + 1)}
          className="shrink-0 rounded px-1.5 py-0.5 text-ink-500 transition-colors hover:bg-paper-200 hover:text-ink-800"
          title="Reload the Planner app (use after starting the dev server)"
        >
          Reload
        </button>
      </div>
    </div>
  )
}
