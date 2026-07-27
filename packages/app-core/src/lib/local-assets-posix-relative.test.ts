// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { posixRelative, resolveAssetExactPath } from './local-assets'
import { useStore } from '../store'

// posixRelative underpins the asset-move reference rewrite: it turns the moved
// asset's vault-relative path into a note-relative href so the rewritten link is
// portable to standard Markdown viewers AND tier-1 resolvable in ZenNotes.
describe('posixRelative', () => {
  it('is identity for a note at the vault root', () => {
    expect(posixRelative('', 'assets/a.jpg')).toBe('assets/a.jpg')
  })

  it('strips the shared prefix for a note whose folder is an ancestor', () => {
    expect(posixRelative('a-folder', 'a-folder/assets/a.jpg')).toBe('assets/a.jpg')
  })

  it('points into the note folder when the asset sits directly under it', () => {
    expect(posixRelative('a-folder', 'a-folder/a.jpg')).toBe('a.jpg')
  })

  it('walks up for a deeper note', () => {
    expect(posixRelative('a-folder/sub', 'a-folder/assets/a.jpg')).toBe('../assets/a.jpg')
  })

  it('walks up and across for a sibling-subtree asset', () => {
    expect(posixRelative('a-folder/x', 'b-folder/a.jpg')).toBe('../../b-folder/a.jpg')
  })
})

// resolveAssetExactPath is tier-1-only (no basename fallback): it distinguishes
// an explicit-path link (which must follow a moving note) from a bare-name link.
describe('resolveAssetExactPath', () => {
  afterEach(() => useStore.setState({ assetFiles: [] }))
  const seed = (...paths: string[]): void =>
    useStore.setState({
      assetFiles: paths.map((p) => ({ path: p, name: p.split('/').pop()!, ext: '.jpg' })) as never
    })

  it('resolves an explicit note-relative path that exists', () => {
    seed('a-folder/assets/a.jpg')
    expect(resolveAssetExactPath('/root', 'a-folder/note.md', 'assets/a.jpg')).toBe(
      'a-folder/assets/a.jpg'
    )
  })

  it('returns null for a bare name that only a basename search would find', () => {
    seed('a-folder/assets/a.jpg')
    // No asset at a-folder/a.jpg — tier 1 misses, and there is no fallback here.
    expect(resolveAssetExactPath('/root', 'a-folder/note.md', 'a.jpg')).toBeNull()
  })

  it('resolves a leading-slash href against the vault root', () => {
    seed('a-folder/a.jpg')
    expect(resolveAssetExactPath('/root', 'x/note.md', '/a-folder/a.jpg')).toBe('a-folder/a.jpg')
  })

  it('strips a #fragment before matching (PDF page refs)', () => {
    seed('a-folder/doc.pdf')
    expect(resolveAssetExactPath('/root', 'a-folder/note.md', 'doc.pdf#page=2')).toBe(
      'a-folder/doc.pdf'
    )
  })

  it('returns null when the explicit path points nowhere', () => {
    seed('a-folder/assets/a.jpg')
    expect(resolveAssetExactPath('/root', 'a-folder/note.md', 'other/a.jpg')).toBeNull()
  })
})
