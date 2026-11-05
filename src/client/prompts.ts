// dsh-workbench — 提示词 / 功能开关配置管理（按人定制，浏览器本地持久化）。
//
// 提交 MR/PR、评审与 Issue 处理时发送的提示词，以及四个功能域的开关，都可被
// 每个使用者在自己的浏览器里定制（localStorage，等价于按人隔离；与 DMS
// Region/Tid、上次所在页同一套模式）。架构上是一套「配置注册表 + 存取层 +
// 设置面板」三元组：
//   - CONFIG_ITEMS 登记每一项配置（key / label / kind / scope / default /
//     help）。后续引入新配置只需往注册表加一项：对应 scope 的设置面板自动
//     渲染，业务代码用 resolveConfigText(key, vars) / resolveConfigToggle(key)
//     读取生效值，无需再动面板或调用点。scope 决定入口位置：'forge' = 仓库页
//     提示词，'global'（缺省）= 全局功能（功能开关）。
//   - 未定制（无覆盖 / 覆盖为空串）时读取返回 default —— 默认输出与引入配置
//     管理之前逐字节一致，老用户零感知。
//   - kind 决定设置面板控件：'prompt' = 多行文本框，'toggle' = 即时生效的
//     开关，'model' = 从 Host 模型目录拉取的下拉（值形如 provider/model）；
//     'text' / 'select' 等预留（配置面板里加分支）。
//   - 任何写入都会推进配置 revision 并广播给订阅者（subscribeConfig），
//     功能开关相关 UI（页签 / 侧栏常显入口 / 后台轮询）据此即时重渲染。
//
// 本模块是纯函数层（无 React 依赖），导出供 test/prompt-config.mjs 直接断言。

import { systemPrompt } from '../shared/git-commit-prompt.js'
import type { ForgeItem, IssueItem } from './types'
import { numLabel, repoPathFromIssueUrl } from './format'

export const CONFIG_LS_KEY = 'samanhappy.dsh-workbench.config'

// 配置变更广播：写入成功后 revision+1 并通知订阅者。功能开关的读取层
// （features.ts）据此即时重渲染，写入方无需手动通知——新增写入路径只要走
// 下面的 save/reset 就自动生效。
let configRev = 0
const configSubs = new Set<() => void>()

/** 当前配置 revision（每次成功写入 +1；作为「配置是否变过」的快照值）。 */
export function configRevision(): number {
  return configRev
}

/** 订阅配置变更，返回退订函数。 */
export function subscribeConfig(fn: () => void): () => void {
  configSubs.add(fn)
  return function () { configSubs.delete(fn) }
}

function notifyConfigChanged(): void {
  configRev += 1
  for (const fn of Array.from(configSubs)) { try { fn() } catch (e) {} }
}

export function loadConfig(): Record<string, string> {
  try {
    const raw = globalThis.localStorage ? globalThis.localStorage.getItem(CONFIG_LS_KEY) : null
    const p = raw ? JSON.parse(raw) : null
    return p && typeof p === 'object' ? p : {}
  } catch (e) {
    return {}
  }
}

/** 合并写入 patch；返回是否成功（设置面板据此提示「保存失败」，不再静默）。 */
export function saveConfig(patch: Record<string, string>): boolean {
  try {
    if (!globalThis.localStorage) return false
    const next = Object.assign(loadConfig(), patch)
    globalThis.localStorage.setItem(CONFIG_LS_KEY, JSON.stringify(next))
    notifyConfigChanged()
    return true
  } catch (e) {
    return false
  }
}

/** 清除单项定制；返回是否成功。 */
export function resetConfig(key: string): boolean {
  return resetConfigKeys([key])
}

/** 清除给定的一组 key 的定制（只动这些 key，其余保留）；返回是否成功。
 *  「全部恢复默认」按面板 scope 分域调用：仓库页的恢复默认不得清掉
 *  全局配置的定制（以及未来任何其他域的定制）。 */
export function resetConfigKeys(keys: Array<string>): boolean {
  try {
    if (!globalThis.localStorage || !keys.length) return false
    const next = loadConfig()
    for (const k of keys) delete next[k]
    globalThis.localStorage.setItem(CONFIG_LS_KEY, JSON.stringify(next))
    notifyConfigChanged()
    return true
  } catch (e) {
    return false
  }
}

/** 用 vars 渲染 {name} 占位符：已知键替换为值（值为空串/缺失时输出空）；
 * 未提供的占位符与非常规花括号（如 JSON 示例 {"a":1}）原样保留 ——
 * 避免用户提示词里的字面花括号被吞掉，只替换文档列出的占位符。 */
export function renderTemplate(tpl: string | null | undefined, vars?: Record<string, unknown> | null): string {
  return String(tpl == null ? '' : tpl).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, function (m, name) {
    const v = vars ? vars[name] : undefined
    return v === undefined || v === null ? m : String(v)
  })
}

/** 在文本的 [start,end) 选区处插入 token（替换选区），返回新文本与插入后的
 * 光标位置；缺省 = 追加到末尾，越界/负数下标收敛进 [0, len]。设置面板的
 * 占位符 chip 用它做「光标处原位插入」，替代旧的强制换行追加（会破坏句子）。 */
export function spliceToken(text: string | null | undefined, start: unknown, end: unknown, token: string): { text: string; caret: number } {
  const s = String(text == null ? '' : text)
  const len = s.length
  let a = Math.floor(Number(start))
  let b = Math.floor(Number(end))
  if (!isFinite(a)) a = len
  if (!isFinite(b)) b = len
  a = Math.max(0, Math.min(a, len))
  b = Math.max(a, Math.min(b, len))
  return { text: s.slice(0, a) + token + s.slice(b), caret: a + token.length }
}

/** 配置项归属的功能域：'forge' = 仓库页（MR/PR 评审 / 提交），入口在该页
 *  内；'home' = 首页显示选项；'global' = 全局功能，入口在工作台顶栏 ⚙。缺省按 'global' 处理 ——
 *  外层面板是默认位置，新的全局配置无需声明 scope。 */
export type ConfigScope = 'forge' | 'global' | 'home'

/** 配置项的默认值：文本类（kind 'prompt' 等）是字符串或渲染函数；开关类
 *  （kind 'toggle'）是布尔。 */
export type ConfigDefault = string | boolean | ((vars: Record<string, unknown>) => string)

export interface ConfigItem {
  key: string
  label: string
  kind: string
  scope?: ConfigScope
  help?: string
  placeholders?: Array<{ name: string; help: string }>
  default: ConfigDefault
  options?: Array<{ value: string; label: string }>
  preview?: string | null
}

/** 取某分域的配置项（'all' = 不分域，全部返回）。注册表驱动：面板按自己的
 *  scope 过滤渲染，后续新增配置只需在注册表声明 scope，面板自动归位。 */
export function configItemsFor(scope: ConfigScope | 'all'): ConfigItem[] {
  if (scope === 'all') return CONFIG_ITEMS.slice()
  return CONFIG_ITEMS.filter(function (c) { return (c.scope || 'global') === scope })
}

/** 取某项配置的生效文本：有非空覆盖 → 渲染覆盖模板；否则 → 注册表默认值
 * （default 可以是字符串，也可以接收 vars 返回默认文本的函数；字符串默认
 * 同样经过占位符渲染）。 */
export function resolveConfigText(key: string, vars?: Record<string, unknown> | null): string {
  const d = (CONFIG_ITEMS.find(function (c) { return c.key === key }) || { default: '' as ConfigDefault }).default
  const over = String(loadConfig()[key] || '').trim()
  if (over) return renderTemplate(over, vars || {})
  if (typeof d === 'function') return d(vars || {})
  return renderTemplate(typeof d === 'boolean' ? String(d) : d, vars || {})
}

// ── 功能开关（kind 'toggle'）────────────────────────────────────────────────
// 开关类配置与文本类共用同一份 localStorage 覆盖值：'' = 未定制（用注册表
// 默认），'off'/'0'/'false'/'no' = 关，其余非空值 = 开。功能域开关的 key 由
// 注册表导出，业务侧经 features.ts 读取，不在别处硬编码字符串。

/** 功能开关的注册表 key（唯一事实来源；features.ts 据此建 FeatureKey）。 */
export const FEATURE_CONFIG_KEYS = {
  forge: 'feature.forge',
  git: 'feature.git',
  dms: 'feature.dms',
  sls: 'feature.sls',
  pingcode: 'feature.pingcode',
  skills: 'feature.skills',
  notifications: 'feature.notifications',
} as const

export type FeatureKey = keyof typeof FEATURE_CONFIG_KEYS

export function shortcutConfigKey(featureKey: string): string {
  return featureKey.replace(/^feature\./, 'shortcut.')
}



/** 开关文本解析：'off' / '0' / 'false' / 'no'（大小写、空白不敏感）为关，
 *  其余（含空串）为开。 */
function parseSwitch(raw: unknown): boolean {
  const v = String(raw == null ? '' : raw).trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no')
}

/** 某配置项的开关默认值（布尔默认直接取；非开关项或未知 key 视为开启）。 */
export function defaultToggleOf(key: string): boolean {
  const item = CONFIG_ITEMS.find(function (c) { return c.key === key })
  if (!item) return true
  return typeof item.default === 'boolean' ? item.default : parseSwitch(item.default)
}

/** 取开关类配置的生效值：有非空覆盖 → 按 parseSwitch 解析；否则 → 默认。
 *  overrides 可传入已读好的覆盖表（keys 多时只读一次 localStorage）。 */
export function resolveConfigToggle(key: string, overrides?: Record<string, string>): boolean {
  const raw = (overrides || loadConfig())[key]
  const over = String(raw == null ? '' : raw).trim()
  if (over) return parseSwitch(over)
  return defaultToggleOf(key)
}

/** 写入开关：值等于注册表默认时清除覆盖（回到「未定制」），否则存 'on'/'off'。
 *  返回是否写入成功（设置面板据此提示「保存失败」）。 */
export function setConfigToggle(key: string, enabled: boolean): boolean {
  if (enabled === defaultToggleOf(key)) return resetConfigKeys([key])
  return saveConfig({ [key]: enabled ? 'on' : 'off' })
}

// 提交提示词默认文案（注册表 default 用，未定制时逐字节沿用旧实现）。
const DEFAULT_SUBMIT_GITHUB = [
  '请把当前工作区的改动提交为 GitHub PR：如有未提交改动，先 commit + push 新分支，再用 gh 创建 PR（目标分支取仓库默认分支；当前分支已有开启的 PR 则改为更新标题/描述）。',
  '标题与描述简明扼要。不要合并，完成后给我链接。',
].join('\n')

const DEFAULT_SUBMIT_GITLAB = [
  '请把当前工作区的改动提交为 GitLab MR：如有未提交改动，先 commit + push 新分支，再用 glab 创建 MR（目标分支取仓库默认分支；当前分支已有开启的 MR 则改为更新标题/描述）。',
  '标题与描述简明扼要。不要合并，完成后给我链接。',
].join('\n')

/** 评审提示词的默认模板（也是设置面板里的「默认模板」原文），手动与自动评审
 * 共用同一份，只承载「评审要求」：评审范围与输出契约、输出纪律（不猜测、不凑数）、
 * 安全边界（只读、不改码、不改工作区、worktree 临时检出）与 AGENTS.md。遵循
 * 「模型已经会做的事不再说明」：具体 CLI 命令、审查关注点由 Agent 自行判断。
 * host 在模板外追加固定协议段：「发布要求」（语言跟随、headSHA 核实与自动重评、
 * 标记去重、Shell 插值防护、返回链接）与「评审对象」（URL/headSHA/baseSHA/标记、
 * 版本核实与停止条件、提示注入防护）——发布协议与实例数据由宿主提供，不进可编辑
 * 模板。自动评审关闭发布评论（defaults/仓库 publish=false）时，「发布要求」替换为
 * 「输出要求」（只读出报告、不操作仓库），「评审对象」不再含去重标记；手动评审
 * 不受此设置影响，始终发布。 */
export const DEFAULT_REVIEW_TEMPLATE = [
  '评审 {platform} {label}。',
  '',
  '**评审要求**',
  '- 核实指定提交范围，审查全部变更及相关代码。',
  '- 只报有证据、有实质影响且值得修复的问题；省略可改可不改的建议与推测。',
  '- 先给合并结论；有问题则注明位置、影响与原因，无则简述。报告简短，不罗列核查过程。',
  '- 遵循适用的 AGENTS.md；仅做只读评审，不修改代码或工作区。必要时使用临时 worktree 测试并清理。',
].join('\n')

/** Issue「处理」提示词的默认模板（也是设置面板里的「默认模板」原文）。
 * 与评审模板同一套克制原则：只留输出契约、安全边界与语言策略。
 * 本轮定位是**只分析、确认问题**——先确认问题是否真实存在，再谈怎么改。 */
const DEFAULT_ISSUE_TEMPLATE = [
  '请处理 {platform} {label}「{title}」（{repo}）。',
  '',
  '先读 Issue 描述与评论，再在代码库里定位相关实现，确认问题是否真实存在、复现路径与影响范围；给出结论：能否复现 / 根因假设 / 涉及文件与行号，按「🔴 已确认 / 🟡 待确认 / 💬 信息不足」三档列出结论与依据。',
  '本轮只做分析与确认：不改代码、不提交、不新建分支，也不关闭 Issue 或发表评论。报告用中文；若要把结论发表为 Issue 评论，先询问我。',
].join('\n')

// ── 评审模型（kind 'model'）─────────────────────────────────────────────────
// 「点评审时用哪个模型」是按人可定制的偏好：配置项存 provider/model 引用
// （与 DSH 自己的模型选择行同一约定），未定制 / 值畸形 → 沿用 DSH 默认模型。
// 只在这一处定义 key 与取值格式，面板与点击链路都从这里读。

/** 「评审模型」的配置 key（唯一事实来源）。 */
export const REVIEW_MODEL_KEY = 'review.model'

/** 组装配置值：`<provider>/<model>`（provider 路由 id 不含 '/'，故按第一个
 *  '/' 切分反解即可；模型 id 自身含 '/' 也不会被截断）。 */
export function formatModelRef(provider: unknown, model: unknown): string {
  const p = String(provider == null ? '' : provider).trim()
  const m = String(model == null ? '' : model).trim()
  return p && m ? p + '/' + m : ''
}

/** 解析配置里的模型引用；空串 / 缺 '/' / 任一侧为空 → null（沿用默认模型）。 */
export function parseModelRef(value: unknown): { provider: string; model: string } | null {
  const raw = String(value == null ? '' : value).trim()
  const at = raw.indexOf('/')
  if (at <= 0 || at >= raw.length - 1) return null
  const provider = raw.slice(0, at).trim()
  const model = raw.slice(at + 1).trim()
  return provider && model ? { provider: provider, model: model } : null
}

/** 生效的评审模型：未定制 / 值畸形 → null（评审会话沿用 DSH 默认模型）。 */
export function resolveReviewModel(): { provider: string; model: string } | null {
  return parseModelRef(loadConfig()[REVIEW_MODEL_KEY])
}

/** 配置注册表。kind: 'prompt' = 多行文本框，'toggle' = 即时生效的开关
 *  （功能开关；关闭后对应功能页签 / 入口消失且不再发起相关请求）。
 *  注册表顺序 = 配置页渲染顺序（功能开关在前，提示词在后）。 */
export const CONFIG_ITEMS: ConfigItem[] = [
  {
    key: FEATURE_CONFIG_KEYS.forge,
    label: '仓库',
    kind: 'toggle',
    scope: 'global',
    default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.git, label: 'Git', kind: 'toggle', scope: 'global', default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.dms,
    label: 'DMS',
    kind: 'toggle',
    scope: 'global',
    default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.sls,
    label: 'SLS',
    kind: 'toggle',
    scope: 'global',
    default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.pingcode,
    label: 'PingCode',
    kind: 'toggle',
    scope: 'global',
    help: '研发工作项',
    default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.skills,
    label: '技能',
    kind: 'toggle',
    scope: 'global',
    help: '关闭页面不影响已安装技能。',
    default: true,
  },
  {
    key: FEATURE_CONFIG_KEYS.notifications,
    label: '显示 GitHub 通知',
    kind: 'toggle',
    scope: 'home',
    help: '关闭后停止查询通知。',
    default: true,
  },
  {
    key: REVIEW_MODEL_KEY,
    label: '评审模型',
    kind: 'model',
    scope: 'forge',
    help: '用于新评审会话，留空沿用 DSH 默认模型。发起评审时也会将所选模型设为全局默认模型，影响后续新会话。',
    default: '',
  },
  {
    key: 'git.commit.language',
    label: 'Git 提交信息语言',
    kind: 'select',
    scope: 'forge',
    default: 'zh',
    options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }],
    help: '用于 AI 生成、一键提交和一键推送；语言以此选项为准。',
  },
  {
    key: 'prompt.git.commit',
    label: 'Git 提交信息提示词',
    kind: 'prompt',
    scope: 'forge',
    help: 'AI 生成本地 Git 提交信息时使用，可定制语言、格式及提交规范；留空恢复默认。仓库、分支、文件列表和 Diff 会自动附加，无需占位符。最多 12000 字符。',
    default: systemPrompt('zh-CN'),
  },
  {
    key: 'prompt.review',
    label: '评审提示词',
    kind: 'prompt',
    scope: 'forge',
    help: '新评审会话的指令，留空使用默认模板。',
    default: DEFAULT_REVIEW_TEMPLATE,
  },
  {
    key: 'prompt.issue',
    label: 'Issue 处理提示词',
    kind: 'prompt',
    scope: 'forge',
    help: '新 Issue 处理会话的指令；点击占位符插入。',
    placeholders: [
      { name: 'platform', help: 'GitHub Issue / GitLab Issue' },
      { name: 'label', help: '编号标识，如 #128' },
      { name: 'num', help: '纯数字编号' },
      { name: 'title', help: '标题' },
      { name: 'repo', help: '仓库路径，如 group/proj' },
      { name: 'author', help: '创建者' },
      { name: 'web_url', help: '详情页链接' },
      { name: 'description', help: '描述（前 500 字）' },
      { name: 'cli', help: 'CLI 名：gh / glab' },
      { name: 'view_cmd', help: '查看详情的命令' },
      { name: 'note_cmd', help: '发表评论的命令' },
    ],
    default: DEFAULT_ISSUE_TEMPLATE,
  },
  {
    key: 'prompt.submit.github',
    label: '提交 GitHub PR 提示词',
    kind: 'prompt',
    scope: 'forge',
    help: '提交 PR 时发送给当前会话的指令。',
    default: DEFAULT_SUBMIT_GITHUB,
  },
  {
    key: 'prompt.submit.gitlab',
    label: '提交 GitLab MR 提示词',
    kind: 'prompt',
    scope: 'forge',
    help: '提交 MR 时发送给当前会话的指令。',
    default: DEFAULT_SUBMIT_GITLAB,
  },
]

/** 评审条目的占位符变量集（{name} 与设置面板帮助文案一一对应）。 */
export function reviewPromptVars(item: ForgeItem): Record<string, unknown> {
  const isGh = item.forge === 'github'
  return {
    platform: isGh ? 'GitHub PR' : 'GitLab MR',
    label: numLabel(item),
    num: item.num,
    title: item.title || '',
    source_branch: item.source_branch,
    target_branch: item.target_branch,
    author: item.author || '',
    web_url: item.web_url || '',
    description: item.description ? String(item.description).trim().slice(0, 500) : '',
    cli: isGh ? 'gh' : 'glab',
    diff_cmd: isGh ? 'gh pr diff ' + item.num : 'glab mr diff ' + item.num,
    view_cmd: isGh ? 'gh pr view ' + item.num : 'glab mr view ' + item.num,
    note_cmd: isGh ? 'gh pr comment ' + item.num : 'glab mr note create ' + item.num,
  }
}

/** The effective review prompt submitted into the fresh workspace session.
 * The session cwd IS the repo working copy, so the plain CLI diff command in
 * it resolves the right host/repo without extra flags. Users may override the
 * whole template through the workbench ⚙ settings (prompt.review). */
export function buildReviewPrompt(item: ForgeItem): string {
  return resolveConfigText('prompt.review', reviewPromptVars(item))
}

/** Issue「处理」条目的占位符变量集（{name} 与设置面板帮助文案一一对应）。 */
export function issuePromptVars(item: IssueItem): Record<string, unknown> {
  const isGh = item.forge === 'github'
  return {
    platform: isGh ? 'GitHub Issue' : 'GitLab Issue',
    label: '#' + String(item.num),
    num: item.num,
    title: item.title || '',
    repo: repoPathFromIssueUrl(item.web_url) || '',
    author: item.author ? (item.author.name || item.author.username || '') : '',
    web_url: item.web_url || '',
    description: item.description ? String(item.description).trim().slice(0, 500) : '',
    cli: isGh ? 'gh' : 'glab',
    view_cmd: isGh ? 'gh issue view ' + item.num : 'glab issue view ' + item.num,
    note_cmd: isGh ? 'gh issue comment ' + item.num : 'glab issue note ' + item.num,
  }
}

/** The effective Issue prompt submitted into the fresh workspace session.
 * The session cwd IS the repo working copy, so the plain CLI commands in it
 * resolve the right host/repo without extra flags. Users may override the
 * whole template through the workbench ⚙ settings (prompt.issue). */
export function buildIssuePrompt(item: IssueItem): string {
  return resolveConfigText('prompt.issue', issuePromptVars(item))
}

/** 提交 MR/PR 的提示词（消息上的「提交 MR/PR」按钮用）。可通过工作台
 * ⚙ 设置按平台定制（prompt.submit.github / prompt.submit.gitlab）。 */
export function buildSubmitPrompt(forge: 'gitlab' | 'github'): string {
  return resolveConfigText(
    forge === 'github' ? 'prompt.submit.github' : 'prompt.submit.gitlab',
    { platform: forge === 'github' ? 'GitHub PR' : 'GitLab MR' },
  )
}
