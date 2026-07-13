import { useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawDocument } from '@shared/excalidraw'

type InitialData = ComponentProps<typeof Excalidraw>['initialData']

function readThemeMode(): 'light' | 'dark' {
  return typeof document !== 'undefined' &&
    document.documentElement.dataset.themeMode === 'dark'
    ? 'dark'
    : 'light'
}

/**
 * The embedded Excalidraw drawing editor for a `.excalidraw` file. Loaded lazily
 * (see LazyExcalidrawView) so the heavy bundle never touches startup. Reads the
 * scene JSON from disk on open and debounce-saves it back on every change.
 */
export function ExcalidrawView({ path }: { path: string }): JSX.Element {
  const [initialData, setInitialData] = useState<InitialData | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<string>('')
  const pathRef = useRef(path)
  pathRef.current = path

  // Follow the app's resolved light/dark mode. That mode lives on
  // `<html data-theme-mode>`, maintained in App.tsx (it already accounts for
  // built-in themes, custom themes, and auto/system) — custom theme ids aren't
  // in the built-in THEMES registry, so we can't derive the mode from themeId.
  // Observe the attribute so an open drawing tracks live theme and OS dark-mode
  // switches, rather than reading it once during render. (#363)
  const [excalidrawTheme, setExcalidrawTheme] = useState<'light' | 'dark'>(readThemeMode)
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const html = document.documentElement
    const sync = (): void => setExcalidrawTheme(readThemeMode())
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme-mode'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    setInitialData(undefined)
    window.zen
      .readNote(path)
      .then((res) => {
        if (cancelled) return
        lastSaved.current = res?.body ?? ''
        const doc = parseExcalidrawDocument(res?.body ?? '')
        setInitialData({
          elements: doc.elements,
          appState: doc.appState,
          files: doc.files
        } as InitialData)
      })
      .catch(() => {
        if (!cancelled) setInitialData({} as InitialData)
      })
    return () => {
      cancelled = true
    }
  }, [path])

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    },
    []
  )

  if (initialData === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        Loading drawing…
      </div>
    )
  }

  return (
    <div className="min-h-0 w-full flex-1" style={{ height: '100%' }} data-excalidraw-view>
      <Excalidraw
        initialData={initialData}
        theme={excalidrawTheme}
        onChange={(elements, appState, files) => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => {
            let json: string
            try {
              json = serializeAsJSON(elements, appState, files, 'local')
            } catch {
              return
            }
            // Skip no-op writes (Excalidraw fires onChange on load and on hover).
            if (json === lastSaved.current) return
            lastSaved.current = json
            void window.zen.writeNote(pathRef.current, json)
          }, 700)
        }}
      />
    </div>
  )
}
