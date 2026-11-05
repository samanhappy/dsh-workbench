// 提示词配置管理（提交 MR/PR + 评审）测试。
//
// 提交 MR/PR 按钮与评审按钮发送的提示词可被每个使用者在自己浏览器里定制
// （localStorage 按人隔离），架构上是一套「配置注册表 + 存取层 + 设置面板」。
// 本文件加载构建产物 lib/client.js（见 test/load-client.mjs），断言导出的
// 纯函数：默认输出不得因引入配置管理而改变（回归基线）、定制模板占位符
// 渲染、未知花括号保留、注册表不变量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'


function lsFrom(store) {
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
  }
}

const REVIEW_ITEM = {
  forge: 'gitlab',
  num: 12,
  title: '接入配置管理',
  source_branch: 'feat/config',
  target_branch: 'master',
  author: 'alice',
  web_url: 'https://gitlab.test/agent/repo/-/merge_requests/12',
  description: '为提交 / 评审提示词引入可定制的配置。',
}

// 未配置时的默认评审提示词 —— 「评审要求」段：只留评审原则、安全边界与输出纪律
// （模型已知的步骤不再说明）；手动与自动评审共用，模板只承载评审原则，host 在
// 模板外追加「发布要求」与「评审对象」（实例数据 + 版本/评论核实，见 auto-review.mjs）。
const EXPECTED_DEFAULT_REVIEW = [
  '评审 GitLab MR !12。',
  '',
  '**评审要求**',
  '- 核实指定提交范围，审查全部变更及相关代码。',
  '- 只报有证据、有实质影响且值得修复的问题；省略可改可不改的建议与推测。',
  '- 先给合并结论；有问题则注明位置、影响与原因，无则简述。报告简短，不罗列核查过程。',
  '- 遵循适用的 AGENTS.md；仅做只读评审，不修改代码或工作区。必要时使用临时 worktree 测试并清理。',
].join('\n')

const ISSUE_ITEM = {
  forge: 'gitlab',
  num: 128,
  title: 'Token 提前过期',
  state: 'opened',
  web_url: 'https://gitlab.test/agent/repo/-/issues/128',
  description: '登录后长时间使用时 Token 会提前过期，需要排查刷新逻辑。',
  author: { username: 'alice', name: 'Alice', avatar: '' },
  assignees: [],
  labels: ['Bug'],
}

// 未配置时的默认 Issue 处理提示词 —— 本轮定位是「仅分析、确认问题」：
// 先确认问题真实存在，再谈怎么改；同样只留输出契约、安全边界与语言策略。
const EXPECTED_DEFAULT_ISSUE = [
  '请处理 GitLab Issue #128「Token 提前过期」（agent/repo）。',
  '',
  '先读 Issue 描述与评论，再在代码库里定位相关实现，确认问题是否真实存在、复现路径与影响范围；给出结论：能否复现 / 根因假设 / 涉及文件与行号，按「🔴 已确认 / 🟡 待确认 / 💬 信息不足」三档列出结论与依据。',
  '本轮只做分析与确认：不改代码、不提交、不新建分支，也不关闭 Issue 或发表评论。报告用中文；若要把结论发表为 Issue 评论，先询问我。',
].join('\n')

test('renderTemplate: 替换已知占位符，未知花括号原样保留', () => {
  const { renderTemplate } = loadClientModule()
  assert.equal(
    renderTemplate('评审 {platform} {label}（{title}）', { platform: 'GitLab MR', label: '!12', title: 't' }),
    '评审 GitLab MR !12（t）'
  )
  // 未知占位符保留 —— 用户的提示词里可能含字面花括号（如 JSON 示例）
  assert.equal(renderTemplate('示例 {json} {"a":1}', { json: 'x' }), '示例 x {"a":1}')
  // 未提供的占位符 / 字面花括号原样保留 —— 用户提示词里可能含它们
  assert.equal(renderTemplate('a {nope} b', {}), 'a {nope} b')
  assert.equal(renderTemplate(null, {}), '')
})

test('buildReviewPrompt: 未配置时输出默认（模板只承载「评审要求」段）', () => {
  const { buildReviewPrompt } = loadClientModule()
  const out = buildReviewPrompt(REVIEW_ITEM)
  assert.equal(out, EXPECTED_DEFAULT_REVIEW)
  // 模板只承载「评审要求」：评审范围、输出纪律、安全边界（只读 + worktree）、AGENTS.md；
  // 「发布要求」与「评审对象」由 host 在模板外追加（见 auto-review.mjs）
  assert.ok(out.includes('**评审要求**'))
  assert.ok(out.includes('核实指定提交范围'))
  assert.ok(out.includes('只报有证据、有实质影响且值得修复的问题'))
  assert.ok(out.includes('仅做只读评审，不修改代码或工作区'))
  assert.ok(out.includes('临时 worktree 测试并清理'))
  assert.ok(out.includes('遵循适用的 AGENTS.md'))
})

test('buildReviewPrompt: 平台/编号随条目渲染，GitHub 输出同样成立', () => {
  const { buildReviewPrompt } = loadClientModule()
  const out = buildReviewPrompt({ forge: 'github', num: 7, title: 't', source_branch: 'a', target_branch: 'b' })
  assert.ok(out.startsWith('评审 GitHub PR #7。'))
  assert.ok(out.includes('先给合并结论'))
})

test('buildReviewPrompt: 定制模板生效，占位符按条目替换，未知占位符保留', () => {
  const store = {
    'samanhappy.dsh-workbench.config': JSON.stringify({
      'prompt.review': '请重点评审 {label}「{title}」的安全与并发（{diff_cmd}），结论：{conclusion}',
    }),
  }
  const { buildReviewPrompt } = loadClientModule(lsFrom(store))
  const out = buildReviewPrompt(REVIEW_ITEM)
  assert.ok(out.includes('请重点评审 !12「接入配置管理」的安全与并发（glab mr diff 12）'))
  assert.ok(out.includes('结论：{conclusion}'))
})

test('buildReviewPrompt: 空串覆盖视为未定制，回退默认模板', () => {
  const store = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'prompt.review': '   ' }) }
  const { buildReviewPrompt } = loadClientModule(lsFrom(store))
  assert.equal(buildReviewPrompt(REVIEW_ITEM), EXPECTED_DEFAULT_REVIEW)
})

test('buildIssuePrompt: 未配置时输出默认（仅分析、确认问题 + 安全边界）', () => {
  const { buildIssuePrompt } = loadClientModule()
  const out = buildIssuePrompt(ISSUE_ITEM)
  assert.equal(out, EXPECTED_DEFAULT_ISSUE)
  assert.ok(out.includes('只做分析与确认'), '默认必须限定本轮只做分析与确认')
  assert.ok(out.includes('不改代码'), '默认必须写明不改代码')
  assert.ok(out.includes('报告用中文'))
})

test('buildIssuePrompt: 平台/编号/仓库随条目渲染，GitHub 输出同样成立', () => {
  const { buildIssuePrompt } = loadClientModule()
  const gh = buildIssuePrompt({
    forge: 'github', num: 7, title: 't', description: '', state: 'opened',
    web_url: 'https://github.com/o/r/issues/7', author: { username: 'alice', name: '', avatar: '' },
    assignees: [], labels: [],
  })
  assert.ok(gh.startsWith('请处理 GitHub Issue #7「t」（o/r）。'))
  assert.ok(gh.includes('三档'))
})

test('buildIssuePrompt: 定制模板生效，占位符按条目替换，未知占位符保留', () => {
  const store = {
    'samanhappy.dsh-workbench.config': JSON.stringify({
      'prompt.issue': '排查 {label}「{title}」于 {repo}：先跑 {view_cmd}，结论 {conclusion}',
    }),
  }
  const { buildIssuePrompt } = loadClientModule(lsFrom(store))
  const out = buildIssuePrompt(ISSUE_ITEM)
  assert.equal(out, '排查 #128「Token 提前过期」于 agent/repo：先跑 glab issue view 128，结论 {conclusion}')
})

test('buildIssuePrompt: 空串覆盖视为未定制，回退默认模板', () => {
  const store = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'prompt.issue': '   ' }) }
  const { buildIssuePrompt } = loadClientModule(lsFrom(store))
  assert.equal(buildIssuePrompt(ISSUE_ITEM), EXPECTED_DEFAULT_ISSUE)
})

test('buildSubmitPrompt: 默认输出为简洁版（平台命令 + 中文 + 不合并）', () => {
  const { buildSubmitPrompt } = loadClientModule()
  const gh = buildSubmitPrompt('github')
  assert.ok(gh.includes('请把当前工作区的改动提交为 GitHub PR'))
  assert.ok(gh.includes('用 gh 创建 PR'))
  const gl = buildSubmitPrompt('gitlab')
  assert.ok(gl.includes('请把当前工作区的改动提交为 GitLab MR'))
  assert.ok(gl.includes('用 glab 创建 MR'))
})

test('buildSubmitPrompt: 定制后不再使用内置文案，且互不影响', () => {
  const store = {
    'samanhappy.dsh-workbench.config': JSON.stringify({
      'prompt.submit.github': '请用 gh 提交 PR，标题用英文，完成后报告链接。',
    }),
  }
  const { buildSubmitPrompt } = loadClientModule(lsFrom(store))
  assert.equal(buildSubmitPrompt('github'), '请用 gh 提交 PR，标题用英文，完成后报告链接。')
  assert.ok(buildSubmitPrompt('gitlab').includes('GitLab MR')) // gitlab 条目不受影响
})

test('CONFIG_ITEMS 注册表：key 唯一、字段齐全、kind 已知、默认值就绪', () => {
  const { CONFIG_ITEMS } = loadClientModule()
  assert.ok(Array.isArray(CONFIG_ITEMS) && CONFIG_ITEMS.length >= 3)
  const keys = new Set()
  for (const item of CONFIG_ITEMS) {
    assert.equal(typeof item.key, 'string', 'key 必须是字符串')
    assert.equal(typeof item.label, 'string', 'label 必须是字符串')
    if (item.help !== undefined) assert.equal(typeof item.help, 'string', 'help 必须是字符串')
    assert.ok(['prompt', 'text', 'select', 'toggle', 'model'].includes(item.kind), '未知 kind: ' + item.kind)
    assert.ok(item.default !== undefined && item.default !== null, 'default 必须提供: ' + item.key)
    assert.ok(!keys.has(item.key), 'key 重复: ' + item.key)
    keys.add(item.key)
  }
  assert.ok(keys.has('prompt.review'))
  assert.ok(keys.has('prompt.issue'))
  assert.ok(keys.has('prompt.submit.github'))
  assert.ok(keys.has('prompt.submit.gitlab'))
  assert.ok(keys.has('review.model'), '评审模型必须登记在注册表里')
})

// ── 评审模型（kind 'model'）──────────────────────────────────────────────────
// 「点评审用哪个模型」是按人可定制的偏好，值形如 provider/model；未定制 /
// 值畸形 → null（沿用 DSH 默认模型）。这里只回归纯函数与注册表契约；点击链
// 路上的实际切换在 test/review-session.mjs。

test('formatModelRef / parseModelRef: provider/model 往返，空与畸形输入 → null', () => {
  const { formatModelRef, parseModelRef } = loadClientModule()
  assert.equal(formatModelRef('deepseek-official', 'deepseek-v4-pro'), 'deepseek-official/deepseek-v4-pro')
  assert.equal(formatModelRef('p', 'm'), 'p/m')
  assert.equal(formatModelRef('', 'm'), '')
  assert.equal(formatModelRef('p', '  '), '')

  // 注：跨 vm realm 的对象原型不同，不能用 deepStrictEqual，逐字段断言
  const ref = parseModelRef('deepseek-official/deepseek-v4-pro')
  assert.equal(ref.provider, 'deepseek-official')
  assert.equal(ref.model, 'deepseek-v4-pro')
  // 模型 id 自身含 '/' 时按第一个 '/' 切分，不被截断
  const nested = parseModelRef('openrouter/vendor/model-1')
  assert.equal(nested.provider, 'openrouter')
  assert.equal(nested.model, 'vendor/model-1')
  // 空 / 缺分隔符 / 单侧为空 → 未定制
  assert.equal(parseModelRef(''), null)
  assert.equal(parseModelRef('   '), null)
  assert.equal(parseModelRef('deepseek-official'), null)
  assert.equal(parseModelRef('/deepseek-v4-pro'), null)
  assert.equal(parseModelRef('deepseek-official/'), null)
  assert.equal(parseModelRef(null), null)
  assert.equal(parseModelRef(undefined), null)
})

test('resolveReviewModel: 读 localStorage 覆盖，未定制 / 空串 / 畸形回退 null', () => {
  const configured = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'review.model': 'deepseek-account/deepseek-v4-pro' }) }
  const a = loadClientModule(lsFrom(configured))
  const ref = a.resolveReviewModel()
  assert.equal(ref.provider, 'deepseek-account')
  assert.equal(ref.model, 'deepseek-v4-pro')

  // 未定制（老用户零感知：评审沿用 DSH 默认模型）
  assert.equal(loadClientModule(lsFrom({})).resolveReviewModel(), null)
  // 空串覆盖 = 未定制
  const blank = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'review.model': '  ' }) }
  assert.equal(loadClientModule(lsFrom(blank)).resolveReviewModel(), null)
  // 畸形值不猜：宁可回退默认模型，也不把半截值发出去
  const broken = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'review.model': 'no-separator' }) }
  assert.equal(loadClientModule(lsFrom(broken)).resolveReviewModel(), null)
})

// ── 配置分域（scope）回归 ────────────────────────────────────────────────────
// 评审 / 提交 MR/PR 提示词是「仓库」页的功能，归 forge 域；四个功能开关
// （仓库 / DMS / SLS / PingCode）是全局功能，归 global 域。configItemsFor(scope)
// 供面板分域取项，配置页（scope 'all'）按域分组渲染。

test('CONFIG_ITEMS scope：评审模型与提示词归仓库页（forge），六个功能开关归全局、通知归首页，无未分域项', () => {
  const { CONFIG_ITEMS, configItemsFor } = loadClientModule()
  const forgeKeys = configItemsFor('forge').map(function (c) { return c.key })
  assert.deepEqual(forgeKeys.sort(), ['git.commit.language', 'prompt.git.commit', 'prompt.issue', 'prompt.review', 'prompt.submit.github', 'prompt.submit.gitlab', 'review.model'])
  // 评审模型是下拉（kind 'model'）且默认留空 = 未定制 = 沿用 DSH 默认模型
  const modelItem = CONFIG_ITEMS.find(function (c) { return c.key === 'review.model' })
  assert.equal(modelItem.kind, 'model')
  assert.equal(modelItem.default, '')
  assert.ok(modelItem.help.includes('DSH 默认模型'), 'help 必须说明留空 = 沿用 DSH 默认模型')
  assert.ok(modelItem.help.includes('全局默认模型'), 'help 必须如实说明会同时改写全局默认模型')
  assert.deepEqual(configItemsFor('global').map(function (c) { return c.key }).sort(),
    ['feature.dms', 'feature.forge', 'feature.git', 'feature.pingcode', 'feature.skills', 'feature.sls'])
  for (const item of CONFIG_ITEMS) {
    assert.ok(item.scope === 'forge' || item.scope === 'global' || item.scope === 'home', '每项都要显式声明 scope: ' + item.key)
  }
})

test('configItemsFor：global = 六个功能开关，forge + global + home 恰好划分全部配置项', () => {
  const { CONFIG_ITEMS, configItemsFor } = loadClientModule()
  const global = configItemsFor('global')
  assert.equal(global.length, 6, '全局域 = 六个功能开关')
  assert.deepEqual(configItemsFor('home').map(c => c.key), ['feature.notifications'])
  assert.ok(global.every(function (c) { return c.kind === 'toggle' }), '全局域当前只放功能开关')
  const all = configItemsFor('all')
  assert.equal(all.length, CONFIG_ITEMS.length)
  const forge = configItemsFor('forge')
  assert.equal(forge.length + global.length + configItemsFor('home').length, all.length, 'forge + global 应恰好划分全部配置项')
})

test('resetConfigKeys: 只清除给定 key，保留其余定制（分域「全部恢复默认」用）', () => {
  const store = {
    'samanhappy.dsh-workbench.config': JSON.stringify({
      'prompt.review': '定制 A',
      'prompt.submit.github': '定制 B',
      'global.example': '全局定制，不得被仓库页的恢复默认清掉',
    }),
  }
  const a = loadClientModule(lsFrom(store))
  assert.equal(a.resetConfigKeys(['prompt.review', 'prompt.submit.github']), true)
  const left = JSON.parse(store['samanhappy.dsh-workbench.config'])
  assert.equal('prompt.review' in left, false)
  assert.equal('prompt.submit.github' in left, false)
  assert.equal(left['global.example'], '全局定制，不得被仓库页的恢复默认清掉')

  // 无 localStorage（隐私模式等）→ false，面板据此提示「保存失败」
  const b = loadClientModule()
  assert.equal(b.resetConfigKeys(['prompt.review']), false)
})

// ── 设置面板 UI 修复回归（光标插入 / 保存反馈 / help 去重）─────────────────
// chip 原实现强制「换行 + 追加到末尾」，会破坏句子（「请评审 」+ {title} →
// 「请评审 \n{title}」）；核心插入逻辑抽成纯函数 spliceToken 在此回归。
// saveConfig/resetConfig 返回布尔，支撑面板「已保存 / 保存失败」提示，
// 不再静默吞掉 localStorage 写失败（隐私模式等）。

test('spliceToken: 光标处原位插入，不破坏句子（回归：旧实现强制换行追加末尾）', () => {
  const { spliceToken } = loadClientModule()
  const r = spliceToken('请评审 ', 4, 4, '{title}')
  assert.equal(r.text, '请评审 {title}')
  assert.equal(r.caret, 11) // 光标落在插入内容之后
})

test('spliceToken: 替换选中区间、末尾追加、缺省/越界下标收敛', () => {
  const { spliceToken } = loadClientModule()
  // 注：跨 vm realm 的对象原型不同，不能用 deepStrictEqual，逐字段断言
  const eq = function (r, text, caret, msg) {
    assert.equal(r.text, text, msg)
    assert.equal(r.caret, caret, msg)
  }
  eq(spliceToken('abcdef', 2, 4, 'X'), 'abXef', 3, '替换选区')
  eq(spliceToken('abc', 3, 3, 'T'), 'abcT', 4, '末尾追加')
  // 无光标信息（start/end 缺省）→ 追加到末尾
  eq(spliceToken('abc', undefined, undefined, 'T'), 'abcT', 4, '缺省下标')
  eq(spliceToken('', undefined, undefined, '{num}'), '{num}', 5, '空文本')
  // 越界与负数下标收敛进 [0, len]
  eq(spliceToken('abc', 99, 99, 'T'), 'abcT', 4, '越界收敛到末尾')
  eq(spliceToken('abc', -2, -2, 'T'), 'Tabc', 1, '负数收敛到开头')
  eq(spliceToken(null, 0, 0, 'x'), 'x', 1, 'null 文本')
})

test('saveConfig/resetConfig: 返回是否成功（存储写失败不再静默）', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  assert.equal(a.saveConfig({ 'prompt.review': '定制 A' }), true)
  assert.equal(a.saveConfig({ 'prompt.submit.github': '定制 B' }), true)
  const merged = JSON.parse(store['samanhappy.dsh-workbench.config'])
  assert.equal(merged['prompt.review'], '定制 A') // 合并写入，互不覆盖
  assert.equal(merged['prompt.submit.github'], '定制 B')
  assert.equal(a.resetConfig('prompt.review'), true)
  assert.equal('prompt.review' in JSON.parse(store['samanhappy.dsh-workbench.config']), false)

  // 无 localStorage（隐私模式等）→ false，面板据此提示「保存失败」
  const b = loadClientModule()
  assert.equal(b.saveConfig({ 'prompt.review': 'x' }), false)
  assert.equal(b.resetConfig('prompt.review'), false)
})

test('CONFIG_ITEMS: 评审提示词不展示占位符按钮，已有模板仍可替换变量', () => {
  const { CONFIG_ITEMS, buildReviewPrompt } = loadClientModule(lsFrom({
      'samanhappy.dsh-workbench.config': JSON.stringify({
        'prompt.review': '{platform} {label} {num} {title} {source_branch} {target_branch} {author} {web_url} {description} {cli} {diff_cmd} {view_cmd} {note_cmd}',
      }),
  }))
  const review = CONFIG_ITEMS.find(function (c) { return c.key === 'prompt.review' })
  assert.equal(review.placeholders, undefined)
  assert.ok(!review.help.includes('点击占位符'))
  assert.equal(buildReviewPrompt(REVIEW_ITEM), [
    'GitLab MR', '!12', '12', REVIEW_ITEM.title, REVIEW_ITEM.source_branch,
    REVIEW_ITEM.target_branch, REVIEW_ITEM.author, REVIEW_ITEM.web_url,
    REVIEW_ITEM.description, 'glab', 'glab mr diff 12', 'glab mr view 12',
    'glab mr note create 12',
  ].join(' '))
})


test('Git commit prompt uses the saved override and restores its shared default when blank', () => {
  const store = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'prompt.git.commit': '用中文写 Conventional Commits，主题不超过 50 字。' }) }
  const client = loadClientModule({ getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value } })
  assert.equal(client.resolveConfigText('prompt.git.commit'), '用中文写 Conventional Commits，主题不超过 50 字。')
  client.saveConfig({ 'prompt.git.commit': '   ' })
  assert.match(client.resolveConfigText('prompt.git.commit'), /根据文件改动生成简洁/)
})


test('Git commit language defaults to Chinese and persists English selection', () => {
  const client = loadClientModule(lsFrom({}))
  const item = client.CONFIG_ITEMS.find(item => item.key === 'git.commit.language')
  assert.equal(item.kind, 'select')
  assert.deepEqual(Array.from(item.options, option => option.value), ['zh', 'en'])
  assert.equal(client.resolveConfigText(item.key), 'zh')
  client.saveConfig({ [item.key]: 'en' })
  assert.equal(client.resolveConfigText(item.key), 'en')
  client.resetConfig(item.key)
  assert.equal(client.resolveConfigText(item.key), 'zh')
})
