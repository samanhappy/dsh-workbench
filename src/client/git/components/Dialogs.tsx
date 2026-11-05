import { ConfirmDialog as WorkbenchConfirmDialog } from '../../components/confirmdialog'
// Small modal dialogs for branch operations. One prompt (create / rename) and
// one confirm (delete); both keep the typed value and any failure on screen.

import { h, React } from '../react'
import type { Translate } from '../types'

export function PromptDialog(props: {
  title: string
  label: string
  initial: string
  submitLabel: string
  busy: boolean
  error: string
  t: Translate
  onCancel: () => void
  onSubmit: (value: string) => void
}): any {
  const [value, setValue] = React.useState(props.initial)
  const submit = () => {
    const next = value.trim()
    if (next !== '') props.onSubmit(next)
  }
  return h(
    'div',
    { className: 'wb-git-overlay', role: 'presentation', onClick: props.onCancel },
    h(
      'div',
      { className: 'wb-git-dialog', role: 'dialog', 'aria-modal': 'true', onClick: (event: any) => event.stopPropagation() },
      h('div', { className: 'wb-git-dialog-title' }, props.title),
      h('label', { className: 'wb-git-dialog-label' }, props.label),
      h('input', {
        className: 'glab-input',
        value,
        autoFocus: true,
        spellCheck: false,
        onChange: (event: any) => setValue(event.target.value),
        onKeyDown: (event: any) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
          if (event.key === 'Escape') props.onCancel()
        },
      }),
      props.error !== '' ? h('div', { className: 'wb-git-dialog-error' }, props.error) : null,
      h(
        'div',
        { className: 'wb-git-dialog-actions' },
        h('button', { type: 'button', className: 'glab-btn', onClick: props.onCancel }, props.t('cancel')),
        h(
          'button',
          { type: 'button', className: 'glab-btn glab-btn-primary', disabled: props.busy || value.trim() === '', onClick: submit },
          props.submitLabel,
        ),
      ),
    ),
  )
}

export function ConfirmDialog(props: {
  title: string
  body: string
  submitLabel: string
  busy: boolean
  error: string
  t: Translate
  onCancel: () => void
  onConfirm: () => void
}): any {
  return h(WorkbenchConfirmDialog, {
    title: props.title,
    lines: [props.body, ...(props.error ? [props.error] : [])],
    okLabel: props.submitLabel,
    danger: true,
    busy: props.busy,
    onCancel: props.onCancel,
    onOk: props.onConfirm,
  })
}
