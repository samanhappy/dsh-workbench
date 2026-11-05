import { h, React } from '../react'
import { DiffBlockPrimitive } from '../../react'
import type { DiffFile, DiffPayload, EntrySide, GitFileEntry, Translate } from '../types'

/** Only adapt Git hunks to the public DSH renderer; DSH owns code and controls. */
export function DiffFileBlock({ file, t }: { file: DiffFile; t: Translate }): any {
  const root = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    // shortcut: DSH has no initial-wrap prop; use its accessible control until one is exported.
    root.current?.querySelectorAll<HTMLButtonElement>('[data-diff] button[aria-label="自动换行"][aria-pressed="false"]').forEach(button => button.click())
  }, [file])
  if (file.binary) return h('div', { className: 'wb-git-placeholder' }, t('binaryFile'))
  const NativeDiff = DiffBlockPrimitive
  if (!NativeDiff) return h('div', { className: 'wb-git-placeholder', role: 'status' }, '当前 DSH 未提供原生 Diff 组件，请升级 DSH。')
  return h('div', { className: 'wb-git-file-block', ref: root }, file.hunks.map((hunk, index) =>
    h('div', { className: 'wb-git-hunk', key: index }, h('div', { className: 'wb-git-diff-orig' }, hunk.header), h(NativeDiff, {
      diffs: [{ path: file.newPath || file.oldPath || '', oldText: hunk.lines.filter(line => line.kind === 'context' || line.kind === 'del').map(line => line.text).join('\n'), newText: hunk.lines.filter(line => line.kind === 'context' || line.kind === 'add').map(line => line.text).join('\n') }],
      labels: { codeLabel: '差异', wrapLabel: '自动换行', unwrapLabel: '取消自动换行', copy: '复制', copied: '已复制', collapseAria: '折叠差异', expandAria: (n: number) => `展开 ${n} 行`, collapse: '折叠', expand: (n: number) => `展开 ${n} 行` },
      maxLines: 200,
    }))))
}

export function DiffView(props: {
  selected: { entry: GitFileEntry; side: EntrySide } | null
  diff: DiffPayload | null
  loading: boolean
  hasChanges: boolean
  t: Translate
  onToggleFile: () => void
}): any {
  const { selected, diff, loading, t } = props
  const [change, setChange] = React.useState(0)
  const body = React.useRef<any>(null)
  React.useEffect(() => { setChange(0); if (body.current) body.current.scrollTop = 0 }, [selected?.entry.path, selected?.side, diff])
  const count = diff?.files?.reduce((sum, file) => sum + file.hunks.length, 0) ?? 0
  const navigate = (delta: number) => {
    const next = Math.max(0, Math.min(count - 1, change + delta))
    setChange(next)
    const target = body.current?.querySelectorAll('.wb-git-hunk')[next]
    if (target && body.current) body.current.scrollTop += target.getBoundingClientRect().top - body.current.getBoundingClientRect().top
  }
  const entry = selected?.entry ?? null
  const side = selected?.side ?? 'unstaged'
  const stats = diff?.stats
  const canAct = entry !== null && !entry.conflicted
  const actionLabel = side === 'staged' ? t('unstageFile') : t('stageFile')

  return h(
    'section',
    { className: 'wb-git-diff', 'aria-label': t('code') },
    h(
      'div',
      { className: 'wb-git-diff-head' },
      h('span', { className: 'wb-git-diff-path', title: entry?.path }, entry?.path ?? t('diff')),
      entry?.origPath
        ? h('span', { className: 'wb-git-diff-orig' }, t('renameFrom') + ' ' + entry.origPath)
        : null,
      stats && (stats.additions > 0 || stats.deletions > 0)
        ? h(
            'span',
            { className: 'wb-git-stats' },
            h('span', { className: 'wb-git-stat-add' }, '+' + String(stats.additions)),
            h('span', { className: 'wb-git-stat-del' }, '−' + String(stats.deletions)),
          )
        : null,
      canAct
        ? h(
            'button',
            {
              type: 'button',
              className: 'glab-btn',
              'data-kind': side === 'staged' ? 'unstage' : 'stage',
              onClick: props.onToggleFile,
            },
            actionLabel,
          )
        : null,
    h('div', { className: 'wb-git-diff-tools' },
      h('span', { className: 'wb-git-group-count' }, count ? (change + 1) + ' / ' + count : '0 处变更'),
      h('button', { type: 'button', className: 'glab-btn', disabled: !count || change === 0, onClick: () => navigate(-1) }, '↑ 上一处'),
      h('button', { type: 'button', className: 'glab-btn', disabled: !count || change >= count - 1, onClick: () => navigate(1) }, '↓ 下一处'))),
    h(
      'div',
      { className: 'wb-git-diff-body', ref: body },
      entry === null
        ? h('div', { className: 'wb-git-empty' }, props.hasChanges ? t('noFileSelected') : t('nothingHint'))
        : loading
          ? h('div', { className: 'wb-git-empty' }, t('loading'))
          : diff && diff.ok === false
            ? h('div', { className: 'wb-git-empty' }, diff.error || t('diffFailed'))
            : diff && diff.binary
              ? h('div', { className: 'wb-git-empty' }, t('binaryFile'))
              : diff && diff.files && diff.files.length > 0
                ? diff.files.map((file, index) => h(DiffFileBlock, { key: 'file:' + String(index), file, t }))
                : h(
                    'div',
                    { className: 'wb-git-empty' },
                    t('noDiff'),
                  ),
    ),
  )
}
