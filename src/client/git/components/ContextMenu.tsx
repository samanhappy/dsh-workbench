// Cursor-anchored context menu used by file rows, branch rows and commit rows.
//
// It flips near the viewport edges, closes on an outside press, Escape, scroll,
// resize or a second context-menu request, and only one exists at a time.

import { h, React } from '../react'

export interface ContextMenuEntry {
  label?: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  divider?: boolean
  onSelect?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  title?: string
  items: ContextMenuEntry[]
}

export function ContextMenu(props: { state: ContextMenuState; onClose: () => void }): any {
  const menuRef = React.useRef<any>(null)
  const [placed, setPlaced] = React.useState({ left: props.state.x, top: props.state.y })

  React.useEffect(() => {
    // Position after mount so the real size is known: flip up/left near edges.
    const node = menuRef.current
    if (node && node.getBoundingClientRect) {
      const rect = node.getBoundingClientRect()
      const width = typeof window !== 'undefined' ? window.innerWidth : 1440
      const height = typeof window !== 'undefined' ? window.innerHeight : 900
      const left = Math.min(props.state.x, width - rect.width - 8)
      const top = Math.min(props.state.y, height - rect.height - 8)
      setPlaced({ left: Math.max(8, left), top: Math.max(8, top) })
    }
    const close = () => props.onClose()
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onDown, true)
      document.addEventListener('keydown', onKey, true)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      window.addEventListener('blur', close)
    }, 0)
    function onDown(event: any) {
      if (menuRef.current && menuRef.current.contains && menuRef.current.contains(event.target)) return
      close()
    }
    function onKey(event: any) {
      if (event.key === 'Escape') close()
    }
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [props.state.x, props.state.y, props.onClose])

  return h(
    'div',
    {
      className: 'wb-git-ctxmenu',
      ref: menuRef,
      role: 'menu',
      style: { left: placed.left + 'px', top: placed.top + 'px' },
      onContextMenu: (event: any) => event.preventDefault(),
    },
    props.state.title ? h('div', { className: 'wb-git-ctxmenu-title' }, props.state.title) : null,
    props.state.items.map((item, index) =>
      item.divider
        ? h('div', { key: 'div:' + String(index), className: 'wb-git-ctxmenu-divider' })
        : h(
            'button',
            {
              key: item.label + ':' + String(index),
              type: 'button',
              role: 'menuitem',
              className: 'wb-git-ctxmenu-item',
              'data-danger': item.danger || undefined,
              disabled: item.disabled || undefined,
              title: item.disabled ? item.hint : undefined,
              onClick: () => {
                if (item.disabled) return
                props.onClose()
                item.onSelect?.()
              },
            },
            h('span', null, item.label),
            item.hint && !item.disabled ? h('kbd', null, item.hint) : null,
          ),
    ),
  )
}
