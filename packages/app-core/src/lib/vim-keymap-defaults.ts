/**
 * Default Vim key mappings, seeded into the `vimKeymap` pref.
 *
 * Kept in its own leaf module (no imports) so `store.ts` can read it without
 * pulling in `vim-keymap.ts`, which depends on the command registry and would
 * otherwise create an import cycle (store → vim-keymap → commands → store).
 */
export const DEFAULT_VIM_KEYMAP = [
  'nmap k gk',
  'nmap j gj',
  'nnoremap - $',
  'vnoremap - $'
].join('\n')
