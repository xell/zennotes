/**
 * Minimal "ghost" badge shown next to the vault name in the sidebar.
 *
 * Deliberately colorless: no fill, a thin neutral outline, and the vault
 * name's first letter in ink. Theme-aware (light/dark) via the paper/ink
 * tokens. This replaced an earlier per-name hue gradient — kept low-key and
 * uniform across vaults on purpose.
 */

export function VaultBadge({
  name,
  size = 28
}: {
  name: string
  size?: number
}): JSX.Element {
  const initial = (name?.trim().charAt(0) || 'Z').toUpperCase()

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg border border-paper-300 font-semibold text-ink-600"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        lineHeight: 1
      }}
      aria-hidden="true"
    >
      {initial}
    </div>
  )
}
