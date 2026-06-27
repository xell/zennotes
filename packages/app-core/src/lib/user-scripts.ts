import type { ZenFacade } from './zen-facade'

/**
 * Loads and runs user JS functions from files in the ZenNotes config dir
 * (`~/.config/zennotes/<file>.js`), for the Vim `zen:<file>:<fn>(args)`
 * mappings.
 *
 * The file is read through the main process on each invocation (cheap), and
 * the compiled function is cached by file + mtime so edits hot-reload on the
 * next keypress without a restart. The file's top-level functions run with a
 * `zen` facade in scope and the parsed literal `args` applied.
 *
 * This evaluates user-authored code in the renderer (the CSP already allows
 * 'unsafe-eval'). It is gated behind the `vimJsScriptsEnabled` setting.
 */

// Compiled functions keyed by `${file}:${mtime}:${fn}`. Bounded by pruning
// stale mtimes per file on reload.
const compiled = new Map<string, (zen: ZenFacade, args: unknown[]) => unknown>()

function compile(
  file: string,
  fn: string,
  code: string
): (zen: ZenFacade, args: unknown[]) => unknown {
  // `fn` is validated as an identifier by the keymap parser, so it is safe to
  // interpolate. Functions in `code` close over the injected `zen`.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(
    'zen',
    'args',
    `${code}\n;return typeof ${fn} === 'function'` +
      ` ? ${fn}.apply(null, args)` +
      ` : (function(){ throw new Error('function ${fn}() is not defined in ${file}.js'); })();`
  ) as (zen: ZenFacade, args: unknown[]) => unknown
}

export async function callUserScript(
  file: string,
  fn: string,
  args: unknown[],
  zen: ZenFacade
): Promise<void> {
  try {
    const res = await window.zen.getUserScript(file)
    if (!res) {
      console.warn(`[zen:js] script not found: ${file}.js (in the ZenNotes config dir)`)
      return
    }
    const key = `${file}:${res.mtime}:${fn}`
    let run = compiled.get(key)
    if (!run) {
      // Drop stale compilations of this file (older mtimes) before caching.
      for (const k of compiled.keys()) {
        if (k.startsWith(`${file}:`)) compiled.delete(k)
      }
      run = compile(file, fn, res.code)
      compiled.set(key, run)
    }
    await run(zen, args)
  } catch (err) {
    console.warn(`[zen:js] error running ${file}:${fn}()`, err)
  }
}
