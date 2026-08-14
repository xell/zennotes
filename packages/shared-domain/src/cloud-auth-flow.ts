import type {
  CloudAccount,
  CloudAccountConnectResult,
  CloudAccountStatus
} from '@zennotes/bridge-contract/cloud-sync'

const AUTH_LIFETIME_MS = 5 * 60 * 1000

export interface CloudAuthPending {
  base_url: string
  state: string
  code_verifier: string
  expires_at: string
}

export interface CloudAuthCredential {
  base_url: string
  token: string
  account: CloudAccount
}

export interface CloudAuthCallback {
  code: string
  state: string
}

export interface CloudAuthExchangeRequest extends CloudAuthCallback {
  code_verifier: string
  device_name: string
  platform: 'desktop' | 'ios' | 'android'
  app_version: string
}

export interface CloudAuthExchangeResponse {
  token: string
  user: CloudAccount['user']
  device: CloudAccount['device']
}

export interface CloudAuthStorage {
  loadPending(): Promise<unknown>
  savePending(pending: CloudAuthPending): Promise<void>
  deletePending(): Promise<void>
  loadCredential(): Promise<unknown>
  saveCredential(credential: CloudAuthCredential): Promise<void>
  deleteCredential(): Promise<void>
}

export interface CloudAuthFlowDependencies {
  platform: 'desktop' | 'ios' | 'android'
  appVersion: string
  deviceName: string
  storage: CloudAuthStorage
  openExternal(url: string): Promise<void>
  exchange(baseUrl: string, request: CloudAuthExchangeRequest): Promise<unknown>
  now?: () => Date
  randomState?: () => string
  randomVerifier?: () => string
  allowInsecureLoopback?: boolean
  allowedInsecureOrigins?: readonly string[]
}

export interface CloudBaseUrlValidationOptions {
  allowInsecureLoopback?: boolean
  allowedInsecureOrigins?: readonly string[]
}

/**
 * Platform-neutral state machine for the one-time browser authorization flow.
 * The platform adapter decides where data is stored; mobile adapters must put
 * the credential in Keychain/Keystore-backed storage.
 */
export class CloudAuthFlow {
  private readonly now: () => Date
  private readonly randomState: () => string
  private readonly randomVerifier: () => string

  constructor(private readonly dependencies: CloudAuthFlowDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.randomState = dependencies.randomState ?? createCloudAuthState
    this.randomVerifier = dependencies.randomVerifier ?? createCloudAuthVerifier
  }

  async status(): Promise<CloudAccountStatus> {
    const credential = await this.credential()
    if (credential) return { state: 'connected', account: credential.account }

    const pending = await this.pending()
    return pending
      ? { state: 'connecting', account: null }
      : { state: 'disconnected', account: null }
  }

  async connect(baseUrl: string): Promise<CloudAccountConnectResult> {
    const normalizedBaseUrl = normalizeCloudBaseUrl(
      baseUrl,
      {
        allowInsecureLoopback: this.dependencies.allowInsecureLoopback,
        allowedInsecureOrigins: this.dependencies.allowedInsecureOrigins
      }
    )
    const state = this.randomState()
    const codeVerifier = this.randomVerifier()
    if (!isBoundedState(state) || !isCodeVerifier(codeVerifier)) {
      throw new Error('ZenNotes could not create a secure cloud sign-in request.')
    }
    const codeChallenge = await createCloudAuthChallenge(codeVerifier)

    const pending: CloudAuthPending = {
      base_url: normalizedBaseUrl,
      state,
      code_verifier: codeVerifier,
      expires_at: new Date(this.now().getTime() + AUTH_LIFETIME_MS).toISOString()
    }
    await this.dependencies.storage.savePending(pending)

    const authorizationUrl = new URL('/app/connect', `${normalizedBaseUrl}/`)
    authorizationUrl.searchParams.set('state', state)
    authorizationUrl.searchParams.set('code_challenge', codeChallenge)
    authorizationUrl.searchParams.set('code_challenge_method', 'S256')
    try {
      await this.dependencies.openExternal(authorizationUrl.toString())
    } catch (error) {
      await this.dependencies.storage.deletePending()
      throw error
    }

    return {
      authorization_url: authorizationUrl.toString(),
      expires_at: pending.expires_at
    }
  }

  async complete(callback: CloudAuthCallback): Promise<CloudAccountStatus> {
    const pending = await this.pending()
    if (!pending || !safeEquals(callback.state, pending.state)) {
      throw new Error('This ZenNotes Cloud sign-in request is invalid or has expired.')
    }

    const response = await this.dependencies.exchange(pending.base_url, {
      code: callback.code,
      state: callback.state,
      code_verifier: pending.code_verifier,
      device_name: this.dependencies.deviceName,
      platform: this.dependencies.platform,
      app_version: this.dependencies.appVersion
    })
    if (!isExchangeResponse(response, this.dependencies.platform)) {
      throw new Error('ZenNotes Cloud returned an invalid sign-in response.')
    }

    const account: CloudAccount = {
      base_url: pending.base_url,
      user: response.user,
      device: response.device,
      connected_at: this.now().toISOString()
    }
    await this.dependencies.storage.saveCredential({
      base_url: pending.base_url,
      token: response.token,
      account
    })
    await this.dependencies.storage.deletePending()

    return { state: 'connected', account }
  }

  async credential(): Promise<CloudAuthCredential | null> {
    const stored = await this.dependencies.storage.loadCredential()
    if (stored === null || stored === undefined) return null
    if (isCloudAuthCredential(stored)) return stored

    await this.dependencies.storage.deleteCredential()
    return null
  }

  async logout(): Promise<CloudAccountStatus> {
    await Promise.all([
      this.dependencies.storage.deleteCredential(),
      this.dependencies.storage.deletePending()
    ])
    return { state: 'disconnected', account: null }
  }

  private async pending(): Promise<CloudAuthPending | null> {
    const stored = await this.dependencies.storage.loadPending()
    if (stored === null || stored === undefined) return null
    if (isCloudAuthPending(stored) && new Date(stored.expires_at).getTime() > this.now().getTime()) {
      return stored
    }

    await this.dependencies.storage.deletePending()
    return null
  }
}

export function normalizeCloudBaseUrl(
  baseUrl: string,
  options: CloudBaseUrlValidationOptions = {}
): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl.trim())
  } catch {
    throw new Error('Enter a valid ZenNotes Cloud URL.')
  }

  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  const isAllowedInsecureOrigin =
    parsed.protocol === 'http:' && options.allowedInsecureOrigins?.includes(parsed.origin)
  if (
    parsed.protocol !== 'https:' &&
    !(options.allowInsecureLoopback && isLoopback && parsed.protocol === 'http:') &&
    !isAllowedInsecureOrigin
  ) {
    throw new Error('ZenNotes Cloud must use HTTPS.')
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !['', '/'].includes(parsed.pathname)
  ) {
    throw new Error('Enter the ZenNotes Cloud origin without a path, query, or credentials.')
  }

  return parsed.origin
}

export function parseCloudAuthCallback(rawUrl: string): CloudAuthCallback | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return null
  }

  const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '')
  if (parsed.protocol !== 'zennotes:' || action !== 'auth') return null

  const code = parsed.searchParams.get('code') ?? ''
  const state = parsed.searchParams.get('state') ?? ''
  if (!/^[A-Za-z0-9]+$/.test(code) || code.length > 256) return null
  if (!isBoundedState(state)) return null

  return { code, state }
}

export function createCloudAuthState(): string {
  return createRandomBase64Url()
}

export function createCloudAuthVerifier(): string {
  return createRandomBase64Url()
}

export async function createCloudAuthChallenge(codeVerifier: string): Promise<string> {
  if (!isCodeVerifier(codeVerifier)) {
    throw new Error('ZenNotes could not create a secure cloud sign-in request.')
  }

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  return encodeBase64Url(new Uint8Array(digest))
}

function createRandomBase64Url(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return encodeBase64Url(bytes)
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function safeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

function isBoundedState(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
}

function isCodeVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value)
}

function isExchangeResponse(
  value: unknown,
  expectedPlatform: CloudAuthFlowDependencies['platform']
): value is CloudAuthExchangeResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<CloudAuthExchangeResponse>
  return (
    typeof response.token === 'string' &&
    response.token.length > 0 &&
    response.token.length <= 4096 &&
    isCloudAccountUser(response.user) &&
    isCloudAccountDevice(response.device) &&
    response.device.platform === expectedPlatform
  )
}

function isCloudAuthPending(value: unknown): value is CloudAuthPending {
  if (!value || typeof value !== 'object') return false
  const pending = value as Partial<CloudAuthPending>
  return (
    typeof pending.base_url === 'string' &&
    typeof pending.state === 'string' &&
    isBoundedState(pending.state) &&
    typeof pending.code_verifier === 'string' &&
    isCodeVerifier(pending.code_verifier) &&
    typeof pending.expires_at === 'string' &&
    Number.isFinite(new Date(pending.expires_at).getTime())
  )
}

function isCloudAuthCredential(value: unknown): value is CloudAuthCredential {
  if (!value || typeof value !== 'object') return false
  const credential = value as Partial<CloudAuthCredential>
  return (
    typeof credential.base_url === 'string' &&
    typeof credential.token === 'string' &&
    credential.token.length > 0 &&
    credential.token.length <= 4096 &&
    isCloudAccount(credential.account) &&
    credential.account.base_url === credential.base_url
  )
}

function isCloudAccount(value: unknown): value is CloudAccount {
  if (!value || typeof value !== 'object') return false
  const account = value as Partial<CloudAccount>
  return (
    typeof account.base_url === 'string' &&
    typeof account.connected_at === 'string' &&
    Number.isFinite(new Date(account.connected_at).getTime()) &&
    isCloudAccountUser(account.user) &&
    isCloudAccountDevice(account.device)
  )
}

function isCloudAccountUser(value: unknown): value is CloudAccount['user'] {
  if (!value || typeof value !== 'object') return false
  const user = value as Partial<CloudAccount['user']>
  return typeof user.name === 'string' && typeof user.email === 'string'
}

function isCloudAccountDevice(value: unknown): value is CloudAccount['device'] {
  if (!value || typeof value !== 'object') return false
  const device = value as Partial<CloudAccount['device']>
  return (
    typeof device.id === 'string' &&
    typeof device.name === 'string' &&
    ['desktop', 'ios', 'android'].includes(String(device.platform)) &&
    (device.app_version === undefined ||
      device.app_version === null ||
      typeof device.app_version === 'string')
  )
}
