// SLS 查询表单的 CSS 布局约定测试。
//
// sim-panel.mjs 是 vdom 级模拟（无布局引擎），看不到盒模型；而表单「组件
// 大小不一 / 输入框与倒序开关重叠」正是盒模型问题：.glab-input 全局没有
// box-sizing（默认 content-box），.wb-sls-finput 的 width:100% + padding
// + 边框让每个输入框比所属字段盒宽出 ~18px——平时吃掉 8px 间隙看不出来，
// 但固定宽度字段（返回行数）的输入框会压到右边「倒序」开关上。
// 这里用静态断言守住修复所依赖的布局约定：
//   1. .wb-sls-finput 必须 border-box，输入框精确贴合字段宽度（不重叠）
//   2. .wb-sls-field-line 固定宽度不可收缩（flex:0 0 …），数字框不再被压
//   3. .wb-sls-field-rev 只占内容宽（flex:none），开关贴行尾不越界
//   4. .wb-sls-frow 可换行，窄窗口字段折行而不是互相推挤
//   5. 未配置环境时手填的 Project/Logstore 框复用同一套字段盒与输入基类
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/client/styles/sls.css'), 'utf8')
const source = readFileSync(new URL('../src/client/components/sls.tsx', import.meta.url), 'utf8')

/** 取出某选择器那条规则的花括号体；找不到返回 null。 */
function rule(sel) {
  const i = css.indexOf(sel + '{')
  if (i < 0) return null
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

test('wb-sls-finput 是 border-box：输入框精确贴合字段宽度，不再横向溢出压到相邻组件', () => {
  const r = rule('.wb-sls-finput')
  assert.ok(r, '存在 .wb-sls-finput 规则')
  assert.match(r, /box-sizing:border-box/)
})

test('wb-sls-field-line 固定宽度不可收缩，数字输入框不被挤压', () => {
  const r = rule('.wb-sls-field-line')
  assert.ok(r, '存在 .wb-sls-field-line 规则')
  assert.match(r, /flex:0 0 \d+px/)
})

test('wb-sls-field-rev 只占内容宽，倒序开关贴行尾不越界', () => {
  const r = rule('.wb-sls-field-rev')
  assert.ok(r, '存在 .wb-sls-field-rev 规则')
  assert.match(r, /flex:none/)
})

test('wb-sls-frow 可换行：窄窗口字段折行而不是重叠', () => {
  const r = rule('.wb-sls-frow')
  assert.ok(r, '存在 .wb-sls-frow 规则')
  assert.match(r, /flex-wrap:wrap/)
})

test('控制件高度一致：环境下拉与开关显式 27px（Chrome select 不吃 line-height，会矮 ~5px）', () => {
  const sel = rule('.wb-sls-envsel')
  assert.ok(sel, '存在 .wb-sls-envsel 规则')
  assert.match(sel, /height:27px/)
  const sw = rule('.wb-sls-switch')
  assert.ok(sw, '存在 .wb-sls-switch 规则')
  assert.match(sw, /height:27px/)
})


test('未配置 SLS 环境时手填 Project/Logstore：复用同一套字段盒与输入基类', () => {
  // 两种形态（环境下拉 / 手填输入）共用 .wb-sls-field + .wb-sls-finput，
  // 手填框不另造样式，否则窄窗口下会和固定宽度字段错位。
  assert.match(source, /'aria-label': 'Project'/)
  assert.match(source, /'aria-label': 'Logstore'/)
  assert.match(source, /h\('span', \{ className: 'wb-sls-flabel' \}, 'Project'\)/)
  assert.match(source, /h\('span', \{ className: 'wb-sls-flabel' \}, 'Logstore'\)/)
  assert.match(source, /'aria-label': 'Project', value: inputs\.project/)
  assert.match(source, /'aria-label': 'Logstore', value: inputs\.logstore/)
  for (const label of ['Project', 'Logstore']) {
    const at = source.indexOf("'aria-label': '" + label + "'")
    const block = source.slice(Math.max(0, at - 300), at)
    assert.ok(block.includes("className: 'glab-input wb-sls-finput'"), label + ' 输入框必须复用共享输入基类')
  }
  // 未配置时的配置提示（管理员改插件行 config）必须存在
  assert.match(source, /未配置 SLS 环境/)
  assert.match(source, /slsEnvironments/)
})


test('同时查询使用外层滚动区域，分区展开详情不被内层滚动裁切', () => {
  assert.match(source, /className: 'glab-body wb-sls-combined'/)
  assert.match(rule('.wb-sls-combined>section'), /flex:none/)
  assert.match(rule('.wb-sls-combined>section>.glab-body'), /overflow:visible/)
  assert.match(rule('.wb-sls-combined>section>.glab-body'), /flex:none/)
})


test('日志正文占满详情区域宽度，边框和内边距包含在宽度内', () => {
  const r = rule('.wb-sls-detail>.wb-sls-content')
  assert.match(r, /flex:0 0 100%/)
  assert.match(r, /width:100%/)
  assert.match(r, /box-sizing:border-box/)
})

test('SLS 结果分区不叠加横向边距，卡片与表单对齐', () => {
  const workbench = readFileSync(new URL('../src/client/styles/workbench.css', import.meta.url), 'utf8')
  assert.match(workbench, /\.wb-workbench \.wb-sls-combined>section>\.glab-body\{[^}]*padding-left:0;[^}]*padding-right:0;[^}]*scrollbar-gutter:auto/)
  assert.match(workbench, /\.wb-workbench \.wb-sls-combined>section>\.wb-sls-summary\{[^}]*padding-left:0;[^}]*padding-right:0/)
  assert.match(workbench, /\.wb-workbench \.wb-sls-entry\{margin-left:0;margin-right:0\}/)
})


test('跨页控件共用尺寸、状态与折叠方向', () => {
  const config = readFileSync(new URL('../src/client/styles/config.css', import.meta.url), 'utf8')
  assert.match(config, /\.wb-config-row-state\{[^}]*text-overflow:ellipsis/, '收起状态的截断样式不能依赖 hover')
  const shared = readFileSync(new URL('../src/client/styles/workbench.css', import.meta.url), 'utf8')
  assert.match(shared, /:is\(\.glab-input,\.glab-repo-input\)\{[^}]*min-height:32px;[^}]*font-size:13px;line-height:20px/)
  assert.match(shared, /select\.glab-input\{appearance:none;[^}]*background-image:var\(--wb-chevron\)/)
  assert.match(shared, /:is\(\.wb-config-chev,\.wb-diff-chev,\.wb-sls-chevron\)\{[^}]*transform:rotate\(-90deg\)/)
  assert.match(shared, /:is\(\.wb-config-chev-open,\.wb-diff-chev-open,\.wb-sls-chevron-open\)\{transform:rotate\(0deg\)/)
  assert.match(shared, /summary::before\{[^}]*mask:var\(--wb-chevron\)/)
  assert.match(shared, /details\[open\]>summary::before\{transform:rotate\(0deg\)/)
  for (const [file, cls] of [['diffview', 'wb-diff-filter'], ['issues', 'wb-iss-pagesize']]) {
    const source = readFileSync(new URL('../src/client/components/' + file + '.tsx', import.meta.url), 'utf8')
    assert.ok(source.includes("className: 'glab-input " + cls + "'"), cls + ' 必须复用共享输入基类')
  }
  const review = readFileSync(new URL('../src/client/components/auto-review.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(review, /className: 'wb-config-select'/, '自动评审下拉不能绕过共享输入基类')
})
