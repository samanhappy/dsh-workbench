// Regression tests for CLI discovery fallback (resolveCliExe).
//
// DSH is a macOS GUI app with the minimal system PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), so Homebrew (/opt/homebrew/bin) and /usr/local/bin installs of
// glab/gh/aliyun are invisible to `subprocess.resolveExecutable`. When the PATH
// lookup fails, the host half must fall back to known install locations before
// reporting "未检测到 … 命令行工具". No real CLI, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCliExe } from '../index.js'

let tempRoot = null
let fakeHome = null

function touchExecutable(rel) {
  const p = join(fakeHome, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

const failingResolve = async () => {
  const err = new Error('subprocess-local: command was not found on PATH')
  err.code = 'SUB_PROCESS_EXECUTABLE_NOT_FOUND'
  throw err
}

// node:test runs sibling tests concurrently; serialize env mutation.
let envChain = Promise.resolve()

function withEnv(env, fn) {
  const run = envChain.then(async () => {
    const prev = {}
    for (const key of ['HOME', 'GLAB_BIN']) {
      prev[key] = process.env[key]
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
    try {
      return await fn()
    } finally {
      for (const key of ['HOME', 'GLAB_BIN']) {
        if (prev[key] === undefined) delete process.env[key]
        else process.env[key] = prev[key]
      }
    }
  })
  envChain = run.catch(() => {})
  return run
}

test.before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cli-discovery-'))
  fakeHome = join(tempRoot, 'home')
  mkdirSync(fakeHome, { recursive: true })
})

test.after(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true })
})

test('uses resolveExecutable result when the PATH lookup succeeds', () => {
  return withEnv({ HOME: fakeHome }, async () => {
    const exe = await resolveCliExe(async () => '/usr/bin/glab', 'glab')
    assert.equal(exe, '/usr/bin/glab', 'a successful PATH lookup must short-circuit the probe')
  })
})

test('skips a PATH hit that cannot run and uses a known install', () => {
  const fallback = touchExecutable(join('.local', 'bin', 'glab'))
  return withEnv({ HOME: fakeHome }, async () => {
    const exe = await resolveCliExe(
      async () => '/shim/glab',
      'glab',
      async (candidate) => candidate === fallback,
    )
    assert.equal(exe, fallback, 'a rejected PATH hit must fall back to an accepted install location')
  })
})

test('keeps the PATH hit when no candidate is accepted', () => {
  return withEnv({ HOME: fakeHome }, async () => {
    const exe = await resolveCliExe(async () => '/shim/no-such-cli-xyz', 'no-such-cli-xyz', async () => false)
    assert.equal(exe, '/shim/no-such-cli-xyz', 'legacy behavior: an unusable CLI is still reported so the caller errors normally')
  })
})

test('GLAB_BIN explicit override wins when PATH lookup fails', () => {
  const custom = touchExecutable(join('custom', 'glab'))
  return withEnv({ HOME: fakeHome, GLAB_BIN: custom }, async () => {
    const exe = await resolveCliExe(failingResolve, 'glab')
    assert.equal(exe, custom, 'GLAB_BIN must be used when PATH lookup fails')
  })
})

test('falls back to nvm bin when PATH lookup fails', () => {
  touchExecutable(join('.nvm', 'versions', 'node', 'v24.15.0', 'bin', 'aliyun'))
  return withEnv({ HOME: fakeHome }, async () => {
    const exe = await resolveCliExe(failingResolve, 'aliyun')
    assert.ok(
      exe && exe.endsWith(join('.nvm', 'versions', 'node', 'v24.15.0', 'bin', 'aliyun')),
      `should use nvm bin, got ${exe}`,
    )
  })
})

test('returns null when nothing exists anywhere', () => {
  // Use a fictitious CLI name so the machine's real /opt/homebrew/bin or
  // /usr/local/bin cannot accidentally satisfy the probe.
  const emptyHome = join(fakeHome, 'empty-home')
  mkdirSync(emptyHome, { recursive: true })
  return withEnv({ HOME: emptyHome }, async () => {
    const exe = await resolveCliExe(failingResolve, 'no-such-cli-xyz')
    assert.equal(exe, null)
  })
})
