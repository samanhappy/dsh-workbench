// PingCode 富文本渲染的客户端半：描述/评论是 HTML 富文本（host sanitizeRichText
// 白名单清洗后才到客户端），looksLikeHtml 决定 innerHTML 渲染还是纯文本节点。
// 纯函数经 load-client.mjs 走构建产物的模块工厂加载（与 prompts/session 同路）。
// CSS 断言沿用 sls-form-css.mjs 的静态契约风格：sim 无布局引擎，布局约定用
// 规则存在性 + 关键声明守住（.wb-pc-desc 的 pre-wrap 只该作用于纯文本路径）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { loadClientModule } from './load-client.mjs'

const mod = loadClientModule()

test('looksLikeHtml: 含标签走 innerHTML 渲染路径', () => {
  assert.equal(mod.looksLikeHtml('<p>在首页登录</p><img src="https://x/y.png" />'), true)
  assert.equal(mod.looksLikeHtml('<strong>粗</strong>'), true)
  assert.equal(mod.looksLikeHtml('<!-- c -->x'), true)
})

test('looksLikeHtml: 纯文本走文本节点路径（pre-wrap 与旧行为一致）', () => {
  assert.equal(mod.looksLikeHtml('纯文本 a & b < c'), false)
  assert.equal(mod.looksLikeHtml('3 < 5 但没有标签'), false)
  assert.equal(mod.looksLikeHtml(''), false)
  assert.equal(mod.looksLikeHtml(null), false)
  assert.equal(mod.looksLikeHtml(undefined), false)
})

test('wb-pc-rich 布局契约：覆盖 pre-wrap、图片限宽不撑破卡片', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/styles/pingcode.css'), 'utf8')
  const rich = css.indexOf('.wb-pc-rich{')
  assert.ok(rich >= 0, '存在 .wb-pc-rich 规则')
  assert.match(css.slice(rich, css.indexOf('}', rich)), /white-space:normal/)
  const img = css.indexOf('.wb-pc-rich img{')
  assert.ok(img >= 0, '存在 .wb-pc-rich img 规则')
  assert.match(css.slice(img, css.indexOf('}', img)), /max-width:100%/)
  assert.match(css.slice(img, css.indexOf('}', img)), /height:auto/)
})

test('状态快筛五桶：挂起独立成桶（不混入待处理），顺序固定', () => {
  assert.deepEqual(mod.PC_STATE_FILTERS, [
    { v: 'all', label: '全部状态' },
    { v: 'pending', label: '待处理' },
    { v: 'suspended', label: '挂起' },
    { v: 'progress', label: '进行中' },
    { v: 'completed', label: '已完成' },
    { v: 'closed', label: '已关闭' },
  ])
})

test('每个状态桶都有快筛圆点色（含挂起）', () => {
  for (const s of mod.PC_STATE_FILTERS || []) {
    if (s.v === 'all') continue
    const dot = mod.PC_STATE_DOTS ? mod.PC_STATE_DOTS[s.v] : null
    assert.ok(dot, '缺圆点色：' + s.v)
  }
})

test('wb-pc-state-suspended 布局契约：挂起 chip 语义着色（violet）', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/styles/pingcode.css'), 'utf8')
  const susp = css.indexOf('.wb-pc-state-suspended{')
  assert.ok(susp >= 0, '存在 .wb-pc-state-suspended 规则')
  assert.match(css.slice(susp, css.indexOf('}', susp)), /--wb-violet/)
})
