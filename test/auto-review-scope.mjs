// 自动评审范围 → host 列表口径（reviewListItems）：
// review / mine（review ∪ 我提交的，按编号去重）/ all，含 GitLab 批准覆盖层与
// 截断保护。全部用 mock runner 驱动真实代码路径，不依赖本机 CLI。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reviewListItems } from '../index.js'

const sha = (n) => String(n).repeat(40).slice(0, 40)
const GH_REPO = { cwd: '/repo', workspaceId: 'ws', forge: 'github', host: 'github.com', repoPath: 'team/repo' }
const GL_REPO = { cwd: '/repo', workspaceId: 'ws', forge: 'gitlab', host: 'gitlab.test', repoPath: 'team/repo' }
const ctx = { get(name) { if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws', path: '/repo' }] }; return undefined } }

function ghItem(num, { draft = false } = {}) {
  return { number: num, title: 'pr ' + num, state: 'OPEN', isDraft: draft, url: `https://github.com/team/repo/pull/${num}`, author: { login: 'alice' }, headRefOid: sha(num + 10), baseRefOid: sha(20), headRefName: 'f' + num, baseRefName: 'main', reviewRequests: [] }
}
function glItem(iid, { author = 'bob', reviewers = [] } = {}) {
  return { iid, title: 'mr ' + iid, state: 'opened', draft: false, web_url: `https://gitlab.test/team/repo/-/merge_requests/${iid}`, author: { username: author }, reviewers: reviewers.map((u) => ({ username: u })), diff_refs: { head_sha: sha(iid + 10), base_sha: sha(20) } }
}

function ghRunner({ all = [], review = [], mine = [] } = {}) {
  const calls = { lists: [], views: 0, apis: 0 }
  return {
    calls,
    async git(argv) {
      if (argv[0] === 'remote') return 'https://github.com/team/repo.git\n'
      return '\n'
    },
    async forgeRun(forge, argv) {
      if (argv[0] === 'pr' && argv[1] === 'list') {
        const s = argv.join(' ')
        calls.lists.push(s)
        if (s.includes('review-requested:@me')) return JSON.stringify(review)
        if (s.includes('--author @me')) return JSON.stringify(mine)
        return JSON.stringify(all)
      }
      if (argv[0] === 'pr' && argv[1] === 'view') { calls.views++; return JSON.stringify(ghItem(Number(argv[2]))) }
      if (argv[0] === 'api') { calls.apis++; return sha(30) }
      return ''
    },
  }
}

function glRunner({ all = [], review = [], mine = [], overlay } = {}) {
  const calls = { lists: [], graphql: 0, views: 0 }
  return {
    calls,
    async git(argv) {
      if (argv[0] === 'remote') return 'https://gitlab.test/team/repo.git\n'
      return '\n'
    },
    async forgeRun(forge, argv) {
      if (argv[0] === 'api' && argv[1] === 'graphql') { calls.graphql++; return JSON.stringify(overlay || { data: { currentUser: { username: 'alice' }, project: { mergeRequests: { nodes: [] } } } }) }
      if (argv[0] === 'mr' && argv[1] === 'list') {
        const s = argv.join(' ')
        calls.lists.push(s)
        if (s.includes('--author @me')) return JSON.stringify(mine)
        if (s.includes('--reviewer @me')) return JSON.stringify(review)
        return JSON.stringify(all)
      }
      if (argv[0] === 'mr' && argv[1] === 'view') { calls.views++; return JSON.stringify(glItem(Number(argv[2]))) }
      return ''
    },
  }
}

test('reviewListItems: review 只取 review-requested:@me，all 取全量，github 详情固定 merge-base', async () => {
  const r = ghRunner({ review: [ghItem(1)], all: [ghItem(1), ghItem(2)] })
  const review = await reviewListItems(ctx, r, GH_REPO, 'review')
  assert.deepEqual(review.map((i) => i.num), [1])
  assert.ok(r.calls.lists[0].includes('review-requested:@me'))
  assert.equal(r.calls.views, 1)
  const all = await reviewListItems(ctx, r, GH_REPO, 'all')
  assert.deepEqual(all.map((i) => i.num), [1, 2])
  assert.ok(!r.calls.lists[1].includes('--search') && !r.calls.lists[1].includes('--author'))
  assert.equal(r.calls.views, 3, 'review 1 条 + all 2 条各补一次详情')
  assert.equal(r.calls.apis, 3, 'github 详情固定取 merge-base')
})

test('reviewListItems: mine = review ∪ 我提交的，按编号去重且只补一次详情', async () => {
  const r = ghRunner({ review: [ghItem(1), ghItem(3)], mine: [ghItem(2), ghItem(3)] })
  const items = await reviewListItems(ctx, r, GH_REPO, 'mine')
  assert.deepEqual(items.map((i) => i.num), [1, 3, 2], 'review 优先，并集去重')
  assert.ok(r.calls.lists.some((s) => s.includes('review-requested:@me')))
  assert.ok(r.calls.lists.some((s) => s.includes('--author @me')))
  assert.equal(r.calls.views, 3, '重叠的 3 不重复补详情')
})

test('reviewListItems: gitlab mine 的 review 子集剔除已批准，我提交的保留', async () => {
  const overlay = { data: { currentUser: { username: 'alice' }, project: { mergeRequests: { nodes: [{ iid: '3', approvedBy: { nodes: [{ username: 'alice' }] } }] } } } }
  const r = glRunner({
    review: [glItem(1, { reviewers: ['alice'] }), glItem(3, { author: 'alice', reviewers: ['alice'] })],
    mine: [glItem(3, { author: 'alice' }), glItem(2, { author: 'alice' })],
    overlay,
  })
  const items = await reviewListItems(ctx, r, GL_REPO, 'mine')
  assert.deepEqual(items.map((i) => i.num), [1, 3, 2], '已批准的 3 因我提交而保留，并集去重')
  assert.equal(r.calls.graphql, 1)
  const byReview = await reviewListItems(ctx, r, GL_REPO, 'review')
  assert.deepEqual(byReview.map((i) => i.num), [1], 'review 子集剔除我已批准的 3')
})

test('reviewListItems: 列表打满上限停止扫描；mine 任一子列表打满也停止', async () => {
  const fifty = Array.from({ length: 50 }, (_, i) => ghItem(i + 1))
  await assert.rejects(reviewListItems(ctx, ghRunner({ all: fifty }), GH_REPO, 'all'), /待评审列表可能被截断/)
  await assert.rejects(reviewListItems(ctx, ghRunner({ review: fifty, mine: [] }), GH_REPO, 'mine'), /待评审列表可能被截断/)
  await assert.rejects(reviewListItems(ctx, ghRunner({ review: [], mine: fifty }), GH_REPO, 'mine'), /待评审列表可能被截断/)
})
