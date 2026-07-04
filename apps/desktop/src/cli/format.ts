/**
 * Output helpers for the `zn` CLI. The default mode is terse,
 * human-readable text. Pass `--json` on any command to swap in
 * machine-friendly JSON instead.
 *
 * We deliberately avoid colors/ANSI/box-drawing — the CLI is intended
 * to compose well in pipelines and CI logs, where escape codes are
 * either stripped or render badly.
 */

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

export function emitLine(line: string): void {
  process.stdout.write(line + '\n')
}

export function emitOk(message: string): void {
  process.stdout.write(message + '\n')
}

export function emitError(message: string): void {
  process.stderr.write(`zn: ${message}\n`)
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1).trimEnd() + '…'
}

export function formatRelativeAge(updatedAt: number): string {
  const diff = Date.now() - updatedAt
  if (diff < 0) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export function pad(value: string, width: number): string {
  if (value.length >= width) return value
  return value + ' '.repeat(width - value.length)
}
