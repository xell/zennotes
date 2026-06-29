import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'

interface Props {
  visible: boolean
}

export function TerminalPanel({ visible }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  // Ref so the ResizeObserver closure always sees current visibility.
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Create xterm once on mount, destroy on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#171717',
        foreground: '#e5e5e5',
        cursor: '#f5c56f',
        selectionBackground: '#3f3f46',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    const unsubData = window.zen?.terminal?.onData((id, data) => {
      if (id === sessionRef.current) term.write(data)
    }) ?? (() => {})
    const unsubExit = window.zen?.terminal?.onExit((id, code) => {
      if (id !== sessionRef.current) return
      term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`)
      sessionRef.current = null
    }) ?? (() => {})

    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return
      requestAnimationFrame(() => {
        fit.fit()
        if (sessionRef.current) {
          window.zen?.terminal?.resize(sessionRef.current, term.cols, term.rows)
        }
      })
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      unsubData()
      unsubExit()
      if (sessionRef.current) {
        window.zen?.terminal?.dispose(sessionRef.current)
        sessionRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // When the panel becomes visible: fit to available space, then create the
  // PTY session on first show or just send a resize on subsequent shows.
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    requestAnimationFrame(() => {
      fit.fit()
      const { cols, rows } = term

      if (!sessionRef.current) {
        const vault = useStore.getState().vault
        const cwd =
          vault?.root ??
          (typeof process !== 'undefined' ? (process.env.HOME ?? '/') : '/')
        window.zen?.terminal
          ?.create({ cwd, cols, rows })
          .then((id) => {
            sessionRef.current = id
            term.onData((data) => window.zen?.terminal?.input(id, data))
          })
          .catch(() => {
            term.writeln('\r\n\x1b[31m[failed to start shell]\x1b[0m')
          })
      } else {
        window.zen?.terminal?.resize(sessionRef.current, cols, rows)
      }
    })
  }, [visible])

  return (
    <div
      className="flex flex-col overflow-hidden flex-1 min-h-0 bg-neutral-950"
      style={{ display: visible ? 'flex' : 'none' }}
    >
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
