import { GitPanel } from './git'
import { fetchWorkspaces as fetchGitWorkspaces } from '../git/routes'
import { useFeatureFlags } from '../features'
import { AutoReviewPanel, openReviewSession } from './auto-review'
// dsh-workbench — 仓库 page (ForgePanel): unified GitLab MR / GitHub PR
// dashboard. Platform auto-detect, workspace switcher, 我的 / 待评审 / 全部
// tabs, detail + diff, and the one-click 创建 / 评审 / 批准 / 合并 / 评论 /
// 关闭 actions — all backed by the host /forge routes over the local
// glab / gh CLIs.

import { React, h, useLayout, MarkdownTextPrimitive } from '../react'
import { EMPTY_ITEMS, FrameworkProps } from './props'
import { WB_PAGE_EVENT, forgeFetch, useWsData, refreshWorkspaces, useShellTick, saveForgeView, loadForgeView } from '../runtime'
import { fmtTime, fmtTimeFull, fmtTimeRel, numLabel, repoPathFromUrl, repoHomeUrl } from '../format'
import { currentSessionIdOf, findReviewWs, startItemSession } from '../session'
import { buildReviewPrompt, resolveReviewModel, formatModelRef } from '../prompts'
import { Chip, EmptyState, RefreshGlyph, forgeIcon, chevronGlyph, checkGlyph, dotsGlyph, xGlyph, copyGlyph, externalGlyph } from '../icons'
import { DiffView } from './diffview'
import { ConfirmDialog, type ConfirmRequest } from './confirmdialog'
import { NoteComposer, ToastOutlet, ToastStack, type Toast } from './common'
import { IssuesView } from './issues'
import type { ForgeItem, ForgeNote, WsData, WorkspaceMeta } from '../types'

// MarkdownText labels must be reference-stable across renders (a new object
// identity discards the primitive's streaming render cache — see its doc).
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

// ── small pieces ────────────────────────────────────────────────────────────

function ItemRow(props: {
  item: ForgeItem
  busy: boolean
  onOpen(item: ForgeItem): void
  onReview?(item: ForgeItem): void
  reviewWs?: { view: { path: string } } | null
  onMerge(item: ForgeItem): void
  onNote(item: ForgeItem): void
}) {
  const item = props.item
  const busy = props.busy
  const chips: React.ReactNode[] = []
  if (item.draft) chips.push(h(Chip, { key: 'd', kind: 'draft' }, 'Draft'))
  if (item.state === 'merged') chips.push(h(Chip, { key: 's', kind: 'merged' }, '已合并'))
  else if (item.state === 'closed') chips.push(h(Chip, { key: 's', kind: 'closed' }, '已关闭'))
  else if (item.has_conflicts) chips.push(h(Chip, { key: 'c', kind: 'conflict' }, '冲突'))
  else if (item.mergeable === 'mergeable') chips.push(h(Chip, { key: 'm', kind: 'ok' }, '可合并'))
  if (item.forge === 'github') {
    if (item.reviewDecision === 'APPROVED') chips.push(h(Chip, { key: 'rd', kind: 'ok' }, '已批准'))
    else if (item.reviewDecision === 'CHANGES_REQUESTED') chips.push(h(Chip, { key: 'rd', kind: 'closed' }, '需修改'))
    else if ((item.reviewRequests || []).length) chips.push(h(Chip, { key: 'rr', kind: 'review' }, '待评审'))
  }
  for (const l of (item.labels || []).slice(0, 3)) {
    chips.push(h(Chip, { key: 'l' + l }, l))
  }

  const actions: React.ReactNode[] = []
  if (item.state === 'opened') {
    if (props.onReview && props.reviewWs) {
      actions.push(h('button', {
        key: 'review', className: 'wb-act wb-act-violet', disabled: busy,
        onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); props.onReview!(item) },
        title: '在对应工作区发起或打开此提交的评审会话：' + props.reviewWs.view.path,
      }, '评审'))
    }
    actions.push(h('button', {
      key: 'merge', className: 'wb-act wb-act-accent', disabled: busy,
      onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); props.onMerge(item) },
    }, '合并'))
    actions.push(h('button', {
      key: 'note', className: 'wb-act', disabled: busy,
      onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); props.onNote(item) },
    }, '评论'))
  }

  return h('div', { className: 'wb-item' },
    h('div', { className: 'wb-item-top' },
      h('button', { type: 'button', className: 'wb-mr-open', onClick: () => props.onOpen(item) },
        h('span', { className: 'glab-mr-iid' }, numLabel(item)),
        h('span', { className: 'glab-mr-title' }, item.title || '(无标题)')
      ),
      item.web_url ? h('a', {
        className: 'wb-act wb-mr-original', href: item.web_url,
        target: '_blank', rel: 'noopener noreferrer',
        title: '在网页打开 ' + numLabel(item), 'aria-label': '在网页打开 ' + numLabel(item),
      }, externalGlyph(14)) : null,
      chips.length ? h('span', { className: 'wb-item-chips' }, chips) : null
    ),
    h('div', { className: 'glab-mr-branches' },
      (item.author || '?') + ' · ' + item.source_branch + ' → ' + item.target_branch +
      (item.comment_count ? ' · ' + item.comment_count + ' 条评论' : '') +
      (item.created_at ? ' · ' + fmtTime(item.created_at) : '')
    ),
    actions.length ? h('div', { className: 'wb-item-actions' }, actions) : null
  )
}

/** Copy-to-clipboard button with transient 已复制 state (navigator.clipboard
 *  with execCommand fallback; never throws into the click handler). */
function CopyButton(props: { text: string; title?: string }) {
  const [done, setDone] = React.useState(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(function () {
    return function () { if (timer.current) clearTimeout(timer.current) }
  }, [])
  async function copy() {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(props.text)
      else {
        const ta = document.createElement('textarea')
        ta.value = props.text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setDone(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(function () { setDone(false) }, 1400)
    } catch (e) {}
  }
  return h('button', {
    type: 'button', className: 'wb-copy' + (done ? ' wb-copy-done' : ''),
    title: props.title || '复制', 'aria-label': props.title || '复制', onClick: copy,
  }, done ? checkGlyph(11) : copyGlyph(11), done ? '已复制' : null)
}

/** Inline note composer moved to ./common.tsx (shared with the Issues page). */

// ── main forge panel ────────────────────────────────────────────────────────

interface DetailState {
  item: ForgeItem
  /** undefined = not fetched yet; null = fetched but empty; string = ready. */
  diff: string | null | undefined
  notesLoading: boolean
  diffLoading: boolean
  error: string | null
  diffError: string | null
}

export function ForgePanel(props: FrameworkProps) {
  const [state, setState] = React.useState<Record<string, unknown> | null>(null)      // /forge/state payload
  const [stateError, setStateError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'mine' | 'review' | 'all'>('mine')
  const wsData = useWsData()                              // shared /forge/workspaces store
  const [target, setTarget] = React.useState<{ cwd: string } | null>(() => {
    const cwd = loadForgeView().cwd
    return cwd ? { cwd } : null
  })        // selected workspace chip
  const [detail, setDetail] = React.useState<DetailState | null>(null)        // item detail
  const [busy, setBusy] = React.useState(false)
  const [noteBusy, setNoteBusy] = React.useState(false)
  const [reviewRefresh, setReviewRefresh] = React.useState(0)
  const [reviewing, setReviewing] = React.useState(false) // one review session start at a time
  const [noteNum, setNoteNum] = React.useState<string | number | null>(null) // list-row quick note target
  const [pickerOpen, setPickerOpen] = React.useState(false) // repo/workspace picker disclosure
  const repoBarRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(function () {
    if (!pickerOpen) return
    function dismissOutside(event: PointerEvent) {
      if (!repoBarRef.current?.contains(event.target as Node)) setPickerOpen(false)
    }
    function dismissEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    return function () {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [pickerOpen])
  // Detail page tabs: 概览 / 代码差异 (diff mounted lazily) / 评论.
  const [detailTab, setDetailTab] = React.useState<'info' | 'diff' | 'notes'>('info')
  // Consolidated action area: 批准 / 网页 / 关闭 collapse into the 「更多」
  // disclosure so 合并 stays the page's single primary action.
  const [moreOpen, setMoreOpen] = React.useState(false)
  // Inline merge confirm panel (replaces the confusing confirm() where
  // 取消 meant "merge without squash"). Squash on by default, plus an
  // explicit delete-source-branch choice.
  const [mergeConfirm, setMergeConfirm] = React.useState(false)
  const [mergeSquash, setMergeSquash] = React.useState(true)
  const [mergeDelBranch, setMergeDelBranch] = React.useState(false)
  // Pending styled-confirm request for the quick actions that used to call
  // native confirm() (list-row 合并 / 关闭 and the 更多 menu's 关闭): one
  // shared ConfirmDialog at the panel root, payload swapped per call site.
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null)
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const toastSeq = React.useRef(0)

  // Git / MR-PR / Issues / 自动评审共享工作区，分别保留视图状态。
  const [requestedSubNav, setSubNav] = React.useState<'git' | 'mr' | 'issues' | 'config'>(function () { return loadForgeView().subNav })
  // 仓库顶栏刷新同时更新工作区列表和 Issues。
  const [repoRefreshTick, setRepoRefreshTick] = React.useState(0)

  const features = useFeatureFlags()
  const subNav = !features.git && requestedSubNav === 'git' ? 'mr'
    : !features.forge && requestedSubNav !== 'git' ? 'git' : requestedSubNav
  const [localWorkspaces, setLocalWorkspaces] = React.useState<WorkspaceMeta[]>([])
  const [workspaceError, setWorkspaceError] = React.useState('')
  const repoWorkspaces = features.forge ? [...(wsData?.workspaces || [])] : []
  if (features.git) for (const ws of localWorkspaces) {
    if (!repoWorkspaces.some(row => row.path === ws.path)) repoWorkspaces.push(ws)
  }
  const activeCwd = target?.cwd || null
  const activeWs = repoWorkspaces.find(ws => ws.path === activeCwd) || null

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onJump = (event: Event) => {
      if ((event as CustomEvent).detail === 'git' && features.git) setSubNav('git')
    }
    window.addEventListener(WB_PAGE_EVENT, onJump)
    return () => window.removeEventListener(WB_PAGE_EVENT, onJump)
  }, [features.git])

  // The workspace the CURRENT session belongs to (same criterion as the
  // sidebar's own grouping: workspace.sessionIds ∋ sessionId), read through
  // the framework-injected global seat. Both hooks are stable per mount.
  // currentSessionIdOf supports both the legacy `current` field and the
  // retainedBy.mainView scan required since dsh 0.1.6-alpha.2.
  const currentSessionId = typeof props.useSessions === 'function'
    ? props.useSessions(currentSessionIdOf)
    : null
  const owningWs = typeof props.useWorkspaces === 'function' && currentSessionId
    ? props.useWorkspaces(function (snap: { items?: Array<{ sessionIds?: string[]; path?: string; title?: string }> } | null) {
        if (!snap || !Array.isArray(snap.items)) return null
        const own = snap.items.find(function (w) {
          return Array.isArray(w.sessionIds) && w.sessionIds.includes(currentSessionId)
        })
        return own ? { path: own.path, title: own.title } : null
      })
    : null
  // Full workspace-registry view list (WorkspaceView: workspaceId/path/title/
  // sessionIds) — the 「评审」 button needs the workspaceId the session
  // controller addresses, which /forge/workspaces (git-remote detection) does
  // not carry. Selector returns the snapshot-owned array reference (stable).
  const wsItems = typeof props.useWorkspaces === 'function'
    ? props.useWorkspaces(function (snap: { items?: unknown[] } | null) {
        return snap && Array.isArray(snap.items) ? snap.items as never : EMPTY_ITEMS
      })
    : EMPTY_ITEMS

  // 默认选择也经过下方的 Git 工作区识别，避免把 empty 等非仓库目录作为目标。
  const targetQuery = function () {
    const parts: string[] = []
    if (activeCwd) parts.push('cwd=' + encodeURIComponent(activeCwd))
    return parts.length ? '&' + parts.join('&') : ''
  }

  // Default target: preselect the chip of the workspace the current session
  // belongs to — until the user manually picks a chip (touchedRef latches).
  const touchedRef = React.useRef(false)
  useLayout(function () {
    if (touchedRef.current) return
    if (!owningWs) return
    if (target && target.cwd === owningWs.path) return
    const hit = repoWorkspaces.some(function (w) { return w.path === owningWs.path })
    if (hit) setTarget({ cwd: owningWs.path })
  }, [owningWs, wsData, localWorkspaces, target])

  // Seq guards: responses may race when the target workspace changes
  // (chip click) — a slow old-cwd reply must never overwrite newer data.
  const stateReqRef = React.useRef(0)
  const loadState = React.useCallback(async (force: boolean) => {
    const req = ++stateReqRef.current
    if (!activeCwd || !features.forge || (activeWs && !activeWs.forge)) {
      setState(null)
      setStateError(null)
      return
    }
    try {
      // NOTE: query must start with '?' — '/forge/state&cwd=…' (missing ?)
      // fails the host's exact route match and surfaces as HTTP 404.
      const parts: string[] = []
      if (activeCwd) parts.push('cwd=' + encodeURIComponent(activeCwd))
      if (force) parts.push('force=1')
      const data = await forgeFetch('/forge/state' + (parts.length ? '?' + parts.join('&') : ''))
      if (req !== stateReqRef.current) return // superseded by a newer fetch
      setState(data)
      setStateError(data && data.repo === null ? '当前工作区不是 Git 仓库，请点击顶部仓库切换工作区' : null)
    } catch (e) {
      if (req !== stateReqRef.current) return
      setStateError(String(e instanceof Error ? e.message : e))
    }
  }, [activeCwd, features.forge, activeWs?.forge])

  // 外壳层心跳（runtime.ts startWorkbenchPolling）：插件 apply() 每 5 分钟
  // 后台刷新工作区与最近查看视图的缓存并 bump；这里订阅后以 force=false
  // 重拉——host 缓存命中即返回，不重复执行 CLI。面板自身不再持有 setInterval。
  const tick = useShellTick()
  useLayout(function () {
    loadState(false)
    if (features.forge) void refreshWorkspaces(false) // TTL-guarded inside the shared store
  }, [loadState, tick, features.forge])

  React.useEffect(() => {
    if (!features.git) return
    let cancelled = false
    void fetchGitWorkspaces().then(data => {
      if (cancelled) return
      if (!data.ok) throw new Error(data.error || '无法读取工作区')
      setLocalWorkspaces(data.workspaces || [])
      setWorkspaceError('')
    }).catch(error => { if (!cancelled) setWorkspaceError(String(error.message || error)) })
    return () => { cancelled = true }
  }, [features.git, tick, repoRefreshTick])

  // 持久化最近查看的 scope+cwd+二级导航：外壳层轮询按它预热 MR/state（或
  // Issues 列表）缓存，面板重进时最先请求的正是这个 key。
  const viewScope = tab === 'all' || tab === 'review' ? tab : 'mine'
  useLayout(function () {
    saveForgeView({ scope: viewScope, cwd: activeCwd, subNav: subNav })
  }, [viewScope, activeCwd, subNav])

  function pushToast(kind: 'ok' | 'err', text: string) {
    const id = ++toastSeq.current
    setToasts(function (prev) { return prev.concat({ id: id, kind: kind, text: text }) })
    setTimeout(function () {
      setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id }) })
    }, 4200)
  }
  const dismissToast = React.useCallback(function (id: number) {
    setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id }) })
  }, [])

  async function refreshAll() {
    setBusy(true)
    await loadState(true)
    if (features.forge) await refreshWorkspaces(true)
    // Issues 半区跟着强刷（列表 + 统计卡），二级导航停在哪边都保持一致。
    setRepoRefreshTick(function (t) { return t + 1 })
    setBusy(false)
  }

  // ── detail loading ────────────────────────────────────────────────────────
  // Seq guard: quickly opening two MRs (or an action-triggered reload racing
  // a new open) must never let a stale slow response overwrite the current
  // detail. View and diff load independently so the 概览 body renders without
  // waiting on the (often much slower) diff subprocess.
  const detailReqRef = React.useRef(0)

  // 列表/详情共用同一个 .glab-body 滚动容器：详情在容器内替换列表内容，列表
  // 的 scrollTop 会残留到详情上（详情不置顶）。显式管理：开详情前记住列表
  // 滚动位置，详情打开置顶，返回列表时恢复原位置。detailOpen 只在列表↔详情
  // 切换时翻转，详情内的刷新（reloadDetail 等）不打断用户滚动。
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const savedListScroll = React.useRef(0)
  const detailOpen = detail !== null
  useLayout(function () {
    const el = scrollRef.current
    if (!el) return
    if (detailOpen) el.scrollTop = 0
    else el.scrollTop = savedListScroll.current
  }, [detailOpen])

  function detailQuery(item: ForgeItem): string {
    return '?num=' + encodeURIComponent(String(item.num)) + targetQuery()
  }

  function applyView(req: number, item: ForgeItem, data: Record<string, unknown> | null, err: string | null) {
    if (req !== detailReqRef.current) return
    setDetail(function (d) {
      if (!d) return d
      return Object.assign({}, d, {
        item: (data && (data.mr as ForgeItem)) || item,
        notesLoading: false,
        error: err,
      })
    })
  }

  async function fetchDetailView(item: ForgeItem, req: number) {
    try {
      const data = await forgeFetch('/forge/mr' + detailQuery(item))
      applyView(req, item, data, data && data.ok === false ? String(data.error || '加载失败') : null)
    } catch (e) {
      applyView(req, item, null, String(e instanceof Error ? e.message : e))
    }
  }

  async function fetchDetailDiff(item: ForgeItem, req: number) {
    setDetail(function (d) { return d ? Object.assign({}, d, { diffLoading: true, diffError: null }) : d })
    try {
      const data = await forgeFetch('/forge/mr/diff' + detailQuery(item))
      if (req !== detailReqRef.current) return
      const diff = (data && typeof data.diff === 'string') ? data.diff : ''
      setDetail(function (d) {
        if (!d) return d
        return Object.assign({}, d, {
          diff: diff,
          diffLoading: false,
          diffError: data && data.ok === false ? String(data.error || 'diff 加载失败') : (diff ? null : d.diffError),
        })
      })
    } catch (e) {
      if (req !== detailReqRef.current) return
      setDetail(function (d) {
        if (!d) return d
        return Object.assign({}, d, { diffLoading: false, diff: d.diff || null, diffError: String(e instanceof Error ? e.message : e) })
      })
    }
  }

  function openDetail(item: ForgeItem) {
    const req = ++detailReqRef.current
    // 列表滚动位置在换到详情前保存（滚动容器被详情复用，scrollTop 不重置）。
    const el = scrollRef.current
    if (el && !detail) savedListScroll.current = el.scrollTop
    setDetailTab('info') // every MR opens on 概览
    setMoreOpen(false)
    setMergeConfirm(false)
    setMergeSquash(true)
    setMergeDelBranch(false)
    // Header renders immediately from the list payload; only the bodies load.
    setDetail({ item: item, diff: undefined, notesLoading: true, diffLoading: false, error: null, diffError: null })
    void fetchDetailView(item, req)
  }

  /** Re-fetch the current detail after a mutation (approve/merge/note…).
   *  Reads the live item/tab via setDetail callbacks — this may be invoked
   *  from a stale render closure (e.g. inside act()), so reading the hook
   *  state directly here would re-request the previously-open MR. */
  function reloadDetail(): void {
    let live: ForgeItem | null = null
    let wantDiff = false
    setDetail(function (d) {
      if (d) {
        live = d.item
        wantDiff = detailTabLiveRef.current === 'diff'
        return Object.assign({}, d, { notesLoading: true })
      }
      return d
    })
    if (!live) return
    const req = ++detailReqRef.current
    void fetchDetailView(live as ForgeItem, req)
    if (wantDiff) void fetchDetailDiff(live as ForgeItem, req)
  }
  // detailTab is read inside the setDetail updater above; the ref keeps the
  // value current without making reloadDetail depend on render scope.
  const detailTabLiveRef = React.useRef<'info' | 'diff' | 'notes'>('info')
  useLayout(function () { detailTabLiveRef.current = detailTab }, [detailTab])

  // Fetch the diff on first switch to the diff tab (lazy mount), not before.
  useLayout(function () {
    if (!detail || detailTab !== 'diff' || detail.diff !== undefined || detail.diffLoading) return
    const req = detailReqRef.current
    void fetchDetailDiff(detail.item, req)
  }, [detail, detailTab])

  async function act(
    path: string,
    body: Record<string, unknown>,
    onDone?: (res: Record<string, unknown>) => void,
    opts?: { okText?: string },
  ) {
    setBusy(true)
    try {
      const base = { cwd: activeCwd }
      const res = await forgeFetch(path, { method: 'POST', body: Object.assign(base, body) })
      if (res && res.ok === false) {
        pushToast('err', '操作失败：' + (res.error || '未知错误'))
      } else {
        if (opts && opts.okText) pushToast('ok', opts.okText)
        if (onDone) onDone(res)
      }
    } catch (e) {
      pushToast('err', '操作失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(false)
    void refreshAll()
    if (detail) void reloadDetail()
  }

  function openMergeConfirm(item: ForgeItem) {
    if (item.has_conflicts || item.mergeable === 'conflicting') return
    setMergeConfirm(true)
  }

  async function confirmMerge(item: ForgeItem) {
    const squash = mergeSquash
    const removeSource = mergeDelBranch
    setMergeConfirm(false)
    await act('/forge/mr/merge',
      { num: item.num, squash: squash, removeSource: removeSource },
      undefined,
      { okText: (squash ? 'Squash ' : '') + '合并已提交' + (removeSource ? '，将删除源分支' : '') })
  }

  async function submitNote(num: string | number, text: string) {
    setNoteBusy(true)
    try {
      const base = { cwd: activeCwd }
      const res = await forgeFetch('/forge/mr/note', { method: 'POST', body: Object.assign(base, { num: num, body: text }) })
      if (res && res.ok === false) {
        pushToast('err', '评论失败：' + (res.error || '未知错误'))
        return false
      } else {
        pushToast('ok', '评论已发表')
        setNoteNum(null)
        if (detail) void reloadDetail()
        void refreshAll()
        return true
      }
    } catch (e) {
      pushToast('err', '评论失败：' + String(e instanceof Error ? e.message : e))
      return false
    } finally {
      setNoteBusy(false)
    }
  }

  /** 「评审」: use the host journal to reuse this revision's task/report.
   * Legacy fallback: open a NEW review session in the workspace owning the item's
   * repo and submit the review prompt into it. Workspace resolution: the
   * panel's active cwd wins, else any registered workspace whose git remote
   * matches the item web_url's repo path. The session itself is opened by the
   * shared startItemSession (uiWorkspace.connectWorkspace / openSession +
   * retainBoundSession — see src/client/session.ts). The model is the
   * configured 评审模型 (配置页), read at click time; unset → DSH default. */
  async function startReview(item: ForgeItem) {
    if (reviewing) return
    const ws = findReviewWs(item, activeCwd, wsData, wsItems)
    if (!ws) {
      pushToast('err', '未找到该 ' + (item.forge === 'github' ? 'PR' : 'MR') + ' 对应的工作区：没有哪个已注册工作区的 git remote 指向 ' +
        (repoPathFromUrl(item.web_url) || '该 ' + (item.forge === 'github' ? 'PR' : 'MR') + ' 的仓库') +
        '。请先在 DSH 中添加该仓库的工作区目录。')
      return
    }
    setReviewing(true)
    if (activeCwd) {
      try {
        const model = resolveReviewModel()
        const result = await forgeFetch('/forge/reviews/start', { method: 'POST', body: {
          cwd: activeCwd, num: String(item.num), prompt: buildReviewPrompt(item),
          model: model ? formatModelRef(model.provider, model.model) : '',
        } })
        if (!result.ok && !result.unsupported) throw new Error(result.error || '无法启动评审')
        if (!result.unsupported) {
          setReviewRefresh((n) => n + 1)
          if (result.task.status === 'failed') pushToast('err', '已有失败任务，请在自动评审记录中重试')
          else if (result.task.status === 'queued') pushToast('ok', '评审已排队')
          else openReviewSession(result.task.sessionId)
          setReviewing(false)
          return
        }
      } catch (e) {
        pushToast('err', String(e instanceof Error ? e.message : e))
        setReviewing(false)
        return // Network/unknown failures must not start a second session.
      }
    }
    const res = await startItemSession(
      ws,
      buildReviewPrompt(item),
      '评审 ' + numLabel(item) + ' ' + (item.title || ''),
      resolveReviewModel(),
    )
    if (!res.ok) {
      if (res.code === 'no-uiworkspace') pushToast('err', '当前 DSH 未提供 uiWorkspace 服务，无法发起新会话（请升级 DSH）')
      else if (res.code === 'no-prompt') pushToast('err', '评审会话已打开，但无法自动发送评审指令，请手动粘贴评审要求')
      else if (res.code === 'prompt-failed') pushToast('err', '评审指令发送失败：' + (res.error || '未知错误'))
      else pushToast('err', '发起评审会话失败：' + (res.error || '未知错误'))
    } else if (res.warning) {
      // 评审照常发起（只是模型降级），仍如实告知，避免「配了没生效」的疑惑。
      pushToast('err', res.warning)
    }
    setReviewing(false)
  }

  // Display forge: the forge the host detected for the active repo.
  const displayForge = activeWs ? activeWs.forge || null : (state && state.repo && (state.repo as { forge?: string }).forge) || null

  // Repo bar: one chip = workspace switcher (open → picker), plus repo meta
  // and the refresh action. Replaces the old brand row + platform row +
  // workspace-chip row. The MR/PR | Issues | 配置 subnav rides the same row
  // (right of the meta) so the page keeps one header line.
  function renderRepoBar() {
    const repo = state && state.repo as Record<string, unknown> | null | undefined
    const chipRepo = ((activeWs && activeWs.repoPath) || (repo && repo.path as string) || activeWs?.title || activeCwd || null) as string | null
    const chipColor = displayForge === 'github'
      ? 'var(--wb-violet)'
      : displayForge === 'gitlab'
        ? 'var(--wb-accent)'
        : 'var(--dsw-alias-label-secondary,#94a3b8)'
    // 仓库栏不再放 meta（分支/用户/未提交改动数）——头部只留仓库、页签与刷新。
    return h('div', { className: 'wb-bar wb-repo-bar', ref: repoBarRef },
      h('button', {
        className: 'wb-repo-chip' + (chipRepo ? '' : ' wb-repo-chip-empty'),
        onClick: function () { setPickerOpen(!pickerOpen) },
        title: '切换工作区', 'aria-expanded': pickerOpen,
      },
        h('span', { style: { display: 'inline-flex', color: chipColor, flex: 'none' } }, forgeIcon(displayForge as 'gitlab' | 'github' | null, 13)),
        h('span', { className: 'wb-repo-name' }, chipRepo || '选择仓库…'),
        h('span', { className: 'wb-chev' }, chevronGlyph(12))
      ),
      // 尚未选中仓库时没有半区可切，二级导航不渲染。
      activeCwd ? renderSubNav() : null,
      h(ToastOutlet),
      h('button', {
        className: 'glab-btn', onClick: refreshAll, disabled: busy, 'aria-label': '刷新仓库',
        title: '刷新' + (updated ? '（上次 ' + fmtTime(updated) + '）' : ''),
      }, RefreshGlyph(busy)),
      renderRepoPicker(),
    )
  }

  // 二级导航（并入仓库栏一行）：MR / PR | Issues | 配置。
  // 沿用列表页签的同一控件语言（下划线橙色高亮）。
  function renderSubNav() {
    return h('div', { className: 'glab-tabs wb-subnav' },
      features.git ? h('button', { key: 'git', className: 'glab-tab' + (subNav === 'git' ? ' glab-tab-active' : ''),
        onClick: () => setSubNav('git'), title: '本地 Git 改动、提交、历史与分支',
      }, 'Git') : null,
      features.forge ? h('button', {
        key: 'mr',
        className: 'glab-tab' + (subNav === 'mr' ? ' glab-tab-active' : ''),
        onClick: function () { setSubNav('mr') },
        title: 'Merge Requests / Pull Requests',
      }, 'MR / PR') : null,
      features.forge ? h('button', {
        key: 'issues',
        className: 'glab-tab' + (subNav === 'issues' ? ' glab-tab-active' : ''),
        onClick: function () { setSubNav('issues') },
        title: 'Issue 管理（GitLab / GitHub）',
      }, 'Issues') : null,
      features.forge ? h('button', {
        key: 'config',
        className: 'glab-tab' + (subNav === 'config' ? ' glab-tab-active' : ''),
        onClick: function () { setSubNav('config') },
        title: '当前仓库的自动评审配置',
      }, '自动评审') : null)
  }

  // 本地工作区也可选择；平台能力由远程仓库和 CLI 登录状态决定。
  function renderRepoPicker() {
    if (!pickerOpen) return null
    const list = repoWorkspaces
    if (!list.length) {
      return h('div', { className: 'wb-picker' },
        h('div', { className: 'wb-picker-note' }, workspaceError || '尚无可用工作区，请先在 DSH 中添加工作区。'))
    }
    return h('div', { className: 'wb-picker' },
      h('div', { className: 'wb-picker-label' }, '工作区'),
      list.map(function (ws) {
        const active = target !== null && target.cwd === ws.path
        return h('button', {
          key: ws.id || ws.path,
          className: 'wb-picker-item',
          // loadState follows the selected workspace.
          onClick: function () { touchedRef.current = true; setTarget({ cwd: ws.path }); setDetail(null); setPickerOpen(false) },
          title: ws.path + (ws.branch ? ' · ' + ws.branch : '') + (ws.user ? ' · ' + ws.user : ''),
        },
          h('span', { className: 'glab-forge-dot ' + (ws.forge || '') }),
          h('span', { className: 'wb-picker-path' }, ws.repoPath || ws.title),
          active ? h('span', { className: 'wb-picker-check' }, checkGlyph(13)) : null,
          ws.branch ? h('span', { className: 'wb-picker-meta' }, ws.branch + (ws.user ? ' · ' + ws.user : '')) : null
        )
      })
    )
  }

  function renderTabs() {
    const counts: Record<string, number> = {}
    if (state) {
      counts.mine = ((state.myOpen as unknown[]) || []).length
      counts.review = ((state.reviewRequests as unknown[]) || []).length
      counts.all = ((state.allOpen as unknown[]) || []).length
    }
    // Zero badges stay hidden — a row of "0" pills carries no information.
    const defs: Array<['mine' | 'review' | 'all', string, number | undefined]> = [
      ['mine', '我的', counts.mine],
      ['review', '待评审', counts.review],
      ['all', '全部', counts.all],
    ]
    return h('div', { className: 'glab-tabs' },
      defs.map(function (d) {
        const badge = typeof d[2] === 'number' && d[2] > 0
          ? h('span', {
              className: 'glab-badge' + (d[0] === 'review' ? ' glab-badge-hot' : ''),
            }, String(d[2]))
          : null
        return h('button', {
          key: d[0],
          className: 'glab-tab' + (tab === d[0] ? ' glab-tab-active' : ''),
          onClick: function () { setTab(d[0]) },
        }, d[1], badge)
      })
    )
  }

  function renderListBody() {
    const listKey = tab === 'all' ? 'allOpen' : tab === 'review' ? 'reviewRequests' : 'myOpen'
    const listError = state && state[listKey + 'Error'] as string | undefined
    if (listError) return h('div', { className: 'glab-error' }, listError)
    if (!state) return h('div', { className: 'glab-list' },
      h('div', { className: 'glab-skel', style: { width: '94%' } }),
      h('div', { className: 'glab-skel', style: { width: '86%' } }),
      h('div', { className: 'glab-skel', style: { width: '90%' } })
    )
    const list = (state[listKey] as ForgeItem[]) || []
    if (!list.length) {
      return h(EmptyState, {
        title: '没有相关记录',
        hint: '切换工作区重试',
      })
    }
    return h('div', { className: 'glab-list' },
      list.map(function (item) {
        return h(ItemRow, {
          key: String(item.num),
          item: item,
          busy: busy,
          onOpen: openDetail,
          onReview: startReview,
          reviewWs: findReviewWs(item, activeCwd, wsData, wsItems),
          onMerge: function (m) {
            if (m.has_conflicts || m.mergeable === 'conflicting') {
              pushToast('err', numLabel(m) + ' 存在冲突，需先解决冲突再合并')
              return
            }
            // Styled confirm dialog (was native confirm()); squash stays the
            // quick-path default — the full option set lives in the detail panel.
            setConfirmReq({
              title: '合并 ' + numLabel(m) + ' 到 ' + (m.target_branch || '?'),
              lines: [m.title || '(无标题)', '将使用 squash 合并（压缩为一个提交）。'],
              okLabel: '确认合并',
              onOk: function () {
                act('/forge/mr/merge', { num: m.num, squash: true, removeSource: false },
                  undefined, { okText: 'Squash 合并已提交' })
              },
            })
          },
          onNote: function (m) { setDetail(null); setNoteNum(m.num) },
        })
      })
    )
  }

  function renderNoteQuick() {
    if (noteNum === null) return null
    return h('div', { className: 'glab-form wb-inset' },
      h('div', { className: 'glab-label' }, '评论 ' + (displayForge === 'github' ? '#' : '!') + noteNum),
      h(NoteComposer, {
        target: (displayForge === 'github' ? '#' : '!') + noteNum,
        busy: noteBusy,
        onCancel: function () { setNoteNum(null) },
        onSubmit: function (text: string) { return submitNote(noteNum, text) },
      })
    )
  }

  /** 评论 tab body: note list + sticky composer at the bottom. */
  function renderNotes(item: ForgeItem, d: DetailState) {
    const notes = item.notes || []
    if (d.notesLoading && !notes.length) {
      return h('div', { className: 'glab-list' },
        h('div', { className: 'glab-skel', style: { width: '60%' } }),
        h('div', { className: 'glab-skel', style: { width: '80%' } }))
    }
    return h('div', { className: 'wb-notes' },
      notes.length
        ? h('div', { className: 'wb-notes-list' },
            notes.map(function (n: ForgeNote, i: number) {
              return h('div', { key: i, className: 'wb-note' },
                h('div', { className: 'wb-note-head' },
                  h('span', { className: 'wb-note-author' }, n.author || '?'),
                  h('span', { className: 'wb-note-time', title: fmtTimeFull(n.created_at) }, fmtTimeRel(n.created_at))),
                MarkdownTextPrimitive
                  ? h('div', { className: 'wb-note-body' },
                      h(MarkdownTextPrimitive, { text: n.body, streaming: false, labels: MD_LABELS }))
                  : h('div', { className: 'wb-note-body wb-note-plain' }, n.body))
            }))
        : h('div', { className: 'wb-meta wb-notes-empty' }, '暂无评论'),
      h(NoteComposer, {
        key: 'composer',
        target: numLabel(item),
        busy: noteBusy,
        placeholder: '发表评论（支持 Markdown）',
        onSubmit: function (text: string) { return submitNote(item.num, text) },
      })
    )
  }

  function renderDetail() {
    if (!detail) return null
    const item = detail.item
    const listName = item.forge === 'github' ? 'Pull Requests' : 'Merge Requests'
    const repoPath = repoPathFromUrl(item.web_url) ||
      (activeWs && activeWs.repoPath) ||
      (state && state.repo ? (state.repo as { path?: string }).path : null) || null

    // State chips only — labels live in the aside; merge verdict lives in
    // the aside too (with its hint), so the header keeps state/draft/冲突.
    const chips: React.ReactNode[] = []
    if (item.state === 'opened') chips.push(h(Chip, { key: 's' }, '已开启'))
    else if (item.state === 'merged') chips.push(h(Chip, { key: 's', kind: 'merged' }, '已合并'))
    else if (item.state === 'closed') chips.push(h(Chip, { key: 's', kind: 'closed' }, '已关闭'))
    if (item.draft) chips.push(h(Chip, { key: 'd', kind: 'draft' }, 'Draft'))
    if (item.has_conflicts || item.mergeable === 'conflicting') chips.push(h(Chip, { key: 'c', kind: 'conflict' }, '存在冲突'))
    else if (item.state === 'opened' && item.mergeable === 'mergeable') chips.push(h(Chip, { key: 'm', kind: 'ok' }, '可合并'))
    if (item.forge === 'github') {
      if (item.reviewDecision === 'APPROVED') chips.push(h(Chip, { key: 'rd', kind: 'ok' }, '已批准'))
      else if (item.reviewDecision === 'CHANGES_REQUESTED') chips.push(h(Chip, { key: 'rd', kind: 'closed' }, '需修改'))
      else if ((item.reviewRequests || []).length) chips.push(h(Chip, { key: 'rr', kind: 'review' }, '待评审'))
    }
    // 右侧栏取消后，标签回到 meta 行；只显示前 4 个避免长标签列表撑爆一行。
    for (const l of (item.labels || []).slice(0, 4)) {
      chips.push(h(Chip, { key: 'l' + l }, l))
    }

    const notesCount = (item.notes && item.notes.length) || Number(item.comment_count) || 0
    const conflicting = item.has_conflicts || item.mergeable === 'conflicting'
    const blocked = item.state !== 'opened' || conflicting
    const blockHint = conflicting ? '存在冲突，需先解决冲突再合并' : undefined

    // Action row: 评审 / 评论 / 更多 are ghost buttons; 合并 is the single
    // primary, flush right via margin-left:auto.
    const detailWs = findReviewWs(item, activeCwd, wsData, wsItems)
    const reviewModel = resolveReviewModel()
    const actions: React.ReactNode[] = []
    if (item.state === 'opened') {
      if (detailWs) {
        actions.push(h('button', {
          key: 'r', className: 'glab-btn', disabled: busy || reviewing,
          onClick: function () { void startReview(item) },
          title: '在对应工作区发起或打开此提交的评审会话：' + detailWs.view.path,
        }, '评审'))
      }
      actions.push(h('button', {
        key: 'n', className: 'glab-btn', disabled: busy,
        onClick: function () { setDetailTab('notes') },
      }, '评论'))
      actions.push(h('div', { key: 'more', className: 'wb-more-wrap' },
        h('button', {
          className: 'glab-btn', 'aria-haspopup': 'menu', 'aria-expanded': moreOpen,
          disabled: busy, title: '更多操作',
          onClick: function () { setMoreOpen(!moreOpen) },
        }, dotsGlyph(13), '更多', chevronGlyph(11)),
        moreOpen
          ? h(React.Fragment, { key: 'pop' },
              // Click-away / Esc layer — closes the disclosure without wiring
              // document listeners. It must not cover the trigger itself.
              h('div', {
                className: 'wb-popbackdrop',
                onClick: function () { setMoreOpen(false) },
                onContextMenu: function (e: React.MouseEvent) { e.preventDefault(); setMoreOpen(false) },
              }),
              h('div', { className: 'wb-more', role: 'menu', onKeyDown: function (e: React.KeyboardEvent) {
                if (e.key === 'Escape') setMoreOpen(false)
              } },
                h('button', {
                  className: 'wb-more-item', disabled: busy,
                  onClick: function () { setMoreOpen(false); act('/forge/mr/approve', { num: item.num }, undefined, { okText: '已批准 ' + numLabel(item) }) },
                }, h('span', { className: 'wb-more-ic wb-ok-ic' }, checkGlyph(13)), '批准'),
                h('button', {
                  className: 'wb-more-item wb-more-danger', disabled: busy,
                  onClick: function () {
                    setMoreOpen(false)
                    setConfirmReq({
                      title: '关闭 ' + numLabel(item) + '？',
                      lines: [item.title || '(无标题)'],
                      okLabel: '确认关闭',
                      danger: true,
                      onOk: function () {
                        act('/forge/mr/close', { num: item.num }, undefined, { okText: '已关闭 ' + numLabel(item) })
                      },
                    })
                  },
                }, h('span', { className: 'wb-more-ic wb-danger-ic' }, xGlyph(13)), '关闭'),
              ))
          : null,
      ))
      actions.push(h('button', {
        key: 'm',
        className: 'glab-btn glab-btn-primary wb-merge-btn',
        disabled: busy || blocked,
        title: blockHint,
        onClick: function () { openMergeConfirm(item) },
      }, '合并'))
    }

    const tabs = h('div', { className: 'glab-tabs wb-detail-tabs' },
      h('button', {
        className: 'glab-tab' + (detailTab === 'info' ? ' glab-tab-active' : ''),
        onClick: function () { setDetailTab('info') },
      }, '概览'),
      h('button', {
        className: 'glab-tab' + (detailTab === 'diff' ? ' glab-tab-active' : ''),
        onClick: function () { setDetailTab('diff') },
      }, '代码差异'),
      h('button', {
        className: 'glab-tab' + (detailTab === 'notes' ? ' glab-tab-active' : ''),
        onClick: function () { setDetailTab('notes') },
      }, '评论', notesCount > 0 ? h('span', { className: 'glab-badge' }, String(notesCount)) : null),
    )

    return h('div', { className: 'wb-detail-wrap' },
      h('div', { className: 'wb-detail-main' },
        // One breadcrumb line doubles as the back affordance (the list
        // segment is a button) — no redundant standalone 返回 button.
        h('div', { className: 'wb-crumbs' },
          repoPath
            ? (item.web_url
                ? h('a', { key: 'r', className: 'wb-crumb-link', href: repoHomeUrl(item.web_url), target: '_blank', rel: 'noopener', title: '在网页打开仓库' }, repoPath)
                : h('span', { key: 'r', className: 'wb-crumb' }, repoPath))
            : null,
          repoPath ? h('span', { className: 'wb-crumb-sep' }, '/') : null,
          h('button', { className: 'wb-crumb-link', onClick: () => setDetail(null), title: '返回列表' }, '← ' + listName),
          h('span', { className: 'wb-crumb-sep' }, '/'),
          h('span', { className: 'wb-crumb-here' }, numLabel(item)),
          item.web_url ? h('a', {
            className: 'wb-act wb-mr-original', href: item.web_url,
            target: '_blank', rel: 'noopener noreferrer',
            title: '在网页打开 ' + numLabel(item), 'aria-label': '在网页打开 ' + numLabel(item),
          }, externalGlyph(14)) : null,
          h('button', {
            className: 'wb-detail-refresh', title: '刷新该详情',
            disabled: busy,
            onClick: function () { void reloadDetail() },
          }, RefreshGlyph(false)),
        ),
        h('div', { className: 'glab-detail-head' },
          h('div', { className: 'wb-detail-title' },
            // 编号与标题同一行（不换行）；编号本身是外链，点击在新标签页打开 MR/PR。
            item.web_url
              ? h('a', { key: 'iid', className: 'wb-title-iid', href: item.web_url, target: '_blank', rel: 'noopener', title: '在网页打开 ' + numLabel(item) }, numLabel(item))
              : h('span', { key: 'iid', className: 'wb-title-iid' }, numLabel(item)),
            h('span', { className: 'wb-title-text' }, item.title || '(无标题)')),
          // 单行 meta：状态 chips · 作者 · 创建/更新时间 · 源分支 → 目标分支。
          // 分支作为一个 nowrap 单元跟在更新时间后面，整行空间不够时整组折到下一行。
          h('div', { className: 'wb-detail-meta' },
            chips.length ? h('span', { className: 'wb-title-chips' }, chips) : null,
            h('span', { className: 'wb-detail-author' }, item.author || '?'),
            h('span', { className: 'wb-meta-dim', title: fmtTimeFull(item.created_at) }, '创建于 ' + fmtTimeRel(item.created_at)),
            item.updated_at
              ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(item.updated_at) }, '更新于 ' + fmtTimeRel(item.updated_at))
              : null,
            h('span', { className: 'wb-branches-inline' },
              h('span', { className: 'wb-branch' },
                h('span', { className: 'wb-branch-name' }, item.source_branch || '?'),
                h(CopyButton, { text: item.source_branch || '', title: '复制源分支名' })),
              h('span', { className: 'wb-branch-arrow' }, '→'),
              h('span', { className: 'wb-branch' },
                h('span', { className: 'wb-branch-name' }, item.target_branch || '?'),
                h(CopyButton, { text: item.target_branch || '', title: '复制目标分支名' })),
            ),
          ),

          // Inline merge confirm: squash (default on) + delete source branch,
          // with an explicit 取消 — canceling no longer silently merges.
          mergeConfirm && item.state === 'opened'
            ? h('div', { className: 'wb-merge-panel', role: 'dialog', 'aria-label': '确认合并' },
                h('div', { className: 'wb-merge-title' }, '合并 ' + numLabel(item) + ' 到 ' + (item.target_branch || '?')),
                h('label', { className: 'glab-check' },
                  h('input', { type: 'checkbox', checked: mergeSquash, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMergeSquash(e.target.checked) }),
                  'Squash 合并（压缩为一个提交）'),
                h('label', { className: 'glab-check' },
                  h('input', { type: 'checkbox', checked: mergeDelBranch, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMergeDelBranch(e.target.checked) }),
                  '合并后删除源分支 ' + (item.source_branch || '')),
                h('div', { className: 'wb-merge-panel-actions' },
                  h('button', {
                    className: 'glab-btn glab-btn-primary', disabled: busy,
                    onClick: function () { void confirmMerge(item) },
                  }, busy ? '合并中…' : '确认合并'),
                  h('button', { className: 'glab-btn', disabled: busy, onClick: function () { setMergeConfirm(false) } }, '取消')),
              )
            : null,
        ),
        h('div', { className: 'wb-detail-context' },
        h('div', { className: 'wb-config-help wb-review-target', title: detailWs?.view.path }, detailWs ? '评审工作区：' + detailWs.view.path + ' · 模型：' + (reviewModel ? formatModelRef(reviewModel.provider, reviewModel.model) : 'DSH 默认') : '未找到评审工作区，请先添加该仓库的工作区'),
        activeCwd ? h(AutoReviewPanel, { key: activeCwd + ':' + item.num, cwd: activeCwd, num: String(item.num), compact: true, refresh: reviewRefresh }) : null),
        detail.error ? h('div', { className: 'glab-error' }, detail.error) : null,
        h('div', { className: 'wb-detail-toolbar' }, tabs, actions.length ? h('div', { className: 'wb-detail-actions' }, actions) : null),
        // 概览 body: the view fetch (notesLoading) only blocks this body; the
        // header above renders from the list payload instantly.
        detailTab === 'info'
          ? h('div', { className: 'wb-tabpane' },
              detail.notesLoading
                ? h('div', { className: 'glab-list' },
                    h('div', { className: 'glab-skel', style: { width: '70%' } }),
                    h('div', { className: 'glab-skel', style: { width: '95%' } }),
                    h('div', { className: 'glab-skel', style: { width: '88%' } }))
                : h('div', { className: 'glab-article' },
                    item.description
                      ? MarkdownTextPrimitive
                        // Same untrusted-markdown renderer the app's document
                        // preview uses; reading typography is retuned through
                        // the --dsw-font-markdown-* tokens on .glab-article.
                        ? h(MarkdownTextPrimitive, { text: item.description, streaming: false, labels: MD_LABELS })
                        : h('div', { className: 'glab-detail-desc' }, item.description)
                      : h('div', { className: 'wb-meta' }, '（无描述）')))
          : null,
        // Diff mounts LAZILY on first tab switch so opening a big MR on
        // 概览 never parses/renders its thousands of lines up front.
        detailTab === 'diff'
          ? h('div', { className: 'wb-tabpane' },
              detail.diffLoading && !detail.diff
                ? h('div', { className: 'glab-list', role: 'status' },
                    h('span', { className: 'wb-config-help' }, '正在加载代码差异…'),
                    h('div', { className: 'glab-skel', style: { width: '90%' } }),
                    h('div', { className: 'glab-skel', style: { width: '94%' } }))
                : detail.diff
                  ? h(DiffView, { key: item.forge + ':' + item.num, diffText: detail.diff })
                  : h('div', { className: 'wb-diff-empty', role: detail.diffError ? 'alert' : undefined }, detail.diffError || '无 diff 内容', detail.diffError ? h('button', { type: 'button', className: 'glab-btn', onClick: () => { void fetchDetailDiff(item, detailReqRef.current) } }, '重试加载') : null))
          : null,
        detailTab === 'notes' ? renderNotes(item, detail) : null,
      ),
    )
  }

  function renderBody() {
    const topError = stateError || (state && state.forgeError as string) || null
    return h('div', { className: 'glab-body', ref: scrollRef },
      // 详情打开时列表态导航（我的/待评审/全部）让位给详情面包屑，降低顶部密度。
      detail ? null : renderTabs(),
      topError ? h('div', { className: 'glab-error' }, topError) : null,
      detail ? renderDetail() : null,
      !detail && noteNum !== null ? renderNoteQuick() : null,
      !detail ? renderListBody() : null
    )
  }

  const updated = state && state.updatedAt as number | undefined

  // Issues 半区：onOpenMr 把关联 MR 跳转接到 MR/PR 半区的详情页（先切二级
  // 导航再开详情，列表/详情状态各自保留）。
  const viewerName = state && state.viewer
    ? (String((state.viewer as { username?: string }).username || '') || null)
    : null
  function openMrFromIssue(mr: ForgeItem) {
    setSubNav('mr')
    openDetail(mr)
  }

  if (!activeCwd) return h('div', { className: 'glab-panel' },
    renderRepoBar(),
    h('div', { className: 'glab-body' }, h(EmptyState, {
      title: '选择一个仓库',
      hint: h('button', { className: 'glab-btn glab-btn-primary', onClick: function () { setPickerOpen(true) } }, '选择工作区'),
    })))

  return h('div', { className: 'glab-panel' },
    renderRepoBar(),
    features.git ? h('div', { key: 'subnav-git',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: subNav === 'git' ? 'flex' : 'none' },
    }, h(GitPanel, { key: activeCwd, cwd: activeCwd, active: props.active !== false && subNav === 'git' })) : null,
    features.forge && subNav !== 'git' && !displayForge ? h('div', { className: 'glab-body' }, h(EmptyState, {
      title: '该工作区尚未关联可用的 GitLab / GitHub 仓库',
      hint: 'MR/PR、Issues 和自动评审需要远程仓库及已登录的 glab / gh CLI；本地 Git 功能仍可使用。',
    })) : null,
    // MR/PR 半区：display:contents 让内层 .glab-body 仍是面板的直接 flex
    // 子元素；切到 Issues 时整体 display:none（状态保留）。类名留给测试
    // 与样式定位半区范围。
    features.forge && displayForge ? h('div', {
      key: 'subnav-mr',
      className: 'wb-forge-mr-half',
      style: { display: subNav === 'mr' ? 'contents' : 'none' },
    }, renderBody()) : null,
    // Issues 半区：常挂载，激活时才发请求（见 IssuesView 的 active gate）。
    features.forge && displayForge ? h('div', {
      key: 'subnav-issues',
      className: 'wb-forge-issues-half',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: subNav === 'issues' ? 'flex' : 'none' },
    }, h(IssuesView, {
      activeCwd: activeCwd,
      active: props.active !== false && subNav === 'issues',
      viewer: viewerName,
      refreshTick: repoRefreshTick,
      onOpenMr: openMrFromIssue,
      wsData: wsData,
      wsItems: wsItems,
    })) : null,
    features.forge && displayForge && subNav === 'config' ? h('div', { className: 'glab-body wb-forge-config-half' },
      h(AutoReviewPanel, { key: activeCwd, cwd: activeCwd, refresh: reviewRefresh })) : null,
    // Shared styled confirm dialog (merge / close) — payload swaps per call
    // site; both buttons dismiss the dialog, OK runs the pending action first.
    confirmReq ? h(ConfirmDialog, Object.assign({}, confirmReq, {
      onOk: function () { setConfirmReq(null); confirmReq.onOk() },
      onCancel: function () { setConfirmReq(null) },
    })) : null,
    h(ToastStack, { toasts: toasts, onDismiss: dismissToast })
  )
}
