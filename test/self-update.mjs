import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSelfUpdater } from '../index.js'
const exec = promisify(execFile)

async function fixture(t, buildFails = false) {
  const root = await mkdtemp(join(tmpdir(), 'wb-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const origin = join(root, 'origin'), local = join(root, 'local')
  const git = async (cwd, args) => (await exec('git', args, { cwd })).stdout
  await mkdir(origin)
  await git(origin, ['init', '-b', 'main'])
  await git(origin, ['config', 'user.email', 'test@example.com'])
  await git(origin, ['config', 'user.name', 'Test'])
  await mkdir(join(origin, 'lib'))
  await writeFile(join(origin, 'index.js'), 'old host')
  await writeFile(join(origin, 'lib/client.js'), 'old client')
  await git(origin, ['add', '.']); await git(origin, ['commit', '-m', 'initial'])
  await git(root, ['clone', origin, local])
  const before = (await git(local, ['rev-parse', 'HEAD'])).trim()
  await writeFile(join(origin, 'index.js'), 'new host')
  await git(origin, ['commit', '-am', 'update'])
  let builds = 0
  const updater = createSelfUpdater({
    git: args => git(local, args),
    async tryRun() {
      builds++
      await writeFile(join(local, 'index.js'), 'built host')
      await writeFile(join(local, 'lib/client.js'), 'built client')
      return { code: buildFails ? 1 : 0, out: '', errText: buildFails ? 'build failed' : '' }
    },
  }, local)
  return { local, before, git, updater, builds: () => builds }
}

test('fast-forward builds once, requests restart, and coalesces concurrent checks', async t => {
  const f = await fixture(t)
  await Promise.all([f.updater.check(), f.updater.check()])
  assert.equal(f.updater.state.status, 'updated')
  assert.match(f.updater.state.message, /重启/)
  assert.notEqual((await f.git(f.local, ['rev-parse', 'HEAD'])).trim(), f.before)
  await f.updater.check()
  assert.equal(f.builds(), 1)
})

test('local edits prevent updates', async t => {
  const f = await fixture(t)
  await writeFile(join(f.local, 'notes'), 'do not delete')
  await f.updater.check()
  assert.equal(f.updater.state.status, 'blocked')
  assert.equal(f.builds(), 0)
  assert.equal((await f.git(f.local, ['rev-parse', 'HEAD'])).trim(), f.before)
})

test('build failure restores commit and both artifacts', async t => {
  const f = await fixture(t, true)
  await f.updater.check()
  assert.equal(f.updater.state.status, 'blocked')
  assert.equal((await f.git(f.local, ['rev-parse', 'HEAD'])).trim(), f.before, f.updater.state.message)
  assert.equal(await readFile(join(f.local, 'index.js'), 'utf8'), 'old host')
  assert.equal(await readFile(join(f.local, 'lib/client.js'), 'utf8'), 'old client')
  assert.equal((await f.git(f.local, ['status', '--porcelain'])).trim(), '')
})

test('local commits are never replaced', async t => {
  const f = await fixture(t)
  await f.git(f.local, ['config', 'user.email', 'test@example.com'])
  await f.git(f.local, ['config', 'user.name', 'Test'])
  await writeFile(join(f.local, 'mine'), 'mine')
  await f.git(f.local, ['add', '.']); await f.git(f.local, ['commit', '-m', 'local'])
  const head = (await f.git(f.local, ['rev-parse', 'HEAD'])).trim()
  await f.updater.check()
  assert.equal(f.updater.state.status, 'blocked')
  assert.equal(f.builds(), 0)
  assert.equal((await f.git(f.local, ['rev-parse', 'HEAD'])).trim(), head)
})

test('manual retry after clearing local edits updates successfully', async t => {
  const f = await fixture(t)
  await writeFile(join(f.local, 'notes'), 'keep until removed')
  await f.updater.check()
  assert.equal(f.updater.state.status, 'blocked')
  await rm(join(f.local, 'notes'))
  await f.updater.check()
  assert.equal(f.updater.state.status, 'updated')
  assert.equal(f.builds(), 1)
})

test('start checks immediately, repeats after five minutes, and stops cleanly', async t => {
  const timers = []
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => {
    const timer = { fn, delay, unref() {} }
    timers.push(timer)
    return timer
  })
  t.mock.method(globalThis, 'clearTimeout', () => {})
  const updater = createSelfUpdater({})
  let checks = 0
  t.mock.method(updater, 'check', async () => { checks++ })
  const stop = updater.start(300000)
  assert.equal(checks, 1)
  await Promise.resolve()
  assert.equal(timers[0].delay, 300000)
  await timers[0].fn()
  assert.equal(checks, 2)
  assert.equal(timers[1].delay, 300000)
  stop()
  assert.equal(globalThis.clearTimeout.mock.calls[0].arguments[0], timers[1])
})

test('disabled automatic updates do not check at startup', t => {
  const updater = createSelfUpdater({})
  const check = t.mock.method(updater, 'check', async () => {})
  updater.start(0)()
  assert.equal(check.mock.callCount(), 0)
})
