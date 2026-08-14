// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZenBridge } from '@zennotes/bridge-contract/bridge'
import { subscribePublishedNoteChanges } from '../lib/published-note-events'
import { PublishNoteModal } from './PublishNoteModal'

describe('PublishNoteModal', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.querySelectorAll('[role="dialog"]').forEach((dialog) => dialog.remove())
  })

  it('updates an existing note without sending per-note appearance', async () => {
    const publishedNoteChanged = vi.fn()
    const unsubscribe = subscribePublishedNoteChanges(publishedNoteChanged)
    const updateCloudPublishedNote = vi.fn(async () => ({
      id: 42,
      slug: 'launch',
      url: 'https://zennotes.org/s/launch'
    }))
    const bridge = {
      getCloudServiceAccount: vi.fn(async () => ({
        user: { name: 'Ada', email: 'ada@example.com' },
        device: { id: 'device-1', name: 'Mac', platform: 'desktop', app_version: '2.27.0' },
        features: {
          sync: { active: true, limits: null },
          backup: { active: true, limits: null },
          publish: { active: true, limits: null }
        }
      })),
      listCloudPublishedNotes: vi.fn(async () => [{
        id: 42,
        slug: 'launch',
        url: 'https://zennotes.org/s/launch',
        title: 'Launch',
        note_path: 'Notes/Launch.md',
        appearance: {
          theme: 'rose-pine-moon',
          logo_url: 'https://zennotes.org/s/assets/logo'
        },
        created_at: '2026-08-10T12:00:00.000Z',
        updated_at: '2026-08-10T12:00:00.000Z'
      }]),
      updateCloudPublishedNote,
      publishCloudNote: vi.fn(),
      readVaultAssetBase64: vi.fn(),
      clipboardWriteText: vi.fn()
    } as unknown as ZenBridge

    await act(async () => {
      root.render(createElement(PublishNoteModal, {
        bridge,
        note: { path: 'Notes/Launch.md', title: 'Launch', body: '# Launch', assetEmbeds: [] },
        onClose: vi.fn()
      }))
    })

    const dialog = document.body.querySelector('[role="dialog"]') as HTMLDivElement
    expect(dialog.querySelector('select')).toBeNull()
    expect(dialog.querySelector('input[type="file"]')).toBeNull()
    expect(dialog.textContent).toContain('Update the public copy with the latest content')
    expect(dialog.textContent).toContain('Theme and logo are managed for your full publication')

    const update = [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === 'Update note')
    await act(async () => update!.click())

    expect(updateCloudPublishedNote).toHaveBeenCalledWith(42, {
      note_path: 'Notes/Launch.md',
      title: 'Launch',
      markdown: '# Launch'
    })
    expect(publishedNoteChanged).toHaveBeenCalledWith({
      notePath: 'Notes/Launch.md',
      url: 'https://zennotes.org/s/launch'
    })
    unsubscribe()
  })
})
