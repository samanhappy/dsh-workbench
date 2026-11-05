// 首页（跨工作区「需要我关注」会话聚合）host 侧契约测试。
//
// 冻结两件事：
//   A. 纯函数：多帧 zstd 会话日志解析（parseSessionLog / sessionLogOf /
//      decompressAll）、projcache 读取（loadProjectionCache）、筛选分组
//      （selectHomeSessions）——会话存储形状以 DSH session.v4 为准，
//      降级路径（无法解析 / 无 python3）不抛错。
//   B. /home/sessions 路由契约：HTTP 200 + { ok:true, sessions, groups,
//      counts }；过滤口径：保留「进行中（flock 被持有）或 待处理（开放步骤/
//      挂起工具调用）或 近 24h 活跃」，排除空白会话（blank）与子会话，
//      最近活跃上限 10 条。
//
// 全部用临时 HOME 构造 fixture（~/.dsh/sessions + storages/session_projcache.json），
// 不读真实 ~/.dsh、不调用 python3（锁探测经 options.lockHeld 注入桩）。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

// ── 环境隔离（必须在 import index.js 之前设置 DSH_HOME）─────────────────────
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'home-host-')))
process.env.DSH_HOME = HOME
const mod = await import('../index.js')

after(() => {
  rmSync(HOME, { recursive: true, force: true })
})

const SESS = join(HOME, 'sessions')
const STOR = join(HOME, 'storages')
mkdirSync(SESS, { recursive: true })
mkdirSync(STOR, { recursive: true })
/** 每个测试独立环境：清空临时 $DSH_HOME/sessions 与 storages，避免跨用例污染。 */
function resetHome() {
  rmSync(SESS, { recursive: true, force: true })
  mkdirSync(SESS, { recursive: true })
  rmSync(STOR, { recursive: true, force: true })
  mkdirSync(STOR, { recursive: true })
  // 会话日志解析缓存按路径缓存，跨用例复用相同路径时必须清空，避免脏数据
  if (typeof mod.clearHomeLogCache === 'function') mod.clearHomeLogCache()
}


/** 与真实持久化一致：头部一帧 + 事件一批一帧（多帧 zstd 拼接）；plain 时整文件
 *  明文 JSONL。mtime 用 utimes 校准到给定时间（scan 用它做快速剪枝与 updatedAt）。 */
function writeSession(ws, sid, { createdAt, events = [], mtime, version = 'v4', compress = true, agentPreset }) {
  const dir = join(SESS, '--ws-' + ws + '--', 'session-' + sid)
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: Number(version[1]), id: 'session-' + sid, createdAt, cwd: '/ws/' + ws }
  if (agentPreset !== undefined) header.agentPreset = agentPreset
  const headerLine = JSON.stringify(header) + '\n'
  const bodyLines = events.map((e) => JSON.stringify(e)).join('\n')
  const body = bodyLines ? bodyLines + '\n' : ''
  let data
  if (compress) {
    data = Buffer.concat([
      zstdCompressSync(Buffer.from(headerLine)),
      body ? zstdCompressSync(Buffer.from(body)) : Buffer.alloc(0),
    ])
  } else {
    data = Buffer.from(headerLine + body)
  }
  writeFileSync(join(dir, `session.${version}.jsonl${compress ? '.zstd' : ''}`), data)
  if (mtime) utimesSync(join(dir, `session.${version}.jsonl${compress ? '.zstd' : ''}`), new Date(mtime), new Date(mtime))
  return dir
}

function writeLock(ws, sid) {
  const dir = join(SESS, '--ws-' + ws + '--', 'session-' + sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.lock'), '')
}

function ev(type, time, data) {
  return { type, time, data: data || {} }
}

/** projcache fixture：写入 sessions 表并返回 sessionId → row 映射。 */
function writeProjCache(rows) {
  const tables = {}
  for (const [sid, r] of Object.entries(rows)) {
    const entry = { identity: {}, rows: {} }
    if (r.createdAt !== undefined) entry.identity.createdAt = r.createdAt
    if (r.cwd !== undefined) entry.identity.cwd = r.cwd
    if (r.title !== undefined) entry.rows.title = { ver: 1, seq: 1, val: r.title }
    if (r.blank !== undefined) entry.rows.sessionListMetadata = { ver: 1, seq: 1, val: { blank: r.blank, lastPromptAt: r.lastPromptAt ?? null } }
    else if (r.lastPromptAt !== undefined) entry.rows.sessionListMetadata = { ver: 1, seq: 1, val: { blank: false, lastPromptAt: r.lastPromptAt } }
    if (r.turns !== undefined || r.openStep !== undefined || r.pendingCalls !== undefined) {
      entry.rows.sessionStats = { ver: 1, seq: 1, val: { turns: r.turns ?? 0, steps: r.steps ?? 0, openStep: r.openStep ?? null, pendingCalls: r.pendingCalls ?? {} } }
    }
    if (r.preset !== undefined) entry.rows.permissions = { ver: 1, seq: 1, val: { preset: r.preset } }
    tables['session-' + sid] = entry
  }
  writeFileSync(join(STOR, 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: tables } }))
}

// 基准时间：所有 fixture 的相对时间都从它算。
const NOW = Date.parse('2026-10-10T10:00:00+08:00')
const H = 3600 * 1000
const D = 24 * H

function scan(opts) {
  return mod.scanHomeSessions(Object.assign({ now: NOW }, opts))
}test('解析：多帧 zstd 会话日志 → 标题 / 消息数 / 轮次 / 最后活动时间', () => {
  const sid = 'a1'
  const dir = writeSession('w', sid, {
    createdAt: NOW - 2 * D,
    events: [
      ev('permission/preset', NOW - 2 * D + 1000, { preset: 'workspace-write' }),
      ev('user/message', NOW - 2 * D + 2000, { source: { kind: 'user' } }),
      ev('session/title', NOW - 2 * D + 3000, { title: '标题甲' }),
      ev('turn/start', NOW - 2 * D + 4000),
      ev('tool/call', NOW - 2 * D + 5000, {}),
      ev('tool/result', NOW - 2 * D + 6000, {}),
      ev('assistant/message', NOW - 2 * D + 7000, {}),
    ],
    mtime: NOW - 1 * D,
  })
  const { header, title, lastEventAt, lastPromptAt, userMsgs, assistantMsgs, turns, toolCalls } = mod.parseSessionLog(join(dir, 'session.v4.jsonl.zstd'))
  assert.equal(header.id, 'session-' + sid)
  assert.equal(header.cwd, '/ws/w')
  assert.equal(title, '标题甲')
  assert.equal(lastEventAt, NOW - 2 * D + 7000)
  assert.equal(lastPromptAt, NOW - 2 * D + 2000)
  assert.equal(userMsgs, 1)
  assert.equal(assistantMsgs, 1)
  assert.equal(turns, 1)
  assert.equal(toolCalls, 1)
})

test('解析：lastPromptAt 只认 source.kind=user 的用户消息（系统注入的 user/message 不算）', () => {
  // 真实日志里同一次用户输入会拆成多条 user/message：kind=user 的原文 +
  // kind=plugin / skill-catalog 的系统注入快照。DSH sessionListMetadata 投影
  // 只认 kind=user，这里必须同口径，否则行尾时间会比侧边栏新。
  const dir = writeSession('w', 'a2', {
    createdAt: NOW - 1 * D,
    events: [
      ev('user/message', NOW - 1 * D + 1000, { source: { kind: 'user' } }),
      ev('user/message', NOW - 1 * H, { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot', sections: [] } }),
      ev('user/message', NOW - 30 * 60 * 1000, { source: { kind: 'skill-catalog', form: 'catalog', entries: [] } }),
      ev('assistant/message', NOW - 5 * 60 * 1000, {}),
    ],
    mtime: NOW - 5 * 60 * 1000,
  })
  const out = mod.parseSessionLog(join(dir, 'session.v4.jsonl.zstd'))
  assert.equal(out.lastPromptAt, NOW - 1 * D + 1000)
  assert.equal(out.lastEventAt, NOW - 5 * 60 * 1000)
  assert.equal(out.userMsgs, 3) // 计数口径不变：所有 user/message
})

test('解析：明文 JSONL 与旧版本文件（v3）同样可读；坏文件不抛错', () => {
  resetHome()
  const dir = writeSession('w', 'b1', { createdAt: NOW - 1 * H, events: [], version: 'v3', compress: false })
  const out = mod.parseSessionLog(join(dir, 'session.v3.jsonl'))
  assert.equal(out.header.id, 'session-b1')
  assert.equal(out.userMsgs, 0)
  // 无日志文件 → sessionLogOf 返回 null
  assert.equal(mod.sessionLogOf(join(SESS, '--ws-x--', 'session-nope')), null)
})

test('解析：明文 JSONL 与旧版本文件（v3）同样可读', () => {
  resetHome()
  const dir = writeSession('w', 'b1b', { createdAt: NOW - 1 * H, events: [], version: 'v3', compress: false })
  const out = mod.parseSessionLog(join(dir, 'session.v3.jsonl'))
  assert.equal(out.header.id, 'session-b1b')
  assert.equal(out.userMsgs, 0)
})

test('sessionLogOf：优先 v4 zstd → v4 明文 → v3', () => {
  resetHome()
  const dir = join(SESS, '--ws-c--', 'session-c1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl'), 'x\n')
  writeFileSync(join(dir, 'session.v4.jsonl'), 'y\n')
  assert.equal(mod.sessionLogOf(dir).endsWith('session.v4.jsonl'), true)
  rmSync(join(dir, 'session.v4.jsonl'))
  assert.equal(mod.sessionLogOf(dir).endsWith('session.v3.jsonl'), true)
})

test('loadProjectionCache：标题 / 元数据 / 统计 / 权限；坏文件返回空表', () => {
  resetHome()
  writeProjCache({ s1: { title: 'T', blank: false, lastPromptAt: NOW - 30 * 60 * 1000, turns: 3, openStep: null, pendingCalls: {}, preset: 'workspace-write', createdAt: NOW - 1 * D, cwd: '/ws/w' } })
  const map = mod.loadProjectionCache(join(STOR, 'session_projcache.json'))
  const row = map.get('session-s1')
  assert.equal(row.title, 'T')
  assert.equal(row.blank, false)
  assert.equal(row.lastPromptAt, NOW - 30 * 60 * 1000)
  assert.equal(row.turns, 3)
  assert.equal(row.openStep, null)
  assert.equal(row.preset, 'workspace-write')
  assert.deepEqual(mod.loadProjectionCache(join(HOME, 'missing.json')).size, 0)
})

test('筛选分组：运行中 / 待处理 / 近24h 保留，空白与子会话与 48h+ 空闲剔除', async () => {
  resetHome()
  // 六个会话：
  //  run1：锁被持有 + 近 24h —— 进行中
  //  wait1：无锁但 proj 有开放步骤（openStep=5）、最后活动 3 天前 —— 待处理（跨龄保留）
  //  rec1：无锁、近 6h 活跃 —— 最近活跃
  //  old1：无锁、最后活动 3 天前、无开放步骤 —— 剔除
  //  blank1：近 1h 但没有任何 user/turn 事件 —— 空白，剔除
  //  child1：近 1h、有 parentSession —— 子会话，剔除
  const mk = (sid, ws, opts) => {
    const events = opts.events || []
    const dir = writeSession(ws, sid, { createdAt: opts.createdAt, events, mtime: opts.mtime })
    if (opts.lock) writeLock(ws, sid)
    return dir
  }
  const userEv = (t) => [ev('user/message', t, { source: { kind: 'user' } }), ev('turn/start', t + 1000)]
  mk('run1', 'w', { createdAt: NOW - 10 * D, events: userEv(NOW - 2 * H), mtime: NOW - 2 * H, lock: true })
  mk('wait1', 'w', { createdAt: NOW - 30 * D, events: userEv(NOW - 3 * D), mtime: NOW - 3 * D })
  mk('rec1', 'w', { createdAt: NOW - 5 * D, events: userEv(NOW - 6 * H), mtime: NOW - 6 * H })
  mk('old1', 'w', { createdAt: NOW - 40 * D, events: userEv(NOW - 3 * D), mtime: NOW - 3 * D })
  mk('blank1', 'w', { createdAt: NOW - 1 * H, events: [], mtime: NOW - 1 * H })
  // 子会话：header 带 parentSession
  const childDir = join(SESS, '--ws-w--', 'session-child1')
  mkdirSync(childDir, { recursive: true })
  const childHeader = JSON.stringify({ type: 'session', version: 4, id: 'session-child1', createdAt: NOW - 1 * H, cwd: '/ws/w', parentSession: 'session-run1' }) + '\n'
  writeFileSync(join(childDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(childHeader)))
  utimesSync(join(childDir, 'session.v4.jsonl.zstd'), new Date(NOW - 1 * H), new Date(NOW - 1 * H))

  writeProjCache({ wait1: { openStep: 5, pendingCalls: {}, turns: 1, lastPromptAt: NOW - 3 * D, createdAt: NOW - 30 * D, cwd: '/ws/w' } })

  // 锁探测桩：只有 run1 被持有。
  const lockHeld = (paths) => new Set(paths.filter((p) => p.includes('session-run1')))
  const payload = await scan({ lockHeld })
  const ids = (rows) => rows.map((r) => r.sessionId.replace('session-', '')).sort()
  assert.deepEqual(ids(payload.groups.running), ['run1'])
  assert.deepEqual(ids(payload.groups.waiting), ['wait1'])
  assert.deepEqual(ids(payload.groups.recent), ['rec1'])
  assert.deepEqual(ids(payload.sessions), ['rec1', 'run1', 'wait1']) // 汇总 = 三组并集
  assert.deepEqual(payload.counts, { running: 1, waiting: 1, recent24h: 2 })
  const run1 = payload.groups.running[0]
  assert.equal(run1.updatedAt, NOW - 2 * H + 1000) // 最后事件（turn/start）时间
  assert.equal(run1.promptedAt, NOW - 2 * H) // 行尾时间 = 最后一条用户消息（侧边栏同源）
  assert.equal(run1.running, true)
  assert.equal(run1.cwd, '/ws/w')
  const wait1 = payload.groups.waiting[0]
  assert.equal(wait1.waiting, true)
  assert.equal(wait1.running, false)
})

test('筛选分组：进行中空白草稿（锁持有但无消息）仍保留；最近活跃封顶', async () => {
  resetHome()
  writeSession('w', 'd1', { createdAt: NOW - 10 * H, events: [], mtime: NOW - 10 * H })
  writeLock('w', 'd1')
  for (let i = 0; i < 12; i++) {
    writeSession('w', 'r' + i, { createdAt: NOW - 1 * H, events: [ev('user/message', NOW - (i + 1) * 1000, { source: { kind: 'user' } })], mtime: NOW - (i + 1) * 1000 })
  }
  const payload = await scan({ lockHeld: (paths) => new Set(paths.filter((p) => p.includes('session-d1'))) })
  assert.deepEqual(payload.groups.running.map((r) => r.sessionId), ['session-d1'])
  assert.equal(payload.groups.recent.length, 10) // 封顶
  assert.equal(payload.sessions.length, 11)
  // 最近活跃按 updatedAt 倒序
  const times = payload.groups.recent.map((r) => r.updatedAt)
  assert.deepEqual(times, [...times].sort((a, b) => b - a))
})

test('后台标记：agent preset 为 router 的会话标 background（header 或 agent-preset/selected 事件），worker/普通会话不标', async () => {
  resetHome()
  const userAt = NOW - 1 * H
  writeSession('w', 'bg1', { createdAt: NOW - 2 * H, agentPreset: 'dsh-superagent-router', events: [ev('user/message', userAt, { source: { kind: 'user' } })], mtime: userAt })
  writeSession('w', 'wk1', { createdAt: NOW - 2 * H, agentPreset: 'dsh-superagent-worker', events: [ev('user/message', userAt, { source: { kind: 'user' } })], mtime: userAt })
  writeSession('w', 'nm1', { createdAt: NOW - 2 * H, events: [ev('user/message', userAt, { source: { kind: 'user' } })], mtime: userAt })
  // 创建时是 standard、空白期切换到 router：以 agent-preset/selected 事件为准
  writeSession('w', 'bg2', {
    createdAt: NOW - 2 * H,
    events: [ev('agent-preset/selected', NOW - 2 * H + 1000, { agentPreset: 'dsh-superagent-router' }), ev('user/message', userAt, { source: { kind: 'user' } })],
    mtime: userAt,
  })

  const payload = await scan({ lockHeld: () => new Set() })
  const byId = Object.fromEntries(payload.sessions.map((r) => [r.sessionId, r]))
  assert.equal(byId['session-bg1'].background, true, 'header.agentPreset=router → 后台')
  assert.equal(byId['session-bg2'].background, true, 'agent-preset/selected=router → 后台')
  assert.equal(byId['session-wk1'].background, false, 'worker preset 不是后台常驻会话')
  assert.equal(byId['session-nm1'].background, false, '没有 agent preset 的普通会话不是后台')
})

test('聚合口径：非 session- 前缀的会话 id（Superagent 的 orchestrator / worker）同样进入首页', async () => {
  resetHome()
  // 会话目录名 = 会话 id，但 id 不一定是 session-<uuid>：侧边栏照样展示、胶囊照样
  // 计数这些会话，首页不能因为前缀把它们静默漏掉（否则出现「侧栏 1、首页 0 行」）。
  const id = 'orchestrator-abc'
  const dir = join(SESS, '--ws-w--', id)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: NOW - 2 * H, cwd: '/ws/w' }) + '\n'
  const log = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(log, zstdCompressSync(Buffer.from(header + JSON.stringify(ev('user/message', NOW - 1 * H, { source: { kind: 'user' } })) + '\n')))
  utimesSync(log, new Date(NOW - 1 * H), new Date(NOW - 1 * H))

  const payload = await scan({ lockHeld: () => new Set() })
  assert.deepEqual(payload.groups.recent.map((r) => r.sessionId), [id])

  // 目录里的非会话条目（没有会话日志）仍被跳过，不会因为放宽前缀而混进来。
  mkdirSync(join(SESS, '--ws-w--', 'not-a-session'), { recursive: true })
  const again = await scan({ lockHeld: () => new Set() })
  assert.deepEqual(again.groups.recent.map((r) => r.sessionId), [id])
})

test('selectHomeSessions：纯函数，运行中优先、窗口过滤、封顶', () => {
  resetHome()
  const row = (id, updatedAt, extra) => Object.assign({ sessionId: id, cwd: '/ws/w', title: null, createdAt: updatedAt, updatedAt, promptedAt: updatedAt, running: false, waiting: false, blank: false, child: false, userMsgs: 1, assistantMsgs: 0, turns: 1, toolCalls: 0, preset: null }, extra || {})
  const rows = [
    row('old', NOW - 3 * D),
    row('rec', NOW - 1 * H),
    row('run', NOW - 4 * D, { running: true }),
    row('wait', NOW - 5 * D, { waiting: true }),
    row('blank', NOW - 1 * H, { blank: true }),
    row('child', NOW - 1 * H, { child: true }),
  ]
  const out = mod.selectHomeSessions(rows, NOW, 24 * H, 10)
  assert.deepEqual(out.groups.running.map((r) => r.sessionId), ['run'])
  assert.deepEqual(out.groups.waiting.map((r) => r.sessionId), ['wait'])
  assert.deepEqual(out.groups.recent.map((r) => r.sessionId), ['rec'])
  assert.equal(out.sessions.length, 3)
})

test('时间口径：右栏按最后活动（updatedAt）排序，汇总/左栏仍按 promptedAt（侧边栏同源）', () => {
  // recA：最后一次提问在 6h 前，但 1h 前有后台/助手活动（updatedAt 更新）；
  // recB：最后一次提问在 2h 前且再无活动。右栏「最近完成」按最后活动排，recA
  // 在前；汇总列表（左栏口径）仍按 promptedAt，recB 在前。
  // 「近 24h 活跃」的保留窗口仍按 updatedAt，两条都保留。
  const row = (id, extra) => Object.assign({ sessionId: id, cwd: '/ws/w', title: id, createdAt: NOW - 10 * D, updatedAt: 0, promptedAt: 0, running: false, waiting: false, blank: false, child: false, userMsgs: 1, assistantMsgs: 1, turns: 1, toolCalls: 0, preset: null, background: false }, extra)
  const rows = [
    row('recA', { promptedAt: NOW - 6 * H, updatedAt: NOW - 1 * H }),
    row('recB', { promptedAt: NOW - 2 * H, updatedAt: NOW - 2 * H }),
  ]
  const out = mod.selectHomeSessions(rows, NOW, 24 * H, 10)
  assert.deepEqual(out.groups.recent.map((r) => r.sessionId), ['recA', 'recB']) // 按 updatedAt 倒序（右栏）
  assert.deepEqual(out.sessions.map((r) => r.sessionId), ['recB', 'recA']) // 汇总按 promptedAt（左栏）
  assert.equal(out.counts.recent24h, 2) // recA 的 1h 前活动仍在 24h 保留窗口内
})

test('/home/sessions 路由：HTTP 200 + { ok, sessions, groups, counts }，force 绕过缓存', async () => {
  resetHome()
  const routes = new Map()
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const off = fn(); return typeof off === 'function' ? off : () => {} },
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    connection: { fetch: { register() {} }, requestRejection: () => undefined },
  }
  mod.apply(ctx)
  mod.setConfig({ ...mod.getConfig(), homeSessionsTtlMs: 0 }) // 无缓存，避免跨用例命中
  const route = routes.get('/home/sessions')
  assert.ok(route, '/home/sessions 必须注册')
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) { if (chunk !== undefined && chunk !== null) this.body += String(chunk); this.writableEnded = true },
  }
  await route.handler({ method: 'GET' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.ok(Array.isArray(body.sessions))
  assert.ok(body.groups && Array.isArray(body.groups.running) && Array.isArray(body.groups.waiting) && Array.isArray(body.groups.recent))
  assert.ok(body.counts && typeof body.counts.recent24h === 'number')
  // 历史超过 24h 仍可按批继续读取，最后一批停止。
  const past = Date.now() - 7 * D
  for (let i = 0; i < 23; i++) writeSession('page', 'p' + i, {
    createdAt: past - i * H,
    events: [ev('user/message', past - i * H, { source: { kind: 'user' } })],
    mtime: past - i * H,
  })
  for (const [limit, count, hasMore] of [[10, 10, true], [20, 20, true], [30, 23, false]]) {
    res.body = ''; res.writableEnded = false
    await route.handler({ method: 'GET', url: '/home/sessions?limit=' + limit }, res)
    const page = JSON.parse(res.body)
    assert.equal(page.groups.recent.length, count)
    assert.equal(page.hasMore, hasMore)
    assert.deepEqual(page.groups.recent.map(r => r.sessionId), Array.from({ length: count }, (_, i) => 'session-p' + i))
  }
  res.body = ''; res.writableEnded = false
  await route.handler({ method: 'GET', url: '/home/sessions?limit=-1' }, res)
  assert.equal(res.statusCode, 400)

})

test('锁探测：空路径直接返回空集；脚本失败（无 python3）不抛错、按无运行中处理', () => {
  resetHome()
  assert.deepEqual([...mod.probeLockHeld([])], [])
  // 传不存在的路径：python3 打开失败按 ERR 行处理，仍返回空集
  assert.deepEqual([...mod.probeLockHeld([join(HOME, 'no-such.lock')])], [])
})

test('扫描剪枝：lock 文件存在但未被持有且 48h 无活动 → 不再深解析（skipped 计入，输出不变）', async () => {
  resetHome()
  // p1：有 lock 文件但未持有、3 天无活动 → 应被剪枝，不得调用解析
  // p2：有 lock 文件且被持有、3 天前活动 → 运行中，保留
  writeSession('w', 'p1', { createdAt: NOW - 30 * D, events: [ev('user/message', NOW - 3 * D, { source: { kind: 'user' } })], mtime: NOW - 3 * D })
  writeLock('w', 'p1')
  writeSession('w', 'p2', { createdAt: NOW - 30 * D, events: [ev('user/message', NOW - 3 * D, { source: { kind: 'user' } })], mtime: NOW - 3 * D })
  writeLock('w', 'p2')
  const parsedPaths = []
  const parseLog = (f) => { parsedPaths.push(f); return mod.parseSessionLog(f) }
  const payload = await scan({ lockHeld: (paths) => new Set(paths.filter((p) => p.includes('session-p2'))), parseLog })
  assert.deepEqual(payload.groups.running.map((r) => r.sessionId), ['session-p2'])
  assert.equal(payload.skipped, 1, '未被持有的 48h+ 空闲会话计入剪枝')
  assert.equal(parsedPaths.some((p) => p.includes('session-p1')), false, '未持有且 48h+ 无活动的会话不得被深解析')
  assert.ok(parsedPaths.some((p) => p.includes('session-p2')), '被持有的会话仍会解析')
})

test('扫描增量解析：未变化的日志命中缓存，仅变更文件重解析', async () => {
  resetHome()
  writeSession('w', 'q1', { createdAt: NOW - 5 * D, events: [ev('user/message', NOW - 2 * H, { source: { kind: 'user' } })], mtime: NOW - 2 * H })
  writeSession('w', 'q2', { createdAt: NOW - 5 * D, events: [ev('user/message', NOW - 1 * H, { source: { kind: 'user' } })], mtime: NOW - 1 * H })
  let parses = 0
  const parseLog = (f) => { parses += 1; return mod.parseSessionLog(f) }
  const first = await scan({ parseLog })
  assert.equal(parses, 2, '首扫解析全部候选')
  const second = await scan({ parseLog })
  assert.equal(parses, 2, '未变化日志命中缓存，不重复解析')
  assert.deepEqual(second.sessions.map((r) => r.sessionId), first.sessions.map((r) => r.sessionId))
  // 变更 q2（追加一条更晚的用户消息 + 推后 mtime）→ 仅 q2 重解析
  writeSession('w', 'q2', {
    createdAt: NOW - 5 * D,
    events: [
      ev('user/message', NOW - 1 * H, { source: { kind: 'user' } }),
      ev('user/message', NOW - 10 * 60 * 1000, { source: { kind: 'user' } }),
    ],
    mtime: NOW - 10 * 60 * 1000,
  })
  const third = await scan({ parseLog })
  assert.equal(parses, 3, '仅变更的会话重解析')
  const q2row = third.groups.recent.find((r) => r.sessionId === 'session-q2')
  assert.equal(q2row.promptedAt, NOW - 10 * 60 * 1000, '重解析读到新数据')
})

test('多帧解压：大量小帧拼接保持完整顺序', () => {
  const chunks = Array.from({ length: 512 }, (_, i) => Buffer.from(`event-${i}\n`))
  const compressed = Buffer.concat(chunks.map(chunk => zstdCompressSync(chunk)))
  assert.deepEqual(mod.decompressAll(compressed), Buffer.concat(chunks))
})
