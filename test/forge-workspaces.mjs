import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, getConfig, setConfig } from '../index.js'

test('仓库发现探测所有 GitLab 实例，强制刷新重新探测登录状态', async () => {
  const routes = []
  const calls = []
  let loggedIn = false
  const ctx = {
    connection: { fetch: { register() {} }, requestRejection: () => undefined },
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [{ path: '/gitlab', title: 'GitLab' }, { path: '/github', title: 'GitHub' }] }
      if (name === 'sandboxPolicy') return { workspaceRoot: '/github' }
      if (name === 'subprocess') return {
        resolveExecutable: async (exe) => exe,
        spawn(spec) {
          const [exe, ...argv] = spec.argv
          calls.push([exe, ...argv])
          let out = '', errText = '', exitCode = 0
          if (argv[0] === 'auth') {
            if (exe === 'glab') {
              // 默认上下文只返回 gitlab.com；--all 才返回私有实例。
              if (loggedIn && argv.includes('--all')) errText = '✓ Logged in to gitlab.internal as alice (config.yml)'
              else exitCode = 1
            } else out = '✓ Logged in to github.com account bob (keyring)'
          } else if (exe === 'git') {
            out = argv[0] === 'remote'
              ? (spec.cwd === '/gitlab' ? 'https://gitlab.internal/team/repo.git' : 'git@github.com:team/repo.git')
              : 'main'
          }
          return {
            done: Promise.resolve({ exitCode }),
            collected: {
              stdout: { readFrom: () => ({ text: out }) },
              stderr: { readFrom: () => ({ text: errText }) },
            },
          }
        },
      }
    },
    effect: (fn) => fn(),
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx)
  const route = routes.find((r) => r.path === '/forge/workspaces')
  async function load(url) {
    let data
    await route.handler({ url }, {
      setHeader() {},
      end(body) { data = JSON.parse(body) },
    })
    return data
  }
  assert.deepEqual((await load('/forge/workspaces')).workspaces.map((w) => w.forge), ['github'])
  loggedIn = true
  assert.deepEqual((await load('/forge/workspaces?force=1')).workspaces.map((w) => w.forge), ['gitlab', 'github'])
  assert.equal(calls.filter((c) => c[0] === 'glab' && c[1] === 'auth').length, 2)
  assert.ok(calls.some((c) => c.join(' ') === 'glab auth status --all'))
})

test('PATH 上无法运行的包装 shim 被跳过，改用可运行的真实 CLI', async () => {
  // 模拟另一个插件把包装 shim 放到 PATH 最前：它解析成功，但注入的 argv 让
  // `--version` 失败（dsh-superagent 的 worker-bin `glab` 即如此）。宿主必须
  // 放弃该 shim，改用可运行的真实安装（这里用 GLAB_BIN 指到临时文件）。
  const dir = mkdtempSync(join(tmpdir(), 'forge-shim-'))
  const fallback = join(dir, 'glab')
  writeFileSync(fallback, '#!/bin/sh\nexit 0\n')
  chmodSync(fallback, 0o755)
  const previousBin = process.env.GLAB_BIN
  process.env.GLAB_BIN = fallback
  try {
    const routes = []
    const calls = []
    const ctx = {
      connection: { fetch: { register() {} }, requestRejection: () => undefined },
      get(name) {
        if (name === 'workspaceRegistry') return { list: () => [{ path: '/gitlab', title: 'GitLab' }] }
        if (name === 'sandboxPolicy') return { workspaceRoot: '/gitlab' }
        if (name === 'subprocess') return {
          resolveExecutable: async (exe) => exe === 'glab' ? '/shim/bin/glab' : exe,
          spawn(spec) {
            const [exe, ...argv] = spec.argv
            calls.push([exe, ...argv])
            let out = '', errText = '', exitCode = 0
            if (exe === '/shim/bin/glab' && argv[0] === '--version') exitCode = 1
            else if (argv[0] === 'auth') {
              if (exe.includes('glab')) errText = '✓ Logged in to gitlab.internal as alice (config.yml)'
              else out = '✓ Logged in to github.com account bob (keyring)'
            } else if (exe === 'git') {
              out = argv[0] === 'remote' ? 'https://gitlab.internal/team/repo.git' : 'main'
            }
            return {
              done: Promise.resolve({ exitCode }),
              collected: {
                stdout: { readFrom: () => ({ text: out }) },
                stderr: { readFrom: () => ({ text: errText }) },
              },
            }
          },
        }
      },
      effect: (fn) => fn(),
      webServer: { register(route) { routes.push(route); return () => {} } },
    }
    apply(ctx)
    // auth/availability 缓存是模块级的：前一个用例已缓存登录探测，这里置 0 强制真探测。
    setConfig({ ...getConfig(), authTtlMs: 0 })
    const route = routes.find((r) => r.path === '/forge/workspaces')
    let data
    await route.handler({ url: '/forge/workspaces' }, {
      setHeader() {},
      end(body) { data = JSON.parse(body) },
    })
    assert.deepEqual(data.workspaces.map((w) => w.forge), ['gitlab'])
    assert.equal(data.workspaces[0].repoPath, 'team/repo')
    assert.ok(calls.some((c) => c[0] === '/shim/bin/glab' && c[1] === '--version'), 'shim must be probed')
    assert.ok(calls.some((c) => c[0] === fallback && c[1] === 'auth' && c.includes('--all')), 'auth probe must use the working CLI')
    assert.ok(!calls.some((c) => c[0] === '/shim/bin/glab' && c[1] === 'auth'), 'the broken shim must never drive detection')
  } finally {
    if (previousBin === undefined) delete process.env.GLAB_BIN
    else process.env.GLAB_BIN = previousBin
    rmSync(dir, { recursive: true, force: true })
  }
})
