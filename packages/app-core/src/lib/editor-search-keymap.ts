import { openSearchPanel, searchKeymap } from '@codemirror/search'
import type { KeyBinding } from '@codemirror/view'
import { getKeymapBinding, type KeymapOverrides } from './keymaps'

/** Convert an app keybinding ("Mod+F") to CodeMirror's key format ("Mod-f"). */
export function toCmKey(binding: string): string {
  const parts = binding.split('+')
  const base = parts.pop() ?? ''
  const mods = parts.join('-')
  const baseOut = base.length === 1 ? base.toLowerCase() : base
  return mods ? `${mods}-${baseOut}` : baseOut
}

/**
 * CodeMirror's `searchKeymap` with its hardcoded find-panel opener replaced by
 * the configurable `editor.find` binding — so opening the in-editor find/replace
 * panel becomes a first-class, clearable/rebindable item in Settings ▸ Keymaps
 * instead of a hidden library default. Every other search binding (find
 * next/prev, close, select-next-occurrence, go-to-line) is kept as shipped.
 *
 * The opener is matched by its `run` (`openSearchPanel`), not by key string, so
 * this stays correct even if the library's default chord changes. When
 * `editor.find` is cleared the opener is simply omitted (the key does nothing in
 * the editor), which is the whole point of making it configurable.
 *
 * Used by every editor surface (main pane, pinned reference, and the standalone
 * note/file/quick-capture windows) so the binding behaves identically across all
 * of them.
 */
export function editorFindKeymap(
  overrides: KeymapOverrides | null | undefined
): readonly KeyBinding[] {
  const base = searchKeymap.filter((b) => b.run !== openSearchPanel)
  const binding = getKeymapBinding(overrides, 'editor.find')
  if (!binding) return base
  return [{ key: toCmKey(binding), run: openSearchPanel }, ...base]
}
