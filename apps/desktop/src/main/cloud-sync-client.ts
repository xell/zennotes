import {
  CloudSyncApiClient,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from '@zennotes/shared-domain/cloud-sync-api'

export class CloudServiceRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message)
    this.name = 'CloudServiceRequestError'
  }
}

export function createCloudSyncClient(
  baseUrl: string,
  token: string,
  fetchImplementation: typeof fetch = fetch
): CloudSyncApiClient {
  return new CloudSyncApiClient(
    new BearerFetchTransport(baseUrl, token, fetchImplementation)
  )
}

class BearerFetchTransport implements CloudSyncHttpTransport {
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImplementation: typeof fetch
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '')
  }

  async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
    const multipart = request.body instanceof FormData
    const response = await this.fetchImplementation(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(request.body === undefined || multipart ? {} : { 'Content-Type': 'application/json' })
      },
      body: request.body === undefined
        ? undefined
        : request.body instanceof FormData
          ? request.body
          : JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000)
    })
    const payload = await parseJson(response)

    if (!response.ok) {
      const error = asErrorPayload(payload)
      throw new CloudServiceRequestError(
        error?.message ?? `ZenNotes Cloud request failed (${response.status}).`,
        response.status,
        error?.code ?? null
      )
    }

    return payload as Response
  }
}

async function parseJson(response: globalThis.Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null

  try {
    return JSON.parse(text)
  } catch {
    throw new CloudServiceRequestError(
      'ZenNotes Cloud returned an invalid JSON response.',
      response.status,
      null
    )
  }
}

function asErrorPayload(payload: unknown): { code?: string; message?: string } | null {
  if (!payload || typeof payload !== 'object') return null
  const response = payload as {
    code?: unknown
    error?: unknown
    errors?: unknown
    message?: unknown
  }
  const candidate =
    response.error && typeof response.error === 'object'
      ? (response.error as { code?: unknown; message?: unknown })
      : response
  const validationMessage = firstValidationMessage(response.errors)

  return {
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
    ...(validationMessage !== null
      ? { message: validationMessage }
      : typeof candidate.message === 'string'
        ? { message: candidate.message }
        : {})
  }
}

function firstValidationMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null

  for (const messages of Object.values(errors)) {
    if (Array.isArray(messages)) {
      const message = messages.find((candidate): candidate is string => typeof candidate === 'string')
      if (message) return message
    }
  }

  return null
}
