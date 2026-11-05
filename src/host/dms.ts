// dsh-workbench — host DMS 工单 domain: drives the locally installed `aliyun`
// CLI (dms-enterprise product) over the same trust shape as the forge half —
// the CLI carries its own credentials (`aliyun configure`), this half never
// touches keys. Every request parameter is whitelisted into a fixed argv —
// nothing reaches a shell. API notes (dms-enterprise 2018-11-01):
//   ListOrders        OrderResultType ∈ AS_ADMIN|AS_COMMITTER(默认)|AS_HANDLER|AS_OWNER|AS_Related
//                     → Orders.Order[]: OrderId/PluginType/StatusCode/StatusDesc/Committer/CreateTime/…
//   GetOrderBaseInfo  OrderId → OrderBaseInfo(含 WorkflowInstanceId 审批流 ID)
//   ApproveOrder      WorkflowInstanceId(必填,取自 GetOrderBaseInfo) + ApprovalType(AGREE|REJECT|CANCEL|…)
//   GetStructSyncExecSqlDetail  OrderId → StructSyncExecSqlDetail{ExecSql,TotalSqlCount}
//                     （结构同步工单的执行 SQL；ExecSql 按语句分页，PageNumber/
//                     PageSize 翻到末页返回「没有可执行的脚本」占位行）
//   GetDataCorrectOrderDetail   OrderId → DataCorrectOrderDetail
//                     {OrderDetail{SqlType,ExeSQL,AttachmentName,RbSQL,RbSQLType},…}
//                     （数据变更同族 DC_* 的 SQL/回滚 SQL；ATTACHMENT 时正文在
//                     附件里。注意正文在 OrderDetail，不在 ConfigDetail）
//   GetDataExportOrderDetail    OrderId → DataExportOrderDetail
//                     {OrderDetail.ExeSQL, KeyInfo.JobStatus}（SQL 结果集导出）
//   GetDatabaseExportOrderDetail OrderId → DatabaseExportOrderDetail
//                     {SearchName, KeyInfo{Config{…},DownloadURL}}（数据库导出）
//   GetDataTrackOrderDetail     OrderId → DataTrackOrderDetail
//                     {DatabaseSearchName,TableNames,TrackTypes,JobStart/EndTime}
//   GetDataArchiveOrderDetail   OrderId → DataArchiveOrderDetail
//                     {PluginParam{TableIncludes,…},PluginExtraData}（归档表/条件）
//   GetPermApplyOrderDetail     OrderId → PermApplyOrderDetail
//                     {ApplyType,PermType,Seconds,Resources[]}
//                     （权限申请工单：库/表/列/实例/行权限，本身没有 SQL）
//   GetOwnerApplyOrderDetail    OrderId → OwnerApplyOrderDetail
//                     {ApplyType(INSTANCE|DB|TABLE),Resources[]}
//                     （库/表/实例 Owner 申请工单，同样没有 SQL）
//   ListDDLPublishRecords       OrderId → DDLPublishRecordList[]
//                     {RiskLevel,PublishStrategy,PublishTaskInfoList[]
//                      →PublishJobList[]{TableName,Scripts}}
//                     （结构设计 NDDL 工单的发布记录，DDL 脚本在 Scripts）
// The CLI prints SDK errors on STDOUT with exit code 1, so error text is
// assembled from both streams before classification.
// Route wiring (with per-route caches and TTL checks) lives in index.ts's
// apply().

import type { HostContext, Runner } from './runner'
import { aliyunOAuthReauthHint, classifyError, exeAvailable } from './runner'

const DMS_EXE = 'aliyun'
const DMS_RESULT_TYPES = ['AS_ADMIN', 'AS_COMMITTER', 'AS_HANDLER', 'AS_OWNER', 'AS_Related']
const DMS_ORDER_STATUS = ['ALL', 'FINISHED', 'RUNNING']
const DMS_APPROVAL_ACTIONS = ['AGREE', 'REJECT', 'CANCEL']

function dmsApiError(raw: unknown): string {
  const o = (raw || {}) as Record<string, unknown>
  const msg = String(o.ErrorMessage || '').trim()
  const code = String(o.ErrorCode || '').trim()
  return (msg || code || 'DMS 接口返回失败') + (code && msg ? '（' + code + '）' : '')
}

/** RegionId: letters/digits/hyphen; empty → let the CLI profile decide. */
function dmsRegion(v: unknown): string | null {
  const s = String(v || '').trim()
  if (!s) return null
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,31}$/.test(s)) throw new Error('无效的 RegionId：' + s.slice(0, 40))
  return s
}

/** Optional numeric tenant id. */
function dmsTid(v: unknown): string | null {
  const s = String(v || '').trim()
  if (!s) return null
  if (!/^\d{1,19}$/.test(s)) throw new Error('无效的租户 Tid：' + s.slice(0, 40))
  return s
}

/** Required numeric id (OrderId / WorkflowInstanceId). */
function dmsLongId(v: unknown, what: string): string {
  const s = String(v || '').trim()
  if (!/^\d{1,19}$/.test(s)) throw new Error('缺少有效的' + what)
  return s
}

function dmsPage(v: unknown, def: number, hi: number): number {
  const s = String(v || '').trim()
  if (!/^\d{1,5}$/.test(s)) return def
  return Math.min(Math.max(Number(s), 1), hi)
}

/** dms-enterprise argv prefix: product + optional RegionId / Tid. */
function dmsArgvPrefix(region: string | null, tid: string | null): string[] {
  const argv = ['dms-enterprise']
  if (region) argv.push('--RegionId', region)
  if (tid) argv.push('--Tid', tid)
  return argv
}

/** Run the aliyun CLI without throwing through `run` (whose stderr-only error
 *  text would miss stdout SDK errors). */
async function dmsRun(runner: Runner, argv: string[]): Promise<string> {
  const r = await runner.tryRun(DMS_EXE, argv, { graceMs: 30000 })
  if (r.code !== 0) {
    const text = (String(r.errText || '').trim() + '\n' + String(r.out || '').trim()).trim()
    const e = new Error(text || DMS_EXE + ' 退出码 ' + String(r.code))
    throw e
  }
  return String(r.out || '')
}

/** Parse CLI stdout as JSON, tolerating any leading noise. */
function dmsJson(out: string): Record<string, unknown> {
  const text = String(out || '')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('aliyun CLI 输出不是 JSON：' + text.slice(0, 120))
  return JSON.parse(text.slice(start)) as Record<string, unknown>
}

export function classifyDmsError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err)
  const low = text.toLowerCase()
  if (/command not found|enoent|no such file|not recognized/.test(low)) {
    return '未检测到 aliyun CLI（brew install aliyun-cli）'
  }
  // OAuth 刷新令牌过期（invalid_grant / Refresh token expired）：重登即可，
  // 不是 AccessKey 配置问题，提示要区别于「无有效登录凭证」。
  const oauth = aliyunOAuthReauthHint(text)
  if (oauth) return oauth
  if (/invalidaccesskey|signaturedoesnotmatch|unable to get credentials|no valid credential|not configured|credential/.test(low)) {
    return 'aliyun CLI 无有效登录凭证：请运行 `aliyun configure configure`（浏览器登录）或 `aliyun configure set` 配置 AccessKey'
  }
  const m = text.match(/Message:\s*(.+)/) // `ERROR: SDK.ServerError … Message: …`
  if (m) return String(m[1]).trim() + '（aliyun CLI）'
  return classifyError(err)
}

/** Normalize one Order (ListOrders) / OrderBaseInfo (GetOrderBaseInfo) into
 *  the compact view both the list rows and the detail view render. */
function toDmsOrderView(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const orderId = obj.OrderId != null ? String(obj.OrderId) : ''
  if (!orderId) return null
  const nicks = obj.RelatedUserNickList && Array.isArray((obj.RelatedUserNickList as { UserNicks?: unknown }).UserNicks)
    ? (obj.RelatedUserNickList as { UserNicks: unknown[] }).UserNicks : []
  return {
    orderId,
    pluginType: String(obj.PluginType || ''),
    statusCode: String(obj.StatusCode || '').toLowerCase(),
    statusDesc: String(obj.StatusDesc || ''),
    workflowStatusDesc: String(obj.WorkflowStatusDesc || ''),
    workflowInstanceId: obj.WorkflowInstanceId != null ? String(obj.WorkflowInstanceId) : null,
    committer: String(obj.Committer || ''),
    createTime: String(obj.CreateTime || ''),
    lastModifyTime: String(obj.LastModifyTime || ''),
    comment: String(obj.Comment || ''),
    relatedUsers: nicks.map((n) => String(n)).filter(Boolean).slice(0, 10),
    attachmentName: String(obj.OriginAttachmentName || '') || null,
  }
}

export interface DmsStatusPayload {
  ok: boolean
  updatedAt: number
  cli: {
    available: boolean
    configured: boolean
    activeRegion: string | null
    profiles: Array<Record<string, unknown>>
    error: string | null
  }
}

/** `aliyun configure list` → valid profile? active region? Table rows look
 *  like `OAuthProfile * | OAuth:… | Valid | cn-hangzhou | zh`. */
export async function loadDmsStatus(ctx: HostContext, runner: Runner): Promise<DmsStatusPayload> {
  const available = await exeAvailable(runner, DMS_EXE)
  const data: DmsStatusPayload = {
    ok: true,
    updatedAt: Date.now(),
    cli: { available, configured: false, activeRegion: null, profiles: [], error: null },
  }
  if (!available) {
    data.cli.error = '未检测到 aliyun 命令行工具（brew install aliyun-cli）'
    return data
  }
  const r = await runner.tryRun(DMS_EXE, ['configure', 'list'], { graceMs: 15000 })
  const text = String(r.out || '') + '\n' + String(r.errText || '')
  const rows: Array<Record<string, unknown>> = []
  for (const line of text.split('\n')) {
    const cols = line.split('|').map((c) => c.trim())
    if (cols.length < 4 || !cols[0]) continue
    if (/^profile$/i.test(cols[0]) || /^-+$/.test(cols[0].replace(/\s/g, ''))) continue
    rows.push({
      name: cols[0].replace(/\*+\s*$/, '').trim(),
      active: cols[0].includes('*'),
      valid: /^valid$/i.test(cols[2]),
      region: cols[3] || null,
    })
  }
  data.cli.profiles = rows.filter((x) => x.name).slice(0, 12)
  const active = rows.find((x) => x.active === true)
  const anyValid = rows.some((x) => x.valid === true)
  data.cli.configured = anyValid
  if (active && active.valid === true) data.cli.activeRegion = String(active.region || '') || null
  if (!anyValid) {
    data.cli.error = 'aliyun CLI 没有有效的登录凭证：请运行 `aliyun configure configure`（浏览器登录）或 `aliyun configure set` 配置 AccessKey'
  }
  return data
}

export interface DmsQuery {
  resultType?: string
  page?: string
  pageSize?: string
  region?: string
  tid?: string
  orderStatus?: string
  search?: string
  id?: string
}

export async function loadDmsOrders(ctx: HostContext, runner: Runner, q: DmsQuery): Promise<Record<string, unknown>> {
  const resultType = DMS_RESULT_TYPES.includes(String(q.resultType || '')) ? String(q.resultType) : 'AS_HANDLER'
  const page = dmsPage(q.page, 1, 10000)
  const pageSize = dmsPage(q.pageSize, 20, 100)
  const region = dmsRegion(q.region)
  const tid = dmsTid(q.tid)
  const orderStatus = DMS_ORDER_STATUS.includes(String(q.orderStatus || '')) ? String(q.orderStatus) : null
  const search = String(q.search || '').trim().slice(0, 100)
  const argv = dmsArgvPrefix(region, tid).concat([
    'ListOrders',
    '--OrderResultType', resultType,
    '--PageNumber', String(page),
    '--PageSize', String(pageSize),
  ])
  if (orderStatus) argv.push('--OrderStatus', orderStatus)
  if (search) argv.push('--SearchContent', search)
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const list = raw.Orders && Array.isArray((raw.Orders as { Order?: unknown }).Order) ? (raw.Orders as { Order: unknown[] }).Order : []
  return {
    orders: list.map(toDmsOrderView).filter((v): v is Record<string, unknown> => v !== null),
    totalCount: Number(raw.TotalCount || 0) || 0,
    page,
    pageSize,
    resultType,
  }
}

export async function loadDmsOrder(ctx: HostContext, runner: Runner, q: DmsQuery): Promise<Record<string, unknown>> {
  const id = dmsLongId(q.id, '工单 ID（id）')
  const region = dmsRegion(q.region)
  const tid = dmsTid(q.tid)
  const argv = dmsArgvPrefix(region, tid).concat(['GetOrderBaseInfo', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const view = toDmsOrderView(raw.OrderBaseInfo)
  if (!view) throw new Error('工单 ' + id + ' 查询失败：接口未返回工单信息')
  return view
}

/** 审批工单：ApproveOrder 审批的是「审批流」，WorkflowInstanceId 必填 —— 客户端
 * 未携带时宿主先查 GetOrderBaseInfo 解析。 */
export async function handleDmsApprove(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = dmsLongId(body.id, '工单 ID（id）')
  const action = DMS_APPROVAL_ACTIONS.includes(String(body.action || '')) ? String(body.action) : null
  if (!action) throw new Error('无效的审批动作 action（AGREE / REJECT / CANCEL）')
  const region = dmsRegion(body.region)
  const tid = dmsTid(body.tid)
  const comment = String(body.comment || '').trim().slice(0, 500)
  const widRaw = String(body.workflowInstanceId || '').trim()
  let wid = /^\d{1,19}$/.test(widRaw) ? widRaw : null
  if (!wid) {
    const base = await loadDmsOrder(ctx, runner, { id, region: region || '', tid: tid || '' })
    wid = String(base.workflowInstanceId || '') || null
  }
  if (!wid) throw new Error('无法解析工单 ' + id + ' 的审批流 ID（WorkflowInstanceId），无法审批')
  const argv = dmsArgvPrefix(region, tid).concat([
    'ApproveOrder',
    '--WorkflowInstanceId', wid,
    '--ApprovalType', action,
  ])
  if (comment) argv.push('--Comment', comment)
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  return { ok: true, orderId: id, action, workflowInstanceId: wid }
}

// ── 工单内容详情（审批前看一眼：SQL 脚本 / 申请内容 / 工单配置）─────────────
// 每族工单的正文藏在不同的 API 里，宿主按 PluginType 路由：
//   TABLE_SYNC  结构同步 → GetStructSyncExecSqlDetail。ExecSql 按语句分页
//               （实测：--PageNumber 2 --PageSize 1 在只有 1 条语句的工单上
//               返回「没有可执行的脚本」占位行），TotalSqlCount 是语句总数，
//               宿主按固定 PageSize 顺序翻页拼接，翻完 total 条或遇空页即停。
//   DC_*        数据变更同族（普通/无锁/清理/导入/可编程对象）→
//               GetDataCorrectOrderDetail。**正文在 OrderDetail**（实测：
//               ConfigDetail 只放调度与导入子类型配置，ExeSQL 不在那里）：
//               SqlType=TEXT 时 ExeSQL 是正文；ATTACHMENT 时正文在附件
//               （AttachmentName）里，只能提示去 DMS 控制台下载；RbSQL 是回滚
//               SQL（'empty'/ATTACHMENT 表示未提供）。
//   DATA_EXPORT SQL 结果集导出 → GetDataExportOrderDetail.OrderDetail.ExeSQL。
//   DB_EXPORT   数据库导出 → GetDatabaseExportOrderDetail（表/格式/下载地址，
//               没有 SQL）。
//   DATA_TRACK  数据追踪 → GetDataTrackOrderDetail（库表 + 追踪类型 + 时间
//               区间，没有 SQL）。
//   DATA_ARCHIVE 数据归档 → GetDataArchiveOrderDetail（归档表与过滤条件在
//               PluginParam，没有 SQL）。
//   PERM_APPLY / OWNER_APPLY 权限与 Owner 申请 → GetPermApplyOrderDetail /
//               GetOwnerApplyOrderDetail。这两类工单**本身没有 SQL**（审批的
//               是「给谁开哪个库/表/列/实例的什么权限、开多久」），所以宿主回
//               申请内容（资源清单 + 权限 + 有效期），客户端渲染成申请卡。
//   NDDL        结构设计 → ListDDLPublishRecords。没有独立的 SQL 详情接口，
//               正文在发布记录的 PublishTaskInfoList[].PublishJobList[]
//               .Scripts（每个表一段 DDL）；多条记录的脚本按序拼接、表名去重。
// 没有 SQL 的类型统一把关键信息归一化成 facts（k-v 行），由客户端渲染成
// 「工单内容」卡；其余未覆盖类型（GENERATE 等）不发起 CLI 调用，返回
// supported:false，由客户端展示「该工单类型暂不支持在线查看详情」。

const SQL_SYNC_TYPE = 'TABLE_SYNC'
/** 数据变更同族：PluginType 随子类型不同（DATA_CHANGE 是 ListOrders 的筛选
 *  别名，其余是真实工单类型），详情都走 GetDataCorrectOrderDetail。 */
const DATA_CHANGE_TYPES = new Set(['DATA_CHANGE', 'DC_COMMON', 'DC_CHUNK', 'DC_CRON_CLEAR', 'DC_BIG_FILE', 'DC_PROC'])
/** SQL 结果集导出（SQL_EXPORT 是历史别名）。 */
const DATA_EXPORT_TYPES = new Set(['DATA_EXPORT', 'SQL_EXPORT'])
const DB_EXPORT_TYPE = 'DB_EXPORT'
const DATA_TRACK_TYPE = 'DATA_TRACK'
const DATA_ARCHIVE_TYPE = 'DATA_ARCHIVE'
const NDDL_TYPE = 'NDDL'
/** 结构同步翻页：单页语句数 + 页数上限（500 条语句封顶，防超大工单打爆 CLI）。 */
const SQL_SYNC_PAGE_SIZE = 50
const SQL_SYNC_MAX_PAGES = 10
const SQL_SYNC_EMPTY_MARK = '没有可执行的脚本'

// ── 权限申请 / Owner 申请（没有 SQL，看申请内容）────────────────────────────
// 两个接口都只回 pluginExtraData，宿主在这里把码值翻译成人话（同
// toDmsOrderView 的分工：客户端只渲染，语义留宿主），客户端不认英文码。
const PERM_APPLY_TYPE = 'PERM_APPLY'
const OWNER_APPLY_TYPE = 'OWNER_APPLY'
/** 权限申请粒度（ApplyType）：库/表/列/实例/行。 */
const PERM_APPLY_TYPE_LABELS: Record<string, string> = {
  INSTANT: '实例权限', INSTANCE: '实例权限', DB: '库权限', TAB: '表权限', COL: '列权限', ROW: '行权限',
}
/** Owner 申请粒度（同字段不同取值域）。 */
const OWNER_APPLY_TYPE_LABELS: Record<string, string> = {
  INSTANCE: '实例 Owner', DB: '库 Owner', TABLE: '表 Owner',
}
/** PermType 码值 → 权限名（DMS 文档：1 查询 … 8 登录）。 */
const PERM_TYPE_LABELS: Record<string, string> = {
  '1': '查询', '2': '导出', '3': '查询和导出', '4': '变更',
  '5': '查询和变更', '6': '导出和变更', '7': '查询、导出和变更', '8': '登录',
}
const ENV_TYPE_LABELS: Record<string, string> = { product: '生产', pre: '预发', test: '测试', dev: '开发' }
/** 数据变更子类型（ConfigDetail.DetailType）。 */
const CHANGE_DETAIL_TYPE_LABELS: Record<string, string> = {
  COMMON: '普通数据变更', CHUNK_DML: '无锁变更', BIG_FILE: '批量数据导入',
  CRON_CLEAR_DATA: '历史数据清理', PROCEDURE: '可编程对象变更',
}
/** 结构设计发布记录的风险等级（RiskLevel）。 */
const NDDL_RISK_LEVEL_LABELS: Record<string, string> = {
  NONE_RISK: '无风险', LOW_RISK: '低风险', MIDDLE_RISK: '中风险', HIGH_RISK: '高风险',
}
/** 结构设计发布策略（PublishStrategy）。 */
const NDDL_PUBLISH_STRATEGY_LABELS: Record<string, string> = {
  IMMEDIATELY: '立即执行', REGULARLY: '定时执行',
}
/** SQL 结果集导出任务状态（KeyInfo.JobStatus）。 */
const EXPORT_JOB_STATUS_LABELS: Record<string, string> = {
  PRE_CHECKING: '预校验中', PRE_CHECK_SUCCESS: '预校验通过', PRE_CHECK_FAIL: '预校验失败',
  WAITING_APPLY_AUDIT: '等待提交审批', APPLY_AUDIT_SUCCESS: '已提交审批', ENABLE_EXPORT: '允许导出',
  WAITING_EXPORT: '等待调度', DOING_EXPORT: '导出中', EXPORT_FAIL: '导出失败', EXPORT_SUCCESS: '导出成功',
}
/** 数据追踪任务状态（JobStatus）。 */
const TRACK_JOB_STATUS_LABELS: Record<string, string> = {
  INIT: '初始化', LISTING: '获取 Binlog 列表', LIST_SUCCESS: 'Binlog 列表完成',
  DOWNLOADING: '下载 Binlog 中', DOWNLOAD_FAIL: '下载 Binlog 失败', DOWNLOAD_SUCCESS: '下载 Binlog 完成',
  FILTERING: '解析 Binlog 中', FILTER_FAIL: '解析 Binlog 失败', FILTER_SUCCESS: '解析 Binlog 完成',
}
/** 数据追踪类型（TrackTypes，实测取值形如 UPDATE）。 */
const TRACK_TYPE_LABELS: Record<string, string> = { INSERT: '插入', UPDATE: '更新', DELETE: '删除', DDL: '结构变更' }
/** 数据库导出的导出内容（KeyInfo.Config.ExportContent）。 */
const EXPORT_CONTENT_LABELS: Record<string, string> = { DATA: '数据', STRUCT: '结构', DATA_STRUCT: '数据和结构' }

export interface DmsOrderSqlQuery {
  id?: string
  region?: string
  tid?: string
  type?: string
}

/** 工单内容详情路由的统一 payload：supported=false 时客户端展示类型提示；
 *  struct 同步带 sqlCount/truncated，数据变更带 rollbackSql/attachmentName，
 *  申请类带 apply（没有 SQL），其余按类型带 facts（k-v 行）。 */
export async function loadDmsOrderSql(ctx: HostContext, runner: Runner, q: DmsOrderSqlQuery): Promise<Record<string, unknown>> {
  const id = dmsLongId(q.id, '工单 ID（id）')
  const region = dmsRegion(q.region)
  const tid = dmsTid(q.tid)
  const type = String(q.type || '').trim().toUpperCase()
  if (type === SQL_SYNC_TYPE) return structSyncSql(runner, id, region, tid)
  if (DATA_CHANGE_TYPES.has(type)) return dataChangeDetail(runner, id, region, tid, type)
  if (DATA_EXPORT_TYPES.has(type)) return dataExportDetail(runner, id, region, tid, type)
  if (type === DB_EXPORT_TYPE) return dbExportDetail(runner, id, region, tid)
  if (type === DATA_TRACK_TYPE) return dataTrackDetail(runner, id, region, tid)
  if (type === DATA_ARCHIVE_TYPE) return dataArchiveDetail(runner, id, region, tid)
  if (type === PERM_APPLY_TYPE) return permApplyDetail(runner, id, region, tid)
  if (type === OWNER_APPLY_TYPE) return ownerApplyDetail(runner, id, region, tid)
  if (type === NDDL_TYPE) return nddlDetail(runner, id, region, tid)
  return { ok: true, supported: false, type: type || null, sql: null }
}

/** TABLE_SYNC：GetStructSyncExecSqlDetail 按 PageSize 顺序翻页拼接 ExecSql。
 *  停止条件：拼满 TotalSqlCount、当前页是空占位行、或达到页数上限（上限停下
 *  时带 truncated 标记，客户端提示已截断）。 */
async function structSyncSql(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const chunks: string[] = []
  let total = 0
  let truncated = false
  for (let page = 1; page <= SQL_SYNC_MAX_PAGES; page++) {
    const argv = dmsArgvPrefix(region, tid).concat([
      'GetStructSyncExecSqlDetail',
      '--OrderId', id,
      '--PageNumber', String(page),
      '--PageSize', String(SQL_SYNC_PAGE_SIZE),
    ])
    const raw = dmsJson(await dmsRun(runner, argv))
    if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
    const detail = (raw.StructSyncExecSqlDetail || {}) as Record<string, unknown>
    total = Number(detail.TotalSqlCount || 0) || total
    const sql = String(detail.ExecSql || '')
    if (!sql.trim() || sql.includes(SQL_SYNC_EMPTY_MARK)) break
    chunks.push(sql)
    if (chunks.length * SQL_SYNC_PAGE_SIZE >= total) break
    if (page === SQL_SYNC_MAX_PAGES) truncated = true
  }
  return {
    ok: true,
    supported: true,
    type: SQL_SYNC_TYPE,
    sql: chunks.join('\n').trim() || null,
    sqlCount: total,
    truncated,
  }
}

/** 数据变更同族：GetDataCorrectOrderDetail → OrderDetail 的 SQL/回滚 SQL（实测
 *  正文在 OrderDetail，ConfigDetail 只有 DetailType 等子类型配置），外加
 *  DatabaseList / 影响行数 facts。 */
async function dataChangeDetail(runner: Runner, id: string, region: string | null, tid: string | null, type: string): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetDataCorrectOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.DataCorrectOrderDetail)
  const cfg = dmsObj(detail.ConfigDetail)
  const od = dmsObj(detail.OrderDetail)
  const sqlType = dmsStr(od.SqlType).toUpperCase()
  const rbType = dmsStr(od.RbSQLType).toUpperCase()
  const rb = dmsStr(od.RbSQL)
  const facts: DmsFact[] = []
  const detailType = dmsStr(cfg.DetailType).toUpperCase()
  pushFact(facts, '变更类型', CHANGE_DETAIL_TYPE_LABELS[detailType] || '数据变更')
  const dbs = dmsArray(dmsObj(detail.DatabaseList).Database).map(dmsDatabaseLabel).filter((x): x is string => x !== null)
  if (dbs.length) pushFact(facts, '数据库', dbs.join('、'))
  pushFact(facts, '影响行数', dmsAffectRows(od))
  // CRON_CLEAR_DATA：定时清理才有 Cron 表达式与调度次数。
  pushFact(facts, '调度', cfg.Cron === true ? dmsStr(cfg.CronFormat) : '')
  return {
    ok: true,
    supported: true,
    type,
    // ATTACHMENT：SQL 正文在附件里，API 不返回文本。
    sql: sqlType === 'ATTACHMENT' ? null : (dmsStr(od.ExeSQL) || null),
    rollbackSql: rbType === 'ATTACHMENT' || !rb || rb.toLowerCase() === 'empty' ? null : rb,
    attachmentName: sqlType === 'ATTACHMENT' ? (dmsStr(od.AttachmentName) || null) : null,
    facts,
  }
}

/** SQL 结果集导出：GetDataExportOrderDetail → OrderDetail.ExeSQL 就是导出语句。 */
async function dataExportDetail(runner: Runner, id: string, region: string | null, tid: string | null, type: string): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetDataExportOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.DataExportOrderDetail)
  const od = dmsObj(detail.OrderDetail)
  const key = dmsObj(detail.KeyInfo)
  const facts: DmsFact[] = []
  const env = dmsStr(od.EnvType)
  const db = dmsStr(od.Database)
  pushFact(facts, '数据库', db ? db + (env ? '（' + (ENV_TYPE_LABELS[env.toLowerCase()] || env) + '）' : '') : '')
  if (od.Logic === true) pushFact(facts, '库类型', '逻辑库')
  pushFact(facts, '导出原因', od.Classify)
  pushFact(facts, '影响行数', od.ActualAffectRows != null ? dmsStr(od.ActualAffectRows) + ' 行' : '')
  const job = dmsStr(key.JobStatus).toUpperCase()
  pushFact(facts, '导出状态', job ? (EXPORT_JOB_STATUS_LABELS[job] || job) : '')
  return { ok: true, supported: true, type, sql: dmsStr(od.ExeSQL) || null, facts }
}

/** 数据库导出：GetDatabaseExportOrderDetail（KeyInfo.Config 是导出配置，没有 SQL）。 */
async function dbExportDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetDatabaseExportOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.DatabaseExportOrderDetail)
  const key = dmsObj(detail.KeyInfo)
  const cfg = dmsObj(key.Config)
  const facts: DmsFact[] = []
  pushFact(facts, '数据库', dmsStr(detail.SearchName) || dmsStr(cfg.DbName))
  const content = dmsStr(cfg.ExportContent).toUpperCase()
  pushFact(facts, '导出内容', content ? (EXPORT_CONTENT_LABELS[content] || content) : '')
  pushFact(facts, '导出格式', cfg.TargetOption)
  pushFact(facts, '导出类型', cfg.ExportTypes)
  pushFact(facts, '表', cfg.SelectedTables)
  pushFact(facts, '下载地址', key.DownloadURL)
  return { ok: true, supported: true, type: DB_EXPORT_TYPE, sql: null, facts }
}

/** 数据追踪：GetDataTrackOrderDetail（按 binlog 追踪库表变更，没有 SQL）。 */
async function dataTrackDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetDataTrackOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.DataTrackOrderDetail)
  const facts: DmsFact[] = []
  pushFact(facts, '数据库', dmsStr(detail.DatabaseSearchName) || dmsStr(detail.SchemaName))
  if (detail.Logic === true) pushFact(facts, '库类型', '逻辑库')
  pushFact(facts, '追踪表', detail.TableNames)
  const types = dmsArray(detail.TrackTypes)
  if (types.length) pushFact(facts, '追踪类型', types.map((t) => TRACK_TYPE_LABELS[dmsStr(t).toUpperCase()] || dmsStr(t)).join('、'))
  const from = dmsStr(detail.JobStartTime)
  const to = dmsStr(detail.JobEndTime)
  if (from || to) pushFact(facts, '追踪区间', (from || '?') + ' ~ ' + (to || '?'))
  const job = dmsStr(detail.JobStatus).toUpperCase()
  pushFact(facts, '任务状态', job ? (TRACK_JOB_STATUS_LABELS[job] || job) : dmsStr(detail.StatusDesc))
  return { ok: true, supported: true, type: DATA_TRACK_TYPE, sql: null, facts }
}

/** 数据归档：GetDataArchiveOrderDetail（归档表与过滤条件在 PluginParam，
 *  执行明细在 PluginExtraData，都没有 SQL 正文）。 */
async function dataArchiveDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetDataArchiveOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.DataArchiveOrderDetail)
  const param = typeof detail.PluginParam === 'string' ? dmsJson(detail.PluginParam) : dmsObj(detail.PluginParam)
  const extra = dmsObj(detail.PluginExtraData)
  const facts: DmsFact[] = []
  pushFact(facts, '归档方式', param.ArchiveMethod)
  pushFact(facts, '运行方式', param.RunMethod)
  pushFact(facts, '源库', param.DbSchema)
  if (param.Logic === true) pushFact(facts, '库类型', '逻辑库')
  pushFact(facts, '目标实例', param.TargetInstanceId)
  const tables = dmsArray(param.TableIncludes).map((t) => {
    const row = dmsObj(t)
    const name = dmsStr(row.TableName)
    if (!name) return ''
    const where = dmsStr(row.TableWhere)
    return where ? name + '（' + where + '）' : name
  }).filter(Boolean)
  if (tables.length) pushFact(facts, '归档表', tables.join('、'))
  pushFact(facts, '后置行为', param.OrderAfter)
  pushFact(facts, '归档任务数', extra.InstanceTotal != null ? dmsStr(extra.InstanceTotal) : '')
  return { ok: true, supported: true, type: DATA_ARCHIVE_TYPE, sql: null, facts }
}

/** NDDL 结构设计：ListDDLPublishRecords → 发布记录里每个表的 DDL 脚本
 *  （PublishJobList.Scripts，结构设计没有独立的 SQL 详情接口）。多条记录的
 *  脚本按序拼接、表名去重；风险等级 / 发布策略取首条非空码值翻成 label。 */
async function nddlDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['ListDDLPublishRecords', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const scripts: string[] = []
  const tables: string[] = []
  let risk = ''
  let strategy = ''
  for (const rec of dmsArray(raw.DDLPublishRecordList)) {
    const ro = dmsObj(rec)
    const riskCode = dmsStr(ro.RiskLevel).toUpperCase()
    if (!risk && riskCode) risk = NDDL_RISK_LEVEL_LABELS[riskCode] || riskCode
    for (const task of dmsArray(ro.PublishTaskInfoList)) {
      const to = dmsObj(task)
      // PublishStrategy 挂在发布任务（库）上而不是发布记录上（实测）。
      const stratCode = dmsStr(to.PublishStrategy).toUpperCase()
      if (!strategy && stratCode) strategy = NDDL_PUBLISH_STRATEGY_LABELS[stratCode] || stratCode
      for (const job of dmsArray(to.PublishJobList)) {
        const j = dmsObj(job)
        const sql = dmsStr(j.Scripts)
        if (sql) scripts.push(sql)
        const table = dmsStr(j.TableName)
        if (table && !tables.includes(table)) tables.push(table)
      }
    }
  }
  const facts: DmsFact[] = []
  pushFact(facts, '变更表', tables.join('、'))
  pushFact(facts, '风险等级', risk)
  pushFact(facts, '发布策略', strategy)
  return { ok: true, supported: true, type: NDDL_TYPE, sql: scripts.join('\n\n') || null, facts }
}

// ── 权限申请 / Owner 申请：资源清单归一化 ───────────────────────────────────

function dmsObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function dmsStr(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

/** 一个「工单内容」的 k-v 行（客户端只渲染，不认码值）。 */
interface DmsFact {
  k: string
  v: string
}

/** pushFact：值为空（空串/空数组）时整行不落，避免客户端出现空值占位。
 *  数组按「、」拼接（表名列表 / 导出类型等）。 */
function pushFact(facts: DmsFact[], k: string, v: unknown): void {
  const s = Array.isArray(v) ? v.map(dmsStr).filter(Boolean).join('、') : dmsStr(v)
  if (s) facts.push({ k, v: s })
}

/** 任意值 → 数组（API 的数组字段缺失时返回空数组）。 */
function dmsArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : []
}

/** DatabaseList.Database[] 的一条 → 「库搜索名（库类型 · 环境 · 逻辑库）」。 */
function dmsDatabaseLabel(v: unknown): string | null {
  const d = dmsObj(v)
  const scope = dmsStr(d.SearchName) || dmsStr(d.DbId)
  if (!scope) return null
  const meta = dmsResourceMeta(d, d, d.Logic === true)
  return meta ? scope + '（' + meta + '）' : scope
}

/** 影响行数：预估与实际（实际为 0 时通常是还没执行，不占位）。 */
function dmsAffectRows(od: Record<string, unknown>): string {
  const parts: string[] = []
  if (od.EstimateAffectRows != null && Number.isFinite(Number(od.EstimateAffectRows))) {
    parts.push('预估 ' + dmsStr(od.EstimateAffectRows) + ' 行')
  }
  if (od.ActualAffectRows != null && Number(od.ActualAffectRows) > 0) {
    parts.push('实际 ' + dmsStr(od.ActualAffectRows) + ' 行')
  }
  return parts.join('，')
}

/** 资源行的补充信息：库类型 + 环境（+ 逻辑库）；都没有返回 null，客户端不占位。 */
function dmsResourceMeta(db: Record<string, unknown>, inst: Record<string, unknown>, logic: boolean): string | null {
  const dbType = dmsStr(db.DbType) || dmsStr(inst.DbType)
  const env = (dmsStr(db.EnvType) || dmsStr(inst.EnvType)).toLowerCase()
  const parts = [dbType ? dbType.toUpperCase() : '', env ? (ENV_TYPE_LABELS[env] || env) : '']
  if (logic) parts.push('逻辑库')
  return parts.filter(Boolean).join(' · ') || null
}

/** 资源定位串：库/实例 → 表[.列]；库名里已含表名时不重复拼接。 */
function dmsResourcePath(scope: string, table: string, column: string): string {
  if (!table) return scope
  const leaf = column ? table + '.' + column : table
  if (!scope) return leaf
  return scope.includes(table) ? scope : scope + ' · ' + leaf
}

/** 权限申请的一条资源：实例/库/表/列/行都能落成一个定位串。 */
function permApplyResource(v: unknown): Record<string, unknown> | null {
  const r = dmsObj(v)
  const db = dmsObj(r.DatabaseInfo)
  const inst = dmsObj(r.InstanceInfo)
  const tab = dmsObj(r.TableInfo)
  const col = dmsObj(r.ColumnInfo)
  const row = dmsObj(r.RowInfo)
  const host = dmsStr(inst.Host) ? dmsStr(inst.Host) + (dmsStr(inst.Port) ? ':' + dmsStr(inst.Port) : '') : ''
  const scope = dmsStr(db.SearchName) || dmsStr(inst.SearchName) || host || dmsStr(inst.InstanceId) || dmsStr(row.SchemaName)
  const table = dmsStr(col.TableName) || dmsStr(tab.TableName) || dmsStr(row.TableName)
  const column = dmsStr(col.ColumnName) || dmsStr(row.ColumnName)
  let label = dmsResourcePath(scope, table, column)
  const rowValue = dmsStr(dmsObj(r.RowValueInfo).RowValue)
  if (rowValue) label += ' ' + (dmsStr(row.MatchMode).toUpperCase() === 'LIKE' ? 'like' : '=') + ' ' + rowValue
  if (!label) return null
  return { label, meta: dmsResourceMeta(db, inst, db.Logic === true || row.Logic === true) }
}

/** Owner 申请的一条资源：ResourceDetail + 该行的 Logic 标记。 */
function ownerApplyResource(v: unknown): Record<string, unknown> | null {
  const r = dmsObj(v)
  const d = dmsObj(r.ResourceDetail)
  const host = dmsStr(d.Host) ? dmsStr(d.Host) + (dmsStr(d.Port) ? ':' + dmsStr(d.Port) : '') : ''
  const scope = dmsStr(d.SearchName) || host || dmsStr(d.InstanceId)
  const label = dmsResourcePath(scope, dmsStr(d.TableName), '') || (dmsStr(r.TargetId) ? '#' + dmsStr(r.TargetId) : '')
  if (!label) return null
  return { label, meta: dmsResourceMeta(d, d, r.Logic === true) }
}

/** 有效期秒数 → 天/小时/分钟；0 表示长期（DMS 的「长期有效」）。 */
function dmsDurationLabel(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds === 0) return '长期有效'
  const units: Array<[number, string]> = [[86400, '天'], [3600, '小时'], [60, '分钟']]
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = seconds / size
      return (Number.isInteger(n) ? String(n) : n.toFixed(1)) + ' ' + name
    }
  }
  return seconds + ' 秒'
}

/** 两类申请共用的 payload 形状（字段缺失一律回 null，客户端据此隐藏该行）。 */
function applyDetailPayload(
  type: string,
  detail: Record<string, unknown>,
  typeLabels: Record<string, string>,
  resources: unknown[],
  toView: (v: unknown) => Record<string, unknown> | null,
): Record<string, unknown> {
  const applyType = dmsStr(detail.ApplyType).toUpperCase()
  const permType = Number(detail.PermType)
  const seconds = Number(detail.Seconds)
  const list = resources.map(toView).filter((x): x is Record<string, unknown> => x !== null)
  return {
    ok: true,
    supported: true,
    type,
    // 申请类工单没有脚本，sql 恒为 null；客户端据 apply 渲染申请内容卡。
    sql: null,
    apply: {
      applyType: applyType || null,
      applyTypeLabel: (applyType && typeLabels[applyType]) || applyType || null,
      permType: Number.isFinite(permType) && detail.PermType != null ? permType : null,
      permTypeLabel: detail.PermType != null ? (PERM_TYPE_LABELS[String(permType)] || null) : null,
      seconds: Number.isFinite(seconds) && detail.Seconds != null ? seconds : null,
      durationLabel: detail.Seconds != null ? dmsDurationLabel(seconds) : null,
      resources: list,
      resourceCount: list.length,
    },
  }
}

/** PERM_APPLY：GetPermApplyOrderDetail → 资源/权限/有效期。 */
async function permApplyDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetPermApplyOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.PermApplyOrderDetail)
  const resources = Array.isArray(detail.Resources) ? (detail.Resources as unknown[]) : []
  return applyDetailPayload(PERM_APPLY_TYPE, detail, PERM_APPLY_TYPE_LABELS, resources, permApplyResource)
}

/** OWNER_APPLY：GetOwnerApplyOrderDetail → 资源 + 原 Owner（无权限类型/有效期）。 */
async function ownerApplyDetail(runner: Runner, id: string, region: string | null, tid: string | null): Promise<Record<string, unknown>> {
  const argv = dmsArgvPrefix(region, tid).concat(['GetOwnerApplyOrderDetail', '--OrderId', id])
  const raw = dmsJson(await dmsRun(runner, argv))
  if (raw && raw.Success === false) throw new Error(dmsApiError(raw))
  const detail = dmsObj(raw.OwnerApplyOrderDetail)
  const resources = Array.isArray(detail.Resources) ? (detail.Resources as unknown[]) : []
  return applyDetailPayload(OWNER_APPLY_TYPE, detail, OWNER_APPLY_TYPE_LABELS, resources, ownerApplyResource)
}
