// dsh-workbench — 技能管理 page (SkillPanel), driven by the skills.sh `npx
// skills` CLI and DSH's own skill roots through the host /skills/* routes.
//
// 数据来自 host 的 /skills/* 路由（见 src/host/skills.ts）：
//   /skills/status   CLI/Node 探测 + DSH 技能根 + 可安装的 agent 目标
//   /skills/list     已装技能（直接读技能根，不跑 CLI）
//   /skills/search   skills.sh 公开搜索端点（/api/search）
//   /skills/detail   某技能的 SKILL.md + frontmatter + 支持文件清单
//   /skills/file     某技能内单个支持文件的正文（详情页按需读取；图片按上限
//                    内联成 data URL）
//   /skills/install|remove|update|discover  写操作（CLI）
//
// 页面分两个视图（常挂载、display 切换，切换不丢各自状态）：
//   - 已安装：本机 DSH 技能根下的技能；点名称 / 「详情」进**独立详情页**
//     （列表↔详情原地互换，同 Issues 页）：左侧文件树（SKILL.md + references/
//     等支持文件），右侧按文件类型只读渲染当前文件（Markdown 排版 / 代码·配置
//     语法高亮 / CSV·TSV 表格 / .env 键值表 / 图片内联预览 / 纯文本）；
//     SKILL.md 里指向技能内文件的相对链接在页内打开对应文件；卸载（二次确认）；
//     顶部「检查更新」只读比较来源指纹；「更新全部」跑 CLI update。
//   - 发现技能：搜索 skills.sh 目录 + 一键安装（包来源 / 指定技能名 / 作用域 /
//     目标 agent / copy 模式）。
//
// 安装落点（写错会让用户装到读不到的地方）：
//   - 作用域 global = `~/.agents/skills`（DSH 的全局技能根，默认）；
//     project = `<工作区>/.agents/skills`。
//   - 目标 agent 的 id 直接交给 CLI 的 `--agent`；DSH 默认目标 universal 在
//     global 下的落点恰好就是 `~/.agents/skills`。真正的路径由 CLI 决定并回传。
//   - 装了其它 agent（claude-code / codex …）的技能，DSH 不一定读得到——只有
//     universal/zed 的 global 根与项目级 .agents/skills 在 DSH 的发现范围内，
//     界面据此给出提示。
//
// SKILL.md 与支持文件都是外部内容，只做只读渲染：Markdown 走本地 renderMarkdown
// 生成 React 元素（纯文本节点，无 innerHTML，链接只允许 http/https），代码/配置
// 交给宿主的 shiki CodeBlock primitive，图片只呈现 host 内联的 data:image data URL；
// 宿主缺少 primitive 或文件过大时一律降级为纯文本，不自己拼 HTML。

import { React, h, CodeBlockPrimitive } from '../react'
import { forgeFetch, useWsData } from '../runtime'
import { Chip, EmptyState, RefreshGlyph, skillIcon, externalGlyph, searchGlyph, gearGlyph, checkGlyph } from '../icons'
import { ToastOutlet, ToastStack, useToasts } from './common'
import { ConfirmDialog, type ConfirmRequest } from './confirmdialog'
import type { FrameworkProps } from './props'

// ── 安装目标与作用域（纯数据，供 UI 与测试）────────────────────────────────

/** 安装目标 agent（与 host 的 SKILL_AGENTS 对应；universal 是 DSH 默认目标）。 */
export const SKILLS_TARGET_AGENTS: Array<{ id: string; label: string }> = [
  { id: 'universal', label: '通用（DSH 默认）' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'github-copilot', label: 'GitHub Copilot' },
]

export const SKILLS_INSTALL_SCOPES: Array<{ id: 'global' | 'project'; label: string; hint: string }> = [
  { id: 'global', label: '全局', hint: '~/.agents/skills（所有 DSH 工作区可用）' },
  { id: 'project', label: '当前工作区', hint: '<工作区>/.agents/skills（只对当前工作区生效）' },
]

/** 已停用徽标的悬停说明（徽标文案保持「已停用」两个字，避免把卡片头部撑高）。 */
const DISABLED_HINT = '已停用：模型不再自动触发（disable-model-invocation）；文件保留，可随时启用'

/** 发现页的快捷搜索词（skills.sh 公开搜索端点要求 ≥2 字符）。 */
export const SKILLS_SEARCH_PRESETS: Array<{ id: string; label: string; query: string }> = [
  { id: 'git', label: 'Git / 提交', query: 'git commit' },
  { id: 'review', label: '代码评审', query: 'code review' },
  { id: 'test', label: '测试', query: 'testing' },
  { id: 'docs', label: '文档写作', query: 'documentation' },
  { id: 'frontend', label: '前端 UI', query: 'frontend design' },
  { id: 'refactor', label: '重构', query: 'refactoring' },
]

const AGENT_IDS = SKILLS_TARGET_AGENTS.map(function (a) { return a.id })

export function isSkillScope(v: unknown): v is 'global' | 'project' {
  return v === 'global' || v === 'project'
}

/** 归一安装请求体：作用域白名单（非法回落 global）、agent 白名单去重
 *  （空 = universal）、技能名去空去重、copy 默认 true（技能文件真落到目标根，
 *  绕开 CLI 对部分 agent 的 symlink 默认；显式 copy:false 才关）。 */
export function buildSkillInstallBody(input: {
  package?: unknown
  skills?: unknown
  scope?: unknown
  agents?: unknown
  copy?: unknown
  cwd?: unknown
}): { package: string; skills: string[]; scope: 'global' | 'project'; agents: string[]; copy: boolean; cwd: string | null } {
  let pkg = String((input && input.package) == null ? '' : (input && input.package)).trim()
  let linkedSkill = ''
  if (pkg.startsWith('https://skills.sh/')) {
    const parts = new URL(pkg).pathname.split('/').filter(Boolean)
    if (parts.length === 3) { pkg = parts.slice(0, 2).join('/'); linkedSkill = parts[2] }
  }
  const rawSkills = input && Array.isArray(input.skills) ? input.skills : []
  const skills: string[] = []
  for (const s of rawSkills) {
    const name = String(s == null ? '' : s).trim()
    if (name && skills.indexOf(name) < 0) skills.push(name)
  }
  if (!skills.length && linkedSkill) skills.push(linkedSkill)
  const rawAgents = input && Array.isArray(input.agents) ? input.agents : []
  const agents: string[] = []
  for (const a of rawAgents) {
    const id = String(a == null ? '' : a).trim()
    if (AGENT_IDS.indexOf(id) >= 0 && agents.indexOf(id) < 0) agents.push(id)
  }
  if (!agents.length) agents.push('universal')
  const cwd = String((input && input.cwd) == null ? '' : (input && input.cwd)).trim() || null
  return {
    package: pkg,
    skills: skills,
    scope: input && isSkillScope(input.scope) ? input.scope : 'global',
    agents: agents,
    copy: !(input && input.copy === false),
    cwd: cwd,
  }
}

/** 已装技能列表的本地过滤（名称 / 描述子串，大小写不敏感）。 */
export function installedMatchesQuery(skill: { name?: unknown; description?: unknown }, q: unknown): boolean {
  const needle = String(q == null ? '' : q).trim().toLowerCase()
  if (!needle) return true
  const name = String((skill && skill.name) == null ? '' : skill!.name).toLowerCase()
  const desc = String((skill && skill.description) == null ? '' : skill!.description).toLowerCase()
  return name.indexOf(needle) >= 0 || desc.indexOf(needle) >= 0
}

/** agent 列表的展示文案（空 = 未探测到；逗号连接，最多 3 个后省略号）。 */
export function skillAgentLabel(agents: unknown): string {
  const list = Array.isArray(agents) ? agents.map(function (a) { return String(a) }).filter(Boolean) : []
  if (!list.length) return '—'
  if (list.length <= 3) return list.join(', ')
  return list.slice(0, 3).join(', ') + '…'
}

/** 安装量：1234567 → 1.2M；12345 → 12.3K；950 → 950；无效 → ''。 */
export function formatInstalls(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : NaN
  if (!isFinite(v) || v < 0) return ''
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K'
  return String(Math.round(v))
}

function formatBytes(n: unknown): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0
  if (v >= 1048576) return (v / 1048576).toFixed(1).replace(/\.0$/, '') + 'MB'
  if (v >= 1024) return (v / 1024).toFixed(1).replace(/\.0$/, '') + 'KB'
  return String(Math.round(v)) + 'B'
}

// ── 详情页文件浏览（纯数据，供 UI 与测试）──────────────────────────────────

export interface SkillFileEntry { path: string; sizeBytes: number }

/** 技能文件的渲染方式（按路径判定；host 的 kind 只作为「是否二进制/图片」的事实
 *  来源）：Markdown 走只读排版，代码/配置走宿主共享高亮器，JSON 走可展开树，
 *  CSV/TSV 走表格，`.env` 走键值表，图片走内联预览，其余按纯文本。 */
export type SkillFileView = 'markdown' | 'code' | 'json' | 'table' | 'env' | 'image' | 'text'

/** 表格 / 键值预览的行列上限：只预览前 N 行并在页内标注，避免大文件卡住面板。 */
export const SKILL_TABLE_MAX_ROWS = 200
export const SKILL_TABLE_MAX_COLS = 30
export const SKILL_ENV_MAX_ROWS = 200

const SKILL_MARKDOWN_EXT = /\.(md|markdown|mdx)$/i
const SKILL_JSON_EXT = /\.(json|jsonc|json5)$/i
const SKILL_TABLE_EXT = /\.(csv|tsv)$/i
const SKILL_IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i

/** 扩展名 → 宿主高亮器的语法名。取值与宿主 `languageForPath` 一致（含短名），
 *  只列宿主能加载的语法，未识别返回空串由调用方按纯文本回落。 */
const SKILL_CODE_LANGS: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  json: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp',
  cs: 'csharp', kt: 'kotlin', kts: 'kotlin', swift: 'swift', php: 'php',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', lua: 'lua',
}

/** 路径 → 宿主共享高亮器的语法名（未识别 → ''）。 */
export function codeLangOf(path: unknown): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path == null ? '' : path))
  return m ? SKILL_CODE_LANGS[m[1].toLowerCase()] || '' : ''
}

/** 按文件名选渲染方式；`.env` 这类 dotfile 按文件名而不是扩展名判定。 */
export function skillFileView(path: unknown): SkillFileView {
  const p = String(path == null ? '' : path)
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (SKILL_MARKDOWN_EXT.test(base)) return 'markdown'
  if (base === '.env' || base.indexOf('.env.') === 0) return 'env'
  if (SKILL_IMAGE_EXT.test(base)) return 'image'
  if (SKILL_TABLE_EXT.test(base)) return 'table'
  if (SKILL_JSON_EXT.test(base)) return 'json'
  return codeLangOf(base) ? 'code' : 'text'
}

/** 归一文件清单：只认字符串路径（host 的 files 是 `{ path, sizeBytes }`）。 */
function normalizeSkillFiles(files: unknown): SkillFileEntry[] {
  const out: SkillFileEntry[] = []
  if (!Array.isArray(files)) return out
  for (const f of files) {
    const path = typeof f === 'string' ? f : (f && typeof (f as { path?: unknown }).path === 'string' ? String((f as { path: string }).path) : '')
    if (!path) continue
    const size = f && typeof (f as { sizeBytes?: unknown }).sizeBytes === 'number' ? Number((f as { sizeBytes: number }).sizeBytes) : 0
    out.push({ path: path, sizeBytes: isFinite(size) ? size : 0 })
  }
  return out
}

/** 把 SKILL.md（或任一支持文件）里的相对链接解析成技能内的文件路径：相对
 *  当前文件所在目录归一（`./`、`../`），去掉 `#锚点` 与查询串并做 URL 解码；
 *  绝对 URL / 协议链接 / 越出技能目录的路径，以及不在文件清单里的目标，一律
 *  返回 null（保持普通链接行为）。baseFile 缺省按技能根处理。 */
export function resolveSkillFileLink(href: unknown, files: unknown, baseFile?: unknown): string | null {
  const raw = String(href == null ? '' : href).trim()
  if (!raw) return null
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return null   // http: / mailto: / data: …
  if (raw.startsWith('/')) return null                      // 绝对路径不是技能内相对引用
  let p = raw.split('#')[0].split('?')[0]
  if (!p) return null
  try { p = decodeURIComponent(p) } catch (e) {}
  const base = String(baseFile == null ? '' : baseFile)
  const idx = base.lastIndexOf('/')
  const segs: string[] = idx >= 0 ? base.slice(0, idx).split('/') : []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segs.length) return null                          // 越出技能目录
      segs.pop()
      continue
    }
    segs.push(part)
  }
  const resolved = segs.join('/')
  if (!resolved) return null
  for (const f of normalizeSkillFiles(files)) {
    if (f.path === resolved) return f.path
  }
  return null
}

/** 详情页左侧文件树：按目录分组 —— 根目录在前且 SKILL.md 置顶，其余目录与组内
 *  文件按路径排序。 */
export function skillFileGroups(files: unknown): Array<{ dir: string; files: SkillFileEntry[] }> {
  const byDir = new Map<string, SkillFileEntry[]>()
  for (const f of normalizeSkillFiles(files)) {
    const idx = f.path.lastIndexOf('/')
    const dir = idx >= 0 ? f.path.slice(0, idx) : ''
    const arr = byDir.get(dir)
    if (arr) arr.push(f)
    else byDir.set(dir, [f])
  }
  const dirs = Array.from(byDir.keys()).sort(function (a, b) {
    if (!a) return -1
    if (!b) return 1
    return a.localeCompare(b)
  })
  return dirs.map(function (dir) {
    const items = (byDir.get(dir) || []).slice().sort(function (a, b) {
      if (a.path === 'SKILL.md') return -1
      if (b.path === 'SKILL.md') return 1
      return a.path.localeCompare(b.path)
    })
    return { dir: dir, files: items }
  })
}

// ── 非 Markdown 文件的只读渲染数据（纯函数，供 UI 与测试）────────────────────

/** 按分隔符切一行，处理 `"..."` 引号与 `""` 转义（RFC 4180 常用子集）。 */
function splitDelimitedLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else quoted = false
      } else cur += ch
      continue
    }
    if (ch === '"' && cur === '') { quoted = true; continue }
    if (ch === delim) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

export interface SkillDelimitedTable { header: string[]; rows: string[][]; truncated: boolean }

/** CSV/TSV → 表头 + 行（空行跳过；行按行宽对齐表头，列数按上限截断；超出
 *  行数上限置 truncated）。 */
export function parseDelimitedRows(text: unknown, delim: unknown): SkillDelimitedTable {
  const d = String(delim == null ? '' : delim) || ','
  const lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .filter(function (l) { return l.trim() !== '' })
  if (!lines.length) return { header: [], rows: [], truncated: false }
  const all = lines.map(function (l) { return splitDelimitedLine(l, d) })
  const header = all[0].slice(0, SKILL_TABLE_MAX_COLS)
  const body = all.slice(1)
  const rows = body.slice(0, SKILL_TABLE_MAX_ROWS).map(function (cells) {
    const row = cells.slice(0, header.length)
    while (row.length < header.length) row.push('')
    return row
  })
  return { header: header, rows: rows, truncated: body.length > SKILL_TABLE_MAX_ROWS }
}

export interface SkillEnvRow { key: string; value: string; comment: boolean }

/** `.env` → 键值行（注释行原样保留为 comment 行，只读视图不该吞掉文件内容；
 *  跳过空行与非法行；赋值行去掉 `export ` 前缀与成对引号，按第一个 `=` 切分，
 *  值里的 `=` 保留）。 */
export function dotenvRows(text: unknown): SkillEnvRow[] {
  const out: SkillEnvRow[] = []
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    if (out.length >= SKILL_ENV_MAX_ROWS) break
    const line = raw.trim()
    if (!line) continue
    if (line[0] === '#') { out.push({ key: '', value: line, comment: true }); continue }
    const body = line.indexOf('export ') === 0 ? line.slice(7).trim() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!key) continue
    let value = body.slice(eq + 1).trim()
    const q = value[0]
    if (value.length >= 2 && (q === '"' || q === "'") && value[value.length - 1] === q) value = value.slice(1, -1)
    out.push({ key: key, value: value, comment: false })
  }
  return out
}

/** JSON → 可树化的对象/数组；标量、非法 JSON、空内容一律 null（回落代码视图）。 */
export function parseJsonForView(text: unknown): object | unknown[] | null {
  const s = String(text == null ? '' : text).trim()
  if (!s || s.length > 1048576) return null
  let v: unknown
  try { v = JSON.parse(s) } catch (e) { return null }
  return v && typeof v === 'object' ? (v as object | unknown[]) : null
}

/** JSON 文件重排成缩进 2 的源码（压缩成一行的配置也能读）；不可解析时原样返回。 */
export function prettyJsonForView(text: unknown): string {
  const s = String(text == null ? '' : text)
  const data = parseJsonForView(s)
  if (!data) return s
  try { return JSON.stringify(data, null, 2) } catch (e) { return s }
}

/** 只放行 host 内联的 `data:image/*;base64,` 图片（防 `data:text/html` 之类被当图片渲染）。 */
export function safeImageDataUrl(v: unknown): string | null {
  const s = String(v == null ? '' : v).trim()
  return /^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]{4,}$/.test(s) ? s : null
}

// ── 非 Markdown 文件的只读视图 ──────────────────────────────────────────────

/** 超过这个体积的源码不交给高亮器（shiki 分词大文件会明显卡面板），改按纯文本。 */
export const SKILL_CODE_HIGHLIGHT_MAX = 200 * 1024

/** 宿主 CodeBlock 的文案（本包不持有 locale，文案由调用方注入）。 */
const CODE_BLOCK_LABELS = { copyLabel: '复制', copiedLabel: '已复制' }

/** 源码 / 配置：宿主 shiki 高亮；宿主没有该组件或文件过大时回落纯文本。 */
export function renderCodeView(content: string, path: string): React.ReactNode {
  if (CodeBlockPrimitive && content.length <= SKILL_CODE_HIGHLIGHT_MAX) {
    return h(CodeBlockPrimitive, {
      code: content,
      lang: codeLangOf(path) || undefined,
      lineNumbers: true,
      copyLabel: CODE_BLOCK_LABELS.copyLabel,
      copiedLabel: CODE_BLOCK_LABELS.copiedLabel,
    })
  }
  return h('div', {},
    content.length > SKILL_CODE_HIGHLIGHT_MAX
      ? h('div', { className: 'wb-sk-file-note' }, '文件较大（超过 ' + String(Math.round(SKILL_CODE_HIGHLIGHT_MAX / 1024)) + 'KB），按纯文本显示。')
      : null,
    h('pre', { className: 'wb-sk-pre wb-sk-filepre' }, content))
}

/** JSON：重排成缩进 2 的源码后走高亮（与其它源码文件同一个视图）。 */
export function renderJsonView(content: string, path: string): React.ReactNode {
  return renderCodeView(prettyJsonForView(content), path)
}

/** CSV / TSV：表格（表头 + 前 N 行）。 */
export function renderTableView(content: string, path: string): React.ReactNode {
  const t = parseDelimitedRows(content, /\.tsv$/i.test(path) ? '\t' : ',')
  if (!t.header.length) return h('div', { className: 'wb-sk-file-note' }, '空文件。')
  return h('div', { className: 'wb-sk-table-wrap' },
    h('table', { className: 'wb-sk-dtable' },
      h('thead', {}, h('tr', {}, t.header.map(function (c, i) {
        return h('th', { key: 'h' + String(i) }, c)
      }))),
      h('tbody', {}, t.rows.map(function (row, ri) {
        return h('tr', { key: 'r' + String(ri) }, row.map(function (c, ci) {
          return h('td', { key: 'c' + String(ci), title: c }, c)
        }))
      }))),
    t.truncated ? h('div', { className: 'wb-sk-file-note' }, '仅预览前 ' + String(SKILL_TABLE_MAX_ROWS) + ' 行。') : null)
}

/** `.env` / `.env.*`：键值表（值原样显示，不做任何脱敏改写）。 */
export function renderEnvView(content: string): React.ReactNode {
  const rows = dotenvRows(content)
  if (!rows.length) return h('div', { className: 'wb-sk-file-note' }, '没有可显示的键值。')
  const items: React.ReactNode[] = []
  rows.forEach(function (r, i) {
    if (r.comment) {
      items.push(h('div', { key: 'c' + String(i), className: 'wb-sk-env-comment' }, r.value))
      return
    }
    items.push(h('dt', { key: 'k' + String(i), className: 'wb-sk-env-key' }, r.key))
    items.push(h('dd', { key: 'v' + String(i), className: 'wb-sk-env-value' }, r.value))
  })
  return h('dl', { className: 'wb-sk-env' }, items)
}

/** 图片：内联 data URL 预览（host 已按上限内联）。 */
export function renderImageView(file: { dataUrl?: unknown; file?: unknown; path?: unknown }, sizeBytes: number): React.ReactNode {
  const src = safeImageDataUrl(file ? file.dataUrl : '')
  const name = String((file && (file.file || file.path)) || '')
  if (!src) return h('div', { className: 'wb-sk-file-note' }, '图片过大，未内联预览（' + formatBytes(sizeBytes) + '）。')
  return h('div', { className: 'wb-sk-image-wrap' }, h('img', { className: 'wb-sk-file-img', src: src, alt: name }))
}

// ── Markdown 只读渲染 ───────────────────────────────────────────────────────
// 只生成 React 元素（绝不 innerHTML）：先整段转义由 React 的文本节点天然完成；
// 链接仅放行 http/https/mailto，其它（javascript: 等）退化为纯文本。

/** 链接目标是否可安全渲染成 <a>。 */
export function safeHref(raw: unknown): string | null {
  const s = String(raw == null ? '' : raw).trim()
  if (!s || s.length > 2000) return null
  if (/^(https?:|mailto:)/i.test(s)) return s
  if (/^\.?\.?\//.test(s)) return s   // 相对路径（技能内的文件引用）
  if (/^#/.test(s)) return s
  return null
}

interface MdInline { type: 'text' | 'code' | 'strong' | 'em' | 'link'; value: string; href?: string }

/** 行内解析：`code` / **strong** / *em* / [text](href) / <url>。 */
export function parseMdInline(text: unknown): MdInline[] {
  const s = String(text == null ? '' : text)
  const out: MdInline[] = []
  let buf = ''
  const flush = function () { if (buf) { out.push({ type: 'text', value: buf }); buf = '' } }
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i) { flush(); out.push({ type: 'code', value: s.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) { flush(); out.push({ type: 'strong', value: s.slice(i + 2, end) }); i = end + 2; continue }
    }
    if (ch === '*') {
      const end = s.indexOf('*', i + 1)
      if (end > i + 1) { flush(); out.push({ type: 'em', value: s.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (ch === '[') {
      const close = s.indexOf(']', i + 1)
      if (close > i && s[close + 1] === '(') {
        const paren = s.indexOf(')', close + 2)
        if (paren > close) {
          flush()
          out.push({ type: 'link', value: s.slice(i + 1, close), href: s.slice(close + 2, paren) })
          i = paren + 1
          continue
        }
      }
    }
    if (ch === '<') {
      const end = s.indexOf('>', i + 1)
      if (end > i && /^https?:\/\//i.test(s.slice(i + 1, end))) {
        flush()
        out.push({ type: 'link', value: s.slice(i + 1, end), href: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

function renderInline(text: unknown, keyPrefix: string, opts?: SkillMdRenderOpts): React.ReactNode[] {
  return parseMdInline(text).map(function (piece, idx) {
    const key = keyPrefix + '-' + String(idx)
    if (piece.type === 'code') return h('code', { key: key, className: 'wb-sk-code' }, piece.value)
    if (piece.type === 'strong') return h('strong', { key: key }, piece.value)
    if (piece.type === 'em') return h('em', { key: key }, piece.value)
    if (piece.type === 'link') {
      // 技能内引用（references/*.md 等）：详情页接管跳转，在文件树里打开该文件。
      const target = opts && opts.onOpenFile ? resolveSkillFileLink(piece.href, opts.files, opts.baseFile) : null
      if (target && opts && opts.onOpenFile) {
        const open = opts.onOpenFile
        return h('a', {
          key: key, href: '#', className: 'wb-sk-link wb-sk-link-file', title: '在详情页打开 ' + target,
          onClick: function (e: { preventDefault(): void }) { e.preventDefault(); open(target) },
        }, piece.value)
      }
      const href = safeHref(piece.href)
      if (!href) return h('span', { key: key }, piece.value)
      return h('a', { key: key, href: href, target: '_blank', rel: 'noreferrer', className: 'wb-sk-link' }, piece.value)
    }
    return h('span', { key: key }, piece.value)
  })
}

/** Markdown 渲染选项：传入 onOpenFile + files 后，正文里指向技能内文件的相对
 *  链接改成页内跳转（详情页的文件浏览）；baseFile = 当前文件路径（相对技能根），
 *  用于归一 `../` 这类相对引用。 */
export interface SkillMdRenderOpts {
  files?: unknown
  baseFile?: string
  onOpenFile?: (path: string) => void
}

/** Markdown → React 元素（标题 / 列表 / 引用 / 代码块 / 表格分隔行跳过 / 段落）。 */
export function renderMarkdown(md: unknown, opts?: SkillMdRenderOpts): React.ReactNode {
  const lines = String(md == null ? '' : md).split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0
  const nextKey = function () { key += 1; return 'md-' + String(key) }
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) { body.push(lines[i]); i++ }
      i++ // 收尾 ```
      blocks.push(h('pre', { key: nextKey(), className: 'wb-sk-pre' },
        lang ? h('div', { className: 'wb-sk-prelang' }, lang) : null,
        h('code', {}, body.join('\n'))))
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = Math.min(6, heading[1].length)
      const tag = 'h' + String(Math.max(3, level + 2))
      blocks.push(h(tag, { key: nextKey(), className: 'wb-sk-h wb-sk-h' + String(level) }, renderInline(heading[2], 'h', opts)))
      i++
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { i++; continue } // 分隔线
    if (/^\s*\|/.test(line)) {
      // 表格：按行切成 pre（只读渲染不追求表格排版）
      const rows: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++ }
      blocks.push(h('pre', { key: nextKey(), className: 'wb-sk-table' }, rows.join('\n')))
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push(h('blockquote', { key: nextKey(), className: 'wb-sk-quote' }, renderInline(quote.join(' '), 'q', opts)))
      continue
    }
    const bullet = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      const ordered = !/^[-*+]$/.test(bullet[2])
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
        if (!m) break
        items.push(m[3])
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      blocks.push(h(tag, { key: nextKey(), className: 'wb-sk-list' },
        items.map(function (it, idx) { return h('li', { key: String(idx) }, renderInline(it, 'li' + String(idx), opts)) })))
      continue
    }
    if (!line.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    if (para.length) blocks.push(h('p', { key: nextKey(), className: 'wb-sk-p' }, renderInline(para.join(' '), 'p', opts)))
    else i++
  }
  return h('div', { className: 'wb-sk-md' }, blocks)
}

// ── 类型 ────────────────────────────────────────────────────────────────────

interface SkillRow {
  source?: string | null
  name: string
  description: string
  path: string
  scope: string
  agents: string[]
  managed?: boolean
  /** SKILL.md 有 `disable-model-invocation: true`：模型不再自动触发，文件保留。 */
  disabled?: boolean
  mtimeMs: number | null
}
interface SkillSearchRow {
  description?: string
  agents?: string[]
  stars?: number
  updatedAt?: string
  id: string
  slug: string
  name: string
  source: string
  installs: number | null
  installUrl: string | null
  url: string | null
}
interface SkillStatus {
  ok?: boolean
  updatedAt?: number
  cli?: { available: boolean; version: string | null; bin: string | null; source: string; tool: string }
  node?: { available: boolean; version: string | null }
  roots?: Record<string, string>
  rootsExist?: Record<string, boolean>
  scopes?: string[]
  agents?: Array<{ id: string; name: string }>
  installDefaultScope?: string
  searchApi?: string
  cliSpec?: string
  error?: string
}
interface SkillDetail {
  name: string
  path: string
  scope: string
  managed?: boolean
  /** SKILL.md 有 `disable-model-invocation: true`（模型不再自动触发）。 */
  disabled?: boolean
  invocation?: { disableModelInvocation: boolean; userInvocable: boolean | undefined }
  content: string
  truncated: boolean
  sizeBytes: number
  files: Array<{ path: string; sizeBytes: number }>
  filesTruncated: boolean
  frontmatter: { name: string; description: string; metadata: Record<string, string> }
  agents: string[]
}
/** 详情页按需读取的单个支持文件（/skills/file）。 */
interface SkillFileData {
  name: string
  scope: string
  file: string
  path: string
  sizeBytes: number
  content: string
  /** 图片按上限内联的 data URL（非图片为空串）。 */
  dataUrl: string
  truncated: boolean
  binary: boolean
  kind: 'markdown' | 'text' | 'binary' | 'image'
}

/** 本地偏好：上次视图 / 作用域 / 目标 agent（按人存本机 localStorage）。 */
const SK_LS_KEY = 'samanhappy.dsh-workbench.skills'

function loadSkillPrefs(): Record<string, string> {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(SK_LS_KEY) : null
    const p = raw ? JSON.parse(raw) : null
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {}
  }
}

function saveSkillPrefs(patch: Record<string, string>): void {
  try {
    if (!globalThis.localStorage) return
    globalThis.localStorage.setItem(SK_LS_KEY, JSON.stringify(Object.assign(loadSkillPrefs(), patch)))
  } catch (e) {}
}

/** 项目作用域基准：当前 DSH 工作区（无工作区时 host 回落自己的根）。 */
function workspacePathOf(wsData: unknown): string | null {
  const items = wsData && typeof wsData === 'object' ? (wsData as { workspaces?: Array<{ path?: string }> }).workspaces : null
  if (!Array.isArray(items) || !items.length) return null
  const p = items[0] && typeof items[0].path === 'string' ? items[0].path : null
  return p || null
}

// ── panel ───────────────────────────────────────────────────────────────────

type SkillUpdate = { name: string; source: string | null; status: 'current' | 'update' | 'unknown' | 'disabled'; error?: string }

export function installCandidates(available: Array<{ name: string; description: string }>, installed: SkillRow[], updates: SkillUpdate[], source: string) {
  const names = new Set(installed.map(function (r) { return r.name }))
  return available.filter(function (r) { return r.name }).map(function (r) {
    const update = updates.find(function (item) { return item.name === r.name && item.source === source })
    return Object.assign({}, r, { status: names.has(r.name) ? update ? update.status : 'unknown' : 'new' })
  }).filter(function (r) { return r.status !== 'current' && r.status !== 'disabled' })
}

export function SkillPanel(props: FrameworkProps) {
  void props
  const wsData = useWsData()
  const prefs = React.useRef(loadSkillPrefs()).current

  const [tab, setTab] = React.useState<'installed' | 'search'>(prefs.tab === 'search' ? 'search' : 'installed')
  const [scope, setScope] = React.useState<'global' | 'project'>(isSkillScope(prefs.scope) ? prefs.scope : 'global')
  const [status, setStatus] = React.useState<SkillStatus | null>(null)
  const [statusError, setStatusError] = React.useState<string | null>(null)
  const [rows, setRows] = React.useState<SkillRow[]>([])
  const [roots, setRoots] = React.useState<string[]>([])
  const [listError, setListError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  // 与仓库页共用标题栏消息区域。
  const [toasts, pushToast, dismissToast] = useToasts()
  const flash = React.useCallback(function (ok: boolean, text: string) {
    pushToast(ok ? 'ok' : 'err', text)
  }, [pushToast])
  const [detail, setDetail] = React.useState<{ name: string; data: SkillDetail | null; error: string | null } | null>(null)
  // 卸载 / 停用的确认统一走面板根上的共享 ConfirmDialog（同 forge/issues 页）：
  // 行内只留 [详情] [停用] [卸载]，长确认文案不再挤压行布局。
  const [confirmReq, setConfirmReq] = React.useState<ConfirmRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = React.useState(false)

  const [query, setQuery] = React.useState('')
  const [queryInput, setQueryInput] = React.useState('')
  const [results, setResults] = React.useState<SkillSearchRow[]>([])
  const [searchType, setSearchType] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [pkg, setPkg] = React.useState('')
  const [candidates, setCandidates] = React.useState<Array<{ name: string; description: string; status: string }> | null>(null)
  const [selected, setSelected] = React.useState<string[]>([])
  const [previewError, setPreviewError] = React.useState<string | null>(null)
  const [targets, setTargets] = React.useState<string[]>(function () {
    try {
      const raw = loadSkillPrefs().agents
      const list = raw ? JSON.parse(raw) : null
      if (Array.isArray(list) && list.length) return list.filter(function (a) { return AGENT_IDS.indexOf(a) >= 0 })
    } catch (e) {}
    return ['universal']
  })
  // 详情页当前打开的支持文件（null = 正在看 SKILL.md 正文）
  const [openFile, setOpenFile] = React.useState<{ path: string; data: SkillFileData | null; error: string | null } | null>(null)

  const previewReqRef = React.useRef(0)
  const [updates, setUpdates] = React.useState<SkillUpdate[] | null>(null)
  const [checkError, setCheckError] = React.useState<string | null>(null)
  const [repoOpen, setRepoOpen] = React.useState(false)
  const [category, setCategory] = React.useState('')
  const [sort, setSort] = React.useState('popular')
  const [sessionInstalled, setSessionInstalled] = React.useState<string[]>([])
  const checkReqRef = React.useRef(0)
  const searchReqRef = React.useRef(0)
  const detailReqRef = React.useRef(0)
  const fileReqRef = React.useRef(0)
  const reqRef = React.useRef(0)
  const wsPath = workspacePathOf(wsData)

  // ── 状态探测 ──────────────────────────────────────────────────────────────
  const loadStatus = React.useCallback(async function (force: boolean) {
    const parts: string[] = []
    if (wsPath) parts.push('cwd=' + encodeURIComponent(wsPath))
    if (force) parts.push('force=1')
    try {
      const data = await forgeFetch('/skills/status' + (parts.length ? '?' + parts.join('&') : ''))
      setStatus(data)
      setStatusError(data && data.ok === false ? String(data.error || '状态探测失败') : null)
    } catch (e) {
      setStatusError(String(e instanceof Error ? e.message : e))
    }
  }, [wsPath])

  // ── 已装列表 ──────────────────────────────────────────────────────────────
  const loadList = React.useCallback(async function (force: boolean) {
    const req = ++reqRef.current
    setLoading(true)
    const parts = ['scope=' + scope]
    if (wsPath) parts.push('cwd=' + encodeURIComponent(wsPath))
    if (force) parts.push('force=1')
    try {
      const data = await forgeFetch('/skills/list?' + parts.join('&'))
      if (req !== reqRef.current) return
      setRows(data && data.ok && Array.isArray(data.skills) ? data.skills : [])
      setRoots(data && Array.isArray(data.roots) ? data.roots : [])
      setListError(data && data.ok === false ? String(data.error || '加载失败') : null)
    } catch (e) {
      if (req !== reqRef.current) return
      setListError(String(e instanceof Error ? e.message : e))
    }
    setLoading(false)
  }, [scope, wsPath])

  React.useEffect(function () {
    void loadStatus(false)
  }, [loadStatus])
  React.useEffect(function () {
    void loadList(false)
  }, [tab, loadList])

  // ── 搜索 ──────────────────────────────────────────────────────────────────
  const runSearch = React.useCallback(async function (q: string) {
    const req = ++searchReqRef.current
    const needle = String(q || '').trim()
    if (needle.length < 2) {
      setSearching(false)
      setSearchError('搜索词至少 2 个字符')
      setResults([])
      return
    }
    setQuery(needle === 'skill' ? '' : needle)
    saveSkillPrefs({ query: needle })
    setSearching(true)
    setSearchError(null)
    try {
      const data = await forgeFetch('/skills/search?q=' + encodeURIComponent(needle))
      if (req !== searchReqRef.current) return
      if (data && data.ok === false) {
        setSearchError(String(data.error || '搜索失败'))
        setResults([])
      } else {
        setResults(data && Array.isArray(data.skills) ? data.skills : [])
        setSearchType(String((data && data.searchType) || ''))
      }
    } catch (e) {
      if (req !== searchReqRef.current) return
      setSearchError(String(e instanceof Error ? e.message : e))
      setResults([])
    }
    setSearching(false)
  }, [])

  React.useEffect(function () { if (tab === 'search' && !query && !results.length) void runSearch('skill') }, [tab])

  // ── 详情页（技能 + 支持文件）──────────────────────────────────────────────
  async function openDetail(name: string) {
    const req = ++detailReqRef.current
    fileReqRef.current++
    setConfirmReq(null)
    setOpenFile(null)
    setDetail({ name: name, data: null, error: null })
    const parts = ['name=' + encodeURIComponent(name), 'scope=' + scope]
    if (wsPath) parts.push('cwd=' + encodeURIComponent(wsPath))
    try {
      const data = await forgeFetch('/skills/detail?' + parts.join('&'))
      if (req !== detailReqRef.current) return
      if (data && data.ok === false) setDetail({ name: name, data: null, error: String(data.error || '读取失败') })
      else setDetail({ name: name, data: data as SkillDetail, error: null })
    } catch (e) {
      if (req !== detailReqRef.current) return
      setDetail({ name: name, data: null, error: String(e instanceof Error ? e.message : e) })
    }
  }

  /** 关闭详情页回列表（列表状态保留在组件里）。 */
  function closeDetail() {
    ++detailReqRef.current
    ++fileReqRef.current
    setDetail(null)
    setOpenFile(null)
    setConfirmReq(null)
  }

  /** 打开技能内的支持文件；SKILL.md 用详情里已取回的正文，不重复请求。 */
  async function openSkillFile(path: string) {
    if (!detail) return
    if (path === 'SKILL.md') {
      ++fileReqRef.current
      setOpenFile(null)
      return
    }
    const req = ++fileReqRef.current
    setOpenFile({ path: path, data: null, error: null })
    const parts = ['name=' + encodeURIComponent(detail.name), 'scope=' + scope, 'file=' + encodeURIComponent(path)]
    if (wsPath) parts.push('cwd=' + encodeURIComponent(wsPath))
    try {
      const data = await forgeFetch('/skills/file?' + parts.join('&'))
      if (req !== fileReqRef.current) return
      if (data && data.ok === false) setOpenFile({ path: path, data: null, error: String(data.error || '读取失败') })
      else setOpenFile({ path: path, data: data as SkillFileData, error: null })
    } catch (e) {
      if (req !== fileReqRef.current) return
      setOpenFile({ path: path, data: null, error: String(e instanceof Error ? e.message : e) })
    }
  }

  // ── 写操作 ────────────────────────────────────────────────────────────────
  async function doRemove(name: string) {
    clearUpdates()
    clearPreview()
    setBusy('remove:' + name)
    try {
      const data = await forgeFetch('/skills/remove', {
        method: 'POST',
        body: { skills: [name], scope: scope, cwd: wsPath },
      })
      if (data && data.ok) {
        flash(true, '已卸载 ' + name)
        closeDetail()
      } else {
        flash(false, '卸载失败：' + String((data && data.error) || '未知错误'))
      }
    } catch (e) {
      flash(false, '卸载失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(null)
    await loadList(true)
  }

  /** 停用（模型不再自动触发）/ 启用（恢复）：编辑 SKILL.md frontmatter，不依赖 CLI。
   *  完成后刷新列表；详情页开着时同步详情里的 disabled 状态。 */
  async function doSetDisabled(name: string, disabled: boolean) {
    clearUpdates()
    clearPreview()
    setBusy('disable:' + name)
    try {
      const data = await forgeFetch('/skills/disable', {
        method: 'POST',
        body: { name: name, scope: scope, disabled: disabled, cwd: wsPath },
      })
      if (data && data.ok) {
        flash(true, disabled ? '已停用 ' + name + '（模型不再自动触发）' : '已启用 ' + name)
        const target = detail && detail.name === name
        if (target && detail.data) {
          setDetail({ name: name, data: Object.assign({}, detail.data, { disabled: !!data.disabled, invocation: data.invocation }), error: null })
        }
      } else {
        flash(false, (disabled ? '停用' : '启用') + '失败：' + String((data && data.error) || '未知错误'))
      }
    } catch (e) {
      flash(false, (disabled ? '停用' : '启用') + '失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(null)
    await loadList(true)
  }

  async function checkUpdates() {
    clearPreview()
    const req = ++checkReqRef.current
    setBusy('check')
    setCheckError(null)
    setUpdates(null)
    try {
      const data = await forgeFetch('/skills/check?scope=' + scope + (wsPath ? '&cwd=' + encodeURIComponent(wsPath) : ''))
      if (req !== checkReqRef.current) return
      if (!data || !data.ok || !Array.isArray(data.skills)) throw new Error(String(data && data.error || '更新检测失败'))
      setUpdates(data.skills)
    } catch (e) {
      if (req === checkReqRef.current) setCheckError(String(e instanceof Error ? e.message : e))
    } finally { setBusy(null) }
  }

  function clearUpdates() {
    ++checkReqRef.current
    setUpdates(null)
    setCheckError(null)
  }
  React.useEffect(clearUpdates, [scope, wsPath])

  async function doUpdate() {
    clearUpdates()
    clearPreview()
    setBusy('update')
    try {
      const data = await forgeFetch('/skills/update', { method: 'POST', body: { scope: scope, cwd: wsPath } })
      if (data && data.ok) {
        const n = Array.isArray(data.updated) ? data.updated.length : 0
        flash(true, data.upToDate ? '已是最新' : (n ? '已更新 ' + String(n) + ' 个技能' : '更新完成'))
      } else {
        flash(false, '更新失败：' + String((data && data.error) || '未知错误'))
      }
    } catch (e) {
      flash(false, '更新失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(null)
    await loadList(true)
  }

  async function doInstall(source: string, skills: string[]) {
    if (busy !== null) return
    const body = buildSkillInstallBody({ package: source, skills: skills, scope: scope, agents: targets, copy: true, cwd: wsPath })
    if (!body.package) {
      flash(false, '请先填写技能包来源（owner/repo 或 URL）')
      return
    }
    setBusy('install:' + body.package)
    try {
      const data = await forgeFetch('/skills/install', { method: 'POST', body: body })
      const installed = data && Array.isArray(data.installed) ? data.installed : []
      const failed = data && Array.isArray(data.failed) ? data.failed : []
      if (data && data.ok && installed.length) {
        flash(true, '已安装 ' + installed.map(function (x: { name: string }) { return x.name }).join('、'))
        clearPreview()
        clearUpdates()
        setSessionInstalled(function (prev) { return prev.concat(installed.map(function (item: { name: string }) { const name = item.name; return scope + ':' + targets.slice().sort().join(',') + ':' + source + '/' + name })) })
        setRepoOpen(false)
        await loadList(true)
      } else if (failed.length) {
        flash(false, '安装失败：' + String(failed[0].error || '未知错误'))
      } else {
        flash(false, '安装失败：' + String((data && data.error) || '未知错误'))
      }
    } catch (e) {
      flash(false, '安装失败：' + String(e instanceof Error ? e.message : e))
    }
    setBusy(null)
  }

  function clearPreview() {
    ++previewReqRef.current
    setCandidates(null)
    setSelected([])
    setPreviewError(null)
  }

  async function previewSkills() {
    const req = ++previewReqRef.current
    const body = buildSkillInstallBody({ package: pkg, scope, cwd: wsPath })
    setBusy('discover')
    setCandidates(null)
    setSelected([])
    setPreviewError(null)
    try {
      const [data, list, checked] = await Promise.all([
        forgeFetch('/skills/discover', { method: 'POST', body: { package: body.package, cwd: wsPath } }),
        forgeFetch('/skills/list?scope=' + scope + '&force=1' + (wsPath ? '&cwd=' + encodeURIComponent(wsPath) : '')),
        forgeFetch('/skills/check?scope=' + scope + (wsPath ? '&cwd=' + encodeURIComponent(wsPath) : '')),
      ])
      if (req !== previewReqRef.current) return
      if (!data || !data.ok) throw new Error(String(data && data.error || '读取技能失败'))
      if (!list || !list.ok) throw new Error(String(list && list.error || '读取已安装技能失败'))
      if (!checked || !checked.ok || !Array.isArray(checked.skills)) throw new Error(String(checked && checked.error || '更新检测失败'))
      const available = installCandidates(data.skills || [], list.skills || [], checked.skills, body.package)
      setUpdates(checked.skills)
      setCandidates(available)
      setSelected(body.skills.filter(function (name) { return available.some(function (r: { name: string }) { return r.name === name }) }))
    } catch (e) {
      if (req === previewReqRef.current) setPreviewError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  React.useEffect(clearPreview, [scope, wsPath])

  function toggleTarget(id: string) {
    setTargets(function (prev) {
      const next = prev.indexOf(id) >= 0 ? prev.filter(function (x) { return x !== id }) : prev.concat([id])
      saveSkillPrefs({ agents: JSON.stringify(next) })
      return next
    })
  }

  // ── render helpers ────────────────────────────────────────────────────────
  const cli = status && status.cli
  const nodeOk = !!(status && status.node && status.node.available)
  const cliOk = !!(cli && cli.available)
  let statusMeta = '探测中…'
  if (status) {
    statusMeta = cliOk
      ? 'skills CLI ' + (cli!.version || '?') + (nodeOk ? ' · node ' + (status.node!.version || '?') : ' · 未检测到 node')
      : 'skills CLI 不可用'
  }

  const visible = rows.filter(function (r) { return installedMatchesQuery(r, filter) })

  function renderToolbar() {
    return h('div', { className: 'wb-bar wb-sk-toolbar' },
      h('span', { className: 'wb-title' }, '技能库'),
      h('span', { className: 'wb-sk-tabs' },
        h('button', {
          key: 'installed',
          className: 'wb-sk-tab' + (tab === 'installed' ? ' wb-sk-tab-active' : ''),
          onClick: function () { setTab('installed'); saveSkillPrefs({ tab: 'installed' }) },
        }, '已安装 (' + String(rows.length) + ')'),
        h('button', {
          key: 'search',
          className: 'wb-sk-tab' + (tab === 'search' ? ' wb-sk-tab-active' : ''),
          onClick: function () { setTab('search'); saveSkillPrefs({ tab: 'search' }) },
        }, h('span', { className: 'wb-sk-tab-ic' }, searchGlyph(12)), '发现技能')
      ),
      h('span', { className: (cliOk ? 'wb-sk-dot wb-sk-dot-ok' : 'wb-sk-dot wb-sk-dot-bad'), title: statusMeta }),
      h('span', { className: 'wb-meta wb-sk-status', title: statusMeta }, status ? (cliOk ? 'skills.sh 已连接' : '管理不可用') : '连接中…'),

      h(ToastOutlet),
      h('details', { className: 'wb-sk-destination' },
        h('summary', {}, '安装到：' + targets.map(function (id) { return id === 'universal' ? '通用' : SKILLS_TARGET_AGENTS.find(function (a) { return a.id === id })?.label || id }).join('、') + ' · ' + (scope === 'global' ? '全局' : '当前工作区')),
        h('div', { className: 'wb-sk-destination-menu' }, renderAgentPicker(),
      h('select', {
          key: 'scope',
          className: 'glab-input wb-sk-scope',
          value: scope,
          onChange: function (e: React.ChangeEvent<HTMLSelectElement>) {
            const v = e.target.value === 'project' ? 'project' : 'global'
            clearPreview()
            clearUpdates()
            setScope(v)
            ++detailReqRef.current
            setDetail(null)
            setConfirmReq(null)
            saveSkillPrefs({ scope: v })
          },
          'aria-label': '技能作用域', disabled: busy !== null,
          title: '技能作用域：全局 ~/.agents/skills / 当前工作区 .agents/skills',
        }, SKILLS_INSTALL_SCOPES.map(function (s) {
          return h('option', { key: s.id, value: s.id }, s.label)
        })))),
        tab === 'installed' ? h('div', { key: 'filter', className: 'wb-sk-filter' },
          h('input', {
            className: 'glab-input wb-sk-finput',
            placeholder: '搜索已安装技能…', 'aria-label': '搜索已安装技能',
            value: filter,
            onChange: function (e: React.ChangeEvent<HTMLInputElement>) { setFilter(e.target.value) },
          }))
        : null,
        tab === 'installed' ? h('button', {
          key: 'check', className: 'glab-btn', disabled: busy !== null,
          onClick: function () { void checkUpdates() }, title: '只检测可用更新，不修改已安装技能',
        }, busy === 'check' ? '检测中…' : '检查更新') : null,
        tab === 'installed' ? h('button', {
          key: 'update', className: 'glab-btn', disabled: busy !== null || !cliOk,
          onClick: function () { void doUpdate() }, title: '更新该作用域下的全部技能',
        }, busy === 'update' ? '更新中…' : '更新全部') : null,
      h('button', {
        className: 'glab-btn', onClick: function () { setSettingsOpen(!settingsOpen) },
        title: '技能目录与 CLI 信息', 'aria-label': '技能连接信息', 'aria-expanded': settingsOpen,
      }, gearGlyph(13)),
      h('button', {
        className: 'glab-btn', disabled: loading,
        onClick: function () { clearUpdates(); clearPreview(); void loadStatus(true); void loadList(true); if (tab === 'search') void runSearch([queryInput.trim(), category].filter(Boolean).join(' ') || 'skill') },
        title: '刷新', 'aria-label': '刷新技能',
      }, RefreshGlyph(loading))
    )
  }

  function renderSettings() {
    if (!settingsOpen) return null
    const lines: string[] = []
    if (status) {
      lines.push('CLI 来源：' + String(status.cliSpec || 'skills@latest') + (cli && cli.bin ? '（' + cli.bin + '）' : ''))
      lines.push('node：' + (nodeOk ? 'v' + String(status.node!.version || '?') : '未检测到（技能管理需要本机 node）'))
      lines.push('搜索端点：' + String(status.searchApi || ''))
      const roots = status.roots || {}
      const exist = status.rootsExist || {}
      lines.push('全局根：' + String(roots.global || '') + (exist.global ? '' : '（不存在，安装后创建）'))
      lines.push('工作区根：' + String(roots.project || '') + (exist.project ? '' : '（不存在，安装后创建）'))
      lines.push('DSH 专有根：' + String(roots.dshProject || '') + ' / ' + String(roots.dshUser || ''))
    }
    if (statusError) lines.push('状态探测：' + statusError)
    if (status && status.error) lines.push(status.error)
    if (!cliOk) lines.push('CLI 不可用时仍可浏览与预览已装技能；安装 / 卸载 / 更新需要 node + npx（首次运行会联网拉取 skills 包）。')
    return h('div', { className: 'wb-picker' },
      lines.map(function (l, i) {
        return h('div', { key: i, className: 'wb-picker-note', style: { whiteSpace: 'pre-wrap' } }, l)
      }))
  }

  function renderAgentPicker() {
    return h('div', { className: 'wb-sk-agents' },
      h('span', { className: 'wb-sk-flabel' }, '安装到'),
      SKILLS_TARGET_AGENTS.map(function (a) {
        const on = targets.indexOf(a.id) >= 0
        return h('button', {
          key: a.id,
          className: 'wb-sk-chip' + (on ? ' wb-sk-chip-on' : ''),
          onClick: function () { toggleTarget(a.id) },
          'aria-pressed': on,
          title: a.id === 'universal' ? 'DSH 默认目标：全局落点就是 ~/.agents/skills' : '装到 ' + a.label + ' 的技能目录',
        }, on ? checkGlyph(11) : null, a.label)
      }),
      h('span', { className: 'wb-meta' }, '全局安装到其他 agent 时，DSH 可能无法读取。')
    )
  }

  /** 行内卸载入口（列表与详情页共用）：点击弹共享确认框，不在行内展开确认组。 */
  function renderRemoveControl(name: string, managed: boolean | undefined) {
    return h('button', {
      className: 'wb-act wb-act-danger',
      disabled: !cliOk || busy !== null || managed === false,
      onClick: function (e: { stopPropagation(): void }) {
        e.stopPropagation()
        setConfirmReq({
          title: '卸载技能',
          lines: ['将卸载「' + name + '」（npx skills remove），卸载后需重新安装才能恢复。'],
          okLabel: '卸载',
          danger: true,
          onOk: function () { void doRemove(name) },
        })
      },
      title: managed === false
        ? '该技能只存在于 .dsh/skills（CLI 不识别此根），无法用 npx skills 卸载'
        : (cliOk ? '卸载该技能（npx skills remove）' : '需要可用的 skills CLI'),
    }, '卸载')
  }

  /** 行内停用/启用入口（列表与详情页共用）。停用=编辑 SKILL.md frontmatter 加
   *  `disable-model-invocation: true`（模型不再自动触发，文件保留，不依赖 CLI），
   *  弹共享确认框；启用是恢复动作，直接执行。 */
  function renderDisableControl(name: string, disabled: boolean | undefined, managed: boolean | undefined) {
    const off = disabled === true
    return h('button', {
      className: off ? 'wb-act wb-act-accent' : 'wb-act',
      disabled: busy !== null || managed === false,
      onClick: function (e: { stopPropagation(): void }) {
        e.stopPropagation()
        if (off) { void doSetDisabled(name, false); return }
        setConfirmReq({
          title: '停用技能',
          lines: ['停用后「' + name + '」不再被模型自动触发；文件保留，可随时启用。'],
          okLabel: '停用',
          onOk: function () { void doSetDisabled(name, true) },
        })
      },
      title: managed === false
        ? '该技能只存在于 .dsh/skills（CLI 不识别此根），仍可直接读写其 SKILL.md'
        : off
          ? '启用该技能（移除 disable-model-invocation 标记，模型恢复自动触发）'
          : '停用该技能（模型不再自动触发，文件保留，不卸载）',
    }, off ? '启用' : '停用')
  }

  function renderInstalledRow(r: SkillRow) {
    const update = updates && updates.find(function (item) { return item.name === r.name })
    const off = r.disabled === true
    return h('div', { key: r.name, className: 'wb-item wb-sk-item' + (off ? ' wb-sk-item-disabled' : '') },
      h('div', { className: 'wb-item-top' },
        h('span', { className: 'wb-sk-avatar', 'aria-hidden': true }, skillIcon(18)),
        h('button', {
          className: 'glab-mr-title wb-sk-name',
          title: '打开详情页：SKILL.md + 引用的支持文件',
          onClick: function () { void openDetail(r.name) },
        }, r.name),
        h('span', { className: 'wb-item-chips' },
          off ? h(Chip, { key: 'd', kind: 'warn', title: DISABLED_HINT }, '已停用') : h(Chip, { key: 'd', kind: 'ok' }, '已启用'),
          update && !off ? h('span', { className: 'wb-meta', title: update.error }, update.status === 'update' ? '可更新' : update.status === 'current' ? '已是最新' : '无法检测') : null,
          r.managed === false ? h(Chip, { key: 'm', kind: 'warn' }, '非 CLI 管理') : null,
          off ? null : h(Chip, { key: 'a' }, skillAgentLabel(r.agents)))),
      h('div', { className: 'wb-sk-meta' },
        h('p', { className: 'wb-sk-description', title: r.description }, r.description || '暂无描述'),
        h('span', { className: 'wb-meta wb-sk-path', title: r.path }, r.path)),
      h('span', { className: 'wb-sk-rowacts' },
        h('button', {
          className: 'wb-act wb-act-accent',
          onClick: function (e: { stopPropagation(): void }) { e.stopPropagation(); void openDetail(r.name) },
          title: '详情页：SKILL.md + 引用的支持文件',
        }, '详情'),
        renderDisableControl(r.name, r.disabled, r.managed),
        renderRemoveControl(r.name, r.managed)))

  }

  // ── 详情页：左侧文件树 + 右侧文件正文 ─────────────────────────────────────

  /** 当前文件正文（SKILL.md 用详情里的正文，其余文件按需读取）。 */
  function renderFileView(treeFiles: Array<{ path: string; sizeBytes: number }>) {
    const sel = openFile
    if (sel && sel.error) return h('div', { className: 'glab-error wb-sk-file-error' }, sel.error)
    if (sel && !sel.data) {
      return h('div', { className: 'wb-sk-file-loading' },
        h('div', { className: 'glab-skel', style: { width: '45%' } }),
        h('div', { className: 'glab-skel', style: { width: '88%' } }),
        h('div', { className: 'glab-skel', style: { width: '72%' } }))
    }
    const d = detail ? detail.data : null
    const path = sel ? sel.path : 'SKILL.md'
    const file = sel ? sel.data : null
    const content = sel ? (file ? file.content : '') : (d ? d.content : '')
    const sizeBytes = sel ? (file ? file.sizeBytes : 0) : (d ? d.sizeBytes : 0)
    const truncated = sel ? !!(file && file.truncated) : !!(d && d.truncated)
    const binary = !!(file && file.binary)
    // 视图按文件路径判定（host 的 kind 只决定「是不是图片/二进制」这一事实）。
    const view = skillFileView(path)
    const lang = view === 'code' ? codeLangOf(path) : ''
    let body: React.ReactNode
    if (file && file.kind === 'image') body = renderImageView(file, sizeBytes)
    else if (binary) {
      body = h('div', { className: 'wb-sk-file-note' },
        view === 'image'
          ? '图片过大，不在页内预览（' + formatBytes(sizeBytes) + '）。'
          : '二进制文件，不在页内渲染（' + formatBytes(sizeBytes) + '）。')
    } else if (view === 'markdown') {
      body = renderMarkdown(content, { files: treeFiles, baseFile: path, onOpenFile: function (p) { void openSkillFile(p) } })
    } else if (view === 'json') body = renderJsonView(content, path)
    else if (view === 'table') body = renderTableView(content, path)
    else if (view === 'env') body = renderEnvView(content)
    else if (view === 'code') body = renderCodeView(content, path)
    else body = h('pre', { className: 'wb-sk-pre wb-sk-filepre' }, content)
    return h(React.Fragment, {},
      h('div', { className: 'wb-sk-file-head' },
        h('span', { className: 'wb-sk-file-path', title: path }, path),
        h('span', { className: 'wb-meta' }, formatBytes(sizeBytes)),
        view === 'code' && lang ? h('span', { className: 'wb-meta wb-sk-file-lang' }, lang) : null,
        truncated ? h('span', { className: 'wb-meta wb-sk-trunc' }, '（已截断显示）') : null),
      body)
  }

  function renderDetailPage() {
    if (!detail) return null
    const d = detail.data
    // 文件清单封顶时 SKILL.md 可能不在前 50 项里，详情页始终提供 SKILL.md 入口。
    const listed = d ? (d.files || []) : []
    const treeFiles = d && !listed.some(function (f) { return f.path === 'SKILL.md' })
      ? [{ path: 'SKILL.md', sizeBytes: d.sizeBytes }].concat(listed)
      : listed
    const groups = skillFileGroups(treeFiles)
    const fm = d ? d.frontmatter || { name: '', description: '', metadata: {} } : null
    return h('div', { className: 'wb-sk-detail' },
      h('div', { className: 'wb-sk-detail-head' },
        h('div', { className: 'wb-crumbs' },
          h('button', { className: 'wb-crumb-link', onClick: closeDetail }, '← 技能库'),
          h('span', { className: 'wb-crumb-sep' }, '/'),
          h('span', { className: 'wb-crumb-here' }, detail.name)),
        h('div', { className: 'wb-sk-detail-title' },
          h('span', { className: 'wb-sk-avatar', 'aria-hidden': true }, skillIcon(18)),
          h('span', { className: 'wb-title-text' }, detail.name),
          h('span', { className: 'wb-item-chips' },
            h(Chip, { key: 'scope' }, scope === 'global' ? '全局' : '当前工作区'),
            d && d.disabled === true ? h(Chip, { key: 'd', kind: 'warn', title: DISABLED_HINT }, '已停用') : null,
            d && d.managed === false ? h(Chip, { key: 'm', kind: 'warn' }, '非 CLI 管理') : null,
            h(Chip, { key: 'a' }, skillAgentLabel(d ? d.agents : [])))),
        h('div', { className: 'wb-sk-detail-actions' },
          renderDisableControl(detail.name, d ? d.disabled : undefined, d ? d.managed : undefined),
          renderRemoveControl(detail.name, d ? d.managed : undefined),
          h('button', {
            className: 'wb-detail-refresh', disabled: busy !== null,
            title: '重新读取技能详情', 'aria-label': '刷新技能详情',
            onClick: function () { void openDetail(detail.name) },
          }, RefreshGlyph(false)))),
      d
        ? h('div', { className: 'wb-sk-detail-meta' },
            h('span', { className: 'wb-meta', title: d.path }, d.path),
            fm && fm.description ? h('span', { className: 'wb-meta wb-sk-detail-desc' }, fm.description) : null)
        : null,
      detail.error ? h('div', { className: 'glab-error', style: { margin: '8px 16px' } }, detail.error) : null,
      !d && !detail.error
        ? h('div', { className: 'wb-sk-detail-body' },
            h('aside', { className: 'wb-sk-tree' },
              h('div', { className: 'glab-skel', style: { width: '80%' } }),
              h('div', { className: 'glab-skel', style: { width: '60%' } })),
            h('section', { className: 'wb-sk-file' },
              h('div', { className: 'glab-skel', style: { width: '70%' } }),
              h('div', { className: 'glab-skel', style: { width: '92%' } }),
              h('div', { className: 'glab-skel', style: { width: '55%' } })))
        : null,
      d
        ? h('div', { className: 'wb-sk-detail-body' },
            h('aside', { className: 'wb-sk-tree', 'aria-label': '技能文件' },
              h('div', { className: 'wb-sk-tree-head' }, '文件 ' + String(treeFiles.length)),
              groups.map(function (g) {
                return h('div', { key: g.dir || '.', className: 'wb-sk-tree-group' },
                  g.dir ? h('div', { className: 'wb-sk-tree-dir', title: g.dir }, g.dir + '/') : null,
                  g.files.map(function (f) {
                    const active = openFile ? openFile.path === f.path : f.path === 'SKILL.md'
                    return h('button', {
                      key: f.path,
                      className: 'wb-sk-tree-item' + (active ? ' wb-sk-tree-item-active' : ''),
                      title: f.path, 'aria-current': active ? 'true' : undefined,
                      onClick: function () { void openSkillFile(f.path) },
                    },
                      h('span', { className: 'wb-sk-tree-name' }, f.path.slice(f.path.lastIndexOf('/') + 1)),
                      h('span', { className: 'wb-sk-tree-size' }, formatBytes(f.sizeBytes)))
                  }))
              }),
              d.filesTruncated ? h('div', { className: 'wb-sk-tree-note' }, '仅列出前 ' + String(listed.length) + ' 个文件') : null),
            h('section', { className: 'wb-sk-file' }, renderFileView(treeFiles)))
        : null)
  }

  function renderInstallForm() {
    return h('div', { className: 'wb-sk-install' },
      h('div', { className: 'wb-sk-frow' },
        h('div', { className: 'wb-sk-field wb-sk-field-grow' },
          h('label', { className: 'wb-sk-flabel', htmlFor: 'wb-sk-package' }, '技能包来源（owner/repo、仓库 URL 或 skills.sh 链接）'),
          h('input', {
            className: 'glab-input wb-sk-finput',
            id: 'wb-sk-package', placeholder: '例如 owner/repo 或 https://github.com/owner/repo',
            value: pkg,
            onChange: function (e: React.ChangeEvent<HTMLInputElement>) { setPkg(e.target.value); clearPreview() },
          })),
        h('button', {
          className: 'glab-btn', disabled: !cliOk || busy !== null || !pkg.trim(),
          onClick: function () { void previewSkills() },
        }, busy === 'discover' ? '读取中…' : '选择技能')),
      previewError ? h('div', { className: 'glab-error', role: 'alert' }, previewError) : null,
      candidates ? h('div', { className: 'wb-sk-candidates' },
        h('div', { className: 'wb-meta' }, candidates.length ? '选择技能（已隐藏最新项）' : '没有可安装或更新的技能'),
        candidates.length ? h('button', { className: 'glab-btn', disabled: busy !== null,
          onClick: function () { setSelected(selected.length === candidates.length ? [] : candidates.map(function (r) { return r.name })) },
        }, selected.length === candidates.length ? '取消全选' : '全选') : null,
        candidates.map(function (r) {
          return h('label', { key: r.name, className: 'wb-sk-candidate' },
            h('input', { type: 'checkbox', checked: selected.includes(r.name), disabled: busy !== null,
              onChange: function () { setSelected(function (prev) { return prev.includes(r.name) ? prev.filter(function (name) { return name !== r.name }) : prev.concat(r.name) }) },
            }), h('span', {}, r.name), h('span', { className: 'wb-meta' }, r.status === 'update' ? '可更新' : r.status === 'unknown' ? '已安装 · 无法检测' : '未安装'), h('span', { className: 'wb-meta' }, r.description))
        })) : null,
      h('div', { className: 'wb-sk-install-foot' },
        h('span', { className: 'wb-meta' },
          '作用域：' + (scope === 'global' ? '全局 ~/.agents/skills' : '当前工作区 .agents/skills')),
        h('button', {
          className: 'glab-btn glab-btn-primary', disabled: !cliOk || busy !== null || !candidates || !selected.length,
          onClick: function () { void doInstall(buildSkillInstallBody({ package: pkg }).package, selected) },
          title: cliOk ? '安装到所选目录' : '需要可用的 skills CLI',
        }, busy && busy.indexOf('install:') === 0 ? '安装中…' : '安装')))
  }

  function renderSearchBody() {
    const sorted = results.slice().sort(function (a, b) { return sort === 'name' ? a.name.localeCompare(b.name) : (b.installs || 0) - (a.installs || 0) })
    function search(q: string, cat: string) { void runSearch([q.trim(), cat].filter(Boolean).join(' ') || 'skill') }
    return h(React.Fragment, {},
      h('div', { className: 'wb-sk-hero' },
        h('div', {}, h('h1', {}, '发现技能'),
          h('div', { className: 'wb-sk-searchbox' }, searchGlyph(20),
            h('input', { id: 'wb-sk-search', className: 'glab-input', 'aria-label': '搜索技能', placeholder: '搜索技能…', value: queryInput,
              onChange: function (e: React.ChangeEvent<HTMLInputElement>) { setQueryInput(e.target.value) },
              onKeyDown: function (e: { key: string }) { if (e.key === 'Enter') search(queryInput, category) } }),
            h('button', { className: 'glab-btn glab-btn-primary', disabled: searching, onClick: function () { search(queryInput, category) } }, searching ? '搜索中…' : '搜索')))),
      h('div', { className: 'wb-sk-browsebar' },
        h('div', { className: 'wb-sk-presets' },
          [{ id: 'all', label: '全部', query: '' }].concat(SKILLS_SEARCH_PRESETS).map(function (p) {
            return h('button', { key: p.id, className: 'wb-sk-chip' + (category === p.query ? ' wb-sk-chip-on' : ' wb-sk-chip-quiet'), 'aria-pressed': category === p.query,
              onClick: function () { setCategory(p.query); search(queryInput, p.query) } }, p.label)
          })),
        h('button', { className: 'glab-btn', onClick: function () { setRepoOpen(true) } }, '+ 从仓库安装')),
      h('div', { className: 'wb-sk-results-head' }, h('h2', {}, query ? '搜索结果' : '推荐技能'),
        h('span', { className: 'wb-meta' }, query ? String(results.length) + ' 个技能' : '来自 skills.sh 技能目录'),
        h('select', { className: 'glab-input', value: sort, 'aria-label': '技能排序', onChange: function (e: React.ChangeEvent<HTMLSelectElement>) { setSort(e.target.value) } },
          h('option', { value: 'popular' }, '热门优先 · 安装量'), h('option', { value: 'name' }, '名称排序'))),
      searchError ? h('div', { className: 'glab-error', role: 'alert' }, searchError) : null,
      searching ? h('div', { className: 'wb-sk-summary', role: 'status' }, '正在查找技能…') : null,
      !searching && sorted.length ? h('div', { className: 'wb-sk-grid wb-sk-discovery-grid' }, sorted.map(function (r) {
        const source = r.source || r.id.split('/').slice(0, 2).join('/')
        const local = rows.find(function (item) { return item.name === r.slug && item.source === source })
        const description = (r.description || local?.description || '').trim()
        const installed = !!local || sessionInstalled.includes(scope + ':' + targets.slice().sort().join(',') + ':' + source + '/' + r.slug)
        return h('article', { key: r.id, className: 'wb-sk-result' },
          h('div', { className: 'wb-sk-card-head' }, h('span', { className: 'wb-sk-avatar', 'aria-hidden': true }, skillIcon(22)),
            h('div', {}, h('h3', {}, r.name), h('span', { className: 'wb-meta wb-sk-source', title: source }, source))),
          description ? h('p', { className: 'wb-sk-description', title: description }, description) : null,
          r.agents?.length ? h('div', { className: 'wb-sk-card-agents' }, r.agents.map(function (agent) { return h(Chip, { key: agent }, agent) })) : null,
          h('div', { className: 'wb-sk-card-foot' }, h('span', { className: 'wb-meta' },
            r.stars != null ? '★ ' + formatInstalls(r.stars) : r.installs != null ? formatInstalls(r.installs) + ' 次安装' : '',
            r.updatedAt ? ' · 更新 ' + r.updatedAt : ''),
            r.url ? h('a', { className: 'wb-act', href: r.url, target: '_blank', rel: 'noreferrer' }, '详情', externalGlyph(11)) : null,
            h('button', { className: 'glab-btn ' + (installed ? 'wb-sk-installed' : 'glab-btn-primary'), disabled: installed || !cliOk || busy !== null,
              onClick: function () { void doInstall(source, [r.slug]) } }, installed ? '已安装' : busy === 'install:' + source ? '安装中…' : '安装')))
      })) : query && !searching && !searchError ? h(EmptyState, { icon: searchGlyph(28), title: '没有找到相关技能', hint: '调整关键词或分类' }) : null,
      repoOpen ? h(SkillRepoDialog, { busy: busy !== null, onClose: function () { setRepoOpen(false) } }, renderInstallForm()) : null)
  }

  function renderInstalledBody() {
    if (listError) return h('div', { className: 'glab-error', style: { margin: '8px 16px' } }, listError)
    if (loading && !rows.length) {
      return h('div', { className: 'glab-list' },
        h('div', { className: 'glab-skel', style: { width: '92%' } }),
        h('div', { className: 'glab-skel', style: { width: '84%' } }),
        h('div', { className: 'glab-skel', style: { width: '88%' } }))
    }
    if (!rows.length) {
      return h(EmptyState, {
        icon: skillIcon(28),
        title: scope === 'global' ? '全局还没有安装技能' : '当前工作区还没有安装技能',
        hint: h('span', {}, '到「发现技能」搜索并安装'),
      })
    }
    if (!visible.length) {
      return h(EmptyState, { icon: skillIcon(24), title: '没有匹配「' + filter + '」的技能', hint: '清空过滤条件' })
    }
    return h('div', { className: 'glab-list wb-sk-grid' }, visible.map(renderInstalledRow))
  }

  // 详情页与列表在根节点原地互换（同 Issues 页）：详情页自己承担头/体布局与滚动。
  if (detail) {
    return h('div', { className: 'glab-panel wb-sk-panel' },
      renderDetailPage(),
      confirmReq
        ? h(ConfirmDialog, Object.assign({}, confirmReq, {
            onOk: function () { setConfirmReq(null); confirmReq.onOk() },
            onCancel: function () { setConfirmReq(null) },
          }))
        : null,
      h(ToastStack, { toasts: toasts, onDismiss: dismissToast }))
  }

  return h('div', { className: 'glab-panel wb-sk-panel' },
    renderToolbar(),
    renderSettings(),
    h('div', { className: 'glab-body', 'aria-busy': loading || searching },
      h('div', { style: { display: tab === 'installed' ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 } },
        !cliOk && status
          ? h('div', { className: 'wb-picker-note', style: { margin: '0 16px 6px' } },
              'skills CLI 不可用：' + String(status.error || '未检测到 node/npx') + '。已装技能仍可浏览与查看详情。')
          : null,
        checkError ? h('div', { className: 'glab-error', role: 'alert' }, checkError) : null,
        renderInstalledBody()),
      h('div', { style: { display: tab === 'search' ? 'flex' : 'none', flexDirection: 'column', minHeight: 0 } },
        renderSearchBody())),
    confirmReq
      ? h(ConfirmDialog, Object.assign({}, confirmReq, {
          onOk: function () { setConfirmReq(null); confirmReq.onOk() },
          onCancel: function () { setConfirmReq(null) },
        }))
      : null,
    h(ToastStack, { toasts: toasts, onDismiss: dismissToast }))
}

function SkillRepoDialog(props: { busy: boolean; onClose(): void; children?: React.ReactNode }) {
  const ref = React.useRef<HTMLDialogElement | null>(null)
  React.useEffect(function () { const dialog = ref.current; dialog?.showModal(); return function () { dialog?.close() } }, [])
  return h('dialog', { ref: ref, className: 'wb-sk-repo-dialog', onCancel: function (e: React.SyntheticEvent) { if (props.busy) e.preventDefault(); else props.onClose() } },
    h('div', { className: 'wb-sk-results-head' }, h('h2', {}, '从仓库安装'), h('button', { className: 'glab-btn', disabled: props.busy, 'aria-label': '关闭仓库安装', onClick: props.onClose }, '关闭')),
    props.children)
}
