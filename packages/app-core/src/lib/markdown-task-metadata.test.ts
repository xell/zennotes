// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('task metadata chips in the reading preview (#479)', () => {
  it('chips priority, due date and fields inside a task item', () => {
    const html = renderMarkdown('- [ ] Ship it !high due:2026-07-20 @waiting')
    expect(html).toContain('<span class="zen-task-prio zen-task-prio-high">!high</span>')
    expect(html).toContain('data-due="2026-07-20"')
    expect(html).toContain('<span class="zen-task-meta zen-task-field">@waiting</span>')
  })

  it('marks each priority level, shorthand spellings included', () => {
    const html = renderMarkdown('- [ ] a !med\n- [ ] b !l\n- [x] c !h')
    expect(html).toContain('zen-task-prio-med')
    expect(html).toContain('zen-task-prio-low')
    expect(html).toContain('zen-task-prio-high')
  })

  it('leaves the same tokens alone outside a task item', () => {
    const html = renderMarkdown('A paragraph with !high and due:2026-07-20 and @waiting\n\n- a list !high')
    expect(html).not.toContain('zen-task-prio')
    expect(html).not.toContain('zen-task-meta')
  })

  it('never touches tokens inside inline code or a fenced block', () => {
    const html = renderMarkdown('- [ ] Write `!high` in docs\n\n```md\n- [ ] Example !low\n```')
    expect(html).toContain('<code>!high</code>')
    expect(html).not.toContain('zen-task-prio')
  })

  it('leaves the due chip date-neutral — the overdue tint is applied on attach', () => {
    // The rendered HTML is cached and outlives "today", so the plugin must not
    // bake in an overdue decision; Preview decides it against the current date.
    const html = renderMarkdown('- [ ] Overdue thing due:2000-01-01')
    expect(html).toContain('zen-task-due')
    expect(html).not.toContain('zen-task-due-overdue')
  })

  it('keeps hashtags as tag links rather than swallowing them', () => {
    const html = renderMarkdown('- [ ] Ship it !high #release')
    expect(html).toContain('class="hashtag"')
    expect(html).toContain('zen-task-prio-high')
  })

  it('marks metadata on a nested task item too', () => {
    const html = renderMarkdown('- [ ] Parent !low\n  - [ ] Child !high')
    expect(html).toContain('zen-task-prio-low')
    expect(html).toContain('zen-task-prio-high')
  })
})
