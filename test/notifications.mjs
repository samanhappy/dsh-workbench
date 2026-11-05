import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply, getConfig, notificationHost, notificationListArgv, notificationActionArgv, parseNotifications } from '../index.js'
import { loadClientModule } from './load-client.mjs'

test('通知查询：账号级 API、分页与 host 校验', () => {
  assert.equal(notificationHost(' GHE.example.com '), 'ghe.example.com')
  assert.deepEqual(notificationListArgv({}), ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', 'notifications?all=false&per_page=50&page=1'])
  assert.equal(notificationListArgv({ all: 'true', page: '2' }).at(-1), 'notifications?all=true&per_page=50&page=2')
  for (const host of ['--evil', 'https://github.com', 'host/path', 'host?x=1']) assert.throws(() => notificationHost(host))
  for (const page of ['0', '-1', '1.5', 'NaN', '501']) assert.throws(() => notificationListArgv({ page }))
})

test('通知操作：已读 PATCH、完成 DELETE，拒绝非线程路径和未知操作', () => {
  for (const [action, method] of [['read', 'PATCH'], ['done', 'DELETE']]) {
    const argv = notificationActionArgv({ id: '123', action })
    assert.equal(argv[argv.indexOf('--method') + 1], method)
    assert.equal(argv.at(-1), 'notifications/threads/123')
    assert.ok(argv.includes('X-GitHub-Api-Version: 2026-03-10'))
  }
  assert.throws(() => notificationActionArgv({ id: '../issues/1', action: 'done' }))
  assert.throws(() => notificationActionArgv({ id: '1', action: 'close' }))
})

test('通知链接：PR/Issue/Discussion 转网页，其他类型回通知页，不透传外部链接', () => {
  const items = parseNotifications(JSON.stringify([
    { id: '1', unread: true, repository: { full_name: 'o/r' }, subject: { title: 'PR', type: 'PullRequest', url: 'https://api.github.com/repos/o/r/pulls/3' } },
    { id: '2', repository: { full_name: 'o/r' }, subject: { url: 'https://api.github.com/repos/o/r/issues/4' } },
    { id: '3', repository: { full_name: 'o/r' }, subject: { title: 'D', type: 'Discussion', url: 'https://api.github.com/repos/o/r/discussions/1309', latest_comment_url: null } },
    { id: '4', subject: { url: 'javascript:alert(1)' } },
    { id: '5', repository: { full_name: 'o/r' }, subject: { url: 'https://api.github.com/repos/other/r/issues/4' } },
    { id: '6', repository: { full_name: 'x?/r' }, subject: { url: 'https://api.github.com/repos/x?/r/issues/4' } },
    null, { id: '../bad' },
  ]), 'ghe.example.com')
  assert.equal(items.length, 6)
  assert.equal(items[0].url, 'https://ghe.example.com/o/r/pull/3')
  assert.equal(items[0].unread, true)
  assert.equal(items[1].url, 'https://ghe.example.com/o/r/issues/4')
  assert.equal(items[2].url, 'https://ghe.example.com/o/r/discussions/1309')
  for (const it of items.slice(3)) assert.ok(it.url.startsWith('https://ghe.example.com/notifications?'))
  assert.throws(() => parseNotifications('{}', 'github.com'))
})

test('安全公告通知：空 URL 按唯一标题解析，仓库查询复用，歧义与失败回退', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/host/notifications.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
  const mod = { exports: {} }
  new Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports)
  const rows = ['OAuth tokens', 'duplicate', 'missing', 'invalid'].map((title, i) => ({
    id: String(i + 1), repository: { full_name: 'samanhappy/mcphub' },
    subject: { type: 'RepositoryAdvisory', title, url: null, latest_comment_url: null },
  }))
  rows.push({ id: '5', repository: { full_name: '../bad' }, subject: { type: 'RepositoryAdvisory' } })
  const calls = []
  let fail = false
  const runner = { async forgeRun(forge, argv) {
    calls.push(argv)
    if (argv.at(-1).startsWith('notifications?')) return JSON.stringify(rows)
    if (fail) throw new Error('403')
    return JSON.stringify([[{ summary: 'duplicate', ghsa_id: 'GHSA-j435-jx3g-qm5r' },
      { summary: 'duplicate', ghsa_id: 'GHSA-gm6q-v3rf-w2gq' }, { summary: 'invalid', ghsa_id: '../bad' }],
      [{ summary: 'OAuth tokens', ghsa_id: 'GHSA-j435-jx3g-qm5r' }]])
  } }
  const data = await mod.exports.loadNotifications(runner, { host: 'ghe.example.com' })
  assert.equal(data.items[0].url, 'https://ghe.example.com/samanhappy/mcphub/security/advisories/GHSA-j435-jx3g-qm5r')
  for (const item of data.items.slice(1)) assert.ok(item.url.includes('/notifications?'))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], ['api', '--hostname', 'ghe.example.com', '--paginate', '--slurp', 'repos/samanhappy/mcphub/security-advisories?per_page=100'])
  fail = true
  assert.ok((await mod.exports.loadNotifications(runner, {})).items.every(it => it.url.includes('/notifications?')))
})

test('通知页遵循功能开关、跳转与回退', () => {
  const c = loadClientModule()
  assert.equal(c.isWbPage('notifications'), true)
  assert.equal(c.isPageEnabled('notifications', { notifications: false }), false)
  assert.equal(c.fallbackPage({ notifications: true }), 'notifications')
})

test('通知路由：同源围栏、方法限制、CLI 错误与读写调用', async () => {
  const routes = [], calls = []
  let rejected, fail = false
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: '/tmp' }
      if (name === 'subprocess') return {
        resolveExecutable: async exe => exe,
        spawn(spec) {
          // CLI 解析时的一次性 `--version` 探测不是数据调用，不计入调用断言。
          if (spec.argv.length === 2 && spec.argv[1] === '--version') {
            return { done: Promise.resolve({ exitCode: 0 }), collected: {
              stdout: { readFrom: () => ({ text: '' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            } }
          }
          calls.push(spec.argv)
          return { done: Promise.resolve({ exitCode: fail ? 1 : 0 }), collected: {
            stdout: { readFrom: () => ({ text: spec.argv.at(-1).startsWith('notifications?') ? '[]' : '' }) },
            stderr: { readFrom: () => ({ text: fail ? 'HTTP 403: missing notifications scope' : '' }) },
          } }
        },
      }
    },
    connection: { fetch: { register() {} }, requestRejection: () => rejected },
    effect: fn => fn(),
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { ...getConfig(), selfUpdateIntervalMs: 0 })
  async function request(path, method, body) {
    let payload, status
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.url = path; req.method = method
    const res = { setHeader() {}, set statusCode(v) { status = v }, end(text) { payload = text ? JSON.parse(text) : undefined } }
    await routes.find(r => r.path === path.split('?')[0]).handler(req, res)
    return { status, payload }
  }
  rejected = 403
  assert.equal((await request('/notifications/list', 'GET')).status, 403)
  assert.equal(calls.length, 0)
  rejected = undefined
  assert.equal((await request('/notifications/action', 'GET')).status, 405)
  assert.equal(calls.length, 0)
  assert.deepEqual((await request('/notifications/list', 'GET')).payload, { ok: true, items: [], hasMore: false })
  assert.equal(calls.at(-1)[0], 'gh')
  assert.equal((await request('/notifications/action', 'POST', { id: '1', action: 'read' })).payload.ok, true)
  assert.equal(calls.at(-1).at(-1), 'notifications/threads/1')
  const count = calls.length
  assert.equal((await request('/notifications/action', 'POST', { id: '../x', action: 'done' })).payload.ok, false)
  assert.equal(calls.length, count)
  fail = true
  assert.match((await request('/notifications/list', 'GET')).payload.error, /notifications scope/)
})

test('通知列表缓存：TTL 内同参数命中、force 绕过、写操作失效、参数区分 key', async () => {
  const routes = []
  const calls = []
  let seq = 0
  const ctx = {
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: '/tmp' }
      if (name === 'subprocess') return {
        resolveExecutable: async exe => exe,
        spawn(spec) {
          // CLI 解析时的一次性 `--version` 探测不是数据调用，不计入缓存断言。
          if (spec.argv.length === 2 && spec.argv[1] === '--version') {
            return { done: Promise.resolve({ exitCode: 0 }), collected: {
              stdout: { readFrom: () => ({ text: '' }) },
              stderr: { readFrom: () => ({ text: '' }) },
            } }
          }
          calls.push(spec.argv)
          const n = String(++seq)
          return { done: Promise.resolve({ exitCode: 0 }), collected: {
            stdout: { readFrom: () => ({ text: JSON.stringify([{ id: n, repository: { full_name: 'o/r' }, subject: { title: '通知' + n, type: 'Issue', url: 'https://api.github.com/repos/o/r/issues/1' }, reason: 'subscribed', unread: true, updated_at: '2026-10-12T00:00:00Z' }]) }) },
            stderr: { readFrom: () => ({ text: '' }) },
          } }
        },
      }
    },
    connection: { fetch: { register() {} }, requestRejection: () => undefined },
    effect: fn => fn(),
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  apply(ctx, { ...getConfig(), selfUpdateIntervalMs: 0 })
  async function request(path, method, body) {
    let payload
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.url = path; req.method = method || 'GET'
    const res = { setHeader() {}, end(text) { payload = text ? JSON.parse(text) : undefined } }
    await routes.find(r => r.path === path.split('?')[0]).handler(req, res)
    return payload
  }
  const url = '/notifications/list?host=github.com&all=false&page=1'
  const first = await request(url)
  assert.equal(first.ok, true)
  assert.equal(first.items[0].id, '1')
  assert.equal(calls.length, 1)
  const second = await request(url)
  assert.equal(second.items[0].id, '1', 'TTL 内同参数命中缓存，不重复调用 gh')
  assert.equal(calls.length, 1)
  const forced = await request(url + '&force=1')
  assert.equal(forced.items[0].id, '2', 'force=1 绕过缓存重新拉取')
  assert.equal(calls.length, 2)
  const other = await request('/notifications/list?host=github.com&all=true&page=1')
  assert.equal(other.items[0].id, '3', 'all 不同 = 不同 key，重新拉取')
  assert.equal(calls.length, 3)
  assert.equal((await request('/notifications/action', 'POST', { id: '1', action: 'read' })).ok, true)
  const after = await request(url)
  assert.equal(after.items[0].id, '5', '写操作成功后缓存整组失效，重新拉取')
  assert.equal(calls.length, 5)
})

test('通知交互：仅进入时查询、过期响应丢弃、失败保留列表、成功刷新', async () => {
  const { build } = await import('esbuild')
  const slots = [], effects = [], pending = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useEffect(fn, deps) {
      const i = cursor++, old = effects[i]
      if (old && deps.every((v, j) => v === old.deps[j])) return
      old?.cleanup?.()
      effects[i] = { deps, cleanup: fn() }
    },
  }
  const result = await build({ entryPoints: ['src/client/components/notifications.tsx'], bundle: true,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'runtime', setup(b) {
      b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const useShellTick=()=>0; export const refreshNotificationUnread=async()=>{}; export const applyNotificationUnread=d=>{ (globalThis.__notificationUnreadApplied=globalThis.__notificationUnreadApplied||[]).push(d); }; export const forgeFetch=(...args)=>globalThis.__notificationFetch(...args);', loader: 'js' }))
    } }],
  })
  globalThis.__notificationFetch = (path, opts) => new Promise(resolve => pending.push({ path, opts, resolve }))
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports)
  const render = (active = true) => { cursor = 0; return mod.exports.NotificationsPanel({ active }) }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
  const text = n => typeof n === 'string' ? n : n?.children?.map(text).join('') || ''
  const button = (tree, label) => nodes(tree).find(n => n.type === 'button' && text(n) === label)
  const flush = () => new Promise(resolve => setImmediate(resolve))
  try {
    render(false)
    assert.equal(pending.length, 0)
    let tree = render()
    assert.match(pending[0].path, /all=true/)
    assert.equal(nodes(tree).some(n => n.type === 'input'), false)
    assert.equal(nodes(tree).find(n => n.type === 'select').props.value, 'all')
    nodes(tree).find(n => n.type === 'select').props.onChange({ target: { value: 'unread' } })
    render()
    pending[1].resolve({ ok: true, items: [{ id: '2', title: 'new', url: 'https://github.com/o/r/issues/2', unread: true }], hasMore: false })
    await flush()
    // 未读筛选第一页 = 未读数口径：同一份响应喂共享计数
    assert.equal(globalThis.__notificationUnreadApplied.length, 1)
    assert.equal(globalThis.__notificationUnreadApplied[0].items[0].id, '2')
    pending[0].resolve({ ok: true, items: [{ id: '1', title: 'stale' }], hasMore: true })
    await flush()
    tree = render()
    assert.ok(text(tree).includes('new'))
    assert.ok(!text(tree).includes('stale'))
    // 过期的「全部」响应既不进列表也不喂计数（含已读，长度不是未读数）
    assert.equal(globalThis.__notificationUnreadApplied.length, 1)
    assert.equal(nodes(tree).find(n => n.type === 'a').props.rel, 'noopener noreferrer')
    button(tree, '标为完成').props.onClick()
    assert.deepEqual(pending[2].opts.body, { host: 'github.com', id: '2', action: 'done' })
    tree = render()
    assert.equal(button(tree, '标为已读').props.disabled, true)
    pending[2].resolve({ ok: false, error: 'denied' })
    await flush()
    tree = render()
    assert.ok(text(tree).includes('denied'))
    assert.ok(text(tree).includes('new'))
    const titleLink = nodes(tree).find(n => n.type === 'a' && text(n) === 'new')
    assert.equal(titleLink.props.href, 'https://github.com/o/r/issues/2')
    assert.equal(titleLink.props.target, '_blank')
    titleLink.props.onClick()
    assert.equal(pending[3].opts.body.action, 'read')
    pending[3].resolve({ ok: true })
    await flush()
    render()
    assert.equal(pending.length, 5, '成功后重查列表')
    pending[4].resolve({ ok: true, items: [], hasMore: false })
    await flush()
    assert.ok(!text(render()).includes('new'))
  } finally {
    for (const effect of effects) effect?.cleanup?.()
    delete globalThis.__notificationFetch
    delete globalThis.__notificationUnreadApplied
  }
})

test('通知外链定位最新评论，区分普通评论与行内评审，忽略其他仓库的评论', () => {
  const row = { id: '1', repository: { full_name: 'samanhappy/mcphub' }, subject: {
    type: 'PullRequest', url: 'https://api.github.com/repos/samanhappy/mcphub/pulls/1296',
    latest_comment_url: 'https://api.github.com/repos/samanhappy/mcphub/issues/comments/6078706633',
  } }
  const url = () => parseNotifications(JSON.stringify([row]), 'github.com')[0].url
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/pull/1296#issuecomment-6078706633')
  row.subject.latest_comment_url = 'https://api.github.com/repos/samanhappy/mcphub/pulls/comments/123'
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/pull/1296#discussion_r123')
  row.subject.latest_comment_url = 'https://api.github.com/repos/other/repo/issues/comments/123'
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/pull/1296')
  row.subject.latest_comment_url = row.subject.url
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/pull/1296')
  row.subject = { type: 'Discussion', url: 'https://api.github.com/repos/samanhappy/mcphub/discussions/1309', latest_comment_url: null }
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/discussions/1309')
  row.subject.latest_comment_url = 'https://api.github.com/repos/samanhappy/mcphub/discussions/comments/5'
  assert.equal(url(), 'https://github.com/samanhappy/mcphub/discussions/1309')
  row.repository = { full_name: 'other/repo' }
  assert.equal(url(), 'https://github.com/notifications?query=thread%3A1')
})

test('后台未读轮询：立即查询、五分钟重复、徽标、关闭功能与卸载清理', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/client/runtime.ts'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'flags', setup(b) {
    b.onLoad({ filter: /src\/client\/features\.ts$/ }, () => ({ contents: 'export const featureFlags=()=>globalThis.__pollFlags;', loader: 'js' }))
  } }] })
  const savedFetch = globalThis.fetch
  const states = []
  const requests = []
  let count = 2, fail = false, tick, cleared = false
  globalThis.__pollFlags = { notifications: true }
  globalThis.fetch = async url => {
    requests.push(String(url))
    if (fail) throw new Error('offline')
    return { ok: true, json: async () => ({ ok: true, items: Array.from({ length: count }, () => ({})), hasMore: count === 50 }) }
  }
  const mod = { exports: {} }
  const react = { useState: value => [value, v => states.push(v)], useLayoutEffect: fn => fn() }
  try {
    Function('module', 'exports', 'require', 'setInterval', 'clearInterval', result.outputFiles[0].text)(mod, mod.exports,
      name => name === 'react' ? react : {}, fn => { tick = fn; return 1 }, () => { cleared = true })
    mod.exports.useNotificationUnread()
    const stop = mod.exports.startWorkbenchPolling()
    const list = mod.exports.fetchUnreadNotifications()
    await mod.exports.refreshNotificationUnread()
    assert.equal((await list).items.length, 2)
    assert.equal(mod.exports.getNotificationItems(), (await list).items, '首页可直接使用后台已取得的列表')
    assert.equal(requests.length, 1, '并发查询合并')
    assert.match(requests[0], /all=false&page=1/)
    assert.equal(states.at(-1), '2')
    count = 0
    tick()
    await mod.exports.refreshNotificationUnread()
    assert.equal(states.at(-1), '0', '成功空列表必须显示零，不能与失败混用 null')
    count = 50
    tick()
    await mod.exports.refreshNotificationUnread()
    assert.equal(states.at(-1), '50+')
    fail = true
    tick()
    await mod.exports.refreshNotificationUnread()
    assert.equal(states.at(-1), null)
    globalThis.__pollFlags.notifications = false
    const before = requests.length
    tick()
    assert.equal(requests.length, before)
    stop()
    assert.equal(cleared, true)
  } finally { globalThis.fetch = savedFetch; delete globalThis.__pollFlags }
})

test('未读数同步：列表响应直接喂共享计数，统计卡/徽标与列表同源一致', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/client/runtime.ts'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'flags', setup(b) {
    b.onLoad({ filter: /src\/client\/features\.ts$/ }, () => ({ contents: 'export const featureFlags=()=>globalThis.__pollFlags;', loader: 'js' }))
  } }] })
  const states = []
  const react = { useState: value => [value, v => states.push(v)], useLayoutEffect: fn => fn() }
  globalThis.__pollFlags = { notifications: true }
  const mod = { exports: {} }
  try {
    Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, name => name === 'react' ? react : {})
    mod.exports.useNotificationUnread()
    // 首页/通知页拉到 3 条未读 → 同一份响应喂计数（列表 2 条而徽标 3 的分叉不再出现）
    mod.exports.applyNotificationUnread({ ok: true, items: [{}, {}, {}], hasMore: false })
    assert.equal(states.at(-1), '3')
    mod.exports.applyNotificationUnread({ ok: true, items: Array.from({ length: 50 }, () => ({})), hasMore: true })
    assert.equal(states.at(-1), '50+', '整页 50 条仍显示 50+')
    // 坏响应不覆盖旧值：ok:false 与非列表形状都忽略
    mod.exports.applyNotificationUnread({ ok: false, items: [], hasMore: false })
    mod.exports.applyNotificationUnread(null)
    assert.equal(states.at(-1), '50+', '坏响应不能清掉或覆盖计数')
    // 功能开关关闭时不喂计数（与后台轮询的开关语义一致）
    globalThis.__pollFlags.notifications = false
    mod.exports.applyNotificationUnread({ ok: true, items: [{}], hasMore: false })
    assert.equal(states.at(-1), '50+')
  } finally { delete globalThis.__pollFlags }
})
