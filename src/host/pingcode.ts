// dsh-workbench — host PingCode domain: drives the pingcode skill's Python
// scripts (`python3 <skill>/scripts/api_call.py`) over the same trust shape
// as the DMS/SLS halves — credentials live in the skill's own `.env`, this
// half never touches keys. Every request is whitelisted: the HTTP method
// comes from an enum, the path from a fixed endpoint table, and values are
// passed as separate argv elements (argparse in the script parses them —
// nothing ever reaches a shell).
//
// api_call.py is the ONLY skill interface used here: the other scripts print
// human-formatted text, while api_call.py prints raw JSON (`--raw`) and
// encodes the pagination quirks (page_index is 0-based, some endpoints
// ignore page_size, `total` can lie — `--fetch-all` terminates on
// "returned fewer than the first page" instead of page*size>=total).
//
// Endpoints (phase 1, read-only):
//   GET /v1/pjm/projects         项目列表（--fetch-all）
//   GET /v1/pjm/work_items       工作项列表（project_id/type_id/assignee_id/
//                                 keywords/created_by + page/pageSize；
//                                 assigneeId=me 解析当前用户做服务端过滤）
//   GET /v1/pjm/work_item_states 全企业状态表（--fetch-all；is_system=1 系统态
//                                 的 type → id 集合，供状态分类过滤，缓存 1 小时）
//   POST /v1/pjm/work_items/search  状态分类过滤：assignee.id/project.id/type/
//                                 created_by.id + state.id in [系统态 id]
//                                 （page 1 附带四桶精确统计 stats）
//   GET /v1/pjm/work_items/{id}  工作项详情
//   GET /v1/comments             工作项评论（principal_type=work_item）
//   GET /v1/directory/users      企业成员（--fetch-all）
//   GET /v1/myself               当前用户（assigneeId=me 与 scope=created 的
//                                依赖；仅用户令牌可用，进程内缓存 10 分钟）
//
// Route wiring (with per-route caches and TTL checks) lives in index.ts's
// apply(); the deployment knob (skill directory) lives in config.ts.

import { constants as FsConstants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getConfig } from './config'
import type { HostContext, Runner } from './runner'
import { exeAvailable } from './runner'

export const PC_PYTHON = 'python3'
export const PC_SCRIPT = join('scripts', 'api_call.py')

/** state.type 分类（PingCode 状态对象自带 pending/in_progress/completed/closed），
 *  也是客户端状态快筛与服务端 stateType 过滤的规范键。挂起（suspended）没有
 *  独立的 state.type——它是 type=pending 的系统态，按名从 pending 桶拆出。 */
export const PC_STATE_TYPES: Record<string, string> = {
  pending: '待处理',
  suspended: '挂起',
  progress: '进行中',
  completed: '已完成',
  closed: '已关闭',
}

/** PingCode 状态对象的 type 与规范键的别名映射（API 用 in_progress，页面用 progress）。 */
const PC_STATE_TYPE_ALIAS: Record<string, string> = { in_progress: 'progress' }

function pcStateTypeKey(t: string): string {
  return PC_STATE_TYPE_ALIAS[t] || t
}

/** 挂起系统态按名识别（去首尾空白、小写比较的精确名）：state.type 只有四类，
 *  「挂起」混在 pending 里，唯一可靠信号是系统态名（中英文实例各一）。 */
const PC_SUSPENDED_NAMES = ['挂起', 'suspended']

function pcIsSuspendedName(name: string): boolean {
  return PC_SUSPENDED_NAMES.indexOf(String(name || '').trim().toLowerCase()) >= 0
}

/** 工作项视图的状态分类：挂起系统态单独成桶（suspended），其余按 state.type 归一。 */
function pcViewStateType(type: string, name: string): string {
  const t = pcStateTypeKey(type)
  return t === 'pending' && pcIsSuspendedName(name) ? 'suspended' : t
}

/** 工作项系统类型枚举（scrum/kanban 项目的固定类型）。 */
export const PC_WORK_ITEM_TYPES = ['epic', 'feature', 'story', 'task', 'bug', 'issue']

const PC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const PC_PAGE_MAX = 10000
const PC_PAGE_SIZE_MAX = 100
const PC_KEYWORDS_MAX = 200
const PC_NOTES_MAX = 200

// ── skill directory resolution ──────────────────────────────────────────────

function probeSkillDir(dir: string): boolean {
  try {
    readFileSync(join(dir, PC_SCRIPT))
    return true
  } catch (e) {
    return false
  }
}

/** Default candidates (in order): the conventional skill install locations. */
export function defaultSkillDirs(): string[] {
  let home = ''
  try { home = homedir() } catch (e) {}
  const out: string[] = []
  if (home) {
    out.push(join(home, '.agents', 'skills', 'pingcode'))
    out.push(join(home, '.workbuddy', 'skills', 'pingcode'))
  }
  return out
}

/** Resolve the skill directory: explicit config wins, else auto-detect.
 *  A candidate counts only if scripts/api_call.py is readable there. */
export function resolveSkillDir(configured?: string | null): string | null {
  const explicit = String(configured || '').trim()
  if (explicit) return probeSkillDir(explicit) ? explicit : null
  for (const dir of defaultSkillDirs()) {
    if (probeSkillDir(dir)) return dir
  }
  return null
}

function requireSkillDir(): string {
  const dir = resolveSkillDir(getConfig().pingcodeSkillDir)
  if (!dir) {
    throw new Error('未找到 PingCode 技能目录（默认 ' + defaultSkillDirs().join('、') +
      '，或在组合行 config 里配置 pingcodeSkillDir），需包含 scripts/api_call.py 与 .env')
  }
  return dir
}

// ── .env inspection (keys only — values never leave the host) ──────────────

/** Parse KEY=VALUE lines (skill-style .env) into a plain map. */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    const k = line.slice(0, i).trim()
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    if (k) out[k] = v
  }
  return out
}

/** Which credential set is present + auth mode + base URL (no values). */
export function pingcodeEnvState(env: Record<string, string>): {
  authMode: string
  clientCredentials: boolean
  userCredentials: boolean
  accessToken: boolean
  baseUrlConfigured: boolean
  baseUrl: string
} {
  const mode = String(env.PINGCODE_AUTH_MODE || '').toLowerCase().trim()
  return {
    authMode: mode === 'authorization_code' ? 'authorization_code' : 'client_credentials',
    clientCredentials: !!(env.PINGCODE_CLIENT_ID && env.PINGCODE_CLIENT_SECRET),
    userCredentials: !!(env.PINGCODE_USER_CLIENT_ID && env.PINGCODE_USER_CLIENT_SECRET),
    accessToken: !!env.PINGCODE_ACCESS_TOKEN,
    baseUrlConfigured: !!env.PINGCODE_BASE_URL,
    baseUrl: String(env.PINGCODE_BASE_URL || 'https://open.pingcode.com'),
  }
}

// ── whitelisted argv construction ──────────────────────────────────────────

export type PcMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const PC_METHODS: PcMethod[] = ['GET', 'POST', 'PATCH', 'DELETE']

export interface PcCall {
  method: PcMethod
  path: string
  params?: Record<string, string>
  /** POST/PATCH 的 JSON 请求体（独立 argv 元素；search 接口用）。 */
  body?: string
  fetchAll?: boolean
}

/** Build the `api_call.py …` argv (Runner 契约：exe 单独传 `python3`，subprocess
 *  服务会拼成 [python3, ...argv])。方法来自枚举，路径来自端点表（仅做防御性
 *  形状检查），参数与 body 都是独立 argv 元素——不进 shell、无选项注入。 */
export function buildApiCallArgv(skillDir: string, call: PcCall): string[] {
  if (!PC_METHODS.includes(call.method)) throw new Error('非法的方法：' + String(call.method))
  const path = String(call.path || '')
  if (!path.startsWith('/') || path.length > 200 || /[\r\n]/.test(path)) {
    throw new Error('非法路径：' + path.slice(0, 60))
  }
  const argv = [join(skillDir, PC_SCRIPT), call.method, path, '--raw']
  if (call.fetchAll) argv.push('--fetch-all')
  const params = call.params || {}
  const keys = Object.keys(params).filter((k) => params[k] !== '' && params[k] != null).sort()
  if (keys.length) {
    argv.push('--params')
    for (const k of keys) argv.push(k + '=' + String(params[k]))
  }
  const body = String(call.body || '')
  if (body) argv.push('--body', body)
  return argv
}

// ── param whitelists ───────────────────────────────────────────────────────

/** PingCode 对象 id（项目/工作项/成员）：字母数字、-、_，4..64 位。 */
function pcId(v: unknown, what: string): string {
  const s = String(v || '').trim()
  if (!PC_ID_RE.test(s)) throw new Error('缺少有效的' + what)
  return s
}

function pcKeywords(v: unknown): string | null {
  const s = String(v || '').trim().slice(0, PC_KEYWORDS_MAX)
  if (!s) return null
  if (s.startsWith('-')) throw new Error('无效的搜索词：不能以 - 开头')
  return s
}

function pcPage(v: unknown): number {
  const s = String(v || '').trim()
  if (!/^\d{1,5}$/.test(s)) return 1
  return Math.min(Math.max(Number(s), 1), PC_PAGE_MAX)
}

function pcPageSize(v: unknown): number {
  const s = String(v || '').trim()
  if (!/^\d{1,3}$/.test(s)) return 50
  return Math.min(Math.max(Number(s), 1), PC_PAGE_SIZE_MAX)
}

// ── runner helpers ─────────────────────────────────────────────────────────

/** Run python + argv; SDK-style errors print on stdout with exit code 1, so
 *  both streams are merged before classification (same as the aliyun halves). */
async function pcRun(runner: Runner, argv: string[]): Promise<string> {
  const r = await runner.tryRun(PC_PYTHON, argv, { graceMs: 30000 })
  if (r.code !== 0) {
    const text = (String(r.errText || '').trim() + '\n' + String(r.out || '').trim()).trim()
    throw new Error(text || PC_PYTHON + ' 退出码 ' + String(r.code))
  }
  return String(r.out || '')
}

/** Parse python stdout as JSON (object or array), tolerating leading noise. */
function pcJson(out: string): unknown {
  const text = String(out || '')
  let start = text.indexOf('{')
  const arrStart = text.indexOf('[')
  if (arrStart >= 0 && (start < 0 || arrStart < start)) start = arrStart
  if (start < 0) throw new Error('pingcode 脚本输出不是 JSON：' + text.slice(0, 120))
  return JSON.parse(text.slice(start))
}

/** 列表响应归一化：接受 {total, values} 或裸数组（--fetch-all 输出前者）。 */
export function parseListPayload(raw: unknown): { total: number; values: unknown[] } {
  if (Array.isArray(raw)) return { total: raw.length, values: raw }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const values = Array.isArray(o.values) ? o.values : []
    const n = Number(o.total ?? values.length)
    return { total: isFinite(n) ? n : values.length, values }
  }
  return { total: 0, values: [] }
}

/** PingCode 时间字段是 epoch 秒；统一转成毫秒（客户端的 Date 直接可用）。 */
function pcTs(v: unknown): number | null {
  const n = Number(v)
  return isFinite(n) && n > 0 ? Math.round(n * 1000) : null
}

// ── 富文本清洗（描述/评论是 HTML：白名单重序列化后才交给客户端渲染）─────────

/** 输入长度上限：描述/评论不该是巨字符串，超限截断（防御异常数据拖垮渲染）。 */
const PC_RICH_MAX = 200000
/** 标签 → 允许保留的属性。不在标签白名单里的元素被「解包」（丢标签留子内容），
 *  PC_RICH_DROP 里的元素连同内容整体丢弃。 */
const PC_RICH_ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
}
const PC_RICH_TAGS = new Set([
  'a', 'img', 'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
  'span', 'div', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
])
/** 连同内容一起丢弃的元素：浏览器也不把其内容当标记渲染，直接跳到闭标签。 */
const PC_RICH_DROP = new Set(['script', 'style', 'noscript', 'textarea', 'title', 'xmp', 'iframe', 'object', 'embed', 'svg', 'math', 'template'])
const PC_RICH_VOID = new Set(['br', 'hr', 'img'])
/** 开新标签时需要自动闭合的栈顶同级元素（浏览器同款规则，输出才规整）。 */
const PC_RICH_AUTOCLOSE: Record<string, string[]> = {
  p: ['p'], li: ['li'], tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'],
}
const PC_RICH_SCHEMES = new Set(['http', 'https', 'mailto'])
const PC_NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':' }

function pcIsAlpha(c: string): boolean { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }
function pcIsAlnum(c: string): boolean { return pcIsAlpha(c) || (c >= '0' && c <= '9') }
function pcIsSpace(c: string): boolean { return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' }

/** 解码数字与常见命名实体。URL 校验前必须先解码：否则 `javascript&#58;` 能
 *  绕过 scheme 白名单（浏览器解析属性值时会解码实体）。未知命名实体原样保留。 */
function pcDecodeEntities(v: string): string {
  return v.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, body: string) {
    if (body.charCodeAt(0) === 35) {
      const code = (body.charCodeAt(1) | 32) === 120 ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    const named = PC_NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? m : named
  })
}

function pcEscapeText(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 富文本正文文本节点的换行处理：作者在正文里敲的换行（\n）要能渲染出来，
 *  否则客户端 white-space:normal（为了不显示标签间排版换行）会把它折叠成一个
 *  空格、整段糊成一行。规则：
 *  - `<pre>` 内换行由浏览器保留，不再转（否则双重换行）；
 *  - 纯空白的换行（标签间排版残留，如 `</p>\n<p>`）保持折叠，不产 <br/>；
 *  - 段首/段尾的换行是排版残留，裁掉；
 *  - 其余 \n 转成 <br/>（\r\n、\r、&#10; 先归一成 \n）。 */
function pcEmitText(t: string, inPre: boolean): string {
  const d = pcDecodeEntities(t)
  const norm = d.replace(/\r\n?/g, '\n')
  if (inPre || norm.indexOf('\n') < 0 || !/[^\s]/.test(norm)) return pcEscapeText(norm)
  return pcEscapeText(norm.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br/>')
}

function pcEscapeAttr(t: string): string {
  return pcEscapeText(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** 安全 URL：scheme 必须在白名单内（在实体解码与去掉 tab/换行/控制符之后判——
 *  浏览器的 URL 解析会忽略这些字符，`java\tscript:` 必须拦）；无 scheme 的
 *  相对路径 / 锚点 / 协议相对按同站资源放行。 */
function pcSafeUrl(v: string): string | null {
  const cleaned = pcDecodeEntities(v).replace(/[\t\n\r\x00-\x1f]/g, '')
  const m = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (m && !PC_RICH_SCHEMES.has(m[1].toLowerCase())) return null
  return cleaned
}

/** PingCode 描述/评论是 HTML 富文本：整段重序列化——只重发白名单标签与属性
 *  （URL 过 scheme 白名单、正文转义、结构补闭合）。输出只由已验证的片段拼成，
 *  不依赖浏览器解析容错，因此没有 mXSS 走私面。无标签形制的纯文本原样返回
 *  （客户端按纯文本节点渲染，与旧 pre-wrap 行为一致）；含标签时 `&`/`<` 会被
 *  解码再转义成规范的 HTML，浏览器渲染结果与原文一致。 */
export function sanitizeRichText(input: unknown): string {
  const raw = String(input ?? '')
  if (!raw || !/<[a-zA-Z!/?]/.test(raw)) return raw
  let src = raw
  if (src.length > PC_RICH_MAX) src = src.slice(0, PC_RICH_MAX)
  let out = ''
  const stack: string[] = []
  const closeUntil = function (name: string): void {
    const at = stack.lastIndexOf(name)
    if (at < 0) return // 游离闭标签：丢弃
    for (let i = stack.length - 1; i >= at; i--) out += '</' + stack[i] + '>'
    stack.length = at
  }
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    const inPre = stack.indexOf('pre') >= 0
    if (lt < 0) { out += pcEmitText(src.slice(i), inPre); break }
    if (lt > i) out += pcEmitText(src.slice(i, lt), inPre)
    i = lt
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    const next = src[i + 1]
    if (next === '!' || next === '?') {
      const end = src.indexOf('>', i + 2)
      i = end < 0 ? n : end + 1
      continue
    }
    const closing = next === '/'
    let j = i + (closing ? 2 : 1)
    if (j >= n || !pcIsAlpha(src[j])) { out += '&lt;'; i++; continue } // `<` 不是标签开头 → 按正文
    let name = ''
    while (j < n && pcIsAlnum(src[j])) { name += src[j].toLowerCase(); j++ }
    if (closing) {
      while (j < n && src[j] !== '>') j++
      i = j < n ? j + 1 : n
      if (PC_RICH_TAGS.has(name)) closeUntil(name)
      continue
    }
    // 开标签：扫到未引号的 `>`（引号值里可以包 `>`），顺带收集属性
    const attrs: Array<[string, string | null]> = []
    let broken = true
    while (j <= n) {
      while (j < n && pcIsSpace(src[j])) j++
      if (j >= n) break
      const ch = src[j]
      if (ch === '>') { j++; broken = false; break }
      if (ch === '/') { j++; continue } // `/>`：void 元素本来就自闭合输出，非 void 与浏览器一样当开标签
      let an = ''
      while (j < n && !pcIsSpace(src[j]) && src[j] !== '=' && src[j] !== '>' && src[j] !== '/') { an += src[j]; j++ }
      if (!an) { j++; continue } // 孤立 `=` 等：跳过防死循环
      let k = j
      while (k < n && pcIsSpace(src[k])) k++
      let av: string | null = null
      if (src[k] === '=') {
        k++
        while (k < n && pcIsSpace(src[k])) k++
        const q = src[k]
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, k + 1)
          if (end < 0) { av = src.slice(k + 1); k = n } // 引号不闭合：吞到 EOF（同浏览器，整个标签随后被丢弃）
          else { av = src.slice(k + 1, end); k = end + 1 }
        } else {
          let uq = ''
          while (k < n && !pcIsSpace(src[k]) && src[k] !== '>') { uq += src[k]; k++ }
          av = uq
        }
        j = k
      }
      attrs.push([an.toLowerCase(), av])
    }
    if (broken) break // EOF 处未终止的标签：整体丢弃（同浏览器）
    i = j
    if (!PC_RICH_TAGS.has(name)) {
      if (PC_RICH_DROP.has(name)) {
        const mEnd = src.slice(i).match(new RegExp('</\\s*' + name + '[^>]*>', 'i'))
        i = mEnd ? i + (mEnd.index || 0) + mEnd[0].length : n
      }
      continue // 解包：不输出该标签，子内容照常走主循环
    }
    const ac = PC_RICH_AUTOCLOSE[name]
    if (ac) {
      while (stack.length && ac.indexOf(stack[stack.length - 1]) >= 0) closeUntil(stack[stack.length - 1])
    }
    const allowed = PC_RICH_ATTRS[name] || []
    const seen: Record<string, boolean> = {}
    let attrsOut = ''
    for (const pair of attrs) {
      const an = pair[0]
      if (allowed.indexOf(an) < 0 || seen[an]) continue // 重复属性首个生效（同浏览器）
      seen[an] = true
      const value = pair[1] === null ? '' : pair[1]
      let emitted: string | null = null
      if (an === 'href' || an === 'src') {
        const safe = pcSafeUrl(value.trim().slice(0, 2000))
        if (safe) emitted = an + '="' + pcEscapeAttr(safe) + '"'
      } else if (an === 'width' || an === 'height') {
        const v = value.trim().slice(0, 24)
        if (/^\d{1,5}(\.\d{1,16})?$/.test(v)) emitted = an + '="' + v + '"'
      } else { // alt / title：正文属性，解码后转义
        emitted = an + '="' + pcEscapeAttr(pcDecodeEntities(value.trim().slice(0, 500))) + '"'
      }
      if (emitted) attrsOut += ' ' + emitted
    }
    if (PC_RICH_VOID.has(name)) out += '<' + name + attrsOut + ' />'
    else { out += '<' + name + attrsOut + '>'; stack.push(name) }
  }
  for (let s = stack.length - 1; s >= 0; s--) out += '</' + stack[s] + '>'
  return out
}

// ── 文件链接 token（描述里的 /files/public/ 图片链接要带 public_image_token）──

const PC_FILE_TOKEN_TTL_MS = 5 * 60 * 1000
let pcFileBaseHostMemo: { dir: string; at: number; baseHost: string } | null = null

/** 测试隔离用：清空 base host 进程内缓存。 */
export function clearFileTokenCache(): void {
  pcFileBaseHostMemo = null
}

function pcHostOf(u: string): string {
  try { return new URL(u).host } catch (e) { return '' }
}

/** 私有部署的 base host（从技能 .env 的 PINGCODE_BASE_URL 取；公有云取不到时
 *  回退空串，*.pingcode.com 规则兜底）。只用于限制拼 token 的链接域，不是凭据。
 *  进程内缓存 5 分钟。 */
function pcFileBaseHost(): string {
  const dir = resolveSkillDir(getConfig().pingcodeSkillDir)
  if (!dir) return ''
  if (pcFileBaseHostMemo && pcFileBaseHostMemo.dir === dir && Date.now() - pcFileBaseHostMemo.at < PC_FILE_TOKEN_TTL_MS) {
    return pcFileBaseHostMemo.baseHost
  }
  let baseHost = ''
  try {
    const env = parseEnvLines(readFileSync(join(dir, '.env'), 'utf8'))
    baseHost = pcHostOf(pingcodeEnvState(env).baseUrl)
  } catch (e) {
    baseHost = ''
  }
  pcFileBaseHostMemo = { dir, at: Date.now(), baseHost }
  return baseHost
}

/** 撤销转义（sanitizeRichText 属性值只可能含这五种实体），改完再转义回去。 */
function pcUnescapeAttr(v: string): string {
  return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** 给 `/files/public/` 链接拼上图片访问令牌（PingCode 图片/附件直链的授权
 *  方式，与 PingCode 网页端一致；token 来自接口的 public_image_token，不是
 *  用户凭据）。已有 token 参数则替换；查询串用 & 续接。只对 base URL 同 host
 *  或 *.pingcode.com 的链接拼——异域链接即使长得像文件路径也不拼，防止把
 *  令牌送给第三方主机。 */
export function appendFileToken(html: string, token: string, baseHost: string): string {
  if (!html || !token) return html
  return html.replace(/(src|href)="(https?:\/\/[^"]+\/files\/public\/[^"]*)"/g, function (m, attr: string, url: string) {
    const host = pcHostOf(pcUnescapeAttr(url))
    if (!host || (host !== baseHost && !/(^|\.)pingcode\.com$/.test(host))) return m
    const clean = pcUnescapeAttr(url)
    let out: string
    if (/(?:\?|&)token=/.test(clean)) out = clean.replace(/((?:\?|&)token=)[^&]*/, '$1' + encodeURIComponent(token))
    else out = clean + (clean.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token)
    return attr + '="' + pcEscapeAttr(out) + '"'
  })
}

/** 富文本统一管线：白名单清洗 → 文件链接拼该项的 public_image_token。
 *  token 缺省（评论/项目接口不返回）时只清洗不拼。 */
function pcRich(v: unknown, token?: unknown): string {
  return appendFileToken(sanitizeRichText(v), String(token || ''), pcFileBaseHost())
}

// ── normalization (raw API values → compact views) ─────────────────────────

export function toProjectView(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const id = String(obj.id || '')
  if (!id) return null
  const st = obj.state && typeof obj.state === 'object' ? obj.state as Record<string, unknown> : null
  const asg = obj.assignee && typeof obj.assignee === 'object' ? obj.assignee as Record<string, unknown> : null
  return {
    id,
    name: String(obj.name || ''),
    type: String(obj.type || ''),
    state: st ? String(st.name || '') : '',
    assignee: asg ? String(asg.display_name || asg.name || '') : '',
    description: pcRich(obj.description),
  }
}

export function toWorkItemView(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const id = String(obj.id || '')
  if (!id) return null
  const st = obj.state && typeof obj.state === 'object' ? obj.state as Record<string, unknown> : null
  const pr = obj.priority && typeof obj.priority === 'object' ? obj.priority as Record<string, unknown> : null
  const asg = obj.assignee && typeof obj.assignee === 'object' ? obj.assignee as Record<string, unknown> : null
  const pj = obj.project && typeof obj.project === 'object' ? obj.project as Record<string, unknown> : null
  return {
    id,
    identifier: String(obj.identifier || ''),
    title: String(obj.title || ''),
    type: String(obj.type || ''),
    stateName: st ? String(st.name || '') : '',
    stateType: st ? pcViewStateType(String(st.type || ''), String(st.name || '')) : '',
    stateColor: st ? String(st.color || '') : '',
    priority: pr ? String(pr.name || '') : '',
    assignee: asg ? {
      id: String(asg.id || ''),
      name: String(asg.name || ''),
      displayName: String(asg.display_name || ''),
    } : null,
    project: pj ? {
      id: String(pj.id || ''),
      name: String(pj.name || ''),
      identifier: String(pj.identifier || ''),
    } : null,
    htmlUrl: String(obj.html_url || ''),
    description: pcRich(obj.description, obj.public_image_token),
    /** 能力旗标：本条富文本已过 sanitizeRichText，客户端才允许 innerHTML 渲染。
     *  旧 host（重启前）不带它——客户端对无旗标数据一律按纯文本渲染。 */
    rich: true,
    startAt: pcTs(obj.start_at),
    endAt: pcTs(obj.end_at),
    completedAt: pcTs(obj.completed_at),
  }
}

export function toMemberView(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const id = String(obj.id || '')
  if (!id) return null
  return {
    id,
    name: String(obj.name || ''),
    displayName: String(obj.display_name || obj.name || ''),
    email: String(obj.email || ''),
  }
}

export function toNoteView(o: unknown): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null
  const obj = o as Record<string, unknown>
  const id = String(obj.id || '')
  if (!id) return null
  const by = obj.created_by && typeof obj.created_by === 'object' ? obj.created_by as Record<string, unknown> : null
  return {
    id,
    author: by ? String(by.display_name || by.name || '') : '',
    content: pcRich(obj.content),
    rich: true,
    created_at: pcTs(obj.created_at),
    isReply: obj.is_reply_comment === 1 || obj.is_reply_comment === true,
  }
}

// ── loaders ─────────────────────────────────────────────────────────────────

export interface PingcodeStatusPayload {
  ok: boolean
  updatedAt: number
  python: { available: boolean }
  skill: { found: boolean; dir: string | null; scriptFound: boolean; error: string | null }
  env: {
    authMode: string
    clientCredentials: boolean
    userCredentials: boolean
    accessToken: boolean
    baseUrlConfigured: boolean
    baseUrl: string
  }
  probe: { ok: boolean; error: string | null; projectTotal: number | null }
}

/** 端到端探测：python3 可用？技能目录与脚本在？.env 配了哪种凭证？最后跑一次
 *  真实 API（projects 第一页）验证令牌可用。探测失败不抛出（状态页展示原因）。 */
export async function loadPingcodeStatus(ctx: HostContext, runner: Runner): Promise<PingcodeStatusPayload> {
  const data: PingcodeStatusPayload = {
    ok: true,
    updatedAt: Date.now(),
    python: { available: false },
    skill: { found: false, dir: null, scriptFound: false, error: null },
    env: pingcodeEnvState({}),
    probe: { ok: false, error: null, projectTotal: null },
  }
  data.python.available = await exeAvailable(runner, PC_PYTHON)
  const dir = resolveSkillDir(getConfig().pingcodeSkillDir)
  if (!dir) {
    data.skill.error = '未找到 PingCode 技能目录（默认 ' + defaultSkillDirs().join('、') +
      '），请在组合行 config 配置 pingcodeSkillDir'
  } else {
    data.skill.found = true
    data.skill.dir = dir
    data.skill.scriptFound = probeSkillDir(dir)
  }
  let envText = ''
  if (dir) {
    try { envText = readFileSync(join(dir, '.env'), 'utf8') } catch (e) {}
  }
  const env = pingcodeEnvState(parseEnvLines(envText))
  data.env = env
  const ready = data.python.available && data.skill.found && data.skill.scriptFound &&
    (env.clientCredentials || env.accessToken)
  if (!ready) {
    if (!data.python.available) data.skill.error = '未检测到 python3（brew install python3）'
    else if (data.skill.found && data.skill.scriptFound && !env.clientCredentials && !env.accessToken) {
      data.skill.error = '技能 .env 未配置凭证：请配置 PINGCODE_CLIENT_ID/SECRET（企业令牌）或运行 auth_user.py（用户令牌）'
    }
    return data
  }
  if (!dir) return data // ready 蕴含 dir 非空；显式窄化供类型检查
  try {
    const argv = buildApiCallArgv(dir, {
      method: 'GET',
      path: '/v1/pjm/projects',
      params: { page_size: '1', page_index: '0' },
    })
    const { total } = parseListPayload(pcJson(await pcRun(runner, argv)))
    data.probe = { ok: true, error: null, projectTotal: total }
  } catch (e) {
    data.probe = { ok: false, error: classifyPingcodeError(e), projectTotal: null }
  }
  return data
}

/** 项目列表（--fetch-all 全量，宿主缓存压频）。 */
export async function loadPingcodeProjects(ctx: HostContext, runner: Runner): Promise<Record<string, unknown>> {
  const dir = requireSkillDir()
  const raw = pcJson(await pcRun(runner, buildApiCallArgv(dir, {
    method: 'GET',
    path: '/v1/pjm/projects',
    fetchAll: true,
  })))
  const { total, values } = parseListPayload(raw)
  return {
    ok: true,
    updatedAt: Date.now(),
    total,
    projects: values.map(toProjectView).filter((v): v is Record<string, unknown> => v !== null),
  }
}

export interface PcWorkItemsQuery {
  projectId?: unknown
  typeId?: unknown
  /** 负责人 id；特殊值 `me` = 当前用户（/v1/myself 解析，仅用户令牌可用）。 */
  assigneeId?: unknown
  keywords?: unknown
  /** all（默认）| created（我创建的，需用户令牌解析 /v1/myself）。 */
  scope?: unknown
  /** pending | progress | completed | closed：服务端按状态分类过滤（search 接口
   *  `state.id in [系统态 id]`）。缺省/空 = 全部状态。PingCode 不支持按
   *  state.type 直接过滤，但状态是全企业共享的（GET /v1/pjm/work_item_states，
   *  系统态 is_system=1 可过滤，自定义态被 search 拒绝 100044）。 */
  stateType?: unknown
  page?: unknown
  pageSize?: unknown
}

/** 工作项列表：服务端过滤（项目/类型/负责人/关键词/我创建的/状态分类）+ 分页。
 *  stateType 走 search 接口（state.id in 系统态 id），其余走列表接口；page 1
 *  附带四桶精确统计 stats（search total，失败退 null 不拖垮列表）。 */
export async function loadPingcodeWorkItems(ctx: HostContext, runner: Runner, q: PcWorkItemsQuery): Promise<Record<string, unknown>> {
  const dir = requireSkillDir()
  const stateType = String(q.stateType || '').trim()
  if (stateType && !PC_STATE_TYPES[stateType]) {
    throw new Error('无效的状态筛选 stateType（' + Object.keys(PC_STATE_TYPES).join('/') + '）')
  }
  const projectId = String(q.projectId || '').trim()
  if (projectId) pcId(projectId, '项目 id（projectId）')
  const typeId = String(q.typeId || '').trim()
  if (typeId && !PC_WORK_ITEM_TYPES.includes(typeId)) {
    throw new Error('无效的工作项类型 typeId（' + PC_WORK_ITEM_TYPES.join('/') + '）')
  }
  const assigneeRaw = String(q.assigneeId || '').trim()
  const scope = String(q.scope || '').trim()
  if (scope && scope !== 'all' && scope !== 'created') {
    throw new Error('无效的 scope（all / created）')
  }
  // 两个互不依赖的前置查询先并行发起：/v1/myself（me/created 用）与状态表
  // （stateType 用，1 小时进程内缓存）；随后主查询与四桶统计再并行。
  const needMe = assigneeRaw === 'me' || scope === 'created'
  const meP = needMe ? myselfInfo(runner, dir) : Promise.resolve(null)
  const statesP = stateType ? pcStatesByType(runner, dir) : Promise.resolve(null)
  // statesP 可能全程没人 await：meP 失败会先抛出，参数校验（负责人 id / 关键词）
  // 也可能先抛出，函数提前返回。此时它的拒绝若无人处理就是进程级
  // unhandledRejection——宿主的 fail-loud 处理器会打印 dsh: fatal load failure
  // 并 exit(1) 杀掉整个 Host（实测崩溃日志 crash-*-host.log 即此路径）。这里先挂
  // no-op handler 只标记「已处理」；后面 await statesP 该抛还是照抛，错误分类不变
  // （同 loadPingcodeWorkItem 里的 notesP）。
  void statesP.catch(() => {})
  let me: { id: string; displayName: string } | null = null
  let assigneeId = ''
  let createdBy = ''
  if (needMe) {
    const info = (await meP) as { id: string; displayName: string }
    if (assigneeRaw === 'me') {
      me = { id: info.id, displayName: info.displayName }
      assigneeId = pcId(info.id, '当前用户 id')
    }
    if (scope === 'created') createdBy = pcId(info.id, '当前用户 id')
  } else if (assigneeRaw) {
    assigneeId = pcId(assigneeRaw, '负责人 id（assigneeId）')
  }
  const keywords = pcKeywords(q.keywords)
  const page = pcPage(q.page)
  const pageSize = pcPageSize(q.pageSize)

  const dims = { assigneeId, projectId, typeId, createdBy, keywords }
  let mainP: Promise<{ total: number; values: unknown[] }>
  if (stateType) {
    // stateType 分支下 statesP 必为 pcStatesByType（非 null）
    const ids = (await statesP)![stateType] || []
    if (!ids.length) throw new Error('PingCode 未找到「' + PC_STATE_TYPES[stateType] + '」状态的系统态')
    const filter: Record<string, unknown> = {}
    if (assigneeId) filter['assignee.id'] = { in: [assigneeId] }
    if (projectId) filter['project.id'] = { in: [projectId] }
    if (typeId) filter['type'] = { in: [typeId] }
    if (createdBy) filter['created_by.id'] = { in: [createdBy] }
    filter['state.id'] = { in: ids }
    mainP = pcSearch(runner, dir, filter, keywords, page, pageSize)
  } else {
    const params: Record<string, string> = {}
    if (projectId) params.project_id = projectId
    if (typeId) params.type_id = typeId
    if (assigneeId) params.assignee_id = assigneeId
    if (keywords) params.keywords = keywords
    if (createdBy) params.created_by = createdBy
    // 带图片令牌：响应里每项才有 public_image_token，描述里的图片链接才能拼上
    params.include_public_image_token = 'description'
    params.page_size = String(pageSize)
    params.page_index = String(page - 1) // PingCode page_index 从 0 开始
    mainP = pcRun(runner, buildApiCallArgv(dir, { method: 'GET', path: '/v1/pjm/work_items', params }))
      .then(pcJson).then(pcCheckBusinessError).then(parseListPayload)
  }
  // 统计与主查询互不依赖：并行发起，等待从「串行相加」降为「取最大」
  const statsP = page === 1 ? pcLoadStateStats(runner, dir, dims) : Promise.resolve(null)
  const main = await mainP
  const stats = await statsP
  return Object.assign({
    ok: true,
    updatedAt: Date.now(),
    total: main.total,
    page,
    pageSize,
    workitems: main.values.map(toWorkItemView).filter((v): v is Record<string, unknown> => v !== null),
  }, me ? { me: { id: me.id, displayName: me.displayName } } : {}, stats ? { stats } : {})
}

// ── search 接口（state.id in 系统态 id）+ 四桶统计 ──────────────────────────

/** 业务错误识别：api_call.py 对 HTTP 200 + code/message 的业务错误照常 exit 0
 *  打印 JSON（如 search 的 100044）——不识别就会静默当空结果。 */
function pcCheckBusinessError(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (typeof o.code === 'string' && typeof o.message === 'string' && o.total === undefined) {
      throw new Error('PingCode 接口错误 ' + o.code + '：' + String(o.message))
    }
  }
  return raw
}

function pcSleep(ms: number): Promise<void> {
  return new Promise(function (r) { setTimeout(r, ms) })
}

/** search 接口（POST --body）。实测 `state.id in` 存在间歇性 100044 窗口
 *  （约 1-2 分钟自愈）：首次 100044 睡 300ms 重试一次，仍失败则抛可读错误。 */
async function pcSearch(
  runner: Runner, dir: string, filter: Record<string, unknown>, keywords: string | null,
  page: number, pageSize: number,
): Promise<{ total: number; values: unknown[] }> {
  const payload: Record<string, unknown> = { filter, page_size: pageSize, page_index: page - 1 }
  if (keywords) payload.keywords = keywords
  // 带图片令牌：结果项才有 public_image_token，描述里的图片链接才能拼上
  payload.include_public_image_token = 'description'
  const body = JSON.stringify({ mode: 'query', payload })
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = pcJson(await pcRun(runner, buildApiCallArgv(dir, {
        method: 'POST', path: '/v1/pjm/work_items/search', body,
      })))
      return parseListPayload(pcCheckBusinessError(raw))
    } catch (e) {
      lastErr = e
      if (attempt === 0 && /100044/.test(String(e))) {
        await pcSleep(300)
        continue
      }
      throw e
    }
  }
  throw lastErr
}

/** 状态表缓存（1 小时）：状态全企业共享、数量小、极少变。 */
const PC_STATES_TTL_MS = 60 * 60 * 1000
let pcStatesMemo: { dir: string; at: number; byType: Record<string, string[]> } | null = null

/** 测试隔离用：清空状态表进程内缓存。 */
export function clearStatesCache(): void {
  pcStatesMemo = null
}

/** 各状态分类的系统态 id（is_system=1；自定义态被 search 过滤拒绝 100044）。 */
async function pcStatesByType(runner: Runner, dir: string): Promise<Record<string, string[]>> {
  if (pcStatesMemo && pcStatesMemo.dir === dir && Date.now() - pcStatesMemo.at < PC_STATES_TTL_MS) {
    return pcStatesMemo.byType
  }
  const raw = pcJson(await pcRun(runner, buildApiCallArgv(dir, {
    method: 'GET', path: '/v1/pjm/work_item_states', fetchAll: true,
  })))
  const { values } = parseListPayload(pcCheckBusinessError(raw))
  const byType: Record<string, string[]> = {}
  for (const v of values) {
    const o = v as Record<string, unknown>
    if (o.is_system !== 1 && o.is_system !== true) continue // 自定义态不可过滤
    const t = pcStateTypeKey(String(o.type || ''))
    const id = String(o.id || '')
    if (!t || !id) continue
    // 挂起是 type=pending 的系统态：按名拆出单独成桶，待处理桶不再含它
    const bucket = t === 'pending' && pcIsSuspendedName(String(o.name || '')) ? 'suspended' : t
    ;(byType[bucket] = byType[bucket] || []).push(id)
  }
  pcStatesMemo = { dir, at: Date.now(), byType }
  return byType
}

/** 四桶精确统计（pending/progress/completed/closed）：每桶一个 search total。
 *  任一桶失败则整体退 null——统计是锦上添花，不拖垮列表（客户端退回本地计数）。 */
async function pcLoadStateStats(
  runner: Runner, dir: string,
  dims: { assigneeId: string; projectId: string; typeId: string; createdBy: string; keywords: string | null },
): Promise<Record<string, number> | null> {
  try {
    const byType = await pcStatesByType(runner, dir)
    // 四桶互不依赖：并行发起（每桶一个 search total），任一失败整体退 null
    const entries = Object.keys(PC_STATE_TYPES).map(async (t) => {
      const ids = byType[t] || []
      if (!ids.length) return [t, 0] as const
      const filter: Record<string, unknown> = {}
      if (dims.assigneeId) filter['assignee.id'] = { in: [dims.assigneeId] }
      if (dims.projectId) filter['project.id'] = { in: [dims.projectId] }
      if (dims.typeId) filter['type'] = { in: [dims.typeId] }
      if (dims.createdBy) filter['created_by.id'] = { in: [dims.createdBy] }
      filter['state.id'] = { in: ids }
      const r = await pcSearch(runner, dir, filter, dims.keywords, 1, 1)
      return [t, r.total] as const
    })
    const out: Record<string, number> = {}
    for (const [t, n] of await Promise.all(entries)) out[t] = n
    return out
  } catch (e) {
    return null
  }
}

/** 当前用户（/v1/myself 仅用户令牌可用）：assigneeId=me 与 scope=created 的
 *  依赖。进程内缓存 10 分钟——列表分页/心跳重拉不必每次都多打一发。 */
const MYSELF_TTL_MS = 10 * 60 * 1000
let myselfMemo: { dir: string; id: string; displayName: string; at: number } | null = null

/** 测试隔离用：清空 myself 进程内缓存。 */
export function clearMyselfCache(): void {
  myselfMemo = null
}

async function myselfInfo(runner: Runner, dir: string): Promise<{ id: string; displayName: string }> {
  if (myselfMemo && myselfMemo.dir === dir && Date.now() - myselfMemo.at < MYSELF_TTL_MS) {
    return { id: myselfMemo.id, displayName: myselfMemo.displayName }
  }
  const raw = pcJson(await pcRun(runner, buildApiCallArgv(dir, { method: 'GET', path: '/v1/myself' })))
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  const id = o ? String(o.id || '') : ''
  if (!id) throw new Error('无法解析当前用户（/v1/myself 未返回 id）')
  const info = { id, displayName: o ? String(o.display_name || o.name || '') : '' }
  myselfMemo = Object.assign({ dir, at: Date.now() }, info)
  return info
}

/** 工作项详情 + 评论（评论失败不拖垮详情主体，与 forge 详情同一形态）。 */
export async function loadPingcodeWorkItem(ctx: HostContext, runner: Runner, q: Record<string, unknown>): Promise<Record<string, unknown>> {
  const dir = requireSkillDir()
  const id = pcId(q.id, '工作项 id（id）')
  // 详情与评论互不依赖：同时发起，等待从「串行相加」降为「取最大」
  // （评论失败兜底为空数组，不拖垮详情；catch 提前挂上避免 unhandledRejection）。
  const detailP = pcRun(runner, buildApiCallArgv(dir, {
    method: 'GET',
    path: '/v1/pjm/work_items/' + id,
    params: { include_public_image_token: 'description' },
  }))
  const notesP = pcRun(runner, buildApiCallArgv(dir, {
    method: 'GET',
    path: '/v1/comments',
    params: { principal_type: 'work_item', principal_id: id },
    fetchAll: true,
  })).then(pcJson).catch(() => null)
  const raw = pcJson(await detailP)
  const view = toWorkItemView(raw)
  if (!view) throw new Error('工作项 ' + id + ' 查询失败：接口未返回数据')
  let notes: unknown[] = []
  try {
    const notesRaw = await notesP
    if (notesRaw) {
    const { values } = parseListPayload(notesRaw)
    notes = values.map(toNoteView).filter((v): v is Record<string, unknown> => v !== null)
      .sort((a, b) => {
        const at = Number((a as Record<string, unknown>).created_at || 0)
        const bt = Number((b as Record<string, unknown>).created_at || 0)
        return at - bt
      })
      .slice(0, PC_NOTES_MAX)
    }
  } catch (e) {
    notes = []
  }
  return { ok: true, updatedAt: Date.now(), workitem: Object.assign(view, { notes }) }
}

/** 企业成员列表（负责人筛选用）。 */
export async function loadPingcodeMembers(ctx: HostContext, runner: Runner): Promise<Record<string, unknown>> {
  const dir = requireSkillDir()
  const raw = pcJson(await pcRun(runner, buildApiCallArgv(dir, {
    method: 'GET',
    path: '/v1/directory/users',
    fetchAll: true,
  })))
  const { total, values } = parseListPayload(raw)
  return {
    ok: true,
    updatedAt: Date.now(),
    total,
    members: values.map(toMemberView).filter((v): v is Record<string, unknown> => v !== null),
  }
}

// ── error classification ────────────────────────────────────────────────────

export function classifyPingcodeError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err).trim()
  const low = text.toLowerCase()
  if (/未找到 PingCode 技能目录/.test(text)) return text
  if (/未检测到 python3|command not found|enoent|no such file|not recognized/.test(low)) {
    return '未检测到 python3（PingCode 集成依赖本机 python3：brew install python3）'
  }
  if (/需要配置 PINGCODE_ACCESS_TOKEN|请运行以下命令完成授权|请运行.*auth_user/.test(low)) {
    return 'PingCode 用户令牌未配置或已过期（30 天有效期）：请运行 python3 <技能目录>/scripts/auth_user.py 重新授权'
  }
  if (/缺少.*凭证|缺少 PingCode 应用凭证|获取令牌失败|invalid_client|unauthorized/.test(low)) {
    return 'PingCode 应用凭证无效：请检查技能 .env（企业令牌 PINGCODE_CLIENT_ID/SECRET，或用户令牌凭证）'
  }
  const m = text.match(/⚠️ HTTP (\d{3})/)
  if (m) {
    const code = Number(m[1])
    if (code === 401) return 'PingCode 令牌无效或已过期（30 天有效期）：请运行 python3 <技能目录>/scripts/auth_user.py 重新授权'
    if (code === 403) return 'PingCode 应用无权限访问该数据：请在应用管理配置数据访问范围'
    if (code === 404) return 'PingCode 资源不存在（404）：项目/工作项可能已删除，或 id 不正确'
    if (code === 429) return 'PingCode 接口限流（每分钟 200 次）：请稍后重试'
    return 'PingCode 接口返回 HTTP ' + code
  }
  if (/<!doctype html|<!DOCTYPE|text\/html/.test(low)) {
    return 'PingCode 返回了 HTML 页面而非 JSON：请检查 PINGCODE_BASE_URL 是否缺少 /open 前缀（私有部署）'
  }
  if (/could not resolve host|getaddrinfo|network|timeout|timed out|connection refused|connection error/.test(low)) {
    return '网络错误：无法连接 PingCode（' + text.slice(0, 120) + '）'
  }
  return text || 'PingCode 请求失败'
}
