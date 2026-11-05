// Regression tests for the 待评审 (scope=review) approval filter.
//
// Bug: GitLab keeps you assigned as a reviewer after you approve an MR, so
// `glab mr list --reviewer @me` keeps returning MRs that no longer await my
// review (observed on GitLab, which also
// silently ignores the `not[approved_by_ids]` REST list filter). The host
// therefore overlays one GraphQL call (currentUser + approvedBy per iid) onto
// the reviewer list and drops the MRs the viewer has already approved.
//
// The fixtures mirror the observed response shapes.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseApprovalOverlay,
  dropApprovedByViewer,
  gitlabReviewApprovalsArgv,
  bucketItemLists,
  toItemView,
} from '../index.js'

// toItemView: num = m.iid (REST JSON → number). GraphQL: iid is a string.
const items = [
  { forge: 'gitlab', num: 1001, title: '已批准' },
  { forge: 'gitlab', num: 1002, title: '别人批准' },
  { forge: 'gitlab', num: 1003, title: '无人批准' },
]

const OVERLAY_WRAPPED = {
  data: {
    currentUser: { username: 'alice' },
    project: {
      mergeRequests: {
        nodes: [
          { iid: '1001', approvedBy: { nodes: [{ username: 'alice' }] } },
          { iid: '1002', approvedBy: { nodes: [{ username: 'bob' }] } },
          { iid: '1003', approvedBy: { nodes: [] } },
        ],
      },
    },
  },
}

test('parseApprovalOverlay: 提取 viewer 与 iid → 批准者集合（data 包装形态）', () => {
  const overlay = parseApprovalOverlay(OVERLAY_WRAPPED)
  assert.equal(overlay.viewer, 'alice')
  assert.ok(overlay.approved.get('1001').has('alice'))
  assert.ok(overlay.approved.get('1002').has('bob'))
  assert.equal(overlay.approved.get('1003').size, 0)
})

test('parseApprovalOverlay: 无 data 包装的裸 GraphQL payload 同样可解析', () => {
  const overlay = parseApprovalOverlay(OVERLAY_WRAPPED.data)
  assert.equal(overlay.viewer, 'alice')
  assert.ok(overlay.approved.has('1001'))
})

test('parseApprovalOverlay: 异常/缺失字段不抛错，退化为空覆盖层', () => {
  assert.equal(parseApprovalOverlay(null), null)
  assert.equal(parseApprovalOverlay('nope'), null)
  const broken = parseApprovalOverlay({ data: { currentUser: null, project: null } })
  assert.deepEqual(broken, { viewer: '', approved: new Map() })
  const withNulls = parseApprovalOverlay({
    data: {
      currentUser: { username: 'alice' },
      project: { mergeRequests: { nodes: [null, { iid: '9', approvedBy: null }, { iid: '10', approvedBy: { nodes: [null, {}] } }] } },
    },
  })
  assert.equal(withNulls.viewer, 'alice')
  assert.equal(withNulls.approved.size, 2) // iids registered, empty approver sets
})

test('回归：我已批准的 MR 从待评审列表剔除（!1001 场景）', () => {
  const overlay = parseApprovalOverlay(OVERLAY_WRAPPED)
  const kept = dropApprovedByViewer(items, overlay)
  assert.deepEqual(kept.map((it) => it.num), [1002, 1003])
})

test('别人批准的 MR 仍保留（仍等待我评审）', () => {
  const overlay = parseApprovalOverlay(OVERLAY_WRAPPED)
  const kept = dropApprovedByViewer(items, overlay)
  assert.ok(kept.find((it) => it.num === 1002))
})

test('fail-soft：覆盖层为 null / viewer 未知 / iid 不在覆盖层 → 原样保留', () => {
  assert.equal(dropApprovedByViewer(items, null), items)
  const unknownViewer = dropApprovedByViewer(items, { viewer: '', approved: new Map([['1001', new Set(['alice'])]]) })
  assert.deepEqual(unknownViewer.map((it) => it.num), [1001, 1002, 1003])
  const partial = dropApprovedByViewer(items, { viewer: 'alice', approved: new Map([['9999', new Set(['alice'])]]) })
  assert.deepEqual(partial.map((it) => it.num), [1001, 1002, 1003])
})

test('gitlabReviewApprovalsArgv: 只收数字 iid、按 100 截断、fullPath 安全嵌入', () => {
  const argv = gitlabReviewApprovalsArgv('group/project', items)
  assert.equal(argv[0], 'api')
  assert.equal(argv[1], 'graphql')
  assert.equal(argv[2], '-f')
  const query = argv[3]
  assert.ok(query.startsWith('query='))
  assert.ok(query.includes('"group/project"'))
  assert.ok(query.includes('iids:["1001","1002","1003"]'))
  assert.ok(query.includes('currentUser{username}'))
  assert.ok(query.includes('approvedBy{nodes{username}}'))
})

test('gitlabReviewApprovalsArgv: 没有有效 iid 时返回 null（调用方跳过覆盖层）', () => {
  assert.equal(gitlabReviewApprovalsArgv('group/project', [{ num: 'x' }, { num: null }]), null)
  assert.equal(gitlabReviewApprovalsArgv('group/project', []), null)
})

// ── 三页签一次拉全：单条 mr list 本地分桶 ───────────────────────────────────
// /forge/state 用一条 `glab mr list`（全部开启中）取回列表后，宿主按
// author / reviewer 本地分桶出「我的」「待评审」，不再发三条查询。

test('toItemView(gitlab): reviewers 映射为 reviewRequests 用户名数组', () => {
  const raw = {
    iid: 1001,
    title: 't',
    state: 'opened',
    author: { id: 133, username: 'bob' },
    reviewers: [
      { id: 26, username: 'alice' },
      { username: null },
      { id: 9, username: 'zhangsan' },
    ],
  }
  const view = toItemView(raw, 'gitlab')
  assert.deepEqual(view.reviewRequests, ['alice', 'zhangsan'])
  assert.equal(view.author, 'bob')
})

test('toItemView(gitlab): reviewers 缺失时 reviewRequests 为空数组', () => {
  assert.deepEqual(toItemView({ iid: 1, state: 'opened' }, 'gitlab').reviewRequests, [])
})

test('bucketItemLists: 按 author / reviewer 分桶（用户名大小写不敏感）', () => {
  const items = [
    { num: 1, author: 'alice', reviewRequests: [] },                    // 我的
    { num: 2, author: 'bob', reviewRequests: ['Alice'] },           // 待评审
    { num: 3, author: 'bob', reviewRequests: ['zhangsan'] },          // 无关
    { num: 4, author: 'alice', reviewRequests: ['alice'] },           // 既是我发起也指派我
  ]
  const { mine, review } = bucketItemLists(items, 'alice')
  assert.deepEqual(mine.map((it) => it.num), [1, 4])
  assert.deepEqual(review.map((it) => it.num), [2, 4])
})

test('bucketItemLists: viewer 未知 / 非数组输入 → 两桶为空（fail-soft）', () => {
  const items = [{ num: 1, author: 'alice', reviewRequests: ['alice'] }]
  assert.deepEqual(bucketItemLists(items, ''), { mine: [], review: [] })
  assert.deepEqual(bucketItemLists(items, null), { mine: [], review: [] })
  assert.deepEqual(bucketItemLists(null, 'alice'), { mine: [], review: [] })
})
