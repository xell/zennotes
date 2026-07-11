import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { recallMediaPlayback, rememberMediaPlayback } from '../lib/media-playback-memory'

/**
 * A focusable wrapper around a native `<video controls>` / `<audio controls>`
 * that gives the whole pane consistent keyboard control, independent of which
 * inner control (the video surface, the seek slider, the play button) actually
 * holds DOM focus.
 *
 * Why this is needed:
 *   - Native media elements only respond to keys when a specific sub-control is
 *     focused, so clicking the video surface then pressing arrows/space did
 *     nothing useful, and clicking the seek slider let arrows seek but space
 *     was inert (the slider has no play/pause).
 *   - VimNav's global key handler runs in the capture phase (before the media
 *     element), so arrows leaked out to sidebar navigation. It now yields for
 *     `[data-zen-media-player]` (see VimNav.tsx), letting these keys reach here.
 *
 * The handler runs in the capture phase and stops propagation for the keys it
 * owns, so the native element never double-handles them (e.g. no double seek
 * when the slider is focused).
 *
 * It also restores playback position across mount/unmount: AssetTabView (and
 * the pinned-reference pane) render only the active tab's content, so
 * switching away from a playing video and back used to always restart it
 * from 0:00. See `lib/media-playback-memory.ts`.
 */
export function MediaPlayer({
  src,
  kind,
  className,
  mediaClassName
}: {
  src: string
  kind: 'video' | 'audio'
  /** Class for the focusable wrapper (owns the pane's layout, e.g. bg + centering). */
  className?: string
  /** Class for the inner media element. */
  mediaClassName?: string
}): JSX.Element {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  // Transient volume HUD shown while adjusting with the keyboard — null when
  // hidden. Mirrors the element's own volume/muted state rather than owning
  // it, so it can never drift from what's actually playing.
  const [volumeHud, setVolumeHud] = useState<{ volume: number; muted: boolean } | null>(null)
  const volumeHudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Grab focus on open so the keyboard works without a click first — but only
  // when nothing else already owns focus, so opening a media tab in a
  // background split can't yank focus away from what the user is doing.
  useEffect(() => {
    const active = document.activeElement
    if (!active || active === document.body) {
      wrapperRef.current?.focus({ preventScroll: true })
    }
  }, [src])

  // Restore a remembered position on mount, and keep it fresh while playing
  // so unmounting (switching tabs) always has an up-to-date last-known state
  // to save. The tracked values live in a ref, not state — updated on every
  // `timeupdate` while playing — so the cleanup below never needs to read
  // back from `mediaRef.current` (which React may have already detached by
  // the time an effect cleanup actually runs) to know what to remember.
  useEffect(() => {
    const el = mediaRef.current
    if (!el) return
    const latest = { time: 0, wasPlaying: false }

    const applyRestore = (): void => {
      const remembered = recallMediaPlayback(src)
      if (!remembered) return
      el.currentTime = remembered.time
      // Set optimistically so switching away again immediately (before a
      // play/pause event has fired) still remembers the right state; the
      // listeners below correct it once real playback events arrive.
      latest.time = remembered.time
      latest.wasPlaying = remembered.wasPlaying
      if (remembered.wasPlaying) void el.play().catch(() => {})
    }
    if (el.readyState >= 1) applyRestore()
    else el.addEventListener('loadedmetadata', applyRestore, { once: true })

    const trackLatest = (): void => {
      latest.time = el.currentTime
      latest.wasPlaying = !el.paused
    }
    el.addEventListener('timeupdate', trackLatest)
    el.addEventListener('play', trackLatest)
    el.addEventListener('pause', trackLatest)
    el.addEventListener('seeked', trackLatest)

    return () => {
      el.removeEventListener('loadedmetadata', applyRestore)
      el.removeEventListener('timeupdate', trackLatest)
      el.removeEventListener('play', trackLatest)
      el.removeEventListener('pause', trackLatest)
      el.removeEventListener('seeked', trackLatest)
      rememberMediaPlayback(src, latest)
    }
  }, [src])

  useEffect(() => {
    return () => {
      if (volumeHudTimerRef.current) clearTimeout(volumeHudTimerRef.current)
    }
  }, [])

  const VOLUME_STEP = 0.05
  const VOLUME_HUD_HIDE_MS = 1500
  const SEEK_STEP_SECONDS = 5
  const SEEK_STEP_SECONDS_LONG = 30

  // Shows the volume HUD reflecting the element's current volume/muted state,
  // and (re)schedules it to auto-hide — repeated key presses keep resetting
  // the timer rather than stacking multiple hides.
  const flashVolumeHud = (el: HTMLVideoElement | HTMLAudioElement): void => {
    setVolumeHud({ volume: el.volume, muted: el.muted })
    if (volumeHudTimerRef.current) clearTimeout(volumeHudTimerRef.current)
    volumeHudTimerRef.current = setTimeout(() => {
      volumeHudTimerRef.current = null
      setVolumeHud(null)
    }, VOLUME_HUD_HIDE_MS)
  }

  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
    const el = mediaRef.current
    if (!el) return
    // Leave real app shortcuts (⌘/Ctrl/Alt chords) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return

    const handled = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }

    switch (e.key) {
      case ' ':
      case 'k':
        handled()
        if (el.paused) void el.play().catch(() => {})
        else el.pause()
        return
      case 'ArrowLeft': {
        handled()
        const step = e.shiftKey ? SEEK_STEP_SECONDS_LONG : SEEK_STEP_SECONDS
        el.currentTime = Math.max(0, el.currentTime - step)
        return
      }
      case 'ArrowRight': {
        handled()
        const step = e.shiftKey ? SEEK_STEP_SECONDS_LONG : SEEK_STEP_SECONDS
        el.currentTime = Math.min(
          Number.isFinite(el.duration) ? el.duration : el.currentTime + step,
          el.currentTime + step
        )
        return
      }
      case 'ArrowUp':
        handled()
        el.muted = false
        el.volume = Math.min(1, el.volume + VOLUME_STEP)
        flashVolumeHud(el)
        return
      case 'ArrowDown':
        handled()
        el.volume = Math.max(0, el.volume - VOLUME_STEP)
        flashVolumeHud(el)
        return
      case 'm':
        handled()
        el.muted = !el.muted
        flashVolumeHud(el)
        return
      case 'f':
        // Fullscreen only makes sense for video.
        if (kind !== 'video') return
        handled()
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
        else void el.requestFullscreen?.().catch(() => {})
        return
      default:
        return
    }
  }

  // Clicking the letterbox / padding area (not the media element or its native
  // controls) grabs focus so keyboard control resumes. Clicks landing on the
  // media element keep their own native focus, which is still inside the
  // wrapper, so the capture handler above still fires.
  const onMouseDown = (e: MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest('video, audio')) return
    wrapperRef.current?.focus({ preventScroll: true })
  }

  const volumePercent = volumeHud ? Math.round((volumeHud.muted ? 0 : volumeHud.volume) * 100) : 0

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      data-zen-media-player
      onKeyDownCapture={onKeyDownCapture}
      onMouseDown={onMouseDown}
      className={['relative outline-none', className].filter(Boolean).join(' ')}
    >
      {kind === 'video' ? (
        <video ref={mediaRef} src={src} controls className={mediaClassName} />
      ) : (
        <audio ref={mediaRef} src={src} controls className={mediaClassName} />
      )}
      {volumeHud && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-white shadow-lg">
            <SpeakerIcon muted={volumeHud.muted} width={16} height={16} className="shrink-0" />
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/25">
              <div
                className="h-full rounded-full bg-white transition-[width]"
                style={{ width: `${volumePercent}%` }}
              />
            </div>
            <span className="w-9 text-right text-xs tabular-nums">{volumePercent}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

function SpeakerIcon({
  muted,
  width = 16,
  height = 16,
  className
}: {
  muted: boolean
  width?: number
  height?: number
  className?: string
}): JSX.Element {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      {muted ? (
        <path d="M17 9l4 6M21 9l-4 6" />
      ) : (
        <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
      )}
    </svg>
  )
}
