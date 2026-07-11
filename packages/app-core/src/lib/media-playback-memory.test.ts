import { afterEach, describe, expect, it } from 'vitest'
import {
  clearMediaPlaybackMemory,
  forgetMediaPlayback,
  recallMediaPlayback,
  rememberMediaPlayback
} from './media-playback-memory'

afterEach(() => clearMediaPlaybackMemory())

describe('media playback memory', () => {
  it('remembers and recalls a position by src', () => {
    rememberMediaPlayback('zen-asset://local?path=a.mp4', { time: 12.5, wasPlaying: true })
    expect(recallMediaPlayback('zen-asset://local?path=a.mp4')).toEqual({
      time: 12.5,
      wasPlaying: true
    })
  })

  it('returns undefined for an unseen src', () => {
    expect(recallMediaPlayback('zen-asset://local?path=never.mp4')).toBeUndefined()
  })

  it('overwrites the position on the same src', () => {
    rememberMediaPlayback('a.mp4', { time: 1, wasPlaying: true })
    rememberMediaPlayback('a.mp4', { time: 2, wasPlaying: false })
    expect(recallMediaPlayback('a.mp4')).toEqual({ time: 2, wasPlaying: false })
  })

  it('forgets a single src', () => {
    rememberMediaPlayback('a.mp4', { time: 1, wasPlaying: false })
    forgetMediaPlayback('a.mp4')
    expect(recallMediaPlayback('a.mp4')).toBeUndefined()
  })

  it('ignores an empty src', () => {
    rememberMediaPlayback('', { time: 1, wasPlaying: false })
    expect(recallMediaPlayback('')).toBeUndefined()
  })

  it('evicts the least-recently-used entry past the cap', () => {
    // Cap is 30. Insert 31 distinct srcs; the first inserted should be gone.
    for (let i = 0; i < 31; i++) {
      rememberMediaPlayback(`a-${i}.mp4`, { time: i, wasPlaying: false })
    }
    expect(recallMediaPlayback('a-0.mp4')).toBeUndefined()
    expect(recallMediaPlayback('a-30.mp4')).toEqual({ time: 30, wasPlaying: false })
  })

  it('refreshes LRU order on re-remember so an active asset is not evicted', () => {
    for (let i = 0; i < 30; i++) {
      rememberMediaPlayback(`a-${i}.mp4`, { time: i, wasPlaying: false })
    }
    rememberMediaPlayback('a-0.mp4', { time: 999, wasPlaying: true })
    rememberMediaPlayback('a-30.mp4', { time: 30, wasPlaying: false })
    expect(recallMediaPlayback('a-1.mp4')).toBeUndefined()
    expect(recallMediaPlayback('a-0.mp4')).toEqual({ time: 999, wasPlaying: true })
  })
})
