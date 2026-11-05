// Workbench behavior simulation on the built client bundle.
// Uses a minimal React runtime and stubbed host APIs to exercise navigation,
// request scoping and races, confirmation flows, queries, and saved settings.
// Assert user-visible outcomes and side effects; layout and icon geometry
// require a real browser and are outside this simulation's scope.

import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8')

let failures = 0
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + JSON.stringify(extra ?? null)))
  if (!cond) failures++
}

// ── mini react ───────────────────────────────────────────────────────────────
// Hook slots are scoped PER COMPONENT by its tree path (real React positions
// hooks per fiber), not by one global sequence: mounting a hook-ful subtree
// mid-run (the MR detail view) must not shift the slots of components rendered
// after it. expand() maintains the path stack while it calls components.
let effectQueue = []
let renderScheduled = false
let renderFn = null

const hookTables = new Map() // tree path → that component's hook slot array
const hookPath = ['root']
function tableFor() {
  const p = hookPath.join('/')
  let t = hookTables.get(p)
  if (!t) hookTables.set(p, t = [])
  return t
}

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...kids) {
    const children = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false && k !== true)
    return { type, props: props || {}, children }
  },
  // Context stub: the bundle's ToastProvider publishes via
  // h(ToastContext.Provider, { value }, children) and reads via useContext.
  // Provider is expanded like a function component, so it must return a node
  // (not the raw children array) for expand() to recurse into the subtree.
  createContext(defaultValue) {
    const ctx = { value: defaultValue }
    ctx.Provider = function ContextProvider(props) {
      ctx.value = props.value
      return React.createElement(React.Fragment, null, props.children)
    }
    ctx.Consumer = function ContextConsumer(props) {
      return typeof props.children === 'function' ? props.children(ctx.value) : null
    }
    return ctx
  },
  useContext(ctx) {
    const value = ctx ? ctx.value : undefined
    // The mini renderer re-expands the whole tree on every effect-driven pass;
    // real React bails out when a Provider's children element is referentially
    // unchanged. With the real publish() that means ToastLayer's layout effect
    // would push a new entries array every pass and never settle. The sim has no
    // toast assertions, so keep the context shape but stub publish as a no-op.
    if (value && typeof value === 'object' && typeof value.publish === 'function') {
      return Object.assign({}, value, { publish: () => {} })
    }
    return value
  },
  useState(init) {
    const t = tableFor()
    const i = t.idx || 0; t.idx = i + 1
    if (!t[i]) t[i] = { v: typeof init === 'function' ? init() : init }
    const set = (nv) => {
      const next = typeof nv === 'function' ? nv(t[i].v) : nv
      if (next !== t[i].v) { t[i].v = next; schedule() }
    }
    return [t[i].v, set]
  },
  useRef(init) {
    const t = tableFor()
    const i = t.idx || 0; t.idx = i + 1
    if (!t[i]) t[i] = { v: { current: init } }
    return t[i].v
  },
  useCallback(fn, deps) {
    return React.useMemo(() => fn, deps)
  },
  useMemo(fn, deps) {
    const t = tableFor()
    const i = t.idx || 0; t.idx = i + 1
    const prev = t[i]
    const changed = !prev || !deps || !prev.deps ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    if (changed) t[i] = { v: fn(), deps }
    return t[i].v
  },
  useLayoutEffect(fn, deps) {
    // real deps semantics: skip re-run when deps are unchanged, run previous
    // cleanup first (the bundle passes deps arrays to useLayout)
    const t = tableFor()
    const i = t.idx || 0; t.idx = i + 1
    const prev = t[i]
    const changed = !prev || !deps || !prev.deps ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    t[i] = { deps, cleanup: prev && prev.cleanup }
    if (changed) effectQueue.push(() => {
      if (typeof t[i].cleanup === 'function') { try { t[i].cleanup() } catch (e) {} }
      t[i].cleanup = fn()
    })
  },
  useEffect(fn, deps) {
    const t = tableFor()
    const i = t.idx || 0; t.idx = i + 1
    const prev = t[i]
    const changed = !prev || !deps || !prev.deps ||
      deps.length !== prev.deps.length || deps.some((d, k) => d !== prev.deps[k])
    t[i] = { deps, cleanup: prev && prev.cleanup }
    if (changed) effectQueue.push(() => {
      if (typeof t[i].cleanup === 'function') { try { t[i].cleanup() } catch (e) {} }
      t[i].cleanup = fn()
    })
  },
}

function schedule() {
  if (!renderScheduled) { renderScheduled = true; queueMicrotask(pass) }
}

// The mini react keeps refs inert (useRef returns the object, but a `ref` prop
// is never attached). Attach them here right after renderFn() — before layout
// effects run, mirroring real React's commit order — so components that read
// their own ref (the scroll containers in ForgePanel/IssuesView) see the live
// node. Host-element nodes carry a `.scrollTop` property the components set;
// nothing else models the real DOM.
// scrollTop 按 ref 对象在 pass 间流转：真实 DOM 里列表/详情复用同一个滚动
// 节点，React 换 className 不会重置 scrollTop（这正是「详情残留列表滚动位置」
// 的成因）；逐 pass 重建 vdom 的模拟器用 ref → 上次 scrollTop 的映射把这一
// 行为补回来，滚动回归断言（详情置顶 / 返回恢复）才能在模拟器里成立。
const refScroll = new Map()
function attachRefs(el) {
  if (el === null || el === undefined || typeof el !== 'object') return
  const ref = el.props && el.props.ref
  if (ref) {
    if (typeof ref === 'function') ref(el)
    else {
      const prev = ref.current
      if (prev && typeof prev.scrollTop === 'number') refScroll.set(ref, prev.scrollTop)
      ref.current = el
      if (refScroll.has(ref)) el.scrollTop = refScroll.get(ref)
    }
  }
  const kids = el.children || []
  for (const c of kids) attachRefs(c)
}

async function pass() {
  renderScheduled = false
  for (const t of hookTables.values()) t.idx = 0
  renderFn()
  attachRefs(root)
  const fns = effectQueue
  effectQueue = []
  for (const f of fns) { try { f() } catch (e) {} }
}

const tick = () => new Promise((r) => setTimeout(r, 2))

// ── localStorage stub (Map-backed; the bundle guards every access) ──────────
const lsStore = new Map()
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
}

// ── confirm() stub ───────────────────────────────────────────────────────────
// The styled .wb-modal dialog replaced every native confirm(); the counter must
// stay 0 through the whole sim (a call would also crash a real headless run).
let confirmCalls = 0
globalThis.confirm = () => { confirmCalls++; return true }

// ── fetch stub (identical payload object per URL → setState bails, settles) ─
const fetchLog = []
const payloads = new Map()
const held = new Map() // url prefix → resolvers of in-flight responses

function releaseHeld(prefix) {
  for (const [p, waiters] of held) {
    if (p === prefix) for (const w of waiters.splice(0)) w()
  }
}
function mkStateMr(scope, which) {
  return {
    num: 100, title: 'MR[' + scope + '@repo-' + which + ']', state: 'opened', author: 'alice',
    source_branch: 'f', target_branch: 'm', labels: [], comment_count: 0,
    web_url: 'https://gitlab.test/grp/repo-' + which + '/-/merge_requests/100',
  }
}
function payloadFor(url) {
  const u = new URL(url)
  const p = u.pathname
  if (p === '/forge/workspaces') {
    return {
      ok: true, updatedAt: Date.now(),
      forges: {
        gitlab: { available: true, hosts: [{ host: 'gitlab.example.com', user: 'alice' }] },
        github: { available: false, hosts: [] },
      },
      workspaces: [
        { id: '/ws/a', path: '/ws/a', title: 'a', repoPath: 'grp/repo-a', host: 'gitlab.example.com', branch: 'main', user: 'alice', forge: 'gitlab' },
        { id: '/ws/b', path: '/ws/b', title: 'b', repoPath: 'grp/repo-b', host: 'gitlab.example.com', branch: 'dev', user: 'alice', forge: 'gitlab' },
      ],
      detected: [],
    }
  }
  if (p === '/home/sessions') {
    const mk = (sessionId, cwd, title, promptedAt, extra) => Object.assign({
      sessionId, cwd, title, createdAt: promptedAt, promptedAt,
      // updatedAt（最近任意活动）缺省跟随 promptedAt；extra 可单独拨新以模拟
      // 「刚有助手/后台活动但用户没再提问」的侧边栏同源口径。
      updatedAt: promptedAt,
      running: false, waiting: false, blank: false, child: false,
      userMsgs: 1, assistantMsgs: 0, turns: 1, toolCalls: 0, preset: 'workspace-write',
    }, extra || {})
    const running = [
      mk('session-r1', '/ws/a', '评审 !123 feat(core)', Date.now() - 2 * 60 * 1000, { running: true, userMsgs: 3, turns: 2, toolCalls: 5 }),
      mk('session-r2', '/home/user/proj/ai-agent', '处理 #45 登录超时', Date.now() - 5 * 60 * 1000, { running: true }),
    ]
    const waiting = [
      mk('session-w1', '/ws/a', '重构技能预览为详情页', Date.now() - 3 * 3600 * 1000, { waiting: true, userMsgs: 20, turns: 4, toolCalls: 40 }),
    ]
    const recent = [
      // c1：1 分钟前有活动（updatedAt）但最后提问在 10 分钟前（promptedAt）——
      // 行尾时间必须显示 10 分钟前（与侧边栏一致），不能被活动拨新成 1 分钟前。
      mk('session-c1', '/ws/a', 'SLS 日志查询 trace 下钻', Date.now() - 10 * 60 * 1000, { userMsgs: 6, turns: 3, toolCalls: 9, updatedAt: Date.now() - 60 * 1000 }),
      mk('session-c2', '/ws/b', '补齐 DMS 工单审批注释', Date.now() - 10 * 3600 * 1000, { userMsgs: 2, turns: 1, toolCalls: 1 }),
      // p1：宿主两个信号都没判出「在等你」（非运行、非待处理），但客户端 uiSession
      // 说它有待交互（提问待回答）——必须留在活跃列表里（老会话 projcache 无统计）。
      mk('session-p1', '/ws/b', '补充 SLS 查询文档', Date.now() - 20 * 60 * 1000, { userMsgs: 4, turns: 2, toolCalls: 3 }),
    ]
    return {
      ok: true, updatedAt: Date.now(),
      sessions: [...running, ...waiting, ...recent],
      groups: { running, waiting, recent },
      counts: { running: 2, waiting: 1, recent24h: 6 },
      skipped: 0,
    }
  }
  if (p === '/forge/reviews') return { ok: true, supported: false, defaults: { trigger: 'first', model: '' }, repo: null, tasks: [] }
  if (p === '/forge/reviews/start') return { ok: false, unsupported: true }
  if (p === '/forge/state') {
    const cwd = u.searchParams.get('cwd') || ''
    const which = cwd === '/ws/b' ? 'b' : 'a'
    return {
      ok: true, updatedAt: Date.now(),
      repo: { root: cwd || '/ws/a', path: 'grp/repo-' + which, branch: which === 'b' ? 'dev' : 'main', dirtyCount: 0, lastCommitTitle: 't', forge: 'gitlab' },
      // /forge/state inlines the three MR tabs; the client no longer calls /forge/mrs.
      myOpen: [mkStateMr('mine', which)], reviewRequests: [mkStateMr('review', which)], allOpen: [mkStateMr('all', which)], branchMR: [],
      viewer: { username: 'alice', name: 'alice' },
    }
  }
  if (p === '/forge/mrs') {
    const cwd = u.searchParams.get('cwd') || ''
    const scope = u.searchParams.get('scope') || 'all'
    const which = cwd === '/ws/b' ? 'b' : 'a'
    return {
      ok: true, updatedAt: Date.now(),
      mrs: [{ num: 100, title: 'MR[' + scope + '@repo-' + which + ']', state: 'opened', author: 'alice', source_branch: 'f', target_branch: 'm', labels: [], comment_count: 0 }],
    }
  }
  if (p === '/dms/status') {
    return {
      ok: true, updatedAt: Date.now(),
      cli: { available: true, configured: true, activeRegion: 'cn-hangzhou', profiles: [{ name: 'OAuthProfile', active: true, valid: true, region: 'cn-hangzhou' }], error: null },
    }
  }
  if (p === '/dms/orders') {
    return {
      ok: true, updatedAt: Date.now(),
      orders: [
        {
          orderId: '7001', pluginType: 'DATA_CHANGE', statusCode: 'toaudit', statusDesc: '审批中',
          workflowInstanceId: '9101', committer: 'zhangsan',
          createTime: '2026-09-17 10:00:00', lastModifyTime: '2026-09-17 10:00:00',
          comment: '工单[待审批@7001]', relatedUsers: [], attachmentName: null,
        },
        {
          orderId: '7002', pluginType: 'PERM_APPLY', statusCode: 'toaudit', statusDesc: '审批中',
          workflowInstanceId: '9102', committer: 'bob',
          createTime: '2026-09-18 10:00:00', lastModifyTime: '2026-09-18 10:00:00',
          comment: '工单[权限申请@7002]', relatedUsers: [], attachmentName: null,
        },
        {
          orderId: '7003', pluginType: 'DATA_EXPORT', statusCode: 'toaudit', statusDesc: '审批中',
          workflowInstanceId: '9103', committer: 'wangwu',
          createTime: '2026-09-19 10:00:00', lastModifyTime: '2026-09-19 10:00:00',
          comment: '工单[结果集导出@7003]', relatedUsers: [], attachmentName: null,
        },
      ],
      totalCount: 3, page: 1, pageSize: 50, resultType: 'AS_HANDLER',
    }
  }
  if (p === '/dms/order') {
    const id = u.searchParams.get('id')
    const orders = {
      '7001': {
        orderId: '7001', pluginType: 'DATA_CHANGE', statusCode: 'toaudit', statusDesc: '审批中',
        workflowStatusDesc: '', workflowInstanceId: '9101', committer: 'zhangsan',
        createTime: '2026-09-17 10:00:00', lastModifyTime: '2026-09-17 10:00:00',
        comment: '工单[待审批@7001]', relatedUsers: [], attachmentName: null,
      },
      '7002': {
        orderId: '7002', pluginType: 'PERM_APPLY', statusCode: 'toaudit', statusDesc: '审批中',
        workflowStatusDesc: '', workflowInstanceId: '9102', committer: 'bob',
        createTime: '2026-09-18 10:00:00', lastModifyTime: '2026-09-18 10:00:00',
        comment: '工单[权限申请@7002]', relatedUsers: [], attachmentName: null,
      },
      '7003': {
        orderId: '7003', pluginType: 'DATA_EXPORT', statusCode: 'toaudit', statusDesc: '审批中',
        workflowStatusDesc: '', workflowInstanceId: '9103', committer: 'wangwu',
        createTime: '2026-09-19 10:00:00', lastModifyTime: '2026-09-19 10:00:00',
        comment: '工单[结果集导出@7003]', relatedUsers: [], attachmentName: null,
      },
    }
    return { ok: true, updatedAt: Date.now(), order: orders[id] || orders['7001'] }
  }
  if (p === '/dms/order/sql') {
    const type = u.searchParams.get('type')
    // 权限申请工单（PERM_APPLY）没有 SQL：host 回 apply 申请内容（真实
    // GetPermApplyOrderDetail 形状的归一化结果）。
    if (type === 'PERM_APPLY') {
      return {
        ok: true, supported: true, type: 'PERM_APPLY', sql: null,
        apply: {
          applyType: 'COL', applyTypeLabel: '列权限', permType: 1, permTypeLabel: '查询',
          seconds: 15552000, durationLabel: '180 天', resourceCount: 1,
          resources: [{ label: 'shop_db@rm-example.mysql.rds.aliyuncs.com:3306 · t_order.address', meta: 'MYSQL · 生产' }],
        },
      }
    }
    // SQL 结果集导出（DATA_EXPORT）：有 SQL 也有 facts，客户端要同时渲染
    // 「SQL 脚本」块和「工单内容」卡。
    if (type === 'DATA_EXPORT') {
      return {
        ok: true, supported: true, type: 'DATA_EXPORT',
        sql: 'SELECT * from `t_order`', facts: [
          { k: '数据库', v: 'test_db@10.0.0.1:3306 [databaseproxy_1]（生产）' },
          { k: '导出原因', v: '数据分析' },
          { k: '影响行数', v: '201 行' },
          { k: '导出状态', v: '导出成功' },
        ],
      }
    }
    // 真实 GetDataCorrectOrderDetail 形状：SqlType=TEXT 时 OrderDetail.ExeSQL
    // 是 SQL 正文，RbSQL='empty' 表示未提供回滚 SQL。
    return {
      ok: true, supported: true, type: 'DATA_CHANGE',
      sql: 'update t1 set name = \'x\' where id <= 100;',
      rollbackSql: null, attachmentName: null,
      facts: [{ k: '变更类型', v: '普通数据变更' }],
    }
  }
  if (p === '/forge/mr') {
    return {
      ok: true,
      mr: { num: 100, title: 'MR[all@repo-b]', description: 'MR 描述[fix NPE]', state: 'opened', author: 'alice', source_branch: 'f', target_branch: 'm', labels: ['fix', 'review'], comment_count: 2, reviewRequests: ['alice'], created_at: new Date(Date.now() - 16 * 3600_000).toISOString(), updated_at: new Date(Date.now() - 12 * 3600_000).toISOString(), mergeable: 'mergeable', web_url: 'https://gitlab.test/grp/repo-b/-/merge_requests/100', notes: [
        { author: 'alice', body: '评论一', created_at: new Date(Date.now() - 3600_000).toISOString() },
        { author: 'bob', body: '评论二', created_at: new Date(Date.now() - 1800_000).toISOString() },
      ] },
    }
  }
  if (p === '/forge/mr/diff') {
    // glab mr diff 真实形状：GitLab API per-file diff 拼接（无 diff --git、
    // 无 a/ b/ 前缀，只有 --- 全路径 / +++ 全路径）
    return {
      ok: true,
      diff: [
        '--- src/foo.java',
        '+++ src/foo.java',
        '@@ -1,3 +1,4 @@',
        ' context',
        '-old line',
        '+new line',
        '+added line',
        ' context2',
        '--- README.md',
        '+++ README.md',
        '@@ -1,1 +1,2 @@',
        ' title',
        '+new readme line',
      ].join('\n') + '\n',
    }
  }
  if (p === '/pingcode/status') {
    return {
      ok: true, updatedAt: Date.now(),
      python: { available: true },
      skill: { found: true, dir: '/Users/user/.agents/skills/pingcode', scriptFound: true, error: null },
      env: { authMode: 'authorization_code', clientCredentials: false, userCredentials: true, accessToken: true, baseUrlConfigured: false, baseUrl: 'https://open.pingcode.com' },
      probe: { ok: true, error: null, projectTotal: 2 },
    }
  }
  if (p === '/pingcode/projects') {
    return { ok: true, updatedAt: Date.now(), total: 2, projects: [
      { id: 'proj0001', name: '敏捷示例项目', type: 'scrum', state: '进行中', assignee: '张三', description: '' },
      { id: 'proj0002', name: '官网重构', type: 'kanban', state: '进行中', assignee: '李四', description: '' },
    ] }
  }
  if (p === '/pingcode/members') {
    return { ok: true, updatedAt: Date.now(), total: 2, members: [
      { id: 'user0001', name: 'alice', displayName: 'Alice', email: '' },
      { id: 'user0002', name: 'bob', displayName: 'Bob', email: '' },
    ] }
  }
  if (p === '/pingcode/workitems') {
    // 分页夹具（真实分页语义：每页 min(pageSize,total) 条）。服务端状态过滤
    // 后：pending 153 条（page1 100 + page2 53）、progress 2 条、all 155 条
    // （2 progress + 153 pending）。stats 是服务端五桶精确统计（挂起独立成桶，
    // 不再计入待处理）。
    const page = Number(u.searchParams.get('page') || '1')
    const st = u.searchParams.get('stateType') || ''
    const asg = { id: 'user0001', name: 'alice', displayName: 'Alice' }
    const proj = { id: 'proj0001', name: '敏捷示例项目', identifier: 'SCR' }
    const mk = (i, stateType, title) => ({
      id: 'wi' + String(i).padStart(6, '0'), identifier: 'SCR-' + i, title, type: 'task',
      stateName: stateType === 'pending' ? '待处理' : (stateType === 'suspended' ? '挂起' : '进行中'), stateType,
      stateColor: stateType === 'pending' ? '#ff7575' : (stateType === 'suspended' ? '#e0685f' : '#f5a623'), priority: '普通',
      assignee: asg, project: proj, htmlUrl: '', description: '', startAt: null, endAt: null, completedAt: null,
    })
    const rows = []
    if (st === 'progress') {
      rows.push(mk(1, 'progress', '优化登录性能[PC]'))
      rows.push(mk(2, 'progress', '接口文档更新[PC]'))
    } else if (st === 'suspended') {
      rows.push(mk(201, 'suspended', '挂起项A[PC]'))
      rows.push(mk(202, 'suspended', '挂起项B[PC]'))
    } else if (st === 'pending') {
      if (page <= 1) { for (let i = 3; i <= 102; i++) rows.push(mk(i, 'pending', '批量工作项' + i + '[PC]')) }
      else { for (let i = 103; i <= 155; i++) rows.push(mk(i, 'pending', '批量工作项' + i + '[PC]')) }
    } else if (page <= 1) {
      rows.push(mk(1, 'progress', '优化登录性能[PC]'))
      rows.push(mk(2, 'progress', '接口文档更新[PC]'))
      for (let i = 3; i <= 100; i++) rows.push(mk(i, 'pending', '批量工作项' + i + '[PC]'))
    } else {
      for (let i = 101; i <= 155; i++) rows.push(mk(i, 'pending', '批量工作项' + i + '[PC]'))
    }
    return {
      ok: true, updatedAt: Date.now(),
      total: st === 'progress' ? 2 : (st === 'suspended' ? 2 : (st === 'pending' ? 153 : 155)),
      page, pageSize: 100,
      me: { id: 'user0001', name: 'alice', displayName: 'Alice' },
      stats: { pending: 153, suspended: 2, progress: 2, completed: 0, closed: 0 },
      workitems: rows,
    }
  }
  if (p === '/pingcode/workitem') {
    return {
      ok: true, updatedAt: Date.now(),
      workitem: {
        id: 'wi000001', identifier: 'SCR-101', title: '优化登录性能[PC]', type: 'task',
        stateName: '进行中', stateType: 'progress', stateColor: '#f5a623', priority: '高',
        assignee: { id: 'user0001', name: 'alice', displayName: 'Alice' },
        project: { id: 'proj0001', name: '敏捷示例项目', identifier: 'SCR' },
        htmlUrl: 'https://pc.example.com/pjm/workitems/abc',
        description: '登录页首屏优化，缓存 token 校验结果。',
        startAt: null, endAt: Date.now() + 86400000, completedAt: null,
        notes: [{ id: 'c0001', author: '李四', content: '已复现，优先处理', created_at: Date.now() - 3600000, isReply: false }],
      },
    }
  }
  if (p === '/sls/status') {
    // SLS 页与 DMS 共用同一个 aliyun 凭证探测；environments 来自插件行 config
    // 的 slsEnvironments（host 解析后给客户端渲染环境下拉）。
    return {
      ok: true, updatedAt: Date.now(),
      cli: { available: true, configured: true, activeRegion: 'cn-hangzhou', profiles: [], error: null },
      environments: [
        { key: 'prod', label: '生产环境', project: 'demo-prod-logs', logstore: 'demo-prod-traces', logs: 'demo-prod-logs' },
        { key: 'test', label: '测试环境', project: 'demo-test-logs', logstore: 'demo-test-traces', logs: 'demo-test-logs' },
      ],
    }
  }
  if (p === '/sls/query') {
    // 真实 get-logs-v2 形状：span 数据（duration 单位 µs，start/end epoch 微秒，
    // host 与 __source__ 常同值，attribute 是字符串化 JSON，DB span 带 db.* 字段）
    return {
      ok: true, count: 2, progress: 'Complete', elapsedMs: 231, keys: [],
      logs: [
        { __time__: '1789872058', __source__: '10.0.0.1', __topic__: '', host: '10.0.0.1',
          name: 'POST /api/orders/42', service: 'order-service', kind: 'server',
          statusCode: 'Error', duration: '60000000', start: '1789872058123456', end: '1789872118123456',
          attribute: '{"http.method":"POST","user_agent":"Mozilla/5.0","db.operation":"SELECT","db.sql.table":"t_order","db.connection_string":"mysql://db.example.com:3306","db.statement":"SELECT id, order_no, status, created_at FROM t_order WHERE id = 42 AND status = 1","thread.name":"http-nio-8080-exec-7","server.address":"db.example.com"}',
          traceID: '8a0c282911823ab591d48337c3c90f55', spanID: 'sp1', parentSpanID: '' },
        { __time__: '1789872058', __topic__: '',
          name: 'INSERT t_order_item', service: 'order-service', kind: 'client',
          statusCode: 'Ok', duration: '3440', start: '1789872058200000', end: '1789872058203440',
          traceID: '8a0c282911823ab591d48337c3c90f55', spanID: 'sp2', parentSpanID: 'sp1' },
      ],
    }
  }
  if (p === '/forge/issues') {
    const scope = u.searchParams.get('scope') || 'all'
    return {
      ok: true, updatedAt: Date.now(), forge: 'gitlab',
      issues: [
        {
          forge: 'gitlab', num: 128, title: 'Issue[' + scope + ']', description: '登录后长时间使用时 Token 会提前过期，需要排查刷新逻辑',
          state: 'opened', state_reason: null, web_url: 'https://gitlab.test/grp/repo-a/-/issues/128',
          author: { username: 'alice', name: 'Alice', avatar: '' }, assignees: [{ username: 'bob', name: 'Bob', avatar: '' }],
          labels: ['Bug', 'High'], created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', closed_at: null,
          comment_count: 12, mr_count: 1,
          related: [{ num: 142, title: 'fix: token refresh', state: 'opened', web_url: 'https://gitlab.test/grp/repo-a/-/merge_requests/142' }],
        },
        {
          forge: 'gitlab', num: 126, title: 'Issue[closed]', description: '', state: 'closed', state_reason: 'completed',
          web_url: 'https://gitlab.test/grp/repo-a/-/issues/126', author: { username: 'wangjing', name: '王静', avatar: '' },
          assignees: [], labels: [], created_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-19T10:00:00Z', closed_at: '2026-09-19T10:00:00Z',
          comment_count: 0, mr_count: 0,
        },
      ],
      total: 2, hasMore: false, page: 1, pageSize: 20,
    }
  }
  if (p === '/forge/issue') {
    const num = u.searchParams.get('num') || '0'
    return {
      ok: true,
      issue: {
        forge: 'gitlab', num: Number(num), title: 'Issue#' + num + ' 详情标题', description: 'Issue 描述[markdown]',
        state: 'opened', state_reason: null, web_url: 'https://gitlab.test/grp/repo-a/-/issues/' + num,
        author: { username: 'alice', name: 'Alice', avatar: '' }, assignees: [{ username: 'bob', name: 'Bob', avatar: '' }],
        labels: ['Bug'], created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-20T10:00:00Z', closed_at: null,
        comment_count: 1, mr_count: 1,
        notes: [{ author: 'alice', body: 'issue 评论', created_at: '2026-09-19T10:00:00Z' }],
        related: [{ num: 142, title: 'fix: token refresh', state: 'opened', web_url: 'https://gitlab.test/grp/repo-a/-/merge_requests/142' }],
      },
    }
  }
  if (p === '/forge/issue/meta') {
    return {
      ok: true, forge: 'gitlab', updatedAt: Date.now(),
      stats: { open: 24, closed: 128, assignedOpen: 6 },
      labels: [{ name: 'Bug', color: '#D6393F' }, { name: 'High', color: '#fc6d26' }],
      members: [{ username: 'alice', name: 'Alice' }, { username: 'bob', name: 'Bob' }],
      viewer: { username: 'alice', name: 'Alice' },
    }
  }
  if (p === '/notifications/list') {
    // 通知桩：2 条未读（首页通知区 / GitHub 未读卡 / 通知列表页共用；hasMore=false
    // → 未读数=2，不出现 50+ 徽标口径）。标题避开会话行标题，免得撞上首页文本顺序断言。
    return {
      ok: true, items: [
        { id: '1001', title: 'fix: 登录跳转失效', repo: 'grp/repo-a', type: 'PullRequest', reason: 'review_requested', unread: true, updatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), url: 'https://github.com/grp/repo-a/pull/12' },
        { id: '1002', title: 'docs: 补充部署说明', repo: 'grp/repo-b', type: 'Issue', reason: 'mention', unread: true, updatedAt: new Date(Date.now() - 5 * 3600 * 1000).toISOString(), url: 'https://github.com/grp/repo-b/issues/7' },
      ], hasMore: false,
    }
  }
  return { ok: true }
}

globalThis.fetch = async (input) => {
  const url = String(input)
  fetchLog.push(url)
  if (!payloads.has(url)) payloads.set(url, payloadFor(url))
  const body = payloads.get(url)
  for (const [prefix, waiters] of held) {
    if (url.includes(prefix)) await new Promise((res) => waiters.push(res))
  }
  return { ok: true, status: 200, json: async () => body }
}

// ── evaluate the bundle factory ──────────────────────────────────────────────
let factory = null
const windowStub = {
  __ModuleLoader__: { load: (def) => { factory = def.factory } },
}
const setIntervalStub = () => ({ unref() {} })
const clearIntervalStub = () => {}
const Fn = Function
Fn('require', 'window', 'setInterval', 'clearInterval', src)(
  (spec) => { if (spec === 'react') return React; throw new Error('unexpected require ' + spec) },
  windowStub, setIntervalStub, clearIntervalStub,
)
if (!factory) throw new Error('factory not captured')

const registry = new Map()
// MarkdownText stub: the real primitive needs real React internals (memo +
// useMemo over the mdast pipeline) that mini react does not implement; the
// stub records the contract our glue must forward — text, streaming=false.
function MdStub(props) {
  return React.createElement('div', {
    'data-md-stub': '1',
    'data-md-text': props.text,
    'data-md-streaming': props.streaming === true ? '1' : '0',
  }, props.text)
}
const modTable = {
  react: React,
  '@deepseek-ai/dsh-client-ui-primitives': { Tooltip: null, MarkdownText: MdStub },
}
const plugin = factory((spec) => {
  if (spec in modTable) return modTable[spec]
  throw new Error('module not shared: ' + spec)
})
// apply with stub ctx: capture slot components. Key by slot name + entry id
// (the shell dispatches within a slot; "workbench" exists both as a
// panellist id and as the main key, so the bare id would collide).
// ── 会话启动桩（MR/PR「评审」与 Issue「处理」共用的 uiWorkspace + sessions 契约）──
// startItemSession 在点击时经 ctx.get('uiWorkspace') 解析服务、经
// ctx.get('sessions') 的 retain() 物化新会话 scope；这里按真实契约打桩并记录
// 调用，用来断言「点击 → 新建会话 → 提交提示词」的完整链路。
const sessionCalls = { connected: [], prompts: [], renamed: [], opened: [], released: 0 }
const sessionStub = {
  prompt: async (parts, mode, requestId) => {
    sessionCalls.prompts.push({ text: parts.map((p) => p.text).join(''), mode, requestId })
    return { ok: true, requestId }
  },
  beginSubmission: (o) => { sessionCalls.echo = o; return { requestId: 'req-sim' } },
  rename: async (t) => { sessionCalls.renamed.push(t); return { ok: true } },
}
const sessionsStub = {
  // 宿主会话列表（SessionListState）：侧栏计数走这里。刻意混入首页不展示的行——
  // 两个子会话（teammate：mate-running 在跑、mate-done 未读完成）与一个空白会话
  // （blank-idle）——侧栏必须把它们剔除，否则「进行中 / 未读完成」会多于首页两栏。
  list: {
    getSnapshot: () => ({
      ids: ['session-r1', 'session-r2', 'session-p1', 'session-c1', 'mate-running', 'mate-done', 'blank-idle'],
      byId: {
        'session-r1': { id: 'session-r1', running: true, blank: false },
        'session-r2': { id: 'session-r2', running: true, blank: false },
        'session-p1': { id: 'session-p1', running: false, blank: false },
        'session-c1': { id: 'session-c1', running: false, blank: false },
        'mate-running': { id: 'mate-running', running: true, blank: false, parentId: 'session-r1' },
        'mate-done': { id: 'mate-done', running: false, blank: false, origin: 'subagent' },
        'blank-idle': { id: 'blank-idle', running: false, blank: true },
      },
    }),
    subscribe: () => () => {},
  },
  retain(id) {
    return {
      ready: Promise.resolve({ sessionId: id, session: sessionStub, eventSource: null, ctx: null }),
      release() { sessionCalls.released += 1 },
    }
  },
}
// 宿主工作区注册表（IWorkspaces.list）：session-r1/w1/c1 归属「工作区 Alpha」
// （注册名 ≠ 路径末段，证明行内工作区名真走了注册表）；r2 不归属任何工作区 →
// 回退 cwd 路径末段。快照契约与 WorkspaceSnapshot 对齐（items: WorkspaceView[]）。
const workspacesStub = {
  list: {
    getSnapshot: () => ({ items: [
      { workspaceId: 'ws-a', path: '/ws/a', title: '工作区 Alpha', sessionIds: ['session-r1', 'session-w1', 'session-c1'] },
      { workspaceId: 'ws-b', path: '/ws/b', title: '工作区 Beta', sessionIds: [] },
    ] }),
    subscribe: () => () => {},
  },
}
// 宿主会话 UI 状态（uiSession.sessionStatus，侧边栏状态点数据源）：
// session-c1 在主视图外结束且未被看过（completionUnread）→ 首页行应显示绿点；
// session-r2 有 open 的审批请求（pendingInteraction.kind=approval）→ 首页行给
// warning 点，不能被宿主仍报的 running=true 覆盖成 spinner；
// session-p1 有待回答的提问（question）→ 必须在列表里（宿主两个信号都没判出）；
// 未覆盖的空闲行（session-c2）维持灰点空闲。
const uiSessionStub = {
  sessionStatus: {
    getSnapshot: () => new Map([
      ['session-c1', { running: false, completionUnread: true }],
      ['session-r2', { running: true, pendingInteraction: { key: 'req-1', kind: 'approval', sessionId: 'session-r2' } }],
      ['session-p1', { running: false, pendingInteraction: { key: 'req-2', kind: 'question', sessionId: 'session-p1' } }],
      // 首页不展示的子会话同样带未读完成 / 待交互：侧栏必须按 isHiddenFromHome 剔除。
      ['mate-done', { running: false, completionUnread: true }],
      ['mate-running', { running: true, pendingInteraction: { key: 'req-3', kind: 'approval', sessionId: 'mate-running' } }],
    ]),
    subscribe: () => () => {},
  },
}
const uiWorkspaceStub = {
  connectWorkspace: async (id) => { sessionCalls.connected.push(id); return 'sess-sim-1' },
  openSession: (id) => { sessionCalls.opened.push(id) },
}
plugin.apply({
  get: (name) => {
    if (name === 'sessions') return sessionsStub
    if (name === 'workspaces') return workspacesStub
    if (name === 'uiSession') return uiSessionStub
    if (name === 'uiWorkspace') return uiWorkspaceStub
    return null
  },
  effect: (fn) => { fn() },
  // Optional-service injection (registerWorkbenchShortcuts): call back with a
  // scope exposing the contributed shortcut + layout faces the bundle uses.
  inject(names, fn) {
    fn({
      effect: (nested) => { nested() },
      shortcuts: { register: () => () => {} },
      layout: { selectPanel: () => {} },
    })
  },
  slots: {
    inject(name, fn) {
      fn()
    },
    register(opts, comp) {
      registry.set(opts.name + '|' + (opts.key || opts.id || ''), comp)
      return { opts, comp }
    },
  },
})

const WorkbenchPanelComp = registry.get('main|workbench')
if (!WorkbenchPanelComp) throw new Error('WorkbenchPanel not registered under main key "workbench"')
const PanelIconComp = registry.get('sidebar.panellist|workbench')
if (!PanelIconComp) throw new Error('PanelIcon not registered under sidebar.panellist id "workbench"')
if (registry.has('main|dms') || registry.has('sidebar.panellist|dms')) {
  throw new Error('stale "dms" registrations still present — sidebar must stay single-entry')
}

// ── props stubs ──────────────────────────────────────────────────────────────
const SNAP = { items: [
  { workspaceId: 'ws-a', path: '/ws/a', title: 'a', sessionIds: ['sess-1'] },
  { workspaceId: 'ws-b', path: '/ws/b', title: 'b', sessionIds: [] },
] }
const props = {
  useSessions: (sel) => sel({ current: 'sess-1' }),
  useWorkspaces: (sel) => sel(SNAP),
}

// ── render driver ────────────────────────────────────────────────────────────
let root = null

/** Stable per-component hook-path segment: component name + sibling index + element key. */
function segFor(c, i) {
  if (c === null || typeof c !== 'object' || typeof c.type !== 'function') return undefined
  return (c.type.name || 'anon') + '#' + i + (c.key !== undefined && c.key !== null ? ':' + c.key : '')
}

// Expand function components depth-first so NESTED component hooks run inside
// the render pass (real React reconciles children; expanding them lazily in
// walk() instead ran their effects outside the pass, which scrambled timing
// once ForgePanel/DmsPanel became children of WorkbenchPanel). The pushed
// segments give every component its own hook table (see the mini react note).
function expand(el, seg) {
  if (el === null || el === undefined || typeof el !== 'object') return el
  if (typeof el.type === 'function') {
    const isRoot = seg === undefined
    if (!isRoot) hookPath.push(seg)
    try {
      // Re-attach varargs children — but only when there are any: components
      // receiving a render function via the `children` PROP key (Issues
      // Dropdown) must keep it, or their menu render fn is clobbered by [].
      return expand(el.type(Object.assign({}, el.props, el.children.length ? { children: el.children } : null)))
    } finally {
      if (!isRoot) hookPath.pop()
    }
  }
  if (Array.isArray(el.children)) el.children = el.children.map((c, i) => expand(c, segFor(c, i)))
  return el
}

renderFn = () => { root = expand(WorkbenchPanelComp(props)) }

function pathsOf(el) {
  const out = []
  walk(el, (n) => {
    if (n && typeof n === 'object' && n.props && typeof n.props.d === 'string') out.push(n.props.d)
  })
  return out.join(' ')
}
function walk(el, fn) {
  if (el === null || el === undefined) return
  if (typeof el !== 'object') { fn(el); return }
  fn(el)
  let kids = el.children || []
  if (typeof el.type === 'function') {
    // mini component renderer: expand function components (e.g. Chip/MrRow) so
    // text assertions can see inside them. Real React merges children into
    // props — the mini createElement keeps them separate, so re-attach here
    // (varargs only; a `children` render-prop key must survive, see expand).
    try { kids = [el.type(Object.assign({}, el.props, el.children.length ? { children: el.children } : null))] } catch (e) { kids = [] }
  }
  for (const c of kids) walk(c, fn)
}
function textOf(el) {
  let out = ''
  walk(el, (n) => { if (typeof n === 'string') out += n })
  return out
}

/** Find buttons by a className fragment + visible text, click the first match. */
function clickButton(el, needle, cls) {
  let clicked = false
  walk(el, (n) => {
    if (clicked) return
    if (n.type === 'button' && typeof n.props.className === 'string' &&
        (!cls || n.props.className.includes(cls)) &&
        textOf(n).includes(needle) && typeof n.props.onClick === 'function') {
      n.props.onClick({ stopPropagation() {} }); clicked = true
    }
  })
  return clicked
}
function findButton(el, needle, cls) {
  let found = null
  walk(el, (n) => {
    if (found) return
    if (n.type === 'button' && typeof n.props.className === 'string' &&
        (!cls || n.props.className.includes(cls)) && textOf(n).includes(needle)) found = n
  })
  return found
}

/** Find the first element (any tag) whose className includes the fragment. */
function findClass(el, cls) {
  let found = null
  walk(el, (n) => {
    if (found || !n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className.includes(cls)) found = n
  })
  return found
}

/** Exact-className finder — needed for .wb-modal, since its backdrop
 *  (.wb-modal-backdrop) contains the card's class as a substring. */
function findExact(el, cls) {
  let found = null
  walk(el, (n) => {
    if (found || !n || typeof n !== 'object') return
    if (n.props?.className === cls) found = n
  })
  return found
}

/** Current page per the shell body style: pages stay mounted (display toggles),
 *  so text/absence assertions cannot tell the shown page — the keyed body div
 *  can (`page-home-body` / `page-forge-body` / …). */
function pageShown(el, key) {
  let hit = null
  walk(el, (n) => {
    if (hit || !n || typeof n !== 'object') return
    if (n.props && n.props.key === 'page-' + key + '-body' && n.props.style) hit = n.props.style.display !== 'none'
  })
  return hit === true
}

/** Find the first .glab-body whose subtree contains `needle` — the DMS /
 *  PingCode pages keep one persistent .glab-body with no page-specific class,
 *  so scroll assertions scope to it by a distinctive text of the active view. */
function scrollerWith(needle) {
  let hit = null
  walk(root, (n) => {
    if (hit || !n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className === 'glab-body' &&
        textOf(n).includes(needle)) hit = n
  })
  return hit
}

/** Click the repo-bar workspace switcher chip (toggles the picker disclosure). */
function openPicker() {
  let clicked = false
  walk(root, (n) => {
    if (clicked) return
    if (n.type === 'button' && typeof n.props.className === 'string' &&
        n.props.className.includes('wb-repo-chip') && typeof n.props.onClick === 'function') {
      n.props.onClick({ stopPropagation() {} }); clicked = true
    }
  })
  return clicked
}

// settle the initial mount cascade
schedule()
for (let i = 0; i < 14; i++) { await tick(); await pass() }

// 1. the 404 regression: state URL must carry '?cwd=' (encoded), never '&cwd' on the bare path
const badState = fetchLog.filter((u) => u.includes('/forge/state&'))
const goodState = fetchLog.filter((u) => u.includes('/forge/state?cwd=%2Fws%2Fa'))
check('state URL uses ?cwd= (404 fix), owning workspace default', badState.length === 0 && goodState.length > 0,
  { badState: badState.slice(0, 3), good: goodState[0] })

// 2. default selection: the repo bar chip shows the owning workspace's repo
const chipA = findButton(root, 'grp/repo-a', 'wb-repo-chip')
check('owning workspace repo auto-selected in repo bar (repo-a)', !!chipA, textOf(root).slice(0, 120))

// 3. verdict line removed
let allText = ''
walk(root, (n) => { if (typeof n === 'string') allText += n + '\n' })

// 4. header shows the selected repo (state actually loaded for the owning cwd)
check('header shows selected repo path (state loaded)', allText.includes('grp/repo-a'), allText.slice(0, 200))

// 5. manual pick of repo-b in the picker latches and retargets fetches
const before = fetchLog.length
const chipOpened = openPicker()
check('repo chip toggles the picker', chipOpened, null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const pickerItems = []
walk(root, (n) => {
  if (n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('wb-picker-item')) {
    pickerItems.push(textOf(n))
  }
})
check('picker lists both workspaces', pickerItems.some((t) => t.includes('repo-a')) && pickerItems.some((t) => t.includes('repo-b')), pickerItems)
const didPick = clickButton(root, 'repo-b', 'wb-picker-item')
check('picked workspace repo-b', didPick, null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
const chipB = findButton(root, 'grp/repo-b', 'wb-repo-chip')
check('repo bar now shows repo-b', !!chipB, textOf(root).slice(0, 160))
const stateB = fetchLog.slice(before).filter((u) => u.includes('/forge/state?cwd=%2Fws%2Fb'))
check('state refetched with cwd=/ws/b after pick', stateB.length > 0, fetchLog.slice(before, before + 6))
// latch: auto-select must not flip back to repo-a
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('selection stays on repo-b (latched)', !!findButton(root, 'grp/repo-b', 'wb-repo-chip') &&
  !findButton(root, 'grp/repo-a', 'wb-repo-chip'), null)

// 6. stale-closure refetch removed: switching back to repo-a must refetch with
//    the NEW cwd only — the old code also fired loadList(true) from the click
//    closure, i.e. a doomed old-cwd request (the race that showed stale data)
const beforeA = fetchLog.length
check('reopened picker for switch-back', openPicker(), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('picked repo-a again (switch back)', clickButton(root, 'repo-a', 'wb-picker-item'), null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
const afterA = fetchLog.slice(beforeA)
const stateA = afterA.filter((u) => u.includes('/forge/state?') && u.includes('cwd=%2Fws%2Fa'))
const stateBstale = afterA.filter((u) => u.includes('/forge/state?') && u.includes('cwd=%2Fws%2Fb'))
check('picker pick refetches state with NEW cwd only', stateA.length === 1 && stateBstale.length === 0, afterA.slice(0, 8))
let textA = ''
walk(root, (n) => { if (typeof n === 'string') textA += n })
check('list body shows repo-a data after switch-back', textA.includes('MR[mine@repo-a]') && !textA.includes('MR[mine@repo-b]'), textA.slice(0, 300))

// 7. seq guard: a late stale-scope response must never overwrite newer data.
//    Hold the mine@/ws/b reply, switch to 全部 (all@/ws/b resolves fast),
//    then release the stale reply — the guard must discard it.
held.set('/forge/mrs?scope=mine&cwd=%2Fws%2Fb', [])
check('reopened picker (seq guard)', openPicker(), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('picked repo-b again', clickButton(root, 'repo-b', 'wb-picker-item'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const mrHalf = findClass(root, 'wb-forge-mr-half')
check('clicked tab 全部', clickButton(mrHalf || root, '全部', 'glab-tab'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let textAll = ''
walk(root, (n) => { if (typeof n === 'string') textAll += n })
check('list shows all@repo-b while mine reply held', textAll.includes('MR[all@repo-b]'), textAll.slice(0, 300))
releaseHeld('/forge/mrs?scope=mine&cwd=%2Fws%2Fb')
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let textLate = ''
walk(root, (n) => { if (typeof n === 'string') textLate += n })
check('late stale reply discarded (still all@repo-b)', textLate.includes('MR[all@repo-b]') && !textLate.includes('MR[mine@repo-b]'), textLate.slice(0, 300))
const rowActions = findClass(root, 'wb-item-actions')
check('列表保留评审/合并/评论，低频操作集中到详情', !!rowActions &&
  textOf(rowActions).includes('评审') && textOf(rowActions).includes('合并') && textOf(rowActions).includes('评论') &&
  !textOf(rowActions).includes('批准') && !textOf(rowActions).includes('关闭') && !textOf(rowActions).includes('网页'),
  rowActions && textOf(rowActions))

// ── 8. MR 详情页签（基础信息 / 代码差异）+ 可折叠文件列表 diff 视图 ─────────
// Click a row opener by its content and class, including native buttons.
function clickNode(el, needle, cls) {
  let clicked = false
  walk(el, (n) => {
    if (clicked) return
    if (typeof n === 'object' && n && typeof n.props?.className === 'string' &&
        (!cls || n.props.className.includes(cls)) && textOf(n).includes(needle) &&
        typeof n.props.onClick === 'function') {
      n.props.onClick({ stopPropagation() {} }); clicked = true
    }
  })
  return clicked
}
// 行打开器在重构后是 .wb-item-top 里的 button.wb-mr-open（键盘可达），不再是
// .wb-item-top 本身（已是 div，onClick 移到了内层按钮上）。
check('MR row opener is keyboard accessible', !!findButton(root, 'MR[all@repo-b]', 'wb-mr-open'), null)
check('clicked MR row opens detail', clickButton(root, 'MR[all@repo-b]', 'wb-mr-open'), null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
check('detail diff NOT fetched until diff tab opened (lazy)', !fetchLog.some((u) => u.includes('/forge/mr/diff?num=100')), fetchLog.slice(-4))

// 详情三页签：概览（描述）/ 代码差异（diff 懒挂载）/ 评论。
const infoTabBtn = findButton(root, '概览', 'glab-tab')
const diffTabBtn = findButton(root, '代码差异', 'glab-tab')
const notesTabBtn = findButton(root, '评论', 'glab-tab')
check('detail tabs 概览/代码差异/评论 render', !!infoTabBtn && !!diffTabBtn && !!notesTabBtn, null)

check('default detail tab is 概览', !!infoTabBtn && infoTabBtn.props.className.includes('glab-tab-active') &&
  !!diffTabBtn && !diffTabBtn.props.className.includes('glab-tab-active'), null)
let dtabInfo = findClass(root, 'wb-tabpane')
check('description renders inside 概览 tab', !!dtabInfo && textOf(dtabInfo).includes('MR 描述[fix NPE]'), dtabInfo && textOf(dtabInfo).slice(0, 160))

// 描述走共享 MarkdownText 渲染（GFM + 数学 + URL 清洗，与文档预览同源）：
// glue 必须转发 text / streaming=false；primitive 在位时不得退回纯文本。
function findMdStub() {
  let found = null
  walk(root, (n) => {
    if (found || !n || typeof n !== 'object' || !n.props) return
    if (n.props['data-md-stub'] === '1') found = n
  })
  return found
}
const mdNode = findMdStub()
check('description renders through MarkdownText primitive',
  !!mdNode && mdNode.props['data-md-text'] === 'MR 描述[fix NPE]' && mdNode.props['data-md-streaming'] === '0',
  mdNode && { text: mdNode.props['data-md-text'], streaming: mdNode.props['data-md-streaming'] })
let usedFallback = false
walk(dtabInfo || root, (n) => {
  if (n && typeof n === 'object' && typeof n.props?.className === 'string' &&
      n.props.className.includes('glab-detail-desc')) usedFallback = true
})
check('markdown path active (plain-text fallback unused while primitive present)',
  !!mdNode && !usedFallback, { mdNode: !!mdNode, usedFallback })

// ── 10. 详情页改版：面包屑 / 头部信息层级 / 收敛操作区 / 右侧信息栏 ──────────
// List-mode scope tabs must disappear while a detail is open (weakened list
// nav); the reading width is the article wrapper around the markdown body.
// Scope: the MR/PR half only — the Issues half stays mounted beside it and
// carries its own 我的/待处理/全部 view tabs.

const crumbs = findClass(root, 'wb-crumbs')
check('breadcrumb shows repo / Merge Requests / !100', !!crumbs &&
  textOf(crumbs).includes('grp/repo-b') && textOf(crumbs).includes('Merge Requests') &&
  textOf(crumbs).includes('!100'), crumbs && textOf(crumbs))
check('back entry lives in breadcrumb (← Merge Requests)', !!findButton(root, '← Merge Requests', 'wb-crumb-link'), null)
const titleNode = findClass(root, 'wb-detail-title')

// iid 与标题同一行（inline），且编号是指向外部 MR 页的超链接
const iidLink = (() => {
  let hit = null
  walk(titleNode || root, (n) => {
    if (!hit && n.type === 'a' && typeof n.props.className === 'string' &&
        n.props.className.includes('wb-title-iid')) hit = n
  })
  return hit
})()
check('iid is an external link (same line as title)', !!iidLink &&
  iidLink.props.href === 'https://gitlab.test/grp/repo-b/-/merge_requests/100' &&
  iidLink.props.target === '_blank' && textOf(iidLink) === '!100', iidLink && iidLink.props)
check('clicked detail tab 代码差异', clickButton(root, '代码差异', 'glab-tab'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('diff fetched lazily on tab switch', fetchLog.some((u) => u.includes('/forge/mr/diff?num=100')), fetchLog.slice(-4))
const infoTab2 = findButton(root, '概览', 'glab-tab')
const diffTab2 = findButton(root, '代码差异', 'glab-tab')
check('diff tab active after switch', !!diffTab2 && diffTab2.props.className.includes('glab-tab-active') &&
  !!infoTab2 && !infoTab2.props.className.includes('glab-tab-active'), null)
check('PR detail explicitly names review workspace and model', textOf(findClass(root, 'wb-review-target')).includes('/ws/b') && textOf(findClass(root, 'wb-review-target')).includes('DSH 默认'), null)

const dtabDiff = findClass(root, 'wb-diff')
check('diff view mounted', !!dtabDiff, null)

// 文件列表：每文件一行（路径 + 增删计数 + 箭头），默认全部展开
function findRows() {
  const rows = []
  walk(root, (n) => {
    if (n && n.type === 'button' && typeof n.props.className === 'string' &&
        n.props.className.includes('wb-diff-file-row')) rows.push(n)
  })
  return rows
}
function fullTextNow() {
  let out = ''
  walk(root, (n) => { if (typeof n === 'string') out += n })
  return out
}
let rows = findRows()
check('file list shows both files with counts', rows.length === 2 &&
  textOf(rows[0]).includes('src/foo.java') && textOf(rows[0]).includes('+2') && textOf(rows[0]).includes('-1') &&
  textOf(rows[1]).includes('README.md') && textOf(rows[1]).includes('+1') && textOf(rows[1]).includes('-0'),
  rows.map((r) => textOf(r)))
check('both files expanded by default (hunk headers rendered)',
  !!rows[0] && rows[0].props['aria-expanded'] === true &&
  fullTextNow().includes('@@ -1,3 +1,4 @@') && fullTextNow().includes('@@ -1,1 +1,2 @@'), null)
let addRows = 0
let delRows = 0
let ctxRows = 0
walk(root, (n) => {
  if (typeof n === 'object' && n && typeof n.props?.className === 'string') {
    if (n.props.className.includes('wb-diff-add')) addRows++
    if (n.props.className.includes('wb-diff-del')) delRows++
    if (n.props.className.includes('wb-diff-ctx')) ctxRows++
  }
})
check('expanded bodies: 3 add / 1 del / 3 ctx rows total', addRows === 3 && delRows === 1 && ctxRows === 3, { addRows, delRows, ctxRows })

// 点击文件行收起 / 再展开
check('clicked file row collapses it', clickButton(root, 'src/foo.java', 'wb-diff-file-row'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
rows = findRows()
let collapsedText = fullTextNow()
check('file 0 collapsed, file 1 still open', !!rows[0] && rows[0].props['aria-expanded'] === false &&
  !!rows[1] && rows[1].props['aria-expanded'] === true &&
  !collapsedText.includes('@@ -1,3 +1,4 @@') && collapsedText.includes('@@ -1,1 +1,2 @@'), collapsedText.slice(0, 200))
check('clicked file row again re-expands', clickButton(root, 'src/foo.java', 'wb-diff-file-row'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('file 0 header back after re-expand', fullTextNow().includes('@@ -1,3 +1,4 @@'), null)

// 全部收起 / 全部展开
check('clicked 全部收起', clickButton(root, '全部收起', 'wb-diff-tool'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('collapse-all hides every hunk body', !fullTextNow().includes('@@ -1,3 +1,4 @@') && !fullTextNow().includes('@@ -1,1 +1,2 @@') &&
  findRows().every((r) => r.props['aria-expanded'] === false), null)
check('clicked 全部展开', clickButton(root, '全部展开', 'wb-diff-tool'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('expand-all restores every hunk body', fullTextNow().includes('@@ -1,3 +1,4 @@') && fullTextNow().includes('@@ -1,1 +1,2 @@') &&
  findRows().every((r) => r.props['aria-expanded'] === true), null)

// 工具栏汇总：文件数 + 总增删
check('diff toolbar shows 2 个文件 +3 -1', fullTextNow().includes('2 个文件') && fullTextNow().includes('+3 -1'), fullTextNow().slice(0, 260))

// wrap toggle flips the whole diff container's data attribute; default is ON
// (long lines wrap instead of hard-clipping inside the panel).
check('wrap toggle starts on (aria-pressed true)',
  findButton(root, '自动换行', 'wb-diff-tool').props['aria-pressed'] === true, null)
let wrapNode = null
walk(root, (n) => {
  if (n && typeof n === 'object' && n.props?.className === 'wb-diff' && n.props['data-wrap'] !== undefined) wrapNode = n
})
check('container carries data-wrap by default', !!wrapNode && wrapNode.props['data-wrap'] === '1',
  wrapNode && wrapNode.props['data-wrap'])
check('clicked wrap toggle (off)', clickButton(root, '自动换行', 'wb-diff-tool'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('wrap toggled off (aria-pressed false, data-wrap removed)',
  findButton(root, '自动换行', 'wb-diff-tool').props['aria-pressed'] === false &&
  (() => {
    let wn = null
    walk(root, (n) => {
      if (n && typeof n === 'object' && n.props?.className === 'wb-diff') wn = n
    })
    return wn.props['data-wrap'] === undefined
  })(), null)

// ── 操作区：评审/评论/更多 常驻为幽灵按钮，合并为唯一 primary（内联确认弹层）；
// 批准/关闭 进「更多」；「在网页打开」已移除（标题编号本身是外链）

// 「评审」点击链路回归：与 Issue「处理」共用 startItemSession（抽出共享例程后
// 必须仍然新建会话 + 提交默认评审提示词）。
const reviewPromptsBefore = sessionCalls.prompts.length
check('clicked 评审 发起评审会话', clickButton(root, '评审', 'glab-btn'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const reviewPrompt = sessionCalls.prompts[reviewPromptsBefore]
check('评审：新建会话并提交默认评审提示词（!100 + 评审要求段）',
  sessionCalls.prompts.length === reviewPromptsBefore + 1 && !!reviewPrompt &&
  reviewPrompt.text.includes('评审 GitLab MR !100') && reviewPrompt.text.includes('**评审要求**') &&
  reviewPrompt.text.includes('仅做只读评审，不修改代码或工作区') && reviewPrompt.text.includes('临时 worktree 测试并清理'),
  reviewPrompt)
check('low-frequency actions hidden until 更多 opens',
  !findButton(root, '批准', 'glab-btn') && !findButton(root, '关闭', 'glab-btn'), null)
const mergeBtn = (() => {
  let hit = null
  walk(root, (n) => {
    if (!hit && n.type === 'button' && typeof n.props.className === 'string' &&
        n.props.className.includes('wb-merge-btn') && textOf(n).includes('合并')) hit = n
  })
  return hit
})()
check('merge button found + clickable', !!mergeBtn && typeof mergeBtn.props.onClick === 'function', null)
mergeBtn.props.onClick({})
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('merge click opens inline confirm panel (no confirm())', !!findClass(root, 'wb-merge-panel'), null)
check('merge panel offers squash (default on) + delete source branch',
  (() => {
    const panel = findClass(root, 'wb-merge-panel')
    if (!panel) return false
    const checks = (panel.children || []).filter((c) => c && c.type === 'label')
    const squash = checks.find((c) => textOf(c).includes('Squash'))
    const squashChecked = !!squash && squash.children?.[0]?.props?.checked === true
    return textOf(panel).includes('Squash') && textOf(panel).includes('删除源分支') && squashChecked
  })(), null)
check('cancel merge panel', clickButton(root, '取消', 'glab-btn'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('panel closed after cancel', !findClass(root, 'wb-merge-panel'), null)
check('clicked 更多 opens the menu', clickButton(root, '更多', 'glab-btn'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('menu lists 批准/关闭 and no 在网页打开 item', !!findButton(root, '批准', 'wb-more-item') &&
  !findButton(root, '在网页打开', 'wb-more-item') && !!findButton(root, '关闭', 'wb-more-item'), null)
check('backdrop layer rendered for click-away', !!findClass(root, 'wb-popbackdrop'), null)
// 标题编号链接直接承担「在网页打开」（菜单项已删除）

// menu stayed open (the removed 在网页打开 item used to close it) — 批准 is live
const beforeApproveMr = fetchLog.length
check('menu 批准 click fires', clickButton(root, '批准', 'wb-more-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('approve posted to /forge/mr/approve', fetchLog.slice(beforeApproveMr).some((u) => u.includes('/forge/mr/approve')),
  fetchLog.slice(beforeApproveMr, beforeApproveMr + 4))
check('clicked 更多 (close item check)', clickButton(root, '更多', 'glab-btn'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('menu 关闭 item present (opens styled confirm)', !!findButton(root, '关闭', 'wb-more-item'), null)
// click-away backdrop closes the menu
check('backdrop click closes the menu', (() => {
  const bd = findClass(root, 'wb-popbackdrop')
  if (!bd || typeof bd.props.onClick !== 'function') return false
  bd.props.onClick({})
  return true
})(), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('menu gone after backdrop click', !findButton(root, '关闭', 'wb-more-item'), null)

// ── 16. 样式化确认对话框（.wb-modal）替代原生 confirm()：详情「更多·关闭」───
check('clicked 更多 (styled close confirm)', clickButton(root, '更多', 'glab-btn'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('menu 关闭 click opens the styled dialog (not native confirm)',
  clickButton(root, '关闭', 'wb-more-item'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
const closeModal = findExact(root, 'wb-modal')
const closeOkBtn = findButton(root, '确认关闭', 'glab-btn-red')
check('close dialog: backdrop + 关闭 !100 + title line + danger OK autofocused',
  !!closeModal && !!findClass(root, 'wb-modal-backdrop') &&
  textOf(closeModal).includes('关闭 !100') && textOf(closeModal).includes('MR[all@repo-b]') &&
  !!closeOkBtn && closeOkBtn.props.autoFocus === true, closeModal && textOf(closeModal))
// Esc on the card cancels (focus sits on the OK button, so the keydown lands inside)
if (closeModal) closeModal.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('Esc cancels the close dialog without POSTing', !findClass(root, 'wb-modal'), null)
check('clicked 更多 again (close confirm path)', clickButton(root, '更多', 'glab-btn'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('clicked menu 关闭 again', clickButton(root, '关闭', 'wb-more-item'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
const beforeCloseMr = fetchLog.length
check('clicked 确认关闭', clickButton(root, '确认关闭', 'glab-btn-red'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('确认关闭 posts /forge/mr/close and the dialog closes',
  fetchLog.slice(beforeCloseMr).some((u) => u.includes('/forge/mr/close')) && !findClass(root, 'wb-modal'),
  fetchLog.slice(beforeCloseMr, beforeCloseMr + 4))

// 评论 tab: host notes render with composer
check('clicked 评论 tab', clickButton(root, '评论', 'glab-tab'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('notes list renders both notes + composer', fullTextNow().includes('评论一') &&
  fullTextNow().includes('评论二') && !!findButton(root, '发表评论', 'glab-btn-primary'), null)

check('clicked breadcrumb ← Merge Requests (back to list)', clickButton(root, '← Merge Requests', 'wb-crumb-link'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('back restores list view (tabs return, detail gone)',
  !!findButton(root, '我的', 'glab-tab') && !findClass(root, 'wb-detail-title'), null)

// ── 16b. 列表行合并：同一个样式化确认框（此前是原生 confirm()），确认后 squash 合并
const mergeRowBtn = findButton(root, '合并', 'wb-act-accent')
check('list row shows the 合并 quick action', !!mergeRowBtn && typeof mergeRowBtn.props.onClick === 'function', null)
mergeRowBtn.props.onClick({ stopPropagation() {} })
for (let i = 0; i < 3; i++) { await tick(); await pass() }
const mergeModal = findExact(root, 'wb-modal')
check('row merge opens the styled dialog (target branch + squash line + primary OK)',
  !!mergeModal && textOf(mergeModal).includes('合并 !100 到 m') &&
  textOf(mergeModal).includes('将使用 squash 合并') && !!findButton(root, '确认合并', 'glab-btn-primary'),
  mergeModal && textOf(mergeModal))
const beforeMergeMr = fetchLog.length
check('clicked 确认合并', clickButton(root, '确认合并', 'glab-btn-primary'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('确认合并 posts squash merge and the dialog closes',
  fetchLog.slice(beforeMergeMr).some((u) => u.includes('/forge/mr/merge')) && !findClass(root, 'wb-modal'),
  fetchLog.slice(beforeMergeMr, beforeMergeMr + 4))
check('native confirm() never used anywhere in the panel', confirmCalls === 0, confirmCalls)

// ── WorkbenchPanel 顶级功能页页签（主页 / 仓库 / DMS 工单）──────────────────
const segNav0 = findClass(root, 'wb-seg')
const firstTab = segNav0 && Array.isArray(segNav0.children) ? segNav0.children[0] : null
const homeTab = findButton(root, '主页', 'wb-seg-item')
const forgeTab = findButton(root, '仓库', 'wb-seg-item')
const dmsTab = findButton(root, 'DMS', 'wb-seg-item')
check('页签以「主页」开头（第一个页签），仓库 / DMS 工单 render',
  !!homeTab && firstTab === homeTab && !!forgeTab && !!dmsTab,
  { first: firstTab ? textOf(firstTab) : null, forge: !!forgeTab, dms: !!dmsTab })

// 首页聚合：统计卡 + 活跃会话单列表 + 通知摘要（stub /home/sessions 返回 2 运行 / 1 待处理 / 3 最近，
// 其中 c1 未读完成 → 并入左栏；c2 已读空闲 → 右栏归档；p1 宿主没判出待处理、靠客户端待交互保留）
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let homeText = ''
walk(root, (n) => { if (typeof n === 'string') homeText += n + '\n' })
check('首页渲染进行中会话统计卡', homeText.includes('进行中会话') && homeText.includes('2'), homeText.slice(0, 200))
// 左栏：需要你动手的（待审批 r2 / 待处理 w1 / 待回答 p1，组内沿用输入顺序）置顶，
// 进行中 r1 随后；右栏「最近完成」排在左栏之后。
check('首页渲染活跃会话（需要动手的置顶 → 进行中，无分组小标题）',
  homeText.includes('活跃会话') && !homeText.includes('最近会话') && !homeText.includes('待处理 (') &&
  homeText.indexOf('处理 #45 登录超时') > -1 &&
  homeText.indexOf('处理 #45 登录超时') < homeText.indexOf('重构技能预览为详情页') &&
  homeText.indexOf('重构技能预览为详情页') < homeText.indexOf('补充 SLS 查询文档') &&
  homeText.indexOf('补充 SLS 查询文档') < homeText.indexOf('评审 !123 feat(core)') &&
  homeText.indexOf('评审 !123 feat(core)') < homeText.indexOf('SLS 日志查询 trace 下钻'),
  homeText.slice(0, 300))
// 区块头：标题 + 总数徽标（设计稿样式）；分项计数（进行中 X · 待处理 Y · 未读
// Z）不展示，状态由行内 chip 逐行标注。徽标 = 可见会话数 5（r1/r2/w1/p1/c1）。
const homeSecs = []
walk(root, (n) => {
  if (typeof n === 'object' && n !== null && n.props && n.props.className === 'wb-home-sec') homeSecs.push(n)
})
const secText = (sec) => { let t = ''; walk(sec, (n) => { if (typeof n === 'string') t += n }); return t }
const secBadge = (sec) => {
  let t = null
  walk(sec, (n) => { if (typeof n === 'object' && n !== null && n.props && n.props.className === 'wb-home-sec-badge') t = textOf(n) })
  return t
}
check('活跃会话区块头：徽标 = 可见会话数 5（含未读完成 c1）',
  homeSecs.length >= 1 && secBadge(homeSecs[0]) === '5' && secText(homeSecs[0]).includes('活跃会话'),
  { badge: homeSecs.length >= 1 ? secBadge(homeSecs[0]) : null, text: homeSecs.length >= 1 ? secText(homeSecs[0]).slice(0, 120) : null })
check('会话分两栏：未读完成并入左栏（绿点），右栏只留已读归档且不报总数',
  !!findClass(root, 'wb-home-sessions') && homeSecs.length >= 2 &&
  secBadge(homeSecs[1]) === null && secText(homeSecs[1]).includes('最近完成') &&
  !findClass(homeSecs[1], 'wb-home-sec-unread') &&
  secText(homeSecs[0]).includes('SLS 日志查询 trace 下钻') &&
  !secText(homeSecs[1]).includes('SLS 日志查询 trace 下钻') &&
  secText(homeSecs[1]).includes('补齐 DMS 工单审批注释'))
check('首页会话行渲染标题与状态', homeText.includes('评审 !123 feat(core)') && homeText.includes('处理 #45 登录超时'), homeText.slice(0, 300))
// 工作区名：注册表归属的会话显示注册名（≠ 路径末段），未归属的回退路径末段。
check('首页会话行渲染工作区名（注册名优先 / 未注册回退末段）与相对时间',
  homeText.includes('工作区 Alpha') && homeText.includes('ai-agent') && homeText.includes('分钟前') &&
  !homeText.includes('/ws/a'), homeText.slice(0, 300))

// 单行布局：状态icon 最前 + 标题 · 工作区 + 行尾时间；状态文字与消息/轮次/工具
// 统计都不渲染（状态只由行首的点/spinner 表达）。
let slistNode = null
walk(root, (n) => {
  if (!slistNode && n && typeof n === 'object' && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-home-slist')) slistNode = n
})
let listText = ''
if (slistNode) walk(slistNode, (n) => { if (typeof n === 'string') listText += n + '\n' })

// 未读完成：completionUnread（uiSession.sessionStatus，侧边栏绿点同源）的 c1
// 并入左栏、带绿点并加粗；右栏只剩已读的 c2，不画状态点也不占槽位（标题直接从
// 卡片内边距起排）。
const doneRows = []
walk(homeSecs[1], (n) => {
  if (typeof n === 'object' && n !== null && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-home-srow')) doneRows.push(n)
})
const dotsIn = (row) => {
  const out = []
  walk(row, (n) => { if (typeof n === 'object' && n !== null && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-home-sdot')) out.push(n.props['data-state']) })
  return out
}
const doneRowText = (row) => { let t = ''; walk(row, (n) => { if (typeof n === 'string') t += n }); return t }
check('最近完成：只留已读归档、不画状态点、不含未读完成',
  doneRows.length === 1 &&
  doneRowText(doneRows[0]).includes('补齐 DMS 工单审批注释') && doneRows[0].props.className.includes('wb-home-srow-read') &&
  dotsIn(doneRows[0]).length === 0 &&
  !secText(homeSecs[0]).includes('补齐 DMS 工单审批注释'),
  { rows: doneRows.map((r) => [r.props.className, dotsIn(r)]) })

// 行尾时间与侧边栏同源同值：显示 promptedAt（最后一条用户消息、向下取整分桶），
// 最近任意活动（updatedAt 更新）不拨新它。c1 活动 1 分钟前、提问 10 分钟前 → 10 分钟前。
check('首页会话行时间与侧边栏同源（最后一条用户消息，活动不拨新）',
  homeText.includes('10 分钟前') && !homeText.includes('1 分钟前'),
  listText.slice(0, 400))

// 待交互（uiSession.sessionStatus.pendingInteraction，侧边栏 warning 点 + 「待审批」
// 同源）：状态点按侧边栏同序 —— 待交互 > 进行中。session-r2 宿主仍报 running=true，
// 但不能画成 spinner；session-p1 宿主两个信号都没判出，仍要留在列表里（行内不写
// 状态文字，状态只由行首的点表达）。
const homeRows = []
walk(root, (n) => {
  if (typeof n === 'object' && n !== null && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-home-srow')) homeRows.push(n)
})
const rowText = (row) => { let t = ''; walk(row, (n) => { if (typeof n === 'string') t += n }); return t }
const rowDotState = (row) => {
  let state = null
  walk(row, (n) => {
    if (state !== null || typeof n !== 'object' || n === null || !n.props || typeof n.props.className !== 'string') return
    if (n.props.className.includes('wb-home-sdot') || n.props.className.includes('wb-home-sspin')) state = n.props['data-state']
  })
  return state
}
const rowOf = (title) => homeRows.find((r) => rowText(r).includes(title))
const unreadLeft = rowOf('SLS 日志查询 trace 下钻')
check('未读完成并入左栏：绿点 + 加粗（与侧边栏同源）',
  !!unreadLeft && rowDotState(unreadLeft) === 'done' && unreadLeft.props.className.includes('wb-home-srow-unread'),
  { state: unreadLeft ? rowDotState(unreadLeft) : null, cls: unreadLeft ? unreadLeft.props.className : null })
check('待审批会话行给 warning 点（待交互优先于进行中，与侧边栏状态同源）',
  rowDotState(rowOf('处理 #45 登录超时')) === 'warning' &&
  rowDotState(rowOf('评审 !123 feat(core)')) === 'ongoing',
  { pending: rowDotState(rowOf('处理 #45 登录超时')), running: rowDotState(rowOf('评审 !123 feat(core)')) })
check('待交互会话恒在活跃列表（宿主未判出的待回答会话也保留）',
  !!rowOf('补充 SLS 查询文档') && rowDotState(rowOf('补充 SLS 查询文档')) === 'warning' &&
  !secText(homeSecs[0]).includes('补齐 DMS 工单审批注释'),
  { rows: homeRows.map(rowText) })

// 行尾紧凑状态文案（与侧边栏 trailingLabel 同值）：待交互行用「待审批 / 待回答」
// 顶掉相对时间（r2 不再显示 5 分钟前），非待交互行照旧显示相对时间（r1 显示 2 分钟前）。
check('待交互行行尾显示紧凑状态文案并顶掉相对时间（与侧边栏 trailingLabel 同值）',
  rowText(rowOf('处理 #45 登录超时')).includes('待审批') &&
  !rowText(rowOf('处理 #45 登录超时')).includes('分钟前') &&
  rowText(rowOf('补充 SLS 查询文档')).includes('待回答') &&
  !rowText(rowOf('补充 SLS 查询文档')).includes('分钟前') &&
  rowText(rowOf('评审 !123 feat(core)')).includes('分钟前') &&
  !rowText(rowOf('评审 !123 feat(core)')).includes('待审批') &&
  !rowText(rowOf('评审 !123 feat(core)')).includes('待回答'),
  { r2: rowText(rowOf('处理 #45 登录超时')), p1: rowText(rowOf('补充 SLS 查询文档')), r1: rowText(rowOf('评审 !123 feat(core)')) })

// ── 主页占第一个页签：点「主页」页签回首页；页签栏空白区（页签外）同样回首页 ──
const segNav = findClass(root, 'wb-seg')
check('页签栏有背景点击回首页（nav.onClick）', !!segNav && typeof segNav.props.onClick === 'function', null)
check('clicked page tab 仓库', clickButton(root, '仓库', 'wb-seg-item'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('forge shown after tab click', pageShown(root, 'forge') && !pageShown(root, 'home'), null)
const segNav2 = findClass(root, 'wb-seg')
segNav2.props.onClick({ target: { closest: () => true } }) // 点在页签按钮上（closest('button') 命中）
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('页签内点击不触发回首页', pageShown(root, 'forge') && !pageShown(root, 'home'), null)
segNav2.props.onClick({ target: null }) // 点在页签栏空白（无 button 祖先）
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('页签外点击回首页', pageShown(root, 'home') && !pageShown(root, 'forge'), null)
check('回首页后持久化为 home', lsStore.get('samanhappy.dsh-workbench.page') === 'home', lsStore.get('samanhappy.dsh-workbench.page'))
// 主页页签：显式回首页入口 —— 先点仓库离开，再点「主页」页签回来
check('clicked page tab 仓库', clickButton(root, '仓库', 'wb-seg-item'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('clicked page tab 主页', clickButton(root, '主页', 'wb-seg-item'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('主页页签点击回首页（active + aria-current，不落在 forge）',
  pageShown(root, 'home') && !pageShown(root, 'forge') &&
  findButton(root, '主页', 'wb-seg-item').props.className.includes('wb-seg-active') &&
  findButton(root, '主页', 'wb-seg-item').props['aria-current'] === 'page',
  { page: lsStore.get('samanhappy.dsh-workbench.page'), tabs: (() => { const out = []; walk(root, (n) => { if (n.type === 'button' && String(n.props.className || '').includes('wb-seg-item')) out.push(textOf(n) + (String(n.props.className).includes('wb-seg-active') ? '*' : '')) }); return out })() })

// ── 点击会话行 → uiWorkspace.openSession 在主视图打开该会话（侧边栏点击会话同款）──
let srowNode = null
walk(root, (n) => {
  if (!srowNode && typeof n === 'object' && n !== null && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-home-srow')) srowNode = n
})
check('会话行可点击（row.onClick）', !!srowNode && typeof srowNode.props.onClick === 'function', null)
const openedBefore = sessionCalls.opened.length
srowNode.props.onClick({})
check('点击会话行打开对应会话（首个行 = 置顶的待审批 session-r2）',
  sessionCalls.opened.length === openedBefore + 1 && sessionCalls.opened[openedBefore] === 'session-r2', sessionCalls.opened)
let sTitleBtn = null
walk(srowNode, (n) => {
  if (!sTitleBtn && n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('wb-home-stitle')) sTitleBtn = n
})
check('会话标题是键盘可达按钮', !!sTitleBtn && typeof sTitleBtn.props.onClick === 'function', null)
sTitleBtn.props.onClick({ stopPropagation() {} })
check('标题按钮只触发一次 openSession（stopPropagation 防冒泡双发）',
  sessionCalls.opened.length === openedBefore + 2 && sessionCalls.opened[openedBefore + 1] === 'session-r2', sessionCalls.opened)

// the DMS page stays mounted (display:none), so its poll ran on first mount
check('dms list fetched with resultType=AS_HANDLER', fetchLog.some((u) => u.includes('/dms/orders?') && u.includes('resultType=AS_HANDLER')), fetchLog.filter((u) => u.includes('/dms/')).slice(0, 4))
check('dms status probed', fetchLog.some((u) => u.includes('/dms/status')), null)

// pending badge on the DMS page tab (stub totalCount = 3)
let badgeNode = null
walk(dmsTab, (n) => {
  if (badgeNode) return
  if (n.type === 'span' && typeof n.props.className === 'string' && n.props.className.includes('glab-badge-hot')) badgeNode = n
})
check('dms page tab shows pending badge 3', !!badgeNode && textOf(badgeNode) === '3', badgeNode && textOf(badgeNode))

check('clicked page tab DMS 工单', clickButton(root, 'DMS', 'wb-seg-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const dmsTab2 = findButton(root, 'DMS', 'wb-seg-item')
const forgeTab2 = findButton(root, '仓库', 'wb-seg-item')
check('dms page active after switch', !!dmsTab2 && dmsTab2.props.className.includes('wb-seg-active') &&
  !!forgeTab2 && !forgeTab2.props.className.includes('wb-seg-active'), null)
check('page persisted to localStorage', lsStore.get('samanhappy.dsh-workbench.page') === 'dms', lsStore.get('samanhappy.dsh-workbench.page'))

let dmsText = ''
walk(root, (n) => { if (typeof n === 'string') dmsText += n + '\n' })
check('dms row renders order id + comment + status', dmsText.includes('#7001') && dmsText.includes('工单[待审批@7001]') && dmsText.includes('审批中'), dmsText.slice(0, 300))
check('dms row offers 同意/拒绝 for a pending order', dmsText.includes('同意') && dmsText.includes('拒绝'), dmsText.slice(0, 300))

function dmsPanelRoot() {
  // The SLS panel also renders the aliyun meta line; take the FIRST match (DMS
  // page comes before SLS in the always-mounted page tree).
  let panel = null
  walk(root, (n) => {
    if (panel || !n || typeof n !== 'object') return
    if (n.props && n.props.className === 'glab-panel' && textOf(n).includes('aliyun CLI 已登录')) panel = n
  })
  return panel
}
check('DMS scope tabs default to 待审批', !!findButton(root, '待审批', 'glab-tab-active'), null)
check('DMS 全部 tab available', clickButton(dmsPanelRoot(), '全部', 'glab-tab'), null)
await pass()
check('unconfigured 全部 shows the same three orders', textOf(root).includes('#7001') && textOf(root).includes('#7002') && textOf(root).includes('#7003'), null)
clickButton(dmsPanelRoot(), '待审批', 'glab-tab')
await pass()
let dmsSettingsButton = null
walk(root, (n) => { if (n && n.props && n.props['aria-label'] === 'DMS 连接设置') dmsSettingsButton = n })
dmsSettingsButton.props.onClick()
await pass()
function committerInput() {
  let input = null
  walk(root, (n) => { if (n && n.props && n.props.placeholder === '姓名用逗号分隔，留空显示全部') input = n })
  return input
}
committerInput().props.onChange({ target: { value: 'zhangsan，wangwu' } })
await pass()
committerInput().props.onBlur()
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('multiple committers filter only 待审批', textOf(root).includes('#7001') && !textOf(root).includes('#7002') && textOf(root).includes('#7003'), null)
check('filtered pending badge is two', textOf(findButton(root, 'DMS', 'wb-seg-item')).includes('2'), null)
clickButton(dmsPanelRoot(), '全部', 'glab-tab')
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('configured 全部 retains other committers', textOf(root).includes('#7002'), null)
clickButton(dmsPanelRoot(), '待审批', 'glab-tab')
await pass()
committerInput().props.onChange({ target: { value: '' } })
await pass()
committerInput().props.onBlur()
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('clearing committers restores identical data', textOf(root).includes('#7002'), null)

const beforeApprove = fetchLog.length
check('clicked dms row 同意 opens styled confirm (not native)', clickButton(root, '同意', 'wb-act'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
const dmsModal = findExact(root, 'wb-modal')
check('dms agree dialog: 同意工单 7001 + hint + 执行 hint + primary 确认同意',
  !!dmsModal && textOf(dmsModal).includes('同意工单 7001') &&
  textOf(dmsModal).includes('工单[待审批@7001]') && textOf(dmsModal).includes('同意后进入下一审批节点') &&
  !!findButton(root, '确认同意', 'glab-btn-primary'), dmsModal && textOf(dmsModal))
check('no approve POST before the dialog is confirmed',
  !fetchLog.slice(beforeApprove).some((u) => u.includes('/dms/order/approve')), null)
check('clicked 确认同意', clickButton(root, '确认同意', 'glab-btn-primary'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const approveCalls = fetchLog.slice(beforeApprove).filter((u) => u.includes('/dms/order/approve'))
check('dms 同意 posts /dms/order/approve after dialog confirm', approveCalls.length === 1, fetchLog.slice(beforeApprove, beforeApprove + 4))
check('dms dialog closed after 确认同意', !findExact(root, 'wb-modal'), null)
check('dms list refetched after approve (force=1)', fetchLog.slice(beforeApprove).some((u) => u.includes('/dms/orders?') && u.includes('force=1')), null)

// ── DMS 工单详情：基础信息 + SQL 详情区（/dms/order/sql 按 PluginType 路由）──
// 滚动回归（同 Issues）：列表/详情共用 .glab-body 滚动节点，详情打开须置顶、
// 返回列表恢复原位。先模拟列表已滚到 333。
const dmsListEl = scrollerWith('#7001')
check('DMS 列表滚动容器在（滚动回归前置）', !!dmsListEl, null)
if (dmsListEl) dmsListEl.scrollTop = 333
check('clicked dms row title (详情入口)', clickButton(root, '#7001', 'wb-item-top'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('detail fetched base info + sql in parallel',
  fetchLog.some((u) => u.includes('/dms/order?') && u.includes('id=7001') && !u.includes('approve')) &&
  fetchLog.some((u) => u.includes('/dms/order/sql?') && u.includes('id=7001') && u.includes('type=DATA_CHANGE')),
  fetchLog.filter((u) => u.includes('/dms/order')).slice(-4))
let dmsDetailText = ''
walk(root, (n) => { if (typeof n === 'string') dmsDetailText += n + '\n' })
check('detail renders base info (提交人/审批流 ID) + back button',
  dmsDetailText.includes('提交人') && dmsDetailText.includes('zhangsan') &&
  dmsDetailText.includes('9101') && dmsDetailText.includes('返回列表'), dmsDetailText.slice(0, 400))
const dmsSqlWrap = findClass(root, 'wb-sls-sqlwrap')
const dmsSqlText = dmsSqlWrap ? textOf(dmsSqlWrap) : ''
check('detail renders SQL block (reused sls SqlBlock: lineno + kw highlight + copy)',
  !!dmsSqlWrap && dmsSqlText.includes('SQL 脚本') && dmsSqlText.includes('update t1 set name') &&
  !!findClass(root, 'wb-sls-sqlno') && !!findClass(root, 'wb-sls-sqlkw') && !!findButton(root, '复制', 'wb-sls-act'),
  dmsSqlText)
const dmsDetailBody = scrollerWith('返回列表')
check('DMS 详情打开后滚动置顶（不残留列表位置 333）',
  !!dmsDetailBody && dmsDetailBody.scrollTop === 0, dmsDetailBody && { scrollTop: dmsDetailBody.scrollTop })
// 详情里滚过（模拟读完 SQL 滚到下方）后返回：列表要回到进入详情前的位置。
if (dmsDetailBody) dmsDetailBody.scrollTop = 200
check('clicked 返回列表', clickButton(root, '返回列表', 'glab-btn'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('back to dms list (detail closed)', !!findButton(root, '#7001', 'wb-item-top') && !findClass(root, 'wb-sls-sqlwrap'), null)
const dmsListEl2 = scrollerWith('#7001')
check('DMS 返回列表恢复进入详情前的滚动位置（333，而非停在中部/底部）',
  !!dmsListEl2 && dmsListEl2.scrollTop === 333, dmsListEl2 && { scrollTop: dmsListEl2.scrollTop })

// ── DMS 权限申请工单（PERM_APPLY）：没有 SQL，详情渲染「申请内容」卡 ────────
// 第 2 行 7002 是权限申请（列权限 / 查询 / 180 天）：宿主回 apply，客户端既
// 不该再说「暂不支持在线查看 SQL」，也不该渲染 SQL 代码块。
const permRow = (() => {
  let hit = null
  walk(root, (n) => {
    if (hit || !n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className.includes('wb-item') &&
        textOf(n).includes('#7002')) hit = n
  })
  return hit
})()
check('PERM_APPLY row renders in DMS list', !!permRow, null)
check('clicked PERM_APPLY row title (详情入口)', !!permRow && clickButton(permRow, '#7002', 'wb-item-top'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('PERM_APPLY detail fetches /dms/order/sql?type=PERM_APPLY (id=7002)',
  fetchLog.some((u) => u.includes('/dms/order/sql?') && u.includes('type=PERM_APPLY') && u.includes('id=7002')),
  fetchLog.filter((u) => u.includes('/dms/order/sql')).slice(-3))
check('PERM_APPLY detail base info belongs to 7002 (stub honors id)',
  textOf(scrollerWith('返回列表') || root).includes('#7002'), null)
const applyCard = findClass(root, 'wb-dms-kv')
const applyText = applyCard ? textOf(applyCard) : ''
check('PERM_APPLY detail renders 申请内容 card (类型/权限/有效期/资源)',
  !!applyCard && applyText.includes('列权限') && applyText.includes('查询') &&
  applyText.includes('180 天') && applyText.includes('t_order.address') &&
  applyText.includes('MYSQL · 生产'), applyText)

check('PERM_APPLY 详情不渲染 SQL 代码块（无行号块）', !findClass(root, 'wb-sls-sqlno'), null)
check('clicked 返回列表（PERM_APPLY 详情关闭）', clickButton(root, '返回列表', 'glab-btn'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('back to dms list after PERM_APPLY detail', !!findButton(root, '#7001', 'wb-item-top') && !findClass(root, 'wb-dms-kv'), null)

// ── DMS 结果集导出工单（DATA_EXPORT）：既有 SQL 又有 facts ──────────────────
// 导出类工单要同时渲染「SQL 脚本」块（导出的查询语句）与「工单内容」卡
// （数据库 / 原因 / 影响行数 / 导出状态）——两者必须在同一个详情里共存。
const exportRow = (() => {
  let hit = null
  walk(root, (n) => {
    if (hit || !n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className.includes('wb-item') &&
        textOf(n).includes('#7003')) hit = n
  })
  return hit
})()
check('DATA_EXPORT row renders in DMS list', !!exportRow, null)
check('clicked DATA_EXPORT row title (详情入口)', !!exportRow && clickButton(exportRow, '#7003', 'wb-item-top'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('DATA_EXPORT detail fetches /dms/order/sql?type=DATA_EXPORT (id=7003)',
  fetchLog.some((u) => u.includes('/dms/order/sql?') && u.includes('type=DATA_EXPORT') && u.includes('id=7003')),
  fetchLog.filter((u) => u.includes('/dms/order/sql')).slice(-3))
const exportHeads = []
walk(root, (n) => {
  if (n && typeof n === 'object' && typeof n.props?.className === 'string' && n.props.className.includes('wb-sls-dhead')) exportHeads.push(textOf(n))
})
check('DATA_EXPORT detail renders 工单内容 card next to the SQL block',
  exportHeads.includes('SQL 脚本') && exportHeads.includes('工单内容'), exportHeads)
const exportFacts = findClass(root, 'wb-dms-kv')
const exportFactsText = exportFacts ? textOf(exportFacts) : ''
check('DATA_EXPORT facts render 数据库/导出原因/影响行数/导出状态',
  !!exportFacts && exportFactsText.includes('数据库') && exportFactsText.includes('数据分析') &&
  exportFactsText.includes('201 行') && exportFactsText.includes('导出成功'), exportFactsText)
check('DATA_EXPORT SQL block still renders the export statement',
  textOf(root).includes('SELECT * from `t_order`') && !!findClass(root, 'wb-sls-sqlno'), null)
check('clicked 返回列表（DATA_EXPORT 详情关闭）', clickButton(root, '返回列表', 'glab-btn'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('back to dms list after DATA_EXPORT detail', !!findButton(root, '#7001', 'wb-item-top') && !findClass(root, 'wb-dms-kv'), null)

// ── SLS 日志页（aliyun sls get-logs-v2）─────────────────────────────────────
// SLS 页与 DMS 一样常挂载：首挂载即探测 /sls/status（同 aliyun 凭证探测）。
const slsTab = findButton(root, 'SLS', 'wb-seg-item')
check('page tab SLS 日志 renders', !!slsTab, null)
check('sls status probed (aliyun probe)', fetchLog.some((u) => u.includes('/sls/status')), null)

check('clicked page tab SLS 日志', clickButton(root, 'SLS', 'wb-seg-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const slsTab2 = findButton(root, 'SLS', 'wb-seg-item')
check('sls page active after switch', !!slsTab2 && slsTab2.props.className.includes('wb-seg-active'), null)
check('sls page persisted to localStorage', lsStore.get('samanhappy.dsh-workbench.page') === 'sls', lsStore.get('samanhappy.dsh-workbench.page'))

let slsText = ''
walk(root, (n) => { if (typeof n === 'string') slsText += n + '\n' })
check('sls form renders compact row labels + preset chips',
  slsText.includes('环境') && slsText.includes('生产环境') && slsText.includes('测试环境') &&
  slsText.includes('时间范围') &&
  slsText.includes('返回行数') && slsText.includes('最近1小时') && slsText.includes('查询'),
  slsText.slice(0, 300))

// 环境下拉替代 Project/Logstore 输入：默认生产环境，选项映射 project/logstore
const envSel = findClass(root, 'wb-sls-envsel')
check('env select exists and defaults to 生产环境 (prod)', !!envSel && envSel.props.value === 'prod', envSel && envSel.props.value)
const envOpts = envSel && Array.isArray(envSel.children) ? envSel.children : []
check('env select offers 生产/测试 mapping',
  envOpts.some((o) => o && o.props && o.props.value === 'prod' && textOf(o) === '生产环境') &&
  envOpts.some((o) => o && o.props && o.props.value === 'test' && textOf(o) === '测试环境'),
  envOpts.map((o) => (o && o.props ? o.props.value + ':' + textOf(o) : String(o))))

// ── SLS 设计图改版：紧凑表单 / 单行日志头 / µs 时长 / 语义色 / trace 下钻 ──
const beforeQuery = fetchLog.length
check('clicked preset chip 最近1小时', clickButton(root, '最近1小时', 'wb-sls-preset'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('preset chip click posts /sls/query', fetchLog.slice(beforeQuery).some((u) => u.includes('/sls/query')), fetchLog.slice(beforeQuery, beforeQuery + 3))
// 快捷区间查询成功 → 表单保持展开、不再自动折叠；chip 直接点亮
check('preset query keeps the form open (no auto-collapse)', !!findClass(root, 'wb-sls-form'), null)

check('clicked chip lights up (wb-sls-preset-active)', !!findButton(root, '最近1小时', 'wb-sls-preset-active'), null)

slsText = ''
walk(root, (n) => { if (typeof n === 'string') slsText += n + '\n' })
check('duration rendered from µs (60.0s / 3.44ms, no raw ms suffix)',
  slsText.includes('60.0s') && slsText.includes('3.44ms') && !slsText.includes('60213322ms') && !slsText.includes('3440ms'),
  slsText.split('\n').filter((l) => l.includes('ms')).slice(0, 4))
// 日志与 Trace 查询结果都保留可识别的信息及下钻入口。
let headCount = 0
walk(root, (n) => {
  if (n && n.props && typeof n.props.className === 'string' && n.props.className.split(/\s+/).includes('wb-sls-entry-head')) headCount++
})
check('log and trace groups each render two entry heads with svc + ip + trace',
  headCount === 4 && !!findClass(root, 'wb-sls-svctag') &&
  slsText.includes('POST /api/orders/42') && slsText.includes('10.0.0.1') &&
  slsText.includes('trace=8a0c282911823ab591d48337c3c90f55'), { headCount })
check('host == __source__ deduped in head (ip rendered once)', !slsText.includes('10.0.0.1 · 10.0.0.1'), null)

const traceBtn = findButton(root, 'trace=8a0c282911823ab591d48337c3c90f55', 'wb-sls-trace')
check('trace renders as a drill-down link in the head', !!traceBtn, null)
check('clicked trace drill-down', !!traceBtn && (traceBtn.props.onClick({ stopPropagation() {} }), true), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let slsQueryBox = null
walk(root, (n) => {
  if (slsQueryBox || typeof n !== 'object' || !n) return
  if (n.type === 'textarea' && n.props && n.props['aria-label'] === '日志查询语句' && typeof n.props.value === 'string') slsQueryBox = n
})
check('drill-down refills query with traceID: "…"',
  !!slsQueryBox && slsQueryBox.props.value.includes('traceID: "8a0c282911823ab591d48337c3c90f55"'),
  slsQueryBox && slsQueryBox.props.value)
check('drill-down issued a second /sls/query POST', fetchLog.filter((u) => u.includes('/sls/query')).length >= 2, fetchLog.filter((u) => u.includes('/sls/query')).length)

let navOk = false
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } }, configurable: true,
  })
  navOk = typeof globalThis.navigator.clipboard.writeText === 'function'
} catch (e) {}
if (navOk) {
  check('clicked 复制 trace', clickButton(root, '复制 trace', 'wb-sls-act'), null)
  for (let i = 0; i < 4; i++) { await tick(); await pass() }
  check('copy shows transient 已复制', !!findButton(root, '已复制', 'wb-sls-act'), null)
} else {
  check('copy feedback (navigator.clipboard unavailable in sim, skipped)', true, null)
}

// ── 展开体：详情 / SQL / JSON 三页签 ─────────────────────────────────────
slsText = ''
walk(root, (n) => { if (typeof n === 'string') slsText += n + '\n' })
check('span time shows ms precision from start (µs)', slsText.includes('.123') && slsText.includes('.200'),
  slsText.split('\n').filter((l) => l.includes('.1') || l.includes('.2')).slice(0, 3))
check('clicked first entry head to expand', clickNode(root, 'POST /api/orders/42', 'wb-sls-entry-head'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('expanded entry gets the orange card + 详情/SQL/JSON tabs',
  !!findClass(root, 'wb-sls-entry-open') && !!findButton(root, '详情', 'wb-sls-tab') &&
  !!findButton(root, 'SQL', 'wb-sls-tab') && !!findButton(root, 'JSON', 'wb-sls-tab'), null)
// 详情默认页签：左基本信息，右 SQL 与扩展字段；普通扩展字段需展开。
const detailNode = findClass(root, 'wb-sls-detail')
const detailText = detailNode ? textOf(detailNode) : ''
check('log details expose basic information and expandable fields',
  detailText.includes('基本信息') && detailText.includes('扩展字段') &&
  detailText.includes('TraceID') && detailText.includes('数据库连接') &&
  detailText.includes('mysql://db.example.com:3306') &&
  !!findButton(detailNode, '展开其余', 'wb-sls-extras-toggle'),
  detailText.slice(0, 300))
check('expand remaining log fields', clickButton(detailNode, '展开其余', 'wb-sls-extras-toggle'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const expandedDetailText = textOf(findExact(root, 'wb-sls-detail'))
check('expanded fields include HTTP method and user agent',
  expandedDetailText.includes('http.method') && expandedDetailText.includes('Mozilla/5.0'), expandedDetailText)
// SQL 页签显示原始查询语句。
check('clicked SQL tab', clickButton(root, 'SQL', 'wb-sls-tab'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const sqlBox = findClass(root, 'wb-sls-sql')
const sqlText = sqlBox ? textOf(sqlBox) : ''
check('SQL tab displays the query statement',
  !!sqlBox && sqlText.includes('SELECT') && sqlText.includes('t_order'),
  sqlText.slice(0, 140))
// JSON 页签：字符串化 JSON 字段被解开成缩进树（无 \" 转义），key 分色
check('clicked JSON tab', clickButton(root, 'JSON', 'wb-sls-tab'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const jsonBox = findClass(root, 'wb-sls-json')
const jsonText = jsonBox ? textOf(jsonBox) : ''
check('expanded JSON unwraps stringified fields (no \\" escapes)',
  jsonText.includes('"http.method"') && jsonText.includes('"user_agent"') && !jsonText.includes('\\"'),
  jsonText.slice(0, 160))

// 瀑布视图：span 条目出现 列表/瀑布 切换，按 traceID 分组渲染时间条
check('瀑布 toggle appears for span results', !!findButton(root, '瀑布', 'wb-sls-vtog'), null)
check('clicked 瀑布', clickButton(root, '瀑布', 'wb-sls-vtog'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
let wfRows = 0
walk(root, (n) => {
  if (n && n.props && typeof n.props.className === 'string' && n.props.className.includes('wb-sls-wf-row')) wfRows++
})
check('waterfall renders grouped span rows', wfRows === 2 && !!findClass(root, 'wb-sls-wf-track'), { wfRows })
let wfText = ''
walk(root, (n) => { if (typeof n === 'string') wfText += n + '\n' })
check('waterfall shows trace head + durations',
  wfText.includes('trace=8a0c282911823a') && wfText.includes('2 spans') && wfText.includes('60.0s'),
  wfText.slice(0, 200))
check('clicked 列表 back', clickButton(root, '列表', 'wb-sls-vtog'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }

// 环境下拉：切到测试环境后，后续查询走 test 的 project/logstore（toolbar 摘要可见）
const envSel2 = findClass(root, 'wb-sls-envsel')
check('switch env to 测试环境', !!envSel2 && (envSel2.props.onChange({ target: { value: 'test' } }), true), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('env select now 测试环境', (() => { const s = findClass(root, 'wb-sls-envsel'); return !!s && s.props.value === 'test' })(), null)

// 加载更多：行数调小成整批 → 上限提示 + 按钮 → offset 追加翻倍（提示消失）
let lineInput = null
walk(root, (n) => {
  if (lineInput || typeof n !== 'object' || !n) return
  if (n.type === 'input' && n.props && n.props.type === 'number') lineInput = n
})
check('found 返回行数 input', !!lineInput, null)
if (lineInput) lineInput.props.onChange({ target: { value: '2' } })
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const beforeMore = fetchLog.length
check('clicked 查询 with line=2', clickButton(root, '查询', 'glab-btn-primary'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let barText = ''
walk(root, (n) => { if (typeof n === 'string') barText += n + '\n' })
check('query runs against test env project/logstore',
  barText.includes('demo-test-logs / demo-test-traces'), barText.slice(0, 140))
check('full batch offers 加载更多 + line-cap hint',
  !!findButton(root, '加载更多', 'glab-btn') && (() => {
    let t = ''
    walk(root, (n) => { if (typeof n === 'string') t += n })
    return t.includes('可能还有更多')
  })(), null)
check('clicked 加载更多', clickButton(root, '加载更多', 'glab-btn'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
let entryCount = 0
walk(root, (n) => {
  if (n && n.props && typeof n.props.className === 'string' &&
      n.props.className.split(/\s+/).includes('wb-sls-entry')) entryCount++
})
slsText = ''
walk(root, (n) => { if (typeof n === 'string') slsText += n + '\n' })
check('load-more appends via offset (4 entries, 已取 4 条, hint stays for full batch)',
  entryCount === 4 && slsText.includes('已取 4 条') && slsText.includes('可能还有更多') && fetchLog.length > beforeMore,
  { entryCount, summary: (slsText.match(/已取 \d+ 条/) || [])[0], fetches: fetchLog.length - beforeMore })

// 查询 Loading：响应挂起时按钮变 查询中… 并禁用，重复点击不再发 POST
held.set('/sls/query', [])
const qCountBefore = fetchLog.filter((u) => u.includes('/sls/query')).length
check('clicked 查询 (response held)', clickButton(root, '查询', 'glab-btn-primary'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const qBtn = findButton(root, '查询中…', 'glab-btn-primary')
check('query shows loading state (查询中…, disabled)', !!qBtn && qBtn.props.disabled === true,
  qBtn && { text: textOf(qBtn), disabled: qBtn.props.disabled })
if (qBtn) qBtn.props.onClick({})
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('no duplicate POST while busy',
  fetchLog.filter((u) => u.includes('/sls/query')).length === qCountBefore + 1,
  { posts: fetchLog.filter((u) => u.includes('/sls/query')).length, before: qCountBefore })
releaseHeld('/sls/query')
held.delete('/sls/query') // releaseHeld only wakes waiters; drop the gate so later queries resolve
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('query settles back to 查询', !!findButton(root, '查询', 'glab-btn-primary') &&
  !findButton(root, '查询中…', 'glab-btn-primary'), null)

// 快捷区间再点一次 → 表单仍然展开（任何查询都不再自动折叠）
check('clicked preset chip 最近15分钟 again', clickButton(root, '最近15分钟', 'wb-sls-preset'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('form still open after preset re-query (no collapse)', !!findClass(root, 'wb-sls-form') && !findClass(root, 'wb-sls-collapsed'), null)

// ── 侧栏图标红点（待审批 > 0 时点亮）───────────────────────────────────────
// fresh hook tables: rendering a different component mid-run would otherwise
// read stale states (PanelIcon would collide with WorkbenchPanel's root table)
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(PanelIconComp({ size: 18 })) }
schedule()
for (let i = 0; i < 6; i++) { await tick(); await pass() }
let dot = null
walk(root, (n) => {
  if (dot) return
  if (n.type === 'span' && n.props && n.props.style && n.props.style.borderRadius === '50%') dot = n
})
check('sidebar icon shows pending red dot', !!dot, null)

// ── 侧栏行常显快捷入口（仓库 / DMS 工单 / SLS 日志 / PingCode / 技能）──────
// wide（size 16）渲染配置页勾选的常显功能入口（无首页图标——行本身即首页入口，见
// workbenchRowClickHandler；通知也无图标——入口收敛到首页通知区）；点击
// requestWorkbenchPage 持久化页面并派发 window 事件；已挂载 WorkbenchPanel
// 订阅同一事件就地切页；rail（size 18）不渲染跳转图标。window 用 stub 捕获事件与订阅。
hookTables.clear()
effectQueue = []
const wbEvents = []
const wbListeners = new Map()
const prevWindow = globalThis.window
globalThis.window = {
  addEventListener: (type, fn) => { wbListeners.set(type, fn) },
  removeEventListener: (type) => { wbListeners.delete(type) },
  dispatchEvent: (ev) => {
    wbEvents.push(ev)
    const fn = wbListeners.get(ev.type)
    if (fn) fn(ev)
    return true
  },
}
renderFn = () => { root = expand(PanelIconComp({ size: 16 })) }
schedule()
for (let i = 0; i < 6; i++) { await tick(); await pass() }
const jumps = []
walk(root, (n) => {
  if (n && n.props && n.props.className === 'wb-row-jump') jumps.push(n)
})
check('wide 侧栏行常显五个功能入口（无首页 / 无通知——行本身即首页入口，通知走首页）',
  jumps.length === 5 &&
  jumps[0].props['aria-label'] === '仓库' &&
  jumps[1].props['aria-label'] === 'DMS' &&
  jumps[2].props['aria-label'] === 'SLS' &&
  jumps[3].props['aria-label'] === 'PingCode' &&
  jumps[4].props['aria-label'] === '技能' &&
  !jumps.some((j) => j.props['aria-label'] === '首页') &&
  !jumps.some((j) => j.props['aria-label'] === 'GitHub 通知'),
  jumps.map((j) => j.props['aria-label']).join(','))

// 会话状态胶囊：每种状态一枚 wb-spill（状态图标 + 数量），按 待处理 > 进行中 >
// 未读完成 排列。r2（待审批）+ p1（待回答）= 待处理 2；r1 = 进行中 1；c1 = 未读完成 1。
// 会话列表里混入的两个子会话（mate-running / mate-done）与空白会话不计入——
// 与首页两栏同口径（宿主列表承载全部行，首页扫描剔除子会话与空白会话）。
const rowBadges = []
walk(root, (n) => {
  if (n && n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('wb-row-session-badge')) rowBadges.push(n)
})
const badgeStates = rowBadges.map((b) => b.props['data-state'])
const badgeCount = (state) => { const b = rowBadges.find((x) => x.props['data-state'] === state); return b ? textOf(b) : null }
const ORDER = ['warning', 'ongoing', 'done']
const badgeIcon = (b) => {
  let s = null
  walk(b, (n) => { if (s === null && n && n.props && typeof n.props.className === 'string' && /wb-home-s(dot|spin)/.test(n.props.className)) s = n.props['data-state'] })
  return s
}
check('侧栏会话胶囊：柔和实底 wb-spill + 同色状态图标 + 数量，按待处理 > 进行中 > 未读完成排列',
  rowBadges.length === 3 &&
  rowBadges.every((b) => b.props.className.includes('wb-spill') && badgeIcon(b) === b.props['data-state']) &&
  badgeStates.every((s, i) => i === 0 || ORDER.indexOf(badgeStates[i - 1]) < ORDER.indexOf(s)) &&
  badgeCount('warning') === '2' && badgeCount('ongoing') === '1' && badgeCount('done') === '1',
  rowBadges.map((b) => [b.props['data-state'], badgeIcon(b), textOf(b)]))
check('侧栏计数剔除首页不展示的会话（子会话 / 空白会话不计入，与首页两栏同口径）',
  badgeCount('ongoing') === '1' && badgeCount('done') === '1',
  { ongoing: badgeCount('ongoing'), done: badgeCount('done'), badges: rowBadges.map((b) => textOf(b)) })

// 仓库图标覆盖 MR/PR 和 Issues；页签与侧栏快捷入口保持一致。
check('仓库跳转图标是 FolderGit2 图形',
  pathsOf(jumps[0]).includes('M18 19a5 5 0 0 1-5-5v8') && pathsOf(jumps[0]).includes('M9 20H4'),
  pathsOf(jumps[0]).slice(0, 120))
check('DMS 跳转图标是票券图形',
  pathsOf(jumps[1]).includes('M13 11v2') && pathsOf(jumps[1]).includes('M13 5v2'),
  pathsOf(jumps[1]).slice(0, 120))
check('PingCode 跳转图标是任务清单图形',
  pathsOf(jumps[3]).includes('M12 11h4') && pathsOf(jumps[3]).includes('M16 4h2a2 2 0 0 1 2 2v14'),
  pathsOf(jumps[3]).slice(0, 120))

// 包含块守卫：根 span 必须保持静态（不带 position），行尾常显入口 cluster 的
// 绝对定位才能跳过它、以宿主行按钮（data-wb-row + position:relative）为包
// 含块贴行尾定位；红点改由内层定位包装承载。根 span 一旦定位，right:6px
// 会贴着 18px 图标把整条 cluster 推出行左缘（回归：只剩最右一个图标）。
let wbRoot = null
let glyphWrap = null
walk(root, (n) => {
  if (n && n.props && typeof n.props.title === 'string' && n.props.title.startsWith('工作台') && wbRoot === null) wbRoot = n
})
if (wbRoot && Array.isArray(wbRoot.children)) {
  glyphWrap = wbRoot.children.find((c) => c && c.props && c.props.style && c.props.style.position === 'relative') || null
}
check('根 span 静态（包含块 = 宿主行按钮）',
  !!wbRoot && !wbRoot.props.style.position && !!glyphWrap,
  wbRoot && wbRoot.props.style)
check('红点在内层定位包装内', !!glyphWrap && Array.isArray(glyphWrap.children) &&
  glyphWrap.children.some((c) => c && c.props && c.props.style && c.props.style.position === 'absolute'),
  glyphWrap && (glyphWrap.children || []).length)

// 行级点击 = 首页直达：行内跳转图标外的任意区域（工作台图标 / 标签 / 空白）
// 走同一条持久化 + page 事件通道；jump 图标与行内外来按钮的点击则留给各自的
// 处理器（真实 DOM 里该 handler 由 useLayout 挂在宿主行按钮上，先于 React
// 委托处理器触发，这里直接调用同一导出验证决策逻辑）。
const rowEl = { id: 'wb-row' }
const rowClick = plugin.workbenchRowClickHandler(rowEl)
lsStore.set('samanhappy.dsh-workbench.page', 'forge')
wbEvents.length = 0
rowClick({ target: { closest: (sel) => (sel === 'button' ? { id: 'wb-row' } : null) } })
rowClick({ target: { closest: (sel) => (sel === 'button' ? rowEl : null) } })
check('行内点击（跳转图标外）直达首页并派发 page 事件',
  lsStore.get('samanhappy.dsh-workbench.page') === 'home' && wbEvents.length === 1 &&
  wbEvents[0].type === 'samanhappy.dsh-workbench:page' && wbEvents[0].detail === 'home',
  { page: lsStore.get('samanhappy.dsh-workbench.page'), events: wbEvents.map((e) => e.detail) })
lsStore.set('samanhappy.dsh-workbench.page', 'forge')
wbEvents.length = 0
rowClick({ target: { closest: (sel) => (sel === '.wb-row-jump' ? { id: 'jump' } : { id: 'wb-row' }) } })
rowClick({ target: { closest: (sel) => (sel === '.wb-row-jump' ? null : { id: 'foreign' }) } })
check('jump 图标 / 行内外来按钮的点击不触发行级首页跳转',
  lsStore.get('samanhappy.dsh-workbench.page') === 'forge' && wbEvents.length === 0,
  { page: lsStore.get('samanhappy.dsh-workbench.page'), events: wbEvents.length })

jumps[1].props.onClick()
check('点击 DMS 跳转图标持久化 dms 页', lsStore.get('samanhappy.dsh-workbench.page') === 'dms', lsStore.get('samanhappy.dsh-workbench.page'))
check('点击 DMS 跳转图标派发 page 事件', wbEvents.length === 1 && wbEvents[0].type === 'samanhappy.dsh-workbench:page' && wbEvents[0].detail === 'dms', JSON.stringify(wbEvents))

// 已挂载面板：挂载读回持久化页（dms），收到事件就地切到 forge
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(WorkbenchPanelComp(props)) }
schedule()
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const dmsSeg = findButton(root, 'DMS', 'wb-seg-item')
check('面板挂载读回 dms 页', !!dmsSeg && dmsSeg.props.className.includes('wb-seg-active'), dmsSeg && dmsSeg.props.className)

wbEvents.length = 0
globalThis.window.dispatchEvent({ type: 'samanhappy.dsh-workbench:page', detail: 'forge' })
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const forgeSeg = findButton(root, '仓库', 'wb-seg-item')
const dmsSeg2 = findButton(root, 'DMS', 'wb-seg-item')
check('面板订阅 page 事件就地切到 forge', !!forgeSeg && forgeSeg.props.className.includes('wb-seg-active') &&
  !!dmsSeg2 && !dmsSeg2.props.className.includes('wb-seg-active'), null)
check('事件切页也持久化 forge', lsStore.get('samanhappy.dsh-workbench.page') === 'forge', lsStore.get('samanhappy.dsh-workbench.page'))

// ── 通知入口收敛到首页：无「通知」页签 / 无侧栏图标，首页通知区 + 「查看全部」
// 直达列表页（列表页仍常挂载、受功能开关约束，但不再是顶级功能页）────────────
check('clicked page tab 主页（回首页）', clickButton(root, '主页', 'wb-seg-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('顶部页签无「通知」入口（列表页只从首页进入）', !findButton(root, '通知', 'wb-seg-item'), null)
let homeAllText = ''
walk(root, (n) => { if (typeof n === 'string') homeAllText += n + '\n' })
check('首页通知区展示未读通知（标题 + repo · 类型 · 原因）',
  homeAllText.includes('GitHub 通知') && homeAllText.includes('fix: 登录跳转失效') &&
  homeAllText.includes('grp/repo-a') && homeAllText.includes('请求评审'),
  homeAllText.slice(-500))
const moreBtn = findClass(root, 'wb-home-more')
// 未读数移到通知区块头的徽标上，「查看全部」按钮只留动作 + 行尾 chevron。
const homeSecs2 = []
walk(root, (n) => {
  if (typeof n === 'object' && n !== null && n.props && n.props.className === 'wb-home-sec') homeSecs2.push(n)
})
check('首页通知徽标带未读数 + 「查看全部」按钮（未读=2）',
  homeSecs2.length >= 2 && secBadge(homeSecs2[2]) === '2' &&
  !!moreBtn && textOf(moreBtn).includes('查看全部') && !textOf(moreBtn).includes('（'),
  { badge: homeSecs2.length >= 2 ? secBadge(homeSecs2[2]) : null, btn: moreBtn && textOf(moreBtn) })
wbEvents.length = 0
moreBtn.props.onClick({})
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('点击「查看全部」就地切到通知列表页（无页签高亮，通知行渲染）',
  pageShown(root, 'notifications') && !!findClass(root, 'wb-notification-row') &&
  !findButton(root, '通知', 'wb-seg-item') &&
  wbEvents.length === 1 && wbEvents[0].type === 'samanhappy.dsh-workbench:page' && wbEvents[0].detail === 'notifications',
  { page: lsStore.get('samanhappy.dsh-workbench.page'), rows: !!findClass(root, 'wb-notification-row'), events: wbEvents.map((e) => e.detail) })
check('「查看全部」跳转持久化 notifications', lsStore.get('samanhappy.dsh-workbench.page') === 'notifications', lsStore.get('samanhappy.dsh-workbench.page'))
// 回仓库页：后续 Issues 二级导航模拟依赖 forge 页挂载
check('clicked page tab 仓库（回仓库页）', clickButton(root, '仓库', 'wb-seg-item'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }

// rail（size 18）不渲染跳转图标
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(PanelIconComp({ size: 18 })) }
schedule()
for (let i = 0; i < 6; i++) { await tick(); await pass() }
let railJumps = 0
walk(root, (n) => { if (n && n.props && n.props.className === 'wb-row-jump') railJumps++ })
check('rail 侧栏行不渲染跳转图标', railJumps === 0, railJumps)

// 回到仓库页，开始 Issues 二级导航模拟
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(WorkbenchPanelComp(props)) }
schedule()
for (let i = 0; i < 8; i++) { await tick(); await pass() }

// ── 17. Issues 二级导航：MR / PR | Issues 切换 + 列表 + 详情 + 「处理」───────
const repoSubnav = findClass(root, 'wb-subnav')

check('MR/PR 列表不挂载自动评审配置', !findClass(findClass(root, 'wb-forge-mr-half'), 'wb-auto-review'), null)
check('点击仓库配置 tab', clickButton(repoSubnav, '自动评审', 'glab-tab'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('仓库配置页挂载自动评审（概览+两栏页面布局）', !!findClass(root, 'wb-forge-config-half') && !!findClass(root, 'wb-auto-review') && !!findClass(root, 'wb-review-page'), null)
check('仓库配置导航持久化', lsStore.get('samanhappy.dsh-workbench.forge-view').includes('"subNav":"config"'), null)
clickButton(findClass(root, 'wb-subnav'), 'MR / PR', 'glab-tab')
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('离开仓库配置页卸载配置', !findClass(root, 'wb-forge-config-half'), null)
const subMr = findButton(root, 'MR / PR', 'glab-tab')
const subIssues = findButton(root, 'Issues', 'glab-tab')
check('二级导航渲染 MR / PR | Issues，默认 MR/PR 激活',
  !!subMr && !!subIssues && subMr.props.className.includes('glab-tab-active') &&
  !subIssues.props.className.includes('glab-tab-active'), null)

check('clicked 二级导航 Issues', clickButton(root, 'Issues', 'glab-tab'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
const subIssues2 = findButton(root, 'Issues', 'glab-tab')
check('Issues 半区激活', !!subIssues2 && subIssues2.props.className.includes('glab-tab-active'), null)
check('切换持久化 subNav=issues', lsStore.get('samanhappy.dsh-workbench.forge-view').includes('"subNav":"issues"'), lsStore.get('samanhappy.dsh-workbench.forge-view'))
check('Issues 激活时拉列表（默认 scope=all + state=opened）+ meta',
  fetchLog.some((u) => u.includes('/forge/issues?') && u.includes('scope=all') && u.includes('state=opened')) &&
  fetchLog.some((u) => u.includes('/forge/issue/meta?')),
  fetchLog.filter((u) => u.includes('/forge/issue')).slice(0, 4))

let issText = ''
walk(root, (n) => { if (typeof n === 'string') issText += n + '\n' })

check('Issues 表格行渲染 状态图标/标题/编号/标签/创建者/负责人/评论/关联',
  issText.includes('Issue[all]') && issText.includes('#128') && issText.includes('Bug') &&
  issText.includes('Alice') && issText.includes('Bob') && issText.includes('!142') && issText.includes('共 2 条'),
  issText.slice(0, 600))

check('Issues 工具条渲染（搜索框 + 工具条容器）',
  !!findClass(root, 'wb-iss-search-input') && !!findClass(root, 'wb-iss-toolbar'), null)
const ddBtns = []
walk(root, (n) => { if (n && n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('wb-iss-dd-btn')) ddBtns.push(n) })

// 列表行「处理」：与 MR/PR 行内「评审」同构 —— 仅在能解析出工作区、且 Issue
// 处于开启中时渲染（关闭行不给入口）。断言限定在 Issues 表格卡内，避开
// 常挂载但隐藏的 MR 半区（那里的「评审」同样是 wb-act-violet）。
const issCard = findClass(root, 'wb-iss-card')
const rowHandleBtns = []
if (issCard) walk(issCard, (n) => {
  if (n && n.type === 'button' && typeof n.props.className === 'string' && n.props.className.includes('wb-act-violet')) rowHandleBtns.push(n)
})
check('列表行「处理」按钮：开启中行 1 个、关闭行不给入口（2 行中 1 个）',
  rowHandleBtns.length === 1 && textOf(rowHandleBtns[0]).includes('处理'), rowHandleBtns.map(textOf))

// 状态下拉：默认「已开启」（仅未关闭）→ 切「已关闭」重拉
check('状态下拉默认 已开启（默认仅显示未关闭）',
  ddBtns.some(b => textOf(b).includes('已开启')),
  ddBtns.map((b) => textOf(b)))
check('clicked 状态下拉打开', clickButton(root, '已开启', 'wb-iss-dd-btn'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('clicked 状态项 已关闭', clickButton(root, '已关闭', 'wb-iss-dd-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('状态切换重拉列表 state=closed', fetchLog.some((u) => u.includes('/forge/issues?') && u.includes('state=closed')),
  fetchLog.filter((u) => u.includes('/forge/issues?')).slice(-3))
check('条件变化后出现重置筛选', !!findButton(root, '重置筛选', 'glab-btn'), null)
check('点击重置筛选', clickButton(root, '重置筛选', 'glab-btn'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('重置回默认状态并收起入口', !!findButton(root, '已开启', 'wb-iss-dd-btn') &&
  !findButton(root, '重置筛选', 'glab-btn'), null)

// 关联 MR 点击 → 跳 MR/PR 半区详情
check('clicked 关联 !142 跳 MR 详情', clickButton(root, '!142', 'wb-iss-rel'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('MR 详情打开（面包屑 Merge Requests / !142）',
  !!findClass(root, 'wb-crumbs') && textOf(findClass(root, 'wb-crumbs')).includes('Merge Requests') &&
  fetchLog.some((u) => u.includes('/forge/mr?') && u.includes('num=142')),
  fetchLog.filter((u) => u.includes('/forge/mr?')).slice(-3))
check('clicked 返回 MR 列表再回 Issues', clickButton(root, '← Merge Requests', 'wb-crumb-link'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('clicked Issues 回半区', clickButton(root, 'Issues', 'glab-tab'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }

// Issues 详情：点击标题行 → /forge/issue + 主内容 + 右侧属性面板
// 滚动回归：真实 DOM 里列表（.glab-body）与详情（.wb-iss-detail）复用同一个
// 滚动节点，打开详情若不显式置顶会残留列表的 scrollTop（详情从中部打开）。
// 先模拟列表已滚到 321，再验证详情打开后置顶、返回列表后恢复到 321。
const issScroller = () => {
  const half = findClass(root, 'wb-forge-issues-half')
  let hit = null
  if (half) walk(half, (n) => {
    if (hit || !n || typeof n !== 'object') return
    if (typeof n.props?.className === 'string' && n.props.className === 'glab-body') hit = n
  })
  return hit
}
const issListEl = issScroller()
check('Issues 列表滚动容器在（滚动回归前置）', !!issListEl, null)
if (issListEl) issListEl.scrollTop = 321
check('clicked Issue 行打开详情', clickNode(root, 'Issue[all]', 'wb-iss-cell-title'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('Issue 详情拉取 /forge/issue?num=128',
  fetchLog.some((u) => u.includes('/forge/issue?') && u.includes('num=128')),
  fetchLog.filter((u) => u.includes('/forge/issue?')).slice(-3))
let issDetailText = ''
walk(root, (n) => { if (typeof n === 'string') issDetailText += n + '\n' })
check('Issue 详情渲染 主内容（标题/描述/评论）+ 右栏（状态/负责人/标签/关联 MR/时间）',
  issDetailText.includes('详情标题') && issDetailText.includes('Issue 描述[markdown]') && issDetailText.includes('issue 评论') &&
  issDetailText.includes('状态') && issDetailText.includes('Bob') && issDetailText.includes('关联 MR / PR') && issDetailText.includes('创建'),
  issDetailText.slice(0, 500))
check('Issue 详情保留 编辑/关闭，编号直达网页，无重复网页按钮',
  !!findButton(root, '编辑', 'glab-btn') && !!findButton(root, '关闭', 'glab-btn-red') && !findButton(root, '网页', 'glab-btn') && (() => {
    let linked = false
    walk(root, n => { if (n.type === 'a' && n.props.className === 'wb-title-iid' && n.props.href?.includes('/issues/128')) linked = true })
    return linked
  })(), null)
const issDetailEl = findClass(root, 'wb-iss-detail')
check('Issue 详情打开后滚动置顶（不残留列表位置 321）',
  !!issDetailEl && issDetailEl.scrollTop === 0, issDetailEl && { scrollTop: issDetailEl.scrollTop })

// 「处理」：点击 → 解析工作区 → 新建会话 → 提交「仅分析、确认问题」的处理提示词
// （与 MR/PR「评审」共用 startItemSession；服务桩记录调用链）
const handlePromptsBefore = sessionCalls.prompts.length
check('Issue 详情动作行有「处理」（解析到工作区时出现）', !!findButton(root, '处理', 'glab-btn'), null)
check('clicked 处理 发起处理会话', clickButton(root, '处理', 'glab-btn'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('处理：connectWorkspace 用面板选中工作区（重置后回到 owning /ws/a）+ openSession + retain/release 成对',
  sessionCalls.connected.includes('ws-a') && sessionCalls.opened.includes('sess-sim-1') && sessionCalls.released >= 1,
  { connected: sessionCalls.connected, opened: sessionCalls.opened, released: sessionCalls.released })
check('处理：会话重命名为「处理 #128 …」',
  (sessionCalls.renamed[sessionCalls.renamed.length - 1] || '').startsWith('处理 #128'), sessionCalls.renamed)
const handlePrompt = sessionCalls.prompts[handlePromptsBefore]
check('处理：提交默认提示词（仅分析、确认问题；含编号/标题/仓库）',
  sessionCalls.prompts.length === handlePromptsBefore + 1 && !!handlePrompt &&
  handlePrompt.text.includes('只做分析与确认') && handlePrompt.text.includes('不改代码') &&
  handlePrompt.text.includes('#128') && handlePrompt.text.includes('Issue#128 详情标题') &&
  handlePrompt.text.includes('grp/repo-a') && handlePrompt.mode === 'queue',
  handlePrompt)

// 关闭 Issue：样式化确认 → POST /forge/issue/close
const beforeIssClose = fetchLog.length
check('clicked Issue 关闭 opens styled confirm', clickButton(root, '关闭', 'glab-btn-red'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
const issModal = findExact(root, 'wb-modal')
check('Issue 关闭对话框（关闭 #128 + 确认关闭）',
  !!issModal && textOf(issModal).includes('关闭 #128') && !!findButton(root, '确认关闭', 'glab-btn-red'), issModal && textOf(issModal))
check('clicked 确认关闭', clickButton(root, '确认关闭', 'glab-btn-red'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('Issue 关闭 POST /forge/issue/close + meta 强刷 force=1',
  fetchLog.slice(beforeIssClose).some((u) => u.includes('/forge/issue/close')) &&
  fetchLog.slice(beforeIssClose).some((u) => u.includes('/forge/issue/meta?') && u.includes('force=1')),
  fetchLog.slice(beforeIssClose, beforeIssClose + 6))
check('Issue 关闭后对话框收起', !findClass(root, 'wb-modal'), null)

// 详情里滚过（模拟读完长评论滚到下方）后返回：列表要回到进入详情前的位置。
const issDetailEl2 = findClass(root, 'wb-iss-detail')
if (issDetailEl2) issDetailEl2.scrollTop = 200
check('clicked ← Issues 回列表', clickButton(root, '← Issues', 'wb-crumb-link'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
const issListEl2 = issScroller()
check('返回列表恢复进入详情前的滚动位置（321，而非停在中部/底部）',
  !!issListEl2 && issListEl2.scrollTop === 321, issListEl2 && { scrollTop: issListEl2.scrollTop })

// 批量选择：表头全选 → 批量条 → 批量关闭（只关闭 opened 行）
const headCheck = (() => {
  let hit = null
  walk(findClass(root, 'wb-forge-issues-half'), (n) => {
    if (hit || !n || n.type !== 'input') return
    const cls = n.props && n.props.className
    void cls
    if (n.props && n.props.type === 'checkbox') hit = n
  })
  return hit
})()
check('表头全选框渲染', !!headCheck && headCheck.props.type === 'checkbox', null)
if (headCheck) {
  headCheck.props.onChange({ target: { checked: true } })
  for (let i = 0; i < 4; i++) { await tick(); await pass() }
  let batchText = ''
  walk(root, (n) => { if (typeof n === 'string') batchText += n })
  check('批量条出现（已选 + 批量关闭）', batchText.includes('已选') && batchText.includes('批量关闭'), batchText.slice(0, 200))
  const beforeBatch = fetchLog.length
  check('clicked 批量关闭 opens confirm', clickButton(root, '批量关闭', 'glab-btn-red'), null)
  for (let i = 0; i < 3; i++) { await tick(); await pass() }
  const batchModal = findExact(root, 'wb-modal')
  check('批量关闭对话框（关闭 N 个 Issue）', !!batchModal && /关闭 \d+ 个 Issue/.test(textOf(batchModal)), batchModal && textOf(batchModal))
  check('clicked 确认关闭（批量）', clickButton(root, '确认关闭', 'glab-btn-red'), null)
  for (let i = 0; i < 10; i++) { await tick(); await pass() }
  const batchPosts = fetchLog.slice(beforeBatch).filter((u) => u.includes('/forge/issue/close'))
  check('批量关闭逐条 POST（只关 opened 行）', batchPosts.length === 1 && !findClass(root, 'wb-modal'),
    { posts: batchPosts.length })
}

// ── 18. PingCode 研发管理页（python3 技能 api_call.py）──────────────────────
// PingCode 页与其余页一样常挂载：首挂载即探测 /pingcode/status（端到端探测：
// python3 / 技能目录 / .env 凭证 / 真实 API）并拉项目/成员/工作项。
check('pingcode status probed on mount (python + skill + API)',
  fetchLog.some((u) => u.includes('/pingcode/status')), null)
check('page tab PingCode renders', !!findButton(root, 'PingCode', 'wb-seg-item'), null)
check('clicked page tab PingCode', clickButton(root, 'PingCode', 'wb-seg-item'), null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
const pcTab2 = findButton(root, 'PingCode', 'wb-seg-item')
check('pingcode page active after switch', !!pcTab2 && pcTab2.props.className.includes('wb-seg-active'), null)
check('pingcode page persisted to localStorage', lsStore.get('samanhappy.dsh-workbench.page') === 'pingcode', lsStore.get('samanhappy.dsh-workbench.page'))

let pcText = ''
walk(root, (n) => { if (typeof n === 'string') pcText += n + '\n' })
check('pingcode toolbar: title + stat chips (服务端 stats) + 已连接 meta',
  pcText.includes('待处理 153') && pcText.includes('进行中 2') && pcText.includes('已完成 0') &&
  pcText.includes('已关闭 0') && pcText.includes('PingCode 已连接') &&
  pcText.includes('状态统计为服务端实时结果'),
  pcText.split('\n').filter((l) => l.includes('待处理') || l.includes('PingCode 已连接') || l.includes('状态统计')).slice(0, 8))
check('pingcode filter form renders (me/project/type/assignee/search)',
  pcText.includes('我（Alice）') && pcText.includes('全部项目') && pcText.includes('全部类型') &&
  pcText.includes('全部负责人') && pcText.includes('搜索（编号/标题）'),
  pcText.slice(0, 300))
check('default query: assignee=me + stateType=pending requested from host',
  fetchLog.some((u) => u.includes('/pingcode/workitems') && u.includes('assigneeId=me') && u.includes('stateType=pending')), null)
check('default state filter=pending auto-filled remaining page (no manual 加载更多)',
  fetchLog.some((u) => u.includes('/pingcode/workitems') && u.includes('page=2')), null)
check('default view (负责人=我 + 待处理, 服务端过滤) shows only pending rows incl. page-2 rows',
  pcText.includes('批量工作项3[PC]') && pcText.includes('SCR-155') &&
  !pcText.includes('优化登录性能') && pcText.includes('当前显示 153 条「待处理」'),
  pcText.split('\n').filter((l) => l.includes('当前显示') || l.includes('优化登录')).slice(0, 6))

// 状态快筛 pills：默认待处理已激活——点一下取消回全部（progress 行也出现），再点恢复筛选。
check('clicked 待处理 stat pill resets default filter (all rows)',
  clickButton(root, '待处理 153', 'wb-pc-stat'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
let pcAll = ''
walk(root, (n) => { if (typeof n === 'string') pcAll += n + '\n' })
check('reset filter shows all rows including progress rows (page 1 only; 已关闭 pill from stats)',
  pcAll.includes('优化登录性能') && pcAll.includes('接口文档更新') && pcAll.includes('SCR-100') &&
  pcAll.includes('已关闭 0') && !pcAll.includes('SCR-155') && !pcAll.includes('当前显示'),
  pcAll.split('\n').filter((l) => l.includes('当前显示') || l.includes('优化登录') || l.includes('SCR-15') || l.includes('已关闭')).slice(0, 6))
check('clicked 待处理 stat pill again filters pending only (计数仍来自 stats)',
  clickButton(root, '待处理 153', 'wb-pc-stat'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }

// 详情：描述 + 评论 + 「在 PingCode 打开」（默认视图首行是 SCR-3）
// 滚动回归（同 Issues）：列表/详情共用 .glab-body 滚动节点，详情打开须置顶、
// 返回列表恢复原位。先模拟列表已滚到 345。
const pcListEl = scrollerWith('批量工作项3[PC]')
check('PingCode 列表滚动容器在（滚动回归前置）', !!pcListEl, null)
if (pcListEl) pcListEl.scrollTop = 345
let pcRowOpen = false
walk(root, (n) => {
  if (pcRowOpen) return
  if (n && n.props && n.props.className === 'wb-item-top' && textOf(n).includes('批量工作项3[PC]') &&
      typeof n.props.onClick === 'function') {
    n.props.onClick({ stopPropagation() {} }); pcRowOpen = true
  }
})
check('clicked work item row opens detail', pcRowOpen, null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
pcText = ''
walk(root, (n) => { if (typeof n === 'string') pcText += n + '\n' })
check('work item detail: kv + description + comments + open link',
  pcText.includes('登录页首屏优化') && pcText.includes('评论（1）') &&
  pcText.includes('已复现，优先处理') && pcText.includes('在 PingCode 打开') &&
  pcText.includes('Alice'),
  pcText.slice(0, 400))
const pcDetailBody = scrollerWith('在 PingCode 打开')
check('PingCode 详情打开后滚动置顶（不残留列表位置 345）',
  !!pcDetailBody && pcDetailBody.scrollTop === 0, pcDetailBody && { scrollTop: pcDetailBody.scrollTop })
// 详情里滚过（模拟读完评论滚到下方）后返回：列表要回到进入详情前的位置。
if (pcDetailBody) pcDetailBody.scrollTop = 200
check('clicked ← 返回列表 (crumb link)', clickButton(root, '← 返回列表', 'wb-crumb-link'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('back to pingcode list (detail closed)', !findClass(root, 'wb-pc-notes'), null)
const pcListEl2 = scrollerWith('批量工作项3[PC]')
check('PingCode 返回列表恢复进入详情前的滚动位置（345，而非停在中部/底部）',
  !!pcListEl2 && pcListEl2.scrollTop === 345, pcListEl2 && { scrollTop: pcListEl2.scrollTop })

// 挂起独立成桶（不再混入待处理）：pill 计数来自服务端五桶 stats，点击按
// stateType=suspended 服务端过滤，摘要行诚实标注桶名。
let pcPills = ''
walk(root, (n) => { if (typeof n === 'string') pcPills += n + '\n' })
check('挂起 pill renders (五桶 stats，计数 2)', pcPills.includes('挂起 2'),
  pcPills.split('\n').filter((l) => l.includes('挂起') || l.includes('待处理')).slice(0, 8))
// 详情页上点状态快筛 tab = 按该分类回列表：重开详情再点 「挂起 2」，详情要
// 收起落到过滤后的列表（此前 query 变了但详情仍盖在列表上，点了没反应）。
let pcRowReopen = false
walk(root, (n) => {
  if (pcRowReopen) return
  if (n && n.props && n.props.className === 'wb-item-top' && textOf(n).includes('批量工作项3[PC]') &&
      typeof n.props.onClick === 'function') {
    n.props.onClick({ stopPropagation() {} }); pcRowReopen = true
  }
})
check('clicked work item row re-opens detail (stat-pill-from-detail precondition)', pcRowReopen, null)
for (let i = 0; i < 10; i++) { await tick(); await pass() }
let pcDetail2 = ''
walk(root, (n) => { if (typeof n === 'string') pcDetail2 += n + '\n' })
check('detail open again before pill click (评论卡在)',
  pcDetail2.includes('评论（1）') && !!findClass(root, 'wb-pc-notes'), null)
check('clicked 挂起 stat pill while detail open', clickButton(root, '挂起 2', 'wb-pc-stat'), null)
for (let i = 0; i < 6; i++) { await tick(); await pass() }
check('stat pill click from detail returns to the list (详情收起)',
  !findClass(root, 'wb-pc-notes') && !findButton(root, '← 返回列表', 'wb-crumb-link'), null)
check('suspended filter requested from host (stateType=suspended)',
  fetchLog.some((u) => u.includes('/pingcode/workitems') && u.includes('stateType=suspended')), null)
let pcSusp = ''
walk(root, (n) => { if (typeof n === 'string') pcSusp += n + '\n' })
check('suspended view shows only suspended rows with honest summary (「挂起」桶名)',
  pcSusp.includes('当前显示 2 条「挂起」') && pcSusp.includes('挂起项A[PC]') &&
  !pcSusp.includes('批量工作项3[PC]'),
  pcSusp.split('\n').filter((l) => l.includes('当前显示') || l.includes('挂起项')).slice(0, 6))
check('clicked 挂起 stat pill again resets to all', clickButton(root, '挂起 2', 'wb-pc-stat'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }

// ── 19. 配置独立顶级页 + 收起 / 展开：默认全部收起，点标题行展开编辑详情 ───────
// 仓库页的 ⚙ disclosure 移除 —— 配置是顶级「配置」页（页签常在，不叠在列表
// 上方），按需挂载（离开页面即卸载，每次进入都全收起）。面板内每条配置：
// 收起行 = 标题 + 定制状态 + 一行内容摘要（定制值首行优先，否则默认模板首行）；
// textarea / 占位符 chips / 默认模板预览只在展开后挂载；「恢复默认」收起态即可用。
// 断言都圈定在 .wb-config 面板子树内 —— SLS 等其他常挂载页有自己的 textarea，
// 全树统计会误伤。
lsStore.set('samanhappy.dsh-workbench.config', JSON.stringify({ 'prompt.review': '定制评审指令首行\n第二行' }))
check('clicked page tab 配置', clickButton(root, '设置', 'wb-seg-item'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('config page persisted to localStorage', lsStore.get('samanhappy.dsh-workbench.page') === 'config', lsStore.get('samanhappy.dsh-workbench.page'))
check('configuration navigation announces current page', findButton(root, '设置', 'wb-seg-item')?.props['aria-current'] === 'page', null)
check('config page tab active after switch', !!findButton(root, '设置', 'wb-seg-item') &&
  findButton(root, '设置', 'wb-seg-item').props.className.includes('wb-seg-active'), null)

const cfgPanel = () => findExact(root, 'wb-config')
check('config panel mounted on the config page', !!cfgPanel(), null)

const countTextareas = () => {
  let c = 0
  walk(cfgPanel(), (n) => { if (n.type === 'textarea') c++ })
  return c
}

check('default collapsed: no textarea mounted', countTextareas() === 0, countTextareas())

let cfgText = ''
walk(cfgPanel(), (n) => { if (typeof n === 'string') cfgText += n + '\n' })
check('customized item flagged 已定制 while collapsed', cfgText.includes('已定制'), null)

check('clicked 评审提示词 row expands it', clickButton(root, '评审提示词', 'wb-config-toggle'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const revToggle = findButton(root, '评审提示词', 'wb-config-toggle')
check('expanded: aria-expanded=true', !!revToggle && revToggle.props['aria-expanded'] === true,
  revToggle && revToggle.props['aria-expanded'])
check('expanded: exactly one textarea (the clicked item only)', countTextareas() === 1, countTextareas())
let taNode = null
walk(cfgPanel(), (n) => { if (!taNode && n.type === 'textarea') taNode = n })
check('expanded textarea carries the customized draft',
  !!taNode && taNode.props.value === '定制评审指令首行\n第二行', taNode && taNode.props.value)
check('clicked 评审提示词 row again collapses it', clickButton(root, '评审提示词', 'wb-config-toggle'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const revToggle2 = findButton(root, '评审提示词', 'wb-config-toggle')
check('re-collapsed: textarea gone + aria-expanded=false',
  countTextareas() === 0 && !!revToggle2 && revToggle2.props['aria-expanded'] === false,
  { taCount: countTextareas() })

// 收起态的「恢复默认」：一键清定制，无需先展开。必须点在**评审提示词**那一行
// 自己的按钮上，避免点到其他配置项的恢复按钮。
let resetClicked = false
walk(cfgPanel(), (n) => {
  if (resetClicked) return
  if (!n || !n.props || typeof n.props.className !== 'string' ||
      !n.props.className.includes('wb-config-item')) return
  if (!textOf(n).includes('评审提示词')) return
  walk(n, (b) => {
    if (resetClicked) return
    if (b.type === 'button' && b.props.className === 'glab-btn' && textOf(b) === '恢复默认' &&
        typeof b.props.onClick === 'function') {
      b.props.onClick({ stopPropagation() {} }); resetClicked = true
    }
  })
})
check('clicked 恢复默认 on the collapsed customized row', resetClicked, null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
cfgText = ''
walk(cfgPanel(), (n) => { if (typeof n === 'string') cfgText += n + '\n' })
check('after reset: default state restored and override removed',
  !cfgText.includes('已定制') && !JSON.parse(lsStore.get('samanhappy.dsh-workbench.config') || '{}')['prompt.review'],
  lsStore.get('samanhappy.dsh-workbench.config'))

// 评审模型（kind 'model'）：配置页多一行下拉，数据源是 Host 模型目录
// （remote.session.modelCatalog）。sim 的桩 ctx 没有 remote，因此这里走的是
// 「目录不可用」分支：下拉仍必须渲染、写明不可用原因，且用户已有的选择可以被
// 清除（不能因目录不可用就丢掉配置能力）。选中后立即写 localStorage。
check('review model is available inline', !findButton(root, '评审模型', 'wb-config-toggle'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
const modelSelect = (() => {
  let found = null
  walk(cfgPanel(), (n) => { if (!found && n && n.type === 'select' && n.props['aria-label'] === '评审模型') found = n })
  return found
})()
check('评审模型下拉渲染（aria-label + 沿用默认项）',
  !!modelSelect && modelSelect.props['aria-label'] === '评审模型' &&
  modelSelect.props.value === '' && textOf(modelSelect).includes('沿用 DSH 默认模型'),
  modelSelect && { value: modelSelect.props.value, text: textOf(modelSelect) })
cfgText = ''
walk(cfgPanel(), (n) => { if (typeof n === 'string') cfgText += n + '\n' })
check('模型目录不可用时如实说明（并提示已存选择仍生效）',
  cfgText.includes('无法读取模型目录') && cfgText.includes('恢复默认'),
  cfgText.split('\n').filter((l) => l.includes('模型目录')).slice(0, 2))
if (modelSelect) modelSelect.props.onChange({ target: { value: 'deepseek-account/deepseek-v4-pro' } })
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('选择评审模型后写入配置（review.model = provider/model）',
  JSON.parse(lsStore.get('samanhappy.dsh-workbench.config') || '{}')['review.model'] === 'deepseek-account/deepseek-v4-pro',
  lsStore.get('samanhappy.dsh-workbench.config'))
const modelSelect2 = (() => {
  let found = null
  walk(cfgPanel(), (n) => { if (!found && n && n.type === 'select' && n.props['aria-label'] === '评审模型') found = n })
  return found
})()
cfgText = ''
walk(cfgPanel(), (n) => { if (typeof n === 'string') cfgText += n + '\n' })
check('已选模型在下拉里回显且被标为「当前不可用」（目录不可用时也不静默丢配置）',
  !!modelSelect2 && modelSelect2.props.value === 'deepseek-account/deepseek-v4-pro' &&
  textOf(modelSelect2).includes('当前不可用'),
  modelSelect2 && { value: modelSelect2.props.value, text: textOf(modelSelect2) })

// 离开配置页 → 面板卸载（按需挂载：再进入时回到全收起；编辑中的草稿先经
// blur 提交，不丢）。
check('clicked page tab 仓库 leaves the config page', clickButton(root, '仓库', 'wb-seg-item'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('config panel unmounted after leaving the page', !findExact(root, 'wb-config'), null)

// ── 20. 功能开关：关闭 = 隐藏入口 + 不挂载功能页 + 不发该域请求 ───────────────
// 开关登记在配置页（kind 'toggle'，localStorage 覆盖值，默认开启）。这里驱动
// 真实组件断言：
//   a. 关掉 SLS / PingCode 后，两者的页签消失、面板根节点不挂载，也不再请求
//      /sls、/pingcode 路由（技能默认开启，页签仍显示）；
//   b. 上次所在页恰好被关掉（pingcode）时，落回仍开启的第一个功能页并持久化；
//   c. 侧边栏 hover 跳转图标只渲染开启的功能域；
//   d. 在配置页点开关（不刷新）→ 页签即时恢复（配置变更广播驱动重渲染）。
lsStore.set('samanhappy.dsh-workbench.config', JSON.stringify({ 'feature.sls': 'off', 'feature.pingcode': 'off' }))
lsStore.set('samanhappy.dsh-workbench.page', 'pingcode') // 上次停留在被关掉的页
hookTables.clear()
effectQueue = []
const logBefore = fetchLog.length
renderFn = () => { root = expand(WorkbenchPanelComp(props)) }
schedule()
for (let i = 0; i < 8; i++) { await tick(); await pass() }

check('关闭的功能页不渲染页签（只剩 仓库 / DMS / 配置）',
  !!findButton(root, '仓库', 'wb-seg-item') && !!findButton(root, 'DMS', 'wb-seg-item') &&
  !!findButton(root, '设置', 'wb-seg-item') &&
  !findButton(root, 'SLS', 'wb-seg-item') && !findButton(root, 'PingCode', 'wb-seg-item'),
  { segs: (() => { const out = []; walk(root, (n) => { if (n.type === 'button' && String(n.props.className || '').includes('wb-seg-item')) out.push(textOf(n)) }); return out })() })
check('关闭的功能页组件不挂载（SLS 表单 / PingCode 工具条都不存在）',
  !findClass(root, 'wb-sls-form') && !findClass(root, 'wb-pc-stats'), null)
check('被关掉的持久化页（pingcode）落回仍开启的第一个功能页',
  !!findButton(root, '仓库', 'wb-seg-item') &&
  findButton(root, '仓库', 'wb-seg-item').props.className.includes('wb-seg-active') &&
  lsStore.get('samanhappy.dsh-workbench.page') === 'forge', lsStore.get('samanhappy.dsh-workbench.page'))
const urlsAfterOff = fetchLog.slice(logBefore)
check('关闭的功能域不发任何请求（无 /sls、/pingcode）',
  urlsAfterOff.length > 0 && urlsAfterOff.every((u) => !u.includes('/sls/') && !u.includes('/pingcode/')),
  urlsAfterOff)

// 侧边栏常显入口（wide）只渲染开启且勾选的功能域：SLS/PingCode 关掉后剩 3 个
// （仓库 / DMS 工单 / 技能 —— 技能默认开启；通知本就无图标）；首页无图标，
// 行本身即首页入口
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(PanelIconComp({ size: 16 })) }
schedule()
for (let i = 0; i < 6; i++) { await tick(); await pass() }
const offJumpLabels = []
walk(root, (n) => { if (n && n.props && n.props.className === 'wb-row-jump') offJumpLabels.push(n.props['aria-label']) })
check('关闭功能域的侧边栏跳转图标隐藏', offJumpLabels.join(',') === '仓库,DMS,技能', offJumpLabels.join(','))

// d. 回到配置页：五个开关 + 关闭态可读；点 SLS 开关 → 覆盖值清除、页签即时恢复
hookTables.clear()
effectQueue = []
renderFn = () => { root = expand(WorkbenchPanelComp(props)) }
schedule()
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('clicked page tab 配置（功能开关组）', clickButton(root, '设置', 'wb-seg-item'), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
let slsSwitch = null
walk(root, (n) => {
  if (!slsSwitch && n.type === 'button' && n.props['aria-label'] === 'SLS' &&
      String(n.props.className || '').includes('wb-switch')) slsSwitch = n
})
check('SLS 开关初始为关（已关闭）', !!slsSwitch && slsSwitch.props['aria-checked'] === false,
  slsSwitch && slsSwitch.props['aria-checked'])
check('clicked SLS 功能开关', !!slsSwitch && (slsSwitch.props.onClick({ stopPropagation() {} }), true), null)
for (let i = 0; i < 4; i++) { await tick(); await pass() }
check('再开启 = 回到默认，覆盖值被清除（已定制标记消失）',
  !('feature.sls' in JSON.parse(lsStore.get('samanhappy.dsh-workbench.config'))),
  lsStore.get('samanhappy.dsh-workbench.config'))
check('开启后页签即时恢复（配置变更广播驱动，无需刷新）', !!findButton(root, 'SLS', 'wb-seg-item'), null)
check('PingCode 仍关闭（互不影响）', !findButton(root, 'PingCode', 'wb-seg-item'), null)

// 收尾：整场模拟零原生 confirm()——所有确认（合并/关闭）都走样式化对话框
check('整个面板从未调用原生 confirm()', confirmCalls === 0, confirmCalls)

// 从没有所属工作区的全局面板进入：先选择，不能向 host 发无 cwd 的列表请求。
lsStore.set('samanhappy.dsh-workbench.page', 'forge')
lsStore.delete('samanhappy.dsh-workbench.forge-view')
hookTables.clear()
effectQueue = []
const beforeUnbound = fetchLog.length
renderFn = () => { root = expand(WorkbenchPanelComp({
  useSessions: sel => sel({ current: 'empty-session' }),
  useWorkspaces: sel => sel({ items: [{ path: '/empty', sessionIds: ['empty-session'] }] }),
})) }
schedule()
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('未选仓库显示选择入口，隐藏列表与筛选', fullTextNow().includes('选择一个仓库') &&
  !!findButton(root, '选择工作区', 'glab-btn-primary') && !findClass(root, 'wb-iss-toolbar'), null)
check('未选仓库不请求 state / MR / Issues', !fetchLog.slice(beforeUnbound).some(u =>
  /\/forge\/(state|mrs|issues)(\?|$)/.test(u)), fetchLog.slice(beforeUnbound))
check('选择入口打开工作区列表', clickButton(root, '选择工作区', 'glab-btn-primary'), null)
for (let i = 0; i < 3; i++) { await tick(); await pass() }
check('选择后正常进入仓库', clickButton(root, 'repo-a', 'wb-picker-item'), null)
for (let i = 0; i < 8; i++) { await tick(); await pass() }
check('选中仓库后恢复二级导航', !!findButton(root, 'Issues', 'glab-tab'), null)

if (prevWindow === undefined) delete globalThis.window
else globalThis.window = prevWindow

console.log(failures === 0 ? '\nALL PASS' : '\nFAILURES: ' + failures)
process.exit(failures === 0 ? 0 : 1)
