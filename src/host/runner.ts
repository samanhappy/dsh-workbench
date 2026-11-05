// dsh-workbench — host runner infrastructure: the HostContext surface the host
// half touches, the subprocess runner contract, http helpers, error
// classification, and the shared CLI-availability probe.
//
// This module is import-free of the forge/DMS domains — src/host/index.ts and
// src/host/dms.ts both depend on it, and it depends only on config.ts — so it
// never forms a cycle. `createRunner` (the forge-flavored Runner factory, keyed
// off the FORGES map) intentionally lives in index.ts with the forge domain.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { access, constants, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getConfig } from './config'

export type ForgeKey = 'gitlab' | 'github'

// ── host service surface the host half touches (duck-typed, fail-soft) ──────

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface HostContext {
  get(name: string): unknown
  effect(fn: () => void | (() => void), label?: string): void
  webServer: { register(route: WebRoute): () => void }
  connection: { requestRejection(req: IncomingMessage): number | undefined }
}

export interface RunOpts {
  cwd?: string
  maxBytes?: number
  spillMaxBytes?: number
  graceMs?: number
  /** Extra environment for the child process (e.g. npm_config_cache so a
   *  sandboxed `npx` does not have to write ~/.npm). Best-effort: the DSH
   *  subprocess service may ignore unknown spawn-spec fields. */
  env?: Record<string, string>
}

export interface RunResult {
  out: string
  errText: string
  code: number
}

export interface Runner {
  forgeRun(forge: ForgeKey, argv: string[], opts?: RunOpts): Promise<string>
  git(argv: string[], opts?: RunOpts): Promise<string>
  tryRun(exe: string, argv: string[], opts?: RunOpts): Promise<RunResult>
  getWorkspaceRoot(): string
}

export function connectionOf(ctx: HostContext) {
  return Reflect.get(ctx, 'connection')
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function queryOf(req: IncomingMessage): Record<string, string> {
  const url = new URL(String(req.url), 'http://localhost')
  const out: Record<string, string> = {}
  for (const [k, v] of url.searchParams.entries()) out[k] = v
  return out
}

// ── error classification ────────────────────────────────────────────────────

/** aliyun CLI OAuth 刷新令牌过期（invalid_grant / Refresh token expired /
 *  failed to refresh token）的重登提示。错误文本里带 CLI 自己的
 *  re-authenticate 命令时原样带上，否则给通用 OAuth 重登命令；不匹配返回
 *  null。DMS / SLS 两个域共用（同一个 aliyun CLI 凭证）。 */
export function aliyunOAuthReauthHint(errText: string): string | null {
  const low = errText.toLowerCase()
  if (!/failed to refresh token|invalid_grant|refresh token expired|re-authenticate/.test(low)) return null
  const m = errText.match(/re-authenticate:\s*([^\n;]+)/i)
  const cmd = (m && m[1]) ? m[1].trim() : 'aliyun configure --mode OAuth --oauth-site-type CN'
  return 'aliyun CLI OAuth 登录已过期：请重新运行 `' + cmd + '` 重新登录（浏览器授权）'
}

export function classifyError(err: unknown): string {
  const text = String(err && typeof err === 'object' && 'message' in err ? (err as { message: unknown }).message : err)
  const low = text.toLowerCase()
  if (/未检测到|command not found|enoent|no such file|is not recognized|not recognized/.test(low)) {
    return '未检测到 GitLab CLI（glab）或 GitHub CLI（gh）命令行工具（brew install glab / brew install gh）'
  }
  if (/not a git repository|不是 git 仓库/.test(low)) {
    return '当前工作区不是 Git 仓库，请在面板顶部切换到 Git 工作区'
  }
  if (/401|unauthorized|unauthenticated|authentication failed|not logged in|请先登录|登录.*失效|invalid token|auth login|to get started with/.test(low)) {
    return '未登录对应平台或登录已过期（请运行 glab auth login 或 gh auth login 重新授权）'
  }
  if (/404|not found/.test(low)) {
    return '资源不存在（404）：仓库或 MR/PR 可能不存在、无权限，或未指定正确的 host'
  }
  if (/could not resolve host|getaddrinfo|network|proxy|timeout|timed out/.test(low)) {
    return '网络错误：无法连接平台（' + text.slice(0, 120) + '）'
  }
  return text
}

// ── CLI availability (cached) ───────────────────────────────────────────────

let exeCache: { at: number; byExe: Record<string, boolean> } | null = null

/** Whether an executable resolves on PATH (cache authTtlMs). Shared by the
 *  forge (glab/gh) and DMS (aliyun) probes. */
export async function exeAvailable(runner: Runner, exe: string): Promise<boolean> {
  const now = Date.now()
  if (!exeCache || now - exeCache.at >= getConfig().authTtlMs) exeCache = { at: now, byExe: {} }
  if (exeCache.byExe[exe] !== undefined) return exeCache.byExe[exe]
  const r = await runner.tryRun(exe, ['--version'], { graceMs: 10000 })
  exeCache.byExe[exe] = r.code === 0
  return exeCache.byExe[exe]
}

// ── CLI discovery (host PATH fallback) ──────────────────────────────────────
//
// `subprocess.resolveExecutable(name)` only searches the host process's
// scrubbed PATH. DSH is a macOS GUI app, so its PATH is the system minimum
// (/usr/bin:/bin:/usr/sbin:/sbin) — Homebrew (/opt/homebrew/bin) and
// /usr/local/bin installs (glab, gh, aliyun) are invisible even though the
// terminal finds them via ~/.zprofile / ~/.zshrc. When the PATH lookup fails,
// probe known install locations before giving up:
//   1. $<NAME>_BIN — explicit absolute path override (e.g. GLAB_BIN).
//   2. ~/.local/bin, ~/.npm-global/bin, ~/.bun/bin, ~/.volta/bin,
//      /usr/local/bin, /opt/homebrew/bin — each + '/' + name.
//   3. ~/.nvm/versions/node/*/bin — newest nvm node first.

function isExecutableFile(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(() => true, () => false)
}

function homeCandidateDirs(home: string): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
}

/** Newest-first nvm node version dirs (e.g. v24.15.0), absolute. */
async function nvmNodeBinDirs(home: string): Promise<string[]> {
  const nodeRoot = join(home, '.nvm', 'versions', 'node')
  let entries
  try {
    entries = await readdir(nodeRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const versions = entries
    .filter((d) => d.isDirectory() && /^v\d+\.\d+\.\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => {
      const pa = a.slice(1).split('.').map(Number)
      const pb = b.slice(1).split('.').map(Number)
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
      }
      return 0
    })
  return versions.map((v) => join(nodeRoot, v, 'bin'))
}

/** If `candidate` is the npm run.js wrapper, return its platform binary path. */
async function resolveNativeBinary(candidate: string, platform: string, arch: string): Promise<string | null> {
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return null
  }
  if (basename(real) !== 'run.js' || basename(dirname(real)) !== 'scripts') return null
  // The wrapper execs <pkg>/bin/<binName>-<platform>-<arch>; binName comes from
  // package.json's `bin` field (the CLI name, not necessarily the package name).
  const pkgDir = dirname(dirname(real))
  let binName: string | null = null
  try {
    const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
    const bin = pkg && pkg.bin
    if (typeof bin === 'string') binName = basename(bin)
    else if (bin && typeof bin === 'object') binName = Object.keys(bin)[0] || null
  } catch {}
  if (!binName) return null
  const bin = join(pkgDir, 'bin', `${binName}-${platform}-${arch}`)
  return (await isExecutableFile(bin)) ? bin : null
}

/**
 * Resolve an executable CLI for subprocess.spawn, falling back to known
 * install locations when the host PATH hides it. Returns null when nothing
 * usable exists. `resolveExecutable` failure is NOT fatal — the probe list
 * exists precisely because the host PATH hides common installs.
 *
 * `accept` (optional) lets the caller reject a path that resolves but does not
 * run — e.g. another plugin prepends a wrapper shim to the app PATH whose argv
 * injection breaks this CLI. A rejected PATH hit is skipped in favor of the
 * known install locations; when nothing is accepted the first PATH hit is
 * returned unchanged (legacy behavior).
 */
export async function resolveCliExe(
  resolveExecutable: ((name: string) => Promise<string>) | undefined,
  name: string,
  accept?: (path: string) => Promise<boolean>,
): Promise<string | null> {
  let fallback: string | null = null
  if (resolveExecutable !== undefined) {
    try {
      const resolved = await resolveExecutable(name)
      if (accept === undefined || await accept(resolved)) return resolved
      fallback = resolved
    } catch {}
  }
  const home = process.env.HOME || (() => {
    try { return homedir() } catch { return '/tmp' }
  })()
  const explicit = process.env[name.toUpperCase() + '_BIN']
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const candidates = [
    ...(explicit ? [explicit] : []),
    ...(await nvmNodeBinDirs(home)).map((dir) => join(dir, name)),
    ...homeCandidateDirs(home).map((dir) => join(dir, name)),
  ]
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      const path = (await resolveNativeBinary(candidate, platform, arch)) || candidate
      if (accept === undefined || await accept(path)) return path
      if (fallback === null) fallback = path
    }
  }
  return fallback
}
