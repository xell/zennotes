// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastHost } from './Toast'
import { useToastStore } from '../../lib/toast'

describe('ToastHost (#257)', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    useToastStore.setState({ toasts: [] })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root.render(createElement(ToastHost)))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('renders a success toast with a working action button that dismisses it', () => {
    const onClick = vi.fn()
    act(() => {
      useToastStore.getState().addToast('PDF exported', 'success', { label: 'Show in folder', onClick })
    })
    expect(host.textContent).toContain('PDF exported')
    const action = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show in folder')
    expect(action).toBeTruthy()
    act(() => action!.click())
    expect(onClick).toHaveBeenCalledOnce()
    expect(host.textContent).not.toContain('PDF exported') // action dismisses it
  })

  it('auto-dismisses success toasts after 4s', () => {
    act(() => useToastStore.getState().addToast('PDF exported', 'success'))
    expect(host.textContent).toContain('PDF exported')
    act(() => vi.advanceTimersByTime(4000))
    expect(host.textContent).not.toContain('PDF exported')
  })

  it('keeps error toasts until dismissed (they replace the blocking alert)', () => {
    act(() => useToastStore.getState().addToast('Could not export the note as a PDF.', 'error'))
    act(() => vi.advanceTimersByTime(10000))
    expect(host.textContent).toContain('Could not export') // still there
    const dismiss = host.querySelector('button[aria-label="Dismiss notification"]') as HTMLButtonElement
    expect(dismiss).toBeTruthy()
    act(() => dismiss.click())
    expect(host.textContent).not.toContain('Could not export')
  })
})
