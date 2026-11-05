// /forge/state 三页签列表的「一次拉全 + 截断回退」调度测试。
//
// 策略：先用一条全量列表（ALL_LIST_LIMIT=50 上限）本地按 author/reviewer 分桶；
// 返回不足 50 条说明列表完整，分桶即精确值；恰好打满 50 条则可能被截断，
// 自动退回 `--author @me` / `--reviewer @me` 逐口径精确查询（旧行为）。
// 全部用 mock runner 驱动 loadStateLists 的真实代码路径，不依赖本机 CLI。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadStateLists } from '../index.js'

function mr(iid, author, reviewers) {
  return {
    iid,
    title: 'mr ' + iid,
    state: 'opened',
    author: { username: author },
    reviewers: (reviewers || []).map((u) => ({ username: u })),
  }
}

function makeRunner({ allPayload, minePayload, reviewPayload, overlayPayload }) {
  const calls = { lists: [], graphql: 0 }
  return {
    calls,
    async tryRun(exe, argv) {
      if (exe === 'glab' && argv[0] === 'auth' && argv[1] === 'status') {
        return { out: 'Logged in to gitlab.test as alice\n', errText: '', code: 0 }
      }
      return { out: '', errText: '', code: 1 }
    },
    async git(argv) {
      if (argv[0] === 'remote') return 'https://gitlab.test/agent/repo.git\n'
      if (argv[0] === 'rev-parse') return '/tmp/fake-repo\n'
      return '\n'
    },
    async forgeRun(forge, argv) {
      const s = argv.join(' ')
      if (argv[0] === 'api' && argv[1] === 'graphql') {
        calls.graphql += 1
        return JSON.stringify(overlayPayload)
      }
      calls.lists.push(s)
      if (s.includes('--author @me')) return JSON.stringify(minePayload)
      if (s.includes('--reviewer @me')) return JSON.stringify(reviewPayload)
      return JSON.stringify(allPayload)
    },
  }
}

const ctx = { get() { return undefined } }
const OPTS = { forge: 'gitlab', wsRoot: null, repoPath: 'agent/repo', root: '/tmp/fake-repo', viewer: 'alice' }

test('小仓库（< 50 条）：只发一条列表，本地分桶 + 覆盖层剔除已批准', async () => {
  const runner = makeRunner({
    allPayload: [mr(1, 'alice'), mr(2, 'bob', ['alice']), mr(3, 'zhangsan'), mr(4, 'bob', ['alice', 'zhangsan'])],
    minePayload: [],
    reviewPayload: [],
    overlayPayload: {
      data: {
        currentUser: { username: 'alice' },
        project: { mergeRequests: { nodes: [{ iid: '2', approvedBy: { nodes: [{ username: 'alice' }] } }, { iid: '4', approvedBy: { nodes: [] } }] } },
      },
    },
  })
  const out = await loadStateLists(ctx, runner, OPTS)
  assert.equal(runner.calls.lists.length, 1)
  assert.ok(!runner.calls.lists[0].includes('--author'))
  assert.ok(!runner.calls.lists[0].includes('--reviewer'))
  assert.deepEqual(out.allOpen.map((m) => m.num), [1, 2, 3, 4])
  assert.deepEqual(out.myOpen.map((m) => m.num), [1])
  // iid 2 已被我批准 → 剔除；iid 4 仍等我审 → 保留
  assert.deepEqual(out.reviewRequests.map((m) => m.num), [4])
  assert.equal(runner.calls.graphql, 1)
  assert.equal(out.allOpenError, undefined)
})

test('打满 50 条（可能截断）：退回 mine/review 逐口径精确查询', async () => {
  // 全量列表 50 条全是我无关的 MR——我发起的和我待评审的都在第 51 条之后，
  // 只有精确查询才能拿到（分桶会漏）。
  const allPayload = []
  for (let i = 1; i <= 50; i++) allPayload.push(mr(i, 'zhangsan'))
  const runner = makeRunner({
    allPayload,
    minePayload: [mr(9001, 'alice')],
    reviewPayload: [mr(9002, 'bob', ['alice'])],
    overlayPayload: {
      data: {
        currentUser: { username: 'alice' },
        project: { mergeRequests: { nodes: [{ iid: '9002', approvedBy: { nodes: [] } }] } },
      },
    },
  })
  const out = await loadStateLists(ctx, runner, OPTS)
  assert.equal(out.allOpen.length, 50)
  // 一条全量 + 一条 mine + 一条 review，共 3 条
  assert.equal(runner.calls.lists.length, 3)
  assert.ok(runner.calls.lists.some((s) => s.includes('--author @me')))
  assert.ok(runner.calls.lists.some((s) => s.includes('--reviewer @me')))
  // 精确查询结果（分桶在这份截断列表上会得到空桶）
  assert.deepEqual(out.myOpen.map((m) => m.num), [9001])
  assert.deepEqual(out.reviewRequests.map((m) => m.num), [9002])
  assert.equal(runner.calls.graphql, 1) // review 口径的批准覆盖层
})
