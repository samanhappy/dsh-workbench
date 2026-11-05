// dsh-workbench — shared styled confirm dialog.
//
// Replaces the remaining native confirm() calls (the browser alert ignores
// the app theme and its buttons are the browser-locale "OK/Cancel"). The card
// reuses the panel's own pieces — the surface/border/shadow tokens of the
// disclosure menus and the glab-btn variants (red = destructive) — styled by
// .wb-modal-* in styles/detail.css.

import { React, h } from '../react'

/** Modal confirmation card. Focus lands on the OK button on open, so Enter
 *  confirms and Esc (handled on the card) cancels — the native confirm()
 *  keyboard contract. The OWNER of `onOk`/`onCancel` decides what those do;
 *  the usual pattern is to clear the pending request in both. */
export function ConfirmDialog(props: {
  title: string
  lines?: string[]
  okLabel: string
  danger?: boolean
  busy?: boolean
  onOk(): void
  onCancel(): void
}) {
  const opener = React.useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  React.useEffect(function () {
    return function () {
      if (opener.current?.isConnected) opener.current.focus()
    }
  }, [])
  return h('div', { className: 'wb-modal-backdrop', onClick: props.onCancel },
    h('div', {
      className: 'wb-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': props.title,
      // Clicks inside the card must not bubble to the cancel backdrop.
      onClick: function (e: React.MouseEvent) { e.stopPropagation() },
      onKeyDown: function (e: React.KeyboardEvent<HTMLDivElement>) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          props.onCancel()
        } else if (e.key === 'Tab') {
          const buttons = e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')
          const first = buttons[0]
          const last = buttons[buttons.length - 1]
          if (first && last && ((e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last))) {
            e.preventDefault()
            const target = e.shiftKey ? last : first
            target.focus()
          }
        }
      },
    },
      h('div', { className: 'wb-modal-title' }, props.title),
      props.lines && props.lines.length
        ? h('div', { className: 'wb-modal-body' }, props.lines.map(function (line, i) {
            return h('div', { key: i }, line)
          }))
        : null,
      h('div', { className: 'wb-modal-actions' },
        h('button', { className: 'glab-btn', onClick: props.onCancel }, '取消'),
        h('button', {
          className: 'glab-btn ' + (props.danger ? 'glab-btn-red' : 'glab-btn-primary'),
          autoFocus: true,
          disabled: props.busy,
          onClick: props.onOk,
        }, props.okLabel))))
}

/** The pending-confirm payload a panel keeps in state; null = dialog closed. */
export type ConfirmRequest = {
  title: string
  lines?: string[]
  okLabel: string
  danger?: boolean
  onOk(): void
}
