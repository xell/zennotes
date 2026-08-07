import { describe, it, expect } from 'vitest'
import { insertTasksUnderTasksHeading } from './tasklists'

describe('insertTasksUnderTasksHeading (#452)', () => {
  it('inserts under an existing `## Tasks` section, matching the issue example', () => {
    const body =
      '# 2026-07-23\n\n## Tasks\n\n- [ ] Existing task\n\n## Notes\n\n- Meeting notes.\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded task'])
    expect(out).toBe(
      '# 2026-07-23\n\n## Tasks\n\n- [ ] Existing task\n- [ ] Forwarded task\n\n## Notes\n\n- Meeting notes.\n'
    )
  })

  it('appends to the end when there is no Tasks heading', () => {
    const body = '# 2026-07-23\n\n## Notes\n\n- Meeting notes.\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded task'])
    expect(out).toBe(
      '# 2026-07-23\n\n## Notes\n\n- Meeting notes.\n- [ ] Forwarded task\n'
    )
  })

  it('appends under Tasks when it is the last section', () => {
    const body = '# 2026-07-23\n\n## Tasks\n\n- [ ] Existing task\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded task'])
    expect(out).toBe(
      '# 2026-07-23\n\n## Tasks\n\n- [ ] Existing task\n- [ ] Forwarded task\n'
    )
  })

  it('places tasks under an empty Tasks section, keeping a blank line', () => {
    const body = '# 2026-07-23\n\n## Tasks\n\n## Notes\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded task'])
    expect(out).toBe(
      '# 2026-07-23\n\n## Tasks\n\n- [ ] Forwarded task\n## Notes\n'
    )
  })

  it('keeps multiple rolled-over lines together and in order', () => {
    const body = '## Tasks\n\n- [ ] a\n\n## Notes\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] b', '  - [ ] b-child', '- [ ] c'])
    expect(out).toBe('## Tasks\n\n- [ ] a\n- [ ] b\n  - [ ] b-child\n- [ ] c\n\n## Notes\n')
  })

  it('matches other heading levels (`# Tasks`), case-insensitively', () => {
    const body = '# tasks\n\n- [ ] a\n\n# Log\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] b'])
    expect(out).toBe('# tasks\n\n- [ ] a\n- [ ] b\n\n# Log\n')
  })

  it('does not treat a subheading of the Tasks section as its end', () => {
    const body = '## Tasks\n\n- [ ] a\n\n### Later\n\n- [ ] b\n\n## Notes\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] c'])
    // Section runs through the level-3 subheading; the new task lands after the
    // section's last content line.
    expect(out).toBe('## Tasks\n\n- [ ] a\n\n### Later\n\n- [ ] b\n- [ ] c\n\n## Notes\n')
  })

  it('ignores a `## Tasks` line inside a fenced code block', () => {
    const body = '# Doc\n\n```md\n## Tasks\n- [ ] not real\n```\n\n- [ ] real end\n'
    const out = insertTasksUnderTasksHeading(body, ['- [ ] forwarded'])
    // No real Tasks heading -> append to end.
    expect(out).toBe(
      '# Doc\n\n```md\n## Tasks\n- [ ] not real\n```\n\n- [ ] real end\n- [ ] forwarded\n'
    )
  })

  it('returns the body unchanged when there are no task lines', () => {
    const body = '## Tasks\n\n- [ ] a\n'
    expect(insertTasksUnderTasksHeading(body, [])).toBe(body)
  })

  describe('a horizontal rule ends the section (#483)', () => {
    it('inserts above a rule that follows the task list, matching the issue example', () => {
      const body = '## Tasks\n- [ ] Task 1\n- [ ] Task 2\n\n-----\n\n## Notes\n'
      const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded task'])
      expect(out).toBe(
        '## Tasks\n- [ ] Task 1\n- [ ] Task 2\n- [ ] Forwarded task\n\n-----\n\n## Notes\n'
      )
    })

    it('handles every thematic-break spelling', () => {
      // Daily-note templates separate sections with whichever of these the
      // author likes; all of them close the Tasks section.
      for (const rule of ['---', '***', '___', '- - -', '*****', '   ---']) {
        const body = `## Tasks\n- [ ] Task 1\n\n${rule}\n\n## Notes\n`
        const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded'])
        expect(out, `rule ${JSON.stringify(rule)}`).toBe(
          `## Tasks\n- [ ] Task 1\n- [ ] Forwarded\n\n${rule}\n\n## Notes\n`
        )
      }
    })

    it('still appends under Tasks when the rule closes the note', () => {
      const body = '## Tasks\n- [ ] Task 1\n\n---\n'
      const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded'])
      expect(out).toBe('## Tasks\n- [ ] Task 1\n- [ ] Forwarded\n\n---\n')
    })

    it('treats an empty Tasks section followed by a rule as empty', () => {
      const body = '## Tasks\n\n---\n\n## Notes\n'
      const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded'])
      expect(out).toBe('## Tasks\n\n- [ ] Forwarded\n---\n\n## Notes\n')
    })

    it('ignores a rule inside a fenced code block', () => {
      const body = '## Tasks\n- [ ] Task 1\n\n```md\n---\n```\n\n## Notes\n'
      const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded'])
      // The fence is still section content, so the task lands after it.
      expect(out).toBe('## Tasks\n- [ ] Task 1\n\n```md\n---\n```\n- [ ] Forwarded\n\n## Notes\n')
    })

    it('does not mistake a task line or a short dash run for a rule', () => {
      const body = '## Tasks\n- [ ] Task 1\n- -\n\n## Notes\n'
      const out = insertTasksUnderTasksHeading(body, ['- [ ] Forwarded'])
      expect(out).toBe('## Tasks\n- [ ] Task 1\n- -\n- [ ] Forwarded\n\n## Notes\n')
    })
  })
})
