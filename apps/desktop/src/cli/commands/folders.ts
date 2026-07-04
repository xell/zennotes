/**
 * `zn folder ...` subcommands. Folders are subpaths under one of the
 * four top-level folders (inbox / quick / archive / trash); the CLI
 * treats `folder/sub` as the canonical reference.
 */

import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
  type NoteFolder
} from '../../mcp/vault-ops.js'
import { getBool, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk } from '../format.js'

const TOP_FOLDERS: NoteFolder[] = ['inbox', 'quick', 'archive']

interface FolderRef {
  folder: NoteFolder
  subpath: string
}

function splitFolderPath(spec: string): FolderRef {
  const trimmed = spec.replace(/^\/+|\/+$/g, '')
  if (!trimmed) throw new Error('Folder path must not be empty.')
  const [head, ...rest] = trimmed.split('/')
  if (!TOP_FOLDERS.includes(head as NoteFolder)) {
    throw new Error(
      `Folder path must start with one of ${TOP_FOLDERS.join(', ')} (got "${head}").`
    )
  }
  return { folder: head as NoteFolder, subpath: rest.join('/') }
}

export async function cmdFolderList(vault: string, args: ParsedArgs): Promise<void> {
  const folders = await listFolders(vault)
  if (getBool(args, 'json')) {
    emitJson(folders)
    return
  }
  if (folders.length === 0) {
    emitLine('No subfolders.')
    return
  }
  for (const f of folders) {
    emitLine(`${f.folder}/${f.subpath}`)
  }
}

export async function cmdFolderCreate(vault: string, args: ParsedArgs): Promise<void> {
  const target = args.positionals[0] ?? getString(args, 'path')
  if (!target) throw new Error('zn folder create requires a folder path like inbox/Work.')
  const ref = splitFolderPath(target)
  if (!ref.subpath) throw new Error('Cannot create the top-level folder; pick a subpath.')
  await createFolder(vault, ref.folder, ref.subpath)
  if (getBool(args, 'json')) {
    emitJson({ ok: true, folder: ref.folder, subpath: ref.subpath })
    return
  }
  emitOk(`Created ${ref.folder}/${ref.subpath}`)
}

export async function cmdFolderRename(vault: string, args: ParsedArgs): Promise<void> {
  const oldPath = args.positionals[0] ?? getString(args, 'path')
  const to = getString(args, 'to')
  if (!oldPath) throw new Error('zn folder rename requires a folder path.')
  if (!to) throw new Error('zn folder rename requires --to <newPath>.')
  const oldRef = splitFolderPath(oldPath)
  const newRef = splitFolderPath(to)
  if (oldRef.folder !== newRef.folder) {
    throw new Error(
      'Renaming across top-level folders is not supported. Use `zn move` for individual notes.'
    )
  }
  if (!oldRef.subpath || !newRef.subpath) {
    throw new Error('Both old and new folder paths must include a subpath.')
  }
  const next = await renameFolder(vault, oldRef.folder, oldRef.subpath, newRef.subpath)
  if (getBool(args, 'json')) {
    emitJson({ ok: true, folder: oldRef.folder, subpath: next })
    return
  }
  emitOk(`Renamed to ${oldRef.folder}/${next}`)
}

export async function cmdFolderDelete(vault: string, args: ParsedArgs): Promise<void> {
  const target = args.positionals[0] ?? getString(args, 'path')
  if (!target) throw new Error('zn folder delete requires a folder path.')
  if (!getBool(args, 'yes')) {
    throw new Error(
      'zn folder delete is destructive. Re-run with --yes to confirm.'
    )
  }
  const ref = splitFolderPath(target)
  if (!ref.subpath) throw new Error('Cannot delete a top-level folder.')
  await deleteFolder(vault, ref.folder, ref.subpath)
  if (getBool(args, 'json')) {
    emitJson({ ok: true, folder: ref.folder, subpath: ref.subpath })
    return
  }
  emitOk(`Deleted ${ref.folder}/${ref.subpath}`)
}
