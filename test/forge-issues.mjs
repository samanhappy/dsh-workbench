// Issues 域（src/host/issues.ts）纯函数测试：
//
//   - normalizeIssueFilters：路由 query → 白名单过滤条件（越界回默认）
//   - gitlabIssuesArgv / parseGitlabIssueList：glab api 路径构造 + `-i`
//     响应头解析（X-Total 精确总数 / X-Next-Page 翻页）
//   - githubIssuesArgv / parseGithubIssueList：gh issue list 本地切片分页 +
//     sort 搜索限定符
//   - toIssueView / normalizeRelatedMrs：两端 Issue 折成统一视图
//   - update/close/reopen/note/view argv：白名单构造
//
// 全部走构建产物的 re-export（index.js），不依赖本机 CLI。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeIssueFilters, gitlabIssuesArgv, githubIssuesArgv, parseGlabApiWithHeaders,
  parseGitlabIssueList, parseGithubIssueList, toIssueView, normalizeRelatedMrs,
  gitlabIssueUpdateArgv, githubIssueUpdateArgv,
  issueViewArgv, issueNoteArgv, gitlabIssueNotesArgv, gitlabRelatedMrsArgv,
} from '../index.js'

// ── normalizeIssueFilters ───────────────────────────────────────────────────

test('normalizeIssueFilters：缺省值与默认分页', () => {
  const f = normalizeIssueFilters({})
  assert.deepEqual(
    { scope: f.scope, state: f.state, sort: f.sort, page: f.page, pageSize: f.pageSize },
    { scope: 'all', state: 'all', sort: 'updated_desc', page: 1, pageSize: 20 })
  assert.equal(f.search, '')
  assert.equal(f.label, '')
  assert.equal(f.assignee, '')
})

test('normalizeIssueFilters：非法值回默认，越界分页收敛', () => {
  const f = normalizeIssueFilters({ scope: 'hack', state: 'x', sort: 'evil; rm', page: '999', pageSize: '1000' })
  assert.equal(f.scope, 'all')
  assert.equal(f.state, 'all')
  assert.equal(f.sort, 'updated_desc')
  assert.equal(f.page, 500) // 上限收敛
  assert.equal(f.pageSize, 50) // 上限收敛
})

test('normalizeIssueFilters：合法值透传，@me 前缀剥掉，长度截断', () => {
  const f = normalizeIssueFilters({ scope: 'mine', state: 'closed', sort: 'created_asc', page: '3', pageSize: '50', search: '  token 刷新  ', label: 'Bug', assignee: '@me' })
  assert.equal(f.scope, 'mine')
  assert.equal(f.state, 'closed')
  assert.equal(f.sort, 'created_asc')
  assert.equal(f.page, 3)
  assert.equal(f.pageSize, 50)
  assert.equal(f.search, 'token 刷新')
  assert.equal(f.label, 'Bug')
  assert.equal(f.assignee, 'me')
})

// ── GitLab：argv 构造 + `-i` 输出解析 ────────────────────────────────────────

test('gitlabIssuesArgv：api 子命令 + -i + scope/state/排序/分页进 query，仓库路径编码', () => {
  const argv = gitlabIssuesArgv('alice/dsh-workbench', normalizeIssueFilters({ scope: 'mine', state: 'opened', sort: 'created_desc', page: 2, pageSize: 20 }))
  assert.equal(argv[0], 'api')
  assert.equal(argv[1], '-i')
  assert.equal(argv[2], 'projects/alice%2Fdsh-workbench/issues?per_page=20&page=2&scope=created_by_me&state=opened&order_by=created_at&sort=desc')
})

test('gitlabIssuesArgv：文本搜索走 search+in，纯数字走 iids[] 编号直查', () => {
  const text = gitlabIssuesArgv('g/p', normalizeIssueFilters({ search: 'token 刷新' }))[2]
  assert.ok(text.includes('search=token%20%E5%88%B7%E6%96%B0'))
  assert.ok(text.includes('in=title,description'))
  const num = gitlabIssuesArgv('g/p', normalizeIssueFilters({ search: '128' }))[2]
  assert.ok(num.includes('iids%5B%5D=128'))
  assert.ok(!num.includes('search='))
})

test('gitlabIssuesArgv：标签与负责人过滤', () => {
  const argv = gitlabIssuesArgv('g/p', normalizeIssueFilters({ label: 'Bug', assignee: 'alice' }))[2]
  assert.ok(argv.includes('labels=Bug'))
  assert.ok(argv.includes('assignee_username=alice'))
})

test('parseGlabApiWithHeaders：解析 -i 的响应头 + 正文；纯 JSON 兼容', () => {
  const raw = 'HTTP/2.0 200 OK\r\nX-Total: 24\r\nX-Next-Page: 2\r\nX-Page: 1\r\n\r\n[{"iid":1}]'
  const parsed = parseGlabApiWithHeaders(raw)
  assert.equal(parsed.headers['x-total'], '24')
  assert.equal(parsed.headers['x-next-page'], '2')
  assert.deepEqual(JSON.parse(parsed.body), [{ iid: 1 }])
  const plain = parseGlabApiWithHeaders('[{"iid":2}]')
  assert.deepEqual(JSON.parse(plain.body), [{ iid: 2 }])
  assert.deepEqual(plain.headers, {})
})

test('parseGitlabIssueList：X-Total 精确总数 + X-Next-Page 翻页 + 归一化', () => {
  const raw = 'HTTP/2.0 200 OK\r\nX-Total: 128\r\nX-Next-Page: \r\n\r\n' + JSON.stringify([
    { iid: 1, title: 'A', description: 'd', state: 'opened', labels: ['Bug'], user_notes_count: 12, merge_requests_count: 2,
      author: { username: 'alice', name: 'Alice', avatar_url: 'http://x/a.png' }, assignees: [{ username: 'bob', name: 'Bob' }], web_url: 'https://h/g/p/-/issues/1' },
    { iid: 2, title: 'B', state: 'closed' },
  ])
  const page = parseGitlabIssueList(raw)
  assert.equal(page.total, 128)
  assert.equal(page.hasMore, false)
  assert.equal(page.issues.length, 2)
  const first = page.issues[0]
  assert.equal(first.forge, 'gitlab')
  assert.equal(first.num, 1)
  assert.equal(first.state, 'opened')
  assert.equal(first.author.username, 'alice')
  assert.equal(first.author.name, 'Alice')
  assert.equal(first.comment_count, 12)
  assert.equal(first.mr_count, 2)
  assert.equal(first.assignees[0].username, 'bob')
  assert.equal(page.issues[1].state, 'closed')
})

// ── GitHub：argv 构造 + 本地切片分页 ────────────────────────────────────────

test('githubIssuesArgv：state 映射 / scope 旗标 / 标签重复 / sort 限定符', () => {
  const { argv } = githubIssuesArgv(normalizeIssueFilters({ scope: 'mine', state: 'closed', label: 'Bug,High', search: 'token' }))
  assert.equal(argv[0], 'issue')
  assert.deepEqual(argv.slice(1, 5), ['list', '--json', 'number,title,body,state,stateReason,labels,assignees,author,url,createdAt,updatedAt,closedAt,closedByPullRequestsReferences,comments', '--state'])
  assert.equal(argv[5], 'closed')
  assert.ok(argv.includes('--author'))
  assert.ok(argv.includes('@me'))
  assert.equal(argv.filter((x) => x === '--label').length, 2)
  assert.ok(argv.includes('Bug') && argv.includes('High'))
  const si = argv.indexOf('--search')
  assert.equal(argv[si + 1], 'token sort:updated-desc')
})

test('githubIssuesArgv：无搜索词也带 sort 限定符；assigned scope 用 @me；页数×pageSize 封顶', () => {
  const bare = githubIssuesArgv(normalizeIssueFilters({}))
  assert.equal(bare.argv[bare.argv.indexOf('--search') + 1], 'sort:updated-desc')
  const assigned = githubIssuesArgv(normalizeIssueFilters({ scope: 'assigned' }))
  assert.ok(assigned.argv.includes('--assignee'))
  assert.ok(assigned.argv.includes('@me'))
  const deep = githubIssuesArgv(normalizeIssueFilters({ page: 99, pageSize: 50 }))
  assert.equal(deep.fetchLimit, 250)
})

test('parseGithubIssueList：page*pageSize 取回后本地切片 + hasMore 推断', () => {
  const f = normalizeIssueFilters({ page: 2, pageSize: 3 })
  const raw = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: 't' + i, state: 'OPEN' })))
  const page = parseGithubIssueList(raw, f)
  assert.deepEqual(page.issues.map((it) => it.num), [4, 5, 6])
  assert.equal(page.hasMore, true)
  assert.equal(page.total, null)
  const last = parseGithubIssueList(raw, normalizeIssueFilters({ page: 3, pageSize: 3 }))
  assert.deepEqual(last.issues.map((it) => it.num), [7])
  assert.equal(last.hasMore, false)
})

// ── 归一化 ──────────────────────────────────────────────────────────────────

test('toIssueView：GitHub 行（头像可构造、closedByPullRequestsReferences → related）', () => {
  const v = toIssueView({
    number: 128, title: 'T', body: 'B', state: 'CLOSED', stateReason: 'NOT_PLANNED',
    labels: [{ name: 'Bug' }], assignees: [{ login: 'bob' }], author: { login: 'alice' },
    url: 'https://github.com/o/r/issues/128', createdAt: '2024-03-28T10:24:00Z', updatedAt: '2024-03-29T10:24:00Z',
    comments: [{ body: 'c1' }, { body: 'c2' }],
    closedByPullRequestsReferences: [{ number: 142, title: 'fix', url: 'https://github.com/o/r/pull/142', state: 'MERGED' }],
  }, 'github')
  assert.equal(v.forge, 'github')
  assert.equal(v.num, 128)
  assert.equal(v.state, 'closed')
  assert.equal(v.state_reason, 'not_planned')
  assert.equal(v.author.avatar, 'https://github.com/alice.png?size=40')
  assert.equal(v.assignees[0].avatar, 'https://github.com/bob.png?size=40')
  assert.deepEqual(v.labels, ['Bug'])
  assert.equal(v.comment_count, 2)
  assert.equal(v.mr_count, 1)
  assert.equal(v.related[0].num, 142)
  assert.equal(v.related[0].state, 'merged')
})

test('toIssueView：缺字段容错；非法输入返回 null', () => {
  const v = toIssueView({ iid: 5, title: 'x' }, 'gitlab')
  assert.equal(v.num, 5)
  assert.equal(v.state, 'opened')
  assert.equal(v.author, null)
  assert.equal(v.comment_count, null)
  assert.equal(toIssueView(null, 'gitlab'), null)
  assert.equal(toIssueView({}, 'github'), null)
  assert.equal(toIssueView('x', 'gitlab'), null)
})

test('normalizeRelatedMrs：iid/number 双兼容，state 归一，缺编号剔除', () => {
  const out = normalizeRelatedMrs([
    { iid: 142, title: 'MR', state: 'opened', web_url: 'https://h/g/p/-/merge_requests/142', source_branch: 'f', target_branch: 'main' },
    { number: 7, title: 'PR', state: 'open', url: 'https://github.com/o/r/pull/7' },
    { title: '无编号' },
    null,
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].num, 142)
  assert.equal(out[0].state, 'opened')
  assert.equal(out[1].num, 7)
  assert.equal(out[1].state, 'opened')
})

// ── 写操作 argv ─────────────────────────────────────────────────────────────

test('update argv：标题/描述条件追加，标签增删，负责人 +/-/! 前缀（gitlab）与 add/remove（github）', () => {
  const gl = gitlabIssueUpdateArgv('9', { title: '新标题', addLabels: ['Bug'], removeLabels: ['High'], addAssignees: ['alice'], removeAssignees: ['bob'] })
  assert.deepEqual(gl, ['issue', 'update', '9', '-t', '新标题', '-l', 'Bug', '-u', 'High', '-a', '+alice', '-a', '!bob'])
  const glDescOnly = gitlabIssueUpdateArgv('9', { description: 'd', addLabels: [], removeLabels: [], addAssignees: [], removeAssignees: [] })
  assert.deepEqual(glDescOnly, ['issue', 'update', '9', '-d', 'd'])
  const gh = githubIssueUpdateArgv('9', { addLabels: ['Bug'], removeAssignees: ['bob'] })
  assert.deepEqual(gh, ['issue', 'edit', '9', '--add-label', 'Bug', '--remove-assignee', 'bob'])
})

test('view/notes/related argv：两端各自取数路径正确', () => {
  assert.deepEqual(issueViewArgv('gitlab', '3'), ['issue', 'view', '3', '-F', 'json'])
  assert.equal(issueViewArgv('github', '3').includes('--json'), true)
  assert.deepEqual(issueNoteArgv('gitlab', '3', 'hi'), ['issue', 'note', '3', '-m', 'hi'])
  assert.deepEqual(issueNoteArgv('github', '3', 'hi'), ['issue', 'comment', '3', '--body', 'hi'])
  assert.deepEqual(gitlabIssueNotesArgv('g/p', '3'), ['api', 'projects/g%2Fp/issues/3/notes?per_page=100&sort=asc'])
  assert.deepEqual(gitlabRelatedMrsArgv('g/p', '3'), ['api', 'projects/g%2Fp/issues/3/related_merge_requests?per_page=20'])
})
