import type { PastedImageInput } from '@shared/ipc'

const IMAGE_FILE_EXTENSION_RE = /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i

export function isClipboardImageFile(file: File): boolean {
  if (file.type.toLowerCase().startsWith('image/')) return true
  return IMAGE_FILE_EXTENSION_RE.test(file.name)
}

export function pastedImageFilesFromClipboard(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return []
  const direct = Array.from(dataTransfer.files ?? []).filter(isClipboardImageFile)
  if (direct.length > 0) return direct

  return Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file && isClipboardImageFile(file))
}

export async function pastedImageInputFromFile(file: File): Promise<PastedImageInput> {
  return {
    data: await file.arrayBuffer(),
    mimeType: file.type || 'image/png',
    suggestedName: file.name || null
  }
}

/**
 * True when the clipboard carries real text the editor should paste instead of
 * an image.
 *
 * Word (and Pages, Excel, Keynote) put a bitmap RENDERING of the selection on
 * the clipboard next to the HTML/RTF/plain-text flavours. An image-first paste
 * handler therefore turns every copy out of Word into a picture of the text,
 * which is unusable in a markdown note.
 *
 * `text/plain` is the discriminator, and deliberately not `text/html`: a browser
 * image copy DOES carry `text/html` (an `<img>` tag) but leaves plain text
 * empty, so keying on HTML would break the one case where image-paste is
 * genuinely wanted. A screenshot carries no text flavour at all.
 */
export function clipboardHasPastableText(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  // Some platforms list a type but hand back an empty string, so read the value
  // rather than trusting `types`.
  return dataTransfer.getData('text/plain').trim().length > 0
}
