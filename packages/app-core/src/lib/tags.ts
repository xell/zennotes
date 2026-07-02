/**
 * Extract `#tags` from a markdown body. Mirrors the extraction the
 * main process runs in `vault.ts` so the sidebar can update tag
 * counts *live* as the user types, instead of waiting for the save +
 * chokidar round-trip.
 *
 * Rules:
 *  - The hash must be preceded by start-of-line or whitespace (so
 *    `me#tag` and `url.com/#x` don't match).
 *  - The first tag character must be a letter in any script (Cyrillic,
 *    CJK, … — #205), the rest can be letters, digits, `_`, `-`, or `/`.
 *  - Fenced code blocks and inline code spans are stripped first.
 *  - Heading markers (`#`, `##`, …) are not a hashtag because the
 *    character after the hash is a space, not a letter.
 */
export function extractTags(body: string): string[] {
  const stripped = stripCodeContent(body)
  const regex = /(?:^|\s)#(\p{L}[\p{L}\d_/-]*)/gu
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = regex.exec(stripped)) !== null) {
    seen.add(m[1])
  }
  return [...seen]
}

/**
 * Blank out fenced and inline code so the tag scanner never reads code as a
 * tag. Fence detection is line-based and indentation-tolerant: a fence nested
 * under a list item is still a code block, so e.g. a C `#include` line inside
 * it is not a tag (#293). Mirrors `stripCodeContent` in
 * apps/desktop/src/main/vault.ts and apps/server/internal/vault/parse.go —
 * keep the three in sync.
 */
function stripCodeContent(body: string): string {
  if (!body.includes('`') && !body.includes('~')) return body
  const lines = body.split('\n')
  let inFence = false
  let fenceChar = ''
  let fenceLen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line)
    if (m) {
      const marker = m[1] as string
      const char = marker[0] as string
      const rest = m[2] as string
      if (!inFence) {
        // A backtick fence's info string may not contain a backtick (CommonMark).
        if (char === '~' || !rest.includes('`')) {
          inFence = true
          fenceChar = char
          fenceLen = marker.length
          lines[i] = ' '
          continue
        }
      } else if (char === fenceChar && marker.length >= fenceLen && rest.trim() === '') {
        inFence = false
        lines[i] = ' '
        continue
      }
    }
    if (inFence) lines[i] = ' '
  }
  return lines.join('\n').replace(/`[^`\n]*`/g, ' ')
}

/**
 * Does a note's tags satisfy the Tags-view selection? `all` = the note carries
 * every selected tag (AND, the narrowing default, #221); `any` = it carries at
 * least one (OR). Case-insensitive. No selection → no match.
 */
export function matchesSelectedTags(
  noteTags: readonly string[],
  selectedTags: readonly string[],
  mode: 'all' | 'any'
): boolean {
  if (selectedTags.length === 0) return false
  const have = new Set(noteTags.map((t) => t.toLowerCase()))
  const want = selectedTags.map((t) => t.toLowerCase())
  return mode === 'any' ? want.some((t) => have.has(t)) : want.every((t) => have.has(t))
}
