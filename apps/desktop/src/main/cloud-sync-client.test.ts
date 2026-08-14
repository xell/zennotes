import { describe, expect, it, vi } from 'vitest'
import { CloudServiceRequestError, createCloudSyncClient } from './cloud-sync-client'

describe('createCloudSyncClient', () => {
  it('authenticates requests without exposing the token in the URL', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const client = createCloudSyncClient(
      'https://zennotes.org/',
      'secret-token',
      fetchImplementation
    )

    await client.listVaults()

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://zennotes.org/api/v1/vaults',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' })
      })
    )
    expect(fetchImplementation.mock.calls[0]?.[0]).not.toContain('secret-token')
  })

  it('preserves stable backend error codes', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'FEATURE_NOT_ENTITLED', message: 'Upgrade required.' }
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.listVaults()).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 403,
        code: 'FEATURE_NOT_ENTITLED',
        message: 'Upgrade required.'
      })
    )
  })

  it('surfaces Laravel validation messages', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: 'The mutations.0.path field is required.',
          errors: { 'mutations.0.path': ['The mutations.0.path field is required.'] }
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.mutate('vault-1', { mutations: [] })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 422,
        code: null,
        message: 'The mutations.0.path field is required.'
      })
    )
  })

  it('surfaces field details from the cloud API validation envelope', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The request data is invalid.'
          },
          errors: {
            markdown: ['The markdown field must be present.']
          }
        }),
        { status: 422, headers: { 'Content-Type': 'application/json' } }
      )
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await expect(client.publishNote({
      note_path: 'Empty.md',
      title: 'Empty',
      markdown: ''
    })).rejects.toEqual(
      expect.objectContaining<Partial<CloudServiceRequestError>>({
        status: 422,
        code: 'VALIDATION_FAILED',
        message: 'The markdown field must be present.'
      })
    )
  })

  it('lets fetch set the multipart boundary for published-note assets', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 42, slug: 'photo', url: 'https://zennotes.org/s/photo' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const client = createCloudSyncClient('https://zennotes.org', 'token', fetchImplementation)

    await client.publishNote({
      note_path: 'Photo.md',
      title: 'Photo',
      markdown: '![Photo](photo.png)',
      assets: [{ ref: 'photo.png', name: 'photo.png', mime: 'image/png', base64: 'AQID' }]
    })

    const options = fetchImplementation.mock.calls[0]?.[1]
    expect(options?.body).toBeInstanceOf(FormData)
    expect(new Headers(options?.headers).has('Content-Type')).toBe(false)
  })
})
