// /forge/mr 详情评论归一化测试（normalizeNotes）：
//
// 详情页「评论」页签的数据源：
//   - GitHub：`gh pr view --json comments` 自带的 issue 评论数组
//     （{author:{login},body,createdAt}），不含 review thread；
//   - GitLab：glab api projects/:path/merge_requests/:iid/notes
//     （{author:{username},body,created_at,system}），system=true 是
//     「批准/关闭/指派」之类的系统记录，必须剔除。
// 统一成 {author,body,created_at}，按时间升序，空评论剔除，上限 100 条。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeNotes } from '../index.js'

test('github：提取 login/body/createdAt，空 body 剔除', () => {
  const raw = {
    comments: [
      { author: { login: 'alice' }, body: 'first', createdAt: '2024-09-18T10:00:00Z' },
      { author: { name: 'Bob' }, body: '  ', createdAt: '2024-09-18T11:00:00Z' },
      { author: null, body: 'third', createdAt: '2024-09-18T12:00:00Z' },
    ],
  }
  const notes = normalizeNotes(raw.comments, 'github')
  assert.deepEqual(notes, [
    { author: 'alice', body: 'first', created_at: '2024-09-18T10:00:00Z' },
    { author: '', body: 'third', created_at: '2024-09-18T12:00:00Z' },
  ])
})

test('gitlab：系统记录剔除，用户名取 username，按创建时间升序', () => {
  const raw = [
    { author: { username: 'bob' }, body: 'later', created_at: '2024-09-18T12:00:00.000Z', system: false },
    { author: { username: 'alice' }, body: 'earlier', created_at: '2024-09-18T10:00:00.000Z', system: false },
    { author: { username: 'alice' }, body: 'closed this merge request', created_at: '2024-09-18T11:00:00.000Z', system: true },
  ]
  const notes = normalizeNotes(raw, 'gitlab')
  assert.deepEqual(notes.map((n) => n.author + ':' + n.body), ['alice:earlier', 'bob:later'])
})

test('非数组 / null / 乱项不抛异常，输出空数组或只含有效项', () => {
  assert.deepEqual(normalizeNotes(null, 'github'), [])
  assert.deepEqual(normalizeNotes('x', 'gitlab'), [])
  assert.deepEqual(normalizeNotes([null, 1, 'x', {}], 'github'), [])
})

test('超过 100 条截断保护', () => {
  const raw = Array.from({ length: 150 }, (_, i) => ({
    author: { login: 'a' },
    body: 'm' + i,
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
  }))
  assert.equal(normalizeNotes(raw, 'github').length, 100)
})
