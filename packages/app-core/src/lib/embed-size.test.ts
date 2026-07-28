// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { parseImageEmbedLabel } from './embed-size'

// The single place both rendering surfaces agree on what an embed label means:
// `![[image.png|600]]` is a render size, `![[chart.png|Q3 revenue]]` is alt
// text. Getting this wrong in either direction is a visible regression — either
// sizes stop working, or captions written before sizes existed get eaten.
describe('parseImageEmbedLabel', () => {
  it('reads a bare width', () => {
    expect(parseImageEmbedLabel('600')).toEqual({ alt: '', width: 600, height: undefined })
  })

  it('reads width x height', () => {
    expect(parseImageEmbedLabel('600x400')).toEqual({ alt: '', width: 600, height: 400 })
  })

  it('keeps alt text that precedes a size', () => {
    expect(parseImageEmbedLabel('A cat|600')).toEqual({ alt: 'A cat', width: 600, height: undefined })
  })

  it('treats a non-size label as alt text', () => {
    expect(parseImageEmbedLabel('Q3 revenue')).toEqual({ alt: 'Q3 revenue' })
  })

  it('does not mistake digits inside a caption for a size', () => {
    expect(parseImageEmbedLabel('Q3 revenue 600')).toEqual({ alt: 'Q3 revenue 600' })
  })

  it('only accepts a size as the final segment', () => {
    expect(parseImageEmbedLabel('600|A cat')).toEqual({ alt: '600|A cat' })
  })

  it('ignores a partial or malformed size', () => {
    expect(parseImageEmbedLabel('600x')).toEqual({ alt: '600x' })
    expect(parseImageEmbedLabel('x400')).toEqual({ alt: 'x400' })
    expect(parseImageEmbedLabel('60.5')).toEqual({ alt: '60.5' })
    expect(parseImageEmbedLabel('-600')).toEqual({ alt: '-600' })
  })

  it('handles an absent or blank label', () => {
    expect(parseImageEmbedLabel(null)).toEqual({ alt: '' })
    expect(parseImageEmbedLabel(undefined)).toEqual({ alt: '' })
    expect(parseImageEmbedLabel('   ')).toEqual({ alt: '' })
  })

  it('trims whitespace around both parts', () => {
    expect(parseImageEmbedLabel('  A cat | 600 ')).toEqual({
      alt: 'A cat',
      width: 600,
      height: undefined
    })
  })
})
