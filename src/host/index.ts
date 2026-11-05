import { apply as registerGitRoutes } from './git/register.js'
import { loadNotifications, notificationHost, notificationActionArgv } from './notifications'
export { notificationHost, notificationListArgv, notificationActionArgv, parseNotifications } from './notifications'
// dsh-workbench — host half (composition plugin row), TypeScript source.
//
// Bundled by build.mjs (esbuild) from src/host/*.ts into the package-root
// `index.js` (ESM, with @deepseek-ai/schemastery inlined), so the deployment
// row `- id: dsh-workbench / name: dsh-workbench` resolves the same entry it
// always has. Registers same-origin routes under /forge/* that drive the
// locally installed `glab` (GitLab CLI) and `gh` (GitHub CLI) through the DSH
// subprocess service, plus /dms/* routes that drive the locally installed
// `aliyun` CLI (dms-enterprise) for DMS 工单 (see ./dms.ts). The browser widget
// (src/client/*, built to lib/client.js) reads and writes merge requests /
// pull requests / DMS orders through these routes — no dynamic Cordis runner,
// no approval, no steering.
//
// Source layout (all bundled together by build.mjs):
//   config.ts — schemastery Config schema + active-config accessor
//   runner.ts — HostContext/Runner contracts, http helpers, classifyError,
//               CLI-availability probe (shared by forge + dms)
//   dms.ts    — DMS 工单 domain (aliyun CLI)
//   index.ts  — forge domain (this file) + route wiring + apply()
//
// Forge model: every request resolves to exactly one forge — 'gitlab' (glab)
// or 'github' (gh) — either explicitly (query/body `forge`) or by
// auto-detecting the git remote host against the CLIs' auth status:
//   glab: "Logged in to <host> as <user>"
//   gh:   "Logged in to <host> account <user>"
// plus the well-known hosts (gitlab.com / github.com). GitLab MRs and GitHub
// PRs are normalized into one item view (num / source_branch / target_branch /
// web_url / labels / …) so the client renders both forges with one component.
//
// Route shape (all JSON):
//   GET  /forge/state             workspace git repo state + MR/PR summary
//   GET  /forge/workspaces        per-workspace forge association (registry × git remote × CLI auth)
//   GET  /forge/mrs               list items (scope=all|mine|review — review 指
//                                 派给我且我尚未批准，GitLab 用 GraphQL
//                                 approvedBy 覆盖层剔除已批准项, forge=, repo=, host=, cwd=)
//   GET  /forge/mr                item detail (num=, forge=, repo=, host=, cwd=)
//   GET  /forge/mr/diff           unified diff text (num=, forge=, repo=, host=, cwd=)
//   POST /forge/mr/approve        approve {num,forge,cwd}  (GitHub: pr review --approve)
//   POST /forge/mr/merge          merge {num,squash,removeSource,forge,cwd}
//   POST /forge/mr/note           comment {num,body,forge,cwd}
//   POST /forge/mr/close          close {num,forge,cwd}
//   (Issues 路由 /forge/issues*：/forge/issues 列表（scope=mine|assigned|all +
//    state/search/label/assignee/sort/page，GitLab 走 glab api 分页 + X-Total，
//    GitHub 走 gh issue list 本地切片）、/forge/issue 详情（评论 + 关联 MR）、
//    /forge/issue/meta（统计 + 标签 + 可指派成员）、/forge/issue/update|close|
//    reopen|note — 见 ./issues.ts）
//   (DMS 工单 /dms/* routes: /dms/status /dms/orders /dms/order /dms/order/sql
//    /dms/order/approve over the local `aliyun` CLI — see ./dms.ts)
//   (SLS 日志 /sls/* routes: /sls/status /sls/query over the local `aliyun`
//    CLI (`sls get-logs-v2`) — see ./sls.ts)
//
// Trust: every route asks `connection.requestRejection(req)` first (Host/Origin
// fence + login cookie), the same security shape as open-in-app and the
// ark-usage widget. Fail-soft: nothing here throws into composition startup.
//
// Config (schemastery, validated by the Loader against the exported `Config`
// schema): TTLs and the all-list page cap are tunable per deployment instead
// of being hardcoded module constants (see ./config.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createAutoReview } from './auto-review'
import type { ReviewController, ReviewRepo, ReviewScope } from './auto-review'
export { createAutoReview, reviewRepoKey } from './auto-review'
import { Config, getConfig, setConfig } from './config'
import { createSelfUpdater } from './self-update'
export { createSelfUpdater } from './self-update'
import type { ForgeKey, HostContext, RunOpts, RunResult, Runner } from './runner'
import { classifyError, connectionOf, exeAvailable, queryOf, readBody, resolveCliExe, sendJson } from './runner'
import type { HomeSessionsPayload } from './home'
import { scanHomeSessions } from './home'
export {
  sessionLogOf, parseSessionLog, decompressAll, loadProjectionCache, probeLockHeld,
  selectHomeSessions, scanHomeSessions, sessionRoot,
  HOME_SCAN_KEEP_MS, HOME_RECENT_MS, HOME_RECENT_CAP,
} from './home'
export type { HomeSessionRow, HomeSessionsPayload } from './home'
import type { DmsStatusPayload } from './dms'
import { classifyDmsError, handleDmsApprove, loadDmsOrder, loadDmsOrders, loadDmsOrderSql, loadDmsStatus } from './dms'
import { classifySlsError, parseSlsEnvironments, runSlsQuery } from './sls'
import type { SlsEnvironment } from './sls'
import type { PingcodeStatusPayload } from './pingcode'
import { classifyPingcodeError, loadPingcodeMembers, loadPingcodeProjects, loadPingcodeStatus, loadPingcodeWorkItem, loadPingcodeWorkItems } from './pingcode'
import type { IssueFilters, IssueStats, IssueView, RelatedMrView } from './issues'
import {
  checkSkillsUpdates, classifySkillsError, defaultSkillsWorkspaceRoot, discoverSkills, installSkills, isSkillScope, loadSkillDetail, loadSkillFile,
  loadSkillsList, loadSkillsStatus, removeSkills, searchSkillsCatalog, setSkillDisabled, updateSkills, startSkillsAutoUpdate,
  buildSkillsAddArgv, buildSkillsArgv, buildSkillsDiscoverArgv, buildSkillsListArgv, buildSkillsRemoveArgv,
  buildSkillsUpdateArgv, editSkillInvocationFlag, parseSkillFrontmatter, parseSkillInvocation, parseSkillsCliVersion, parseSkillsJsonArray, parseSkillsUpdateReport,
  resolveInstalledSkillDir, resolveSkillsRoots, skillScopeRoots, skillDirNameValid, toSkillSearchItem,
  SKILL_AGENTS, SKILLS_DEFAULT_CLI_SPEC, SKILLS_SEARCH_API, SKILL_SCOPES,
} from './skills'
import type { SkillScope } from './skills'
import {
  githubIssueStatsArgvs, githubIssueUpdateArgv, githubIssuesArgv, githubLabelsArgv, githubMembersArgv,
  gitlabIssueNotesArgv, gitlabIssueStatsArgvs, gitlabIssueUpdateArgv, gitlabIssuesArgv,
  gitlabLabelsArgv, gitlabMembersArgv, gitlabRelatedMrsArgv, issueCloseArgv, issueNoteArgv, issueReopenArgv,
  issueViewArgv, normalizeIssueFilters, normalizeRelatedMrs, parseGlabApiWithHeaders, parseGithubIssueList,
  parseGitlabIssueList, toIssueView,
} from './issues'

export { Config }
export { getConfig, setConfig } from './config'
export { resolveCliExe } from './runner'
export { buildSlsArgv, classifySlsError, parseSlsResult, parseSlsEnvironments, runSlsQuery } from './sls'
export type { SlsEnvironment } from './sls'
export { classifyDmsError, loadDmsOrderSql } from './dms'
export {
  buildSkillsAddArgv, buildSkillsArgv, buildSkillsDiscoverArgv, buildSkillsListArgv, buildSkillsRemoveArgv,
  buildSkillsUpdateArgv, classifySkillsError, discoverSkills, editSkillInvocationFlag, installSkills, isSkillScope, loadSkillDetail, loadSkillFile,
  loadSkillsList, loadSkillsStatus, parseSkillsDiscoverOutput, parseSkillFrontmatter, parseSkillInvocation, parseSkillsCliVersion, parseSkillsJsonArray,
  parseSkillsUpdateReport, removeSkills, resolveInstalledSkillDir, resolveSkillsRoots, searchSkillsCatalog,
  setSkillDisabled, skillScopeRoots, skillDirNameValid, skillRelativeFilePathValid, toSkillSearchItem, updateSkills, startSkillsAutoUpdate, applySkillMetadata,
  SKILL_AGENTS, SKILL_SCOPES, SKILLS_SEARCH_API, SKILLS_DEFAULT_CLI_SPEC, defaultSkillsWorkspaceRoot, SKILLS_FILE_IMAGE_MAX,
} from './skills'
export type { SkillScope, SkillAgent, InstalledSkill, SkillSearchItem } from './skills'
export {
  appendFileToken, buildApiCallArgv, classifyPingcodeError, clearFileTokenCache, clearMyselfCache, clearStatesCache, defaultSkillDirs, loadPingcodeMembers, loadPingcodeProjects,
  loadPingcodeStatus, loadPingcodeWorkItem, loadPingcodeWorkItems, parseEnvLines, parseListPayload,
  pingcodeEnvState, resolveSkillDir, sanitizeRichText, toMemberView, toNoteView, toProjectView, toWorkItemView,
  PC_STATE_TYPES, PC_WORK_ITEM_TYPES,
} from './pingcode'
export {
  githubIssuesArgv, githubIssueStatsArgvs, githubIssueUpdateArgv,
  gitlabIssueNotesArgv, gitlabIssuesArgv, gitlabIssueUpdateArgv, gitlabRelatedMrsArgv,
  issueCloseArgv, issueNoteArgv, issueReopenArgv, issueViewArgv, normalizeIssueFilters, normalizeRelatedMrs,
  parseGlabApiWithHeaders, parseGithubIssueList, parseGitlabIssueList, toIssueView,
} from './issues'
export const name = '@samanhappy/dsh-workbench'
export const inject = ['webServer', 'connection', 'subprocess']

// ── forge identity ──────────────────────────────────────────────────────────

const FORGES: Record<ForgeKey, { exe: string; name: string }> = {
  gitlab: { exe: 'glab', name: 'GitLab' },
  github: { exe: 'gh', name: 'GitHub' },
}
const FORGE_KEYS: ForgeKey[] = Object.keys(FORGES) as ForgeKey[]

function forgeKey(v: unknown): ForgeKey | null {
  return v === 'gitlab' || v === 'github' ? v : null
}

// ── runner ──────────────────────────────────────────────────────────────────

function createRunner(ctx: HostContext): Runner {
  const subprocess = ctx.get('subprocess') as {
    resolveExecutable(exe: string): Promise<string>
    spawn(spec: {
      argv: string[]
      cwd?: string
      stdio: { stdin: string; stdout: { maxBytes: number; spill?: { maxBytes: number } }; stderr: { maxBytes: number } }
      graceMs?: number
    }): {
      done: Promise<{ exitCode: number }>
      collected: { stdout: { readFrom(offset: number): { text: string; lossy?: boolean; spillPath?: string } }; stderr: { readFrom(offset: number): { text: string; lossy?: boolean; spillPath?: string } } }
      terminate(): void
      waitForExit(): Promise<boolean>
    }
  } | undefined

  function getWorkspaceRoot(): string {
    try {
      const policy = ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined
      if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot) {
        return policy.workspaceRoot
      }
    } catch (e) {}
    try {
      const fs = ctx.get('fs') as { resolve(path: string): string | null; processPath(path: string): string } | undefined
      if (fs) {
        const target = fs.resolve('.')
        if (target) return fs.processPath(target)
      }
    } catch (e) {}
    return process.cwd() || '/'
  }

  // Resolving an executable is cached per CLI (including the `--version`
  // check). Another plugin can prepend a wrapper shim to the app PATH whose
  // extra argv breaks the wrapped CLI — dsh-superagent's worker-bin `glab`
  // always injects `--hostname`, so `glab --version` / `glab mr list` exit
  // non-zero. Such a hit is rejected and a real install is used instead.
  const cliCache = new Map<string, Promise<string | null>>()

  function probeCli(path: string): Promise<boolean> {
    if (subprocess === undefined) return Promise.resolve(false)
    try {
      const handle = subprocess.spawn({
        argv: [path, '--version'],
        cwd: getWorkspaceRoot(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 10000,
      })
      return handle.done.then((outcome) => outcome.exitCode === 0, () => false)
    } catch (e) {
      return Promise.resolve(false)
    }
  }

  function resolveCli(name: string): Promise<string | null> {
    const cached = cliCache.get(name)
    if (cached) return cached
    const pending = resolveCliExe(
      subprocess ? (n: string) => subprocess.resolveExecutable(n) : undefined,
      name,
      probeCli,
    )
    cliCache.set(name, pending)
    // A miss is not cached: a later retry may find a freshly installed CLI
    // (the auth/availability caches still throttle repeated attempts).
    void pending.then((exe) => { if (!exe) cliCache.delete(name) }, () => { cliCache.delete(name) })
    return pending
  }

  async function exec(exeName: string, argv: string[], opts: RunOpts = {}): Promise<RunResult> {
    if (subprocess === undefined) {
      const err = new Error('subprocess 服务不可用')
      throw err
    }
    // resolveCliExe falls back to known install locations (Homebrew, /usr/local,
    // ~/.local/bin, nvm) when the host PATH hides the CLI — DSH as a macOS GUI
    // app does not load ~/.zshrc/~/.zprofile, so Homebrew installs are invisible
    // to `subprocess.resolveExecutable` alone.
    const exe = await resolveCli(exeName)
    if (!exe) {
      const err = new Error('未检测到 ' + exeName + ' 命令行工具')
      err.name = 'CliNotFoundError'
      throw err
    }
    const handle = subprocess.spawn({
      argv: [exe].concat(argv),
      cwd: opts.cwd || getWorkspaceRoot(),
      // Best-effort extra environment (npm_config_cache for the skills CLI):
      // unknown spawn-spec fields are ignored by services that do not accept them.
      ...(opts.env ? { env: opts.env } : {}),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: opts.maxBytes || 4000000, ...(opts.spillMaxBytes ? { spill: { maxBytes: opts.spillMaxBytes } } : {}) },
        stderr: { maxBytes: 300000 },
      },
      graceMs: opts.graceMs || 20000,
    })
    const outcome = await handle.done
    const stdout = handle.collected?.stdout?.readFrom(0)
    let out = stdout?.text || ''
    if (stdout?.lossy) {
      if (!stdout.spillPath) throw new Error(exeName + ' 输出超出大小上限，无法读取完整结果；请减少返回行数或缩小查询范围')
      try {
        out = await readFile(stdout.spillPath, 'utf8')
      } finally {
        await unlink(stdout.spillPath)
      }
    }
    const errText = handle.collected && handle.collected.stderr
      ? handle.collected.stderr.readFrom(0).text : ''
    return { out, errText, code: outcome.exitCode }
  }

  async function run(exeName: string, argv: string[], opts: RunOpts = {}): Promise<string> {
    const r = await exec(exeName, argv, opts)
    if (r.code !== 0) {
      const e = new Error(r.errText.trim() || exeName + ' 退出码 ' + String(r.code))
      ;(e as { stderr?: string }).stderr = r.errText
      throw e
    }
    return r.out
  }

  /** Never throws: captures output regardless of exit code (for probing commands like `glab auth status`). */
  async function tryRun(exeName: string, argv: string[], opts: RunOpts = {}): Promise<RunResult> {
    try {
      return await exec(exeName, argv, opts)
    } catch (e) {
      return { out: '', errText: String(e instanceof Error ? e.message : e), code: 1 }
    }
  }

  /** Run a forge CLI (glab / gh) with the forge-agnostic argv already built. */
  async function forgeRun(forge: ForgeKey, argv: string[], opts: RunOpts = {}): Promise<string> {
    const def = FORGES[forge]
    if (!def) throw new Error('未知平台：' + String(forge))
    return run(def.exe, argv, opts)
  }

  async function git(argv: string[], opts: RunOpts = {}): Promise<string> {
    return run('git', argv, opts)
  }

  return { forgeRun, git, tryRun, getWorkspaceRoot }
}

// ── CLI auth / availability (cached) ────────────────────────────────────────

interface AuthHost { host: string; user: string }

let authCache: { at: number; byForge: Record<string, AuthHost[]> } | null = null

/** Parse `glab auth status` / `gh auth status` output into [{ host, user }].
 *  Both CLIs emit "Logged in to <host> as|account <user>", but only after their
 *  API probe succeeds: offline or with a half-broken network glab prints
 *  "x <host>: API call failed: ..." plus "✓ Token found" instead, and gh prints
 *  "X Failed to log in to <host> account <user>". Those hosts ARE configured,
 *  so they must still count — otherwise a network blip reads as "not logged in"
 *  and every forge request fails with a misleading platform error. A 401 is the
 *  one failure that means the token itself is unusable, so it stays excluded.
 *  The status table may land on stdout or stderr depending on version/tty. */
export function parseAuthHosts(text: string): AuthHost[] {
  const hosts: AuthHost[] = []
  const add = (host: string, user = ''): void => {
    if (!host || hosts.some((h) => h.host === host)) return
    hosts.push({ host, user })
  }
  for (const m of text.matchAll(/Logged in to (\S+)(?: (?:account|as) (\S+))?/g)) add(m[1], m[2] || '')
  for (const m of text.matchAll(/Failed to log in to (\S+) account (\S+)/g)) add(m[1], m[2])
  // glab: group the per-instance blocks by their unindented host header so a
  // "Token found" line is only credited to the instance it belongs to.
  const blocks = new Map<string, string[]>()
  let current: string | null = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (line === trimmed && /^[A-Za-z0-9._:-]+$/.test(trimmed)) {
      current = trimmed
      if (!blocks.has(current)) blocks.set(current, [])
      continue
    }
    if (current) blocks.get(current)!.push(trimmed)
  }
  for (const [host, lines] of blocks) {
    const body = lines.join('\n')
    if (!/Token found/.test(body) || !/API call failed/.test(body)) continue
    if (/API call failed[^\n]*\b401\b/.test(body)) continue
    add(host)
  }
  return hosts
}

/** Logged-in hosts per forge, cached for authTtlMs. */
async function forgeAuthHosts(runner: Runner, forge: ForgeKey): Promise<AuthHost[]> {
  const now = Date.now()
  if (!authCache || now - authCache.at >= getConfig().authTtlMs) authCache = { at: now, byForge: {} }
  if (authCache.byForge[forge]) return authCache.byForge[forge]
  const exe = FORGES[forge].exe
  const r = await runner.tryRun(exe, forge === 'gitlab' ? ['auth', 'status', '--all'] : ['auth', 'status'], { graceMs: 30000 })
  const hosts = parseAuthHosts(String(r.out || '') + '\n' + String(r.errText || ''))
  authCache.byForge[forge] = hosts
  return hosts
}

/** Map a git remote host to a forge: authorized in glab → gitlab; authorized
 *  in gh → github; well-known public hosts fall back by name. null = unknown. */
async function forgeOfHost(runner: Runner, host: string): Promise<ForgeKey | null> {
  const h = String(host || '').trim().toLowerCase()
  if (!h) return null
  const glabHosts = await forgeAuthHosts(runner, 'gitlab')
  if (glabHosts.some((x) => String(x.host).toLowerCase() === h)) return 'gitlab'
  const ghHosts = await forgeAuthHosts(runner, 'github')
  if (ghHosts.some((x) => String(x.host).toLowerCase() === h)) return 'github'
  if (h === 'gitlab.com') return 'gitlab'
  if (h === 'github.com') return 'github'
  return null
}

// ── repo / target resolution ────────────────────────────────────────────────

/** Parse a git remote URL into { host, path }. */
function parseRemote(url: string): { host: string; path: string } | null {
  if (!url) return null
  let m = String(url).match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m) return { host: m[1], path: m[2].replace(/\/+$/, '') }
  m = String(url).match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (m) return { host: m[1], path: m[2].replace(/\/+$/, '') }
  m = String(url).match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (m) return { host: m[1], path: m[2].replace(/\/+$/, '') }
  return null
}

async function repoRoot(runner: Runner): Promise<string | null> {
  try {
    const out = await runner.git(['rev-parse', '--show-toplevel'])
    return out.trim() || null
  } catch (e) {
    return null
  }
}

interface ResolvedTarget {
  forge: ForgeKey
  /** -R <url> prefix for an explicit repo target (empty when cwd drives). */
  argv: string[]
  cwd: string | null
  /** OWNER/REPO path (GitLab project fullPath), feeds the 待评审 approval overlay. */
  repoPath: string | null
  /** remote host（gh api 无 -R，需 --hostname 定向 GHE）。 */
  host: string | null
}

/**
 * Resolve a request to { forge, argv, cwd, repoPath }: which CLI to run and
 * how to target the repo. A validated Workspace cwd wins (the CLI reads
 * remote+host from that working copy, argv = []); otherwise an explicit repo
 * (+host) builds the -R full-URL target. `repoPath` is the OWNER/REPO path
 * (GitLab project fullPath) used by the 待评审 approval overlay. The forge is
 * explicit `forge` when given, else auto-detected from the git remote host
 * via CLI auth status.
 */
async function resolveTarget(ctx: HostContext, runner: Runner, query: Record<string, string>): Promise<ResolvedTarget> {
  const explicit = forgeKey(query && query.forge)
  const wsCwd = resolveWorkspaceCwd(ctx, query && query.cwd)
  let targetUrl: string | null = null
  let cwd: string | null = null
  if (wsCwd) {
    cwd = wsCwd
  } else {
    const repo = query && query.repo ? String(query.repo).trim() : ''
    const host = query && query.host ? String(query.host).trim() : ''
    if (repo) {
      const clean = repo.replace(/\/+$/, '').replace(/\.git$/, '')
      const remote = parseRemote(clean)
      if (remote) {
        targetUrl = 'https://' + remote.host + '/' + remote.path
      } else {
        if (!host) {
          throw new Error('指定了仓库但缺少 host：请提供完整 URL（https://host/OWNER/REPO）或同时填写 host（例如 github.com）')
        }
        targetUrl = 'https://' + host + '/' + clean
      }
    }
  }
  if (!cwd && !targetUrl) {
    // No explicit target: fall back to the session workspace git repo.
    const root = await repoRoot(runner)
    if (!root) {
      throw new Error('当前工作区不是 Git 仓库，请指定仓库（OWNER/REPO）或 host')
    }
    cwd = root
  }

  // Repo identity (host + OWNER/REPO path): from the explicit -R URL, else
  // from the working copy's origin remote (which is also the forge
  // auto-detect input). repoPath feeds the GitLab 待评审 approval overlay.
  let host: string | null = null
  let repoPath: string | null = null
  if (targetUrl) {
    const parsed = parseRemote(targetUrl)
    host = parsed ? parsed.host : null
    repoPath = parsed ? parsed.path : null
  } else if (cwd) {
    try {
      const remote = (await runner.git(['remote', 'get-url', 'origin'], { cwd })).trim()
      const parsed = parseRemote(remote)
      host = parsed ? parsed.host : null
      repoPath = parsed ? parsed.path : null
    } catch (e) {}
  }

  let forge = explicit
  if (!forge && host) forge = await forgeOfHost(runner, host)
  if (!forge) {
    throw new Error('无法确定目标平台（GitLab/GitHub）' +
      (cwd ? '：该工作区的远程 host 未在 glab/gh 的登录列表中' : '，请在面板中选择平台') +
      '，可显式指定 forge=gitlab|github')
  }
  return { forge, argv: targetUrl ? ['-R', targetUrl] : [], cwd, repoPath, host }
}

// ── workspace registry (per-workspace forge association) ────────────────────

interface WorkspaceEntry {
  id?: string
  path: string
  title: string
}

/** All registered DSH workspaces (fail-soft: [] when the service is absent). */
function workspaceList(ctx: HostContext): WorkspaceEntry[] {
  try {
    const reg = ctx.get('workspaceRegistry') as { list?(): unknown } | undefined
    if (reg && typeof reg.list === 'function') {
      const items = reg.list()
      if (Array.isArray(items)) return items as WorkspaceEntry[]
    }
  } catch (e) {}
  return []
}

/**
 * Resolve a client-requested working directory. Only paths that are exactly a
 * registered Workspace directory are honored — this is an execution boundary,
 * not an arbitrary-path escape hatch.
 */
function resolveWorkspaceCwd(ctx: HostContext, requested: unknown): string | null {
  const p = String(requested || '').trim()
  if (!p) return null
  for (const w of workspaceList(ctx)) {
    if (w && typeof w.path === 'string' && w.path === p) return w.path
  }
  return null
}

interface WorkspaceProbe {
  path: string
  title: string
  remote: string | null
  host: string | null
  repoPath: string | null
  authorized: boolean
  user: string | null
  branch: string
  forge: ForgeKey | null
}

interface WorkspacesResult {
  ok: boolean
  updatedAt: number
  forges: Record<string, { available: boolean; hosts: AuthHost[] }>
  workspaces: unknown[]
  detected: unknown[]
  error: string | null
}

/** Enumerate workspaces × git remote × forge CLI auth. The response carries
 *  every registered workspace with its verdict (`detected`, incl. the forge it
 *  matched) so the panel can show WHY a workspace is or is not associated,
 *  plus the matched subset (`workspaces`) for the chips, plus per-forge CLI
 *  availability (`forges`) for the platform picker. */
async function loadWorkspaces(ctx: HostContext, runner: Runner): Promise<WorkspacesResult> {
  const result: WorkspacesResult = {
    ok: true,
    updatedAt: Date.now(),
    forges: {},
    workspaces: [],
    detected: [],
    error: null,
  }
  const forges: Record<string, { available: boolean; hosts: AuthHost[] }> = {}
  let anyCli = false
  for (const key of FORGE_KEYS) {
    const available = await exeAvailable(runner, FORGES[key].exe)
    const hosts = await forgeAuthHosts(runner, key)
    forges[key] = { available, hosts }
    if (available) anyCli = true
  }
  result.forges = forges
  if (!anyCli) {
    result.error = '未检测到 glab 或 gh 命令行工具，请先安装并登录 GitLab CLI 或 GitHub CLI'
  }

  const probes = workspaceList(ctx).map(async (w): Promise<WorkspaceProbe | null> => {
    const path = w && typeof w.path === 'string' ? w.path : ''
    if (!path) return null
    const entry: WorkspaceProbe = {
      path,
      title: String((w && w.title) || ''),
      remote: null,
      host: null,
      repoPath: null,
      authorized: false,
      user: null,
      branch: '',
      forge: null,
    }
    try {
      entry.remote = (await runner.git(['remote', 'get-url', 'origin'], { cwd: path })).trim() || null
    } catch (e) {
      entry.remote = null // not a git repo / no origin
    }
    const parsed = entry.remote ? parseRemote(entry.remote) : null
    if (parsed) {
      entry.host = parsed.host
      entry.repoPath = parsed.path
      const forge = await forgeOfHost(runner, parsed.host)
      if (forge) {
        entry.forge = forge
        entry.authorized = true
        const hosts = await forgeAuthHosts(runner, forge)
        const hit = hosts.find((x) => String(x.host).toLowerCase() === String(parsed.host).toLowerCase())
        entry.user = hit ? hit.user : ''
      }
    }
    if (entry.authorized) {
      try {
        entry.branch = (await runner.git(['branch', '--show-current'], { cwd: path })).trim()
      } catch (e) {}
    }
    return entry
  })
  const found = (await Promise.all(probes)).filter((e): e is WorkspaceProbe => e !== null)
  result.detected = found
  result.workspaces = found
    .filter((e) => e.authorized)
    .map((e) => ({
      id: e.path,
      title: e.title,
      path: e.path,
      host: e.host,
      repoPath: e.repoPath,
      branch: e.branch,
      user: e.user,
      forge: e.forge,
    }))
  return result
}

// ── unified item view (GitLab MR / GitHub PR → one shape) ───────────────────

const GH_STATE: Record<string, string> = { OPEN: 'opened', MERGED: 'merged', CLOSED: 'closed' }

export function toItemView(m: unknown, forge: ForgeKey): Record<string, unknown> | null {
  if (!m || typeof m !== 'object') return null
  const o = m as Record<string, unknown>
  if (forge === 'github') {
    return {
      forge: 'github',
      num: o.number,
      title: o.title || '',
      description: o.body || '',
      state: GH_STATE[String(o.state)] || String(o.state || '').toLowerCase(),
      draft: o.isDraft === true,
      head_sha: o.headRefOid || '',
      base_sha: o.baseRefOid || '',
      source_branch: o.headRefName || '',
      target_branch: o.baseRefName || '',
      web_url: o.url || '',
      author: (o.author && ((o.author as { login?: unknown }).login || (o.author as { name?: unknown }).name)) || '',
      labels: Array.isArray(o.labels) ? (o.labels as Array<Record<string, unknown>>).map((l) => l && l.name).filter(Boolean) : [],
      has_conflicts: o.mergeable === 'CONFLICTING',
      mergeable: o.mergeable === 'MERGEABLE' ? 'mergeable' : (o.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown'),
      reviewDecision: o.reviewDecision ? String(o.reviewDecision) : null,
      reviewRequests: Array.isArray(o.reviewRequests) ? (o.reviewRequests as Array<Record<string, unknown>>).map((r) => r && r.login).filter(Boolean) : [],
      created_at: o.createdAt || null,
      updated_at: o.updatedAt || null,
      comment_count: Array.isArray(o.comments) ? (o.comments as unknown[]).length : 0,
    }
  }
  // gitlab
  return {
    forge: 'gitlab',
    num: o.iid,
    title: o.title || '',
    description: o.description || '',
    state: o.state || '',
    draft: o.draft === true,
    head_sha: (o.diff_refs as { head_sha?: string } | undefined)?.head_sha || o.sha || '',
    base_sha: (o.diff_refs as { base_sha?: string } | undefined)?.base_sha || '',
    source_branch: o.source_branch || '',
    target_branch: o.target_branch || '',
    web_url: o.web_url || '',
    author: (o.author && ((o.author as { username?: unknown }).username || (o.author as { name?: unknown }).name)) || '',
    labels: Array.isArray(o.labels) ? o.labels : [],
    has_conflicts: o.has_conflicts === true,
    mergeable: (o.detailed_merge_status === 'mergeable' || o.merge_status === 'can_be_merged') ? 'mergeable' : 'unknown',
    reviewDecision: null,
    // 指派的 reviewer 用户名 —— 与 GitHub 的 reviewRequests 复用同一字段，
    // state 单条列表拉全后本地分桶「待评审」用（GitLab 批准后指派仍保留）。
    // 客户端的「待评审」chip 只在 forge==='github' 时渲染，gitlab 填充无 UI 影响。
    reviewRequests: Array.isArray(o.reviewers) ? (o.reviewers as Array<Record<string, unknown>>).map((r) => r && r.username).filter(Boolean) : [],
    created_at: o.created_at || null,
    updated_at: o.updated_at || null,
    comment_count: o.user_notes_count || 0,
  }
}

// ── notes (detail「评论」tab) ────────────────────────────────────────────────

/** One normalized issue-note shown on the detail 评论 tab. */
export interface NoteView {
  author: string
  body: string
  created_at: string
}

const NOTES_LIMIT = 100

/**
 * Normalize issue-level notes from both forges:
 *   - GitHub: `gh pr view --json comments` rows ({author:{login},body,createdAt})
 *     — review threads are NOT part of this array;
 *   - GitLab: `glab api .../merge_requests/:iid/notes` rows
 *     ({author:{username},body,created_at,system}) — system=true rows are
 *     status events (approved/closed/assigned…), never user discussion.
 * Empty bodies are dropped, the remainder sorts oldest→newest and caps at
 * 100. Never throws on malformed input.
 */
export function normalizeNotes(raw: unknown, forge: ForgeKey): NoteView[] {
  if (!Array.isArray(raw)) return []
  const notes: NoteView[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (forge === 'gitlab' && o.system === true) continue
    const a = o.author
    const author = a && typeof a === 'object'
      ? String((a as Record<string, unknown>).login ?? (a as Record<string, unknown>).username ?? (a as Record<string, unknown>).name ?? '')
      : ''
    const body = String(o.body ?? '').trim()
    if (!body) continue
    const at = String(o.createdAt ?? o.created_at ?? '')
    if (!at) continue
    notes.push({ author: author, body: body, created_at: at })
  }
  notes.sort((x, y) => x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0)
  return notes.slice(0, NOTES_LIMIT)
}

/** 一次拉全后的本地分桶（/forge/state 的三页签汇总）：「我的」= author 是我；
 *  「待评审」= reviewer 里有我。与旧的 `--author @me` / `--reviewer @me` 双查询
 *  口径一致 —— 一条 MR 两个条件都命中就进两个桶；用户名大小写不敏感，viewer
 *  未知时两桶为空（fail-soft，全部页签不受影响）。 */
export function bucketItemLists(items: unknown, viewer: unknown): { mine: unknown[]; review: unknown[] } {
  const list = Array.isArray(items) ? items : []
  const me = String(viewer || '').trim().toLowerCase()
  if (!me) return { mine: [], review: [] }
  const mine: unknown[] = []
  const review: unknown[] = []
  for (const it of list) {
    if (!it) continue
    const o = it as Record<string, unknown>
    if (String(o.author || '').trim().toLowerCase() === me) mine.push(it)
    if (Array.isArray(o.reviewRequests) &&
      (o.reviewRequests as unknown[]).some((r) => String(r || '').trim().toLowerCase() === me)) review.push(it)
  }
  return { mine, review }
}

// ── 待评审口径（GitLab）：剔除「我已批准」的 MR ─────────────────────────────
//
// GitLab 在批准后不会自动移除 reviewer 指派，`glab mr list --reviewer @me`
// 会一直带回已批准的 MR；而 13.10 这类版本的 REST 列表没有
// `not[approved_by_ids]` 过滤参数（传了也会被静默忽略）。因此宿主在 review
// 列表上补一次 GraphQL 调用（currentUser + 各 MR 的 approvedBy），把 viewer
// 已批准的 MR 从待评审里剔除。GitHub 不需要这层：提交 review 后 GitHub 会
// 自动撤掉 review request。

/** Build the argv for the approval overlay: one GraphQL call returning the
 *  viewer username plus approvedBy usernames for the listed MR iids. Returns
 *  null when no item carries a numeric iid (caller skips the overlay call). */
export function gitlabReviewApprovalsArgv(repoPath: string | null, items: unknown): string[] | null {
  const iids = (Array.isArray(items) ? items : [])
    .map((it) => String(it && typeof it === 'object' && (it as Record<string, unknown>).num != null ? (it as Record<string, unknown>).num : ''))
    .filter((s) => /^\d+$/.test(s))
    .slice(0, 100)
  if (!iids.length) return null
  const gql = 'query{currentUser{username}project(fullPath:' + JSON.stringify(String(repoPath || '')) +
    '){mergeRequests(iids:[' + iids.map((i) => '"' + i + '"').join(',') + '],first:' + iids.length +
    '){nodes{iid approvedBy{nodes{username}}}}}}'
  return ['api', 'graphql', '-f', 'query=' + gql]
}

/** Parse the GraphQL overlay payload into { viewer, approved: Map<iid → Set<username>> }.
 *  Never throws: malformed payloads degrade to an empty overlay (null for
 *  non-object input) and an unknown viewer makes the filter a no-op. */
export function parseApprovalOverlay(data: unknown): { viewer: string; approved: Map<string, Set<string>> } | null {
  if (!data || typeof data !== 'object') return null
  const payload = (data as { data?: unknown }).data && typeof (data as { data?: unknown }).data === 'object' ? (data as { data: Record<string, unknown> }).data : data as Record<string, unknown>
  const viewer = payload.currentUser && typeof (payload.currentUser as { username?: unknown }).username === 'string'
    ? (payload.currentUser as { username: string }).username : ''
  const approved = new Map<string, Set<string>>()
  const nodes = payload.project && (payload.project as { mergeRequests?: unknown }).mergeRequests &&
    Array.isArray((payload.project as { mergeRequests: { nodes?: unknown } }).mergeRequests.nodes)
    ? (payload.project as { mergeRequests: { nodes: Array<Record<string, unknown>> } }).mergeRequests.nodes : []
  for (const n of nodes) {
    if (!n || n.iid == null) continue
    const set = new Set<string>()
    approved.set(String(n.iid), set)
    const by = n.approvedBy && Array.isArray((n.approvedBy as { nodes?: unknown }).nodes) ? (n.approvedBy as { nodes: Array<Record<string, unknown>> }).nodes : []
    for (const u of by) {
      if (u && typeof u.username === 'string' && u.username) set.add(u.username)
    }
  }
  return { viewer, approved }
}

/** 待评审 = 指派给我为 reviewer 且我尚未批准（overlay 为 null / viewer 未知 /
 *  iid 不在覆盖层里时原样保留，fail-soft）。 */
export function dropApprovedByViewer(items: unknown, overlay: { viewer: string; approved: Map<string, Set<string>> } | null): unknown[] {
  if (!overlay || !overlay.viewer) return Array.isArray(items) ? items : []
  return (Array.isArray(items) ? items : []).filter((it) => {
    const o = it as Record<string, unknown>
    const set = overlay.approved.get(String(o && o.num))
    return !(set && set.has(overlay.viewer))
  })
}

// ── per-forge command builders ──────────────────────────────────────────────

interface ForgeCmds {
  list(scope: string): string[]
  listByBranch(branch: string): string[]
  view(num: string): string[]
  /** Extra argv to fetch issue-level notes when view() does not carry them. */
  notes?(num: string, repoPath: string): string[]
  diff(num: string): string[]
  approve(num: string): string[]
  merge(num: string, squash: boolean, removeSource: boolean): string[]
  note(num: string, body: string): string[]
  close(num: string): string[]
  viewer(): string[]
  reviewApprovals?(repoPath: string | null, items: unknown): string[] | null
}

const CMDS: Record<ForgeKey, ForgeCmds> = {
  gitlab: {
    list(scope) {
      const argv = ['mr', 'list', '--output', 'json']
      if (scope === 'mine') argv.push('--author', '@me')
      if (scope === 'review') argv.push('--reviewer', '@me')
      argv.push('--per-page', String(getConfig().allListLimit))
      return argv
    },
    listByBranch(branch) {
      return ['mr', 'list', '--output', 'json', '--source-branch', branch, '--per-page', '10']
    },
    view(num) { return ['mr', 'view', String(num), '--output', 'json'] },
    /** GitLab view JSON has no note bodies; fetch them via the notes API
     *  (system events are filtered out during normalization). */
    notes(num, repoPath) {
      return ['api', 'projects/' + encodeURIComponent(repoPath) + '/merge_requests/' + String(num) +
        '/notes?per_page=' + NOTES_LIMIT + '&sort=asc']
    },
    diff(num) { return ['mr', 'diff', String(num)] },
    approve(num) { return ['mr', 'approve', String(num)] },
    merge(num, squash, removeSource) {
      const argv = ['mr', 'merge', String(num), '--yes']
      if (squash) argv.push('--squash')
      if (removeSource) argv.push('--remove-source-branch')
      return argv
    },
    note(num, body) { return ['mr', 'note', 'create', String(num), '-m', body] },
    close(num) { return ['mr', 'close', String(num)] },
    viewer() { return ['api', 'user', '--output', 'json'] },
    /** 待评审过滤的批准覆盖层：一次 GraphQL 拿 viewer 用户名与各 MR 的 approvedBy。 */
    reviewApprovals(repoPath, items) { return gitlabReviewApprovalsArgv(repoPath, items) },
  },
  github: {
    list(scope) {
      const argv = ['pr', 'list', '--json', GH_LIST_FIELDS, '--state', 'open', '--limit', String(getConfig().allListLimit)]
      if (scope === 'mine') argv.push('--author', '@me')
      if (scope === 'review') argv.push('--search', 'review-requested:@me')
      return argv
    },
    listByBranch(branch) {
      return ['pr', 'list', '--json', GH_LIST_FIELDS, '--state', 'open', '--head', branch, '--limit', '10']
    },
    view(num) { return ['pr', 'view', String(num), '--json', GH_VIEW_FIELDS] },
    diff(num) { return ['pr', 'diff', String(num)] },
    approve(num) { return ['pr', 'review', String(num), '--approve'] },
    merge(num, squash, removeSource) {
      const argv = ['pr', 'merge', String(num), squash ? '--squash' : '--merge']
      if (removeSource) argv.push('--delete-branch')
      return argv
    },
    note(num, body) { return ['pr', 'comment', String(num), '--body', body] },
    close(num) { return ['pr', 'close', String(num)] },
    viewer() { return ['api', 'user', '--jq', '.login'] },
  },
}

// GitHub PR JSON fields. `comments` is omitted from list calls (heavy); the
// view call appends it.
const GH_LIST_FIELDS =
  'number,title,body,state,isDraft,headRefName,baseRefName,url,author,labels,mergeable,createdAt,updatedAt,reviewDecision,reviewRequests'
const GH_VIEW_FIELDS = GH_LIST_FIELDS + ',comments,headRefOid,baseRefOid'

// ── state assembly ──────────────────────────────────────────────────────────

/** Run the GitLab approval overlay (one GraphQL call: currentUser + approvedBy
 *  per iid) for the given items and return the parsed overlay, or null on any
 *  failure / nothing to query (fail-soft — the caller keeps the unfiltered list). */
async function loadApprovalOverlay(runner: Runner, repoPath: string | null, items: unknown[], argv: string[], cwd: string | null) {
  const overlayArgv = CMDS.gitlab.reviewApprovals ? CMDS.gitlab.reviewApprovals(repoPath, items) : null
  if (!overlayArgv) return null
  try {
    const overlayRaw = await runner.forgeRun('gitlab', (argv || []).concat(overlayArgv), { cwd: cwd || undefined })
    return parseApprovalOverlay(JSON.parse(overlayRaw))
  } catch (e) {
    return null
  }
}

async function loadItemList(ctx: HostContext, runner: Runner, query: Record<string, string>): Promise<unknown[]> {
  const { forge, argv, cwd, repoPath } = await resolveTarget(ctx, runner, query)
  const scope = String(query.scope || 'all')
  const out = await runner.forgeRun(forge, argv.concat(CMDS[forge].list(scope)), { cwd: cwd || undefined })
  let raw: unknown = []
  try {
    raw = JSON.parse(out)
  } catch (e) {
    raw = []
  }
  const items = (Array.isArray(raw) ? raw : []).map((m) => toItemView(m, forge)).filter((v): v is Record<string, unknown> => v !== null)
  // 待评审口径（GitLab）：指派给我且我尚未批准。覆盖层查询失败时 fail-soft
  // 保留原列表，不让页签直接空掉。
  if (forge === 'gitlab' && scope === 'review' && items.length && repoPath) {
    const overlay = await loadApprovalOverlay(runner, repoPath, items, argv, cwd)
    return dropApprovedByViewer(items, overlay)
  }
  return items
}

async function loadViewer(ctx: HostContext, runner: Runner, forge: ForgeKey, cwd: string | null): Promise<{ username: string; name: string }> {
  const out = await runner.forgeRun(forge, CMDS[forge].viewer(), { cwd: cwd || undefined })
  if (forge === 'github') {
    const login = String(out).trim()
    return { username: login, name: login }
  }
  const user = JSON.parse(out) as { username?: string; name?: string }
  return { username: user.username || '', name: user.name || '' }
}

/** Resolve the forge of a local git checkout root (explicit pref wins). */
async function forgeOfRoot(ctx: HostContext, runner: Runner, root: string, pref: unknown): Promise<ForgeKey | null> {
  const explicit = forgeKey(pref)
  if (explicit) return explicit
  try {
    const remote = (await runner.git(['remote', 'get-url', 'origin'], { cwd: root })).trim()
    const parsed = parseRemote(remote)
    if (parsed) return await forgeOfHost(runner, parsed.host)
  } catch (e) {}
  return null
}

interface StateListsOptions {
  forge: ForgeKey
  wsRoot?: string | null
  repoPath?: string | null
  root?: string | null
  viewer?: string | null
}

/**
 * 三页签列表汇总（/forge/state 的我的 / 待评审 / 全部）：
 *   1. 先发一条全量列表（`mr list` / `pr list`，ALL_LIST_LIMIT 上限），
 *      返回**不足**上限 → 列表确定完整，本地按 author / reviewer 分桶即精确值
 *      （GitLab 待评审桶再过 approvedBy 覆盖层剔除我已批准的 MR）；
 *   2. 返回**打满**上限 → 列表可能被截断、分桶不可信，退回
 *      `--author @me` / `--reviewer @me` 逐口径精确查询（并行，与旧三条并行
 *      行为一致；review 口径经 loadItemList 自带覆盖层）。
 * 两种情况下徽标都是精确值；「全部」始终是上限内的前 N 条。
 * Fail-soft：全量列表失败只置 allOpenError；回退查询各自失败保留空桶。
 */
export async function loadStateLists(ctx: HostContext, runner: Runner, opts: StateListsOptions): Promise<{
  myOpen: unknown[]
  reviewRequests: unknown[]
  allOpen: unknown[]
  allOpenError?: string
  myOpenError?: string
  reviewRequestsError?: string
}> {
  const forge = opts.forge
  const wsRoot = opts.wsRoot || undefined
  const out: {
    myOpen: unknown[]
    reviewRequests: unknown[]
    allOpen: unknown[]
    allOpenError?: string
    myOpenError?: string
    reviewRequestsError?: string
  } = { myOpen: [], reviewRequests: [], allOpen: [] }
  let items: unknown[] = []
  try {
    items = await loadItemList(ctx, runner, { scope: 'all', cwd: wsRoot || '', forge: forge })
  } catch (e) {
    out.allOpenError = classifyError(e)
    return out
  }
  out.allOpen = items
  if (Array.isArray(items) && items.length >= getConfig().allListLimit) {
    const [mineRes, reviewRes] = await Promise.allSettled([
      loadItemList(ctx, runner, { scope: 'mine', cwd: wsRoot || '', forge: forge }),
      loadItemList(ctx, runner, { scope: 'review', cwd: wsRoot || '', forge: forge }),
    ])
    if (mineRes.status === 'fulfilled') out.myOpen = mineRes.value
    else out.myOpenError = classifyError(mineRes.reason)
    if (reviewRes.status === 'fulfilled') out.reviewRequests = reviewRes.value
    else out.reviewRequestsError = classifyError(reviewRes.reason)
    return out
  }
  const buckets = bucketItemLists(items, opts.viewer)
  out.myOpen = buckets.mine
  out.reviewRequests = buckets.review
  if (forge === 'gitlab' && buckets.review.length && opts.repoPath) {
    const overlay = await loadApprovalOverlay(runner, opts.repoPath, buckets.review, [], opts.root || null)
    out.reviewRequests = dropApprovedByViewer(buckets.review, overlay)
  }
  return out
}

interface StatePayload {
  ok: boolean
  updatedAt: number
  workspace: string
  repo: Record<string, unknown> | null
  viewer: { username: string; name: string } | null
  branchMR: unknown[]
  myOpen: unknown[]
  reviewRequests: unknown[]
  allOpen: unknown[]
  [key: string]: unknown
}

/** @param cwdParam - optional Workspace directory requested by the client
 * (validated against the registry). The host composition has no "current
 * session" notion, so the panel drives the default target itself. */
async function loadState(ctx: HostContext, runner: Runner, cwdParam: unknown, forgePref: unknown): Promise<StatePayload> {
  const state: StatePayload = {
    ok: true,
    updatedAt: Date.now(),
    workspace: runner.getWorkspaceRoot(),
    repo: null,
    viewer: null,
    branchMR: [],
    myOpen: [],
    reviewRequests: [],
    allOpen: [],
  }
  const wsRoot = resolveWorkspaceCwd(ctx, cwdParam)
  const root = wsRoot || await repoRoot(runner)
  if (!root) return state
  const repo: Record<string, unknown> = { root, host: null, path: null, branch: '', dirtyCount: 0, lastCommitTitle: '', forge: null }
  try {
    const remote = (await runner.git(['remote', 'get-url', 'origin'], { cwd: root })).trim()
    const parsed = parseRemote(remote)
    if (parsed) {
      repo.host = parsed.host
      repo.path = parsed.path
    } else {
      repo.remoteRaw = remote.slice(0, 200)
    }
  } catch (e) {}
  try {
    repo.branch = (await runner.git(['branch', '--show-current'], { cwd: root })).trim()
  } catch (e) {}
  try {
    const status = await runner.git(['status', '--porcelain'], { cwd: root })
    repo.dirtyCount = status.trim() ? status.split('\n').filter(Boolean).length : 0
  } catch (e) {}
  try {
    repo.lastCommitTitle = (await runner.git(['log', '-1', '--format=%s'], { cwd: root })).trim()
  } catch (e) {}
  state.repo = repo

  const forge = await forgeOfRoot(ctx, runner, root, forgePref)
  repo.forge = forge
  if (!forge) {
    state.forgeError = '无法确定该仓库的平台（GitLab/GitHub）：' +
      (repo.host ? '远程 ' + repo.host + ' 未在 glab/gh 的登录列表中' : '未检测到远程仓库') +
      '，请在面板顶部选择平台'
    return state
  }

  // Viewer identity + item summaries (best effort, never fatal to the widget),
  // targeted at the same workspace as the repo facts above.
  try {
    state.viewer = await loadViewer(ctx, runner, forge, root)
  } catch (e) {
    state.viewerError = classifyError(e)
  }
  // 三个页签一次拉全（不足 50 条本地分桶，打满 50 条退回逐口径精确查询）；
  // viewer 加载失败时只影响分桶，「全部」照常。
  Object.assign(state, await loadStateLists(ctx, runner, {
    forge: forge,
    wsRoot: wsRoot,
    repoPath: (repo.path as string) || null,
    root: root,
    viewer: state.viewer && state.viewer.username,
  }))
  if (repo.branch) {
    try {
      const { argv, cwd } = await resolveTarget(ctx, runner, { cwd: wsRoot || '', forge: forge })
      const out = await runner.forgeRun(forge, argv.concat(CMDS[forge].listByBranch(String(repo.branch))), { cwd: cwd || undefined })
      const raw = JSON.parse(out) as unknown
      state.branchMR = (Array.isArray(raw) ? raw : []).map((m) => toItemView(m, forge)).filter((v): v is Record<string, unknown> => v !== null)
    } catch (e) {
      state.branchMRError = classifyError(e)
    }
  }
  return state
}

// ── Issues（GitLab Issue / GitHub Issue 查询与写操作）────────────────────────

/** 列表预取关联 MR 的条数上限（mr_count>0 的前 N 条并行拉，超出只显示数量）。 */
const RELATED_LIST_CAP = 8

/** GitLab 列表：为 mr_count>0 的前 N 条并行补 related_merge_requests（fail-soft）。 */
async function attachGitlabRelatedMrs(
  runner: Runner, repoPath: string, argv: string[], cwd: string | null, issues: IssueView[],
): Promise<void> {
  const need = issues
    .filter((it) => (it.mr_count || 0) > 0 && !(it.related && it.related.length))
    .slice(0, RELATED_LIST_CAP)
  if (!need.length) return
  await Promise.allSettled(need.map(async (it) => {
    const out = await runner.forgeRun('gitlab', argv.concat(gitlabRelatedMrsArgv(repoPath, String(it.num))), { cwd: cwd || undefined })
    it.related = normalizeRelatedMrs(JSON.parse(out) as unknown)
  }))
}

export async function loadIssueList(ctx: HostContext, runner: Runner, query: Record<string, unknown>): Promise<Record<string, unknown>> {
  const f: IssueFilters = normalizeIssueFilters(query)
  const { forge, argv, cwd, repoPath } = await resolveTarget(ctx, runner, query as Record<string, string>)
  const base = { ok: true, updatedAt: Date.now(), forge: forge, page: f.page, pageSize: f.pageSize }
  if (forge === 'gitlab') {
    if (!repoPath) throw new Error('无法确定仓库路径，无法查询 Issue')
    const out = await runner.forgeRun(forge, argv.concat(gitlabIssuesArgv(repoPath, f)), { cwd: cwd || undefined })
    const page = parseGitlabIssueList(out)
    await attachGitlabRelatedMrs(runner, repoPath, argv, cwd, page.issues)
    return Object.assign(base, { issues: page.issues, total: page.total, hasMore: page.hasMore })
  }
  const gh = githubIssuesArgv(f)
  const out = await runner.forgeRun(forge, argv.concat(gh.argv), { cwd: cwd || undefined })
  const page = parseGithubIssueList(out, f)
  return Object.assign(base, { issues: page.issues, total: null, hasMore: page.hasMore })
}

export async function loadIssueDetail(ctx: HostContext, runner: Runner, query: Record<string, string>): Promise<Record<string, unknown>> {
  const num = numOf(query.num, 'Issue')
  const { forge, argv, cwd, repoPath } = await resolveTarget(ctx, runner, query)
  const out = await runner.forgeRun(forge, argv.concat(issueViewArgv(forge, num)), { cwd: cwd || undefined })
  const issue = toIssueView(JSON.parse(out) as unknown, forge)
  if (!issue) throw new Error('Issue 数据解析失败')
  // 评论与关联 MR：GitHub 的 view 已带 comments / closedByPullRequestsReferences；
  // GitLab 需要补两条 API（并行，失败不拖垮详情主体）。
  let notes: NoteView[] = []
  let related: RelatedMrView[] = issue.related || []
  if (forge === 'github') {
    const raw = JSON.parse(out) as Record<string, unknown>
    notes = normalizeNotes(raw.comments, forge)
  } else if (repoPath) {
    const [notesRes, relRes] = await Promise.allSettled([
      runner.forgeRun(forge, argv.concat(gitlabIssueNotesArgv(repoPath, num)), { cwd: cwd || undefined }),
      runner.forgeRun(forge, argv.concat(gitlabRelatedMrsArgv(repoPath, num)), { cwd: cwd || undefined }),
    ])
    if (notesRes.status === 'fulfilled') {
      try { notes = normalizeNotes(JSON.parse(notesRes.value) as unknown, forge) } catch (e) {}
    }
    if (relRes.status === 'fulfilled') {
      try { related = normalizeRelatedMrs(JSON.parse(relRes.value) as unknown) } catch (e) {}
    }
  }
  issue.notes = notes
  issue.related = related
  return { ok: true, issue: issue }
}

export interface IssueMetaPayload {
  ok: boolean
  updatedAt: number
  forge: ForgeKey
  stats: IssueStats
  labels: Array<{ name: string; color: string }>
  members: Array<{ username: string; name: string }>
  viewer: { username: string; name: string } | null
}

/** GitLab 的 `-i` 统计输出 → X-Total 数字（失败 null）。 */
function totalFromGlab(out: unknown): number | null {
  try {
    const { headers } = parseGlabApiWithHeaders(String(out))
    const n = Number(headers['x-total'])
    return isFinite(n) ? n : null
  } catch (e) {
    return null
  }
}

function totalFromGh(out: unknown): number | null {
  const n = Number(String(out == null ? '' : out).trim())
  return isFinite(n) && n >= 0 ? n : null
}

function parseLabels(raw: unknown): Array<{ name: string; color: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; color: string }> = []
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue
    const o = l as Record<string, unknown>
    const name = String(o.name || '').trim()
    if (!name) continue
    out.push({ name: name, color: String(o.color || '') })
  }
  return out
}

function parseMembers(raw: unknown, forge: ForgeKey): Array<{ username: string; name: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ username: string; name: string }> = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const username = String(o.username || o.login || '').trim()
    if (!username) continue
    out.push({ username: username, name: String(o.name || '') || username })
    if (out.length >= 100) break
  }
  return out
}

export async function loadIssueMeta(ctx: HostContext, runner: Runner, query: Record<string, string>): Promise<IssueMetaPayload> {
  const { forge, argv, cwd, repoPath, host } = await resolveTarget(ctx, runner, query)
  const meta: IssueMetaPayload = {
    ok: true,
    updatedAt: Date.now(),
    forge: forge,
    stats: { open: null, closed: null, assignedOpen: null },
    labels: [],
    members: [],
    viewer: null,
  }
  let viewer: { username: string; name: string } | null = null
  try {
    viewer = await loadViewer(ctx, runner, forge, cwd)
    meta.viewer = viewer
  } catch (e) {}
  if (forge === 'gitlab') {
    if (!repoPath) throw new Error('无法确定仓库路径，无法查询 Issue 元信息')
    const stats = gitlabIssueStatsArgvs(repoPath)
    const [openRes, closedRes, assignedRes, labelsRes, membersRes] = await Promise.allSettled([
      runner.forgeRun(forge, argv.concat(stats.open), { cwd: cwd || undefined }),
      runner.forgeRun(forge, argv.concat(stats.closed), { cwd: cwd || undefined }),
      runner.forgeRun(forge, argv.concat(stats.assignedOpen), { cwd: cwd || undefined }),
      runner.forgeRun(forge, argv.concat(gitlabLabelsArgv(repoPath)), { cwd: cwd || undefined }),
      runner.forgeRun(forge, argv.concat(gitlabMembersArgv(repoPath)), { cwd: cwd || undefined }),
    ])
    if (openRes.status === 'fulfilled') meta.stats.open = totalFromGlab(openRes.value)
    if (closedRes.status === 'fulfilled') meta.stats.closed = totalFromGlab(closedRes.value)
    if (assignedRes.status === 'fulfilled') meta.stats.assignedOpen = totalFromGlab(assignedRes.value)
    if (labelsRes.status === 'fulfilled') {
      try { meta.labels = parseLabels(JSON.parse(labelsRes.value) as unknown) } catch (e) {}
    }
    if (membersRes.status === 'fulfilled') {
      try { meta.members = parseMembers(JSON.parse(membersRes.value) as unknown, forge) } catch (e) {}
    }
    return meta
  }
  if (!repoPath) throw new Error('无法确定仓库路径，无法查询 Issue 元信息')
  // `gh api` 不继承根级 -R（unknown shorthand flag），改用 --hostname 定向
  // （github.com 缺省也对；GHE 必须显式指定）。search 的 q 与 repos/ 路径
  // 自带 OWNER/REPO，无需 -R。
  const apiPrefix = host ? ['api', '--hostname', host] : ['api']
  const stats = githubIssueStatsArgvs(repoPath, viewer && viewer.username)
  const [openRes, closedRes, assignedRes, labelsRes, membersRes] = await Promise.allSettled([
    runner.forgeRun(forge, apiPrefix.concat(stats.open.slice(1)), { cwd: cwd || undefined }),
    runner.forgeRun(forge, apiPrefix.concat(stats.closed.slice(1)), { cwd: cwd || undefined }),
    stats.assignedOpen ? runner.forgeRun(forge, apiPrefix.concat(stats.assignedOpen.slice(1)), { cwd: cwd || undefined }) : Promise.resolve(''),
    runner.forgeRun(forge, argv.concat(githubLabelsArgv()), { cwd: cwd || undefined }),
    runner.forgeRun(forge, apiPrefix.concat(githubMembersArgv(repoPath)), { cwd: cwd || undefined }),
  ])
  if (openRes.status === 'fulfilled') meta.stats.open = totalFromGh(openRes.value)
  if (closedRes.status === 'fulfilled') meta.stats.closed = totalFromGh(closedRes.value)
  if (assignedRes.status === 'fulfilled' && stats.assignedOpen) meta.stats.assignedOpen = totalFromGh(assignedRes.value)
  if (labelsRes.status === 'fulfilled') {
    try { meta.labels = parseLabels(JSON.parse(labelsRes.value) as unknown) } catch (e) {}
  }
  if (membersRes.status === 'fulfilled') {
    try { meta.members = parseMembers(JSON.parse(membersRes.value) as unknown, forge) } catch (e) {}
  }
  return meta
}

function issueLabelsOf(body: Record<string, unknown>, key: string): string[] {
  const raw = body[key]
  if (!Array.isArray(raw)) return []
  return raw.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, 50)
}

async function handleIssueUpdate(ctx: HostContext, runner: Runner, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const num = numOf(body.num, 'Issue')
  const fields = {
    title: body.title === undefined ? undefined : String(body.title || '').trim() || undefined,
    description: body.description === undefined ? undefined : String(body.description || ''),
    addLabels: issueLabelsOf(body, 'addLabels'),
    removeLabels: issueLabelsOf(body, 'removeLabels'),
    addAssignees: issueLabelsOf(body, 'addAssignees'),
    removeAssignees: issueLabelsOf(body, 'removeAssignees'),
  }
  const { forge, argv, cwd } = await resolveTarget(ctx, runner, body as Record<string, string>)
  const argvBuilt = forge === 'github' ? githubIssueUpdateArgv(num, fields) : gitlabIssueUpdateArgv(num, fields)
  if (argvBuilt.length <= 2) throw new Error('没有需要更新的字段')
  const out = await runner.forgeRun(forge, argv.concat(argvBuilt), { cwd: cwd || undefined, graceMs: 60000 })
  return { ok: true, forge: forge, stdout: String(out).slice(0, 1000) }
}

// ── routes ──────────────────────────────────────────────────────────────────

function registerRoute(
  ctx: HostContext,
  path: string,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  errorClass?: (err: unknown) => string,
): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const connection = connectionOf(ctx) as { requestRejection(req: IncomingMessage): number | undefined } | undefined
      const rejection = connection === undefined ? undefined : connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      try {
        await handler(req, res)
      } catch (err) {
        sendJson(res, 200, { ok: false, error: (errorClass || classifyError)(err) })
      }
    },
  }), 'dsh-workbench: ' + path)
}

function numOf(value: unknown, label = 'MR/PR'): string {
  const num = String(value || '').trim()
  if (!/^\d+$/.test(num)) throw new Error('缺少有效的' + label + '编号参数')
  return num
}

/** 自动评审的详情读取：GitHub 固定以 merge-base 作为评审基准（PR review 的
 *  比较基准是合并基点而不是目标分支 tip）。 */
async function reviewDetail(ctx: HostContext, runner: Runner, repo: ReviewRepo, num: string): Promise<import('../client/types').ForgeItem> {
  const { forge, argv, cwd } = await resolveTarget(ctx, runner, { cwd: repo.cwd, forge: repo.forge })
  const raw = JSON.parse(await runner.forgeRun(forge, argv.concat(CMDS[forge].view(numOf(num))), { cwd: cwd || undefined }))
  const item = toItemView(raw, forge)
  if (!item) throw new Error('无法读取评审对象')
  if (forge === 'github') {
    const head = String(item.head_sha), base = String(item.base_sha)
    if (!/^[a-f0-9]{40,64}$/i.test(head) || !/^[a-f0-9]{40,64}$/i.test(base)) throw new Error('无法读取 PR 提交版本')
    // PR reviews compare against the merge base, not the target branch tip.
    item.base_sha = (await runner.forgeRun('github', ['api', '--hostname', repo.host,
      'repos/' + repo.repoPath.split('/').map(encodeURIComponent).join('/') + '/compare/' + base + '...' + head,
      '--jq', '.merge_base_commit.sha'], { cwd: cwd || undefined })).trim()
  }
  return item as unknown as import('../client/types').ForgeItem
}

/** 自动评审的候选列表：按范围取口径并补详情。
 *  - review：指派给我为 reviewer（GitLab 经批准覆盖层剔除我已批准的）；
 *  - mine：review 与「我提交的」两条口径的并集（按编号去重）；
 *  - all：全部。
 *  任一口径列表打满部署上限都视为可能被截断，停止扫描（不把截断当完整基线）。 */
export async function reviewListItems(ctx: HostContext, runner: Runner, repo: ReviewRepo, scope: ReviewScope): Promise<import('../client/types').ForgeItem[]> {
  const limit = getConfig().allListLimit
  const load = (s: string) => loadItemList(ctx, runner, { cwd: repo.cwd, forge: repo.forge, scope: s }) as Promise<import('../client/types').ForgeItem[]>
  let items: import('../client/types').ForgeItem[]
  if (scope === 'all') {
    items = await load('all')
  } else if (scope === 'mine') {
    const [reviewed, authored] = await Promise.all([load('review'), load('mine')])
    if (reviewed.length >= limit || authored.length >= limit) throw new Error('待评审列表可能被截断，请提高部署的列表上限后重试')
    const seenNums = new Set<string>()
    items = []
    for (const it of [...reviewed, ...authored]) {
      const k = String(it.num)
      if (seenNums.has(k)) continue
      seenNums.add(k)
      items.push(it)
    }
  } else {
    items = await load('review')
  }
  if (scope !== 'mine' && items.length >= limit) throw new Error('待评审列表可能被截断，请提高部署的列表上限后重试')
  const ready = items.filter((item) => item.state === 'opened' && !item.draft)
  const details: import('../client/types').ForgeItem[] = []
  for (const item of ready) details.push(await reviewDetail(ctx, runner, repo, String(item.num)))
  return details
}

export function apply(ctx: HostContext, config?: Config): void {
  registerGitRoutes(ctx)
  setConfig(config)
  const runner = createRunner(ctx)
  const updater = createSelfUpdater(runner)
  ctx.effect(() => updater.start(getConfig().selfUpdateIntervalMs))
  registerRoute(ctx, '/workbench/update/status', async (_req, res) => { sendJson(res, 200, { ok: true, ...updater.state }) })
  registerRoute(ctx, '/workbench/update/check', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    await updater.check()
    sendJson(res, 200, { ok: true, ...updater.state })
  })
  const reviews = createAutoReview({
    intervalMs: Math.min(86400000, Math.max(10000, Math.floor(getConfig().autoReviewIntervalMs || 60000))),
    cooldownMs: Math.min(86400000, Math.max(0, Math.floor(getConfig().autoReviewCooldownMs || 0))),
    retentionDays: Math.max(1, getConfig().autoReviewRetentionDays || 90),
    historyLimit: Math.max(1, Math.floor(getConfig().autoReviewHistoryLimit || 20)),
    file: getConfig().autoReviewStateFile || join(homedir(), '.dsh', 'workbench', 'reviews.json'),
    controller() {
      const service = ctx.get('sessionController') as ReviewController | null
      return service && ['create', 'rename', 'prompt', 'inspect'].every((key) => typeof Reflect.get(service, key) === 'function') ? service : null
    },
    async resolveRepo(requested) {
      const cwd = resolveWorkspaceCwd(ctx, requested)
      const ws = workspaceList(ctx).find((w) => w.path === cwd)
      if (!cwd || !ws?.id) throw new Error('自动评审需要已注册的 DSH 工作区')
      const target = await resolveTarget(ctx, runner, { cwd })
      if (!target.host || !target.repoPath) throw new Error('无法确定评审仓库')
      return { cwd, workspaceId: ws.id, forge: target.forge, host: target.host, repoPath: target.repoPath }
    },
    list(repo, scope) { return reviewListItems(ctx, runner, repo, scope) },
    detail(repo, num) { return reviewDetail(ctx, runner, repo, num) },
  })
  let reviewError: string | null = null
  let reviewPolling = false
  async function pollReviews() {
    if (reviewPolling) return
    reviewPolling = true
    try { await reviews.tick(); reviewError = null } catch (e) { reviewError = classifyError(e) }
    finally { reviewPolling = false }
  }
  let reviewTimer: ReturnType<typeof setInterval> | undefined
  let reviewDisposed = false
  function scheduleReviews(interval: number) {
    if (reviewDisposed) return
    if (reviewTimer) clearInterval(reviewTimer)
    reviewTimer = setInterval(() => { void pollReviews() }, interval)
    reviewTimer.unref()
  }
  ctx.effect(() => {
    // No client dependency: closing the panel/browser does not stop opted-in reviews.
    void reviews.snapshot('').then((s) => {
      scheduleReviews(s.defaults.intervalMs || 60000)
      if (!reviewDisposed) void pollReviews()
    }).catch((e) => { reviewError = classifyError(e) })
    return () => { reviewDisposed = true; if (reviewTimer) clearInterval(reviewTimer); reviews.stop() }
  })
  registerRoute(ctx, '/forge/reviews', async (req, res) => {
    if (req.method && req.method !== 'GET') throw new Error('仅支持 GET')
    sendJson(res, 200, { ...await reviews.snapshot(queryOf(req).cwd || ''), schedulerError: reviewError })
  })
  registerRoute(ctx, '/forge/reviews/config', async (req, res) => {
    if (req.method !== 'POST') throw new Error('仅支持 POST')
    const snapshot = await reviews.configure(await readBody(req))
    scheduleReviews(snapshot.defaults.intervalMs || 60000)
    sendJson(res, 200, snapshot)
    void pollReviews()
  })
  registerRoute(ctx, '/forge/reviews/start', async (req, res) => {
    if (req.method !== 'POST') throw new Error('仅支持 POST')
    sendJson(res, 200, await reviews.review(await readBody(req)))
    void pollReviews()
  })
  let stateCache: { at: number; data: StatePayload } | null = null
  let listCache: Record<string, { at: number; data: Record<string, unknown> }> = {}

  let stateCwdKey: string | null = null
  registerRoute(ctx, '/forge/state', async (req, res) => {
    const q = queryOf(req)
    const cwdKey = typeof q.cwd === 'string' ? q.cwd : ''
    const now = Date.now()
    if (q.force === '1' || cwdKey !== stateCwdKey) stateCache = null
    if (stateCache && now - stateCache.at < getConfig().stateTtlMs) {
      sendJson(res, 200, stateCache.data)
      return
    }
    const data = await loadState(ctx, runner, cwdKey || undefined, forgeKey(q.forge))
    stateCache = { at: now, data }
    stateCwdKey = cwdKey
    sendJson(res, 200, data)
  })

  let wsCache: { at: number; data: WorkspacesResult } | null = null
  registerRoute(ctx, '/forge/workspaces', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && wsCache && now - wsCache.at < getConfig().listTtlMs) {
      sendJson(res, 200, wsCache.data)
      return
    }
    if (q.force === '1') authCache = null
    const data = await loadWorkspaces(ctx, runner)
    wsCache = { at: now, data }
    sendJson(res, 200, data)
  })

  registerRoute(ctx, '/forge/mrs', async (req, res) => {
    const q = queryOf(req)
    const key = [q.scope || 'all', q.forge || '', q.repo || '', q.host || '', q.cwd || ''].join('|')
    const now = Date.now()
    const hit = listCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    try {
      const items = await loadItemList(ctx, runner, q)
      const data = { ok: true, updatedAt: Date.now(), mrs: items }
      listCache[key] = { at: now, data }
      sendJson(res, 200, data)
    } catch (err) {
      sendJson(res, 200, { ok: false, error: classifyError(err) })
    }
  })

  registerRoute(ctx, '/forge/mr', async (req, res) => {
    const q = queryOf(req)
    const num = numOf(q.num)
    const { forge, argv, cwd, repoPath } = await resolveTarget(ctx, runner, q)
    const out = await runner.forgeRun(forge, argv.concat(CMDS[forge].view(num)), { cwd: cwd || undefined })
    const raw = JSON.parse(out) as unknown
    const mr = toItemView(raw, forge)
    // Detail-only notes: GitHub view already carries `comments`; GitLab needs
    // an extra notes API call. A notes failure must NOT blank the detail —
    // the header/diff render fine without the 评论 tab body.
    let notes: NoteView[] = []
    try {
      if (forge === 'github') {
        notes = normalizeNotes(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).comments : null, forge)
      } else if (CMDS.gitlab.notes && repoPath) {
        const notesOut = await runner.forgeRun(
          forge, argv.concat(CMDS.gitlab.notes(num, repoPath)), { cwd: cwd || undefined })
        notes = normalizeNotes(JSON.parse(notesOut) as unknown, forge)
      }
    } catch (e) {
      notes = []
    }
    if (mr) (mr as Record<string, unknown>).notes = notes
    sendJson(res, 200, { ok: true, mr: mr })
  })

  registerRoute(ctx, '/forge/mr/diff', async (req, res) => {
    const q = queryOf(req)
    const num = numOf(q.num)
    const { forge, argv, cwd } = await resolveTarget(ctx, runner, q)
    const out = await runner.forgeRun(forge, argv.concat(CMDS[forge].diff(num)), { cwd: cwd || undefined, maxBytes: 2000000 })
    const capped = String(out).slice(0, 1800000)
    sendJson(res, 200, { ok: true, diff: capped, truncated: String(out).length > capped.length })
  })

  const mutate = async (req: IncomingMessage, res: ServerResponse, argv: { forge: ForgeKey; args: string[] }, cwd: string | null): Promise<void> => {
    const out = await runner.forgeRun(argv.forge, argv.args, { cwd: cwd || undefined })
    stateCache = null
    listCache = {}
    wsCache = null
    sendJson(res, 200, { ok: true, stdout: String(out).slice(0, 1000) })
  }

  const mutationRoutes: Array<[string, 'approve' | 'merge' | 'note' | 'close']> = [
    ['/forge/mr/approve', 'approve'],
    ['/forge/mr/merge', 'merge'],
    ['/forge/mr/note', 'note'],
    ['/forge/mr/close', 'close'],
  ]
  for (const [path, kind] of mutationRoutes) {
    registerRoute(ctx, path, async (req, res) => {
      const body = await readBody(req)
      const num = numOf(body.num)
      const { forge, argv, cwd } = await resolveTarget(ctx, runner, body as Record<string, string>)
      let args = argv.concat((CMDS[forge][kind] as (num: string) => string[])(num))
      if (kind === 'merge') {
        args = argv.concat(CMDS[forge].merge(num, body.squash === true, body.removeSource === true))
      }
      if (kind === 'note') {
        const text = String(body.body || '').trim()
        if (!text) throw new Error('评论内容不能为空')
        args = argv.concat(CMDS[forge].note(num, text))
      }
      await mutate(req, res, { forge, args }, cwd)
    })
  }

  // ── Issues（GitLab Issue / GitHub Issue，同走 glab / gh CLI）───────────────
  const issueListCache: Record<string, { at: number; data: Record<string, unknown> }> = {}
  const issueMetaCache: Record<string, { at: number; data: IssueMetaPayload }> = {}

  function clearIssueCaches(): void {
    for (const k of Object.keys(issueListCache)) delete issueListCache[k]
    for (const k of Object.keys(issueMetaCache)) delete issueMetaCache[k]
  }

  registerRoute(ctx, '/forge/issues', async (req, res) => {
    const q = queryOf(req)
    const f = normalizeIssueFilters(q)
    const key = [q.forge || '', q.repo || '', q.host || '', q.cwd || '', f.scope, f.state, f.search, f.label, f.assignee, f.sort, f.page, f.pageSize].join('|')
    const now = Date.now()
    const hit = issueListCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadIssueList(ctx, runner, q)
    issueListCache[key] = { at: now, data }
    sendJson(res, 200, data)
  })

  registerRoute(ctx, '/forge/issue', async (req, res) => {
    const q = queryOf(req)
    sendJson(res, 200, await loadIssueDetail(ctx, runner, q))
  })

  registerRoute(ctx, '/forge/issue/meta', async (req, res) => {
    const q = queryOf(req)
    const key = [q.forge || '', q.repo || '', q.host || '', q.cwd || ''].join('|')
    const now = Date.now()
    const hit = issueMetaCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadIssueMeta(ctx, runner, q)
    issueMetaCache[key] = { at: now, data }
    sendJson(res, 200, data)
  })

  registerRoute(ctx, '/forge/issue/update', async (req, res) => {
    const body = await readBody(req)
    const result = await handleIssueUpdate(ctx, runner, body)
    clearIssueCaches()
    sendJson(res, 200, result)
  })

  const issueMutationRoutes: Array<[string, 'close' | 'reopen']> = [
    ['/forge/issue/close', 'close'],
    ['/forge/issue/reopen', 'reopen'],
  ]
  for (const [path, kind] of issueMutationRoutes) {
    registerRoute(ctx, path, async (req, res) => {
      const body = await readBody(req)
      const num = numOf(body.num, 'Issue')
      const { forge, argv, cwd } = await resolveTarget(ctx, runner, body as Record<string, string>)
      const args = argv.concat(kind === 'close' ? issueCloseArgv(num) : issueReopenArgv(num))
      const out = await runner.forgeRun(forge, args, { cwd: cwd || undefined })
      clearIssueCaches()
      sendJson(res, 200, { ok: true, stdout: String(out).slice(0, 1000) })
    })
  }

  registerRoute(ctx, '/forge/issue/note', async (req, res) => {
    const body = await readBody(req)
    const num = numOf(body.num, 'Issue')
    const text = String(body.body || '').trim()
    if (!text) throw new Error('评论内容不能为空')
    const { forge, argv, cwd } = await resolveTarget(ctx, runner, body as Record<string, string>)
    const out = await runner.forgeRun(forge, argv.concat(issueNoteArgv(forge, num, text)), { cwd: cwd || undefined })
    clearIssueCaches()
    sendJson(res, 200, { ok: true, stdout: String(out).slice(0, 1000) })
  })

  // ── DMS 工单（本机 aliyun CLI）────────────────────────────────────────────
  let dmsStatusCache: { at: number; data: DmsStatusPayload } | null = null
  const dmsListCache: Record<string, { at: number; data: Record<string, unknown> }> = {}
  const dmsDetailCache: Record<string, { at: number; data: Record<string, unknown> }> = {}
  const dmsSqlCache: Record<string, { at: number; data: Record<string, unknown> }> = {}

  registerRoute(ctx, '/dms/status', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && dmsStatusCache && now - dmsStatusCache.at < getConfig().authTtlMs) {
      sendJson(res, 200, dmsStatusCache.data)
      return
    }
    const data = await loadDmsStatus(ctx, runner)
    dmsStatusCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifyDmsError)

  registerRoute(ctx, '/dms/orders', async (req, res) => {
    const q = queryOf(req)
    const key = [q.resultType || '', q.page || '', q.pageSize || '', q.region || '', q.tid || '', q.orderStatus || '', q.search || ''].join('|')
    const now = Date.now()
    const hit = dmsListCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = Object.assign({ ok: true, updatedAt: now }, await loadDmsOrders(ctx, runner, q))
    dmsListCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifyDmsError)

  registerRoute(ctx, '/dms/order', async (req, res) => {
    const q = queryOf(req)
    const key = [q.id || '', q.region || '', q.tid || ''].join('|')
    const now = Date.now()
    const hit = dmsDetailCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = { ok: true, updatedAt: now, order: await loadDmsOrder(ctx, runner, q) }
    dmsDetailCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifyDmsError)

  // 工单内容详情（TABLE_SYNC → GetStructSyncExecSqlDetail 翻页拼接，
  // DATA_CHANGE → GetDataCorrectOrderDetail，PERM_APPLY / OWNER_APPLY →
  // GetPermApplyOrderDetail / GetOwnerApplyOrderDetail 回申请内容；其余类型
  // 返回 supported:false，不执行 CLI）。审批通过后工单开始执行，缓存随审批
  // 一起失效。
  registerRoute(ctx, '/dms/order/sql', async (req, res) => {
    const q = queryOf(req)
    const key = [q.id || '', q.region || '', q.tid || '', String(q.type || '').trim().toUpperCase()].join('|')
    const now = Date.now()
    const hit = dmsSqlCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadDmsOrderSql(ctx, runner, q)
    dmsSqlCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifyDmsError)

  registerRoute(ctx, '/dms/order/approve', async (req, res) => {
    const body = await readBody(req)
    const result = await handleDmsApprove(ctx, runner, body)
    for (const k of Object.keys(dmsListCache)) delete dmsListCache[k]
    for (const k of Object.keys(dmsDetailCache)) delete dmsDetailCache[k]
    for (const k of Object.keys(dmsSqlCache)) delete dmsSqlCache[k]
    sendJson(res, 200, result)
  }, classifyDmsError)

  // ── SLS 日志查询（本机 aliyun CLI `sls get-logs-v2`）─────────────────────
  // /sls/status 与 /dms/status 探测的是同一个 aliyun CLI 凭证（aliyun configure
  // list），直接复用 loadDmsStatus，并附上部署配置的环境列表（slsEnvironments，
  // 见 config.ts / sls.ts 的 parseSlsEnvironments）；/sls/query 每次实时执行
  // （日志查询对时效敏感，不做结果缓存），project/logstore 必填、无默认值。
  type SlsStatusPayload = DmsStatusPayload & { environments: SlsEnvironment[] }
  let slsStatusCache: { at: number; data: SlsStatusPayload } | null = null

  registerRoute(ctx, '/sls/status', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && slsStatusCache && now - slsStatusCache.at < getConfig().authTtlMs) {
      sendJson(res, 200, slsStatusCache.data)
      return
    }
    const data: SlsStatusPayload = {
      ...(await loadDmsStatus(ctx, runner)),
      environments: parseSlsEnvironments(getConfig().slsEnvironments),
    }
    slsStatusCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifySlsError)

  registerRoute(ctx, '/sls/query', async (req, res) => {
    const body = await readBody(req)
    const data = await runSlsQuery(ctx, runner, body)
    sendJson(res, 200, data)
  }, classifySlsError)

  // ── GitHub 通知（本机 gh CLI）────────────────────────────────────────────
  // /notifications/list 结果按 (host|all|page) 短 TTL 缓存（notificationsTtlMs
  // 部署可调），首页通知区 / 侧栏未读徽标 / 通知页共享同一份缓存，避免反复
  // 打 GitHub API；force=1 绕过。/notifications/action 写成功后整组失效，
  // 标记已读 / 完成立即反映到下次查询（与 DMS 写后失效同款）。
  let notificationsCache: Record<string, { at: number; data: Awaited<ReturnType<typeof loadNotifications>> }> = {}

  registerRoute(ctx, '/notifications/list', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    const q = queryOf(req)
    const key = [notificationHost(q.host), q.all === 'true', q.page || '1'].join('|')
    const now = Date.now()
    const hit = notificationsCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().notificationsTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadNotifications(runner, q)
    notificationsCache[key] = { at: now, data }
    sendJson(res, 200, data)
  })
  registerRoute(ctx, '/notifications/action', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    const body = await readBody(req)
    await runner.forgeRun('github', notificationActionArgv(body))
    for (const k of Object.keys(notificationsCache)) delete notificationsCache[k]
    sendJson(res, 200, { ok: true })
  })

  // ── 首页 /home/sessions：跨工作区「需要我关注」会话聚合（见 ./home.ts）──────
  // 读 DSH 会话存储（$DSH_HOME/sessions + projcache），无 CLI 依赖；短 TTL 缓存
  // 合并多消费者的重复拉取（homeSessionsTtlMs 部署可调）。
  let homeCache: { at: number; data: HomeSessionsPayload } | null = null
  registerRoute(ctx, '/home/sessions', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    const q = queryOf(req)
    const requested = Number(q.limit || 10)
    if (!Number.isSafeInteger(requested) || requested < 1) {
      return sendJson(res, 400, { ok: false, error: 'Invalid session limit' })
    }
    const now = Date.now()
    if (q.force === '1' || !homeCache || now - homeCache.at >= getConfig().homeSessionsTtlMs) {
      const data = await scanHomeSessions({ scanKeepMs: Infinity, recentMs: Infinity, recentCap: Infinity })
      homeCache = { at: now, data }
    }
    const data = homeCache.data
    const recent = data.groups.recent.slice(0, requested)
    const sessions = [...data.groups.running, ...data.groups.waiting, ...recent]
      .sort((a, b) => b.promptedAt - a.promptedAt)
    sendJson(res, 200, {
      ...data, sessions, groups: { ...data.groups, recent },
      counts: { ...data.counts, recent24h: data.sessions.filter(row => row.updatedAt >= now - 24 * 3600 * 1000).length },
      hasMore: data.groups.recent.length > requested,
    })
  })

  // ── PingCode（python3 <技能目录>/scripts/api_call.py，见 ./pingcode.ts）────
  // 阶段一只读：状态探测 / 项目 / 工作项列表与详情 / 评论 / 成员。所有列表
  // 分级缓存（listTtlMs），状态探测缓存 authTtlMs（内部含一次真实 API 探测）。
  // 写操作（创建/更新/评论）留待阶段二，届时按 dms 的形态加写后失效。
  let pcStatusCache: { at: number; data: PingcodeStatusPayload } | null = null
  let pcProjectsCache: { at: number; data: Record<string, unknown> } | null = null
  let pcMembersCache: { at: number; data: Record<string, unknown> } | null = null
  const pcListCache: Record<string, { at: number; data: Record<string, unknown> }> = {}
  const pcDetailCache: Record<string, { at: number; data: Record<string, unknown> }> = {}

  registerRoute(ctx, '/pingcode/status', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && pcStatusCache && now - pcStatusCache.at < getConfig().authTtlMs) {
      sendJson(res, 200, pcStatusCache.data)
      return
    }
    const data = await loadPingcodeStatus(ctx, runner)
    pcStatusCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifyPingcodeError)

  registerRoute(ctx, '/pingcode/projects', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && pcProjectsCache && now - pcProjectsCache.at < getConfig().listTtlMs) {
      sendJson(res, 200, pcProjectsCache.data)
      return
    }
    const data = await loadPingcodeProjects(ctx, runner)
    pcProjectsCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifyPingcodeError)

  registerRoute(ctx, '/pingcode/workitems', async (req, res) => {
    const q = queryOf(req)
    const key = [q.projectId || '', q.typeId || '', q.assigneeId || '', q.keywords || '', q.scope || '', q.stateType || '', q.page || '', q.pageSize || ''].join('|')
    const now = Date.now()
    const hit = pcListCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadPingcodeWorkItems(ctx, runner, q)
    pcListCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifyPingcodeError)

  registerRoute(ctx, '/pingcode/workitem', async (req, res) => {
    const q = queryOf(req)
    const key = String(q.id || '')
    const now = Date.now()
    const hit = pcDetailCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadPingcodeWorkItem(ctx, runner, q)
    pcDetailCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifyPingcodeError)

  registerRoute(ctx, '/pingcode/members', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    if (q.force !== '1' && pcMembersCache && now - pcMembersCache.at < getConfig().listTtlMs) {
      sendJson(res, 200, pcMembersCache.data)
      return
    }
    const data = await loadPingcodeMembers(ctx, runner)
    pcMembersCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifyPingcodeError)

  // ── 技能管理（skills.sh 的 `npx skills` CLI + 本地技能根，见 ./skills.ts）──
  // 列表/详情直接读 DSH 的技能发现根；安装/卸载/更新走 CLI（写操作即时失效
  // 列表缓存）；搜索走 skills.sh 的公开 /api/search。状态探测缓存 authTtlMs，
  // 列表/搜索缓存 listTtlMs（写操作后清空列表缓存）。
  let skStatusCache: { at: number; data: Record<string, unknown> } | null = null
  const skListCache: Record<string, { at: number; data: Record<string, unknown> }> = {}
  const skSearchCache: Record<string, { at: number; data: Record<string, unknown> }> = {}

  function clearSkillCaches(): void {
    skStatusCache = null
    for (const k of Object.keys(skListCache)) delete skListCache[k]
    for (const k of Object.keys(skSearchCache)) delete skSearchCache[k]
  }

  /** cwd 只能是绝对路径（否则回落工作区根），避免相对路径在 host 进程里解析。 */
  function skillsCwd(v: unknown): string {
    const s = String(v == null ? '' : v).trim()
    return s && s.startsWith('/') ? s : defaultSkillsWorkspaceRoot(runner)
  }

  ctx.effect(() => startSkillsAutoUpdate(ctx, runner, getConfig().skillsAutoUpdateIntervalMs, clearSkillCaches))

  registerRoute(ctx, '/skills/status', async (req, res) => {
    const q = queryOf(req)
    const now = Date.now()
    const cwd = skillsCwd(q.cwd)
    if (q.force !== '1' && skStatusCache && now - skStatusCache.at < getConfig().authTtlMs) {
      sendJson(res, 200, skStatusCache.data)
      return
    }
    const data = await loadSkillsStatus(ctx, runner, cwd)
    skStatusCache = { at: now, data }
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/list', async (req, res) => {
    const q = queryOf(req)
    const scope: SkillScope = isSkillScope(q.scope) ? q.scope : 'global'
    const cwd = skillsCwd(q.cwd)
    const key = scope + '|' + cwd
    const now = Date.now()
    const hit = skListCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await loadSkillsList(ctx, runner, scope, cwd)
    skListCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/check', async (req, res) => {
    const q = queryOf(req)
    const scope: SkillScope = isSkillScope(q.scope) ? q.scope : 'global'
    sendJson(res, 200, await checkSkillsUpdates(runner, scope, skillsCwd(q.cwd)))
  }, classifySkillsError)

  registerRoute(ctx, '/skills/search', async (req, res) => {
    const q = queryOf(req)
    const query = String(q.q || '').trim()
    const limitRaw = Number(q.limit)
    const limit = isFinite(limitRaw) && limitRaw > 0 ? Math.min(50, Math.floor(limitRaw)) : undefined
    const key = query.toLowerCase() + '|' + String(limit || '')
    const now = Date.now()
    const hit = skSearchCache[key]
    if (q.force !== '1' && hit && now - hit.at < getConfig().listTtlMs) {
      sendJson(res, 200, hit.data)
      return
    }
    const data = await searchSkillsCatalog(query, limit)
    if (data.ok) skSearchCache[key] = { at: now, data }
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/detail', async (req, res) => {
    const q = queryOf(req)
    const scope: SkillScope = isSkillScope(q.scope) ? q.scope : 'global'
    const name = String(q.name || '').trim()
    if (!skillDirNameValid(name)) throw new Error('无效的技能名：' + name.slice(0, 60))
    const data = await loadSkillDetail(scope, name, skillsCwd(q.cwd), process.env.HOME || '')
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/file', async (req, res) => {
    const q = queryOf(req)
    const scope: SkillScope = isSkillScope(q.scope) ? q.scope : 'global'
    const name = String(q.name || '').trim()
    if (!skillDirNameValid(name)) throw new Error('无效的技能名：' + name.slice(0, 60))
    const data = await loadSkillFile(scope, name, q.file, skillsCwd(q.cwd), process.env.HOME || '')
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/install', async (req, res) => {
    const body = await readBody(req)
    const data = await installSkills(ctx, runner, Object.assign({ cwd: skillsCwd(body.cwd) }, body))
    clearSkillCaches()
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/remove', async (req, res) => {
    const body = await readBody(req)
    const data = await removeSkills(ctx, runner, Object.assign({ cwd: skillsCwd(body.cwd) }, body))
    clearSkillCaches()
    sendJson(res, 200, data)
  }, classifySkillsError)

  // 停用/启用：编辑 SKILL.md frontmatter（不依赖 CLI），改动后清列表缓存。
  registerRoute(ctx, '/skills/disable', async (req, res) => {
    const body = await readBody(req)
    const data = await setSkillDisabled(ctx, runner, Object.assign({ cwd: skillsCwd(body.cwd) }, body))
    clearSkillCaches()
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/update', async (req, res) => {
    const body = await readBody(req)
    const data = await updateSkills(ctx, runner, Object.assign({ cwd: skillsCwd(body.cwd) }, body))
    clearSkillCaches()
    sendJson(res, 200, data)
  }, classifySkillsError)

  registerRoute(ctx, '/skills/discover', async (req, res) => {
    const body = await readBody(req)
    const data = await discoverSkills(ctx, runner, body.package, skillsCwd(body.cwd))
    sendJson(res, 200, data)
  }, classifySkillsError)
}
