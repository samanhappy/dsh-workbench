// dsh-workbench — DMS 工单 page (DmsPanel), driven by the local aliyun CLI.
//
// 数据来自 host 的 /dms/* 路由（本机 `aliyun dms-enterprise` CLI）：
//   /dms/status   CLI 探测（已安装？有有效凭证？默认 Region？）
//   /dms/orders   ListOrders（待审批 = AS_HANDLER，我的 = AS_COMMITTER）
//   /dms/order    GetOrderBaseInfo 详情（含审批流 ID）
//   /dms/order/sql  工单内容详情（TABLE_SYNC → GetStructSyncExecSqlDetail，
//                  DATA_CHANGE → GetDataCorrectOrderDetail，PERM_APPLY /
//                  OWNER_APPLY → GetPermApplyOrderDetail /
//                  GetOwnerApplyOrderDetail；宿主按 PluginType 路由，申请类
//                  工单没有 SQL，回 apply 申请内容，其余类型 supported=false
//                  不执行 CLI）
//   /dms/order/approve  ApproveOrder（AGREE / REJECT；WorkflowInstanceId 宿主侧解析）
// RegionId / 租户 Tid 持久化在 localStorage（留空 = CLI profile 默认值）。
// 刷新由外壳层轮询驱动（见 runtime.ts startWorkbenchPolling）：面板订阅
// useShellTick 心跳后以 force=false 重拉，命中 host 缓存不重复执行 CLI。
// 例外：进入本页时若待审批列表为空，强制刷新一次（见 entryRefreshRef）——
// 后台轮询的空缓存最长存活一个 TTL，不该让用户以为真的没有待办。

import { React, h, useLayout } from '../react'
import { forgeFetch, dmsOrdersUrl, refreshDmsOrders, loadDmsPrefs, saveDmsPrefs, setDmsPendingTotal, filterDmsOrders, useShellTick } from '../runtime'
import { dmsShortTime } from '../format'
import { Chip, EmptyState, RefreshGlyph, gearGlyph } from '../icons'
import { SqlBlock, copyText } from './sls'
import { ConfirmDialog, type ConfirmRequest } from './confirmdialog'
import type { DmsApplyDetail, DmsOrder, DmsOrderSql } from '../types'
import type { FrameworkProps } from './props'

// StatusCode → { label, chip kind }（StatusDesc 优先，仅作回退与配色依据）。
const DMS_STATUS: Record<string, { label: string; kind: string }> = {
  toaudit: { label: '待审批', kind: 'draft' },
  new: { label: '新建', kind: 'review' },
  processing: { label: '执行中', kind: 'review' },
  approved: { label: '已通过', kind: 'ok' },
  success: { label: '已完成', kind: 'ok' },
  reject: { label: '已拒绝', kind: 'closed' },
  fail: { label: '失败', kind: 'closed' },
  cancel: { label: '已取消', kind: '' },
  closed: { label: '已关闭', kind: '' },
}

/** 申请类工单的 PluginType（这两类的 /dms/order/sql 回报申请内容而非 SQL）。 */
const APPLY_ORDER_TYPES = ['PERM_APPLY', 'OWNER_APPLY']

function dmsStatusView(o: DmsOrder): { label: string; kind: string } {
  const meta = DMS_STATUS[o.statusCode] || null
  return {
    label: o.statusDesc || (meta && meta.label) || o.statusCode || '未知',
    kind: meta ? meta.kind : '',
  }
}

function DmsRow(props: {
  order: DmsOrder
  busy: boolean
  /** 「我的」列表是提交人视角：不提供审批动作；标题本身就是详情入口。 */
  readOnly: boolean
  onOpen(order: DmsOrder): void
  onAgree(order: DmsOrder): void
  onReject(order: DmsOrder): void
}) {
  const o = props.order
  const st = dmsStatusView(o)
  const pending = !props.readOnly && (o.statusCode === 'toaudit' || o.statusCode === 'new')
  return h('div', { className: 'wb-item' },
    h('button', { type: 'button', className: 'wb-item-top', onClick: function () { props.onOpen(o) } },
      h('span', { className: 'glab-mr-iid' }, '#' + o.orderId),
      h('span', { className: 'glab-mr-title' }, o.comment || '(无备注)'),
      h('span', { className: 'wb-item-chips' }, h(Chip, { kind: st.kind }, st.label))
    ),
    h('div', { className: 'glab-mr-branches' },
      (o.pluginType || '工单') + ' · 提交人 ' + (o.committer || '?') +
      ' · 创建于 ' + dmsShortTime(o.createTime) +
      (o.lastModifyTime && o.lastModifyTime !== o.createTime ? ' · 更新于 ' + dmsShortTime(o.lastModifyTime) : '')
    ),
    // 标题按钮已经是详情入口，行操作只保留审批动作；无需审批时整行不占位。
    pending ? h('div', { className: 'wb-item-actions' },
      h('button', {
        className: 'wb-act wb-act-ok', disabled: props.busy,
        onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); props.onAgree(o) },
        title: '同意当前审批节点',
      }, '同意'),
      h('button', {
        className: 'wb-act wb-act-danger', disabled: props.busy,
        onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); props.onReject(o) },
        title: '拒绝该工单的当前审批节点（需填写备注）',
      }, '拒绝')
    ) : null
  )
}

interface DmsDetailState {
  order: DmsOrder
  error: string | null
  loading: boolean
  /** 从「我的」进入：只读详情，不渲染审批表单与动作。 */
  readOnly: boolean
}

/** 详情页的内容详情区状态（/dms/order/sql 独立于工单基础信息加载）。 */
interface DmsDetailSqlState {
  loading: boolean
  data: DmsOrderSql | null
  error: string | null
}

export function DmsPanel(props: FrameworkProps & { active?: boolean }) {
  // 外壳层把功能页常挂载、用 display 切换，页签激活态由 active 传入；
  // 旧宿主/测试不传时按激活处理（与常挂载的旧行为一致）。
  const pageActive = props.active !== false
  // 输入值（inputs）与已提交的查询参数（query）分离：只在 blur / Enter 时提交，
  // 避免每敲一个字符就重新拉一次工单列表。
  const [inputs, setInputs] = React.useState(function () {
    const p = loadDmsPrefs()
    return { region: String(p.region || ''), tid: String(p.tid || ''), committers: String(p.committers || '') }
  })
  const [query, setQuery] = React.useState(function () {
    const p = loadDmsPrefs()
    return { region: String(p.region || ''), tid: String(p.tid || ''), committers: String(p.committers || '') }
  })
  const [tab, setTab] = React.useState<'review' | 'all' | 'mine'>('review')
  const [status, setStatus] = React.useState<Record<string, unknown> | null>(null)     // /dms/status payload
  const [orders, setOrders] = React.useState<Record<string, unknown> | null>(null)     // /dms/orders payload (AS_HANDLER)
  const [myOrders, setMyOrders] = React.useState<Record<string, unknown> | null>(null) // /dms/orders payload (AS_COMMITTER，按需加载)
  const [listError, setListError] = React.useState<string | null>(null)
  const [myError, setMyError] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<DmsDetailState | null>(null)     // { order, error, loading }
  const [detailSql, setDetailSql] = React.useState<DmsDetailSqlState | null>(null) // 工单内容详情区（SQL / 申请内容）
  const [sqlCopied, setSqlCopied] = React.useState(false)                     // SQL 复制按钮反馈
  const [detailComment, setDetailComment] = React.useState('')
  const [rejectNum, setRejectNum] = React.useState<string | null>(null)
  const [rejectComment, setRejectComment] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false) // Region/Tid disclosure
  // Pending styled-confirm request — replaces the native confirm() on 同意
  // (list-row quick action; the detail form submits without a confirm).
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null)

  // 未手动填过 Region 时采用 CLI profile 的默认 Region。
  useLayout(function () {
    if (query.region) return
    const cli = status && status.cli ? status.cli as { activeRegion?: string } : null
    const r = cli ? cli.activeRegion : undefined
    if (!r) return
    setInputs(function (prev) { return Object.assign({}, prev, { region: r || '' }) })
    setQuery(function (prev) { return Object.assign({}, prev, { region: r || '' }) })
    saveDmsPrefs({ region: r || '' })
  }, [status, query])

  function commitInputs() {
    const next = { region: inputs.region.trim(), tid: inputs.tid.trim(), committers: inputs.committers.trim() }
    saveDmsPrefs(next)
    setQuery(function (prev) {
      return prev.region === next.region && prev.tid === next.tid && prev.committers === next.committers ? prev : next
    })
  }

  function dmsQuery(extra?: Record<string, string>): string {
    const parts: string[] = []
    if (query.region) parts.push('region=' + encodeURIComponent(query.region))
    if (query.tid) parts.push('tid=' + encodeURIComponent(query.tid))
    for (const k of Object.keys(extra || {})) parts.push(k + '=' + encodeURIComponent((extra || {})[k]))
    return parts.length ? '?' + parts.join('&') : ''
  }

  const statusReqRef = React.useRef(0)
  const loadStatus = React.useCallback(async function (force: boolean) {
    const req = ++statusReqRef.current
    try {
      const data = await forgeFetch('/dms/status' + (force ? '?force=1' : ''))
      if (req !== statusReqRef.current) return
      setStatus(data)
    } catch (e) {
      if (req !== statusReqRef.current) return
      setStatus({ ok: false, cli: { available: false, error: String(e instanceof Error ? e.message : e) } })
    }
  }, [])

  const listReqRef = React.useRef(0)
  const loadList = React.useCallback(async function (force: boolean) {
    const req = ++listReqRef.current
    setListError(null)
    try {
      // refreshDmsOrders 走持久化 Region/Tid 的同一 URL，并把 AS_HANDLER
      // 的 totalCount（服务端待我审批总数）喂给共享徽标 store。
      const data = await refreshDmsOrders(force)
      if (req !== listReqRef.current) return
      setOrders(data)
      if (!data.ok) setListError(String(data.error || '加载失败'))
    } catch (e) {
      if (req !== listReqRef.current) return
      setDmsPendingTotal(null)
      setListError(String(e instanceof Error ? e.message : e))
    }
  }, [query])

  // 「我的」：AS_COMMITTER（我提交的工单）。不在挂载时预热——首次切到该页签
  // 才执行 CLI；host 缓存按 resultType 分桶，来回切页签不重复执行。
  const myReqRef = React.useRef(0)
  const loadMine = React.useCallback(async function (force: boolean) {
    const req = ++myReqRef.current
    setMyError(null)
    try {
      const data = await forgeFetch(dmsOrdersUrl(force, 1, 'AS_COMMITTER'))
      if (req !== myReqRef.current) return
      setMyOrders(data)
      if (!data.ok) setMyError(String(data.error || '加载失败'))
    } catch (e) {
      if (req !== myReqRef.current) return
      setMyError(String(e instanceof Error ? e.message : e))
    }
  }, [query])

  // 外壳层心跳：插件 apply() 每 5 分钟后台刷新（面板关闭也在跑）并 bump，
  // 这里订阅后以 force=false 重拉——host 缓存（listTtlMs 5min）命中即返回，
  // 不重复执行 CLI。面板自身不再持有 setInterval。
  const tick = useShellTick()
  useLayout(function () {
    loadStatus(false)
    loadList(false)
  }, [loadList, tick])

  // 「我的」只在页签激活时拉取；心跳到达时同样以缓存优先刷新当前视角。
  useLayout(function () {
    if (tab !== 'mine') return
    loadMine(false)
  }, [tab, loadMine, tick])

  // 进入 DMS 页签时若待审批列表为空，强制刷新一次绕过 host 缓存：后台轮询
  // 写入的空结果在一个 TTL 内都算命中，新工单会被挡住。只看进入那一刻的
  // 已加载数据：本次进入判定一次后即锁定（补刷后仍为空也不重复，之后列表
  // 再变空也不再补刷）；离开页签时复位，下次进入可再判定。
  const entryRefreshRef = React.useRef(false)
  useLayout(function () {
    if (!pageActive) {
      entryRefreshRef.current = false
      return
    }
    if (entryRefreshRef.current) return
    if (!orders || orders.ok !== true) return
    entryRefreshRef.current = true
    if (((orders.orders as DmsOrder[]) || []).length) return
    loadList(true)
  }, [pageActive, orders, loadList])

  const detailReqRef = React.useRef(0)

  // 列表/详情共用同一个 .glab-body 滚动容器（详情在容器内替换列表内容），列表
  // 的 scrollTop 会残留到详情上（详情不置顶）。显式管理：开详情前记住列表
  // 滚动位置，详情打开置顶，返回列表时恢复原位置。detailOpen 只在列表↔详情
  // 切换时翻转，详情内的加载/审批刷新不打断用户滚动。
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const savedListScroll = React.useRef(0)
  const detailOpen = detail !== null
  useLayout(function () {
    const el = scrollRef.current
    if (!el) return
    if (detailOpen) el.scrollTop = 0
    else el.scrollTop = savedListScroll.current
  }, [detailOpen])

  async function openDetail(o: DmsOrder) {
    const req = ++detailReqRef.current
    const readOnly = tab === 'mine'
    // 列表滚动位置在换到详情前保存（滚动容器被详情复用，scrollTop 不重置）。
    const el = scrollRef.current
    if (el && !detail) savedListScroll.current = el.scrollTop
    setDetail({ order: o, error: null, loading: true, readOnly: readOnly })
    setDetailComment('')
    setSqlCopied(false)
    setDetailSql({ loading: true, data: null, error: null })
    // 内容详情与工单基础信息并行拉（同源同权）：详情失败不影响头部渲染，
    // 只在详情区显示错误行。
    forgeFetch('/dms/order/sql' + dmsQuery({ id: o.orderId, type: o.pluginType }))
      .then(function (data) {
        if (req !== detailReqRef.current) return
        const d = data && data.ok ? (data as unknown as DmsOrderSql) : null
        setDetailSql({ loading: false, data: d, error: data && !data.ok ? (data.error || '查询失败') : null })
      })
      .catch(function (e) {
        if (req !== detailReqRef.current) return
        setDetailSql({ loading: false, data: null, error: String(e instanceof Error ? e.message : e) })
      })
    try {
      const data = await forgeFetch('/dms/order' + dmsQuery({ id: o.orderId }))
      if (req !== detailReqRef.current) return
      const order = data && data.ok && data.order ? data.order : o
      setDetail({ order: order, error: data && !data.ok ? (data.error || '查询失败') : null, loading: false, readOnly: readOnly })
    } catch (e) {
      if (req !== detailReqRef.current) return
      setDetail({ order: o, error: String(e instanceof Error ? e.message : e), loading: false, readOnly: readOnly })
    }
  }

  async function act(path: string, body: Record<string, unknown>, onDone?: (res: Record<string, unknown>) => void) {
    setBusy(true)
    try {
      const res = await forgeFetch(path, {
        method: 'POST',
        body: Object.assign({ region: query.region || undefined, tid: query.tid || undefined }, body),
      })
      if (res && res.ok === false) {
        alert('操作失败：' + (res.error || '未知错误'))
      } else if (onDone) {
        onDone(res)
      }
    } catch (e) {
      alert('操作失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(false)
    void loadList(true)
  }

  function askAgree(o: DmsOrder) {
    const hint = o.comment ? o.comment.slice(0, 80) : '无备注'
    // Styled confirm dialog (was native confirm()); agreeing runs the same
    // approve call — the dialog is dismissed before the POST by the panel.
    setConfirmReq({
      title: '同意工单 ' + o.orderId + '？',
      lines: [hint, '同意后进入下一审批节点或开始执行。'],
      okLabel: '确认同意',
      onOk: function () {
        const fromDetail = detail && detail.order && String(detail.order.orderId) === String(o.orderId)
        act('/dms/order/approve', {
          id: o.orderId,
          action: 'AGREE',
          workflowInstanceId: fromDetail && detail.order.workflowInstanceId ? detail.order.workflowInstanceId : undefined,
        })
      },
    })
  }

  function submitDetail(action: string) {
    const o = detail && detail.order
    if (!o) return
    act('/dms/order/approve', {
      id: o.orderId,
      action: action,
      comment: detailComment.trim() || undefined,
      workflowInstanceId: o.workflowInstanceId || undefined,
    }, function () {
      setDetail(null)
      setDetailComment('')
    })
  }

  // Toolbar row: section title + pending badge + CLI status meta, with the
  // Region/Tid configuration behind a ⚙ disclosure (config is not chrome).
  function renderToolbar() {
    const cli = status && status.cli ? status.cli as { available?: boolean; configured?: boolean; activeRegion?: string | null } : null
    // 徽标只表示「待我审批」总数；「我的」页签是全部我提交的工单，不显示。
    const total = tab === 'mine' || !orders || !orders.ok
      ? null
      : (tab === 'review' && query.committers ? filterDmsOrders((orders.orders || []) as DmsOrder[], query.committers).length : orders.totalCount)
    let cliMeta: string | null = null
    if (cli && cli.available && cli.configured) {
      cliMeta = 'aliyun CLI 已登录' + (cli.activeRegion ? ' · ' + cli.activeRegion : '')
    } else if (cli && !cli.available) {
      cliMeta = 'aliyun CLI 不可用'
    }
    return h('div', { className: 'wb-bar' },
      h('span', { className: 'wb-title' }, 'DMS'),
      typeof total === 'number' && total > 0
        ? h('span', { className: 'glab-badge glab-badge-hot' }, String(total))
        : null,
      cliMeta ? h('span', { className: 'wb-meta' }, cliMeta) : null,
      h('span', { className: 'wb-bar-spacer' }),
      h('span', { className: 'wb-bar-tools' }, h('button', {
        className: 'glab-btn', onClick: function () { setSettingsOpen(!settingsOpen) },
        title: 'RegionId / 租户 / 提交人设置', 'aria-label': 'DMS 连接设置', 'aria-expanded': settingsOpen,
      }, gearGlyph(13)),
      h('button', {
        className: 'glab-btn', disabled: busy,
        onClick: function () { loadStatus(true); if (tab === 'mine') loadMine(true); else loadList(true) },
        'aria-label': '刷新工单',
        title: '刷新' + (updated ? '（上次 ' + fmtDmsUpdated(updated) + '）' : ''),
      }, RefreshGlyph(busy)))
    )
  }

  function renderSettings() {
    if (!settingsOpen) return null
    return h('div', { className: 'wb-picker' },
      h('div', { className: 'wb-picker-row' },
        h('div', { className: 'glab-field', style: { flex: 1, minWidth: 150 } },
          h('label', { className: 'glab-label' }, 'RegionId（可选）'),
          h('input', {
            className: 'glab-repo-input',
            placeholder: '留空使用 CLI 默认 Region',
            value: inputs.region,
            onChange: function (e) { setInputs(Object.assign({}, inputs, { region: e.target.value })) },
            onBlur: commitInputs,
            onKeyDown: function (e: { key: string; target: { blur(): void } }) { if (e.key === 'Enter') e.target.blur() },
          })
        ),
        h('div', { className: 'glab-field', style: { flex: 1, minWidth: 150 } },
          h('label', { className: 'glab-label' }, '租户 Tid（可选）'),
          h('input', {
            className: 'glab-repo-input',
            placeholder: '多租户账号填 DMS 租户 ID',
            value: inputs.tid,
            onChange: function (e) { setInputs(Object.assign({}, inputs, { tid: e.target.value })) },
            onBlur: commitInputs,
            onKeyDown: function (e: { key: string; target: { blur(): void } }) { if (e.key === 'Enter') e.target.blur() },
          })
        ),
        h('div', { className: 'glab-field', style: { flex: 1, minWidth: 200 } },
          h('label', { className: 'glab-label' }, '待审批的提交人（可选）'),
          h('input', {
            className: 'glab-repo-input', placeholder: '姓名用逗号分隔，留空显示全部',
            value: inputs.committers,
            onChange: function (e) { setInputs(Object.assign({}, inputs, { committers: e.target.value })) },
            onBlur: commitInputs,
            onKeyDown: function (e: { key: string; target: { blur(): void } }) { if (e.key === 'Enter') e.target.blur() },
          })
        )
      )
    )
  }

  function renderListBody() {
    const cli = status && status.cli ? status.cli as { error?: string | null } : null
    if (cli && cli.error) return h('div', { className: 'glab-error' }, cli.error)
    const payload = tab === 'mine' ? myOrders : orders
    const error = tab === 'mine' ? myError : listError
    if (error) return h('div', { className: 'glab-error' }, error)
    if (!payload) return h('div', { className: 'glab-list' },
      h('div', { className: 'glab-skel', style: { width: '94%' } }),
      h('div', { className: 'glab-skel', style: { width: '86%' } }),
      h('div', { className: 'glab-skel', style: { width: '90%' } })
    )
    const all = (payload.orders as DmsOrder[]) || []
    const list = tab === 'review' ? filterDmsOrders(all, query.committers) : all
    if (!list.length) {
      return h(EmptyState, {
        title: tab === 'review' ? '暂无待审批的工单' : tab === 'mine' ? '暂无我提交的工单' : '暂无工单',
        hint: tab === 'review' ? '进入页面时自动刷新 · 每 5 分钟后台刷新' : '每 5 分钟自动刷新',
      })
    }
    // 「我的」列表没有本地提交人筛选，总数与当前页直接可比；待审批的本地
    // 提交人过滤已经用完所有分页，不再提示截断。
    const truncated = (tab === 'mine' || !(tab === 'review' && query.committers)) && (payload.totalCount as number) > list.length
      ? h('div', { className: 'glab-mr-branches' }, '共 ' + payload.totalCount + ' 条工单，当前显示前 ' + list.length + ' 条')
      : null
    return h('div', { className: 'glab-list' },
      truncated,
      list.map(function (o) {
        return h(DmsRow, {
          key: o.orderId,
          order: o,
          busy: busy,
          readOnly: tab === 'mine',
          onOpen: openDetail,
          onAgree: askAgree,
          onReject: function (x) { setRejectNum(x.orderId); setRejectComment('') },
        })
      })
    )
  }

  function renderRejectBox() {
    if (rejectNum === null) return null
    return h('div', { className: 'glab-form wb-inset' },
      h('div', { className: 'glab-label' }, '拒绝工单 #' + rejectNum + '（备注必填，随审批记录留痕）'),
      h('textarea', {
        className: 'glab-input glab-textarea', value: rejectComment,
        onChange: function (e: React.ChangeEvent<HTMLTextAreaElement>) { setRejectComment(e.target.value) },
      }),
      h('div', { className: 'glab-row' },
        h('button', {
          className: 'glab-btn glab-btn-red', disabled: busy || !rejectComment.trim(),
          onClick: function () {
            act('/dms/order/approve', { id: rejectNum, action: 'REJECT', comment: rejectComment.trim() }, function () {
              setRejectNum(null)
              setRejectComment('')
            })
          },
        }, '确认拒绝'),
        h('button', { className: 'glab-btn', onClick: function () { setRejectNum(null) } }, '取消')
      )
    )
  }

  /** SQL 复制（按钮反馈到下一次打开详情或再次复制时重置）。 */
  function copyOrderSql(sql: string) {
    if (copyText(sql)) setSqlCopied(true)
  }

  /** 工单内容详情区：有 SQL 的类型渲染 SqlBlock（回滚 SQL 有则附加一块），
   *  申请类渲染申请内容卡（本身没有 SQL），导出/追踪/归档等渲染 facts 卡，
   *  ATTACHMENT 给附件提示行，其余类型说明暂不支持。加载失败不影响头部与
   *  审批表单。 */
  function renderOrderSql() {
    if (!detailSql) return null
    if (detailSql.loading) {
      return h('div', { className: 'wb-sls-sqlwrap' },
        h('div', { className: 'wb-sls-sqlhead' },
          h('span', { className: 'wb-sls-dhead' },
            detail && APPLY_ORDER_TYPES.indexOf(detail.order.pluginType) >= 0 ? '申请详情' : 'SQL 详情')),
        h('div', { className: 'glab-skel', style: { margin: '4px 8px 10px', width: '92%' } }),
        h('div', { className: 'glab-skel', style: { margin: '0 8px 10px', width: '86%' } })
      )
    }
    if (detailSql.error) {
      return h('div', { className: 'wb-meta' }, '详情加载失败：' + detailSql.error)
    }
    const d = detailSql.data
    if (!d) return null
    if (!d.supported) {
      return h('div', { className: 'wb-meta' },
        '该工单类型（' + (d.type || '未知') + '）暂不支持在线查看详情，请到 DMS 控制台查看')
    }
    if (d.apply) return renderApplyCard(d.apply)
    const facts = d.facts || []
    const title = 'SQL 脚本' +
      (typeof d.sqlCount === 'number' && d.sqlCount > 0 ? '（' + d.sqlCount + ' 条）' : '') +
      (d.truncated ? '（已截断）' : '')
    const blocks: React.ReactNode[] = []
    // ATTACHMENT：正文在附件里；此时 facts 仍会渲染，所以提示行单独占一块。
    if (!d.sql && d.attachmentName) {
      blocks.push(h('div', { className: 'wb-meta', key: 'att' },
        'SQL 在附件「' + d.attachmentName + '」中，请到 DMS 控制台下载查看'))
    }
    if (d.sql) blocks.push(h(SqlBlock, { key: 'sql', title: title, sql: d.sql, copied: sqlCopied, onCopy: function () { copyOrderSql(d.sql as string) } }))
    if (d.rollbackSql) blocks.push(h(SqlBlock, { key: 'rb', title: '回滚 SQL', sql: d.rollbackSql }))
    if (facts.length) blocks.push(renderKvCard('工单内容', facts.map(function (f, i) { return kvRow(f.k, f.v, 'f' + i) }), 'facts'))
    if (blocks.length) return h('div', { className: 'wb-dms-sqls' }, blocks)
    return h('div', { className: 'wb-meta' }, '无可执行 SQL')
  }

  /** 一行 k-v（值为空则不占位）；keyPrefix 只用于 React key 去重。 */
  function kvRow(k: string, v: React.ReactNode, keyPrefix: string): React.ReactNode {
    if (v === null || v === undefined || v === '') return null
    return h('div', { className: 'wb-dms-kv-row', key: keyPrefix + ':' + k },
      h('span', { className: 'wb-dms-kv-k' }, k),
      h('span', { className: 'wb-dms-kv-v' }, v)
    )
  }

  /** 通用内容卡：标题 + 若干 k-v 行（申请内容 / 工单内容共用）。 */
  function renderKvCard(title: string, rows: React.ReactNode[], keyPrefix: string): React.ReactNode {
    return h('div', { className: 'wb-sls-sqlwrap', key: keyPrefix },
      h('div', { className: 'wb-sls-sqlhead' }, h('span', { className: 'wb-sls-dhead' }, title)),
      h('div', { className: 'wb-dms-kv' }, rows)
    )
  }

  /** 权限申请 / Owner 申请的内容卡：申请类型 / 权限 / 有效期 / 资源清单。
   *  这两类工单没有 SQL，审批依据就是这些字段；host 已把码值翻成 label，
   *  缺字段（如 Owner 申请没有权限与有效期）整行不渲染。 */
  function renderApplyCard(a: DmsApplyDetail) {
    const items = (a.resources || []).map(function (r, i) {
      return h('div', { className: 'wb-dms-kv-item', key: 'r' + i },
        h('span', { className: 'wb-dms-kv-label' }, r.label),
        r.meta ? h('span', { className: 'wb-dms-kv-meta' }, r.meta) : null
      )
    })
    return renderKvCard('申请内容', [
      kvRow('申请类型', a.applyTypeLabel, 'a1'),
      kvRow('权限', a.permTypeLabel, 'a2'),
      kvRow('有效期', a.durationLabel, 'a3'),
      kvRow('资源（' + (a.resourceCount || items.length) + '）',
        items.length ? h('div', { className: 'wb-dms-kv-list' }, items) : '接口未返回资源明细', 'a4'),
    ], 'apply')
  }

  function renderDetailActions() {
    return h('div', { className: 'glab-row' },
      h('button', {
        className: 'glab-btn glab-btn-green', disabled: busy,
        onClick: function () { submitDetail('AGREE') },
      }, '同意'),
      h('button', {
        className: 'glab-btn glab-btn-red', disabled: busy || !detailComment.trim(),
        onClick: function () { submitDetail('REJECT') },
      }, '拒绝')
    )
  }

  function renderDetail() {
    if (!detail) return null
    if (detail.loading) return h('div', { className: 'glab-list' },
      h('div', { className: 'glab-skel', style: { width: '70%' } }),
      h('div', { className: 'glab-skel', style: { width: '95%' } }),
      h('div', { className: 'glab-skel', style: { width: '90%' } })
    )
    const o = detail.order
    const st = dmsStatusView(o)
    const pending = o.statusCode === 'toaudit' || o.statusCode === 'new'
    const canApprove = pending && !detail.readOnly
    const kv = function (k: string, v: React.ReactNode) {
      return h('div', { className: 'glab-kv' },
        h('span', { className: 'glab-kv-k' }, k),
        h('span', { className: 'glab-kv-v' }, v)
      )
    }
    return h('div', { className: 'glab-detail' },
      h('div', { className: 'glab-row' },
        h('button', { className: 'glab-btn', onClick: function () { setDetail(null) } }, '← 返回列表'),
        canApprove ? renderDetailActions() : null
      ),
      h('div', { className: 'glab-detail-head' },
        h('div', { className: 'glab-detail-title' },
          '#' + o.orderId + ' · 工单 ',
          h(Chip, { key: 'st', kind: st.kind }, st.label),
          h(Chip, { key: 't' }, o.pluginType || '工单')
        ),
        detail.error ? h('div', { className: 'glab-error' }, detail.error) : null,
        kv('提交人', o.committer || '?'),
        kv('创建时间', o.createTime || '?'),
        o.lastModifyTime ? kv('最近更新', o.lastModifyTime) : null,
        o.statusDesc ? kv('工单状态', o.statusDesc) : null,
        o.workflowStatusDesc ? kv('审批流状态', o.workflowStatusDesc) : null,
        o.workflowInstanceId ? kv('审批流 ID', String(o.workflowInstanceId)) : null,
        (o.relatedUsers || []).length ? kv('相关人', o.relatedUsers.join('、')) : null,
        o.attachmentName ? kv('附件', o.attachmentName) : null
      ),
      o.comment ? h('div', { className: 'glab-detail-desc' }, o.comment) : null,
      renderOrderSql(),
      canApprove ? h('div', { className: 'glab-form' },
        h('div', { className: 'glab-label' }, '审批备注（同意时可选，拒绝时必填）'),
        h('textarea', {
          className: 'glab-input glab-textarea', value: detailComment,
          onChange: function (e: React.ChangeEvent<HTMLTextAreaElement>) { setDetailComment(e.target.value) },
        }),
        renderDetailActions()
      ) : h('div', { className: 'wb-meta', style: { textAlign: 'center', padding: '18px 0' } },
        detail.readOnly ? '我提交的工单，仅供查看' : '当前无需审批')
    )
  }

  function renderBody() {
    return h('div', { className: 'glab-body', ref: scrollRef },
      detail ? renderDetail() : null,
      !detail && rejectNum !== null ? renderRejectBox() : null,
      !detail ? renderListBody() : null
    )
  }

  const updated = (tab === 'mine' ? myOrders : orders)?.updatedAt as number | undefined

  return h('div', { className: 'glab-panel' },
    renderToolbar(),
    renderSettings(),
    !detail ? h('div', { className: 'glab-tabs' },
      (['review', 'all', 'mine'] as const).map(function (value) {
        return h('button', {
          key: value, className: 'glab-tab' + (tab === value ? ' glab-tab-active' : ''),
          onClick: function () { setTab(value); setRejectNum(null) },
        }, value === 'review' ? '待审批' : value === 'all' ? '全部' : '我的')
      })
    ) : null,
    renderBody(),
    // Shared styled confirm dialog (同意) — same pattern as the forge page.
    confirmReq ? h(ConfirmDialog, Object.assign({}, confirmReq, {
      onOk: function () { setConfirmReq(null); confirmReq.onOk() },
      onCancel: function () { setConfirmReq(null) },
    })) : null
  )
}

/** DMS updatedAt is an epoch number; keep the toolbar hint compact. */
function fmtDmsUpdated(updated: number): string {
  const d = new Date(updated)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}
