import { useStore } from '../store'
import { externalLinkUrl } from './internal-links'
import { openExternalFileLink } from './external-file-link'
import { isExcalidrawPath, isObsidianExcalidrawPath } from '@shared/excalidraw'

/** Absolute on-disk path for a vault-relative asset, for opening it in the OS
 *  default app. `path.resolve` in the desktop handler normalizes the join. */
function vaultAssetAbsolutePath(vaultRoot: string, assetVaultRel: string): string {
  return `${vaultRoot.replace(/\/+$/, '')}/${assetVaultRel}`
}

const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp'
])
const PDF_EXTENSIONS = new Set(['.pdf'])
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mov', '.mp4', '.ogv', '.webm'])
const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const TEXT_EXTENSIONS = new Set(['.txt', '.text'])

export type LocalAssetKind = 'image' | 'pdf' | 'audio' | 'video' | 'html' | 'text' | 'excalidraw' | 'file'

function stripQueryAndHash(href: string): string {
  return href.split('#')[0]?.split('?')[0] ?? href
}

export function hrefFragment(href: string): string {
  const hashIdx = href.indexOf('#')
  return hashIdx >= 0 ? href.slice(hashIdx) : ''
}

function decodeHrefPath(value: string): string {
  const cleaned = stripQueryAndHash(value)
  try {
    return decodeURIComponent(cleaned)
  } catch {
    return cleaned
  }
}

function posixJoin(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  if (a.endsWith('/')) return `${a}${b}`
  return `${a}/${b}`
}

function posixNormalize(input: string): string {
  const parts = input.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return '..'
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join('/')
}

/**
 * POSIX relative path from a note's folder to a vault-relative target, both
 * vault-relative (no leading slash). E.g. `posixRelative('a-folder',
 * 'a-folder/assets/a.jpg')` → `assets/a.jpg`, and from `a-folder/sub` →
 * `../assets/a.jpg`. Used to keep rewritten asset links note-relative (portable
 * and tier-1 resolvable) rather than dumping the raw vault-relative path.
 */
export function posixRelative(fromDir: string, toPath: string): string {
  const from = posixNormalize(fromDir).split('/').filter(Boolean)
  const to = posixNormalize(toPath).split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length && from[i] === to[i]) i++
  const segments = [...Array(from.length - i).fill('..'), ...to.slice(i)]
  return segments.join('/') || (to[to.length - 1] ?? toPath)
}

function assetExtension(href: string): string {
  const clean = stripQueryAndHash(href)
  const lastDot = clean.lastIndexOf('.')
  return lastDot === -1 ? '' : clean.slice(lastDot).toLowerCase()
}

export function classifyLocalAssetHref(href: string): LocalAssetKind | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) return null
  if (isExcalidrawPath(href) || isObsidianExcalidrawPath(href)) return 'excalidraw'
  const ext = assetExtension(href)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (PDF_EXTENSIONS.has(ext)) return 'pdf'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (HTML_EXTENSIONS.has(ext)) return 'html'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'file'
}

export function resolveLocalAssetUrl(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  if (!vaultRoot || !notePath) return null
  const resolvedRel = resolveAssetVaultRelativePath(vaultRoot, notePath, href)
  if (resolvedRel) {
    return window.zen.resolveVaultAssetUrl(vaultRoot, resolvedRel)
  }
  // If the asset list hasn't arrived yet (cold start, before
  // `listAssets` resolves), skip producing a URL rather than baking in
  // the notedir-relative fallback. The cm-live-preview plugin
  // re-decorates as soon as `assetFiles` populates and the basename
  // search will then run with real data. This stops the wrong URL from
  // being cached by the widget on the first paint.
  if (useStore.getState().assetFiles.length === 0) return null
  return window.zen.resolveLocalAssetUrl(vaultRoot, notePath, href)
}

/**
 * Same input as `resolveLocalAssetUrl` but returns a POSIX vault-
 * relative path instead of a `zen-asset://` URL. Useful when we need
 * to feed the asset into our own state (e.g. `pinAssetReference`).
 * Returns null when the asset is outside the vault.
 */
export function resolveAssetVaultRelativePath(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  if (!vaultRoot || !notePath) return null
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const decodedHref = decodeHrefPath(trimmed)
  const isAbsolute = decodedHref.startsWith('/')
  let target = isAbsolute
    ? decodedHref.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decodedHref)
      : decodedHref
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null

  const assets = useStore.getState().assetFiles
  if (assets.some((asset) => asset.path === target)) return target

  // A wikilink embed (`![[assets/img.png]]`) — and any path written relative
  // to the vault root — resolves from the root, not the note's folder, which
  // is what Obsidian does with wikilinks. When the note-relative join above
  // didn't hit an asset, try the path as vault-root-relative before the fuzzy
  // basename search below. This is what makes a pasted `![[assets/img.png]]`
  // render from a note in a subfolder (e.g. a daily note under
  // `Daily Notes/`), and it's more precise than the basename fallback when
  // several files share a name. (#459)
  if (!isAbsolute && noteDir) {
    const rootTarget = posixNormalize(decodedHref)
    if (
      rootTarget &&
      rootTarget !== target &&
      !rootTarget.startsWith('../') &&
      rootTarget !== '..' &&
      assets.some((asset) => asset.path === rootTarget)
    ) {
      return rootTarget
    }
  }

  const targetBase = target.split('/').filter(Boolean).pop()?.toLowerCase()
  if (!targetBase) return null

  const basenameMatches = assets.filter((asset) => {
    const assetBase = asset.path.split('/').filter(Boolean).pop()?.toLowerCase()
    return assetBase === targetBase
  })
  if (basenameMatches.length === 1) {
    return basenameMatches[0]!.path
  }

  return null
}

/**
 * Tier-1-only resolution: the exact vault-relative asset path an href points at
 * (note-relative join, or vault-root for a leading slash), returned only when an
 * asset actually exists there — no basename fallback. Lets callers tell an
 * explicit-path link, which must follow the referencing note when it moves, from
 * a bare-name link, which resolves by basename and is thus location-independent.
 */
export function resolveAssetExactPath(
  vaultRoot: string | null | undefined,
  notePath: string | null | undefined,
  href: string
): string | null {
  if (!vaultRoot || !notePath) return null
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  const decodedHref = decodeHrefPath(trimmed)
  let target = decodedHref.startsWith('/')
    ? decodedHref.replace(/^\/+/, '')
    : noteDir
      ? posixJoin(noteDir, decodedHref)
      : decodedHref
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null

  return useStore.getState().assetFiles.some((asset) => asset.path === target) ? target : null
}

/**
 * For every note that embeds `assetPath`, the exact href string(s) it used —
 * resolved via `resolveAssetVaultRelativePath`, so it stays consistent with
 * how embeds actually render. Used before a rename/move to know which notes'
 * bodies need their reference rewritten, and to gate the "update N notes?"
 * confirmation. Callers with a menu-item-per-asset context (Assets Manager,
 * the Preview pane's asset context menu) both need this same lookup.
 */
export function findAssetReferenceHrefs(
  notes: readonly { path: string; assetEmbeds?: readonly string[] }[],
  vaultRoot: string | null | undefined,
  assetPath: string
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const note of notes) {
    const hrefs = (note.assetEmbeds ?? []).filter(
      (h) => resolveAssetVaultRelativePath(vaultRoot, note.path, h) === assetPath
    )
    if (hrefs.length > 0) map.set(note.path, hrefs)
  }
  return map
}

function localAssetLabel(href: string, fallback: string): string {
  const clean = href.split('#')[0]?.split('?')[0] ?? href
  const parts = clean.split('/').filter(Boolean)
  const last = parts[parts.length - 1]
  if (!last) return fallback
  // Markdown encodes spaces (and other special chars) in the URL via
  // %20 etc. — decode so the visible label reads like a real filename.
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function imageCaptionLabel(img: HTMLImageElement, href: string): string {
  const alt = img.getAttribute('alt')?.trim()
  if (alt) return alt
  return localAssetLabel(href, 'Image')
}

function isStandaloneAnchorParagraph(anchor: HTMLAnchorElement): HTMLParagraphElement | null {
  const paragraph = anchor.parentElement as HTMLParagraphElement | null
  if (!paragraph || paragraph.tagName !== 'P') return null
  const otherAnchors = paragraph.querySelectorAll('a')
  if (otherAnchors.length !== 1 || otherAnchors[0] !== anchor) return null
  const text = paragraph.textContent?.trim() ?? ''
  const anchorText = anchor.textContent?.trim() ?? ''
  return text === anchorText ? paragraph : null
}

/** The render size `remarkImageEmbedSize` parked on the element, if any. */
function imageEmbedSize(img: HTMLImageElement): { width: number | null; height: number | null } {
  const width = Number(img.dataset.embedWidth)
  const height = Number(img.dataset.embedHeight)
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null
  }
}

/**
 * Size an image that renders on its own, i.e. NOT inside an embed figure.
 * `max-*` rather than `width`/`height` so the image still shrinks inside a
 * narrow pane instead of overflowing it.
 */
function applyInlineImageEmbedSize(img: HTMLImageElement): void {
  const { width, height } = imageEmbedSize(img)
  if (width) img.style.maxWidth = `${width}px`
  if (height) img.style.maxHeight = `${height}px`
}

function isStandaloneImageParagraph(img: HTMLImageElement): HTMLParagraphElement | null {
  const paragraph = img.parentElement as HTMLParagraphElement | null
  if (!paragraph || paragraph.tagName !== 'P') return null
  const images = paragraph.querySelectorAll('img')
  if (images.length !== 1 || images[0] !== img) return null
  const text = paragraph.textContent?.trim() ?? ''
  return text === '' ? paragraph : null
}

function buildImageAction(label: string, variant: 'edit' | 'open' | 'locate'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `local-image-embed-action local-image-embed-action-${variant}`
  button.setAttribute('aria-label', label)
  button.title = label
  button.textContent = variant === 'edit' ? '</>' : variant === 'locate' ? '⌕' : '↗'
  return button
}

function buildImageEmbed(
  img: HTMLImageElement,
  rawHref: string,
  resolvedUrl: string,
  onRequestEdit?: (() => void) | null,
  onOpenAsset?: (() => void) | null,
  onLocateAsset?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-image-embed not-prose'

  // A size hint belongs on the figure, not the image. The frame is a bordered,
  // full-width block and the image inside it is `width: 100%`, so capping only
  // the image would leave a 600px picture floating in a full-width box, with
  // the hover controls pinned to the box's edges rather than the picture's.
  // Capping the figure makes the whole embed — border, controls, caption —
  // shrink to the requested width together.
  const { width, height } = imageEmbedSize(img)
  if (width) {
    figure.style.maxWidth = `${width}px`
    img.style.removeProperty('max-width')
  }
  if (height) img.style.maxHeight = `${height}px`

  const frame = document.createElement('div')
  frame.className = 'local-image-embed-frame'

  const controlsTop = document.createElement('div')
  controlsTop.className = 'local-image-embed-controls local-image-embed-controls-top'

  if (onRequestEdit) {
    const editButton = buildImageAction('Edit this block', 'edit')
    editButton.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onRequestEdit()
    })
    controlsTop.append(editButton)
  }

  const controlsBottom = document.createElement('div')
  controlsBottom.className = 'local-image-embed-controls local-image-embed-controls-bottom'
  if (onLocateAsset) {
    const locateButton = buildImageAction('Locate in Assets Manager', 'locate')
    locateButton.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onLocateAsset()
    })
    controlsBottom.append(locateButton)
  }
  const openButton = buildImageAction('Open image', 'open')
  openButton.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (onOpenAsset) {
      onOpenAsset()
    }
  })
  controlsBottom.append(openButton)

  img.classList.add('local-image-embed-image')
  img.dataset.localAssetUrl = resolvedUrl
  frame.append(img, controlsTop, controlsBottom)

  const caption = document.createElement('figcaption')
  caption.className = 'local-image-embed-caption'
  caption.textContent = imageCaptionLabel(img, rawHref)

  figure.append(frame, caption)
  return figure
}

function buildEmbed(
  kind: Exclude<LocalAssetKind, 'image' | 'html' | 'text' | 'file' | 'excalidraw'>,
  url: string,
  label: string,
  href: string,
  onOpenAsset?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed not-prose'
  // Tag the figure so right-click handlers can identify the asset
  // without traversing into the iframe / audio / video child.
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = kind
  figure.dataset.localAssetHref = href

  const header = document.createElement('div')
  header.className = 'local-asset-embed-header'

  const title = document.createElement('div')
  title.className = 'local-asset-embed-title'
  title.textContent = label

  const open = onOpenAsset
    ? document.createElement('button')
    : document.createElement('a')
  open.className = 'local-asset-embed-open'
  open.dataset.localAssetUrl = url
  open.dataset.localAssetHref = href
  open.textContent = 'Open'
  if (onOpenAsset) {
    open.type = 'button'
    open.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpenAsset()
    })
  } else {
    const link = open as HTMLAnchorElement
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
  }

  header.append(title, open)
  figure.append(header)

  if (kind === 'pdf') {
    const frame = document.createElement('iframe')
    frame.className = 'local-asset-embed-frame'
    frame.src = url + hrefFragment(href)
    frame.title = label
    figure.append(frame)
    return figure
  }

  if (kind === 'audio') {
    const audio = document.createElement('audio')
    audio.className = 'local-asset-embed-audio'
    audio.src = url
    audio.controls = true
    audio.preload = 'metadata'
    figure.append(audio)
    return figure
  }

  const video = document.createElement('video')
  video.className = 'local-asset-embed-video'
  video.src = url
  video.controls = true
  video.preload = 'metadata'
  figure.append(video)
  return figure
}

// Paperclip — denotes a non-previewable attachment. Static markup (no user
// input), so `innerHTML` is safe here.
const ATTACHMENT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'

/**
 * A compact chip that denotes a non-previewable attachment (`.tldraw`, `.zip`,
 * unknown types) embedded with image syntax `![](file.ext)`. Reused by both the
 * reading preview and the editor's live-preview widget so the two match. When
 * `onOpen` is given the chip is a button that runs it; otherwise it's a plain
 * link to the resolved asset URL. (#463)
 */
export function buildAttachmentChip(
  resolvedUrl: string,
  rawHref: string,
  label: string,
  onOpen?: (() => void) | null
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-file-attachment not-prose'
  figure.dataset.localAssetUrl = resolvedUrl
  figure.dataset.localAssetKind = 'file'
  figure.dataset.localAssetHref = rawHref

  const action = onOpen ? document.createElement('button') : document.createElement('a')
  action.className = 'local-file-attachment-button'
  if (onOpen) {
    ;(action as HTMLButtonElement).type = 'button'
    action.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      onOpen()
    })
  } else {
    const link = action as HTMLAnchorElement
    link.href = resolvedUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
  }

  const icon = document.createElement('span')
  icon.className = 'local-file-attachment-icon'
  icon.innerHTML = ATTACHMENT_ICON_SVG

  const name = document.createElement('span')
  name.className = 'local-file-attachment-name'
  name.textContent = label

  const openHint = document.createElement('span')
  openHint.className = 'local-file-attachment-open'
  openHint.setAttribute('aria-hidden', 'true')
  openHint.textContent = '↗'

  action.append(icon, name, openHint)
  figure.append(action)
  return figure
}

/**
 * Build a compact "showing in reference pane" placeholder used when an
 * embedded PDF in the note is the same one the user has pinned in the
 * side reference pane — no point repeating the iframe, but we want a
 * visual breadcrumb so the user knows it's there.
 */
function buildPinnedRefPlaceholder(
  url: string,
  href: string,
  label: string,
  onActivate: () => void
): HTMLElement {
  const figure = document.createElement('figure')
  figure.className = 'local-asset-embed local-asset-pinned-ref not-prose'
  figure.dataset.localAssetUrl = url
  figure.dataset.localAssetKind = 'pdf'
  figure.dataset.localAssetHref = href

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'local-asset-pinned-ref-button'
  button.title = 'Showing in the reference pane — click to focus'
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate()
  })

  const icon = document.createElement('span')
  icon.className = 'local-asset-pinned-ref-icon'
  icon.textContent = '↗'

  const text = document.createElement('span')
  text.className = 'local-asset-pinned-ref-text'
  text.textContent = label

  const badge = document.createElement('span')
  badge.className = 'local-asset-pinned-ref-badge'
  badge.textContent = 'in reference pane'

  button.append(icon, text, badge)
  figure.append(button)
  return figure
}

export function enhanceLocalAssetNodes(
  root: HTMLElement,
  options: {
    vaultRoot: string | null | undefined
    notePath: string | null | undefined
    onRequestEdit?: (() => void) | null
    /** When set, PDF embeds matching this vault-relative path are
     *  collapsed to a compact placeholder instead of a full iframe. */
    pinnedAssetPath?: string | null
    onActivatePinnedRef?: (() => void) | null
    onOpenAsset?: ((assetPath: string) => void) | null
    onLocateAsset?: ((assetPath: string) => void) | null
  }
): void {
  const {
    vaultRoot,
    notePath,
    onRequestEdit,
    pinnedAssetPath,
    onActivatePinnedRef,
    onOpenAsset,
    onLocateAsset
  } = options
  if (!vaultRoot || !notePath) return

  root.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
    const raw = img.getAttribute('src') || ''
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return
    const assetVaultRel = resolveAssetVaultRelativePath(vaultRoot, notePath, raw)

    // #463: a non-image file embedded with image syntax (`![](file.tldraw)`)
    // is a broken <img> with no indication it's an attachment. Denote it — a
    // chip when it's on its own line, an inline link otherwise — so it never
    // renders blank. Real images fall through to the embed path below;
    // excalidraw keeps its own dedicated embed handling.
    const imgKind = classifyLocalAssetHref(raw)
    if (imgKind && imgKind !== 'image' && imgKind !== 'excalidraw') {
      const label = localAssetLabel(raw, 'Attachment')
      // A non-previewable file opens in the OS default app (a `.tldraw` in its
      // editor, a `.zip` in the archiver) — an in-app asset tab can't render
      // it, which read as "nothing happened" when clicked. (#463)
      const openAsset =
        vaultRoot && assetVaultRel
          ? () => void openExternalFileLink(vaultAssetAbsolutePath(vaultRoot, assetVaultRel))
          : null
      const standalone = isStandaloneImageParagraph(img)
      if (standalone && standalone.dataset.assetEmbed !== 'true') {
        standalone.dataset.assetEmbed = 'true'
        standalone.replaceWith(buildAttachmentChip(resolved, raw, label, openAsset))
      } else {
        const link = document.createElement('a')
        link.className = 'local-file-attachment-inline'
        link.textContent = label
        link.href = resolved
        link.dataset.localAssetUrl = resolved
        link.dataset.localAssetKind = 'file'
        link.dataset.localAssetHref = raw
        if (openAsset) {
          link.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            openAsset()
          })
        } else {
          link.target = '_blank'
          link.rel = 'noreferrer'
        }
        img.replaceWith(link)
      }
      return
    }

    img.src = resolved
    img.loading = 'lazy'
    // Sized here for an image rendering on its own; `buildImageEmbed` moves the
    // width onto the figure instead when this becomes a framed embed.
    applyInlineImageEmbedSize(img)
    img.dataset.localAssetUrl = resolved
    img.dataset.localAssetHref = raw
    img.dataset.localAssetKind = 'image'
    const paragraph = isStandaloneImageParagraph(img)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    paragraph.replaceWith(
      buildImageEmbed(
        img,
        raw,
        resolved,
        onRequestEdit,
        assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null,
        assetVaultRel && onLocateAsset ? () => onLocateAsset(assetVaultRel) : null
      )
    )
  })

  root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    if (anchor.classList.contains('wikilink') || anchor.classList.contains('hashtag')) return
    const raw = anchor.getAttribute('href') || ''
    // A `.md` link is a note link, and an external web link (`google.com`,
    // `https://…`) isn't a vault asset — leave both for the link-navigation
    // handlers instead of rewriting them to a zen-asset URL. (#201)
    if (/\.md(?:[#?].*)?$/i.test(raw.trim()) || externalLinkUrl(raw)) return
    const resolved = resolveLocalAssetUrl(vaultRoot, notePath, raw)
    if (!resolved) return

    const assetVaultRel = resolveAssetVaultRelativePath(vaultRoot, notePath, raw)
    const kind = classifyLocalAssetHref(raw) ?? 'file'
    anchor.href = resolved + hrefFragment(raw)
    anchor.dataset.localAssetUrl = resolved
    anchor.dataset.localAssetKind = kind
    anchor.dataset.localAssetHref = raw
    anchor.target = '_blank'
    anchor.rel = 'noreferrer'
    if (assetVaultRel && onOpenAsset) {
      anchor.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onOpenAsset(assetVaultRel)
      })
    }

    // 'html' stays a plain click-to-open link inline (no auto-embed), so
    // its script never executes just because a note scrolled into view —
    // it renders only on a deliberate open, in a sandboxed tab iframe.
    // 'text' is read-only either way, but a large .txt/.log file rendered
    // as a giant inline block would still be an unpleasant surprise
    // mid-note, so it gets the same plain-link treatment. 'excalidraw' has
    // its own dedicated ![[drawing.excalidraw]] wikilink embed syntax
    // (upstream) — a plain link to one shouldn't also auto-embed.
    if (
      kind === 'file' ||
      kind === 'image' ||
      kind === 'html' ||
      kind === 'text' ||
      kind === 'excalidraw'
    )
      return

    const paragraph = isStandaloneAnchorParagraph(anchor)
    if (!paragraph || paragraph.dataset.assetEmbed === 'true') return
    paragraph.dataset.assetEmbed = 'true'
    const label = localAssetLabel(raw, anchor.textContent?.trim() || 'Asset')
    if (kind === 'pdf' && pinnedAssetPath) {
      if (assetVaultRel === pinnedAssetPath) {
        paragraph.replaceWith(
          buildPinnedRefPlaceholder(resolved, raw, label, () => {
            onActivatePinnedRef?.()
          })
        )
        return
      }
    }
    paragraph.replaceWith(
      buildEmbed(
        kind,
        resolved,
        label,
        raw,
        assetVaultRel && onOpenAsset ? () => onOpenAsset(assetVaultRel) : null
      )
    )
  })
}

/** Which glyph a file's row shows in the sidebar and reference lists, chosen by
 *  extension. Coarser than `classifyLocalAssetHref` (which drives *viewers*):
 *  here a PDF and a .docx share one "document" bucket because the list only
 *  needs to say "this is a document" at a glance. */
export type AssetFileIcon = 'document' | 'image' | 'attachment'

// Defaults for the two user-editable extension lists. Kept as the same
// comma-separated string the Settings text field shows, so the preference
// default and the built-in fallback can never disagree.
export const DEFAULT_DOCUMENT_EXTS = 'pdf, doc, docx, xls, xlsx, ppt, pptx, key, txt, text'
export const DEFAULT_IMAGE_EXTS =
  'png, jpg, jpeg, gif, webp, svg, bmp, tif, tiff, heic, heif, avif, ico, psd, af'

// Parsing the same string yields the same Set instance, so callers can compare
// by reference and skip re-parsing an unchanged preference.
const extSetCache = new Map<string, Set<string>>()

/** A comma/space-separated extension list to a lower-cased set, tolerant of
 *  leading dots and stray whitespace (`.PNG`, ` jpg `, `psd`). */
export function parseExtSet(list: string): Set<string> {
  const cached = extSetCache.get(list)
  if (cached) return cached
  const set = new Set(
    list
      .split(/[\s,]+/)
      .map((e) => e.replace(/^\.+/, '').toLowerCase())
      .filter(Boolean)
  )
  extSetCache.set(list, set)
  return set
}

const DEFAULT_DOCUMENT_SET = parseExtSet(DEFAULT_DOCUMENT_EXTS)
const DEFAULT_IMAGE_SET = parseExtSet(DEFAULT_IMAGE_EXTS)

/** The icon bucket for a file path or bare filename. The two extension sets
 *  default to the built-ins; the sidebar passes the user-configured ones.
 *  Anything in neither set is an attachment (paperclip). */
export function assetFileIcon(
  pathOrName: string,
  documentExts: Set<string> = DEFAULT_DOCUMENT_SET,
  imageExts: Set<string> = DEFAULT_IMAGE_SET
): AssetFileIcon {
  const base = pathOrName.split(/[\\/]/).pop() ?? pathOrName
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (documentExts.has(ext)) return 'document'
  if (imageExts.has(ext)) return 'image'
  return 'attachment'
}
