/**
 * Fetch open-graph metadata for a URL so the renderer can draw a bookmark card
 * (Notion-style). Runs in the main process, so it isn't subject to the
 * renderer's CSP / CORS, and it can apply its own safety limits.
 *
 * Guards: https only; obvious loopback / private hosts are refused (a note is
 * untrusted content, so we don't let it point the fetch at internal services);
 * a hard timeout; and the body is read only up to a cap (metadata lives in
 * `<head>`, so we never need the whole page).
 */
import type { LinkMetadata } from '@shared/ipc'

const TIMEOUT_MS = 6000
const MAX_BYTES = 512 * 1024
const USER_AGENT =
  'Mozilla/5.0 (compatible; ZenNotes/1.0; +https://zennotes.app) LinkPreview'

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0.0.0.0') return true
  // IPv4 private / loopback / link-local ranges.
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  return false
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ')
}

/** Read a `<meta property=".." content="..">` (or `name=`), order-agnostic. */
function metaTag(html: string, key: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'i'
  )
  const tag = html.match(re)?.[0]
  if (!tag) return undefined
  const content = tag.match(/content=["']([^"']*)["']/i)?.[1]
  return content ? decodeEntities(content).trim() : undefined
}

function firstFavicon(html: string, base: URL): string | undefined {
  const links = html.match(/<link[^>]+>/gi) ?? []
  for (const link of links) {
    if (!/rel=["'][^"']*icon[^"']*["']/i.test(link)) continue
    const href = link.match(/href=["']([^"']+)["']/i)?.[1]
    if (href) {
      try {
        return new URL(decodeEntities(href), base).href
      } catch {
        /* skip malformed */
      }
    }
  }
  return `${base.origin}/favicon.ico`
}

function absolute(value: string | undefined, base: URL): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, base).href
  } catch {
    return undefined
  }
}

export async function fetchLinkMetadata(rawUrl: string): Promise<LinkMetadata> {
  const url = String(rawUrl ?? '').trim()
  const fail: LinkMetadata = { url, ok: false }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return fail
  }
  if (parsed.protocol !== 'https:' || isBlockedHost(parsed.hostname)) return fail

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }
    })
    if (!res.ok || !res.body) return fail
    const finalUrl = new URL(res.url || parsed.href)
    if (isBlockedHost(finalUrl.hostname)) return fail

    // Read up to MAX_BYTES of the (usually `<head>`-first) HTML.
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
        if (total >= MAX_BYTES) {
          void reader.cancel()
          break
        }
      }
    }
    const html = Buffer.concat(chunks).toString('utf8')

    const titleTag =
      decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim() || undefined
    const title = metaTag(html, 'og:title') ?? metaTag(html, 'twitter:title') ?? titleTag
    const description =
      metaTag(html, 'og:description') ??
      metaTag(html, 'twitter:description') ??
      metaTag(html, 'description')
    const image = absolute(
      metaTag(html, 'og:image') ?? metaTag(html, 'twitter:image'),
      finalUrl
    )
    const siteName = metaTag(html, 'og:site_name')
    const favicon = firstFavicon(html, finalUrl)

    return {
      url,
      ok: true,
      title,
      description,
      image,
      siteName: siteName ?? finalUrl.hostname.replace(/^www\./, ''),
      favicon
    }
  } catch {
    return fail
  } finally {
    clearTimeout(timer)
  }
}
