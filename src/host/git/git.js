/**
 * Git process runner for the host half.
 *
 * Every git invocation in this plugin goes through here, so the child-process
 * shape and the scrubbed environment are defined in exactly one place. The
 * functions take the subprocess service directly (not the Cordis context) so a
 * plain Node test can drive them with a fake process table.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { GitError } from './errors.js'

/** Output caps per command family. */
export const MAX_STATUS_BYTES = 4 * 1024 * 1024
export const MAX_DIFF_BYTES = 2 * 1024 * 1024
export const MAX_REFS_BYTES = 2 * 1024 * 1024
export const GIT_TIMEOUT_MS = 10_000
export const GIT_PUSH_TIMEOUT_MS = 60_000
export const MAX_PUSH_BYTES = 2 * 1024 * 1024

/** Environment every git child starts from (merged over the subprocess scrub). */
export const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
})

/** The harness home; a git config under it was injected by a plugin, not chosen by a person. */
function harnessHomeOf(env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') return env.DSH_HOME
  return join(typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir(), '.dsh')
}

/**
 * The global git config of the person using the workbench, when the host's
 * value was replaced for agent child processes.
 *
 * A harness plugin (an agent deployment) may point `GIT_CONFIG_GLOBAL` at an
 * isolated config so its shells never inherit the operator's identity or
 * credentials. The workbench acts for the person in front of the UI, not for
 * an agent, so it resolves the global config from the operator's home instead
 * of inheriting that replacement. Unset, or a value outside the harness home,
 * is the operator's own choice and stays untouched.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | undefined} config path to use, or undefined to inherit `env`
 */
export function operatorGitConfig(env = process.env) {
  const configured = typeof env.GIT_CONFIG_GLOBAL === 'string' ? env.GIT_CONFIG_GLOBAL : ''
  if (configured === '') return undefined
  const home = harnessHomeOf(env)
  const inside = configured === home || configured.startsWith(home.endsWith('/') ? home : home + '/')
  if (!inside) return undefined
  const userHome = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir()
  const file = join(userHome, '.gitconfig')
  if (existsSync(file)) return file
  const xdg = join(typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : join(userHome, '.config'), 'git', 'config')
  return existsSync(xdg) ? xdg : file
}

/**
 * The child environment for one git invocation.
 *
 * The same isolation that replaces `GIT_CONFIG_GLOBAL` also suppresses the
 * machine's git config (`GIT_CONFIG_NOSYSTEM=1`). That config is where macOS
 * keeps the `osxkeychain` credential helper, so a git started under the
 * isolation cannot authenticate a push even after the operator's own config is
 * restored — it fails with `could not read Username`. Restoring the machine
 * config is part of acting as the person in front of the UI.
 */
export function gitEnvironment(env = process.env) {
  const operatorConfig = operatorGitConfig(env)
  if (operatorConfig === undefined) return { ...GIT_ENV }
  return { ...GIT_ENV, GIT_CONFIG_GLOBAL: operatorConfig, GIT_CONFIG_NOSYSTEM: '0' }
}


/**
 * Resolve the subprocess service, refusing to run without it.
 * A missing capability is a deployment problem, not a request problem.
 */
export function subprocessOf(ctx) {
  const subprocess = ctx.get('subprocess')
  if (
    !subprocess ||
    typeof subprocess.resolveExecutable !== 'function' ||
    typeof subprocess.spawn !== 'function'
  ) {
    throw new GitError('subprocess 服务不可用：该插件需要 subprocess 能力', 'subprocess-unavailable')
  }
  return subprocess
}

/**
 * Run one git command through the subprocess capability.
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export async function execGit(subprocess, argv, cwd, options = {}) {
  return runProcess(subprocess, 'git', argv, cwd, {
    ...options,
    env: gitEnvironment(),
    missingMessage: '未找到 git 可执行文件（macOS 上仅安装 Command Line Tools 存根时也会出现）',
    missingCode: 'git-not-found',
    spawnMessage: '无法启动 git：',
    spawnCode: 'git-spawn-failed',
  })
}

/**
 * Run one fixed-argv child process through the subprocess capability.
 *
 * The same shape as a git call — no shell, scrubbed environment, bounded
 * output, bounded run time — but the executable is named by the caller so the
 * local `open` actions do not need a second spawn implementation.
 *
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
export async function runProcess(subprocess, command, argv, cwd, options = {}) {
  if (
    !subprocess ||
    typeof subprocess.resolveExecutable !== 'function' ||
    typeof subprocess.spawn !== 'function'
  ) {
    throw new GitError('subprocess 服务不可用：该插件需要 subprocess 能力', 'subprocess-unavailable')
  }
  const label = options.label ?? command
  const maxBytes = options.maxBytes ?? MAX_STATUS_BYTES
  let exe
  try {
    exe = await subprocess.resolveExecutable(command)
  } catch {
    throw new GitError(
      options.missingMessage ?? '未找到 ' + label + ' 可执行文件',
      options.missingCode ?? command + '-not-found',
    )
  }
  let handle
  try {
    handle = subprocess.spawn({
      argv: [exe, ...argv],
      cwd,
      env: { ...(options.env ?? {}) },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: options.timeoutMs ?? GIT_TIMEOUT_MS,
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new GitError(
      (options.spawnMessage ?? '无法启动 ' + label + '：') + detail,
      options.spawnCode ?? command + '-spawn-failed',
    )
  }
  const outcome = await handle.done
  const stdout = handle.collected?.stdout?.readFrom(0)
  const stderr = handle.collected?.stderr?.readFrom(0)
  if (stdout?.lossy) throw new GitError('输出超出上限，请缩小查询范围', 'output-too-large')
  return { code: outcome.exitCode, out: stdout?.text ?? '', err: (stderr?.text ?? '').trim() }
}

/** The checked-out branch, or '' when HEAD is detached. */
export async function currentBranchOf(subprocess, cwd) {
  try {
    return (await git(subprocess, ['symbolic-ref', '--short', '-q', 'HEAD'], cwd, { maxBytes: 8 * 1024 })).trim()
  } catch {
    return ''
  }
}

/** Run git and throw on a non-zero exit, carrying git's own message. */
export async function git(subprocess, argv, cwd, options) {
  const result = await execGit(subprocess, argv, cwd, options)
  if (result.code !== 0) throw new GitError(result.err || 'git 退出码 ' + String(result.code), 'git-failed')
  return result.out
}
