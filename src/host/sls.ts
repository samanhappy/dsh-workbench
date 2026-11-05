// dsh-workbench — host SLS 日志查询 domain: drives the locally installed
// `aliyun` CLI (`sls get-logs-v2`, API 2020-12-30) over the same trust shape
// as the DMS half — the CLI carries its own credentials (`aliyun configure`),
// this half never touches keys. Every request parameter is whitelisted into a
// fixed argv — nothing reaches a shell.
//
// Command contract (docs: 调用CLI命令查询日志 — 查询模式 / SQL 模式):
//   aliyun sls get-logs-v2 --project=<p> --logstore=<l> --from=<from>
//     --to=<to> --accept-encoding lz4 [--query=<q>] [--line=<n>]
//     [--offset=<o>] [--reverse=<bool>]
//   --from/--to: Unix 时间戳（秒），左闭右开区间 [from, to)。
//   --query: 查询语法（关键字）或 `<查询语法> | <SQL>` 分析语句。
//   --line: 0..100，仅查询模式有效；--offset: 分页偏移；--reverse: 排序。
// The CLI decompresses lz4 itself and prints the raw GetLogsV2 JSON payload:
//   { "data": [ { "__time__": "…", "__source__": "…", <fields…> } ],
//     "meta": { "count": n, "progress": "Complete", "elapsedMillisecond": ms,
//               "keys": […], … } }
// (SDK 文档里的字段名是 logs，实际 CLI 输出是 data —— 解析器两者都接受。)
// 与 dms-enterprise 一样，SDK 错误打印在 STDOUT 且退出码 1：宿主合并两路输出
// 并提取 `Message:` 归类成中文提示（classifySlsError）。
//
// 环境/Project/Logstore 由部署配置 `slsEnvironments`（JSON 数组，见 config.ts
// 与 parseSlsEnvironments）提供；本模块不含任何默认 Project/Logstore，请求必须
// 携带非空的 project 与 logstore（面板未配置环境时让使用者手填）。
// Route wiring (with the status cache) lives in index.ts's apply().

import type { HostContext, Runner } from './runner'
import { aliyunOAuthReauthHint, classifyError } from './runner'

const SLS_EXE = 'aliyun'
const SLS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SLS_ENV_MAX = 20

/** 一个部署配置的 SLS 环境（`slsEnvironments` 数组项，字段已归一化）。 */
export interface SlsEnvironment {
  key: string
  label: string
  project: string
  logstore: string
  /** 「日志」视图使用的 logstore（缺省 = logstore，即 Trace 库）。 */
  logs: string
}

/** 解析部署配置里的 `slsEnvironments`（JSON 数组字符串）。
 *  留空 / 非法 JSON / 非数组 → `[]`；缺 project 或 logstore 合法名称的条目、
 *  重复 key 的条目逐条忽略；绝不抛错（配置写坏只影响 SLS 页的可用环境）。 */
export function parseSlsEnvironments(raw: unknown): SlsEnvironment[] {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return []
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch (e) { return [] }
  if (!Array.isArray(parsed)) return []
  const out: SlsEnvironment[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (out.length >= SLS_ENV_MAX) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const project = String(row.project == null ? '' : row.project).trim()
    const logstore = String(row.logstore == null ? '' : row.logstore).trim()
    if (!SLS_NAME_RE.test(project) || !SLS_NAME_RE.test(logstore)) continue
    const key = String(row.key == null ? '' : row.key).trim() || project
    if (seen.has(key)) continue
    seen.add(key)
    const label = String(row.label == null ? '' : row.label).trim() || key
    const logsRaw = String(row.logs == null ? '' : row.logs).trim()
    out.push({ key, label, project, logstore, logs: SLS_NAME_RE.test(logsRaw) ? logsRaw : logstore })
  }
  return out
}

const SLS_LINE_MAX = 100   // get-logs-v2 --line 最大 100
const SLS_OFFSET_MAX = 1000000
const SLS_QUERY_MAX = 8192

export interface SlsQueryInput {
  project?: unknown
  logstore?: unknown
  from?: unknown
  to?: unknown
  query?: unknown
  line?: unknown
  offset?: unknown
  reverse?: unknown
}

/** Project / Logstore 名称：必填，字母/数字开头，字母、数字、-、_，最长 128。
 *  缺省报错并指向部署配置键：面板未配置环境时使用者需要手填，host 不兜底。 */
function slsName(v: unknown, what: string): string {
  const s = String(v == null ? '' : v).trim()
  if (!s) {
    throw new Error('缺少 SLS ' + what + '：请在插件行 config 的 slsEnvironments 中配置环境，或在请求中携带 ' + what)
  }
  if (!SLS_NAME_RE.test(s)) {
    throw new Error('无效的 SLS ' + what + '：' + s.slice(0, 60))
  }
  return s
}

/** Unix 时间戳（秒）：纯数字；from 必须早于 to（左闭右开）。 */
function slsTs(v: unknown, what: string): number {
  const s = String(v == null ? '' : v).trim()
  if (!/^\d{1,12}$/.test(s)) {
    throw new Error('无效的 ' + what + '（Unix 秒级时间戳）：' + s.slice(0, 40))
  }
  return Number(s)
}

/** 0..100（get-logs-v2 --line 上限 100）；缺省用 SLS 默认值 100。 */
function slsLine(v: unknown): number | null {
  const s = String(v == null ? '' : v).trim()
  if (!s) return null
  if (!/^\d{1,3}$/.test(s)) throw new Error('无效的 line（0-100）：' + s.slice(0, 40))
  const n = Number(s)
  if (n > SLS_LINE_MAX) throw new Error('无效的 line：最大 ' + SLS_LINE_MAX)
  return n
}

/** 分页偏移：0..1000000。 */
function slsOffset(v: unknown): number | null {
  const s = String(v == null ? '' : v).trim()
  if (!s) return null
  if (!/^\d{1,7}$/.test(s)) throw new Error('无效的 offset（0-' + SLS_OFFSET_MAX + '）：' + s.slice(0, 40))
  const n = Number(s)
  if (n > SLS_OFFSET_MAX) throw new Error('无效的 offset：最大 ' + SLS_OFFSET_MAX)
  return n
}

/** 查询语句：任意文本（作为单个 argv 元素透传，绝不进 shell），限长。 */
function slsQuery(v: unknown): string | null {
  const s = String(v == null ? '' : v).trim()
  if (!s) return null
  if (s.length > SLS_QUERY_MAX) throw new Error('query 过长（最多 ' + SLS_QUERY_MAX + ' 字符）')
  return s
}

/** 排序：true=新者优先（时间戳降序），false/缺省=旧者优先（升序）。 */
function slsReverse(v: unknown): boolean | null {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  if (!s) return null
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  throw new Error('无效的 reverse（true/false）：' + s.slice(0, 20))
}

/** 白名单式构造 `aliyun sls get-logs-v2` argv（纯函数，供测试直接断言）。
 *  project/logstore 必填（部署配置或请求显式提供），无缺省兜底。 */
export function buildSlsArgv(q: SlsQueryInput): string[] {
  const project = slsName(q.project, 'project')
  const logstore = slsName(q.logstore, 'logstore')
  const from = slsTs(q.from, 'from')
  const to = slsTs(q.to, 'to')
  if (from >= to) {
    throw new Error('无效的时间区间：from 必须早于 to（[from, to) 左闭右开）')
  }
  const argv = [
    'sls', 'get-logs-v2',
    '--project', project,
    '--logstore', logstore,
    '--accept-encoding', 'lz4',
    '--from', String(from),
    '--to', String(to),
  ]
  const query = slsQuery(q.query)
  if (query) argv.push('--query', query)
  const line = slsLine(q.line)
  if (line !== null) argv.push('--line', String(line))
  const offset = slsOffset(q.offset)
  if (offset !== null) argv.push('--offset', String(offset))
  const reverse = slsReverse(q.reverse)
  if (reverse !== null) argv.push('--reverse', String(reverse))
  return argv
}

/** 解析 CLI stdout：容忍前导噪声；实际输出字段是 `data`（文档示例为 logs），
 *  两者都接受。meta 的 count/progress/elapsedMillisecond 原样带出。 */
export function parseSlsResult(out: string): Record<string, unknown> {
  const text = String(out || '')
  const start = text.indexOf('{')
  if (start < 0) throw new Error('aliyun CLI 输出不是 JSON：' + text.slice(0, 120))
  const raw = JSON.parse(text.slice(start)) as Record<string, unknown>
  const logs = Array.isArray(raw.data) ? raw.data
    : Array.isArray(raw.logs) ? raw.logs
      : []
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta as Record<string, unknown> : {}
  return {
    ok: true,
    logs,
    count: Number(meta.count ?? logs.length) || logs.length,
    progress: String(meta.progress || ''),
    elapsedMs: Number(meta.elapsedMillisecond || 0) || null,
    keys: Array.isArray(meta.keys) ? meta.keys : [],
  }
}

export function classifySlsError(err: unknown): string {
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

/** 执行一次 SLS 日志查询。CLI 的 SDK 错误打印在 stdout 且退出码 1，所以用
 *  tryRun 合并两路输出再归类。超过内存窗口的完整输出落盘，最多 64MB。 */
export async function runSlsQuery(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const argv = buildSlsArgv(body || {})
  const r = await runner.tryRun(SLS_EXE, argv, { graceMs: 30000, maxBytes: 12000000, spillMaxBytes: 64000000 })
  if (r.code !== 0) {
    const text = (String(r.errText || '').trim() + '\n' + String(r.out || '').trim()).trim()
    throw new Error(text || SLS_EXE + ' 退出码 ' + String(r.code))
  }
  return parseSlsResult(String(r.out || ''))
}
