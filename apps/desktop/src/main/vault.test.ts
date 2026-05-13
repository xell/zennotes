import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  absolutePath,
  appendToNote,
  ensureVaultLayout,
  getVaultSettings,
  invalidateNoteMetaCache,
  listNotes,
  listFolders,
  rememberLocalVault,
  renameFolder,
  searchVaultText,
  searchVaultTextCapabilities,
  setVaultSettings,
  writeNote
} from './vault'

const tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('absolutePath', () => {
  it('rejects sibling-prefix escapes outside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-parent-')
    const root = path.join(parent, 'vault')
    const sibling = path.join(parent, 'vault-evil')
    await mkdir(root, { recursive: true })
    await mkdir(sibling, { recursive: true })

    expect(() => absolutePath(root, '../vault-evil/secret.md')).toThrow(/Path escapes vault/)
  })

  it('allows paths that stay inside the vault root', async () => {
    const parent = await makeTempDir('zennotes-vault-allowed-')
    const root = path.join(parent, 'vault')
    await mkdir(path.join(root, 'inbox'), { recursive: true })

    expect(absolutePath(root, 'inbox/note.md')).toBe(path.join(root, 'inbox', 'note.md'))
  })
})

describe('rememberLocalVault', () => {
  it('moves an opened vault to the top and deduplicates by root', () => {
    const firstRoot = path.resolve('/tmp/zennotes-first')
    const secondRoot = path.resolve('/tmp/zennotes-second')

    const remembered = rememberLocalVault(
      [
        { root: firstRoot, name: 'First', lastOpenedAt: 10 },
        { root: secondRoot, name: 'Second', lastOpenedAt: 20 }
      ],
      { root: firstRoot, name: 'First renamed' },
      30
    )

    expect(remembered).toEqual([
      { root: firstRoot, name: 'First renamed', lastOpenedAt: 30 },
      { root: secondRoot, name: 'Second', lastOpenedAt: 20 }
    ])
  })
})

describe('appendToNote', () => {
  it('appends to the end with a separating blank line when target lacks trailing newline', async () => {
    const root = await makeTempDir('zennotes-append-end-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\nfirst line', 'utf8')

    await appendToNote(root, rel, 'second thought', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('# Quick\n\nfirst line\n\nsecond thought\n')
  })

  it('prepends to the start with a separating blank line', async () => {
    const root = await makeTempDir('zennotes-append-start-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    await writeFile(path.join(root, rel), '# Quick\n\noriginal\n', 'utf8')

    await appendToNote(root, rel, 'breaking news', 'start')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe('breaking news\n\n# Quick\n\noriginal\n')
  })

  it('is a no-op when the addition is whitespace-only', async () => {
    const root = await makeTempDir('zennotes-append-empty-')
    await ensureVaultLayout(root)
    const rel = 'inbox/quick.md'
    const original = '# Quick\n\nbody\n'
    await writeFile(path.join(root, rel), original, 'utf8')

    await appendToNote(root, rel, '   \n  ', 'end')

    const next = await readFile(path.join(root, rel), 'utf8')
    expect(next).toBe(original)
  })
})

describe('renameFolder', () => {
  it('can promote a nested inbox folder to the vault root in root mode', async () => {
    const root = await makeTempDir('zennotes-rename-root-mode-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })
    await mkdir(path.join(root, 'inbox', 'demo'), { recursive: true })
    await writeFile(path.join(root, 'inbox', 'demo', 'Start.md'), '# Start\n', 'utf8')

    const next = await renameFolder(root, 'inbox', 'inbox/demo', 'demo')

    expect(next).toBe('demo')
    await expect(readFile(path.join(root, 'demo', 'Start.md'), 'utf8')).resolves.toBe(
      '# Start\n'
    )
    const folders = await listFolders(root)
    expect(folders.some((folder) => folder.folder === 'inbox' && folder.subpath === 'demo')).toBe(
      true
    )
  })
})

describe('searchVaultTextCapabilities', () => {
  it('treats invalid custom executable paths as unavailable', async () => {
    const root = await makeTempDir('zennotes-search-tools-')
    const fake = path.join(root, 'evil-tool')
    await writeFile(fake, 'not a real search binary', 'utf8')

    const capabilities = await searchVaultTextCapabilities(
      { ripgrepPath: fake, fzfPath: fake },
      true
    )

    expect(capabilities.ripgrep).toBe(false)
    expect(capabilities.fzf).toBe(false)
  })
})

describe('searchVaultText', () => {
  it('invalidates cached candidates when a note is written', async () => {
    const root = await makeTempDir('zennotes-search-cache-')
    await ensureVaultLayout(root)
    const rel = 'inbox/cache.md'
    await writeFile(path.join(root, rel), 'alpha only\n', 'utf8')

    expect((await searchVaultText(root, 'alpha', 'builtin')).map((m) => m.path)).toContain(rel)

    await writeNote(root, rel, 'beta only\n')

    expect((await searchVaultText(root, 'alpha', 'builtin')).map((m) => m.path)).not.toContain(
      rel
    )
    expect((await searchVaultText(root, 'beta', 'builtin')).map((m) => m.path)).toContain(rel)
  })

  it('matches note body text when auto resolves to fzf', async () => {
    const root = await makeTempDir('zennotes-search-fzf-')
    await ensureVaultLayout(root)
    const rel = 'inbox/fzf.md'
    await writeFile(path.join(root, rel), 'first line\nneedle unique body\n', 'utf8')

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        "const filter = args[args.indexOf('--filter') + 1] ?? '';",
        "const delimiterArg = args.find((arg) => arg.startsWith('--delimiter='));",
        "const delimiter = delimiterArg ? delimiterArg.slice('--delimiter='.length) : null;",
        "const nthArg = args.find((arg) => arg.startsWith('--nth='));",
        "const fields = (nthArg ? nthArg.slice('--nth='.length) : '').split(',').map((part) => Number(part)).filter(Boolean);",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const rows = input.split(/\\r?\\n/).filter(Boolean);",
        "  const matches = rows.filter((row) => {",
        "    const parts = delimiter === '\\t' ? row.split('\\t') : row.trim().split(/\\s+/);",
        "    const haystack = (fields.length > 0 ? fields.map((field) => parts[field - 1] ?? '').join(' ') : row).toLowerCase();",
        "    return haystack.includes(filter.toLowerCase());",
        "  });",
        "  process.stdout.write(matches.join('\\n'));",
        "  if (matches.length > 0) process.stdout.write('\\n');",
        "});",
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', {
      fzfPath,
      ripgrepPath: path.join(root, 'rg')
    })

    expect(matches[0]).toMatchObject({
      path: rel,
      lineNumber: 2,
      offset: 'first line\n'.length
    })
  })

  it('normalizes root-mode ripgrep candidates before fzf search', async () => {
    const root = await makeTempDir('zennotes-search-rg-root-')
    await ensureVaultLayout(root)
    const settings = await getVaultSettings(root)
    await setVaultSettings(root, { ...settings, primaryNotesLocation: 'root' })

    await mkdir(path.join(root, 'demo'), { recursive: true })
    await mkdir(path.join(root, 'quick'), { recursive: true })
    await mkdir(path.join(root, 'trash'), { recursive: true })
    await writeFile(path.join(root, 'demo/root.md'), '# Root\n\nneedle in root mode\n', 'utf8')
    await writeFile(path.join(root, 'quick/quick.md'), '# Quick\n\nneedle in quick\n', 'utf8')
    await writeFile(path.join(root, 'trash/trash.md'), '# Trash\n\nneedle should stay hidden\n', 'utf8')

    const ripgrepPath = path.join(root, 'rg')
    await writeFile(
      ripgrepPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake rg'); process.exit(0); }",
        'const events = [',
        "  { type: 'match', data: { path: { text: './demo/root.md' }, lines: { text: 'needle in root mode\\n' }, line_number: 3 } },",
        "  { type: 'match', data: { path: { text: './quick/quick.md' }, lines: { text: 'needle in quick\\n' }, line_number: 3 } },",
        "  { type: 'match', data: { path: { text: './trash/trash.md' }, lines: { text: 'needle should stay hidden\\n' }, line_number: 3 } }",
        '];',
        "process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n');",
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(ripgrepPath, 0o755)

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        'process.stdin.pipe(process.stdout);',
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', { ripgrepPath, fzfPath })

    expect(matches.map((match) => ({ path: match.path, folder: match.folder }))).toEqual(
      expect.arrayContaining([
        { path: 'demo/root.md', folder: 'inbox' },
        { path: 'quick/quick.md', folder: 'quick' }
      ])
    )
  })

  it('falls back to built-in ranking when fzf emits no rows', async () => {
    const root = await makeTempDir('zennotes-search-fzf-empty-')
    await ensureVaultLayout(root)
    const rel = 'inbox/fallback.md'
    await writeFile(path.join(root, rel), 'first line\nneedle still exists\n', 'utf8')

    const fzfPath = path.join(root, 'fzf')
    await writeFile(
      fzfPath,
      [
        '#!/usr/bin/env node',
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('fake fzf'); process.exit(0); }",
        'process.stdin.resume();',
        ''
      ].join('\n'),
      'utf8'
    )
    await chmod(fzfPath, 0o755)

    const matches = await searchVaultText(root, 'needle', 'auto', {
      fzfPath,
      ripgrepPath: path.join(root, 'rg')
    })

    expect(matches[0]).toMatchObject({
      path: rel,
      lineNumber: 2,
      offset: 'first line\n'.length
    })
  })
})

describe('listNotes metadata parsing', () => {
  it('detects only local asset references as attachments', async () => {
    const root = await makeTempDir('zennotes-meta-assets-')
    await ensureVaultLayout(root)
    const plainRel = 'inbox/plain.md'
    const imageRel = 'inbox/image.md'
    const embedRel = 'inbox/embed.md'
    await writeFile(path.join(root, plainRel), '# Plain\n\n[[Project Note]]\n', 'utf8')
    await writeFile(path.join(root, imageRel), '# Image\n\n![diagram](../attachements/diagram.png)\n', 'utf8')
    await writeFile(path.join(root, embedRel), '# Embed\n\n![[brief.pdf]]\n', 'utf8')

    const notes = await listNotes(root)
    const byPath = new Map(notes.map((note) => [note.path, note] as const))

    expect(byPath.get(plainRel)?.hasAttachments).toBe(false)
    expect(byPath.get(plainRel)?.wikilinks).toEqual(['Project Note'])
    expect(byPath.get(imageRel)?.hasAttachments).toBe(true)
    expect(byPath.get(embedRel)?.hasAttachments).toBe(true)
    expect(byPath.get(embedRel)?.wikilinks).toEqual([])
  })
})

describe('listNotes metadata cache', () => {
  it('uses matching persisted metadata without reparsing unchanged note bodies', async () => {
    const root = await makeTempDir('zennotes-meta-cache-hit-')
    await ensureVaultLayout(root)
    const rel = 'inbox/cached.md'
    const abs = path.join(root, rel)
    await writeFile(abs, '# Disk Title\n\n#disk\n', 'utf8')
    const info = await stat(abs)
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'note-meta-cache-v1.json'),
      `${JSON.stringify({
        version: 1,
        entries: [
          {
            path: rel,
            mtimeMs: info.mtimeMs,
            size: info.size,
            meta: {
              path: rel,
              title: 'Cached Title',
              folder: 'inbox',
              siblingOrder: 0,
              createdAt: info.birthtimeMs || info.ctimeMs,
              updatedAt: info.mtimeMs,
              size: info.size,
              tags: ['cached'],
              wikilinks: ['Cached Target'],
              hasAttachments: false,
              excerpt: 'cached excerpt'
            }
          }
        ]
      })}\n`,
      'utf8'
    )

    invalidateNoteMetaCache(root)

    const notes = await listNotes(root)
    const note = notes.find((item) => item.path === rel)

    expect(note?.title).toBe('Cached Title')
    expect(note?.tags).toEqual(['cached'])
    expect(note?.excerpt).toBe('cached excerpt')
  })

  it('ignores stale persisted metadata when file stats no longer match', async () => {
    const root = await makeTempDir('zennotes-meta-cache-stale-')
    await ensureVaultLayout(root)
    const rel = 'inbox/stale.md'
    const abs = path.join(root, rel)
    await writeFile(abs, '# Fresh Title\n\n#fresh\n', 'utf8')
    await mkdir(path.join(root, '.zennotes'), { recursive: true })
    await writeFile(
      path.join(root, '.zennotes', 'note-meta-cache-v1.json'),
      `${JSON.stringify({
        version: 1,
        entries: [
          {
            path: rel,
            mtimeMs: 1,
            size: 1,
            meta: {
              path: rel,
              title: 'Stale Title',
              folder: 'inbox',
              siblingOrder: 0,
              createdAt: 1,
              updatedAt: 1,
              size: 1,
              tags: ['stale'],
              wikilinks: [],
              hasAttachments: false,
              excerpt: 'stale excerpt'
            }
          }
        ]
      })}\n`,
      'utf8'
    )

    invalidateNoteMetaCache(root)

    const notes = await listNotes(root)
    const note = notes.find((item) => item.path === rel)

    expect(note?.title).toBe('stale')
    expect(note?.tags).toEqual(['fresh'])
    expect(note?.excerpt).toContain('Fresh Title')
  })
})
