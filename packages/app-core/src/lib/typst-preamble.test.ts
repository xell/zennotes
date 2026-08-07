import { describe, expect, it } from 'vitest'
import {
  isTypstPreamblePath,
  preambleKeyFromTitle,
  preambleKeysForTag,
  resolveTypstPreamble,
  type TypstPreambleNote
} from './typst-preamble'

const preamble = (key: string, body: string): TypstPreambleNote => ({ key, body })

describe('typst preamble resolution (#486)', () => {
  it('recognises preamble notes by their folder, at any depth', () => {
    expect(isTypstPreamblePath('inbox/typst/physics.md')).toBe(true)
    expect(isTypstPreamblePath('archive/course/typst/maths.md')).toBe(true)
    expect(isTypstPreamblePath('inbox/TYPST/physics.md')).toBe(true)
    // A note merely *named* typst is not a preamble.
    expect(isTypstPreamblePath('inbox/typst.md')).toBe(false)
    expect(isTypstPreamblePath('inbox/notes/typstish/x.md')).toBe(false)
  })

  it('walks a nested tag from broad to specific', () => {
    expect(preambleKeysForTag('physics/mechanics')).toEqual(['physics', 'physics.mechanics'])
    expect(preambleKeysForTag('physics')).toEqual(['physics'])
    expect(preambleKeysForTag('a/b/c')).toEqual(['a', 'a.b', 'a.b.c'])
    // Tags are matched case-insensitively, like everywhere else in the app.
    expect(preambleKeysForTag('Physics/Mechanics')).toEqual(['physics', 'physics.mechanics'])
    expect(preambleKeyFromTitle('  Physics.Mechanics ')).toBe('physics.mechanics')
  })

  it('prepends the matching preamble for a tag', () => {
    const out = resolveTypstPreamble(['physics'], [preamble('physics', '#let vec(x) = arrow(x)')])
    expect(out).toBe('#let vec(x) = arrow(x)')
  })

  it('layers a nested tag general → specific, so the narrower one wins', () => {
    const out = resolveTypstPreamble(
      ['physics/mechanics'],
      [
        preamble('physics', '#let unit = "SI"'),
        preamble('physics.mechanics', '#let vec(x) = arrow(x)')
      ]
    )
    expect(out).toBe('#let unit = "SI"\n#let vec(x) = arrow(x)')
  })

  it('includes each preamble once even when several tags reach it', () => {
    // Typst rejects a duplicate binding, so `physics` must not appear twice.
    const out = resolveTypstPreamble(
      ['physics', 'physics/mechanics'],
      [preamble('physics', '#let a = 1'), preamble('physics.mechanics', '#let b = 2')]
    )
    expect(out).toBe('#let a = 1\n#let b = 2')
  })

  it('orders multiple tags alphabetically, so the same tags always compile alike', () => {
    const notes = [preamble('alpha', '#let a = 1'), preamble('beta', '#let b = 2')]
    const one = resolveTypstPreamble(['beta', 'alpha'], notes)
    const other = resolveTypstPreamble(['alpha', 'beta'], notes)
    expect(one).toBe(other)
    expect(one).toBe('#let a = 1\n#let b = 2')
  })

  it('ignores tags with no preamble, and preambles no tag asks for', () => {
    expect(resolveTypstPreamble(['cooking'], [preamble('physics', '#let a = 1')])).toBe('')
    expect(resolveTypstPreamble([], [preamble('physics', '#let a = 1')])).toBe('')
    expect(resolveTypstPreamble(['physics'], [])).toBe('')
  })

  it('skips an empty preamble note rather than emitting blank lines', () => {
    const out = resolveTypstPreamble(
      ['physics/mechanics'],
      [preamble('physics', '   \n\n'), preamble('physics.mechanics', '#let b = 2')]
    )
    expect(out).toBe('#let b = 2')
  })

  it('keeps the first of two preambles claiming the same key', () => {
    const out = resolveTypstPreamble(
      ['physics'],
      [preamble('physics', '#let a = 1'), preamble('physics', '#let a = 2')]
    )
    expect(out).toBe('#let a = 1')
  })
})
