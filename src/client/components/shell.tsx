// Workbench sidebar, page navigation and assistant submit action.

import { React, h, useLayout, TooltipPrimitive } from '../react'
import { WB_PAGE_EVENT, loadForgeView, saveForgeView, forgeFetch, useWsData, useDmsPendingTotal, useNotificationUnread, getSessionsService, useSessionRunningIds, useSessionPendingKinds, useCompletionUnreadIds, useHiddenSessionIds } from '../runtime'
import { buildSubmitPrompt } from '../prompts'
import { useFeatureFlags, shortcutFlags, FEATURE_ORDER } from '../features'
import type { FeatureFlags } from '../features'
import { forgeIcon, workbenchIcon, repositoryIcon, ticketIcon, slsIcon, pingcodeIcon, skillIcon, gearGlyph, homeIcon, RefreshGlyph } from '../icons'
import { HomePanel, SessionStateIcon, sessionRowState, visiblePendingKind } from './home'
import { ToastProvider } from './common'
import { ForgePanel } from './forge'
import { DmsPanel } from './dms'
import { SlsPanel } from './sls'
import { PingCodePanel } from './pingcode'
import { NotificationsPanel } from './notifications'
import { SkillPanel } from './skills'
import { ConfigPanel } from './config'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'

// ── sidebar panel icon ──────────────────────────────────────────────────────

// Function-page jump channel shared by the sidebar pending shortcut and the panel:
// requestWorkbenchPage() persists the page (a cold WorkbenchPanel mount reads
// it back) and notifies a live panel through a window CustomEvent, so a jump
// works whether or not the workbench is the currently selected main panel.
export { WB_PAGE_EVENT } from '../runtime'

export type WbPage = 'home' | 'git' | 'forge' | 'dms' | 'sls' | 'pingcode' | 'skills' | 'notifications' | 'config'

export function isWbPage(value: unknown): value is WbPage {
  return value === 'git' || value === 'home' || value === 'forge' || value === 'dms' || value === 'sls' || value === 'pingcode' || value === 'skills' || value === 'notifications' || value === 'config'
}

// 功能页 ↔ 功能开关（配置页手动开关，见 features.ts）。'config' 不挂任何开关：
// 否则全部关闭后就没有入口把它打开了。'home' 同样恒可用（汇总页，各区块的
// 内容各自受对应开关约束，见 home.tsx）。
const PAGE_FEATURE: Partial<Record<WbPage, 'git' | 'forge' | 'dms' | 'sls' | 'pingcode' | 'skills' | 'notifications'>> = {
  git: 'git', forge: 'forge', dms: 'dms', sls: 'sls', pingcode: 'pingcode', skills: 'skills', notifications: 'notifications',
}

/** 该功能页是否可用（配置页恒可用）。 */
export function isPageEnabled(page: WbPage, flags: FeatureFlags): boolean {
  if (page === 'forge') return !!(flags.forge || flags.git)
  const feature = PAGE_FEATURE[page]
  return !feature || flags[feature]
}

/** 当前页被开关关掉时的落点：仍开启的第一个功能页（注册表顺序），都没有则配置页。 */
export function fallbackPage(flags: FeatureFlags): WbPage {
  for (const feature of FEATURE_ORDER) if (flags[feature]) return feature === 'git' ? 'forge' : feature as WbPage
  return 'config'
}

function persistWorkbenchPage(page: WbPage): void {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(WB_PAGE_LS_KEY, page === 'git' ? 'forge' : page)
  } catch (e) {}
}

/** Direct jump: persist the page (for a cold mount) and notify a live panel. */
export function requestWorkbenchPage(page: WbPage): void {
  if (page === 'git') saveForgeView({ ...loadForgeView(), subNav: 'git' })
  persistWorkbenchPage(page)
  try {
    const win = globalThis.window as { dispatchEvent?: (ev: unknown) => boolean } | undefined
    const CustomEventCtor = (globalThis as { CustomEvent?: new (type: string, opts?: { detail?: unknown }) => unknown }).CustomEvent
    if (typeof CustomEventCtor === 'function' && typeof win?.dispatchEvent === 'function') {
      win.dispatchEvent(new CustomEventCtor(WB_PAGE_EVENT, { detail: page }))
    }
  } catch (e) {}
}

// The sidebar「工作台」row itself is the 首页 entry: any click on the row outside
// the always-visible function shortcuts jumps the workbench home page through
// the same persist + WB_PAGE_EVENT channel as JumpItem. Clicks ON a shortcut are
// excluded so JumpItem's own requestWorkbenchPage keeps deciding the page, and
// clicks on foreign buttons inside the host row (host-provided controls) are
// left alone. Attached to the host row button right next to the data-wb-row
// tag (see PanelIcon) — a native row listener fires before React's delegated
// handlers, so neither JumpItem nor the row's selectPanel can preempt it.
export function workbenchRowClickHandler(row: Element): (ev: { target?: unknown }) => void {
  return function (ev) {
    const t = ev && ev.target
    if (!t || typeof (t as Element).closest !== 'function') return
    if ((t as Element).closest('.wb-row-jump')) return
    const btn = (t as Element).closest('button')
    if (btn && btn !== row) return
    requestWorkbenchPage('home')
  }
}

// One always-visible function shortcut in the row tail. A span (not a button —
// nested buttons are invalid HTML inside the host row button) that deliberately
// lets the click BUBBLE to the host row button: ui-sidebar's PanelRow onClick
// then selects the workbench main panel while our handler switches the page —
// together that is a direct jump to the page. The row's own click handler
// (workbenchRowClickHandler) skips .wb-row-jump targets, so this bubbling
// semantics and the row-as-home-entry coexist.
function JumpItem(props: { label: string; title?: string; icon: React.ReactNode; dot?: boolean; onJump: () => void }) {
  return h('span', {
    className: 'wb-row-jump',
    role: 'button',
    tabIndex: -1,
    title: props.title || props.label,
    'aria-label': props.label,
    onClick: function () { props.onJump() },
  },
    props.icon,
    props.dot ? h('span', { className: 'wb-row-jump-dot' }) : null
  )
}

/** 每个会话只计入最高优先级状态，与首页状态点共用判断。
 *  hidden 是首页不展示的会话（子会话 / 空白会话，见 runtime isHiddenFromHome）：
 *  宿主会话列表承载全部行，不剔除就会数出首页根本没有的会话——最典型的是
 *  teammate / subagent 会话，它们同样在跑，于是侧栏「进行中」远多于首页左栏。 */
export function sessionBadgeCounts(running: Record<string, boolean> | null, pending: Record<string, string> | null, unread: Record<string, boolean> | null, hidden?: Record<string, true> | null) {
  const counts = { ongoing: 0, warning: 0, done: 0, idle: 0 }
  const ids = new Set([...Object.keys(running || {}), ...Object.keys(pending || {}), ...Object.keys(unread || {})])
  for (const id of ids) {
    if (hidden && hidden[id]) continue
    counts[sessionRowState({ running: running?.[id] === true, waiting: false }, unread?.[id], visiblePendingKind(pending?.[id]))]++
  }
  return counts
}

export function PanelIcon(props: { size?: number; active?: boolean }) {
  const features = useFeatureFlags()
  const shortcuts = useFeatureFlags(shortcutFlags)
  const unreadRaw = useNotificationUnread()
  const unread = features.notifications ? unreadRaw : null
  const pendingRaw = useDmsPendingTotal()
  // DMS 关闭时不显示待审批红点 / 徽标（也就不再关心那次数值）。
  const pending = features.dms ? pendingRaw : null
  const sessionCounts = sessionBadgeCounts(useSessionRunningIds(), useSessionPendingKinds(), useCompletionUnreadIds(), useHiddenSessionIds())
  const sessionLabels = { ongoing: '进行中', warning: '待处理', done: '未读完成' }
  const sessionStates = (['warning', 'ongoing', 'done'] as const).filter(state => sessionCounts[state] > 0)
  // 行尾常显的快捷入口：配置页「菜单栏快捷入口」逐项控制，hover 不再弹出/替换；
  // 每个入口常显、直接点击进对应功能页。DMS 有待审批时额外带红点，且入口强制
  // 显示（配置页关掉 DMS 快捷入口只影响无待审批时的常显；要彻底隐藏 DMS 请
  // 关闭 DMS 功能开关）。
  const pendingCount = pending !== null && pending > 0 ? pending : 0
  const dmsShortcutVisible = shortcuts.dms || pendingCount > 0
  const shortcutsList = [
    shortcuts.forge ? { key: 'shortcut-forge', label: '仓库', title: '仓库', icon: repositoryIcon(15), dot: false, page: 'forge' as const } : null,
    dmsShortcutVisible ? { key: 'shortcut-dms', label: 'DMS', title: pendingCount > 0 ? 'DMS 待审批：' + pendingCount : 'DMS 工单', icon: ticketIcon(15), dot: pendingCount > 0, page: 'dms' as const } : null,
    shortcuts.sls ? { key: 'shortcut-sls', label: 'SLS', title: 'SLS 日志', icon: slsIcon(15), dot: false, page: 'sls' as const } : null,
    shortcuts.pingcode ? { key: 'shortcut-pingcode', label: 'PingCode', title: 'PingCode', icon: pingcodeIcon(15), dot: false, page: 'pingcode' as const } : null,
    shortcuts.skills ? { key: 'shortcut-skills', label: '技能', title: '技能管理', icon: skillIcon(15), dot: false, page: 'skills' as const } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null)
  const glyphRef = React.useRef<HTMLSpanElement | null>(null)
  // ui-sidebar's PanelRow renders 16px glyphs in the expanded column and 18px
  // in the 56px rail — `wide` gates the row tail (the 36px rail row has no
  // room for badges / shortcuts).
  const wide = (props.size === undefined ? 18 : props.size) <= 16
  // Tag the host row button so the plugin stylesheet can position the tail
  // against it (`button[data-wb-row]{position:relative}`). React leaves data-*
  // attributes it did not render alone, and the cleanup untags when the row
  // unmounts.
  useLayout(function () {
    const row = glyphRef.current ? glyphRef.current.closest('button') : null
    if (!row || row.dataset.wbRow === '1') return undefined
    row.dataset.wbRow = '1'
    // 行点击 = 首页入口：常显快捷入口与外来按钮之外的任意区域都直达首页（见
    // workbenchRowClickHandler），与 JumpItem 的冒泡语义并存。
    const onRowClick = workbenchRowClickHandler(row)
    row.addEventListener('click', onRowClick)
    return function () {
      delete row.dataset.wbRow
      row.removeEventListener('click', onRowClick)
    }
  }, [])
  // 行尾常显入口/胶囊的实际宽度决定标题可用空间：宽度不够时截断标题，而不是
  // 让入口盖住文字。变量挂在宿主行按钮上，CSS 用它给标题留位（宽度随侧栏变化
  // 由 calc(100% - …) 自动重算，无需监听 resize）。
  useLayout(function () {
    const root = glyphRef.current
    const row = root ? root.closest('button') as HTMLElement | null : null
    if (!row) return
    const tail = root!.querySelector('.wb-row-tail')
    if (tail) {
      row.style.setProperty('--wb-tail-w', tail.getBoundingClientRect().width + 'px')
      row.dataset.wbTail = '1'
    } else {
      row.style.removeProperty('--wb-tail-w')
      delete row.dataset.wbTail
    }
  })
  // Containment matters: the ROOT span must stay STATIC (the red dot gets its
  // own positioned wrapper instead) so the absolutely-positioned .wb-row-tail
  // skips past it and resolves against the nearest positioned ancestor — the
  // tagged row button (button[data-wb-row]{position:relative}). Rooted on the
  // 18px span instead, right:6px pushes the tail out of the row's LEFT edge
  // (regressed once: only the SLS icon survived, at the far left).
  return h('span', {
    ref: glyphRef,
    style: { display: 'inline-flex', color: 'currentColor' },
    title: ['工作台', ...(['ongoing', 'warning', 'done'] as const).filter(state => sessionCounts[state] > 0).map(state => sessionLabels[state] + '：' + sessionCounts[state])].join(' · '),
  },
    h('span', {
      key: 'glyph',
      style: { position: 'relative', display: 'inline-flex' },
    },
      workbenchIcon(props.size || 18),
      ((unread !== null && unread !== '0') || (pending !== null && pending > 0))
        ? h('span', {
          key: 'dot',
          style: {
            position: 'absolute', top: -2, right: -3, width: 7, height: 7,
            borderRadius: '50%', background: '#fc6d26',
            border: '1.5px solid var(--dsw-alias-bg-layer-1,#232324)',
          },
        })
        : null
    ),
    // 行尾固定区：配置页勾选的功能快捷入口常显在前，其后是会话状态胶囊。
    // 两者都常显，hover 不再替换/隐藏其中任何一个；点击入口直达功能页，点击
    // 胶囊或行内其它区域回首页。窄侧栏 + 多个胶囊时标题会被截断给入口让位，
    // 可在配置页关掉部分入口或拉宽侧栏。
    wide && (shortcutsList.length > 0 || sessionStates.length > 0) ? h('span', { className: 'wb-row-tail' },
      ...shortcutsList.map(item => h(JumpItem, {
        key: item.key,
        label: item.label,
        title: item.title,
        icon: item.icon,
        dot: item.dot,
        onJump: function () { requestWorkbenchPage(item.page) },
      })),
      // 每种状态一枚柔和实底胶囊（状态图标 + 数量），按侧边栏状态优先级排列：
      // 待处理 > 进行中 > 未读完成；图标与首页会话行同一组件。
      sessionStates.length > 0 ? h('span', { className: 'wb-row-session-badges' },
        ...sessionStates.map(state => h('span', { key: state, className: 'wb-spill wb-row-session-badge', 'data-state': state,
          title: sessionLabels[state] + '：' + sessionCounts[state],
          'aria-label': sessionLabels[state] + '：' + sessionCounts[state] },
          h(SessionStateIcon, { state, size: 10 }), String(sessionCounts[state])))
      ) : null
    ) : null)
}

// ── turn action: 「提交 MR/PR」(conversation.chat.assistant-actions entry) ───
//
// Registered into the finalized-assistant-message action row (the same slot
// the shipped 👍/👎 feedback buttons use). Clicking submits a prepared prompt
// into the owning Session through the official ISession API
// (beginSubmission + prompt, mode 'queue') — the Agent wakes up and performs
// the actual work: inspect diff, write title/description, commit+push,
// create the MR/PR with the workspace's forge CLI, and report the link.

function SubmitButton(props: {
  sessionId?: string
  useWorkspaces?: (selector: (snap: any) => any) => any
}) {
  const [busy, setBusy] = React.useState(false)
  const wsData = useWsData()
  // 仓库功能开关关闭时，「提交 MR/PR」这类仓库页能力一并隐藏。
  const features = useFeatureFlags()

  // The workspace this Session belongs to (framework-injected useWorkspaces
  // global seat; membership = the session id in the workspace's sessionIds).
  // props.useWorkspaces is framework-injected and stable per slot kind, so
  // this branch never flips between renders of one mount.
  let wsPath: string | null = null
  if (typeof props.useWorkspaces === 'function') {
    wsPath = props.useWorkspaces(function (snap: { items?: Array<{ sessionIds?: string[]; path?: string }> } | null) {
      if (!snap || !Array.isArray(snap.items) || !props.sessionId) return null
      const own = snap.items.find(function (w) {
        return Array.isArray(w.sessionIds) && w.sessionIds.includes(props.sessionId!)
      })
      return own ? own.path || null : null
    })
  }

  // Show only when the session workspace's git remote host is authorized for
  // a forge — i.e. the workspace surfaced in /forge/workspaces with a forge.
  const matchedWs = wsPath && wsData && Array.isArray(wsData.workspaces)
    ? wsData.workspaces.find(function (ws) { return ws.path === wsPath && ws.forge }) || null
    : null

  if (!features.forge || !getSessionsService() || !props.sessionId || !matchedWs) return null

  const forge = matchedWs.forge as 'gitlab' | 'github'
  const kind = forge === 'github' ? 'PR' : 'MR'
  const prompt = buildSubmitPrompt(forge)

  async function onClick() {
    if (busy) return
    let session: SessionFace | null = null
    try {
      const binding = getSessionsService()!.binding(props.sessionId as never)
      session = binding?.session ?? null
    } catch (e) {
      session = null
    }
    if (!session || typeof session.prompt !== 'function') {
      alert('无法访问会话服务，无法触发 Agent')
      return
    }
    setBusy(true)
    try {
      // Local echo first (renders as a normal user bubble), then the prompt.
      const handle = typeof session.beginSubmission === 'function'
        ? session.beginSubmission({ mode: 'queue', text: prompt, attachments: [] })
        : null
      const result = await session.prompt(
        [{ type: 'text', text: prompt }],
        'queue',
        undefined,
        handle ? handle.requestId : undefined,
      )
      if (result && result.ok === false) {
        alert('指令发送失败：' + ((result.error && result.error.message) || '未知错误'))
      }
    } catch (e) {
      alert('指令发送失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(false)
  }

  const label = '提交 ' + kind
  const btn = h('button', {
    className: 'glab-turnbtn',
    disabled: busy,
    onClick: function () { void onClick() },
    'aria-label': label,
    title: TooltipPrimitive ? undefined : label,
  }, forgeIcon(forge, 15))
  // Same styled Tooltip primitive (side bottom) as the 👍/👎 siblings.
  if (TooltipPrimitive) {
    return h(TooltipPrimitive, { label: label, side: 'bottom' }, btn)
  }
  return btn
}

// ── workbench shell：顶级功能页切换（仓库 / DMS 工单 / SLS 日志 / PingCode / 配置）
// 侧栏只保留一个「工作台」entry（main key "workbench"）；功能页在这里用页签
// 切换，**已开启**的页面组件常挂载、display:none 切换 —— 列表状态在页间来回
// 不丢；被功能开关关掉的域不挂载、也没有页签（开关在配置页，见 features.ts）。
// 数据刷新由外壳层轮询驱动（runtime.ts startWorkbenchPolling），面板订阅
// useShellTick 心跳后以 force=false 重拉（命中 host 缓存不重复执行 CLI）。
// 上次所在页持久化到 localStorage。

const WB_PAGE_LS_KEY = 'samanhappy.dsh-workbench.page'

function loadWorkbenchPage(): WbPage {
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(WB_PAGE_LS_KEY)
    if (saved === 'git') {
      persistWorkbenchPage('forge')
      saveForgeView({ ...loadForgeView(), subNav: 'git' })
      return 'forge'
    }
    return saved === 'forge' || saved === 'dms' || saved === 'sls' || saved === 'pingcode' || saved === 'skills' || saved === 'notifications' || saved === 'config' || saved === 'home' ? saved : 'home'
  } catch (e) {
    return 'home'
  }
}

export function WorkbenchPanel(props: Record<string, unknown>) {
  const [updateMessage, setUpdateMessage] = React.useState('')
  const [updateBusy, setUpdateBusy] = React.useState(false)
  async function refreshUpdate() {
    if (updateBusy) return
    setUpdateBusy(true)
    try {
      const data = await forgeFetch('/workbench/update/check', { method: 'POST' })
      setUpdateMessage(data.message || '已是最新版本')
    } catch (error) {
      setUpdateMessage(error instanceof Error ? error.message : String(error))
    } finally { setUpdateBusy(false) }
  }
  React.useEffect(() => {
    let active = true
    const poll = () => { void forgeFetch('/workbench/update/status').then(data => { if (active) setUpdateMessage(data.status === 'updated' || data.status === 'blocked' ? data.message : '') }).catch(() => {}) }
    poll()
    const timer = setInterval(poll, 30000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const features = useFeatureFlags()
  const [page, setPage] = React.useState<WbPage>(loadWorkbenchPage)
  const pendingRaw = useDmsPendingTotal()
  const pending = features.dms ? pendingRaw : null

  // 开关可能随时改（配置页就在同一个面板里），当前页被关掉时立即落到仍开启的
  // 功能页（都没有则配置页）并持久化，不留「页签全都不存在却还在显示某页」的
  // 中间态。渲染也以 shownPage 为准，所以状态归一化前该页的组件也不会挂载。
  const pageEnabled = isPageEnabled(page, features)
  const shownPage: WbPage = pageEnabled ? page : fallbackPage(features)

  React.useEffect(function () {
    if (pageEnabled) return
    setPage(shownPage)
    persistWorkbenchPage(shownPage)
  }, [pageEnabled, shownPage])

  function switchPage(next: WbPage) {
    if (!isPageEnabled(next, features)) return
    setPage(next)
    persistWorkbenchPage(next)
  }

  // 首页等入口通过 WB_PAGE_EVENT 切换已挂载面板；冷挂载则由
  // loadWorkbenchPage() 读回持久化页 —— 两条路径共同完成直达跳转。
  // 目标页已被开关关掉的事件直接忽略（图标本身也不会渲染，防御陈旧事件）。
  React.useEffect(function () {
    if (typeof globalThis.window === 'undefined' || typeof globalThis.window.addEventListener !== 'function') return undefined
    function onJump(ev: Event) {
      const target = (ev as CustomEvent).detail
      if (!isWbPage(target) || !isPageEnabled(target, features)) return
      setPage(target === 'git' ? 'forge' : target)
      persistWorkbenchPage(target)
    }
    globalThis.window.addEventListener(WB_PAGE_EVENT, onJump)
    return function () { globalThis.window.removeEventListener(WB_PAGE_EVENT, onJump) }
  }, [features])

  const dmsBadge = pending !== null && pending > 0
    ? h('span', { className: 'glab-badge glab-badge-hot' }, String(pending))
    : null

  // Single top bar: a segmented page switcher (visually distinct from the
  // underline scope tabs inside each page — one control language per level).
  // 只有开启的功能页出现页签（通知例外——它不设页签，见文件头注）；配置页与
  // 「主页」恒在（全部关闭后仍有入口把功能
  // 打开）。主页占第一个页签；点页签栏空白处（页签外）或侧栏「工作台」行
  // （行内待审批快捷入口外）同样回首页 —— 页签点击会冒泡到 nav，但 closest('button')
  // 命中时直接忽略，页签语义不变。
  // 配置 is a first-class page (not an inline disclosure inside 仓库): the
  // registry-driven ConfigPanel renders ALL scopes here, so future global
  // items land on the same page without a second entry point.
  // Each page keeps its own toolbar (repo bar / DMS title row) below.
  return h('div', { className: 'glab-panel wb-workbench' },
    h('div', { className: 'wb-top' },
      h('nav', {
        className: 'wb-seg',
        'aria-label': '工作台功能',
        title: '点击页签外空白处回到首页',
        onClick: function (ev: { target?: { closest?: (sel: string) => unknown } | null }) {
          const t = ev && ev.target
          if (t && typeof t.closest === 'function' && t.closest('button')) return
          switchPage('home')
        },
      },
        // 「主页」恒为第一个页签（无功能开关，与配置同）：聚合页的显式入口。
        h('button', {
          key: 'page-home',
          'aria-current': shownPage === 'home' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'home' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('home') },
          title: '工作台首页（需要我关注的汇总）',
        }, homeIcon(13), '主页'),
        features.forge || features.git ? h('button', {
          key: 'page-forge',
          'aria-current': shownPage === 'forge' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'forge' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('forge') },
          title: 'GitLab / GitHub 仓库评审（glab / gh CLI）',
        }, repositoryIcon(13), '仓库') : null,
        features.dms ? h('button', {
          key: 'page-dms',
          'aria-current': shownPage === 'dms' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'dms' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('dms') },
          title: '阿里云 DMS 工单审批（aliyun CLI）',
        }, ticketIcon(13), 'DMS', dmsBadge) : null,
        features.sls ? h('button', {
          key: 'page-sls',
          'aria-current': shownPage === 'sls' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'sls' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('sls') },
          title: '阿里云 SLS 日志查询（aliyun sls get-logs-v2）',
        }, slsIcon(13), 'SLS') : null,
        features.pingcode ? h('button', {
          key: 'page-pingcode',
          'aria-current': shownPage === 'pingcode' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'pingcode' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('pingcode') },
          title: 'PingCode 研发管理工作项（python3 技能 api_call.py）',
        }, pingcodeIcon(13), 'PingCode') : null,
        features.skills ? h('button', {
          key: 'page-skills',
          'aria-current': shownPage === 'skills' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'skills' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('skills') },
          title: '技能管理（skills.sh / npx skills CLI）',
        }, skillIcon(13), '技能') : null,
        // 通知无页签（入口收敛到首页：GitHub 未读卡 + 「查看全部」），列表页仍
        // 常挂载、受 feature.notifications 开关约束——见文件头注。
        h('button', {
          key: 'page-config',
          'aria-current': shownPage === 'config' ? 'page' : undefined,
          className: 'wb-seg-item' + (shownPage === 'config' ? ' wb-seg-active' : ''),
          onClick: function () { switchPage('config') },
          title: '功能开关、提示词与自动评审配置',
        }, gearGlyph(13), '设置')
      ),
      updateMessage ? h('div', { className: 'wb-bar-tools wb-update-status', role: 'status' },
        h('span', { className: 'wb-meta' }, updateMessage),
        h('button', { type: 'button', className: 'glab-btn', disabled: updateBusy,
          onClick: refreshUpdate, title: '重新检查工作台更新', 'aria-label': '刷新工作台更新' }, RefreshGlyph(updateBusy))) : null
    ),
    // 功能页容器保持挂载：flex:1 占满剩余空间，内层 .glab-panel 的
    // height:100% 相对它解析，避免与页签行叠加溢出。关闭的功能域直接不挂载
    // —— 既不发请求，也不保留其列表状态（重新开启后从干净状态进入）。
    // 配置页例外：面板不轮询、无列表状态，按需挂载 —— 每次进入都回到
    // 全收起，未保存的草稿也会先经 blur 提交。
    // 首页常挂载：聚合页无功能开关，但各区块内容受对应开关约束（见 home.tsx）。
    h('div', {
      key: 'page-home-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'home' ? 'flex' : 'none' },
    }, h(HomePanel, { active: shownPage === 'home', onJump: requestWorkbenchPage })),
    features.forge || features.git ? h('div', {
      key: 'page-forge-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'forge' ? 'flex' : 'none' },
    }, h(ToastProvider, null, h(ForgePanel, { ...props, active: shownPage === 'forge' }))) : null,
    features.dms ? h('div', {
      key: 'page-dms-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'dms' ? 'flex' : 'none' },
    }, h(DmsPanel, { ...props, active: shownPage === 'dms' })) : null,
    features.sls ? h('div', {
      key: 'page-sls-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'sls' ? 'flex' : 'none' },
    }, h(SlsPanel, props)) : null,
    features.pingcode ? h('div', {
      key: 'page-pingcode-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'pingcode' ? 'flex' : 'none' },
    }, h(PingCodePanel, props)) : null,
    features.skills ? h('div', {
      key: 'page-skills-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'skills' ? 'flex' : 'none' },
    }, h(ToastProvider, null, h(SkillPanel, props))) : null,
    features.notifications ? h('div', {
      key: 'page-notifications-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'notifications' ? 'flex' : 'none' },
    }, h(NotificationsPanel, { active: shownPage === 'notifications' })) : null,
    h('div', {
      key: 'page-config-body',
      style: { flex: 1, minHeight: 0, minWidth: 0, display: shownPage === 'config' ? 'flex' : 'none', flexDirection: 'column' },
    }, shownPage === 'config' ? h(ConfigPanel, { scope: 'all' }) : null)
  )
}

export { SubmitButton }
