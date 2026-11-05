// 「评审」首次点击的回归测试（新建评审会话的 Session 解析）。
//
// Bug：第一次点「评审」时弹窗提示“评审会话已打开，但无法自动发送评审指令，
// 请手动粘贴评审要求”，再点一次才成功。
//
// 根因：connectWorkspace 对从未打开过的 workspace 会新建一个会话，而新建的
// 会话尚未被任何一方 retain（scope 未物化）。startReview 里用一次性的
// sessions.binding(sessionId) 取会话 —— ClientSessions.binding() 只返回
// scopes 里已物化（被 retain 过）的世代，新会话首次访问时返回 undefined，
// session 取不到，于是走回退分支弹窗；第二次点击时该会话已被 mainView
// retain 过，binding() 才拿得到。正确做法是按会话控制器的契约用
// sessions.retain() 物化 scope 并 await reference.ready（会话 open、可寻址
// 后才 resolve binding），用完 release()。
//
// 本文件加载构建产物 lib/client.js（test/load-client.mjs），用与真实
// ClientSessions 契约一致的桩（binding 只认已物化 scope、retain 物化并异步
// resolve ready）断言导出的纯 helper retainBoundSession。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

/** 模拟 ClientSessions 的会话控制器契约：
 *  - binding(id)：只在 scope 已物化（被 retain 过）时返回绑定，否则 undefined
 *    （这正是首次点击失败的原因 —— 新建会话的 scope 尚未物化）；
 *  - retain(id, { source })：物化 scope（此后 binding 有值），并异步 resolve
 *    reference.ready 为 binding（对应 open() 完成后 resolve）；
 *  - create(id)：在控制器 manager 里登记一个会话（等价 connectWorkspace
 *    新建会话后「已可寻址」），但 scope 未物化。
 */
function makeFakeSessionsService() {
  const manager = new Map()
  const summaries = []
  const scopes = new Map()

  function newSession(id) {
    const session = {
      sessionId: id,
      prompt: async (messages, mode, signal, requestId) => ({ ok: true, requestId }),
      beginSubmission: (opts) => ({ requestId: 'req-' + id }),
      rename: async (title) => ({ ok: true }),
    }
    manager.set(id, session)
    return session
  }

  return {
    binding(id) {
      const rec = scopes.get(id)
      return rec ? rec.binding : undefined
    },
    retain(id, options) {
      // 与 resolveTarget 一致：未知会话直接抛错。
      if (!manager.has(id) && !summaries.some((s) => s.sessionId === id)) {
        throw new Error('sessions.retain: unknown session ' + id)
      }
      let rec = scopes.get(id)
      if (!rec) {
        const session = manager.get(id) || newSession(id)
        const binding = { sessionId: id, session, eventSource: null, ctx: null }
        const ready = Promise.resolve(binding)
        rec = { binding, live: true, ready }
        scopes.set(id, rec)
      }
      return {
        sessionId: id,
        ready: rec.ready,
        release() {
          rec.live = false
          scopes.delete(id)
        },
      }
    },
    // 等价 connectWorkspace 新建会话后：会话在 manager 中（可寻址），scope 未物化。
    create(id) {
      newSession(id)
    },
  }
}

test('retainBoundSession: 新建会话首次点击也能解析到 Session（首次点击回归）', async () => {
  const exports = loadClientModule()
  assert.equal(typeof exports.retainBoundSession, 'function', 'src/client.js 必须导出 retainBoundSession')

  const svc = makeFakeSessionsService()
  svc.create('session-fresh') // 新建会话已可寻址，但 scope 未物化
  assert.equal(
    svc.binding('session-fresh'),
    undefined,
    '先决条件：未物化的新会话 binding() 返回 undefined —— 正是首次点击失败的根因',
  )

  const held = await exports.retainBoundSession(svc, 'session-fresh')
  assert.ok(held, '应返回持有引用（即使 binding() 当时没有值）')
  assert.equal(held.session.sessionId, 'session-fresh')
  assert.equal(typeof held.session.prompt, 'function', '评审提示词应能发送')
  assert.equal(typeof held.release, 'function', '调用方用完应能 release()')
  // retain 之后 scope 已物化，binding() 应当开始返回该会话。
  assert.equal(svc.binding('session-fresh').session.sessionId, 'session-fresh')
  held.release()
})

test('retainBoundSession: 已物化的会话（第二次点击 / 提交按钮场景）仍可解析', async () => {
  const exports = loadClientModule()
  const svc = makeFakeSessionsService()
  svc.create('session-existing')
  svc.retain('session-existing', { source: 'mainView' }) // 已被 mainView 物化
  assert.ok(svc.binding('session-existing'), '先决条件：已物化会话 binding() 有值')

  const held = await exports.retainBoundSession(svc, 'session-existing')
  assert.equal(held.session.sessionId, 'session-existing')
  assert.equal(held.session.beginSubmission({ text: 'x' }).requestId, 'req-session-existing')
  held.release()
})

test('retainBoundSession: sessions 服务不可用返回 null（保留旧回退提示）', async () => {
  const exports = loadClientModule()
  assert.equal(await exports.retainBoundSession(null, 's1'), null)
  assert.equal(await exports.retainBoundSession({}, 's1'), null)
})

test('retainBoundSession: retain 失败（未知会话）时向调用方抛错', async () => {
  const exports = loadClientModule()
  const svc = makeFakeSessionsService()
  await assert.rejects(
    () => exports.retainBoundSession(svc, 'no-such-session'),
    /unknown session/,
  )
})

// ── Issue「处理」的工作区解析（与评审同构）────────────────────────────────────

const WS_DATA = {
  workspaces: [
    { id: 'a', path: '/ws/a', title: 'a', repoPath: 'grp/repo-a', host: 'gitlab.test', forge: 'gitlab' },
    { id: 'b', path: '/ws/b', title: 'b', repoPath: 'grp/repo-b', host: 'gitlab.test', forge: 'gitlab' },
  ],
}
const WS_ITEMS = [
  { workspaceId: 'ws-a', path: '/ws/a', title: 'a' },
  { workspaceId: 'ws-b', path: '/ws/b', title: 'b' },
]

test('repoPathFromIssueUrl: GitLab（含 /-/）与 GitHub issue URL 都能取出仓库路径', () => {
  const { repoPathFromIssueUrl } = loadClientModule()
  assert.equal(repoPathFromIssueUrl('https://gitlab.test/grp/repo-a/-/issues/128'), 'grp/repo-a')
  assert.equal(repoPathFromIssueUrl('https://gitlab.test/grp/repo-a/issues/128'), 'grp/repo-a')
  assert.equal(repoPathFromIssueUrl('https://github.com/o/r/issues/7'), 'o/r')
  assert.equal(repoPathFromIssueUrl('https://gitlab.test/grp/repo-a/-/merge_requests/12'), null)
  assert.equal(repoPathFromIssueUrl(''), null)
  assert.equal(repoPathFromIssueUrl(null), null)
})

test('findIssueWs: 面板选中工作区优先，否则按 Issue 仓库路径匹配注册表', () => {
  const { findIssueWs } = loadClientModule()
  const item = { web_url: 'https://gitlab.test/grp/repo-b/-/issues/7' }
  // 选中 cwd 优先（与评审一致：列表就是通过该工作区查的）
  const byActive = findIssueWs(item, '/ws/a', WS_DATA, WS_ITEMS)
  assert.equal(byActive.view.workspaceId, 'ws-a')
  // 无选中 cwd 时回落到 web_url 里的仓库路径
  const byRepo = findIssueWs(item, null, WS_DATA, WS_ITEMS)
  assert.equal(byRepo.view.workspaceId, 'ws-b')
  assert.equal(byRepo.meta.repoPath, 'grp/repo-b')
  // 没有对应工作区 → null（按钮据此不渲染）
  assert.equal(findIssueWs({ web_url: 'https://gitlab.test/other/repo/-/issues/1' }, null, WS_DATA, WS_ITEMS), null)
})

test('startItemSession: 未绑定 uiWorkspace 时返回结构化失败（不抛错）', async () => {
  const { startItemSession } = loadClientModule()
  const res = await startItemSession({ view: { workspaceId: 'ws-a', path: '/ws/a' } }, 'prompt', 'title')
  assert.equal(res.ok, false)
  assert.equal(res.code, 'no-uiworkspace')
})
