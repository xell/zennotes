import { Vim } from '@replit/codemirror-vim'

type ExHandler = Parameters<typeof Vim.defineEx>[2]

/**
 * Keep CodeMirror-Vim's internal `move` implementation available for bare
 * ranges such as `:13`. The visible `:move` name is only a command prefix;
 * its handler lives under a distinct internal name so it cannot replace the
 * line-jump function in the global Ex table (#513).
 */
export function registerNoteMoveExCommands(handler: ExHandler): void {
  Vim.defineEx('movenote', 'move', handler)
  Vim.defineEx('mv', 'mv', handler)
}
