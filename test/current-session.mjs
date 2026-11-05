// Regression test: the workbench panel's default repo selection broke after
// the dsh 0.1.6-alpha.2 upgrade ("打开工作台没有默认选中当前工作区对应的仓库").
//
// Root cause: dsh commit 6830e1460d (refactor(session-controller): own Client
// Session generations) removed `current` / `currentAddress` from
// SessionListState (packages/api/session-controller/src/client/sessions/
// service.ts). The shipped UI now derives the main-view session from the
// retention counts carried on each byId row — see mainSessionId() in
// packages/client/ui-workspace/src/client/tree.ts:
//
//   Object.values(list.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id
//
// The panel must support BOTH shapes: the legacy `current` field (older dsh)
// and the retainedBy.mainView scan (0.1.6-alpha.2+).
//
// The helper lives in the client bundle body (src/client/session.ts). This
// test loads the BUILT lib/client.js through the shared loader
// (test/load-client.mjs) and asserts on the exported pure helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'


test('currentSessionIdOf: new dsh shape (retainedBy.mainView, no `current`) — the 0.1.6-alpha.2 regression', () => {
  const exports = loadClientModule()
  assert.equal(typeof exports.currentSessionIdOf, 'function', 'src/client.js must export currentSessionIdOf')
  const list = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', retainedBy: { mainView: 1 } },
      s2: { id: 's2', retainedBy: {} },
    },
    phase: 'ready',
  }
  assert.equal(exports.currentSessionIdOf(list), 's1')
})

test('currentSessionIdOf: legacy dsh shape (`current` field) keeps working', () => {
  const exports = loadClientModule()
  const list = {
    ids: ['s9'],
    byId: { s9: { id: 's9' } },
    current: 's9',
    phase: 'ready',
  }
  assert.equal(exports.currentSessionIdOf(list), 's9')
})

test('currentSessionIdOf: new shape with no main-view-retained session yields null', () => {
  const exports = loadClientModule()
  const list = {
    ids: ['s1'],
    byId: { s1: { id: 's1', retainedBy: {} } },
    phase: 'ready',
  }
  assert.equal(exports.currentSessionIdOf(list), null)
})

test('currentSessionIdOf: absent rows and absent list yield null', () => {
  const exports = loadClientModule()
  assert.equal(exports.currentSessionIdOf({ ids: [], byId: {}, phase: 'pending' }), null)
  assert.equal(exports.currentSessionIdOf(null), null)
  assert.equal(exports.currentSessionIdOf(undefined), null)
})
