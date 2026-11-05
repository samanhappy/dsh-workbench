// Standalone smoke test for the dsh-workbench host half (dual forge: GitLab +
// GitHub).
// Mocks the DSH composition services (webServer/connection/subprocess) around
// index.js and drives each /forge route with a fake req/res pair. The
// subprocess mock spawns REAL glab / gh, so this validates the exact argv
// wiring for both CLIs.
import { spawnSync } from 'node:child_process'
import { Writable } from 'node:stream'

// This smoke test drives REAL glab / gh / aliyun against a real forge and log
// store, so it only runs when the target is supplied explicitly. Without the
// required SMOKE_* variables it prints a skip line and exits 0, so the suite
// never reaches any company infrastructure from a fresh checkout.
//
//   SMOKE_GITLAB_HOST / SMOKE_GITLAB_REPO / SMOKE_GITLAB_MR   (required)
//   SMOKE_ISSUES_REPO      issues repo path      (default samanhappy/dsh-workbench)
//   SMOKE_GITHUB_REPO      GitHub owner/repo     (default octocat/Hello-World)
//   SMOKE_SLS_PROJECT / SMOKE_SLS_LOGSTORE       SLS target for the log query
//   SMOKE_DMS_PERM_ORDER / SMOKE_DMS_DC_ORDER /
//   SMOKE_DMS_NDDL_ORDER / SMOKE_DMS_EXPORT_ORDER  real DMS order ids, per type
const SMOKE_ENV = process.env
const SMOKE = {
  gitlabHost: SMOKE_ENV.SMOKE_GITLAB_HOST || '',
  gitlabRepo: SMOKE_ENV.SMOKE_GITLAB_REPO || SMOKE_ENV.SMOKE_GITLAB_GIT_REPO || '',
  gitlabMr: SMOKE_ENV.SMOKE_GITLAB_MR || '',
  issuesRepo: SMOKE_ENV.SMOKE_ISSUES_REPO || 'samanhappy/dsh-workbench',
  githubRepo: SMOKE_ENV.SMOKE_GITHUB_REPO || 'octocat/Hello-World',
  slsProject: SMOKE_ENV.SMOKE_SLS_PROJECT || '',
  slsLogstore: SMOKE_ENV.SMOKE_SLS_LOGSTORE || '',
  dmsOrders: {
    perm: SMOKE_ENV.SMOKE_DMS_PERM_ORDER || '',
    dc: SMOKE_ENV.SMOKE_DMS_DC_ORDER || '',
    nddl: SMOKE_ENV.SMOKE_DMS_NDDL_ORDER || '',
    export: SMOKE_ENV.SMOKE_DMS_EXPORT_ORDER || '',
  },
}
const SMOKE_MISSING = [
  ['SMOKE_GITLAB_HOST', SMOKE.gitlabHost],
  ['SMOKE_GITLAB_REPO', SMOKE.gitlabRepo],
  ['SMOKE_GITLAB_MR', SMOKE.gitlabMr],
].filter(([, v]) => !v).map(([k]) => k)
if (SMOKE_MISSING.length) {
  console.log('SKIP  smoke.mjs: real-CLI smoke needs ' + SMOKE_MISSING.join(', ') +
    ' (optional: SMOKE_ISSUES_REPO, SMOKE_GITHUB_REPO, SMOKE_SLS_PROJECT, SMOKE_SLS_LOGSTORE)')
  process.exit(0)
}

const routes = []
// Every spawned argv (exe + args joined), for spawn-count assertions.
const spawnLog = []
const webServerMock = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const connectionMock = {
  requestRejection() { return undefined }, // allow all in test
  // The bundled git host modules register their routes on the connection's
  // fetch registry (as they do in DSH), not on webServer.
  fetch: { register() { return () => {} } },
}
const subprocessMock = {
  async resolveExecutable(cmd) { return cmd },
  spawn(spec) {
    spawnLog.push([spec.argv[0]].concat(spec.argv.slice(1)).join(' '))
    const res = spawnSync(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 60000,
    })
    const handle = {
      collected: {
        stdout: { readFrom() { return { text: res.stdout || '' } } },
        stderr: { readFrom() { return { text: res.stderr || '' } } },
      },
      done: new Promise((resolve) => {
        setImmediate(() => resolve({ exitCode: res.status }))
      }),
      terminate() {},
      waitForExit() { return Promise.resolve(true) },
    }
    return handle
  },
}
const ctx = {
  webServer: webServerMock,
  connection: connectionMock,
  subprocess: subprocessMock,
  get(name) {
    if (name === 'webServer') return webServerMock
    if (name === 'connection') return connectionMock
    if (name === 'subprocess') return subprocessMock
    if (name === 'sandboxPolicy') {
      return { workspaceRoot: testRoot }
    }
    return undefined
  },
  effect(fn, label) { fn(); return () => {} },
}

// ── throwaway workspaces: one GitLab remote, one GitHub remote ──────────────
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Workspace root of this test itself (the plugin repo), derived from the
// script location so no absolute path or user name is hardcoded.
const testRoot = dirname(fileURLToPath(import.meta.url))

function makeWs(remoteUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'forgews-'))
  spawnSync('git', ['init', '-q', dir])
  spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteUrl])
  return dir
}
const glWs = makeWs('https://' + SMOKE.gitlabHost + '/' + SMOKE.gitlabRepo + '.git')
const ghWs = makeWs('https://github.com/' + SMOKE.githubRepo + '.git')
process.on('exit', () => {
  for (const dir of [glWs, ghWs]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (e) {}
  }
})
const origGet = ctx.get
ctx.get = function (name) {
  if (name === 'workspaceRegistry') {
    return {
      list: () => [
        { id: 'w1', path: glWs, title: 'glabws', createdAt: '', updatedAt: '' },
        { id: 'w2', path: ghWs, title: 'ghws', createdAt: '', updatedAt: '' },
      ],
    }
  }
  return origGet.call(this, name)
}

const { apply } = await import('./index.js')
apply(ctx)

function makeReqRes(method, url, body) {
  const req = {
    method,
    url,
    on() {},
  }
  const res = new Writable({
    write(chunk, enc, cb) {
      res._body = (res._body || '') + chunk.toString()
      cb()
    },
  })
  res.statusCode = 200
  res.setHeader = () => {}
  res.end = (chunk) => {
    if (chunk) res._body += chunk.toString()
    res._ended = true
  }
  res._body = ''
  res._reqBody = body
  return { req, res }
}

async function call(path, method = 'GET', body) {
  const pathname = path.split('?')[0]
  const route = routes.find((r) => r.kind === 'exact' && r.path === pathname)
  if (!route) throw new Error('no route for ' + pathname)
  const { req, res } = makeReqRes(method, path, body)
  // fake body reader: index.js reads via req 'data'/'end' events
  if (body !== undefined) {
    const chunks = [Buffer.from(JSON.stringify(body))]
    const listeners = {}
    req.on = (ev, fn) => { listeners[ev] = fn }
    process.nextTick(() => {
      for (const c of chunks) listeners.data && listeners.data(c)
      listeners.end && listeners.end()
    })
  } else {
    const listeners = {}
    req.on = (ev, fn) => { listeners[ev] = fn }
    process.nextTick(() => { listeners.end && listeners.end() })
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res._body || '{}') }
}

// ── run the smoke tests ─────────────────────────────────────────────────────
const R = SMOKE.gitlabRepo
const H = SMOKE.gitlabHost
const MR = SMOKE.gitlabMr
const GR = 'https://github.com/' + SMOKE.githubRepo

const results = []
async function check(name, fn) {
  try {
    const out = await fn()
    results.push({ name, ok: true, detail: out })
  } catch (e) {
    results.push({ name, ok: false, detail: String(e && e.message ? e.message : e) })
  }
}

await check('state (default workspace)', async () => {
  const r = await call('/forge/state')
  return { repo: r.json.repo && { host: r.json.repo.host, forge: r.json.repo.forge }, workspace: r.json.workspace }
})

await check('state with cwd = GitLab workspace repo', async () => {
  const r = await call('/forge/state?cwd=' + encodeURIComponent(glWs))
  return {
    ok: r.json.ok,
    host: r.json.repo && r.json.repo.host,
    path: r.json.repo && r.json.repo.path,
    forge: r.json.repo && r.json.repo.forge,
    branch: r.json.repo && r.json.repo.branch,
    myOpen: (r.json.myOpen || []).length,
  }
})

await check('state with cwd = GitHub workspace repo', async () => {
  spawnLog.length = 0
  const r = await call('/forge/state?force=1&cwd=' + encodeURIComponent(ghWs))
  const tabListCalls = spawnLog.filter((s) => s.includes(' pr list ') && !s.includes('--head')).length
  return {
    ok: r.json.ok,
    host: r.json.repo && r.json.repo.host,
    path: r.json.repo && r.json.repo.path,
    forge: r.json.repo && r.json.repo.forge,
    viewer: r.json.viewer && r.json.viewer.username,
    allOpen: (r.json.allOpen || []).length,
    myOpen: (r.json.myOpen || []).length,
    review: (r.json.reviewRequests || []).length,
    // 50 条打满 → 应自动退回逐口径查询（all + mine + review = 3 条 pr list）
    prListCalls: tabListCalls,
  }
})

// 三页签一次拉全：/forge/state 只发一条页签口径的 `mr list`（mine/review 由
// 宿主本地分桶），不再是 mine/review/all 三条并行查询。--source-branch 的
// branchMR 查询（git ≥2.28 对未出生分支也报 main）单独计数，不参与该断言。
await check('state issues exactly ONE mr list (tabs bucketed locally)', async () => {
  spawnLog.length = 0
  const r = await call('/forge/state?force=1&cwd=' + encodeURIComponent(glWs))
  const tabListCalls = spawnLog.filter((s) => s.includes(' mr list ') && !s.includes('--source-branch')).length
  if (tabListCalls !== 1) {
    throw new Error('expected exactly 1 tab `mr list` per state load, got ' + tabListCalls + ': ' + JSON.stringify(spawnLog, null, 1))
  }
  const branchListCalls = spawnLog.filter((s) => s.includes(' mr list ') && s.includes('--source-branch')).length
  const graphql = spawnLog.filter((s) => s.includes(' api graphql ')).length
  return {
    ok: r.json.ok,
    mrListCalls: tabListCalls,
    branchListCalls,
    graphqlCalls: graphql,
    myOpen: (r.json.myOpen || []).length,
    review: (r.json.reviewRequests || []).length,
    all: (r.json.allOpen || []).length,
  }
})

await check('gitlab mrs scope=all with explicit repo', async () => {
  const r = await call('/forge/mrs?scope=all&repo=' + R + '&host=' + H)
  return { ok: r.json.ok, count: (r.json.mrs || []).length, first: r.json.mrs && r.json.mrs[0] && { num: r.json.mrs[0].num, forge: r.json.mrs[0].forge } }
})

await check('gitlab mrs scope=mine with explicit repo', async () => {
  const r = await call('/forge/mrs?scope=mine&repo=' + R + '&host=' + H)
  return { ok: r.json.ok, count: (r.json.mrs || []).length }
})

// 待评审口径：指派给我且我尚未批准 —— 已批准的 MR 由 GraphQL approvedBy
// 覆盖层剔除（回归：批准后仍出现在 --reviewer @me 列表）。
await check('gitlab mrs scope=review (approval overlay filters approved-by-me)', async () => {
  const r = await call('/forge/mrs?scope=review&repo=' + R + '&host=' + H)
  return { ok: r.json.ok, count: (r.json.mrs || []).length, nums: (r.json.mrs || []).map((m) => m.num) }
})

await check('github mrs scope=all (auto-detected forge)', async () => {
  const r = await call('/forge/mrs?scope=all&repo=' + GR)
  return { ok: r.json.ok, count: (r.json.mrs || []).length, first: r.json.mrs && r.json.mrs[0] && { num: r.json.mrs[0].num, forge: r.json.mrs[0].forge } }
})

await check('github mrs scope=review (search review-requested:@me)', async () => {
  const r = await call('/forge/mrs?scope=review&repo=' + GR)
  return { ok: r.json.ok, count: (r.json.mrs || []).length }
})

await check('github mrs with explicit forge param (full-url repo)', async () => {
  const r = await call('/forge/mrs?scope=all&repo=' + encodeURIComponent(GR) + '&forge=github')
  return { ok: r.json.ok, count: (r.json.mrs || []).length }
})

await check('gitlab mr view', async () => {
  const r = await call('/forge/mr?num=' + encodeURIComponent(MR) + '&repo=' + R + '&host=' + H)
  return { ok: r.json.ok, num: r.json.mr && r.json.mr.num, title: r.json.mr && r.json.mr.title, forge: r.json.mr && r.json.mr.forge }
})

await check('gitlab mr diff', async () => {
  const r = await call('/forge/mr/diff?num=' + encodeURIComponent(MR) + '&repo=' + R + '&host=' + H)
  return { ok: r.json.ok, len: (r.json.diff || '').length, head: (r.json.diff || '').slice(0, 40) }
})

await check('github pr view', async () => {
  const r = await call('/forge/mr?num=1&repo=' + GR)
  return { ok: r.json.ok, num: r.json.mr && r.json.mr.num, forge: r.json.mr && r.json.mr.forge, state: r.json.mr && r.json.mr.state }
})

await check('github pr diff', async () => {
  const r = await call('/forge/mr/diff?num=1&repo=' + GR)
  return { ok: r.json.ok, len: (r.json.diff || '').length, head: (r.json.diff || '').slice(0, 40) }
})

await check('mrs without repo (workspace not a repo) errors cleanly', async () => {
  const r = await call('/forge/mrs?scope=all')
  return { ok: r.json.ok, error: r.json.error }
})

await check('mr view with missing num errors', async () => {
  const r = await call('/forge/mr?repo=' + R + '&host=' + H)
  return { ok: r.json.ok, error: r.json.error }
})

await check('gitlab approve non-existent MR errors cleanly', async () => {
  const r = await call('/forge/mr/approve', 'POST', { num: 99999999, repo: R, host: H })
  return { ok: r.json.ok, error: r.json.error }
})

await check('gitlab merge non-existent MR errors cleanly', async () => {
  const r = await call('/forge/mr/merge', 'POST', { num: 99999999, repo: R, host: H })
  return { ok: r.json.ok, error: r.json.error }
})

await check('github approve non-existent PR errors cleanly', async () => {
  const r = await call('/forge/mr/approve', 'POST', { num: 99999999, repo: GR })
  return { ok: r.json.ok, error: r.json.error }
})

await check('note empty body rejected', async () => {
  const r = await call('/forge/mr/note', 'POST', { num: MR, body: '', repo: R, host: H })
  return { ok: r.json.ok, error: r.json.error }
})

await check('workspaces: registry × git remote × CLI auth match (both forges)', async () => {
  const r = await call('/forge/workspaces')
  return {
    ok: r.json.ok,
    forges: r.json.forges && {
      glab: { available: r.json.forges.gitlab.available, hosts: r.json.forges.gitlab.hosts },
      gh: { available: r.json.forges.github.available, hosts: r.json.forges.github.hosts },
    },
    detected: (r.json.detected || []).map((d) => ({ host: d.host, forge: d.forge, authorized: d.authorized, repoPath: d.repoPath })),
    count: (r.json.workspaces || []).length,
    first: r.json.workspaces && r.json.workspaces[0] && {
      host: r.json.workspaces[0].host,
      forge: r.json.workspaces[0].forge,
      repoPath: r.json.workspaces[0].repoPath,
      user: r.json.workspaces[0].user,
    },
  }
})

await check('mrs with cwd targeting a registered workspace', async () => {
  const r = await call('/forge/mrs?scope=all&cwd=' + encodeURIComponent(glWs))
  return { ok: r.json.ok, count: (r.json.mrs || []).length }
})

await check('cwd outside the registry falls back to session workspace', async () => {
  const r = await call('/forge/mrs?scope=all&cwd=/etc')
  // /etc is refused as a workspace target; the route falls back to the
  // session workspace repo (now a git repo) instead of executing there.
  return { ok: r.json.ok, count: (r.json.mrs || []).length }
})

// ── DMS 工单（本机 aliyun CLI）──────────────────────────────────────────────

await check('dms status (CLI + credential probe)', async () => {
  const r = await call('/dms/status')
  return {
    ok: r.json.ok,
    cli: r.json.cli && {
      available: r.json.cli.available,
      configured: r.json.cli.configured,
      activeRegion: r.json.cli.activeRegion,
      profiles: (r.json.cli.profiles || []).length,
    },
  }
})

await check('dms orders AS_HANDLER (default region)', async () => {
  const r = await call('/dms/orders?resultType=AS_HANDLER&pageSize=5')
  return {
    ok: r.json.ok,
    total: r.json.totalCount,
    count: (r.json.orders || []).length,
    first: r.json.orders && r.json.orders[0] && {
      orderId: r.json.orders[0].orderId,
      statusCode: r.json.orders[0].statusCode,
    },
  }
})

await check('dms orders reject a bad region cleanly', async () => {
  const r = await call('/dms/orders?region=bad%20region;rm')
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms orders reject a bad tid cleanly', async () => {
  const r = await call('/dms/orders?tid=12ab')
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms order detail for a non-existent id errors cleanly', async () => {
  const r = await call('/dms/order?id=999999999')
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms order sql: unsupported type short-circuits without CLI', async () => {
  const r = await call('/dms/order/sql?id=1&type=GENERATE')
  return { ok: r.json.ok, supported: r.json.supported, type: r.json.type }
})

await check('dms order sql rejects a bad id cleanly', async () => {
  const r = await call('/dms/order/sql?id=abc&type=TABLE_SYNC')
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms order sql for a non-existent TABLE_SYNC order errors cleanly', async () => {
  const r = await call('/dms/order/sql?id=999999999&type=TABLE_SYNC')
  return { ok: r.json.ok, error: r.json.error }
})

// ── 真实工单的内容详情（order id 由 SMOKE_DMS_*_ORDER 显式指定）────────────
// 权限申请类工单走的也是这个路由（PERM_APPLY → GetPermApplyOrderDetail）；
// 用不存在的工单验证它确实执行了 CLI 并干净报错，而不是回 supported:false。
await check('dms order sql for a non-existent PERM_APPLY order errors cleanly', async () => {
  const r = await call('/dms/order/sql?id=999999999&type=PERM_APPLY')
  return { ok: r.json.ok, error: r.json.error }
})

// 真实工单内容只在显式给出 order id 时查询；夹具形状由 test/dms-order-sql.mjs
// 覆盖，未指定 id 时跳过，避免从空配置访问公司 DMS。
async function checkRealOrder(envName, id, type, detail) {
  if (!id) {
    console.log('SKIP  dms ' + type + ': set ' + envName + ' to query a real order')
    return
  }
  await check('dms order sql: real ' + type + ' order', async () => {
    const r = await call('/dms/order/sql?id=' + encodeURIComponent(id) + '&type=' + type)
    return detail(r.json)
  })
}

await checkRealOrder('SMOKE_DMS_PERM_ORDER', SMOKE.dmsOrders.perm, 'PERM_APPLY', (j) => ({
  ok: j.ok, supported: j.supported, type: j.type, sql: j.sql,
  applyType: j.apply && j.apply.applyTypeLabel,
  perm: j.apply && j.apply.permTypeLabel,
  resources: j.apply && j.apply.resourceCount,
}))

await checkRealOrder('SMOKE_DMS_DC_ORDER', SMOKE.dmsOrders.dc, 'DC_COMMON', (j) => ({
  ok: j.ok, supported: j.supported, type: j.type,
  hasSql: !!j.sql, facts: (j.facts || []).map((f) => f.k),
}))

// 结构设计 NDDL：正文在发布记录 ListDDLPublishRecords 的 Scripts 里。
await checkRealOrder('SMOKE_DMS_NDDL_ORDER', SMOKE.dmsOrders.nddl, 'NDDL', (j) => ({
  ok: j.ok, supported: j.supported, type: j.type,
  hasSql: !!j.sql, facts: (j.facts || []).map((f) => f.k),
}))

await checkRealOrder('SMOKE_DMS_EXPORT_ORDER', SMOKE.dmsOrders.export, 'DATA_EXPORT', (j) => ({
  ok: j.ok, supported: j.supported, type: j.type,
  hasSql: !!j.sql, facts: (j.facts || []).map((f) => f.k),
}))

// DB_EXPORT / DATA_TRACK / DATA_ARCHIVE 本租户没有真实工单：用不存在的工单
// 验证 API 名与 argv 能被 CLI 接受（报「orderId not exist」而不是 unknown
// action / 参数错误），归一化逻辑由 test/dms-order-sql.mjs 的夹具覆盖。
for (const type of ['DB_EXPORT', 'DATA_TRACK', 'DATA_ARCHIVE']) {
  await check('dms order sql: ' + type + ' api is accepted (non-existent order errors cleanly)', async () => {
    const r = await call('/dms/order/sql?id=999999999&type=' + type)
    return { ok: r.json.ok, error: r.json.error }
  })
}

await check('dms approve with an invalid action errors', async () => {
  const r = await call('/dms/order/approve', 'POST', { id: '1', action: 'MAYBE' })
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms approve with a non-numeric id errors', async () => {
  const r = await call('/dms/order/approve', 'POST', { id: 'abc', action: 'AGREE' })
  return { ok: r.json.ok, error: r.json.error }
})

await check('dms approve a non-existent order errors cleanly (workflow resolution fails)', async () => {
  const r = await call('/dms/order/approve', 'POST', { id: '999999999', action: 'AGREE' })
  return { ok: r.json.ok, error: r.json.error }
})

// ── SLS 日志查询（本机 aliyun CLI `sls get-logs-v2`）────────────────────────

await check('sls status (CLI + credential probe, same aliyun probe as dms)', async () => {
  const r = await call('/sls/status')
  return {
    ok: r.json.ok,
    cli: r.json.cli && {
      available: r.json.cli.available,
      configured: r.json.cli.configured,
      profiles: (r.json.cli.profiles || []).length,
    },
  }
})

// 真实日志查询只在显式指定目标时运行（SMOKE_SLS_PROJECT / SMOKE_SLS_LOGSTORE），
// 否则跳过：空配置不访问任何日志服务。时间区间校验不触网，始终运行。
if (SMOKE.slsProject && SMOKE.slsLogstore) {
  await check('sls query (real get-logs-v2, last hour)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const r = await call('/sls/query', 'POST', {
      project: SMOKE.slsProject, logstore: SMOKE.slsLogstore,
      from: String(now - 3600), to: String(now), line: '5',
    })
    return {
      ok: r.json.ok,
      count: r.json.count,
      returned: Array.isArray(r.json.logs) ? r.json.logs.length : null,
      progress: r.json.progress,
      first: r.json.logs && r.json.logs[0] && {
        time: r.json.logs[0].__time__,
        service: r.json.logs[0].service,
        name: r.json.logs[0].name,
      },
    }
  })
} else {
  console.log('SKIP  sls query: set SMOKE_SLS_PROJECT + SMOKE_SLS_LOGSTORE to query a real logstore')
}

await check('sls query rejects an invalid time range cleanly', async () => {
  const r = await call('/sls/query', 'POST', { from: '1789747200', to: '1789747200' })
  return { ok: r.json.ok, error: r.json.error }
})

// ── Issues 路由（真实 GitLab；只读检查，写操作 argv 由单测覆盖）──────────────
const ISS_REPO = SMOKE.issuesRepo
const ISS_QS = 'repo=' + encodeURIComponent(ISS_REPO) + '&host=' + encodeURIComponent(H)

await check('issues list (gitlab, scope=all + state=all)', async () => {
  const r = await call('/forge/issues?' + ISS_QS + '&scope=all&state=all&sort=updated_desc&page=1&pageSize=20')
  if (!r.json.ok) throw new Error(r.json.error || 'not ok')
  const first = (r.json.issues || [])[0] || {}
  return {
    ok: r.json.ok,
    forge: r.json.forge,
    count: (r.json.issues || []).length,
    total: r.json.total,
    hasMore: r.json.hasMore,
    firstNum: first.num,
    firstState: first.state,
    firstLabels: first.labels,
    authorFields: first.author && Object.keys(first.author),
    mrCount: first.mr_count,
  }
})

await check('issues list numeric search hits the exact iid (iids[])', async () => {
  const r = await call('/forge/issues?' + ISS_QS + '&scope=all&state=all&search=1')
  return {
    ok: r.json.ok,
    nums: (r.json.issues || []).map((it) => it.num),
    total: r.json.total,
  }
})

await check('issues list scope filters (mine / assigned)', async () => {
  const mine = await call('/forge/issues?' + ISS_QS + '&scope=mine&state=all')
  const assigned = await call('/forge/issues?' + ISS_QS + '&scope=assigned&state=all')
  spawnLog.length = 0
  return {
    mineNums: (mine.json.issues || []).map((it) => it.num),
    assignedTotal: assigned.json.total,
    mineTotal: mine.json.total,
  }
})

await check('issue detail (notes + related MRs attach)', async () => {
  const r = await call('/forge/issue?' + ISS_QS + '&num=1')
  const it = r.json.issue || {}
  return {
    ok: r.json.ok,
    num: it.num,
    title: (it.title || '').slice(0, 30),
    state: it.state,
    notes: (it.notes || []).length,
    related: (it.related || []).length,
    web_url: (it.web_url || '').includes('/-/issues/1'),
  }
})

await check('issue meta (stats + labels + members + viewer)', async () => {
  const r = await call('/forge/issue/meta?' + ISS_QS)
  return {
    ok: r.json.ok,
    forge: r.json.forge,
    stats: r.json.stats,
    labels: (r.json.labels || []).map((l) => l.name),
    members: (r.json.members || []).map((m) => m.username),
    viewer: r.json.viewer && r.json.viewer.username,
  }
})

for (const r of results) {
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + '  ' + JSON.stringify(r.detail))
}
const failed = results.filter((r) => !r.ok)
process.exit(failed.length ? 1 : 0)
