// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearImageCache,
  imageCacheKey,
  imageCacheStats,
  rememberImageOnLoad,
  takeCachedImage
} from './image-element-cache'

// jsdom never actually loads images, so fake the decoded dimensions the cache
// reads for its budget accounting.
function loadedImage(width: number, height: number): HTMLImageElement {
  const img = document.createElement('img')
  Object.defineProperty(img, 'complete', { value: true })
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  return img
}

beforeEach(() => {
  clearImageCache()
  document.body.innerHTML = ''
})

describe('#472 image element cache', () => {
  it('hands back a remembered element instead of forcing a reload', () => {
    const key = imageCacheKey('zen-asset://x/a.png', 100)
    expect(takeCachedImage(key)).toBeNull()

    const img = loadedImage(800, 600)
    rememberImageOnLoad(key, img)

    expect(takeCachedImage(key)).toBe(img)
  })

  it('will not hand out an element that is still on screen', () => {
    // The same asset embedded twice can be visible at once, and one element
    // cannot live in two places.
    const key = imageCacheKey('zen-asset://x/a.png', 100)
    const img = loadedImage(800, 600)
    rememberImageOnLoad(key, img)
    document.body.append(img)

    expect(takeCachedImage(key)).toBeNull()

    img.remove()
    expect(takeCachedImage(key)).toBe(img)
  })

  it('treats a changed file as a different image (#472 staleness guard)', () => {
    const url = 'zen-asset://x/a.png'
    const img = loadedImage(800, 600)
    rememberImageOnLoad(imageCacheKey(url, 100), img)

    // Same path, newer mtime: must miss, or an edited image would keep
    // rendering the old bitmap.
    expect(takeCachedImage(imageCacheKey(url, 200))).toBeNull()
    expect(takeCachedImage(imageCacheKey(url, 100))).toBe(img)
  })

  it('evicts least-recently-used entries to stay inside the pixel budget', () => {
    const budget = imageCacheStats().budget
    // Four images at 40% of budget each: the fourth cannot coexist with all
    // three predecessors.
    const side = Math.floor(Math.sqrt(budget * 0.4))
    const keys = ['a', 'b', 'c', 'd'].map((n) => imageCacheKey(`zen-asset://x/${n}.png`, 1))
    for (const k of keys) rememberImageOnLoad(k, loadedImage(side, side))

    expect(imageCacheStats().pixels).toBeLessThanOrEqual(budget)
    // The oldest went first, the newest survived.
    expect(takeCachedImage(keys[0])).toBeNull()
    expect(takeCachedImage(keys[3])).not.toBeNull()
  })

  it('keeps a re-read entry alive over an older one', () => {
    const budget = imageCacheStats().budget
    const side = Math.floor(Math.sqrt(budget * 0.4))
    const a = imageCacheKey('zen-asset://x/a.png', 1)
    const b = imageCacheKey('zen-asset://x/b.png', 1)
    rememberImageOnLoad(a, loadedImage(side, side))
    rememberImageOnLoad(b, loadedImage(side, side))

    // Touch `a` so `b` becomes the least recently used.
    const reused = takeCachedImage(a)
    expect(reused).not.toBeNull()

    rememberImageOnLoad(imageCacheKey('zen-asset://x/c.png', 1), loadedImage(side, side))
    expect(imageCacheStats().pixels).toBeLessThanOrEqual(budget)
    expect(takeCachedImage(b)).toBeNull()
  })

  it('refuses an image bigger than the whole budget rather than thrashing', () => {
    const budget = imageCacheStats().budget
    const side = Math.ceil(Math.sqrt(budget * 2))
    const key = imageCacheKey('zen-asset://x/huge.png', 1)
    rememberImageOnLoad(key, loadedImage(side, side))

    expect(imageCacheStats().entries).toBe(0)
    expect(takeCachedImage(key)).toBeNull()
  })

  it('only admits an image once it has actually decoded', () => {
    const key = imageCacheKey('zen-asset://x/pending.png', 1)
    const img = document.createElement('img') // not complete, no dimensions
    rememberImageOnLoad(key, img)

    expect(imageCacheStats().entries).toBe(0)
    expect(takeCachedImage(key)).toBeNull()
  })
})
