// Searchable directory groups; staging state stays separate from preview selection.

import { h, React } from '../react'
import { FileRow } from './FileRow'
import { chevronGlyph } from '../../icons'
import type { EntrySide, GitFileEntry, GitStatusPayload, Translate } from '../types'

export function ChangeList(props: {
  status: GitStatusPayload | null
  statusError: string
  rows: { staged: GitFileEntry[]; unstaged: GitFileEntry[]; conflicted: GitFileEntry[] }
  busy: boolean
  onBatch: (paths: string[], side: EntrySide) => void
  stats: Record<string, { additions: number; deletions: number }>
  selectedKey: string
  t: Translate
  onSelect: (entry: GitFileEntry, side: EntrySide) => void
  onToggle: (entry: GitFileEntry, side: EntrySide) => void
  onCopyPath: (entry: GitFileEntry) => void
  onContextMenu: (entry: GitFileEntry, side: EntrySide, event: any) => void
}): any {
  const { status, statusError, rows, t } = props
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [folded, setFolded] = React.useState<Record<string, boolean>>({})
  const items = (['conflicted', 'staged', 'unstaged'] as EntrySide[]).flatMap(side =>
    rows[side].map(entry => ({ entry, side })))
  const visible = items.filter(({ entry, side }) => (filter === 'all' || side === filter) && entry.path.toLowerCase().includes(query.toLowerCase()))
  const groups = new Map<string, typeof items>()
  for (const item of visible) {
    const dir = item.entry.path.includes('/') ? item.entry.path.slice(0, item.entry.path.lastIndexOf('/')) : '.'
    const key = item.side + ':' + dir
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(item)
  }
  return h('section', { className: 'wb-git-list', 'aria-label': t('pendingFiles') },
    h('div', { className: 'wb-git-list-tabs', role: 'tablist', 'aria-label': '文件状态' },
      [['all', '全部', status?.entries?.length ?? 0], ['staged', '已暂存', rows.staged.length], ['unstaged', '未暂存', rows.unstaged.length], ...(rows.conflicted.length ? [['conflicted', '冲突', rows.conflicted.length]] : [])].map(([key, label, count]) =>
        h('button', { key, className: 'glab-tab' + (filter === key ? ' glab-tab-active' : ''), type: 'button', role: 'tab', 'aria-selected': filter === key, onClick: () => setFilter(String(key)) }, label + ' ' + count))),
    h('div', { className: 'wb-git-file-tools' },
      h('input', { className: 'glab-input wb-git-search-input', value: query, placeholder: '搜索文件…', 'aria-label': '搜索文件', onChange: (e: any) => setQuery(e.target.value) }),
      h('button', { type: 'button', className: 'glab-btn', title: '暂存全部可见文件', 'aria-label': '暂存全部可见文件', disabled: props.busy || !visible.some(i => i.side === 'unstaged'), onClick: () => props.onBatch(visible.filter(i => i.side === 'unstaged').map(i => i.entry.path), 'unstaged') }, '+'),
      h('button', { type: 'button', className: 'glab-btn', title: '取消暂存可见文件', 'aria-label': '取消暂存可见文件', disabled: props.busy || !visible.some(i => i.side === 'staged'), onClick: () => props.onBatch(visible.filter(i => i.side === 'staged').map(i => i.entry.path), 'staged') }, '−')),
    h('div', { className: 'wb-git-file-scroll' },
      !status && !statusError ? h('div', { className: 'wb-git-placeholder' }, t('loading')) : items.length === 0
        ? h('div', { className: 'wb-git-empty' }, t('nothingToCommit'), h('span', { className: 'wb-git-empty-hint' }, t('nothingHint')))
        : visible.length === 0 ? h('div', { className: 'wb-git-placeholder' }, '没有匹配的文件')
        : [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
          const side = group[0].side
          const label = side === 'staged' ? '已暂存' : side === 'conflicted' ? '冲突' : '未暂存'
          return h('div', { key, className: 'wb-git-directory' },
            h('button', { type: 'button', className: 'wb-git-directory-head', 'aria-expanded': !folded[key], onClick: () => setFolded({ ...folded, [key]: !folded[key] }) },
              h('span', null, h('span', { className: 'wb-git-directory-caret', 'data-folded': folded[key] || undefined, 'aria-hidden': true }, chevronGlyph(16)), key.slice(key.indexOf(':') + 1)), h('small', null, label + ' · ' + group.length)),
            folded[key] ? null : group.map(({ entry, side }) => h(FileRow, {
              key: side + ':' + entry.path, entry, side, grouped: true, stats: props.stats[side + '\u0000' + entry.path], busy: props.busy,
              active: props.selectedKey === side + '\u0000' + entry.path, t,
              onSelect: props.onSelect, onToggle: props.onToggle, onContextMenu: props.onContextMenu,
            })))
        })))
}
