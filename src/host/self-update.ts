import { readFile, writeFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Runner } from './runner'
import { resolveCliExe } from './runner'

export interface UpdateState { status: 'idle' | 'checking' | 'current' | 'blocked' | 'updated' | 'error'; message: string }

/** Only updates the installed package's own Git root; never the enclosing workspace. */
export function createSelfUpdater(runner: Runner, directory = dirname(fileURLToPath(import.meta.url))) {
  const state: UpdateState = { status: 'idle', message: '' }
  let pending: Promise<void> | undefined
  let stopped = false
  const git = (args: string[]) => runner.git(['-c', 'credential.interactive=false', ...args], { cwd: directory, graceMs: 120000 })
  const clean = async () => !(await git(['status', '--porcelain', '--untracked-files=all'])).trim()
  async function update() {
    if (stopped || state.status === 'updated') return
    state.status = 'checking'
    try {
      const root = (await git(['rev-parse', '--show-toplevel'])).trim()
      if (await realpath(root) !== await realpath(directory)) throw new Error('安装目录不是独立 Git 仓库，无法自动更新')
      if (!await clean()) throw new Error('安装目录有本地修改，已跳过自动更新')
      const upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim()
      const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
      const remote = (await git(['config', '--get', `branch.${branch}.remote`])).trim()
      if (!remote || remote === '.') throw new Error('当前分支没有远端上游')
      await git(['fetch', '--', remote])
      const before = (await git(['rev-parse', 'HEAD'])).trim()
      const after = (await git(['rev-parse', upstream])).trim()
      if (before === after) { state.status = 'current'; state.message = ''; return }
      // Behind-only updates are allowed. Local commits and divergence require human handling.
      const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).trim().split(/\s+/).map(Number)
      if (counts[0] !== 0) throw new Error('当前分支含本地提交或已分叉，已跳过自动更新')
      const npm = await resolveCliExe(undefined, 'npm')
      const node = await resolveCliExe(undefined, 'node')
      if (!npm || !node) throw new Error('未检测到 node/npm，无法构建更新')
      const paths = ['index.js', 'lib/client.js']
      const backups = await Promise.all(paths.map(path => readFile(join(directory, path))))
      if (stopped || !await clean() || (await git(['rev-parse', 'HEAD'])).trim() !== before) return
      await git(['merge', '--ff-only', '--', after])
      try {
        const build = await runner.tryRun(node, [npm, 'run', 'build'], { cwd: directory, graceMs: 120000 })
        if (build.code !== 0) throw new Error(build.errText || build.out || '构建失败')
      } catch (error) {
        // reset --merge preserves unrelated edits made while the build ran.
        if ((await git(['rev-parse', 'HEAD'])).trim() !== after) throw new Error('构建失败且分支已变化，请手动恢复')
        await git(['restore', '--source=HEAD', '--', ...paths])
        await git(['update-index', '--refresh'])
        await git(['reset', '--merge', before])
        await Promise.all(paths.map((path, i) => writeFile(join(directory, path), backups[i])))
        throw error
      }
      state.status = 'updated'; state.message = '工作台已更新，重启 DSH 后生效'
    } catch (error) {
      state.status = 'blocked'; state.message = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    state,
    check() { return pending ??= update().finally(() => { pending = undefined }) },
    start(intervalMs: number) {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
      let timer: ReturnType<typeof setTimeout>
      const schedule = (delay: number) => { timer = setTimeout(async () => { await this.check(); if (!stopped && state.status !== 'updated') schedule(Math.min(2147483647, Math.max(60000, intervalMs))) }, delay); timer.unref?.() }
      void this.check().then(() => { if (!stopped && state.status !== 'updated') schedule(Math.min(2147483647, Math.max(60000, intervalMs))) })
      return () => { stopped = true; clearTimeout(timer) }
    },
  }
}
