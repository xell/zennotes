import { describe, it, expect } from 'vitest'
import {
  FRONTMATTER_BLOCK_RE,
  composeTaskFile,
  parseFrontmatterFields,
  updateFrontmatterFields,
  yamlValue
} from './frontmatter'

describe('yamlValue', () => {
  it('leaves plain scalars bare, including mid-value brackets and commas', () => {
    for (const v of ['hello world', '2026-08-07', '-5', 'a, b', 'x [y]', 'v2.25.0', '-x']) {
      expect(yamlValue(v)).toBe(v)
    }
  })

  it('quotes values a YAML reader would take as structure', () => {
    for (const v of [
      '[[Project X]]',
      '[a]',
      '{x}',
      '- item',
      '-',
      '? key',
      '> folded',
      '|literal',
      '&anchor',
      '*alias',
      '!tag',
      '%directive',
      '`tick',
      ',lead',
      '] stray',
      'a: b',
      '#tag',
      ' padded',
      'padded ',
      ''
    ]) {
      expect(yamlValue(v)).toBe(JSON.stringify(v))
    }
  })

  it('round-trips through parseFrontmatterFields as the same string, never a list', () => {
    for (const v of ['[[Project X]]', '[[A]], [[B]]', '[a]', '- item', '> folded', '*alias']) {
      const parsed = parseFrontmatterFields(`k: ${yamlValue(v)}`)
      expect(parsed.k).toBe(v)
    }
  })

  it('an UNQUOTED wikilink is misread as an inline list, which is why quoting matters', () => {
    expect(parseFrontmatterFields('k: [[Project X]]').k).not.toBe('[[Project X]]')
  })
})

describe('yamlValue callers', () => {
  it('updateFrontmatterFields writes a wikilink value readably', () => {
    const body = updateFrontmatterFields('Body\n', { project: '[[Project X]]' })
    expect(body).toContain('project: "[[Project X]]"')
    const m = FRONTMATTER_BLOCK_RE.exec(body)
    expect(parseFrontmatterFields(m?.[1] ?? '').project).toBe('[[Project X]]')
  })

  it('composeTaskFile quotes a bracket-leading title', () => {
    const file = composeTaskFile({ title: '[urgent] fix the roof' })
    const m = FRONTMATTER_BLOCK_RE.exec(file)
    expect(parseFrontmatterFields(m?.[1] ?? '').title).toBe('[urgent] fix the roof')
  })
})
