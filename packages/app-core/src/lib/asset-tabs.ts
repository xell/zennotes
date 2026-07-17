const ASSET_TAB_PREFIX = 'zen://asset/'

export function assetTabPath(assetPath: string): string {
  const normalized = assetPath.replace(/^\/+/, '')
  return `${ASSET_TAB_PREFIX}${encodeURIComponent(normalized)}`
}

export function isAssetTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(ASSET_TAB_PREFIX)
}

export function assetPathFromTab(path: string | null | undefined): string | null {
  if (!path || !isAssetTabPath(path)) return null
  const encoded = path.slice(ASSET_TAB_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/**
 * Adapt a raw vault-path rewrite (as used for note tabs on rename/move) so it
 * also applies to encoded asset-tab paths (`zen://asset/<encoded>`). Asset
 * tabs would otherwise be missed by a plain prefix rewrite, leaving an open
 * PDF/asset viewer pointed at a path that no longer exists after its file or
 * parent folder is renamed/moved. Pass the result to `rewritePathsInTree`.
 */
export function withAssetTabRewrite(rewriteRaw: (p: string) => string): (p: string) => string {
  return (p: string): string => {
    if (isAssetTabPath(p)) {
      const assetPath = assetPathFromTab(p)
      if (assetPath == null) return p
      const next = rewriteRaw(assetPath)
      return next === assetPath ? p : assetTabPath(next)
    }
    return rewriteRaw(p)
  }
}

export function assetTitleFromPath(path: string | null | undefined): string {
  if (!path) return 'Asset'
  const clean = path.split('#')[0]?.split('?')[0] ?? path
  const last = clean.split('/').filter(Boolean).pop() ?? clean
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}
