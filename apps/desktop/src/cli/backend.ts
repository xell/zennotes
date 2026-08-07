/**
 * The seam that lets every `zn` command work against a local folder or a
 * self-hosted ZenNotes server (#493).
 *
 * Commands used to take a `vault: string` root and call the filesystem-backed
 * vault-ops directly, which is why the CLI was the one client that couldn't
 * reach a server the desktop and web apps were both already talking to. They
 * now take a VaultBackend: the same set of operations, bound either to a root
 * on disk or to a server over HTTP.
 *
 * The remote implementations lean on the pure body transforms exported by
 * vault-ops rather than reimplementing them, so `zn append` composes the same
 * bytes whichever end of the wire the note lives on. Where the server has no
 * endpoint for something (there is no task-toggle route, and note creation
 * takes no body), the operation is composed from the routes that do exist.
 */

import {
  appendToBody,
  appendToNote,
  archiveNote,
  backlinks,
  backlinksIn,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  duplicateNote,
  listFolders,
  listNotes,
  moveNote,
  moveToTrash,
  parseTaskIndex,
  prependToBody,
  prependToNote,
  readNote,
  renameFolder,
  renameNote,
  restoreFromTrash,
  scanAllTasks,
  searchText,
  splitTaskId,
  toggleFileTaskInBody,
  toggleTask,
  toggleTaskInBody,
  unarchiveNote,
  writeNote,
  type NoteContent,
  type NoteFolder,
  type NoteMeta,
  type VaultTask,
  type VaultTextSearchMatch
} from '../mcp/vault-ops.js'
import { CliRemoteClient } from './remote/client.js'
import type { VaultTarget } from './vault-target.js'

export interface VaultBackend {
  readonly kind: 'local' | 'remote'
  /** How to name this vault in output and errors. */
  readonly label: string
  /** The vault root on disk. Empty for a remote vault — `zn open` uses this
   *  to resolve vault-relative paths and has nothing to resolve against. */
  readonly root: string

  listNotes(): Promise<NoteMeta[]>
  listFolders(): Promise<{ folder: NoteFolder; subpath: string }[]>
  readNote(rel: string): Promise<NoteContent>
  writeNote(rel: string, body: string): Promise<NoteMeta>
  createNote(
    folder: NoteFolder,
    title?: string,
    subpath?: string,
    body?: string
  ): Promise<NoteMeta>
  appendToNote(rel: string, text: string): Promise<NoteMeta>
  prependToNote(rel: string, text: string): Promise<NoteMeta>
  renameNote(rel: string, nextTitle: string): Promise<NoteMeta>
  moveNote(rel: string, folder: NoteFolder, subpath: string): Promise<NoteMeta>
  archiveNote(rel: string): Promise<NoteMeta>
  unarchiveNote(rel: string): Promise<NoteMeta>
  moveToTrash(rel: string): Promise<NoteMeta>
  restoreFromTrash(rel: string): Promise<NoteMeta>
  duplicateNote(rel: string): Promise<NoteMeta>
  deleteNote(rel: string): Promise<void>
  createFolder(folder: NoteFolder, subpath: string): Promise<void>
  renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string>
  deleteFolder(folder: NoteFolder, subpath: string): Promise<void>
  searchText(query: string, limit: number): Promise<VaultTextSearchMatch[]>
  backlinks(rel: string): Promise<NoteMeta[]>
  scanAllTasks(): Promise<VaultTask[]>
  toggleTask(taskId: string): Promise<VaultTask | null>
}

export function createBackend(target: VaultTarget): VaultBackend {
  return target.kind === 'remote' ? new RemoteBackend(target) : new LocalBackend(target.root)
}

/** A vault on this machine. Every method is vault-ops bound to one root. */
class LocalBackend implements VaultBackend {
  readonly kind = 'local' as const

  constructor(readonly root: string) {}

  get label(): string {
    return this.root
  }

  listNotes = (): Promise<NoteMeta[]> => listNotes(this.root)
  listFolders = (): Promise<{ folder: NoteFolder; subpath: string }[]> => listFolders(this.root)
  readNote = (rel: string): Promise<NoteContent> => readNote(this.root, rel)
  writeNote = (rel: string, body: string): Promise<NoteMeta> => writeNote(this.root, rel, body)
  createNote = (
    folder: NoteFolder,
    title?: string,
    subpath = '',
    body?: string
  ): Promise<NoteMeta> => createNote(this.root, folder, title, subpath, body)
  appendToNote = (rel: string, text: string): Promise<NoteMeta> =>
    appendToNote(this.root, rel, text)
  prependToNote = (rel: string, text: string): Promise<NoteMeta> =>
    prependToNote(this.root, rel, text)
  renameNote = (rel: string, nextTitle: string): Promise<NoteMeta> =>
    renameNote(this.root, rel, nextTitle)
  moveNote = (rel: string, folder: NoteFolder, subpath: string): Promise<NoteMeta> =>
    moveNote(this.root, rel, folder, subpath)
  archiveNote = (rel: string): Promise<NoteMeta> => archiveNote(this.root, rel)
  unarchiveNote = (rel: string): Promise<NoteMeta> => unarchiveNote(this.root, rel)
  moveToTrash = (rel: string): Promise<NoteMeta> => moveToTrash(this.root, rel)
  restoreFromTrash = (rel: string): Promise<NoteMeta> => restoreFromTrash(this.root, rel)
  duplicateNote = (rel: string): Promise<NoteMeta> => duplicateNote(this.root, rel)
  deleteNote = (rel: string): Promise<void> => deleteNote(this.root, rel)
  createFolder = (folder: NoteFolder, subpath: string): Promise<void> =>
    createFolder(this.root, folder, subpath).then(() => undefined)
  renameFolder = (folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> =>
    renameFolder(this.root, folder, oldSubpath, newSubpath)
  deleteFolder = (folder: NoteFolder, subpath: string): Promise<void> =>
    deleteFolder(this.root, folder, subpath)
  searchText = (query: string, limit: number): Promise<VaultTextSearchMatch[]> =>
    searchText(this.root, query, limit)
  backlinks = (rel: string): Promise<NoteMeta[]> => backlinks(this.root, rel)
  scanAllTasks = (): Promise<VaultTask[]> => scanAllTasks(this.root)
  toggleTask = (taskId: string): Promise<VaultTask | null> => toggleTask(this.root, taskId)
}

/** A vault behind a self-hosted server, reached over the same HTTP API the
 *  desktop and web clients use. */
class RemoteBackend implements VaultBackend {
  readonly kind = 'remote' as const
  readonly root = ''
  readonly label: string
  private readonly client: CliRemoteClient

  constructor(target: Extract<VaultTarget, { kind: 'remote' }>) {
    this.label = target.name ? `${target.name} (${target.baseUrl})` : target.baseUrl
    this.client = new CliRemoteClient(target.baseUrl, target.authToken)
  }

  listNotes = (): Promise<NoteMeta[]> => this.client.listNotes()
  listFolders = (): Promise<{ folder: NoteFolder; subpath: string }[]> =>
    this.client.listFolders()
  readNote = (rel: string): Promise<NoteContent> => this.client.readNote(rel)
  writeNote = (rel: string, body: string): Promise<NoteMeta> => this.client.writeNote(rel, body)

  /** Two round trips: the server's create route takes no body, so a note with
   *  content is created and then written. */
  createNote = async (
    folder: NoteFolder,
    title?: string,
    subpath = '',
    body?: string
  ): Promise<NoteMeta> => {
    if (folder === 'trash') throw new Error('Refusing to create a note directly in trash/')
    const meta = await this.client.createNote(folder, title, subpath)
    if (body == null) return meta
    return await this.client.writeNote(meta.path, body)
  }

  appendToNote = async (rel: string, text: string): Promise<NoteMeta> => {
    const note = await this.client.readNote(rel)
    return await this.client.writeNote(rel, appendToBody(note.body, text))
  }

  prependToNote = async (rel: string, text: string): Promise<NoteMeta> => {
    const note = await this.client.readNote(rel)
    return await this.client.writeNote(rel, prependToBody(note.body, text))
  }

  renameNote = (rel: string, nextTitle: string): Promise<NoteMeta> =>
    this.client.renameNote(rel, nextTitle)
  moveNote = (rel: string, folder: NoteFolder, subpath: string): Promise<NoteMeta> =>
    this.client.moveNote(rel, folder, subpath)
  archiveNote = (rel: string): Promise<NoteMeta> => this.client.archiveNote(rel)
  unarchiveNote = (rel: string): Promise<NoteMeta> => this.client.unarchiveNote(rel)
  moveToTrash = (rel: string): Promise<NoteMeta> => this.client.moveToTrash(rel)
  restoreFromTrash = (rel: string): Promise<NoteMeta> => this.client.restoreFromTrash(rel)
  duplicateNote = (rel: string): Promise<NoteMeta> => this.client.duplicateNote(rel)
  deleteNote = (rel: string): Promise<void> => this.client.deleteNote(rel)
  createFolder = (folder: NoteFolder, subpath: string): Promise<void> =>
    this.client.createFolder(folder, subpath)
  renameFolder = (folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> =>
    this.client.renameFolder(folder, oldSubpath, newSubpath)
  deleteFolder = (folder: NoteFolder, subpath: string): Promise<void> =>
    this.client.deleteFolder(folder, subpath)

  /** The server's search route has no limit parameter, so the cap is applied
   *  here. It also runs the server's own engine (ripgrep when available)
   *  rather than the CLI's scan, so ordering can differ from a local vault. */
  searchText = async (query: string, limit: number): Promise<VaultTextSearchMatch[]> => {
    const matches = await this.client.searchText(query)
    return matches.slice(0, limit)
  }

  backlinks = async (rel: string): Promise<NoteMeta[]> =>
    backlinksIn(await this.client.listNotes(), normalizeRelPath(rel))

  scanAllTasks = (): Promise<VaultTask[]> => this.client.scanTasks()

  /** No task-toggle endpoint exists, so the note is read, the same transform a
   *  local toggle applies is applied here, and the server re-parses the result
   *  — which keeps the Go and TypeScript task parsers honest with each other. */
  toggleTask = async (taskId: string): Promise<VaultTask | null> => {
    const { rel, indexStr } = splitTaskId(taskId)
    const note = await this.client.readNote(rel)

    let nextBody: string | null
    if (indexStr === 'task') {
      const current = (await this.client.scanTasksForPath(rel)).find((t) => t.id === taskId)
      nextBody = current ? toggleFileTaskInBody(note.body, current.checked) : null
    } else {
      nextBody = toggleTaskInBody(note.body, parseTaskIndex(taskId, indexStr))
    }
    if (nextBody == null) return null

    await this.client.writeNote(rel, nextBody)
    return (await this.client.scanTasksForPath(rel)).find((t) => t.id === taskId) ?? null
  }
}

/** `./inbox/Note.md` → `inbox/Note.md`, matching how the server reports paths. */
function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}
