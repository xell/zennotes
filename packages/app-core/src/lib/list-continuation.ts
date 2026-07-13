/**
 * Compute the list-marker prefix to start a new item that continues the list on
 * `lineText`, or `null` when the line is not a list item.
 *
 * Used by the Vim `o`/`O` open-line actions so that opening a line on a list
 * item carries the marker forward (like pressing Enter): bullets repeat, ordered
 * numbers advance (the ordered-list renumber pass corrects the exact value for
 * both `o` and `O`), indentation is preserved, and a task checkbox continues as
 * a fresh unchecked box.
 *
 *   "- foo"        → "- "
 *   "  * bar"      → "  * "
 *   "3. baz"       → "4. "
 *   "2) qux"       → "3) "
 *   "- [x] done"   → "- [ ] "
 *   "plain text"   → null
 */
export function listContinuationPrefix(lineText: string): string | null {
  const match = lineText.match(/^([ \t]*)(?:([-+*])|(\d{1,9})([.)]))[ \t]+(\[[ xX]\][ \t]+)?/)
  if (!match) return null
  const [, indent, bullet, orderedNumber, orderedDelimiter, checkbox] = match
  const marker = bullet ?? `${Number.parseInt(orderedNumber, 10) + 1}${orderedDelimiter}`
  return `${indent}${marker} ${checkbox ? '[ ] ' : ''}`
}
