import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runCommandById: vi.fn(),
  getState: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn()
}))

vi.mock('@replit/codemirror-vim', () => ({
  Vim: {
    defineAction: vi.fn(),
    map: vi.fn(),
    mapCommand: vi.fn(),
    noremap: vi.fn(),
    unmap: vi.fn()
  },
  getCM: vi.fn(() => ({ state: { vim: {} } }))
}))

vi.mock('../store', () => ({
  useStore: {
    getState: mocks.getState
  }
}))

vi.mock('./commands', () => ({
  runCommandById: mocks.runCommandById
}))

vi.mock('./zen-facade', () => ({
  makeZenFacade: vi.fn()
}))

vi.mock('./user-scripts', () => ({
  callUserScript: vi.fn()
}))

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  } as unknown as KeyboardEvent
}

describe('applyVimKeymap modifier bindings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      vimJsScriptsEnabled: false,
      vimMode: true,
      editorViewRef: { hasFocus: true }
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: mocks.addEventListener,
        removeEventListener: mocks.removeEventListener
      }
    })
  })

  it('matches <D-M-k> when macOS reports Option+k as a dead key', async () => {
    const { applyVimKeymap } = await import('./vim-keymap')

    applyVimKeymap('nmap <D-M-k> zen:note.daily.today')

    const handler = mocks.addEventListener.mock.calls.find((call) => call[0] === 'keydown')?.[1]
    expect(handler).toBeTypeOf('function')

    const event = keyEvent({ key: 'Dead', code: 'KeyK', metaKey: true, altKey: true })
    handler(event)

    expect(mocks.runCommandById).toHaveBeenCalledWith('note.daily.today')
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
  })
})
