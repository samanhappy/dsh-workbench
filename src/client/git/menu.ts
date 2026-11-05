// Shared popover behaviour for every dropdown in the panel (repository
// switcher, branch row menu, file row menu).
//
// One menu at a time: opening a menu closes the previous one. A menu also closes
// on an outside press, Escape, or any scroll, so it can never pile up or keep
// swallowing clicks meant for the row underneath.

import { React } from './react'

let activeClose: (() => void) | null = null

export function usePopover(): {
  open: boolean
  toggle: () => void
  close: () => void
  menuRef: any
  triggerRef: any
} {
  const [open, setOpen] = React.useState(false)
  const menuRef = React.useRef<any>(null)
  const triggerRef = React.useRef<any>(null)
  const close = React.useCallback(() => setOpen(false), [])

  React.useEffect(() => {
    if (!open) return
    if (activeClose && activeClose !== close) activeClose()
    activeClose = close

    const contains = (node: any, target: any) => Boolean(node && node.contains && node.contains(target))
    const onDown = (event: any) => {
      if (contains(menuRef.current, event.target) || contains(triggerRef.current, event.target)) return
      close()
    }
    const onKey = (event: any) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: any) => {
      // Scrolling inside the popover itself (wheel over the list, dragging its
      // scrollbar) must not dismiss it; only the page behind closes a menu.
      const target = event && event.target
      if (target && menuRef.current && menuRef.current.contains && menuRef.current.contains(target)) return
      close()
    }

    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      if (activeClose === close) activeClose = null
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, close])

  return { open, toggle: () => setOpen((value: boolean) => !value), close, menuRef, triggerRef }
}
