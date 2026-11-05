// dsh-workbench — 首页：需要我关注的各类信息的汇总主页。
//
// 定位：工作台打开时的默认落地页。集中展示
//   1) 关注点统计卡：进行中会话 / 待评审 MR（当前工作区）/ 待审批 DMS /
//      GitHub 未读，点击跳对应功能页（各卡受对应功能开关约束）；
//   2) 活跃会话：跨工作区（/home/sessions，host 按过滤口径筛好：flock 兜底的
//      运行中 / 待处理 = 开放步骤/挂起工具调用 / 历史会话分批加载），客户端先以宿主
//      会话状态（sessions.list，与侧边栏 spinner 同源）覆盖运行判定——flock 是
//      写柄租约，会话开着即持有、与是否正在产出无关——再接宿主的待交互状态
//      （uiSession.sessionStatus.pendingInteraction，侧边栏 warning 点同源：审批 /
//      计划待审 / 待回答），左栏展示需要你动手的（置顶）→ 进行中 → 未读完成
//      （绿点 + 加粗：「结果还没看过」是要你扫一眼的信号，见 homeSessionColumns），
//      右栏只放已读完成的归档（不画状态点、不占槽位，标题直接从卡片内边距起排），
//      按最后活动时间（updatedAt）倒序、行尾也显示最后活动；
//      待交互会话恒保留——它可能既没被 flock 判成运行、
//      projcache 也没有它的待处理统计（老会话），但用户正等着回答；已读的空闲
//      会话查看后仍保留在右栏；列表高度随内容、最多 5 行，超出滚动；
//      单行布局：左栏状态点（与侧边栏同源）+ 标题 · 工作区 + 行尾——无待交互时是
//      相对时间（工作区名取宿主注册表
//      workspaces.list 的 title，未覆盖的会话回退 cwd 末段；左栏时间与侧边栏行尾
//      同源同值：promptedAt = 最后一条用户消息 + 向下取整分桶，助手/后台活动
//      不拨新它），有待交互时换成紧凑状态文案（待审批 / 计划待审 / 待回答，与
//      侧边栏 trailingLabel 同表）；后台常驻会话（host 按 agent preset 判定）行上
//      标「后台」并描虚线，两栏各自可在「全部 / 剔除后台」间切换；空白会话与
//      子会话已被 host 剔除；
//   3) 最近未读的 GitHub 通知（复用 /notifications/list，最多 HOME_NOTES_MAX 条；
//      该区块是首页最后一块，卡片高度随视窗拉伸、列表在卡片内滚动：视窗越高
//      看到越多行）。
//
// 刷新策略：外壳轮询（5min）+ 心跳重拉（命中 host 缓存）；首页打开时另有一个
// 60s 的轻轮询刷新会话（HOME_POLL_MS）——其余字段时效敏感，是唯一页面自有的
// 定时器（与 conventions「面板不各自起定时器」的例外，代价：一次廉价的 fs 扫描）；
// 运行状态不走轮询：sessions.list 订阅是宿主推送的。
// 功能开关只裁剪对应卡片与通知区，会话区恒展示（首页无自己的开关）。

import { React, h } from '../react'
import { forgeFetch, applyNotificationUnread, fetchUnreadNotifications, getNotificationItems, loadForgeView, openSessionInMain, refreshHomeSessions, useCompletionUnreadIds, useDmsPendingTotal, useHomeSessions, useNotificationUnread, useSessionPendingKinds, useSessionRunningIds, useShellTick, useWorkspaceTitles } from '../runtime'
import { fmtTimeRel, fmtTimeRelFloor } from '../format'
import { useFeatureFlags } from '../features'
import { EmptyState, homeIcon, repositoryIcon, ticketIcon, inboxGlyph, chevronRightGlyph } from '../icons'
import type { HomeSessionRow } from '../types'
import type { GithubNotification } from '../../host/notifications'
import { REASONS } from './notifications'
import type { WbPage } from './shell'

/** 首页打开时刷新「进行中」状态的轻轮询间隔（毫秒）。 */
export const HOME_POLL_MS = 60000
/** 通知区展示的最近未读条数上限。通知卡片吃满视窗剩余高度，条数太少会在卡片
 *  底部留出空白（尤其大屏），故上限远大于一屏可见行数；超出部分在卡片内滚动。 */
export const HOME_NOTES_MAX = 20

/** 工作区显示名的兜底：cwd 路径末段（DSH defaultWorkspaceTitle 同规则），
 *  无 cwd 时「未知工作区」。 */
export function workspaceName(cwd: string | null): string {
  if (!cwd) return '未知工作区'
  const parts = String(cwd).replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwd
}

/** 会话行的工作区名：宿主工作区注册表（IWorkspaces，按 sessionIds 归属，与
 *  侧边栏「按工作区」分组同源）优先——可重命名的工作区显示注册名；注册表未
 *  覆盖（未分组/服务未就绪）回退 cwd 路径末段。测试用纯函数。 */
export function sessionWorkspaceLabel(row: Pick<HomeSessionRow, 'sessionId' | 'cwd'>, titles: Record<string, string> | null): string {
  const t = titles ? titles[row.sessionId] : undefined
  return typeof t === 'string' && t ? t : workspaceName(row.cwd)
}

/** 统计卡数值：未知（null）显示 –；已知显示原文（未读可能为 "50+"）。 */
export function cardValue(v: number | string | null | undefined): string {
  return v === null || v === undefined ? '–' : String(v)
}

/** 侧边栏会展示的待交互 kind（DSH visiblePendingKind 同表）：审批 / 计划待审 /
 *  待回答。其它域自带的 pending 请求（如插件审批）侧边栏不展示，首页同样忽略。 */
export type SessionPendingKind = 'approval' | 'plan-review' | 'question'

export function visiblePendingKind(kind: unknown): SessionPendingKind | null {
  return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : null
}

/** 待交互会话集合：uiSession 的 sessionId → kind 平表经白名单过滤。服务未就绪
 *  （null）返回 null，调用方按「无待交互」处理。 */
export function pendingSessionIds(kinds: Record<string, string> | null): Set<string> | null {
  if (!kinds) return null
  const out = new Set<string>()
  for (const id of Object.keys(kinds)) {
    if (visiblePendingKind(kinds[id])) out.add(id)
  }
  return out
}

/** 待交互的紧凑行尾文案（与侧边栏 trailingLabel 同表：status.compact.approval 等）：
 *  有待交互时顶掉行尾相对时间，其余行照旧显示时间。未知 kind 返回 null。 */
export const PENDING_LABELS: Record<SessionPendingKind, string> = {
  approval: '待审批',
  'plan-review': '计划待审',
  question: '待回答',
}

export function pendingLabel(kind: SessionPendingKind | null | undefined): string | null {
  return kind ? PENDING_LABELS[kind] ?? null : null
}

/** 首页两栏的分栏与排序。
 *  - 左栏「活跃会话」= 需要你关注的会话：待交互 / 待处理（与侧边栏 warning 点
 *    同口径）置顶，其后进行中，最后是未读完成（会话在主视图外结束、尚未被看过，
 *    侧边栏绿点同源：「结果还没看」是要你扫一眼的信号，不该混进归档栏）。
 *    顺序即侧边栏状态序（待交互 > 进行中 > 未读完成）。待交互会话恒保留：
 *    宿主侧两个信号都可能漏（flock 是打开就持有的写柄租约、projcache 只覆盖
 *    近期会话），而侧边栏此刻正显示待审批。
 *  - 右栏「最近完成」= 已读完成的归档：全是已读，行内不需要状态点，标题直接从
 *    卡片内边距起排；查看后仍保留。归档按最后活动时间（updatedAt）倒序——历史
 *    分页在 host 侧也按同一顺序切片，保证加载更多不会打乱顺序。
 *  左栏沿用 host 契约（按 promptedAt 倒序），组内相对顺序保持不变；右栏按
 *  updatedAt 重排。未读状态源缺失（null / {}）时无法区分，按已读归档（右栏）。 */
export function homeSessionColumns(sessions: HomeSessionRow[], unread: Record<string, boolean> | null, pending?: ReadonlySet<string> | null): { active: HomeSessionRow[]; completed: HomeSessionRow[] } {
  const waitingOnUser = (r: HomeSessionRow) => pending != null && pending.has(r.sessionId)
  const isUnread = (r: HomeSessionRow) => unread ? unread[r.sessionId] === true : false
  const attention = sessions.filter((r) => waitingOnUser(r) || (!r.running && r.waiting))
  const ongoing = sessions.filter((r) => r.running && !waitingOnUser(r))
  const idle = sessions.filter((r) => !r.running && !r.waiting && !waitingOnUser(r))
  const unreadDone = idle.filter(isUnread)
  // 归档按最后活动时间倒序（updatedAt）：与 host 的分页切片同一口径。
  const readDone = idle.filter((r) => !isUnread(r)).sort((a, b) => b.updatedAt - a.updatedAt)
  return {
    active: attention.concat(ongoing, unreadDone),
    completed: readDone,
  }
}

/** 每栏的「剔除后台会话」视图过滤：只在用户切换到剔除时去掉 background 行。
 *  纯展示过滤，不改 host 口径，也不影响未读/待处理信号本身。 */
export function filterBackgroundRows(rows: HomeSessionRow[], hideBackground: boolean): HomeSessionRow[] {
  return hideBackground ? rows.filter((r) => !r.background) : rows
}

/** 用宿主会话状态（SessionListState.byId[*].running，与侧边栏同源）覆盖 flock
 *  探测结果：flock 是写柄租约——会话在 GUI 里开着即被持有，与是否正在产出无关，
 *  只适合当宿主列表未覆盖时的兜底。宿主没有该会话的行时保留 flock 值。 */
export function applyRunningOverlay(sessions: HomeSessionRow[], overlay: Record<string, boolean> | null): HomeSessionRow[] {
  if (!overlay) return sessions
  return sessions.map((r) => (r.sessionId in overlay ? Object.assign({}, r, { running: overlay[r.sessionId] }) : r))
}

// StateDot 同款会话状态点：复用宿主 dsh-client-ui-primitives StateDot 的几何、
// 动画与配色（侧边栏会话行同款）。运行态 = 14px svg 旋转环（track 常显 25% +
// 弧线呼吸，两动画同周期 1.5s）；其余 = 10px 实心点（::after 画 60% 核）。
// 颜色取宿主语义变量：ongoing=label-tertiary、warning=state-warn、
// done=state-success、idle=state-idle。
/** 把 spinner 的 CSS 动画起点钉到文档时间零点，多个运行中行相位一致（DSH syncSpinner 同款）。 */
function pinSpin(el: SVGSVGElement | null): void {
  if (el === null) return
  for (const a of el.getAnimations ? el.getAnimations({ subtree: true }) : []) a.startTime = 0
}

/** 会话行状态（点与文案共用，与 StateDot 状态词表一致）：与侧边栏
 *  sessionStatuses 同序——待交互 > 进行中 > 待处理 > 未读完成 > 空闲。待交互 =
 *  uiSession.sessionStatus.pendingInteraction 的审批 / 计划待审 / 待回答（侧边栏
 *  warning 点 + 「待审批」等行尾文案同源）：宿主此时仍报 running（回合没结束），
 *  只看运行会把「在等你」画成进行中。未读完成 =
 *  uiSession.sessionStatus.completionUnread（会话在主视图外结束、尚未被看过，
 *  侧边栏此时给绿点）；状态源缺失时回退空闲。 */
export type SessionRowState = 'ongoing' | 'warning' | 'done' | 'idle'

export function sessionRowState(
  row: Pick<HomeSessionRow, 'running' | 'waiting'>,
  unread: boolean | undefined,
  pending?: SessionPendingKind | null,
): SessionRowState {
  if (pending) return 'warning'
  if (row.running) return 'ongoing'
  if (row.waiting) return 'warning'
  if (unread) return 'done'
  return 'idle'
}

/** 会话状态图标：运行态 = StateDot 同款旋转环，其余 = 实心点。首页会话行与
 *  侧边栏状态胶囊共用；size 只作用于运行环（实心点尺寸由所在容器的 CSS 决定）。 */
export function SessionStateIcon(props: { state: SessionRowState; size?: number }) {
  const size = props.size || 14
  if (props.state === 'ongoing') {
    return h('svg', {
      ref: pinSpin,
      className: 'wb-home-sspin',
      'data-state': 'ongoing',
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      'aria-hidden': 'true',
    }, h('g', { className: 'wb-home-sspin-motion' },
      h('circle', { className: 'wb-home-sspin-track', cx: '12', cy: '12', r: '9.5' }),
      h('circle', { className: 'wb-home-sspin-arc', cx: '12', cy: '12', r: '9.5' })))
  }
  return h('span', { className: 'wb-home-sdot', 'data-state': props.state, 'aria-hidden': 'true' })
}

function SessionRow(props: { completed: boolean; row: HomeSessionRow; titles: Record<string, string> | null; unread: boolean | undefined; pending: SessionPendingKind | null }) {
  const row = props.row
  const statusLabel = pendingLabel(props.pending)
  const state = sessionRowState(row, props.unread, props.pending)
  const wsLabel = sessionWorkspaceLabel(row, props.titles)
  // 左栏每行都有状态点（待交互 / 进行中 / 未读完成，与侧边栏同源同序）；右栏全是
  // 已读完成，不画点、也不占槽位，标题直接从卡片内边距起排。
  const showIcon = !props.completed
  // 未读完成现在只出现在左栏：绿点 + 加粗即「结果还没看过」；右栏已读退到次级色。
  const unreadRow = props.unread === true
  // 整行可点击 → uiWorkspace.openSession 在主视图打开该会话（侧边栏点击会话
  // 同款导航）；标题是键盘可达的按钮，stopPropagation 防止冒泡触发两次。
  // 行尾时间：左栏与侧边栏同源同值（promptedAt = 最后一条用户消息）；右栏是
  // 按最后活动排序的归档，显示 updatedAt，否则会出现「按 A 排序、显示 B」。
  const timeValue = props.completed ? row.updatedAt : row.promptedAt
  return h('div', {
    className: 'wb-home-srow' + (unreadRow ? ' wb-home-srow-unread' : '') + (props.completed ? ' wb-home-srow-read' : ''),
    'data-state': state,
    'data-background': row.background ? '1' : undefined,
    title: (row.title || '(无标题)') + ' · ' + (row.cwd || wsLabel),
    onClick: function () { openSessionInMain(row.sessionId) },
  },
    // 状态点与侧边栏同源同序（待交互=warning、运行=spinner、未读完成=绿点）
    showIcon ? h('span', { className: 'wb-home-sicon' }, h(SessionStateIcon, { state })) : null,
    h('div', { className: 'wb-home-sbody' },
      h('button', {
        type: 'button',
        className: 'wb-home-stitle',
        onClick: function (ev: { stopPropagation(): void }) { ev.stopPropagation(); openSessionInMain(row.sessionId) },
      }, row.title || '(无标题)'),
      h('span', { className: 'wb-home-ssep' }, ' · '),
      h('span', { className: 'wb-home-sws' }, wsLabel),
      // 后台常驻会话：行内加一枚「后台」标记，两栏的过滤器据它剔除
      row.background ? h('span', { className: 'wb-spill wb-home-sbg', title: '后台会话：由后台 agent 自驱，非人工发起' }, '后台') : null),
    h('div', { className: 'wb-home-send' },
      // 有待交互时换成紧凑状态胶囊（待审批 / 计划待审 / 待回答），与侧边栏
      // trailingLabel 顶掉时间的语义一致
      statusLabel
        ? h('span', { className: 'wb-spill wb-home-slabel', 'data-state': 'warning' }, statusLabel)
        : h('span', { title: new Date(timeValue).toLocaleString('zh-CN', { hour12: false }) }, fmtTimeRelFloor(timeValue)),
      chevronRightGlyph(14)))
}

/** 每栏的显示范围过滤：「全部」/「剔除后台」。纯视图开关，不改 host 口径。 */
function BackgroundFilter(props: { hide: boolean; onChange: (hide: boolean) => void }) {
  return h('div', { className: 'wb-home-filter', role: 'group', 'aria-label': '显示范围' },
    h('button', {
      type: 'button',
      className: 'wb-home-filter-btn',
      'aria-pressed': !props.hide,
      title: '显示全部会话',
      onClick: function () { props.onChange(false) },
    }, '全部'),
    h('button', {
      type: 'button',
      className: 'wb-home-filter-btn',
      'aria-pressed': props.hide,
      title: '剔除后台常驻会话',
      onClick: function () { props.onChange(true) },
    }, '剔除后台'))
}

function StatCard(props: { label: string; value: string; icon: React.ReactNode; page?: WbPage; onJump?: (p: WbPage) => void }) {
  const card = h('div', { className: 'wb-home-card' },
    h('div', { className: 'wb-home-card-value' }, props.value),
    h('div', { className: 'wb-home-card-label' }, props.icon, props.label))
  if (!props.page || typeof props.onJump !== 'function') return card
  return h('button', {
    className: 'wb-home-card wb-home-card-link',
    type: 'button',
    onClick: function () { props.onJump!(props.page as WbPage) },
    title: '前往 ' + props.label,
  },
    h('div', { className: 'wb-home-card-value' }, props.value),
    h('div', { className: 'wb-home-card-label' }, props.icon, props.label))
}

export function HomePanel(props: { active: boolean; onJump?: (p: WbPage) => void }) {
  const [completedLimit, setCompletedLimit] = React.useState(10)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [loadMoreError, setLoadMoreError] = React.useState('')
  const loadingMoreRef = React.useRef(false)
  const features = useFeatureFlags()
  const tick = useShellTick()
  const home = useHomeSessions()
  const unreadRaw = useNotificationUnread()
  const pendingRaw = useDmsPendingTotal()
  const [reviewCount, setReviewCount] = React.useState<number | null>(null)
  const [notes, setNotes] = React.useState<GithubNotification[]>(() => (getNotificationItems() || []).slice(0, HOME_NOTES_MAX))
  const [notesLoading, setNotesLoading] = React.useState(getNotificationItems() === null)
  const [notesError, setNotesError] = React.useState('')
  const [notesRevision, setNotesRevision] = React.useState(0)
  const [notesBusy, setNotesBusy] = React.useState(false)
  const notesPending = React.useRef(0)
  // 两栏各自的后台会话过滤（默认全部；切到剔除只影响本栏展示）。
  const [hideActiveBackground, setHideActiveBackground] = React.useState(false)
  const [hideCompletedBackground, setHideCompletedBackground] = React.useState(false)

  // 激活 + 外壳心跳时重拉（命中 host 缓存）；另有 60s 轻轮询刷新进行中状态。
  React.useEffect(function () {
    if (!props.active) return undefined
    void refreshHomeSessions(false)
    return undefined
  }, [props.active, tick])

  React.useEffect(function () {
    if (!props.active) return undefined
    const t = setInterval(function () { void refreshHomeSessions(false) }, HOME_POLL_MS)
    return function () { clearInterval(t) }
  }, [props.active])

  // 待评审 MR（当前工作区，复用 /forge/state 的 warm 缓存）。
  React.useEffect(function () {
    if (!features.forge || !props.active) return undefined
    let cancelled = false
    const view = loadForgeView()
    const url = '/forge/state' + (view.cwd ? '?cwd=' + encodeURIComponent(view.cwd) : '')
    void forgeFetch(url)
      .then(function (d) {
        if (cancelled) return
        setReviewCount(d && d.ok && Array.isArray(d.reviewRequests) ? d.reviewRequests.length : null)
      })
      .catch(function () { if (!cancelled) setReviewCount(null) })
    return function () { cancelled = true }
  }, [features.forge, props.active, tick])

  // 最近未读通知（前 5 条）。
  React.useEffect(function () {
    if (!features.notifications || !props.active) return undefined
    let cancelled = false
    setNotesError('')
    void fetchUnreadNotifications()
      .then(function (d) {
        if (cancelled) return
        if (!d.ok || !Array.isArray(d.items)) throw new Error(d.error || '查询通知失败')
        // 本查询就是未读数口径：同一份响应喂给共享计数，统计卡/徽标才不会
        // 领先或落后于下面正在展示的列表（点击进 GitHub 已读后尤其明显）。
        applyNotificationUnread(d)
        setNotes(d.items.slice(0, HOME_NOTES_MAX))
      })
      .catch(function (err) { if (!cancelled) setNotesError(String(err.message || err)) })
      .finally(function () { if (!cancelled) setNotesLoading(false) })
    return function () { cancelled = true }
  }, [features.notifications, props.active, tick, notesRevision])

  async function readNotification(it: GithubNotification) {
    if (!it.unread) return
    notesPending.current += 1
    setNotesBusy(true)
    setNotesError('')
    try {
      const data = await forgeFetch('/notifications/action', { method: 'POST', body: { host: 'github.com', id: it.id, action: 'read' } })
      if (!data.ok) throw new Error(data.error || '处理通知失败')
      setNotesRevision(v => v + 1)
    } catch (err) {
      setNotesError(String(err instanceof Error ? err.message : err))
    } finally {
      notesPending.current -= 1
      setNotesBusy(notesPending.current > 0)
    }
  }

  const liveRunning = useSessionRunningIds()
  const unreadDone = useCompletionUnreadIds()
  const pendingKinds = useSessionPendingKinds()
  const wsTitles = useWorkspaceTitles()
  const sessions = home ? applyRunningOverlay(home.sessions, liveRunning) : []
  const pendingIds = pendingSessionIds(pendingKinds)
  const columns = homeSessionColumns(sessions, unreadDone, pendingIds)
  const activeSessions = filterBackgroundRows(columns.active, hideActiveBackground)
  const completedSessions = filterBackgroundRows(columns.completed, hideCompletedBackground)

  async function loadMoreCompleted() {
    if (loadingMoreRef.current) return
    if (completedSessions.length > completedLimit) {
      setCompletedLimit(completedLimit + 10)
      return
    }
    if (!home?.hasMore) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadMoreError('')
    try {
      const nextLimit = completedLimit + 10
      const data = await refreshHomeSessions(false, nextLimit)
      if (!data) throw new Error('加载会话失败，请重试')
      setCompletedLimit(nextLimit)
    } catch (err) {
      setLoadMoreError(String(err instanceof Error ? err.message : err))
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }

  const unread = features.notifications ? unreadRaw : null
  const pending = features.dms ? pendingRaw : null

  return h('div', { className: 'glab-panel wb-home' },
    h('div', { className: 'wb-home-cards' },
      h(StatCard, { label: '进行中会话', value: cardValue(home ? sessions.filter((r) => r.running).length : null), icon: homeIcon(14) }),
      features.forge ? h(StatCard, { label: '待评审 MR', value: cardValue(reviewCount), icon: repositoryIcon(14), page: 'forge', onJump: props.onJump }) : null,
      features.dms ? h(StatCard, { label: '待审批 DMS', value: cardValue(pending), icon: ticketIcon(14), page: 'dms', onJump: props.onJump }) : null,
      features.notifications ? h(StatCard, { label: 'GitHub 未读', value: cardValue(unread), icon: inboxGlyph(14), page: 'notifications', onJump: props.onJump }) : null,
    ),

    h('div', { className: 'wb-home-sessions' },
      [
        { title: '活跃会话', empty: '暂无活跃会话', rows: activeSessions, completed: false, hideBackground: hideActiveBackground, onToggleBackground: setHideActiveBackground },
        { title: '最近完成', empty: '暂无最近完成', rows: completedSessions.slice(0, completedLimit), completed: true, hideBackground: hideCompletedBackground, onToggleBackground: setHideCompletedBackground },
      ].map(section => h('div', { className: 'wb-home-sec', key: section.title },
        h('div', { className: 'wb-home-sec-head' },
          h('div', { className: 'wb-home-sec-topline' },
            h('span', { className: 'wb-home-sec-title' }, section.title),
            home === null ? null
              : !section.completed ? h('span', { className: 'wb-home-sec-badge' }, String(section.rows.length))
              // 右栏只放已读归档：不报总数（历史可无限加载），也没有未读胶囊——
              // 未读完成已并入左栏（绿点 + 计数），这里再列一次只会重复同一个信号。
              : null),
          h(BackgroundFilter, { hide: section.hideBackground, onChange: section.onToggleBackground })),
        home === null
          ? h(EmptyState, { title: '加载会话…' })
          : section.rows.length === 0
            ? h(EmptyState, { title: section.empty })
            : h('div', { className: 'wb-home-slist', onScroll: section.completed ? (ev: React.UIEvent<HTMLDivElement>) => {
              const el = ev.currentTarget
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 32) void loadMoreCompleted()
            } : undefined },
              section.rows.map(row => h(SessionRow, {
                key: row.sessionId,
                completed: section.completed,
                row,
                titles: wsTitles,
                unread: unreadDone ? unreadDone[row.sessionId] === true : false,
                pending: pendingKinds ? visiblePendingKind(pendingKinds[row.sessionId]) : null,
              })),
              section.completed && loadingMore ? h('div', { className: 'wb-home-sfoot', role: 'status' }, '加载更多…') : null,
              section.completed && loadMoreError ? h('div', { className: 'wb-home-sfoot' },
                h('button', { type: 'button', className: 'wb-home-more', onClick: () => { void loadMoreCompleted() } }, loadMoreError + '，点击重试')) : null))),
    ),

    features.notifications ? h('div', { className: 'wb-home-sec' },
      h('div', { className: 'wb-home-sec-head' },
        h('div', { className: 'wb-home-sec-topline' },
          h('span', { className: 'wb-home-sec-title' }, 'GitHub 通知'),
          // 徽标 = 未读数（与统计卡同源）；未知（null）不给数
          unread === null ? null : h('span', { className: 'wb-home-sec-badge' }, String(unread))),
        h('button', {
          className: 'wb-home-more',
          type: 'button',
          onClick: function () { if (props.onJump) props.onJump('notifications') },
        }, '查看全部', chevronRightGlyph(14))),
      notesError ? h('div', { className: 'glab-error', role: 'alert' }, notesError) : null,
      notesLoading
        ? h(EmptyState, { title: '加载通知…' })
        : notesError && notes.length === 0 ? null : notes.length === 0
        ? h(EmptyState, { title: '暂无未读通知' })
        : h('div', { className: 'wb-home-notes' },
          notes.map(function (it) {
            return h('div', { key: it.id, className: 'wb-home-note-row' },
              h('a', {
              onClick: () => { void readNotification(it) },
              onAuxClick: (ev: React.MouseEvent) => { if (ev.button === 1) void readNotification(it) },
              className: 'wb-home-note' + (it.unread ? ' wb-home-note-unread' : ''),
              href: it.url,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
              h('div', { className: 'wb-home-note-title' }, it.title),
              h('div', { className: 'wb-home-note-meta' },
                [it.repo, it.type === 'PullRequest' ? 'PR' : it.type, REASONS[it.reason] || it.reason, fmtTimeRel(it.updatedAt)].filter(Boolean).join(' · '))),
              it.unread ? h('button', {
                className: 'wb-act', type: 'button', disabled: notesBusy || notesLoading,
                onClick: () => { void readNotification(it) },
              }, '标为已读') : null)
          }))) : null)
}
