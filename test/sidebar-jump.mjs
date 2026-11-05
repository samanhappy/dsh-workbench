// Sidebar row behavior: the「工作台」row shows the always-visible function
// shortcuts configured in 配置页 → 菜单栏快捷入口; clicking one opens the
// workbench main panel (the click bubbles to the host row button →
// selectPanel) and switches the panel's function page. There is no 首页 icon:
// the row itself is the home entry — workbenchRowClickHandler (attached to the
// host row button next to the data-wb-row tag) jumps home for any click
// outside the shortcut and foreign controls. The pure jump channel asserted
// here:
//
//   requestWorkbenchPage(page)
//     → persists the page to localStorage (a cold panel mount reads it), and
//     → dispatches window CustomEvent WB_PAGE_EVENT with the page as detail
//       (a live WorkbenchPanel subscribes and switches in place).
//
// Loads the BUILT lib/client.js through the shared loader like the other
// pure-helper suites.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

test('WB_PAGE_EVENT is the stable window CustomEvent name the panel subscribes to', () => {
  const exports = loadClientModule()
  assert.equal(exports.WB_PAGE_EVENT, 'samanhappy.dsh-workbench:page')
})

test('isWbPage accepts exactly the function pages (forge/dms/sls/pingcode/skills/config)', () => {
  const exports = loadClientModule()
  assert.equal(exports.isWbPage('forge'), true)
  assert.equal(exports.isWbPage('dms'), true)
  assert.equal(exports.isWbPage('sls'), true)
  assert.equal(exports.isWbPage('pingcode'), true)
  assert.equal(exports.isWbPage('skills'), true)
  assert.equal(exports.isWbPage('config'), true)
  assert.equal(exports.isWbPage('conversation'), false)
  assert.equal(exports.isWbPage('workbench'), false)
  assert.equal(exports.isWbPage(null), false)
  assert.equal(exports.isWbPage(undefined), false)
  assert.equal(exports.isWbPage(42), false)
})

test('requestWorkbenchPage persists the page for a cold panel mount', () => {
  const exports = loadClientModule()
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  try {
    exports.requestWorkbenchPage('dms')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'dms')
    exports.requestWorkbenchPage('sls')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'sls')
    exports.requestWorkbenchPage('forge')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'forge')
    exports.requestWorkbenchPage('pingcode')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'pingcode')
    exports.requestWorkbenchPage('skills')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'skills')
    exports.requestWorkbenchPage('config')
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'config')
  } finally {
    delete globalThis.localStorage
  }
})

test('requestWorkbenchPage notifies a live panel through window CustomEvent', () => {
  const exports = loadClientModule()
  const seen = []
  class FakeCustomEvent {
    constructor(type, opts) {
      this.type = type
      this.detail = opts && opts.detail
    }
  }
  const prevWindow = globalThis.window
  const prevCustomEvent = globalThis.CustomEvent
  globalThis.CustomEvent = FakeCustomEvent
  globalThis.window = {
    dispatchEvent(ev) { seen.push(ev) },
  }
  try {
    exports.requestWorkbenchPage('dms')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].type, 'samanhappy.dsh-workbench:page')
    assert.equal(seen[0].detail, 'dms')
  } finally {
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    if (prevCustomEvent === undefined) delete globalThis.CustomEvent
    else globalThis.CustomEvent = prevCustomEvent
  }
})

test('requestWorkbenchPage is safe without window / CustomEvent (node, sim harness)', () => {
  const exports = loadClientModule()
  const prevWindow = globalThis.window
  const prevCustomEvent = globalThis.CustomEvent
  delete globalThis.window
  delete globalThis.CustomEvent
  try {
    exports.requestWorkbenchPage('forge') // must not throw
  } finally {
    if (prevWindow !== undefined) globalThis.window = prevWindow
    if (prevCustomEvent !== undefined) globalThis.CustomEvent = prevCustomEvent
  }
})

test('workbenchRowClickHandler: the sidebar row itself is the home entry', () => {
  const exports = loadClientModule()
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  const seen = []
  class FakeCustomEvent {
    constructor(type, opts) {
      this.type = type
      this.detail = opts && opts.detail
    }
  }
  const prevWindow = globalThis.window
  const prevCustomEvent = globalThis.CustomEvent
  globalThis.CustomEvent = FakeCustomEvent
  globalThis.window = { dispatchEvent(ev) { seen.push(ev) } }
  const row = { kind: 'row' }
  const jumpEl = { kind: 'jump' }
  const foreignEl = { kind: 'foreign' }
  // closest(sel) 桩：.wb-row-jump / button 两个查询各自命中（与真实 DOM 一致
  // ——处理器先查跳转图标，再查宿主按钮归属）。
  const clickIn = (jumpHit, buttonHit) => ({
    target: { closest: (sel) => (sel === '.wb-row-jump' ? jumpHit : sel === 'button' ? buttonHit : null) },
  })
  const handler = exports.workbenchRowClickHandler(row)
  try {
    // 行本体（工作台图标 / 标签 / 空白）→ 首页直达，与 jump 图标共用同一条
    // 持久化 + WB_PAGE_EVENT 通道。
    store.set('samanhappy.dsh-workbench.page', 'forge')
    handler(clickIn(null, row))
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'home')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].type, 'samanhappy.dsh-workbench:page')
    assert.equal(seen[0].detail, 'home')
    // 功能 jump 图标的点击留给 JumpItem 自己（冒泡设计），行级处理器不抢先。
    store.set('samanhappy.dsh-workbench.page', 'forge')
    handler(clickIn(jumpEl, row))
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'forge')
    // 行内宿主自带控件（外来 button）：不劫持成首页。
    handler(clickIn(null, foreignEl))
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'forge')
    // 奇异 target（无 closest / 无 target / null 事件）：不抛错、不跳转。
    handler({ target: {} })
    handler({})
    handler(null)
    assert.equal(store.get('samanhappy.dsh-workbench.page'), 'forge')
    assert.equal(seen.length, 1)
  } finally {
    delete globalThis.localStorage
    if (prevWindow === undefined) delete globalThis.window
    else globalThis.window = prevWindow
    if (prevCustomEvent === undefined) delete globalThis.CustomEvent
    else globalThis.CustomEvent = prevCustomEvent
  }
})

test('session badges count live sessions once, pending takes priority over running and unread', () => {
  const { sessionBadgeCounts } = loadClientModule()
  assert.deepEqual(sessionBadgeCounts(null, null, null), { ongoing: 0, warning: 0, done: 0, idle: 0 })
  assert.deepEqual(sessionBadgeCounts(
    { run: true, approve: true, read: false },
    { approve: 'approval', plan: 'plan-review', question: 'question', other: 'plugin' },
    { approve: true, run: true, done: true },
  ), { ongoing: 1, warning: 3, done: 1, idle: 2 })
})

test('session badges skip sessions the home page never shows (subagent / blank)', () => {
  const { sessionBadgeCounts, isHiddenFromHome } = loadClientModule()
  // 宿主会话列表包含子会话（teammate / subagent）与空白会话，首页扫描会剔除它们；
  // 不剔除就会数出首页根本没有的会话（典型症状：侧栏进行中 4，首页左栏只有 1）。
  const running = { lead: true, mate1: true, mate2: true, blankIdle: false }
  const unread = { mate3: true }
  const hidden = { mate1: true, mate2: true, mate3: true, blankIdle: true }
  assert.deepEqual(sessionBadgeCounts(running, null, unread, hidden), { ongoing: 1, warning: 0, done: 0, idle: 0 })
  // 不传 hidden（服务未就绪）时保持原口径，不做静默剔除
  assert.deepEqual(sessionBadgeCounts(running, null, unread), { ongoing: 3, warning: 0, done: 1, idle: 1 })

  // 与 host selectHomeSessions 的 `(!blank || running) && !child` 同口径
  assert.equal(isHiddenFromHome({ parentId: 'lead' }), true, '子会话（parentId）')
  assert.equal(isHiddenFromHome({ origin: 'subagent' }), true, '子会话（origin）')
  assert.equal(isHiddenFromHome({ blank: true, running: false }), true, '空闲空白会话')
  assert.equal(isHiddenFromHome({ blank: true, running: true }), false, '运行中的空白会话仍展示')
  assert.equal(isHiddenFromHome({ running: true }), false, '普通运行中会话')
  assert.equal(isHiddenFromHome({}), false)
  assert.equal(isHiddenFromHome(null), false)
})
