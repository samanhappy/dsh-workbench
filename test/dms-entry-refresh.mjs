// 进入 DMS 页签的补刷契约：
//   - 页签未激活时不发强制请求；
//   - 激活时若待审批列表为空，强制刷新一次（force=1），且每次进入只补刷一次；
//   - 列表非空时进入不额外强制刷新；
//   - 离开页签后再次进入可再补刷，补刷后为空也仍只发一次。
// 手法与 dms-my-orders.mjs 相同：esbuild 打包 dms.tsx + mini React 直测。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

function makeHarness() {
  let cursor = 0
  const slots = []
  const effects = []
  const state = {
    prefs: { region: 'cn-hangzhou', tid: '', committers: '' },
    urlCalls: [],
    refreshCalls: 0,
    pendingTotal: null,
    handlers: [],
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
  return { React, slots, effects, state, resetCursor: () => { cursor = 0 } }
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

const order = (id) => ({
  orderId: id, pluginType: 'DATA_CHANGE', statusCode: 'toaudit', statusDesc: '审批中',
  workflowStatusDesc: '', workflowInstanceId: '9' + id, committer: 'alice',
  createTime: '2026-09-20 10:00:00', lastModifyTime: '2026-09-20 10:00:00',
  comment: '工单@' + id, relatedUsers: [], attachmentName: null,
})

function textOf(n) {
  const all = (x, out = []) => {
    if (x == null) return out
    if (typeof x === 'string') { out.push(x); return out }
    if (typeof x !== 'object') return out
    out.push(x)
    for (const c of x.children || []) all(c, out)
    if (typeof x.type === 'function') {
      all(x.type(Object.assign({}, x.props, (x.children || []).length ? { children: x.children } : null)), out)
    }
    return out
  }
  return all(n).filter((x) => typeof x === 'string').join('')
}

test('进入 DMS 页且待审批为空时自动强制刷新一次', async () => {
  const h = makeHarness()
  globalThis.__dmsFetch = async (path) => {
    const u = new URL('http://x' + path)
    if (u.pathname === '/dms/status') {
      return { ok: true, cli: { available: true, configured: true, activeRegion: 'cn-hangzhou', profiles: [], error: null } }
    }
    if (u.pathname === '/dms/orders') {
      const mine = u.searchParams.get('resultType') === 'AS_COMMITTER'
      const rows = mine ? [] : h.state.handlers
      return {
        ok: true, updatedAt: 1, orders: rows, totalCount: rows.length,
        resultType: mine ? 'AS_COMMITTER' : 'AS_HANDLER',
      }
    }
    if (u.pathname === '/dms/order/sql') return { ok: true, supported: true, type: 'DATA_CHANGE', sql: 'select 1', facts: [] }
    if (u.pathname === '/dms/order') return { ok: true, order: order('7001') }
    return { ok: true }
  }
  const DmsPanel = await loadPanel(h.React)
  let active = false
  const render = () => {
    h.resetCursor()
    const tree = DmsPanel({ active })
    while (h.effects.length) h.effects.shift()()
    return tree
  }
  const settle = async (rounds = 8) => {
    let tree = render()
    for (let i = 0; i < rounds; i++) { await Promise.resolve(); tree = render() }
    return tree
  }
  const forceCalls = () => h.state.urlCalls.filter((c) => c.force)
  const setActive = async (next) => { active = next; return settle() }
  try {
    // 页签未激活：照常以缓存口径加载，但绝不强制请求
    let tree = await settle()
    assert.ok(h.state.refreshCalls >= 1, '未激活时也预加载待审批列表')
    assert.equal(forceCalls().length, 0, '未激活时不发强制刷新')
    assert.ok(textOf(tree).includes('暂无待审批的工单'))

    // 进入页签：待审批为空 → 强制刷新一次
    tree = await setActive(true)
    assert.equal(forceCalls().length, 1, '进入且待审批为空时补刷一次')
    assert.equal(forceCalls()[0].resultType, 'AS_HANDLER')
    assert.equal(forceCalls()[0].page, 1)

    // 补刷后仍为空：不重复补刷
    tree = await settle()
    assert.equal(forceCalls().length, 1, '补刷后仍为空也不重复刷新')
    assert.ok(textOf(tree).includes('暂无待审批的工单'))
    assert.ok(textOf(tree).includes('进入页面时自动刷新'), '空列表提示进入时自动刷新')

    // 服务端已出现工单后离开再进入：补刷一次并渲染出来
    h.state.handlers = [order('7001')]
    await setActive(false)
    tree = await setActive(true)
    assert.equal(forceCalls().length, 2, '再次进入且待审批为空时补刷一次')
    assert.ok(textOf(tree).includes('#7001'), '补刷后渲染新工单')

    // 列表非空时进入：不再强制刷新
    await setActive(false)
    tree = await setActive(true)
    assert.equal(forceCalls().length, 2, '列表非空时进入不强制刷新')
    assert.ok(textOf(tree).includes('#7001'))
  } finally {
    delete globalThis.__dmsFetch
    delete globalThis.__dmsRuntimeState
  }
})
