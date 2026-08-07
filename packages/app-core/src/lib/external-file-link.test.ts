import { describe, expect, it } from 'vitest'
import { externalFileLink } from './external-file-link'

describe('externalFileLink', () => {
  it('recognizes home-relative paths (#424)', () => {
    expect(externalFileLink('~/.local/bin/example-bash-script.sh')).toBe(
      '~/.local/bin/example-bash-script.sh'
    )
    expect(externalFileLink('~')).toBe('~')
    expect(externalFileLink('~/notes/todo.txt')).toBe('~/notes/todo.txt')
  })

  it('recognizes file:// URLs', () => {
    expect(externalFileLink('file:///Users/me/report.pdf')).toBe('file:///Users/me/report.pdf')
  })

  it('recognizes Windows drive paths', () => {
    expect(externalFileLink('C:\\Users\\me\\file.txt')).toBe('C:\\Users\\me\\file.txt')
    expect(externalFileLink('D:/data/notes.md')).toBe('D:/data/notes.md')
  })

  it('recognizes absolute POSIX paths that name a concrete non-md file', () => {
    expect(externalFileLink('/Users/me/scripts/build.sh')).toBe('/Users/me/scripts/build.sh')
    expect(externalFileLink('/etc/hosts.txt')).toBe('/etc/hosts.txt')
  })

  it('leaves vault-root note paths alone (no extension, or .md)', () => {
    // A leading `/` is "vault-root relative" here; these must stay note links so
    // the create-note flow still works.
    expect(externalFileLink('/todo')).toBeNull()
    expect(externalFileLink('/notes/plan')).toBeNull()
    expect(externalFileLink('/notes/plan.md')).toBeNull()
  })

  it('leaves web URLs and other schemes alone', () => {
    expect(externalFileLink('https://example.com')).toBeNull()
    expect(externalFileLink('http://example.com/a.pdf')).toBeNull()
    expect(externalFileLink('mailto:a@b.com')).toBeNull()
    expect(externalFileLink('zen-asset://x/y.png')).toBeNull()
    expect(externalFileLink('example.com/path')).toBeNull()
  })

  it('leaves vault-relative and bare links alone', () => {
    expect(externalFileLink('./assets/diagram.png')).toBeNull()
    expect(externalFileLink('../Projects/plan.md')).toBeNull()
    expect(externalFileLink('Some Note')).toBeNull()
    expect(externalFileLink('folder/Note.md')).toBeNull()
    expect(externalFileLink('#heading')).toBeNull()
    expect(externalFileLink('')).toBeNull()
    expect(externalFileLink('   ')).toBeNull()
  })
})
