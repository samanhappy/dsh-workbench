// SLS 日志查询（/sls/*）的 argv 白名单构造 + 环境配置解析 + 结果解析 + 错误归类测试。
//
// 全部用 mock runner 驱动 index.js 里 re-export 的纯函数与 runSlsQuery 的真实
// 代码路径，不依赖本机 CLI。验证点：
//   - slsEnvironments 解析：合法数组归一化、非法 JSON / 非数组 / 非法条目降级
//   - project/logstore 必填（无内置默认值），缺失时提示插件配置键
//   - 显式参数透传、可选参数只在给出时追加、白名单校验拒绝非法输入
//   - 客户端两种形态：配置了环境用环境下拉；未配置时手填 Project/Logstore + 提示
//   - 结果解析兼容 `data`（实际 CLI 输出）与 `logs`（文档示例）两种字段
//   - SDK 错误（stdout + 退出码 1）合并归类成中文提示
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSlsArgv, parseSlsEnvironments, parseSlsResult, classifySlsError, runSlsQuery } from '../index.js'

const FROM = '1789747200'
const TO = '1789833600'

const DEMO_ENVS = [
  { key: 'prod', label: '生产环境', project: 'demo-prod-logs', logstore: 'demo-prod-traces', logs: 'demo-prod-logs' },
  { key: 'test', label: '测试环境', project: 'demo-test-logs', logstore: 'demo-test-traces', logs: 'demo-test-logs' },
]

test('parseSlsEnvironments: 留空 / 非法 JSON / 非数组都降级为空列表', () => {
  assert.deepEqual(parseSlsEnvironments(''), [])
  assert.deepEqual(parseSlsEnvironments('   '), [])
  assert.deepEqual(parseSlsEnvironments(undefined), [])
  assert.deepEqual(parseSlsEnvironments(null), [])
  assert.deepEqual(parseSlsEnvironments('{'), [])
  assert.deepEqual(parseSlsEnvironments('{"project":"x"}'), [])
  assert.deepEqual(parseSlsEnvironments('"x"'), [])
  assert.deepEqual(parseSlsEnvironments('[1, null, "x"]'), [])
})

test('parseSlsEnvironments: 合法数组归一化 key/label/logs 缺省值', () => {
  const envs = parseSlsEnvironments(JSON.stringify([
    { project: 'demo-prod-logs', logstore: 'demo-prod-traces' },
    { key: 'test', label: '测试环境', project: 'demo-test-logs', logstore: 'demo-test-traces', logs: 'demo-test-logs' },
    { key: 'custom', project: 'demo-custom-logs', logstore: 'demo-custom-traces', logs: 'not a valid name!' },
  ]))
  assert.deepEqual(envs, [
    { key: 'demo-prod-logs', label: 'demo-prod-logs', project: 'demo-prod-logs', logstore: 'demo-prod-traces', logs: 'demo-prod-traces' },
    { key: 'test', label: '测试环境', project: 'demo-test-logs', logstore: 'demo-test-traces', logs: 'demo-test-logs' },
    { key: 'custom', label: 'custom', project: 'demo-custom-logs', logstore: 'demo-custom-traces', logs: 'demo-custom-traces' },
  ])
})

test('parseSlsEnvironments: 缺 project/logstore 或名称非法的条目逐条忽略，不抛错', () => {
  const envs = parseSlsEnvironments(JSON.stringify([
    null,
    { project: 'demo-prod-logs' },
    { logstore: 'demo-prod-traces' },
    { project: 'bad project!', logstore: 'demo-prod-traces' },
    { project: 'demo-prod-logs', logstore: 'bad logstore!' },
    { key: 'prod', label: '生产环境', project: 'demo-prod-logs', logstore: 'demo-prod-traces', logs: 'demo-prod-logs' },
    { key: 'prod', label: '重复 key', project: 'other-logs', logstore: 'other-traces' },
  ]))
  assert.deepEqual(envs, [DEMO_ENVS[0]])
})

test('buildSlsArgv: project/logstore 必填（无内置默认值），缺失时提示插件配置键', () => {
  assert.throws(() => buildSlsArgv({ from: FROM, to: TO }), /缺少 SLS project.*slsEnvironments/)
  assert.throws(() => buildSlsArgv({ project: '  ', logstore: 'demo-prod-traces', from: FROM, to: TO }), /缺少 SLS project/)
  assert.throws(() => buildSlsArgv({ project: 'demo-prod-logs', from: FROM, to: TO }), /缺少 SLS logstore.*slsEnvironments/)
  assert.throws(() => buildSlsArgv({ project: 'demo-prod-logs', logstore: '', from: FROM, to: TO }), /缺少 SLS logstore/)
})

test('buildSlsArgv: 显式参数透传，可选参数只在给出时追加', () => {
  const argv = buildSlsArgv({
    project: 'my-prod-project',
    logstore: 'my-traces',
    from: FROM,
    to: TO,
    query: '2fa26bdea4ca1c475a907105667e341a',
    line: '10',
    offset: '20',
    reverse: 'true',
  })
  assert.deepEqual(argv, [
    'sls', 'get-logs-v2',
    '--project', 'my-prod-project',
    '--logstore', 'my-traces',
    '--accept-encoding', 'lz4',
    '--from', FROM,
    '--to', TO,
    '--query', '2fa26bdea4ca1c475a907105667e341a',
    '--line', '10',
    '--offset', '20',
    '--reverse', 'true',
  ])
})

test('buildSlsArgv: 空 query / line / offset / reverse 不追加参数', () => {
  const argv = buildSlsArgv({ project: 'demo-prod-logs', logstore: 'demo-prod-traces', from: FROM, to: TO, query: '  ', line: '', offset: '', reverse: '' })
  assert.equal(argv.length, 12)
  assert.ok(!argv.includes('--query') && !argv.includes('--line') && !argv.includes('--offset') && !argv.includes('--reverse'))
})

test('buildSlsArgv: 白名单校验拒绝非法输入', () => {
  const base = { project: 'demo-prod-logs', logstore: 'demo-prod-traces', from: FROM, to: TO }
  assert.throws(() => buildSlsArgv({ ...base, project: 'bad project!' }), /无效的 SLS project/)
  assert.throws(() => buildSlsArgv({ ...base, logstore: 'x'.repeat(200) }), /无效的 SLS logstore/)
  assert.throws(() => buildSlsArgv({ ...base, from: 'abc' }), /无效的 from/)
  assert.throws(() => buildSlsArgv({ ...base, to: '12.5' }), /无效的 to/)
  assert.throws(() => buildSlsArgv({ ...base, to: FROM }), /from 必须早于 to/)
  assert.throws(() => buildSlsArgv({ ...base, from: TO, to: FROM }), /from 必须早于 to/)
  assert.throws(() => buildSlsArgv({ ...base, line: '101' }), /line/)
  assert.throws(() => buildSlsArgv({ ...base, line: 'abc' }), /line/)
  assert.throws(() => buildSlsArgv({ ...base, offset: '1000001' }), /offset/)
  assert.throws(() => buildSlsArgv({ ...base, reverse: 'maybe' }), /reverse/)
  assert.throws(() => buildSlsArgv({ ...base, query: 'q'.repeat(9000) }), /query 过长/)
})

test('parseSlsResult: 兼容实际 CLI 输出的 data 字段与文档示例的 logs 字段', () => {
  const out = JSON.stringify({
    data: [{ __time__: '1789747201', __source__: '1.2.3.4', service: 'demo-service', name: 'SELECT' }],
    meta: { count: 1, progress: 'Complete', elapsedMillisecond: 42, keys: ['service', 'name'] },
  })
  const r = parseSlsResult(out)
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(r.progress, 'Complete')
  assert.equal(r.elapsedMs, 42)
  assert.deepEqual(r.logs, [{ __time__: '1789747201', __source__: '1.2.3.4', service: 'demo-service', name: 'SELECT' }])

  const doc = JSON.stringify({ logs: [{ message: 'hello' }], meta: { count: 1 } })
  assert.deepEqual(parseSlsResult(doc).logs, [{ message: 'hello' }])

  // 空结果 / meta 缺失都不抛
  assert.deepEqual(parseSlsResult(JSON.stringify({ data: [] })).logs, [])
  assert.throws(() => parseSlsResult('not json at all'), /不是 JSON/)
})

test('classifySlsError: CLI 缺失 / 凭证失效 / SDK Message 提取', () => {
  assert.match(classifySlsError(new Error('spawn aliyun ENOENT')), /未检测到 aliyun CLI/)
  assert.match(classifySlsError(new Error('no valid credential')), /无有效登录凭证/)
  assert.equal(
    classifySlsError(new Error('ERROR: SDK.ServerError\nRequestId: test-request-id\nMessage: The specified project does not exist.')),
    'The specified project does not exist.（aliyun CLI）')
})

test('classifySlsError: OAuth 刷新令牌过期提示重登（含 CLI 的 re-authenticate 命令）', () => {
  const err = 'ERROR: init client failed: failed to refresh token, status code: 400, error: invalid_grant, ' +
    'description: Refresh token expired: test-refresh-token, ' +
    'requestId: test-request-id; ' +
    're-authenticate: aliyun configure --mode OAuth --oauth-site-type CN --profile OAuthProfile'
  const msg = classifySlsError(new Error(err))
  assert.match(msg, /OAuth 登录已过期/)
  assert.match(msg, /重新运行 `aliyun configure --mode OAuth --oauth-site-type CN --profile OAuthProfile`/)
  // 与「无有效登录凭证」的 AccessKey 提示区分开
  assert.ok(!/AccessKey/.test(msg))
})

test('classifySlsError: OAuth 过期但无 re-authenticate 命令时给通用重登提示', () => {
  const msg = classifySlsError(new Error('failed to refresh token, invalid_grant, Refresh token expired'))
  assert.match(msg, /OAuth 登录已过期/)
  assert.match(msg, /重新运行 `aliyun configure --mode OAuth --oauth-site-type CN`/)
})

test('runSlsQuery: 成功路径返回解析结果，argv 带显式 project/logstore', async () => {
  const calls = []
  const runner = {
    async tryRun(exe, argv, opts) {
      calls.push({ exe, argv, opts })
      assert.equal(exe, 'aliyun')
      return {
        code: 0,
        out: JSON.stringify({ data: [{ __time__: '1789747201' }], meta: { count: 1, progress: 'Complete' } }),
        errText: '',
      }
    },
  }
  const body = { project: 'demo-prod-logs', logstore: 'demo-prod-traces', from: FROM, to: TO }
  const r = await runSlsQuery({ get() { return undefined } }, runner, body)
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.deepEqual(calls[0].argv.slice(0, 6), ['sls', 'get-logs-v2', '--project', 'demo-prod-logs', '--logstore', 'demo-prod-traces'])
  assert.ok(calls[0].opts.maxBytes > 4000000) // 日志体积大，放宽 stdout 上限
})

test('runSlsQuery: 缺少 project/logstore 时拒绝执行，不调用 CLI', async () => {
  let called = false
  const runner = { async tryRun() { called = true; return { code: 0, out: '{}', errText: '' } } }
  await assert.rejects(
    runSlsQuery({ get() { return undefined } }, runner, { from: FROM, to: TO }),
    /缺少 SLS project.*slsEnvironments/)
  assert.equal(called, false)
})

test('runSlsQuery: SDK 错误在 stdout 且退出码 1 → 合并两路输出后抛出', async () => {
  const runner = {
    async tryRun() {
      return { code: 1, out: 'ERROR: SDK.ServerError\nMessage: query is invalid', errText: '' }
    },
  }
  await assert.rejects(
    runSlsQuery({ get() { return undefined } }, runner, { project: 'demo-prod-logs', logstore: 'demo-prod-traces', from: FROM, to: TO }),
    /query is invalid/)
})

test('SLS 环境模式：环境下拉映射日志/Trace 库、独立查询条件和结果清理', async () => {
  const { build } = await import('esbuild')
  const slots = []; let cursor = 0
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback: fn => fn, useEffect() {},
  }
  const bundle = await build({ entryPoints: ['src/client/components/sls.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const forgeFetch=(...args)=>globalThis.__slsFetch(...args);', loader: 'js' }))
  } }] })
  let stored = JSON.stringify({ dataType: 'traces', project: 'demo-prod-logs', logstore: 'demo-prod-traces', query: 'traceID: "old"' })
  globalThis.localStorage = { getItem: () => stored, setItem: (_k, v) => { stored = v } }
  const STATUS = { ok: true, updatedAt: Date.now(), cli: { available: true, configured: true, activeRegion: 'cn-hangzhou' }, environments: DEMO_ENVS }
  globalThis.__slsFetch = async (path, options) => {
    if (String(path).startsWith('/sls/status')) return STATUS
    requests.push({ path, options }); return { ok: true, logs: [{ message: 'hello' }] }
  }
  try {
    const module = { exports: {} }
    Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => name === 'react' ? React : {}, module, module.exports)
    const render = () => { cursor = 0; return module.exports.SlsPanel({}) }
    const all = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(all)]
    const control = (tree, label) => all(tree).find(n => n.props['aria-label'] === label)
    let tree = render()
    // 首帧 status 未返回：退化为手填 Project/Logstore 输入框
    assert.ok(control(tree, 'Project') && control(tree, 'Logstore'))
    assert.equal(control(tree, '日志环境'), undefined)
    // 点刷新状态拿到配置环境 → 环境下拉替代输入框
    control(tree, '刷新 CLI 状态').props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    tree = render()
    assert.equal(control(tree, 'Project'), undefined)
    const envSel = control(tree, '日志环境')
    assert.ok(envSel && envSel.props.value === 'prod')
    control(tree, '数据类型').props.onChange({ target: { value: 'logs' } }); tree = render()
    assert.equal(slots[0].logstore, 'demo-prod-logs')
    assert.equal(slots[0].query, '')
    slots[0].query = 'level: ERROR'
    const button = all(tree).find(n => n.props.title === '执行 SLS 查询（get-logs-v2）')
    button.props.onClick(); await Promise.resolve(); tree = render()
    assert.equal(requests[0].options.body.project, 'demo-prod-logs')
    assert.equal(requests[0].options.body.logstore, 'demo-prod-logs')
    control(tree, '数据类型').props.onChange({ target: { value: 'traces' } }); tree = render()
    assert.equal(slots[0].query, 'traceID: "old"')
    assert.equal(slots[3], null)
    control(tree, '数据类型').props.onChange({ target: { value: 'logs' } }); tree = render()
    assert.equal(slots[0].query, 'level: ERROR')
    control(tree, '日志环境').props.onChange({ target: { value: 'test' } })
    assert.equal(slots[0].logstore, 'demo-test-logs')
    tree = render()
    all(tree).find(n => n.props.title === '执行 SLS 查询（get-logs-v2）').props.onClick()
    await Promise.resolve(); tree = render()
    const range = requests[1].options.body
    all(tree).find(n => typeof n.props.onTrace === 'function').props.onTrace('abc')
    await Promise.resolve()
    assert.equal(requests[2].options.body.project, 'demo-test-logs')
    assert.equal(requests[2].options.body.logstore, 'demo-test-traces')
    assert.equal(requests[2].options.body.query, 'traceID: "abc"')
    assert.equal(requests[2].options.body.from, range.from)
    assert.equal(requests[2].options.body.to, range.to)
    tree = render()
    control(tree, '数据类型').props.onChange({ target: { value: 'all' } }); tree = render()
    slots[0].line = '1'
    globalThis.__slsFetch = async (path, options) => {
      if (String(path).startsWith('/sls/status')) return STATUS
      requests.push({ path, options })
      return options.body.logstore.endsWith('traces') ? { ok: false, error: 'trace unavailable' } : { ok: true, logs: [{ message: 'hello' }] }
    }
    all(tree).find(n => n.props.title === '执行 SLS 查询（get-logs-v2）').props.onClick()
    await new Promise(resolve => setImmediate(resolve)); tree = render()
    assert.deepEqual(requests.slice(3).map(r => r.options.body.logstore), ['demo-test-logs', 'demo-test-traces'])
    assert.equal(requests[3].options.body.from, requests[4].options.body.from)
    assert.ok(JSON.stringify(tree).includes('trace unavailable'))
    assert.ok(all(tree).some(n => typeof n.props.onTrace === 'function'))
    all(tree).find(n => n.props.title === '以当前条数为 offset 取下一页').props.onClick()
    await new Promise(resolve => setImmediate(resolve)); tree = render()
    assert.equal(requests[5].options.body.logstore, 'demo-test-logs')
    assert.equal(requests[5].options.body.offset, '1')
    assert.ok(JSON.stringify(tree).includes('trace unavailable'))
    assert.equal(all(tree).filter(n => typeof n.props.onTrace === 'function').length, 2)

    // 最近查询：提交时记录、去重；回填只改语句，不发请求或改变查询范围。
    const recent = JSON.parse(JSON.parse(stored).recentQueries)
    assert.deepEqual(recent, ['traceID: "abc"', 'level: ERROR'])
    const before = { ...slots[0] }
    const requestCount = requests.length
    control(tree, '最近查询').props.onChange({ target: { value: recent[1] } })
    assert.deepEqual(slots[0], { ...before, query: recent[1] })
    assert.equal(requests.length, requestCount)
    tree = render()
    all(tree).find(n => n.props.title === '清空最近查询记录').props.onClick()
    assert.deepEqual(JSON.parse(JSON.parse(stored).recentQueries), [])
    assert.equal(slots[0].query, recent[1])
    assert.equal(control(render(), '最近查询'), undefined)

  } finally { delete globalThis.__slsFetch; delete globalThis.localStorage }
})

test('SLS 未配置环境：手填 Project/Logstore 预填已保存偏好，配齐前禁用查询并提示配置', async () => {
  const { build } = await import('esbuild')
  const slots = []; let cursor = 0
  const requests = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback: fn => fn, useEffect() {},
  }
  const bundle = await build({ entryPoints: ['src/client/components/sls.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const forgeFetch=(...args)=>globalThis.__slsFetch(...args);', loader: 'js' }))
  } }] })
  // 旧偏好里的 project/logstore 预填；初始化时 status 未返回也不影响预填。
  let stored = JSON.stringify({ project: 'saved-logs', logstore: 'saved-traces' })
  globalThis.localStorage = { getItem: () => stored, setItem: (_k, v) => { stored = v } }
  const STATUS = { ok: true, updatedAt: Date.now(), cli: { available: true, configured: true, activeRegion: 'cn-hangzhou' }, environments: [] }
  globalThis.__slsFetch = async (path, options) => {
    if (String(path).startsWith('/sls/status')) return STATUS
    requests.push({ path, options }); return { ok: true, logs: [] }
  }
  try {
    const module = { exports: {} }
    Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => name === 'react' ? React : {}, module, module.exports)
    const render = () => { cursor = 0; return module.exports.SlsPanel({}) }
    const all = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(all)]
    const control = (tree, label) => all(tree).find(n => n.props['aria-label'] === label)
    let tree = render()
    // 点刷新状态确认 host 明确报告「没有配置环境」→ 展示配置提示
    control(tree, '刷新 CLI 状态').props.onClick()
    await new Promise(resolve => setImmediate(resolve))
    tree = render()
    assert.equal(control(tree, '日志环境'), undefined)
    assert.equal(control(tree, '数据类型'), undefined)
    assert.ok(JSON.stringify(tree).includes('slsEnvironments'), '未配置时提示管理员设置 slsEnvironments')
    const projectInput = control(tree, 'Project')
    const logstoreInput = control(tree, 'Logstore')
    assert.equal(projectInput.props.value, 'saved-logs')
    assert.equal(logstoreInput.props.value, 'saved-traces')
    const queryButton = () => all(tree).find(n => n.props.title === '执行 SLS 查询（get-logs-v2）')
    assert.equal(queryButton().props.disabled, false)
    // 清空 project → 禁用查询；补回后恢复并可用手填值查询
    projectInput.props.onChange({ target: { value: '' } }); tree = render()
    assert.equal(queryButton().props.disabled, true)
    control(tree, 'Project').props.onChange({ target: { value: 'manual-project' } }); tree = render()
    assert.equal(queryButton().props.disabled, false)
    control(tree, 'Logstore').props.onChange({ target: { value: 'manual-logstore' } }); tree = render()
    queryButton().props.onClick(); await Promise.resolve(); tree = render()
    assert.equal(requests[0].options.body.project, 'manual-project')
    assert.equal(requests[0].options.body.logstore, 'manual-logstore')
    assert.equal(JSON.parse(stored).project, 'manual-project')
    assert.equal(JSON.parse(stored).logstore, 'manual-logstore')
  } finally { delete globalThis.__slsFetch; delete globalThis.localStorage }
})

test('最近查询读取：过滤损坏数据、去重、限制条数，并容忍存储不可用', async () => {
  const { build } = await import('esbuild')
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/client/components/sls.tsx', import.meta.url), 'utf8')
  const bundle = await build({ stdin: { contents: source + '\nexport { loadRecentQueries }', resolveDir: new URL('../src/client/components', import.meta.url).pathname, loader: 'tsx' }, bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} }
  Function('require', 'module', 'exports', bundle.outputFiles[0].text)(() => ({}), module, module.exports)
  let recentQueries = JSON.stringify([null, 1, '', '  ', ' q ', 'q', ...Array.from({ length: 25 }, (_, i) => String(i))])
  globalThis.localStorage = { getItem: () => JSON.stringify({ recentQueries }) }
  try {
    assert.deepEqual(module.exports.loadRecentQueries(), ['q', ...Array.from({ length: 19 }, (_, i) => String(i))])
    recentQueries = '{'
    assert.deepEqual(module.exports.loadRecentQueries(), [])
    recentQueries = '{}'
    assert.deepEqual(module.exports.loadRecentQueries(), [])
    globalThis.localStorage.getItem = () => { throw new Error('unavailable') }
    assert.deepEqual(module.exports.loadRecentQueries(), [])
  } finally { delete globalThis.localStorage }
})

test('JSON 字段、数组项和闭合括号按层级缩进', async () => {
  const { build } = await import('esbuild')
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/client/components/sls.tsx', import.meta.url), 'utf8')
  const bundle = await build({ stdin: { contents: source + '\nexport { entryJsonNodes }', resolveDir: new URL('../src/client/components', import.meta.url).pathname, loader: 'tsx' }, bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  Function('require', 'module', 'exports', bundle.outputFiles[0].text)(name => name === 'react' ? React : {}, module, module.exports)
  const lines = module.exports.entryJsonNodes({ resource: '{"items":["long value"]}' })
  assert.deepEqual(lines.map(n => n.props.style.paddingLeft), ['0ch', '2ch', '4ch', '6ch', '4ch', '2ch', '0ch'])
})

test('SLS 路由恢复超限 stdout，清理 spill，并拒绝无法恢复的截断结果', async () => {
  const { apply } = await import('../index.js')
  const { mkdtemp, writeFile, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'wb-sls-'))
  const spillPath = join(dir, 'stdout')
  const full = JSON.stringify({ data: [{ message: 'x'.repeat(12000000) }] })
  const tail = Buffer.from(full).subarray(-12000000).toString('utf8')
  let recoverable = true
  const routes = [], dispose = []
  const ctx = {
    connection: { fetch: { register() {} }, requestRejection: () => undefined },
    get(name) {
      if (name === 'subprocess') return {
        resolveExecutable: async exe => exe,
        spawn(spec) {
          assert.equal(spec.stdio.stdout.spill.maxBytes, 64000000)
          return { done: Promise.resolve({ exitCode: 0 }), collected: {
            stdout: { readFrom: () => ({ text: tail, lossy: true, ...(recoverable ? { spillPath } : {}) }) },
            stderr: { readFrom: () => ({ text: '' }) },
          } }
        },
      }
    },
    effect(fn) { const close = fn(); if (typeof close === 'function') dispose.push(close) },
    webServer: { register(route) { routes.push(route); return () => {} } },
  }
  async function query() {
    const body = JSON.stringify({ project: 'demo-prod-logs', logstore: 'demo-prod-traces', from: FROM, to: TO })
    const req = Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: '/sls/query' })
    let result
    await routes.find(r => r.path === '/sls/query').handler(req, { setHeader() {}, end(body) { result = JSON.parse(body) } })
    return result
  }
  try {
    await writeFile(spillPath, full)
    apply(ctx, { autoReviewIntervalMs: 0, skillsAutoUpdateIntervalMs: 0 })
    const result = await query()
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.logs[0].message.length, 12000000)
    await assert.rejects(access(spillPath), { code: 'ENOENT' })
    recoverable = false
    const failed = await query()
    assert.equal(failed.ok, false)
    assert.match(failed.error, /输出超出大小上限/)
  } finally {
    for (const close of dispose.reverse()) close()
    await rm(dir, { recursive: true, force: true })
  }
})
