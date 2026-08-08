import { execFile } from 'node:child_process'
import { promises as fsp, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// A login shell can be slow if the user's profile is heavy; cap it so a stuck
// shell never blocks search. Resolution is memoized, so this runs rarely.
const LOGIN_SHELL_TIMEOUT_MS = 5_000
// Memoize resolved locations so we don't spawn a shell on every capability
// check / search. Short enough to self-heal after a tool is installed mid-run.
const RESOLUTION_TTL_MS = 60_000

// Binary names are interpolated into a shell `command -v` invocation, so only
// ever accept bare tokens — never anything that could break out of the word.
const SAFE_COMMAND = /^[A-Za-z0-9._-]+$/

const cache = new Map<string, { at: number; value: string | null }>()
let pathDirsCache: { at: number; value: string[] } | null = null

/**
 * Resolve a command to an absolute path using the user's login shell.
 *
 * GUI apps launched from Finder/Dock on macOS (and similar elsewhere) inherit
 * only a minimal PATH (e.g. `/usr/bin:/bin:/usr/sbin:/sbin`), so tools
 * installed by Homebrew, cargo, npm, nix, etc. aren't resolvable by their bare
 * name. Spawning a *login* shell (`$SHELL -lc 'command -v <cmd>'`) queries the
 * PATH the user actually has configured — the same approach the CLI-install and
 * Raycast integrations already use to locate their tools.
 *
 * Returns the absolute path, or `null` when the command can't be resolved —
 * including on Windows, where GUI apps already inherit the full PATH and the
 * POSIX login-shell trick doesn't apply (callers should fall back to the bare
 * command name there).
 */
export async function resolveCommandViaLoginShell(command: string): Promise<string | null> {
  if (!SAFE_COMMAND.test(command)) return null
  if (process.platform === 'win32') return null

  const cached = cache.get(command)
  if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached.value

  const value = await queryLoginShell(command)
  cache.set(command, { at: Date.now(), value })
  return value
}

/**
 * The PATH directories the user's login shell actually has, which on macOS is
 * not the PATH this process was given.
 *
 * Anything asking "will the user be able to type this command in a terminal?"
 * has to ask the login shell, not `process.env.PATH`. A Finder or Dock launch
 * inherits launchd's `/usr/bin:/bin:/usr/sbin:/sbin` and never reads the
 * profile, so the CLI installer told people `~/.local/bin` was missing from
 * their PATH while their shell had it all along (#528). A terminal launch DOES
 * inherit the real PATH, which is why this never shows up in development.
 *
 * Empty on Windows (GUI apps there already have the full PATH) and whenever no
 * shell answers; callers fall back to `process.env.PATH`.
 */
export async function resolveLoginShellPathDirs(): Promise<string[]> {
  if (process.platform === 'win32') return []

  const cached = pathDirsCache
  if (cached && Date.now() - cached.at < RESOLUTION_TTL_MS) return cached.value

  const value = await queryLoginShellPathDirs()
  pathDirsCache = { at: Date.now(), value }
  return value
}

async function queryLoginShellPathDirs(): Promise<string[]> {
  for (const shellPath of loginShells()) {
    try {
      await fsp.access(shellPath, fsConstants.X_OK)
      // `printf` rather than `echo` so a PATH entry that looks like a flag
      // cannot be eaten, and no trailing newline has to be trimmed off.
      const { stdout } = await execFileAsync(shellPath, ['-lc', 'printf %s "$PATH"'], {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      })
      const dirs = String(stdout)
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
      if (dirs.length > 0) return dirs
    } catch {
      /* shell missing here, or it refused -lc — try the next one */
    }
  }
  return []
}

/** The user's own shell first, then the standard POSIX ones. Those still pick
 *  up the login PATH from the system/user profile even when the user's
 *  interactive shell is something exotic (fish, nu) whose syntax differs. */
function loginShells(): string[] {
  return Array.from(
    new Set([process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean))
  ) as string[]
}

async function queryLoginShell(command: string): Promise<string | null> {
  for (const shellPath of loginShells()) {
    try {
      await fsp.access(shellPath, fsConstants.X_OK)
      const { stdout } = await execFileAsync(shellPath, ['-lc', `command -v ${command}`], {
        encoding: 'utf8',
        timeout: LOGIN_SHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      })
      const resolved = String(stdout).trim().split(/\r?\n/)[0]?.trim()
      if (resolved && path.isAbsolute(resolved)) return resolved
    } catch {
      /* shell missing here, or command not found in it — try the next one */
    }
  }
  return null
}
