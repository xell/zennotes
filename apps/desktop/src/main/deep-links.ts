import path from 'node:path'

export const ZENNOTES_DEEP_LINK_SCHEME = 'zennotes'

export type OpenNoteDeepLinkTarget = 'tab' | 'window'

export interface OpenNoteDeepLinkRequest {
  target: OpenNoteDeepLinkTarget
  path: string
}

export interface CloudAuthDeepLinkRequest {
  code: string
  state: string
}

const OPEN_NOTE_ACTION_TARGETS: Record<string, OpenNoteDeepLinkTarget> = {
  open: 'tab',
  'open-window': 'window'
}

function deepLinkAction(parsed: URL): string {
  return parsed.hostname || parsed.pathname.replace(/^\/+/, '')
}

export function parseQuickCaptureDeepLink(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed) return false

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }

  return parsed.protocol === `${ZENNOTES_DEEP_LINK_SCHEME}:` && deepLinkAction(parsed) === 'quick-capture'
}

export function parseCloudAuthDeepLink(rawUrl: string): CloudAuthDeepLinkRequest | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== `${ZENNOTES_DEEP_LINK_SCHEME}:` || deepLinkAction(parsed) !== 'auth') {
    return null
  }

  const code = parsed.searchParams.get('code') ?? ''
  const state = parsed.searchParams.get('state') ?? ''
  if (!/^[A-Za-z0-9]+$/.test(code) || code.length > 256) return null
  if (!/^[A-Za-z0-9._-]+$/.test(state) || state.length > 128) return null

  return { code, state }
}

export function parseOpenNoteDeepLink(rawUrl: string): OpenNoteDeepLinkRequest | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== `${ZENNOTES_DEEP_LINK_SCHEME}:`) return null

  const action = deepLinkAction(parsed)
  const target = OPEN_NOTE_ACTION_TARGETS[action]
  if (!target) return null

  const notePath = normalizeDeepLinkNotePath(parsed.searchParams.get('path'))
  return notePath ? { target, path: notePath } : null
}

/** The inverse of parseOpenNoteDeepLink: the shareable URL that opens a
 *  vault-relative note in the app. Segments are percent-encoded so titles
 *  with spaces, `#`, `?` or `&` survive; slashes stay readable. Parens are
 *  encoded beyond what encodeURIComponent does because these URLs live
 *  inside markdown `[title](url)` links, where a bare `)` ends the link. */
export function buildOpenNoteDeepLink(relPath: string): string {
  const encoded = relPath
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    .join('/')
  return `${ZENNOTES_DEEP_LINK_SCHEME}://open?path=${encoded}`
}

export function normalizeDeepLinkNotePath(rawPath: string | null | undefined): string | null {
  const trimmed = rawPath?.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  const slashPath = trimmed.replace(/\\/g, '/')
  if (slashPath.startsWith('/') || /^[a-zA-Z]:\//.test(slashPath)) return null
  if (slashPath.split('/').some((part) => part === '..')) return null

  const normalized = path.posix.normalize(slashPath)
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  if (path.posix.isAbsolute(normalized)) return null

  return normalized
}
