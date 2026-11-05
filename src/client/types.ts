// dsh-workbench — shared browser-half types.
//
// The type-only imports below pull the official client-module contracts into
// this module graph: cordis Context gains `slots` (ui-renderer SlotRegistry),
// `sessions` (api-session-controller ISessions), `workspaces`
// (api-workspace-controller IWorkspaces) and `uiWorkspace` (ui-workspace),
// and the SlotMap gains the slot names this bundle registers
// into ('sidebar.panellist' / 'main' / 'conversation.chat.assistant-actions').
// esbuild erases every one of them at build time — they are type references
// only, resolved by tsc against the running DSH installation (tsconfig paths).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ISessions, SessionBinding, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'

/** The client root context with the merged official service contracts. */
export type ClientContext = Context

export type { ISessions, SessionBinding, SessionReference, UiWorkspace }

export type ForgeKey = 'gitlab' | 'github'

/** One normalized MR/PR item (GitLab and GitHub share this shape). */
export interface ForgeItem {
  forge: ForgeKey
  num: number | string
  title?: string
  description?: string
  state?: string
  draft?: boolean
  head_sha?: string
  base_sha?: string
  source_branch?: string
  target_branch?: string
  web_url?: string
  author?: string
  labels?: string[]
  has_conflicts?: boolean
  mergeable?: string
  reviewDecision?: string | null
  reviewRequests?: string[]
  created_at?: string | null
  updated_at?: string | null
  comment_count?: number
  /** Detail-only: issue-level notes normalized by the host (system events filtered). */
  notes?: ForgeNote[]
}

/** One normalized comment on the detail 评论 tab. */
export interface ForgeNote {
  author: string
  body: string
  created_at: string
}

/** One related MR/PR shown in the Issue 关联 column / detail aside. */
export interface RelatedMr {
  num: number | string
  title: string
  state: string
  web_url: string
  source_branch?: string
  target_branch?: string
}

/** One issue person (author / assignee) for the avatar + name cells. */
export interface IssuePerson {
  username: string
  name: string
  avatar: string
}

/** One normalized Issue (GitLab and GitHub share this shape). */
export interface IssueItem {
  forge: ForgeKey
  num: number
  title: string
  description: string
  state: 'opened' | 'closed'
  /** GitHub 的 completed / not_planned（GitLab 恒 null）。 */
  state_reason: string | null
  web_url: string
  author: IssuePerson | null
  assignees: IssuePerson[]
  labels: string[]
  created_at: string | null
  updated_at: string | null
  closed_at: string | null
  comment_count: number | null
  mr_count: number | null
  related?: RelatedMr[]
  /** Detail-only: notes normalized by the host (system events filtered). */
  notes?: ForgeNote[]
}

/** /forge/issues payload. */
export interface IssueListResult {
  ok: boolean
  error?: string
  updatedAt?: number
  forge?: ForgeKey
  issues: IssueItem[]
  total: number | null
  hasMore: boolean
  page: number
  pageSize: number
}

/** /forge/issue/meta payload — 统计卡片 + 标签/成员筛选源。 */
export interface IssueMeta {
  ok: boolean
  forge?: ForgeKey
  stats: { open: number | null; closed: number | null; assignedOpen: number | null }
  labels: Array<{ name: string; color: string }>
  members: Array<{ username: string; name: string }>
  viewer: { username: string; name: string } | null
}

/** One workspace as /forge/workspaces detects it (registry × git remote × CLI auth). */
export interface WorkspaceMeta {
  id?: string
  title?: string
  path: string
  host?: string | null
  repoPath?: string | null
  branch?: string
  user?: string | null
  forge?: ForgeKey | null
}

/** /forge/workspaces payload. */
export interface WsData {
  ok: boolean
  forges?: Record<string, { available: boolean; hosts: Array<{ host: string; user: string }> }>
  workspaces?: WorkspaceMeta[]
  error?: string | null
}

/** One DMS 工单 row (ListOrders Order / GetOrderBaseInfo OrderBaseInfo → compact view). */
export interface DmsOrder {
  orderId: string
  pluginType: string
  statusCode: string
  statusDesc: string
  workflowStatusDesc: string
  workflowInstanceId: string | null
  committer: string
  createTime: string
  lastModifyTime: string
  comment: string
  relatedUsers: string[]
  attachmentName: string | null
}

/** 权限申请 / Owner 申请的一条资源（host 已把库/表/列/实例/行归一化成一个定位串）。 */
export interface DmsApplyResource {
  /** 资源定位串（库 · 表.列 / 实例地址等）。 */
  label: string
  /** 库类型 · 环境（· 逻辑库）；没有时 null。 */
  meta: string | null
}

/** /dms/order/sql 的 apply 字段 —— PERM_APPLY / OWNER_APPLY 的申请内容
 *  （这两类工单没有 SQL，审批依据就是这些字段）。码值已由 host 翻译成 label。 */
export interface DmsApplyDetail {
  applyType: string | null
  applyTypeLabel: string | null
  /** PERM_APPLY：权限类型码（1 查询 … 8 登录）；OWNER_APPLY 为 null。 */
  permType: number | null
  permTypeLabel: string | null
  seconds: number | null
  durationLabel: string | null
  resources: DmsApplyResource[]
  resourceCount: number
}

/** 工单内容详情里的一行 k-v（host 已翻译成中文标签，客户端只渲染）。 */
export interface DmsFact {
  k: string
  v: string
}

/** /dms/order/sql payload — 工单内容详情（SQL 脚本 / 申请内容 / 工单配置）。 */
export interface DmsOrderSql {
  ok: boolean
  supported: boolean
  type: string | null
  /** SQL 正文；ATTACHMENT、无 SQL 的工单类型时为 null。 */
  sql: string | null
  /** TABLE_SYNC：语句总数（TotalSqlCount）。 */
  sqlCount?: number
  /** TABLE_SYNC：达到页数上限未能拉全时为 true。 */
  truncated?: boolean
  /** DATA_CHANGE / DC_*：回滚 SQL（'empty'/ATTACHMENT 时为 null）。 */
  rollbackSql?: string | null
  /** DATA_CHANGE / DC_*：SqlType=ATTACHMENT 时的附件名（正文需去 DMS 控制台下载）。 */
  attachmentName?: string | null
  /** 没有 SQL 的类型（导出 / 追踪 / 归档等）的工单配置行，渲染成「工单内容」卡。 */
  facts?: DmsFact[] | null
  /** PERM_APPLY / OWNER_APPLY：申请内容（此时 sql 恒为 null）。 */
  apply?: DmsApplyDetail | null
}

/** Workspace-registry view row the 「评审」 button addresses (workspaceId). */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds?: string[]
}

/** One SLS log entry (GetLogsV2 `data` row: string-keyed fields, `__time__`
 *  is epoch seconds as a string). */
export interface SlsLogEntry {
  __time__?: string
  __source__?: string
  __topic__?: string
  [key: string]: unknown
}

/** /sls/query payload (host parses `data`/`logs` into `logs`). */
export interface SlsQueryResult {
  ok: boolean
  logs: SlsLogEntry[]
  count: number
  progress: string
  elapsedMs: number | null
  keys?: string[]
}

/** One SLS environment supplied by the plugin-row `slsEnvironments` config
 *  (host `/sls/status` normalizes it: project/logstore required, logs defaults
 *  to logstore). */
export interface SlsEnvironment {
  key: string
  label: string
  project: string
  logstore: string
  logs: string
}

/** /sls/status payload — same aliyun CLI probe shape as /dms/status, plus the
 *  deployment-configured environments (empty = not configured). */
export interface SlsStatusPayload {
  ok: boolean
  updatedAt: number
  cli: SlsCliStatus
  environments?: SlsEnvironment[]
}

/** /sls/status `cli` probe shape — same aliyun CLI probe as /dms/status. */
export interface SlsCliStatus {
  available: boolean
  configured: boolean
  activeRegion: string | null
  error?: string | null
}

/** Session list snapshot row (framework-injected useSessions / useWorkspaces). */
export interface SessionListRow {
  id?: string
  sessionIds?: string[]
  path?: string
  title?: string
  retainedBy?: { mainView?: number }
}

// ── 首页（/home/sessions host 归一化后的跨工作区会话视图）───────────────────

/** 一个「需要关注」的会话行（host 已按过滤口径筛好并分组）。 */
export interface HomeSessionRow {
  sessionId: string
  /** 会话所属工作区路径。 */
  cwd: string | null
  title: string | null
  createdAt: number
  /** max(createdAt, lastPromptAt, 最后事件时间, 日志 mtime)——保留窗口口径。 */
  updatedAt: number
  /** max(createdAt, 最后一条用户消息时间)——侧边栏行尾时间同源，行内展示与排序用它。 */
  promptedAt: number
  /** flock 被持有（会话当前打开/正在写入）。 */
  running: boolean
  /** 有开放步骤或挂起工具调用（agent 卡住或在等你）。 */
  waiting: boolean
  blank: boolean
  child: boolean
  userMsgs: number
  assistantMsgs: number
  turns: number
  toolCalls: number
  /** projcache 里的权限 preset（permissions.preset），不是 agent preset。 */
  preset: string | null
  /** 后台常驻会话（host 按 agent preset 判定）：行上标「后台」，两栏可过滤掉。 */
  background: boolean
}

/** /home/sessions payload。 */
export interface HomePayload {
  hasMore?: boolean
  ok: boolean
  updatedAt: number
  sessions: HomeSessionRow[]
  groups: { running: HomeSessionRow[]; waiting: HomeSessionRow[]; recent: HomeSessionRow[] }
  counts: { running: number; waiting: number; recent24h: number }
}

// ── PingCode（host 经 python3 技能 api_call.py 归一化后的视图）──────────────

/** 一个 PingCode 项目（/pingcode/projects values）。 */
export interface PingCodeProject {
  id: string
  name: string
  type: string
  state: string
  assignee: string
  description: string
}

/** 一个 PingCode 工作项（列表行与详情共用同一视图）。 */
export interface PingCodeWorkItem {
  id: string
  identifier: string
  title: string
  type: string
  /** 状态名（如「新建」「进行中」）。 */
  stateName: string
  /** 状态分类：pending | progress | completed | ''（客户端筛选与统计用）。 */
  stateType: string
  stateColor: string
  priority: string
  assignee: { id: string; name: string; displayName: string } | null
  project: { id: string; name: string; identifier: string } | null
  htmlUrl: string
  description: string
  /** host 已对该富文本跑过白名单清洗（sanitizeRichText）；客户端只对带旗标的
   *  数据走 innerHTML 渲染，缺省（旧 host）按纯文本显示。 */
  rich?: boolean
  /** epoch 毫秒（host 已把秒转毫秒）。 */
  startAt: number | null
  endAt: number | null
  completedAt: number | null
  /** Detail-only: 评论（host 归一化，按时间升序）。 */
  notes?: PingCodeNote[]
}

/** 一条工作项评论（/v1/comments values）。 */
export interface PingCodeNote {
  id: string
  author: string
  content: string
  /** 同 PingCodeWorkItem.rich：host 清洗旗标，innerHTML 渲染的前提。 */
  rich?: boolean
  created_at: number | null
  isReply: boolean
}

/** 一个企业成员（/pingcode/members values）。 */
export interface PingCodeMember {
  id: string
  name: string
  displayName: string
  email: string
}

/** /pingcode/status payload —— 端到端探测（python3 / 技能目录 / .env 凭证 / 真实 API）。 */
export interface PingCodeStatus {
  ok: boolean
  updatedAt?: number
  python?: { available: boolean }
  skill?: { found: boolean; dir: string | null; scriptFound: boolean; error: string | null }
  env?: {
    authMode: string
    clientCredentials: boolean
    userCredentials: boolean
    accessToken: boolean
    baseUrlConfigured: boolean
    baseUrl: string
  }
  probe?: { ok: boolean; error: string | null; projectTotal: number | null }
  error?: string
}
