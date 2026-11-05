// dsh-workbench — host config: deployment-tunable parameters.
//
// Bundled by build.mjs into index.js together with the rest of src/host/*, so
// the deployment row `- id: dsh-workbench / name: dsh-workbench` keeps
// resolving the same `index.js` entry it always has. The Loader validates the
// row's `config` against the exported schemastery `Config` schema; the active
// values are read via getConfig() everywhere (helpers default before apply()).

import s from '@deepseek-ai/schemastery'

/** Deployment-tunable parameters (Loader-validated via `Config`). */
export interface Config {
  /** 本地 Git 安装自动更新间隔，0 关闭。 */
  readonly selfUpdateIntervalMs: number
  /** 自动评审轮询检查间隔（毫秒）。 */
  readonly autoReviewIntervalMs: number
  /** 推送触发自动评审的冷却窗口（毫秒），0 关闭：窗口内同一 MR/PR 的多次推送
   *  合并为一次评审，只评窗口结束后的最新提交。 */
  readonly autoReviewCooldownMs: number
  readonly autoReviewStateFile: string
  readonly autoReviewRetentionDays: number
  readonly autoReviewHistoryLimit: number
  readonly stateTtlMs: number
  /** /forge/mrs、/dms/orders、/dms/order 结果缓存 TTL。 */
  readonly listTtlMs: number
  /** /home/sessions 跨工作区会话扫描结果缓存 TTL。 */
  readonly homeSessionsTtlMs: number
  /** /notifications/list 结果缓存 TTL（首页通知区 / 未读徽标 / 通知页共享）。 */
  readonly notificationsTtlMs: number
  /** CLI auth/availability 探测缓存 TTL（glab/gh/aliyun 登录状态）。 */
  readonly authTtlMs: number
  /** /forge/state 单次拉全的分页上限（gitlab --per-page / github --limit 共用）。 */
  readonly allListLimit: number
  /** PingCode 技能目录（须含 scripts/api_call.py 与 .env）。留空自动探测
   *  ~/.agents/skills/pingcode / ~/.workbuddy/skills/pingcode。 */
  readonly pingcodeSkillDir: string
  /** skills CLI 来源：`skills@latest`（默认，经 npx）/ 固定版本 / 绝对路径
   *  （绝对路径或 ./ 开头 = 直接执行本机 skills 可执行文件）。 */
  readonly skillsCliSpec: string
  /** skills.sh 公开搜索端点的单次结果上限（1..50）。 */
  readonly skillsSearchLimit: number
  /** npx 的 npm 缓存目录（留空 = 用户默认 ~/.npm）。 */
  readonly skillsNpmCacheDir: string
  /** 自动更新间隔（毫秒），0 关闭。 */
  readonly skillsAutoUpdateIntervalMs: number
  /** SLS 环境列表（JSON 数组字符串）。每项
   *  `{ key, label, project, logstore, logs? }`：
   *  `project` / `logstore` 必填（`logstore` 是 Trace / 日志查询用的库），
   *  `logs` 是「日志」视图使用的库（缺省 = `logstore`），`key` 缺省由
   *  `project` 派生、`label` 缺省同 `key`。留空 = 未配置：SLS 页显示可编辑的
   *  Project / Logstore 输入框并提示管理员在此设置；非法 JSON、非数组或
   *  缺 project/logstore 的条目会被忽略（不抛错）。 */
  readonly slsEnvironments: string
}

/** schemastery schema the Loader validates the row's `config` against. */
export const Config = s.object({
  selfUpdateIntervalMs: s.number().default(300000),
  autoReviewIntervalMs: s.number().default(60000),
  autoReviewCooldownMs: s.number().default(300000),
  autoReviewStateFile: s.string().default(''),
  autoReviewRetentionDays: s.number().default(90),
  autoReviewHistoryLimit: s.number().default(20),
  stateTtlMs: s.number().default(15000),
  listTtlMs: s.number().default(300000),
  homeSessionsTtlMs: s.number().default(30000),
  notificationsTtlMs: s.number().default(30000),
  authTtlMs: s.number().default(600000),
  allListLimit: s.number().default(50),
  pingcodeSkillDir: s.string().default(''),
  skillsCliSpec: s.string().default('skills@latest'),
  skillsSearchLimit: s.number().default(30),
  skillsNpmCacheDir: s.string().default(''),
  skillsAutoUpdateIntervalMs: s.number().default(86400000),
  slsEnvironments: s.string().default(''),
})

const DEFAULT_CONFIG: Config = {
  selfUpdateIntervalMs: 300000,
  autoReviewIntervalMs: 60000,
  autoReviewCooldownMs: 300000,
  autoReviewStateFile: '',
  autoReviewRetentionDays: 90,
  autoReviewHistoryLimit: 20,
  stateTtlMs: 15000,
  listTtlMs: 300000,
  homeSessionsTtlMs: 30000,
  notificationsTtlMs: 30000,
  authTtlMs: 600000,
  allListLimit: 50,
  pingcodeSkillDir: '',
  skillsCliSpec: 'skills@latest',
  skillsSearchLimit: 30,
  skillsNpmCacheDir: '',
  skillsAutoUpdateIntervalMs: 86400000,
  slsEnvironments: '',
}

/** Active config — swapped by apply(); helpers read it so exported test
 *  helpers (loadStateLists etc.) keep working with the default before apply. */
let activeConfig: Config = DEFAULT_CONFIG

export function getConfig(): Config {
  return activeConfig
}

export function setConfig(config?: Config): void {
  if (config) activeConfig = config
}
