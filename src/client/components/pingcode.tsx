// dsh-workbench — PingCode 研发管理 page (PingCodePanel), driven by the
// pingcode skill's Python scripts through the host /pingcode/* routes.
//
// 数据来自 host 的 /pingcode/* 路由（python3 <技能目录>/scripts/api_call.py）：
//   /pingcode/status    端到端探测（python3 / 技能目录 / .env 凭证 / 真实 API）
//   /pingcode/projects  项目列表（--fetch-all，项目筛选下拉）
//   /pingcode/workitems 工作项列表（项目/类型/负责人/关键词/我创建的/状态分类
//                        + 分页；page 1 附带五桶精确统计 stats）
//   /pingcode/workitem  工作项详情 + 评论
//   /pingcode/members   企业成员（负责人筛选下拉）
// 本地偏好（上次项目/负责人/状态筛选）持久化在 localStorage；刷新由外壳层
// 轮询驱动（runtime.ts startWorkbenchPolling 预热 host 缓存），面板订阅
// useShellTick 心跳后以 force=false 重拉，命中缓存不重复执行 python。
//
// 默认视图：负责人=我（assigneeId=me，服务端过滤；/v1/myself 仅用户令牌
// 可用，企业令牌模式探测回来后自动纠正为「全部负责人」）+ 状态快筛=待处理。
// 状态分类筛选是**服务端过滤**：状态全企业共享（GET /v1/pjm/work_item_states，
// 21 个），search 接口 `assignee.id + state.id in [系统态 id]` 一次返回精确
// 桶。「挂起」是 type=pending 的系统态，host 按名拆出独立成桶——待处理与
// 挂起分离后五桶恰好划分全部工作项。统计卡来自 host 的 stats（五桶 search
// total，精确值）；stats 缺失时退回本地计数。
// 大桶（如已完成 325 条）仍由自动补页拉全（≤ PC_AUTO_PAGE_LIMIT）。

import { React, h, useLayout } from '../react'
import { forgeFetch, useShellTick, loadPingcodePrefs, savePingcodePrefs, setPingcodeUserTokenMode } from '../runtime'
import { fmtTime, fmtTimeFull } from '../format'
import { Chip, EmptyState, RefreshGlyph, externalGlyph, gearGlyph } from '../icons'
import type { PingCodeMember, PingCodeProject, PingCodeStatus, PingCodeWorkItem } from '../types'
import type { FrameworkProps } from './props'

const TYPE_LABELS: Record<string, string> = { epic: '史诗', feature: '特性', story: '用户故事', task: '任务', bug: '缺陷', issue: '事项' }
// 页大小取 PingCode 上限 100（实测被尊重）：小结果集拉全的调用次数减半
// （543 条 = 6 页而非 11 页），host 侧 per-page 缓存仍逐页生效。
const PC_PAGE_SIZE = 100
/** 自动补页的上限：结果集不超过它就把剩余页拉全；超过则保持手动「加载更多」。
 *  配合服务端 stateType 过滤，大桶（如已完成 325 条）仍自动补齐。 */
const PC_AUTO_PAGE_LIMIT = 1000
/** 状态快筛五桶（导出给客户端契约测试）：挂起在 PingCode 里是 type=pending
 *  的系统态，host 按名拆出单独成桶（suspended），待处理不再混入挂起。 */
export const STATE_FILTERS: Array<{ v: string; label: string }> = [
  { v: 'all', label: '全部状态' },
  { v: 'pending', label: '待处理' },
  { v: 'suspended', label: '挂起' },
  { v: 'progress', label: '进行中' },
  { v: 'completed', label: '已完成' },
  { v: 'closed', label: '已关闭' },
]
// 状态分类 → 快筛 pill 圆点色（无 state.color 时的 chip 兜底也用这组语义色）
export const STATE_DOTS: Record<string, string> = {
  pending: 'var(--wb-warn)',
  suspended: 'var(--wb-violet)',
  progress: 'var(--wb-info)',
  completed: 'var(--wb-ok)',
  closed: 'var(--dsw-alias-label-tertiary,#8a8f98)',
}

/** 状态 chip 的类与内联色：PingCode 的 state.color（#rrggbb）直接着色整枚
 *  chip（文字/底/描边），缺色时退回 stateType 的语义色。 */
function stateView(it: PingCodeWorkItem): { cls: string; style: Record<string, string> | undefined } {
  const c = typeof it.stateColor === 'string' ? it.stateColor.trim() : ''
  if (/^#[0-9a-fA-F]{6}$/.test(c)) {
    return { cls: 'wb-pc-state', style: { color: c, background: c + '1a', borderColor: c + '40' } }
  }
  const kind = STATE_DOTS[it.stateType] ? it.stateType : ''
  return { cls: 'wb-pc-state' + (kind ? ' wb-pc-state-' + kind : ''), style: undefined }
}

/** 优先级文字着色：紧急/最高 → 红，其余带「高」→ 橙，普通/低 → 弱化灰。 */
function prioClass(priority: string): string {
  if (/紧急|最高/.test(priority)) return 'wb-pc-prio wb-pc-prio-danger'
  if (priority.indexOf('高') >= 0) return 'wb-pc-prio wb-pc-prio-warn'
  return 'wb-pc-prio'
}

/** 评论头像底色：名字哈希到固定色相（同一人颜色稳定）。 */
function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return 'hsl(' + (hash % 360) + ' 42% 46%)'
}

/** PingCode 描述/评论是 HTML 富文本（<p>/<img>…），host 已经 sanitizeRichText
 *  白名单重序列化后才发给客户端——这是 innerHTML 前的唯一防线，客户端不再自行
 *  清洗。`rich` 是 host 的清洗旗标：旧 host（未重启）发的原始富文本不带旗标，
 *  一律按纯文本渲染，避免「新客户端 + 旧 host」窗口期把未清洗 HTML 喂给
 *  innerHTML。纯文本也常见：只有带旗标且形如含标签的字符串才走 innerHTML
 *  （.wb-pc-rich，white-space 覆盖回 normal），否则维持纯文本节点（pre-wrap，
 *  与旧行为一致）。 */
export function looksLikeHtml(s: unknown): boolean {
  return /<[a-zA-Z!/?]/.test(String(s ?? ''))
}

/** 富文本正文：空给占位文案；带清洗旗标且像 HTML → innerHTML；否则原样纯文本。 */
function richBody(text: string, emptyText: string, rich?: boolean) {
  if (!text) return emptyText
  if (!rich || !looksLikeHtml(text)) return text
  return h('div', { className: 'wb-pc-rich', dangerouslySetInnerHTML: { __html: text } })
}

interface PcQuery {
  projectId: string
  typeId: string
  assigneeId: string
  scope: string
  state: string
  keywords: string
}

function prefsQuery(): PcQuery {
  const p = loadPingcodePrefs()
  return {
    projectId: String(p.projectId || ''),
    typeId: String(p.typeId || ''),
    // 负责人缺省「我」（用户令牌模式；企业令牌探测回来后自动纠正为''，
    // 不落偏好）。显式选过「全部负责人」（''）则尊重之。
    assigneeId: typeof p.assigneeId === 'string' ? p.assigneeId : 'me',
    scope: 'all',
    // 状态快筛缺省「待处理」：进入页面先看自己的待办。
    state: typeof p.state === 'string' && p.state ? p.state : 'pending',
    keywords: '',
  }
}

function listUrl(pg: number, q: PcQuery, force: boolean): string {
  const parts = ['page=' + pg, 'pageSize=' + PC_PAGE_SIZE]
  if (q.projectId) parts.push('projectId=' + encodeURIComponent(q.projectId))
  if (q.typeId) parts.push('typeId=' + encodeURIComponent(q.typeId))
  if (q.assigneeId) parts.push('assigneeId=' + encodeURIComponent(q.assigneeId))
  if (q.scope && q.scope !== 'all') parts.push('scope=' + encodeURIComponent(q.scope))
  // 状态快筛走服务端过滤（search state.id in 系统态 id），不再本地分桶。
  if (q.state && q.state !== 'all') parts.push('stateType=' + encodeURIComponent(q.state))
  if (q.keywords) parts.push('keywords=' + encodeURIComponent(q.keywords))
  if (force) parts.push('force=1')
  return '/pingcode/workitems?' + parts.join('&')
}

function PcRow(props: { item: PingCodeWorkItem; onOpen(it: PingCodeWorkItem): void }) {
  const it = props.item
  const st = stateView(it)
  return h('div', { className: 'wb-item' },
    h('button', { type: 'button', className: 'wb-item-top', onClick: function () { props.onOpen(it) } },
      h('span', { className: 'glab-mr-iid' }, it.identifier || it.id.slice(0, 8)),
      h('span', { className: 'glab-mr-title' }, it.title || '(无标题)'),
      h('span', { className: 'wb-item-chips' },
        h('span', { key: 'st', className: st.cls, style: st.style },
          h('span', { className: 'wb-pc-dot' }),
          h('span', { className: 'wb-pc-state-label' }, it.stateName || it.stateType || '未知')),
        it.type ? h(Chip, { key: 'ty' }, TYPE_LABELS[it.type] || it.type) : null,
        it.priority ? h('span', { key: 'pr', className: prioClass(it.priority) }, it.priority) : null)
    ),
    h('div', { className: 'wb-pc-meta' },
      (it.project ? it.project.name : '无项目') +
      ' · 负责人 ' + (it.assignee ? (it.assignee.displayName || it.assignee.name) : '未指派') +
      (it.endAt ? ' · 截止 ' + fmtTime(it.endAt) : ''))
  )
}

interface PcDetailState {
  item: PingCodeWorkItem
  error: string | null
  loading: boolean
}

export function PingCodePanel(props: FrameworkProps) {
  const [query, setQuery] = React.useState<PcQuery>(prefsQuery)
  const [status, setStatus] = React.useState<PingCodeStatus | null>(null)
  const [projects, setProjects] = React.useState<PingCodeProject[]>([])
  const [members, setMembers] = React.useState<PingCodeMember[]>([])
  const [items, setItems] = React.useState<PingCodeWorkItem[]>([])
  const [total, setTotal] = React.useState<number | null>(null)
  /** 五桶精确统计（服务端 search total）；null = 服务端未给（失败回退本地计数）。 */
  const [stats, setStats] = React.useState<Record<string, number> | null>(null)
  const [meInfo, setMeInfo] = React.useState<{ id: string; displayName: string } | null>(null)
  const [page, setPage] = React.useState(1)
  const [loading, setLoading] = React.useState(false)
  const [listError, setListError] = React.useState<string | null>(null)
  const [keywordsInput, setKeywordsInput] = React.useState('')
  const [detail, setDetail] = React.useState<PcDetailState | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  // ── data loading（请求序号防竞态：慢响应回来时若已发起新请求则丢弃）──────
  const statusReqRef = React.useRef(0)
  const loadStatus = React.useCallback(async function (force: boolean) {
    const req = ++statusReqRef.current
    try {
      const data = await forgeFetch('/pingcode/status' + (force ? '?force=1' : ''))
      if (req !== statusReqRef.current) return
      setStatus(data)
      // 告知 runtime 认证模式：预热 URL 的缺省负责人（我/全部）要与面板首拉一致。
      setPingcodeUserTokenMode(!!(data && data.env && data.env.authMode === 'authorization_code'))
    } catch (e) {
      if (req !== statusReqRef.current) return
      setStatus({ ok: false, error: String(e instanceof Error ? e.message : e) })
    }
  }, [])

  const projectsReqRef = React.useRef(0)
  const loadProjects = React.useCallback(async function (force: boolean) {
    const req = ++projectsReqRef.current
    try {
      const data = await forgeFetch('/pingcode/projects' + (force ? '?force=1' : ''))
      if (req !== projectsReqRef.current) return
      setProjects(data && data.ok && Array.isArray(data.projects) ? data.projects : [])
    } catch (e) {
      if (req !== projectsReqRef.current) return
      setProjects([])
    }
  }, [])

  const membersReqRef = React.useRef(0)
  const loadMembers = React.useCallback(async function (force: boolean) {
    const req = ++membersReqRef.current
    try {
      const data = await forgeFetch('/pingcode/members' + (force ? '?force=1' : ''))
      if (req !== membersReqRef.current) return
      setMembers(data && data.ok && Array.isArray(data.members) ? data.members : [])
    } catch (e) {
      if (req !== membersReqRef.current) return
      setMembers([])
    }
  }, [])

  const listReqRef = React.useRef(0)
  const loadList = React.useCallback(async function (force: boolean, pg: number, append: boolean) {
    const req = ++listReqRef.current
    setLoading(true)
    setListError(null)
    try {
      const data = await forgeFetch(listUrl(pg, query, force))
      if (req !== listReqRef.current) return
      const rows = data && data.ok && Array.isArray(data.workitems) ? data.workitems as PingCodeWorkItem[] : []
      setItems(function (prev) { return append ? prev.concat(rows) : rows })
      setTotal(data && data.ok && typeof data.total === 'number' ? data.total : null)
      setStats(data && data.ok && data.stats && typeof data.stats === 'object'
        ? data.stats as Record<string, number>
        : null)
      setMeInfo(data && data.me && typeof data.me === 'object'
        ? { id: String(data.me.id || ''), displayName: String(data.me.displayName || '') }
        : null)
      setPage(pg)
      if (!data.ok) setListError(String(data.error || '加载失败'))
    } catch (e) {
      if (req !== listReqRef.current) return
      setListError(String(e instanceof Error ? e.message : e))
    }
    setLoading(false)
  }, [query])

  // 外壳层心跳驱动重拉（force=false 命中 host 缓存）。列表拉取等探测回来再
  // 发：负责人缺省「我」依赖认证模式（/v1/myself 仅用户令牌），企业令牌模式
  // 下先把未动过的缺省纠正为「全部负责人」再拉（不落偏好——回到用户令牌
  // 环境仍默认「我」）。
  const tick = useShellTick()
  useLayout(function () {
    loadStatus(false)
    loadProjects(false)
    loadMembers(false)
  }, [tick])
  useLayout(function () {
    if (!status) return
    const env = status.ok !== false ? status.env : null
    if (env && env.authMode !== 'authorization_code' && query.assigneeId === 'me' &&
        loadPingcodePrefs().assigneeId === undefined) {
      setQuery(function (prev) { return Object.assign({}, prev, { assigneeId: '' }) })
      return
    }
    loadList(false, 1, false)
  }, [status, loadList, tick])

  // 状态快筛是本地分桶，只作用于已加载范围：结果集不大（≤ PC_AUTO_PAGE_LIMIT）
  // 时自动把剩余页补全，「待处理」默认视图的列表与统计才完整。逐页追加，
  // query 变化（loadList 依赖改变）后请求序号失效自动中断。
  useLayout(function () {
    if (query.state === 'all' || loading || detail) return
    if (total === null || total <= 0 || total > PC_AUTO_PAGE_LIMIT) return
    if (items.length === 0 || items.length >= total) return
    if (page * PC_PAGE_SIZE >= total) return
    loadList(false, page + 1, true)
  }, [query.state, loading, total, items.length, page, detail, loadList])

  function commitKeywords() {
    const kw = keywordsInput.trim().slice(0, 200)
    setQuery(function (prev) {
      return prev.keywords === kw ? prev : Object.assign({}, prev, { keywords: kw })
    })
  }

  function patchQuery(patch: Partial<PcQuery>) {
    setQuery(function (prev) {
      const next = Object.assign({}, prev, patch)
      if (next.projectId !== prev.projectId) savePingcodePrefs({ projectId: next.projectId })
      if (next.assigneeId !== prev.assigneeId) savePingcodePrefs({ assigneeId: next.assigneeId })
      if (next.state !== prev.state) savePingcodePrefs({ state: next.state })
      return next
    })
  }

  function refreshAll() {
    loadStatus(true)
    loadProjects(true)
    loadMembers(true)
    loadList(true, 1, false)
  }

  const detailReqRef = React.useRef(0)

  // 列表/详情共用同一个 .glab-body 滚动容器（详情在容器内替换列表内容），列表
  // 的 scrollTop 会残留到详情上（详情不置顶）。显式管理：开详情前记住列表
  // 滚动位置，详情打开置顶，返回列表时恢复原位置。detailOpen 只在列表↔详情
  // 切换时翻转，详情内的加载/刷新不打断用户滚动。
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const savedListScroll = React.useRef(0)
  const detailOpen = detail !== null
  useLayout(function () {
    const el = scrollRef.current
    if (!el) return
    if (detailOpen) el.scrollTop = 0
    else el.scrollTop = savedListScroll.current
  }, [detailOpen])

  // 收起详情回列表：同时使在途的详情请求失效（req 序号不再匹配），否则
  // 「点快筛 tab / 返回列表」之后迟到的详情响应会把详情重新盖回列表上。
  function closeDetail() {
    detailReqRef.current++
    setDetail(null)
  }

  async function openDetail(it: PingCodeWorkItem) {
    const req = ++detailReqRef.current
    // 列表滚动位置在换到详情前保存（滚动容器被详情复用，scrollTop 不重置）。
    const el = scrollRef.current
    if (el && !detail) savedListScroll.current = el.scrollTop
    setDetail({ item: it, error: null, loading: true })
    try {
      const data = await forgeFetch('/pingcode/workitem?id=' + encodeURIComponent(it.id))
      if (req !== detailReqRef.current) return
      const item = data && data.ok && data.workitem ? data.workitem as PingCodeWorkItem : it
      setDetail({ item: item, error: data && !data.ok ? String(data.error || '查询失败') : null, loading: false })
    } catch (e) {
      if (req !== detailReqRef.current) return
      setDetail({ item: it, error: String(e instanceof Error ? e.message : e), loading: false })
    }
  }

  // ── render ────────────────────────────────────────────────────────────────

  const env = status && status.env
  const authMode = env && env.authMode === 'authorization_code' ? '用户令牌' : '企业令牌'
  const ready = status && status.ok !== false && !(status.error)
  let statusMeta: string | null = null
  if (status && status.skill && !status.skill.found) {
    statusMeta = 'PingCode 技能目录未找到'
  } else if (status && status.probe && status.probe.ok) {
    statusMeta = 'PingCode 已连接 · ' + authMode
  } else if (status && status.probe && status.probe.error) {
    statusMeta = 'PingCode 未连接'
  }

  // 状态分类筛选走服务端（stateType → search state.id in 系统态 id）；本地
  // visible 过滤是冗余防御（服务端已按该分类返回）。统计卡优先用服务端精确
  // stats（四桶 search total），缺失时退回已加载列表的本地计数。
  // stateKey 归一名：PingCode 状态 type 是 in_progress（host 已归一为 progress，
  // 这里兜底旧 host / 原始数据的防御）。
  const stateKey = function (t: string): string { return t === 'in_progress' ? 'progress' : t }
  const visible = query.state === 'all'
    ? items
    : items.filter(function (it) { return stateKey(it.stateType) === query.state })
  const statCount = function (t: string): number {
    return items.filter(function (it) { return stateKey(it.stateType) === t }).length
  }
  const statLabels = STATE_FILTERS.filter(function (s) { return s.v !== 'all' })
    .map(function (s) { return { t: s.v, label: s.label } })

  const showScopeMine = authMode === '用户令牌'

  function renderToolbar() {
    return h('div', { className: 'wb-bar' },
      h('span', { className: 'wb-title' }, '工作项'),
      // 状态快筛 pills：计数来自服务端精确 stats（缺失时退本地已加载计数）；
      // 点一下按该分类服务端过滤，再点一下取消。
      h('span', { className: 'wb-pc-stats' },
        statLabels.map(function (s) {
          const active = query.state === s.t
          const count = stats ? (stats[s.t] || 0) : statCount(s.t)
          return h('button', {
            key: s.t,
            className: 'wb-pc-stat' + (active ? ' wb-pc-stat-active' : ''),
            onClick: function () {
              // 详情打开时点状态快筛 = 按该分类回列表：详情收起后列表视图才
              // 可见（query 变化已触发 loadList 重拉），否则筛选改了但详情
              // 仍盖在列表上，看起来「点了没反应」。
              if (detail) closeDetail()
              patchQuery({ state: active ? 'all' : s.t })
            },
            'aria-pressed': active,
            title: '按「' + s.label + '」筛选' + (stats ? '（服务端精确统计）' : '（基于已加载范围）'),
          },
            h('span', { className: 'wb-pc-stat-dot', style: { background: STATE_DOTS[s.t] } }),
            s.label + ' ' + count)
        })),
      statusMeta ? h('span', { className: 'wb-meta' }, statusMeta) : null,
      h('span', { className: 'wb-bar-spacer' }),
      h('span', { className: 'wb-bar-tools' }, h('button', {
        className: 'glab-btn', onClick: function () { setSettingsOpen(!settingsOpen) },
        title: 'PingCode 连接与配置信息', 'aria-label': '连接信息', 'aria-expanded': settingsOpen,
      }, gearGlyph(13)),
      h('button', {
        className: 'glab-btn', disabled: loading,
        onClick: refreshAll, 'aria-label': '刷新工作项', title: '刷新（重新探测并拉取）',
      }, RefreshGlyph(loading)))
    )
  }

  function renderSettings() {
    if (!settingsOpen) return null
    const s = status
    const lines: string[] = []
    if (s && s.skill) {
      lines.push('技能目录：' + (s.skill.dir || '未找到（默认 ~/.agents/skills/pingcode，或配置 pingcodeSkillDir）'))
      lines.push('认证模式：' + authMode + (s.env && s.env.baseUrlConfigured ? '（私有部署 BASE_URL 已配置）' : '（公有云 open.pingcode.com）'))
      lines.push('凭证：' + (s.env && s.env.clientCredentials ? '企业令牌 已配置' : '企业令牌 未配置') +
        (s.env && s.env.accessToken ? '；用户令牌 已配置' : '；用户令牌 未配置（运行 auth_user.py）'))
    }
    if (s && s.probe && s.probe.ok) lines.push('API 探测：成功（可见项目 ' + s.probe.projectTotal + ' 个）')
    if (s && s.probe && s.probe.error) lines.push('API 探测：' + s.probe.error)
    if (s && s.skill && s.skill.error) lines.push(s.skill.error)
    if (s && s.error) lines.push(s.error)
    return h('div', { className: 'wb-picker' },
      lines.map(function (l, i) {
        return h('div', { key: i, className: 'wb-picker-note', style: { whiteSpace: 'pre-wrap' } }, l)
      }),
      h('div', { className: 'wb-picker-note' }, '令牌有效期 30 天；过期后运行 python3 <技能目录>/scripts/auth_user.py 重新授权。')
    )
  }

  function renderFilter() {
    // 与 SLS 表单控件同一基类（glab-input：主题边框 + 橙色聚焦环 + 去浏览器默认 outline）
    const sel = { className: 'glab-input wb-sls-finput wb-sls-envsel' }
    return h('div', { className: 'wb-sls-form' },
      h('div', { className: 'wb-sls-frow' },
        h('div', { className: 'wb-sls-field', style: { flex: '1 1 200px' } },
          h('label', { className: 'wb-sls-flabel' }, '项目'),
          h('select', Object.assign({}, sel, {
            'aria-label': '项目', value: query.projectId,
            onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { patchQuery({ projectId: e.target.value }) },
            title: '按项目过滤工作项（服务端）',
          }),
            h('option', { key: '', value: '' }, '全部项目'),
            projects.map(function (p) {
              return h('option', { key: p.id, value: p.id }, p.name)
            })
          )
        ),
        h('div', { className: 'wb-sls-field', style: { flex: '0 0 130px' } },
          h('label', { className: 'wb-sls-flabel' }, '类型'),
          h('select', Object.assign({}, sel, {
            'aria-label': '工作项类型', value: query.typeId,
            onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { patchQuery({ typeId: e.target.value }) },
          }),
            h('option', { key: '', value: '' }, '全部类型'),
            Object.keys(TYPE_LABELS).map(function (t) {
              return h('option', { key: t, value: t }, TYPE_LABELS[t])
            })
          )
        ),
        h('div', { className: 'wb-sls-field', style: { flex: '0 0 150px' } },
          h('label', { className: 'wb-sls-flabel' }, '负责人'),
          h('select', Object.assign({}, sel, {
            'aria-label': '负责人', value: query.assigneeId,
            onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { patchQuery({ assigneeId: e.target.value }) },
            title: '负责人=我需要用户令牌（/v1/myself）',
          }),
            showScopeMine ? h('option', { key: 'me', value: 'me' },
              meInfo && meInfo.displayName ? '我（' + meInfo.displayName + '）' : '我') : null,
            h('option', { key: '', value: '' }, '全部负责人'),
            members.map(function (m) {
              return h('option', { key: m.id, value: m.id }, m.displayName || m.name)
            })
          )
        ),
        // 状态筛选在工具栏的快筛 pills 上（与仓库页页签同一交互语言），表单不重复。
        showScopeMine ? h('div', { className: 'wb-sls-field', style: { flex: '0 0 110px' } },
          h('label', { className: 'wb-sls-flabel' }, '范围'),
          h('select', Object.assign({}, sel, {
            'aria-label': '工作项范围', value: query.scope,
            onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { patchQuery({ scope: e.target.value }) },
          }),
            h('option', { key: 'all', value: 'all' }, '全部'),
            h('option', { key: 'created', value: 'created' }, '我创建的')
          )
        ) : null,
        h('div', { className: 'wb-sls-field wb-sls-field-grow' },
          h('label', { className: 'wb-sls-flabel' }, '搜索（编号/标题）'),
          h('input', {
            className: 'glab-input wb-sls-finput',
            placeholder: '关键字，回车搜索',
            'aria-label': '搜索工作项编号或标题', value: keywordsInput,
            onChange: function (e: React.ChangeEvent<HTMLInputElement>) { setKeywordsInput(e.target.value) },
            onBlur: commitKeywords,
            onKeyDown: function (e: { key: string; target: { blur(): void } }) { if (e.key === 'Enter') e.target.blur() },
          })
        )
      )
    )
  }

  // 结果摘要行（SLS 的「已取 N 条」同一位置与语言）：诚实标注统计/筛选范围。
  function renderSummary() {
    const stateLabel = query.state === 'all'
      ? null
      : (STATE_FILTERS.find(function (s) { return s.v === query.state }) || { label: query.state }).label
    const filling = !!(loading && stateLabel && total !== null && total > items.length &&
      total <= PC_AUTO_PAGE_LIMIT)
    const statsSource = stats ? '状态统计为服务端实时结果' : '状态统计基于已加载范围'
    return h('div', { className: 'wb-sls-summary' },
      h('span', { className: 'wb-meta' },
        '已加载 ' + items.length + (total !== null ? ' / 共 ' + total : '') + ' 条 · ' + statsSource +
        (stateLabel ? ' · 当前显示 ' + visible.length + ' 条「' + stateLabel + '」' : '') +
        (filling ? ' · 正在补齐「' + stateLabel + '」…' : '')))
  }

  function renderListBody() {
    if (listError) return h('div', { className: 'glab-error' }, listError)
    if (loading && !items.length) {
      return h('div', { className: 'glab-list' },
        h('div', { className: 'glab-skel', style: { width: '94%' } }),
        h('div', { className: 'glab-skel', style: { width: '86%' } }),
        h('div', { className: 'glab-skel', style: { width: '90%' } })
      )
    }
    if (!visible.length) {
      return h(EmptyState, {
        title: items.length ? '没有符合当前状态筛选的工作项' : '没有工作项',
        hint: items.length ? '调整筛选条件' : '调整筛选条件或刷新',
      })
    }
    const more = total !== null && items.length < total
    return h('div', { className: 'glab-list' },
      visible.map(function (it) {
        return h(PcRow, { key: it.id, item: it, onOpen: openDetail })
      }),
      more ? h('div', { className: 'wb-sls-more' },
        h('button', {
          className: 'glab-btn', disabled: loading,
          onClick: function () { loadList(false, page + 1, true) },
        }, loading ? '加载中…' : '加载更多'),
        h('span', { className: 'wb-sls-more-hint' }, '已加载 ' + items.length + ' / 共 ' + total + ' 条')
      ) : null
    )
  }

  // 详情与仓库页同一排版：面包屑（返回 + 项目）→ 大标题（编号可外链）→
  // meta 行（状态点色 chip / 类型 / 优先级 / 负责人 / 时间 / 外链）→
  // 描述与评论两张卡（标题复用 SLS 的 dhead）。
  function renderDetail() {
    if (!detail) return null
    if (detail.loading) return h('div', { className: 'glab-list' },
      h('div', { className: 'glab-skel', style: { width: '70%' } }),
      h('div', { className: 'glab-skel', style: { width: '95%' } }),
      h('div', { className: 'glab-skel', style: { width: '90%' } })
    )
    const it = detail.item
    const iid = it.identifier || it.id.slice(0, 8)
    const st = stateView(it)
    const notes = it.notes || []
    return h('div', { className: 'wb-detail-wrap' },
      h('div', { className: 'wb-detail-main' },
        h('div', { className: 'wb-crumbs' },
          h('button', { className: 'wb-crumb-link', onClick: closeDetail, title: '返回列表' }, '← 返回列表'),
          it.project ? [
            h('span', { key: 's0', className: 'wb-crumb-sep' }, '/'),
            h('span', { key: 'p', className: 'wb-crumb' }, it.project.name),
          ] : null,
          h('span', { className: 'wb-crumb-sep' }, '/'),
          h('span', { className: 'wb-crumb-here' }, iid),
        ),
        h('div', { className: 'glab-detail-head' },
          h('div', { className: 'wb-detail-title' },
            it.htmlUrl
              ? h('a', { key: 'iid', className: 'wb-title-iid', href: it.htmlUrl, target: '_blank', rel: 'noreferrer', title: '在 PingCode 打开 ' + iid }, iid)
              : h('span', { key: 'iid', className: 'wb-title-iid' }, iid),
            h('span', { className: 'wb-title-text' }, it.title || '(无标题)')),
          h('div', { className: 'wb-detail-meta' },
            h('span', { className: 'wb-title-chips' },
              h('span', { key: 'st', className: st.cls, style: st.style },
                h('span', { className: 'wb-pc-dot' }),
                h('span', { className: 'wb-pc-state-label' }, it.stateName || it.stateType || '未知')),
              it.type ? h(Chip, { key: 'ty' }, TYPE_LABELS[it.type] || it.type) : null,
              it.priority ? h('span', { key: 'pr', className: prioClass(it.priority) }, it.priority) : null),
            h('span', { className: 'wb-detail-author' },
              it.assignee ? (it.assignee.displayName || it.assignee.name) : '未指派'),
            it.startAt ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(it.startAt) }, '开始 ' + fmtTime(it.startAt)) : null,
            it.endAt ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(it.endAt) }, '截止 ' + fmtTime(it.endAt)) : null,
            it.completedAt ? h('span', { className: 'wb-meta-dim', title: fmtTimeFull(it.completedAt) }, '完成 ' + fmtTime(it.completedAt)) : null,
            it.htmlUrl ? h('a', {
              className: 'wb-pc-open', href: it.htmlUrl, target: '_blank', rel: 'noreferrer',
            }, externalGlyph(12), '在 PingCode 打开') : null,
          ),
          detail.error ? h('div', { className: 'glab-error' }, detail.error) : null,
        ),
        h('div', { className: 'wb-pc-card' },
          h('div', { className: 'wb-sls-sqlhead' }, h('span', { className: 'wb-sls-dhead' }, '描述')),
          h('div', { className: 'wb-pc-desc' + (it.description ? '' : ' wb-pc-desc-empty') },
            richBody(it.description, '无描述', it.rich)),
        ),
        h('div', { className: 'wb-pc-card wb-pc-notes' },
          h('div', { className: 'wb-sls-sqlhead' }, h('span', { className: 'wb-sls-dhead' }, '评论（' + notes.length + '）')),
          notes.length
            ? h('div', { className: 'wb-pc-note-list' },
                notes.map(function (n) {
                  const author = n.author || '匿名'
                  return h('div', { key: n.id, className: 'wb-pc-note' + (n.isReply ? ' wb-pc-note-reply' : '') },
                    h('span', { className: 'wb-pc-avatar', style: { background: avatarColor(author) } }, author.slice(0, 1)),
                    h('div', { className: 'wb-pc-note-main' },
                      h('div', { className: 'wb-pc-note-head' },
                        h('span', { className: 'wb-pc-note-author' }, author),
                        n.created_at ? h('span', { className: 'wb-pc-note-time', title: fmtTimeFull(n.created_at) }, fmtTime(n.created_at)) : null),
                      h('div', { className: 'wb-pc-note-body' }, richBody(n.content, '', n.rich)))
                  )
                }))
            : h('div', { className: 'wb-pc-desc wb-pc-desc-empty' }, '暂无评论'),
        ),
      )
    )
  }

  // 连接异常时的顶部提示（技能缺失 / 令牌过期 / 网络…），列表区仍渲染各自的错误。
  let fatal: string | null = null
  if (status && status.skill && status.skill.error && !status.skill.found) fatal = status.skill.error
  else if (status && status.probe && status.probe.error) fatal = status.probe.error
  else if (status && status.error) fatal = status.error

  return h('div', { className: 'glab-panel' },
    renderToolbar(),
    renderSettings(),
    fatal ? h('div', { className: 'glab-error', style: { margin: '0 10px 8px' } }, fatal) : null,
    h('div', { className: 'glab-body', ref: scrollRef },
      detail ? renderDetail() : null,
      !detail ? h(React.Fragment, {},
        renderFilter(),
        renderSummary(),
        renderListBody()
      ) : null
    )
  )
}
