import { describe, expect, it } from 'vitest'
import { compileMatcher } from './matches'

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Compile and match, failing the test rather than the assertion when a pattern
 *  that was meant to compile did not. */
function test(pattern: string, input: string): boolean {
  const matcher = compileMatcher(pattern)
  if (!matcher.ok) throw new Error(`\`${pattern}\` did not compile: ${matcher.reason}`)
  return matcher.matches(input)
}

function reason(pattern: string): string {
  const matcher = compileMatcher(pattern)
  return matcher.ok ? '' : matcher.reason
}

/* -------------------------------------------------------------------------- */
/*  Constructs                                                                */
/* -------------------------------------------------------------------------- */

describe('literals and anchors', () => {
  it('matches anywhere by default, the way RegExp.test does', () => {
    expect(test('log', 'reading log 2026')).toBe(true)
    expect(test('log', 'nothing here')).toBe(false)
  })

  it('anchors to the ends of the whole input', () => {
    expect(test('^inbox/projects', 'inbox/projects/Compiler.md')).toBe(true)
    expect(test('^projects', 'inbox/projects/Compiler.md')).toBe(false)
    expect(test('\\.md$', 'inbox/Dune.md')).toBe(true)
    expect(test('\\.md$', 'inbox/Dune.md.bak')).toBe(false)
    expect(test('^$', '')).toBe(true)
    expect(test('^$', 'x')).toBe(false)
  })

  it('is case insensitive on both sides', () => {
    expect(test('DUNE', 'dune')).toBe(true)
    expect(test('dune', 'DUNE')).toBe(true)
    expect(test('[a-z]+', 'ABC')).toBe(true)
    expect(test('[^a-z]+', 'ABC')).toBe(false)
  })

  it('treats an astral character as one atom', () => {
    expect(test('^.$', '😀')).toBe(true)
    expect(test('^..$', '😀')).toBe(false)
  })
})

describe('character classes', () => {
  it('matches sets, ranges and negation', () => {
    expect(test('^[aeiou]+$', 'aioue')).toBe(true)
    expect(test('^[aeiou]+$', 'aixue')).toBe(false)
    expect(test('^[a-f0-9]+$', 'beef42')).toBe(true)
    expect(test('^[a-f0-9]+$', 'beefy')).toBe(false)
    expect(test('^[^/]+$', 'Dune.md')).toBe(true)
    expect(test('^[^/]+$', 'inbox/Dune.md')).toBe(false)
  })

  it('reads a trailing dash and an escaped bracket as literals', () => {
    expect(test('^[a-]+$', 'a-a')).toBe(true)
    expect(test('^[\\]]$', ']')).toBe(true)
    expect(test('^[]', '[')).toBe(false)
  })

  it('honours the shorthands inside a class', () => {
    expect(test('^[\\d.]+$', '3.14')).toBe(true)
    expect(test('^[\\d.]+$', '3,14')).toBe(false)
    expect(test('^[\\w-]+$', 'note-1_a')).toBe(true)
    expect(test('^[\\s]$', '\t')).toBe(true)
  })
})

describe('escapes', () => {
  it('covers the classes and their negations', () => {
    expect(test('^\\d+$', '2026')).toBe(true)
    expect(test('^\\D+$', '2026')).toBe(false)
    expect(test('^\\w+$', 'note_1')).toBe(true)
    expect(test('^\\W+$', '!?')).toBe(true)
    expect(test('^\\s$', ' ')).toBe(true)
    expect(test('^\\S$', ' ')).toBe(false)
  })

  it('covers punctuation and the control escapes', () => {
    expect(test('^a\\.b$', 'a.b')).toBe(true)
    expect(test('^a\\.b$', 'axb')).toBe(false)
    expect(test('^a\\/b$', 'a/b')).toBe(true)
    expect(test('^\\(\\+\\*\\?\\[\\{\\|\\^\\$\\\\\\)$', '(+*?[{|^$\\)')).toBe(true)
    expect(test('a\\nb', 'a\nb')).toBe(true)
    expect(test('a\\tb', 'a\tb')).toBe(true)
  })

  it('supports word boundaries', () => {
    expect(test('\\blog\\b', 'reading log 2026')).toBe(true)
    expect(test('\\blog\\b', 'catalogue')).toBe(false)
    expect(test('\\Blog', 'catalogue')).toBe(true)
  })
})

describe('quantifiers, alternation and groups', () => {
  it('runs the unbounded quantifiers', () => {
    expect(test('^ab*c$', 'ac')).toBe(true)
    expect(test('^ab*c$', 'abbbc')).toBe(true)
    expect(test('^ab+c$', 'ac')).toBe(false)
    expect(test('^colou?r$', 'color')).toBe(true)
    expect(test('^colou?r$', 'colour')).toBe(true)
    expect(test('^colou?r$', 'colouur')).toBe(false)
  })

  it('runs the bounded ones', () => {
    expect(test('^a{3}$', 'aaa')).toBe(true)
    expect(test('^a{3}$', 'aa')).toBe(false)
    expect(test('^a{2,}$', 'aaaa')).toBe(true)
    expect(test('^a{2,}$', 'a')).toBe(false)
    expect(test('^a{2,3}$', 'aa')).toBe(true)
    expect(test('^a{2,3}$', 'aaa')).toBe(true)
    expect(test('^a{2,3}$', 'aaaa')).toBe(false)
    expect(test('^a{0}b$', 'b')).toBe(true)
  })

  it('reads a brace that is not a bound as a literal', () => {
    expect(test('^\\{draft\\}$', '{draft}')).toBe(true)
    expect(test('^{draft}$', '{draft}')).toBe(true)
  })

  it('alternates, including an empty branch', () => {
    expect(test('^(foo|bar)baz$', 'barbaz')).toBe(true)
    expect(test('^(foo|bar)baz$', 'bazbaz')).toBe(false)
    expect(test('^(a|)$', '')).toBe(true)
  })

  it('treats a capture group as a plain group', () => {
    expect(test('^(?:ab)+$', 'ababab')).toBe(true)
    expect(test('^(ab)+$', 'ababab')).toBe(true)
    expect(test('^((a|b)c)+$', 'acbc')).toBe(true)
  })

  it('accepts a lazy quantifier and answers the same boolean', () => {
    expect(test('^a+?b$', 'aab')).toBe(true)
    expect(test('a??b', 'b')).toBe(true)
  })

  it('terminates on a quantified group that can match nothing', () => {
    expect(test('^(a*)*$', 'aaa')).toBe(true)
    expect(test('^(a*)*b$', 'aaa')).toBe(false)
    expect(test('^(|a)*$', '')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  Agreement with RegExp                                                     */
/* -------------------------------------------------------------------------- */

// Every pattern here is one a backtracker answers quickly, so the two engines
// can be compared directly. The point is not that the subset is complete, it is
// that inside the subset nothing quietly means something else.
describe('differential against RegExp', () => {
  const PATTERNS = [
    'log',
    '^inbox/projects',
    '\\.md$',
    '^$',
    'a.c',
    '^a{2,3}b$',
    'colou?r',
    '(foo|bar)baz',
    '^(?:ab)+$',
    '[a-f0-9]+',
    '[^aeiou]{3}',
    '\\d+\\.\\d+',
    '^[A-Z][a-z]*$',
    '\\bword\\b',
    '\\Bword',
    '^.*$',
    '^\\w+-\\d{4}$',
    '^(a|b)*c$',
    '[\\s]+$',
    '^\\[\\[.+\\]\\]$',
    '2026-\\d{2}-\\d{2}',
    '^(?:draft|wip)[- ]'
  ]

  const INPUTS = [
    '',
    'log',
    'Reading Log',
    'inbox/projects/Compiler.md',
    'Dune.md',
    'a.c',
    'abc',
    'aabb',
    'color',
    'colour',
    'barbaz',
    'ababab',
    'beef42',
    '3.14',
    'word',
    'catalogue',
    'a word here',
    'Meeting 2026-07-28',
    '[[Dune]]',
    'draft-plan',
    'WIP note',
    'trailing   ',
    'multi\nline',
    'ÀÉÎ'
  ]

  it('answers what RegExp answers on patterns both engines can run', () => {
    for (const pattern of PATTERNS) {
      const matcher = compileMatcher(pattern)
      expect(matcher.ok, `\`${pattern}\` did not compile`).toBe(true)
      if (!matcher.ok) continue
      const native = new RegExp(pattern, 'i')
      for (const input of INPUTS) {
        expect(matcher.matches(input), `\`${pattern}\` against \`${input}\``).toBe(
          native.test(input)
        )
      }
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  The bound the whole module exists for                                     */
/* -------------------------------------------------------------------------- */

describe('running time', () => {
  it('answers a pattern that hangs a backtracker, in milliseconds', () => {
    // `^(a+)+$` against a run of `a` and one character that cannot match is the
    // textbook exponential case: RegExp takes minutes at this length.
    const matcher = compileMatcher('^(a+)+$')
    expect(matcher.ok).toBe(true)
    if (!matcher.ok) return
    const started = Date.now()
    expect(matcher.matches('a'.repeat(60))).toBe(true)
    expect(matcher.matches(`${'a'.repeat(60)}!`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('stays linear on nested quantifiers over a long input', () => {
    const matcher = compileMatcher('^(a|aa)+$')
    expect(matcher.ok).toBe(true)
    if (!matcher.ok) return
    const started = Date.now()
    expect(matcher.matches(`${'a'.repeat(2000)}b`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                  */
/* -------------------------------------------------------------------------- */

describe('unsupported constructs', () => {
  it('refuses backreferences', () => {
    expect(reason('(a)\\1')).toBe('backreferences are not supported')
    expect(reason('[\\1]')).toBe('backreferences are not supported')
  })

  it('refuses lookaround', () => {
    expect(reason('a(?=b)')).toBe('lookahead is not supported')
    expect(reason('a(?!b)')).toBe('lookahead is not supported')
    expect(reason('(?<=a)b')).toBe('lookbehind is not supported')
    expect(reason('(?<!a)b')).toBe('lookbehind is not supported')
  })

  it('refuses named groups and inline flags', () => {
    expect(reason('(?<name>a)')).toBe('named groups are not supported')
    expect(reason('(?i)abc')).toBe('inline flags are not supported')
  })

  it('refuses an escape outside the subset', () => {
    expect(reason('\\p{L}')).toBe('\\p is not a supported escape')
    expect(reason('\\x41')).toBe('\\x is not a supported escape')
  })

  it('refuses a repeat big enough to be an expansion attack', () => {
    expect(reason('a{101}')).toContain('more than 100')
    expect(reason('a{1,5000}')).toContain('more than 100')
    expect(reason('(((a{100}){100}){100})')).toBe('the pattern is too large')
  })

  it('refuses the malformed patterns RegExp also refuses', () => {
    expect(reason('[unclosed')).toBe('a character class was never closed')
    expect(reason('(unclosed')).toBe('a group was never closed')
    expect(reason('unmatched)')).toBe('an unmatched `)`')
    expect(reason('trailing\\')).toBe('a pattern may not end in a backslash')
    expect(reason('*nothing')).toBe('`*` has nothing to repeat')
    expect(reason('a**')).toBe('a quantifier has nothing to repeat')
    expect(reason('a{3,1}')).toBe('a repeat counts down')
    expect(reason('[z-a]')).toBe('a character range runs backwards')
    expect(reason('[a-\\d]')).toBe('a character range cannot end in a class like \\d')
  })

  it('refuses a pattern nested past the recursion cap', () => {
    expect(reason(`${'('.repeat(200)}a${')'.repeat(200)}`)).toBe('the pattern nests too deeply')
  })
})
