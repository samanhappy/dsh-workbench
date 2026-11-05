// dsh-workbench — Issues page (IssuesView).
//
// GitLab Issue / GitHub Issue 列表与详情，数据来自 host 的 /forge/issues* 路由
// （本机 glab / gh CLI，见 src/host/issues.ts）：
//   /forge/issues       列表（scope/state/search/label/assignee/sort/page）
//   /forge/issue        详情（描述 + 评论 + 关联 MR）
//   /forge/issue/meta   标签/可指派成员（shared store，见 runtime.ts）
//   /forge/issue/update|close|reopen|note          写操作（即时失效缓存）
//
// 「处理」与 MR/PR 的「评审」同构：解析 Issue 仓库对应的工作区，在其中新建
// 会话并提交「仅分析、确认问题」的处理提示词（见 session.ts / prompts.ts）。
//
// 布局：搜索 + 状态/标签/负责人 + 排序工具条，
// 表格列表（状态/标题/标签/创建者/负责人/更新时间/评论/关联/操作），底部分页；
// 详情 = 主内容区（标题/描述 Markdown/评论）+ 右侧属性面板（状态/负责人/
// 标签/关联 MR/时间）。组件常挂载（display:none 切换），激活时才拉数据。

import { React, h, useLayout, MarkdownTextPrimitive } from '../react'
import { forgeFetch, useShellTick, useIssueMeta, refreshIssueMeta, type IssueMetaSnapshot } from '../runtime'
import { fmtTime, fmtTimeFull, repoPathFromIssueUrl, repoHomeUrl } from '../format'
import { findIssueWs, startItemSession } from '../session'
import { buildIssuePrompt } from '../prompts'
import {
  EmptyState, RefreshGlyph, chevronGlyph, checkGlyph, xGlyph, externalGlyph,
  clockCircleGlyph, checkCircleGlyph, searchGlyph, sortGlyph, bubbleGlyph, mergeGlyph,
} from '../icons'
import { ConfirmDialog, type ConfirmRequest } from './confirmdialog'
import { NoteComposer, ToastStack, useToasts } from './common'
import type { ForgeItem, ForgeNote, IssueItem, IssueListResult, IssuePerson, RelatedMr, WsData, WorkspaceView } from '../types'

// MarkdownText labels must be reference-stable across renders (a new object
// identity discards the primitive's streaming render cache — see its doc).
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

type IssueStateF = 'all' | 'opened' | 'closed'
type IssueSortF = 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc'

/** Related MR → ForgeItem so ForgePanel.openDetail can render it directly. */
function relatedToForgeItem(r: RelatedMr, forge: ForgeItem['forge']): ForgeItem {
  return {
    forge: forge,
    num: r.num,
    title: r.title,
    state: r.state,
    web_url: r.web_url,
    source_branch: r.source_branch,
    target_branch: r.target_branch,
  }
}

/** First-line plain excerpt of a markdown description (list row second line). */
function excerpt(text: string | null | undefined): string {
  const line = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
  return line.replace(/^[#>\-*\s]+/, '').replace(/[`*_\[\]]/g, '').slice(0, 90)
}

// ── small pieces ────────────────────────────────────────────────────────────

/** Avatar with graceful fallback to the initial (external images may fail). */
function Avatar(props: { person: IssuePerson | null; size?: number }) {
  const p = props.person
  const size = props.size || 20
  const [broken, setBroken] = React.useState(false)
  if (!p || (!p.avatar && !p.name)) {
    return h('span', { className: 'wb-iss-ava wb-iss-ava-empty', style: { width: size, height: size, fontSize: Math.round(size * 0.55) } }, '?')
  }
  if (!p.avatar || broken) {
    return h('span', { className: 'wb-iss-ava wb-iss-ava-letter', style: { width: size, height: size, fontSize: Math.round(size * 0.55) } },
      (p.name || p.username || '?').slice(0, 1).toUpperCase())
  }
  return h('img', {
    className: 'wb-iss-ava', src: p.avatar, width: size, height: size,
    alt: p.name || p.username, loading: 'lazy', referrerPolicy: 'no-referrer',
    onError: function () { setBroken(true) },
  })
}

/** Colored label chip (falls back to the neutral chip without a color).
 *  可读性不在这里算：文字色由 CSS 锚定主题文字色（--dsw-alias-label-primary）
 *  混入标签色，明暗主题都成立——面板是浅色主题时按亮度挑「原色/向白提亮」
 *  的旧方案会把淡彩标签冲成近白。 */
function LabelChip(props: { name: string; color?: string; onRemove?: () => void }) {
  const raw = String(props.color || '')
  const hex = /^#?[0-9a-fA-F]{6}$/.test(raw) ? (raw.startsWith('#') ? raw : '#' + raw) : ''
  // 名字包一层 span：chip 被 max-width 收窄时在 span 上真实省略（flex 容器
  // 自身的 text-overflow 不生效），移除按钮 × 仍可见。
  const kids: React.ReactNode[] = [h('span', { className: 'wb-iss-lbl-t' }, props.name)]
  if (props.onRemove) {
    kids.push(h('span', {
      className: 'wb-iss-lbl-x', role: 'button', 'aria-label': '移除标签 ' + props.name,
      onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); props.onRemove!() },
    }, '×'))
  }
  return h('span', {
    className: 'wb-iss-lbl' + (hex ? '' : ' wb-iss-lbl-plain'),
    title: props.name,
    style: hex ? ({ '--lbl-c': hex } as Record<string, string>) : undefined,
  }, kids)
}

/** Issue state glyph: 开启=绿时钟，关闭=红对勾（设计稿语义）。 */
function StateGlyph(props: { state: string; size?: number }) {
  const size = props.size || 15
  return h('span', { className: 'wb-iss-st wb-iss-st-' + (props.state === 'closed' ? 'closed' : 'open') },
    props.state === 'closed' ? checkCircleGlyph(size) : clockCircleGlyph(size))
}

const STATE_CHIP: Record<string, { label: string; kind: string }> = {
  opened: { label: '已开启', kind: 'review' },
  closed: { label: '已关闭', kind: 'closed' },
}

/** Generic disclosure dropdown (筛选/排序共用的触发按钮 + 弹出菜单).
 *  菜单内容经 props.children 以「渲染函数」传入（props 传函数，绕开
 *  createElement 对 function children 的类型限制）。 */
function Dropdown(props: {
  label: React.ReactNode
  active?: boolean
  width?: number
  children?: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const render = props.children
  return h('div', { className: 'wb-iss-dd' },
    h('button', {
      className: 'wb-iss-dd-btn' + (props.active || open ? ' wb-iss-dd-on' : ''),
      'aria-haspopup': 'menu', 'aria-expanded': open,
      onClick: function () { setOpen(!open) },
    }, props.label, chevronGlyph(11)),
    open && render
      ? h(React.Fragment, {},
          h('div', { className: 'wb-popbackdrop', onClick: function () { setOpen(false) } }),
          h('div', { className: 'wb-iss-dd-menu', style: props.width ? { minWidth: props.width } : undefined, role: 'menu' },
            render(function () { setOpen(false) })))
      : null)
}

function DropdownItem(props: { label: string; active: boolean; onPick(): void }) {
  return h('button', {
    className: 'wb-iss-dd-item' + (props.active ? ' wb-iss-dd-item-on' : ''),
    onClick: props.onPick,
  }, props.label, props.active ? h('span', { className: 'wb-iss-dd-check' }, checkGlyph(12)) : null)
}

// ── list row ────────────────────────────────────────────────────────────────

function IssueRow(props: {
  item: IssueItem
  labelColor: (name: string) => string | undefined
  selected: boolean
  busy: boolean
  onToggle(num: string, on: boolean): void
  onOpen(item: IssueItem): void
  onOpenRelated(r: RelatedMr, forge: ForgeItem['forge']): void
  onHandle?(item: IssueItem): void
  handleWs?: { view: { path: string } } | null
}) {
  const it = props.item
  const labels = (it.labels || [])
  const labelChips: React.ReactNode[] = []
  for (const l of labels.slice(0, 3)) {
    labelChips.push(h(LabelChip, { key: l, name: l, color: props.labelColor(l) }))
  }
  if (labels.length > 3) labelChips.push(h('span', { key: 'more', className: 'wb-iss-lbl-more' }, '+' + (labels.length - 3)))
  const rel = it.related && it.related.length ? it.related : null
  const relCell: React.ReactNode[] = []
  if (rel) {
    relCell.push(h('button', {
      key: 'rel', className: 'wb-iss-rel', title: rel[0].title || ('MR !' + rel[0].num),
      disabled: props.busy,
      onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); props.onOpenRelated(rel[0], it.forge) },
    }, mergeGlyph(11), '!' + rel[0].num,
      rel.length > 1 ? h('span', { className: 'wb-iss-rel-more' }, '+' + (rel.length - 1)) : null))
  } else if ((it.mr_count || 0) > 0) {
    relCell.push(h('span', { key: 'cnt', className: 'wb-iss-rel-count', title: '关联 ' + it.mr_count + ' 个 MR/PR（打开详情查看）' },
      mergeGlyph(11), String(it.mr_count)))
  } else {
    relCell.push(h('span', { key: 'none', className: 'wb-iss-none' }, '-'))
  }
  return h('div', { className: 'wb-iss-row' + (props.selected ? ' wb-iss-row-sel' : '') },
    h('label', { className: 'wb-iss-cell wb-iss-cell-check', onClick: function (e: { stopPropagation(): void }) { e.stopPropagation() } },
      h('input', {
        type: 'checkbox', checked: props.selected, 'aria-label': '选择 Issue #' + it.num,
        onChange: function (e: React.ChangeEvent<HTMLInputElement>) { props.onToggle(String(it.num), e.target.checked) },
      })),
    h('span', { className: 'wb-iss-cell wb-iss-cell-state' }, h(StateGlyph, { state: it.state })),
    h('button', { type: 'button', className: 'wb-iss-cell wb-iss-cell-title', onClick: function () { props.onOpen(it) } },
      h('div', { className: 'wb-iss-title', title: it.title || '(无标题)' }, it.title || '(无标题)'),
      h('div', { className: 'wb-iss-sub' },
        h('span', { className: 'wb-iss-num' }, '#' + it.num),
        it.description ? h('span', { className: 'wb-iss-desc' }, excerpt(it.description)) : null)),
    h('div', { className: 'wb-iss-cell wb-iss-cell-labels' },
      labelChips.length
        ? labelChips
        : h('span', { className: 'wb-iss-none' }, '-')),
    h('div', { className: 'wb-iss-cell wb-iss-cell-user' },
      h(Avatar, { person: it.author }),
      h('span', { className: 'wb-iss-user' }, (it.author && (it.author.name || it.author.username)) || '?')),
    h('div', { className: 'wb-iss-cell wb-iss-cell-user' },
      it.assignees.length
        ? it.assignees.slice(0, 2).map(function (a) {
            return h(React.Fragment, { key: a.username },
              h(Avatar, { person: a }),
              h('span', { className: 'wb-iss-user' }, a.name || a.username))
          })
        : h('span', { className: 'wb-iss-none' }, '未指派')),
    h('span', { className: 'wb-iss-cell wb-iss-cell-time', title: fmtTimeFull(it.updated_at) }, fmtTime(it.updated_at)),
    h('span', { className: 'wb-iss-cell wb-iss-cell-comments' },
      it.comment_count != null
        ? h(React.Fragment, {}, bubbleGlyph(12), h('span', { className: 'wb-iss-cnt' }, String(it.comment_count)))
        : h('span', { className: 'wb-iss-none' }, '-')),
    h('span', { className: 'wb-iss-cell wb-iss-cell-rel' }, relCell),
    h('span', { className: 'wb-iss-cell wb-iss-cell-act' },
      it.state === 'opened' && props.onHandle && props.handleWs
        ? h('button', {
            className: 'wb-act wb-act-violet', disabled: props.busy,
            title: '在对应工作区发起新的处理会话：' + props.handleWs.view.path,
            onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); props.onHandle!(it) },
          }, '处理')
        : null))
}

// ── edit form（详情「编辑」面板）─────────────────────────────────────────────

function IssueEditForm(props: {
  item: IssueItem
  members: Array<{ username: string; name: string }>
  busy: boolean
  onSubmit(fields: {
    title?: string
    description?: string
    addLabels: string[]
    removeLabels: string[]
    addAssignees: string[]
    removeAssignees: string[]
  }): void
  onCancel(): void
}) {
  const it = props.item
  const [title, setTitle] = React.useState(it.title || '')
  const [description, setDescription] = React.useState(it.description || '')
  const [labels, setLabels] = React.useState<string[]>((it.labels || []).slice())
  const [assignees, setAssignees] = React.useState<string[]>(it.assignees.map(function (a) { return a.username }))
  const [labelInput, setLabelInput] = React.useState('')

  function diffLabels(next: string[], orig: string[]): { add: string[]; remove: string[] } {
    return {
      add: next.filter(function (l) { return !orig.includes(l) }),
      remove: orig.filter(function (l) { return !next.includes(l) }),
    }
  }
  function addLabelsFromInput() {
    const parts = labelInput.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    if (!parts.length) return
    setLabels(function (prev) {
      const next = prev.slice()
      for (const p of parts) if (!next.includes(p)) next.push(p)
      return next
    })
    setLabelInput('')
  }
  const labelDiff = diffLabels(labels, it.labels || [])
  const assigneeDiff = diffLabels(assignees, it.assignees.map(function (a) { return a.username }))
  const unchanged = title.trim() === (it.title || '') && description === (it.description || '') &&
    !labelDiff.add.length && !labelDiff.remove.length && !assigneeDiff.add.length && !assigneeDiff.remove.length

  return h('div', { className: 'wb-iss-edit' },
    h('div', { className: 'glab-field' },
      h('label', { className: 'glab-label' }, '标题'),
      h('input', { className: 'glab-input', value: title, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value) })),
    h('div', { className: 'glab-field' },
      h('label', { className: 'glab-label' }, '描述'),
      h('textarea', { className: 'glab-input glab-textarea', value: description, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value) })),
    h('div', { className: 'glab-field' },
      h('label', { className: 'glab-label' }, '标签'),
      labels.length ? h('div', { className: 'wb-iss-edit-chips' },
        labels.map(function (l) {
          return h(LabelChip, { key: l, name: l, onRemove: function () { setLabels(labels.filter(function (x) { return x !== l })) } })
        })) : null,
      h('div', { className: 'glab-row' },
        h('input', {
          className: 'glab-input wb-iss-edit-input', value: labelInput,
          placeholder: '添加标签，逗号分隔，回车确认',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setLabelInput(e.target.value),
          onKeyDown: function (e: React.KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); addLabelsFromInput() } },
        }),
        h('button', { className: 'glab-btn', disabled: !labelInput.trim(), onClick: addLabelsFromInput }, '添加'))),
    h('div', { className: 'glab-field' },
      h('label', { className: 'glab-label' }, '负责人'),
      assignees.length ? h('div', { className: 'wb-iss-edit-chips' },
        assignees.map(function (u) {
          return h('span', { key: u, className: 'wb-iss-lbl wb-iss-lbl-plain' }, u,
            h('span', {
              className: 'wb-iss-lbl-x', role: 'button', 'aria-label': '移除负责人 ' + u,
              onClick: function () { setAssignees(assignees.filter(function (x) { return x !== u })) },
            }, '×'))
        })) : h('span', { className: 'wb-iss-none' }, '未指派'),
      props.members.length
        ? h('select', {
            className: 'glab-input wb-iss-select wb-iss-edit-select', value: '',
            onChange: function (e: React.ChangeEvent<HTMLSelectElement>) {
              const u = e.target.value
              if (u) setAssignees(function (prev) { return prev.includes(u) ? prev : prev.concat(u) })
            },
          },
            h('option', { value: '' }, '从成员中添加负责人…'),
            props.members
              .filter(function (m) { return !assignees.includes(m.username) })
              .map(function (m) {
                return h('option', { key: m.username, value: m.username }, m.name === m.username ? m.username : m.name + '（' + m.username + '）')
              }))
        : null),
    h('div', { className: 'glab-row' },
      h('button', {
        className: 'glab-btn glab-btn-primary', disabled: props.busy || unchanged,
        onClick: function () {
          props.onSubmit({
            title: title.trim() === (it.title || '') ? undefined : title.trim(),
            description: description === (it.description || '') ? undefined : description,
            addLabels: labelDiff.add, removeLabels: labelDiff.remove,
            addAssignees: assigneeDiff.add, removeAssignees: assigneeDiff.remove,
          })
        },
      }, props.busy ? '保存中…' : '保存修改'),
      h('button', { className: 'glab-btn', disabled: props.busy, onClick: props.onCancel }, '取消')))
}

// ── main view ───────────────────────────────────────────────────────────────

export interface IssuesViewProps {
  /** 选中的工作区 cwd（ForgePanel 仓库选择器）。 */
  activeCwd: string | null
  /** 二级导航当前停在 Issues（未激活时不发任何请求）。 */
  active: boolean
  /** /forge/state 的 viewer 用户名（可能未知）。 */
  viewer: string | null
  /** ForgePanel 刷新按钮信号（递增即强制重拉）。 */
  refreshTick: number
  /** 关联 MR 点击 → MR/PR 详情。 */
  onOpenMr(mr: ForgeItem): void
  /** /forge/workspaces 检测结果（「处理」解析工作区用；共享 store）。 */
  wsData: WsData | null
  /** 工作区注册表视图（带 workspaceId，会话控制器据此寻址）。 */
  wsItems: WorkspaceView[]
}

interface IssueDetailState {
  item: IssueItem
  loading: boolean
  error: string | null
}

const SORT_LABELS: Record<IssueSortF, string> = {
  updated_desc: '最新更新',
  updated_asc: '最早更新',
  created_desc: '最新创建',
  created_asc: '最早创建',
}

export function IssuesView(props: IssuesViewProps) {
  const cwd = props.activeCwd
  // 视图口径：固定全仓库数据（无 scope 页签），默认仅显示未关闭 Issue——
  // 看已关闭/全部走工具条的状态下拉。
  const [stateF, setStateF] = React.useState<IssueStateF>('opened')
  const [labelF, setLabelF] = React.useState('')
  const [assigneeF, setAssigneeF] = React.useState('')
  const [sort, setSort] = React.useState<IssueSortF>('updated_desc')
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [searchInput, setSearchInput] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [list, setList] = React.useState<IssueListResult | null>(null)
  const [listError, setListError] = React.useState<string | null>(null)
  const [listLoading, setListLoading] = React.useState(false)
  const [detail, setDetail] = React.useState<IssueDetailState | null>(null)
  const [editOpen, setEditOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [handling, setHandling] = React.useState(false) // one 处理 session start at a time
  const [noteBusy, setNoteBusy] = React.useState(false)
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [toasts, pushToast, dismissToast] = useToasts()
  const meta = useIssueMeta(cwd)

  const metaLabels = (meta && meta.labels) || []
  function labelColor(name: string): string | undefined {
    for (const l of metaLabels) if (l.name === name) return l.color
    return undefined
  }

  // 任何过滤条件变化都回到第 1 页（与该过滤的 setter 成对调用；已在第 1 页时
  // setPage(1) 被 React 原地吞掉，不触发多余请求）。
  function resetPage() {
    setPage(1)
  }

  // 搜索防抖提交（450ms 静默后提交，避免逐键执行 CLI）。
  React.useEffect(function () {
    const t = setTimeout(function () {
      const next = searchInput.trim()
      if (next !== search) {
        setSearch(next)
        setPage(1)
      }
    }, 450)
    return function () { clearTimeout(t) }
  }, [searchInput, search])

  const listReqRef = React.useRef(0)
  const loadList = React.useCallback(async function (force: boolean) {
    const req = ++listReqRef.current
    setListLoading(true)
    setListError(null)
    try {
      const parts = ['scope=all', 'state=' + stateF, 'sort=' + sort, 'page=' + page, 'pageSize=' + pageSize]
      if (search) parts.push('search=' + encodeURIComponent(search))
      if (labelF) parts.push('label=' + encodeURIComponent(labelF))
      if (assigneeF) parts.push('assignee=' + encodeURIComponent(assigneeF))
      if (cwd) parts.push('cwd=' + encodeURIComponent(cwd))
      const data = await forgeFetch('/forge/issues?' + parts.join('&') + (force ? '&force=1' : ''))
      if (req !== listReqRef.current) return
      setList(data)
      if (data && data.ok === false) setListError(String(data.error || '加载失败'))
    } catch (e) {
      if (req !== listReqRef.current) return
      setListError(String(e instanceof Error ? e.message : e))
    }
    if (req === listReqRef.current) setListLoading(false)
  }, [stateF, sort, page, pageSize, search, labelF, assigneeF, cwd])

  // 激活 / 过滤条件变化 / 外壳心跳 → 重拉（force=false 命中 host 缓存）。
  const tick = useShellTick()
  useLayout(function () {
    if (!props.active) return
    loadList(false)
  }, [loadList, tick, props.active])

  // ForgePanel 顶部刷新按钮 → force 重拉列表与统计。
  useLayout(function () {
    if (!props.active || props.refreshTick === 0) return
    loadList(true)
    void refreshIssueMeta(cwd, true)
  }, [props.refreshTick])

  // 激活时拉统计/标签/成员（TTL 内与统计卡共享一份）。
  useLayout(function () {
    if (props.active) void refreshIssueMeta(cwd, false)
  }, [props.active, cwd])

  // ── detail loading（seq guard 同 ForgePanel）──────────────────────────────
  const detailReqRef = React.useRef(0)

  // 列表/详情在根节点同一位置原地换 div（仅 className 变，DOM 节点复用），
  // 滚动容器因此残留列表的 scrollTop，详情会从列表的滚动位置打开。这里显式
  // 管理：开详情前记住列表滚动位置，详情打开置顶，返回列表时恢复原位置。
  // detailOpen 只在列表↔详情切换时翻转，详情内的刷新/编辑不打断用户滚动。
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const savedListScroll = React.useRef(0)
  const detailOpen = detail !== null
  useLayout(function () {
    const el = scrollRef.current
    if (!el) return
    if (detailOpen) el.scrollTop = 0
    else el.scrollTop = savedListScroll.current
  }, [detailOpen])

  function fetchDetail(item: IssueItem, req: number) {
    const parts = ['num=' + encodeURIComponent(String(item.num))]
    if (cwd) parts.push('cwd=' + encodeURIComponent(cwd))
    forgeFetch('/forge/issue?' + parts.join('&'))
      .then(function (data) {
        if (req !== detailReqRef.current) return
        if (data && data.ok === false) {
          setDetail(function (d) { return d ? Object.assign({}, d, { loading: false, error: String(data.error || '加载失败') }) : d })
        } else {
          setDetail(function (d) {
            if (!d) return d
            return Object.assign({}, d, { item: (data && (data.issue as IssueItem)) || item, loading: false, error: null })
          })
        }
      })
      .catch(function (e) {
        if (req !== detailReqRef.current) return
        setDetail(function (d) { return d ? Object.assign({}, d, { loading: false, error: String(e instanceof Error ? e.message : e) }) : d })
      })
  }

  function openDetail(item: IssueItem) {
    const req = ++detailReqRef.current
    setEditOpen(false)
    // 列表滚动位置在换到详情前保存（滚动节点会被详情复用，scrollTop 不重置）。
    const el = scrollRef.current
    if (el && !detail) savedListScroll.current = el.scrollTop
    setDetail({ item: item, loading: true, error: null })
    fetchDetail(item, req)
  }

  function reloadDetail() {
    let live: IssueItem | null = null
    setDetail(function (d) {
      if (d) { live = d.item; return Object.assign({}, d, { loading: true }) }
      return d
    })
    if (!live) return
    const req = ++detailReqRef.current
    fetchDetail(live as IssueItem, req)
  }

  /** 写操作统一走这里：POST → toast → 强刷列表/统计 → 详情在开则重拉。 */
  async function issueAct(path: string, body: Record<string, unknown>, okText: string, onDone?: (res: Record<string, unknown>) => void) {
    setBusy(true)
    try {
      const res = await forgeFetch(path, {
        method: 'POST',
        body: Object.assign({}, body, cwd ? { cwd: cwd } : {}),
      })
      if (res && res.ok === false) {
        pushToast('err', '操作失败：' + (res.error || '未知错误'))
      } else {
        pushToast('ok', okText)
        if (onDone) onDone(res)
      }
    } catch (e) {
      pushToast('err', '操作失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(false)
    void loadList(true)
    void refreshIssueMeta(cwd, true)
    reloadDetail()
  }

  async function submitNote(num: string | number, text: string) {
    setNoteBusy(true)
    try {
      const res = await forgeFetch('/forge/issue/note', {
        method: 'POST',
        body: Object.assign({ num: num, body: text }, cwd ? { cwd: cwd } : {}),
      })
      if (res && res.ok === false) {
        pushToast('err', '评论失败：' + (res.error || '未知错误'))
        return false
      }
      pushToast('ok', '评论已发表')
      void loadList(true)
      reloadDetail()
      return true
    } catch (e) {
      pushToast('err', '评论失败：' + String(e instanceof Error ? e.message : e))
      return false
    } finally {
      setNoteBusy(false)
    }
  }

  /** 批量关闭 / 重新打开（逐条 POST，聚合结果 toast）。 */
  function batchSetState(next: 'closed' | 'opened') {
    const items = (list && list.issues) || []
    const targets = items.filter(function (it) { return selected.has(String(it.num)) && it.state !== next })
    if (!targets.length) {
      pushToast('err', next === 'closed' ? '所选 Issue 均已关闭' : '所选 Issue 均已开启')
      return
    }
    const verb = next === 'closed' ? '关闭' : '重新打开'
    setConfirmReq({
      title: verb + ' ' + targets.length + ' 个 Issue？',
      lines: targets.slice(0, 3).map(function (it) { return '#' + it.num + ' ' + (it.title || '(无标题)') })
        .concat(targets.length > 3 ? ['…等共 ' + targets.length + ' 条'] : []),
      okLabel: '确认' + verb,
      danger: next === 'closed',
      onOk: function () {
        setBusy(true)
        let done = 0
        let failed = 0
        const run = function (i: number): void {
          if (i >= targets.length) {
            setBusy(false)
            setSelected(new Set())
            if (failed) pushToast('err', verb + '完成：' + done + ' 成功，' + failed + ' 失败')
            else pushToast('ok', '已' + verb + ' ' + done + ' 个 Issue')
            void loadList(true)
            void refreshIssueMeta(cwd, true)
            return
          }
          const it = targets[i]
          forgeFetch('/forge/issue/' + (next === 'closed' ? 'close' : 'reopen'), {
            method: 'POST',
            body: Object.assign({ num: it.num }, cwd ? { cwd: cwd } : {}),
          }).then(function () { done += 1 })
            .catch(function () { failed += 1 })
            .then(function () { run(i + 1) })
        }
        run(0)
      },
    })
  }

  function toggleAll(on: boolean) {
    const items = (list && list.issues) || []
    if (!on) { setSelected(new Set()); return }
    const next = new Set<string>()
    for (const it of items) next.add(String(it.num))
    setSelected(next)
  }

  /** 「处理」: open a NEW session in the workspace owning the issue's repo and
   *  submit the (analysis-only) issue prompt into it — same session bridge as
   *  the MR/PR 「评审」 button (src/client/session.ts). Workspace resolution:
   *  the panel's active cwd wins, else any registered workspace whose git
   *  remote matches the issue web_url's repo path. */
  async function startHandle(item: IssueItem) {
    if (handling) return
    const ws = findIssueWs(item, cwd, props.wsData, props.wsItems)
    if (!ws) {
      pushToast('err', '未找到该 Issue 对应的工作区：没有哪个已注册工作区的 git remote 指向 ' +
        (repoPathFromIssueUrl(item.web_url) || '该 Issue 的仓库') +
        '。请先在 DSH 中添加该仓库的工作区目录。')
      return
    }
    setHandling(true)
    const res = await startItemSession(
      ws,
      buildIssuePrompt(item),
      '处理 #' + item.num + ' ' + (item.title || ''),
    )
    if (!res.ok) {
      if (res.code === 'no-uiworkspace') pushToast('err', '当前 DSH 未提供 uiWorkspace 服务，无法发起新会话（请升级 DSH）')
      else if (res.code === 'no-prompt') pushToast('err', '处理会话已打开，但无法自动发送处理指令，请手动粘贴处理要求')
      else if (res.code === 'prompt-failed') pushToast('err', '处理指令发送失败：' + (res.error || '未知错误'))
      else pushToast('err', '发起处理会话失败：' + (res.error || '未知错误'))
    }
    setHandling(false)
  }

  // ── render pieces ─────────────────────────────────────────────────────────

  function renderToolbar() {
    const stateLabel = stateF === 'opened' ? '已开启' : stateF === 'closed' ? '已关闭' : '全部状态'
    const members = (meta && meta.members) || []
    const assigneeNames = members.map(function (m) { return m.username })
    const assigneeLabel = assigneeF
      ? (assigneeNames.includes(assigneeF)
          ? (members.filter(function (m) { return m.username === assigneeF })[0] || { name: assigneeF }).name
          : assigneeF)
      : '负责人'
    return h('div', { className: 'wb-iss-toolbar' },
      h('div', { className: 'wb-iss-search' },
        h('span', { className: 'wb-iss-search-ic' }, searchGlyph(13)),
        h('input', {
          className: 'glab-input wb-iss-search-input', value: searchInput,
          placeholder: '搜索 Issue / 标题 / 编号',
          onChange: function (e: React.ChangeEvent<HTMLInputElement>) { setSearchInput(e.target.value) },
          onKeyDown: function (e: React.KeyboardEvent) { if (e.key === 'Enter') { setSearch(searchInput.trim()); resetPage() } },
        }),
        searchInput ? h('button', {
          className: 'wb-iss-search-x', 'aria-label': '清空搜索',
          onClick: function () { setSearchInput(''); setSearch(''); resetPage() },
        }, xGlyph(11)) : null),
      h(Dropdown, {
        key: 'state', label: stateLabel, active: stateF !== 'all', width: 120,
        children: function (close: () => void) {
          return [
            h(DropdownItem, { key: 'all', label: '全部状态', active: stateF === 'all', onPick: function () { setStateF('all'); resetPage(); close() } }),
            h(DropdownItem, { key: 'o', label: '已开启', active: stateF === 'opened', onPick: function () { setStateF('opened'); resetPage(); close() } }),
            h(DropdownItem, { key: 'c', label: '已关闭', active: stateF === 'closed', onPick: function () { setStateF('closed'); resetPage(); close() } }),
          ]
        },
      }),
      h(Dropdown, {
        key: 'label', label: labelF || '标签', active: !!labelF, width: 200,
        children: function (close: () => void) {
          const names = metaLabels.map(function (l) { return l.name })
          return [
            h(DropdownItem, { key: 'all', label: '全部标签', active: !labelF, onPick: function () { setLabelF(''); resetPage(); close() } }),
            names.length
              ? names.map(function (n) {
                  return h(DropdownItem, { key: n, label: n, active: labelF === n, onPick: function () { setLabelF(n); resetPage(); close() } })
                })
              : h('div', { key: 'none', className: 'wb-iss-dd-note' }, '本仓库暂无标签'),
          ]
        },
      }),
      h(Dropdown, {
        key: 'assignee', label: assigneeLabel, active: !!assigneeF, width: 200,
        children: function (close: () => void) {
          return [
            h(DropdownItem, { key: 'all', label: '全部负责人', active: !assigneeF, onPick: function () { setAssigneeF(''); resetPage(); close() } }),
            members.length
              ? members.map(function (m) {
                  return h(DropdownItem, {
                    key: m.username, label: (m.name === m.username ? m.username : m.name + '（' + m.username + '）'),
                    active: assigneeF === m.username,
                    onPick: function () { setAssigneeF(m.username); resetPage(); close() },
                  })
                })
              : h('div', { key: 'none', className: 'wb-iss-dd-note' }, '未获取到可指派成员'),
          ]
        },
      }),
      searchInput || search || labelF || assigneeF || stateF !== 'opened' || sort !== 'updated_desc'
        ? h('button', {
            className: 'glab-btn',
            onClick: function () {
              setSearchInput(''); setSearch(''); setLabelF(''); setAssigneeF('')
              setStateF('opened'); setSort('updated_desc'); resetPage()
            },
          }, '重置筛选')
        : null,
      h('span', { className: 'wb-iss-toolbar-spacer' }),
      h(Dropdown, {
        key: 'sort', label: h(React.Fragment, {}, sortGlyph(12), SORT_LABELS[sort]), width: 140,
        children: function (close: () => void) {
          return (Object.keys(SORT_LABELS) as IssueSortF[]).map(function (k) {
            return h(DropdownItem, { key: k, label: SORT_LABELS[k], active: sort === k, onPick: function () { setSort(k); resetPage(); close() } })
          })
        },
      }))
  }

  function renderBatchBar() {
    if (!selected.size) return null
    return h('div', { className: 'wb-iss-batch' },
      h('span', { className: 'wb-iss-batch-count' }, '已选 ' + selected.size + ' 条'),
      h('button', { className: 'glab-btn', disabled: busy, onClick: function () { batchSetState('opened') } }, '批量重新打开'),
      h('button', { className: 'glab-btn glab-btn-red', disabled: busy, onClick: function () { batchSetState('closed') } }, '批量关闭'),
      h('button', { className: 'glab-btn', disabled: busy, onClick: function () { setSelected(new Set()) } }, '取消选择'))
  }

  function renderTable() {
    const items = (list && list.issues) || []
    const allSel = items.length > 0 && items.every(function (it) { return selected.has(String(it.num)) })
    const head = h('div', { className: 'wb-iss-head' },
      h('label', { className: 'wb-iss-cell wb-iss-cell-check' },
        h('input', { type: 'checkbox', checked: allSel, onChange: function (e: React.ChangeEvent<HTMLInputElement>) { toggleAll(e.target.checked) } })),
      h('span', { className: 'wb-iss-cell wb-iss-cell-state' }, '状态'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-title' }, '标题'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-labels' }, '标签'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-user' }, '创建者'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-user' }, '负责人'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-time' }, '更新时间'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-comments' }, '评论'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-rel' }, '关联'),
      h('span', { className: 'wb-iss-cell wb-iss-cell-act' }, '操作'))
    return h('div', { className: 'wb-iss-card' },
      head,
      listLoading && !items.length
        ? h('div', { className: 'wb-iss-body' },
            h('div', { className: 'glab-skel', style: { margin: '8px 12px', width: '92%' } }),
            h('div', { className: 'glab-skel', style: { margin: '8px 12px', width: '85%' } }),
            h('div', { className: 'glab-skel', style: { margin: '8px 12px', width: '89%' } }))
        : listError
          ? h('div', { className: 'wb-iss-body' },
              h('div', { className: 'glab-error' }, listError),
              h('div', { style: { padding: '0 12px 10px' } },
                h('button', { className: 'glab-btn', onClick: function () { void loadList(true) } }, '重试')))
          : items.length
            ? h('div', { className: 'wb-iss-body' },
                items.map(function (it) {
                  return h(IssueRow, {
                    key: it.forge + ':' + it.num,
                    item: it,
                    labelColor: labelColor,
                    selected: selected.has(String(it.num)),
                    busy: busy,
                    onToggle: function (num, on) {
                      setSelected(function (prev) {
                        const next = new Set(prev)
                        if (on) next.add(num)
                        else next.delete(num)
                        return next
                      })
                    },
                    onOpen: openDetail,
                    onOpenRelated: function (r, forge) { props.onOpenMr(relatedToForgeItem(r, forge)) },
                    onHandle: startHandle,
                    handleWs: findIssueWs(it, cwd, props.wsData, props.wsItems),
                  })
                }))
            : h('div', { className: 'wb-iss-body' },
                h(EmptyState, {
                  title: '没有相关记录',
                  hint: search || labelF || assigneeF || stateF !== 'all'
                    ? '调整筛选条件'
                    : '切换工作区重试',
                })))
  }

  function renderPager() {
    const items = (list && list.issues) || []
    const total = list ? list.total : null
    const hasMore = !!(list && list.hasMore)
    return h('div', { className: 'wb-iss-foot' },
      h('span', { className: 'wb-iss-foot-total' },
        typeof total === 'number' ? '共 ' + total + ' 条' : (items.length ? '第 ' + page + ' 页' : '')),
      h('span', { className: 'wb-iss-foot-spacer' }),
      h('button', { className: 'wb-iss-page-btn', disabled: page <= 1, 'aria-label': '上一页', onClick: function () { setPage(page - 1) } }, '‹'),
      h('span', { className: 'wb-iss-page-cur' }, String(page)),
      h('button', { className: 'wb-iss-page-btn', disabled: !hasMore, 'aria-label': '下一页', onClick: function () { setPage(page + 1) } }, '›'),
      h('select', {
        className: 'glab-input wb-iss-pagesize', value: String(pageSize), 'aria-label': '每页条数',
        onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { setPageSize(Number(e.target.value)); resetPage() },
      },
        h('option', { value: '20' }, '20 条/页'),
        h('option', { value: '50' }, '50 条/页')))
  }

  /** aside 属性卡（标题 + 内容行）。 */
  function asideCard(key: string, title: string, body: React.ReactNode) {
    return h('div', { key: key, className: 'wb-iss-aside-card' },
      h('div', { className: 'wb-iss-aside-h' }, title),
      h('div', { className: 'wb-iss-aside-b' }, body))
  }

  function renderDetail() {
    const d = detail
    if (!d) return null
    const it = d.item
    const repoPath = repoPathFromIssueUrl(it.web_url)
    const chip = STATE_CHIP[it.state] || STATE_CHIP.opened
    const notes = it.notes || []
    const commentsCount = notes.length || (it.comment_count != null ? it.comment_count : 0)
    const related = it.related || []

    const actions: React.ReactNode[] = []
    // 「处理」与 MR/PR 详情的「评审」同构：仅在能解析出对应工作区时出现。
    const handleWs = findIssueWs(it, cwd, props.wsData, props.wsItems)
    if (it.state === 'opened' && handleWs) {
      actions.push(h('button', {
        key: 'handle', className: 'glab-btn', disabled: busy || handling,
        onClick: function () { void startHandle(it) },
        title: '在对应工作区发起新的处理会话：' + handleWs.view.path,
      }, '处理'))
    }
    actions.push(h('button', {
      key: 'edit', className: 'glab-btn', disabled: busy,
      onClick: function () { setEditOpen(!editOpen) },
    }, '编辑'))
    if (it.state === 'closed') {
      actions.push(h('button', {
        key: 'reopen', className: 'glab-btn', disabled: busy,
        onClick: function () {
          setConfirmReq({
            title: '重新打开 #' + it.num + '？',
            lines: [it.title || '(无标题)'],
            okLabel: '确认重新打开',
            onOk: function () { void issueAct('/forge/issue/reopen', { num: it.num }, '已重新打开 #' + it.num) },
          })
        },
      }, '重新打开'))
    } else {
      actions.push(h('button', {
        key: 'close', className: 'glab-btn glab-btn-red', disabled: busy,
        onClick: function () {
          setConfirmReq({
            title: '关闭 #' + it.num + '？',
            lines: [it.title || '(无标题)'],
            okLabel: '确认关闭',
            danger: true,
            onOk: function () { void issueAct('/forge/issue/close', { num: it.num }, '已关闭 #' + it.num) },
          })
        },
      }, '关闭'))
    }

    const aside: React.ReactNode[] = []
    aside.push(asideCard('state', '状态',
      h('div', { className: 'wb-iss-aside-row' },
        h(StateGlyph, { state: it.state, size: 14 }),
        h('span', null, chip.label),
        it.state_reason === 'not_planned' ? h('span', { className: 'wb-iss-none' }, '（未计划）') : null)))
    aside.push(asideCard('assignees', '负责人',
      it.assignees.length
        ? h('div', { className: 'wb-iss-aside-people' },
            it.assignees.map(function (a) {
              return h('div', { key: a.username, className: 'wb-iss-aside-person' },
                h(Avatar, { person: a, size: 20 }),
                h('span', { className: 'wb-iss-user' }, a.name || a.username))
            }))
        : h('span', { className: 'wb-iss-none' }, '未指派')))
    aside.push(asideCard('labels', '标签',
      (it.labels || []).length
        ? h('div', { className: 'wb-iss-aside-chips' },
            it.labels.map(function (l) { return h(LabelChip, { key: l, name: l, color: labelColor(l) }) }))
        : h('span', { className: 'wb-iss-none' }, '无标签')))
    aside.push(asideCard('related', '关联 MR / PR',
      related.length
        ? h('div', { className: 'wb-iss-aside-rels' },
            related.map(function (r) {
              return h('button', {
                key: String(r.num), className: 'wb-iss-aside-rel',
                title: (r.title || '') + '（打开 MR/PR 详情）',
                onClick: function () { props.onOpenMr(relatedToForgeItem(r, it.forge)) },
              }, mergeGlyph(12), h('span', { className: 'wb-iss-rel-num' }, '!' + r.num),
                h('span', { className: 'wb-iss-aside-rel-title' }, r.title || '(无标题)'))
            }))
        : h('span', { className: 'wb-iss-none' }, '暂无关联')))
    aside.push(asideCard('time', '时间',
      h('div', { className: 'wb-iss-aside-kvs' },
        it.created_at ? h('div', { className: 'wb-iss-aside-kv' }, h('span', null, '创建'), h('span', { title: fmtTimeFull(it.created_at) }, fmtTimeFull(it.created_at))) : null,
        it.updated_at ? h('div', { className: 'wb-iss-aside-kv' }, h('span', null, '更新'), h('span', { title: fmtTimeFull(it.updated_at) }, fmtTimeFull(it.updated_at))) : null,
        it.closed_at ? h('div', { className: 'wb-iss-aside-kv' }, h('span', null, '关闭'), h('span', { title: fmtTimeFull(it.closed_at) }, fmtTimeFull(it.closed_at))) : null)))

    return h('div', { className: 'wb-iss-detail', ref: scrollRef },
      h('div', { className: 'wb-iss-main' },
        h('div', { className: 'wb-crumbs' },
          repoPath
            ? (it.web_url
                ? h('a', { key: 'r', className: 'wb-crumb-link', href: repoHomeUrl(it.web_url), target: '_blank', rel: 'noopener', title: '在网页打开仓库' }, repoPath)
                : h('span', { key: 'r', className: 'wb-crumb' }, repoPath))
            : null,
          repoPath ? h('span', { className: 'wb-crumb-sep' }, '/') : null,
          h('button', { className: 'wb-crumb-link', onClick: function () { setDetail(null); setEditOpen(false) } }, '← Issues'),
          h('span', { className: 'wb-crumb-sep' }, '/'),
          h('span', { className: 'wb-crumb-here' }, '#' + it.num),
          it.web_url ? h('a', {
            className: 'wb-act wb-mr-original', href: it.web_url,
            target: '_blank', rel: 'noopener noreferrer',
            title: '在网页打开 #' + it.num, 'aria-label': '在网页打开 #' + it.num,
          }, externalGlyph(14)) : null,
          h('button', {
            className: 'wb-detail-refresh', title: '刷新该详情', disabled: busy || d.loading,
            onClick: function () { reloadDetail() },
          }, RefreshGlyph(d.loading))),
        h('div', { className: 'wb-detail-title' },
          it.web_url
            ? h('a', { key: 'num', className: 'wb-title-iid', href: it.web_url, target: '_blank', rel: 'noopener', title: '在网页打开 #' + it.num }, '#' + it.num)
            : h('span', { key: 'num', className: 'wb-title-iid' }, '#' + it.num),
          h('span', { className: 'wb-title-text' }, it.title || '(无标题)')),
        h('div', { className: 'wb-detail-meta' },
          h('span', { className: 'wb-iss-st wb-iss-st-' + it.state }, h(StateGlyph, { state: it.state, size: 13 })),
          h('span', { className: 'wb-detail-author' }, (it.author && (it.author.name || it.author.username)) || '?'),
          it.created_at ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(it.created_at) }, '创建于 ' + fmtTime(it.created_at)) : null,
          it.updated_at ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(it.updated_at) }, '更新于 ' + fmtTime(it.updated_at)) : null),
        actions.length ? h('div', { className: 'wb-detail-actions' }, actions) : null,
        editOpen
          ? h(IssueEditForm, {
              item: it,
              members: (meta && meta.members) || [],
              busy: busy,
              onCancel: function () { setEditOpen(false) },
              onSubmit: function (fields) {
                void issueAct('/forge/issue/update', Object.assign({ num: it.num }, fields), '已更新 #' + it.num, function () {
                  setEditOpen(false)
                })
              },
            })
          : null,
        d.error ? h('div', { className: 'glab-error' }, d.error) : null,
        h('div', { className: 'wb-iss-desc-sec' },
          h('div', { className: 'wb-iss-sec-h' }, '描述'),
          d.loading && !it.description
            ? h('div', { className: 'glab-list' },
                h('div', { className: 'glab-skel', style: { width: '70%' } }),
                h('div', { className: 'glab-skel', style: { width: '92%' } }),
                h('div', { className: 'glab-skel', style: { width: '55%' } }))
            : it.description
              ? h('div', { className: 'glab-article' },
                  MarkdownTextPrimitive
                    ? h(MarkdownTextPrimitive, { text: it.description, streaming: false, labels: MD_LABELS })
                    : h('div', { className: 'glab-detail-desc' }, it.description))
              : h('div', { className: 'wb-meta' }, '（无描述）')),
        h('div', { className: 'wb-iss-notes-sec' },
          h('div', { className: 'wb-iss-sec-h' }, '评论', commentsCount > 0 ? h('span', { className: 'glab-badge' }, String(commentsCount)) : null),
          d.loading && !notes.length
            ? h('div', { className: 'glab-list' },
                h('div', { className: 'glab-skel', style: { width: '55%' } }),
                h('div', { className: 'glab-skel', style: { width: '80%' } }))
            : notes.length
              ? h('div', { className: 'wb-notes-list' },
                  notes.map(function (n: ForgeNote, i: number) {
                    return h('div', { key: i, className: 'wb-note' },
                      h('div', { className: 'wb-note-head' },
                        h('span', { className: 'wb-note-author' }, n.author || '?'),
                        h('span', { className: 'wb-note-time', title: fmtTimeFull(n.created_at) }, n.created_at ? fmtTime(n.created_at) : '')),
                      MarkdownTextPrimitive
                        ? h('div', { className: 'wb-note-body' },
                            h(MarkdownTextPrimitive, { text: n.body, streaming: false, labels: MD_LABELS }))
                        : h('div', { className: 'wb-note-body wb-note-plain' }, n.body))
                  }))
              : h('div', { className: 'wb-meta wb-notes-empty' }, '暂无评论'),
          h(NoteComposer, {
            key: 'composer',
            target: '#' + it.num,
            busy: noteBusy,
            placeholder: '发表评论（Markdown）',
            onSubmit: function (text: string) { return submitNote(it.num, text) },
          }))),
      h('div', { className: 'wb-iss-aside' }, aside))
  }

  // ── root ──────────────────────────────────────────────────────────────────

  return h('div', { className: 'glab-panel wb-iss-page' },
    detail
      ? renderDetail()
      : h('div', { ref: scrollRef, className: 'glab-body' },
            renderToolbar(),
            renderBatchBar(),
            renderTable(),
            renderPager()),
    confirmReq
      ? h(ConfirmDialog, Object.assign({}, confirmReq, {
          onOk: function () { setConfirmReq(null); confirmReq.onOk() },
          onCancel: function () { setConfirmReq(null) },
        }))
      : null,
    h(ToastStack, { toasts: toasts, onDismiss: dismissToast, active: props.active }))
}
