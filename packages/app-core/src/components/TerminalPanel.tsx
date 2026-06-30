import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../store'
import { TERMINAL_THEMES } from '../lib/terminal-themes'

interface Props {
  visible: boolean
}

function cssVarTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const rgb = (v: string): string => {
    const parts = css.getPropertyValue(v).trim().split(' ').map(Number)
    return parts.length === 3 ? `rgb(${parts.join(',')})` : '#888'
  }
  const bgParts = css.getPropertyValue('--z-bg').trim().split(' ').map(Number)
  const lum =
    bgParts.length === 3
      ? (bgParts[0] * 0.299 + bgParts[1] * 0.587 + bgParts[2] * 0.114) / 255
      : 0
  const isDark = lum < 0.5
  return {
    background: rgb('--z-bg'),
    foreground: rgb('--z-fg'),
    cursor: rgb('--z-accent'),
    cursorAccent: rgb('--z-bg'),
    selectionBackground: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
  }
}

function resolveIsDark(): boolean {
  const css = getComputedStyle(document.documentElement)
  const parts = css.getPropertyValue('--z-bg').trim().split(' ').map(Number)
  if (parts.length !== 3) return window.matchMedia('(prefers-color-scheme: dark)').matches
  const lum = (parts[0] * 0.299 + parts[1] * 0.587 + parts[2] * 0.114) / 255
  return lum < 0.5
}

function buildXtermTheme(lightName: string, darkName: string): ITheme {
  const name = resolveIsDark() ? darkName : lightName
  return TERMINAL_THEMES[name] ?? cssVarTheme()
}

export function TerminalPanel({ visible }: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const terminalScrollbarOnHover = useStore((s) => s.terminalScrollbarOnHover)
  const terminalLightTheme = useStore((s) => s.terminalLightTheme)
  const terminalDarkTheme = useStore((s) => s.terminalDarkTheme)
  const terminalFontFamily = useStore((s) => s.terminalFontFamily)
  const terminalFontSize = useStore((s) => s.terminalFontSize)

  const DEFAULT_FONT_FAMILY =
    'ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Roboto Mono", monospace'
  const DEFAULT_FONT_SIZE = 13

  const lightThemeRef = useRef(terminalLightTheme)
  const darkThemeRef = useRef(terminalDarkTheme)
  const fontFamilyRef = useRef(terminalFontFamily)
  const fontSizeRef = useRef(terminalFontSize)
  lightThemeRef.current = terminalLightTheme
  darkThemeRef.current = terminalDarkTheme
  fontFamilyRef.current = terminalFontFamily
  fontSizeRef.current = terminalFontSize

  // Re-apply theme whenever light/dark theme names change in settings.
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.theme = buildXtermTheme(terminalLightTheme, terminalDarkTheme)
  }, [terminalLightTheme, terminalDarkTheme])

  // Re-apply font whenever font settings change in settings.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    term.options.fontFamily = terminalFontFamily || DEFAULT_FONT_FAMILY
    term.options.fontSize = terminalFontSize || DEFAULT_FONT_SIZE
    requestAnimationFrame(() => {
      fit.fit()
      if (sessionRef.current) {
        window.zen?.terminal?.resize(sessionRef.current, term.cols, term.rows)
      }
    })
  }, [terminalFontFamily, terminalFontSize])

  // Create xterm once on mount, destroy on unmount.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: fontFamilyRef.current || DEFAULT_FONT_FAMILY,
      fontSize: fontSizeRef.current || DEFAULT_FONT_SIZE,
      theme: buildXtermTheme(lightThemeRef.current, darkThemeRef.current),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // Re-apply xterm theme whenever html[data-theme] changes.
    const observer = new MutationObserver(() => {
      term.options.theme = buildXtermTheme(lightThemeRef.current, darkThemeRef.current)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    const unsubData =
      window.zen?.terminal?.onData((id, data) => {
        if (id === sessionRef.current) term.write(data)
      }) ?? (() => {})
    const unsubExit =
      window.zen?.terminal?.onExit((id, code) => {
        if (id !== sessionRef.current) return
        term.writeln(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m`)
        sessionRef.current = null
      }) ?? (() => {})

    const focusHandler = (): void => {
      term.focus()
    }
    window.addEventListener('zen:focus-terminal-input', focusHandler)

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

    const w = window as Window & { __zenTerminalSend?: (text: string) => void }
    w.__zenTerminalSend = (text: string): void => {
      if (sessionRef.current) window.zen?.terminal?.input(sessionRef.current, text)
    }

    return () => {
      observer.disconnect()
      ro.disconnect()
      window.removeEventListener('zen:focus-terminal-input', focusHandler)
      unsubData()
      unsubExit()
      if (sessionRef.current) {
        window.zen?.terminal?.dispose(sessionRef.current)
        sessionRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      w.__zenTerminalSend = undefined
    }
  }, [])

  // When the panel becomes visible: fit and start PTY on first show.
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
      className="flex flex-col overflow-hidden flex-1 min-h-0 p-2"
      style={{ display: visible ? 'flex' : 'none', background: 'rgb(var(--z-bg))' }}
    >
      <div
        ref={containerRef}
        className={[
          'flex-1 min-h-0 overflow-hidden',
          terminalScrollbarOnHover ? 'terminal-scrollbar-on-hover' : 'terminal-scrollbar-hidden',
        ].join(' ')}
      />
    </div>
  )
}
