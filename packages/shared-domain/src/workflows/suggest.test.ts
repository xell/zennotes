import { describe, expect, it } from 'vitest'
import {
  COMPARE_OP_HINTS,
  ENGINE_FIELDS,
  FRONTMATTER_KEYS,
  RENDER_STYLE_HINTS,
  paramSignature,
  suggestAt,
  verbDetail
} from './suggest'
import type { SuggestContext, Suggestion } from './suggest'
import { NODE_DEFS, nodeDef } from './nodes'
import { CONSUMED_KEYS, WORKFLOW_EVENTS } from './parse'
import { renderNotes } from './engine'
import type { WorkflowNote } from './types'

// `|` is a pipe in the grammar, so the caret marker has to be something the
// grammar can never contain.
const CARET = '‸'

/**
 * Build a context from a source string with the caret marked.
 *
 * Writing the position inline is what keeps these tests readable: an offset
 * spelled as a number is unreviewable the moment the fixture changes by a
 * character.
 *
 * `explicit` defaults to true, so each of these reads as "with the caret HERE,
 * asking for completions offers X", which is the question about the grammar.
 * Whether the popup should have opened by itself is a different question, and it
 * has its own describe block below where `explicit` is passed as false.
 */
function ctxOf(source: string, extra: Partial<SuggestContext> = {}): SuggestContext {
  const offset = source.indexOf(CARET)
  if (offset === -1) throw new Error(`fixture has no ${CARET} caret marker`)
  return { text: source.replace(CARET, ''), offset, explicit: true, ...extra }
}

/** The same fixture, but with nobody having asked: what typing alone produces. */
function typedCtx(source: string, extra: Partial<SuggestContext> = {}): SuggestContext {
  return ctxOf(source, { ...extra, explicit: false })
}

const labels = (items: Suggestion[]): string[] => items.map((item) => item.label)
const inserts = (items: Suggestion[]): string[] => items.map((item) => item.insert)

const detailOf = (items: Suggestion[], label: string): string | undefined =>
  items.find((item) => item.label === label)?.detail

const VAULT: Partial<SuggestContext> = {
  wires: ['books', 'good'],
  tags: ['book', '#project', 'meeting'],
  fields: ['rating', 'status', 'title'],
  paths: ['inbox/Reading Log.md', 'inbox/projects/Compiler.md', 'Root.md']
}

/* -------------------------------------------------------------------------- */
/*  The head of a statement                                                   */
/* -------------------------------------------------------------------------- */

describe('suggestAt: the head of a statement', () => {
  it('offers sources in an empty file', () => {
    const items = suggestAt(ctxOf(CARET)).items
    expect(labels(items)).toContain('tag')
    expect(labels(items)).toContain('folder')
    expect(labels(items)).toContain('all')
  })

  it('offers nothing but sources and wires there', () => {
    const items = suggestAt(ctxOf(CARET)).items
    expect(labels(items)).not.toContain('where')
    expect(labels(items)).not.toContain('add-tag')
    expect(labels(items)).not.toContain('write-section')
  })

  it('offers the wires already defined, before the verbs', () => {
    const items = suggestAt(ctxOf(CARET, VAULT)).items
    expect(labels(items).slice(0, 2)).toEqual(['books', 'good'])
    expect(items[0].kind).toBe('wire')
  })

  it('offers only verbs when the workflow has no wires yet', () => {
    const items = suggestAt(ctxOf(CARET)).items
    expect(items.every((item) => item.kind === 'verb')).toBe(true)
  })

  it('treats a blank body line as the head of a new statement', () => {
    const items = suggestAt(ctxOf(`---\nname: X\n---\n\nbooks = tag #book\n${CARET}`)).items
    expect(labels(items)).toContain('all')
  })

  it('replaces the token under the caret when it is half typed', () => {
    const result = suggestAt(ctxOf(`fol${CARET}der inbox`))
    expect([result.from, result.to]).toEqual([0, 6])
  })

  it('completes the pipeline after an assignment', () => {
    const items = suggestAt(ctxOf(`good = ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('books')
    expect(labels(items)).toContain('tag')
  })

  it('says nothing while the caret is inside the wire name being defined', () => {
    const result = suggestAt(ctxOf(`goo${CARET}d = tag #book`, VAULT))
    expect(result.items).toEqual([])
  })

  it('says nothing on a comment line, which is prose', () => {
    expect(suggestAt(ctxOf(`# keep the log in ${CARET}`, VAULT)).items).toEqual([])
  })

  it('says nothing after a bare wire reference, which takes no arguments', () => {
    expect(suggestAt(ctxOf(`books ${CARET}`, VAULT)).items).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/*  After a pipe                                                              */
/* -------------------------------------------------------------------------- */

describe('suggestAt: after a pipe', () => {
  it('offers the verbs that transform a wire', () => {
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('where')
    expect(labels(items)).toContain('sort')
    expect(labels(items)).toContain('add-tag')
  })

  it('never offers a source, which would throw the wire away', () => {
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    for (const def of NODE_DEFS.filter((d) => d.source)) {
      expect(labels(items)).not.toContain(def.kind)
    }
  })

  it('works with the caret pressed against the pipe', () => {
    const items = suggestAt(ctxOf(`books |${CARET}`, VAULT)).items
    expect(labels(items)).toContain('where')
  })

  it('offers terminal verbs when this is the last step', () => {
    const items = suggestAt(ctxOf(`books | render list | ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('write-section')
    expect(labels(items)).toContain('clipboard')
  })

  it('withholds terminal verbs when another step follows', () => {
    const items = suggestAt(ctxOf(`books | ${CARET} | write-section "a.md" "b"`, VAULT)).items
    expect(labels(items)).toContain('render')
    expect(labels(items)).not.toContain('write-section')
    expect(labels(items)).not.toContain('notify')
  })

  it('describes a verb by what it is, not by what it takes', () => {
    // One question per column. The signature is a separate field, shown in the
    // docs beside the list, so this one never has to say `folder` next to
    // `folder` again.
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    expect(detailOf(items, 'where')).toBe('Where field')
    expect(detailOf(items, 'sort')).toBe('Sort')
    expect(detailOf(items, 'write-section')).toBe('Replace section in note')
    expect(items.find((item) => item.label === 'where')?.signature).toBe('field op value')
  })

  it('describes a verb with no parameters the same way', () => {
    const items = suggestAt(ctxOf(CARET)).items
    expect(detailOf(items, 'all')).toBe('All notes')
  })

  it('never answers with a bare parameter name, which was the bug', () => {
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    for (const item of items) {
      const def = nodeDef(item.label)
      if (!def) continue
      for (const spec of def.params) expect(item.detail).not.toBe(spec.name)
    }
  })

  it('replaces the half-typed verb, not the whole step', () => {
    const result = suggestAt(ctxOf(`books | whe${CARET} #x`, VAULT))
    expect([result.from, result.to]).toEqual([8, 11])
  })

  it('keeps a quoted pipe out of the segment split', () => {
    const items = suggestAt(ctxOf(`books | append "| a | b |" | ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('write')
  })
})

/* -------------------------------------------------------------------------- */
/*  Parameters                                                                */
/* -------------------------------------------------------------------------- */

describe('suggestAt: parameters complete by declared type', () => {
  it('offers the engine fields first, then the vault ones', () => {
    const items = suggestAt(ctxOf(`books | where ${CARET}`, VAULT)).items
    expect(labels(items).slice(0, 5)).toEqual(['title', 'path', 'folder', 'created', 'updated'])
    expect(labels(items)).toContain('rating')
    expect(items.every((item) => item.kind === 'field')).toBe(true)
  })

  it('does not offer a vault field twice when it shadows an engine one', () => {
    const items = suggestAt(ctxOf(`books | where ${CARET}`, VAULT)).items
    expect(labels(items).filter((label) => label === 'title')).toHaveLength(1)
  })

  it('offers the comparison operators with what they mean', () => {
    const items = suggestAt(ctxOf(`books | where rating ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('>=')
    expect(labels(items)).toContain('contains')
    expect(detailOf(items, '>=')).toBe(COMPARE_OP_HINTS['>='])
  })

  it('says nothing for a free-text value', () => {
    expect(suggestAt(ctxOf(`books | where rating >= ${CARET}`, VAULT)).items).toEqual([])
  })

  it('offers the sort directions', () => {
    const items = suggestAt(ctxOf(`books | sort title ${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['asc', 'desc'])
  })

  it('offers tags with the hash the grammar expects', () => {
    const items = suggestAt(ctxOf(`tag ${CARET}`, VAULT)).items
    expect(inserts(items)).toEqual(['#book', '#project', '#meeting'])
    expect(items.every((item) => item.kind === 'tag')).toBe(true)
  })

  it('replaces a half-typed tag, hash included', () => {
    const result = suggestAt(ctxOf(`books | add-tag #so${CARET}me`, VAULT))
    expect([result.from, result.to]).toEqual([16, 21])
  })

  it('offers the render styles with what each one produces', () => {
    const items = suggestAt(ctxOf(`books | render ${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['table', 'list', 'count', 'links'])
    expect(detailOf(items, 'links')).toBe(RENDER_STYLE_HINTS.links)
  })

  it('says nothing for a column list, which the registry does not type', () => {
    // A known gap, recorded rather than papered over: `render table <columns>`
    // is a `rest` param, so there is no type to complete from. The fix is a
    // param type in the registry, not a special case keyed on the param name.
    expect(suggestAt(ctxOf(`books | render table ${CARET}`, VAULT)).items).toEqual([])
  })

  it('offers wires where a wire is expected', () => {
    const items = suggestAt(ctxOf(`books | subtract ${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['books', 'good'])
    expect(items.every((item) => item.kind === 'wire')).toBe(true)
  })

  it('offers note paths, quoted the way the serializer writes them', () => {
    const items = suggestAt(ctxOf(`books | write ${CARET}`, VAULT)).items
    expect(inserts(items)).toContain('"inbox/Reading Log.md"')
    expect(labels(items)).toContain('inbox/Reading Log.md')
  })

  it('picks a quote character the path does not already contain', () => {
    const items = suggestAt(ctxOf(`books | write ${CARET}`, { paths: ['a "b".md'] })).items
    expect(inserts(items)).toEqual([`'a "b".md'`])
  })

  it('offers folders derived from the paths, ancestors included', () => {
    const items = suggestAt(ctxOf(`folder ${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['inbox', 'inbox/projects'])
    expect(items.every((item) => item.kind === 'path')).toBe(true)
  })

  it('quotes a folder only when it has to', () => {
    const items = suggestAt(ctxOf(`folder ${CARET}`, { paths: ['my notes/a.md'] })).items
    expect(inserts(items)).toEqual(['"my notes"'])
  })

  it('offers durations people actually reach for', () => {
    const items = suggestAt(ctxOf(`books | since ${CARET}`, VAULT)).items
    expect(labels(items)).toContain('7d')
    expect(labels(items)).toContain('24h')
    expect(labels(items)).toContain('2w')
  })

  it('says nothing after a verb it does not recognize', () => {
    expect(suggestAt(ctxOf(`books | frobnicate ${CARET}`, VAULT)).items).toEqual([])
  })

  it('says nothing past the last declared parameter', () => {
    expect(suggestAt(ctxOf(`books | limit 5 ${CARET}`, VAULT)).items).toEqual([])
  })

  it('returns an empty range when the caret sits in whitespace', () => {
    const result = suggestAt(ctxOf(`books | where ${CARET}`, VAULT))
    expect(result.from).toBe(result.to)
    expect(result.from).toBe(14)
  })
})

/* -------------------------------------------------------------------------- */
/*  Typing drives it                                                          */
/* -------------------------------------------------------------------------- */

describe('suggestAt: nothing typed, nobody asked', () => {
  // The bug this feature was reported for: the caret landing on a blank line
  // produced a popup listing every source verb, over an empty prefix, which then
  // ate Enter. Arriving somewhere is not a question.
  it('offers nothing at the head of an empty statement', () => {
    expect(suggestAt(typedCtx(CARET, VAULT)).items).toEqual([])
  })

  it('offers nothing straight after a pipe', () => {
    expect(suggestAt(typedCtx(`books | ${CARET}`, VAULT)).items).toEqual([])
  })

  it('offers nothing on an empty parameter slot', () => {
    expect(suggestAt(typedCtx(`books | where ${CARET}`, VAULT)).items).toEqual([])
  })

  it('offers nothing on an empty frontmatter line', () => {
    expect(suggestAt(typedCtx(`---\n${CARET}\n---\n\nall\n`)).items).toEqual([])
  })

  it('still returns the range, so the caller can splice without asking twice', () => {
    const result = suggestAt(typedCtx(`books | ${CARET}`, VAULT))
    expect([result.from, result.to]).toEqual([8, 8])
  })

  it('offers everything the moment a character is typed', () => {
    const items = suggestAt(typedCtx(`books | w${CARET}`, VAULT)).items
    expect(labels(items)).toContain('where')
  })
})

describe('suggestAt: asked for over an empty prefix', () => {
  it('offers the whole list at the head of a statement', () => {
    const items = suggestAt(ctxOf(CARET, VAULT)).items
    expect(labels(items)).toContain('all')
    expect(labels(items)).toContain('books')
  })

  it('offers the whole list after a pipe', () => {
    const asked = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    const typed = suggestAt(typedCtx(`books | ${CARET}`, VAULT)).items
    expect(asked.length).toBeGreaterThan(0)
    expect(typed).toEqual([])
  })

  it('offers the whole list on a parameter slot', () => {
    const items = suggestAt(ctxOf(`books | since ${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['24h', '7d', '2w', '30d'])
  })

  it('marks nothing, because nothing was typed to match', () => {
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    expect(items.every((item) => item.match === undefined)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/*  Filtering and ranking                                                     */
/* -------------------------------------------------------------------------- */

describe('suggestAt: filters against what was typed', () => {
  it('keeps only what matches, prefix or not', () => {
    const items = suggestAt(ctxOf(`books | whe${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['where'])
  })

  it('ignores case, in both directions', () => {
    expect(labels(suggestAt(ctxOf(`books | WHE${CARET}`, VAULT)).items)).toEqual(['where'])
    expect(labels(suggestAt(ctxOf(`books | sInC${CARET}`, VAULT)).items)).toEqual(['since'])
  })

  it('ranks a prefix match above a substring one, then short before long', () => {
    const items = suggestAt(ctxOf(`books | re${CARET}`, VAULT)).items
    expect(labels(items)).toEqual([
      // `re...` first, shortest first, and `rename` before `render` on the
      // alphabet when the lengths tie.
      'rename',
      'render',
      'remove-tag',
      // Then the ones that merely contain it, nearest match first.
      'prepend',
      'create-each',
      'where'
    ])
  })

  it('orders the same way every time it is asked', () => {
    const once = labels(suggestAt(ctxOf(`books | t${CARET}`, VAULT)).items)
    const again = labels(suggestAt(ctxOf(`books | t${CARET}`, VAULT)).items)
    expect(again).toEqual(once)
    expect(once.length).toBeGreaterThan(1)
  })

  it('returns nothing when nothing matches, so the popup closes', () => {
    expect(suggestAt(ctxOf(`books | frob${CARET}`, VAULT)).items).toEqual([])
    expect(suggestAt(ctxOf(`books | where zzz${CARET}`, VAULT)).items).toEqual([])
    expect(suggestAt(ctxOf(`books | render zzz${CARET}`, VAULT)).items).toEqual([])
  })

  it('filters a parameter slot by its own vocabulary', () => {
    expect(labels(suggestAt(ctxOf(`books | where rat${CARET}`, VAULT)).items)).toEqual(['rating'])
    expect(labels(suggestAt(ctxOf(`books | render li${CARET}`, VAULT)).items)).toEqual([
      'list',
      'links'
    ])
  })

  it('filters tags with the hash the user typed', () => {
    const items = suggestAt(ctxOf(`books | add-tag #pro${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['#project'])
  })

  it('filters paths through the opening quote, which is punctuation', () => {
    const items = suggestAt(ctxOf(`books | write "inbox/Read${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['inbox/Reading Log.md'])
  })

  it('filters frontmatter keys too', () => {
    const items = suggestAt(ctxOf(`---\ntrig${CARET}\n---\n\nall\n`)).items
    expect(labels(items)).toEqual(['trigger'])
  })

  it('matches on the text behind the caret, not the whole token', () => {
    // `fol` is the request; `der inbox` is what is already on screen.
    const items = suggestAt(ctxOf(`fol${CARET}der inbox`, VAULT)).items
    expect(labels(items)).toEqual(['folder'])
  })
})

describe('suggestAt: says where each item matched', () => {
  it('marks a prefix match from the first character', () => {
    const items = suggestAt(ctxOf(`books | wher${CARET}`, VAULT)).items
    expect(items[0].match).toEqual({ start: 0, end: 4 })
  })

  it('marks a substring match where it actually sits', () => {
    const items = suggestAt(ctxOf(`books | pen${CARET}`, VAULT)).items
    expect(labels(items)).toEqual(['append', 'prepend'])
    expect(items[0].match).toEqual({ start: 2, end: 5 })
    expect(items[1].match).toEqual({ start: 3, end: 6 })
  })

  it('marks the label, not the quoted insert', () => {
    const items = suggestAt(ctxOf(`books | write "inbox/Read${CARET}`, VAULT)).items
    const [item] = items
    expect(item.label.slice(item.match?.start, item.match?.end)).toBe('inbox/Read')
    expect(item.insert).toBe('"inbox/Reading Log.md"')
  })

  it('marks what was typed even when the case differs', () => {
    const items = suggestAt(ctxOf(`books | WHE${CARET}`, VAULT)).items
    expect(items[0].match).toEqual({ start: 0, end: 3 })
  })
})

/* -------------------------------------------------------------------------- */
/*  The docs the popup shows                                                  */
/* -------------------------------------------------------------------------- */

describe('suggestAt: carries the registry docs to the caller', () => {
  it('gives a verb its signature, its description and its example', () => {
    const items = suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items
    const where = items.find((item) => item.label === 'where')
    const def = nodeDef('where')
    expect(where?.signature).toBe('field op value')
    expect(where?.description).toBe(def?.description)
    expect(where?.example).toBe(def?.example)
  })

  it('leaves the signature off a verb that takes nothing', () => {
    const items = suggestAt(ctxOf(`books | render list | ${CARET}`, VAULT)).items
    const clipboard = items.find((item) => item.label === 'clipboard')
    expect(clipboard?.signature).toBeUndefined()
    expect(clipboard?.description).toBe(nodeDef('clipboard')?.description)
  })

  it('documents every verb it offers, from both positions', () => {
    const everywhere = [
      suggestAt(ctxOf(CARET, VAULT)).items,
      suggestAt(ctxOf(`books | render list | ${CARET}`, VAULT)).items
    ].flat()
    const verbs = everywhere.filter((item) => item.kind === 'verb')
    expect(verbs.length).toBeGreaterThan(0)
    for (const item of verbs) {
      expect(item.description).toBeTruthy()
      expect(item.example).toBeTruthy()
    }
  })

  it('keeps the docs through a filter, so the pane follows the selection', () => {
    const items = suggestAt(ctxOf(`books | sor${CARET}`, VAULT)).items
    expect(items[0].description).toBe(nodeDef('sort')?.description)
    expect(items[0].signature).toBe('field [direction]')
  })

  it('does not invent docs for a value, a tag or a path', () => {
    const items = [
      suggestAt(ctxOf(`tag ${CARET}`, VAULT)).items,
      suggestAt(ctxOf(`books | where rating ${CARET}`, VAULT)).items,
      suggestAt(ctxOf(`books | write ${CARET}`, VAULT)).items
    ].flat()
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.description).toBeUndefined()
      expect(item.example).toBeUndefined()
      expect(item.signature).toBeUndefined()
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Frontmatter                                                               */
/* -------------------------------------------------------------------------- */

describe('suggestAt: inside the frontmatter', () => {
  it('offers the keys the format understands', () => {
    const items = suggestAt(ctxOf(`---\n${CARET}\n---\n\nall\n`)).items
    expect(labels(items)).toEqual(['name', 'description', 'status', 'trigger', 'key'])
    expect(items.every((item) => item.kind === 'frontmatter')).toBe(true)
  })

  it('inserts a key with its colon so the line is ready for a value', () => {
    const items = suggestAt(ctxOf(`---\n${CARET}\n---\n\nall\n`)).items
    expect(inserts(items)).toContain('trigger: ')
  })

  it('inserts a bare key when the line already has a colon', () => {
    const items = suggestAt(ctxOf(`---\ntrig${CARET}: manual\n---\n\nall\n`)).items
    expect(inserts(items)).toContain('trigger')
    expect(inserts(items)).not.toContain('trigger: ')
  })

  it('replaces only the key, leaving the value alone', () => {
    const result = suggestAt(ctxOf(`---\ntrig${CARET}: manual\n---\n\nall\n`))
    expect([result.from, result.to]).toEqual([4, 8])
  })

  it('offers the trigger vocabulary after `trigger:`', () => {
    const items = suggestAt(ctxOf(`---\ntrigger: ${CARET}\n---\n\nall\n`)).items
    expect(labels(items)).toContain('manual')
    expect(labels(items)).toContain('on note-saved')
    expect(labels(items)).toContain('schedule 0 9 * * *')
  })

  it('replaces the whole trigger value, which can be several words', () => {
    const result = suggestAt(ctxOf(`---\ntrigger: on note-${CARET}saved\n---\n\nall\n`))
    expect([result.from, result.to]).toEqual([13, 26])
  })

  it('says nothing for a value that is prose', () => {
    expect(suggestAt(ctxOf(`---\ndescription: keeps ${CARET}\n---\n\nall\n`)).items).toEqual([])
  })

  it('says nothing on a fence line', () => {
    expect(suggestAt(ctxOf(`--${CARET}-\nname: X\n---\n\nall\n`)).items).toEqual([])
  })

  it('still helps while the closing fence is unwritten', () => {
    const items = suggestAt(ctxOf(`---\nname: X\n${CARET}`)).items
    expect(labels(items)).toContain('trigger')
  })

  it('stops being frontmatter after the closing fence', () => {
    const items = suggestAt(ctxOf(`---\nname: X\n---\n\n${CARET}`)).items
    expect(labels(items)).toContain('tag')
    expect(labels(items)).not.toContain('description')
  })

  it('treats a file with no frontmatter as all body', () => {
    const items = suggestAt(ctxOf(`name: X\n${CARET}`)).items
    expect(labels(items)).toContain('tag')
  })
})

/* -------------------------------------------------------------------------- */
/*  Robustness                                                                */
/* -------------------------------------------------------------------------- */

describe('suggestAt: bad input', () => {
  it('clamps an offset past the end of the document', () => {
    const result = suggestAt({ text: 'books | ', offset: 999, explicit: true })
    expect(result.from).toBe(8)
    expect(labels(result.items)).toContain('where')
  })

  it('clamps a negative offset', () => {
    const result = suggestAt({ text: 'tag #book', offset: -5 })
    expect([result.from, result.to]).toEqual([0, 3])
  })

  it('survives an offset that is not a number', () => {
    const result = suggestAt({ text: 'tag #book', offset: Number.NaN })
    expect(result.from).toBe(0)
  })

  it('finds the caret line in a CRLF document', () => {
    const items = suggestAt(ctxOf(`books = tag #book\r\nbooks | ${CARET}\r\n`, VAULT)).items
    expect(labels(items)).toContain('where')
  })

  it('keeps the caret inside the range it returns, always', () => {
    const text = `---\nname: X\ntrigger: manual\n---\n\nbooks = tag #book\nbooks | where rating >= 4\n`
    for (let offset = 0; offset <= text.length; offset++) {
      const result = suggestAt({ text, offset, explicit: true, ...VAULT })
      expect(result.from).toBeLessThanOrEqual(offset)
      expect(result.to).toBeGreaterThanOrEqual(offset)
    }
  })
})

/* -------------------------------------------------------------------------- */
/*  Agreement with the rest of the feature                                    */
/* -------------------------------------------------------------------------- */

describe('the vocabulary matches what the engine and parser accept', () => {
  it('offers only fields the engine can actually read', () => {
    // `fieldValue` is private to the engine, but `render table` goes through it,
    // so a field that renders a value is a field the engine knows. A name that
    // drifted would complete to an expression matching nothing, silently.
    const note: WorkflowNote = {
      path: 'inbox/a.md',
      title: 'A',
      folder: 'inbox',
      tags: [],
      frontmatter: {},
      createdAt: 1,
      updatedAt: 2
    }
    const columns = ENGINE_FIELDS.map((field) => field.name).join(', ')
    const row = renderNotes([note], 'table', columns).split('\n')[2]
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim())
    expect(cells).toHaveLength(ENGINE_FIELDS.length)
    for (const cell of cells) expect(cell).not.toBe('')
  })

  it('offers exactly the frontmatter keys the parser consumes', () => {
    const offered = new Set(FRONTMATTER_KEYS.map((hint) => hint.name))
    expect(offered).toEqual(new Set(CONSUMED_KEYS))
  })

  it('offers every trigger event the parser recognizes', () => {
    const items = suggestAt(ctxOf(`---\ntrigger: ${CARET}\n---\n\nall\n`)).items
    for (const event of WORKFLOW_EVENTS) expect(labels(items)).toContain(`on ${event}`)
  })

  it('can reach every node in the registry from some position', () => {
    // The guard that makes "derived from NODE_DEFS" true rather than aspirational:
    // a node added tomorrow is completable without touching this module.
    const head = labels(suggestAt(ctxOf(CARET)).items)
    const piped = labels(suggestAt(ctxOf(`books | ${CARET}`, VAULT)).items)
    for (const def of NODE_DEFS) {
      expect(def.source ? head : piped).toContain(def.kind)
    }
  })

  it('describes every node without inventing a signature', () => {
    for (const def of NODE_DEFS) {
      const detail = verbDetail(def)
      expect(detail).not.toBe('')
      for (const spec of def.params) expect(paramSignature(def)).toContain(spec.name)
    }
  })

  it('brackets the optional parameters and only those', () => {
    const sort = nodeDef('sort')
    expect(sort && paramSignature(sort)).toBe('field [direction]')
  })

  it('gives every suggestion a label, an insert and a detail', () => {
    const everywhere = [
      suggestAt(ctxOf(CARET, VAULT)),
      suggestAt(ctxOf(`books | ${CARET}`, VAULT)),
      suggestAt(ctxOf(`books | where ${CARET}`, VAULT)),
      suggestAt(ctxOf(`books | where rating ${CARET}`, VAULT)),
      suggestAt(ctxOf(`books | since ${CARET}`, VAULT)),
      suggestAt(ctxOf(`books | render ${CARET}`, VAULT)),
      suggestAt(ctxOf(`tag ${CARET}`, VAULT)),
      suggestAt(ctxOf(`folder ${CARET}`, VAULT)),
      suggestAt(ctxOf(`books | write ${CARET}`, VAULT)),
      suggestAt(ctxOf(`---\n${CARET}\n---\n\nall\n`)),
      suggestAt(ctxOf(`---\ntrigger: ${CARET}\n---\n\nall\n`))
    ]
    for (const result of everywhere) {
      expect(result.items.length).toBeGreaterThan(0)
      for (const item of result.items) {
        expect(item.label).not.toBe('')
        expect(item.insert).not.toBe('')
        expect(item.detail).not.toBe('')
        expect(item.detail).not.toContain('\u2014')
      }
    }
  })
})
