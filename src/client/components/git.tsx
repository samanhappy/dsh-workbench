import { h, React, TooltipPrimitive } from '../react'
import { Workspace } from '../git/components/Workspace'
import { useFeatureFlags } from '../features'
import { gitIcon } from '../icons'
import { ZH } from '../git/locale'

const translate = (key: string) => ZH[key] || key
const locale = () => 'zh'

export function GitPanel(props: { active: boolean; cwd: string }) {
  return h(Workspace, { active: props.active, cwd: props.cwd, t: translate, locale })
}

export function GitCommitButton(props: {
  sessionId?: string
  useWorkspaces?: (selector: (snap: any) => any) => any
}) {
  const [open, setOpen] = React.useState(false)
  const opener = React.useRef<HTMLButtonElement | null>(null)
  const flags = useFeatureFlags()
  const cwd = typeof props.useWorkspaces === 'function'
    ? props.useWorkspaces((snap: any) => snap?.items?.find((ws: any) =>
        props.sessionId && ws.sessionIds?.includes(props.sessionId))?.path || '')
    : ''
  const close = () => { setOpen(false); opener.current?.focus() }
  if (!flags.git || !cwd) return null
  const label = 'Git'
  const button = h('button', {
    ref: opener, type: 'button', className: 'glab-turnbtn',
    'aria-label': label, title: TooltipPrimitive ? undefined : label,
    onClick: () => setOpen(true),
  }, gitIcon(15))
  return h(React.Fragment, null,
    TooltipPrimitive ? h(TooltipPrimitive, { label, side: 'bottom' }, button) : button,
    open ? h('div', { className: 'wb-modal-backdrop', onClick: close },
      h('div', {
        className: 'wb-workbench wb-git-commit-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': label,
        onClick: (event: any) => event.stopPropagation(),
        onKeyDown: (event: any) => {
          if (event.key === 'Escape') { event.stopPropagation(); close() }
          if (event.key === 'Tab') {
            const items = event.currentTarget.querySelectorAll('button:not(:disabled), textarea, input:not(:disabled), select')
            const first = items[0], last = items[items.length - 1]
            if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
              event.preventDefault(); (event.shiftKey ? last : first).focus()
            }
          }
        },
      },
      h('div', { className: 'wb-git-commit-title' }, h('strong', null, 'Git · ' + cwd),
        h('button', { className: 'glab-btn', autoFocus: true, onClick: close }, '关闭')),
      h(Workspace, { key: cwd, active: true, cwd, t: translate, locale }))) : null)
}
