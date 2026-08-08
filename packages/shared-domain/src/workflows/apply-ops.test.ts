import { describe, expect, it } from 'vitest'
import { TEXT_OP_KINDS, applyTextOp, isTextOp } from './apply-ops'
import { parseFrontmatter } from '../template-files'
import type { WorkflowOp } from './types'

/**
 * These are the semantics of "applying a workflow", stated without a
 * filesystem. Anything that is true here is true of a run, which is the point
 * of the ops being pure text transforms: the risky part of the feature is
 * testable at this level, and the applier above only has to be right about
 * files, not about markdown.
 *
 * Two properties get exercised repeatedly rather than stated once, because they
 * are what the trust model rests on:
 *
 *   - idempotence: workflows fire on events and on a schedule, so every op runs
 *     twice sooner or later, and a note that grows each time is a corrupted note
 *   - identity: a no-op returns `before` itself, so the applier can skip the
 *     write and keep the undo journal down to what actually changed
 */

const PATH = 'inbox/Note.md'

/* --- one helper per op, so the tests read as semantics not as op literals --- */

function run(before: string, op: WorkflowOp): string {
  const after = applyTextOp(before, op)
  if (after === null) throw new Error(`expected ${op.kind} to be a text op`)
  return after
}

const setField = (before: string, field: string, value: string): string =>
  run(before, { kind: 'set-frontmatter', path: PATH, field, value })

const addTag = (before: string, tag: string): string =>
  run(before, { kind: 'add-tag', path: PATH, tag })

const removeTag = (before: string, tag: string): string =>
  run(before, { kind: 'remove-tag', path: PATH, tag })

const append = (before: string, text: string): string =>
  run(before, { kind: 'append', path: PATH, text })

const prepend = (before: string, text: string): string =>
  run(before, { kind: 'prepend', path: PATH, text })

const writeSection = (before: string, heading: string, text: string): string =>
  run(before, { kind: 'write-section', path: PATH, heading, text })

const writeNote = (before: string, text: string): string =>
  run(before, { kind: 'write-note', path: PATH, text })

const createNote = (before: string, body: string): string =>
  run(before, { kind: 'create-note', path: PATH, body })

const applyTemplate = (before: string, template: string): string =>
  run(before, { kind: 'apply-template', path: PATH, template })

/* -------------------------------------------------------------------------- */
/*  What is and is not a text op                                              */
/* -------------------------------------------------------------------------- */

describe('text op classification', () => {
  const NON_TEXT: WorkflowOp[] = [
    { kind: 'move', path: PATH, to: 'archive' },
    { kind: 'rename', path: PATH, to: 'Other.md' },
    { kind: 'archive', path: PATH },
    { kind: 'trash', path: PATH },
    { kind: 'notify', message: 'done' },
    { kind: 'clipboard', text: 'copied' }
  ]

  for (const op of NON_TEXT) {
    it(`\`${op.kind}\` is not a text op`, () => {
      expect(applyTextOp('anything', op)).toBeNull()
      expect(isTextOp(op)).toBe(false)
    })
  }

  it('every text op kind is recognized by isTextOp', () => {
    const ops: WorkflowOp[] = [
      { kind: 'set-frontmatter', path: PATH, field: 'a', value: 'b' },
      { kind: 'add-tag', path: PATH, tag: 'x' },
      { kind: 'remove-tag', path: PATH, tag: 'x' },
      { kind: 'append', path: PATH, text: 'x' },
      { kind: 'prepend', path: PATH, text: 'x' },
      { kind: 'write-section', path: PATH, heading: 'H', text: 'x' },
      { kind: 'write-note', path: PATH, text: 'x' },
      { kind: 'create-note', path: PATH, body: 'x' },
      { kind: 'apply-template', path: PATH, template: 'x' }
    ]
    expect(ops.map((op) => op.kind).sort()).toEqual([...TEXT_OP_KINDS].sort())
    for (const op of ops) {
      expect(isTextOp(op)).toBe(true)
      expect(applyTextOp('', op)).not.toBeNull()
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  set-frontmatter                                                           */
/* -------------------------------------------------------------------------- */

describe('set-frontmatter', () => {
  it('updates an existing key in place', () => {
    const before = '---\ntitle: Dune\nrating: 3\n---\n\nBody text.\n'
    expect(setField(before, 'rating', '5')).toBe(
      '---\ntitle: Dune\nrating: 5\n---\n\nBody text.\n'
    )
  })

  it('preserves key order when updating', () => {
    const before = '---\na: 1\nb: 2\nc: 3\n---\n'
    const { data } = parseFrontmatter(setField(before, 'b', 'two'))
    expect(Object.keys(data)).toEqual(['a', 'b', 'c'])
  })

  it('appends a new key at the end of the block', () => {
    const before = '---\ntitle: Dune\n---\nBody\n'
    expect(setField(before, 'rating', '5')).toBe('---\ntitle: Dune\nrating: 5\n---\nBody\n')
  })

  it('creates a block when the note has none', () => {
    expect(setField('Just a body.\n', 'status', 'done')).toBe(
      '---\nstatus: done\n---\nJust a body.\n'
    )
  })

  it('creates a block for an empty file', () => {
    expect(setField('', 'status', 'done')).toBe('---\nstatus: done\n---\n')
  })

  it('leaves the body byte for byte, including trailing whitespace', () => {
    const body = '\n# Heading\n\n  indented  \n\n\n\ttabbed\n'
    const before = `---\na: 1\n---${body}`
    expect(setField(before, 'a', '2')).toBe(`---\na: 2\n---${body}`)
  })

  it('leaves unrelated lines in the block untouched, including comments', () => {
    const before = '---\n# a comment\ntags:\n  - book\nrating: 1\n---\n'
    expect(setField(before, 'rating', '4')).toBe(
      '---\n# a comment\ntags:\n  - book\nrating: 4\n---\n'
    )
  })

  it('replaces a block list with the scalar it was asked to set', () => {
    const before = '---\ntags:\n  - book\n  - read\nrating: 1\n---\nBody\n'
    expect(setField(before, 'tags', 'book')).toBe('---\ntags: book\nrating: 1\n---\nBody\n')
  })

  it('replaces a block list that sits at the foot of the block', () => {
    const before = '---\nrating: 1\ntags:\n  - book\n  - read\n---\nBody\n'
    expect(setField(before, 'tags', 'book')).toBe('---\nrating: 1\ntags: book\n---\nBody\n')
  })

  it('appends after a block list without disturbing it', () => {
    const before = '---\ntags:\n  - book\n---\nBody\n'
    const after = setField(before, 'rating', '5')
    expect(after).toBe('---\ntags:\n  - book\nrating: 5\n---\nBody\n')
    expect(parseFrontmatter(after).data.rating).toBe('5')
  })

  it('rewrites every duplicate of the key, since the last one wins on read', () => {
    const before = '---\nstatus: open\nstatus: done\n---\n'
    const after = setField(before, 'status', 'blocked')
    expect(after).toBe('---\nstatus: blocked\nstatus: blocked\n---\n')
    expect(parseFrontmatter(after).data.status).toBe('blocked')
  })

  it('matches the key the way parseFrontmatter does, indentation and all', () => {
    const before = '---\n  rating : 1\n---\n'
    expect(setField(before, 'rating', '5')).toBe('---\nrating: 5\n---\n')
  })

  it('keeps a CRLF file on CRLF', () => {
    const before = '---\r\ntitle: Dune\r\n---\r\nBody\r\n'
    expect(setField(before, 'rating', '5')).toBe(
      '---\r\ntitle: Dune\r\nrating: 5\r\n---\r\nBody\r\n'
    )
  })

  it('is a no-op, byte for byte, when the value is already set', () => {
    const before = '---\nrating: 5\n---\nBody\n'
    expect(setField(before, 'rating', '5')).toBe(before)
  })

  it('refuses a key that could not be read back', () => {
    const before = '---\na: 1\n---\n'
    expect(setField(before, 'a: b', 'x')).toBe(before)
    expect(setField(before, '', 'x')).toBe(before)
    expect(setField(before, 'two\nlines', 'x')).toBe(before)
  })

  it('applied twice is applied once', () => {
    const before = '---\ntitle: Dune\n---\nBody\n'
    const once = setField(before, 'rating', '5')
    expect(setField(once, 'rating', '5')).toBe(once)
  })

  const ROUND_TRIP: Array<[string, string]> = [
    ['plain', 'done'],
    ['spaces inside', 'in progress'],
    ['a colon', 'ratio 2:1'],
    ['a hash', '#starred'],
    ['edge whitespace', '  padded  '],
    ['empty', ''],
    ['a double quote', 'he said "hi"'],
    ['an apostrophe', "it's fine"],
    ['a leading dash', '- not a list'],
    ['brackets', '[not, an, array]'],
    ['already quoted', '"quoted"'],
    ['a date', '2026-07-28'],
    ['unicode', 'café ☕']
  ]

  for (const [label, value] of ROUND_TRIP) {
    it(`round-trips a value with ${label} through parseFrontmatter`, () => {
      const after = setField('---\ntitle: Dune\n---\nBody\n', 'field', value)
      const parsed = parseFrontmatter(after)
      expect(parsed.data.field).toBe(value)
      // The rest of the note has to survive the quoting too.
      expect(parsed.data.title).toBe('Dune')
      expect(parsed.body).toBe('Body\n')
    })
  }

  it('keeps a multi-line value on one line so the block cannot break', () => {
    const after = setField('---\ntitle: Dune\n---\nBody\n', 'note', 'line one\nline two')
    const parsed = parseFrontmatter(after)
    expect(parsed.body).toBe('Body\n')
    expect(parsed.data.title).toBe('Dune')
    // Escaped rather than round-tripped: parseFrontmatter unquotes but does not
    // unescape. The contract that matters is that the block stays parseable.
    expect(parsed.data.note).not.toContain('\n')
    // `---`, title, note, `---`, `Body`, and the empty string after the last
    // newline: the value did not open a sixth line inside the block.
    expect(after.split('\n')).toHaveLength(6)
  })
})

/* -------------------------------------------------------------------------- */
/*  add-tag                                                                   */
/* -------------------------------------------------------------------------- */

describe('add-tag', () => {
  it('appends the tag on its own line', () => {
    expect(addTag('Some notes.\n', 'book')).toBe('Some notes.\n#book\n')
  })

  it('tags an empty note', () => {
    expect(addTag('', 'book')).toBe('#book')
  })

  it('adds below the frontmatter, never inside it', () => {
    const after = addTag('---\ntitle: Dune\n---\n\nBody\n', 'book')
    expect(after).toBe('---\ntitle: Dune\n---\n\nBody\n#book\n')
    expect(parseFrontmatter(after).data.title).toBe('Dune')
  })

  it('is idempotent: adding a tag that is already there changes nothing', () => {
    const before = 'Reading #book tonight.\n'
    expect(addTag(before, 'book')).toBe(before)
  })

  it('applying it twice equals applying it once', () => {
    const before = 'Some notes.\n'
    const once = addTag(before, 'book')
    expect(addTag(once, 'book')).toBe(once)
  })

  it('ignores a `#` that is not a tag boundary', () => {
    // `me#book` is not a tag, so the note is genuinely untagged.
    expect(addTag('mailto:me#book\n', 'book')).toBe('mailto:me#book\n#book\n')
  })

  it('does not count a tag inside a fenced code block', () => {
    const before = 'Intro\n\n```c\n#include <stdio.h>\n#book\n```\n'
    expect(addTag(before, 'book')).toBe(`${before}#book\n`)
  })

  it('does not count a tag inside an indented fence', () => {
    const before = '- item\n\n  ```\n  #book\n  ```\n'
    expect(addTag(before, 'book')).toBe(`${before}#book\n`)
  })

  it('does not count a tag inside an inline code span', () => {
    const before = 'Type `#book` to tag it.\n'
    expect(addTag(before, 'book')).toBe(`${before}#book\n`)
  })

  it('does not count a `#book` written inside the frontmatter', () => {
    const before = '---\nsummary: about #book stuff\n---\nBody\n'
    expect(addTag(before, 'book')).toBe('---\nsummary: about #book stuff\n---\nBody\n#book\n')
  })

  it('treats a differently cased tag as the same tag', () => {
    const before = 'Reading #Book tonight.\n'
    expect(addTag(before, 'book')).toBe(before)
  })

  it('treats a hierarchical tag as distinct from its parent', () => {
    const before = 'Work on #project/compiler today.\n'
    expect(addTag(before, 'project')).toBe(`${before}#project\n`)
    expect(addTag(before, 'project/compiler')).toBe(before)
  })

  it('accepts a tag written with its hash', () => {
    expect(addTag('Body\n', '#book')).toBe('Body\n#book\n')
  })

  it('refuses to write something that would not read back as a tag', () => {
    const before = 'Body\n'
    expect(addTag(before, '123')).toBe(before)
    expect(addTag(before, 'two words')).toBe(before)
    expect(addTag(before, '')).toBe(before)
  })

  it('keeps a note that ended mid-line ending mid-line', () => {
    expect(addTag('No trailing newline', 'book')).toBe('No trailing newline\n#book')
  })

  it('refuses a note that ends inside an unclosed fence', () => {
    // The end of that file is code, so the tag would not read back as a tag and
    // every run would append another one. Doing nothing is the safe direction.
    const before = 'Intro\n\n```\nnot closed\n'
    expect(addTag(before, 'book')).toBe(before)
  })

  it('does not open a third blank line at the end', () => {
    expect(addTag('Body\n\n\n\n', 'book')).toBe('Body\n\n#book\n')
  })
})

/* -------------------------------------------------------------------------- */
/*  remove-tag                                                                */
/* -------------------------------------------------------------------------- */

describe('remove-tag', () => {
  it('removes an inline tag and the space it used', () => {
    expect(removeTag('Reading #book tonight.\n', 'book')).toBe('Reading tonight.\n')
  })

  it('removes a trailing tag without leaving trailing whitespace', () => {
    expect(removeTag('Reading tonight #book\n', 'book')).toBe('Reading tonight\n')
  })

  it('removes a leading tag without leaving leading whitespace', () => {
    expect(removeTag('#book is the plan\n', 'book')).toBe('is the plan\n')
  })

  it('removes every occurrence', () => {
    expect(removeTag('#book here and #book there\n', 'book')).toBe('here and there\n')
  })

  it('drops a line that held nothing but the tag', () => {
    expect(removeTag('Intro\n#book\nOutro\n', 'book')).toBe('Intro\nOutro\n')
  })

  it('collapses the gap a removed tag line leaves behind', () => {
    expect(removeTag('Intro\n\n#book\n\nOutro\n', 'book')).toBe('Intro\n\nOutro\n')
  })

  it('leaves a tag inside a fenced code block alone', () => {
    const before = 'Intro\n\n```\n#book\n```\n'
    expect(removeTag(before, 'book')).toBe(before)
  })

  it('leaves a tag inside an inline code span alone', () => {
    const before = 'Type `#book` to tag it.\n'
    expect(removeTag(before, 'book')).toBe(before)
  })

  it('leaves the frontmatter alone', () => {
    const before = '---\ntags: book\nsummary: about #book\n---\nBody #book\n'
    expect(removeTag(before, 'book')).toBe('---\ntags: book\nsummary: about #book\n---\nBody\n')
  })

  it('does not remove a child tag when asked for the parent', () => {
    const before = 'Work on #project/compiler today.\n'
    expect(removeTag(before, 'project')).toBe(before)
  })

  it('removes a differently cased occurrence', () => {
    expect(removeTag('Reading #Book tonight.\n', 'book')).toBe('Reading tonight.\n')
  })

  it('is a no-op, byte for byte, when the tag is absent', () => {
    const before = 'Nothing to see.\n'
    expect(removeTag(before, 'book')).toBe(before)
  })

  it('applying it twice equals applying it once', () => {
    const before = 'Reading #book tonight.\n#book\n'
    const once = removeTag(before, 'book')
    expect(removeTag(once, 'book')).toBe(once)
  })

  it('undoes add-tag on a note that did not have the tag', () => {
    const before = '---\ntitle: Dune\n---\n\nBody text.\n'
    expect(removeTag(addTag(before, 'book'), 'book')).toBe(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  append / prepend                                                          */
/* -------------------------------------------------------------------------- */

describe('append', () => {
  it('adds the text on its own line', () => {
    expect(append('Line one\n', 'Line two')).toBe('Line one\nLine two\n')
  })

  it('adds a line break when the note ended mid-line', () => {
    expect(append('Line one', 'Line two')).toBe('Line one\nLine two')
  })

  it('keeps a blank line the note already had', () => {
    expect(append('Line one\n\n', 'Line two')).toBe('Line one\n\nLine two\n')
  })

  it('reads a leading newline as "on its own line", which it already is', () => {
    expect(append('Line one\n', '\nLine two')).toBe('Line one\nLine two\n')
  })

  it('honours a blank line the text asked for', () => {
    expect(append('Line one\n', '\n\nLine two')).toBe('Line one\n\nLine two\n')
  })

  it('never produces three line breaks in a row', () => {
    expect(append('Line one\n\n\n\n', '\n\n\nLine two')).toBe('Line one\n\nLine two\n')
  })

  it('writes into an empty note', () => {
    expect(append('', '- item')).toBe('- item')
  })

  it('keeps the internal shape of a multi-line block', () => {
    expect(append('Log\n', '- a\n\n- b\n')).toBe('Log\n- a\n\n- b\n')
  })

  it('is a no-op, byte for byte, for empty text', () => {
    const before = 'Line one\n\n'
    expect(append(before, '')).toBe(before)
  })

  it('appends below the frontmatter without disturbing it', () => {
    const after = append('---\ntitle: Dune\n---\nBody\n', 'More')
    expect(after).toBe('---\ntitle: Dune\n---\nBody\nMore\n')
    expect(parseFrontmatter(after).data.title).toBe('Dune')
  })

  it('keeps a CRLF file on CRLF', () => {
    expect(append('Line one\r\n', 'Line two')).toBe('Line one\r\nLine two\r\n')
  })

  it('accumulates on purpose: append is the one op that is not idempotent', () => {
    const once = append('Log\n', '- entry')
    expect(append(once, '- entry')).toBe('Log\n- entry\n- entry\n')
  })
})

describe('prepend', () => {
  it('adds the text above the body', () => {
    expect(prepend('Line two\n', 'Line one')).toBe('Line one\nLine two\n')
  })

  it('inserts below the frontmatter, never above it', () => {
    const after = prepend('---\ntitle: Dune\n---\nBody\n', 'Intro')
    expect(after).toBe('---\ntitle: Dune\n---\nIntro\nBody\n')
    expect(parseFrontmatter(after).data.title).toBe('Dune')
    expect(parseFrontmatter(after).body).toBe('Intro\nBody\n')
  })

  it('honours a blank line the text asked for', () => {
    expect(prepend('Body\n', 'Intro\n\n')).toBe('Intro\n\nBody\n')
  })

  it('never produces three line breaks in a row', () => {
    expect(prepend('\n\n\nBody\n', 'Intro\n\n\n')).toBe('Intro\n\nBody\n')
  })

  it('writes into an empty note', () => {
    expect(prepend('', 'Intro')).toBe('Intro')
  })

  it('writes into a note that is only frontmatter', () => {
    expect(prepend('---\ntitle: Dune\n---\n', 'Intro')).toBe('---\ntitle: Dune\n---\nIntro')
  })

  it('is a no-op, byte for byte, for empty text', () => {
    const before = '\n\nBody\n'
    expect(prepend(before, '')).toBe(before)
    expect(prepend(before, '\n\n')).toBe(before)
  })

  it('keeps a note that ended mid-line ending mid-line', () => {
    expect(prepend('Body', 'Intro')).toBe('Intro\nBody')
  })
})

/* -------------------------------------------------------------------------- */
/*  write-section                                                             */
/* -------------------------------------------------------------------------- */

describe('write-section', () => {
  const NOTE = [
    '# Reading Log',
    '',
    '## Finished',
    '',
    '- [[Dune]]',
    '',
    '## Reading',
    '',
    '- [[Ubik]]',
    ''
  ].join('\n')

  it('replaces the body under the heading and leaves the rest alone', () => {
    expect(writeSection(NOTE, 'Finished', '- [[Dune]]\n- [[Solaris]]')).toBe(
      [
        '# Reading Log',
        '',
        '## Finished',
        '',
        '- [[Dune]]',
        '- [[Solaris]]',
        '',
        '## Reading',
        '',
        '- [[Ubik]]',
        ''
      ].join('\n')
    )
  })

  it('leaves the heading line itself byte for byte', () => {
    const before = '##   Finished   \n\nold\n'
    expect(writeSection(before, 'Finished', 'new')).toBe('##   Finished   \n\nnew\n')
  })

  it('is a fixpoint: writing the same text twice changes nothing', () => {
    const once = writeSection(NOTE, 'Finished', '- [[Dune]]\n- [[Solaris]]')
    expect(writeSection(once, 'Finished', '- [[Dune]]\n- [[Solaris]]')).toBe(once)
  })

  it('is a no-op, byte for byte, when the section already says that', () => {
    expect(writeSection(NOTE, 'Finished', '- [[Dune]]')).toBe(NOTE)
  })

  it('creates the section at the end when it is absent', () => {
    expect(writeSection('# Reading Log\n', 'Finished', '- [[Dune]]')).toBe(
      '# Reading Log\n\n## Finished\n\n- [[Dune]]\n'
    )
  })

  it('creating then rewriting is a fixpoint', () => {
    const once = writeSection('# Reading Log\n', 'Finished', '- [[Dune]]')
    expect(writeSection(once, 'Finished', '- [[Dune]]')).toBe(once)
  })

  it('creates the section in an empty note', () => {
    expect(writeSection('', 'Finished', '- [[Dune]]')).toBe('## Finished\n\n- [[Dune]]\n')
  })

  it('ends the section at the next heading of the same level', () => {
    const before = '## A\n\nold a\n\n## B\n\nkeep b\n'
    expect(writeSection(before, 'A', 'new a')).toBe('## A\n\nnew a\n\n## B\n\nkeep b\n')
  })

  it('ends the section at a heading of a higher level', () => {
    const before = '## A\n\nold a\n\n# Top\n\nkeep top\n'
    expect(writeSection(before, 'A', 'new a')).toBe('## A\n\nnew a\n\n# Top\n\nkeep top\n')
  })

  it('swallows deeper headings, which belong to the section', () => {
    const before = '## Finished\n\nold\n\n### Notes\n\nalso old\n\n## Reading\n\nkeep\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(
      '## Finished\n\nnew\n\n## Reading\n\nkeep\n'
    )
  })

  it('is not fooled by a heading inside a fenced code block', () => {
    const before = '## Finished\n\n```md\n## Reading\n```\n\n## Reading\n\nkeep\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(
      '## Finished\n\nnew\n\n## Reading\n\nkeep\n'
    )
  })

  it('does not treat a hashtag as a heading', () => {
    const before = '## Finished\n\n#book\n\n## Reading\n\nkeep\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(
      '## Finished\n\nnew\n\n## Reading\n\nkeep\n'
    )
  })

  it('matches the heading with or without its hashes', () => {
    const before = '## Finished\n\nold\n'
    expect(writeSection(before, '## Finished', 'new')).toBe('## Finished\n\nnew\n')
    expect(writeSection(before, 'Finished', 'new')).toBe('## Finished\n\nnew\n')
  })

  it('respects a level given in the op', () => {
    const before = '# Finished\n\nkeep top\n\n## Finished\n\nold\n'
    expect(writeSection(before, '## Finished', 'new')).toBe(
      '# Finished\n\nkeep top\n\n## Finished\n\nnew\n'
    )
  })

  it('creates at the level the op asked for', () => {
    expect(writeSection('Body\n', '### Finished', 'new')).toBe('Body\n\n### Finished\n\nnew\n')
  })

  it('matches a heading case-insensitively', () => {
    expect(writeSection('## finished\n\nold\n', 'Finished', 'new')).toBe('## finished\n\nnew\n')
  })

  it('matches the first heading when a note repeats one', () => {
    const before = '## Log\n\nfirst\n\n## Log\n\nsecond\n'
    expect(writeSection(before, 'Log', 'new')).toBe('## Log\n\nnew\n\n## Log\n\nsecond\n')
  })

  it('handles a closing hash sequence', () => {
    expect(writeSection('## Finished ##\n\nold\n', 'Finished', 'new')).toBe(
      '## Finished ##\n\nnew\n'
    )
  })

  it('empties a section when the text is empty', () => {
    const before = '## Finished\n\n- [[Dune]]\n\n## Reading\n\nkeep\n'
    const after = writeSection(before, 'Finished', '')
    expect(after).toBe('## Finished\n\n## Reading\n\nkeep\n')
    expect(writeSection(after, 'Finished', '')).toBe(after)
  })

  it('ignores a heading inside the frontmatter', () => {
    const before = '---\ntitle: # Finished\n---\n\n## Finished\n\nold\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(
      '---\ntitle: # Finished\n---\n\n## Finished\n\nnew\n'
    )
  })

  it('writes into a note whose section is at the very end', () => {
    expect(writeSection('## Finished\n', 'Finished', 'new')).toBe('## Finished\n\nnew\n')
  })

  it('keeps a note that ended mid-line ending mid-line', () => {
    expect(writeSection('## Finished', 'Finished', 'new')).toBe('## Finished\n\nnew')
  })

  it('normalizes the blank lines the text arrived with', () => {
    expect(writeSection('## Finished\n\nold\n', 'Finished', '\n\nnew\n\n\n')).toBe(
      '## Finished\n\nnew\n'
    )
  })

  it('keeps a CRLF file on CRLF', () => {
    expect(writeSection('## Finished\r\n\r\nold\r\n', 'Finished', 'new')).toBe(
      '## Finished\r\n\r\nnew\r\n'
    )
  })

  it('refuses to create a section in a note that ends inside an unclosed fence', () => {
    const before = 'Intro\n\n```\nnot closed\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(before)
  })

  it('still replaces an existing section in a note with an unclosed fence', () => {
    const before = '## Finished\n\nold\n\n## Notes\n\n```\nnot closed\n'
    expect(writeSection(before, 'Finished', 'new')).toBe(
      '## Finished\n\nnew\n\n## Notes\n\n```\nnot closed\n'
    )
  })

  it('refuses an empty heading rather than guessing', () => {
    const before = '## Finished\n\nold\n'
    expect(writeSection(before, '', 'new')).toBe(before)
    expect(writeSection(before, '##', 'new')).toBe(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  write-note / create-note                                                  */
/* -------------------------------------------------------------------------- */

describe('write-note and create-note', () => {
  it('replaces the whole file', () => {
    expect(writeNote('old contents\n', 'new contents\n')).toBe('new contents\n')
  })

  it('terminates generated text with a newline', () => {
    expect(writeNote('', '- [[Dune]]\n- [[Ubik]]')).toBe('- [[Dune]]\n- [[Ubik]]\n')
  })

  it('writes an empty file for empty text', () => {
    expect(writeNote('old\n', '')).toBe('')
  })

  it('ignores what was there before', () => {
    expect(writeNote('a very long note\n', 'x')).toBe(writeNote('', 'x'))
  })

  it('create-note uses its body field', () => {
    expect(createNote('', '# New\n')).toBe('# New\n')
  })

  it('create-note of an empty body is an empty file', () => {
    expect(createNote('', '')).toBe('')
  })

  it('is idempotent', () => {
    const once = writeNote('old\n', 'new')
    expect(writeNote(once, 'new')).toBe(once)
  })
})

/* -------------------------------------------------------------------------- */
/*  apply-template                                                            */
/* -------------------------------------------------------------------------- */

describe('apply-template', () => {
  it('prepends the resolved template body', () => {
    expect(applyTemplate('My notes\n', '# Daily\n\n## Tasks\n')).toBe(
      '# Daily\n\n## Tasks\nMy notes\n'
    )
  })

  it('lets the template ask for a blank line after itself', () => {
    expect(applyTemplate('My notes\n', '# Daily\n\n## Tasks\n\n')).toBe(
      '# Daily\n\n## Tasks\n\nMy notes\n'
    )
  })

  it('inserts below the note frontmatter', () => {
    const after = applyTemplate('---\ntitle: Today\n---\nMy notes\n', '## Tasks')
    expect(after).toBe('---\ntitle: Today\n---\n## Tasks\nMy notes\n')
    expect(parseFrontmatter(after).data.title).toBe('Today')
  })

  it('applies to an empty note, template text as written', () => {
    expect(applyTemplate('', '# Daily\n')).toBe('# Daily\n')
  })

  it('inserts an unresolved name verbatim, so the failure is visible', () => {
    // The caller resolves templates. When it does not, the author sees the name
    // sitting in the note rather than a silent no-op.
    expect(applyTemplate('My notes\n', 'daily')).toBe('daily\nMy notes\n')
  })

  it('is a no-op, byte for byte, for an empty template', () => {
    const before = 'My notes\n'
    expect(applyTemplate(before, '')).toBe(before)
  })
})

/* -------------------------------------------------------------------------- */
/*  Sequences, which is how a run actually arrives                            */
/* -------------------------------------------------------------------------- */

describe('op sequences on one file', () => {
  it('survives a realistic run and repeats it without drift', () => {
    const start = '---\ntitle: Reading Log\n---\n\n# Reading Log\n\n## Finished\n\n- [[Dune]]\n'
    const ops: WorkflowOp[] = [
      { kind: 'set-frontmatter', path: PATH, field: 'updated', value: '2026-07-28' },
      { kind: 'write-section', path: PATH, heading: 'Finished', text: '- [[Dune]]\n- [[Ubik]]' },
      { kind: 'add-tag', path: PATH, tag: 'log' }
    ]
    const once = ops.reduce((text, op) => run(text, op), start)
    expect(once).toBe(
      [
        '---',
        'title: Reading Log',
        'updated: 2026-07-28',
        '---',
        '',
        '# Reading Log',
        '',
        '## Finished',
        '',
        '- [[Dune]]',
        '- [[Ubik]]',
        '#log',
        ''
      ].join('\n')
    )
    // The whole run is a fixpoint, which is what makes a scheduled workflow safe.
    expect(ops.reduce((text, op) => run(text, op), once)).toBe(once)
  })

  it('keeps the frontmatter readable after every text op', () => {
    const start = '---\ntitle: Dune\n---\n\n## Notes\n\nBody\n'
    const ops: WorkflowOp[] = [
      { kind: 'prepend', path: PATH, text: 'Intro' },
      { kind: 'append', path: PATH, text: 'Outro' },
      { kind: 'add-tag', path: PATH, tag: 'book' },
      { kind: 'apply-template', path: PATH, template: 'From the template' },
      { kind: 'write-section', path: PATH, heading: 'Notes', text: 'filled' },
      { kind: 'set-frontmatter', path: PATH, field: 'rating', value: '5' }
    ]
    const after = ops.reduce((text, op) => run(text, op), start)
    const parsed = parseFrontmatter(after)
    expect(parsed.data).toEqual({ title: 'Dune', rating: '5' })
    expect(parsed.body).toBe('From the template\nIntro\n## Notes\n\nfilled\n')
  })

  it('a section that runs to the end of the file owns what was appended there', () => {
    // Worth pinning: `add-tag` and `append` write at the end of the note, and a
    // final section extends to the end of the note, so a later `write-section`
    // over that section replaces them. Ops apply in the order the plan lists
    // them, and the author can see that order in the dry run.
    const start = '## Finished\n\n- [[Dune]]\n'
    const tagged = run(start, { kind: 'add-tag', path: PATH, tag: 'log' })
    expect(tagged).toBe('## Finished\n\n- [[Dune]]\n#log\n')
    const rewritten = run(tagged, {
      kind: 'write-section',
      path: PATH,
      heading: 'Finished',
      text: '- [[Dune]]'
    })
    expect(rewritten).toBe(start)
  })

  /**
   * The applier has no fallback for a transform that throws or that grows a
   * file every time it runs, so both properties are checked against every ugly
   * input this vault could plausibly hold rather than case by case.
   */
  describe('over malformed and edge-case files', () => {
    const FILES: Array<[string, string]> = [
      ['empty', ''],
      ['one newline', '\n'],
      ['blank lines', '\n\n\n'],
      ['spaces only', '   '],
      ['an unterminated fence marker', '---'],
      ['an unterminated block', '---\ntitle: Dune\n'],
      ['a block with no trailing newline', '---\ntitle: Dune\n---'],
      ['an empty-looking block', '---\n\n---\n'],
      ['no frontmatter', 'Just text, no newline at the end'],
      ['a bare heading', '# H'],
      ['an unclosed code fence', '```\n#book\n'],
      ['a note that is one tag', '#book'],
      ['CRLF throughout', '---\r\ntitle: Dune\r\n---\r\n\r\n## Finished\r\n\r\n#book\r\n'],
      ['nested headings', '# A\n## B\n### C\n#### D\n'],
      ['a stray delimiter in the body', 'text\n---\nmore\n']
    ]

    const IDEMPOTENT: Array<[string, WorkflowOp]> = [
      ['set-frontmatter', { kind: 'set-frontmatter', path: PATH, field: 'status', value: 'done' }],
      ['add-tag', { kind: 'add-tag', path: PATH, tag: 'book' }],
      ['remove-tag', { kind: 'remove-tag', path: PATH, tag: 'book' }],
      ['write-section', { kind: 'write-section', path: PATH, heading: 'Finished', text: '- x' }],
      ['write-note', { kind: 'write-note', path: PATH, text: 'replaced' }],
      ['create-note', { kind: 'create-note', path: PATH, body: 'created' }]
    ]

    for (const [fileLabel, before] of FILES) {
      for (const [opLabel, op] of IDEMPOTENT) {
        it(`${opLabel} is stable on ${fileLabel}`, () => {
          const once = run(before, op)
          expect(typeof once).toBe('string')
          expect(run(once, op)).toBe(once)
        })
      }

      it(`append and prepend survive ${fileLabel}`, () => {
        const appended = run(before, { kind: 'append', path: PATH, text: 'tail' })
        const both = run(appended, { kind: 'prepend', path: PATH, text: 'head' })
        expect(both).toContain('head')
        expect(both).toContain('tail')
        expect(both).not.toMatch(/\n{3}/)
      })
    }
  })

  it('never leaves three blank lines behind, whatever the order', () => {
    const start = 'Body\n\n\n'
    const ops: WorkflowOp[] = [
      { kind: 'append', path: PATH, text: '\n\nA' },
      { kind: 'prepend', path: PATH, text: 'B\n\n\n' },
      { kind: 'add-tag', path: PATH, tag: 'x' },
      { kind: 'append', path: PATH, text: '\n\n\nC' }
    ]
    const after = ops.reduce((text, op) => run(text, op), start)
    expect(after).not.toMatch(/\n{3}/)
  })
})
