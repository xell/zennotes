/**
 * URL embeds — a ```embed fence holding a URL renders as an inline iframe in
 * the reading/split view (Notion-style). Preview.tsx calls `renderEmbeds` after
 * each markdown render, mirroring the diagram renderers.
 *
 * Providers are curated: each recognized host maps to a known, sandbox-friendly
 * player URL, and only those hosts are opened up in the renderer/server CSP
 * `frame-src`. An unrecognized URL falls back to a plain link rather than an
 * arbitrary iframe.
 */

export interface ParsedEmbed {
  /** The iframe `src` to load. */
  src: string
  /** Accessible title for the iframe. */
  title: string
  /** width / height ratio for the responsive box (16/9 for video). */
  aspectRatio: number
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') return u.pathname.slice(1) || null
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v')
    const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([^/?#]+)/)
    if (m) return m[1]
  }
  return null
}

function vimeoId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, '')
  if (host === 'vimeo.com') {
    const m = u.pathname.match(/^\/(\d+)/)
    if (m) return m[1]
  }
  if (host === 'player.vimeo.com') {
    const m = u.pathname.match(/^\/video\/(\d+)/)
    if (m) return m[1]
  }
  return null
}

/** Map a raw URL to a curated embed, or null when the provider isn't supported. */
export function parseEmbed(rawUrl: string): ParsedEmbed | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null

  const yt = youtubeId(u)
  if (yt) {
    const params = new URLSearchParams()
    // Carry a start time from `?t=`/`?start=` (supports `1m30s` or plain seconds).
    const t = u.searchParams.get('t') ?? u.searchParams.get('start')
    const start = t ? parseStartSeconds(t) : null
    if (start) params.set('start', String(start))
    const query = params.toString()
    return {
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}${query ? `?${query}` : ''}`,
      title: 'YouTube video',
      aspectRatio: 16 / 9
    }
  }

  const vm = vimeoId(u)
  if (vm) {
    return {
      src: `https://player.vimeo.com/video/${encodeURIComponent(vm)}`,
      title: 'Vimeo video',
      aspectRatio: 16 / 9
    }
  }

  return null
}

/** `90`, `1m30s`, `1h2m3s` → seconds. */
function parseStartSeconds(value: string): number | null {
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10)
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return (
    Number.parseInt(m[1] ?? '0', 10) * 3600 +
    Number.parseInt(m[2] ?? '0', 10) * 60 +
    Number.parseInt(m[3] ?? '0', 10)
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render a single embed into `el` (the iframe, or a link fallback). Shared by
 *  the preview placeholders and the live-editor widget. */
export function renderEmbedElement(el: HTMLElement, rawUrl: string): void {
  const url = rawUrl.trim()
  if (!url) {
    el.innerHTML = ''
    return
  }
  const parsed = parseEmbed(url)
  if (!parsed) {
    // Unsupported provider: keep the URL as a clickable link rather than
    // embedding an arbitrary site in an iframe.
    el.innerHTML = `<div class="zen-embed-unsupported">Can't embed this link yet — <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></div>`
    return
  }
  const surface = document.createElement('div')
  surface.className = 'zen-embed-frame'
  surface.style.aspectRatio = String(parsed.aspectRatio)
  const iframe = document.createElement('iframe')
  iframe.src = parsed.src
  iframe.title = parsed.title
  iframe.loading = 'lazy'
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  iframe.setAttribute('frameborder', '0')
  iframe.setAttribute(
    'allow',
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
  )
  iframe.setAttribute('allowfullscreen', 'true')
  surface.appendChild(iframe)
  el.innerHTML = ''
  el.appendChild(surface)
}

/**
 * Fill every `.zen-embed` placeholder inside `root` with its iframe (or a link
 * fallback for an unsupported URL). Re-runs are a no-op on unchanged blocks
 * (stamped `data-zen-embed-rendered`) so the video isn't reloaded on re-render.
 */
export function renderEmbeds(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.zen-embed'))) {
    const url = (el.getAttribute('data-embed-url') ?? el.textContent ?? '').trim()
    if (el.getAttribute('data-zen-embed-rendered') === url) continue
    el.setAttribute('data-zen-embed-rendered', url)
    el.setAttribute('data-embed-url', url)
    renderEmbedElement(el, url)
  }
}

// ---------------------------------------------------------------------------
// Bookmark cards
// ---------------------------------------------------------------------------

interface LinkMeta {
  url: string
  ok: boolean
  title?: string
  description?: string
  image?: string
  favicon?: string
  siteName?: string
}

// Metadata is fetched once per URL per session and reused across re-renders and
// notes (the same link often appears more than once).
const metaCache = new Map<string, Promise<LinkMeta>>()

function fetchMeta(url: string): Promise<LinkMeta> {
  let p = metaCache.get(url)
  if (!p) {
    const fetcher = window.zen?.fetchLinkMetadata
    p =
      typeof fetcher === 'function'
        ? Promise.resolve(fetcher(url)).catch(() => ({ url, ok: false }) as LinkMeta)
        : Promise.resolve({ url, ok: false } as LinkMeta)
    metaCache.set(url, p)
  }
  return p
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function buildBookmarkCard(el: HTMLElement, url: string, meta: LinkMeta): void {
  const host = hostnameOf(url)
  const title = meta.title || host
  const anchor = document.createElement('a')
  anchor.className = 'zen-bookmark-card'
  anchor.href = url
  anchor.setAttribute('title', url)
  // Open the link ourselves so a card in the live editor opens externally
  // (never navigates the app), and stop the click bubbling to the editor/preview
  // so it isn't also treated as a "reveal source" click.
  anchor.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    window.open(url, '_blank', 'noopener,noreferrer')
  })

  const body = document.createElement('div')
  body.className = 'zen-bookmark-body'

  const titleEl = document.createElement('div')
  titleEl.className = 'zen-bookmark-title'
  titleEl.textContent = title
  body.appendChild(titleEl)

  if (meta.description) {
    const desc = document.createElement('div')
    desc.className = 'zen-bookmark-desc'
    desc.textContent = meta.description
    body.appendChild(desc)
  }

  const foot = document.createElement('div')
  foot.className = 'zen-bookmark-foot'
  if (meta.favicon) {
    const fav = document.createElement('img')
    fav.className = 'zen-bookmark-favicon'
    fav.src = meta.favicon
    fav.alt = ''
    fav.addEventListener('error', () => fav.remove())
    foot.appendChild(fav)
  }
  const urlEl = document.createElement('span')
  urlEl.className = 'zen-bookmark-url'
  urlEl.textContent = meta.siteName || host
  foot.appendChild(urlEl)
  body.appendChild(foot)

  anchor.appendChild(body)

  if (meta.image) {
    const thumbWrap = document.createElement('div')
    thumbWrap.className = 'zen-bookmark-thumb'
    const thumb = document.createElement('img')
    thumb.src = meta.image
    thumb.alt = ''
    thumb.addEventListener('error', () => thumbWrap.remove())
    thumbWrap.appendChild(thumb)
    anchor.appendChild(thumbWrap)
  }

  el.innerHTML = ''
  el.appendChild(anchor)
}

/** Render a single bookmark card into `el`: an immediate host/link placeholder,
 *  then an async upgrade with fetched metadata. Shared by the preview
 *  placeholders and the live-editor widget. `token` guards the async fill so a
 *  recycled element isn't overwritten. */
export function renderBookmarkElement(el: HTMLElement, rawUrl: string, token: string): void {
  const url = rawUrl.trim()
  if (!url) {
    el.innerHTML = ''
    return
  }
  buildBookmarkCard(el, url, { url, ok: false, siteName: hostnameOf(url) })
  void fetchMeta(url).then((meta) => {
    if (el.getAttribute('data-zen-bookmark-rendered') !== token) return
    buildBookmarkCard(el, url, meta.ok ? meta : { url, ok: false, siteName: hostnameOf(url) })
  })
}

/**
 * Fill every `.zen-bookmark` placeholder with a rich link card. Metadata is
 * fetched via the bridge (desktop parses the page; web falls back to a bare
 * link). Re-runs on unchanged blocks are a no-op.
 */
export function renderBookmarks(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('.zen-bookmark'))) {
    const url = (el.getAttribute('data-bookmark-url') ?? el.textContent ?? '').trim()
    if (el.getAttribute('data-zen-bookmark-rendered') === url) continue
    el.setAttribute('data-zen-bookmark-rendered', url)
    el.setAttribute('data-bookmark-url', url)
    renderBookmarkElement(el, url, url)
  }
}
