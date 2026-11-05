// dsh-workbench — host 技能管理域: 驱动 skills.sh 的 `npx skills` CLI 做技能
// 的安装 / 卸载 / 更新，读取 DSH 自己的技能发现根做列表与详情，并用 skills.sh
// 的**公开**搜索端点（`/api/search`，CLI 的 `find` 用的同一个）做目录检索。
//
// 为什么是这两条数据链路（写错会出问题）：
//   - 安装/卸载/更新只能走 CLI：skills.sh 把技能的来源解析、GitHub 认证、
//     锁文件与多 agent 分发都封装在 CLI 里；插件不自己下载仓库。
//   - 列表/详情直接读 DSH 的技能发现根（`~/.agents/skills`、
//     `<工作区>/.agents/skills`，以及 `~/.dsh/skills` / `<工作区>/.dsh/skills`），
//     与 DSH 的 dsh-skill-filesystem provider 保持同一事实来源。CLI 的
//     `ls --json` 会扫描所有 agent 目录并按副本折叠，既慢又会把「装了但 DSH
//     读不到」的技能混进来；直接读根目录得到的才是「DSH 真正能用的技能」。
//   - 搜索用公开端点而不是 CLI 的 `find`：`find` 是纯 TTY 交互实现，
//     非 TTY 下只会打印结果文本（`--json` 也不生效），无法作为机器接口。
//     skills.sh 文档里的 `/api/v1/*` 需要 Vercel OIDC 令牌，插件拿不到。
//
// 安装落点（默认全局 ~/.agents/skills，与 DSH 的 global 技能根一致）：
//   `npx skills add <pkg> [-s <skill>] [-a <agent>] [-g] --copy -y --json`
//   - 作用域只允许 global / project 两个白名单值；project 落在 `<cwd>/.agents/skills`。
//   - agent 目标来自 CLI 的 agent 注册表（见 SKILL_AGENTS）；DSH 默认目标
//     `universal` 的 global 路径恰好就是 `~/.agents/skills`。真正的落点路径由
//     CLI 决定并回传（结果里的 path），插件不复刻那张 agent × 路径表。
//   - 默认 `--copy`：CLI 默认可能对部分 agent 建符号链接（指向 CLI 自己的
//     canonical 目录）；copy 让技能文件真正落在目标根里，DSH 侧更可预期。
//
// argv 一律白名单构造，包名 / 技能名 / agent id 逐个做取值校验后作为独立
// argv 元素透传，任何用户输入都不进 shell。
//
// Route wiring 见 index.ts 的 apply()。

import { readFile, readdir, realpath, stat, lstat, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { HostContext, Runner } from './runner'
import { classifyError, resolveCliExe } from './runner'
import { getConfig } from './config'

// ── 常量与白名单 ────────────────────────────────────────────────────────────

/** CLI 调用方式：默认 `npx --yes <spec>`；config.skillsCliSpec 可换成固定版本
 *  （`skills@1.7.0`）或本机已安装的 `skills` 可执行文件。 */
export const SKILLS_DEFAULT_CLI_SPEC = 'skills@latest'
export const SKILLS_SEARCH_API = 'https://skills.sh/api/search'
const SKILLS_SEARCH_API_DEFAULT_LIMIT = 30
const SKILLS_QUERY_MIN = 2
const SKILLS_QUERY_MAX = 64
const SKILLS_SEARCH_TIMEOUT_MS = 15000
const SKILLS_MD_MAX = 256 * 1024      // SKILL.md 读取上限
const SKILLS_FILES_MAX = 50           // 详情里罗列的支持文件上限
const SKILLS_DETAIL_FILES_MAX = 200
const SKILLS_FILE_MAX = 256 * 1024    // 单个支持文件的正文上限
const SKILLS_FILE_PATH_MAX = 256      // 技能内相对路径长度上限
const SKILLS_FILE_BINARY_SCAN = 8192  // 二进制探测的采样字节数
const SKILLS_NAME_MAX = 64

/** 作用域白名单：global（用户级）/ project（工作区级）。 */
export const SKILL_SCOPES = ['global', 'project'] as const
export type SkillScope = typeof SKILL_SCOPES[number]

/** 安装目标 agent（CLI `--agent` 的值）。universal 是 DSH 的默认目标：它的
 *  global 路径就是 `~/.agents/skills`（DSH 的 user-agents 技能根）。 */
export interface SkillAgent {
  id: string
  name: string
  universal?: boolean
}
export const SKILL_AGENTS: SkillAgent[] = [
  { id: 'universal', name: '通用（DSH 默认，~/.agents/skills）', universal: true },
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
]

const AGENT_IDS = new Set(SKILL_AGENTS.map((a) => a.id))

/** 包名 / 技能名 / agent id 的字符白名单（逐个 argv 元素透传前的校验）。 */
const SKILL_PACKAGE_RE = /^(@?[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?)$/
const SKILL_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSkillScope(v: unknown): v is SkillScope {
  return v === 'global' || v === 'project'
}

/** 技能目录名合法性（也用于校验请求里的技能名，杜绝路径穿越）。 */
export function skillDirNameValid(name: unknown): boolean {
  const s = String(name == null ? '' : name).trim()
  return s.length > 0 && s.length <= SKILLS_NAME_MAX && SKILL_NAME_RE.test(s)
}

function skillToken(v: unknown, what: string): string {
  const s = String(v == null ? '' : v).trim()
  if (!s || s.length > 128 || !SKILL_TOKEN_RE.test(s)) {
    throw new Error('无效的' + what + '：' + s.slice(0, 60))
  }
  return s
}

/** 包来源合法性：HTTP(S) URL、`owner/repo`、`@scope/name`、`owner/repo@skill` 或单名
 *  （well-known 源如 `notion` / `open.feishu.cn`）。 */
function skillPackage(v: unknown): string {
  const s = String(v == null ? '' : v).trim()
  if (/^https?:\/\//i.test(s)) {
    let url: URL | undefined
    try { url = new URL(s) } catch {}
    if (!url || s.length > 2048 || /[\s\x00-\x1f\x7f]/.test(s) || !url.hostname || url.username || url.password) {
      throw new Error('无效的技能来源 URL（请使用不含凭据的 HTTP/HTTPS 链接）')
    }
    return s
  }
  const at = s.lastIndexOf('@')
  const head = at > 0 ? s.slice(0, at) : s
  if (!head || head.length > 200 || !SKILL_PACKAGE_RE.test(head)) {
    throw new Error('无效的技能包来源（应为 HTTP/HTTPS URL、owner/repo 或 owner/repo@skill）：' + s.slice(0, 80))
  }
  return s
}

// ── argv 构造（纯函数）──────────────────────────────────────────────────────

export interface SkillsCliConfig {
  cliSpec?: string
  cliBin?: string
  npmCacheDir?: string
}

/** `npx skills` 的 argv 前缀。cliBin 非空 = 直接用本机 skills 可执行文件。
 *  注意：buildSkillsAdd/List/Remove/Update/DiscoverArgv 返回的**只是 skills
 *  子命令参数**，前缀在 runSkillsCli 里统一加（避免把一个已经带前缀的 argv
 *  再套一层，产生 `npx --yes skills@latest npx --yes …`）。 */
export function buildSkillsArgv(tool: string, args: string[], cfg?: SkillsCliConfig): string[] {
  const argv = Array.isArray(args) ? args.slice() : []
  if (tool === 'npx') {
    const bin = String((cfg && cfg.cliBin) || '').trim()
    if (bin) return [bin].concat(argv)
    return ['npx', '--yes', String((cfg && cfg.cliSpec) || SKILLS_DEFAULT_CLI_SPEC).trim()].concat(argv)
  }
  if (tool === 'node') return ['node'].concat(argv)
  throw new Error('未知的 skills CLI 调用方式：' + String(tool))
}

/** 给「只含子命令参数」的 argv 加上 CLI 前缀（runSkillsCli 用；导出便于测试
 *  断言「最终 spawn 的 argv」与「归一后的子命令参数」两条独立事实）。 */
export function withSkillsCliPrefix(args: string[], cfg?: SkillsCliConfig): string[] {
  return buildSkillsArgv('npx', args, cfg)
}

export interface SkillsAddInput {
  package?: unknown
  skills?: unknown
  scope?: unknown
  agents?: unknown
  copy?: unknown
  all?: unknown
}

function tokenList(v: unknown, what: string, limit: number): string[] {
  if (v === undefined || v === null) return []
  const arr = Array.isArray(v) ? v : [v]
  const out: string[] = []
  for (const item of arr) {
    const s = String(item == null ? '' : item).trim()
    if (!s) continue
    if (!SKILL_TOKEN_RE.test(s)) throw new Error('无效的' + what + '：' + s.slice(0, 60))
    if (out.indexOf(s) < 0) out.push(s)
    if (out.length >= limit) break
  }
  return out
}

function agentList(v: unknown): string[] {
  const out = tokenList(v, 'agent 目标', 12)
  for (const a of out) {
    if (!AGENT_IDS.has(a)) throw new Error('不支持的 agent 目标：' + a.slice(0, 40))
  }
  return out
}

/** `skills add` argv：固定 flag 顺序（--global 在 --yes 之后，逐个 -s/-a 展开）。 */
export function buildSkillsAddArgv(input: SkillsAddInput, cfg?: SkillsCliConfig): string[] {
  const pkg = skillPackage(input.package)
  const scope = isSkillScope(input.scope) ? input.scope : 'global'
  const skills = tokenList(input.skills, '技能名', Infinity)
  const agents = agentList(input.agents)
  const argv = ['add', pkg, '--yes', '--json']
  if (scope === 'global') argv.push('--global')
  for (const s of skills) argv.push('--skill', s)
  for (const a of agents) argv.push('--agent', a)
  if (input.copy === true) argv.push('--copy')
  if (input.all === true) argv.push('--all')
  return argv
}

/** `skills ls --json` 子命令参数：`--global` = 全局（缺省 = 项目级）。 */
export function buildSkillsListArgv(scope?: unknown, _cfg?: SkillsCliConfig): string[] {
  return isSkillScope(scope) && scope === 'global' ? ['ls', '--json', '--global'] : ['ls', '--json']
}

export interface SkillsRemoveInput {
  skills?: unknown
  scope?: unknown
  agents?: unknown
}

/** `skills remove` 子命令参数（前缀由 runSkillsCli 统一加）。 */
export function buildSkillsRemoveArgv(input: SkillsRemoveInput, _cfg?: SkillsCliConfig): string[] {
  const names = tokenList(input.skills, '技能名', 30)
  if (!names.length) throw new Error('缺少要卸载的技能名')
  const argv = ['remove'].concat(names, ['--yes', '--json'])
  if (isSkillScope(input.scope) && input.scope === 'global') argv.push('--global')
  for (const a of agentList(input.agents)) argv.push('--agent', a)
  return argv
}

/** `skills update` 子命令参数（CLI 无 JSON 输出，用文本判定；缺省 = 全局）。 */
export function buildSkillsUpdateArgv(scope?: unknown, _cfg?: SkillsCliConfig): string[] {
  const global = isSkillScope(scope) ? scope === 'global' : true
  return ['update', global ? '-g' : '-p', '-y']
}

/** `skills add <pkg> -l` 子命令参数：安装前列出该来源里的技能。 */
export function buildSkillsDiscoverArgv(pkg: unknown, _cfg?: SkillsCliConfig): string[] {
  return ['add', skillPackage(pkg), '-l', '-y']
}

// ── CLI 输出解析（纯函数）───────────────────────────────────────────────────

/** 从 CLI 输出里截出第一个 JSON 数组。CLI 在 `--json` 下仍会先打印自带横幅 /
 *  安全审计框 / ANSI 颜色，所以不能直接 JSON.parse 整段输出；从第一个 `[`
 *  起做括号配平（跳过字符串与转义），配平失败则退回「取到最后一个 `]`」。 */
export function parseSkillsJsonArray(out: string): unknown[] {
  const text = stripAnsi(String(out == null ? '' : out))
  const start = text.indexOf('[')
  if (start < 0) return []
  // 括号配平扫描（字符串感知），失败时退回最后一个 ']' 的宽松切片。
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown
          return Array.isArray(parsed) ? parsed : []
        } catch (e) {
          break
        }
      }
    }
  }
  const end = text.lastIndexOf(']')
  if (end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      return Array.isArray(parsed) ? parsed : []
    } catch (e) {}
  }
  return []
}

/** List mode is text-only in skills 1.7. Parse names only inside its
 * Available Skills section, keeping descriptions separate from names. */
export function parseSkillsDiscoverOutput(out: string): Array<{ name: string; description: string }> {
  const text = stripAnsi(String(out || ''))
  const json = parseSkillsJsonArray(text).filter(function (raw): raw is Record<string, unknown> {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).name === 'string'
  })
  if (json.length) return json.map(function (raw) { return { name: str(raw.name), description: str(raw.description) } })
  const skills: Array<{ name: string; description: string }> = []
  let inList = false
  for (const line of text.split(/\r?\n/)) {
    if (/^[│|◇\s]*Available Skills\s*$/.test(line)) { inList = true; continue }
    if (!inList) continue
    if (/^[└■]/.test(line)) break
    const name = line.match(/^[│|] {4}([A-Za-z0-9][A-Za-z0-9._:/-]*)\s*$/)
    if (name) {
      if (!skills.some(function (skill) { return skill.name === name[1] })) skills.push({ name: name[1], description: '' })
      continue
    }
    const description = line.match(/^[│|] {6}(\S.*)$/)
    if (description && skills.length) {
      const skill = skills[skills.length - 1]
      skill.description += (skill.description ? ' ' : '') + description[1].trim()
    }
  }
  return skills
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
}

/** `skills -v` 输出 → 语义版本（`1.7.0`）。 */
export function parseSkillsCliVersion(out: unknown): string | null {
  const m = stripAnsi(String(out == null ? '' : out)).match(/\b(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/)
  return m ? m[1] : null
}

/** 极简 SKILL.md frontmatter 解析：顶层标量 name/description + `metadata:` 下的
 *  一级 key: value（只做字符串值；嵌套不展开）。无 frontmatter 时返回空值，
 *  绝不抛错——技能文件是外部内容，坏文件不应让整页 500。 */
export function parseSkillFrontmatter(md: unknown): { name: string; description: string; metadata: Record<string, string> } {
  const text = String(md == null ? '' : md)
  const empty = { name: '', description: '', metadata: {} as Record<string, string> }
  if (!text.startsWith('---')) return empty
  const end = text.indexOf('\n---', 3)
  if (end < 0) return empty
  const lines = text.slice(3, end).split('\n')
  const out = { name: '', description: '', metadata: {} as Record<string, string> }
  let block = ''
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = /^\s/.test(line)
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (!indent) {
      block = value === '' ? key : ''
      if (key === 'name' || key === 'description') out[key] = unquote(value)
      continue
    }
    if (block === 'metadata') out.metadata[key] = unquote(value)
  }
  return out
}

function unquote(v: string): string {
  let s = String(v == null ? '' : v).trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s.trim()
}

/** 找到 frontmatter 闭合分隔线（end 指向 `\n---` 的换行；无有效头返回 null）。
 * 与 parseSkillFrontmatter 用同一判定，保证「解析」与「改写」看到同一个块。 */
function skillFrontmatterEnd(text: string): number | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  return end < 0 ? null : end
}

/** DSH 的 frontmatterBoolean 宽松版（true/1/"true"/"yes"/"on" → true，其余 false）。
 * 只用于展示与改写判定，不参与 DSH 自身的加载。 */
function frontmatterBooleanLoose(v: unknown): boolean {
  if (v === true || v === 1 || v === '1') return true
  if (typeof v === 'string') {
    const s = unquote(v).toLowerCase()
    if (s === 'true' || s === 'yes' || s === 'on') return true
  }
  return false
}

export interface SkillInvocationFlags {
  /** frontmatter `disable-model-invocation: true`：DSH 把该技能从模型面向的目录排除
   *  （模型不再自动触发），文件保留、用户仍可手动触发；这是「停用但不卸载」的原生做法。 */
  disableModelInvocation: boolean
  /** frontmatter `user-invocable: false`：用户也不可手动触发；缺省 undefined = 允许。 */
  userInvocable: boolean | undefined
}

/** 解析 SKILL.md frontmatter 里的调用策略字段（顶层键，只认非缩进行）。无
 *  frontmatter 或值非法一律按「未停用」处理，绝不抛错。 */
export function parseSkillInvocation(md: unknown): SkillInvocationFlags {
  const flags: SkillInvocationFlags = { disableModelInvocation: false, userInvocable: undefined }
  const text = String(md == null ? '' : md)
  const end = skillFrontmatterEnd(text)
  if (end === null) return flags
  const block = text.slice(3, end)
  const eol = block.includes('\r\n') ? '\r\n' : '\n'
  const rows = (block.startsWith(eol) ? block.slice(eol.length) : block).split(eol)
  for (const raw of rows) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || /^\s/.test(line) || line.trim().startsWith('#')) continue
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    if (m[1] === 'disable-model-invocation') flags.disableModelInvocation = frontmatterBooleanLoose(m[2])
    else if (m[1] === 'user-invocable') flags.userInvocable = frontmatterBooleanLoose(m[2])
  }
  return flags
}

/** 在 SKILL.md 里增删顶层 `disable-model-invocation` 标记（停用=true 写入/置 true，
 *  启用=false 删除该行）。行级编辑：正文与其余 frontmatter 字段原样保留，只动这一
 *  个顶层键；保留原行尾风格（CRLF/LF）。无有效 frontmatter 返回 null（调用方报错）。 */
export function editSkillInvocationFlag(md: unknown, disabled: boolean): string | null {
  const s = String(md == null ? '' : md)
  const end = skillFrontmatterEnd(s)
  if (end === null) return null
  const eol = s.includes('\r\n') ? '\r\n' : '\n'
  // CRLF 文件的闭合分隔线是 `\r\n---`：end 落在 `\n` 上，闭合段要连前导 `\r` 一起保留。
  const closingStart = eol === '\r\n' && s[end - 1] === '\r' ? end - 1 : end
  const block = s.slice(3, closingStart)
  const rows = block ? (block.startsWith(eol) ? block.slice(eol.length) : block).split(eol) : []
  const KEY = 'disable-model-invocation'
  const KEY_RE = /^disable-model-invocation\s*:/
  const out: string[] = []
  let wrote = false
  for (const line of rows) {
    if (KEY_RE.test(line.trim()) && !/^\s/.test(line)) {
      wrote = true
      if (disabled) {
        const canonical = KEY + ': true'
        if (line !== canonical) out.push(canonical)
        else out.push(line)
      }
      continue // 启用时删掉该行
    }
    out.push(line)
  }
  if (disabled && !wrote) out.push(KEY + ': true')
  return '---' + (out.length ? eol + out.join(eol) : '') + s.slice(closingStart)
}

/** 用 frontmatter 补齐列表项的 name/description（CLI 的 ls 不给描述）。 */
export function applySkillMetadata<T extends { name: string; description?: string }>(items: T[], overwrite: boolean): T[] {
  for (const it of items) {
    const fm = (it as { frontmatter?: { name?: string; description?: string } }).frontmatter
    if (!fm) continue
    if ((overwrite || !it.name) && fm.name) it.name = fm.name
    if ((overwrite || !it.description) && fm.description) it.description = fm.description
  }
  return items
}

/** `skills update` 的文本报告 → 判定是否「已是最新」与列出被更新的技能。
 *  CLI 没有 JSON 输出，只能读文本；判定偏保守：只有明确出现「XX up to date」
 *  且没有可识别的更新记录时才算已最新。 */
export function parseSkillsUpdateReport(out: unknown): { upToDate: boolean; updated: string[] } {
  const text = stripAnsi(String(out == null ? '' : out))
  const upToDate = /already up to date|are up to date|up to date|No project skills to update|No global skills to update/i.test(text)
  const updated: string[] = []
  // `Updated <name>` / `Upgraded <name>`：排除 `Up to date` 与计数（`Updated 3 skills`）。
  const re = /(?:Updated|Upgraded)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    if (/^\d+$/.test(name) || /^(to|date)$/i.test(name)) continue
    if (updated.indexOf(name) < 0) updated.push(name)
  }
  return { upToDate: upToDate && updated.length === 0, updated }
}

// ── 相对 CLI 的路径与作用域 ─────────────────────────────────────────────────

/** DSH 技能发现根的绝对路径（与 dsh-skill-filesystem 的 roots() 对齐）。
 *  home 缺省 = $HOME，取不到则用 os.homedir()；都取不到时退化为工作区自身
 *  （宁可展示空列表，也不要在请求路径上抛错）。 */
export function resolveSkillsRoots(workspaceRoot: string, home?: string): { global: string; project: string; dshProject: string; dshUser: string } {
  const ws = resolve(String(workspaceRoot || process.cwd() || '/'))
  let h = String(home == null ? '' : home).trim()
  if (!h) {
    h = String(process.env.HOME || '').trim()
    if (!h) { try { h = homedir() } catch (e) { h = '' } }
  }
  if (!h) h = ws
  const homeRoot = resolve(h)
  return {
    global: join(homeRoot, '.agents', 'skills'),
    project: join(ws, '.agents', 'skills'),
    dshProject: join(ws, '.dsh', 'skills'),
    dshUser: join(homeRoot, '.dsh', 'skills'),
  }
}

/** 某作用域的 DSH 侧技能根（首个是 CLI 管理的规范根，次个是 DSH 专有根）。 */
export function skillScopeRoots(scope: SkillScope, workspaceRoot: string, home: string): { root: string; alt: string } {
  const roots = resolveSkillsRoots(workspaceRoot, home)
  return scope === 'project'
    ? { root: roots.project, alt: roots.dshProject }
    : { root: roots.global, alt: roots.dshUser }
}

/** 请求没带 cwd 时的技能作用域基准目录：DSH 工作区根。 */
export function defaultSkillsWorkspaceRoot(runner: Runner): string {
  try {
    const root = runner.getWorkspaceRoot()
    if (root) return resolve(root)
  } catch (e) {}
  return resolve(process.cwd() || '/')
}

/** 技能域的错误归类：CLI 缺失 / 网络 / 其余沿用通用归类。 */
export function classifySkillsError(err: unknown): string {
  const text = String(err && typeof err === 'object' && 'message' in err ? (err as { message: unknown }).message : err)
  const low = text.toLowerCase()
  if (/enoent|command not found|not found|no such file|is not recognized/.test(low)) {
    return '未检测到 Node.js / npx（技能管理需要本机 node 与网络访问 skills.sh）：' + text.slice(0, 120)
  }
  if (/network|fetch failed|timeout|timed out|eai_again|enotfound|econnrefused|etimedout|could not resolve/.test(low)) {
    return '网络错误：无法访问 skills.sh（' + text.slice(0, 120) + '）'
  }
  return classifyError(err)
}

// ── skills.sh 公开搜索端点 ──────────────────────────────────────────────────

export interface SkillSearchItem {
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

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

/** 归一 skills.sh `/api/search` 的技能项（缺失字段给 null，不猜）。 */
export function toSkillSearchItem(raw: unknown): SkillSearchItem | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  const name = str(o.name) || str(o.skillId)
  if (!id && !name) return null
  const source = str(o.source)
  const slug = str(o.skillId) || (id.indexOf('/') >= 0 ? id.slice(id.lastIndexOf('/') + 1) : name)
  const installs = typeof o.installs === 'number' && isFinite(o.installs) ? o.installs : null
  return {
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(Array.isArray(o.agents) ? { agents: o.agents.filter((agent): agent is string => typeof agent === 'string') } : {}),
    ...(typeof o.stars === 'number' && Number.isFinite(o.stars) && o.stars >= 0 ? { stars: o.stars } : {}),
    ...(typeof o.updatedAt === 'string' ? { updatedAt: o.updatedAt } : {}),
    id: id || (source ? source + '/' + slug : slug),
    slug,
    name,
    source,
    installs,
    installUrl: source ? 'https://github.com/' + source : null,
    url: id ? 'https://skills.sh/' + id : null,
  }
}

/** 搜索 skills.sh 公开端点（无需令牌）。q 至少 2 个字符。 */
export async function searchSkillsCatalog(query: unknown, limit?: number): Promise<{ ok: true; query: string; searchType: string; skills: SkillSearchItem[] } | { ok: false; error: string }> {
  const q = String(query == null ? '' : query).trim()
  if (q.length < SKILLS_QUERY_MIN) return { ok: false, error: '搜索词至少 ' + SKILLS_QUERY_MIN + ' 个字符' }
  if (q.length > SKILLS_QUERY_MAX) return { ok: false, error: '搜索词过长（最多 ' + SKILLS_QUERY_MAX + ' 字符）' }
  const cap = typeof limit === 'number' && isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : getConfig().skillsSearchLimit
  const url = SKILLS_SEARCH_API + '?q=' + encodeURIComponent(q) + '&limit=' + String(cap || SKILLS_SEARCH_API_DEFAULT_LIMIT)
  const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof fetchFn !== 'function') return { ok: false, error: '当前运行时没有 fetch，无法访问 skills.sh' }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(function () { ctrl.abort() }, SKILLS_SEARCH_TIMEOUT_MS) : null
  try {
    const res = await fetchFn(url, { headers: { accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
    if (!res.ok) return { ok: false, error: 'skills.sh 搜索失败（HTTP ' + String(res.status) + '）' }
    const payload = await res.json() as Record<string, unknown>
    const raw = Array.isArray(payload.skills) ? payload.skills : []
    const skills: SkillSearchItem[] = []
    for (const item of raw) {
      const view = toSkillSearchItem(item)
      if (view) skills.push(view)
    }
    return { ok: true, query: str(payload.query) || q, searchType: str(payload.searchType), skills }
  } catch (err) {
    return { ok: false, error: classifySkillsError(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── 本地技能读取 ────────────────────────────────────────────────────────────

export interface InstalledSkill {
  name: string
  description: string
  path: string
  scope: SkillScope
  root: string
  managed: boolean
  installed: boolean
  /** SKILL.md frontmatter 有 `disable-model-invocation: true`：模型不再自动触发，
   *  文件保留（DSH 原生「停用但不卸载」），界面据此标注与跳过更新检测。 */
  disabled: boolean
  agents: string[]
  source: string | null
  mtimeMs: number | null
}

async function readSkillFrontmatter(dir: string): Promise<{ name: string; description: string; metadata: Record<string, string>; disabled: boolean }> {
  try {
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const fm = parseSkillFrontmatter(text.slice(0, SKILLS_MD_MAX))
    return Object.assign(fm, { disabled: parseSkillInvocation(text).disableModelInvocation })
  } catch (e) {
    return { name: '', description: '', metadata: {}, disabled: false }
  }
}

async function listSubdirs(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (e) {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) { out.push(e.name); continue }
    if (e.isSymbolicLink()) {
      // 符号链接的技能目录（CLI 对部分 agent 的默认形态）也算已装。
      try {
        const st = await stat(join(root, e.name))
        if (st.isDirectory()) out.push(e.name)
      } catch (err) {}
    }
  }
  return out.sort()
}

/** 该技能目录在哪些 agent 的全局/项目根里可见（尽力而为：按已知 agent 的
 *  目录做存在性探测，只影响展示，不参与任何写操作）。 */
async function detectSkillAgents(name: string, workspaceRoot: string, home: string, scope: SkillScope): Promise<string[]> {
  const candidates: Array<[string, string]> = scope === 'global'
    ? [
        [join(home, '.agents', 'skills'), '通用'],
        [join(home, '.claude', 'skills'), 'Claude Code'],
        [join(home, '.codex', 'skills'), 'Codex'],
        [join(home, '.cursor', 'skills'), 'Cursor'],
        [join(home, '.config', 'opencode', 'skills'), 'OpenCode'],
        [join(home, '.copilot', 'skills'), 'GitHub Copilot'],
      ]
    : [
        [join(workspaceRoot, '.agents', 'skills'), '通用'],
        [join(workspaceRoot, '.claude', 'skills'), 'Claude Code'],
        [join(workspaceRoot, '.cursor', 'skills'), 'Cursor'],
      ]
  const out: string[] = []
  for (const [dir, label] of candidates) {
    try {
      const st = await stat(join(dir, name))
      if (st.isDirectory() || st.isFile()) out.push(label)
    } catch (e) {}
  }
  return out
}

/** 读取某作用域下 DSH 可发现的所有技能：CLI 规范根（.agents/skills，managed）
 *  在前，DSH 专有根（.dsh/skills）在后；同名折叠为一项（规范根优先）。 */
export async function listInstalledSkills(scope: SkillScope, workspaceRoot: string, home: string): Promise<{ skills: InstalledSkill[]; roots: string[] }> {
  const { root, alt } = skillScopeRoots(scope, workspaceRoot, home)
  const roots = alt === root ? [root] : [root, alt]
  const byName = new Map<string, InstalledSkill>()
  for (const dir of roots) {
    const managed = dir === root
    for (const name of await listSubdirs(dir)) {
      const existing = byName.get(name)
      if (existing && existing.managed) continue
      const skillPath = join(dir, name)
      const fm = await readSkillFrontmatter(skillPath)
      let mtimeMs: number | null = null
      try {
        const st = await stat(skillPath)
        mtimeMs = st.mtimeMs
      } catch (e) {}
      byName.set(name, {
        name,
        description: fm.description,
        path: skillPath,
        scope,
        root: dir,
        managed,
        installed: true,
        disabled: fm.disabled,
        agents: [],
        source: null,
        mtimeMs,
      })
    }
  }
  const skills = Array.from(byName.values()).sort(function (a, b) { return a.name.localeCompare(b.name) })
  for (const s of skills) s.agents = await detectSkillAgents(s.name, workspaceRoot, home, scope)
  return { skills, roots }
}

/** 在某作用域的两个根里定位已装技能目录。 */
export async function resolveInstalledSkillDir(name: unknown, scope: SkillScope, workspaceRoot: string, home: string): Promise<string | null> {
  const n = String(name == null ? '' : name).trim()
  if (!skillDirNameValid(n)) return null
  const { root, alt } = skillScopeRoots(scope, workspaceRoot, home)
  for (const dir of alt === root ? [root] : [root, alt]) {
    const candidate = join(dir, n)
    try {
      const st = await stat(candidate)
      if (st.isDirectory()) return candidate
    } catch (e) {}
  }
  return null
}

interface SkillFileEntry { path: string; sizeBytes: number }

async function walkSkillFiles(root: string, dir: string, out: SkillFileEntry[], depth: number): Promise<void> {
  if (out.length >= SKILLS_FILES_MAX || depth > 3) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    return
  }
  for (const e of entries) {
    if (out.length >= SKILLS_FILES_MAX) return
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      await walkSkillFiles(root, full, out, depth + 1)
      continue
    }
    if (!e.isFile() && !e.isSymbolicLink()) continue
    let size = 0
    try {
      const st = await stat(full)
      if (!st.isFile()) continue
      size = st.size
    } catch (err) {
      continue
    }
    out.push({ path: relative(root, full).split(sep).join('/'), sizeBytes: size })
  }
}

/** 技能详情：SKILL.md 全文（截断）+ frontmatter + 支持文件清单。 */
export async function loadSkillDetail(scope: SkillScope, name: unknown, workspaceRoot: string, home: string): Promise<Record<string, unknown>> {
  const dir = await resolveInstalledSkillDir(name, scope, workspaceRoot, home)
  if (!dir) {
    return { ok: false, error: '未找到已安装的技能：' + String(name == null ? '' : name).slice(0, 60) + '（作用域 ' + scope + '）' }
  }
  let content = ''
  let sizeBytes = 0
  let truncated = false
  try {
    const buf = await readFile(join(dir, 'SKILL.md'), 'utf8')
    sizeBytes = Buffer.byteLength(buf, 'utf8')
    if (buf.length > SKILLS_MD_MAX) {
      content = buf.slice(0, SKILLS_MD_MAX)
      truncated = true
    } else {
      content = buf
    }
  } catch (e) {
    return { ok: false, error: '技能目录缺少 SKILL.md：' + basename(dir) }
  }
  const files: SkillFileEntry[] = []
  await walkSkillFiles(dir, dir, files, 0)
  const fm = parseSkillFrontmatter(content)
  const invocation = parseSkillInvocation(content)
  const roots = resolveSkillsRoots(workspaceRoot, home)
  return {
    ok: true,
    name: String(name == null ? '' : name).trim(),
    scope,
    path: dir,
    managed: dir.startsWith(roots.global + sep) || dir.startsWith(roots.project + sep),
    frontmatter: fm,
    disabled: invocation.disableModelInvocation,
    invocation,
    content,
    truncated,
    sizeBytes,
    files,
    filesTruncated: files.length >= SKILLS_FILES_MAX,
    agents: await detectSkillAgents(String(name == null ? '' : name).trim(), workspaceRoot, home, scope),
  }
}

/** 技能内相对文件路径合法性：拒绝绝对路径 / 反斜杠 / NUL / 空段与 `.`、`..`
 *  段（路径穿越），并与详情文件清单保持一致地拒绝 node_modules、.git。 */
export function skillRelativeFilePathValid(p: unknown): boolean {
  const s = String(p == null ? '' : p).trim()
  if (!s || s.length > SKILLS_FILE_PATH_MAX) return false
  if (s.startsWith('/') || s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) return false
  for (const seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..') return false
    if (seg === 'node_modules' || seg === '.git') return false
  }
  return true
}

/** 技能内单个支持文件的类型：Markdown / 图片 / 其它文本 / 二进制（二进制不回正文）。 */
export type SkillFileKind = 'markdown' | 'text' | 'binary' | 'image'

/** 图片内联上限：超过这个体积不回 data URL（只回报体积，详情页给纯提示）——
 *  技能里的截图/示意图通常远小于此，正常大小的图片仍能页内预览。 */
export const SKILLS_FILE_IMAGE_MAX = 2 * 1024 * 1024

/** 可页内预览的图片类型（按扩展名判定）。 */
const SKILLS_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** 图片 mime：按扩展名判定，非图片返回 null。 */
function skillImageMime(rel: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(rel)
  return m ? SKILLS_IMAGE_MIME[m[1].toLowerCase()] || null : null
}

function skillFileKindOf(rel: string, binary: boolean, image: boolean): SkillFileKind {
  if (image) return 'image'
  if (binary) return 'binary'
  return /\.(md|markdown|mdx)$/i.test(rel) ? 'markdown' : 'text'
}

/** 按需读取技能内的单个支持文件（详情页的文件浏览）。安全边界与详情一致：
 *  只接受技能目录内的相对路径；绝对路径 / `..` / 指向目录外的符号链接一律
 *  拒绝（realpath 二次校验，防止链接逃逸）；图片按上限内联成 data URL；其余
 *  二进制只回报体积不回正文；超过上限的正文截断并标记 truncated。 */
export async function loadSkillFile(scope: SkillScope, name: unknown, file: unknown, workspaceRoot: string, home: string): Promise<Record<string, unknown>> {
  const skillName = String(name == null ? '' : name).trim()
  const dir = await resolveInstalledSkillDir(skillName, scope, workspaceRoot, home)
  if (!dir) {
    return { ok: false, error: '未找到已安装的技能：' + skillName.slice(0, 60) + '（作用域 ' + scope + '）' }
  }
  const rel = String(file == null ? '' : file).trim()
  if (!skillRelativeFilePathValid(rel)) {
    return { ok: false, error: '无效的技能文件路径：' + rel.slice(0, 80) }
  }
  let rootReal = dir
  try { rootReal = await realpath(dir) } catch (e) {}
  let real = ''
  try {
    real = await realpath(resolve(rootReal, rel))
  } catch (e) {
    return { ok: false, error: '技能内没有这个文件：' + rel.slice(0, 120) }
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    return { ok: false, error: '拒绝读取技能目录之外的文件：' + rel.slice(0, 120) }
  }
  let st
  try {
    st = await stat(real)
  } catch (e) {
    return { ok: false, error: '技能内没有这个文件：' + rel.slice(0, 120) }
  }
  if (!st.isFile()) return { ok: false, error: '不是文件：' + rel.slice(0, 120) }
  let buf: Buffer
  try {
    buf = await readFile(real)
  } catch (e) {
    return { ok: false, error: '读取失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  const mime = skillImageMime(rel)
  const dataUrl = mime && st.size <= SKILLS_FILE_IMAGE_MAX
    ? 'data:' + mime + ';base64,' + buf.toString('base64')
    : ''
  const binary = buf.subarray(0, SKILLS_FILE_BINARY_SCAN).includes(0)
  const truncated = !dataUrl && buf.length > SKILLS_FILE_MAX
  const content = binary || dataUrl ? '' : buf.subarray(0, truncated ? SKILLS_FILE_MAX : buf.length).toString('utf8')
  return {
    ok: true,
    name: skillName,
    scope,
    file: rel,
    path: real,
    sizeBytes: st.size,
    content,
    dataUrl,
    truncated,
    binary,
    kind: skillFileKindOf(rel, binary, !!dataUrl),
  }
}

// ── CLI 执行 ────────────────────────────────────────────────────────────────

/** 技能 CLI 的调用环境：`--yes` 之外再把 npm 缓存显式指向工作区（配置
 *  skillsNpmCacheDir 时），避免 npx 往 ~/.npm 写缓存被沙箱拒掉。 */
function cliOpts(cwd: string): { cwd: string; env?: Record<string, string> } {
  const dir = String(getConfig().skillsNpmCacheDir || '').trim()
  return dir ? { cwd, env: { npm_config_cache: resolve(dir), NO_COLOR: '1' } } : { cwd, env: { NO_COLOR: '1' } }
}

async function skillsCliConfig(runner: Runner): Promise<{ tool: string; cfg: SkillsCliConfig }> {
  const spec = String(getConfig().skillsCliSpec || '').trim() || SKILLS_DEFAULT_CLI_SPEC
  // 绝对路径 / 形如 ./x 的 spec = 直接用本机可执行文件（部署可换成固定版本或
  // 自编译产物）；`@` 或裸名 = 交给 npx 解析。
  if (/^([/~]|\.)/.test(spec)) return { tool: 'npx', cfg: { cliBin: spec } }
  void runner
  return { tool: 'npx', cfg: { cliSpec: spec } }
}

interface CliOutcome { code: number; out: string; errText: string }

async function runSkillsCli(ctx: HostContext, runner: Runner, args: string[], cwd: string, graceMs: number): Promise<CliOutcome> {
  const { cfg } = await skillsCliConfig(runner)
  const argv = withSkillsCliPrefix(args, cfg)
  void ctx
  const r = await runner.tryRun(argv[0], argv.slice(1), Object.assign(cliOpts(cwd), { graceMs, maxBytes: 4000000 }))
  return { code: r.code, out: String(r.out || ''), errText: String(r.errText || '') }
}

/** 探测 skills CLI：优先 `npx --version`，再用 `-v` 拿 skills 自身版本。
 *  失败不抛错——状态路由要把「不可用」也当成正常结果展示。 */
export async function loadSkillsStatus(ctx: HostContext, runner: Runner, workspaceRoot?: string): Promise<Record<string, unknown>> {
  const ws = resolve(String(workspaceRoot || runner.getWorkspaceRoot() || process.cwd() || '/'))
  const home = process.env.HOME || homedir()
  const roots = resolveSkillsRoots(ws, home)
  const spec = String(getConfig().skillsCliSpec || '').trim() || SKILLS_DEFAULT_CLI_SPEC
  const status: Record<string, unknown> = {
    ok: true,
    updatedAt: Date.now(),
    roots,
    scopes: SKILL_SCOPES.slice(),
    agents: SKILL_AGENTS.slice(),
    installDefaultScope: 'global',
    searchApi: SKILLS_SEARCH_API,
    cliSpec: spec,
  }

  // node 可用性（CLI 通过 npx 运行，没有 node 就什么都做不了）。
  let nodeVersion: string | null = null
  let nodeAvailable = false
  try {
    const nodeBin = await resolveCliExe(
      (ctx.get('subprocess') as { resolveExecutable(name: string): Promise<string> } | undefined)?.resolveExecutable,
      'node',
    )
    if (nodeBin) {
      const r = await runner.tryRun(nodeBin, ['--version'], { graceMs: 8000 })
      if (r.code === 0) {
        nodeAvailable = true
        nodeVersion = String(r.out || '').trim().replace(/^v/, '') || null
      }
    }
  } catch (e) {}
  status.node = { available: nodeAvailable, version: nodeVersion }

  let cliVersion: string | null = null
  let cliAvailable = false
  let bin: string | null = null
  let error: string | null = null
  try {
    const argv = buildSkillsArgv('npx', ['-v'], { cliSpec: spec })
    const r = await runner.tryRun(argv[0], argv.slice(1), Object.assign(cliOpts(ws), { graceMs: 60000 }))
    if (r.code === 0) {
      cliVersion = parseSkillsCliVersion(r.out)
      cliAvailable = cliVersion !== null
      bin = argv[0]
    }
    if (!cliAvailable) {
      const text = (String(r.errText || '') + '\n' + String(r.out || '')).trim()
      error = text ? classifySkillsError(text) : 'skills CLI 探测失败（退出码 ' + String(r.code) + '）'
    }
  } catch (err) {
    error = classifySkillsError(err)
  }
  status.cli = { available: cliAvailable, version: cliVersion, tool: 'npx', bin, source: spec }
  const rootsExist: Record<string, boolean> = {}
  for (const key of Object.keys(roots) as Array<keyof typeof roots>) rootsExist[key] = await dirExists(roots[key])
  status.rootsExist = rootsExist
  if (error) status.error = error
  return status
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const st = await lstat(dir)
    return st.isDirectory() || st.isSymbolicLink()
  } catch (e) {
    return false
  }
}

/** 列表：本地读取（不经过 CLI），附上 CLI 可用性提示（不可用时 UI 只能看不能改）。 */
export async function loadSkillsList(ctx: HostContext, runner: Runner, scope: SkillScope, workspaceRoot?: string): Promise<Record<string, unknown>> {
  const ws = resolve(String(workspaceRoot || runner.getWorkspaceRoot() || process.cwd() || '/'))
  const home = process.env.HOME || homedir()
  const res = await listInstalledSkills(scope, ws, home)
  void ctx
  return {
    ok: true,
    updatedAt: Date.now(),
    scope,
    workspaceRoot: ws,
    skills: res.skills,
    roots: res.roots,
  }
}

export interface SkillUpdateStatus {
  name: string
  source: string | null
  status: 'current' | 'update' | 'unknown' | 'disabled'
  error?: string
}

/** Read-only: CLI `check` is an alias of update in skills 1.7, so compare
 * lock fingerprints with GitHub trees/blobs without invoking that command. */
export async function checkSkillsUpdates(runner: Runner, scope: SkillScope, workspaceRoot?: string): Promise<Record<string, unknown>> {
  const cwd = resolve(workspaceRoot || runner.getWorkspaceRoot() || process.cwd())
  const home = process.env.HOME || homedir()
  const lockPath = scope === 'project' ? join(cwd, 'skills-lock.json')
    : process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : join(home, '.agents', '.skill-lock.json')
  let entries: Record<string, Record<string, unknown>> = {}
  let lockError = '缺少安装来源记录，请从原来源重新安装'
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    if (!lock || !lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) throw new Error('无效的技能锁文件')
    entries = lock.skills
  } catch (e) {
    if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) lockError = '安装来源记录读取失败'
  }
  const installed = await listInstalledSkills(scope, cwd, home)
  // One tree request per repository/ref; failures remain unknown for every dependent skill.
  type TreeItem = { type: string; path: string; sha: string; mode: string }
  type GitTree = { sha: string; truncated?: boolean; tree: TreeItem[] }
  type GitBlob = { encoding: string; content: string }
  const trees = new Map<string, Promise<GitTree>>()
  const blobs = new Map<string, Promise<GitBlob>>()
  async function github<T>(path: string): Promise<T> {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (token) headers.Authorization = 'Bearer ' + token
    const response = await fetch('https://api.github.com/' + path, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      // Reuse the user's gh login for private sources or unauthenticated rate limits.
      if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 429) {
        try { return JSON.parse(await runner.forgeRun('github', ['api', '--hostname', 'github.com', path], { cwd })) as T } catch (e) {}
      }
      throw new Error('GitHub 来源检测失败（HTTP ' + response.status + '）')
    }
    return response.json() as Promise<T>
  }
  const skills: SkillUpdateStatus[] = []
  for (const row of installed.skills) {
    const entry = Object.hasOwn(entries, row.name) ? entries[row.name] : undefined
    const result: SkillUpdateStatus = { name: row.name, source: entry ? str(entry.source) || null : null, status: 'unknown' }
    skills.push(result)
    // 停用中：本地 SKILL.md 被改写了 disable-model-invocation 标记，指纹必然与来源
    // 不同——不再做来源比较（更新会把它覆盖回启用态）。单独报 disabled，界面标「已停用」。
    if (row.disabled) { result.status = 'disabled'; continue }
    if (!row.managed) { result.error = '非 CLI 管理的技能，无法检测更新'; continue }
    if (!entry) { result.error = lockError; continue }
    const source = str(entry.source)
    const path = str(entry.skillPath)
    const expected = str(scope === 'project' ? entry.computedHash : entry.skillFolderHash)
    if (entry.sourceType !== 'github' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source)) {
      result.error = '该来源暂不支持只读更新检测'; continue
    }
    if (!path || !skillRelativeFilePathValid(path) || !/SKILL\.md$/i.test(path) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected)) {
      result.error = '缺少可比较的安装指纹，请从原来源重新安装'; continue
    }
    try {
      const repo = 'repos/' + source
      const key = repo + '/git/trees/' + encodeURIComponent(str(entry.ref) || 'HEAD') + '?recursive=1'
      if (!trees.has(key)) trees.set(key, github<GitTree>(key))
      const tree = await trees.get(key)!
      if (!tree || tree.truncated || !Array.isArray(tree.tree)) throw new Error('来源文件树不完整，无法检测')
      if (!tree.tree.some((item) => item.type === 'blob' && item.path === path)) throw new Error('来源技能已移动或删除，请检查原来源')
      const folder = path.slice(0, -8).replace(/\/$/, '')
      let latest: string
      if (expected.length === 40) {
        const sha = folder ? tree.tree.find((item) => item.type === 'tree' && item.path === folder)?.sha : tree.sha
        if (!sha) throw new Error('来源技能目录不存在')
        latest = sha
      } else {
        const prefix = folder ? folder + '/' : ''
        const files = tree.tree.filter((item) => item.type === 'blob' && item.mode !== '120000' && item.path.startsWith(prefix))
          .map((item) => ({ ...item, relativePath: item.path.slice(prefix.length) }))
          .filter((item) => !item.relativePath.split('/').some((part: string) => part === '.git' || part === 'node_modules'))
          .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        const hash = createHash('sha256')
        for (const file of files) {
          const blobKey = repo + '/git/blobs/' + file.sha
          if (!blobs.has(blobKey)) blobs.set(blobKey, github<GitBlob>(blobKey))
          const blob = await blobs.get(blobKey)!
          if (blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('来源文件内容无法比较')
          hash.update(file.relativePath)
          hash.update(Buffer.from(blob.content, 'base64'))
        }
        latest = hash.digest('hex')
      }
      result.status = latest === expected ? 'current' : 'update'
    } catch (e) { result.error = classifySkillsError(e) }
  }
  return { ok: true, scope, skills }
}

/** 安装：CLI `add --json` → 归一成 installed/failed 两桶。 */
export async function installSkills(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope: SkillScope = isSkillScope(body.scope) ? body.scope : 'global'
  const cwd = resolve(String(body.cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const argv = buildSkillsAddArgv({
    package: body.package,
    skills: body.skills,
    scope,
    agents: body.agents,
    copy: body.copy !== false,
    all: body.all === true,
  })
  const r = await runSkillsCli(ctx, runner, argv, cwd, 180000)
  const parsed = parseSkillsJsonArray(r.out)
  const installed: Array<Record<string, unknown>> = []
  const failed: Array<Record<string, unknown>> = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const entry = {
      name: str(o.name),
      status: str(o.status) === 'installed' && !o.error ? 'installed' : 'failed',
      source: str(o.source) || null,
      path: str(o.path) || null,
      scope: str(o.scope) || scope,
      agents: Array.isArray(o.agents) ? o.agents.map(str) : [],
      security: o.security && typeof o.security === 'object' ? o.security : null,
    }
    if (str(o.status) === 'installed' && !o.error) installed.push(entry)
    else failed.push(Object.assign({ error: str(o.error) || '安装失败' }, entry))
  }
  const ok = r.code === 0 && failed.length === 0 && (installed.length > 0 || parsed.length === 0)
  const errText = (r.errText || '').trim()
  if (!ok && parsed.length === 0) {
    return {
      ok: false,
      error: errText ? classifySkillsError(errText) : '安装失败（skills CLI 退出码 ' + String(r.code) + '）',
      installed,
      failed,
      stdout: r.out.slice(0, 4000),
      stderr: errText.slice(0, 4000),
    }
  }
  return {
    ok: true,
    installed,
    failed,
    stdout: r.out.slice(0, 4000),
    stderr: errText.slice(0, 4000),
  }
}

/** 卸载：CLI `remove --json` 在成功时**不产出 JSON**（只打印提示文本），所以
 *  以退出码 + 目录是否还在为准，逐个回报。 */
export async function removeSkills(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope: SkillScope = isSkillScope(body.scope) ? body.scope : 'global'
  const cwd = resolve(String(body.cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const names = tokenList(body.skills, '技能名', 30)
  if (!names.length) throw new Error('缺少要卸载的技能名')
  const argv = buildSkillsRemoveArgv({ skills: names, scope, agents: body.agents })
  const r = await runSkillsCli(ctx, runner, argv, cwd, 120000)
  const home = process.env.HOME || homedir()
  const removed: string[] = []
  const failed: Array<{ name: string; error: string }> = []
  for (const name of names) {
    const still = await resolveInstalledSkillDir(name, scope, cwd, home)
    if (!still) removed.push(name)
    else failed.push({ name, error: r.code === 0 ? '目录仍存在（CLI 未删除）' : (r.errText || '').trim().slice(0, 200) || '卸载失败（退出码 ' + String(r.code) + '）' })
  }
  const ok = failed.length === 0 && r.code === 0
  return {
    ok,
    removed,
    failed,
    error: ok ? undefined : (removed.length ? '部分技能卸载失败' : (r.errText || '').trim().slice(0, 300) || '卸载失败（skills CLI 退出码 ' + String(r.code) + '）'),
    stdout: r.out.slice(0, 4000),
    stderr: (r.errText || '').slice(0, 4000),
  }
}

/** 停用 / 启用：编辑 SKILL.md frontmatter 的 `disable-model-invocation` 标记。
 *  停用 = DSH 把该技能从模型面向的目录排除（模型不再自动触发），文件保留、可随时
 *  启用——这是「停用但不卸载」的原生做法，且**不依赖 skills CLI**（纯文件改动，CLI
 *  不可用时也能用）。只允许作用域内的已装技能；frontmatter 用行级编辑，正文与其余
 *  字段原样保留；原子写（临时文件 + rename）。 */
export async function setSkillDisabled(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  void ctx
  const scope: SkillScope = isSkillScope(body.scope) ? body.scope : 'global'
  const name = String(body.name == null ? '' : body.name).trim()
  if (!skillDirNameValid(name)) throw new Error('无效的技能名：' + name.slice(0, 60))
  const cwd = resolve(String(body.cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const home = process.env.HOME || homedir()
  const dir = await resolveInstalledSkillDir(name, scope, cwd, home)
  if (!dir) return { ok: false, error: '未找到已安装的技能：' + name + '（作用域 ' + scope + '）' }
  const skillMd = join(dir, 'SKILL.md')
  let text: string
  try {
    text = await readFile(skillMd, 'utf8')
  } catch (e) {
    return { ok: false, error: '技能目录缺少 SKILL.md：' + basename(dir) }
  }
  const target = body.disabled === true
  const edited = editSkillInvocationFlag(text, target)
  if (edited === null) {
    return { ok: false, error: '技能缺少 frontmatter，无法写入停用标记：' + name }
  }
  if (edited !== text) {
    const tmp = join(dir, '.SKILL.md.tmp-' + String(Date.now()))
    try {
      await writeFile(tmp, edited, 'utf8')
      await rename(tmp, skillMd)
    } catch (e) {
      await rm(tmp, { force: true }).catch(function () {})
      return { ok: false, error: '写入 SKILL.md 失败：' + (e instanceof Error ? e.message : String(e)) }
    }
  }
  const invocation = parseSkillInvocation(edited)
  return {
    ok: true,
    name,
    scope,
    path: dir,
    disabled: invocation.disableModelInvocation,
    invocation,
    frontmatter: parseSkillFrontmatter(edited),
  }
}

/** 自动和手动更新共享进行中的任务，避免同时写同一作用域的锁文件。 */
const skillUpdates = new Map<string, Promise<Record<string, unknown>>>()

export function updateSkills(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope = isSkillScope(body.scope) ? body.scope : 'global'
  const cwd = resolve(String(body.cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const key = scope === 'global' ? 'global' : cwd
  const existing = skillUpdates.get(key)
  if (existing) return existing
  const task = performSkillsUpdate(ctx, runner, { scope, cwd }).finally(() => skillUpdates.delete(key))
  skillUpdates.set(key, task)
  return task
}

/** 更新：CLI 无 JSON，按文本报告判定（upToDate / updated）。 */
async function performSkillsUpdate(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope: SkillScope = isSkillScope(body.scope) ? body.scope : 'global'
  const cwd = resolve(String(body.cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const argv = buildSkillsUpdateArgv(scope)
  const r = await runSkillsCli(ctx, runner, argv, cwd, 300000)
  const report = parseSkillsUpdateReport(r.out + '\n' + r.errText)
  const ok = r.code === 0
  return {
    ok,
    scope,
    updated: report.updated,
    upToDate: report.upToDate,
    failed: [],
    error: ok ? undefined : classifySkillsError((r.errText || '').trim() || '更新失败（skills CLI 退出码 ' + String(r.code) + '）'),
    stdout: r.out.slice(0, 4000),
    stderr: (r.errText || '').slice(0, 4000),
  }
}

/** 安装前预览来源技能；list 模式不支持 --json，也不会安装文件。 */
export async function discoverSkills(ctx: HostContext, runner: Runner, pkg: unknown, cwd?: string): Promise<Record<string, unknown>> {
  const dir = resolve(String(cwd || '').trim() || runner.getWorkspaceRoot() || process.cwd() || '/')
  const argv = buildSkillsDiscoverArgv(pkg)
  const r = await runSkillsCli(ctx, runner, argv, dir, 120000)
  const output = r.out + '\n' + r.errText
  if (r.code !== 0) {
    const errors = parseSkillsJsonArray(output).filter(function (raw): raw is Record<string, unknown> { return !!raw && typeof raw === 'object' })
    const message = errors.map(function (raw) { return str(raw.error) }).filter(Boolean).join('；')
    return { ok: false, error: classifySkillsError(message || output.trim() || '无法读取技能来源') }
  }
  const skills = parseSkillsDiscoverOutput(output)
  if (!skills.length) return { ok: false, error: '无法解析来源技能列表，请检查 skills CLI 输出或来源是否包含有效技能' }
  return { ok: true, package: String(pkg), skills }
}

/** host 生命周期内运行；完成后再计时，慢任务不会重叠，卸载后不再调度。 */
export function startSkillsAutoUpdate(ctx: HostContext, runner: Runner, intervalMs: number, invalidate: () => void): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
  const delay = Math.min(2147483647, Math.max(60000, intervalMs))
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const run = async () => {
    for (const scope of SKILL_SCOPES) {
      if (stopped) break
      try {
        const result = await updateSkills(ctx, runner, { scope, cwd: defaultSkillsWorkspaceRoot(runner) })
        if (!result.ok) console.warn('[dsh-workbench] 技能自动更新失败:', scope, result.error)
      } catch (err) {
        console.warn('[dsh-workbench] 技能自动更新失败:', scope, classifySkillsError(err))
      } finally {
        invalidate()
      }
    }
    if (!stopped) schedule(delay)
  }
  const schedule = (ms: number) => {
    timer = setTimeout(() => { void run() }, ms)
    timer.unref?.()
  }
  // 让 host 完成启动后再调用 CLI。
  schedule(30000)
  return () => { stopped = true; clearTimeout(timer) }
}
