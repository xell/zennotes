/**
 * Count words in a markdown body the way Obsidian does: strip the
 * YAML frontmatter, then treat every whitespace-separated token as
 * a word. Code blocks and inline code stay counted — Obsidian
 * counts the words inside them and an earlier implementation
 * stripping them caused issue #43 (huge undercounts on code-heavy
 * notes).
 */
export function countWords(body: string): number {
  const stripped = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
  const matches = stripped.match(/\S+/g)
  return matches?.length ?? 0
}

export const READING_WORDS_PER_MINUTE = 200

export interface ReadingStats {
  words: number
  characters: number
  /** Exact reading time in minutes (words / wpm), not rounded — use
   *  formatReadingMinutes for display so the "< 1 minute" case is honest. */
  minutes: number
}

/**
 * The word / character / reading-time triple shown in the header stats.
 * Shared so the whole-note stat and the selection stat count identically —
 * selecting the entire note reproduces the whole-note numbers exactly.
 */
export function readingStats(text: string): ReadingStats {
  const words = countWords(text)
  return {
    words,
    characters: text.length,
    minutes: words / READING_WORDS_PER_MINUTE
  }
}

/**
 * Reading time for display. Anything under a real minute reads as `<1`
 * (so a two-word selection no longer claims a full minute); a minute or
 * more rounds to the nearest whole minute. Empty content is `0`.
 */
export function formatReadingMinutes(minutes: number): string {
  if (minutes <= 0) return '0'
  if (minutes < 1) return '<1'
  return String(Math.round(minutes))
}
