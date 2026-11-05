// One change row: checkbox, status badge, path, and a hover action. The row also
// answers right-click (and Shift+F10) with the panel context menu.

import { h } from '../react'
import type { EntrySide, GitFileEntry, Translate } from '../types'
import { splitPath, statusLetter, statusTone } from '../model'

function letterOf(entry: GitFileEntry, side: EntrySide): string {
  return statusLetter(entry, side)
}

export function FileRow(props: {
  entry: GitFileEntry
  side: EntrySide
  grouped?: boolean
  busy?: boolean
  stats?: { additions: number; deletions: number }
  active: boolean
  t: Translate
  onSelect: (entry: GitFileEntry, side: EntrySide) => void
  onToggle: (entry: GitFileEntry, side: EntrySide) => void
  onContextMenu: (entry: GitFileEntry, side: EntrySide, event: any) => void
}): any {
  const entry = props.entry
  const side = props.side
  const t = props.t
  const letter = letterOf(entry, side)
  const tone = statusTone(letter)
  const { dir, name } = splitPath(entry.path)
  const conflict = side === 'conflicted' || entry.conflicted
  const actionLabel = side === 'staged' ? t('unstageShort') : t('stageShort')
  const title = entry.origPath ? entry.path + ' — ' + t('renameFrom') + ' ' + entry.origPath : entry.path

  const openMenu = (event: any) => {
    event.preventDefault()
    props.onContextMenu(entry, side, event)
  }

  return h(
    'div',
    {
      className: 'wb-git-row',
      'data-active': props.active || undefined,
      'data-side': side,
      role: 'button',
      tabIndex: 0,
      title,
      onClick: () => props.onSelect(entry, side),
      onContextMenu: openMenu,
      onKeyDown: (event: any) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onSelect(entry, side)
        }
        if (event.key === 'F10' && event.shiftKey) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          props.onContextMenu(entry, side, { clientX: rect.left + 24, clientY: rect.top + 18, preventDefault() {} })
        }
      },
    },
    h('input', {
      type: 'checkbox',
      className: 'wb-git-check',
      checked: side === 'staged',
      disabled: conflict || props.busy,
      'aria-label': side === 'staged' ? t('unstageFile') : t('stageFile'),
      title: conflict ? t('conflictsBlockCommit') : actionLabel,
      onClick: (event: any) => event.stopPropagation(),
      onChange: () => props.onToggle(entry, side),
    }),
    h('span', { className: 'wb-git-badge', 'data-tone': tone }, letter),
    h(
      'span',
      { className: 'wb-git-path' },
      dir && !props.grouped ? h('span', { className: 'wb-git-path-dir' }, dir) : null,
      h('span', { className: 'wb-git-path-name' }, name),
    ),
    props.stats ? h('span', { className: 'wb-git-stats' }, h('span', { className: 'wb-git-stat-add' }, '+' + props.stats.additions), h('span', { className: 'wb-git-stat-del' }, '−' + props.stats.deletions)) : null,
    conflict
      ? h('span', { className: 'wb-act wb-act-accent wb-git-rowact', 'data-disabled': true, title: t('conflictsBlockCommit') }, t('conflict'))
      : h(
          'button',
          {
            type: 'button',
            className: 'wb-act wb-act-accent wb-git-rowact',
            disabled: props.busy,
            onClick: (event: any) => {
              event.stopPropagation()
              props.onToggle(entry, side)
            },
          },
          actionLabel,
        ),
  )
}
