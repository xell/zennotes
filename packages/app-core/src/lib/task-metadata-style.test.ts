import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

/** The declaration block covering one task-metadata class. The editor
 *  (`cm-task-*`) and the reading preview (`zen-task-*`) share these rules, so
 *  the block is looked up by whichever selector is asked for. */
function rule(selector: string): string {
  const match = stylesSource.match(new RegExp(`\\.${selector}[^{]*\\{[^}]*\\}`, 's'))
  expect(match, `missing rule for .${selector}`).not.toBeNull()
  return match?.[0] ?? ''
}

describe('task metadata chips in the editor (#454, #479)', () => {
  it('gives each priority level both a colour and a background tint', () => {
    // Colour alone wasn't enough. On palettes where the priority hues sit close
    // to the editor foreground — the default Gruvbox dark among them, where
    // `!med` amber lands within ΔE ~20 of the body text — the marker read as
    // plain bold text and the three levels looked alike. The tint carries the
    // distinction when the hue can't.
    for (const [level, colorVar] of [
      ['cm-task-prio-high', '--z-red'],
      ['cm-task-prio-med', '--z-yellow'],
      ['cm-task-prio-low', '--z-blue']
    ] as const) {
      const body = rule(level)
      expect(body).toMatch(new RegExp(`color:\\s*rgb\\(var\\(${colorVar}\\)\\)`))
      expect(body).toMatch(new RegExp(`background-color:\\s*rgb\\(var\\(${colorVar}\\)\\s*/`))
    }
  })

  it('shapes priority markers like the due-date and field chips beside them', () => {
    const prio = rule('cm-task-prio')
    expect(prio).toMatch(/font-weight:\s*600/)
    expect(prio).toMatch(/border-radius:/)
    expect(prio).toMatch(/padding:/)
  })

  it('styles the editor and the preview from one rule, so a split view matches', () => {
    // The chips are rendered by two different pipelines — CodeMirror decorations
    // and a remark plugin — and must not drift apart visually. (#479)
    for (const [editor, preview] of [
      ['cm-task-prio', 'zen-task-prio'],
      ['cm-task-prio-high', 'zen-task-prio-high'],
      ['cm-task-prio-med', 'zen-task-prio-med'],
      ['cm-task-prio-low', 'zen-task-prio-low'],
      ['cm-task-meta', 'zen-task-meta'],
      ['cm-task-due', 'zen-task-due'],
      ['cm-task-due-overdue', 'zen-task-due-overdue'],
      ['cm-task-field', 'zen-task-field'],
      ['cm-task-rollup', 'zen-task-rollup'],
      ['cm-task-rollup-complete', 'zen-task-rollup-complete']
    ] as const) {
      const block = rule(editor)
      expect(block, `.${preview} must share .${editor}'s rule`).toContain(`.${preview}`)
    }
  })

  it('keeps the due-date and field chips tinted too', () => {
    expect(rule('cm-task-due')).toMatch(/background-color:\s*rgb\(var\(--z-blue\)\s*\//)
    expect(rule('cm-task-due-overdue')).toMatch(/background-color:\s*rgb\(var\(--z-red\)\s*\//)
    expect(rule('cm-task-field')).toMatch(/background-color:\s*rgb\(var\(--z-purple\)\s*\//)
  })

  it('keeps the subtask rollup neutral until complete, then green (#512)', () => {
    expect(rule('cm-task-rollup')).toMatch(/color:\s*rgb\(var\(--z-fg-2\)\)/)
    expect(rule('cm-task-rollup-complete')).toMatch(/color:\s*rgb\(var\(--z-green\)\)/)
  })
})
