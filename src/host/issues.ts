// dsh-workbench — Issues 域（GitLab Issue / GitHub Issue），纯函数 + argv 构造。
//
// 与 MR/PR 域同构：per-forge 的命令构造器（白名单 argv，绝不透传 shell）+
// 归一化器（两端 Issue 折成一个 IssueView，一个 UI 渲染两端）。宿主路由
// （index.ts 的 /forge/issues*）调用这里；node --test 直接断言纯函数。
//
// 数据源：
//   - GitLab：`glab api projects/:path/issues?...`（REST 分页 + search/labels/
//     scope 过滤，`-i` 带回 X-Total / X-Next-Page 响应头做总数与翻页）；
//     详情 = `glab issue view <iid> -F json`；评论/关联 MR =
//     `glab api projects/:path/issues/:iid/notes` / `.../related_merge_requests`。
//   - GitHub：`gh issue list --json …`（无服务端分页，宿主按 page*pageSize
//     取回后本地切片）；详情 = `gh issue view <num> --json …`（含 comments）；
//     总数 = `gh api search/issues?q=repo:… state:… type:issue` 的 total_count。
//
// 注意：glab 的 search 依赖实例的检索能力（部分私有实例对 CJK 全文检索
// 返回空），纯数字串走 `iids[]` 精确按编号查 ——「搜索 标题/描述/编号」
// 在 GitLab 上是 服务端 search + 编号直查 的并集口径。

import type { ForgeKey } from './runner'

// ── 过滤条件（路由参数 → 白名单结构）────────────────────────────────────────

export type IssueScope = 'mine' | 'assigned' | 'all'
export type IssueStateFilter = 'opened' | 'closed' | 'all'
export type IssueSort = 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc'

export interface IssueFilters {
  scope: IssueScope
  state: IssueStateFilter
  search: string
  label: string
  assignee: string
  sort: IssueSort
  page: number
  pageSize: number
}

export const ISSUE_PAGE_SIZES = [20, 50]

function oneOf<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  const s = String(v == null ? '' : v)
  return (allowed as readonly string[]).includes(s) ? (s as T) : dflt
}

function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.floor(Number(v))
  if (!isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/** 路由 query → 白名单过滤条件（越界/非法值一律回默认，绝不进 argv）。 */
export function normalizeIssueFilters(q: Record<string, unknown>): IssueFilters {
  return {
    scope: oneOf(q.scope, ['mine', 'assigned', 'all'] as const, 'all'),
    state: oneOf(q.state, ['opened', 'closed', 'all'] as const, 'all'),
    search: String(q.search == null ? '' : q.search).trim().slice(0, 200),
    label: String(q.label == null ? '' : q.label).trim().slice(0, 200),
    assignee: String(q.assignee == null ? '' : q.assignee).trim().slice(0, 100).replace(/^@/, ''),
    sort: oneOf(q.sort, ['updated_desc', 'updated_asc', 'created_desc', 'created_asc'] as const, 'updated_desc'),
    page: clampInt(q.page, 1, 500, 1),
    pageSize: clampInt(q.pageSize, 1, 50, 20),
  }
}

// ── 归一化 IssueView ────────────────────────────────────────────────────────

/** One related MR/PR shown in the 关联 column and the detail aside. */
export interface RelatedMrView {
  num: number | string
  title: string
  state: string
  web_url: string
  source_branch?: string
  target_branch?: string
}

/** One issue person (author / assignee) for avatar+name rendering. */
export interface IssuePerson {
  username: string
  name: string
  avatar: string
}

export interface IssueView {
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
  /** 列表可能缺（GitHub 列表拉了 comments 则有；未知为 null）。 */
  comment_count: number | null
  /** merge_requests_count / closedByPullRequestsReferences 数（未知 null）。 */
  mr_count: number | null
  /** 关联 MR：GitHub 列表自带（closedBy…）；GitLab 由宿主按 mr_count>0 预取或详情拉全。 */
  related?: RelatedMrView[]
  /** 详情专用：归一化后的评论（system 事件已过滤，见 index.ts normalizeNotes）。 */
  notes?: Array<{ author: string; body: string; created_at: string }>
}

function person(username: unknown, name: unknown, avatar: unknown): IssuePerson | null {
  const u = String(username == null ? '' : username).trim()
  if (!u) return null
  return { username: u, name: String(name == null ? '' : name) || u, avatar: String(avatar == null ? '' : avatar) }
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).name : l))
    .map((n) => String(n == null ? '' : n))
    .filter(Boolean)
}

/** GitHub avatar URL：gh 的 issue JSON 不带 avatar_url，但 GitHub 头像地址可构造。 */
function ghAvatar(login: string): string {
  return login ? 'https://github.com/' + encodeURIComponent(login) + '.png?size=40' : ''
}

/**
 * 归一化 GitLab / GitHub Issue 为统一 IssueView。容错：任何字段缺失都给
 * 安全默认值；结构完全非法时返回 null。GitLab 输入是 REST issue 对象
 * （glab issue view -F json / glab api projects/:path/issues），GitHub 输入
 * 是 `gh issue list|view --json` 行。
 */
export function toIssueView(m: unknown, forge: ForgeKey): IssueView | null {
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  if (forge === 'github') {
    const num = Number(o.number)
    if (!isFinite(num)) return null
    const author = (o.author && typeof o.author === 'object' ? o.author as Record<string, unknown> : null)
    const login = String(author && author.login || '')
    const closedRefs = Array.isArray(o.closedByPullRequestsReferences) ? o.closedByPullRequestsReferences : []
    const comments = Array.isArray(o.comments) ? o.comments : null
    return {
      forge: 'github',
      num,
      title: String(o.title || ''),
      description: String(o.body || ''),
      state: String(o.state).toUpperCase() === 'CLOSED' ? 'closed' : 'opened',
      state_reason: o.stateReason ? String(o.stateReason).toLowerCase() : null,
      web_url: String(o.url || ''),
      author: person(login, author && author.name, ghAvatar(login)),
      assignees: (Array.isArray(o.assignees) ? o.assignees : []).map((a) => {
        const rec = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
        const l = String(rec.login || '')
        return person(l, rec.name, ghAvatar(l))
      }).filter((p): p is IssuePerson => p !== null),
      labels: labelNames(o.labels),
      created_at: o.createdAt ? String(o.createdAt) : null,
      updated_at: o.updatedAt ? String(o.updatedAt) : null,
      closed_at: o.closedAt ? String(o.closedAt) : null,
      comment_count: comments ? comments.length : null,
      mr_count: closedRefs.length || null,
      related: normalizeRelatedMrs(closedRefs),
    }
  }
  // gitlab
  const num = Number(o.iid)
  if (!isFinite(num)) return null
  const author = (o.author && typeof o.author === 'object' ? o.author as Record<string, unknown> : null)
  const assignees = (Array.isArray(o.assignees) ? o.assignees : []).map((a) => {
    const rec = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
    return person(rec.username, rec.name, rec.avatar_url)
  }).filter((p): p is IssuePerson => p !== null)
  return {
    forge: 'gitlab',
    num,
    title: String(o.title || ''),
    description: String(o.description || ''),
    state: o.state === 'closed' ? 'closed' : 'opened',
    state_reason: null,
    web_url: String(o.web_url || ''),
    author: person(author && author.username, author && author.name, author && author.avatar_url),
    assignees,
    labels: labelNames(o.labels),
    created_at: o.created_at ? String(o.created_at) : null,
    updated_at: o.updated_at ? String(o.updated_at) : null,
    closed_at: o.closed_at ? String(o.closed_at) : null,
    comment_count: Number.isFinite(Number(o.user_notes_count)) ? Number(o.user_notes_count) : null,
    mr_count: Number.isFinite(Number(o.merge_requests_count)) ? Number(o.merge_requests_count) : null,
  }
}

/** related_merge_requests / closedByPullRequestsReferences → 关联 MR 视图。 */
export function normalizeRelatedMrs(raw: unknown): RelatedMrView[] {
  if (!Array.isArray(raw)) return []
  const out: RelatedMrView[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const num = Number(o.iid != null ? o.iid : o.number)
    if (!isFinite(num)) continue
    const stateRaw = String(o.state || '').toLowerCase()
    const state = ['opened', 'merged', 'closed'].includes(stateRaw) ? stateRaw
      : stateRaw === 'open' ? 'opened' : stateRaw
    out.push({
      num,
      title: String(o.title || ''),
      state,
      web_url: String(o.web_url || o.url || ''),
      source_branch: o.source_branch ? String(o.source_branch) : undefined,
      target_branch: o.target_branch ? String(o.target_branch) : undefined,
    })
  }
  return out
}

// ── GitLab：glab api 路径构造 + `-i` 输出解析 ────────────────────────────────

function enc(s: string): string {
  return encodeURIComponent(s)
}

function gitlabIssuesQuery(f: IssueFilters): string {
  const parts: string[] = ['per_page=' + f.pageSize, 'page=' + f.page]
  if (f.scope === 'mine') parts.push('scope=created_by_me')
  if (f.scope === 'assigned') parts.push('scope=assigned_to_me')
  parts.push('state=' + f.state)
  if (f.search) {
    // 纯数字 → 按编号精确直查（实例全文检索对编号无意义；括号转义更稳）；
    // 否则服务端 search（标题+描述）。
    if (/^\d+$/.test(f.search)) parts.push('iids%5B%5D=' + enc(f.search))
    else parts.push('search=' + enc(f.search), 'in=title,description')
  }
  if (f.label) parts.push('labels=' + enc(f.label))
  if (f.assignee) parts.push('assignee_username=' + enc(f.assignee))
  const [order, dir] = f.sort.split('_')
  parts.push('order_by=' + (order === 'created' ? 'created_at' : 'updated_at'), 'sort=' + (dir || 'desc'))
  return parts.join('&')
}

/** GET /forge/issues 的 GitLab argv：一条 `glab api -i`（响应头带 X-Total / X-Next-Page）。 */
export function gitlabIssuesArgv(repoPath: string, f: IssueFilters): string[] {
  return ['api', '-i', 'projects/' + enc(repoPath) + '/issues?' + gitlabIssuesQuery(f)]
}

export function gitlabIssueNotesArgv(repoPath: string, num: string): string[] {
  return ['api', 'projects/' + enc(repoPath) + '/issues/' + num + '/notes?per_page=100&sort=asc']
}

export function gitlabRelatedMrsArgv(repoPath: string, num: string): string[] {
  return ['api', 'projects/' + enc(repoPath) + '/issues/' + num + '/related_merge_requests?per_page=20']
}

export interface IssueStats {
  open: number | null
  closed: number | null
  /** 指派给我且未关闭（我的待处理卡片）。 */
  assignedOpen: number | null
}

/** GitLab 统计 argv（三条独立查询，各取 X-Total）。 */
export function gitlabIssueStatsArgvs(repoPath: string): { open: string[]; closed: string[]; assignedOpen: string[] } {
  const base = 'projects/' + enc(repoPath) + '/issues?per_page=1&'
  return {
    open: ['api', '-i', base + 'state=opened'],
    closed: ['api', '-i', base + 'state=closed'],
    assignedOpen: ['api', '-i', base + 'scope=assigned_to_me&state=opened'],
  }
}

export function gitlabLabelsArgv(repoPath: string): string[] {
  return ['api', 'projects/' + enc(repoPath) + '/labels?per_page=100']
}

export function gitlabMembersArgv(repoPath: string): string[] {
  return ['api', 'projects/' + enc(repoPath) + '/members?per_page=100']
}

/**
 * 解析 `glab api -i <path>` 输出：状态行 + 响应头 + 空行 + JSON 正文。
 * 头里拿 X-Total（精确总数）与 X-Next-Page（还有下一页）。JSON 正文里不会
 * 出现裸 CRLF CRLF（JSON 字符串的换行是转义序列），按第一个空行切分安全。
 * 无 `-i` 前缀的纯 JSON 输入也兼容（total/hasMore 退化）。
 */
export function parseGlabApiWithHeaders(out: string): { headers: Record<string, string>; body: string } {
  const text = String(out || '')
  const sep = text.match(/\r?\n\r?\n/)
  if (!sep || sep.index === undefined) return { headers: {}, body: text }
  const headerBlock = text.slice(0, sep.index)
  const body = text.slice(sep.index + sep[0].length)
  const headers: Record<string, string> = {}
  for (const line of headerBlock.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
  }
  return { headers, body }
}

export interface IssueListPage {
  issues: IssueView[]
  total: number | null
  hasMore: boolean
}

/** GitLab 列表输出 → 页数据（issues 归一化 + X-Total / X-Next-Page）。 */
export function parseGitlabIssueList(out: string, forge: ForgeKey = 'gitlab'): IssueListPage {
  const { headers, body } = parseGlabApiWithHeaders(out)
  let raw: unknown = []
  try {
    raw = JSON.parse(body)
  } catch (e) {
    raw = []
  }
  const issues = (Array.isArray(raw) ? raw : [])
    .map((m) => toIssueView(m, forge))
    .filter((v): v is IssueView => v !== null)
  const total = Number(headers['x-total'])
  const nextPage = headers['x-next-page']
  return {
    issues,
    total: isFinite(total) ? total : null,
    hasMore: nextPage ? /^\d+$/.test(nextPage) : false,
  }
}

// ── GitHub：gh issue list argv（本地切片分页）────────────────────────────────

export const GH_ISSUE_LIST_FIELDS =
  'number,title,body,state,stateReason,labels,assignees,author,url,createdAt,updatedAt,closedAt,closedByPullRequestsReferences,comments'

/**
 * GET /forge/issues 的 GitHub argv。gh issue list 没有服务端分页：取
 * `page*pageSize` 条后本地切片（宿主负责），hasMore 按取满与否判断。
 * 排序走 search 限定符（sort:updated-desc），与用户 search 词拼接。
 */
export function githubIssuesArgv(f: IssueFilters): { argv: string[]; fetchLimit: number } {
  const fetchLimit = Math.min(250, f.page * f.pageSize)
  const argv = ['issue', 'list', '--json', GH_ISSUE_LIST_FIELDS, '--state', f.state === 'opened' ? 'open' : f.state === 'closed' ? 'closed' : 'all', '--limit', String(fetchLimit)]
  if (f.scope === 'mine') argv.push('--author', '@me')
  if (f.assignee) argv.push('--assignee', f.assignee)
  else if (f.scope === 'assigned') argv.push('--assignee', '@me')
  if (f.label) {
    for (const l of f.label.split(',').map((x) => x.trim()).filter(Boolean)) argv.push('--label', l)
  }
  const [order, dir] = f.sort.split('_')
  const sortQ = 'sort:' + order + '-' + (dir || 'desc')
  if (f.search) argv.push('--search', f.search + ' ' + sortQ)
  else argv.push('--search', sortQ)
  return { argv, fetchLimit }
}

/** GitHub 列表输出 → 页数据（本地切片 + hasMore 推断，total 未知为 null）。 */
export function parseGithubIssueList(out: string, f: IssueFilters): IssueListPage {
  let raw: unknown = []
  try {
    raw = JSON.parse(String(out || ''))
  } catch (e) {
    raw = []
  }
  const all = (Array.isArray(raw) ? raw : [])
    .map((m) => toIssueView(m, 'github'))
    .filter((v): v is IssueView => v !== null)
  const start = (f.page - 1) * f.pageSize
  return {
    issues: all.slice(start, start + f.pageSize),
    total: null,
    hasMore: all.length > f.page * f.pageSize,
  }
}

/** GitHub 统计 argv（search API 的 total_count；viewer 未知时待处理卡为 null）。 */
export function githubIssueStatsArgvs(repoPath: string, viewer: string | null): { open: string[]; closed: string[]; assignedOpen: string[] | null } {
  const q = (terms: string): string[] => ['api', 'search/issues?q=' + enc('repo:' + repoPath + ' ' + terms), '--jq', '.total_count']
  return {
    open: q('state:open type:issue'),
    closed: q('state:closed type:issue'),
    assignedOpen: viewer ? q('state:open type:issue assignee:' + viewer) : null,
  }
}

export function githubLabelsArgv(): string[] {
  return ['label', 'list', '--json', 'name,color', '--limit', '100']
}

export function githubMembersArgv(repoPath: string): string[] {
  // 「可被指派的人」= repos/:owner/:repo/assignees（assignables 端点不存在）。
  // 返回值不带 'api' 前缀：loadIssueMeta 的 GitHub 分支统一拼 --hostname 前缀。
  return ['repos/' + repoPath + '/assignees?per_page=100']
}

// ── 写操作 argv ─────────────────────────────────────────────────────────────

export interface IssueUpdateFields {
  title?: string
  description?: string
  addLabels: string[]
  removeLabels: string[]
  addAssignees: string[]
  removeAssignees: string[]
}

export function gitlabIssueUpdateArgv(num: string, f: IssueUpdateFields): string[] {
  const addLabels = f.addLabels || []
  const removeLabels = f.removeLabels || []
  const addAssignees = f.addAssignees || []
  const removeAssignees = f.removeAssignees || []
  const argv = ['issue', 'update', String(num)]
  if (f.title !== undefined) argv.push('-t', f.title)
  if (f.description !== undefined) argv.push('-d', f.description)
  for (const l of addLabels) argv.push('-l', l)
  for (const l of removeLabels) argv.push('-u', l)
  // -a 支持 +/-/! 前缀做增量增删（重复 flag 合并）。
  for (const u of addAssignees) argv.push('-a', '+' + u)
  for (const u of removeAssignees) argv.push('-a', '!' + u)
  return argv
}

export function githubIssueUpdateArgv(num: string, f: IssueUpdateFields): string[] {
  const addLabels = f.addLabels || []
  const removeLabels = f.removeLabels || []
  const addAssignees = f.addAssignees || []
  const removeAssignees = f.removeAssignees || []
  const argv = ['issue', 'edit', String(num)]
  if (f.title !== undefined) argv.push('--title', f.title)
  if (f.description !== undefined) argv.push('--body', f.description)
  for (const l of addLabels) argv.push('--add-label', l)
  for (const l of removeLabels) argv.push('--remove-label', l)
  for (const u of addAssignees) argv.push('--add-assignee', u)
  for (const u of removeAssignees) argv.push('--remove-assignee', u)
  return argv
}

export function issueCloseArgv(num: string): string[] {
  return ['issue', 'close', String(num)]
}

export function issueReopenArgv(num: string): string[] {
  return ['issue', 'reopen', String(num)]
}

export function issueNoteArgv(forge: ForgeKey, num: string, body: string): string[] {
  return forge === 'github'
    ? ['issue', 'comment', String(num), '--body', body]
    : ['issue', 'note', String(num), '-m', body]
}

export function issueViewArgv(forge: ForgeKey, num: string): string[] {
  return forge === 'github'
    ? ['issue', 'view', String(num), '--json', GH_ISSUE_LIST_FIELDS]
    : ['issue', 'view', String(num), '-F', 'json']
}
