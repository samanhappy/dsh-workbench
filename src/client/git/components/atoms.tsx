// Small presentational atoms shared by the workspace panes.

import { h } from '../react'

export function Chip(props: { tone?: 'ok' | 'warn' | 'brand' | 'muted'; title?: string; children?: any }): any {
  return h('span', { className: 'wb-git-chip', 'data-tone': props.tone ?? 'muted', title: props.title }, props.children)
}

export function PanelResize(props: { label: string; min: number; max: number }): any {
  const resize = (handle: any, width: number) => {
    const node = handle.previousElementSibling
    const maximum = Math.min(props.max, node.parentElement.clientWidth - 280)
    const next = Math.max(props.min, Math.min(maximum, width))
    node.style.flexBasis = next + 'px'
    handle.setAttribute('aria-valuenow', String(next))
  }
  return h('div', { className: 'wb-git-resize', title: props.label, role: 'separator', tabIndex: 0, 'aria-label': props.label, 'aria-orientation': 'vertical', 'aria-valuenow': props.min, 'aria-valuemin': props.min, 'aria-valuemax': props.max,
    onKeyDown: (e: any) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const node = e.currentTarget.previousElementSibling
      resize(e.currentTarget, node.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 20 : -20))
    },
    onPointerDown: (e: any) => {
      if (e.button !== 0) return
      e.preventDefault()
      const handle = e.currentTarget, node = handle.previousElementSibling
      const start = e.clientX, width = node.getBoundingClientRect().width
      handle.setPointerCapture(e.pointerId)
      handle.onpointermove = (event: any) => resize(handle, width + event.clientX - start)
      handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; handle.onpointerup = null; handle.onpointercancel = null }
    },
  }, h('svg', { width: 8, height: 20, viewBox: '0 0 8 20', fill: 'currentColor', 'aria-hidden': 'true' },
    [6, 10, 14].flatMap(y => [2, 6].map(x => h('circle', { key: x + ':' + y, cx: x, cy: y, r: 1 }))),
  ))
}
