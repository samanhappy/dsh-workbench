// 首页（需要我关注汇总页）client 侧契约测试。
//
// 断言纯函数层（统计卡数值 / 工作区名称解析 / 最近会话合并）与 shell 接线
// （'home' 是合法页、恒可用、跳转持久化）。页面渲染行为由 sim-panel.mjs 覆盖
// （首页默认落地页、统计卡、最近会话单列表、会话行内容）。
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

function lsFrom(store) {
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
  }
}

test('首页：合法页 / 恒可用（无功能开关）/ 跳转持久化', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  assert.equal(a.isWbPage('home'), true)
  const ALL_OFF = { forge: false, dms: false, sls: false, pingcode: false, skills: false, notifications: false }
  // 首页不是功能域：全部关掉也恒可用（与配置页一致），保证汇总页永远进得去
  assert.equal(a.isPageEnabled('home', ALL_OFF), true)
  a.requestWorkbenchPage('home')
  assert.equal(store['samanhappy.dsh-workbench.page'], 'home')
})

test('首页：统计卡数值未知显示 –，已知原样', () => {
  const a = loadClientModule()
  assert.equal(a.cardValue(null), '–')
  assert.equal(a.cardValue(undefined), '–')
  assert.equal(a.cardValue(0), '0')
  assert.equal(a.cardValue(3), '3')
  assert.equal(a.cardValue('50+'), '50+')
})

test('首页：工作区名称——宿主注册名优先，未注册回退路径末段', () => {
  const a = loadClientModule()
  // 宿主 workspaces 注册表（WorkspaceView.title）按会话归属解析，可重命名的工作区用注册名
  const row = { sessionId: 's1', cwd: '/Users/user/code/dsh-workbench' }
  assert.equal(a.sessionWorkspaceLabel(row, { s1: '工作区 Alpha' }), '工作区 Alpha')
  // 宿主注册表未覆盖的会话：与 DSH defaultWorkspaceTitle 同规则取路径末段
  assert.equal(a.sessionWorkspaceLabel(row, null), 'dsh-workbench')
  assert.equal(a.sessionWorkspaceLabel({ sessionId: 's2', cwd: '/ws/b' }, { s1: '工作区 Alpha' }), 'b')
  assert.equal(a.workspaceName(null), '未知工作区')
})

function homeRow(id, updatedAt, extra) {
  return Object.assign({
    sessionId: id, cwd: '/ws/w', title: id, createdAt: 0, updatedAt,
    running: false, waiting: false, blank: false, child: false,
    userMsgs: 1, assistantMsgs: 1, turns: 1, toolCalls: 1, preset: null, background: false,
  }, extra)
}

test('首页：会话行时间与侧边栏同值——promptedAt 口径 + 向下取整分桶', () => {
  const a = loadClientModule()
  const NOW = Date.parse('2026-10-10T10:00:00+08:00')
  const M = 60 * 1000
  // 侧边栏 relativeTime 分桶向下取整：45.9 分钟必须显示 45 分钟前，不能四舍五入成 46
  assert.equal(a.fmtTimeRelFloor(NOW - 45.9 * M, NOW), '45 分钟前')
  assert.equal(a.fmtTimeRelFloor(NOW - 60 * M, NOW), '1 小时前') // 60min 整点进小时桶
  assert.equal(a.fmtTimeRelFloor(NOW - 90 * M, NOW), '1 小时前') // 1.5h 向下取整
  assert.equal(a.fmtTimeRelFloor(NOW - 23.5 * 60 * M, NOW), '23 小时前')
  assert.equal(a.fmtTimeRelFloor(NOW - 2.5 * 24 * 60 * M, NOW), '2 天前')
  assert.equal(a.fmtTimeRelFloor(NOW - 40 * 1000, NOW), '刚刚')
  // 无效输入返回空串（隐藏该段而不是显示 NaN）
  assert.equal(a.fmtTimeRelFloor(null, NOW), '')
  assert.equal(a.fmtTimeRelFloor('garbage', NOW), '')
  // 左栏行上展示的是 promptedAt（最后一条用户消息），不是 updatedAt（最近任意活动）：
  // 会话刚有后台活动也不把左栏行尾时间拨新——与侧边栏一致（右栏改用最后活动，见下）
  const row = homeRow('session-p', NOW - 10 * M, { promptedAt: NOW - 10 * M, updatedAt: NOW - 1 * M })
  assert.equal(row.promptedAt, NOW - 10 * M)
})

test('首页：两栏分栏——左栏需要动手的置顶→进行中→未读完成，右栏只留已读完成', () => {
  const a = loadClientModule()
  const ids = (rows) => rows.map((r) => r.sessionId)
  const t = 1_000_000_000

  // 左栏：待处理（不在运行）排在进行中之前；组内沿用 host 契约的 promptedAt 倒序
  const busy = []
  for (let i = 0; i < 3; i++) busy.push(homeRow('run-' + i, t - i, { running: true }))
  busy.push(homeRow('wait-0', t - 100, { waiting: true }), homeRow('idle-0', t - 200))
  const c1 = a.homeSessionColumns(busy, null)
  assert.deepEqual(ids(c1.active), ['wait-0', 'run-0', 'run-1', 'run-2'])
  assert.deepEqual(ids(c1.completed), ['idle-0'])
  // 运行中且有开放步骤：仍是进行中（与 sessionRowState 的运行优先一致），不进置顶组
  assert.deepEqual(ids(a.homeSessionColumns([homeRow('run-0', t, { running: true }), homeRow('rw-0', t - 1, { running: true, waiting: true })], null).active), ['run-0', 'rw-0'])

  // 分栏：未读完成（会话在主视图外结束且未被查看）是「需要你看一眼」的信号，
  // 并入左栏、排在进行中之后（与侧边栏状态序 待交互 > 进行中 > 未读完成 一致）；
  // 右栏只留已读完成的历史归档（行内不再需要状态点）
  const rows = [
    homeRow('run-0', t, { running: true }),
    homeRow('read-0', t - 800),
    homeRow('unread-0', t - 900),
    homeRow('read-1', t - 950),
  ]
  const split = a.homeSessionColumns(rows, { 'unread-0': true, 'read-0': false })
  assert.deepEqual(ids(split.active), ['run-0', 'unread-0'])
  assert.deepEqual(ids(split.completed), ['read-0', 'read-1'])
  // 未读完成比进行中更新也排在其后：左栏顺序按状态优先级，不按时间插队
  assert.deepEqual(ids(a.homeSessionColumns([homeRow('run-0', t - 500, { running: true }), homeRow('unread-new', t)], { 'unread-new': true }).active), ['run-0', 'unread-new'])
  // 未读状态源缺失（null / {}）时信息不可知 → 维持输入顺序，全部按已读归档
  assert.deepEqual(ids(a.homeSessionColumns(rows, null).completed), ['read-0', 'unread-0', 'read-1'])
  assert.deepEqual(ids(a.homeSessionColumns(rows, {}).completed), ['read-0', 'unread-0', 'read-1'])
  assert.deepEqual(ids(a.homeSessionColumns(rows, {}).active), ['run-0'])

  // 全部空闲已读：左栏为空（展示空态，不用空闲凑数）
  assert.deepEqual(ids(a.homeSessionColumns([homeRow('read-0', t), homeRow('read-1', t - 10)], {}).active), [])
  assert.deepEqual(ids(a.homeSessionColumns([homeRow('read-0', t), homeRow('read-1', t - 10)], {}, new Set()).completed), ['read-0', 'read-1'])
})

test('首页：右栏按最后活动时间（updatedAt）倒序，与输入顺序（promptedAt 口径）解耦', () => {
  const a = loadClientModule()
  const ids = (rows) => rows.map((r) => r.sessionId)
  // 输入按 host 汇总顺序（promptedAt 倒序）：p-new 更新；右栏要按 updatedAt 重排成 u-new 在前。
  const rows = [
    homeRow('p-new', 1000, { promptedAt: 3000, updatedAt: 1000 }),
    homeRow('u-new', 3000, { promptedAt: 1000, updatedAt: 3000 }),
    homeRow('run-0', 2000, { promptedAt: 2000, running: true }),
  ]
  const cols = a.homeSessionColumns(rows, {})
  assert.deepEqual(ids(cols.completed), ['u-new', 'p-new'])
  assert.deepEqual(ids(cols.active), ['run-0']) // 左栏仍沿用输入（promptedAt）顺序
})

test('首页：后台会话标记与每栏「剔除后台」过滤', () => {
  const a = loadClientModule()
  const ids = (rows) => rows.map((r) => r.sessionId)
  const rows = [homeRow('bg', 2000, { promptedAt: 2000, background: true }), homeRow('norm', 1000, { promptedAt: 1000 })]
  assert.deepEqual(ids(a.filterBackgroundRows(rows, false)), ['bg', 'norm'])
  assert.deepEqual(ids(a.filterBackgroundRows(rows, true)), ['norm'])
  // 过滤只影响展示：两个会话在 columns 里仍各归其栏，行标记保留
  const cols = a.homeSessionColumns(rows, {})
  assert.deepEqual(ids(cols.completed), ['bg', 'norm'])
  assert.equal(cols.completed[0].background, true)
})

test('首页：会话行状态——未读完成显示已完成（与侧边栏绿点同源同序）', () => {
  const a = loadClientModule()
  // 侧边栏 sessionStatuses 优先级：进行中 > 待处理 > 未读完成 > 空闲；
  // 未读完成 = uiSession.sessionStatus.completionUnread（主视图外结束还没看过，绿点）
  assert.equal(a.sessionRowState({ running: false, waiting: false }, true), 'done')
  assert.equal(a.sessionRowState({ running: true, waiting: false }, true), 'ongoing')
  assert.equal(a.sessionRowState({ running: false, waiting: true }, true), 'warning')
  // 无未读完成或状态源缺失：维持空闲
  assert.equal(a.sessionRowState({ running: false, waiting: false }, false), 'idle')
  assert.equal(a.sessionRowState({ running: false, waiting: false }, undefined), 'idle')
})

test('首页：待交互（审批 / 计划待审 / 待回答）优先于进行中——与侧边栏同源同序', () => {
  const a = loadClientModule()
  // 侧边栏 sessionStatuses：pendingInteraction 是首要状态，压过 running。等待审批的
  // 会话在宿主里仍报 running=true（回合没结束），只看 running 会画成进行中 spinner。
  assert.equal(a.sessionRowState({ running: true, waiting: false }, false, 'approval'), 'warning')
  assert.equal(a.sessionRowState({ running: true, waiting: false }, true, 'plan-review'), 'warning')
  assert.equal(a.sessionRowState({ running: true, waiting: true }, false, 'question'), 'warning')
  // 无待交互时维持既有优先级（进行中 > 待处理 > 未读完成 > 空闲）
  assert.equal(a.sessionRowState({ running: true, waiting: false }, false, null), 'ongoing')
  assert.equal(a.sessionRowState({ running: true, waiting: false }, false), 'ongoing')
  assert.equal(a.sessionRowState({ running: false, waiting: true }, true, null), 'warning')
  assert.equal(a.sessionRowState({ running: false, waiting: false }, true, null), 'done')

  // kind 白名单（DSH visiblePendingKind 同表）：侧边栏不展示的 pending 请求
  // （其它域自带，如 cordis 插件审批）不参与状态判定。
  assert.equal(a.visiblePendingKind('approval'), 'approval')
  assert.equal(a.visiblePendingKind('plan-review'), 'plan-review')
  assert.equal(a.visiblePendingKind('question'), 'question')
  assert.equal(a.visiblePendingKind('plugin-approval'), null)
  assert.equal(a.visiblePendingKind(undefined), null)

  // 行尾紧凑状态文案（与侧边栏 trailingLabel 同表）：待交互时顶掉相对时间。
  assert.equal(a.pendingLabel('approval'), '待审批')
  assert.equal(a.pendingLabel('plan-review'), '计划待审')
  assert.equal(a.pendingLabel('question'), '待回答')
  assert.equal(a.pendingLabel(null), null)
  assert.equal(a.pendingLabel(undefined), null)
  assert.equal(a.pendingLabel('plugin-approval'), null)
})

test('首页：待交互会话恒在活跃列表内——不因 flock/宿主漏判而消失', () => {
  const a = loadClientModule()
  const t = 1_000_000_000
  const ids = (rows) => rows.map((r) => r.sessionId)
  // 待在审批的会话：flock 与宿主都判不出运行（projcache 无该会话时等待也判不出），
  // 但用户正等着回答——必须像侧边栏一样始终保留。
  const rows = [homeRow('run-0', t, { running: true }), homeRow('pend-0', t - 50), homeRow('idle-0', t - 100)]
  const cols = a.homeSessionColumns(rows, {}, new Set(['pend-0']))
  assert.deepEqual(ids(cols.active), ['pend-0', 'run-0'])
  assert.deepEqual(ids(cols.completed), ['idle-0'], '待交互会话不进右栏')
  // 待交互 + 进行中（宿主仍报 running）：按 warning 置顶，不重复、不剔除
  const both = [homeRow('run-1', t, { running: true }), homeRow('pend-run', t - 10, { running: true })]
  assert.deepEqual(ids(a.homeSessionColumns(both, {}, new Set(['pend-run'])).active), ['pend-run', 'run-1'])
  // 不传待交互集合时：pend-0 只是普通空闲会话
  assert.deepEqual(ids(a.homeSessionColumns(rows, {}).active), ['run-0'])
  assert.equal(a.pendingSessionIds({ 'a-0': 'approval', 'b-0': 'plugin-approval' }).has('a-0'), true)
  assert.equal(a.pendingSessionIds({ 'a-0': 'approval', 'b-0': 'plugin-approval' }).has('b-0'), false)
  assert.equal(a.pendingSessionIds(null), null)
})

test('首页：宿主会话状态覆盖 flock 运行判定（与侧边栏同源）', () => {
  const a = loadClientModule()
  // flock 探测=写柄租约：会话在 GUI 里开着即持有，与是否正在产出无关。
  // 宿主会话列表（SessionListState.byId[*].running）是侧边栏 spinner 的数据源，
  // 覆盖后「开着但已结束」的会话不再显示进行中。
  const rows = [
    homeRow('session-open-idle', 1000, { running: true }),   // flock 误报：开着但已结束
    homeRow('session-live', 2000, { running: false }),       // flock 兜底漏报：正在运行
    homeRow('session-unknown', 3000, { running: true }),     // 宿主列表未覆盖 → 保留 flock
  ]
  const overlay = { 'session-open-idle': false, 'session-live': true }
  const out = a.applyRunningOverlay(rows, overlay)
  assert.equal(out[0].running, false)
  assert.equal(out[1].running, true)
  assert.equal(out[2].running, true)
  assert.notEqual(out[0], rows[0]) // 不可变：不原地改行
  assert.equal(a.applyRunningOverlay(rows, null), rows) // 无宿主状态时原样返回
})

test('hover uses the native DSH fill without decorative borders or underlines', () => {
  const homeCss = readFileSync(new URL('../src/client/styles/home.css', import.meta.url), 'utf8')
  for (const selector of ['button.wb-home-card:hover', '.wb-home-more:hover', '.wb-home-srow:hover', '.wb-home-note-row:hover']) {
    const body = homeCss.slice(homeCss.indexOf(selector + '{') + selector.length + 1).split('}')[0]
    assert.match(body, /background:var\(--dsw-alias-interactive-bg-hover,/)
    assert.doesNotMatch(body, /border-color:|text-decoration:|box-shadow:/)
  }
  const sharedCss = readFileSync(new URL('../src/client/styles/workbench.css', import.meta.url), 'utf8')
  assert.match(sharedCss, /button:not\(\.wb-popbackdrop\),a,summary,\[role="button"\]/)
  assert.match(sharedCss, /:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover/)
})


test('row title controls reuse the parent hover fill; independent actions keep their own', () => {
  const css = readFileSync(new URL('../src/client/styles/workbench.css', import.meta.url), 'utf8')
  const exclusions = css.match(/:not\(:where\(([^)]+)\)\):not\(:disabled\)/)?.[1].split(',')
  assert.deepEqual(exclusions, ['.wb-item-top', '.wb-mr-open', '.wb-sk-name', '.wb-home-stitle', '.wb-home-note', '.wb-iss-cell-title'])
  assert.ok(!exclusions.includes('.wb-act'))
  const homeCss = readFileSync(new URL('../src/client/styles/home.css', import.meta.url), 'utf8')
  assert.match(homeCss, /\.wb-workbench \.wb-home-note-row>\.wb-act\{background:transparent\}/)
})

test('首页会话两栏与通知区平分视窗剩余高度', () => {
  const homeCss = readFileSync(new URL('../src/client/styles/home.css', import.meta.url), 'utf8')
  // 规则必须整条命中（同一行、以换行起头），否则前缀相同的选择器会串规则
  const rule = (selector) => {
    const start = homeCss.indexOf('\n' + selector + '{')
    assert.notEqual(start, -1, selector + ' 规则应存在')
    return homeCss.slice(start + selector.length + 2).split('}')[0]
  }
  // 首页根：三行网格（统计卡按内容 + 两条 1fr 轨道平分剩余高度）；底部留白与
  // 区块间距一致
  const home = rule('.wb-home')
  assert.match(home, /--wb-home-content-height:228px/)
  assert.match(home, /--wb-home-block-min:calc\(var\(--wb-home-content-height\) \+ 68px\)/)
  assert.match(home, /display:grid/)
  assert.match(home, /grid-template-rows:auto minmax\(var\(--wb-home-block-min\),1fr\) minmax\(var\(--wb-home-block-min\),1fr\)/)
  assert.match(home, /padding-bottom:20px/)
  // 会话两栏：单行轨道吃满所在网格行，卡片纵向排列、列表在卡内滚动
  const sessions = rule('.wb-home-sessions')
  assert.match(sessions, /grid-template-rows:minmax\(0,1fr\)/)
  assert.match(sessions, /align-items:stretch/)
  assert.match(rule('.wb-home-sessions>.wb-home-sec'), /display:flex;flex-direction:column/)
  const list = rule('.wb-home-slist')
  assert.match(list, /flex:1 1 0/)
  assert.doesNotMatch(list, /max-height:/)
  // 通知区：纵向排列；列表 / 空态吃满剩余高度，不能退回固定高度（否则矮视窗
  // 或错误条出现时撑破卡片）
  assert.match(rule('.wb-home>.wb-home-sec'), /display:flex;flex-direction:column/)
  const notes = rule('.wb-home-notes,.wb-home>.wb-home-sec>.wb-empty')
  assert.match(notes, /flex:1 1 0/)
  assert.match(notes, /min-height:0/)
  assert.doesNotMatch(notes, /(?:^|;)height:var\(--wb-home-content-height\)/)
})

test('首页通知：加载、失败、空列表与点击已读刷新', async () => {
  const { build } = await import('esbuild')
  const slots = [], effects = [], pending = []
  let cursor = 0, tick = 0
  const react = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useRef(init) { const i = cursor++; if (!(i in slots)) slots[i] = { current: init }; return slots[i] },
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = init
      return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }]
    },
    useEffect(fn, deps) {
      const i = cursor++, old = effects[i]
      if (old && deps.every((v, j) => v === old.deps[j])) return
      old?.cleanup?.()
      effects[i] = { deps, cleanup: fn() }
    },
  }
  const result = await build({ entryPoints: ['src/client/components/home.tsx'], bundle: true,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'home-stubs', setup(b) {
      b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: `
        export const forgeFetch=(...args)=>globalThis.__homeFetch(...args);
        export const useShellTick=()=>globalThis.__homeTick();
        export const useNotificationUnread=()=> '0';
        export const useDmsPendingTotal=()=>null;
        export const useHomeSessions=()=>globalThis.__homeSessions||null;
        export const useCompletionUnreadIds=()=>null;
        export const useSessionPendingKinds=()=>null;
        export const useSessionRunningIds=()=>null;
        export const useWorkspaceTitles=()=>null;
        export const refreshHomeSessions=(...args)=>globalThis.__homeRefresh?.(...args);
        export const refreshNotificationUnread=()=>{};
        export const getNotificationItems=()=>null;
        export const fetchUnreadNotifications=()=>globalThis.__homeFetch("/notifications/list?host=github.com&all=false&page=1");
        export const applyNotificationUnread=d=>{ (globalThis.__homeUnreadApplied=globalThis.__homeUnreadApplied||[]).push(d); };
        export const loadForgeView=()=>({});
        export const openSessionInMain=()=>{};
      `, loader: 'js' }))
      b.onLoad({ filter: /src\/client\/features\.ts$/ }, () => ({ contents: 'export const useFeatureFlags=()=>({notifications:true});', loader: 'js' }))
    } }],
  })
  const requests = []
  globalThis.__homeFetch = (...args) => { requests.push(args); return new Promise(resolve => pending.push(resolve)) }
  globalThis.__homeTick = () => tick
  const mod = { exports: {} }
  Function('require', 'module', 'exports', 'setInterval', 'clearInterval', result.outputFiles[0].text)(
    name => name === 'react' ? react : {}, mod, mod.exports, () => 1, () => {})
  const render = () => { cursor = 0; return mod.exports.HomePanel({ active: true }) }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const titles = tree => nodes(tree).map(n => n.props.title)
  try {
    globalThis.__homeUnreadApplied = []
    render()
    assert.ok(titles(render()).includes('加载通知…'))
    pending.shift()({ ok: false, error: '查询失败' })
    await flush()
    let tree = render()
    assert.ok(nodes(tree).some(n => n.props.role === 'alert' && n.children.includes('查询失败')))
    assert.ok(!titles(tree).includes('暂无未读通知'))
    assert.deepEqual(globalThis.__homeUnreadApplied, [], '失败响应不喂计数')
    tick++
    render()
    const listResponse = { ok: true, items: [] }
    pending.shift()(listResponse)
    await flush()
    tree = render()
    assert.ok(titles(tree).includes('暂无未读通知'))
    assert.ok(!titles(tree).includes('加载通知…'))
    assert.ok(!nodes(tree).some(n => n.props.role === 'alert'))
    // 列表响应必须同步喂共享未读数：统计卡/徽标与列表同源，不再各说各话
    assert.deepEqual(globalThis.__homeUnreadApplied, [listResponse])
    for (const click of ['onClick', 'onAuxClick', 'markRead']) {
      tick++
      render()
      const item = { id: '123', unread: true, title: '通知', url: 'https://github.com/a/b/issues/1' }
      pending.shift()({ ok: true, items: [item] })
      await flush()
      const link = nodes(render()).find(n => n.props.className?.includes('wb-home-note-unread'))
      assert.equal(link.props.href, item.url)
      if (click === 'onAuxClick') {
        const count = requests.length
        link.props.onAuxClick({ button: 2 })
        assert.equal(requests.length, count, '右键不标为已读')
      }
      if (click === 'markRead') {
        const button = nodes(render()).find(n => n.children.includes('标为已读'))
        assert.equal(button.type, 'button')
        assert.equal(nodes(link).some(n => n.type === 'button'), false, '操作按钮不嵌套在链接内')
        button.props.onClick()
        assert.equal(nodes(render()).find(n => n.children.includes('标为已读')).props.disabled, true)
      } else link.props[click]({ button: 1 })
      assert.deepEqual(requests.at(-1), ['/notifications/action', { method: 'POST', body: { host: 'github.com', id: '123', action: 'read' } }])
      pending.shift()({ ok: true })
      await flush()
      tree = render()
      assert.ok(!titles(tree).includes('加载通知…'), '已读后后台同步，不切换整块列表为加载态')
      assert.ok(nodes(tree).some(n => n.props.href === item.url), '同步期间保留通知行')
      assert.equal(requests.at(-1)[0], '/notifications/list?host=github.com&all=false&page=1')
      const refreshed = { ok: true, items: [] }
      pending.shift()(refreshed)
      await flush()
      assert.ok(titles(render()).includes('暂无未读通知'))
      assert.equal(globalThis.__homeUnreadApplied.at(-1), refreshed)
    }


    const history = Array.from({ length: 23 }, (_, i) => homeRow('history-' + i, 1000 - i))
    const loads = []
    globalThis.__homeSessions = { sessions: history.slice(0, 10), hasMore: true }
    globalThis.__homeRefresh = async (_force, limit) => {
      loads.push(limit)
      return globalThis.__homeSessions = { sessions: history.slice(0, limit), hasMore: limit < history.length }
    }
    const completed = () => nodes(render()).find(n => n.props.className === 'wb-home-sessions').children[1]
    const scroll = () => nodes(completed()).find(n => n.props.className === 'wb-home-slist').props.onScroll({
      currentTarget: { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 },
    })
    const rows = () => nodes(completed()).filter(n => n.props.row).length
    assert.equal(rows(), 10)
    assert.ok(!nodes(completed()).some(n => n.props.className === 'wb-home-sec-badge'))
    scroll(); scroll()
    await flush()
    assert.deepEqual(loads, [20], '重复滚动只加载一次')
    assert.equal(rows(), 20)
    scroll(); await flush()
    assert.equal(rows(), 23)
    scroll(); await flush()
    assert.deepEqual(loads, [20, 30], '最后一批后停止请求')

  } finally {
    delete globalThis.__homeSessions
    delete globalThis.__homeRefresh
    delete globalThis.__homeFetch
    delete globalThis.__homeTick
    delete globalThis.__homeUnreadApplied
  }
})
