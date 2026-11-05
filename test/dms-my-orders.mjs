// DMS「我的」页签契约：
//   - 默认 / 徽标轮询口径保持 AS_HANDLER（待我审批），不能被新页签带偏；
//   - 「我的」显式请求 AS_COMMITTER（我提交的工单），行上不出现审批动作；
//   - 从「我的」打开的详情是只读的，不渲染同意 / 拒绝。
//
// URL 规则用构建产物里的纯函数验证；渲染与请求时序用 esbuild 打包
// dms.tsx + mini React 直测（与 auto-review-client.mjs 同一套手法）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { loadClientModule } from './load-client.mjs'

const prefs = { region: 'cn-hangzhou', tid: '123' }
const mod = loadClientModule({ getItem: () => JSON.stringify(prefs) })

test('我的工单 URL 请求 AS_COMMITTER，并带上 Region/Tid/分页', () => {
  const url = mod.dmsOrdersUrl(false, 1, 'AS_COMMITTER')
  assert.match(url, /[?&]resultType=AS_COMMITTER(&|$)/)
  assert.match(url, /[?&]region=cn-hangzhou(&|$)/)
  assert.match(url, /[?&]tid=123(&|$)/)
  assert.match(url, /[?&]page=1(&|$)/)
  assert.ok(!url.includes('force=1'))
})

test('我的工单支持翻页与强制刷新参数', () => {
  const url = mod.dmsOrdersUrl(true, 2, 'AS_COMMITTER')
  assert.match(url, /[?&]page=2(&|$)/)
  assert.match(url, /[?&]force=1(&|$)/)
  assert.match(url, /[?&]resultType=AS_COMMITTER(&|$)/)
})

test('默认（不传 resultType）仍是待我审批 AS_HANDLER', () => {
  assert.match(mod.dmsOrdersUrl(false), /[?&]resultType=AS_HANDLER(&|$)/)
  assert.match(mod.dmsOrdersUrl(false, 3), /[?&]resultType=AS_HANDLER(&|$)/)
})

// ── 页面契约：esbuild 打包 dms.tsx + mini React ─────────────────────────────

const order = (id, extra) => Object.assign({
  orderId: id, pluginType: 'DATA_CHANGE', statusCode: 'toaudit', statusDesc: '审批中',
  workflowStatusDesc: '', workflowInstanceId: '9' + id, committer: 'alice',
  createTime: '2026-09-20 10:00:00', lastModifyTime: '2026-09-20 10:00:00',
  comment: '工单@' + id, relatedUsers: [], attachmentName: null,
}, extra)

function makeHarness() {
  let cursor = 0
  const slots = []
  const effects = []
  const requests = []
  const state = {
    prefs: { region: 'cn-hangzhou', tid: '', committers: '' },
    urlCalls: [],
    refreshCalls: 0,
    pendingTotal: null,
  }
  globalThis.__dmsRuntimeState = state
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type, props: props || {},
      children: children.flat(Infinity).filter((x) => x != null),
    }),
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback(fn, deps) {
      const i = cursor++
      const prev = slots[i]
      if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, n) => d !== prev.deps[n])) slots[i] = { fn, deps }
      return slots[i].fn
    },
    useMemo(fn, deps) {
      const i = cursor++
      const prev = slots[i]
      if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, n) => d !== prev.deps[n])) slots[i] = { v: fn(), deps }
      return slots[i].v
    },
    useLayoutEffect(fn, deps) {
      const i = cursor++
      const prev = slots[i]
      if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, n) => d !== prev.deps[n])) {
        slots[i] = { deps }
        effects.push(fn)
      }
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = slots[i]
      if (!prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, n) => d !== prev.deps[n])) {
        slots[i] = { deps }
        effects.push(fn)
      }
    },
  }
  return { React, slots, effects, requests, state, resetCursor: () => { cursor = 0 } }
}

async function loadPanel(React) {
  const runtimeStub = `
const state = globalThis.__dmsRuntimeState
export function loadDmsPrefs() { return state.prefs }
export function saveDmsPrefs(patch) { Object.assign(state.prefs, patch) }
export function dmsOrdersUrl(force, page = 1, resultType = 'AS_HANDLER') {
  state.urlCalls.push({ force, page, resultType })
  const parts = ['resultType=' + resultType, 'page=' + page, 'pageSize=50']
  if (state.prefs.region) parts.push('region=' + encodeURIComponent(state.prefs.region))
  if (state.prefs.tid) parts.push('tid=' + encodeURIComponent(state.prefs.tid))
  if (force) parts.push('force=1')
  return '/dms/orders?' + parts.join('&')
}
export async function refreshDmsOrders(force) {
  state.refreshCalls += 1
  const data = await globalThis.__dmsFetch(dmsOrdersUrl(force))
  state.pendingTotal = data && data.ok ? data.totalCount : null
  return data
}
export function filterDmsOrders(orders, committers) {
  const names = committers.split(/[,，、;；\\n]+/).map((s) => s.trim()).filter(Boolean)
  return names.length ? orders.filter((o) => names.includes(o.committer)) : orders
}
export function setDmsPendingTotal(n) { state.pendingTotal = n }
export function useShellTick() { return 0 }
export function forgeFetch(path, opts) { return globalThis.__dmsFetch(path, opts) }
`
  const result = await build({
    entryPoints: ['src/client/components/dms.tsx'],
    bundle: true,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [{
      name: 'runtime-stub',
      setup(b) {
        b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: runtimeStub, loader: 'js' }))
      },
    }],
  })
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(
    (name) => name === 'react' ? React : {},
    mod, mod.exports,
  )
  return mod.exports.DmsPanel
}

function makeHarnessWalk() {
  const all = (n, out = []) => {
    if (n == null) return out
    if (typeof n === 'string') { out.push(n); return out }
    if (typeof n !== 'object') return out
    out.push(n)
    for (const c of n.children || []) all(c, out)
    if (typeof n.type === 'function') {
      const rendered = n.type(Object.assign({}, n.props, (n.children || []).length ? { children: n.children } : null))
      all(rendered, out)
    }
    return out
  }
  const textOf = (n) => all(n).filter((x) => typeof x === 'string').join('')
  const button = (n, label, cls) => all(n).find((x) =>
    x && typeof x === 'object' && x.type === 'button' &&
    (!cls || String(x.props.className || '').includes(cls)) && textOf(x).includes(label))
  return { all, textOf, button }
}

test('DMS 我的页签：AS_COMMITTER 列表只读，详情不提供审批入口', async () => {
  const h = makeHarness()
  const handlers = [order('7001', { pluginType: 'DATA_CHANGE', comment: '待我审批工单', workflowInstanceId: '9101' })]
  const mine = [
    order('7101', { pluginType: 'SQL_EXPORT', statusCode: 'approved', statusDesc: '已通过', comment: '我提交的导出工单' }),
    order('7102', { pluginType: 'DATA_CHANGE', comment: '我提交的变更工单' }),
  ]
  globalThis.__dmsFetch = async (path) => {
    h.requests.push({ path })
    const u = new URL('http://x' + path)
    if (u.pathname === '/dms/status') {
      return { ok: true, cli: { available: true, configured: true, activeRegion: 'cn-hangzhou', profiles: [], error: null } }
    }
    if (u.pathname === '/dms/orders') {
      const mineList = u.searchParams.get('resultType') === 'AS_COMMITTER'
      return { ok: true, updatedAt: 1, orders: mineList ? mine : handlers, totalCount: mineList ? mine.length : handlers.length, resultType: mineList ? 'AS_COMMITTER' : 'AS_HANDLER' }
    }
    if (u.pathname === '/dms/order/sql') {
      return { ok: true, supported: true, type: 'DATA_CHANGE', sql: 'select 1', rollbackSql: null, facts: [] }
    }
    if (u.pathname === '/dms/order') {
      const id = u.searchParams.get('id')
      const found = mine.concat(handlers).find((o) => o.orderId === id)
      return { ok: true, order: found || handlers[0] }
    }
    return { ok: true }
  }
  const DmsPanel = await loadPanel(h.React)
  const { all, textOf, button } = makeHarnessWalk()
  const render = () => {
    h.resetCursor()
    const tree = DmsPanel({ active: true })
    while (h.effects.length) { h.effects.shift()() }
    return tree
  }
  const settle = async (rounds = 6) => {
    let tree = render()
    for (let i = 0; i < rounds; i++) { await Promise.resolve(); tree = render() }
    return tree
  }
  try {
    let tree = await settle()
    // 待审批是默认页签，既有行为不变
    assert.ok(textOf(tree).includes('待审批') && textOf(tree).includes('我的'))
    assert.ok(textOf(tree).includes('#7001'))
    assert.equal(h.state.refreshCalls, 1)
    assert.equal(h.state.pendingTotal, 1)

    // 切到「我的」：只发 AS_COMMITTER 查询，列表换成我提交的工单
    const mineTab = button(tree, '我的', 'glab-tab')
    assert.ok(mineTab, '「我的」页签存在')
    mineTab.props.onClick({ stopPropagation() {} })
    tree = await settle()
    assert.ok(h.state.urlCalls.some((c) => c.resultType === 'AS_COMMITTER'), '我的页签请求 AS_COMMITTER')
    assert.ok(h.requests.some((r) => r.path.includes('/dms/orders?') && r.path.includes('resultType=AS_COMMITTER')))
    assert.ok(textOf(tree).includes('#7101') && textOf(tree).includes('#7102'))
    assert.ok(!textOf(tree).includes('#7001'), '我的页签不显示待他人审批的工单')
    assert.equal(h.state.refreshCalls, 1, '我的页签不重复拉待审批列表')
    assert.ok(!textOf(tree).includes('同意') && !textOf(tree).includes('拒绝'), '提交人视角不出现审批动作')
    assert.ok(!button(tree, '详情'), '行上不再提供详情按钮（标题即入口）')
    assert.ok(button(tree, '我的', 'glab-tab-active'), '我的页签处于激活态')

    // 打开我提交的工单详情：标题即入口；详情只读，不渲染同意 / 拒绝
    let rowEl = null
    for (const n of all(tree)) {
      if (n && typeof n === 'object' && String(n.props.className || '').includes('wb-item') && textOf(n).includes('#7101')) { rowEl = n; break }
    }
    assert.ok(rowEl, '找到我提交的工单行')
    const detailBtn = button(rowEl, '#7101', 'wb-item-top')
    assert.ok(detailBtn, '标题按钮是详情入口')
    detailBtn.props.onClick({ stopPropagation() {} })
    tree = await settle()
    assert.ok(h.requests.some((r) => r.path.includes('/dms/order?') && r.path.includes('id=7101')))
    const detailText = textOf(tree)
    assert.ok(detailText.includes('我提交的工单，仅供查看'), detailText.slice(0, 400))
    assert.ok(!textOf(tree).includes('同意') && !textOf(tree).includes('拒绝'))

    // 返回列表仍停留在「我的」
    button(tree, '返回列表', 'glab-btn').props.onClick({ stopPropagation() {} })
    tree = await settle()
    assert.ok(textOf(tree).includes('#7101'))

    // 切回待审批：原有审批动作恢复，详情仍只从标题进入
    button(tree, '待审批', 'glab-tab').props.onClick({ stopPropagation() {} })
    tree = await settle()
    assert.ok(textOf(tree).includes('#7001') && textOf(tree).includes('同意'))
    assert.ok(!button(tree, '详情'), '待审批行同样不再渲染详情按钮')
  } finally {
    delete globalThis.__dmsFetch
    delete globalThis.__dmsRuntimeState
  }
})
