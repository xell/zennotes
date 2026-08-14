/**
 * Embed render-size hints: `![[image.png|600]]`, `![[diagram.excalidraw|600x400]]`.
 *
 * IMPORTANT — this module must stay a leaf with **zero imports**.
 *
 * It is pulled in by `local-assets.ts`, which the store imports at module
 * scope, so anything reachable from here lands in the renderer's earliest
 * chunk. This parser originally lived in `excalidraw-preview.ts`; importing it
 * from there dragged that module's `await import('@excalidraw/excalidraw')`
 * into the `app-local-assets` chunk, which broke boot outright — every window
 * came up blank. Keep the dependency list empty and that cannot happen again.
 */

export interface EmbedSize {
  width?: number
  height?: number
}

/** `600` → width only; `600x400` → both. Anything else is not a size. */
const SIZE_HINT_RE = /^(\d+)(?:x(\d+))?$/

export function parseEmbedSizeHint(hint: string | null | undefined): EmbedSize | null {
  if (!hint) return null
  const m = hint.trim().match(SIZE_HINT_RE)
  if (!m) return null
  const width = Number(m[1])
  const height = m[2] ? Number(m[2]) : undefined
  // A zero dimension is not a resize. Treating `|0` or `|0x300` as a hint used
  // to eat the caption and then skip the zero at the falsy checks downstream,
  // distorting the image; an invalid hint stays a caption instead.
  if (width < 1 || (height !== undefined && height < 1)) return null
  return { width, height }
}

export interface ImageEmbedLabel {
  /** What's left for the `alt` attribute once a size hint is taken out. */
  alt: string
  width?: number
  height?: number
}

/**
 * Split an image embed's label into alt text and an optional render size —
 * `![[image.png|600]]`, `![[image.png|600x400]]`, and the Markdown equivalents
 * `![600](image.png)` / `![alt|600](image.png)`.
 *
 * The size is only ever the LAST `|`-separated segment, and only when the whole
 * segment is digits (`600`) or WxH (`600x400`). Anything else stays alt text, so
 * a caption like `![[chart.png|Q3 revenue]]` keeps working exactly as before —
 * which matters, because that label WAS the alt attribute before sizes existed
 * and silently eating it would rewrite the meaning of notes already written.
 */
export function parseImageEmbedLabel(label: string | null | undefined): ImageEmbedLabel {
  const raw = (label ?? '').trim()
  if (!raw) return { alt: '' }
  const cut = raw.lastIndexOf('|')
  const size = parseEmbedSizeHint(cut >= 0 ? raw.slice(cut + 1) : raw)
  if (!size) return { alt: raw }
  return {
    alt: cut >= 0 ? raw.slice(0, cut).trim() : '',
    width: size.width,
    height: size.height
  }
}
