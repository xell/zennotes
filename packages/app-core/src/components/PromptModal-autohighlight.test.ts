import { describe, expect, it } from 'vitest'
import { activeSuggestionAfterInput } from './PromptModal'

// #467: folder pickers preselect the first match as you type, so Enter picks it
// without an arrow key. Other prompts (autoHighlightFirst off) keep the typed
// value selected so Enter submits exactly what was typed.
describe('#467 — activeSuggestionAfterInput', () => {
  it('preselects the first suggestion once a non-empty query is typed (folder picker)', () => {
    expect(activeSuggestionAfterInput('Work', true)).toBe(0)
    expect(activeSuggestionAfterInput('inbox/Research', true)).toBe(0)
  })

  it('keeps the typed value selected for an empty / whitespace query', () => {
    // Empty query = no filter, so Enter should still create at the typed/root value.
    expect(activeSuggestionAfterInput('', true)).toBe(-1)
    expect(activeSuggestionAfterInput('   ', true)).toBe(-1)
  })

  it('leaves the typed value selected when auto-highlight is off (default prompts)', () => {
    expect(activeSuggestionAfterInput('Work', false)).toBe(-1)
    expect(activeSuggestionAfterInput('', false)).toBe(-1)
  })
})
