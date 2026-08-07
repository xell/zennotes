import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  shell,
  webContents,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IPty } from 'node-pty'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fsp, createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { IPC } from '@shared/ipc'
import type {
  ManualOrderMap,
  NoteMeta,
  NoteCommentInput,
  NoteFolder,
  DeletedAsset,
  ExternalFileContent,
  GitCommitResult,
  GitFileEntry,
  GitStatusResult,
  MoveExternalFileResult,
  PastedImageInput,
  LocalVaultEntry,
  RemoteWorkspaceInfo,
  RemoteWorkspaceProfile,
  RemoteWorkspaceProfileInput,
  ServerCapabilities,
  VaultSettings,
  VaultChangeEvent,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchToolPaths
} from '@shared/ipc'
import {
  absolutePath,
  appendToNote,
  archiveNote,
  createFolder,
  createNote,
  createExcalidraw,
  convertObsidianExcalidraw,
  deleteAsset,
  DEFAULT_QUICK_CAPTURE_HOTKEY,
  deleteFolder,
  deleteNote,
  duplicateAsset,
  duplicateFolder,
  duplicateNote,
  emptyTrash,
  ensureVaultLayout,
  forgetLocalVault,
  folderAbsolutePath,
  generateDemoTour,
  getManualOrder,
  getVaultSettings,
  hasAssetsDir,
  importExternalNote,
  importFiles,
  importPastedImage,
  invalidateNoteMetaCache,
  invalidateVaultTextSearchCache,
  listAssets,
  listFolders,
  listNotes,
  loadConfig,
  moveNote,
  moveAsset,
  moveToTrash,
  readNoteComments,
  readNote,
  renameFolder,
  renameNote,
  renameAsset,
  removeDemoTour,
  restoreDeletedAsset,
  listDeletedAssets,
  purgeDeletedAsset,
  emptyDeletedAssets,
  restoreFromTrash,
  searchVaultTextCapabilities,
  searchVaultText,
  setManualOrder,
  setVaultSettings,
  rootContentHiddenByInboxMode,
  type PersistedRemoteWorkspaceConfig,
  type PersistedRemoteWorkspaceProfile,
  type PersistedWindowState,
  type PersistedWindowSession,
  rememberLocalVault,
  updateConfig,
  unarchiveNote,
  vaultInfo,
  writeNoteComments,
  writeNote,
  writeFileAtomicBinary
} from './vault'
import {
  initAppConfig,
  getPortableConfigSnapshot,
  setPortableConfig,
  getConfigFilePath,
  ensureConfigFile,
  getConfigDir
} from './app-config'
import {
  getCustomThemesDir,
  ensureCustomThemesDir,
  listCustomThemes,
  startWatchingCustomThemes,
  deleteCustomTheme,
  customThemeRevealTarget,
  createCustomTheme,
  resolveThemeAssetPath
} from './custom-themes'
import {
  ensureOverridesDir,
  listOverrides,
  startWatchingOverrides,
  overrideRevealTarget,
  deleteOverride
} from './overrides'
import type { AppConfigPortable } from '@shared/app-config'
import type { CustomTheme } from '@shared/custom-themes'
import type { Override } from '@shared/overrides'
import {
  listCustomTemplates,
  readCustomTemplate,
  writeCustomTemplate,
  deleteCustomTemplate
} from './templates'
import type { WriteTemplateInput } from '@zennotes/bridge-contract/templates'
import {
  deleteRemoteWorkspaceSecret,
  getRemoteWorkspaceSecret,
  setRemoteWorkspaceSecret
} from './secret-store'
import { scanAllTasks, scanTasksForPath } from './tasks'
import {
  readDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  renameDatabase,
  createRecordPage,
  listDatabases
} from './databases'
import type { DatabaseSidecar, DbRow } from '@shared/databases'
import { VaultWatcher } from './watcher'
import { WindowVaultRegistry } from './window-vaults'
import { registerEphemeralRoot, isEphemeralRoot } from './ephemeral-vaults'
import { renderTikz } from './tikz'
import { resolveCommandViaLoginShell } from './login-shell-path'
import { fetchLinkMetadata } from './link-metadata'
import { RemoteServerClient } from './remote/server-client'
import {
  getMcpClientStatuses,
  getMcpServerRuntime,
  installMcpForClient,
  uninstallMcpForClient
} from './mcp-integrations'
import {
  getCliInstallStatus,
  installCli,
  uninstallCli
} from './cli-install'
import {
  getRaycastExtensionStatus,
  installRaycastExtension
} from './raycast-integration'
import {
  checkForAppUpdates,
  downloadAppUpdate,
  getAppUpdateState,
  initAppUpdater,
  installAppUpdate,
  scheduleBackgroundAppUpdateCheck
} from './updater'
import type { McpClientId, McpInstructionsPayload } from '@shared/mcp-clients'
import {
  instructionsFilePath,
  readCustomInstructions,
  writeCustomInstructions,
  MCP_SERVER_INSTRUCTIONS
} from '../mcp/instructions-store'
import { recordBootMark, recordMainPerf } from './perf'
import {
  parseOpenNoteDeepLink,
  parseQuickCaptureDeepLink,
  ZENNOTES_DEEP_LINK_SCHEME
} from './deep-links'
import {
  isMarkdownFilePath,
  MARKDOWN_FILE_EXTENSIONS,
  candidatePathsFromArgv,
  resolveMarkdownOpenTarget
} from './file-open'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const nodeRequire = createRequire(import.meta.url)

// First point our code runs: everything before this is Electron/Node binary
// startup (and, on Linux AppImages, the runtime's FUSE mount).
recordBootMark('main.boot.module-loaded')
const LOCAL_ASSET_SCHEME = 'zen-asset'
const THEME_ASSET_SCHEME = 'zen-theme'
const EXCALIDRAW_ASSET_SCHEME = 'zen-excalidraw'
// Serves the Typst renderer's bundled assets (the compiler + renderer WASM and
// the New Computer Modern fonts) to the renderer. On the packaged app the window
// loads over file://, whose opaque origin makes the CSP `connect-src 'self'`
// reject a plain fetch of these assets, so the Typst renderer requests them
// through this scheme instead (added to connect-src in the renderer's
// index.html). Web keeps fetching the same-origin http assets.
const TYPST_ASSET_SCHEME = 'zen-typst'

const PRIVILEGED_ASSET_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  stream: true,
  corsEnabled: true
} as const

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_ASSET_SCHEME, privileges: PRIVILEGED_ASSET_PRIVILEGES },
  { scheme: THEME_ASSET_SCHEME, privileges: PRIVILEGED_ASSET_PRIVILEGES },
  { scheme: EXCALIDRAW_ASSET_SCHEME, privileges: PRIVILEGED_ASSET_PRIVILEGES },
  { scheme: TYPST_ASSET_SCHEME, privileges: PRIVILEGED_ASSET_PRIVILEGES }
])

let mainWindow: BrowserWindow | null = null
let mainWindowReadyForAppEvents = false
let creatingMainWindow: Promise<BrowserWindow> | null = null
let currentVault: VaultInfo | null = null
let currentWorkspaceMode: 'local' | 'remote' = 'local'
let remoteWorkspaceConfig: PersistedRemoteWorkspaceConfig | null = null
let currentRemoteWorkspaceProfileId: string | null = null
let remoteWorkspaceClient: RemoteServerClient | null = null
let remoteServerCapabilities: ServerCapabilities | null = null
let stopRemoteVaultWatch: (() => void) | null = null
const ipcWindowContext = new AsyncLocalStorage<BrowserWindow>()
const windowVaults = new WindowVaultRegistry({
  makeWatcher: () => new VaultWatcher(),
  invalidateVault: (root, ev) => {
    invalidateNoteMetaCache(root, ev.scope === 'vault-settings' ? undefined : ev.path)
    invalidateVaultTextSearchCache(root)
  },
  sendVaultChange: (windowId, ev) => {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.VAULT_ON_CHANGE, ev)
  }
})
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 900
const MIN_WINDOW_HEIGHT = 600
// Standalone single-file windows (external file, floating note) have no
// sidebar/tabs, so they can shrink far below the main window's minimum.
const STANDALONE_MIN_WINDOW_WIDTH = 360
const STANDALONE_MIN_WINDOW_HEIGHT = 320

const execFileAsync = promisify(execFile)
const WINDOW_STATE_PERSIST_DELAY_MS = 150
const DEFAULT_ZOOM_FACTOR = 1
const MIN_ZOOM_FACTOR = 0.5
const MAX_ZOOM_FACTOR = 3
const ZOOM_STEP = 0.1
const MAC_WINDOW_BACKGROUND_COLOR = '#1f1f1f'
const MAIN_WINDOW_TABBING_IDENTIFIER = 'zennotes-vault-window'
const APP_WEBSITE_URL = 'https://zennotes.org'
const APP_DISCORD_URL = 'https://discord.gg/W4fWzapKS6'
const APP_REPOSITORY_URL = 'https://github.com/ZenNotes/zennotes'
const APP_RELEASES_URL = 'https://github.com/ZenNotes/zennotes/releases/latest'
const APP_ISSUES_URL = 'https://github.com/ZenNotes/zennotes/issues'
const userDataPathOverride = process.env['ZENNOTES_USER_DATA_PATH']?.trim()
if (userDataPathOverride && (process.env['ZEN_PERF'] === '1' || !app.isPackaged)) {
  app.setPath('userData', path.resolve(userDataPathOverride))
}
let currentZoomFactor = DEFAULT_ZOOM_FACTOR
const pendingOpenNoteRequests: string[] = []
const pendingFloatingNoteRequests: string[] = []
let flushingFloatingNoteRequests = false

// Markdown files handed to us by the OS (Finder "Open With", a file
// double-click, drag onto the dock, or a Windows/Linux argv launch).
const pendingFileOpens: { absPath: string; reuseMainWindow: boolean }[] = []
// windowId -> absolute path of the standalone external file it edits.
const externalFileWindows = new Map<number, string>()
// Per-window renderer readiness, so note-open requests can target any
// window (not just the main one) without racing the renderer mount.
const readyWindowIds = new Set<number>()
const pendingWindowNoteOpens = new Map<number, string[]>()
let appStartupComplete = false
const gotSingleInstanceLock = app.requestSingleInstanceLock()

function isMac(): boolean {
  return process.platform === 'darwin'
}

function windowIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../build/icon.png')
}

function openAllowedExternalUrl(url: string): void {
  if (/^(https?:|mailto:)/i.test(url)) {
    shell.openExternal(url).catch(() => {})
  }
}

function registerAppDeepLinkProtocol(): void {
  if (!isMac()) return

  try {
    const defaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true
    const didRegister =
      defaultApp && process.argv[1]
        ? app.setAsDefaultProtocolClient(
            ZENNOTES_DEEP_LINK_SCHEME,
            process.execPath,
            [path.resolve(process.argv[1])]
          )
        : app.setAsDefaultProtocolClient(ZENNOTES_DEEP_LINK_SCHEME)

    if (!didRegister) {
      console.warn(`Failed to register ${ZENNOTES_DEEP_LINK_SCHEME} URL handler`)
    }
  } catch (err) {
    console.warn(`Failed to register ${ZENNOTES_DEEP_LINK_SCHEME} URL handler`, err)
  }
}

function dispatchOpenNoteRequest(win: BrowserWindow, relPath: string): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send(IPC.APP_OPEN_NOTE_REQUESTED, relPath)
}

function flushPendingOpenNoteRequests(win = mainWindow): void {
  if (!win || win.isDestroyed() || !mainWindowReadyForAppEvents) return

  const requests = pendingOpenNoteRequests.splice(0)
  for (const relPath of requests) dispatchOpenNoteRequest(win, relPath)
}

function queueOpenNoteRequest(relPath: string): void {
  pendingOpenNoteRequests.push(relPath)

  if (mainWindow && !mainWindow.isDestroyed()) {
    flushPendingOpenNoteRequests(mainWindow)
    return
  }

  if (app.isReady()) {
    void ensureMainWindow().then(() => flushPendingOpenNoteRequests())
  }
}

function queueFloatingNoteRequest(relPath: string): void {
  pendingFloatingNoteRequests.push(relPath)
  if (app.isReady()) void flushPendingFloatingNoteRequests()
}

async function flushPendingFloatingNoteRequests(): Promise<void> {
  if (flushingFloatingNoteRequests || pendingFloatingNoteRequests.length === 0) return
  flushingFloatingNoteRequests = true
  try {
    const vault = await loadCurrentVaultFromConfig()
    if (!vault) {
      await ensureMainWindow()
      return
    }

    const requests = pendingFloatingNoteRequests.splice(0)
    for (const relPath of requests) openFloatingNoteWindow(relPath)
  } finally {
    flushingFloatingNoteRequests = false
  }
}

type ExternalOpenUrlResult = 'none' | 'note' | 'quick-capture'

function handleExternalOpenUrl(rawUrl: string): ExternalOpenUrlResult {
  if (parseQuickCaptureDeepLink(rawUrl)) {
    void toggleQuickCaptureWindow()
    return 'quick-capture'
  }
  const request = parseOpenNoteDeepLink(rawUrl)
  if (!request) return 'none'
  if (request.target === 'window') queueFloatingNoteRequest(request.path)
  else queueOpenNoteRequest(request.path)
  return 'note'
}

function handleStartupDeepLinks(argv: string[]): ExternalOpenUrlResult {
  let result: ExternalOpenUrlResult = 'none'
  for (const arg of argv) {
    if (arg.startsWith(`${ZENNOTES_DEEP_LINK_SCHEME}:`)) {
      const next = handleExternalOpenUrl(arg)
      if (next !== 'none') result = next
    }
  }
  return result
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// Dispatch a note-open to a specific window, deferring until that
// window's renderer reports ready so the request isn't dropped on a
// freshly created window.
function queueNoteOpenForWindow(win: BrowserWindow, relPath: string): void {
  if (win.isDestroyed()) return
  if (readyWindowIds.has(win.id)) {
    dispatchOpenNoteRequest(win, relPath)
    return
  }
  const list = pendingWindowNoteOpens.get(win.id) ?? []
  list.push(relPath)
  pendingWindowNoteOpens.set(win.id, list)
}

function flushWindowNoteOpens(win: BrowserWindow): void {
  const list = pendingWindowNoteOpens.get(win.id)
  if (!list || list.length === 0) return
  pendingWindowNoteOpens.delete(win.id)
  for (const relPath of list) dispatchOpenNoteRequest(win, relPath)
}

// Full workspace windows created via createWindow. Utility windows —
// quick capture, floating notes, PDF export, external-file editors —
// inherit the vault session in windowVaults so they can read the vault,
// but they must never be picked as the target for opening a note: a
// Finder "Open in ZenNotes" that lands in the hidden quick-capture
// panel looks like the app opened a quick note instead of the file.
const workspaceWindowIds = new Set<number>()
/** Id of the workspace window focused most recently. Quick capture reads it to
 *  decide which vault to capture into when it has no explicit choice. */
let lastFocusedWorkspaceWindowId: number | null = null
// The app is on its way out (before-quit already ran the unsaved-PDF guard),
// so per-window close handlers must NOT prompt again.
let appIsQuitting = false
// Windows whose unsaved-PDF close prompt was already answered "proceed" — the
// second `win.close()` after confirming is allowed straight through.
const windowsAllowedToClose = new Set<number>()

/** Ask one window's renderer whether it's OK to close/quit with unsaved PDF
 *  highlights. Reaches the renderer-held state + dialog via a `window` hook.
 *  Resolves false only when the user cancels. */
async function confirmWindowUnsavedPdfs(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return true
  try {
    const proceed = await win.webContents.executeJavaScript(
      'window.__zenConfirmUnsavedPdfs ? window.__zenConfirmUnsavedPdfs() : true'
    )
    return proceed !== false
  } catch (err) {
    // Never let a failed check wedge the window/app in a can't-close state.
    console.error('[close] unsaved-PDF check failed', err)
    return true
  }
}
// Maps Electron BrowserWindow.id → stable session UUID so each window can be
// individually identified across launches.
const windowUuids = new Map<number, string>()

// node-pty is not listed as a package.json dependency so electron-builder does
// not try to pack it (which would fail due to workspace symlinks). Instead:
//   dev  — loaded from the monorepo node_modules via require('node-pty')
//   prod — copied to Resources/node-pty/ via extraResources; loaded by path
function loadNodePty(): typeof import('node-pty') {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'node-pty')
    : 'node-pty'
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(p) as typeof import('node-pty')
}

// Electron's tab APIs (addTabbedWindow, mergeAllWindows, etc.) are
// write-only: there is no event or getter for "which windows are tabbed
// with this one right now". Dragging a tab out of the bar by hand, or
// dropping one window's tab into another's bar, changes real AppKit state
// that Electron never surfaces to JS. `native/tab-groups` is a small N-API
// addon that reads NSWindow.tabbedWindows directly to answer that question.
// Same dev/prod path split as loadNodePty above, but from our own repo
// directory rather than node_modules since it isn't an installed package.
interface TabGroupsNative {
  getTabGroupHandles(handle: Buffer): Buffer[]
  /** Electron's own BrowserWindow constructor sets tabbingMode to
   *  NSWindowTabbingModeDisallowed for any non-default titleBarStyle
   *  (hiddenInset counts as "no native title bar" internally, even
   *  though it still has real traffic lights) — confirmed empirically:
   *  tabbingMode read back as disallowed despite tabbingIdentifier being
   *  passed to the constructor. addTabbedWindow() bypasses that check
   *  (which is why merging already worked), but toggleTabBar() respects
   *  it and silently no-ops. Call once per vault window right after
   *  creation to put tabbingMode back to automatic and set the
   *  identifier Electron skipped. */
  enableTabbing(handle: Buffer, identifier: string): void
  /** Points of the content view's top edge currently covered by native
   *  title bar / tab bar chrome (NSWindow.contentLayoutRect under the
   *  hood). hiddenInset windows never shrink the content view for this —
   *  by design, so the app can draw its own chrome there — so this is the
   *  only way to know how much top space is actually safe to use. */
  getContentTopInset(handle: Buffer): number
  /** Ground truth for whether AppKit is currently drawing a tab strip for
   *  this window — independent of tab group membership, since a lone
   *  window can have its bar manually shown (Window > Toggle Tab Bar)
   *  with nothing else tabbed into it yet. Electron has no getter for
   *  this (toggleTabBar() only flips it), so this is the only way to
   *  know which way it's currently flipped. */
  isTabBarVisible(handle: Buffer): boolean
  /** Diagnostic-only dump of every geometry number that could plausibly be
   *  the real top inset, plus the frame of every view layered above the
   *  content view. Logged by DEBUG_TAB_CHROME while pinning down the exact
   *  right number for getContentTopInset; not used in the actual UI. */
  getChromeDebug(handle: Buffer): Record<string, unknown>
}
// Toggle with the DEBUG_TAB_CHROME env var — this is diagnostic-only, dumping
// raw window/tab-bar geometry to the console so the getContentTopInset
// formula can be tuned against real numbers instead of guessed.
const DEBUG_TAB_CHROME = !!process.env.DEBUG_TAB_CHROME
function loadTabGroupsNative(): TabGroupsNative | null {
  if (!isMac()) return null
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'tab-groups', 'tab_groups.node')
      : path.join(__dirname, '../../native/tab-groups/build/Release/tab_groups.node')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(p) as TabGroupsNative
  } catch (err) {
    console.error('[window tabs] native tab-groups addon unavailable, tab layout will not persist across relaunch', err)
    return null
  }
}
const tabGroupsNative = loadTabGroupsNative()

// Electron windows never enrol in AppKit window restoration, which is how
// native apps carry their windows back onto their Mission Control Spaces after
// a quit (dead for Electron on macOS 26 — see data/per-window-space-persistence.md).
// `native/window-spaces` is a small N-API addon over the private SkyLight API
// (the BetterTouchTool "Move Window to Desktop X" route) that lets us capture a
// window's Space and send it back there on relaunch. Same dev/prod path split
// and ABI-stable N-API contract as the tab-groups addon above; isolated in its
// own module so the private-API dependency can't destabilise tab persistence.
interface WindowSpacesNative {
  /** Token of the Space the window is on, or "" if unknown — which includes the
   *  ordinary case of the window sitting on a Space that isn't currently
   *  visible, since the WindowServer only answers for the visible Space. */
  getWindowSpaceId(handle: Buffer): string
  /** Token of the Space visible right now on this window's display (pass an
   *  empty buffer for the primary display). Only trustworthy for a window known
   *  to be on the active Space, i.e. one that just took focus. */
  getCurrentSpaceId(handle: Buffer): string
  /** Relocate the window to the identified Space without switching to it.
   *  False when the window has no window number yet or the Space no longer
   *  exists (closed, or ids reshuffled by a reboot) — leave the window put. */
  moveWindowToSpaceId(handle: Buffer, spaceId: string): boolean
  /** Diagnostic-only: a token for every Space the WindowServer knows. */
  getAllSpaceIds(): string[]
  /** Keep the window bound to one Space rather than following the app onto the
   *  active Space. Measured as already the case, so this is a guard against
   *  that changing rather than a fix. Returns the resulting behaviour mask. */
  setWindowSpaceBound(handle: Buffer): number
  /** Diagnostic-only: window number, collection behaviour, the raw space ids
   *  reported for a window, and the full managed-spaces table. */
  debugWindowSpace(handle: Buffer): {
    windowNumber: number
    collectionBehavior: number
    currentSpaceId: string
    rawSpaceIds: number[]
    managedSpaces: { id: number; token: string }[]
  }
}
function loadWindowSpacesNative(): WindowSpacesNative | null {
  if (!isMac()) return null
  try {
    const p = app.isPackaged
      ? path.join(process.resourcesPath, 'window-spaces', 'window_spaces.node')
      : path.join(__dirname, '../../native/window-spaces/build/Release/window_spaces.node')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(p) as WindowSpacesNative
  } catch (err) {
    console.error('[window spaces] native window-spaces addon unavailable, per-window Space persistence disabled', err)
    return null
  }
}
const windowSpacesNative = loadWindowSpacesNative()
// Per-window Space capture/restore is chatty and entirely diagnostic once it
// works, so it is behind an env var: `DEBUG_WINDOW_SPACES=1`. Note main-process
// logs only surface when the app is launched from a terminal
// (/Applications/ZenNotes.app/Contents/MacOS/ZenNotes) — there is no log file.
const DEBUG_WINDOW_SPACES = !!process.env.DEBUG_WINDOW_SPACES
if (DEBUG_WINDOW_SPACES) {
  if (windowSpacesNative) {
    try {
      console.error(
        '[window spaces] addon loaded; all spaces:',
        JSON.stringify(windowSpacesNative.getAllSpaceIds())
      )
    } catch (err) {
      console.error('[window spaces] getAllSpaceIds threw at load', err)
    }
  } else {
    console.error('[window spaces] addon NOT loaded (windowSpacesNative is null)')
  }
}

// The UUID of the Space `win` is currently on, or null when the addon is
// unavailable or the window isn't realised on screen yet.
// Last known Space per window, keyed by BrowserWindow id. Maintained from
// 'focus' (a focused window is necessarily on the visible Space) because
// CGSCopySpacesForWindows reports nothing for these windows — see
// data/per-window-space-persistence.md. This map, not a live query, is the
// reliable capture source at quit time, when every window is asked at once and
// only one of them is actually on the current Space.
const windowSpaceByWinId = new Map<number, string>()

// Bind the window to a single Space (rather than letting it follow the app onto
// whatever Space is active). Called once per window right after creation.
function nativeBindWindowToSpace(win: BrowserWindow): void {
  if (!windowSpacesNative || win.isDestroyed()) return
  try {
    const mask = windowSpacesNative.setWindowSpaceBound(win.getNativeWindowHandle())
    if (DEBUG_WINDOW_SPACES) {
      console.error('[window spaces] bind', windowUuids.get(win.id), 'collectionBehavior ->', mask)
    }
  } catch (err) {
    console.error('[window spaces] failed to bind window to its Space', err)
  }
}

// Record the Space this window is on. Only valid to call when the window is
// known to be on the active Space (on focus, or right after we placed it).
function rememberWindowSpace(win: BrowserWindow): void {
  if (!windowSpacesNative || win.isDestroyed()) return
  try {
    const uuid = windowSpacesNative.getCurrentSpaceId(win.getNativeWindowHandle())
    if (uuid && uuid.trim()) {
      windowSpaceByWinId.set(win.id, uuid)
      if (DEBUG_WINDOW_SPACES) {
        console.error('[window spaces] remember', windowUuids.get(win.id), '->', uuid)
      }
    }
  } catch (err) {
    console.error('[window spaces] failed to read current Space', err)
  }
}

// The Space currently visible on the main display, with no window in hand.
// (An empty buffer resolves to no NSWindow, which the addon treats as "use the
// primary display".) Used at launch to know which Space we started on.
function nativeCurrentDisplaySpaceId(): string | null {
  if (!windowSpacesNative) return null
  try {
    const uuid = windowSpacesNative.getCurrentSpaceId(Buffer.alloc(0))
    return uuid && uuid.trim() ? uuid : null
  } catch {
    return null
  }
}

// Re-read every window's Space and persist any that changed.
//
// Focus alone is not enough: dragging a window to another Space in Mission
// Control never focuses it, so its Space went unrecorded and it was restored
// onto the launch Space instead. The WindowServer will happily report a
// window's Space — but only while that window is on the *visible* Space — so
// sweeping on a timer picks each window up as the user moves between Spaces
// during normal work, and the value then sticks in the map.
function sweepWindowSpaces(): void {
  if (!windowSpacesNative) return
  const wins = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isWorkspaceWindow(win)
  )
  const changed = new Set<BrowserWindow>()
  const readDirectly: BrowserWindow[] = []
  for (const win of wins) {
    try {
      const uuid = windowSpacesNative.getWindowSpaceId(win.getNativeWindowHandle())
      if (!uuid || !uuid.trim()) continue
      readDirectly.push(win)
      if (windowSpaceByWinId.get(win.id) !== uuid) {
        windowSpaceByWinId.set(win.id, uuid)
        changed.add(win)
      }
    } catch {
      /* window went away mid-sweep */
    }
  }
  // Tabs in one native tab group always share a Space, but only the frontmost
  // tab is readable — the others are ordered out. Propagate from whichever
  // member we just read directly so a whole group moves together.
  for (const win of readDirectly) {
    const uuid = windowSpaceByWinId.get(win.id)
    if (!uuid) continue
    for (const member of nativeTabGroupMembers(win)) {
      if (member.isDestroyed() || member === win) continue
      if (windowSpaceByWinId.get(member.id) === uuid) continue
      windowSpaceByWinId.set(member.id, uuid)
      changed.add(member)
    }
  }
  for (const win of changed) {
    if (DEBUG_WINDOW_SPACES) {
      console.error('[window spaces] sweep changed', windowUuids.get(win.id), '->', windowSpaceByWinId.get(win.id))
    }
    void persistWindowState(win)
  }
}

const WINDOW_SPACE_SWEEP_INTERVAL_MS = 4000
let windowSpaceSweepTimer: ReturnType<typeof setInterval> | null = null
function startWindowSpaceSweep(): void {
  if (!windowSpacesNative || windowSpaceSweepTimer) return
  windowSpaceSweepTimer = setInterval(sweepWindowSpaces, WINDOW_SPACE_SWEEP_INTERVAL_MS)
}

function nativeWindowSpaceId(win: BrowserWindow): string | null {
  if (!windowSpacesNative || win.isDestroyed()) return null
  let direct = ''
  try {
    direct = windowSpacesNative.getWindowSpaceId(win.getNativeWindowHandle())
    if (DEBUG_WINDOW_SPACES) {
      const dump = windowSpacesNative.debugWindowSpace(win.getNativeWindowHandle())
      console.error('[window spaces] capture', windowUuids.get(win.id), 'direct=', JSON.stringify(direct), 'tracked=', windowSpaceByWinId.get(win.id) ?? null, JSON.stringify(dump))
    }
  } catch (err) {
    console.error('[window spaces] failed to read window Space', err)
  }
  // Prefer the WindowServer's own answer when it has one; otherwise fall back
  // to what we tracked on focus.
  if (direct && direct.trim()) return direct
  return windowSpaceByWinId.get(win.id) ?? null
}

// Send `win` back to the Space it was persisted on. No-op (and harmless) when
// the addon is unavailable, the uuid is empty, or that Space no longer exists.
function nativeMoveWindowToSpace(win: BrowserWindow, uuid: string | null | undefined): void {
  if (!windowSpacesNative || win.isDestroyed() || !uuid) return
  try {
    const moved = windowSpacesNative.moveWindowToSpaceId(win.getNativeWindowHandle(), uuid)
    if (DEBUG_WINDOW_SPACES) {
      console.error('[window spaces] restore', windowUuids.get(win.id), 'to', uuid, '=>', moved)
    }
  } catch (err) {
    console.error('[window spaces] failed to move window to Space', err)
  }
}

// The real, current members of `win`'s native tab group (including `win`
// itself), resolved back to BrowserWindow instances by comparing native
// view handles. Falls back to `[win]` (i.e. "standalone") if the addon
// isn't available or the window isn't tabbed with anything.
function nativeTabGroupMembers(win: BrowserWindow): BrowserWindow[] {
  if (!tabGroupsNative || win.isDestroyed()) return [win]
  let handles: Buffer[]
  try {
    handles = tabGroupsNative.getTabGroupHandles(win.getNativeWindowHandle())
  } catch (err) {
    console.error('[window tabs] failed to query native tab group', err)
    return [win]
  }
  const open = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  const members: BrowserWindow[] = []
  for (const handle of handles) {
    const match = open.find((w) => {
      try {
        return w.getNativeWindowHandle().equals(handle)
      } catch {
        return false
      }
    })
    if (match) members.push(match)
  }
  return members.length > 0 ? members : [win]
}

// The traffic lights' own tight bounds sit a bit higher than where content
// should actually start — the single-window title bar has the same kind of
// breathing room around its content, this just matches it for the tabbed case.
const TAB_CHROME_BOTTOM_PADDING = 8

function nativeContentTopInset(win: BrowserWindow): number {
  if (!tabGroupsNative || win.isDestroyed()) return 0
  try {
    return tabGroupsNative.getContentTopInset(win.getNativeWindowHandle()) + TAB_CHROME_BOTTOM_PADDING
  } catch (err) {
    console.error('[window tabs] failed to query content top inset', err)
    return 0
  }
}

function nativeTabBarVisible(win: BrowserWindow): boolean {
  if (!tabGroupsNative || win.isDestroyed()) return false
  try {
    return tabGroupsNative.isTabBarVisible(win.getNativeWindowHandle())
  } catch (err) {
    console.error('[window tabs] failed to query tab bar visibility', err)
    return false
  }
}

// Queries the real native tab groups for every open vault window in one
// synchronous pass (so windows that are actually tabbed together always
// agree on the same group id — no risk of one seeing a stale answer) and
// writes the result straight into openWindows.
async function reconcileAndPersistTabGroups(): Promise<void> {
  const vaultWindows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isWorkspaceWindow(win)
  )
  const idToTabGroupId = new Map<number, string | null>()
  for (const win of vaultWindows) {
    const members = nativeTabGroupMembers(win).filter((w) => isWorkspaceWindow(w))
    // Grouping (for relaunch persistence) and tab bar visibility (for the
    // renderer's chrome inset + Zen mode) are different questions: a 2+
    // member group can have its bar hidden (Zen mode, or now the manual
    // Window menu toggle) while still needing its grouping restored on
    // relaunch, and a lone window can have its bar manually shown with no
    // group at all. Conflating them regressed either the relaunch-restore
    // or the chrome-inset reservation depending on which way it was wrong.
    const isGrouped = members.length >= 2
    const tabBarVisible = nativeTabBarVisible(win)
    syncTabBarForZenMode(win, tabBarVisible)
    if (DEBUG_TAB_CHROME && tabGroupsNative && tabBarVisible) {
      try {
        const debugInfo = tabGroupsNative.getChromeDebug(win.getNativeWindowHandle())
        console.error('[tab-chrome-debug]', windowUuids.get(win.id), JSON.stringify(debugInfo))
      } catch (err) {
        console.error('[tab-chrome-debug] failed', err)
      }
    }
    // Pushed live so the renderer can reserve the right amount of blank
    // space instead of getting overlapped or masked by the native tab bar
    // (see nativeContentTopInset / WindowChromeState for why this can't
    // just be a fixed constant).
    win.webContents.send(IPC.WINDOW_CHROME_ON_CHANGE, {
      tabBarVisible,
      topInset: nativeContentTopInset(win)
    })
    if (!isGrouped) {
      idToTabGroupId.set(win.id, null)
      continue
    }
    const uuids = members
      .map((w) => windowUuids.get(w.id))
      .filter((id): id is string => !!id)
      .sort()
    idToTabGroupId.set(win.id, uuids.length >= 2 ? uuids.join(',') : null)
  }
  const updates = vaultWindows
    .map((win) => ({ win, uuid: windowUuids.get(win.id), tabGroupId: idToTabGroupId.get(win.id) ?? null }))
    .filter((u): u is { win: BrowserWindow; uuid: string; tabGroupId: string | null } => !!u.uuid)
  if (updates.length === 0) return
  await updateConfig((cfg) => {
    const byId = new Map(updates.map((u) => [u.uuid, u]))
    const sessions = cfg.openWindows ?? []
    const seenUuids = new Set<string>()
    const merged = sessions.map((s) => {
      const u = byId.get(s.windowId)
      if (!u) return s
      seenUuids.add(s.windowId)
      return { ...s, tabGroupId: u.tabGroupId }
    })
    // A window that joined a tab group before it ever had its own session
    // entry — the native "+" button's window inherits its vault in memory
    // only (inheritWindowWorkspaceSession), so until now it wasn't persisted
    // until its next resize/move or app quit, whichever came first, if ever
    // — has no existing entry for the map above to update. Build one now so
    // its tabGroupId (and the fact that it's open at all) isn't silently
    // dropped: this is what let a just-created tab vanish, or worse, take
    // over another window's slot, on the next relaunch.
    const appended: PersistedWindowSession[] = []
    for (const u of updates) {
      if (seenUuids.has(u.uuid)) continue
      if (u.win.isDestroyed()) continue
      const vault = windowVaults.vaultForWindow(u.win.id)
      if (!vault) continue
      appended.push({
        windowId: u.uuid,
        root: vault.root,
        windowState: captureWindowState(u.win),
        tabGroupId: u.tabGroupId,
        spaceId: nativeWindowSpaceId(u.win)
      })
    }
    return { ...cfg, openWindows: [...merged, ...appended] }
  })
}

// Debounced separately from per-window geometry persistence: this is a
// shared, app-wide reconciliation (it has to look at every vault window at
// once to be consistent), not a per-window one. Triggered on the same
// move/resize signals used for geometry, since that's the only observable
// side effect of a native tab drag — there is no dedicated event for it.
let tabGroupReconcileTimer: ReturnType<typeof setTimeout> | null = null
function scheduleTabGroupReconcile(): void {
  if (tabGroupReconcileTimer) clearTimeout(tabGroupReconcileTimer)
  tabGroupReconcileTimer = setTimeout(() => {
    tabGroupReconcileTimer = null
    void reconcileAndPersistTabGroups()
  }, WINDOW_STATE_PERSIST_DELAY_MS)
}

// PTY sessions keyed by a random UUID. Each entry records the pty handle and
// the webContents ID so output can be routed back to the right renderer and
// all sessions for a closed window can be cleaned up.
interface PtySession { pty: IPty; webContentsId: number }
const ptySessions = new Map<string, PtySession>()

function killPtySessionsForWebContents(wcId: number): void {
  for (const [id, session] of ptySessions) {
    if (session.webContentsId !== wcId) continue
    try { session.pty.kill() } catch { /* already dead */ }
    ptySessions.delete(id)
    ptyTty.delete(id)
  }
  terminalFocusedWcIds.delete(wcId)
}

// Windows whose embedded terminal currently holds focus (by webContents id),
// reported from the renderer. Used to intercept a couple of hardcoded shortcuts
// at before-input-event level (see createWindow).
const terminalFocusedWcIds = new Set<number>()

function terminalSessionForWebContents(wcId: number): PtySession | undefined {
  for (const session of ptySessions.values()) {
    if (session.webContentsId === wcId) return session
  }
  return undefined
}

// ─── tmux target persistence ────────────────────────────────────────────────
// A window's terminal may host a tmux client. We remember which tmux pane (by
// its stable `%id`) each window was viewing so a relaunch can re-attach it,
// keyed by the window's persistent UUID. tmux keeps the sessions alive across
// an app quit, so we only replay the attach — no session state is saved here.
// See PersistedWindowSession.tmuxTarget.

// pty session id -> the pty's controlling tty (e.g. "ttys004"), resolved once.
const ptyTty = new Map<string, string>()

function windowUuidForWebContents(wcId: number): string | undefined {
  const wc = webContents.fromId(wcId)
  const win = wc ? BrowserWindow.fromWebContents(wc) : null
  return win ? windowUuids.get(win.id) : undefined
}

// Resolve tmux to an absolute path, memoized. A GUI app inherits only a minimal
// PATH, and shell-based resolution is unreliable there (a login shell does not
// source ~/.zshrc where Homebrew's shellenv usually lives), so try the shared
// login-shell resolver first and then probe the well-known install locations.
const TMUX_KNOWN_PATHS = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/opt/local/bin/tmux'
]
let tmuxBinCache: { at: number; value: string | null } | null = null
async function resolveTmuxBin(): Promise<string | null> {
  if (tmuxBinCache && Date.now() - tmuxBinCache.at < 60_000) return tmuxBinCache.value
  let value = await resolveCommandViaLoginShell('tmux')
  if (!value) {
    for (const p of TMUX_KNOWN_PATHS) {
      try {
        await fsp.access(p)
        value = p
        break
      } catch {
        /* not installed here — try the next */
      }
    }
  }
  tmuxBinCache = { at: Date.now(), value }
  return value
}

async function ttyForPid(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { timeout: 2000 })
    const tty = stdout.trim()
    return tty && tty !== '??' ? tty : ''
  } catch {
    return ''
  }
}

// Snapshot every terminal's current tmux pane and persist the changed ones onto
// their window's session entry. If tmux is missing or its server is gone the
// query throws and we leave saved targets untouched, so a transient hiccup (or
// simply not using tmux) never wipes a good target.
async function captureTmuxTargets(): Promise<void> {
  if (ptySessions.size === 0) return
  // A GUI app inherits only a minimal PATH, so resolve tmux via the login shell.
  const tmuxBin = await resolveTmuxBin()
  if (!tmuxBin) return
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      tmuxBin,
      ['list-clients', '-F', '#{client_tty}\t#{pane_id}'],
      { timeout: 2000 }
    ))
  } catch {
    return
  }
  const clients = new Map<string, string>() // tty -> pane id (%N)
  for (const line of stdout.split('\n')) {
    // tmux does not separate the two fields with the tab we asked for (it emits
    // an underscore), so pull each out by shape instead of splitting on a
    // separator. A tty device path is only letters/digits/slashes; a pane id is
    // `%<n>`. Bounding the tty to those chars stops it before the separator.
    const tty = line.match(/\/dev\/([a-zA-Z0-9/]+)/)?.[1]
    const pane = line.match(/%\d+/)?.[0]
    if (tty && pane) clients.set(tty, pane)
  }

  const byUuid = new Map<string, string | null>()
  for (const [sid, session] of ptySessions) {
    let tty = ptyTty.get(sid)
    if (!tty) {
      tty = await ttyForPid(session.pty.pid)
      if (tty) ptyTty.set(sid, tty)
    }
    if (!tty) continue
    const uuid = windowUuidForWebContents(session.webContentsId)
    if (!uuid) continue
    // A terminal with no matching client is genuinely detached from tmux.
    byUuid.set(uuid, clients.get(tty) ?? null)
  }
  if (byUuid.size === 0) return

  await updateConfig((cfg) => {
    const sessions = cfg.openWindows ?? []
    let changed = false
    const next = sessions.map((s) => {
      if (!byUuid.has(s.windowId)) return s
      const target = byUuid.get(s.windowId) ?? null
      if ((s.tmuxTarget ?? null) === target) return s
      changed = true
      return { ...s, tmuxTarget: target }
    })
    return changed ? { ...cfg, openWindows: next } : cfg
  })
}

let tmuxPollTimer: NodeJS.Timeout | null = null
function ensureTmuxTargetPoll(): void {
  if (tmuxPollTimer) return
  // A few seconds is plenty: the target only has to be current by the next quit.
  tmuxPollTimer = setInterval(() => { void captureTmuxTargets() }, 5000)
  tmuxPollTimer.unref?.()
}

// After a terminal spawns, if its window was viewing a tmux pane last run and
// that pane still exists, replay the attach into the fresh shell.
async function restoreTmuxTarget(id: string, wcId: number): Promise<void> {
  const uuid = windowUuidForWebContents(wcId)
  if (!uuid) return
  const cfg = await loadConfig()
  const target = (cfg.openWindows ?? []).find((s) => s.windowId === uuid)?.tmuxTarget
  // Validate the shape before interpolating it into a shell command.
  if (!target || !/^%\d+$/.test(target)) return
  const tmuxBin = await resolveTmuxBin()
  if (!tmuxBin) return
  try {
    // Only attach if the pane is still alive in the running tmux server.
    await execFileAsync(tmuxBin, ['list-panes', '-t', target], { timeout: 2000 })
  } catch {
    return
  }
  // Let the shell finish loading its rc files before we "type" the attach. The
  // `\;` reach tmux as its own command separators, so this attaches to the
  // pane's session and restores the exact window and pane it was showing.
  setTimeout(() => {
    const session = ptySessions.get(id)
    if (!session) return
    const cmd =
      `tmux attach -t "$(tmux display -pt ${target} -p '#{session_id}')" ` +
      `\\; select-window -t ${target} \\; select-pane -t ${target}\n`
    try { session.pty.write(cmd) } catch { /* pty already gone */ }
  }, 500)
}

function isWorkspaceWindow(win: BrowserWindow): boolean {
  return workspaceWindowIds.has(win.id)
}

// Electron's declarative `tabbingIdentifier` is enough for the OS to place
// new sibling windows into a tab group automatically, but it does not
// reliably retrofit *existing* standalone windows into one — the native
// `mergeAllWindows()` action silently no-ops depending on the current
// window arrangement and the system's "prefer tabs" preference. Driving
// `addTabbedWindow` explicitly is the documented, deterministic way to
// force separate windows into a single tab group regardless of that state.
// Right after a window joins a tab group, AppKit briefly renders its tab
// chrome spread across two stacked rows (traffic lights alone, tab strip
// below) before collapsing it into one combined row a moment later — purely
// cosmetic, both fit within the same reserved inset, but it's a visible
// flash the user shouldn't have to see. A trivial resize nudge forces
// AppKit to run its layout pass immediately instead of on its own schedule,
// so the window only ever shows the settled, combined-row look.
function nudgeWindowLayout(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  win.setBounds({ ...bounds, width: bounds.width + 1 })
  win.setBounds(bounds)
}

// Windows currently reporting themselves as being in Zen mode. Renderer-only
// UI state — the main process has no other way to know about it.
const zenModeWindows = new Set<number>()
// Windows whose native tab bar we've hidden to match Zen mode. Tracked
// ourselves since Electron has no getter for "is the tab bar currently
// visible" — toggleTabBar() only flips it, so this is the only way to know
// which way it's currently flipped and avoid toggling twice (or not at all).
const tabBarHiddenForZen = new Set<number>()

// Zen mode hides all of ZenNotes's own chrome, but a tab bar is real AppKit
// UI outside the renderer's control — this is the only way to make Zen mode
// declutter that too. Takes the live visibility reading (not tab group
// membership) since a lone window can now have its bar manually shown via
// Window > Toggle Tab Bar, same as a merged one.
//
// toggleTabBar() only flips whatever is currently showing, so both the hide
// and restore paths check live state before calling it — otherwise a manual
// toggle in between (the user reopening the bar themselves while still in
// Zen mode, or right as Zen mode ends) could get silently undone or, worse,
// flipped the wrong way when this later "restores" a bar that was never
// actually hidden by us in the first place.
//
// It also only flips at all "if there is only one tab" (Electron's own doc
// caveat, confirmed empirically — see e58b7e6): for a window with 2+ real
// tabs the call is a silent no-op, AppKit gives no way to hide that bar. The
// re-check after calling it is what keeps that case honest — it only marks
// the bar as "hidden by us" if the toggle actually took effect, so a later
// Zen-mode exit doesn't try to "restore" a bar that was never really hidden.
function syncTabBarForZenMode(win: BrowserWindow, tabBarVisible: boolean): void {
  if (win.isDestroyed()) return
  if (zenModeWindows.has(win.id)) {
    if (!tabBarVisible) return
    try {
      win.toggleTabBar()
    } catch (err) {
      console.error('[window tabs] failed to hide tab bar for zen mode', err)
      return
    }
    if (!nativeTabBarVisible(win)) tabBarHiddenForZen.add(win.id)
    return
  }
  if (!tabBarHiddenForZen.has(win.id)) return
  tabBarHiddenForZen.delete(win.id)
  if (tabBarVisible) return
  try {
    win.toggleTabBar()
  } catch (err) {
    console.error('[window tabs] failed to restore tab bar after zen mode', err)
  }
}

function mergeAllVaultWindows(): void {
  const vaultWindows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isWorkspaceWindow(win)
  )
  if (vaultWindows.length < 2) return
  const focused = BrowserWindow.getFocusedWindow()
  const anchor = focused && vaultWindows.includes(focused) ? focused : vaultWindows[0]
  for (const win of vaultWindows) {
    if (win === anchor) continue
    try {
      anchor.addTabbedWindow(win)
    } catch (err) {
      console.error('[window tabs] failed to merge window into tab group', err)
    }
  }
  nudgeWindowLayout(anchor)
  anchor.focus()
  void reconcileAndPersistTabGroups()
}

function findWindowForVaultRoot(root: string): BrowserWindow | null {
  const target = path.resolve(root)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || !isWorkspaceWindow(win)) continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault && path.resolve(vault.root) === target) return win
  }
  return null
}

function queueMarkdownFileOpen(rawPath: string, reuseMainWindow: boolean): void {
  pendingFileOpens.push({ absPath: path.resolve(rawPath), reuseMainWindow })
  // Only flush eagerly once startup is finished. During startup `app.isReady()`
  // is already true (we're inside whenReady), so an eager flush here would
  // drain the queue before whenReady's own flush runs — that flush would then
  // report "nothing opened" and open a redundant default window alongside the
  // file's window, so `zen open` (and double-clicking a .md) opened two. (#178)
  if (app.isReady() && appStartupComplete) void flushPendingFileOpens()
}

function handleStartupMarkdownArgs(argv: string[], reuseMainWindow: boolean): void {
  // Candidates include directories (temporary folder session); the opener stats
  // each path and ignores anything that isn't a markdown file or a folder.
  for (const candidate of candidatePathsFromArgv(argv)) {
    queueMarkdownFileOpen(candidate, reuseMainWindow)
  }
}

// Returns true when at least one file produced (or focused) a window, so
// the caller can skip opening a redundant default-vault window.
async function flushPendingFileOpens(): Promise<boolean> {
  if (!app.isReady() || pendingFileOpens.length === 0) return false
  const items = pendingFileOpens.splice(0)
  let openedAny = false
  for (const item of items) {
    try {
      if (await openMarkdownFileFromOS(item.absPath, item.reuseMainWindow)) {
        openedAny = true
      }
    } catch (err) {
      console.error('Failed to open markdown file', item.absPath, err)
    }
  }
  return openedAny
}

async function openMarkdownFileFromOS(absPath: string, reuseMainWindow: boolean): Promise<boolean> {
  let stat
  try {
    stat = await fsp.stat(absPath)
  } catch {
    return false
  }
  // A dropped folder opens as a temporary, non-persisted session.
  if (stat.isDirectory()) {
    return await openTemporaryFolder(absPath, reuseMainWindow)
  }
  if (!stat.isFile() || !isMarkdownFilePath(absPath)) return false

  const cfg = await loadConfig()
  const knownRoots: string[] = []
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault) knownRoots.push(vault.root)
  }
  for (const entry of cfg.localVaults ?? []) knownRoots.push(entry.root)
  if (cfg.vaultRoot) knownRoots.push(cfg.vaultRoot)

  const target = resolveMarkdownOpenTarget(absPath, knownRoots)

  if (target.kind === 'vault') {
    const existing = findWindowForVaultRoot(target.vaultRoot)
    if (existing) {
      focusWindow(existing)
      queueNoteOpenForWindow(existing, target.relPath)
      return true
    }
    const win = await createWindow({
      initialVaultRoot: target.vaultRoot,
      persistInitialVault: true
    })
    if (!reuseMainWindow) focusWindow(win)
    queueNoteOpenForWindow(win, target.relPath)
    return true
  }

  openExternalFileWindow(target.absPath)
  return true
}

/**
 * In-app "Open File…" (#449) — show a native picker for a markdown file and
 * route the choice through the same vault-aware opener as the Finder "Open in
 * ZenNotes" entry and drag-and-drop: a file inside a known vault opens against
 * that vault, anything else opens in a standalone external-file window.
 * Resolves true when a file was opened.
 */
async function openMarkdownFileViaDialog(
  parentWindow?: BrowserWindow | null
): Promise<boolean> {
  const options: Electron.OpenDialogOptions = {
    title: 'Open Markdown File',
    buttonLabel: 'Open',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: MARKDOWN_FILE_EXTENSIONS.map((e) => e.replace(/^\./, '')) },
      { name: 'All Files', extensions: ['*'] }
    ]
  }
  const result =
    parentWindow && !parentWindow.isDestroyed()
      ? await dialog.showOpenDialog(parentWindow, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return false
  return await openMarkdownFileFromOS(path.resolve(result.filePaths[0]), false)
}

// A folder dropped on the app icon (or `zn open <dir>`) opens as a temporary
// session: its markdown is browsable and editable in place, but nothing is
// written into the folder except the user's own note edits, it is never
// remembered as a vault, and closing the window (or the next launch) returns to
// the saved vault. `ephemeralVault` + `persistInitialVault: false` do the work.
async function openTemporaryFolder(dir: string, reuseMainWindow: boolean): Promise<boolean> {
  const resolved = path.resolve(dir)
  const existing = findWindowForVaultRoot(resolved)
  if (existing) {
    focusWindow(existing)
    return true
  }
  if (!(await folderHasMarkdown(resolved))) return false
  const win = await createWindow({
    initialVaultRoot: resolved,
    persistInitialVault: false,
    ephemeralVault: true
  })
  if (!reuseMainWindow) focusWindow(win)
  return true
}

// Cheap bounded scan for at least one markdown file, so dropping a folder with
// no docs in it doesn't spin up an empty session. Skips dotfiles/node_modules.
async function folderHasMarkdown(dir: string): Promise<boolean> {
  const queue: string[] = [dir]
  let scanned = 0
  while (queue.length > 0 && scanned < 4000) {
    const current = queue.shift()
    if (!current) break
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      scanned++
      const name = entry.name
      if (name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (name === 'node_modules') continue
        queue.push(path.join(current, name))
      } else if (isMarkdownFilePath(name)) {
        return true
      }
    }
  }
  return false
}

// Pick a local vault to move an external file into: any open local
// vault, else the active local vault, else the last-used vault on disk.
async function resolveActiveLocalVault(): Promise<VaultInfo | null> {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    if (windowVaults.modeForWindow(win.id) !== 'local') continue
    const vault = windowVaults.vaultForWindow(win.id)
    if (vault) return vault
  }
  if (currentVault && currentWorkspaceMode === 'local') return currentVault
  const cfg = await loadConfig()
  if (cfg.vaultRoot) {
    try {
      await ensureVaultLayout(cfg.vaultRoot)
      return vaultInfo(path.resolve(cfg.vaultRoot))
    } catch {
      return null
    }
  }
  return null
}

// Open a standalone editor window for a markdown file that lives outside
// any vault. The window edits the file in place; the path is held here
// per-window so the renderer can read/write/move it without ever passing
// an arbitrary path back over IPC.
function openExternalFileWindow(absPath: string): void {
  const resolved = path.resolve(absPath)
  for (const [winId, file] of externalFileWindows) {
    if (path.resolve(file) !== resolved) continue
    const existing = BrowserWindow.fromId(winId)
    if (existing && !existing.isDestroyed()) {
      focusWindow(existing)
      return
    }
    externalFileWindows.delete(winId)
  }

  const mac = isMac()
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: STANDALONE_MIN_WINDOW_WIDTH,
    minHeight: STANDALONE_MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...(mac
      ? { backgroundColor: MAC_WINDOW_BACKGROUND_COLOR }
      : { backgroundColor: '#faf7f0', icon: windowIconPath() }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window: keep this editor renderer live when the
      // OS backgrounds/occludes it, so Vim keys and shortcuts don't freeze. (#350)
      backgroundThrottling: false
    }
  })

  externalFileWindows.set(win.id, resolved)
  win.on('closed', () => {
    externalFileWindows.delete(win.id)
    readyWindowIds.delete(win.id)
    pendingWindowNoteOpens.delete(win.id)
    windowVaults.clearWindow(win.id)
  })
  win.webContents.on('did-start-loading', () => {
    readyWindowIds.delete(win.id)
  })
  win.on('ready-to-show', () => win.show())

  installNavigationGuards(win)
  applyZoomFactor(win, currentZoomFactor)

  const params = `?externalFile=${encodeURIComponent(resolved)}`
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }
}

function decodeLocalAssetRequestPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LOCAL_ASSET_SCHEME}:`) return null
    if (parsed.hostname && parsed.hostname !== 'local') return null
    const encoded = parsed.searchParams.get('path')
    if (!encoded) return null
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

function decodeRemoteAssetRequest(url: string): { baseUrl: string; relPath: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LOCAL_ASSET_SCHEME}:`) return null
    if (parsed.hostname !== 'remote') return null
    const baseUrl = parsed.searchParams.get('baseUrl')?.trim()
    const relPath = parsed.searchParams.get('path')?.trim()
    if (!baseUrl || !relPath) return null
    return { baseUrl, relPath }
  } catch {
    return null
  }
}

function currentIpcWindow(): BrowserWindow | null {
  const win = ipcWindowContext.getStore()
  return win && !win.isDestroyed() ? win : null
}

function requireEventWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) {
    throw new Error('No window is associated with this IPC call.')
  }
  return win
}

function isPathInsideVault(absPath: string): boolean {
  const win = currentIpcWindow()
  if (win) return windowVaults.isPathInsideWindowVault(win.id, absPath)
  if (windowVaults.isPathInsideOpenLocalVault(absPath)) return true
  if (!currentVault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(currentVault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function isPathInsideWindowVault(win: BrowserWindow, absPath: string): boolean {
  if (windowVaults.isPathInsideWindowVault(win.id, absPath)) return true
  const vault = windowVaults.vaultForWindow(win.id)
  if (!vault) return false
  const resolved = path.resolve(absPath)
  const root = path.resolve(vault.root)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function installNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideWindowVault(win, abs)) {
        void shell.openPath(abs)
      }
      return { action: 'deny' }
    }
    if (url.startsWith(`${THEME_ASSET_SCHEME}://`)) return { action: 'deny' }
    openAllowedExternalUrl(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (url.startsWith(`${LOCAL_ASSET_SCHEME}://`)) {
      const abs = decodeLocalAssetRequestPath(url)
      if (abs && isPathInsideWindowVault(win, abs)) {
        void shell.openPath(abs)
      }
      return
    }
    if (url.startsWith(`${THEME_ASSET_SCHEME}://`)) return
    openAllowedExternalUrl(url)
  })
}

function mimeTypeForPath(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase()
  switch (ext) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.gif':
      return 'image/gif'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    case '.pdf':
      return 'application/pdf'
    case '.aac':
      return 'audio/aac'
    case '.flac':
      return 'audio/flac'
    case '.m4a':
      return 'audio/mp4'
    case '.mp3':
      return 'audio/mpeg'
    case '.ogg':
      return 'audio/ogg'
    case '.wav':
      return 'audio/wav'
    case '.m4v':
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.ogv':
      return 'video/ogg'
    case '.webm':
      return 'video/webm'
    case '.html':
    case '.htm':
      return 'text/html'
    case '.txt':
    case '.text':
      return 'text/plain'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.ttf':
      return 'font/ttf'
    case '.otf':
      return 'font/otf'
    case '.eot':
      return 'application/vnd.ms-fontobject'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Serve a local file as an HTTP-style Response that honors the `Range`
 * request header, so Chromium's <video>/<audio> elements can seek. Without a
 * 206 + `Content-Range`/`Accept-Ranges` response the media element treats the
 * resource as non-seekable — playback works but the scrubber and arrow keys
 * are inert. Streams the requested byte slice via createReadStream rather than
 * buffering the whole file (a video can be hundreds of MB).
 */
async function serveLocalFileResponse(abs: string, request: Request): Promise<Response> {
  const stat = await fsp.stat(abs)
  const total = stat.size
  const contentType = mimeTypeForPath(abs)
  const baseHeaders: Record<string, string> = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes'
  }

  const rangeHeader = request.headers.get('Range')
  // Only single-range requests (what media elements send). Anything else —
  // no header, or a multipart `bytes=0-1,3-4` — falls through to the full body.
  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (match && (match[1] !== '' || match[2] !== '')) {
    let start: number
    let end: number
    if (match[1] === '') {
      // Suffix range: `bytes=-N` → the final N bytes.
      const suffix = Number.parseInt(match[2], 10)
      start = Math.max(0, total - suffix)
      end = total - 1
    } else {
      start = Number.parseInt(match[1], 10)
      end = match[2] === '' ? total - 1 : Number.parseInt(match[2], 10)
    }
    end = Math.min(end, total - 1)
    if (start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' }
      })
    }
    const stream = createReadStream(abs, { start, end })
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(end - start + 1)
      }
    })
  }

  const stream = createReadStream(abs)
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    headers: { ...baseHeaders, 'content-length': String(total) }
  })
}

function isTrustedRendererUrl(url: string): boolean {
  if (!url) return false
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    return url.startsWith(devServerUrl)
  }
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'file:' &&
      parsed.pathname.endsWith('/out/renderer/index.html')
    )
  } catch {
    return false
  }
}

function isTrustedIpcSender(sender: WebContents): boolean {
  const ownerWindow = BrowserWindow.fromWebContents(sender)
  if (!ownerWindow || ownerWindow.isDestroyed()) return false
  return isTrustedRendererUrl(sender.getURL())
}

function assertTrustedIpcEvent(event: IpcMainEvent | IpcMainInvokeEvent): void {
  if (!isTrustedIpcSender(event.sender)) {
    throw new Error('Blocked IPC call from an untrusted renderer.')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeZoomFactor(value: number): number {
  return Math.round(clamp(value, MIN_ZOOM_FACTOR, MAX_ZOOM_FACTOR) * 100) / 100
}

async function persistZoomFactor(factor: number): Promise<number> {
  const normalized = normalizeZoomFactor(factor)
  currentZoomFactor = normalized
  await updateConfig((cfg) => ({ ...cfg, zoomFactor: normalized }))
  return normalized
}

function applyZoomFactor(win: BrowserWindow, factor: number): number {
  const normalized = normalizeZoomFactor(factor)
  win.webContents.setZoomFactor(normalized)
  currentZoomFactor = normalized
  return normalized
}

async function setWindowZoom(
  win: BrowserWindow | null | undefined,
  factor: number
): Promise<number> {
  const target = win && !win.isDestroyed() ? win : mainWindow
  const normalized = normalizeZoomFactor(factor)
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    for (const openWin of windows) {
      if (!openWin.isDestroyed()) applyZoomFactor(openWin, normalized)
    }
  } else if (target && !target.isDestroyed()) {
    applyZoomFactor(target, normalized)
  }
  return await persistZoomFactor(normalized)
}

async function adjustWindowZoom(
  win: BrowserWindow | null | undefined,
  delta: number
): Promise<number> {
  const target = win && !win.isDestroyed() ? win : mainWindow
  const base = target && !target.isDestroyed() ? target.webContents.getZoomFactor() : currentZoomFactor
  return await setWindowZoom(target, base + delta)
}


function sanitizeWindowState(state: PersistedWindowState | null): PersistedWindowState | null {
  if (!state) return null

  const width = Math.max(MIN_WINDOW_WIDTH, Math.round(state.width))
  const height = Math.max(MIN_WINDOW_HEIGHT, Math.round(state.height))
  const display = screen.getDisplayMatching({
    x: Math.round(state.x),
    y: Math.round(state.y),
    width,
    height
  })
  const workArea = display.workArea
  const clampedWidth = Math.min(width, workArea.width)
  const clampedHeight = Math.min(height, workArea.height)
  const x = clamp(
    Math.round(state.x),
    workArea.x,
    Math.max(workArea.x, workArea.x + workArea.width - clampedWidth)
  )
  const y = clamp(
    Math.round(state.y),
    workArea.y,
    Math.max(workArea.y, workArea.y + workArea.height - clampedHeight)
  )

  return {
    x,
    y,
    width: clampedWidth,
    height: clampedHeight,
    isMaximized: state.isMaximized
  }
}

function captureWindowState(win: BrowserWindow): PersistedWindowState {
  const isMaximized = win.isMaximized()
  const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, isMaximized }
}

async function persistWindowState(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  const state = captureWindowState(win)
  const uuid = windowUuids.get(win.id)
  await updateConfig((cfg) => {
    const updated = { ...cfg, windowState: state }
    if (uuid) {
      const vault = windowVaults.vaultForWindow(win.id)
      if (vault) {
        const sessions = cfg.openWindows ?? []
        const idx = sessions.findIndex((s) => s.windowId === uuid)
        // tabGroupId is owned by reconcileAndPersistTabGroups, not here —
        // preserve whatever it already was rather than guessing at it.
        // Capture the window's current Space here (not in captureWindowState,
        // which stays sync/geometry-only) so it rides along on every persist.
        // Fall back to whatever we last saved if the live read comes back
        // empty (e.g. the window is momentarily off all Spaces mid-move).
        const spaceId = nativeWindowSpaceId(win) ?? (idx >= 0 ? sessions[idx].spaceId ?? null : null)
        if (DEBUG_WINDOW_SPACES) {
          console.error('[window spaces] persist', uuid, 'spaceId=', spaceId, 'existingIdx=', idx)
        }
        const entry: PersistedWindowSession = {
          windowId: uuid,
          root: vault.root,
          windowState: state,
          tabGroupId: idx >= 0 ? sessions[idx].tabGroupId ?? null : null,
          spaceId,
          // Owned by the tmux capture poll — preserve it across this geometry persist.
          tmuxTarget: idx >= 0 ? sessions[idx].tmuxTarget ?? null : null
        }
        updated.openWindows = idx >= 0
          ? sessions.map((s, i) => (i === idx ? entry : s))
          : [...sessions, entry]
      }
    }
    return updated
  })
}

interface CreateWindowOptions {
  initialVaultRoot?: string | null
  inheritWorkspaceFrom?: BrowserWindow | null
  persistInitialVault?: boolean
  /** Stable UUID to reuse for this window (session restore path). When absent,
   *  a fresh UUID is generated so every new window gets its own identity. */
  windowId?: string
  /** Initial window geometry. When provided, takes precedence over the
   *  global cfg.windowState (which tracks only the last-focused window). */
  windowState?: PersistedWindowState | null
  /** Mission Control Space to send this window back to once it's on screen
   *  (session restore path, macOS only). The move happens after the window's
   *  window number exists — see the ready-to-show handler. */
  restoreSpaceId?: string | null
  /** Open initialVaultRoot as a temporary folder session (read a folder without
   *  turning it into a vault). Implies no persistence and no writes into it. */
  ephemeralVault?: boolean
}

async function createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
  const createWindowStartedAt = performance.now()
  const mac = isMac()
  const winUuid = options.windowId ?? randomUUID()
  const cfg = await loadConfig()
  const restoredState = sanitizeWindowState(
    options.windowState !== undefined ? options.windowState : cfg.windowState
  )
  currentZoomFactor = normalizeZoomFactor(cfg.zoomFactor)
  const win = new BrowserWindow({
    width: restoredState?.width ?? DEFAULT_WINDOW_WIDTH,
    height: restoredState?.height ?? DEFAULT_WINDOW_HEIGHT,
    ...(restoredState ? { x: restoredState.x, y: restoredState.y } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    ...(mac
      ? {
          // The renderer now runs fully opaque, so keeping the
          // BrowserWindow transparent forces macOS into an unnecessary
          // compositing path that makes typing feel mushy on large
          // displays. Use a solid background instead.
          backgroundColor: MAC_WINDOW_BACKGROUND_COLOR,
          tabbingIdentifier: MAIN_WINDOW_TABBING_IDENTIFIER
        }
      : {
          backgroundColor: '#faf7f0',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Keep the renderer isolated and node-free, but the current preload
      // still relies on Node/Electron APIs that are not available inside a
      // fully sandboxed preload context.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Don't let Chromium throttle/freeze this renderer when it decides the
      // window is "background" — that can happen while the window is still
      // visually open (occlusion misdetection, display idle, some Wayland
      // compositors). When throttled, the renderer's JS input pipeline stalls,
      // so window-level shortcuts and CodeMirror's Vim keymap stop receiving
      // keys and keystrokes fall through as literal text, until a focus event
      // wakes it. The editor is the primary surface here, so keep it live. (#350)
      backgroundThrottling: false
    }
  })

  // The `tabbingIdentifier` constructor option above is silently ineffective
  // on hiddenInset windows — Electron sets tabbingMode to Disallowed for any
  // non-default titleBarStyle regardless of it (see TabGroupsNative.enableTabbing
  // for why). addTabbedWindow() bypasses that, so merging already worked, but
  // toggleTabBar() doesn't, so a lone window could never show its own bar.
  if (mac && tabGroupsNative) {
    try {
      tabGroupsNative.enableTabbing(win.getNativeWindowHandle(), MAIN_WINDOW_TABBING_IDENTIFIER)
    } catch (err) {
      console.error('[window tabs] failed to enable native tabbing', err)
    }
  }

  workspaceWindowIds.add(win.id)
  windowUuids.set(win.id, winUuid)

  // Belt-and-braces: keep the window bound to a single Space. (Measured as
  // already the case — collectionBehavior reads 132, FullScreenPrimary|Managed,
  // with no CanJoinAllSpaces/MoveToActiveSpace — so this is a guard, not a fix.)
  if (mac) nativeBindWindowToSpace(win)

  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = win
    mainWindowReadyForAppEvents = false
  }

  let persistWindowStateTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleWindowStatePersist = () => {
    if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer)
    persistWindowStateTimer = setTimeout(() => {
      persistWindowStateTimer = null
      void persistWindowState(win)
    }, WINDOW_STATE_PERSIST_DELAY_MS)
  }
  const flushWindowStatePersist = () => {
    if (persistWindowStateTimer) {
      clearTimeout(persistWindowStateTimer)
      persistWindowStateTimer = null
    }
    void persistWindowState(win)
  }

  win.on('ready-to-show', () => {
    recordMainPerf('main.window.ready-to-show', performance.now() - createWindowStartedAt, {
      restored: !!restoredState,
      uptimeMs: Math.round(process.uptime() * 1000)
    })
    if (restoredState?.isMaximized) win.maximize()
    // A window being sent to another Space must not become key on the way:
    // macOS follows the key window, which is what yanked the user onto a
    // different Space during restore. Show it inactive and let the restore
    // sequence decide what to focus at the end.
    if (options.restoreSpaceId) win.showInactive()
    else win.show()
    // Send the window back to its previous Space now that it's realised (a
    // hidden/never-shown window has no window number for CGS to target). This
    // relocates it without switching the visible Space, so windows scatter
    // back to their Spaces instead of collapsing onto the launch Space.
    if (options.restoreSpaceId) {
      nativeMoveWindowToSpace(win, options.restoreSpaceId)
      // We just placed it, so this is its Space — seed the tracker directly
      // rather than waiting for a focus event that may never come for a window
      // restored onto a Space the user isn't looking at.
      windowSpaceByWinId.set(win.id, options.restoreSpaceId)
    }
  })
  win.webContents.on('did-start-loading', () => {
    readyWindowIds.delete(win.id)
    if (mainWindow === win) mainWindowReadyForAppEvents = false
  })
  win.webContents.once('did-finish-load', () => {
    recordMainPerf('main.window.did-finish-load', performance.now() - createWindowStartedAt, {
      restored: !!restoredState,
      uptimeMs: Math.round(process.uptime() * 1000)
    })
  })

  // Hardcoded: while the embedded terminal holds focus, feed tmux's prev/next
  // window keys (Ctrl+B p / Ctrl+B n) straight into the PTY. The intent is
  // Cmd+Shift+[ / Cmd+Shift+], but Leo's system remapper (Karabiner/BTT) rewrites
  // those into Ctrl+Shift+Tab / Ctrl+Tab before any app sees them, so we match the
  // remapped form. before-input-event is the lowest interception point available
  // to us (before the renderer, xterm, and any menu accelerator); a system event
  // tap that runs above the app cannot be preempted from here.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.code !== 'Tab' || !input.control || input.meta || input.alt) return
    if (!terminalFocusedWcIds.has(win.webContents.id)) return
    const session = terminalSessionForWebContents(win.webContents.id)
    if (!session) return
    event.preventDefault()
    // Ctrl+Shift+Tab (from Cmd+Shift+[) → previous window; Ctrl+Tab (from
    // Cmd+Shift+]) → next window. tmux prefix is Ctrl+B (0x02) then p / n.
    session.pty.write(input.shift ? '\x02p' : '\x02n')
  })

  // Focus is the one moment we can be sure this window is on the *visible*
  // Space, so it's when we learn its Space — and we persist right away rather
  // than relying on the quit-time flush, which was capturing correctly in
  // memory but never making it to disk.
  if (mac) {
    win.on('focus', () => {
      rememberWindowSpace(win)
      scheduleWindowStatePersist()
    })
  }

  // Which workspace window you were last in. Quick capture inherits its vault
  // from this when it has no explicit choice: summoned by the global hotkey
  // from another app, no ZenNotes window is focused, and falling back to
  // `mainWindow` (the OLDEST surviving window, not the most recent one) sent
  // captures into whatever vault that window happened to hold. Every platform,
  // unlike the macOS-only handler above.
  win.on('focus', () => {
    lastFocusedWorkspaceWindowId = win.id
  })

  win.on('move', scheduleWindowStatePersist)
  win.on('resize', scheduleWindowStatePersist)
  win.on('maximize', scheduleWindowStatePersist)
  win.on('unmaximize', scheduleWindowStatePersist)
  win.on('move', scheduleTabGroupReconcile)
  win.on('resize', scheduleTabGroupReconcile)
  // Unsaved-highlights guard for closing this window directly (red button,
  // Cmd+W-for-window). Skipped during app quit (before-quit already asked) and
  // on the confirmed second pass.
  win.on('close', (event) => {
    if (appIsQuitting || windowsAllowedToClose.has(win.id)) return
    event.preventDefault()
    void confirmWindowUnsavedPdfs(win).then((proceed) => {
      if (!proceed) return // cancelled — window stays open
      windowsAllowedToClose.add(win.id)
      if (!win.isDestroyed()) win.close()
    })
  })
  win.on('close', flushWindowStatePersist)
  const winWebContentsId = win.webContents.id
  win.on('closed', () => {
    if (persistWindowStateTimer) clearTimeout(persistWindowStateTimer)
    workspaceWindowIds.delete(win.id)
    windowVaults.clearWindow(win.id)
    readyWindowIds.delete(win.id)
    pendingWindowNoteOpens.delete(win.id)
    killPtySessionsForWebContents(winWebContentsId)
    zenModeWindows.delete(win.id)
    tabBarHiddenForZen.delete(win.id)
    void reconcileAndPersistTabGroups()
    const closedUuid = windowUuids.get(win.id)
    windowUuids.delete(win.id)
    if (closedUuid) {
      void updateConfig((cfg) => ({
        ...cfg,
        openWindows: (cfg.openWindows ?? []).filter((s) => s.windowId !== closedUuid)
      }))
    }
    if (mainWindow === win) {
      // Promote only a real workspace window — never quick capture,
      // floating notes, or other utility windows. With none left,
      // mainWindow stays null and the next open recreates one.
      mainWindow =
        BrowserWindow.getAllWindows().find(
          (candidate) =>
            candidate.id !== win.id && !candidate.isDestroyed() && isWorkspaceWindow(candidate)
        ) ?? null
      mainWindowReadyForAppEvents = mainWindow != null
    }
  })

  installNavigationGuards(win)
  applyZoomFactor(win, currentZoomFactor)

  if (options.inheritWorkspaceFrom && !options.inheritWorkspaceFrom.isDestroyed()) {
    inheritWindowWorkspaceSession(options.inheritWorkspaceFrom, win)
  } else if (options.initialVaultRoot) {
    try {
      await setVaultForWindow(win, options.initialVaultRoot, {
        persist: options.persistInitialVault !== false,
        ephemeral: options.ephemeralVault === true
      })
    } catch (err) {
      if (!win.isDestroyed()) win.destroy()
      throw err
    }
  }

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

async function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return
  if (!app.isReady()) return
  if (!creatingMainWindow) {
    creatingMainWindow = createWindow().finally(() => {
      creatingMainWindow = null
    })
  }
  await creatingMainWindow
}

async function openVaultInNewWindow(
  parentWindow?: BrowserWindow | null,
  root?: string | null
): Promise<VaultInfo | null> {
  // A known vault root opens directly in a new window; otherwise fall back to
  // the folder picker (the "Browse for a folder…" path). (#244)
  let target = typeof root === 'string' && root.trim() ? root.trim() : null
  if (!target) {
    const options: Electron.OpenDialogOptions = {
      title: 'Open Vault in New Window',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Vault'
    }
    const result =
      parentWindow && !parentWindow.isDestroyed()
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    target = result.filePaths[0]
  }

  const win = await createWindow({
    initialVaultRoot: target,
    persistInitialVault: true
  })
  if (parentWindow && !parentWindow.isDestroyed()) {
    win.moveTop()
  }
  return windowVaults.vaultForWindow(win.id)
}

async function currentRemoteWorkspaceInfo(): Promise<RemoteWorkspaceInfo | null> {
  const win = currentIpcWindow()
  const windowMode = win ? windowVaults.modeForWindow(win.id) : null
  if (windowMode === 'local') return null
  if (!remoteWorkspaceConfig) {
    const cfg = await loadConfig()
    if (cfg.workspaceMode !== 'remote' || !cfg.remoteWorkspace?.baseUrl) return null
    remoteWorkspaceConfig = cfg.remoteWorkspace
    currentRemoteWorkspaceProfileId = cfg.remoteWorkspaceProfileId
  }
  if (win && windowMode && windowMode !== 'remote') return null
  if (!remoteWorkspaceConfig) return null
  return {
    mode: 'remote',
    baseUrl: remoteWorkspaceConfig.baseUrl,
    authConfigured: Boolean(remoteWorkspaceClient?.authToken),
    capabilities: remoteServerCapabilities,
    profileId: currentRemoteWorkspaceProfileId
  }
}

function normalizeRemoteBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function deriveRemoteWorkspaceProfileName(
  input: {
    id?: string
    baseUrl: string
    vaultPath?: string | null
  },
  existingProfiles: PersistedRemoteWorkspaceProfile[]
): string {
  const normalizedBaseUrl = normalizeRemoteBaseUrl(input.baseUrl)
  let host = 'ZenNotes Server'
  try {
    const normalizedUrl = /^https?:\/\//i.test(normalizedBaseUrl)
      ? normalizedBaseUrl
      : `http://${normalizedBaseUrl}`
    host = new URL(normalizedUrl).host || host
  } catch {
    if (normalizedBaseUrl) host = normalizedBaseUrl
  }

  const trimmedVaultPath = input.vaultPath?.trim() || null
  let baseName = host
  if (trimmedVaultPath) {
    const normalizedVaultPath = trimmedVaultPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const vaultName = path.posix.basename(normalizedVaultPath)
    if (vaultName && vaultName !== '.' && vaultName !== '/') {
      baseName = `${vaultName} (${host})`
    }
  }

  const otherProfiles = existingProfiles.filter((entry) => entry.id !== input.id)
  if (!otherProfiles.some((entry) => entry.name === baseName)) return baseName

  let suffix = 2
  while (otherProfiles.some((entry) => entry.name === `${baseName} ${suffix}`)) suffix += 1
  return `${baseName} ${suffix}`
}

function profileMatchesConnection(
  profile: PersistedRemoteWorkspaceProfile,
  connection: PersistedRemoteWorkspaceConfig,
  vaultPath: string | null
): boolean {
  return (
    normalizeRemoteBaseUrl(profile.baseUrl) === normalizeRemoteBaseUrl(connection.baseUrl) &&
    (profile.vaultPath ?? null) === (vaultPath ?? null)
  )
}

function findRemoteProfileById(
  profiles: PersistedRemoteWorkspaceProfile[],
  id: string | null
): PersistedRemoteWorkspaceProfile | null {
  if (!id) return null
  return profiles.find((entry) => entry.id === id) ?? null
}

async function migrateLegacyRemoteWorkspaceSecrets(): Promise<void> {
  const cfg = await loadConfig()
  let changed = false
  let nextProfiles = [...cfg.remoteWorkspaceProfiles]
  let nextRemoteWorkspace = cfg.remoteWorkspace
  let nextProfileId = cfg.remoteWorkspaceProfileId

  for (const profile of nextProfiles) {
    if (profile.authToken && profile.authToken.trim()) {
      await setRemoteWorkspaceSecret(profile.id, profile.authToken)
      delete profile.authToken
      changed = true
    }
  }

  if (nextRemoteWorkspace?.authToken && nextRemoteWorkspace.authToken.trim()) {
    let targetProfile =
      findRemoteProfileById(nextProfiles, nextProfileId) ??
      nextProfiles.find(
        (entry) => normalizeRemoteBaseUrl(entry.baseUrl) === normalizeRemoteBaseUrl(nextRemoteWorkspace!.baseUrl)
      ) ??
      null

    if (!targetProfile) {
      targetProfile = {
        id: randomUUID(),
        name: deriveRemoteWorkspaceProfileName(
          {
            baseUrl: nextRemoteWorkspace.baseUrl,
            vaultPath: currentVault?.root ?? null
          },
          nextProfiles
        ),
        baseUrl: normalizeRemoteBaseUrl(nextRemoteWorkspace.baseUrl),
        vaultPath: currentVault?.root ?? null,
        lastConnectedAt: null
      }
      nextProfiles = [...nextProfiles, targetProfile].sort((a, b) => a.name.localeCompare(b.name))
      nextProfileId = targetProfile.id
    }

    await setRemoteWorkspaceSecret(targetProfile.id, nextRemoteWorkspace.authToken)
    nextRemoteWorkspace = { baseUrl: nextRemoteWorkspace.baseUrl }
    changed = true
  }

  if (!changed) return

  await updateConfig((current) => ({
    ...current,
    remoteWorkspace: nextRemoteWorkspace
      ? {
          baseUrl: normalizeRemoteBaseUrl(nextRemoteWorkspace.baseUrl)
        }
      : null,
    remoteWorkspaceProfiles: nextProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: normalizeRemoteBaseUrl(profile.baseUrl),
      vaultPath: profile.vaultPath ?? null,
      lastConnectedAt: profile.lastConnectedAt ?? null
    })),
    remoteWorkspaceProfileId: nextProfileId
  }))
}

function stopRemoteWatch(): void {
  if (stopRemoteVaultWatch) {
    stopRemoteVaultWatch()
    stopRemoteVaultWatch = null
  }
}

function startRemoteWatch(client: RemoteServerClient, capabilities: ServerCapabilities): void {
  stopRemoteWatch()
  if (!capabilities.supportsWatch) return
  stopRemoteVaultWatch = client.watchVaultChanges((ev) => {
    windowVaults.sendRemoteVaultChange(ev)
  })
}

async function setVaultForWindow(
  win: BrowserWindow,
  root: string,
  options: { persist?: boolean; ephemeral?: boolean } = {}
): Promise<VaultInfo> {
  // A temporary folder session (drag a folder onto the app to read it) must not
  // write anything into the folder: skip the vault layout, and register the
  // root so the settings/tab/cache writers stay hands-off. persist:false keeps
  // it out of the saved config and the remembered-vaults list.
  if (options.ephemeral) {
    registerEphemeralRoot(root)
  } else {
    await ensureVaultLayout(root)
  }
  const vault = { ...vaultInfo(path.resolve(root)), temporary: options.ephemeral === true }
  windowVaults.setLocalVault(win.id, vault)
  currentVault = vault
  currentWorkspaceMode = 'local'
  // Baseline native title so a tab reads as something useful even before
  // the renderer has mounted (or if it never pushes one). TitleBar refines
  // this to the exact vault+path/section text it renders once it's up,
  // via WINDOW_SET_TITLE.
  if (!win.isDestroyed()) win.setTitle(vault.name)
  if (!windowVaults.hasRemoteWindows()) {
    remoteWorkspaceClient = null
    remoteWorkspaceConfig = null
    currentRemoteWorkspaceProfileId = null
    remoteServerCapabilities = null
    stopRemoteWatch()
  }
  const uuid = windowUuids.get(win.id)
  const windowStateOnOpen = win.isDestroyed() ? null : captureWindowState(win)
  await updateConfig((cfg) => {
    // Always track in openWindows regardless of persist flag — openWindows
    // records what is currently open, not which vault to remember.
    const sessions = cfg.openWindows ?? []
    let newSessions = sessions
    if (uuid && windowStateOnOpen) {
      const idx = sessions.findIndex((s) => s.windowId === uuid)
      // tabGroupId is owned by reconcileAndPersistTabGroups, not here —
      // preserve whatever it already was rather than guessing at it.
      const entry: PersistedWindowSession = {
        windowId: uuid,
        root: vault.root,
        windowState: windowStateOnOpen,
        tabGroupId: idx >= 0 ? sessions[idx].tabGroupId ?? null : null,
        // Owned by the geometry/reconcile persist paths; preserve the last
        // captured value rather than re-reading it on a vault switch.
        spaceId: (idx >= 0 ? sessions[idx].spaceId : null) ?? nativeWindowSpaceId(win),
        // Owned by the tmux capture poll — preserve it across this vault switch.
        tmuxTarget: idx >= 0 ? sessions[idx].tmuxTarget ?? null : null
      }
      newSessions = idx >= 0
        ? sessions.map((s, i) => (i === idx ? entry : s))
        : [...sessions, entry]
    }
    const base = { ...cfg, openWindows: newSessions }
    if (options.persist !== false) {
      return {
        ...base,
        workspaceMode: 'local',
        vaultRoot: vault.root,
        localVaults: rememberLocalVault(cfg.localVaults, vault),
        remoteWorkspaceProfileId: null
      }
    }
    return base
  })
  return vault
}

async function setVault(root: string): Promise<VaultInfo> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed()) return await setVaultForWindow(win, root)

  await ensureVaultLayout(root)
  const vault = vaultInfo(path.resolve(root))
  currentVault = vault
  currentWorkspaceMode = 'local'
  remoteWorkspaceClient = null
  remoteWorkspaceConfig = null
  currentRemoteWorkspaceProfileId = null
  remoteServerCapabilities = null
  stopRemoteWatch()
  await updateConfig((cfg) => ({
    ...cfg,
    workspaceMode: 'local',
    vaultRoot: vault.root,
    localVaults: rememberLocalVault(cfg.localVaults, vault),
    remoteWorkspaceProfileId: null
  }))
  return vault
}

async function closeLocalVaultForWindow(): Promise<VaultInfo | null> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed() && windowVaults.isRemoteWindow(win.id)) return null
  if ((!win || win.isDestroyed()) && currentWorkspaceMode === 'remote') return null
  const vault = win && !win.isDestroyed() ? windowVaults.vaultForWindow(win.id) : currentVault
  if (!vault) return null

  const cfg = await loadConfig()
  const candidates = new Map<string, { root: string; name: string }>()
  const remainingLocalVaults = forgetLocalVault(cfg.localVaults, vault.root)
  for (const entry of remainingLocalVaults) {
    candidates.set(path.resolve(entry.root), entry)
  }
  for (const entry of windowVaults.localVaultsExcept(vault.root)) {
    const root = path.resolve(entry.root)
    if (!candidates.has(root)) candidates.set(root, entry)
  }
  const nextLocalVault = candidates.values().next().value ?? null
  const nextVault =
    nextLocalVault && win && !win.isDestroyed()
      ? await setVaultForWindow(win, nextLocalVault.root, { persist: false })
      : nextLocalVault
        ? await setVault(nextLocalVault.root)
        : null

  if (!nextVault) {
    if (win && !win.isDestroyed()) {
      windowVaults.clearWindow(win.id)
    }
    if (currentVault && path.resolve(currentVault.root) === path.resolve(vault.root)) {
      currentVault = null
    }
    currentWorkspaceMode = 'local'
  }

  await updateConfig((cfg) => ({
    ...cfg,
    workspaceMode: 'local',
    vaultRoot: nextVault ? nextVault.root : null,
    localVaults: forgetLocalVault(cfg.localVaults, vault.root),
    remoteWorkspaceProfileId: null
  }))

  return nextVault
}

async function listLocalVaults(): Promise<LocalVaultEntry[]> {
  const cfg = await loadConfig()
  let entries = cfg.localVaults
  if (cfg.vaultRoot && !entries.some((entry) => path.resolve(entry.root) === path.resolve(cfg.vaultRoot!))) {
    try {
      entries = rememberLocalVault(entries, vaultInfo(cfg.vaultRoot), 0)
    } catch {
      entries = [
        {
          root: path.resolve(cfg.vaultRoot),
          name: path.basename(cfg.vaultRoot),
          lastOpenedAt: 0
        },
        ...entries
      ]
    }
  }
  return entries
}

async function setRemoteWorkspace(
  baseUrl: string,
  authToken?: string | null,
  options: { persist?: boolean; profileId?: string | null; vaultPath?: string | null } = {}
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const client = new RemoteServerClient({ baseUrl, authToken })
  const capabilities = await client.getCapabilities()
  let vault = await client.getCurrentVault()
  const preferredVaultPath = options.vaultPath?.trim() || null
  if (
    capabilities.supportsVaultSelection &&
    preferredVaultPath &&
    vault?.root !== preferredVaultPath
  ) {
    vault = await client.selectVaultPath(preferredVaultPath)
  }

  const win = currentIpcWindow() ?? mainWindow
  currentWorkspaceMode = 'remote'
  currentVault = vault
  if (win && !win.isDestroyed()) {
    windowVaults.setRemoteVault(win.id, vault)
  }
  remoteWorkspaceClient = client
  remoteServerCapabilities = capabilities
  currentRemoteWorkspaceProfileId = options.profileId ?? null
  remoteWorkspaceConfig = {
    baseUrl: client.baseUrl
  }
  startRemoteWatch(client, capabilities)

  if (options.persist !== false) {
    await updateConfig((cfg) => ({
      ...cfg,
      workspaceMode: 'remote',
      remoteWorkspace: remoteWorkspaceConfig,
      remoteWorkspaceProfileId: currentRemoteWorkspaceProfileId
    }))
  }

  return { vault, capabilities }
}

async function disconnectRemoteWorkspace(): Promise<VaultInfo | null> {
  const cfg = await loadConfig()
  const win = currentIpcWindow() ?? mainWindow
  currentWorkspaceMode = 'local'

  if (cfg.vaultRoot) {
    if (win && !win.isDestroyed()) {
      return await setVaultForWindow(win, cfg.vaultRoot)
    }
    return await setVault(cfg.vaultRoot)
  }

  if (win && !win.isDestroyed()) {
    windowVaults.clearWindow(win.id)
  }
  if (!windowVaults.hasRemoteWindows()) {
    remoteWorkspaceClient = null
    remoteWorkspaceConfig = null
    currentRemoteWorkspaceProfileId = null
    remoteServerCapabilities = null
  }
  currentVault = null
  await updateConfig((current) => ({
    ...current,
    workspaceMode: 'local',
    remoteWorkspaceProfileId: null
  }))
  return null
}

function inheritWindowWorkspaceSession(source: BrowserWindow, target: BrowserWindow): void {
  const vault = windowVaults.vaultForWindow(source.id)
  const mode = windowVaults.modeForWindow(source.id)
  if (!vault || !mode) return
  if (mode === 'remote') {
    windowVaults.setRemoteVault(target.id, vault)
  } else {
    windowVaults.setLocalVault(target.id, vault)
  }
}

function noteTitleFromRelPath(relPath: string): string {
  const base = path.posix.basename(relPath)
  return base.replace(/\.md$/i, '') || 'Note'
}

function sanitizePdfFilename(name: string): string {
  const sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || 'Note'
}

function ensurePdfExtension(targetPath: string): string {
  return targetPath.toLowerCase().endsWith('.pdf') ? targetPath : `${targetPath}.pdf`
}

async function waitForExportWindowState(
  win: BrowserWindow,
  timeoutMs = 15000
): Promise<void> {
  const startedAt = Date.now()
  while (!win.isDestroyed()) {
    const state = await win.webContents.executeJavaScript(
      'document.body?.dataset.exportState ?? ""',
      true
    )
    if (state === 'ready') return
    if (state === 'error') {
      const message = await win.webContents.executeJavaScript(
        'document.body?.dataset.exportError ?? "The export renderer reported an error."',
        true
      )
      throw new Error(typeof message === 'string' ? message : 'The export renderer reported an error.')
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out while preparing the note preview for PDF export.')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('The export window closed before PDF export completed.')
}

async function exportNotePdf(
  relPath: string,
  parentWindow: BrowserWindow | null | undefined
): Promise<string | null> {
  const current =
    parentWindow && !parentWindow.isDestroyed()
      ? windowVaults.vaultForWindow(parentWindow.id)
      : currentVault ?? (isRemoteWorkspaceActive() ? await requireRemoteWorkspaceClient().getCurrentVault() : null)
  if (!current) {
    throw new Error('No active vault is available for PDF export.')
  }

  const suggestedName = `${sanitizePdfFilename(noteTitleFromRelPath(relPath))}.pdf`
  const saveDialogOptions = {
    title: 'Export Note as PDF',
    defaultPath: path.join(app.getPath('documents'), suggestedName),
    buttonLabel: 'Export PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions)
  if (result.canceled || !result.filePath) return null

  const targetPath = ensurePdfExtension(result.filePath)
  const mac = isMac()
  const exportWindow = new BrowserWindow({
    width: 1024,
    height: 1400,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(mac
      ? {
          backgroundColor: '#ffffff'
        }
      : {
          backgroundColor: '#ffffff',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    if (parentWindow && !parentWindow.isDestroyed()) {
      inheritWindowWorkspaceSession(parentWindow, exportWindow)
    }
    installNavigationGuards(exportWindow)
    applyZoomFactor(exportWindow, currentZoomFactor)
    const params = `?exportNote=${encodeURIComponent(relPath)}`
    const devServerUrl = process.env['ELECTRON_RENDERER_URL']
    if (devServerUrl) {
      await exportWindow.loadURL(`${devServerUrl}${params}`)
    } else {
      await exportWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
        search: params.slice(1)
      })
    }

    await waitForExportWindowState(exportWindow)
    await exportWindow.webContents.executeJavaScript(
      'document.fonts ? document.fonts.ready.then(() => true) : Promise.resolve(true)',
      true
    )
    const pdf = await exportWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    await fsp.writeFile(targetPath, pdf)
    return targetPath
  } finally {
    windowVaults.clearWindow(exportWindow.id)
    if (!exportWindow.isDestroyed()) {
      exportWindow.destroy()
    }
  }
}

async function listRemoteWorkspaceProfiles(): Promise<RemoteWorkspaceProfile[]> {
  const cfg = await loadConfig()
  return await Promise.all(
    cfg.remoteWorkspaceProfiles.map(async (profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      vaultPath: profile.vaultPath ?? null,
      lastConnectedAt: profile.lastConnectedAt ?? null,
      hasCredential: Boolean(await getRemoteWorkspaceSecret(profile.id))
    }))
  )
}

async function saveRemoteWorkspaceProfile(
  input: RemoteWorkspaceProfileInput & { lastConnectedAt?: number | null }
): Promise<RemoteWorkspaceProfile> {
  const normalizedId = input.id?.trim() || randomUUID()
  await updateConfig((cfg) => {
    const normalizedBaseUrl = normalizeRemoteBaseUrl(input.baseUrl)
    const trimmedName = input.name?.trim() || ''
    const normalizedVaultPath = input.vaultPath?.trim() || null
    if (!normalizedId || !normalizedBaseUrl) {
      throw new Error('Remote workspace profiles need a server URL.')
    }
    const nextNormalized: PersistedRemoteWorkspaceProfile = {
      id: normalizedId,
      name:
        trimmedName ||
        deriveRemoteWorkspaceProfileName(
          {
            id: normalizedId,
            baseUrl: normalizedBaseUrl,
            vaultPath: normalizedVaultPath
          },
          cfg.remoteWorkspaceProfiles
        ),
      baseUrl: normalizedBaseUrl,
      vaultPath: normalizedVaultPath,
      lastConnectedAt:
        typeof input.lastConnectedAt === 'number' && Number.isFinite(input.lastConnectedAt)
          ? input.lastConnectedAt
          : null
    }
    const others = cfg.remoteWorkspaceProfiles.filter((entry) => entry.id !== nextNormalized.id)
    const nextProfiles = [...others, nextNormalized].sort((a, b) => a.name.localeCompare(b.name))
    let nextCurrentProfileId = cfg.remoteWorkspaceProfileId
    if (remoteWorkspaceConfig) {
      if (
        profileMatchesConnection(nextNormalized, remoteWorkspaceConfig, currentVault?.root ?? null)
      ) {
        nextCurrentProfileId = nextNormalized.id
      } else if (cfg.remoteWorkspaceProfileId === nextNormalized.id) {
        nextCurrentProfileId = null
      }
    }
    currentRemoteWorkspaceProfileId = nextCurrentProfileId
    return {
      ...cfg,
      remoteWorkspaceProfiles: nextProfiles,
      remoteWorkspaceProfileId: nextCurrentProfileId
    }
  })
  if (input.clearAuthToken) {
    await deleteRemoteWorkspaceSecret(normalizedId)
  } else if (typeof input.authToken === 'string' && input.authToken.trim()) {
    await setRemoteWorkspaceSecret(normalizedId, input.authToken.trim())
  }
  const cfg = await loadConfig()
  const normalized = findRemoteProfileById(cfg.remoteWorkspaceProfiles, normalizedId)
  if (!normalized) {
    throw new Error('Remote workspace profile could not be saved.')
  }
  return {
    id: normalized.id,
    name: normalized.name,
    baseUrl: normalized.baseUrl,
    vaultPath: normalized.vaultPath ?? null,
    lastConnectedAt: normalized.lastConnectedAt ?? null,
    hasCredential: input.clearAuthToken
      ? false
      : typeof input.authToken === 'string' && input.authToken.trim()
        ? true
        : Boolean(await getRemoteWorkspaceSecret(normalized.id))
  }
}

async function deleteRemoteWorkspaceProfile(id: string): Promise<void> {
  const deletedSecret = await getRemoteWorkspaceSecret(id)
  await updateConfig((cfg) => {
    const deletedProfile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, id)
    const nextProfiles = cfg.remoteWorkspaceProfiles.filter((entry) => entry.id !== id)
    const nextCurrentProfileId =
      cfg.remoteWorkspaceProfileId === id ? null : cfg.remoteWorkspaceProfileId
    const shouldClearLegacyRemoteWorkspace =
      !!deletedProfile &&
      !!cfg.remoteWorkspace &&
      normalizeRemoteBaseUrl(cfg.remoteWorkspace.baseUrl) ===
        normalizeRemoteBaseUrl(deletedProfile.baseUrl) &&
      !nextProfiles.some(
        (entry) =>
          normalizeRemoteBaseUrl(entry.baseUrl) === normalizeRemoteBaseUrl(deletedProfile.baseUrl)
      )
    currentRemoteWorkspaceProfileId = nextCurrentProfileId
    return {
      ...cfg,
      remoteWorkspace: shouldClearLegacyRemoteWorkspace ? null : cfg.remoteWorkspace,
      remoteWorkspaceProfiles: nextProfiles,
      remoteWorkspaceProfileId: nextCurrentProfileId
    }
  })
  await deleteRemoteWorkspaceSecret(id)
  if (deletedSecret && currentRemoteWorkspaceProfileId === id) {
    remoteWorkspaceClient = null
  }
}

async function connectRemoteWorkspaceProfile(
  profileId: string
): Promise<{ vault: VaultInfo | null; capabilities: ServerCapabilities }> {
  const cfg = await loadConfig()
  const profile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, profileId)
  if (!profile) {
    throw new Error('That saved remote workspace no longer exists.')
  }
  const authToken = await getRemoteWorkspaceSecret(profile.id)
  const result = await setRemoteWorkspace(profile.baseUrl, authToken, {
    profileId: profile.id,
    vaultPath: profile.vaultPath
  })
  const connectedAt = Date.now()
  await updateConfig((current) => ({
    ...current,
    remoteWorkspaceProfileId: profile.id,
    remoteWorkspaceProfiles: current.remoteWorkspaceProfiles.map((entry) =>
      entry.id === profile.id ? { ...entry, lastConnectedAt: connectedAt } : entry
    )
  }))
  currentRemoteWorkspaceProfileId = profile.id
  return result
}

async function loadCurrentVaultFromConfig(): Promise<VaultInfo | null> {
  const win = currentIpcWindow() ?? mainWindow
  if (win && !win.isDestroyed()) {
    const existing = windowVaults.vaultForWindow(win.id)
    if (existing) return existing
  } else if (currentVault) {
    return currentVault
  }
  const cfg = await loadConfig()
  remoteWorkspaceConfig = cfg.remoteWorkspace
  currentRemoteWorkspaceProfileId = cfg.remoteWorkspaceProfileId
  if (cfg.workspaceMode === 'remote' && cfg.remoteWorkspace?.baseUrl) {
    const remoteProfile = findRemoteProfileById(cfg.remoteWorkspaceProfiles, cfg.remoteWorkspaceProfileId)
    const authToken =
      (remoteProfile && (await getRemoteWorkspaceSecret(remoteProfile.id))) ??
      cfg.remoteWorkspace.authToken ??
      null
    try {
      const loadRemote = async () =>
        await setRemoteWorkspace(cfg.remoteWorkspace!.baseUrl, authToken, {
          persist: false,
          profileId: remoteProfile?.id ?? cfg.remoteWorkspaceProfileId,
          vaultPath: remoteProfile?.vaultPath ?? null
        })
      const result =
        win && !win.isDestroyed()
          ? await ipcWindowContext.run(win, loadRemote)
          : await loadRemote()
      return result.vault
    } catch {
      currentRemoteWorkspaceProfileId = null
      return null
    }
  }
  if (cfg.vaultRoot) {
    try {
      if (win && !win.isDestroyed()) {
        return await setVaultForWindow(win, cfg.vaultRoot, { persist: false })
      }
      return await setVault(cfg.vaultRoot)
    } catch {
      return null
    }
  }
  return null
}

function requireVault(): VaultInfo {
  const win = currentIpcWindow()
  const vault = win ? windowVaults.vaultForWindow(win.id) : currentVault
  if (!vault) throw new Error('No vault is open')
  return vault
}

function isRemoteWorkspaceActive(): boolean {
  const win = currentIpcWindow()
  if (win && !windowVaults.isRemoteWindow(win.id)) return false
  return remoteWorkspaceClient != null && (win ? true : currentWorkspaceMode === 'remote')
}

function requireRemoteWorkspaceClient(): RemoteServerClient {
  if (!isRemoteWorkspaceActive() || !remoteWorkspaceClient) {
    throw new Error('No remote workspace is connected')
  }
  return remoteWorkspaceClient
}

/**
 * Enumerate installed font families for the font picker.
 *
 * On macOS we call `system_profiler SPFontsDataType -json` and pull the
 * `typefaces[].family` field out of each entry — that's the actual
 * family name users see in Font Book (`JetBrains Mono`, `SF Mono`),
 * not the raw filename. Falls back to the `font-list` package on other
 * platforms.
 */
function listFontFamiliesMac(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/sbin/system_profiler',
      ['SPFontsDataType', '-json'],
      { maxBuffer: 200 * 1024 * 1024 },
      async (err, stdout) => {
        if (err) {
          console.error('system_profiler failed', err)
          resolve([])
          return
        }
        try {
          const data = JSON.parse(stdout) as {
            SPFontsDataType: Array<{
              _name?: string
              typefaces?: Array<{ family?: string; _name?: string }>
            }>
          }
          const entries = data.SPFontsDataType || []
          const families = new Set<string>()
          for (const entry of entries) {
            const faces = entry.typefaces || []
            for (const f of faces) {
              const name = f.family?.trim()
              if (!name) continue
              // Skip macOS private system fonts (leading dot, e.g.
              // `.SF NS`, `.SF Arabic`) — they're meant for the OS,
              // not user-selectable text.
              if (name.startsWith('.')) continue
              families.add(name)
            }
          }
          // Also include every file name that might not appear as a
          // registered typeface — rare but gives us an extra safety net
          // for fonts that were activated after boot and aren't yet in
          // the system_profiler cache.
          try {
            const homeFonts = path.join(app.getPath('home'), 'Library', 'Fonts')
            const files = await fsp.readdir(homeFonts)
            for (const f of files) {
              if (/\.(ttf|otf|ttc|otc)$/i.test(f)) {
                // Not a family name but a filename — only add if we
                // can't find any family that shares its stem.
                const stem = f.replace(/\.(ttf|otf|ttc|otc)$/i, '')
                const guess = stem.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim()
                if (guess && ![...families].some((fam) => guess.toLowerCase().startsWith(fam.toLowerCase()))) {
                  // leave unmatched file stems out of the picker — they
                  // rarely map cleanly to a family the user would pick.
                }
              }
            }
          } catch {
            /* ignore */
          }
          resolve(
            [...families].sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: 'base' })
            )
          )
        } catch (e) {
          console.error('failed to parse system_profiler JSON', e)
          resolve([])
        }
      }
    )
  })
}

async function listFontFamilies(): Promise<string[]> {
  if (process.platform === 'darwin') {
    const list = await listFontFamiliesMac()
    if (list.length > 0) return list
  }
  // Cross-platform fallback via the `font-list` package.
  try {
    const mod = (await import('font-list')) as unknown as {
      getFonts?: () => Promise<string[]>
      default?: { getFonts?: () => Promise<string[]> }
    }
    const getFonts = mod.getFonts ?? mod.default?.getFonts
    if (!getFonts) return []
    const raw = await getFonts()
    const unique = new Set<string>()
    for (const f of raw) {
      const name = f.replace(/^"|"$/g, '').trim()
      if (name) unique.add(name)
    }
    return [...unique].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  } catch (err) {
    console.error('font-list fallback failed', err)
    return []
  }
}

interface ListNotesStreamRequest {
  requestId?: unknown
  chunkSize?: unknown
  offset?: unknown
}

interface ListNotesStreamState {
  notes: NoteMeta[]
  touchedAt: number
}

const DEFAULT_LIST_NOTES_STREAM_CHUNK_SIZE = 500
const MAX_LIST_NOTES_STREAM_CHUNK_SIZE = 1000
const LIST_NOTES_STREAM_STATE_TTL_MS = 60_000
const listNotesStreamStates = new Map<string, ListNotesStreamState>()

function listNotesStreamChunkSize(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_NOTES_STREAM_CHUNK_SIZE
  return Math.min(MAX_LIST_NOTES_STREAM_CHUNK_SIZE, parsed)
}

function listNotesStreamOffset(raw: unknown): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function pruneListNotesStreamStates(): void {
  const cutoff = Date.now() - LIST_NOTES_STREAM_STATE_TTL_MS
  for (const [requestId, state] of listNotesStreamStates) {
    if (state.touchedAt < cutoff) listNotesStreamStates.delete(requestId)
  }
}

// `git status --porcelain=v1 -z -b` parsing. -z sidesteps two problems the
// default (human) format has: it NUL-terminates entries instead of quoting
// unusual filenames, and it reports renames/copies as two NUL-terminated
// fields (new path, then old path) instead of an "old -> new" arrow that
// would need its own parsing.
function emptyGitStatus(isRepo: boolean): GitStatusResult {
  return {
    isRepo,
    branch: null,
    staged: { added: [], modified: [], deleted: [], renamed: [] },
    unstaged: { modified: [], deleted: [] },
    untracked: []
  }
}

// "## main...origin/main [ahead 1]" | "## main" | "## No commits yet on main"
// | "## HEAD (no branch)" (detached HEAD, reported as no branch)
function parseGitBranchLine(line: string): string | null {
  const rest = line.replace(/^##\s*/, '')
  if (rest.startsWith('HEAD (no branch)')) return null
  const noCommitsYet = rest.match(/^No commits yet on (.+)$/)
  const name = (noCommitsYet ? noCommitsYet[1] : rest).split('...')[0].split(' [')[0].trim()
  return name || null
}

function parseGitStatusPorcelain(raw: string): GitStatusResult {
  const result = emptyGitStatus(true)
  const entries = raw.split('\0').filter((entry) => entry.length > 0)
  let i = 0
  while (i < entries.length) {
    const entry = entries[i]
    i++
    if (entry.startsWith('## ')) {
      result.branch = parseGitBranchLine(entry)
      continue
    }
    const x = entry[0]
    const y = entry[1]
    const entryPath = entry.slice(3)
    if (x === '?' && y === '?') {
      result.untracked.push({ path: entryPath })
      continue
    }
    // Rename/copy entries consume a second NUL-terminated field (the old path).
    const isRenameOrCopy = x === 'R' || x === 'C'
    const origPath = isRenameOrCopy ? entries[i++] : undefined
    const fileEntry: GitFileEntry = origPath ? { path: entryPath, origPath } : { path: entryPath }
    let bucketed = false
    switch (x) {
      case 'A':
        result.staged.added.push(fileEntry)
        bucketed = true
        break
      case 'M':
        result.staged.modified.push(fileEntry)
        bucketed = true
        break
      case 'D':
        result.staged.deleted.push(fileEntry)
        bucketed = true
        break
      case 'R':
      case 'C':
        result.staged.renamed.push(fileEntry)
        bucketed = true
        break
    }
    switch (y) {
      case 'M':
        result.unstaged.modified.push(fileEntry)
        bucketed = true
        break
      case 'D':
        result.unstaged.deleted.push(fileEntry)
        bucketed = true
        break
    }
    // Anything this UI doesn't model precisely — merge conflicts show up as
    // combinations like UU/AA/DD — still needs to surface somewhere rather
    // than silently vanish from the list.
    if (!bucketed) result.unstaged.modified.push(fileEntry)
  }
  return result
}

function currentGitRoot(): string | null {
  const win = currentIpcWindow()
  const vault = win ? windowVaults.vaultForWindow(win.id) : currentVault
  return vault ? path.resolve(vault.root) : null
}

async function runGitStatus(root: string): Promise<GitStatusResult> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '-b'], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024
    })
    return parseGitStatusPorcelain(stdout)
  } catch (err) {
    console.error('[git] status failed', err)
    return emptyGitStatus(false)
  }
}

// Node's exec-family functions reject with an Error that also carries the
// process's stdout/stderr — "nothing to commit" and similar advice messages
// land on stdout, not stderr, so both are checked to actually surface git's
// own explanation instead of a generic "Command failed" message.
function execErrorMessage(err: unknown): string {
  const asExecError = err as { stdout?: unknown; stderr?: unknown } | null
  const stderrText = typeof asExecError?.stderr === 'string' ? asExecError.stderr.trim() : ''
  const stdoutText = typeof asExecError?.stdout === 'string' ? asExecError.stdout.trim() : ''
  return stderrText || stdoutText || (err instanceof Error ? err.message : 'git command failed')
}

function registerIpc(): void {
  const handle = <Args extends unknown[], Result>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedIpcEvent(event)
      const win = requireEventWindow(event)
      return await ipcWindowContext.run(win, async () => await listener(event, ...(args as Args)))
    })
  }

  const on = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: Args) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      assertTrustedIpcEvent(event)
      const win = requireEventWindow(event)
      ipcWindowContext.run(win, () => listener(event, ...(args as Args)))
    })
  }

  handle(IPC.APP_PLATFORM, () => process.platform)

  // The native macOS "Look Up" dictionary popover for the current selection.
  // `showDefinitionForSelection` only exists on macOS; elsewhere this is a no-op.
  handle(IPC.APP_SHOW_DEFINITION_FOR_SELECTION, (event) => {
    if (process.platform !== 'darwin') return
    event.sender.showDefinitionForSelection()
  })

  handle(IPC.APP_LIST_FONTS, async () => {
    return await listFontFamilies()
  })
  handle(IPC.APP_ICON_DATA_URL, async () => {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png')
      const png = await fsp.readFile(iconPath)
      return `data:image/png;base64,${png.toString('base64')}`
    } catch {
      return null
    }
  })
  on(IPC.APP_RENDERER_READY, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    readyWindowIds.add(win.id)
    flushWindowNoteOpens(win)
    if (win !== mainWindow) return
    mainWindowReadyForAppEvents = true
    flushPendingOpenNoteRequests(win)
    void flushPendingFloatingNoteRequests()
  })
  handle(IPC.APP_ZOOM_IN, async (e) => {
    return await adjustWindowZoom(BrowserWindow.fromWebContents(e.sender), ZOOM_STEP)
  })
  handle(IPC.APP_ZOOM_OUT, async (e) => {
    return await adjustWindowZoom(BrowserWindow.fromWebContents(e.sender), -ZOOM_STEP)
  })
  handle(IPC.APP_ZOOM_RESET, async (e) => {
    return await setWindowZoom(BrowserWindow.fromWebContents(e.sender), DEFAULT_ZOOM_FACTOR)
  })
  handle(IPC.APP_UPDATER_GET_STATE, () => getAppUpdateState())
  handle(IPC.APP_UPDATER_CHECK, async () => await checkForAppUpdates())
  handle(IPC.APP_UPDATER_CHECK_WITH_UI, async () => {
    await runMenuUpdateCheck()
  })
  handle(IPC.APP_UPDATER_DOWNLOAD, async () => await downloadAppUpdate())
  handle(IPC.APP_UPDATER_INSTALL, () => {
    installAppUpdate()
  })

  handle(IPC.WORKSPACE_GET_INFO, async () => currentRemoteWorkspaceInfo())
  handle(IPC.WORKSPACE_CONNECT_REMOTE, async (_e, baseUrl: string, authToken?: string | null) => {
    return await setRemoteWorkspace(baseUrl, authToken)
  })
  handle(IPC.WORKSPACE_DISCONNECT_REMOTE, async () => {
    return await disconnectRemoteWorkspace()
  })
  handle(IPC.WORKSPACE_LIST_REMOTE_PROFILES, async () => {
    return await listRemoteWorkspaceProfiles()
  })
  handle(IPC.WORKSPACE_SAVE_REMOTE_PROFILE, async (_e, input: RemoteWorkspaceProfileInput) => {
    return await saveRemoteWorkspaceProfile(input)
  })
  handle(IPC.WORKSPACE_DELETE_REMOTE_PROFILE, async (_e, id: string) => {
    await deleteRemoteWorkspaceProfile(id)
  })
  handle(IPC.WORKSPACE_CONNECT_REMOTE_PROFILE, async (_e, id: string) => {
    return await connectRemoteWorkspaceProfile(id)
  })

  handle(IPC.VAULT_GET_CURRENT, async () => {
    return await loadCurrentVaultFromConfig()
  })

  handle(IPC.VAULT_LIST_LOCAL, async () => {
    return await listLocalVaults()
  })

  handle(IPC.VAULT_OPEN_LOCAL, async (_event, root: string) => {
    const trimmed = typeof root === 'string' ? root.trim() : ''
    if (!trimmed) return null
    return await setVault(trimmed)
  })

  handle(IPC.VAULT_CLOSE, async () => {
    return await closeLocalVaultForWindow()
  })

  handle(IPC.VAULT_PICK, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a vault folder',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Open Vault'
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return await setVault(result.filePaths[0])
  })

  handle(IPC.VAULT_SELECT_PATH, async (_e, targetPath: string) => {
    const client = requireRemoteWorkspaceClient()
    const vault = await client.selectVaultPath(targetPath)
    currentVault = vault
    if (remoteServerCapabilities) {
      startRemoteWatch(client, remoteServerCapabilities)
    }
    return vault
  })

  handle(IPC.VAULT_BROWSE_SERVER_DIRECTORIES, async (_e, targetPath: string = '') => {
    const client = requireRemoteWorkspaceClient()
    return await client.browseDirectories(targetPath)
  })

  handle(IPC.VAULT_GET_SETTINGS, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().getVaultSettings()
    }
    const v = requireVault()
    return await getVaultSettings(v.root)
  })

  handle(IPC.VAULT_SET_SETTINGS, async (_e, next: VaultSettings) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().setVaultSettings(next)
    }
    const v = requireVault()
    return await setVaultSettings(v.root, next)
  })

  handle(IPC.MANUAL_ORDER_GET, async () => {
    // Remote workspaces don't sync the manual-order sidecar (yet); fall back to
    // file order there rather than failing.
    if (isRemoteWorkspaceActive()) return {}
    const v = requireVault()
    return await getManualOrder(v.root)
  })

  handle(IPC.MANUAL_ORDER_SET, async (_e, map: ManualOrderMap) => {
    if (isRemoteWorkspaceActive()) return
    const v = requireVault()
    await setManualOrder(v.root, map)
  })

  // Vim IME control (macOS). The renderer passes the user-configured switcher
  // binary path (e.g. macism); we just exec it. Reading prints the current
  // input-source id; writing switches to the given id. Best-effort: any
  // failure (binary missing, wrong path, non-mac) degrades to no-op.
  handle(IPC.IME_GET_CURRENT, async (_e, binaryPath: string) => {
    if (!isMac() || !binaryPath?.trim()) return ''
    try {
      const { stdout } = await execFileAsync(binaryPath.trim(), [], { timeout: 2000 })
      return stdout.trim()
    } catch (err) {
      console.error('[zen:ime] get-current failed', err)
      return ''
    }
  })

  handle(IPC.IME_SET_LAYOUT, async (_e, binaryPath: string, layoutId: string) => {
    if (!isMac() || !binaryPath?.trim() || !layoutId?.trim()) return false
    try {
      await execFileAsync(binaryPath.trim(), [layoutId.trim()], { timeout: 2000 })
      return true
    } catch (err) {
      console.error('[zen:ime] set-layout failed', err)
      return false
    }
  })

  // Read a user JS file for the Vim `zen:<file>:<fn>()` mappings. `name` must
  // be a bare filename (no separators / `..`); we only ever read `<name>.js`
  // from inside the config dir.
  handle(IPC.USER_SCRIPT_GET, async (_e, name: string) => {
    const base = (name ?? '').trim()
    if (!base || !/^[\w.-]+$/.test(base) || base.includes('..')) return null
    try {
      const file = path.join(getConfigDir(), `${base}.js`)
      const [code, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)])
      return { code, mtime: stat.mtimeMs }
    } catch {
      return null
    }
  })

  // Per-vault workspace state (#292): open tabs, pane layout, sidebar, cursors.
  // Stored as <vault>/.zennotes/workspace.json so it travels with the vault.
  // Local vaults only — remote workspaces manage their session server-side.
  // NOTE: not currently called from the renderer (see store.ts) — this fork's
  // multi-window feature keys workspace snapshots per-window so that two
  // windows on the same vault restore independently, which this single
  // shared-file-per-vault design would silently defeat if wired up naively.
  // Left registered (harmless, and useful if reconciled with per-window
  // snapshots later) but intentionally dormant for now.
  handle(IPC.WORKSPACE_STATE_READ, async (): Promise<string | null> => {
    if (isRemoteWorkspaceActive()) return null
    const v = requireVault()
    // Temporary folder session: start fresh, don't read/write .zennotes.
    if (isEphemeralRoot(v.root)) return null
    try {
      return await fsp.readFile(path.join(v.root, '.zennotes', 'workspace.json'), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  })

  handle(IPC.WORKSPACE_STATE_WRITE, async (_e, json: string): Promise<void> => {
    if (isRemoteWorkspaceActive()) return
    if (typeof json !== 'string') return
    const v = requireVault()
    // Temporary folder session: don't write .zennotes/workspace.json into it.
    if (isEphemeralRoot(v.root)) return
    const dir = path.join(v.root, '.zennotes')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'workspace.json'), json, 'utf8')
  })

  handle(IPC.VAULT_ROOT_CONTENT_HIDDEN, async () => {
    // Local-vault only: a remote workspace manages its own layout server-side.
    if (isRemoteWorkspaceActive()) return false
    const v = requireVault()
    return await rootContentHiddenByInboxMode(v.root)
  })

  handle(IPC.VAULT_LIST_NOTES, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listNotes()
    const v = requireVault()
    return await listNotes(v.root)
  })

  handle(IPC.VAULT_LIST_NOTES_STREAM, async (_event, request: ListNotesStreamRequest) => {
    if (typeof request?.requestId !== 'string' || request.requestId.length === 0) {
      throw new Error('Missing list-notes stream request id')
    }
    const requestId = request.requestId
    const chunkSize = listNotesStreamChunkSize(request.chunkSize)
    const offset = listNotesStreamOffset(request.offset)
    pruneListNotesStreamStates()

    let state = listNotesStreamStates.get(requestId)
    if (!state || offset === 0) {
      const notes = isRemoteWorkspaceActive()
        ? await requireRemoteWorkspaceClient().listNotes()
        : await listNotes(requireVault().root)
      state = { notes, touchedAt: Date.now() }
      listNotesStreamStates.set(requestId, state)
    } else {
      state.touchedAt = Date.now()
    }

    const nextOffset = Math.min(state.notes.length, offset + chunkSize)
    const done = nextOffset >= state.notes.length
    const notes = state.notes.slice(offset, nextOffset)
    if (done) listNotesStreamStates.delete(requestId)
    return {
      notes,
      nextOffset,
      done,
      total: state.notes.length
    }
  })

  handle(IPC.VAULT_LIST_FOLDERS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listFolders()
    const v = requireVault()
    return await listFolders(v.root)
  })

  handle(IPC.VAULT_LIST_ASSETS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().listAssets()
    const v = requireVault()
    return await listAssets(v.root)
  })

  handle(IPC.VAULT_HAS_ASSETS_DIR, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().hasAssetsDir()
    const v = requireVault()
    return await hasAssetsDir(v.root)
  })

  handle(IPC.VAULT_GENERATE_DEMO_TOUR, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().generateDemoTour()
    }
    const v = requireVault()
    return await generateDemoTour(v.root)
  })

  handle(IPC.VAULT_REMOVE_DEMO_TOUR, async () => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().removeDemoTour()
    }
    const v = requireVault()
    return await removeDemoTour(v.root)
  })

  // Custom templates live on the local filesystem only; remote vaults fall
  // back to built-in templates (renderer constants), so list returns empty and
  // mutations are rejected.
  handle(IPC.VAULT_LIST_TEMPLATES, async () => {
    if (isRemoteWorkspaceActive()) return []
    const v = requireVault()
    return await listCustomTemplates(v.root)
  })

  handle(IPC.VAULT_READ_TEMPLATE, async (_e, sourcePath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await readCustomTemplate(v.root, sourcePath)
  })

  handle(IPC.VAULT_WRITE_TEMPLATE, async (_e, input: WriteTemplateInput) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await writeCustomTemplate(v.root, input)
  })

  handle(IPC.VAULT_DELETE_TEMPLATE, async (_e, sourcePath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Custom templates are unavailable on remote vaults')
    }
    const v = requireVault()
    return await deleteCustomTemplate(v.root, sourcePath)
  })

  handle(IPC.VAULT_TEXT_SEARCH_CAPABILITIES, async (_e, paths: VaultTextSearchToolPaths = {}) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().getVaultTextSearchCapabilities()
    }
    return await searchVaultTextCapabilities(paths)
  })

  handle(
    IPC.VAULT_SEARCH_TEXT,
    async (
      _e,
      query: string,
      backend: VaultTextSearchBackendPreference = 'auto',
      paths: VaultTextSearchToolPaths = {}
    ) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().searchVaultText(query, backend, paths)
      }
      const v = requireVault()
      return await searchVaultText(v.root, query, backend, paths)
    }
  )

  handle(IPC.VAULT_READ_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().readNote(relPath)
    const v = requireVault()
    return await readNote(v.root, relPath)
  })

  handle(IPC.VAULT_READ_COMMENTS, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().readNoteComments(relPath)
    }
    const v = requireVault()
    return await readNoteComments(v.root, relPath)
  })

  handle(IPC.VAULT_WRITE_COMMENTS, async (_e, relPath: string, comments: NoteCommentInput[]) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().writeNoteComments(relPath, comments)
    }
    const v = requireVault()
    // Comments live under .zennotes/; skip in a temporary session so the folder
    // stays pristine (they aren't persisted for a temporary browse).
    if (isEphemeralRoot(v.root)) return
    return await writeNoteComments(v.root, relPath, comments)
  })

  handle(IPC.VAULT_SCAN_TASKS, async () => {
    if (isRemoteWorkspaceActive()) return await requireRemoteWorkspaceClient().scanTasks()
    const v = requireVault()
    return await scanAllTasks(v.root)
  })

  handle(IPC.VAULT_SCAN_TASKS_FOR, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().scanTasksForPath(relPath)
    }
    const v = requireVault()
    return await scanTasksForPath(v.root, relPath)
  })

  // Databases are local-vault only for now (no remote-server endpoints yet).
  const ensureLocalForDatabases = (): void => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Databases are not yet supported on remote vaults')
    }
  }

  handle(IPC.VAULT_OPEN_DATABASE, async (_e, relPath: string) => {
    ensureLocalForDatabases()
    try {
      return await readDatabase(requireVault().root, relPath)
    } catch (err) {
      // A missing database isn't exceptional — its tab can simply outlive the
      // file (deleted by us or another client). Return null so the renderer
      // forgets it, instead of rejecting and logging a noisy
      // "Error occurred in handler for 'vault:open-database'". Real errors
      // (parse/permission) still throw.
      if (err instanceof Error && err.message.startsWith('Database not found')) return null
      throw err
    }
  })

  handle(IPC.VAULT_WRITE_DATABASE_ROWS, async (_e, relPath: string, rows: DbRow[]) => {
    ensureLocalForDatabases()
    return await writeDatabaseRows(requireVault().root, relPath, rows)
  })

  handle(
    IPC.VAULT_WRITE_DATABASE_SCHEMA,
    async (_e, relPath: string, sidecar: DatabaseSidecar, rows: DbRow[]) => {
      ensureLocalForDatabases()
      return await writeDatabaseSchema(requireVault().root, relPath, sidecar, rows)
    }
  )

  handle(
    IPC.VAULT_CREATE_DATABASE,
    async (_e, folder: NoteFolder, subpath: string, title?: string) => {
      ensureLocalForDatabases()
      return await createDatabase(requireVault().root, folder, subpath, title)
    }
  )

  handle(IPC.VAULT_RENAME_DATABASE, async (_e, csvPath: string, newTitle: string) => {
    ensureLocalForDatabases()
    return await renameDatabase(requireVault().root, csvPath, newTitle)
  })

  handle(
    IPC.VAULT_CREATE_RECORD_PAGE,
    async (_e, csvPath: string, title: string, body: string) => {
      ensureLocalForDatabases()
      return await createRecordPage(requireVault().root, csvPath, title, body)
    }
  )

  handle(IPC.VAULT_LIST_DATABASES, async () => {
    ensureLocalForDatabases()
    return await listDatabases(requireVault().root)
  })

  handle(IPC.VAULT_WRITE_NOTE, async (_e, relPath: string, body: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().writeNote(relPath, body)
    }
    const v = requireVault()
    return await writeNote(v.root, relPath, body)
  })

  handle(IPC.VAULT_WRITE_PDF, async (_e, relPath: string, bytes: Uint8Array) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Saving PDFs is not supported in remote workspaces yet.')
    }
    const v = requireVault()
    const rootAbs = path.resolve(v.root)
    const abs = path.resolve(v.root, relPath.split('/').join(path.sep))
    // Containment + extension guards: never write outside the open vault, and
    // never let this channel clobber a non-PDF file.
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error('Refusing to write outside the vault.')
    }
    if (path.extname(abs).toLowerCase() !== '.pdf') {
      throw new Error('Refusing to write a non-PDF file.')
    }
    await writeFileAtomicBinary(abs, bytes)
    return true
  })

  handle(
    IPC.VAULT_APPEND_NOTE,
    async (_e, relPath: string, body: string, position: 'start' | 'end') => {
      const safePosition = position === 'start' ? 'start' : 'end'
      if (isRemoteWorkspaceActive()) {
        // Remote vaults don't expose appendToNote yet — compose with read+write
        // so the call works uniformly across local + remote workspaces.
        const client = requireRemoteWorkspaceClient()
        const current = await client.readNote(relPath)
        const trimmed = body.replace(/\s+$/u, '')
        if (!trimmed) return current
        const next =
          safePosition === 'end'
            ? `${current.body}${current.body.endsWith('\n') ? '' : '\n'}\n${trimmed}\n`
            : `${trimmed}\n\n${current.body}`
        return await client.writeNote(relPath, next)
      }
      const v = requireVault()
      return await appendToNote(v.root, relPath, body, safePosition)
    }
  )

  handle(
    IPC.VAULT_CREATE_NOTE,
    async (_e, folder: NoteFolder, title: string | undefined, subpath: string = '') => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().createNote(folder, title, subpath)
      }
      const v = requireVault()
      return await createNote(v.root, folder, title, subpath)
    }
  )

  handle(
    IPC.VAULT_CREATE_EXCALIDRAW,
    async (_e, folder: NoteFolder, subpath: string = '', title?: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().createExcalidraw(folder, subpath, title)
      }
      const v = requireVault()
      return await createExcalidraw(v.root, folder, subpath, title)
    }
  )

  handle(IPC.VAULT_CONVERT_OBSIDIAN_EXCALIDRAW, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Converting Obsidian drawings is only available for local vaults.')
    }
    const v = requireVault()
    return await convertObsidianExcalidraw(v.root, relPath)
  })

  handle(IPC.VAULT_RENAME_NOTE, async (_e, relPath: string, nextTitle: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().renameNote(relPath, nextTitle)
    }
    const v = requireVault()
    return await renameNote(v.root, relPath, nextTitle)
  })

  handle(IPC.VAULT_DELETE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      await requireRemoteWorkspaceClient().deleteNote(relPath)
      return
    }
    const v = requireVault()
    await deleteNote(v.root, relPath)
  })

  handle(IPC.VAULT_MOVE_TO_TRASH, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().moveToTrash(relPath)
    }
    const v = requireVault()
    // Trash would create a `trash/` folder inside a temporary session's folder.
    // Keep it pristine: refuse rather than litter (edits still save in place).
    if (isEphemeralRoot(v.root)) {
      throw new Error('Move to Trash is not available in a temporary folder session.')
    }
    return await moveToTrash(v.root, relPath)
  })

  handle(IPC.VAULT_RESTORE_FROM_TRASH, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().restoreFromTrash(relPath)
    }
    const v = requireVault()
    return await restoreFromTrash(v.root, relPath)
  })

  handle(IPC.VAULT_EMPTY_TRASH, async () => {
    if (isRemoteWorkspaceActive()) {
      await requireRemoteWorkspaceClient().emptyTrash()
      return
    }
    const v = requireVault()
    await emptyTrash(v.root)
  })

  handle(IPC.VAULT_ARCHIVE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().archiveNote(relPath)
    }
    const v = requireVault()
    return await archiveNote(v.root, relPath)
  })

  handle(IPC.VAULT_UNARCHIVE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().unarchiveNote(relPath)
    }
    const v = requireVault()
    return await unarchiveNote(v.root, relPath)
  })

  handle(IPC.VAULT_DUPLICATE_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      return await requireRemoteWorkspaceClient().duplicateNote(relPath)
    }
    const v = requireVault()
    return await duplicateNote(v.root, relPath)
  })

  handle(IPC.VAULT_EXPORT_NOTE_PDF, async (event, relPath: string) => {
    return await exportNotePdf(relPath, BrowserWindow.fromWebContents(event.sender))
  })

  handle(IPC.VAULT_REVEAL_NOTE, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    shell.showItemInFolder(abs)
  })

  handle(IPC.VAULT_REVEAL_NOTE_TARGET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    const abs = absolutePath(v.root, relPath)
    let target: string
    try {
      target = await fsp.realpath(abs)
    } catch {
      throw new Error('Could not resolve the symlink target (it may be broken).')
    }
    shell.showItemInFolder(target)
  })

  handle(IPC.VAULT_REVEAL_FILE_PATH, async (_e, absPath: string) => {
    shell.showItemInFolder(absPath)
  })

  // Open a file linked from a note but living outside the vault, with the OS
  // default app. The renderer confirms with the user first (this could launch
  // an app), so here we only resolve the href to an absolute path and open it.
  handle(IPC.VAULT_OPEN_EXTERNAL_FILE, async (_e, href: string) => {
    try {
      const raw = String(href ?? '').trim()
      if (!raw) return { ok: false, error: 'Empty path.' }
      let abs: string
      if (/^file:\/\//i.test(raw)) {
        abs = fileURLToPath(raw)
      } else if (raw === '~' || raw.startsWith('~/')) {
        abs = path.join(homedir(), raw.slice(1))
      } else {
        abs = path.resolve(raw)
      }
      const error = await shell.openPath(abs)
      return error ? { ok: false, error } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle(IPC.VAULT_FETCH_LINK_METADATA, async (_e, url: string) => {
    return await fetchLinkMetadata(url)
  })

  handle(
    IPC.VAULT_MOVE_NOTE,
    async (_e, relPath: string, targetFolder: NoteFolder, targetSubpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().moveNote(relPath, targetFolder, targetSubpath)
      }
      const v = requireVault()
      return await moveNote(v.root, relPath, targetFolder, targetSubpath)
    }
  )

  handle(
    IPC.VAULT_IMPORT_FILES,
    async (_e, _notePath: string, sourcePaths: string[]) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Desktop file import is only available for local vaults right now.')
      }
      const v = requireVault()
      return await importFiles(v.root, sourcePaths)
    }
  )

  handle(IPC.VAULT_IMPORT_PASTED_IMAGE, async (_e, input: PastedImageInput) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Clipboard image paste is only available for local vaults right now.')
    }
    const v = requireVault()
    return await importPastedImage(v.root, input)
  })

  handle(IPC.VAULT_RENAME_ASSET, async (_e, relPath: string, nextName: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset rename is only available for local vaults right now.')
    }
    const v = requireVault()
    return await renameAsset(v.root, relPath, nextName)
  })

  handle(IPC.VAULT_MOVE_ASSET, async (_e, relPath: string, targetDir: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset move is only available for local vaults right now.')
    }
    const v = requireVault()
    return await moveAsset(v.root, relPath, targetDir)
  })

  handle(IPC.VAULT_DUPLICATE_ASSET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset duplication is only available for local vaults right now.')
    }
    const v = requireVault()
    return await duplicateAsset(v.root, relPath)
  })

  handle(IPC.VAULT_DELETE_ASSET, async (_e, relPath: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset deletion is only available for local vaults right now.')
    }
    const v = requireVault()
    return await deleteAsset(v.root, relPath)
  })

  handle(IPC.VAULT_RESTORE_DELETED_ASSET, async (_e, deleted: DeletedAsset) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset restore is only available for local vaults right now.')
    }
    const v = requireVault()
    return await restoreDeletedAsset(v.root, deleted)
  })

  handle(IPC.VAULT_LIST_DELETED_ASSETS, async () => {
    if (isRemoteWorkspaceActive()) return []
    const v = requireVault()
    return await listDeletedAssets(v.root)
  })

  handle(IPC.VAULT_PURGE_DELETED_ASSET, async (_e, undoToken: string) => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset deletion is only available for local vaults right now.')
    }
    const v = requireVault()
    await purgeDeletedAsset(v.root, undoToken)
  })

  handle(IPC.VAULT_EMPTY_DELETED_ASSETS, async () => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Asset deletion is only available for local vaults right now.')
    }
    const v = requireVault()
    await emptyDeletedAssets(v.root)
  })

  handle(
    IPC.VAULT_CREATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        await requireRemoteWorkspaceClient().createFolder(folder, subpath)
        return
      }
      const v = requireVault()
      await createFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_RENAME_FOLDER,
    async (_e, folder: NoteFolder, oldSubpath: string, newSubpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().renameFolder(folder, oldSubpath, newSubpath)
      }
      const v = requireVault()
      return await renameFolder(v.root, folder, oldSubpath, newSubpath)
    }
  )

  handle(
    IPC.VAULT_DELETE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        await requireRemoteWorkspaceClient().deleteFolder(folder, subpath)
        return
      }
      const v = requireVault()
      await deleteFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_DUPLICATE_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        return await requireRemoteWorkspaceClient().duplicateFolder(folder, subpath)
      }
      const v = requireVault()
      return await duplicateFolder(v.root, folder, subpath)
    }
  )

  handle(
    IPC.VAULT_REVEAL_FOLDER,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Reveal in file manager is only available for local vaults.')
      }
      const v = requireVault()
      const abs = await folderAbsolutePath(v.root, folder, subpath)
      await shell.openPath(abs)
    }
  )

  handle(
    IPC.VAULT_REVEAL_FOLDER_TARGET,
    async (_e, folder: NoteFolder, subpath: string) => {
      if (isRemoteWorkspaceActive()) {
        throw new Error('Reveal in file manager is only available for local vaults.')
      }
      const v = requireVault()
      const abs = await folderAbsolutePath(v.root, folder, subpath)
      let target: string
      try {
        target = await fsp.realpath(abs)
      } catch {
        throw new Error('Could not resolve the symlink target (it may be broken).')
      }
      await shell.openPath(target)
    }
  )

  handle(IPC.VAULT_REVEAL_ASSETS_DIR, async () => {
    if (isRemoteWorkspaceActive()) {
      throw new Error('Reveal in file manager is only available for local vaults.')
    }
    const v = requireVault()
    await shell.openPath(v.root)
  })

  // Route window chrome controls to the window that actually sent the
  // IPC (via `e.sender`) so that floating note windows can minimize /
  // maximize / close themselves without hijacking the main window.
  on(IPC.WINDOW_MINIMIZE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })
  on(IPC.WINDOW_TOGGLE_MAXIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  on(IPC.WINDOW_CLOSE, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  // Keeps the native title (what a tab shows as its label, and what Mission
  // Control / Cmd+Tab / the Dock menu show) in sync with whatever TitleBar
  // is actually rendering, so tabs read as something useful instead of the
  // generic app name.
  on(IPC.WINDOW_SET_TITLE, (e, title: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed() && typeof title === 'string') win.setTitle(title.slice(0, 500))
  })
  // Zen mode is a renderer-only concept; this is how it reaches into the one
  // piece of chrome it can't otherwise touch — a tabbed window's native tab
  // bar (see syncTabBarForZenMode).
  on(IPC.WINDOW_SET_ZEN_MODE, (e, active: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return
    if (active) zenModeWindows.add(win.id)
    else zenModeWindows.delete(win.id)
    void reconcileAndPersistTabGroups()
  })

  handle(IPC.WINDOW_OPEN_NOTE, async (_e, relPath: string) => {
    openFloatingNoteWindow(relPath)
  })

  handle(IPC.WINDOW_OPEN_VAULT, async (event, root?: string | null) => {
    return await openVaultInNewWindow(
      BrowserWindow.fromWebContents(event.sender),
      typeof root === 'string' ? root : null
    )
  })

  handle(IPC.APP_READ_EXTERNAL_FILE, async (event): Promise<ExternalFileContent> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    const body = await fsp.readFile(abs, 'utf8')
    return { path: abs, name: path.basename(abs), body }
  })

  handle(IPC.APP_WRITE_EXTERNAL_FILE, async (event, body: string): Promise<void> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    await fsp.writeFile(abs, body, 'utf8')
  })

  handle(IPC.APP_MOVE_EXTERNAL_FILE_TO_VAULT, async (event): Promise<MoveExternalFileResult> => {
    const win = requireEventWindow(event)
    const abs = externalFileWindows.get(win.id)
    if (!abs || !isMarkdownFilePath(abs)) {
      throw new Error('No markdown file is bound to this window.')
    }
    const vault = await resolveActiveLocalVault()
    if (!vault) {
      throw new Error('Open a vault first, then move this file into it.')
    }
    const meta = await importExternalNote(vault.root, abs)
    externalFileWindows.delete(win.id)
    const targetWin =
      findWindowForVaultRoot(vault.root) ??
      (await createWindow({ initialVaultRoot: vault.root, persistInitialVault: true }))
    focusWindow(targetWin)
    queueNoteOpenForWindow(targetWin, meta.path)
    if (!win.isDestroyed()) win.close()
    return { vaultRoot: vault.root, relPath: meta.path }
  })

  // Drag-and-drop a markdown file onto a window. Routes through the same
  // vault-aware opener as the Finder "Open in ZenNotes" entry / `open-file`
  // event: a note inside a known vault opens against that vault, anything
  // else opens in a standalone external-file window. The absolute path comes
  // from `webUtils.getPathForFile` on the dropped File, and the stat +
  // markdown checks inside `openMarkdownFileFromOS` re-validate it.
  handle(IPC.APP_OPEN_MARKDOWN_FILE, async (_event, rawPath: string): Promise<boolean> => {
    if (typeof rawPath !== 'string' || !rawPath.trim() || !isMarkdownFilePath(rawPath)) {
      return false
    }
    return await openMarkdownFileFromOS(path.resolve(rawPath), false)
  })

  // In-app "Open File…" (#449): pop a native picker from the focused window and
  // open the chosen markdown file the same vault-aware way as drag-and-drop.
  handle(IPC.APP_OPEN_FILE_DIALOG, async (event): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return await openMarkdownFileViaDialog(win ?? undefined)
  })

  handle(IPC.APP_OPEN_FOLDER_TEMPORARY, async (_event, rawPath: string): Promise<void> => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return
    let stat
    try {
      stat = await fsp.stat(rawPath)
    } catch {
      return
    }
    if (!stat.isDirectory()) return
    await openTemporaryFolder(path.resolve(rawPath), false)
  })

  handle(IPC.WINDOW_TOGGLE_QUICK_CAPTURE, async () => {
    await toggleQuickCaptureWindow()
  })

  handle(IPC.APP_GET_QUICK_CAPTURE_HOTKEY, async () => {
    const cfg = await loadConfig()
    return cfg.quickCaptureHotkey
  })

  handle(IPC.APP_SET_QUICK_CAPTURE_HOTKEY, async (_e, hotkey: string) => {
    const trimmed = typeof hotkey === 'string' ? hotkey.trim() : ''
    const result = registerQuickCaptureHotkey(trimmed)
    if (result.ok) {
      await updateConfig((cfg) => ({ ...cfg, quickCaptureHotkey: trimmed }))
    }
    return { ok: result.ok, hotkey: trimmed, error: result.error }
  })

  handle(IPC.APP_GET_QUICK_CAPTURE_PINNED, async () => {
    const cfg = await loadConfig()
    quickCapturePinned = cfg.quickCapturePinned
    return quickCapturePinned
  })

  handle(IPC.APP_SET_QUICK_CAPTURE_PINNED, async (_e, pinned: boolean) => {
    quickCapturePinned = pinned === true
    applyQuickCapturePinned()
    await updateConfig((cfg) => ({ ...cfg, quickCapturePinned }))
    return quickCapturePinned
  })

  handle(IPC.APP_LIST_QUICK_CAPTURE_VAULTS, async () => quickCaptureVaultChoices())

  handle(IPC.APP_SET_QUICK_CAPTURE_VAULT, async (_e, root: string) => {
    const trimmed = typeof root === 'string' ? root.trim() : ''
    if (!trimmed) return null
    const resolved = path.resolve(trimmed)
    // Only accept somewhere the picker actually offered, so a stale or crafted
    // root can't silently redirect captures outside the open set.
    const match = quickCaptureVaultChoices().find((v) => v.root === resolved)
    if (!match) return null
    const win = quickCaptureWindow
    if (win && !win.isDestroyed()) windowVaults.setLocalVault(win.id, match)
    await updateConfig((cfg) => ({ ...cfg, quickCaptureVaultRoot: resolved }))
    return match
  })

  handle(IPC.TIKZ_RENDER, async (_e, source: string) => {
    const result = await renderTikz(source)
    if (result.ok) return { ok: true, svg: result.svg }
    return { ok: false, error: result.error }
  })

  handle(IPC.MCP_RUNTIME, async () => await getMcpServerRuntime())
  handle(IPC.MCP_STATUS, async () => await getMcpClientStatuses())
  handle(IPC.MCP_INSTALL, async (_e, id: McpClientId) => await installMcpForClient(id))
  handle(IPC.MCP_UNINSTALL, async (_e, id: McpClientId) => await uninstallMcpForClient(id))
  handle(IPC.MCP_GET_INSTRUCTIONS, async (): Promise<McpInstructionsPayload> => {
    const custom = await readCustomInstructions()
    return {
      defaultValue: MCP_SERVER_INSTRUCTIONS,
      current: custom ?? MCP_SERVER_INSTRUCTIONS,
      isCustom: custom != null,
      filePath: instructionsFilePath()
    }
  })
  handle(
    IPC.MCP_SET_INSTRUCTIONS,
    async (_e, next: string | null): Promise<McpInstructionsPayload> => {
      await writeCustomInstructions(next)
      const custom = await readCustomInstructions()
      return {
        defaultValue: MCP_SERVER_INSTRUCTIONS,
        current: custom ?? MCP_SERVER_INSTRUCTIONS,
        isCustom: custom != null,
        filePath: instructionsFilePath()
      }
    }
  )

  handle(IPC.CLI_GET_STATUS, async () => await getCliInstallStatus())
  handle(IPC.CLI_INSTALL, async () => await installCli())
  handle(IPC.CLI_UNINSTALL, async () => await uninstallCli())
  handle(IPC.RAYCAST_GET_STATUS, async () => await getRaycastExtensionStatus())
  handle(IPC.RAYCAST_INSTALL, async () => await installRaycastExtension())

  handle(IPC.GIT_IS_REPO, async () => {
    const root = currentGitRoot()
    if (!root) return false
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: root, timeout: 3000 })
      return true
    } catch {
      return false
    }
  })

  handle(IPC.GIT_SHOW_INDEX, async (_e, vaultRelativePath: string) => {
    const root = currentGitRoot()
    if (!root) return null
    try {
      const { stdout } = await execFileAsync('git', ['show', `:0:${vaultRelativePath}`], {
        cwd: root,
        timeout: 5000
      })
      return stdout
    } catch {
      return null
    }
  })

  handle(IPC.GIT_STATUS, async (): Promise<GitStatusResult> => {
    const root = currentGitRoot()
    if (!root) return emptyGitStatus(false)
    return await runGitStatus(root)
  })

  handle(IPC.GIT_STAGE_ALL, async (): Promise<GitStatusResult> => {
    const root = currentGitRoot()
    if (!root) return emptyGitStatus(false)
    try {
      await execFileAsync('git', ['add', '-A'], { cwd: root, timeout: 10000 })
    } catch (err) {
      console.error('[git] stage all failed', err)
    }
    return await runGitStatus(root)
  })

  handle(IPC.GIT_UNSTAGE_ALL, async (): Promise<GitStatusResult> => {
    const root = currentGitRoot()
    if (!root) return emptyGitStatus(false)
    try {
      await execFileAsync('git', ['restore', '--staged', '.'], { cwd: root, timeout: 10000 })
    } catch (err) {
      console.error('[git] unstage all failed', err)
    }
    return await runGitStatus(root)
  })

  handle(IPC.GIT_COMMIT, async (_e, message: string): Promise<GitCommitResult> => {
    const root = currentGitRoot()
    if (!root) return { ok: false, error: 'No vault is open', status: emptyGitStatus(false) }
    const trimmed = message.trim() || 'update'
    try {
      await execFileAsync('git', ['commit', '-m', trimmed], { cwd: root, timeout: 15000 })
      return { ok: true, status: await runGitStatus(root) }
    } catch (err) {
      return { ok: false, error: execErrorMessage(err), status: await runGitStatus(root) }
    }
  })

  handle(IPC.GIT_LOG, async (): Promise<string> => {
    const root = currentGitRoot()
    if (!root) return ''
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'log',
          '--graph',
          '--color=always',
          '--pretty=format:%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset',
          '--abbrev-commit',
          '--date=relative',
          '-20'
        ],
        { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
      )
      return stdout
    } catch (err) {
      console.error('[git] log failed', err)
      return ''
    }
  })

  // Synchronous getter so the preload can hydrate the renderer's prefs store
  // at startup without an async round-trip. Registered directly (not via the
  // `on` helper) because it must set `event.returnValue` and doesn't need the
  // window async-context the helper establishes.
  ipcMain.on(IPC.CONFIG_GET_SYNC, (event) => {
    try {
      assertTrustedIpcEvent(event)
      event.returnValue = getPortableConfigSnapshot()
    } catch {
      event.returnValue = null
    }
  })
  ipcMain.on(IPC.WINDOW_GET_ID, (event) => {
    try {
      assertTrustedIpcEvent(event)
      const win = BrowserWindow.fromWebContents(event.sender)
      event.returnValue = win ? (windowUuids.get(win.id) ?? null) : null
    } catch {
      event.returnValue = null
    }
  })
  ipcMain.on(IPC.WINDOW_GET_CHROME_SYNC, (event) => {
    try {
      assertTrustedIpcEvent(event)
      const win = BrowserWindow.fromWebContents(event.sender)
      event.returnValue = win
        ? {
            tabBarVisible: nativeTabBarVisible(win),
            topInset: nativeContentTopInset(win)
          }
        : { tabBarVisible: false, topInset: 0 }
    } catch {
      event.returnValue = { tabBarVisible: false, topInset: 0 }
    }
  })
  handle(IPC.CONFIG_SET, async (_event, next: AppConfigPortable) => {
    await setPortableConfig(next ?? {})
    // The config-file watcher deliberately skips our own writes, so it never
    // notifies the other open windows when a setting changes through the UI.
    // Push the new config to them directly so every window stays in sync.
    broadcastConfigChange(next ?? {})
  })
  handle(IPC.CONFIG_GET_PATH, () => getConfigFilePath())
  handle(IPC.CONFIG_REVEAL, async () => {
    const file = await ensureConfigFile()
    shell.showItemInFolder(file)
  })

  // ── Terminal / PTY ──────────────────────────────────────────────────────────
  handle(IPC.TERMINAL_CREATE, async (event, opts: { cwd: string; cols: number; rows: number }) => {
    assertTrustedIpcEvent(event)
    const shell = process.env.SHELL ?? '/bin/zsh'
    const id = randomUUID()
    const pty = loadNodePty().spawn(shell, [], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    })
    const wcId = event.sender.id
    ptySessions.set(id, { pty, webContentsId: wcId })
    pty.onData((data) => {
      const wc = webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) wc.send(IPC.TERMINAL_DATA, id, data)
    })
    pty.onExit(({ exitCode }) => {
      ptySessions.delete(id)
      ptyTty.delete(id)
      const wc = webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) wc.send(IPC.TERMINAL_EXIT, id, exitCode)
    })
    ensureTmuxTargetPoll()
    void restoreTmuxTarget(id, wcId)
    return id
  })
  ipcMain.on(IPC.TERMINAL_INPUT, (event, id: string, data: string) => {
    if (!isTrustedIpcSender(event.sender)) return
    ptySessions.get(id)?.pty.write(data)
  })
  ipcMain.on(IPC.TERMINAL_RESIZE, (event, id: string, cols: number, rows: number) => {
    if (!isTrustedIpcSender(event.sender)) return
    ptySessions.get(id)?.pty.resize(cols, rows)
  })
  ipcMain.on(IPC.TERMINAL_DISPOSE, (event, id: string) => {
    if (!isTrustedIpcSender(event.sender)) return
    const session = ptySessions.get(id)
    if (!session) return
    try { session.pty.kill() } catch { /* already dead */ }
    ptySessions.delete(id)
    ptyTty.delete(id)
  })
  ipcMain.on(IPC.TERMINAL_FOCUS, (event, focused: boolean) => {
    if (!isTrustedIpcSender(event.sender)) return
    if (focused) terminalFocusedWcIds.add(event.sender.id)
    else terminalFocusedWcIds.delete(event.sender.id)
  })

  handle(IPC.CUSTOM_THEMES_LIST, () => listCustomThemes())
  handle(IPC.CUSTOM_THEMES_GET_DIR, () => getCustomThemesDir())
  handle(IPC.CUSTOM_THEMES_REVEAL, async (_event, slug?: string) => {
    shell.showItemInFolder(await customThemeRevealTarget(slug))
  })
  handle(IPC.CUSTOM_THEMES_DELETE, async (_event, slug: string) => {
    await deleteCustomTheme(slug)
  })
  handle(IPC.CUSTOM_THEMES_CREATE, (_event, input: { name?: string }) => createCustomTheme(input))
  handle(IPC.OVERRIDES_LIST, () => listOverrides())
  handle(IPC.OVERRIDES_REVEAL, async (_event, name?: string) => {
    shell.showItemInFolder(await overrideRevealTarget(name))
  })
  handle(IPC.OVERRIDES_DELETE, async (_event, name: string) => {
    await deleteOverride(name)
  })
  handle(IPC.DEVTOOLS_TOGGLE, (event) => {
    const wc = event.sender
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  })
}

/** Push an externally-changed config (synced dotfile / hand-edit) to every
 *  open renderer so live-reload applies it without a restart. */
function broadcastConfigChange(next: AppConfigPortable): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.CONFIG_ON_CHANGE, next)
  }
}

/** Push the freshly-scanned custom themes to every renderer on a file change. */
function broadcastCustomThemesChange(next: CustomTheme[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.CUSTOM_THEMES_ON_CHANGE, next)
  }
}

/** Push the freshly-scanned overrides to every renderer on a file change. */
function broadcastOverridesChange(next: Override[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.OVERRIDES_ON_CHANGE, next)
  }
}

/**
 * Pop a note out into a standalone always-visible window. The same
 * note is reused if a floating window is already showing it — we just
 * focus the existing one rather than spawning duplicates.
 */
const floatingNoteWindows = new Map<string, BrowserWindow>()
function openFloatingNoteWindow(relPath: string): void {
  const floatingWindowStartedAt = performance.now()
  const sourceWindow = currentIpcWindow() ?? mainWindow
  const sourceVault =
    sourceWindow && !sourceWindow.isDestroyed() ? windowVaults.vaultForWindow(sourceWindow.id) : currentVault
  const floatingKey = `${sourceVault?.root ?? 'no-vault'}:${relPath}`
  const existing = floatingNoteWindows.get(floatingKey)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return
  }
  const mac = isMac()
  const win = new BrowserWindow({
    width: 720,
    height: 720,
    minWidth: STANDALONE_MIN_WINDOW_WIDTH,
    minHeight: STANDALONE_MIN_WINDOW_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    ...(mac
      ? {
          backgroundColor: MAC_WINDOW_BACKGROUND_COLOR
        }
      : {
          backgroundColor: '#faf7f0',
          icon: windowIconPath()
        }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // Keep the renderer isolated and node-free, but the current preload
      // still relies on Node/Electron APIs that are not available inside a
      // fully sandboxed preload context.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window: keep this editor renderer live when the
      // OS backgrounds/occludes it, so Vim keys and shortcuts don't freeze. (#350)
      backgroundThrottling: false
    }
  })

  floatingNoteWindows.set(floatingKey, win)
  win.on('closed', () => {
    floatingNoteWindows.delete(floatingKey)
    windowVaults.clearWindow(win.id)
  })
  win.on('ready-to-show', () => {
    recordMainPerf('main.floating-window.ready-to-show', performance.now() - floatingWindowStartedAt, {
      path: relPath
    })
    win.show()
  })
  win.webContents.once('did-finish-load', () => {
    recordMainPerf(
      'main.floating-window.did-finish-load',
      performance.now() - floatingWindowStartedAt,
      { path: relPath }
    )
  })
  installNavigationGuards(win)
  applyZoomFactor(win, currentZoomFactor)
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  }

  const params = `?floating=1&note=${encodeURIComponent(relPath)}`
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }
}

/**
 * Quick capture window — a small always-on-top floating panel that
 * appears anywhere via a system-wide hotkey. Singleton, hide-on-close
 * (so the second invocation is instant), and lets the user dump text
 * into a brand-new note or append to an existing one.
 */
let quickCaptureWindow: BrowserWindow | null = null
let quickCaptureQuitting = false
let registeredQuickCaptureHotkey: string | null = null
/** When true, the quick-capture window stays pinned on top and does not
 *  auto-hide on blur. Mirrors PersistedConfig.quickCapturePinned. */
let quickCapturePinned = false
/** True when the panel was summoned while ZenNotes was NOT the frontmost app
 *  (the global hotkey fired from another app). On dismiss we then hide the
 *  whole app so macOS hands focus back to that app instead of surfacing
 *  ZenNotes' main window — the Spotlight/Raycast feel. Recomputed on every
 *  show; consumed (reset to false) on the next dismiss. */
let quickCaptureReturnFocus = false

async function ensureQuickCaptureWindow(): Promise<BrowserWindow> {
  if (quickCaptureWindow && !quickCaptureWindow.isDestroyed()) return quickCaptureWindow
  const mac = isMac()
  const sourceWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
  const win = new BrowserWindow({
    width: 620,
    // Tall enough to fully show the `/` slash-command menu (its list caps at
    // 320px) without it spilling past the window edge. (#182)
    height: 480,
    minWidth: 460,
    minHeight: 400,
    title: 'ZenNotes Quick Capture',
    show: false,
    frame: false,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    // Centred on the header's text row, not the window's top edge. The header
    // is 44px tall (py-2.5 = 10px above and below a 24px row, set by the h-6
    // pin button), so its centre line is at y=22. `trafficLightPosition` is the
    // TOP of the 12px-tall button block, hence 22 - 6 = 16. At the old y=12 the
    // buttons centred at 18 and sat 4px above the title. Same arithmetic the
    // main window already uses: y=16 against an h-11 (44px) title bar.
    trafficLightPosition: { x: 12, y: 16 },
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: !mac,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: mac ? MAC_WINDOW_BACKGROUND_COLOR : '#faf7f0',
    ...(mac ? {} : { icon: windowIconPath() }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Same reason as the main window: keep this editor renderer live when the
      // OS backgrounds/occludes it, so Vim keys and shortcuts don't freeze. (#350)
      backgroundThrottling: false
    }
  })

  // NB: the "visible on all workspaces / over fullscreen" collection
  // behavior is applied only when pinned (see applyQuickCapturePinned).
  // Setting it unconditionally made macOS stop treating ZenNotes as a
  // regular app while the panel was frontmost — the app vanished from the
  // Dock and Cmd+Tab and the menu bar went inert.

  // Restore the persisted pin state for this freshly created window.
  void loadConfig().then((cfg) => {
    quickCapturePinned = cfg.quickCapturePinned
    applyQuickCapturePinned()
  })

  win.on('close', (event) => {
    if (quickCaptureQuitting) return
    event.preventDefault()
    hideQuickCaptureWindow(win)
  })
  win.on('closed', () => {
    if (quickCaptureWindow === win) quickCaptureWindow = null
    windowVaults.clearWindow(win.id)
  })
  // The panel intentionally does NOT auto-hide on blur. It stays put as a
  // floating window so you can click the main window or another app for
  // reference and come back to it. Dismiss it explicitly with Cmd/Ctrl+W
  // or by pressing the global hotkey again. (Pinned additionally floats
  // over all spaces / fullscreen — see applyQuickCapturePinned.)

  installNavigationGuards(win)
  applyZoomFactor(win, currentZoomFactor)
  if (sourceWindow && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  } else {
    await ipcWindowContext.run(win, async () => {
      await loadCurrentVaultFromConfig()
    })
  }

  const params = '?quickCapture=1'
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void win.loadURL(`${devServerUrl}${params}`)
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
      search: params.slice(1)
    })
  }

  quickCaptureWindow = win
  return win
}

/** Reflect the current pin state on the live quick-capture window. Pinned uses
 *  a higher always-on-top level so it floats above other apps and fullscreen. */
function applyQuickCapturePinned(): void {
  const win = quickCaptureWindow
  if (!win || win.isDestroyed()) return
  win.setAlwaysOnTop(true, quickCapturePinned ? 'screen-saver' : 'floating')
  // Joining all spaces / floating over fullscreen is a macOS-only,
  // pin-only behavior. When unpinned we leave the panel as an ordinary
  // floating window so macOS keeps presenting ZenNotes as a regular app
  // (Dock icon, Cmd+Tab, working menu bar).
  if (isMac()) {
    win.setVisibleOnAllWorkspaces(quickCapturePinned, {
      visibleOnFullScreen: quickCapturePinned
    })
  }
}

/** Dismiss the quick-capture panel. When it was summoned from another app,
 *  hide the whole app (macOS) so focus returns to that app rather than
 *  surfacing ZenNotes' main window. */
function hideQuickCaptureWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const returnFocus = quickCaptureReturnFocus
  quickCaptureReturnFocus = false
  win.hide()
  if (returnFocus && isMac()) app.hide()
}

/** Commit whatever is sitting in the quick-capture editor, silently. Same
 *  renderer-hook shape as `confirmWindowUnsavedPdfs`: the buffer, the editing
 *  mode and the save logic all live in the renderer, so main just asks it to
 *  save. No prompt and no cancel — by the time this runs the quit is already
 *  confirmed, and the alternative is throwing the text away. */
async function flushQuickCaptureDraft(): Promise<void> {
  const win = quickCaptureWindow
  if (!win || win.isDestroyed()) return
  const save = win.webContents
    .executeJavaScript('window.__zenFlushQuickCapture ? window.__zenFlushQuickCapture() : null')
    .catch((err) => {
      // Never let this wedge the quit — the worst case is losing the draft we
      // were trying to rescue, which is no worse than the old behaviour.
      console.error('[quit] failed to flush the quick capture draft', err)
    })
  // An unresponsive renderer must not hold the app open. Two writes at most,
  // so this is generous; matches the stage-2 flush's own timeout.
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
  await Promise.race([save, timeout])
}

/** Vaults the quick-capture panel can be pointed at: the local vaults held by
 *  open workspace windows, deduped by root, plus the panel's own current vault
 *  so the live destination is always in the list (a chosen vault is sticky, so
 *  it can outlive the window it came from). Sorted by name for a stable menu. */
function quickCaptureVaultChoices(): VaultInfo[] {
  const byRoot = new Map<string, VaultInfo>()
  for (const id of workspaceWindowIds) {
    if (windowVaults.isRemoteWindow(id)) continue
    const vault = windowVaults.vaultForWindow(id)
    if (vault) byRoot.set(vault.root, vault)
  }
  const panel = quickCaptureWindow
  if (panel && !panel.isDestroyed()) {
    const own = windowVaults.vaultForWindow(panel.id)
    if (own && !windowVaults.isRemoteWindow(panel.id)) byRoot.set(own.root, own)
  }
  return [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** The workspace window quick capture should inherit its vault from: whichever
 *  one is focused, else the one focused most recently. `mainWindow` is the last
 *  resort only — it is the oldest surviving window, so with several vaults open
 *  it is rarely the one the user means. */
function quickCaptureSourceWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && workspaceWindowIds.has(focused.id)) return focused
  if (lastFocusedWorkspaceWindowId != null) {
    const recent = BrowserWindow.fromId(lastFocusedWorkspaceWindowId)
    if (recent && !recent.isDestroyed()) return recent
  }
  return mainWindow
}

/** Bind the quick-capture window to the vault it should capture into. An
 *  explicit pick from its vault picker wins and is sticky across invocations
 *  (and restarts); otherwise it follows the window you were last working in. */
async function applyQuickCaptureVault(win: BrowserWindow): Promise<void> {
  const cfg = await loadConfig()
  const pinnedRoot = cfg.quickCaptureVaultRoot
  // A chosen vault holds even when no window has it open — the point of
  // "sticky" — but not if the folder has since gone away.
  if (pinnedRoot && (await isDirectory(pinnedRoot))) {
    windowVaults.setLocalVault(win.id, vaultInfo(pinnedRoot))
    return
  }
  const sourceWindow = quickCaptureSourceWindow()
  if (sourceWindow && sourceWindow.id !== win.id && !sourceWindow.isDestroyed()) {
    inheritWindowWorkspaceSession(sourceWindow, win)
  }
}

async function showQuickCaptureWindow(): Promise<void> {
  // Remember whether ZenNotes was already frontmost. If no ZenNotes window is
  // focused, the panel was summoned from another app (global hotkey / deep
  // link) — dismissing it should hand focus back to that app.
  quickCaptureReturnFocus = !BrowserWindow.getFocusedWindow()
  const win = await ensureQuickCaptureWindow()
  await applyQuickCaptureVault(win)
  win.show()
  win.focus()
  // The panel's renderer stays alive between hide/show, so tell it to re-read
  // the destination — the vault may have changed since it was last visible.
  if (!win.isDestroyed()) win.webContents.send(IPC.APP_QUICK_CAPTURE_VAULT_CHANGED)
}

async function toggleQuickCaptureWindow(): Promise<void> {
  const win = quickCaptureWindow
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
    hideQuickCaptureWindow(win)
    return
  }
  await showQuickCaptureWindow()
}

function unregisterQuickCaptureHotkey(): void {
  if (!registeredQuickCaptureHotkey) return
  try {
    globalShortcut.unregister(registeredQuickCaptureHotkey)
  } catch {
    // Ignore — Electron throws if the binding wasn't registered cleanly.
  }
  registeredQuickCaptureHotkey = null
}

function registerQuickCaptureHotkey(hotkey: string): { ok: boolean; error?: string } {
  unregisterQuickCaptureHotkey()
  const trimmed = hotkey.trim()
  if (!trimmed) return { ok: true }
  try {
    const ok = globalShortcut.register(trimmed, () => {
      console.info(`[zen:quick-capture] hotkey pressed: ${trimmed}`)
      void toggleQuickCaptureWindow()
    })
    if (!ok) {
      return { ok: false, error: `Failed to register quick capture hotkey: ${trimmed}` }
    }
    if (!globalShortcut.isRegistered(trimmed)) {
      return { ok: false, error: `Quick capture hotkey was not registered by the system: ${trimmed}` }
    }
    registeredQuickCaptureHotkey = trimmed
    console.info(`[zen:quick-capture] registered hotkey: ${trimmed}`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// Set the app name before the ready event so the dock / menu bar /
// About panel all show "ZenNotes" instead of the default "Electron"
// during dev. electron-builder handles this for packaged builds via
// `productName`, but in `npm run dev` we have to announce it ourselves.
app.setName('ZenNotes')
if (isMac()) {
  app.setAboutPanelOptions({
    applicationName: 'ZenNotes',
    applicationVersion: app.getVersion()
  })
}

function installAppMenu(): void {
  if (!isMac()) {
    // On Windows/Linux we keep `autoHideMenuBar: true` and skip the menu.
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'ZenNotes',
      submenu: [
        { label: 'About ZenNotes', role: 'about' },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => {
            void runMenuUpdateCheck()
          }
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            const target = BrowserWindow.getFocusedWindow() ?? mainWindow
            target?.webContents.send(IPC.APP_OPEN_SETTINGS)
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: 'Hide ZenNotes' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: 'Quit ZenNotes' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => {
            void openMarkdownFileViaDialog(BrowserWindow.getFocusedWindow() ?? mainWindow)
          }
        },
        {
          label: 'Open Vault in New Window…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => {
            void openVaultInNewWindow(BrowserWindow.getFocusedWindow() ?? mainWindow)
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Alt+I' },
        { type: 'separator' },
        {
          label: 'Actual Size',
          click: () => {
            void setWindowZoom(BrowserWindow.getFocusedWindow(), DEFAULT_ZOOM_FACTOR)
          }
        },
        {
          label: 'Zoom In',
          click: () => {
            void adjustWindowZoom(BrowserWindow.getFocusedWindow(), ZOOM_STEP)
          }
        },
        {
          label: 'Zoom Out',
          click: () => {
            void adjustWindowZoom(BrowserWindow.getFocusedWindow(), -ZOOM_STEP)
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        // Electron 41 leaves these macOS tab roles unlabeled unless the
        // template supplies text, which renders as blank Window menu rows.
        // Not `role: 'toggleTabBar'` — like mergeAllWindows below, that role
        // dispatches @selector(toggleTabBar:) up the responder chain with a
        // nil target, and it silently no-ops for these windows (same class
        // of unreliability). Calling win.toggleTabBar() directly, the same
        // JS method Zen mode already uses to hide/show the bar, works.
        {
          label: 'Toggle Tab Bar',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (DEBUG_TAB_CHROME) console.error('[toggle-tab-bar-debug] focused window', win?.id ?? null)
            if (!win) return
            if (DEBUG_TAB_CHROME && tabGroupsNative) {
              try {
                console.error(
                  '[toggle-tab-bar-debug] before',
                  JSON.stringify(tabGroupsNative.getChromeDebug(win.getNativeWindowHandle()))
                )
              } catch (err) {
                console.error('[toggle-tab-bar-debug] before failed', err)
              }
            }
            try {
              win.toggleTabBar()
              // Same flash nudgeWindowLayout already fixes for addTabbedWindow:
              // AppKit briefly renders the just-toggled chrome in a taller,
              // spread-out layout before settling into its compact one on its
              // own schedule. Forcing a layout pass immediately avoids the
              // visible flash.
              nudgeWindowLayout(win)
            } catch (err) {
              console.error('[window tabs] failed to toggle tab bar', err)
            }
            if (DEBUG_TAB_CHROME && tabGroupsNative) {
              try {
                console.error(
                  '[toggle-tab-bar-debug] after',
                  JSON.stringify(tabGroupsNative.getChromeDebug(win.getNativeWindowHandle()))
                )
              } catch (err) {
                console.error('[toggle-tab-bar-debug] after failed', err)
              }
            }
            void reconcileAndPersistTabGroups()
          }
        },
        { role: 'selectNextTab', label: 'Show Next Tab' },
        { role: 'selectPreviousTab', label: 'Show Previous Tab' },
        {
          label: 'Move Tab to New Window',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            if (!win) return
            win.moveTabToNewWindow()
            void reconcileAndPersistTabGroups()
          }
        },
        // Not `role: 'mergeAllWindows'` — that native action is unreliable
        // at grouping already-separate windows (see mergeAllVaultWindows).
        {
          label: 'Merge All Windows',
          click: () => mergeAllVaultWindows()
        },
        { type: 'separator' },
        { role: 'front' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'ZenNotes Website',
          click: () => {
            openAllowedExternalUrl(APP_WEBSITE_URL)
          }
        },
        {
          label: 'Join Discord',
          click: () => {
            openAllowedExternalUrl(APP_DISCORD_URL)
          }
        },
        { type: 'separator' },
        {
          label: 'GitHub Repository',
          click: () => {
            openAllowedExternalUrl(APP_REPOSITORY_URL)
          }
        },
        {
          label: 'Latest Release',
          click: () => {
            openAllowedExternalUrl(APP_RELEASES_URL)
          }
        },
        {
          label: 'Report an Issue',
          click: () => {
            openAllowedExternalUrl(APP_ISSUES_URL)
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function runMenuUpdateCheck(): Promise<void> {
  const parent = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
  const showDialog = async (
    options: Electron.MessageBoxOptions
  ): Promise<Electron.MessageBoxReturnValue> => {
    return parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  }
  const state = await checkForAppUpdates()

  if (state.phase === 'available') {
    const { response } = await showDialog({
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'ZenNotes Update Available',
      message: `ZenNotes ${state.availableVersion ?? ''} is available.`,
      detail: state.message
    })
    if (response === 0) {
      void downloadAppUpdate()
      await showDialog({
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Downloading Update',
        message: `ZenNotes ${state.availableVersion ?? ''} is downloading in the background.`,
        detail: 'Open Settings → About to track progress and install when the download finishes.'
      })
    }
    return
  }

  if (state.phase === 'downloaded') {
    const { response } = await showDialog({
      type: 'info',
      buttons: ['Install and Relaunch', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'ZenNotes Update Ready',
      message: `ZenNotes ${state.availableVersion ?? ''} is ready to install.`,
      detail: state.message
    })
    if (response === 0) {
      installAppUpdate()
    }
    return
  }

  if (state.phase === 'downloading' || state.phase === 'checking') {
    await showDialog({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
      title: 'ZenNotes Updates',
      message: state.phase === 'checking' ? 'Checking for updates…' : 'Downloading update…',
      detail: state.message
    })
    return
  }

  await showDialog({
    type: state.phase === 'error' ? 'warning' : 'info',
    buttons: ['OK'],
    defaultId: 0,
    title: 'ZenNotes Updates',
    message:
      state.phase === 'not-available'
        ? 'ZenNotes is up to date.'
        : state.phase === 'unsupported'
          ? 'Update checks are unavailable.'
          : state.phase === 'error'
            ? 'Could not check for updates.'
            : 'ZenNotes Updates',
    detail: state.message
  })
}

// On some Linux setups (notably NVIDIA + Fedora) Chromium's VAAPI probe fails
// with "vaInitialize failed: unknown libva error" because the driver doesn't
// expose a working libva. We don't use GPU video decode, so disable the VAAPI
// features to avoid the error and the failed-probe noise. Linux-only; must run
// before `app.whenReady()`.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder')
  // Wayland compositors (including Hyprland/Omarchy) expose global shortcuts
  // through xdg-desktop-portal, but Electron only wires that path when this
  // Chromium feature is enabled before app.whenReady().
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

app.whenReady().then(async () => {
  // The gap from `main.boot.module-loaded` to here is Chromium/GTK
  // initialization — on Linux this is where fontconfig cache rebuilds and
  // desktop-portal waits land, none of it our code.
  recordBootMark('main.boot.app-ready')
  // A second launch (e.g. double-clicking a .md on Windows/Linux) hands
  // its argv to the primary instance via 'second-instance' below, then
  // quits here so there's only ever one ZenNotes process.
  if (!gotSingleInstanceLock) {
    app.quit()
    return
  }

  // Force Chromium's renderer accessibility tree on. By default Chromium builds
  // it lazily, only once it detects an assistive client through the macOS
  // accessibility activation handshake. Tools that read the tree without
  // performing that handshake are otherwise left blind: they find the native
  // window but never see the CodeMirror contentEditable text. Enabling it
  // unconditionally exposes editor content to that whole class of accessibility
  // clients (e.g. the Grammarly desktop app and similar proofreaders, which
  // would otherwise show their UI but report nothing). macOS-only to avoid the
  // small always-on cost where it isn't needed.
  if (process.platform === 'darwin') {
    app.setAccessibilitySupportEnabled(true)
  }

  await migrateLegacyRemoteWorkspaceSecrets()

  protocol.handle(LOCAL_ASSET_SCHEME, async (request) => {
    const remote = decodeRemoteAssetRequest(request.url)
    if (remote) {
      const client = remoteWorkspaceClient
      if (!client || client.baseUrl !== remote.baseUrl) {
        throw new Error(`No remote workspace client for ${remote.baseUrl}`)
      }
      const response = await client.fetchAssetResponse(remote.relPath)
      return response
    }

    const abs = decodeLocalAssetRequestPath(request.url)
    if (!abs || !windowVaults.isPathInsideOpenLocalVault(abs)) {
      throw new Error(`Invalid local asset URL: ${request.url}`)
    }
    return await serveLocalFileResponse(abs, request)
  })

  // Theme-relative assets: url(zen-theme://<slug>/<file>) in a custom theme's
  // CSS, served sandboxed to that theme's own folder.
  protocol.handle(THEME_ASSET_SCHEME, async (request) => {
    // Parse host=slug + path by hand so the slug keeps its case (new URL()
    // would lowercase the hostname, breaking case-sensitive filesystems).
    const without = request.url.slice(`${THEME_ASSET_SCHEME}://`.length).split(/[?#]/)[0]
    const slashIdx = without.indexOf('/')
    const rawSlug = slashIdx === -1 ? without : without.slice(0, slashIdx)
    const rel = slashIdx === -1 ? '' : without.slice(slashIdx + 1)
    let slug: string
    try {
      slug = decodeURIComponent(rawSlug)
    } catch {
      throw new Error(`Invalid theme asset URL: ${request.url}`)
    }
    const abs = resolveThemeAssetPath(slug, rel)
    if (!abs) throw new Error(`Invalid theme asset URL: ${request.url}`)
    const data = await fsp.readFile(abs)
    return new Response(data, {
      headers: {
        'content-type': mimeTypeForPath(abs),
        'cache-control': 'no-cache'
      }
    })
  })

  // Excalidraw's bundled fonts (dist/prod/fonts), served locally so the font
  // picker works offline. With EXCALIDRAW_ASSET_PATH unset Excalidraw fetches its
  // fonts from esm.sh, which the renderer CSP blocks, so nothing applied (#324). A
  // packaged build ships only out/**, so the fonts are copied to
  // resources/excalidraw-fonts (extraResources); dev reads them from node_modules.
  const excalidrawFontsDir = (): string => {
    if (app.isPackaged) return path.join(process.resourcesPath, 'excalidraw-fonts')
    // The package `exports` map blocks resolving package.json, so derive the
    // fonts dir from the main entry (.../dist/prod/index.js -> .../dist/prod/fonts).
    const entry = nodeRequire.resolve('@excalidraw/excalidraw')
    return path.join(path.dirname(entry), 'fonts')
  }
  const excalidrawFontMime = (p: string): string =>
    /\.woff2$/i.test(p)
      ? 'font/woff2'
      : /\.woff$/i.test(p)
        ? 'font/woff'
        : /\.otf$/i.test(p)
          ? 'font/otf'
          : /\.ttf$/i.test(p)
            ? 'font/ttf'
            : 'application/octet-stream'
  protocol.handle(EXCALIDRAW_ASSET_SCHEME, async (request) => {
    // zen-excalidraw://assets/fonts/<Family>/<file> -> <fontsDir>/<Family>/<file>
    const rel = decodeURIComponent(new URL(request.url).pathname)
      .replace(/^\/+/, '')
      .replace(/^fonts\//, '')
    const root = path.resolve(excalidrawFontsDir())
    const abs = path.resolve(root, rel)
    if ((abs !== root && !abs.startsWith(root + path.sep)) || !/\.(woff2?|otf|ttf)$/i.test(abs)) {
      throw new Error(`Invalid Excalidraw font URL: ${request.url}`)
    }
    const data = await fsp.readFile(abs)
    return new Response(data, {
      headers: {
        'content-type': excalidrawFontMime(abs),
        'cache-control': 'public, max-age=31536000, immutable'
      }
    })
  })

  protocol.handle(TYPST_ASSET_SCHEME, async (request) => {
    // zen-typst://asset/<file> -> out/renderer/assets/<file> (the renderer's own
    // bundled assets, next to its JS chunks). The renderer only ever requests
    // the hashed Typst wasm and .otf fonts it imported, so this is a fixed,
    // read-only view of the build output, scoped to those two asset kinds.
    const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '')
    const root = path.resolve(__dirname, '../renderer/assets')
    const abs = path.resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Invalid Typst asset URL: ${request.url}`)
    }
    const contentType = /\.wasm$/i.test(abs)
      ? 'application/wasm'
      : /\.otf$/i.test(abs)
        ? 'font/otf'
        : null
    if (!contentType) throw new Error(`Invalid Typst asset URL: ${request.url}`)
    const data = await fsp.readFile(abs)
    return new Response(data, {
      headers: {
        'content-type': contentType,
        'cache-control': 'public, max-age=31536000, immutable'
      }
    })
  })

  // Permissions this app grants to its own renderer (deny everything else —
  // it's our app talking to our own vault, no third-party surface):
  //   - 'local-fonts'   → queryLocalFonts() for the font picker
  //   - clipboard read/write → copy buttons and vim's "+y / "+p registers
  //     (without this, navigator.clipboard throws NotAllowedError, which on
  //     macOS and Wayland broke yank/paste to the system clipboard — #79)
  //   - 'fileSystem'    → the File System Access API (showSaveFilePicker +
  //     createWritable) behind Excalidraw's "Export image → Save to disk". The
  //     native picker shows regardless, but the *write* is gated on this
  //     permission check; denying it made every PNG/SVG drawing export fail
  //     right after the save dialog with a filesystem write error (#355). The
  //     path is user-initiated and user-picked, so granting it is safe.
  const GRANTED_PERMISSIONS = new Set<string>([
    'local-fonts',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fileSystem'
  ])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED_PERMISSIONS.has(permission as string))
  })
  // writeText()/readText() gate on the synchronous check handler, not the
  // async request handler — grant the same set here or they still fail.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    GRANTED_PERMISSIONS.has(permission as string)
  )

  // `renderEmbeds` drops YouTube/Vimeo players into iframes. The packaged app
  // loads over file://, so those requests carry a null Referer/Origin and the
  // providers reject the embed (YouTube "Error 153"). Give them a valid
  // same-site referrer so the player loads, matching what a normal web embed
  // sends. Scoped to the exact embed hosts.
  const EMBED_REFERERS: Record<string, string> = {
    'www.youtube-nocookie.com': 'https://zennotes.app/',
    'player.vimeo.com': 'https://zennotes.app/'
  }
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://www.youtube-nocookie.com/*', 'https://player.vimeo.com/*'] },
    (details, callback) => {
      try {
        const referer = EMBED_REFERERS[new URL(details.url).hostname]
        if (referer) details.requestHeaders['Referer'] = referer
      } catch {
        /* leave headers unchanged on a malformed URL */
      }
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // macOS dock icon. `BrowserWindow.icon` has no effect on macOS — the
  // dock picks up whatever the running binary advertises. During
  // `npm run dev` that's Electron's default, so we force our own.
  if (isMac() && app.dock) {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png')
      app.dock.setIcon(iconPath)
    } catch (err) {
      console.error('Failed to set dock icon', err)
    }
  }

  // Load the portable config from disk before any window opens so the
  // preload's synchronous getConfigSync() returns real data on first paint.
  await initAppConfig(broadcastConfigChange)

  // Custom user themes live alongside the config dotfile. Seed the dir on first
  // run, then watch it so edits apply live. Await the seed so the watcher
  // attaches to a directory that already exists.
  await ensureCustomThemesDir().catch(() => {})
  startWatchingCustomThemes(broadcastCustomThemesChange)

  // CSS overrides live in a sibling dir; same seed-then-watch dance.
  await ensureOverridesDir().catch(() => {})
  startWatchingOverrides(broadcastOverridesChange)

  installAppMenu()
  registerIpc()
  initAppUpdater()
  registerAppDeepLinkProtocol()
  const startupDeepLinkResult = handleStartupDeepLinks(process.argv)
  handleStartupMarkdownArgs(process.argv, true)

  // Honor a file ZenNotes was launched to open before falling back to a
  // default-vault window, so double-clicking a .md doesn't also pop an
  // unrelated window.
  // The Space we're launching on. Restored windows are shown *inactive* and
  // then relocated, so nothing drags the user off this Space; at the end we
  // focus a window that belongs here (if any).
  const launchSpaceId = nativeCurrentDisplaySpaceId()
  if (DEBUG_WINDOW_SPACES) console.error('[window spaces] launch space', launchSpaceId)
  startWindowSpaceSweep()

  const openedFromFile = await flushPendingFileOpens()
  if (!openedFromFile && startupDeepLinkResult !== 'quick-capture') {
    const startupCfg = await loadConfig()
    const sessions = (startupCfg.openWindows ?? []).filter((s) => s.root && s.windowId)
    if (sessions.length > 0) {
      const restoredByWindowId = new Map<string, BrowserWindow>()
      for (const session of sessions) {
        try {
          const win = await createWindow({
            initialVaultRoot: session.root,
            windowId: session.windowId,
            windowState: session.windowState,
            restoreSpaceId: session.spaceId,
            persistInitialVault: true
          })
          restoredByWindowId.set(session.windowId, win)
        } catch (err) {
          console.error('[session restore] failed to restore window', session.windowId, err)
        }
      }
      // Native tab-group membership doesn't survive quitting the app — macOS
      // doesn't persist it — so it's rebuilt here from the tabGroupId
      // sessions were saved with, re-merging windows that shared a group in
      // the order they were saved. (Once these windows exist, the real
      // grouping can be read straight back via the tab-groups addon, so no
      // further bookkeeping is needed after this point.)
      const restoredGroups = new Map<string, BrowserWindow[]>()
      for (const session of sessions) {
        if (!session.tabGroupId) continue
        const win = restoredByWindowId.get(session.windowId)
        if (!win || win.isDestroyed()) continue
        const members = restoredGroups.get(session.tabGroupId) ?? []
        members.push(win)
        restoredGroups.set(session.tabGroupId, members)
      }
      for (const members of restoredGroups.values()) {
        if (members.length < 2) continue
        const [anchor, ...rest] = members
        for (const win of rest) {
          try {
            anchor.addTabbedWindow(win)
          } catch (err) {
            console.error('[window tabs] failed to restore tab group', err)
          }
        }
      }
      // Everything was shown inactive so the restore wouldn't drag the user
      // across Spaces. Now give focus to a window that actually lives on the
      // Space we launched on; if none does, deliberately focus nothing rather
      // than pulling the user somewhere else.
      if (launchSpaceId) {
        const onLaunchSpace = sessions
          .filter((s) => s.spaceId === launchSpaceId)
          .map((s) => restoredByWindowId.get(s.windowId))
          .find((w): w is BrowserWindow => !!w && !w.isDestroyed())
        if (onLaunchSpace) {
          if (DEBUG_WINDOW_SPACES) {
            console.error('[window spaces] focusing window on launch space', windowUuids.get(onLaunchSpace.id))
          }
          onLaunchSpace.focus()
        } else if (DEBUG_WINDOW_SPACES) {
          console.error('[window spaces] no restored window belongs on the launch space; focusing nothing')
        }
      }
      if (BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && isWorkspaceWindow(w)).length === 0) {
        await ensureMainWindow()
      }
    } else {
      await ensureMainWindow()
    }
  }
  void flushPendingFloatingNoteRequests()
  scheduleBackgroundAppUpdateCheck()

  try {
    const cfg = await loadConfig()
    const desired = cfg.quickCaptureHotkey || DEFAULT_QUICK_CAPTURE_HOTKEY
    const result = registerQuickCaptureHotkey(desired)
    if (!result.ok) console.warn(result.error ?? `Failed to bind ${desired}`)
  } catch (err) {
    console.warn('Quick capture hotkey registration failed', err)
  }

  app.on('activate', () => {
    // Count only real workspace windows: a hidden quick-capture panel
    // (or other utility window) must not stop the dock click from
    // bringing back a usable window.
    const hasWorkspaceWindow = BrowserWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && isWorkspaceWindow(win)
    )
    if (!hasWorkspaceWindow) void ensureMainWindow()
  })

  app.on('new-window-for-tab', () => {
    const sourceWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    void createWindow({
      inheritWorkspaceFrom: sourceWindow,
      persistInitialVault: false
    }).then((win) => {
      // The native "+" only appears once a real tab group exists, but
      // relying on tabbingIdentifier alone to slot the new window in has
      // proven unreliable, so make the attachment explicit.
      if (sourceWindow && !sourceWindow.isDestroyed()) {
        sourceWindow.addTabbedWindow(win)
        nudgeWindowLayout(sourceWindow)
        void reconcileAndPersistTabGroups()
      }
    })
  })

  appStartupComplete = true
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (handleExternalOpenUrl(url) === 'none') {
    console.warn(`Ignoring unsupported ${ZENNOTES_DEEP_LINK_SCHEME} URL: ${url}`)
  }
})

// macOS delivers Finder "Open With" / double-click / dock-drop here.
// During cold start this can fire before the app is ready, so the
// request is queued and flushed in whenReady; reuse the main window for
// the launch file but spawn a fresh window once we're already running.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  queueMarkdownFileOpen(filePath, !appStartupComplete)
})

// Windows/Linux: a relaunch (e.g. opening a .md while ZenNotes is
// already running) forwards its argv here instead of starting a second
// process.
app.on('second-instance', (_event, argv) => {
  const deepLinkResult = handleStartupDeepLinks(argv)
  handleStartupMarkdownArgs(argv, false)
  if (deepLinkResult === 'quick-capture') return
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusWindow(mainWindow)
    return
  }
  void ensureMainWindow()
})

app.on('window-all-closed', () => {
  windowVaults.stopAll()
  stopRemoteWatch()
  if (!isMac()) app.quit()
})

// Nothing here previously waited for pending async writes, so a tab-group
// merge or window-state change made right before quitting could lose the
// write entirely — Electron doesn't drain in-flight promises on its own once
// quit is confirmed, it just tears the process down once every window is
// closed. Flush every open window's state once, then let the real quit
// through; the guard flag stops this from looping (app.quit() below
// re-fires 'before-quit' for the actual, final quit). Capped with a timeout
// so a stuck write can't leave the app refusing to quit.
// Ask each workspace renderer whether it's OK to quit with unsaved PDF
// highlights. The unsaved state and the Save/Discard/Cancel dialog live in the
// renderer, so main reaches it via a hook the app installs on `window`.
// Resolves false if the user cancels in any window.
async function confirmUnsavedPdfsBeforeQuit(): Promise<boolean> {
  const wins = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isWorkspaceWindow(win)
  )
  for (const win of wins) {
    if (!(await confirmWindowUnsavedPdfs(win))) return false
  }
  return true
}

let quitUnsavedConfirmed = false
let quitConfirmInFlight = false
let quitDraftFlushed = false
let quitDraftFlushInFlight = false
let quitFlushDone = false
app.on('before-quit', (event) => {
  // Stage 1: unsaved-highlights confirmation, BEFORE any teardown — so a
  // cancel leaves the app fully functional (watchers, hotkeys still live).
  if (!quitUnsavedConfirmed) {
    event.preventDefault()
    if (quitConfirmInFlight) return
    quitConfirmInFlight = true
    void confirmUnsavedPdfsBeforeQuit().then((proceed) => {
      quitConfirmInFlight = false
      if (!proceed) return // user cancelled — stay running, nothing torn down
      quitUnsavedConfirmed = true
      appIsQuitting = true // per-window close guards must not re-prompt now
      app.quit() // re-fires before-quit, now past the guard
    })
    return
  }

  // Stage 1.5: rescue an undismissed quick-capture draft. This has to happen
  // BEFORE the stage-2 teardown below, because `windowVaults.stopAll()` clears
  // the per-window vault sessions — the save would then have no vault to
  // resolve against and would either fail or, worse, fall back to the wrong
  // one. Runs only once the quit is confirmed, so cancelling stage 1 doesn't
  // silently commit a note.
  if (!quitDraftFlushed) {
    event.preventDefault()
    if (quitDraftFlushInFlight) return
    quitDraftFlushInFlight = true
    void flushQuickCaptureDraft().finally(() => {
      quitDraftFlushed = true
      app.quit() // re-fires before-quit, now past this stage
    })
    return
  }

  // Stage 2+: teardown + state flush (unchanged), only reached once the quit
  // is confirmed.
  windowVaults.stopAll()
  stopRemoteWatch()
  quickCaptureQuitting = true
  unregisterQuickCaptureHotkey()
  if (quitFlushDone) return
  event.preventDefault()
  const vaultWindows = BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && isWorkspaceWindow(win)
  )
  const flush = Promise.all(vaultWindows.map((win) => persistWindowState(win)))
    .then(() => reconcileAndPersistTabGroups())
    .catch((err) => console.error('[quit] failed to flush window state before quitting', err))
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
  void Promise.race([flush, timeout]).then(() => {
    quitFlushDone = true
    app.quit()
  })
})
