import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

export function TerminalPanel(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#171717',
        foreground: '#e5e5e5',
        cursor: '#f5c56f',
        selectionBackground: '#3f3f46'
      }
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminal.writeln('ZenNotes terminal')
    terminal.writeln('Shell connection is not wired yet.')
    terminal.write('\r\n')

    requestAnimationFrame(() => fitAddon.fit())

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => fitAddon.fit())
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      terminal.dispose()
    }
  }, [])

  return (
    <div className="flex-1 overflow-hidden bg-neutral-950">
      <div ref={containerRef} className="h-full w-full p-2" />
    </div>
  )
}
