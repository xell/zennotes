import type {
  CloudBackupRestore,
  CloudBackupRestoreRequest,
  CloudBackupRestoreResponse,
  CloudBackupRestoreResult,
  CloudSyncRunSummary,
  CloudSyncVaultCollection
} from '@zennotes/bridge-contract/cloud-sync'

export interface CloudBackupRestoreClient {
  listVaults(): Promise<CloudSyncVaultCollection>
  createBackupRestore(
    vaultId: string,
    backupId: string,
    body: CloudBackupRestoreRequest
  ): Promise<CloudBackupRestoreResponse>
  backupRestore(
    vaultId: string,
    backupId: string,
    restoreId: string
  ): Promise<CloudBackupRestoreResponse>
}

export interface RestoreCloudBackupOptions {
  client: CloudBackupRestoreClient
  vaultId: string
  backupId: string
  sync(): Promise<CloudSyncRunSummary>
  idempotencyKey?: () => string
  wait?: (milliseconds: number) => Promise<void>
  pollIntervalMs?: number
  maxPolls?: number
}

const terminalRestoreStatuses = new Set<CloudBackupRestore['status']>([
  'completed',
  'conflict',
  'failed'
])

/**
 * Restores only when the remote vault is still at the cursor the user saw,
 * then pulls the completed replacement into the local vault.
 */
export async function restoreCloudBackup({
  client,
  vaultId,
  backupId,
  sync,
  idempotencyKey = () => crypto.randomUUID(),
  wait = delay,
  pollIntervalMs = 1_000,
  maxPolls = 120
}: RestoreCloudBackupOptions): Promise<CloudBackupRestoreResult> {
  const vault = (await client.listVaults()).data.find((candidate) => candidate.id === vaultId)
  if (!vault) {
    throw new Error('The linked ZenNotes Cloud vault is no longer available.')
  }

  let restore = (
    await client.createBackupRestore(vaultId, backupId, {
      idempotency_key: idempotencyKey(),
      expected_cursor: vault.cursor,
      mode: 'replace'
    })
  ).data

  let polls = 0
  while (!terminalRestoreStatuses.has(restore.status)) {
    if (polls >= maxPolls) {
      throw new Error('The backup restore is still running. Check again in a moment.')
    }
    polls += 1
    await wait(pollIntervalMs)
    restore = (await client.backupRestore(vaultId, backupId, restore.id)).data
  }

  return {
    restore,
    sync: restore.status === 'completed' ? await sync() : null
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
