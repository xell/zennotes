/**
 * Keeps recently shown image elements alive across live-preview widget
 * rebuilds. (#472)
 *
 * CodeMirror destroys a widget's DOM when it scrolls out of the viewport and
 * builds a fresh one when it scrolls back. `zen-asset://` responses never go
 * through Chromium's HTTP cache (custom protocol handlers are not routed
 * through it, and the renderer sends no conditional request headers, so
 * ETag/304 cannot help), which made every re-entry re-read the file, ship it
 * over IPC and decode it again. Measured on a 1600x1200 image: 12ms median,
 * 25ms worst, every single time, visible as the image blanking then popping
 * back in mid-scroll.
 *
 * Reusing the element skips the fetch and the decode, so a scroll-back paints
 * immediately. That costs memory, so the budget is counted in decoded pixels
 * rather than entries: a file's size says nothing about its decode cost, and
 * one phone photo can outweigh a dozen screenshots.
 */

/** ~64MB at 4 bytes per pixel. Roughly four typical screenshots, or one
 *  full-resolution phone photo. Deliberately modest: scrolling back over what
 *  you just read is the common case, and jumping back many screens is rare, so
 *  the benefit flattens out well before the memory cost does. */
const MAX_CACHED_PIXELS = 16_000_000

interface Entry {
  img: HTMLImageElement
  pixels: number
}

/** Insertion order doubles as the LRU order: re-inserting on hit moves an
 *  entry to the back, so the front is always the least recently used. */
const cache = new Map<string, Entry>()
let cachedPixels = 0

/** Cache identity for an asset. The mtime is part of the key so an image
 *  edited on disk misses the cache and reloads, rather than showing a stale
 *  bitmap. */
export function imageCacheKey(url: string, version: number): string {
  return `${url}|${version}`
}

/**
 * A fully loaded element for this key that isn't currently in the document,
 * or null. Returning it hands ownership to the caller, which re-inserts it.
 */
export function takeCachedImage(key: string): HTMLImageElement | null {
  const hit = cache.get(key)
  if (!hit) return null
  // The same asset embedded twice can be on screen at once, and one element
  // can only live in one place; let the second occurrence build its own.
  if (hit.img.isConnected) return null
  if (!hit.img.complete || hit.img.naturalWidth === 0) return null
  cache.delete(key)
  cache.set(key, hit)
  return hit.img
}

function evictToBudget(): void {
  for (const [key, entry] of cache) {
    if (cachedPixels <= MAX_CACHED_PIXELS) break
    cache.delete(key)
    cachedPixels -= entry.pixels
  }
}

/**
 * Remember `img` under `key` once it has decoded. Called on the elements we
 * build ourselves; a cache hit is already remembered.
 */
export function rememberImageOnLoad(key: string, img: HTMLImageElement): void {
  const admit = (): void => {
    if (!img.complete || img.naturalWidth === 0) return
    const pixels = img.naturalWidth * img.naturalHeight
    // A single image larger than the whole budget would evict everything and
    // then itself; skip it rather than thrash.
    if (pixels > MAX_CACHED_PIXELS) return
    const existing = cache.get(key)
    if (existing) cachedPixels -= existing.pixels
    cache.delete(key)
    cache.set(key, { img, pixels })
    cachedPixels += pixels
    evictToBudget()
  }
  if (img.complete && img.naturalWidth > 0) {
    admit()
    return
  }
  img.addEventListener('load', admit, { once: true })
}

/** Test/diagnostic view of the cache. */
export function imageCacheStats(): { entries: number; pixels: number; budget: number } {
  return { entries: cache.size, pixels: cachedPixels, budget: MAX_CACHED_PIXELS }
}

/** Drop everything. Used by tests; also a safe reset if a vault closes. */
export function clearImageCache(): void {
  cache.clear()
  cachedPixels = 0
}
