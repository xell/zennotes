/**
 * Per-asset playback memory for the media player.
 *
 * AssetTabView (and the pinned-reference pane) render only the active tab's
 * content, so switching away from a playing video/audio and back otherwise
 * always restarted it from 0:00. This is a small imperative cache — keyed by
 * the asset's resolved `zen-asset://` URL — that remembers the last known
 * playback position and whether it was playing, so re-activating the tab can
 * seek back to it and resume.
 *
 * It's intentionally a module-level cache, not store state: nothing renders
 * from it, it's read/written imperatively on mount/unmount, and it should
 * never trigger a React update. Entries are capped with simple LRU eviction
 * so long sessions don't grow it without bound. Session-only — like tab
 * scroll memory, it doesn't survive an app restart.
 */
export interface MediaPlaybackPosition {
  time: number
  wasPlaying: boolean
}

const MEDIA_PLAYBACK_MEMORY_LIMIT = 30
const memory = new Map<string, MediaPlaybackPosition>()

export function rememberMediaPlayback(src: string, position: MediaPlaybackPosition): void {
  if (!src) return
  // Re-insert so the most recently touched entry is last (LRU ordering).
  memory.delete(src)
  memory.set(src, position)
  while (memory.size > MEDIA_PLAYBACK_MEMORY_LIMIT) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function recallMediaPlayback(src: string): MediaPlaybackPosition | undefined {
  return memory.get(src)
}

export function forgetMediaPlayback(src: string): void {
  memory.delete(src)
}

/** Test-only: drop all remembered positions. */
export function clearMediaPlaybackMemory(): void {
  memory.clear()
}
