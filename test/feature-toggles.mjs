// 功能开关（feature toggle）测试：注册表开关齐全 + 覆盖值解析 + 配置变更广播
// + 页面可用性判定。
//
// 五个功能域（仓库 / DMS / SLS / PingCode / 技能管理）可在工作台「配置」页按
// 人开启或关闭；关闭后对应功能页签 / 侧边栏跳转图标 / 助手按钮消失，外壳轮询
// 也不再请求该域。开关值复用「配置注册表 + localStorage 覆盖」这套存取层
// （见 prompts.ts），这里断言纯函数层：默认值、文本解析、写入语义、变更广播、
// 以及 shell 的页可用性判定（配置页不受开关约束）。
// 加载构建产物 lib/client.js，见 test/load-client.mjs。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

function lsFrom(store) {
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
  }
}

const ALL_ON = { git: true, forge: true, dms: true, sls: true, pingcode: true, skills: true, notifications: true }
const FEATURE_KEYS = ['feature.forge', 'feature.git', 'feature.dms', 'feature.sls', 'feature.pingcode', 'feature.skills', 'feature.notifications']

test('注册表：功能开关齐全，kind=toggle / 按用途分域 / 默认开启', () => {
  const { CONFIG_ITEMS, FEATURE_CONFIG_KEYS, FEATURE_ORDER } = loadClientModule()
  assert.deepEqual(Object.keys(FEATURE_CONFIG_KEYS).sort(), ['dms', 'forge', 'git', 'notifications', 'pingcode', 'skills', 'sls'])
  assert.deepEqual(FEATURE_ORDER, ['forge', 'git', 'dms', 'sls', 'pingcode', 'skills', 'notifications'])
  for (const key of FEATURE_KEYS) {
    const item = CONFIG_ITEMS.find((c) => c.key === key)
    assert.ok(item, '注册表缺少开关项: ' + key)
    assert.equal(item.kind, 'toggle', key + ' 必须是 toggle')
    assert.equal(item.scope, key === 'feature.notifications' ? 'home' : 'global')
    assert.equal(item.default, true, key + ' 默认必须开启（老用户零感知）')
    if (item.help !== undefined) assert.equal(typeof item.help, 'string', key + ' 的说明必须是字符串')
  }
  // 开关项必须排在文本类配置之前（配置页按注册表顺序渲染，功能开关在前）
  assert.deepEqual(CONFIG_ITEMS.slice(0, FEATURE_KEYS.length).map((c) => c.key), FEATURE_KEYS)
})

test('resolveConfigToggle：未定制 / 无 localStorage 时取注册表默认（开启）', () => {
  const a = loadClientModule()
  assert.equal(a.resolveConfigToggle('feature.forge'), true)
  assert.equal(a.defaultToggleOf('feature.forge'), true)
  // 未知 key 视为开启，不抛
  assert.equal(a.resolveConfigToggle('nope.nothing'), true)
  assert.equal(a.defaultToggleOf('nope.nothing'), true)
  // 文本类配置项不是开关，取开关值时同样回退默认（开启）
  assert.equal(a.defaultToggleOf('prompt.review'), true)
})

test('resolveConfigToggle：off/0/false/no 为关（大小写空白不敏感），其余为开', () => {
  for (const [raw, expected] of [
    ['off', false], ['OFF', false], ['  off  ', false], ['0', false], ['false', false], ['No', false],
    ['on', true], ['1', true], ['true', true], ['yes', true], ['  ', true], ['开', true],
  ]) {
    const store = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'feature.sls': raw }) }
    const a = loadClientModule(lsFrom(store))
    assert.equal(a.resolveConfigToggle('feature.sls'), expected, JSON.stringify(raw))
  }
})

test('setConfigToggle：关闭写入 off；开启等于默认时清除覆盖（回到未定制）', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  assert.equal(a.setConfigToggle('feature.dms', false), true)
  assert.equal(JSON.parse(store['samanhappy.dsh-workbench.config'])['feature.dms'], 'off')
  assert.equal(a.resolveConfigToggle('feature.dms'), false)
  // 再点一次开启 = 回到注册表默认 → 不再留覆盖值（「已定制」标记随之消失）
  assert.equal(a.setConfigToggle('feature.dms', true), true)
  assert.equal('feature.dms' in JSON.parse(store['samanhappy.dsh-workbench.config']), false)
  assert.equal(a.resolveConfigToggle('feature.dms'), true)
  // 只动目标 key，其他定制不受影响
  a.saveConfig({ 'prompt.review': '定制' })
  a.setConfigToggle('feature.pingcode', false)
  const left = JSON.parse(store['samanhappy.dsh-workbench.config'])
  assert.equal(left['prompt.review'], '定制')
  assert.equal(left['feature.pingcode'], 'off')
})

test('setConfigToggle：本机存储不可用时返回 false（面板提示保存失败）', () => {
  const a = loadClientModule() // 无 localStorage
  assert.equal(a.setConfigToggle('feature.forge', false), false)
})

test('配置变更广播：写入推进 revision 并通知订阅者，退订后不再收到', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  const seen = []
  const off = a.subscribeConfig(() => seen.push(a.configRevision()))
  const rev0 = a.configRevision()
  a.setConfigToggle('feature.sls', false)
  assert.equal(seen.length, 1, '写入必须广播一次')
  assert.ok(a.configRevision() > rev0, '写入必须推进 revision')
  a.saveConfig({ 'prompt.review': 'x' })
  assert.equal(seen.length, 2, '文本类写入同样广播')
  off()
  a.resetConfig('prompt.review')
  assert.equal(seen.length, 2, '退订后不再收到')
  // 存储不可用 → 写入失败 → revision 不动、不广播
  const b = loadClientModule()
  const rev = b.configRevision()
  const hits = []
  const off2 = b.subscribeConfig(() => hits.push(1))
  assert.equal(b.saveConfig({ 'prompt.review': 'x' }), false)
  assert.equal(b.configRevision(), rev)
  assert.equal(hits.length, 0)
  off2()
})

test('featureFlags：快照按取值指纹缓存，写入后返回反映新值的新快照', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  assert.deepEqual(a.featureFlags(), ALL_ON)
  const snap = a.featureFlags()
  assert.equal(a.featureFlags(), snap, '取值未变时必须是同一对象（useSyncExternalStore 安全）')
  a.setConfigToggle('feature.pingcode', false)
  const next = a.featureFlags()
  assert.notEqual(next, snap, '取值变化后必须换新快照')
  assert.equal(next.pingcode, false)
  assert.equal(a.isFeatureEnabled('pingcode'), false)
  assert.equal(a.isFeatureEnabled('forge'), true)
})

test('featureFlags：插件之外改覆盖值（另一个标签页 / 冷启动持久化）也会立即生效', () => {
  const store = { 'samanhappy.dsh-workbench.config': JSON.stringify({ 'feature.forge': 'on' }) }
  const a = loadClientModule(lsFrom(store))
  assert.equal(a.featureFlags().forge, true)
  const snap = a.featureFlags()
  // 不经过本插件的写入 API、也没有任何变更广播：直接改底层存储
  store['samanhappy.dsh-workbench.config'] = JSON.stringify({ 'feature.forge': 'off', 'feature.dms': '0' })
  const next = a.featureFlags()
  assert.notEqual(next, snap, '取值变了必须换新快照')
  assert.equal(next.forge, false)
  assert.equal(next.dms, false)
  assert.equal(next.sls, true)
})

test('isPageEnabled：只有开启的功能页可用，配置页永不受开关约束', () => {
  const a = loadClientModule()
  assert.equal(a.isPageEnabled('config', ALL_ON), true)
  for (const page of ['forge', 'git', 'dms', 'sls', 'pingcode', 'skills', 'notifications']) {
    assert.equal(a.isPageEnabled(page, ALL_ON), true, page + ' 在全部开启时可用')
  }
  const dmsOff = Object.assign({}, ALL_ON, { dms: false })
  assert.equal(a.isPageEnabled('dms', dmsOff), false)
  assert.equal(a.isPageEnabled('forge', dmsOff), true)
  const allOff = { forge: false, dms: false, sls: false, pingcode: false, skills: false, notifications: false }
  assert.equal(a.isPageEnabled('forge', allOff), false)
  assert.equal(a.isPageEnabled('skills', allOff), false)
  assert.equal(a.isPageEnabled('config', allOff), true, '全部关闭后配置页仍可用，否则无法重新开启')
})

test('fallbackPage：落到仍开启的第一个功能页，全关则回配置页', () => {
  const a = loadClientModule()
  assert.equal(a.fallbackPage(ALL_ON), 'forge')
  assert.equal(a.fallbackPage({ forge: false, dms: true, sls: true, pingcode: true, skills: true, notifications: true }), 'dms')
  assert.equal(a.fallbackPage({ forge: false, dms: false, sls: true, pingcode: true, skills: true, notifications: true }), 'sls')
  assert.equal(a.fallbackPage({ forge: false, dms: false, sls: false, pingcode: true, skills: true, notifications: true }), 'pingcode')
  assert.equal(a.fallbackPage({ forge: false, dms: false, sls: false, pingcode: false, skills: true, notifications: true }), 'skills')
  assert.equal(a.fallbackPage({ forge: false, dms: false, sls: false, pingcode: false, skills: false, notifications: false }), 'config')
})

test('快捷入口独立保存，功能关闭时隐藏，重新开启保留入口偏好', () => {
  const store = {}
  const a = loadClientModule(lsFrom(store))
  assert.deepEqual(a.shortcutFlags(), { ...ALL_ON, git: false })
  assert.equal(a.shortcutFlags(), a.shortcutFlags())
  for (const feature of a.FEATURE_ORDER.filter(key => key !== 'git')) {
    const key = 'shortcut.' + feature
    a.setConfigToggle(key, false)
    assert.equal(a.shortcutFlags()[feature], false)
    assert.equal(a.featureFlags()[feature], true)
    assert.equal(a.isPageEnabled(feature, a.featureFlags()), true)
    a.setConfigToggle('feature.' + feature, false)
    a.setConfigToggle('feature.' + feature, true)
    assert.equal(a.shortcutFlags()[feature], false)
    a.setConfigToggle(key, true)
    assert.equal(a.shortcutFlags()[feature], true)
    a.setConfigToggle('feature.' + feature, false)
    assert.equal(a.shortcutFlags()[feature], false)
    a.resetConfigKeys(['feature.' + feature, key])
    assert.equal(a.shortcutFlags()[feature], true)
  }
})

test('配置卡片：快捷开关受总开关约束，单项和全部恢复默认清除入口偏好', async () => {
  const { build } = await import('esbuild')
  const store = {}
  globalThis.localStorage = lsFrom(store)
  let cursor = 0
  const slots = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  const result = await build({ entryPoints: ['src/client/components/config.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
  const mod = { exports: {} }
  Function('require', 'module', 'exports', 'setTimeout', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports, () => 0)
  const render = () => { cursor = 0; return mod.exports.ConfigPanel({ scope: 'all' }) }
  const all = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(all)]
  const card = tree => all(tree).find(n => n.props.key === 'feature.forge')
  const checkbox = tree => all(card(tree)).find(n => n.type === 'input')
  let tree = render()
  const text = n => typeof n === 'string' ? n : n?.children?.map(text).join('') || ''
  const nav = all(tree).find(n => n.type === 'nav')
  assert.deepEqual(nav.children.map(text), ['功能与导航', '首页', '代码评审', 'Git 提交', 'AI 提示词'])
  assert.equal(all(tree).filter(n => n.type === 'section').length, 5)
  assert.deepEqual(all(tree).filter(n => n.type === 'section' && !n.props.hidden).map(n => n.props['aria-label']), ['功能与导航'])
  nav.children.find(n => text(n) === 'AI 提示词').props.onClick()
  tree = render()
  assert.deepEqual(all(tree).filter(n => n.type === 'section' && !n.props.hidden).map(n => n.props['aria-label']), ['AI 提示词'])
  assert.equal(all(tree).find(n => n.props['aria-current'] === 'location').children[0], 'AI 提示词')
  nav.children.find(n => text(n) === '功能与导航').props.onClick()
  tree = render()
  assert.equal(all(tree).filter(n => n.props.role === 'switch').length, 7)
  assert.ok(!text(tree).includes('已开启'))
  assert.ok(!all(tree).some(n => n.type === 'button' && text(n).includes('恢复默认')))
  const repoCard = key => all(tree).find(n => n.props.key === key)
  assert.equal(all(repoCard('review.model')).filter(n => n.type === 'select').length, 1, '模型行内选择')
  for (const key of ['prompt.git.commit', 'prompt.review', 'prompt.issue', 'prompt.submit.github', 'prompt.submit.gitlab']) {
    const row = repoCard(key)
    assert.equal(all(row).find(n => n.type === 'button').props['aria-expanded'], false)
    assert.equal(all(row).filter(n => n.type === 'textarea').length, 0)
    assert.ok(!all(row).some(n => n.type === 'button' && text(n) === '恢复默认'))
  }
  all(repoCard('prompt.review')).find(n => n.type === 'button').props.onClick()
  tree = render()
  let prompt = repoCard('prompt.review')
  let textarea = all(prompt).find(n => n.type === 'textarea')
  textarea.props.onChange({ target: { value: '定制评审指令' } })
  tree = render()
  prompt = repoCard('prompt.review')
  all(prompt).find(n => n.type === 'button' && text(n) === '保存').props.onClick()
  assert.equal(JSON.parse(store['samanhappy.dsh-workbench.config'])['prompt.review'], '定制评审指令')
  all(prompt).find(n => n.type === 'button' && text(n) === '恢复默认').props.onClick()
  tree = render()
  assert.ok(!JSON.parse(store['samanhappy.dsh-workbench.config'])['prompt.review'])
  assert.ok(!all(repoCard('prompt.review')).some(n => n.type === 'button' && text(n) === '恢复默认'))
  const language = repoCard('git.commit.language')
  all(language).find(n => n.type === 'select').props.onChange({ target: { value: 'en' } })
  tree = render()
  assert.equal(JSON.parse(store['samanhappy.dsh-workbench.config'])['git.commit.language'], 'en')
  all(repoCard('git.commit.language')).find(n => n.type === 'button' && text(n) === '恢复默认').props.onClick()
  tree = render()
  assert.equal(all(repoCard('git.commit.language')).find(n => n.type === 'select').props.value, 'zh')
  const gitCard = all(tree).find(n => n.props.key === 'feature.git')
  assert.equal(all(gitCard).some(n => n.type === 'input'), false, 'Git 无快捷入口配置')
  // 通知列表页没有侧栏快捷入口（入口收敛到首页），快捷开关只渲染 5 个
  assert.equal(all(tree).filter(n => n.type === 'input').length, 5)
  const notifyCard = all(tree).find(n => n.props.key === 'feature.notifications')
  assert.equal(notifyCard.props.className, 'wb-config-item wb-config-setting wb-config-setting-toggle', '首页选项采用配置行')
  assert.ok(all(tree).some(n => n.type === 'section' && n.props['aria-label'] === '首页'))
  all(notifyCard).find(n => n.props.role === 'switch').props.onClick()
  assert.equal(all(render()).find(n => n.props['aria-label'] === '显示 GitHub 通知').props['aria-checked'], false)
  assert.equal(JSON.parse(store['samanhappy.dsh-workbench.config'])['feature.notifications'], 'off')
  assert.equal(all(notifyCard).some(n => n.type === 'input'), false, '通知开关行无快捷入口复选框')
  assert.equal(checkbox(tree).props.checked, true)
  checkbox(tree).props.onChange()
  tree = render()
  assert.equal(checkbox(tree).props.checked, false)
  all(card(tree)).find(n => n.props.role === 'switch').props.onClick()
  tree = render()
  assert.equal(checkbox(tree).props.disabled, true)
  all(card(tree)).find(n => n.props.title?.startsWith('清除此项')).props.onClick()
  tree = render()
  assert.equal(checkbox(tree).props.checked, true)
  assert.equal(checkbox(tree).props.disabled, false)
  checkbox(tree).props.onChange()
  tree = render()
  all(tree).find(n => n.type === 'button' && n.children.includes('全部恢复默认')).props.onClick()
  assert.equal(checkbox(render()).props.checked, true)
  assert.deepEqual(JSON.parse(store['samanhappy.dsh-workbench.config']), {})
})
