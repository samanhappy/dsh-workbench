// DMS 工单详情 SQL 块的 CSS 约定测试。
//
// sim-panel.mjs 是 vdom 级模拟（无布局引擎），看不到字号；而 DMS 详情的
// SQL 脚本是审批时逐字读的内容，复用 sls.css 的 .wb-sls-sql（11px，为日志
// 流水调的字号）会太小。约定：detail.css 用 .wb-dms-sqls 作用域覆盖到正文字号
// （13px/20px），且必须比共享规则大——共享样式改字号或覆盖被删时在此报警。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const detailCss = readFileSync(join(here, '../src/client/styles/detail.css'), 'utf8')
const slsCss = readFileSync(join(here, '../src/client/styles/sls.css'), 'utf8')

/** 取出某选择器那条规则的花括号体；找不到返回 null。 */
function rule(css, sel) {
  const i = css.indexOf(sel + '{')
  if (i < 0) return null
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

function px(value) {
  const m = /font-size:(\d+(?:\.\d+)?)px/.exec(value || '')
  return m ? Number(m[1]) : null
}

test('DMS 详情 SQL 块字号覆盖为正文 13px（审批要逐字读，不是日志流水）', () => {
  const r = rule(detailCss, '.wb-dms-sqls .wb-sls-sql')
  assert.ok(r, 'detail.css 存在 .wb-dms-sqls .wb-sls-sql 覆盖规则')
  assert.equal(px(r), 13)
  assert.match(r, /line-height:20px/)
})

test('DMS 覆盖必须大于共享 .wb-sls-sql（共享改大/覆盖删除都会破坏这条关系）', () => {
  const shared = px(rule(slsCss, '.wb-sls-sql'))
  const dms = px(rule(detailCss, '.wb-dms-sqls .wb-sls-sql'))
  assert.equal(shared, 11, 'sls.css 日志场景的 SQL 字号保持 11px')
  assert.ok(dms !== null && dms > shared, 'DMS 详情字号大于共享字号')
})

test('资源定位串用等宽字体 + 正文 13px + 代码蓝，与申请类型等普通文案区分', () => {
  const label = rule(detailCss, '.wb-dms-kv-label')
  assert.ok(label, '存在 .wb-dms-kv-label 规则')
  assert.match(label, /font-family:var\(--ds-font-family-code/)
  assert.equal(px(label), 13)
  assert.match(label, /line-height:20px/)
  assert.match(label, /color:var\(--wb-info\)/, '颜色与 SQL 关键字同源（--wb-info）')
  const meta = rule(detailCss, '.wb-dms-kv-meta')
  assert.equal(px(meta), 12, '资源 meta（引擎 · 环境）12px，标签性质但保持可读')
})
