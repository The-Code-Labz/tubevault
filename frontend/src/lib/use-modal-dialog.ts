import { useEffect, useRef } from 'react'

/**
 * Wires a native <dialog> element's open/close state to a nullable value,
 * using showModal()/close() for correct focus trapping and Escape handling,
 * and restores focus to the element that was focused before opening.
 */
export function useModalDialog<T>(value: T | null, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (value) {
      if (!el.open) {
        restoreFocusRef.current = document.activeElement as HTMLElement | null
        el.showModal()
      }
    } else if (el.open) {
      el.close()
    }
  }, [value])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    function handleClose() {
      onClose()
      restoreFocusRef.current?.focus?.()
    }
    el.addEventListener('close', handleClose)
    return () => el.removeEventListener('close', handleClose)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return ref
}
