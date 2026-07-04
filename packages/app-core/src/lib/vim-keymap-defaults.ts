/**
 * Default Vim key mappings, seeded into the `vimKeymap` pref.
 *
 * Kept in its own leaf module (no imports) so `store.ts` can read it without
 * pulling in `vim-keymap.ts`, which depends on the command registry and would
 * otherwise create an import cycle (store → vim-keymap → commands → store).
 *
 * `j`/`k` are intentionally NOT remapped to `gj`/`gk` here: display-line
 * movement now comes from `registerDisplayLineMotion()` (cm-vim-display-line.ts,
 * upstream #290/#312/#314), which binds the `j`/`k` motions directly, is
 * count-aware (`3j` moves 3 logical lines), and is shared with the Quick Note
 * window. A `nmap j gj` seed would shadow that motion, so it's dropped.
 */
export const DEFAULT_VIM_KEYMAP = ['nnoremap - $', 'vnoremap - $'].join('\n')
