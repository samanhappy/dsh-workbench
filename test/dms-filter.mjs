import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

const prefs = { committers: '' }
const mod = loadClientModule({ getItem: () => JSON.stringify(prefs) })
const rows = [{ committer: '秦松' }, { committer: '张三' }, { committer: '秦松涛' }]
test('multiple submitters match exact names; empty configuration preserves all', () => {
  assert.equal(mod.filterDmsOrders(rows, ''), rows)
  assert.equal(mod.filterDmsOrders(rows, ' ， ; '), rows)
  assert.deepEqual(mod.filterDmsOrders(rows, ' 秦松，张三;秦松 '), rows.slice(0, 2))
  assert.deepEqual(mod.filterDmsOrders(rows, '无人'), [])
})
test('configured filtering reads subsequent pages without filtering the all list', async () => {
  prefs.committers = '张三'
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, json: async () => ({ ok: true, totalCount: 3, orders: urls.length === 1 ? rows.slice(0, 1) : rows.slice(1) }) }
  }
  const data = await mod.refreshDmsOrders(false)
  assert.equal(urls.length, 2)
  assert.ok(urls[1].includes('page=2'))
  assert.deepEqual(data.orders, rows)
  assert.deepEqual(mod.filterDmsOrders(data.orders, prefs.committers), [rows[1]])
})
