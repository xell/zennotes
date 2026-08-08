// The `matches` operator, compiled to an automaton instead of a regex.
//
// `where title matches ^(a+)+$` is a line an author can type, and one that can
// arrive inside a shared workflow file. Answered with `new RegExp(...).test()`
// it backtracks: a title of forty-odd characters holds the caller for most of a
// minute, and the caller is the renderer, which plans a workflow the moment one
// is selected. A pattern was therefore a way to freeze the window.
//
// Thompson construction removes the class of problem rather than the instance.
// The pattern becomes a state machine; the machine is simulated over the input
// once with every reachable state advanced in lockstep; a state is visited at
// most once per position. Matching costs O(pattern x input) for EVERY pattern,
// with no input that behaves differently from any other, so there is nothing
// left to craft.
//
// The price is a smaller language, and the subset is chosen deliberately: it is
// what Go's regexp package (RE2) can also run, because `types.ts` promises this
// layer will be mirrored in Go and both engines have to agree about which
// workflows are valid. Backreferences and lookaround are the two things no
// automaton can do, so they are compile errors here rather than silent
// mistranslations later, and the engine reports them exactly the way it has
// always reported an unparseable pattern.
//
// Everything is case-insensitive, because `matches` has always been compiled
// with the `i` flag and a stricter operator would change what existing
// workflows select.

/* -------------------------------------------------------------------------- */
/*  Public shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A compiled pattern, or the reason it could not be compiled.
 *
 * A result rather than a throw: the engine turns `reason` into a diagnostic and
 * carries on planning, which is rule 1 of the module it is called from.
 */
export type Matcher =
  | { ok: true; matches: (input: string) => boolean }
  | { ok: false; reason: string }

/** Largest bounded repeat. `{m,n}` compiles by copying the sub-pattern, so a
 *  four-digit count is refused rather than expanded. */
const MAX_REPEAT = 100

/** Ceiling on the machine one pattern may build. Bounded repeats multiply, and
 *  `(a{100}){100}` would otherwise allocate ten thousand states before anyone
 *  typed a note title. */
const MAX_STATES = 4000

/** How deep groups may nest, which is how deep this module's own recursion
 *  goes. Well past anything hand-written, well short of a stack overflow. */
const MAX_GROUP_DEPTH = 100

export function compileMatcher(pattern: string): Matcher {
  try {
    const { program, start } = compile(parsePattern(pattern))
    return { ok: true, matches: (input: string) => simulate(program, start, input) }
  } catch (error) {
    if (error instanceof PatternError) return { ok: false, reason: error.message }
    throw error
  }
}

/** Thrown only inside this module, and only through `compileMatcher`, which is
 *  where every one of them turns back into a reason string. */
class PatternError extends Error {}

/* -------------------------------------------------------------------------- */
/*  The pattern, as a tree                                                    */
/* -------------------------------------------------------------------------- */

type Shorthand = 'digit' | 'not-digit' | 'word' | 'not-word' | 'space' | 'not-space'

/**
 * One code point's worth of pattern: a literal, a class, or `.`, all in the one
 * shape so that case folding and negation have a single implementation.
 */
interface CharSet {
  negated: boolean
  ranges: Array<readonly [number, number]>
  shorthands: Shorthand[]
}

type Assertion = 'start' | 'end' | 'word-boundary' | 'not-word-boundary'

type Node =
  | { type: 'empty' }
  | { type: 'set'; set: CharSet }
  | { type: 'concat'; parts: Node[] }
  | { type: 'alt'; options: Node[] }
  | { type: 'repeat'; body: Node; min: number; max: number }
  | { type: 'assert'; at: Assertion }

/** `.` is everything but a line terminator, matching what RegExp does without
 *  the `s` flag, so a pattern moved from one engine to the other keeps its
 *  meaning on a multi-line body. */
const DOT: CharSet = {
  negated: true,
  ranges: [
    [0x0a, 0x0a],
    [0x0d, 0x0d],
    [0x2028, 0x2029]
  ],
  shorthands: []
}

function literal(cp: number): Node {
  return { type: 'set', set: { negated: false, ranges: [[cp, cp]], shorthands: [] } }
}

function shorthandNode(name: Shorthand): Node {
  return { type: 'set', set: { negated: false, ranges: [], shorthands: [name] } }
}

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                   */
/* -------------------------------------------------------------------------- */

function parsePattern(pattern: string): Node {
  // One entry per code point, so an astral character is one atom rather than a
  // surrogate pair that a quantifier could tear in half.
  const chars = Array.from(pattern)
  let at = 0
  let depth = 0

  const peek = (offset = 0): string => chars[at + offset] ?? ''
  const read = (): string => chars[at++] ?? ''
  const eat = (char: string): boolean => {
    if (peek() !== char) return false
    at += 1
    return true
  }

  function parseAlternation(): Node {
    const options: Node[] = [parseConcat()]
    while (eat('|')) options.push(parseConcat())
    return options.length === 1 ? options[0] : { type: 'alt', options }
  }

  function parseConcat(): Node {
    const parts: Node[] = []
    while (at < chars.length && peek() !== '|' && peek() !== ')') parts.push(parseRepeat())
    if (parts.length === 0) return { type: 'empty' }
    return parts.length === 1 ? parts[0] : { type: 'concat', parts }
  }

  function parseRepeat(): Node {
    const body = parseAtom()
    const bound = readQuantifier()
    if (!bound) return body
    // `*?` and friends only decide which match a backtracker prefers, and a
    // boolean answer does not depend on that, so the lazy marker is consumed
    // and ignored. A second real quantifier is the "nothing to repeat" error.
    eat('?')
    if (readQuantifier()) throw new PatternError('a quantifier has nothing to repeat')
    return { type: 'repeat', body, min: bound.min, max: bound.max }
  }

  function parseAtom(): Node {
    const char = read()
    switch (char) {
      case '(':
        return parseGroup()
      case '[':
        return { type: 'set', set: parseClass() }
      case '.':
        return { type: 'set', set: DOT }
      case '^':
        return { type: 'assert', at: 'start' }
      case '$':
        return { type: 'assert', at: 'end' }
      case '\\':
        return parseEscape()
      case '*':
      case '+':
      case '?':
        throw new PatternError(`\`${char}\` has nothing to repeat`)
      default:
        return literal(char.codePointAt(0) as number)
    }
  }

  /**
   * Every group is a plain group. A capture is not refused, it is simply not
   * captured: the answer this operator gives is a boolean, so there is nothing
   * for a capture to be read by, and treating `(a|b)` as `(?:a|b)` is what lets
   * an ordinary pattern keep working.
   */
  function parseGroup(): Node {
    if (peek() === '?') {
      const marker = peek(1)
      if (marker === ':') {
        at += 2
      } else if (marker === '=' || marker === '!') {
        throw new PatternError('lookahead is not supported')
      } else if (marker === '<' && (peek(2) === '=' || peek(2) === '!')) {
        throw new PatternError('lookbehind is not supported')
      } else if (marker === '<') {
        throw new PatternError('named groups are not supported')
      } else {
        throw new PatternError('inline flags are not supported')
      }
    }
    // Both the parser and the emitter walk a group by recursing, so the nesting
    // is capped rather than left to run the JavaScript stack out from under a
    // module whose first rule is that nothing throws.
    depth += 1
    if (depth > MAX_GROUP_DEPTH) throw new PatternError('the pattern nests too deeply')
    const inner = parseAlternation()
    depth -= 1
    if (!eat(')')) throw new PatternError('a group was never closed')
    return inner
  }

  function parseEscape(): Node {
    const char = read()
    if (!char) throw new PatternError('a pattern may not end in a backslash')
    if (char >= '1' && char <= '9') throw new PatternError('backreferences are not supported')
    switch (char) {
      case 'b':
        return { type: 'assert', at: 'word-boundary' }
      case 'B':
        return { type: 'assert', at: 'not-word-boundary' }
      default: {
        const set = escapedSet(char)
        if (set) return { type: 'set', set }
        return literal(escapedCodePoint(char))
      }
    }
  }

  /** `[abc]`, `[^a-z]`, `[\d-]`. An immediate `]` closes an empty class, the
   *  way RegExp reads it: `[]` matches nothing and `[^]` matches anything. */
  function parseClass(): CharSet {
    const negated = eat('^')
    const ranges: Array<readonly [number, number]> = []
    const shorthands: Shorthand[] = []
    for (;;) {
      if (at >= chars.length) throw new PatternError('a character class was never closed')
      if (eat(']')) break
      const item = readClassItem()
      if (typeof item !== 'number') {
        shorthands.push(item)
        continue
      }
      // A `-` before the closing bracket is a literal dash, not a range that
      // lost its end.
      if (peek() === '-' && peek(1) !== ']' && peek(1) !== '') {
        at += 1
        const upper = readClassItem()
        if (typeof upper !== 'number') {
          throw new PatternError('a character range cannot end in a class like \\d')
        }
        if (upper < item) throw new PatternError('a character range runs backwards')
        ranges.push([item, upper])
        continue
      }
      ranges.push([item, item])
    }
    return { negated, ranges, shorthands }
  }

  /** One member of a class: a code point, or the shorthand it names. */
  function readClassItem(): number | Shorthand {
    const char = read()
    if (char !== '\\') return char.codePointAt(0) as number
    const escaped = read()
    if (!escaped) throw new PatternError('a pattern may not end in a backslash')
    if (escaped >= '1' && escaped <= '9') {
      throw new PatternError('backreferences are not supported')
    }
    const set = escapedSet(escaped)
    if (set) return set.shorthands[0]
    return escapedCodePoint(escaped)
  }

  function readQuantifier(): { min: number; max: number } | null {
    const char = peek()
    if (char === '*') {
      at += 1
      return { min: 0, max: Infinity }
    }
    if (char === '+') {
      at += 1
      return { min: 1, max: Infinity }
    }
    if (char === '?') {
      at += 1
      return { min: 0, max: 1 }
    }
    if (char !== '{') return null
    // A `{` that does not spell a bound is a literal brace, which is how
    // RegExp reads it too, so `matches ^{draft}` keeps meaning what it says.
    let scan = at + 1
    let lower = ''
    while (isDigit(chars[scan])) lower += chars[scan++]
    if (!lower) return null
    let upper = lower
    if (chars[scan] === ',') {
      scan += 1
      let digits = ''
      while (isDigit(chars[scan])) digits += chars[scan++]
      upper = digits
    }
    if (chars[scan] !== '}') return null
    at = scan + 1
    const min = Number(lower)
    const max = upper === '' ? Infinity : Number(upper)
    if (max < min) throw new PatternError('a repeat counts down')
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
      throw new PatternError(`a repeat of more than ${MAX_REPEAT} is not supported`)
    }
    return { min, max }
  }

  const parsed = parseAlternation()
  if (at < chars.length) throw new PatternError('an unmatched `)`')
  return parsed
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function escapedSet(char: string): CharSet | null {
  const name = SHORTHANDS[char]
  if (!name) return null
  return { negated: false, ranges: [], shorthands: [name] }
}

const SHORTHANDS: Record<string, Shorthand | undefined> = {
  d: 'digit',
  D: 'not-digit',
  w: 'word',
  W: 'not-word',
  s: 'space',
  S: 'not-space'
}

const CONTROL_ESCAPES: Record<string, number | undefined> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b
}

/**
 * What `\<char>` stands for when it is not a class.
 *
 * Escaped punctuation is the character itself, which covers every one of
 * `. \ / + * ? ( ) [ ] { } | ^ $`. An escaped letter or digit that reached here
 * is one this subset does not know (`\p{L}`, `\k<name>`, `\xNN`), and it is
 * refused rather than read as the bare letter, because reading `\x41` as three
 * literal characters is the kind of silent divergence that makes a pattern
 * behave one way here and another way in a Go runtime.
 */
function escapedCodePoint(char: string): number {
  const control = CONTROL_ESCAPES[char]
  if (control !== undefined) return control
  if (/[0-9A-Za-z]/.test(char)) throw new PatternError(`\\${char} is not a supported escape`)
  return char.codePointAt(0) as number
}

/* -------------------------------------------------------------------------- */
/*  Compiling to a program                                                    */
/* -------------------------------------------------------------------------- */

interface SplitInst {
  op: 'split'
  next: number
  alt: number
}

type Inst =
  | { op: 'set'; set: CharSet; next: number }
  | SplitInst
  | { op: 'assert'; at: Assertion; next: number }
  | { op: 'match' }

/**
 * Emit the tree backwards, from the instruction each node falls through to.
 *
 * Building from the end means a node's successor is already known when the node
 * is written, so nothing has to be patched afterwards. The one exception is a
 * star, whose loop points back at itself: it reserves its split first and fills
 * in the entry once its body has been emitted.
 */
function compile(node: Node): { program: Inst[]; start: number } {
  const program: Inst[] = []

  const push = (inst: Inst): number => {
    if (program.length >= MAX_STATES) throw new PatternError('the pattern is too large')
    program.push(inst)
    return program.length - 1
  }

  const emit = (current: Node, next: number): number => {
    switch (current.type) {
      case 'empty':
        return next
      case 'set':
        return push({ op: 'set', set: current.set, next })
      case 'assert':
        return push({ op: 'assert', at: current.at, next })
      case 'concat': {
        let pc = next
        for (let index = current.parts.length - 1; index >= 0; index -= 1) {
          pc = emit(current.parts[index], pc)
        }
        return pc
      }
      case 'alt': {
        let pc = emit(current.options[current.options.length - 1], next)
        for (let index = current.options.length - 2; index >= 0; index -= 1) {
          const branch = emit(current.options[index], next)
          pc = push({ op: 'split', next: branch, alt: pc })
        }
        return pc
      }
      case 'repeat': {
        let pc = next
        if (current.max === Infinity) {
          const loop: SplitInst = { op: 'split', next: 0, alt: next }
          const entry = push(loop)
          loop.next = emit(current.body, entry)
          pc = entry
        } else {
          for (let index = current.min; index < current.max; index += 1) {
            const branch = emit(current.body, pc)
            pc = push({ op: 'split', next: branch, alt: pc })
          }
        }
        for (let index = 0; index < current.min; index += 1) pc = emit(current.body, pc)
        return pc
      }
    }
  }

  const match = push({ op: 'match' })
  return { program, start: emit(node, match) }
}

/* -------------------------------------------------------------------------- */
/*  Simulating it                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run the program over the input, advancing every reachable state together.
 *
 * The list of live states is rebuilt once per position and a state can enter it
 * once, which is the whole guarantee: the work is bounded by states x positions
 * no matter what the pattern looks like or what the input is.
 */
function simulate(program: Inst[], start: number, input: string): boolean {
  const cps: number[] = []
  for (const char of input) cps.push(char.codePointAt(0) as number)

  // `marks[i] === gen` means state i is already in the list being built. One
  // stamp per list rather than a fresh array per position.
  const marks = new Int32Array(program.length)
  let gen = 0
  let matched = false
  const stack: number[] = []

  const add = (list: number[], pc: number, pos: number): void => {
    stack.length = 0
    stack.push(pc)
    while (stack.length > 0) {
      const index = stack.pop() as number
      if (marks[index] === gen) continue
      marks[index] = gen
      const inst = program[index]
      if (inst.op === 'split') {
        stack.push(inst.alt)
        stack.push(inst.next)
      } else if (inst.op === 'assert') {
        if (holds(inst.at, cps, pos)) stack.push(inst.next)
      } else if (inst.op === 'match') {
        matched = true
      } else {
        list.push(index)
      }
    }
  }

  gen += 1
  let live: number[] = []
  add(live, start, 0)

  for (let pos = 0; pos < cps.length && !matched; pos += 1) {
    gen += 1
    const next: number[] = []
    const cp = cps[pos]
    for (const index of live) {
      const inst = program[index]
      if (inst.op === 'set' && matchesSet(inst.set, cp)) add(next, inst.next, pos + 1)
    }
    // Unanchored, the way `RegExp.test` is: a match may begin anywhere, so a
    // fresh copy of the machine joins the simulation at every position. `^` is
    // what stops that mattering, since it only holds at position zero.
    add(next, start, pos + 1)
    live = next
  }

  return matched
}

function holds(assertion: Assertion, cps: number[], pos: number): boolean {
  switch (assertion) {
    case 'start':
      return pos === 0
    case 'end':
      return pos === cps.length
    case 'word-boundary':
      return isWordCp(cps[pos - 1]) !== isWordCp(cps[pos])
    case 'not-word-boundary':
      return isWordCp(cps[pos - 1]) === isWordCp(cps[pos])
  }
}

/* -------------------------------------------------------------------------- */
/*  Character membership                                                      */
/* -------------------------------------------------------------------------- */

function matchesSet(set: CharSet, cp: number): boolean {
  let hit = false
  for (const [lower, upper] of set.ranges) {
    if (inRange(lower, upper, cp)) {
      hit = true
      break
    }
  }
  if (!hit) {
    for (const name of set.shorthands) {
      if (matchesShorthand(name, cp)) {
        hit = true
        break
      }
    }
  }
  return set.negated ? !hit : hit
}

/**
 * A range, tried against the code point and against both of its cases.
 *
 * Folding the range itself would be the obvious move and it is wrong: `[A-_]`
 * lowercased has an upper bound below its lower one, and the range silently
 * stops matching anything. Folding the input is what stays correct for every
 * range someone can write.
 */
function inRange(lower: number, upper: number, cp: number): boolean {
  if (cp >= lower && cp <= upper) return true
  const lowered = otherCase(cp, 'lower')
  if (lowered !== cp && lowered >= lower && lowered <= upper) return true
  const raised = otherCase(cp, 'upper')
  return raised !== cp && raised >= lower && raised <= upper
}

/** The other case of one code point, or the code point itself when the mapping
 *  is not one to one (`ß` uppercases to two letters, which no range holds). */
function otherCase(cp: number, to: 'lower' | 'upper'): number {
  const char = String.fromCodePoint(cp)
  const folded = to === 'lower' ? char.toLowerCase() : char.toUpperCase()
  const cps = Array.from(folded)
  return cps.length === 1 ? (cps[0].codePointAt(0) as number) : cp
}

/** RegExp's `\s`: the unicode space separators plus the ASCII whitespace and
 *  the byte order mark. */
const SPACE_CPS = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff
])

function matchesShorthand(name: Shorthand, cp: number): boolean {
  switch (name) {
    case 'digit':
      return isDigitCp(cp)
    case 'not-digit':
      return !isDigitCp(cp)
    case 'word':
      return isWordCp(cp)
    case 'not-word':
      return !isWordCp(cp)
    case 'space':
      return SPACE_CPS.has(cp)
    case 'not-space':
      return !SPACE_CPS.has(cp)
  }
}

function isDigitCp(cp: number | undefined): boolean {
  return cp !== undefined && cp >= 0x30 && cp <= 0x39
}

function isWordCp(cp: number | undefined): boolean {
  if (cp === undefined) return false
  if (isDigitCp(cp)) return true
  if (cp >= 0x41 && cp <= 0x5a) return true
  if (cp >= 0x61 && cp <= 0x7a) return true
  return cp === 0x5f
}
