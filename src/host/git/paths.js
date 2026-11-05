/**
 * Path and workspace guards for the host half.
 *
 * A request may name a repository-relative path and (optionally) a cwd. Both
 * are confined before they can reach argv: the cwd must stay inside the
 * workspace DSH registered for this session, and a path must be a plain
 * relative path with no traversal, no leading dash and no NUL.
 */

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { RequestError } from './errors.js'

/** Workspace root from the host services, with the same fallback ladder workbench uses. */
export function workspaceRootOf(ctx) {
  try {
    const policy = ctx.get('sandboxPolicy')
    if (policy && typeof policy.workspaceRoot === 'string' && policy.workspaceRoot) return policy.workspaceRoot
  } catch {
    /* service not present in this composition */
  }
  try {
    const fs = ctx.get('fs')
    if (fs && typeof fs.resolve === 'function') {
      const target = fs.resolve('.')
      if (target) return typeof fs.processPath === 'function' ? fs.processPath(target) : target
    }
  } catch {
    /* service not present */
  }
  return process.cwd()
}

/**
 * Every directory a git command may run in: the session workspace plus every
 * workspace DSH has registered. This is the trust boundary the repo switcher
 * relies on — a client can name any registered workspace, never an arbitrary
 * path.
 */
export function allowedRoots(ctx) {
  // Roots are compared as real paths so /tmp and /private/tmp agree.
  const roots = []
  const add = (value) => {
    if (typeof value === 'string' && value && !roots.includes(value)) roots.push(value)
  }
  add(workspaceRootOf(ctx))
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      for (const workspace of registry.list()) add(workspace && workspace.path)
    }
  } catch {
    /* service not present in this composition */
  }
  return roots.map(realpathOr)
}

/** Real path when the target exists; the original value otherwise. */
function realpathOr(value) {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
}

function isInside(root, absolute) {
  const rel = relative(root, absolute)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isRepositoryPath(root) {
  try {
    return existsSync(join(root, '.git'))
  } catch {
    return false
  }
}

/**
 * The directory a request without a cwd runs in.
 *
 * The app-level sandbox root is often the process cwd of the desktop app (for
 * example `/`), which is not a repository. Instead of failing with git's
 * "not a git repository", pick the session workspace when it is a repository,
 * otherwise the first registered workspace that is one.
 */
export function defaultRoot(ctx) {
  const roots = allowedRoots(ctx)
  for (const root of roots) if (isRepositoryPath(root)) return root
  return roots[0] ?? process.cwd()
}

/**
 * Resolve the requested `cwd` (optional) and confine it to a registered
 * workspace. Without a requested cwd the default workspace is used.
 */
export function resolveCwd(ctx, requested) {
  const roots = allowedRoots(ctx)
  const root = roots[0] ?? workspaceRootOf(ctx)
  if (!requested) return defaultRoot(ctx)
  if (typeof requested !== 'string' || requested.includes('\0')) throw new RequestError('无效的 cwd 参数')
  // Resolve with node:path only. `ctx.fs.resolve()` returns an opaque FsTarget
  // for the model's filesystem view, not an OS path a child process can chdir to.
  const absolute = realpathOr(isAbsolute(requested) ? requested : resolvePath(root, requested))
  if (!roots.some((candidate) => isInside(candidate, absolute))) {
    throw new RequestError('cwd 不在任何已注册工作区内', 403, 'outside-workspace')
  }
  return absolute
}

/**
 * Validate a repository-relative path before it reaches argv.
 * Rejects NUL, absolute paths, `..` segments, option-looking paths and empty input.
 */
export function safeRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0) throw new RequestError('缺少 path 参数')
  if (value.length > 4096) throw new RequestError('path 参数过长')
  if (value.includes('\0')) throw new RequestError('path 不能包含 NUL')
  if (isAbsolute(value) || value.startsWith('~')) throw new RequestError('path 必须是仓库内相对路径')
  if (value.startsWith('-')) throw new RequestError('path 不能以 - 开头')
  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) throw new RequestError('path 不能包含 ..')
  return segments.filter(Boolean).join('/')
}
