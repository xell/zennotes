import { describe, it, expect } from 'vitest'
import { KEYMAP_CATALOG } from '@shared/keymaps-catalog'
import { getKeymapDefinitions } from './keymaps'

// KEYMAP_CATALOG (shared-domain) is a slim mirror of KEYMAP_DEFINITIONS used by
// the config writer to list every action as a commented default. KEYMAP_DEFINITIONS
// is the source of truth — this test fails if the catalog drifts (added/removed
// action, changed default binding, group, or title).
describe('KEYMAP_CATALOG', () => {
  it('mirrors every keymap definition (id, group, defaultBinding, title)', () => {
    const definitions = getKeymapDefinitions()
    const catalogById = new Map(KEYMAP_CATALOG.map((e) => [e.id, e]))

    expect(KEYMAP_CATALOG).toHaveLength(definitions.length)

    for (const def of definitions) {
      const entry = catalogById.get(def.id)
      expect(entry, `missing catalog entry for ${def.id}`).toBeDefined()
      expect(entry).toEqual({
        id: def.id,
        group: def.group,
        defaultBinding: def.defaultBinding,
        ...(def.defaultBindingMac ? { defaultBindingMac: def.defaultBindingMac } : {}),
        title: def.title
      })
    }
  })

  it('keeps the marker hops off Option+bracket on the Mac (#514)', () => {
    // On a Mac, `[` and `]` ARE Option+5 / Option+6 on German-family layouts,
    // so an `Alt+[` default swallows the keystroke instead of typing the
    // bracket. The hops keep Alt+[ / Alt+] where AltGr layouts don't collide
    // (Windows/Linux AltGr arrives as Ctrl+Alt) and use Ctrl-based chords on
    // the Mac. No Mac default may reintroduce a bare Option+<printable> chord.
    const bareOptionPrintable = /^Alt\+[^+]$/
    for (const id of ['editor.hopMarkerForward', 'editor.hopMarkerBackward']) {
      const entry = KEYMAP_CATALOG.find((e) => e.id === id)
      expect(entry?.defaultBindingMac, `${id} needs a Mac-safe default`).toBeDefined()
    }
    for (const entry of KEYMAP_CATALOG) {
      if (entry.defaultBindingMac) {
        expect(entry.defaultBindingMac).not.toMatch(bareOptionPrintable)
      }
    }
  })
})
