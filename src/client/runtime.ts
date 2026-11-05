export const WB_PAGE_EVENT = 'samanhappy.dsh-workbench:page'
// dsh-workbench — browser runtime plumbing: same-origin host fetches, the
// shared /forge/workspaces store (one poll for every consumer), the DMS
// pending-approval store (sidebar red dot + page-tab badge), and the services
// apply() captures for click-time use.

import { React } from './react'
import { featureFlags } from './features'
import type { GithubNotification } from '../host/notifications'
import type { ClientContext, WsData, IssueMeta, HomePayload, DmsOrder } from './types'

export function hostBase(): string {
  const origin = globalThis.location && typeof globalThis.location.origin === 'string'
    ? globalThis.location.origin
    : undefined
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

export async function forgeFetch(path: string, opts?: { method?: string; body?: Record<string, unknown> }): Promise<any> {
  const url = new URL(path, hostBase())
  const response = await fetch(url, {
    method: (opts && opts.method) || 'GET',
    headers: { accept: 'application/json', ...((opts && opts.body) ? { 'content-type': 'application/json' } : {}) },
    body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined,
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  return response.json()
}

// ── shared /forge/workspaces store ──────────────────────────────────────────
// Both the panel chips and the per-message 提交 buttons read workspace
// detection through this TTL-guarded store, so N components produce ~one
// fetch per minute instead of N.

const WS_TTL_MS = 60000
const wsStore: { data: WsData | null; at: number; pending: Promise<WsData | null> | null; subs: Set<() => void> } = {
  data: null,
  at: 0,
  pending: null,
  subs: new Set(),
}

function wsSnapshot(): WsData | null {
  return wsStore.data
}

function wsSubscribe(fn: () => void): () => void {
  wsStore.subs.add(fn)
  void refreshWorkspaces(false) // TTL-guarded: mounts coalesce into one poll
  return function () { wsStore.subs.delete(fn) }
}

export async function refreshWorkspaces(force: boolean): Promise<WsData | null> {
  if (wsStore.pending) return wsStore.pending
  const now = Date.now()
  if (!force && wsStore.data && now - wsStore.at < WS_TTL_MS) return wsStore.data
  wsStore.pending = forgeFetch('/forge/workspaces' + (force ? '?force=1' : ''))
    .then(function (d) {
      wsStore.data = d && d.ok ? d : null
      wsStore.at = Date.now()
      wsStore.pending = null
      for (const fn of Array.from(wsStore.subs)) { try { fn() } catch (e) {} }
      return wsStore.data
    })
    .catch(function () {
      wsStore.pending = null
      return null
    })
  return wsStore.pending
}

export function useWsData(): WsData | null {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(wsSubscribe, wsSnapshot, wsSnapshot)
  }
  const [d, setD] = React.useState<WsData | null>(wsSnapshot())
  React.useEffect(function () {
    setD(wsSnapshot())
    return wsSubscribe(function () { setD(wsSnapshot()) })
  }, [])
  return d
}

// ── DMS 待审批数共享 store（侧栏红点 / DMS 行尾入口 + 顶级 DMS 页签徽标）──────
// DmsPanel 的轮询把 AS_HANDLER 总数写进来；侧栏图标与 WorkbenchPanel 页签
// 通过订阅读取。null 表示未知（CLI 不可用 / 请求失败），不显示徽标。

let dmsPendingTotal: number | null = null
const dmsPendingSubs = new Set<(v: number | null) => void>()

export function setDmsPendingTotal(n: unknown): void {
  const v = typeof n === 'number' && isFinite(n) ? n : null
  if (dmsPendingTotal === v) return
  dmsPendingTotal = v
  for (const fn of dmsPendingSubs) {
    try { fn(v) } catch (e) {}
  }
}

export function useDmsPendingTotal(): number | null {
  const [n, setN] = React.useState<number | null>(dmsPendingTotal)
  React.useLayoutEffect(function () {
    dmsPendingSubs.add(setN)
    return function () { dmsPendingSubs.delete(setN) }
  }, [])
  return n
}

// GitHub 未读提示与面板开闭无关；首屏满页时显示 50+，避免为徽标遍历收件箱。
let notificationUnread: string | null = null
const notificationUnreadSubs = new Set<(v: string | null) => void>()

function setNotificationUnread(value: string | null): void {
  notificationUnread = value
  for (const fn of notificationUnreadSubs) fn(value)
}

export function useNotificationUnread(): string | null {
  const [value, setValue] = React.useState<string | null>(notificationUnread)
  React.useLayoutEffect(() => {
    setValue(notificationUnread)
    notificationUnreadSubs.add(setValue)
    return () => { notificationUnreadSubs.delete(setValue) }
  }, [])
  return value
}

let notificationPending: Promise<{ ok: true; items: GithubNotification[]; hasMore: boolean; error?: string }> | null = null
let notificationItems: GithubNotification[] | null = null

export function getNotificationItems(): GithubNotification[] | null {
  return notificationItems
}

export function fetchUnreadNotifications() {
  if (notificationPending) return notificationPending
  notificationPending = forgeFetch('/notifications/list?host=github.com&all=false&page=1')
    .then(data => {
      if (!data?.ok || !Array.isArray(data.items)) throw new Error(data?.error || '查询通知失败')
      applyNotificationUnread(data)
      return data
    })
    .finally(() => { notificationPending = null })
  return notificationPending
}
/** 把一次 /notifications/list（all=false&page=1，即「仅未读」第一页）的响应
 *  应用到共享未读数。首页通知区与通知页的列表拉取和后台轮询是同一条查询：
 *  响应顺手喂给统计卡/徽标，计数才不会在「列表已被某次拉取刷新、下一次心跳
 *  还没跑」的窗口里和列表各说各话（点进 GitHub 已读后，首页列表先变、计数
 *  还停在上一轮）。非该口径的响应（如通知页「全部」筛选，含已读）不能喂——
 *  长度不是未读数。 */
export function applyNotificationUnread(data: { ok?: boolean; items?: unknown[]; hasMore?: boolean }): void {
  if (!featureFlags().notifications) return
  if (!data || data.ok !== true || !Array.isArray(data.items)) return
  notificationItems = data.items as GithubNotification[]
  setNotificationUnread(data.hasMore ? '50+' : String(data.items.length))
}
export function refreshNotificationUnread(): Promise<void> {
  return fetchUnreadNotifications()
    .then(() => {})
    .catch(() => { setNotificationUnread(null) })
}

// ── DMS 本地偏好（RegionId / 租户 Tid）─────────────────────────────────────
// 外壳层轮询与 DmsPanel 共用同一份持久化偏好：轮询按偏好预热 host 缓存，
// 面板进入时 force=false 命中缓存即返回，不重复执行 aliyun CLI。

const DMS_LS_KEY = 'samanhappy.dsh-workbench.dms'

export function loadDmsPrefs(): Record<string, string> {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(DMS_LS_KEY) : null
    const p = raw ? JSON.parse(raw) : null
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {}
  }
}

export function saveDmsPrefs(patch: Record<string, string>): void {
  try {
    if (!globalThis.localStorage) return
    const next = Object.assign(loadDmsPrefs(), patch)
    globalThis.localStorage.setItem(DMS_LS_KEY, JSON.stringify(next))
  } catch (e) {}
}

/** DMS 工单列表 URL（resultType 默认 AS_HANDLER 待我审批；「我的」传
 *  AS_COMMITTER。page/force 供有提交人过滤或强制刷新时翻页与绕过缓存）。 */
export function dmsOrdersUrl(force: boolean, page = 1, resultType = 'AS_HANDLER'): string {
  const p = loadDmsPrefs()
  const parts = ['resultType=' + resultType, 'page=' + page, 'pageSize=50']
  if (p.region) parts.push('region=' + encodeURIComponent(p.region))
  if (p.tid) parts.push('tid=' + encodeURIComponent(p.tid))
  if (force) parts.push('force=1')
  return '/dms/orders?' + parts.join('&')
}

/** 配置的是 DMS 显示的提交人姓名，精确匹配，空配置不过滤。 */
export function filterDmsOrders(orders: DmsOrder[], committers: string): DmsOrder[] {
  const names = committers.split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean)
  return names.length ? orders.filter((o) => names.includes(o.committer)) : orders
}

/** 有提交人过滤时读取各页，避免漏掉第一页以外的匹配工单。 */
export async function refreshDmsOrders(force: boolean): Promise<Record<string, unknown>> {
  const committers = String(loadDmsPrefs().committers || '')
  const data = await forgeFetch(dmsOrdersUrl(force))
  if (data.ok && committers.trim()) {
    const orders = ((data.orders || []) as DmsOrder[]).slice()
    for (let page = 2; orders.length < Number(data.totalCount); page++) {
      const next = await forgeFetch(dmsOrdersUrl(force, page))
      if (!next.ok) { setDmsPendingTotal(null); return next }
      const rows = (next.orders || []) as DmsOrder[]
      if (!rows.length) break
      orders.push(...rows)
    }
    data.orders = orders
  }
  setDmsPendingTotal(data && data.ok
    ? (committers.trim() ? filterDmsOrders(data.orders as DmsOrder[], committers).length : data.totalCount)
    : null)
  return data
}

// ── Issue 元信息共享 store（标签/负责人筛选源）───────────────────────────────
// /forge/issue/meta（stats + labels + members + viewer）按 cwd 建桶：IssuesView
// 的筛选下拉读这一份，TTL 60s 内多个消费者
// 合并成一次拉取（host 侧另有 5min 缓存，重复拉不重复执行 CLI）。

export interface IssueMetaSnapshot extends IssueMeta { at: number }

interface IssueMetaBucket {
  at: number
  pending: Promise<IssueMetaSnapshot | null> | null
  data: IssueMetaSnapshot | null
  subs: Set<() => void>
  subscribe(fn: () => void): () => void
  snapshot(): IssueMetaSnapshot | null
}

const ISSUE_META_TTL_MS = 60000
const issueMetaBuckets = new Map<string, IssueMetaBucket>()

function issueMetaBucket(cwd: string | null): IssueMetaBucket {
  const key = cwd || ''
  let b = issueMetaBuckets.get(key)
  if (b) return b
  const bucket: IssueMetaBucket = {
    at: 0,
    pending: null,
    data: null,
    subs: new Set(),
    subscribe(fn: () => void): () => void {
      // Passive: 订阅只登记重渲染，拉取由激活方（IssuesView
      // 的 active 效果）显式 refreshIssueMeta 触发 —— Issues 二级导航未激活时
      // 不发任何 CLI 调用。
      bucket.subs.add(fn)
      return function () { bucket.subs.delete(fn) }
    },
    snapshot(): IssueMetaSnapshot | null { return bucket.data },
  }
  issueMetaBuckets.set(key, bucket)
  return bucket
}

export async function refreshIssueMeta(cwd: string | null, force: boolean): Promise<IssueMetaSnapshot | null> {
  const b = issueMetaBucket(cwd)
  if (b.pending) return b.pending
  const now = Date.now()
  if (!force && b.data && now - b.at < ISSUE_META_TTL_MS) return b.data
  const parts: string[] = []
  if (cwd) parts.push('cwd=' + encodeURIComponent(cwd))
  if (force) parts.push('force=1')
  b.pending = forgeFetch('/forge/issue/meta' + (parts.length ? '?' + parts.join('&') : ''))
    .then(function (d) {
      b.data = d && d.ok ? Object.assign({}, d, { at: Date.now() }) as IssueMetaSnapshot : null
      b.at = Date.now()
      b.pending = null
      for (const fn of Array.from(b.subs)) { try { fn() } catch (e) {} }
      return b.data
    })
    .catch(function () {
      b.pending = null
      return null
    })
  return b.pending
}

export function useIssueMeta(cwd: string | null): IssueMetaSnapshot | null {
  const b = issueMetaBucket(cwd)
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(b.subscribe, b.snapshot, b.snapshot)
  }
  const [d, setD] = React.useState<IssueMetaSnapshot | null>(b.snapshot())
  React.useEffect(function () {
    setD(b.snapshot())
    return b.subscribe(function () { setD(b.snapshot()) })
  }, [])
  return d
}

// ── PingCode 本地偏好（上次选择的项目/负责人/状态筛选）────────────────────
// 外壳层轮询与 PingCodePanel 共用同一份持久化偏好：轮询按偏好预热 host 缓存，
// 面板进入时 force=false 命中缓存即返回，不重复执行 python 脚本。

const PC_LS_KEY = 'samanhappy.dsh-workbench.pingcode'

export function loadPingcodePrefs(): Record<string, string> {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(PC_LS_KEY) : null
    const p = raw ? JSON.parse(raw) : null
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {}
  }
}

export function savePingcodePrefs(patch: Record<string, string>): void {
  try {
    if (!globalThis.localStorage) return
    const next = Object.assign(loadPingcodePrefs(), patch)
    globalThis.localStorage.setItem(PC_LS_KEY, JSON.stringify(next))
  } catch (e) {}
}

// 负责人缺省「我」只在用户令牌模式成立（/v1/myself 仅用户令牌可用）。面板
// 探测到 status 后写入，预热 URL 与面板首拉保持同一缓存 key；未知时按
// 企业令牌处理（预热空 key，面板自行纠正）。
let pcUserTokenMode = false

export function setPingcodeUserTokenMode(v: boolean): void {
  pcUserTokenMode = !!v
}

/** PingCode 工作项列表缺省 URL（外壳层预热与面板冷挂载首拉共用同一缓存 key）。
 *  pageSize 必须与面板 listUrl 的 PC_PAGE_SIZE（100）一致；状态快筛缺省
 *  待处理 → 预热同样带 stateType=pending，否则打不中面板首拉的缓存。 */
export function pingcodeWorkItemsUrl(prefs: Record<string, string>, extra?: Record<string, string>): string {
  const parts = ['page=1', 'pageSize=100']
  const assignee = typeof prefs.assigneeId === 'string' ? prefs.assigneeId : (pcUserTokenMode ? 'me' : '')
  if (assignee) parts.push('assigneeId=' + encodeURIComponent(assignee))
  const state = typeof prefs.state === 'string' && prefs.state ? prefs.state : 'pending'
  if (state !== 'all') parts.push('stateType=' + encodeURIComponent(state))
  if (prefs.projectId) parts.push('projectId=' + encodeURIComponent(prefs.projectId))
  for (const k of Object.keys(extra || {})) parts.push(k + '=' + encodeURIComponent((extra || {})[k]))
  return '/pingcode/workitems?' + parts.join('&')
}

// ── 首页跨工作区会话共享 store（/home/sessions，只有首页消费）───────────────
// null 表示未知/失败。首页打开时以 60s 轻轮询刷新运行状态（唯一的页面自有
// 定时器，见 home.tsx 注）；外壳层轮询不预热该域——首页只在激活时拉取。

let homePayload: HomePayload | null = null
const homeSubs = new Set<() => void>()

export function setHomePayload(p: unknown): void {
  const v = p && typeof p === 'object' && (p as { ok?: boolean }).ok && Array.isArray((p as { sessions?: unknown }).sessions)
    ? p as HomePayload
    : null
  if (homePayload === v) return
  homePayload = v
  for (const fn of Array.from(homeSubs)) { try { fn() } catch (e) {} }
}

export function useHomeSessions(): HomePayload | null {
  if (typeof React.useSyncExternalStore === 'function') {
    const snap = function (): HomePayload | null { return homePayload }
    const sub = function (fn: () => void): () => void {
      homeSubs.add(fn)
      return function () { homeSubs.delete(fn) }
    }
    return React.useSyncExternalStore(sub, snap, snap)
  }
  const [d, setD] = React.useState<HomePayload | null>(homePayload)
  React.useLayoutEffect(function () {
    setD(homePayload)
    const notify = function () { setD(homePayload) }
    homeSubs.add(notify)
    return function () { homeSubs.delete(notify) }
  }, [])
  return d
}

let homePending: Promise<HomePayload | null> | null = null
let homeLimit = 10
export function refreshHomeSessions(force: boolean, limit = homeLimit): Promise<HomePayload | null> {
  if (homePending) return limit > homeLimit ? homePending.then(() => refreshHomeSessions(force, limit)) : homePending
  homeLimit = limit
  homePending = forgeFetch('/home/sessions?limit=' + limit + (force ? '&force=1' : ''))
    .then(function (d) {
      if (!d?.ok || !Array.isArray(d.sessions)) throw new Error('加载会话失败')
      setHomePayload(d)
      return homePayload
    })
    .catch(function () { return null })
    .finally(function () { homePending = null })
  return homePending
}

// ── 外壳层轮询心跳 ──────────────────────────────────────────────────────────
// 轮询从页面组件挪到插件 apply()（浏览器会话期间一直运行，与面板开闭无关）：
// 每 5 分钟刷新 DMS 待审批列表 / forge 工作区与「最近查看视图」的列表缓存，
// 完成后 bump 心跳。只预热**功能开关开启**的域——关掉的域不发任何请求。
// 常挂载的面板订阅读取心跳后以 force=false 重拉——host
// 缓存（listTtlMs 5min）命中即返回，不重复执行 CLI；面板关闭时缓存保持
// 新鲜、待审批徽标持续更新。

const SHELL_POLL_MS = 5 * 60 * 1000
const FORGE_VIEW_LS_KEY = 'samanhappy.dsh-workbench.forge-view'

/** 最近查看的 forge 视图（scope + cwd + 二级导航）——外壳层用它预热面板重进时最先请求的缓存 key。 */
export interface ForgeView {
  scope: string
  cwd: string | null
  /** 仓库页二级导航，各子页共用 cwd。 */
  subNav: 'git' | 'mr' | 'issues' | 'config'
}

export function loadForgeView(): ForgeView {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(FORGE_VIEW_LS_KEY) : null
    const v = raw ? JSON.parse(raw) : null
    if (!v || typeof v !== 'object') return { scope: 'mine', cwd: null, subNav: 'mr' }
    return {
      scope: v.scope === 'all' || v.scope === 'review' ? String(v.scope) : 'mine',
      cwd: typeof v.cwd === 'string' && v.cwd ? v.cwd : null,
      subNav: v.subNav === 'git' || v.subNav === 'issues' || v.subNav === 'config' ? v.subNav : 'mr',
    }
  } catch (e) {
    return { scope: 'mine', cwd: null, subNav: 'mr' }
  }
}

export function saveForgeView(view: { scope: string; cwd: string | null; subNav?: string }): void {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(FORGE_VIEW_LS_KEY, JSON.stringify({
      scope: view.scope === 'all' || view.scope === 'review' ? view.scope : 'mine',
      cwd: view.cwd || null,
      subNav: view.subNav === 'git' || view.subNav === 'issues' || view.subNav === 'config' ? view.subNav : 'mr',
    }))
  } catch (e) {}
}

let shellTick = 0
const shellTickSubs = new Set<(n: number) => void>()

function bumpShellTick(): void {
  shellTick += 1
  for (const fn of Array.from(shellTickSubs)) { try { fn(shellTick) } catch (e) {} }
}

/** 面板订阅外壳层心跳：每次后台轮询完成后递增，面板据此重拉（命中 warm 缓存）。 */
export function useShellTick(): number {
  if (typeof React.useSyncExternalStore === 'function') {
    const snap = function (): number { return shellTick }
    const sub = function (fn: () => void): () => void {
      shellTickSubs.add(fn)
      return function () { shellTickSubs.delete(fn) }
    }
    return React.useSyncExternalStore(sub, snap, snap)
  }
  const [n, setN] = React.useState<number>(shellTick)
  React.useLayoutEffect(function () {
    shellTickSubs.add(setN)
    return function () { shellTickSubs.delete(setN) }
  }, [])
  return n
}

/** Issues 列表缺省过滤（与 IssuesView 冷挂载的首次请求保持一致，warm 命中同一缓存 key）：
 *  全仓库数据、默认仅未关闭。 */
export function defaultIssuesUrl(cwd: string | null): string {
  const parts = ['scope=all', 'state=opened', 'sort=updated_desc', 'page=1', 'pageSize=20']
  if (cwd) parts.push('cwd=' + encodeURIComponent(cwd))
  return '/forge/issues?' + parts.join('&')
}

/** 预热 forge 缓存：最近查看的 scope+cwd 恰好是面板重进时最先请求的 key。 */
function warmForgeCaches(): Array<Promise<unknown>> {
  const view = loadForgeView()
  if (view.subNav === 'git') return []
  const stateUrl = view.cwd ? '/forge/state?cwd=' + encodeURIComponent(view.cwd) : '/forge/state'
  const mrsUrl = '/forge/mrs?scope=' + encodeURIComponent(view.scope) +
    (view.cwd ? '&cwd=' + encodeURIComponent(view.cwd) : '')
  const tasks: Array<Promise<unknown>> = [
    forgeFetch(stateUrl).catch(function () { return null }),
    forgeFetch(mrsUrl).catch(function () { return null }),
  ]
  if (view.subNav === 'issues') {
    tasks.push(forgeFetch(defaultIssuesUrl(view.cwd)).catch(function () { return null }))
    tasks.push(refreshIssueMeta(view.cwd, false).catch(function () { return null }))
  }
  return tasks
}

/** 启动外壳层轮询；返回清理函数（插件卸载时停止）。apply() 内 ctx.effect 调用。
 *  只预热**已开启**的功能域：被功能开关关掉的域不发起任何请求（面板也已不
 *  挂载）；DMS 关闭时顺带把待审批数清空，避免红点残留。 */
export function startWorkbenchPolling(): () => void {
  function poll(): void {
    const on = featureFlags()
    const tasks: Array<Promise<unknown>> = []
    if (on.notifications) tasks.push(refreshNotificationUnread())
    else setNotificationUnread(null)
    if (on.dms) {
      tasks.push(refreshDmsOrders(false).catch(function () { return null }))
    } else {
      setDmsPendingTotal(null)
    }
    if (on.forge) {
      tasks.push(refreshWorkspaces(false))
      // forge 视图（state / mrs / issues / issue meta）缓存预热
      tasks.push.apply(tasks, warmForgeCaches())
    }
    if (on.pingcode) {
      // 按偏好预热项目与工作项列表缓存（面板进入即命中，不重复跑 python）。
      tasks.push(forgeFetch('/pingcode/projects').catch(function () { return null }))
      tasks.push(forgeFetch(pingcodeWorkItemsUrl(loadPingcodePrefs())).catch(function () { return null }))
    }
    void Promise.all(tasks).then(function () { bumpShellTick() })
  }
  poll()
  const t = setInterval(poll, SHELL_POLL_MS)
  return function () { clearInterval(t) }
}

// ── apply()-time service captures ───────────────────────────────────────────
// `sessions` is captured at apply time for the turn-action button (optional:
// the button hides itself when absent). `ctx` is kept for click-time
// resolution of OPTIONAL services the bundle does not inject (uiWorkspace may
// mount after this bundle's apply).

let sessionsService: import('./types').ISessions | null = null
let pluginCtx: ClientContext | null = null

export function bindRuntime(ctx: ClientContext): void {
  sessionsService = ctx.get('sessions') || null
  pluginCtx = ctx
}

export function getSessionsService(): import('./types').ISessions | null {
  return sessionsService
}

export function getPluginCtx(): ClientContext | null {
  return pluginCtx
}

/** 在主视图打开一个会话（uiWorkspace.openSession，与侧边栏点击会话行同款
 *  导航动作）。服务缺失（旧宿主 / 测试桩）时返回 false，调用方保持无操作。 */
export function openSessionInMain(sessionId: string): boolean {
  const nav = getPluginCtx()?.get('uiWorkspace')
  if (!nav || typeof nav.openSession !== 'function') return false
  nav.openSession(sessionId as Parameters<typeof nav.openSession>[0])
  return true
}

/** 订阅宿主会话列表的运行中状态（SessionListState.byId[*].running，与侧边栏
 *  spinner 同源）。返回 sessionId → running 的平表；服务未就绪（如面板桩里
 *  sessions 服务没有 list 快照）时返回 null，调用方保留 flock 兜底结果。 */
export function useSessionRunningIds(): Record<string, boolean> | null {
  return useSessionListProjection(function (summary) { return summary.running === true })
}

/** 会话列表行里与首页口径相关的字段（按结构取用：SessionSummary 的子集）。 */
export interface SessionListFacts {
  running?: boolean
  blank?: boolean
  parentId?: string
  origin?: string
}

/** 首页永远不展示的会话：子会话（subagent / teammate，宿主列表带 parentId 或
 *  origin='subagent'）与没在运行的空白会话——与 host selectHomeSessions 的
 *  `(!blank || running) && !child` 同口径。侧边栏计数据此剔除，才能与首页两栏
 *  对得上（宿主 byId 承载全部行，含子会话与空白会话）。
 *  注意：首页会话两栏另有 24h 窗口与条数上限，未读完成可能落在窗口外——
 *  那种情况侧栏会比首页多，属于预期（侧栏是「有没有未读」的提醒，不是列表长度）。 */
export function isHiddenFromHome(summary: SessionListFacts | null | undefined): boolean {
  if (!summary) return false
  if (summary.parentId || summary.origin === 'subagent') return true
  return summary.blank === true && summary.running !== true
}

/** 订阅宿主会话列表，返回首页不展示的会话 id 集合（isHiddenFromHome）。
 *  服务未就绪时返回 null，调用方按「不剔除」处理。 */
export function useHiddenSessionIds(): Record<string, true> | null {
  return useSessionListProjection(function (summary): true | null { return isHiddenFromHome(summary) ? true : null })
}

/** 会话列表 hook 共用的订阅骨架：把 byId 快照按 project 投影成 sessionId → 值
 *  平表（project 返回 null 的会话不进表）。服务未就绪时返回 null。 */
function useSessionListProjection<T>(project: (summary: SessionListFacts) => T | null): Record<string, T> | null {
  const [out, setOut] = React.useState<Record<string, T> | null>(null)
  React.useEffect(function () {
    const list = sessionsService ? sessionsService.list : null
    if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
    const read = function () {
      try {
        const byId = list.getSnapshot().byId || {}
        const next: Record<string, T> = {}
        for (const [id, summary] of Object.entries(byId)) {
          const value = project(summary as unknown as SessionListFacts)
          if (value !== null) next[id] = value
        }
        setOut(next)
      } catch (e) { /* 服务卸载瞬间快照可能不可读：保持上次值 */ }
    }
    read()
    return list.subscribe(read)
  }, [])
  return out
}

/** uiSession.sessionStatus 里本插件消费的两个事实（按结构取用，不引入新契约名）。 */
interface HostSessionStatus {
  completionUnread?: boolean
  pendingInteraction?: { kind?: string } | undefined
}

/** 两个会话状态 hook 共用的订阅骨架：订阅宿主会话 UI 状态（uiSession.sessionStatus，
 *  侧边栏状态点同源），把快照按 project 投影成 sessionId → 值平表（project 返回
 *  null 的会话不进表）。服务未就绪（旧宿主 / 面板桩）返回 null，调用方各自回退。 */
function useSessionStatusProjection<T>(project: (status: HostSessionStatus) => T | null): Record<string, T> | null {
  const [out, setOut] = React.useState<Record<string, T> | null>(null)
  React.useEffect(function () {
    const ctx = getPluginCtx()
    const status = ctx ? ctx.get('uiSession')?.sessionStatus ?? null : null
    if (!status || typeof status.getSnapshot !== 'function' || typeof status.subscribe !== 'function') return undefined
    const read = function () {
      try {
        const next: Record<string, T> = {}
        for (const [id, st] of status.getSnapshot()) {
          const value = project(st as HostSessionStatus)
          if (value !== null) next[id] = value
        }
        setOut(next)
      } catch (e) { /* 服务卸载瞬间快照可能不可读：保持上次值 */ }
    }
    read()
    return status.subscribe(read)
  }, [])
  return out
}

/** 订阅宿主会话 UI 状态（uiSession.sessionStatus，侧边栏绿点同源），
 *  返回 sessionId → completionUnread（会话在主视图外结束、尚未被确认）。
 *  服务未就绪时返回 null，调用方回退到空闲态。 */
export function useCompletionUnreadIds(): Record<string, boolean> | null {
  return useSessionStatusProjection(function (st) { return st?.completionUnread === true ? true : null })
}

/** 订阅宿主会话 UI 状态里的待交互请求（uiSession.sessionStatus.pendingInteraction，
 *  侧边栏 warning 点同源），返回 sessionId → kind 平表；kind 白名单由展示层
 *  （首页 visiblePendingKind）过滤，这里原样透出。服务未就绪时返回 null。 */
export function useSessionPendingKinds(): Record<string, string> | null {
  return useSessionStatusProjection(function (st) {
    const kind = st?.pendingInteraction?.kind
    return typeof kind === 'string' && kind ? kind : null
  })
}

/** 订阅宿主工作区注册表（IWorkspaces.list，与侧边栏「按工作区」分组同源），
 *  返回 sessionId → WorkspaceView.title 的归属平表。服务未就绪时返回 null，
 *  调用方回退到 cwd 路径末段（DSH defaultWorkspaceTitle 同规则）。 */
export function useWorkspaceTitles(): Record<string, string> | null {
  const [titles, setTitles] = React.useState<Record<string, string> | null>(null)
  React.useEffect(function () {
    const ctx = getPluginCtx()
    const list = ctx ? ctx.get('workspaces')?.list ?? null : null
    if (!list || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return undefined
    const read = function () {
      try {
        const items = list.getSnapshot().items || []
        const out: Record<string, string> = {}
        for (const w of items) {
          if (!w.title) continue
          for (const sid of w.sessionIds) out[sid] = w.title
        }
        setTitles(out)
      } catch (e) { /* 服务卸载瞬间快照可能不可读：保持上次值 */ }
    }
    read()
    return list.subscribe(read)
  }, [])
  return titles
}
