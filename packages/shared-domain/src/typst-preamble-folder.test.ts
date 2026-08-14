import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TYPST_PREAMBLE_FOLDER,
  isTypstPreamblePath,
  normalizeTypstPreambleFolder,
  normalizeTypstPreambleSettings,
  resolveTypstPreambleFolder
} from './typst-preamble-folder'

describe('normalizeTypstPreambleFolder', () => {
  it('accepts a plain directory name', () => {
    expect(normalizeTypstPreambleFolder('typst')).toBe('typst')
    expect(normalizeTypstPreambleFolder('  Preambles  ')).toBe('Preambles')
    expect(normalizeTypstPreambleFolder('math defs')).toBe('math defs')
  })

  it('rejects anything that is not a single safe segment', () => {
    for (const bad of [
      'a/b',
      'a\\b',
      '/typst',
      '.',
      '..',
      '.hidden',
      '',
      '   ',
      'a:b',
      'a*b',
      'a#b',
      'a[b]',
      42,
      null,
      undefined,
      { folder: 'typst' }
    ]) {
      expect(normalizeTypstPreambleFolder(bad)).toBeNull()
    }
  })

  it('rejects an absurdly long name', () => {
    expect(normalizeTypstPreambleFolder('x'.repeat(129))).toBeNull()
    expect(normalizeTypstPreambleFolder('x'.repeat(128))).toBe('x'.repeat(128))
  })
})

describe('resolveTypstPreambleFolder', () => {
  it('falls back to the default for anything unusable', () => {
    expect(resolveTypstPreambleFolder(undefined)).toBe(DEFAULT_TYPST_PREAMBLE_FOLDER)
    expect(resolveTypstPreambleFolder('a/b')).toBe(DEFAULT_TYPST_PREAMBLE_FOLDER)
    expect(resolveTypstPreambleFolder('Preambles')).toBe('Preambles')
  })
})

describe('normalizeTypstPreambleSettings', () => {
  it('drops the default so vault.json keeps no empty stub', () => {
    expect(normalizeTypstPreambleSettings({ folder: 'typst' })).toBeUndefined()
    expect(normalizeTypstPreambleSettings({})).toBeUndefined()
    expect(normalizeTypstPreambleSettings(null)).toBeUndefined()
    expect(normalizeTypstPreambleSettings({ folder: 'a/b' })).toBeUndefined()
  })

  it('keeps a real override', () => {
    expect(normalizeTypstPreambleSettings({ folder: 'Preambles' })).toEqual({
      folder: 'Preambles'
    })
  })
})

describe('isTypstPreamblePath', () => {
  it('matches the folder at any depth, case-insensitively', () => {
    expect(isTypstPreamblePath('typst/physics.md', 'typst')).toBe(true)
    expect(isTypstPreamblePath('inbox/typst/physics.md', 'typst')).toBe(true)
    expect(isTypstPreamblePath('archive/notes/TYPST/maths.md', 'typst')).toBe(true)
  })

  it('never matches the file itself, only a parent directory', () => {
    expect(isTypstPreamblePath('inbox/typst.md', 'typst')).toBe(false)
    expect(isTypstPreamblePath('typst', 'typst')).toBe(false)
  })

  it('does not match a folder that merely starts with the name', () => {
    expect(isTypstPreamblePath('inbox/typstish/x.md', 'typst')).toBe(false)
    expect(isTypstPreamblePath('inbox/my-typst/x.md', 'typst')).toBe(false)
  })

  it('honors a renamed folder, and stops matching the old one', () => {
    expect(isTypstPreamblePath('inbox/Preambles/physics.md', 'Preambles')).toBe(true)
    expect(isTypstPreamblePath('inbox/typst/physics.md', 'Preambles')).toBe(false)
  })

  it('is inert for an empty folder name rather than matching everything', () => {
    expect(isTypstPreamblePath('inbox/typst/physics.md', '')).toBe(false)
  })
})
