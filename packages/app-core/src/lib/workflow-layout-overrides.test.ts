import { describe, expect, it } from 'vitest'
import { parseWorkflow } from '@shared/workflows/parse'
import { serializeWorkflow } from '@shared/workflows/serialize'
import { stepId } from '@shared/workflows/layout'
import {
  LAYOUT_META_KEY,
  parseLayoutOverrides,
  pruneLayoutOverrides,
  serializeLayoutOverrides,
  withLayoutOverrides,
  withLayoutOverridesText
} from './workflow-layout-overrides'
import type { NodePosition } from './workflow-layout-overrides'

/** The map form of `layout: …`, for the round-trip assertions. */
function overrides(entries: Record<string, NodePosition>): Map<string, NodePosition> {
  return new Map(Object.entries(entries))
}

const FILE = `---
name: Reading log
description: Keep the reading log in sync
trigger: manual
---

books   = tag #book
good    = books | where rating >= 4
`

describe('parseLayoutOverrides', () => {
  it('reads nothing from frontmatter that has no layout key', () => {
    expect(parseLayoutOverrides({})).toEqual(new Map())
    expect(parseLayoutOverrides({ name: 'Reading log' })).toEqual(new Map())
  })

  it('reads one entry', () => {
    expect(parseLayoutOverrides({ layout: '0:0=140,40' })).toEqual(overrides({ '0:0': { x: 140, y: 40 } }))
  })

  it('reads several entries separated by spaces', () => {
    expect(parseLayoutOverrides({ layout: '0:0=140,40 1:1=420,90' })).toEqual(
      overrides({ '0:0': { x: 140, y: 40 }, '1:1': { x: 420, y: 90 } })
    )
  })

  it('reads negative coordinates', () => {
    expect(parseLayoutOverrides({ layout: '0:0=-140,-40 1:0=-5,12' })).toEqual(
      overrides({ '0:0': { x: -140, y: -40 }, '1:0': { x: -5, y: 12 } })
    )
  })

  it('rounds fractional coordinates, so a hand-edited file still reads', () => {
    expect(parseLayoutOverrides({ layout: '0:0=140.4,40.6 1:0=-2.5,-2.4' })).toEqual(
      overrides({ '0:0': { x: 140, y: 41 }, '1:0': { x: -2, y: -2 } })
    )
  })

  // The whole point of parsing being total: one bad entry must not take the
  // canvas down with it, because the file is user-editable.
  it('skips a malformed entry and keeps its neighbours', () => {
    expect(parseLayoutOverrides({ layout: '0:0=abc 1:0=10,20 2:0= 3:0=1,2,3' })).toEqual(
      overrides({ '1:0': { x: 10, y: 20 } })
    )
  })

  it('skips an entry that is missing a coordinate', () => {
    expect(parseLayoutOverrides({ layout: '0:0=10 1:0=,20 2:0=30,' })).toEqual(new Map())
  })

  it('skips coordinates that are not plain numbers', () => {
    expect(parseLayoutOverrides({ layout: '0:0=NaN,4 1:0=Infinity,4 2:0=1e3,4 3:0=+5,4' })).toEqual(
      new Map()
    )
  })

  it('tolerates tabs, runs of spaces and a value that is only whitespace', () => {
    expect(parseLayoutOverrides({ layout: '  0:0=1,2\t\t1:0=3,4  ' })).toEqual(
      overrides({ '0:0': { x: 1, y: 2 }, '1:0': { x: 3, y: 4 } })
    )
    expect(parseLayoutOverrides({ layout: '   ' })).toEqual(new Map())
    expect(parseLayoutOverrides({ layout: '' })).toEqual(new Map())
  })

  // Matches `parseFrontmatter`'s own last-one-wins rule for a repeated key, so
  // the two halves of a hand-edited file cannot disagree.
  it('takes the last value for a repeated id', () => {
    expect(parseLayoutOverrides({ layout: '0:0=1,2 0:0=9,9' })).toEqual(
      overrides({ '0:0': { x: 9, y: 9 } })
    )
  })

  it('never throws on hostile input', () => {
    for (const layout of ['=', '==', '0:0=', '{}', '\n\n', '0:0=1,2=3,4', '=1,2', '💥=1,2']) {
      expect(() => parseLayoutOverrides({ layout })).not.toThrow()
    }
    expect(parseLayoutOverrides({ layout: '💥=1,2' })).toEqual(overrides({ '💥': { x: 1, y: 2 } }))
  })
})

describe('serializeLayoutOverrides', () => {
  // Null, not `''`: an empty `layout:` line would be a coordinate-free file that
  // still carries the key, which is the diff noise the design exists to avoid.
  it('returns null for an empty map, so the caller omits the key', () => {
    expect(serializeLayoutOverrides(new Map())).toBeNull()
  })

  it('round-trips through parse', () => {
    const map = overrides({ '0:0': { x: 140, y: 40 }, '1:1': { x: -420, y: 90 } })
    const value = serializeLayoutOverrides(map)
    expect(value).not.toBeNull()
    expect(parseLayoutOverrides({ [LAYOUT_META_KEY]: value as string })).toEqual(map)
  })

  // A pixel of drift must not dirty the file, which only works if what is
  // written is what a re-drag to the same spot would write.
  it('rounds to integers', () => {
    expect(serializeLayoutOverrides(overrides({ '0:0': { x: 140.49, y: 40.5 } }))).toBe('0:0=140,41')
    expect(serializeLayoutOverrides(overrides({ '0:0': { x: -0.2, y: -1.5 } }))).toBe('0:0=0,-1')
  })

  it('writes node ids in reading order rather than drag order', () => {
    const map = new Map<string, NodePosition>()
    map.set('10:0', { x: 3, y: 3 })
    map.set('2:1', { x: 2, y: 2 })
    map.set('2:0', { x: 1, y: 1 })
    expect(serializeLayoutOverrides(map)).toBe('2:0=1,1 2:1=2,2 10:0=3,3')
  })

  it('skips an id that could not be read back', () => {
    const map = overrides({
      '': { x: 1, y: 1 },
      'has space': { x: 2, y: 2 },
      'has=equals': { x: 3, y: 3 },
      '0:0': { x: 4, y: 4 }
    })
    expect(serializeLayoutOverrides(map)).toBe('0:0=4,4')
  })

  it('skips a non-finite coordinate rather than writing `NaN` into the file', () => {
    const map = overrides({
      '0:0': { x: Number.NaN, y: 1 },
      '1:0': { x: 1, y: Number.POSITIVE_INFINITY },
      '2:0': { x: 5, y: 6 }
    })
    expect(serializeLayoutOverrides(map)).toBe('2:0=5,6')
  })

  it('returns null when every entry was skipped', () => {
    expect(serializeLayoutOverrides(overrides({ 'has space': { x: 1, y: 1 } }))).toBeNull()
  })
})

describe('withLayoutOverrides', () => {
  it('omits the key when the map is empty', () => {
    expect(withLayoutOverrides({ author: 'adib' }, new Map())).toEqual({ author: 'adib' })
  })

  it('removes an existing key when the map empties', () => {
    const meta = { author: 'adib', layout: '0:0=1,2' }
    expect(withLayoutOverrides(meta, new Map())).toEqual({ author: 'adib' })
  })

  it('sets the key and keeps every other meta key', () => {
    expect(withLayoutOverrides({ author: 'adib' }, overrides({ '0:0': { x: 1, y: 2 } }))).toEqual({
      author: 'adib',
      layout: '0:0=1,2'
    })
  })

  it('does not mutate the record it was given', () => {
    const meta = { author: 'adib' }
    withLayoutOverrides(meta, overrides({ '0:0': { x: 1, y: 2 } }))
    expect(meta).toEqual({ author: 'adib' })
  })
})

describe('pruneLayoutOverrides', () => {
  // Editing the text above a dragged node renumbers its id. The stale key is
  // already inert on read; pruning is what stops it accumulating in the file.
  it('drops ids that no longer name a node', () => {
    const map = overrides({ '0:0': { x: 1, y: 1 }, '5:2': { x: 2, y: 2 } })
    expect(pruneLayoutOverrides(map, ['0:0', '0:1'])).toEqual(
      overrides({ '0:0': { x: 1, y: 1 } })
    )
  })

  it('keeps everything when every id is still live', () => {
    const map = overrides({ '0:0': { x: 1, y: 1 }, '1:0': { x: 2, y: 2 } })
    expect(pruneLayoutOverrides(map, ['1:0', '0:0'])).toEqual(map)
  })

  it('empties when no id survives, and does not mutate the input', () => {
    const map = overrides({ '0:0': { x: 1, y: 1 } })
    expect(pruneLayoutOverrides(map, [])).toEqual(new Map())
    expect(map.size).toBe(1)
  })

  it('agrees with the ids `stepId` produces', () => {
    const map = overrides({ [stepId(0, 0)]: { x: 1, y: 1 }, [stepId(9, 9)]: { x: 2, y: 2 } })
    expect([...pruneLayoutOverrides(map, [stepId(0, 0)]).keys()]).toEqual(['0:0'])
  })
})

describe('withLayoutOverridesText', () => {
  it('inserts the key just above the closing fence', () => {
    const next = withLayoutOverridesText(FILE, overrides({ '0:0': { x: 140, y: 40 } }))
    expect(next).toBe(`---
name: Reading log
description: Keep the reading log in sync
trigger: manual
layout: 0:0=140,40
---

books   = tag #book
good    = books | where rating >= 4
`)
  })

  // Nudging a box must not reformat the file, which is why this is text surgery
  // and not `serializeWorkflow`: the aligned `books   =` survives.
  it('leaves the body byte for byte alone', () => {
    const next = withLayoutOverridesText(FILE, overrides({ '0:0': { x: 1, y: 2 } }))
    expect(next).toContain('books   = tag #book')
    expect(next.slice(next.indexOf('\n---\n') + 5)).toBe(FILE.slice(FILE.indexOf('\n---\n') + 5))
  })

  it('rewrites an existing key where it already sat', () => {
    const withKey = withLayoutOverridesText(FILE, overrides({ '0:0': { x: 1, y: 2 } }))
    const moved = withLayoutOverridesText(withKey, overrides({ '0:0': { x: 9, y: 9 } }))
    expect(moved).toBe(withKey.replace('layout: 0:0=1,2', 'layout: 0:0=9,9'))
  })

  it('removes the key when the overrides are cleared', () => {
    const withKey = withLayoutOverridesText(FILE, overrides({ '0:0': { x: 1, y: 2 } }))
    expect(withLayoutOverridesText(withKey, new Map())).toBe(FILE)
  })

  it('changes nothing when a file with no key is cleared', () => {
    expect(withLayoutOverridesText(FILE, new Map())).toBe(FILE)
  })

  it('collapses duplicate keys onto the one that was in effect', () => {
    const doubled = `---
name: X
layout: 0:0=1,1
trigger: manual
layout: 0:0=2,2
---

tag #book
`
    expect(withLayoutOverridesText(doubled, overrides({ '0:0': { x: 3, y: 3 } }))).toBe(`---
name: X
trigger: manual
layout: 0:0=3,3
---

tag #book
`)
  })

  it('preserves CRLF line endings', () => {
    const crlf = '---\r\nname: X\r\ntrigger: manual\r\n---\r\n\r\ntag #book\r\n'
    const next = withLayoutOverridesText(crlf, overrides({ '0:0': { x: 1, y: 2 } }))
    expect(next).toBe('---\r\nname: X\r\ntrigger: manual\r\nlayout: 0:0=1,2\r\n---\r\n\r\ntag #book\r\n')
  })

  // Accepting a drag and then losing it would be the worst of both worlds, so a
  // fence-less file grows the fence it was always supposed to have.
  it('grows a frontmatter block for a file that has none', () => {
    const next = withLayoutOverridesText('tag #book\n', overrides({ '0:0': { x: 1, y: 2 } }))
    expect(next).toBe('---\nlayout: 0:0=1,2\n---\n\ntag #book\n')
  })

  it('leaves a fence-less file alone when there is nothing to record', () => {
    expect(withLayoutOverridesText('tag #book\n', new Map())).toBe('tag #book\n')
  })
})

describe('a dragged workflow file', () => {
  it('round-trips through the parser without the parser knowing about layout', () => {
    const map = overrides({ '0:0': { x: 140, y: 40 }, '1:0': { x: -20, y: 90 } })
    const { workflow, diagnostics } = parseWorkflow(withLayoutOverridesText(FILE, map), 'reading-log')
    expect(diagnostics).toEqual([])
    expect(parseLayoutOverrides(workflow.meta)).toEqual(map)
    // Unchanged by the drag: the graph is still exactly what the text says.
    expect(workflow.statements.map((statement) => statement.name)).toEqual(['books', 'good'])
  })

  it('survives a canonical save, because the key is just unrecognized meta', () => {
    const map = overrides({ '0:0': { x: 140, y: 40 } })
    const { workflow } = parseWorkflow(withLayoutOverridesText(FILE, map), 'reading-log')
    const reparsed = parseWorkflow(serializeWorkflow(workflow), 'reading-log').workflow
    expect(parseLayoutOverrides(reparsed.meta)).toEqual(map)
  })

  it('returns to a coordinate-free file once the overrides are cleared', () => {
    const dragged = withLayoutOverridesText(FILE, overrides({ '0:0': { x: 1, y: 2 } }))
    const reset = withLayoutOverridesText(dragged, new Map())
    expect(reset).toBe(FILE)
    expect(parseWorkflow(reset, 'reading-log').workflow.meta).toEqual({})
  })
})
