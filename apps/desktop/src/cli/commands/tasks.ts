/**
 * `zn task ...` — list and toggle markdown checkboxes parsed across
 * the live vault. Mirrors the MCP server's task semantics.
 */

import type { VaultBackend } from '../backend.js'
import { getBool, getString, type ParsedArgs } from '../args.js'
import { emitJson, emitLine, emitOk, pad, truncate } from '../format.js'

export async function cmdTaskList(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const showAll = getBool(args, 'all')
  const onlyUnchecked = getBool(args, 'unchecked')
  const tag = getString(args, 'tag')?.replace(/^#/, '').toLowerCase()

  let tasks = await vault.scanAllTasks()
  if (!showAll) {
    if (onlyUnchecked) tasks = tasks.filter((t) => !t.checked)
    else tasks = tasks.filter((t) => !t.checked && !t.waiting)
  }
  if (tag) tasks = tasks.filter((t) => t.tags.includes(tag))

  if (getBool(args, 'json')) {
    emitJson(tasks)
    return
  }
  if (tasks.length === 0) {
    emitLine('No tasks found.')
    return
  }
  for (const t of tasks) {
    const box = t.checked
      ? '[x]'
      : t.cancelled
        ? '[-]'
        : t.inProgress
          ? '[/]'
          : t.waiting
            ? '[~]'
            : '[ ]'
    const due = t.due ? `  due:${t.due}` : ''
    const pri = t.priority ? `  !${t.priority}` : ''
    emitLine(`${box}  ${pad(t.id, 40)}  ${truncate(t.content, 80)}${due}${pri}`)
  }
}

export async function cmdTaskToggle(vault: VaultBackend, args: ParsedArgs): Promise<void> {
  const id = getString(args, 'id') ?? args.positionals[0]
  if (!id) throw new Error('zn task toggle requires a task id from `zn task list`.')
  const next = await vault.toggleTask(id)
  if (next == null) {
    throw new Error(
      `Task ${id} no longer exists at that location — the file may have changed. Run \`zn task list\` again.`
    )
  }
  if (getBool(args, 'json')) {
    emitJson(next)
    return
  }
  const state = next.checked
    ? 'done'
    : next.inProgress
      ? 'in progress'
      : next.waiting
        ? 'waiting'
        : 'open'
  emitOk(`Toggled ${id} → ${state}`)
}
