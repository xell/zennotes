// Vitest setup: guarantee a working Web Storage API in the test environment.
//
// Node 26 ships a native, experimental `localStorage` global gated behind
// `--localstorage-file`; left unconfigured it evaluates to `undefined` and
// prints an ExperimentalWarning. Vitest's jsdom environment shares its global
// object with the worker (`globalThis === window`), so that unconfigured native
// `localStorage` shadows the one jsdom would otherwise install, and
// `window.localStorage` comes out `undefined`. Every test that touches it then
// throws ("Cannot read properties of undefined (reading 'clear'/'getItem')"),
// and modules like `store.ts` that read it at import time fail to initialize
// (surfacing later as "useStore.getState is not a function").
//
// This installs a minimal in-memory Storage ONLY when the environment doesn't
// already provide a working one, so it's a no-op on Node/CI versions where
// jsdom's localStorage works normally. The app only uses the standard methods
// (getItem/setItem/removeItem/clear), which this covers.

class MemoryStorage {
  #store = new Map<string, string>()

  get length(): number {
    return this.#store.size
  }

  key(index: number): string | null {
    return Array.from(this.#store.keys())[index] ?? null
  }

  getItem(key: string): string | null {
    const k = String(key)
    return this.#store.has(k) ? this.#store.get(k)! : null
  }

  setItem(key: string, value: string): void {
    this.#store.set(String(key), String(value))
  }

  removeItem(key: string): void {
    this.#store.delete(String(key))
  }

  clear(): void {
    this.#store.clear()
  }
}

function hasWorkingStorage(value: unknown): boolean {
  return !!value && typeof (value as Storage).getItem === 'function'
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  let current: unknown
  try {
    current = (globalThis as Record<string, unknown>)[name]
  } catch {
    current = undefined
  }
  if (hasWorkingStorage(current)) return

  const storage = new MemoryStorage()
  try {
    Object.defineProperty(globalThis, name, {
      value: storage,
      configurable: true,
      writable: true
    })
  } catch {
    // Fall back to a plain assignment if the property can't be redefined.
    ;(globalThis as Record<string, unknown>)[name] = storage
  }
}

ensureStorage('localStorage')
ensureStorage('sessionStorage')
