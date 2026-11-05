// Toolbar: branch and sync state, and the actions the
// panel really supports (refresh, reveal in Finder, open a terminal, focus the
// commit box). The two local open actions only exist on macOS; elsewhere they
// are not rendered at all rather than shown as dead buttons.

import { h } from '../react'
import type { GitStatusPayload, OpenTarget, Translate, RefsPayload } from '../types'
import { Chip } from './atoms'
import { CommitIcon, FolderIcon, PullIcon, PushIcon, PushRemotesIcon, RefreshIcon, TerminalIcon } from '../icons'

export function TopBar(props: {
  refs: RefsPayload | null
  onCheckout: (name: string) => void
  status: GitStatusPayload | null
  busy: boolean
  canPull: boolean
  onPull: () => void
  canPush: boolean
  onPush: () => void
  onPushRemotes: () => void
  opening: boolean
  t: Translate
  onRefresh: () => void
  onOpen: (target: OpenTarget) => void
  onCommitFocus: () => void
}): any {
  const { status, t } = props
  const branch = status?.branch && status.branch !== '(detached)' ? status.branch : status?.branch || '—'
  const ahead = status?.ahead ?? 0
  const behind = status?.behind ?? 0
  return h(
    'div',
    { className: 'wb-git-topbar', role: 'toolbar', 'aria-label': 'Git 操作' },
    h(
      'div',
      { className: 'wb-git-refs' },
      h('select', { className: 'glab-input wb-git-branch-select', 'aria-label': t('branches'), value: branch, disabled: props.busy, onChange: (event: any) => props.onCheckout(event.target.value) },
        !(props.refs?.branches || []).some(ref => ref.name === branch) ? h('option', { value: branch }, branch) : null,
        (props.refs?.branches || []).map(ref => h('option', { key: ref.name, value: ref.name }, ref.name))),
      ahead > 0 ? h(Chip, { tone: 'ok', title: t('ahead') }, '↑' + String(ahead)) : null,
      behind > 0 ? h(Chip, { tone: 'warn', title: t('behind') }, '↓' + String(behind)) : null,
      status?.upstream && ahead === 0 && behind === 0 ? h(Chip, { tone: 'ok' }, '✓ 已同步') : null,
      status?.upstream ? h('span', { className: 'wb-git-upstream', title: status.upstream }, status.upstream) : null,
    ),
    h(
      'div',
      { className: 'wb-git-actions' },
      h('button', {
        type: 'button', className: 'wb-review-refresh wb-git-iconbtn',
        title: props.canPull ? t('pull') + ' ' + status?.upstream : t('pullNoUpstream'),
        'aria-label': t('pull'), disabled: !props.canPull || props.busy,
        onClick: props.onPull,
      }, h(PullIcon)),
      h(
        'button',
        {
          type: 'button',
          className: 'wb-review-refresh wb-git-iconbtn',
          title: props.canPush
            ? t('push') + ' ' + branch + (ahead > 0 ? ' · ↑' + String(ahead) : '')
            : t('pushNoRemote'),
          'aria-label': t('push') + ' ' + branch,
          disabled: !props.canPush || props.busy,
          onClick: props.onPush,
        },
        h(PushIcon),
      ),
      h('button', {
        type: 'button', className: 'wb-review-refresh wb-git-iconbtn',
        title: t('pushRemotes'), 'aria-label': t('pushRemotes'),
        disabled: !props.canPush || props.busy || !status?.branch || status.branch === '(detached)',
        onClick: props.onPushRemotes,
      }, h(PushRemotesIcon)),
      h(
        'button',
        {
          type: 'button',
          className: 'wb-review-refresh wb-git-iconbtn',
          title: t('refresh'),
          'aria-label': t('refresh'),
          'data-busy': props.busy || undefined,
          disabled: props.busy,
          onClick: props.onRefresh,
        },
        h(RefreshIcon),
      ),
      status?.platform === 'darwin'
        ? h(
            'button',
            {
              type: 'button',
              className: 'wb-review-refresh wb-git-iconbtn',
              title: t('revealInFinder'),
              'aria-label': t('revealInFinder'),
              'aria-busy': props.opening || undefined,
              disabled: props.opening,
              onClick: () => props.onOpen('finder'),
            },
            h(FolderIcon),
          )
        : null,
      status?.platform === 'darwin'
        ? h(
            'button',
            {
              type: 'button',
              className: 'wb-review-refresh wb-git-iconbtn',
              title: t('openInTerminal'),
              'aria-label': t('openInTerminal'),
              'aria-busy': props.opening || undefined,
              disabled: props.opening,
              onClick: () => props.onOpen('terminal'),
            },
            h(TerminalIcon),
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'wb-review-refresh wb-git-iconbtn',
          title: t('commit'),
          'aria-label': t('commit'),
          onClick: props.onCommitFocus,
        },
        h(CommitIcon),
      ),
    ),
  )
}
