// dsh-workbench — SLS 日志查询 page (SlsPanel), driven by the local aliyun CLI.
//
// 数据来自 host 的 /sls/* 路由（本机 `aliyun sls get-logs-v2` CLI）：
//   /sls/status  CLI 探测（与 /dms/status 同一个 aliyun 凭证探测）+ 部署配置的
//                环境列表（status.environments，来自插件行 config 的
//                slsEnvironments）
//   /sls/query   POST { project, logstore, from, to, query, line, offset, reverse }
// 不含任何内置 Project / Logstore：配置了环境（host 解析后给 environments）就
// 用环境下拉——project 与 logstore/logs 都由配置决定；没有配置时退化成可编辑的
// Project / Logstore 输入框（按已保存偏好预填），并提示管理员在插件行 config
// 中设置 slsEnvironments；两者都非空才允许查询。
//
// 查询表单（紧凑三行，减少首屏占用）：
//   第 1 行 Project / Logstore / 时间范围 / 返回行数 / 倒序开关；
//   第 2 行 查询语句（单行高度、可纵向拉伸）+ 查询 / 清空；
//   第 3 行 快捷区间 chips（当前命中高亮）。Cmd/Ctrl+Enter 直接触发查询。
// 相对快捷区间在每次查询时按「现在」重算起止（chip 命中且未被手动改动时）；
// 查询期间按钮变 查询中… 并禁用，runQuery 以 busy 守卫拒绝重入。
// 快捷区间查询成功后表单折叠成一行摘要（点摘要或「编辑」展开），手动查询
// 不折叠——迭代改查询词的循环不受影响。
//
// 日志列表（紧凑单行头 + 展开详情）：每条头部固定展示 时间 / 操作摘要 /
// 服务名（浅蓝标签）/ 异常状态（红橙标签，正常值不显示）/ 耗时 / 来源 IP /
// traceID（蓝色链接，点击以 traceID: "…" 下钻重查）；右侧 复制 trace /
// 复制 JSON；点头部或箭头展开。展开卡片浅橙描边，其余条目仅分隔线。
// 展开体为 详情 / SQL / JSON 三页签：
//   详情 —— 左右分栏：左「基本信息」（traceID/时间/来源 IP/服务名/数据库
//     连接/数据库表/操作类型/执行耗时/线程名/服务器地址…已知字段取友好
//     标签），右「SQL 语句 + 扩展字段」（attribute/resource 解平后的其余
//     字段：异常/严重度/服务/DB/HTTP 等重要键默认展示，其余默认折叠在
//     「展开其余 N 项」里）。
//   SQL —— db.statement（或摘要中的 SQL 文本）按行号渲染，关键字/字符串/
//     数字/注释/函数分色，可一键复制。
//   JSON —— 字符串化 JSON 字段递归解开的缩进树（key/字符串/数字分色），
//     「复制 JSON」仍复制原始 JSON。
// OTEL span 的 duration 按微秒解释（真实数据校验 end-start == duration）；
// span 有 start（epoch 微秒）时时间戳显示到毫秒。整批返回（batch ≥ 行数）
// 时出现「加载更多」+ 上限提示，按 offset 追加下一页（SQL 分析模式
// `* | select` 下 line/offset 无效，不出现）。span 结果有 列表/瀑布 切换。
// project/logstore/行数/查询语句/排序 持久化在浏览器 localStorage。

import { React, h, useLayout } from '../react'
import { forgeFetch } from '../runtime'
import { EmptyState, RefreshGlyph, chevronGlyph } from '../icons'
import type { SlsCliStatus, SlsEnvironment, SlsLogEntry, SlsQueryResult, SlsStatusPayload } from '../types'
import type { FrameworkProps } from './props'

const SLS_LS_KEY = 'samanhappy.dsh-workbench.sls'
const SLS_DEFAULT_LINE = '100'
const SLS_JSON_CAP = 12000
const SLS_JSON_LINES = 400   // JSON 页签最多渲染的行数（超出行截断）
const SLS_JSON_DEPTH = 3     // 字符串化 JSON 字段递归解开的层数
const SLS_MORE_CAP = 10000   // 「加载更多」的 offset 上限
const SLS_WF_TRACE_CAP = 20  // 瀑布视图最多展示的 trace 数
const SLS_EXTRA_CAP = 40     // 详情「扩展字段」最多抽取的条目数（默认展示区+折叠区合计）
// 「重要」扩展字段的键名模式：排查时先看的键（异常/严重度/DB/HTTP、
// 服务器 host 与进程 pid）默认直接展示；不匹配的（service./os./telemetry./
// host.arch 等部署与环境元信息）默认折叠进「展开其余 N 项」，点开才渲染。
const SLS_EXTRA_IMPORTANT_RE = /^(exception\.|error|severity|db\.|http\.|url\.|rpc\.|messaging\.|level|status|host(\.name)?$|process\.pid$)/i

const RANGE_PRESETS: Array<{ label: string; seconds: number }> = [
  { label: '最近15分钟', seconds: 15 * 60 },
  { label: '最近1小时', seconds: 3600 },
  { label: '最近6小时', seconds: 6 * 3600 },
  { label: '最近24小时', seconds: 24 * 3600 },
  { label: '最近3天', seconds: 3 * 86400 },
  { label: '最近7天', seconds: 7 * 86400 },
]

function loadSlsPrefs(): Record<string, string> {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(SLS_LS_KEY) : null
    const p = raw ? JSON.parse(raw) : null
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {}
  }
}

function saveSlsPrefs(patch: Record<string, string>): void {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(SLS_LS_KEY, JSON.stringify(Object.assign(loadSlsPrefs(), patch)))
  } catch (e) {}
}

function loadRecentQueries(): string[] {
  try {
    const queries: unknown = JSON.parse(loadSlsPrefs().recentQueries || '[]')
    return Array.isArray(queries)
      ? Array.from(new Set(queries.filter((q): q is string => typeof q === 'string' && !!q.trim()).map(q => q.trim()))).slice(0, 20)
      : []
  } catch (e) { return [] }
}

/** /sls/status → 部署配置的环境列表；缺失/字段不合法的条目忽略（未配置为 []）。 */
function statusEnvironments(status: SlsStatusPayload | null): SlsEnvironment[] {
  const list = status && Array.isArray(status.environments) ? status.environments : []
  return list.filter(function (env) {
    return !!env && typeof env.project === 'string' && !!env.project.trim() &&
      typeof env.logstore === 'string' && !!env.logstore.trim()
  })
}

/** 当前 project 命中的环境；对不上（旧偏好 / 手填值）时回落第一个。 */
function resolveEnv(envs: SlsEnvironment[], project: string): SlsEnvironment | null {
  if (!envs.length) return null
  return envs.find(function (env) { return env.project === project }) || envs[0]
}

// ── time helpers ─────────────────────────────────────────────────────────────
function pad2(n: number): string { return String(n).padStart(2, '0') }

/** datetime-local 输入值（本地时区）→ Unix 秒；解析失败返回 null。 */
function dtLocalToEpoch(s: string): number | null {
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? null : Math.floor(t / 1000)
}

/** Unix 秒 → datetime-local 输入值（本地时区）。 */
function epochToDtLocal(e: number): string {
  const d = new Date(e * 1000)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** SLS `__time__`（秒字符串）→ MM-DD HH:mm:ss。 */
function fmtSlsTime(s: unknown): string {
  const n = Number(s)
  if (!isFinite(n)) return String(s || '')
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return String(s || '')
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}

function fmtEpoch(e: number): string {
  if (!e) return ''
  const d = new Date(e * 1000)
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** span 的 start（epoch 微秒字符串）→ MM-DD HH:mm:ss.mmm；非数值返回 null。
 *  `__time__` 只到秒，同一秒内的 span 分不出先后，用 start 补毫秒精度。 */
function fmtSpanTime(start: unknown): string | null {
  const n = Number(start)
  if (!isFinite(n) || n <= 0) return null
  const d = new Date(n / 1000)
  if (Number.isNaN(d.getTime())) return null
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
}

/** 同 fmtSpanTime，但带完整年月日（详情视图用）。 */
function fmtSpanTimeFull(start: unknown): string | null {
  const n = Number(start)
  if (!isFinite(n) || n <= 0) return null
  const d = new Date(n / 1000)
  if (Number.isNaN(d.getTime())) return null
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
}

// ── entry 渲染辅助（纯函数，供断言）──────────────────────────────────────────
function entryTitle(e: SlsLogEntry): string {
  for (const k of ['message', 'log.message', 'content', 'body', 'name', 'event', 'service', 'level', 'exception']) {
    const v = e[k]
    if (typeof v === 'string' && v) return v
  }
  return '(日志)'
}

/** OTEL span duration（微秒）→ 人话时长；非数值/负数返回 null。
 *  单位已用真实数据校验：end - start === duration（start/end 为 epoch 微秒），
 *  早期版本误标成 ms（60213322µs 实为 60.2s，却被显示成 60213322ms）。 */
function fmtDurationUs(v: unknown): string | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!isFinite(n) || n < 0) return null
  if (n < 1000) return Math.round(n) + 'µs'
  const ms = n / 1000
  if (ms < 10) return ms.toFixed(2) + 'ms'
  if (ms < 1000) return Math.round(ms) + 'ms'
  const s = ms / 1000
  if (s < 120) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  const rs = Math.round(s - m * 60)
  return rs ? m + 'm' + (rs < 10 ? '0' + rs : String(rs)) + 's' : m + 'm'
}

/** level / statusCode 文本 → 语义 kind：异常红、超时类橙，其余不着色
 *  （色只当异常信号：Ok/Info/Unset 这类正常值保持次要色，不做绿色噪音）。 */
function partKind(text: string): 'err' | 'warn' | 'plain' {
  if (/error|fail|exception|panic|fatal/i.test(text)) return 'err'
  if (/warn|timeout|deadline|cancel|retry/i.test(text)) return 'warn'
  return 'plain'
}

function entryJson(e: SlsLogEntry): string {
  const text = JSON.stringify(e, null, 2)
  return text.length > SLS_JSON_CAP ? text.slice(0, SLS_JSON_CAP) + '\n…(已截断)' : text
}

// ── 结构化详情：扁平字段抽取 ─────────────────────────────────────────────────
/** 把条目压平成标量 KV：attribute/resource（字符串化 JSON）先展开，
 *  顶层标量字段后放并覆盖同名键；对象/数组不进 KV（JSON 页签看全量）。 */
function flatScalars(e: SlsLogEntry): Record<string, string> {
  const out: Record<string, string> = {}
  const put = function (k: string, v: unknown) {
    if (v === null || v === undefined || typeof v === 'object') return
    const s = String(v)
    if (!s) return
    if (out[k] === undefined) out[k] = s
  }
  for (const k of ['attribute', 'resource']) {
    const raw = e[k]
    if (typeof raw === 'string' && raw.trim().startsWith('{')) {
      try {
        const o: unknown = JSON.parse(raw)
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          for (const kk of Object.keys(o as Record<string, unknown>)) put(kk, (o as Record<string, unknown>)[kk])
        }
      } catch (err) { /* 非法 JSON 原样留在 JSON 页签 */ }
    }
  }
  for (const k of Object.keys(e)) {
    if (k === 'attribute' || k === 'resource') continue
    if (typeof e[k] === 'object') continue
    put(k, e[k])
  }
  return out
}

const SQL_HEAD_RE = /^\s*(select|insert|update|delete|replace|with|create|drop|alter|truncate|show|call)\b/i

export type SlsKv = { k: string; v: string; copy?: string }

export type SlsEntryInfo = {
  basics: SlsKv[]
  extras: SlsKv[]       // 重要扩展字段（默认展示）
  extrasMore: SlsKv[]   // 其余扩展字段（默认折叠，点「展开其余」才渲染）
  sql: string | null
  content: string | null
}

/** 条目 → 结构化详情模型：已知键取友好标签进「基本信息」，db.statement
 *  （或摘要中的 SQL 文本）进 SQL，其余标量按 SLS_EXTRA_IMPORTANT_RE 分成
 *  重要扩展字段（extras，默认展示）与其余（extrasMore，默认折叠）。 */
function describeEntry(e: SlsLogEntry): SlsEntryInfo {
  const f = flatScalars(e)
  const basics: SlsKv[] = []
  const used = new Set<string>(['name', 'start', 'end'])
  const take = function (key: string, label: string) {
    used.add(key)
    if (f[key]) basics.push({ k: label, v: f[key] })
  }
  const trace = typeof e.traceID === 'string' && e.traceID ? e.traceID : null
  if (trace) { used.add('traceID'); basics.push({ k: 'TraceID', v: trace, copy: trace }) }
  // 时间：span start（µs，毫秒精度）优先，退回 __time__；附原始时间戳
  const tFull = fmtSpanTimeFull(e.start)
  if (tFull) basics.push({ k: '时间', v: f.__time__ ? tFull + '（时间戳：' + f.__time__ + '）' : tFull })
  else if (f.__time__) basics.push({ k: '时间', v: (fmtSlsTime(f.__time__) || f.__time__) + '（时间戳：' + f.__time__ + '）' })
  used.add('__time__')
  take('__source__', '来源 IP')
  take('service', '服务名')
  take('statusCode', '状态')
  take('level', '级别')
  take('kind', 'Span 类型')
  take('db.connection_string', '数据库连接')
  take('db.sql.table', '数据库表')
  take('db.operation', '操作类型')
  if (e.duration != null && e.duration !== '') {
    used.add('duration')
    const d = fmtDurationUs(e.duration)
    if (d) basics.push({ k: '执行耗时', v: d })
  }
  take('thread.name', '线程名')
  take('server.address', '服务器地址')
  // SQL：db.statement 优先，退回摘要字段里像 SQL 的文本
  let sql: string | null = null
  if (f['db.statement']) { sql = f['db.statement']; used.add('db.statement') }
  if (!sql) {
    for (const k of ['name', 'content', 'message', 'log.message']) {
      const v = e[k]
      if (typeof v === 'string' && v && SQL_HEAD_RE.test(v)) { sql = v; used.add(k); break }
    }
  }
  // 纯文本日志正文（name 已作标题，不重复）
  let content: string | null = null
  for (const k of ['content', 'message', 'log.message']) {
    const v = e[k]
    if (typeof v === 'string' && v && v !== sql) { content = v; used.add(k); break }
  }
  const seenVals = new Set<string>(basics.map(function (b) { return b.v }))
  const extras: SlsKv[] = []
  const extrasMore: SlsKv[] = []
  for (const k of Object.keys(f)) {
    if (used.has(k)) continue
    if (extras.length + extrasMore.length >= SLS_EXTRA_CAP) break
    const v = f[k]
    // 与基本信息同值的冗余键（host == __source__ 之类）不再重复展示
    if (seenVals.has(v)) continue
    seenVals.add(v)
    const row = { k: k, v: v }
    if (SLS_EXTRA_IMPORTANT_RE.test(k)) extras.push(row)
    else extrasMore.push(row)
  }
  return { basics: basics, extras: extras, extrasMore: extrasMore, sql: sql, content: content }
}

/** 扩展字段单行 KV（key 灰 / value 主色，title 悬停可看完整 k=v）。 */
function extraKv(row: SlsKv, key: string) {
  return h('div', { key: key, className: 'wb-sls-kv', title: row.k + ' = ' + row.v },
    h('span', { className: 'wb-sls-kv-k' }, row.k),
    h('span', { className: 'wb-sls-kv-v' }, row.v))
}

// ── SQL 高亮：逐行 tokenize（关键字/字符串/数字/注释/函数分色）───────────────
const SQL_KW = new Set(('select,from,where,and,or,not,null,is,in,like,between,as,on,join,left,right,' +
  'inner,outer,cross,group,order,by,limit,offset,having,distinct,union,all,insert,into,values,' +
  'update,set,delete,create,drop,alter,truncate,case,when,then,else,end,exists,asc,desc,use,show').split(','))

function sqlLineNodes(line: string, no: number, key: string) {
  const toks: any[] = []
  const re = /('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|--.*$|\/\*.*?\*\/|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\s+|.)/g
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(line))) {
    const t = m[0]
    let cls = ''
    if (/^(--|\/\*)/.test(t)) cls = 'wb-sls-sqlcom'
    else if (/^['"`]/.test(t)) cls = 'wb-sls-sqlstr'
    else if (/^\d/.test(t)) cls = 'wb-sls-sqlnum'
    else if (/^[A-Za-z_]/.test(t)) {
      if (SQL_KW.has(t.toLowerCase())) cls = 'wb-sls-sqlkw'
      else if (line[re.lastIndex] === '(') cls = 'wb-sls-sqlfn'
    }
    toks.push(cls ? h('span', { key: 't' + i++, className: cls }, t) : t)
  }
  // token 必须收进单个容器：sqlline 是 flex，token 若做直接子节点会被压成
  // min-content 竖排（长语句换行时 SELECT 变成 S/E/L/E/C/T）。
  return h('div', { key: key, className: 'wb-sls-sqlline' },
    h('span', { key: 'n', className: 'wb-sls-sqlno' }, String(no)),
    h('span', { key: 'c', className: 'wb-sls-sqlcode' }, toks))
}

/** SQL 语句 → 带行号 + 分色的 vnode 列表。 */
function sqlNodes(sql: string): any[] {
  const lines = sql.replace(/\r/g, '').split('\n')
  return lines.map(function (ln, i) { return sqlLineNodes(ln, i + 1, 'l' + i) })
}

// ── 展开视图：JSON 缩进树（把字符串化的 JSON 字段解开渲染）──────────────────
/** 递归把「看起来是 JSON 的字符串」parse 成结构（最多 depth 层），
 *  消掉 attribute/resource/logs/links 里的 `\"` 转义；parse 失败原样保留。 */
function unwrapJsonStrings(v: unknown, depth: number): unknown {
  if (typeof v === 'string') {
    const s = v.trim()
    if (depth > 0 && ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')))) {
      try { return unwrapJsonStrings(JSON.parse(s), depth - 1) } catch (e) { return v }
    }
    return v
  }
  if (Array.isArray(v)) return v.map(function (x) { return unwrapJsonStrings(x, depth) })
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    const src = v as Record<string, unknown>
    for (const k of Object.keys(src)) o[k] = unwrapJsonStrings(src[k], depth)
    return o
  }
  return v
}

type JsonSt = { n: number; capped: boolean }

function jline(indent: string, kids: any[], key: string) {
  return h('div', { key: key, className: 'wb-sls-jline', style: { paddingLeft: indent.length + 'ch' } }, kids)
}

function jspan(cls: string, text: string) {
  return h('span', { className: cls }, text)
}

/** 递归渲染缩进树；超出 SLS_JSON_LINES 行后停止并补一行截断标记。 */
function pushJson(v: unknown, indent: string, key: string | null, out: any[], st: JsonSt): void {
  if (st.n >= SLS_JSON_LINES) {
    if (!st.capped) {
      st.capped = true
      out.push(h('div', { key: 'cap' + out.length, className: 'wb-sls-jline' }, jspan('wb-sls-jcap', '…(已截断)')))
    }
    return
  }
  st.n++
  const kids: any[] = []
  if (key !== null) kids.push(jspan('wb-sls-jkey', JSON.stringify(key) + ': '))
  const line = function (cls: string) { out.push(jline(indent, kids, 'j' + out.length)) }
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'undefined') {
    kids.push(jspan('wb-sls-jnum', v === undefined ? 'undefined' : String(v)))
    line('wb-sls-jline')
  } else if (typeof v === 'string') {
    kids.push(jspan('wb-sls-jstr', JSON.stringify(v)))
    line('wb-sls-jline')
  } else if (Array.isArray(v)) {
    if (!v.length) { kids.push(jspan('wb-sls-jpunc', '[]')); line('wb-sls-jline'); return }
    kids.push(jspan('wb-sls-jpunc', '['))
    line('wb-sls-jline')
    for (const item of v) pushJson(item, indent + '  ', null, out, st)
    if (st.n < SLS_JSON_LINES) out.push(jline(indent, [jspan('wb-sls-jpunc', ']')], 'j' + out.length))
  } else if (typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>)
    if (!keys.length) { kids.push(jspan('wb-sls-jpunc', '{}')); line('wb-sls-jline'); return }
    kids.push(jspan('wb-sls-jpunc', '{'))
    line('wb-sls-jline')
    const src = v as Record<string, unknown>
    for (const k of keys) pushJson(src[k], indent + '  ', k, out, st)
    if (st.n < SLS_JSON_LINES) out.push(jline(indent, [jspan('wb-sls-jpunc', '}')], 'j' + out.length))
  } else {
    kids.push(jspan('wb-sls-jnum', String(v)))
    line('wb-sls-jline')
  }
}

/** JSON 页签的 vnode 列表：解开嵌套 JSON + 逐行分色；「复制 JSON」仍用原始串。 */
function entryJsonNodes(e: SlsLogEntry): any[] {
  const st: JsonSt = { n: 0, capped: false }
  const out: any[] = []
  pushJson(unwrapJsonStrings(e, SLS_JSON_DEPTH), '', null, out, st)
  return out
}

function copyText(text: string): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {})
      return true
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch (e) {
    return false
  }
}

export { copyText }

// ── 瀑布视图：按 traceID 分组的 span 时间条 ──────────────────────────────────
type WfSpan = {
  sid: string
  parent: string
  name: string
  kind: string
  s: number
  e: number
  err: boolean
  depth: number
}
type WfGroup = { trace: string; spans: WfSpan[]; t0: number; t1: number }

/** 条目是否带可绘制的 span 时间字段（start/end，epoch 微秒）。 */
function isSpanLike(e: SlsLogEntry): boolean {
  const s = Number(e.start)
  const en = Number(e.end)
  return isFinite(s) && isFinite(en) && s > 0 && en >= s
}

/** `* | select …` 分析模式：line/offset 无效，翻页交给 SQL 的 LIMIT。 */
function isSqlMode(query: string): boolean {
  return /\|/.test(query)
}

/** 把 span 条目按 traceID 分组并算出每组的 [t0,t1] 与父子缩进层级；
 *  trace 按最近结束时间排序，最多 SLS_WF_TRACE_CAP 组。 */
function buildWaterfall(logs: SlsLogEntry[]): WfGroup[] {
  const groups = new Map<string, WfSpan[]>()
  for (const e of logs) {
    if (!isSpanLike(e)) continue
    const trace = typeof e.traceID === 'string' && e.traceID ? e.traceID : '(无 traceID)'
    let list = groups.get(trace)
    if (!list) groups.set(trace, list = [])
    list.push({
      sid: typeof e.spanID === 'string' ? e.spanID : '',
      parent: typeof e.parentSpanID === 'string' ? e.parentSpanID : '',
      name: entryTitle(e),
      kind: typeof e.kind === 'string' ? e.kind : '',
      s: Number(e.start),
      e: Number(e.end),
      err: /error/i.test(String(e.statusCode || '')),
      depth: 0,
    })
  }
  const out: WfGroup[] = []
  for (const [trace, spans] of groups) {
    const bySid = new Map<string, WfSpan>()
    for (const sp of spans) if (sp.sid) bySid.set(sp.sid, sp)
    for (const sp of spans) {
      // 沿 parentSpanID 向上数层级；环与缺失父节点都安全终止
      const seen = new Set<string>()
      let d = 0
      let cur = sp
      while (cur.parent && bySid.has(cur.parent) && !seen.has(cur.sid) && d < 6) {
        seen.add(cur.sid)
        const next = bySid.get(cur.parent) as WfSpan
        if (!next || next === cur) break
        cur = next
        d++
      }
      sp.depth = d
    }
    spans.sort(function (a, b) { return a.s - b.s || a.depth - b.depth })
    let t0 = Infinity
    let t1 = -Infinity
    for (const sp of spans) { if (sp.s < t0) t0 = sp.s; if (sp.e > t1) t1 = sp.e }
    if (!isFinite(t0) || !isFinite(t1)) continue
    out.push({ trace: trace, spans: spans, t0: t0, t1: t1 })
  }
  out.sort(function (a, b) { return b.t1 - a.t1 })
  return out.slice(0, SLS_WF_TRACE_CAP)
}

// ── SQL 语句块（详情右栏与 SQL 页签共用，带一键复制；DMS 工单详情复用同一
//    块渲染与 wb-sls-sql* 样式，title/onCopy 可定制，不传 onCopy 时隐藏复制）──
export function SqlBlock(props: { sql: string; copied?: boolean; onCopy?(): void; title?: string }) {
  return h('div', { className: 'wb-sls-sqlwrap' },
    h('div', { className: 'wb-sls-sqlhead' },
      h('span', { className: 'wb-sls-dhead' }, props.title || 'SQL 语句'),
      h('span', { className: 'wb-bar-spacer' }),
      props.onCopy ? h('button', {
        type: 'button',
        className: 'wb-sls-act' + (props.copied ? ' wb-sls-act-done' : ''),
        title: '复制 SQL 语句',
        onClick: props.onCopy,
      }, props.copied ? '已复制' : '复制') : null),
    h('pre', { className: 'wb-sls-sql' }, sqlNodes(props.sql)))
}

// ── entry card（单行头 + 详情/SQL/JSON 三页签）──────────────────────────────
function SlsEntry(props: {
  entry: SlsLogEntry
  index: number
  expanded: Set<number>
  onToggle(i: number): void
  onTrace(trace: string): void
}) {
  // 复制反馈：'trace' | 'json' | 'sql' | ''（1.4s 瞬态，卸载时清计时器）
  const [copied, setCopied] = React.useState('')
  const [tab, setTab] = React.useState<'detail' | 'sql' | 'json'>('detail')
  const [extrasOpen, setExtrasOpen] = React.useState(false) // 扩展字段折叠区，默认收起
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(function () {
    return function () { if (timer.current) clearTimeout(timer.current) }
  }, [])
  function flashCopied(what: string) {
    setCopied(what)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(function () { setCopied('') }, 1400)
  }
  const e = props.entry
  const open = props.expanded.has(props.index)
  const info = React.useMemo(function () { return describeEntry(e) }, [e])
  const trace = typeof e.traceID === 'string' && e.traceID ? e.traceID : null
  const svc = typeof e.service === 'string' && e.service ? e.service : null
  const ip = typeof e.__source__ === 'string' && e.__source__
    ? e.__source__
    : (typeof e.host === 'string' && e.host ? e.host : null)
  const dur = e.duration != null && e.duration !== ''
    ? (fmtDurationUs(e.duration) || String(e.duration))
    : null
  // 状态只在异常时显示（Ok/Unset 不占位），复用语义色规则
  const status = typeof e.statusCode === 'string' && e.statusCode && !/^unset$/i.test(e.statusCode)
    ? e.statusCode : null
  const statusKind = status ? partKind(status) : 'plain'
  const headTime = fmtSpanTime(e.start) || (e.__time__ ? fmtSlsTime(e.__time__) : null)

  function tabBtn(label: string, id: 'detail' | 'sql' | 'json') {
    return h('button', {
      key: id,
      type: 'button',
      className: 'wb-sls-tab' + (tab === id ? ' wb-sls-tab-active' : ''),
      'aria-pressed': tab === id,
      onClick: function (ev: { stopPropagation(): void }) { ev.stopPropagation(); setTab(id) },
    }, label)
  }

  /** SQL 复制（详情右栏 / SQL 页签共用一份 copied 状态）。 */
  function sqlBlock() {
    if (!info.sql) return null
    return h(SqlBlock, {
      sql: info.sql,
      copied: copied === 'sql',
      onCopy: function () { if (copyText(info.sql as string)) flashCopied('sql') },
    })
  }

  /** 详情页签：左基本信息（KV + TraceID 可复制），右 SQL + 扩展字段，正文独占下方整行。
   *  扩展字段只默认展示重要键（extras），其余折叠在「展开其余 N 项」按钮后。 */
  function detailNodes() {
    const moreOpen = extrasOpen && info.extrasMore.length > 0
    return h('div', { className: 'wb-sls-detail' },
      h('div', { className: 'wb-sls-dcol' },
        h('div', { className: 'wb-sls-dhead' }, '基本信息'),
        info.basics.map(function (row, i) {
          return h('div', { key: String(i), className: 'wb-sls-kv' },
            h('span', { className: 'wb-sls-kv-k' }, row.k),
            h('span', { className: 'wb-sls-kv-v', title: row.v }, row.v),
            row.copy ? h('button', {
              className: 'wb-sls-kvcopy',
              title: '复制',
              onClick: function (ev: { stopPropagation(): void }) {
                ev.stopPropagation()
                if (copyText(row.copy as string)) flashCopied('trace')
              },
            }, copied === 'trace' ? '✓' : '⧉') : null)
        })),
      h('div', { className: 'wb-sls-dcol' },
        info.sql ? sqlBlock() : null,
        info.extras.length || info.extrasMore.length
          ? h('div', { className: 'wb-sls-dhead' }, '扩展字段') : null,
        info.extras.length || moreOpen
          ? h('div', { className: 'wb-sls-extras' },
              info.extras.map(function (row, i) { return extraKv(row, 'e' + i) }),
              moreOpen ? info.extrasMore.map(function (row, i) { return extraKv(row, 'm' + i) }) : null)
          : null,
        info.extrasMore.length ? h('button', {
          type: 'button',
          className: 'wb-sls-extras-toggle',
          'aria-expanded': moreOpen,
          title: moreOpen ? '收起其余扩展字段' : '展开其余 ' + info.extrasMore.length + ' 个扩展字段',
          onClick: function (ev: { stopPropagation(): void }) {
            ev.stopPropagation()
            setExtrasOpen(!moreOpen)
          },
        },
          h('span', { className: 'wb-sls-chevron' + (moreOpen ? ' wb-sls-chevron-open' : '') }, chevronGlyph(12)),
          moreOpen ? '收起其余字段' : '展开其余 ' + info.extrasMore.length + ' 项') : null),
      info.content ? h('pre', { className: 'wb-sls-content' }, info.content) : null)
  }

  const head = h('div', {
    className: 'wb-sls-entry-head',
    title: '点击展开/收起详情',
    onClick: function () { props.onToggle(props.index) },
  },
    h('button', { type: 'button', className: 'wb-sls-toggle', 'aria-label': (open ? '收起日志 ' : '展开日志 ') + entryTitle(e), 'aria-expanded': open,
      onClick: function (ev: { stopPropagation(): void }) { ev.stopPropagation(); props.onToggle(props.index) } },
      h('span', { className: 'wb-sls-chevron' + (open ? ' wb-sls-chevron-open' : '') }, chevronGlyph(14))),
    headTime ? h('span', { className: 'wb-sls-time' }, headTime) : null,
    h('span', { className: 'wb-sls-title' }, entryTitle(e)),
    // 固定宽度数据列：无条件渲染（缺数据留空占位），各行纵向对齐——
    // 否则标题弹性宽度 + 条件字段会让 ERROR/耗时/IP/trace 列逐行漂移
    h('span', { className: 'wb-sls-hcell wb-sls-hsvc' },
      svc ? h('span', { className: 'wb-sls-svctag', title: '服务名' }, svc) : null),
    h('span', { className: 'wb-sls-hcell wb-sls-hstatus' },
      status && statusKind !== 'plain'
        ? h('span', { className: 'wb-sls-svctag wb-sls-tag-' + statusKind }, status)
        : null),
    h('span', { className: 'wb-sls-hcell wb-sls-hdur' }, dur || null),
    h('span', { className: 'wb-sls-hcell wb-sls-hip' }, ip || null),
    h('span', { className: 'wb-sls-hcell wb-sls-htrace' },
      trace ? h('button', {
        type: 'button',
        className: 'wb-sls-trace',
        title: '点击以此 traceID 重新查询',
        onClick: function (ev: { stopPropagation(): void }) { ev.stopPropagation(); props.onTrace(trace) },
      }, 'trace=' + trace) : null),
    h('span', { className: 'wb-sls-actions' },
      trace ? h('button', {
        key: 'ctrace',
        type: 'button',
        className: 'wb-sls-act' + (copied === 'trace' ? ' wb-sls-act-done' : ''),
        title: '复制完整 traceID',
        onClick: function (ev: { stopPropagation(): void }) {
          ev.stopPropagation()
          if (copyText(trace)) flashCopied('trace')
        },
      }, copied === 'trace' ? '已复制' : '复制 trace') : null,
      h('button', {
        key: 'cjson',
        type: 'button',
        className: 'wb-sls-act' + (copied === 'json' ? ' wb-sls-act-done' : ''),
        title: '复制原始 JSON',
        onClick: function (ev: { stopPropagation(): void }) {
          ev.stopPropagation()
          if (copyText(JSON.stringify(e))) flashCopied('json')
        },
      }, copied === 'json' ? '已复制' : '复制 JSON')))

  const body = open ? h('div', { className: 'wb-sls-body' },
    h('div', { className: 'wb-sls-tabs' },
      tabBtn('详情', 'detail'),
      info.sql ? tabBtn('SQL', 'sql') : null,
      tabBtn('JSON', 'json')),
    tab === 'json'
      ? h('pre', { className: 'wb-sls-json' }, entryJsonNodes(e))
      : tab === 'sql' && info.sql
        ? sqlBlock()
        : detailNodes())
    : null

  return h('div', { className: 'wb-sls-entry' + (open ? ' wb-sls-entry-open' : '') }, head, body)
}

// ── panel ───────────────────────────────────────────────────────────────────
export function SlsPanel(props: FrameworkProps) {
  // 输入值（inputs）与已提交查询（committed）分离：只在点「查询」/快捷区间时
  // 才真正调 /sls/query，避免每敲一个字符就查询一次。
  const [inputs, setInputs] = React.useState(function () {
    const p = loadSlsPrefs()
    const to = Math.floor(Date.now() / 1000)
    const from = to - 3600 // 默认最近 1 小时
    // 配置了环境时 project/logstore 由环境下拉映射；未配置时以已保存偏好预填
    // 手填输入框（旧偏好里的 project 对不上任何环境时由 resolveEnv 回落第一个）。
    return {
      project: String(p.project || '').trim(),
      dataType: p.dataType === 'logs' ? 'logs' : p.dataType === 'traces' ? 'traces' : 'all',
      logstore: String(p.logstore || '').trim(),
      line: String(p.line || SLS_DEFAULT_LINE),
      reverse: String(p.reverse || 'false'),
      query: String(p.query || ''),
      fromText: epochToDtLocal(from),
      toText: epochToDtLocal(to),
    }
  })
  const [committed, setCommitted] = React.useState(function () {
    return { project: '', logstore: '', from: 0, to: 0, query: '', line: '', reverse: '' }
  })
  const [status, setStatus] = React.useState<SlsStatusPayload | null>(null)
  const [result, setResult] = React.useState<SlsQueryResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [expanded, setExpanded] = React.useState<Set<number>>(function () { return new Set() })
  const [more, setMore] = React.useState(false)            // 还可能有下一页（batch 打满行数）
  const [view, setView] = React.useState<'list' | 'wf'>('list') // 列表 / 瀑布

  const [combined, setCombined] = React.useState<Array<{ logstore: string; result: SlsQueryResult | null; error: string | null; more: boolean }>>([])
  const [recentQueries, setRecentQueries] = React.useState(loadRecentQueries)

  // 部署配置的 SLS 环境（status 未返回前视为未配置）。activeEnv = 当前 project
  // 命中的环境（对不上回落第一个），未配置时为 null；activeProject/activeLogstore
  // 是实际要查询的目标（未配置时取手填输入）。
  const environments = statusEnvironments(status)
  const activeEnv = resolveEnv(environments, inputs.project)
  const activeProject = activeEnv ? activeEnv.project : inputs.project.trim()
  const activeLogstore = activeEnv
    ? (inputs.dataType === 'logs' ? activeEnv.logs : activeEnv.logstore)
    : inputs.logstore.trim()
  const ready = !!activeProject && !!activeLogstore

  const statusReqRef = React.useRef(0)
  const loadStatus = React.useCallback(async function (force: boolean) {
    const req = ++statusReqRef.current
    try {
      const data = await forgeFetch('/sls/status' + (force ? '?force=1' : ''))
      if (req !== statusReqRef.current) return
      setStatus(data)
    } catch (e) {
      if (req !== statusReqRef.current) return
      setStatus({
        ok: false,
        updatedAt: Date.now(),
        cli: { available: false, configured: false, activeRegion: null, error: String(e instanceof Error ? e.message : e) },
      })
    }
  }, [])

  useLayout(function () {
    loadStatus(false)
  }, [loadStatus])

  function setField(key: keyof typeof inputs, value: string) {
    setInputs(function (prev) { return Object.assign({}, prev, { [key]: value }) })
  }

  function toggleEntry(i: number) {
    setExpanded(function (prev) {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  // opts.preset：快捷区间已算好的 [from,to]，跳过 datetime-local 解析；
  // opts.queryOverride：trace 下钻等场景直接以给定查询语句提交（同时回填输入框）。
  // 返回查询是否成功（快捷区间据此决定是否折叠表单）。
  async function runQuery(opts?: { preset?: { from: number; to: number }; queryOverride?: string; trace?: boolean }): Promise<boolean> {
    if (busy) return false // 查询进行中拒绝重入（按钮已禁用，这里兜底防重复提交）
    let from: number | null
    let to: number | null
    if (opts && opts.preset) {
      from = opts.preset.from
      to = opts.preset.to
    } else {
      from = dtLocalToEpoch(inputs.fromText)
      to = dtLocalToEpoch(inputs.toText)
      // 相对快捷区间每次查询重算：chip 命中（区间未被手动改动）且非 trace 下钻
      // 时，以「现在」为终点重新推起止时间，避免反复用同一个陈旧窗口。
      const active = !(opts && opts.queryOverride != null) ? activePreset() : null
      if (active) {
        const p = RANGE_PRESETS.find(function (x) { return x.label === active })
        if (p) {
          to = Math.floor(Date.now() / 1000)
          from = to - p.seconds
          setInputs(function (prev) {
            return Object.assign({}, prev, {
              fromText: epochToDtLocal(from as number),
              toText: epochToDtLocal(to as number),
            })
          })
        }
      }
    }
    if (from === null || to === null) {
      setError('请填写有效的时间范围')
      return false
    }
    if (from >= to) {
      setError('无效的时间区间：开始时间必须早于结束时间（[from, to) 左闭右开）')
      return false
    }
    const project = activeEnv ? activeEnv.project : inputs.project.trim()
    let logstore = activeEnv
      ? (inputs.dataType === 'logs' ? activeEnv.logs : activeEnv.logstore)
      : inputs.logstore.trim()
    // trace 下钻必须查 Trace 库：配置了环境就用环境的 logstore（未配置时手填的
    // logstore 本身就是唯一查询目标）。
    if (opts && opts.trace && activeEnv) logstore = activeEnv.logstore
    if (!project || !logstore) {
      setError('请先配置 SLS 环境（插件行 config 的 slsEnvironments），或填写 Project / Logstore')
      return false
    }
    const query = (opts && opts.queryOverride != null ? opts.queryOverride : inputs.query).trim()
    const line = inputs.line.trim()
    const reverse = inputs.reverse === 'true'
    if (query) {
      const recent = [query, ...recentQueries.filter(q => q !== query)].slice(0, 20)
      setRecentQueries(recent)
      saveSlsPrefs({ recentQueries: JSON.stringify(recent) })
    }
    setCommitted({ project, logstore, from, to, query, line, reverse: reverse ? 'true' : '' })
    saveSlsPrefs({ project, logstore, line, reverse: String(reverse), query, dataType: opts && opts.trace ? 'traces' : inputs.dataType, [opts && opts.trace ? 'tracesQuery' : inputs.dataType + 'Query']: query })
    setBusy(true)
    setError(null)
    let ok = false
    setCombined([])
    if (activeEnv && inputs.dataType === 'all' && !(opts && opts.trace)) {
      const env = activeEnv
      setResult(null)
      const groups = await Promise.all([env.logs, env.logstore].map(async function (store) {
        try {
          const data = await forgeFetch('/sls/query', { method: 'POST', body: {
            project, logstore: store, from: String(from), to: String(to),
            query: query || undefined, line: line || undefined, reverse: reverse ? 'true' : undefined,
          } })
          if (!data || !data.ok) throw new Error(data && data.error || '查询失败')
          const logs = Array.isArray(data.logs) ? data.logs : []
          return { logstore: store, result: data as SlsQueryResult, error: null,
            more: !isSqlMode(query) && logs.length >= (Number(line) || Number(SLS_DEFAULT_LINE)) }
        } catch (e) {
          return { logstore: store, result: null, error: String(e instanceof Error ? e.message : e), more: false }
        }
      }))
      setCombined(groups)
      setExpanded(new Set())
      setBusy(false)
      return groups.some(g => g.result !== null)
    }
    try {
      const data = await forgeFetch('/sls/query', {
        method: 'POST',
        body: {
          project,
          logstore,
          from: String(from),
          to: String(to),
          query: query || undefined,
          line: line || undefined,
          reverse: reverse ? 'true' : undefined,
        },
      })
      if (data && data.ok === false) {
        setError(data.error || '查询失败')
      } else {
        ok = true
        const batch = data && data.ok && Array.isArray(data.logs) ? data.logs : []
        setResult(data && data.ok ? data : { ok: true, logs: [], count: 0, progress: '', elapsedMs: null })
        // 整批返回（≥ 行数）才可能有下一页；SQL 分析模式翻页交给 LIMIT
        const effLine = Number(line) || Number(SLS_DEFAULT_LINE)
        setMore(!isSqlMode(query) && effLine > 0 && batch.length >= effLine)
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
    setBusy(false)
    return ok
  }

  const currentResult = result

  /** 加载更多：以已取条数作为 offset 追加下一页（同一 committed 查询）。 */
  async function loadMore(groupIndex?: number) {
    const group = groupIndex === undefined ? null : combined[groupIndex]
    const result = group ? group.result : currentResult
    if (!result || busy) return
    const prevLogs = Array.isArray(result.logs) ? result.logs : []
    const offset = prevLogs.length
    if (offset <= 0 || offset >= SLS_MORE_CAP) return
    setBusy(true)
    if (group) setCombined(prev => prev.map((g, i) => i === groupIndex ? { ...g, error: null } : g))
    else setError(null)
    try {
      const data = await forgeFetch('/sls/query', {
        method: 'POST',
        body: {
          project: committed.project || undefined,
          logstore: group ? group.logstore : committed.logstore || undefined,
          from: String(committed.from),
          to: String(committed.to),
          query: committed.query || undefined,
          line: committed.line || undefined,
          reverse: committed.reverse || undefined,
          offset: String(offset),
        },
      })
      if (data && data.ok === false) {
        throw new Error(data.error || '查询失败')
      } else if (data && data.ok) {
        const batch = Array.isArray(data.logs) ? data.logs : []
        const hasMore = !isSqlMode(committed.query) && batch.length >= (Number(committed.line) || Number(SLS_DEFAULT_LINE))
        if (group) {
          setCombined(prev => prev.map((g, i) => i === groupIndex ? { ...g, result: { ...data, logs: prevLogs.concat(batch), count: prevLogs.length + batch.length }, more: hasMore } : g))
        } else {
        setResult(function (prev) {
          const merged = (prev && Array.isArray(prev.logs) ? prev.logs : []).concat(batch)
          return Object.assign({}, data, { logs: merged, count: merged.length })
        })
        const effLine = Number(committed.line) || Number(SLS_DEFAULT_LINE)
        setMore(!isSqlMode(committed.query) && effLine > 0 && batch.length >= effLine)
        }
      }
    } catch (e) {
      const error = String(e instanceof Error ? e.message : e)
      if (group) setCombined(prev => prev.map((g, i) => i === groupIndex ? { ...g, error } : g))
      else setError(error)
    }
    setBusy(false)
  }

  function applyPreset(seconds: number) {
    const to = Math.floor(Date.now() / 1000)
    const from = to - seconds
    setInputs(function (prev) {
      return Object.assign({}, prev, { fromText: epochToDtLocal(from), toText: epochToDtLocal(to) })
    })
    // 表单保持展开：紧凑三行表单本身不占空间，查询后保留区间/chip 高亮便于继续调参
    void runQuery({ preset: { from: from, to: to } })
  }

  /** trace 下钻：以 traceID 作为查询语句重新查询（回填输入框并持久化）。 */
  function queryByTrace(trace: string) {
    if (busy) return
    const q = 'traceID: "' + trace + '"'
    const env = resolveEnv(environments, inputs.project)
    setInputs(function (prev) {
      return Object.assign({}, prev, { query: q, dataType: 'traces', logstore: env ? env.logstore : prev.logstore })
    })
    saveSlsPrefs({ query: q })
    void runQuery({ queryOverride: q, trace: true, preset: { from: committed.from, to: committed.to } })
  }

  /** 当前输入的时间范围命中的快捷区间 label；结束时间不在「现在」附近（>5min
   *  前的固定窗口）不算，避免陈旧范围误亮。 */
  function activePreset(): string | null {
    const from = dtLocalToEpoch(inputs.fromText)
    const to = dtLocalToEpoch(inputs.toText)
    if (from === null || to === null) return null
    if (Date.now() / 1000 - to > 300) return null
    const width = to - from
    for (const p of RANGE_PRESETS) if (p.seconds === width) return p.label
    return null
  }

  function applySource(key: string, dataType: string) {
    const env = environments.find(function (e) { return e.key === key }) || environments[0]
    if (!env) return
    const prefs = loadSlsPrefs()
    saveSlsPrefs({ [inputs.dataType + 'Query']: inputs.query })
    const query = dataType === inputs.dataType ? inputs.query : String(prefs[dataType + 'Query'] || '')
    const logstore = dataType === 'logs' ? env.logs : env.logstore
    setInputs(prev => Object.assign({}, prev, { project: env.project, logstore, dataType, query }))
    saveSlsPrefs({ project: env.project, logstore, dataType, query })
    setResult(null)
    setCombined([])
    setError(null)
    setMore(false)
    setExpanded(new Set())
    setView('list')
  }

  function clearQuery() {
    setInputs(function (prev) { return Object.assign({}, prev, { query: '' }) })
    setResult(null)
    setCombined([])
    setError(null)
    setMore(false)
    saveSlsPrefs({ query: '' })
  }

  // ── render ────────────────────────────────────────────────────────────────
  function renderToolbar() {
    const cli = status && status.cli ? status.cli as SlsCliStatus : null
    let cliMeta: string | null = null
    if (cli && cli.available && cli.configured) cliMeta = 'aliyun CLI 已登录'
    else if (cli && !cli.available) cliMeta = 'aliyun CLI 不可用'
    const target = committed.project
      ? committed.project + ' / ' + committed.logstore
      : (activeEnv ? activeEnv.project + ' / ' + activeEnv.logstore : '')
    return h('div', { className: 'wb-bar' },
      h('span', { className: 'wb-title' }, 'SLS'),
      target ? h('span', { className: 'wb-meta', style: { flex: 1, minWidth: 0 } }, target) : h('span', { className: 'wb-bar-spacer' }),
      cliMeta ? h('span', { className: 'wb-meta' }, cliMeta) : null,
      h('button', {
        className: 'glab-btn', disabled: busy,
        onClick: function () { loadStatus(true) },
        title: '刷新 CLI 状态',
        'aria-label': '刷新 CLI 状态',
      }, RefreshGlyph(busy))
    )
  }

  /** 紧凑三行表单：① 环境（或 Project/Logstore）+ 时间范围/行数/倒序
   *  ② 语句+按钮 ③ 快捷区间。未配置环境时展示手填 Project/Logstore 与配置提示。 */
  function renderForm() {
    const activeLabel = activePreset()
    const unconfigured = !environments.length
    return h('div', {
        className: 'wb-sls-form',
        onKeyDown: function (ev: { key: string; metaKey?: boolean; ctrlKey?: boolean; preventDefault(): void }) {
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !busy) {
            ev.preventDefault()
            void runQuery()
          }
        },
      },
      h('div', { className: 'wb-sls-frow' },
        activeEnv
          ? h('div', { className: 'wb-sls-field wb-sls-field-grow' },
            h('span', { className: 'wb-sls-flabel' }, '环境'),
            h('select', {
              className: 'glab-input wb-sls-finput wb-sls-envsel',
              'aria-label': '日志环境', value: activeEnv.key,
              disabled: busy,
              onChange: function (e: { target: { value: string } }) { applySource(e.target.value, inputs.dataType) },
            }, environments.map(function (env) {
              return h('option', { key: env.key, value: env.key }, env.label)
            })))
          : h('div', { className: 'wb-sls-field wb-sls-field-grow' },
            h('span', { className: 'wb-sls-flabel' }, 'Project'),
            h('input', {
              className: 'glab-input wb-sls-finput',
              'aria-label': 'Project', value: inputs.project,
              placeholder: 'project 名称', disabled: busy,
              onChange: function (e: { target: { value: string } }) { setField('project', e.target.value) },
            })),
        activeEnv
          ? h('div', { className: 'wb-sls-field' },
            h('span', { className: 'wb-sls-flabel' }, '数据类型'),
            h('select', {
              className: 'glab-input wb-sls-finput wb-sls-envsel',
              'aria-label': '数据类型', value: inputs.dataType, disabled: busy,
              onChange: function (e: { target: { value: string } }) { applySource(activeEnv.key, e.target.value) },
            }, h('option', { value: 'traces' }, 'Trace'), h('option', { value: 'logs' }, '日志'), h('option', { value: 'all' }, '全部（日志 + Trace）')))
          : h('div', { className: 'wb-sls-field wb-sls-field-grow' },
            h('span', { className: 'wb-sls-flabel' }, 'Logstore'),
            h('input', {
              className: 'glab-input wb-sls-finput',
              'aria-label': 'Logstore', value: inputs.logstore,
              placeholder: 'logstore 名称', disabled: busy,
              onChange: function (e: { target: { value: string } }) { setField('logstore', e.target.value) },
            })),
        h('div', { className: 'wb-sls-field wb-sls-field-range' },
          h('span', { className: 'wb-sls-flabel' }, '时间范围'),
          h('div', { className: 'wb-sls-range' },
            h('input', {
              className: 'glab-input wb-sls-finput',
              type: 'datetime-local',
              'aria-label': '开始时间', value: inputs.fromText,
              onChange: function (e: { target: { value: string } }) { setField('fromText', e.target.value) },
            }),
            h('span', { className: 'wb-sls-range-sep' }, '→'),
            h('input', {
              className: 'glab-input wb-sls-finput',
              type: 'datetime-local',
              'aria-label': '结束时间', value: inputs.toText,
              onChange: function (e: { target: { value: string } }) { setField('toText', e.target.value) },
            }))),
        h('div', { className: 'wb-sls-field wb-sls-field-line' },
          h('span', { className: 'wb-sls-flabel' }, '返回行数'),
          h('input', {
            className: 'glab-input wb-sls-finput',
            type: 'number',
            min: '1',
            'aria-label': '返回行数', value: inputs.line,
            placeholder: '100',
            onChange: function (e: { target: { value: string } }) { setField('line', e.target.value) },
          })),
        h('div', { className: 'wb-sls-field wb-sls-field-rev' },
          h('span', { className: 'wb-sls-flabel' }, '倒序'),
          h('label', { className: 'wb-sls-switch', title: '倒序（新者优先）' },
            h('input', {
              type: 'checkbox',
              'aria-label': '新日志优先', checked: inputs.reverse === 'true',
              onChange: function (e: { target: { checked: boolean } }) { setField('reverse', String(e.target.checked)) },
            }),
            h('span', { className: 'wb-sls-slider' })))),
      unconfigured && status ? h('div', { className: 'wb-sls-frow' },
        h('span', { className: 'wb-meta' },
          '未配置 SLS 环境：请在 DSH profile 的插件行 config 中设置 slsEnvironments（JSON 数组），' +
          '或直接填写上方 Project / Logstore。')) : null,
      h('div', { className: 'wb-sls-frow' },
        h('textarea', {
          className: 'glab-input wb-sls-qinput',
          rows: 1,
          placeholder: 'traceID: "xxx" 或 * | select count(*) as c from log',
          'aria-label': '日志查询语句', value: inputs.query,
          onChange: function (e: { target: { value: string } }) { setField('query', e.target.value) },
        }),
        h('div', { className: 'wb-sls-qbtns' },
          h('button', {
            className: 'glab-btn glab-btn-primary', disabled: busy || !ready,
            onClick: function () { void runQuery() },
            title: '执行 SLS 查询（get-logs-v2）',
          }, busy ? '查询中…' : '查询'),
          h('button', { className: 'glab-btn', disabled: busy, onClick: clearQuery, title: '清空查询语句与结果' }, '清空'))),
      h('div', { className: 'wb-sls-frow wb-sls-presets' },
        RANGE_PRESETS.map(function (p) {
          const active = activeLabel === p.label
          return h('button', {
            key: p.label,
            type: 'button',
            className: 'wb-sls-preset' + (active ? ' wb-sls-preset-active' : ''),
            'aria-pressed': active,
            disabled: busy || !ready,
            onClick: function () { applyPreset(p.seconds) },
          }, p.label)
        })),
      recentQueries.length ? h('div', { className: 'wb-sls-frow' },
        h('div', { className: 'wb-sls-field wb-sls-field-grow' }, h('select', {
          className: 'glab-input wb-sls-finput wb-sls-envsel',
          'aria-label': '最近查询', value: '', disabled: busy,
          onChange: function (e: { target: { value: string } }) { setField('query', e.target.value) },
        }, h('option', { value: '', disabled: true }, '最近查询（选择后回填）'),
        recentQueries.map(q => h('option', { key: q, value: q }, q)))),
        h('button', {
          className: 'glab-btn', disabled: busy, title: '清空最近查询记录',
          onClick: function () { setRecentQueries([]); saveSlsPrefs({ recentQueries: '[]' }) },
        }, '清空记录')) : null)
  }

  const currentError = error
  const currentMore = more

  function renderBody(groupIndex?: number): ReturnType<typeof h> {
    if (groupIndex === undefined && combined.length) {
      return h('div', { className: 'glab-body wb-sls-combined' }, combined.map((g, i) => h('section', { key: g.logstore },
        h('div', { className: 'wb-sls-summary' }, i === 0 ? '日志' : 'Trace', ' · ' + g.logstore), renderBody(i))))
    }
    const group = groupIndex === undefined ? null : combined[groupIndex]
    const result = group ? group.result : currentResult
    const error = group ? group.error : currentError
    const more = group ? group.more : currentMore
    const cli = status && status.cli ? status.cli as SlsCliStatus : null
    const err = error || (cli && cli.error ? cli.error : null)
    // 错误条与上次结果共存：查询失败只叠加错误提示，不把已有结果整块顶掉
    //（改个查询词重试即可，无需重新构造上下文）。
    const errBox = err ? h('div', { className: 'glab-error' }, err) : null
    if (!result) {
      return h('div', { className: 'glab-body' },
        err ? errBox : h(EmptyState, {
          title: '查询 SLS 日志',
          hint: environments.length
            ? '选择时间范围并输入查询语句'
            : '在插件行 config 配置 slsEnvironments，或填写 Project / Logstore 后查询',
        })
      )
    }
    const logs = Array.isArray(result.logs) ? result.logs : []
    // 「已取 N 条」：分页追加后是累计值（SLS 不回传命中总数）
    const summary = '已取 ' + logs.length + ' 条' +
      (result.elapsedMs != null ? ' · ' + result.elapsedMs + ' ms' : '') +
      (result.progress ? ' · ' + result.progress : '') +
      ' · ' + fmtEpoch(committed.from) + ' → ' + fmtEpoch(committed.to)
    const spanLike = logs.some(isSpanLike)
    const summaryRow = h('div', { className: 'wb-sls-summary' },
      h('span', { className: 'wb-meta' }, summary),
      spanLike ? h('span', { className: 'wb-sls-viewtog' },
        h('button', {
          type: 'button',
          className: 'wb-sls-vtog' + (view === 'list' ? ' wb-sls-vtog-active' : ''),
          title: '条目卡片列表',
          onClick: function () { setView('list') },
        }, '列表'),
        h('button', {
          type: 'button',
          className: 'wb-sls-vtog' + (view === 'wf' ? ' wb-sls-vtog-active' : ''),
          title: '按 traceID 分组的 span 瀑布图',
          onClick: function () { setView('wf') },
        }, '瀑布'),
      ) : null)
    if (!logs.length) {
      return h('div', { className: 'glab-body' },
        errBox,
        summaryRow,
        h(EmptyState, { title: '没有匹配的日志', hint: '扩大时间范围或调整查询语句' })
      )
    }
    const content = view === 'wf' && spanLike
      ? renderWaterfall(logs)
      : h('div', { className: 'glab-list' },
        logs.slice(0, 200).map(function (entry, i) {
          return h(SlsEntry, {
            key: i, entry: entry, index: i + (groupIndex === 1 ? SLS_MORE_CAP : 0), expanded: expanded, onToggle: toggleEntry,
            onTrace: queryByTrace,
          })
        }))
    return h('div', { className: 'glab-body' },
      errBox,
      summaryRow,
      content,
      more ? h('div', { className: 'wb-sls-more' },
        h('span', { className: 'wb-sls-more-hint' }, '已达单次返回行数上限，可能还有更多结果'),
        h('button', {
          className: 'glab-btn', disabled: busy,
          onClick: function () { void loadMore(groupIndex) },
          title: '以当前条数为 offset 取下一页',
        }, busy ? '加载中…' : '加载更多')
      ) : null
    )
  }

  /** 瀑布视图：trace 分组 + span 时间条（client span 蓝、Error 红、其余 accent）。 */
  function renderWaterfall(logs: SlsLogEntry[]) {
    const groups = buildWaterfall(logs)
    if (!groups.length) {
      return h(EmptyState, { title: '没有可绘制的 span', hint: '瀑布视图需要条目带 start / end（epoch 微秒）字段' })
    }
    return h('div', { className: 'wb-sls-wf' },
      groups.map(function (g) {
        const span = Math.max(g.t1 - g.t0, 1)
        return h('div', { key: g.trace, className: 'wb-sls-wf-trace' },
          h('div', { className: 'wb-sls-wf-head' },
            h('span', { className: 'wb-sls-wf-tid' },
              'trace=' + (g.trace.length > 14 ? g.trace.slice(0, 14) + '…' : g.trace)),
            h('span', { className: 'wb-sls-wf-meta' },
              g.spans.length + ' spans · ' + (fmtDurationUs(g.t1 - g.t0) || '') +
              ' · ' + (fmtSpanTime(g.t0) || ''))),
          g.spans.map(function (sp, i) {
            const left = Math.max(0, Math.min(100, ((sp.s - g.t0) / span) * 100))
            const width = Math.max(1, Math.min(100 - left, ((sp.e - sp.s) / span) * 100))
            return h('div', {
              key: String(i),
              className: 'wb-sls-wf-row',
              title: sp.name + (sp.kind ? ' · ' + sp.kind : ''),
            },
              h('span', { className: 'wb-sls-wf-label', style: { paddingLeft: sp.depth * 10 } }, sp.name),
              h('span', { className: 'wb-sls-wf-track' },
                h('span', {
                  className: 'wb-sls-wf-bar' +
                    (sp.err ? ' wb-sls-wf-bar-err' : sp.kind === 'client' ? ' wb-sls-wf-bar-client' : ''),
                  style: { left: left + '%', width: width + '%' },
                })),
              h('span', { className: 'wb-sls-wf-dur' }, fmtDurationUs(sp.e - sp.s) || ''))
          }))
      }))
  }

  return h('div', { className: 'glab-panel' },
    renderToolbar(),
    renderForm(),
    renderBody()
  )
}
