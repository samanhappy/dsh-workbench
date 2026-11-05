// PingCode 集成（/pingcode/*）的 argv 白名单构造 + .env 解析 + 归一化 +
// 错误归类 + 加载器测试。
//
// 全部用 mock runner 驱动 index.js 里 re-export 的纯函数与 load* 的真实代码
// 路径，不依赖本机 python3 / 技能目录。验证点：
//   - buildApiCallArgv：python3 + 技能脚本、--raw、--fetch-all、params 排序
//   - parseEnvLines / pingcodeEnvState：.env 解析与凭证存在性（不泄值）
//   - 归一化：项目/工作项/成员/评论（epoch 秒 → 毫秒、isReply）
//   - classifyPingcodeError：技能缺失 / python3 缺失 / 令牌过期 / HTTP 码 /
//     HTML 回包 / 网络
//   - loadPingcodeWorkItems：page_index 从 0 开始、scope=created 先查 /v1/myself
//   - loadPingcodeStatus：探测成功与失败两条路径
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendFileToken, buildApiCallArgv, classifyPingcodeError, clearFileTokenCache, clearMyselfCache, clearStatesCache, loadPingcodeMembers, loadPingcodeProjects,
  loadPingcodeStatus, loadPingcodeWorkItem, loadPingcodeWorkItems, parseEnvLines,
  parseListPayload, pingcodeEnvState, resolveSkillDir, sanitizeRichText, setConfig, toMemberView,
  toNoteView, toProjectView, toWorkItemView, PC_WORK_ITEM_TYPES,
} from '../index.js'

// ── fixture: 临时技能目录（scripts/api_call.py + .env）─────────────────────
const ROOT = mkdtempSync(join(tmpdir(), 'pcskill-'))
const SCRIPTS = join(ROOT, 'scripts')
mkdirSync(SCRIPTS, { recursive: true })
writeFileSync(join(SCRIPTS, 'api_call.py'), '')
writeFileSync(join(ROOT, '.env'), [
  'PINGCODE_AUTH_MODE=authorization_code',
  'PINGCODE_USER_CLIENT_ID=user-id',
  'PINGCODE_USER_CLIENT_SECRET=user-secret',
  'PINGCODE_ACCESS_TOKEN=ae74xxxx',
  '# PINGCODE_CLIENT_ID=commented-out',
].join('\n'))
process.on('exit', () => {
  try { require('node:fs').rmSync(ROOT, { recursive: true, force: true }) } catch (e) {}
})
setConfig({ pingcodeSkillDir: ROOT } )

// ── buildApiCallArgv ────────────────────────────────────────────────────────
test('buildApiCallArgv: 技能脚本 + --raw + --fetch-all + params 排序（exe 由 Runner 提供）', () => {
  const argv = buildApiCallArgv(ROOT, {
    method: 'GET',
    path: '/v1/pjm/work_items',
    params: { keywords: '登录', page_size: '50', page_index: '0' },
  })
  // Runner 契约：tryRun(PC_PYTHON, argv) 会拼成 [python3, ...argv]，argv 不含解释器
  assert.deepEqual(argv, [
    join(ROOT, 'scripts', 'api_call.py'), 'GET', '/v1/pjm/work_items', '--raw',
    '--params', 'keywords=登录', 'page_index=0', 'page_size=50',
  ])
  const withFetch = buildApiCallArgv(ROOT, { method: 'GET', path: '/v1/pjm/projects', fetchAll: true })
  assert.ok(withFetch.includes('--fetch-all'))
})

test('buildApiCallArgv: 非法方法 / 非法路径被拒绝', () => {
  assert.throws(() => buildApiCallArgv(ROOT, { method: 'TRACE', path: '/v1/pjm/projects' }), /非法的方法/)
  assert.throws(() => buildApiCallArgv(ROOT, { method: 'GET', path: 'v1/pjm/projects' }), /非法路径/)
  assert.throws(() => buildApiCallArgv(ROOT, { method: 'GET', path: '/v1/pjm/projects\nrm -rf /' }), /非法路径/)
})

// ── .env 解析 ───────────────────────────────────────────────────────────────
test('parseEnvLines: 跳过注释/空行，去引号，= 取首个', () => {
  const env = parseEnvLines('A=1\n# comment\nB="two words"\nC=\'x\'\n\nD=a=b')
  assert.equal(env.A, '1')
  assert.equal(env.B, 'two words')
  assert.equal(env.C, 'x')
  assert.equal(env.D, 'a=b')
  assert.equal(env['# comment'], undefined)
})

test('pingcodeEnvState: 认证模式与凭证存在性（不返回值）', () => {
  const st = pingcodeEnvState(parseEnvLines([
    'PINGCODE_AUTH_MODE=authorization_code',
    'PINGCODE_USER_CLIENT_ID=uid',
    'PINGCODE_USER_CLIENT_SECRET=usec',
    'PINGCODE_ACCESS_TOKEN=tok',
    'PINGCODE_BASE_URL=https://pc.example.com/open',
  ].join('\n')))
  assert.equal(st.authMode, 'authorization_code')
  assert.equal(st.clientCredentials, false)
  assert.equal(st.userCredentials, true)
  assert.equal(st.accessToken, true)
  assert.equal(st.baseUrlConfigured, true)
  assert.equal(st.baseUrl, 'https://pc.example.com/open')
  const def = pingcodeEnvState({})
  assert.equal(def.authMode, 'client_credentials')
  assert.equal(def.baseUrl, 'https://open.pingcode.com')
})

// ── resolveSkillDir ─────────────────────────────────────────────────────────
test('resolveSkillDir: 显式目录须含 scripts/api_call.py，否则视为未找到', () => {
  assert.equal(resolveSkillDir(ROOT), ROOT)
  assert.equal(resolveSkillDir('/nonexistent/pingcode'), null)
})

// ── parseListPayload ────────────────────────────────────────────────────────
test('parseListPayload: {total,values} / 裸数组 / 非对象', () => {
  assert.deepEqual(parseListPayload({ total: 4, values: [1, 2] }), { total: 4, values: [1, 2] })
  assert.deepEqual(parseListPayload([1, 2, 3]), { total: 3, values: [1, 2, 3] })
  assert.deepEqual(parseListPayload(null), { total: 0, values: [] })
})

// ── 归一化 ──────────────────────────────────────────────────────────────────
test('toProjectView: 压缩项目字段', () => {
  const v = toProjectView({
    id: 'proj1', name: '敏捷示例', type: 'scrum',
    state: { name: '进行中' }, assignee: { display_name: '张三' }, description: '描述',
  })
  assert.deepEqual(v, {
    id: 'proj1', name: '敏捷示例', type: 'scrum', state: '进行中', assignee: '张三', description: '描述',
  })
  assert.equal(toProjectView({ name: 'no-id' }), null)
})

test('toWorkItemView: 挂起系统态（type=pending 名为挂起）归 stateType=suspended，普通 pending 不受影响', () => {
  const susp = toWorkItemView({ id: 'wi2', identifier: 'SCR-2', title: '挂起项', state: { name: '挂起', type: 'pending' } })
  assert.equal(susp.stateType, 'suspended')
  assert.equal(susp.stateName, '挂起')
  const pend = toWorkItemView({ id: 'wi3', identifier: 'SCR-3', title: '新任务', state: { name: '新提交', type: 'pending' } })
  assert.equal(pend.stateType, 'pending')
  const eng = toWorkItemView({ id: 'wi4', identifier: 'SCR-4', title: 'en', state: { name: 'Suspended', type: 'pending' } })
  assert.equal(eng.stateType, 'suspended')
})

test('toWorkItemView: 状态/优先级/负责人/项目压缩 + epoch 秒转毫秒', () => {
  const v = toWorkItemView({
    id: 'wi1', identifier: 'SCR-1', title: '修复登录', type: 'bug',
    state: { id: 's1', name: '新建', type: 'pending', color: '#ff7575' },
    priority: { name: '最高' },
    assignee: { id: 'u1', name: 'john', display_name: 'John' },
    project: { id: 'p1', name: 'Scrum项目', identifier: 'SCR' },
    html_url: 'https://pc.example.com/pjm/workitems/abc',
    description: 'desc', start_at: 1583290309, end_at: null, completed_at: 1583290347,
  })
  assert.equal(v.id, 'wi1')
  assert.equal(v.identifier, 'SCR-1')
  assert.equal(v.stateName, '新建')
  assert.equal(v.stateType, 'pending')
  assert.equal(v.stateColor, '#ff7575')
  assert.equal(v.priority, '最高')
  assert.deepEqual(v.assignee, { id: 'u1', name: 'john', displayName: 'John' })
  assert.deepEqual(v.project, { id: 'p1', name: 'Scrum项目', identifier: 'SCR' })
  assert.equal(v.htmlUrl, 'https://pc.example.com/pjm/workitems/abc')
  assert.equal(v.startAt, 1583290309000)
  assert.equal(v.endAt, null)
  assert.equal(v.completedAt, 1583290347000)
  assert.equal(toWorkItemView({ title: 'x' }), null)
})

test('toMemberView / toNoteView: 成员与评论（isReply）', () => {
  assert.deepEqual(toMemberView({ id: 'm1', name: 'john', display_name: 'John', email: 'j@x.com' }), {
    id: 'm1', name: 'john', displayName: 'John', email: 'j@x.com',
  })
  const n = toNoteView({
    id: 'c1', content: '已复现', created_at: 1565255712, is_reply_comment: 1,
    created_by: { id: 'u1', name: 'john', display_name: 'John' },
  })
  assert.equal(n.author, 'John')
  assert.equal(n.content, '已复现')
  assert.equal(n.created_at, 1565255712000)
  assert.equal(n.isReply, true)
  assert.equal(toNoteView({ content: 'no-id' }), null)
})

// ── 错误归类 ────────────────────────────────────────────────────────────────
test('classifyPingcodeError: 技能目录 / python3 / 令牌 / HTTP / HTML / 网络', () => {
  assert.match(classifyPingcodeError(new Error('未找到 PingCode 技能目录（默认 …）')), /未找到 PingCode 技能目录/)
  assert.match(classifyPingcodeError(new Error('spawn python3 ENOENT')), /未检测到 python3/)
  assert.match(classifyPingcodeError(new Error('错误：用户令牌模式（authorization_code）需要配置 PINGCODE_ACCESS_TOKEN。\n请运行以下命令完成授权：')), /auth_user\.py/)
  assert.match(classifyPingcodeError(new Error('⚠️ HTTP 401')), /令牌无效或已过期/)
  assert.match(classifyPingcodeError(new Error('⚠️ HTTP 403')), /无权限/)
  assert.match(classifyPingcodeError(new Error('⚠️ HTTP 404')), /不存在/)
  assert.match(classifyPingcodeError(new Error('⚠️ HTTP 429')), /限流/)
  assert.equal(classifyPingcodeError(new Error('⚠️ HTTP 500')), 'PingCode 接口返回 HTTP 500')
  assert.match(classifyPingcodeError(new Error('<!DOCTYPE html><html>…')), /HTML 页面/)
  assert.match(classifyPingcodeError(new Error('could not resolve host: open.pingcode.com')), /网络错误/)
  assert.equal(classifyPingcodeError(new Error('自定义失败')), '自定义失败')
})

// ── 加载器（mock runner，验证 argv 与解析）──────────────────────────────────
function mockRunner(responses) {
  const calls = []
  return {
    calls,
    async tryRun(exe, argv, opts) {
      calls.push({ exe, argv, opts })
      // python 可用性探测：--version → 成功
      if (argv.length === 1 && argv[0] === '--version') return { code: 0, out: 'Python 3.12', errText: '' }
      const path = argv.find((a) => a.startsWith('/v1/'))
      const hit = responses[path] || responses['*']
      if (hit === null || hit === undefined) return { code: 1, out: '⚠️ HTTP 404', errText: '' }
      if (typeof hit === 'function') return hit(calls)
      return { code: 0, out: JSON.stringify(hit), errText: '' }
    },
  }
}

/** search 接口的 mock：按 --body 内容路由（state.id 集合 + page_size 区分
 *  行查询与 4 个统计查询）。 */
function searchResponder(routes) {
  return (calls) => {
    const argv = calls[calls.length - 1].argv
    const i = argv.indexOf('--body')
    const body = i >= 0 ? argv[i + 1] : ''
    for (const r of routes) {
      if (body.includes(r.marker)) return { code: 0, out: JSON.stringify(r.response), errText: '' }
    }
    return { code: 0, out: JSON.stringify({ code: '100044', message: 'mock 未匹配 ' + body.slice(0, 80) }), errText: '' }
  }
}

/** 状态表 fixture：pending/progress/completed/closed 系统态各若干 + 1 个
 *  pending 自定义态（应被排除）。 */
const STATE_FIXTURE = {
  total: 6,
  values: [
    { id: 'st-pend-1', name: '新提交', type: 'pending', is_system: 1 },
    { id: 'st-pend-2', name: '挂起', type: 'pending', is_system: 1 },
    { id: 'st-prog-1', name: '进行中', type: 'in_progress', is_system: 1 },
    { id: 'st-comp-1', name: '已完成', type: 'completed', is_system: 1 },
    { id: 'st-clos-1', name: '关闭', type: 'closed', is_system: 1 },
    { id: 'st-custom-1', name: '自定义待处理', type: 'pending', is_system: 0 },
  ],
}

test('loadPingcodeWorkItems: page_index 0-based、白名单校验、scope=created 先查 myself', async () => {
  clearMyselfCache()
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001' },
    '/v1/pjm/work_items': {
      total: 1,
      values: [{ id: 'wi1', identifier: 'SCR-1', title: 't', type: 'task', state: { name: '新建', type: 'pending' } }],
    },
  })
  const r = await loadPingcodeWorkItems({ get() { return undefined } }, runner, {
    projectId: 'proj1', typeId: 'bug', keywords: '登录', scope: 'created', page: '2', pageSize: '30',
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 1)
  assert.equal(r.page, 2)
  assert.equal(r.workitems.length, 1)
  // 第一次调用是 myself，第二次是工作项列表
  assert.ok(runner.calls[0].argv.includes('/v1/myself'))
  const listCall = runner.calls[1]
  assert.ok(listCall.argv.includes('/v1/pjm/work_items'))
  assert.ok(listCall.argv.includes('--params'))
  assert.ok(listCall.argv.includes('page_index=1'))       // page 2 → 0-based index 1
  assert.ok(listCall.argv.includes('page_size=30'))
  assert.ok(listCall.argv.includes('project_id=proj1'))
  assert.ok(listCall.argv.includes('type_id=bug'))
  assert.ok(listCall.argv.includes('created_by=me-user-0001'))
  assert.ok(listCall.argv.some((a) => a.startsWith('keywords=登录')))
  // 列表接口带 include_public_image_token，响应里每项才有 public_image_token
  assert.ok(listCall.argv.includes('include_public_image_token=description'))
  // 非法类型 / 非法 scope 被拒绝（不发调用）
  await assert.rejects(
    loadPingcodeWorkItems({ get() { return undefined } }, runner, { typeId: 'hack' }), /无效的工作项类型/)
  await assert.rejects(
    loadPingcodeWorkItems({ get() { return undefined } }, runner, { scope: 'evil' }), /无效的 scope/)
  await assert.rejects(
    loadPingcodeWorkItems({ get() { return undefined } }, runner, { projectId: 'bad id!' }), /缺少有效的项目 id/)
})

test('loadPingcodeWorkItems: 校验通过的类型枚举来自导出常量', () => {
  assert.deepEqual(PC_WORK_ITEM_TYPES, ['epic', 'feature', 'story', 'task', 'bug', 'issue'])
})

test('loadPingcodeWorkItems: assigneeId=me 解析当前用户（/v1/myself → assignee_id），响应带 me', async () => {
  clearMyselfCache()
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001', display_name: 'Alice' },
    '/v1/pjm/work_items': {
      total: 1,
      values: [{ id: 'wi2', identifier: 'SCR-2', title: '我的待处理', type: 'bug', state: { name: '新提交', type: 'pending' } }],
    },
  })
  const r = await loadPingcodeWorkItems({ get() { return undefined } }, runner, { assigneeId: 'me' })
  assert.equal(r.ok, true)
  // 第一次调用是 myself，第二次是工作项列表（负责人=当前用户走服务端过滤）
  assert.ok(runner.calls[0].argv.includes('/v1/myself'))
  const listCall = runner.calls[1]
  assert.ok(listCall.argv.includes('assignee_id=me-user-0001'))
  assert.deepEqual(r.me, { id: 'me-user-0001', displayName: 'Alice' })
})

test('loadPingcodeWorkItems: myself 进程内缓存——同一技能目录 10 分钟内不重复查 /v1/myself', async () => {
  clearMyselfCache()
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001', display_name: 'Alice' },
    '/v1/pjm/work_items': { total: 0, values: [] },
  })
  await loadPingcodeWorkItems({ get() { return undefined } }, runner, { assigneeId: 'me' })
  await loadPingcodeWorkItems({ get() { return undefined } }, runner, { assigneeId: 'me' })
  const myselfCalls = runner.calls.filter((c) => c.argv.includes('/v1/myself'))
  assert.equal(myselfCalls.length, 1)
  // 显式 assigneeId 不查 myself（最后一次列表调用，忽略 stats 的状态表请求）
  await loadPingcodeWorkItems({ get() { return undefined } }, runner, { assigneeId: 'user0009' })
  const listCalls = runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_items') && !c.argv.includes('search'))
  assert.ok(listCalls.at(-1).argv.includes('assignee_id=user0009'))
  assert.equal(runner.calls.filter((c) => c.argv.includes('/v1/myself')).length, 1)
  clearMyselfCache()
})

test('buildApiCallArgv: POST body 作为独立 argv 元素（--body + JSON）', () => {
  const argv = buildApiCallArgv(ROOT, {
    method: 'POST',
    path: '/v1/pjm/work_items/search',
    body: '{"mode":"query","payload":{"page_size":1}}',
  })
  assert.deepEqual(argv, [
    join(ROOT, 'scripts', 'api_call.py'), 'POST', '/v1/pjm/work_items/search', '--raw',
    '--body', '{"mode":"query","payload":{"page_size":1}}',
  ])
})

test('loadPingcodeWorkItems: stateType=pending 走 search（state.id in 系统态），page 1 附带 stats', async () => {
  clearMyselfCache()
  clearStatesCache()
  // 挂起（st-pend-2）从待处理桶拆出：pending 只剩普通 pending 系统态
  const pendingIds = JSON.stringify(['st-pend-1'])
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001' },
    '/v1/pjm/work_item_states': STATE_FIXTURE,
    '/v1/pjm/work_items/search': searchResponder([
      // 行查询：page_size=100 + pending 系统态
      { marker: '"page_size":100', response: { total: 93, values: [{ id: 'wi1', identifier: 'SCR-1', title: 't', type: 'task', state: { name: '新提交', type: 'pending' } }] } },
      // 统计查询：page_size=1（按 id 集合区分，统计值可相同——断言只验键与数值形状）
      { marker: '"page_size":1', response: { total: 7, values: [] } },
    ]),
  })
  const r = await loadPingcodeWorkItems({ get() { return undefined } }, runner, {
    assigneeId: 'me', stateType: 'pending', page: '1', pageSize: '100',
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 93)
  assert.equal(r.workitems.length, 1)
  // 调用序列：myself → states → 行 search(page_size:100) → 5 次 stats search(page_size:1)
  const searchCalls = runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_items/search'))
  const rows = searchCalls.find((c) => c.argv.some((a) => a.includes('"page_size":100')))
  assert.ok(rows, '行查询带 page_size=100')
  const body = JSON.parse(rows.argv[rows.argv.indexOf('--body') + 1])
  assert.equal(body.mode, 'query')
  assert.deepEqual(body.payload.filter['assignee.id'], { in: ['me-user-0001'] })
  assert.deepEqual(body.payload.filter['state.id'], { in: JSON.parse(pendingIds) })
  assert.equal(body.payload.page_size, 100)
  assert.equal(body.payload.page_index, 0)
  // search payload 也带 include_public_image_token，结果项才有 public_image_token
  assert.equal(body.payload.include_public_image_token, 'description')
  // 统计：5 个键、数值、基于 page 1（fixture 无 completed/closed 之外的类型全 7）
  assert.deepEqual(r.stats, { pending: 7, suspended: 7, progress: 7, completed: 7, closed: 7 })
  // states 只查一次（进程内缓存）
  assert.equal(runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_item_states')).length, 1)
  clearStatesCache()
})

test('loadPingcodeWorkItems: stateType=suspended 单独成桶（挂起系统态 id，不再混入待处理）', async () => {
  clearMyselfCache()
  clearStatesCache()
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001' },
    '/v1/pjm/work_item_states': STATE_FIXTURE,
    '/v1/pjm/work_items/search': searchResponder([
      // 行查询：page_size=100 + 挂起系统态
      { marker: '"page_size":100', response: { total: 2, values: [{ id: 'wi9', identifier: 'SCR-9', title: '挂起项', type: 'task', state: { name: '挂起', type: 'pending' } }] } },
      { marker: '"page_size":1', response: { total: 7, values: [] } },
    ]),
  })
  const r = await loadPingcodeWorkItems({ get() { return undefined } }, runner, {
    assigneeId: 'me', stateType: 'suspended', page: '1', pageSize: '100',
  })
  assert.equal(r.ok, true)
  assert.equal(r.total, 2)
  assert.equal(r.workitems[0].stateType, 'suspended')
  const searchCalls = runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_items/search'))
  const rows = searchCalls.find((c) => c.argv.some((a) => a.includes('"page_size":100')))
  assert.ok(rows, '行查询带 page_size=100')
  const body = JSON.parse(rows.argv[rows.argv.indexOf('--body') + 1])
  assert.deepEqual(body.payload.filter['state.id'], { in: ['st-pend-2'] })
  assert.deepEqual(r.stats, { pending: 7, suspended: 7, progress: 7, completed: 7, closed: 7 })
  clearStatesCache()
})

test('loadPingcodeWorkItems: 前置查询同时失败时不留未处理拒绝（宿主 fail-loud 会因此退出进程）', async () => {
  clearMyselfCache()
  clearStatesCache()
  // meP 先拒绝 → 函数提前抛出，statesP 再没人 await；它的拒绝若无人处理，
  // 宿主的 unhandledRejection 处理器会打印 dsh: fatal load failure 并 exit(1)。
  const runner = mockRunner({ '/v1/myself': null, '/v1/pjm/work_item_states': null })
  const orphans = []
  const onRejection = (err) => orphans.push(err)
  process.on('unhandledRejection', onRejection)
  try {
    await assert.rejects(
      loadPingcodeWorkItems({ get() { return undefined } }, runner, {
        assigneeId: 'me', stateType: 'pending', page: '1',
      }),
      /HTTP 404/)
    // 两个前置查询都已发起；第二个的拒绝必须已被处理（可以失败，但不能逃逸）
    assert.equal(
      runner.calls.filter((c) => c.argv.includes('/v1/myself') || c.argv.includes('/v1/pjm/work_item_states')).length, 2)
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(orphans.map((e) => String((e && e.message) || e)), [])
    // 反向保护：statesP 的失败该抛还是照抛（no-op handler 只标记已处理，不改错误分类）
    await assert.rejects(
      loadPingcodeWorkItems({ get() { return undefined } }, mockRunner({ '/v1/pjm/work_item_states': null }),
        { stateType: 'pending' }),
      /HTTP 404/)
    assert.deepEqual(orphans.map((e) => String((e && e.message) || e)), [])
  } finally {
    process.off('unhandledRejection', onRejection)
    clearMyselfCache()
    clearStatesCache()
  }
})

test('loadPingcodeWorkItems: stateType 只接受白名单值；search 业务错误（100044）重试后抛可读错误', async () => {
  clearMyselfCache()
  clearStatesCache()
  await assert.rejects(
    loadPingcodeWorkItems({ get() { return undefined } }, mockRunner({}), { stateType: 'evil' }), /无效的状态/)
  // 业务错误：HTTP 200 + code/message → 重试一次后抛错（不静默当空结果）
  let n = 0
  const runner = mockRunner({
    '/v1/pjm/work_item_states': STATE_FIXTURE,
    '/v1/pjm/work_items/search': searchResponder([
      { marker: 'st-pend', response: { code: '100044', message: "property_value'值不合法" } },
    ]),
  })
  await assert.rejects(
    loadPingcodeWorkItems({ get() { return undefined } }, runner, { stateType: 'pending' }),
    /100044/)
  assert.ok(runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_items/search')).length >= 2, '重试过一次')
  clearStatesCache()
})

test('loadPingcodeWorkItems: stateType 与 project/type/keywords/created 组合进 search filter', async () => {
  clearMyselfCache()
  clearStatesCache()
  const runner = mockRunner({
    '/v1/myself': { id: 'me-user-0001' },
    '/v1/pjm/work_item_states': STATE_FIXTURE,
    '/v1/pjm/work_items/search': searchResponder([
      { marker: '"page_size":100', response: { total: 1, values: [] } },
      { marker: '"page_size":1', response: { total: 0, values: [] } },
    ]),
  })
  const r = await loadPingcodeWorkItems({ get() { return undefined } }, runner, {
    assigneeId: 'me', stateType: 'pending', projectId: 'proj1', typeId: 'bug',
    keywords: '登录', scope: 'created', pageSize: '100',
  })
  assert.equal(r.total, 1)
  const rows = runner.calls.filter((c) => c.argv.includes('/v1/pjm/work_items/search'))
    .find((c) => c.argv.some((a) => a.includes('"page_size":100')))
  const body = JSON.parse(rows.argv[rows.argv.indexOf('--body') + 1])
  assert.deepEqual(body.payload.filter['project.id'], { in: ['proj1'] })
  assert.deepEqual(body.payload.filter['type'], { in: ['bug'] })
  assert.deepEqual(body.payload.filter['created_by.id'], { in: ['me-user-0001'] })
  assert.equal(body.payload.keywords, '登录')
  clearStatesCache()
})

/** 列表并行性专用 mock：可按需挂住主查询或首桶统计（pending 桶），
 *  统计桶都回 total 7、主查询回 total 93。 */
function listParallelRunner(opts) {
  let resolveMain
  let resolvePending
  const mainGate = new Promise((r) => { resolveMain = r })
  const pendGate = new Promise((r) => { resolvePending = r })
  const seen = { main: 0, stats: 0 }
  const calls = []
  return {
    calls, seen, resolveMain, resolvePending,
    async tryRun(exe, argv, opts2) {
      calls.push({ exe, argv, opts: opts2 })
      const path = argv.find((a) => a.startsWith('/v1/'))
      if (path === '/v1/pjm/work_item_states') return { code: 0, out: JSON.stringify(STATE_FIXTURE), errText: '' }
      if (path === '/v1/pjm/work_items/search') {
        const i = argv.indexOf('--body')
        const body = i >= 0 ? argv[i + 1] : ''
        if (body.includes('"page_size":50')) {
          seen.main++
          if (opts.deferMain) await mainGate
          return { code: 0, out: JSON.stringify({ total: 93, values: [{ id: 'wi1', identifier: 'SCR-1', title: 't', type: 'task', state: { name: '新提交', type: 'pending' } }] }), errText: '' }
        }
        seen.stats++ // 统计桶（page_size:1）
        if (body.includes('st-pend') && opts.deferPendingStat) await pendGate
        return { code: 0, out: JSON.stringify({ total: 7, values: [] }), errText: '' }
      }
      return { code: 1, out: '⚠️ HTTP 404', errText: '' }
    },
  }
}

test('loadPingcodeWorkItems: 统计与主查询并行（主查询未返回时统计已发起）', async () => {
  clearMyselfCache()
  clearStatesCache()
  const runner = listParallelRunner({ deferMain: true })
  const p = loadPingcodeWorkItems({ get() { return undefined } }, runner, { stateType: 'pending', page: '1', pageSize: '50' })
  let parallel = false
  try {
    await new Promise((r) => setImmediate(r))
    parallel = runner.seen.stats > 0
  } finally {
    runner.resolveMain() // 无论断言成败都放行
  }
  assert.ok(parallel, '主查询未返回时统计应已发起（串行实现 stats 在主查询之后才发）')
  const r = await p
  assert.equal(r.total, 93)
  assert.deepEqual(r.stats, { pending: 7, suspended: 7, progress: 7, completed: 7, closed: 7 })
  clearStatesCache()
})

test('loadPingcodeWorkItems: 四桶统计互相并行（首桶未返回时其余已发起）', async () => {
  clearMyselfCache()
  clearStatesCache()
  const runner = listParallelRunner({ deferPendingStat: true })
  const p = loadPingcodeWorkItems({ get() { return undefined } }, runner, { stateType: 'pending', page: '1', pageSize: '50' })
  let allFired = false
  try {
    await new Promise((r) => setImmediate(r))
    allFired = runner.seen.stats >= 3
  } finally {
    runner.resolvePending() // 无论断言成败都放行
  }
  assert.ok(allFired, '首桶统计未返回时其余统计桶应已发起（串行实现每次只发一桶）')
  const r = await p
  assert.equal(r.total, 93)
  assert.deepEqual(r.stats, { pending: 7, suspended: 7, progress: 7, completed: 7, closed: 7 })
  clearStatesCache()
})

test('loadPingcodeProjects / loadPingcodeMembers: --fetch-all 全量', async () => {
  const runner = mockRunner({
    '/v1/pjm/projects': { total: 2, values: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B', state: { name: 'x' } }] },
    '/v1/directory/users': { total: 1, values: [{ id: 'm1', name: 'john', display_name: 'John' }] },
  })
  const pr = await loadPingcodeProjects({ get() { return undefined } }, runner)
  assert.equal(pr.total, 2)
  assert.equal(pr.projects.length, 2)
  assert.ok(runner.calls[0].argv.includes('--fetch-all'))
  const mb = await loadPingcodeMembers({ get() { return undefined } }, runner)
  assert.equal(mb.members.length, 1)
  assert.ok(runner.calls[1].argv.includes('--fetch-all'))
})

test('loadPingcodeWorkItem: 详情 + 评论合并；评论失败不拖垮详情', async () => {
  const runner = mockRunner({
    '/v1/pjm/work_items/wi0001': { id: 'wi0001', identifier: 'SCR-1', title: 't', state: { name: '新建', type: 'pending' } },
    '/v1/comments': { total: 1, values: [{ id: 'c1', content: 'x', created_by: { display_name: 'A' }, created_at: 1 }] },
  })
  const r = await loadPingcodeWorkItem({ get() { return undefined } }, runner, { id: 'wi0001' })
  assert.equal(r.workitem.identifier, 'SCR-1')
  assert.equal(r.workitem.notes.length, 1)
  // 详情接口带 include_public_image_token，响应才有 public_image_token
  assert.ok(runner.calls[0].argv.includes('include_public_image_token=description'))
  const bad = mockRunner({
    '/v1/pjm/work_items/wi0002': { id: 'wi0002', title: 't2', state: { name: 'x' } },
    '/v1/comments': null, // 404
  })
  const r2 = await loadPingcodeWorkItem({ get() { return undefined } }, bad, { id: 'wi0002' })
  assert.equal(r2.workitem.id, 'wi0002')
  assert.deepEqual(r2.workitem.notes, [])
  await assert.rejects(
    loadPingcodeWorkItem({ get() { return undefined } }, runner, { id: '../etc/passwd' }), /缺少有效/)
})

test('loadPingcodeWorkItem: 详情与评论并行发起（详情未返回时评论已发出）', async () => {
  // 挂住详情响应：若实现是串行的，此时评论尚未发起；并行实现应立即已发起。
  let resolveDetail
  const detailPending = new Promise((r) => { resolveDetail = r })
  const order = []
  const runner = {
    calls: [],
    async tryRun(exe, argv, opts) {
      const path = argv.find((a) => a.startsWith('/v1/'))
      order.push(path)
      if (path === '/v1/pjm/work_items/wi-par') {
        await detailPending
        return { code: 0, out: JSON.stringify({ id: 'wi-par', identifier: 'SCR-P', title: 't', state: { name: '新建', type: 'pending' } }), errText: '' }
      }
      return { code: 0, out: JSON.stringify({ total: 0, values: [] }), errText: '' }
    },
  }
  const p = loadPingcodeWorkItem({ get() { return undefined } }, runner, { id: 'wi-par' })
  let parallel = false
  try {
    await new Promise((r) => setImmediate(r))
    parallel = order.includes('/v1/comments')
  } finally {
    resolveDetail() // 无论断言成败都放行，避免悬空 promise
  }
  assert.ok(parallel, '详情未返回时评论调用应已发起（串行实现此处 order 只有详情）')
  const r = await p
  assert.equal(r.workitem.identifier, 'SCR-P')
  assert.deepEqual(r.workitem.notes, [])
})

test('loadPingcodeStatus: 探测成功（python + 技能 + 凭证 + 真实 API）', async () => {
  const runner = mockRunner({
    '/v1/pjm/projects': { total: 7, values: [] },
  })
  const s = await loadPingcodeStatus({ get() { return undefined } }, runner)
  assert.equal(s.python.available, true)
  assert.equal(s.skill.found, true)
  assert.equal(s.skill.dir, ROOT)
  assert.equal(s.env.authMode, 'authorization_code')
  assert.equal(s.env.userCredentials, true)
  assert.equal(s.env.accessToken, true)
  assert.equal(s.probe.ok, true)
  assert.equal(s.probe.projectTotal, 7)
})

test('loadPingcodeStatus: 探测失败不抛出，原因进 probe.error', async () => {
  const runner = mockRunner({})
  runner.tryRun = async function (exe, argv) {
    if (argv.length === 1 && argv[0] === '--version') return { code: 0, out: 'Python 3.12', errText: '' }
    return { code: 1, out: '⚠️ HTTP 401', errText: '' }
  }
  const s = await loadPingcodeStatus({ get() { return undefined } }, runner)
  assert.equal(s.probe.ok, false)
  assert.match(String(s.probe.error), /令牌无效或已过期/)
})

test('loadPingcodeStatus: 技能目录缺失时给引导，不发 API', async () => {
  setConfig({ pingcodeSkillDir: '/nonexistent/pingcode' })
  try {
    const runner = mockRunner({})
    const s = await loadPingcodeStatus({ get() { return undefined } }, runner)
    assert.equal(s.skill.found, false)
    assert.match(String(s.skill.error), /未找到 PingCode 技能目录/)
    assert.equal(s.probe.ok, false)
  } finally {
    setConfig({ pingcodeSkillDir: ROOT })
  }
})

// ── sanitizeRichText（描述/评论是 HTML 富文本：白名单重序列化后才交给客户端）─

test('sanitizeRichText: PingCode 描述保留 p/img 与 src/alt/width/height；重复属性取首个，style/class 丢弃', () => {
  const desc = '<p>在登录页用用户名密码登录 demo-user，退出账户后改用手机号 13800138000 登录</p>' +
    '<p>问题：上一个账号的密码被带入</p><p>期望：不被带入</p>' +
    '<img src="https://atlas.pingcode.com/files/public/000000000000000000000000/origin-url" ' +
    'src="https://atlas.pingcode.com/files/public/000000000000000000000000" alt="image.png" ' +
    'width="675" height="391.7832167832168" style="text-align: center;" class="rich-img" /><p></p>'
  assert.equal(sanitizeRichText(desc),
    '<p>在登录页用用户名密码登录 demo-user，退出账户后改用手机号 13800138000 登录</p>' +
    '<p>问题：上一个账号的密码被带入</p><p>期望：不被带入</p>' +
    '<img src="https://atlas.pingcode.com/files/public/000000000000000000000000/origin-url" alt="image.png" ' +
    'width="675" height="391.7832167832168" /><p></p>')
})

test('sanitizeRichText: 危险内容不外泄（script/style 连内容丢弃、事件属性丢弃、注释丢弃、未知标签解包）', () => {
  assert.equal(sanitizeRichText('a<script>alert(1)</script>b'), 'ab')
  assert.equal(sanitizeRichText('<style>p{color:red}</style>ok'), 'ok')
  assert.equal(sanitizeRichText('<img src="https://x/y.png" onerror="alert(1)">'), '<img src="https://x/y.png" />')
  assert.equal(sanitizeRichText('<a href="https://ok" onclick="alert(1)">x</a>'), '<a href="https://ok">x</a>')
  assert.equal(sanitizeRichText('<!-- 注释 -->t'), 't')
  assert.equal(sanitizeRichText('<font color="red">x</font>'), 'x')
  assert.equal(sanitizeRichText('<iframe src="https://evil"></iframe>'), '')
  assert.equal(sanitizeRichText('<!DOCTYPE html><p>t</p>'), '<p>t</p>')
})

test('sanitizeRichText: URL scheme 白名单（实体解码 + 去 tab/换行后的浏览器视角）', () => {
  assert.equal(sanitizeRichText('<a href="javascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<a href="JAVASCRIPT:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<a href="java\tscript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<a href=" javascript:alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<a href="javascript&#58;alert(1)">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<a href="data:text/html,<b>x</b>">x</a>'), '<a>x</a>')
  assert.equal(sanitizeRichText('<img src="x" onerror="alert(1)">'), '<img src="x" />')
  // 白名单内：http/https/mailto/相对/锚点/协议相对
  assert.equal(sanitizeRichText('<a href="https://ok.example.com/p?a=1&b=2" title="t">link</a>'),
    '<a href="https://ok.example.com/p?a=1&amp;b=2" title="t">link</a>')
  assert.equal(sanitizeRichText('<a href="/pjm/workitems/abc">r</a>'), '<a href="/pjm/workitems/abc">r</a>')
  assert.equal(sanitizeRichText('<a href="#sec">r</a>'), '<a href="#sec">r</a>')
  assert.equal(sanitizeRichText('<a href="mailto:a@b.com">r</a>'), '<a href="mailto:a@b.com">r</a>')
})

test('sanitizeRichText: 正文转义（实体解码后再转义）与结构补全（自动闭合 / 游离闭标签丢弃 / EOF 补闭合）', () => {
  assert.equal(sanitizeRichText('<p>a &lt; b & c</p>'), '<p>a &lt; b &amp; c</p>')
  assert.equal(sanitizeRichText('<p>3 < 5 & 7 > 4</p>'), '<p>3 &lt; 5 &amp; 7 &gt; 4</p>')
  assert.equal(sanitizeRichText('<p>a<p>b'), '<p>a</p><p>b</p>')
  assert.equal(sanitizeRichText('<ul><li>1<li>2</ul>'), '<ul><li>1</li><li>2</li></ul>')
  assert.equal(sanitizeRichText('x</p>y'), 'xy')
  assert.equal(sanitizeRichText('<strong>粗体'), '<strong>粗体</strong>')
})

test('sanitizeRichText: 文本内换行转 <br/>（描述里的 \\n 要渲染成换行，否则 white-space:normal 下被折叠成一整段）', () => {
  // 用户实测：整段内容都在一个 <p> 里，段落/编号用 \n 分隔
  assert.equal(sanitizeRichText('<p>现存困难。\n\n需求：\n1、上线侧边栏。\n2、统计准确率。</p>'),
    '<p>现存困难。<br/><br/>需求：<br/>1、上线侧边栏。<br/>2、统计准确率。</p>')
  // 标签间的排版换行（</p>\n<p>）不是作者意图：保持原样（浏览器折叠，不产出 <br/>）
  assert.equal(sanitizeRichText('<p>a</p>\n<p>b</p>'), '<p>a</p>\n<p>b</p>')
  // 纯空白换行夹在两个内联元素之间：非换行意图，保持折叠
  const inline = sanitizeRichText('<p><b>a</b>\n<b>b</b></p>')
  assert.ok(!inline.includes('<br'), inline)
  // 段首/段尾的换行是排版残留：裁掉，不产生多余空行
  assert.equal(sanitizeRichText('<p>\na\nb\n</p>'), '<p>a<br/>b</p>')
  // \r\n / \r 归一成 \n 再转 <br/>
  assert.equal(sanitizeRichText('<p>a\r\nb</p>'), '<p>a<br/>b</p>')
  assert.equal(sanitizeRichText('<p>a\rb</p>'), '<p>a<br/>b</p>')
  // &#10; 实体解码后同样是换行
  assert.equal(sanitizeRichText('<p>a&#10;b</p>'), '<p>a<br/>b</p>')
  // <pre> 内换行由浏览器保留：不再转 <br/>（否则双重换行）
  assert.equal(sanitizeRichText('<pre>a\nb</pre>'), '<pre>a\nb</pre>')
})

test('sanitizeRichText: 无标签纯文本原样返回（客户端文本节点路径与旧行为一致）', () => {
  const plain = 'a & b < c\n下一行"quoted"\n&copy; 2024'
  assert.equal(sanitizeRichText(plain), plain)
  assert.equal(sanitizeRichText(''), '')
  assert.equal(sanitizeRichText(null), '')
  assert.equal(sanitizeRichText(undefined), '')
  assert.equal(sanitizeRichText(123), '123')
})

test('sanitizeRichText: 超长输入截断（防御异常大描述拖垮渲染）', () => {
  const out = sanitizeRichText('<p>' + 'x'.repeat(300000))
  assert.ok(out.length < 300000)
  assert.ok(out.startsWith('<p>'))
})

test('toWorkItemView / toNoteView / toProjectView: 富文本字段统一经白名单清洗', () => {
  const v = toWorkItemView({ id: 'wi1', description: '<p>x</p><script>alert(1)</script>' })
  assert.equal(v.description, '<p>x</p>')
  // 清洗旗标：客户端只对带旗标的数据走 innerHTML 渲染（旧 host 无旗标 → 纯文本）
  assert.equal(v.rich, true)
  const n = toNoteView({ id: 'c1', content: '<b>加粗</b> 已复现 & 好了', created_by: { display_name: 'A' } })
  assert.equal(n.content, '<b>加粗</b> 已复现 &amp; 好了')
  assert.equal(n.rich, true)
  const p = toProjectView({ id: 'p1', name: 'A', description: '<p>y</p><iframe src="https://evil"></iframe>' })
  assert.equal(p.description, '<p>y</p>')
})

// ── 文件链接 token（/files/public/ 图片/附件需要 ?token= 才能加载）────────────

test('appendFileToken: img src / a href 拼上 token；已有 token 替换；查询串用 & 续接', () => {
  const tok = 'ae74 xxxx' // 带空格验证 encodeURIComponent
  const base = 'open.pingcode.com'
  assert.equal(
    appendFileToken('<img src="https://atlas.pingcode.com/files/public/618f/origin-url" alt="a.png" />', tok, base),
    '<img src="https://atlas.pingcode.com/files/public/618f/origin-url?token=ae74%20xxxx" alt="a.png" />')
  assert.equal(
    appendFileToken('<img src="https://atlas.pingcode.com/files/public/618f?size=2&amp;v=1" />', tok, base),
    '<img src="https://atlas.pingcode.com/files/public/618f?size=2&amp;v=1&amp;token=ae74%20xxxx" />')
  assert.equal(
    appendFileToken('<img src="https://atlas.pingcode.com/files/public/618f?token=old" />', tok, base),
    '<img src="https://atlas.pingcode.com/files/public/618f?token=ae74%20xxxx" />')
  assert.equal(
    appendFileToken('<a href="https://atlas.pingcode.com/files/public/618f">f</a><a href="https://example.com/x">y</a>', tok, base),
    '<a href="https://atlas.pingcode.com/files/public/618f?token=ae74%20xxxx">f</a><a href="https://example.com/x">y</a>')
  assert.equal(
    appendFileToken('<img src="https://atlas.pingcode.com/files/public/618f" />', '', base),
    '<img src="https://atlas.pingcode.com/files/public/618f" />')
})

test('appendFileToken: 异域 /files/public/ 链接不拼 token（防凭据外泄），私部署同 host 可以', () => {
  const out = appendFileToken('<img src="https://evil.example.com/files/public/x" />', 't', 'open.pingcode.com')
  assert.equal(out, '<img src="https://evil.example.com/files/public/x" />')
  const ok = appendFileToken('<img src="https://pc.corp.example.com/files/public/x" />', 't', 'pc.corp.example.com')
  assert.ok(ok.includes('?token=t'), ok)
})

test('toWorkItemView: /files/public/ 链接拼上该项返回的 public_image_token（include_public_image_token 换取）', () => {
  clearFileTokenCache()
  const v = toWorkItemView({
    id: 'wi1',
    public_image_token: 'imgtok123',
    description: '<p>期望：不被带入</p><img src="https://atlas.pingcode.com/files/public/000000000000000000000000/origin-url" alt="image.png" width="675" />',
  })
  assert.ok(v.description.includes('origin-url?token=imgtok123'), v.description)
  // 没给 token（列表/评论接口不返回时）→ 只清洗不拼
  const noTok = toWorkItemView({
    id: 'wi2',
    description: '<p>x</p><img src="https://atlas.pingcode.com/files/public/618f" /><script>alert(1)</script>',
  })
  assert.ok(noTok.description.includes('/files/public/618f"'), noTok.description)
  assert.ok(!noTok.description.includes('token='), noTok.description)
  assert.ok(!noTok.description.includes('script'), noTok.description)
  // 无文件链接的富文本不受影响
  assert.equal(toWorkItemView({ id: 'wi3', description: '<p>x</p>' }).description, '<p>x</p>')
  // 换行转 <br/> 在清洗阶段完成：toWorkItemView 输出里 \n 已消失（客户端才不用管）
  const nl = toWorkItemView({ id: 'wi4', description: '<p>a\n\nb</p>' })
  assert.equal(nl.description, '<p>a<br/><br/>b</p>')
  assert.equal(nl.rich, true)
  // 评论接口不提供 public_image_token：纯文本原样返回
  assert.equal(toNoteView({ id: 'c1', content: '已复现 & 好了' }).content, '已复现 & 好了')
})
