// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

// #463: a non-image file embedded with Markdown image syntax (`![](file.tldraw)`)
// used to render as a broken <img> with no indication an attachment was there.
// It should now be denoted as an attachment chip; real images are unaffected.

function installZen(): void {
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      resolveLocalAssetUrl: vi.fn((_r: string, _n: string, href: string) => `zen-asset://v/${href}`),
      resolveVaultAssetUrl: vi.fn((_r: string, rel: string) => `zen-asset://v/${rel}`)
    }
  })
}

async function load() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  const { useStore } = await import('../store')
  const { enhanceLocalAssetNodes } = await import('./local-assets')
  return { useStore, enhanceLocalAssetNodes }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

const NOTE = 'Knowledge Sharing.md'

describe('#463 — non-image ![]() renders an attachment chip', () => {
  it('denotes a .tldraw embedded with image syntax as a chip, not a broken image', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'attachments/cordon-toleration-bug.tldraw' }] as never })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="attachments/cordon-toleration-bug.tldraw" alt=""></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: NOTE })
    // No dangling <img>; a chip figure carrying the filename + file kind.
    expect(root.querySelector('img')).toBeNull()
    const chip = root.querySelector<HTMLElement>('.local-file-attachment')
    expect(chip).not.toBeNull()
    expect(chip!.getAttribute('data-local-asset-kind')).toBe('file')
    expect(chip!.textContent).toContain('cordon-toleration-bug.tldraw')
  })

  it('a .zip embedded with image syntax also becomes a chip', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'attachments/backup.zip' }] as never })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="attachments/backup.zip" alt=""></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: NOTE })
    const chip = root.querySelector<HTMLElement>('.local-file-attachment')
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('backup.zip')
  })

  it('leaves a real image as an image embed', async () => {
    const { useStore, enhanceLocalAssetNodes } = await load()
    useStore.setState({ assetFiles: [{ path: 'attachments/pic.png' }] as never })
    const root = document.createElement('div')
    root.innerHTML = '<p><img src="attachments/pic.png" alt="pic"></p>'
    enhanceLocalAssetNodes(root, { vaultRoot: '/v', notePath: NOTE })
    expect(root.querySelector('.local-file-attachment')).toBeNull()
    expect(root.querySelector('figure.local-image-embed img')).not.toBeNull()
  })
})
