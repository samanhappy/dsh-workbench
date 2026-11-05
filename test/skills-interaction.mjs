import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Exercise the real component with persistent hook state and controllable requests.
test('技能交互：最新搜索获胜、详情页可浏览支持文件、发现页可切换作用域', async () => {
  const slots = []; let cursor = 0
  const pending = []
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback: fn => fn, useEffect() {},
  }
  const result = await build({ entryPoints: ['src/client/components/skills.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const useWsData=()=>null; export const forgeFetch=(...args)=>globalThis.__skillFetch(...args);', loader: 'js' }))
  } }] })
  globalThis.__skillFetch = (path, options) => new Promise(resolve => pending.push({ path, options, resolve }))
  delete globalThis.localStorage
  const module = { exports: {} }
  // The host primitives are stubbed with string-typed elements: this test
  // asserts WHICH renderer the detail page picks per file type and with what
  // props, not the host's own internals.
  const primitives = { CodeBlock: 'CodeBlock' }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : primitives, module, module.exports)
  const render = () => { cursor = 0; return module.exports.SkillPanel({}) }
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(all)]
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || ''
  const find = (tree, label) => all(tree).find(n => n.type === 'button' && text(n) === label)
  let tree = render()
  find(tree, '发现技能').props.onClick(); tree = render()
  assert.ok(all(tree).find(n => n.type === 'select' && n.props['aria-label'] === '技能作用域'))
  find(tree, '代码评审').props.onClick(); tree = render()
  find(tree, '测试').props.onClick()
  pending[1].resolve({ skills: [{ id: 'a/b/new', name: 'new', slug: 'new', source: 'a/b' }] }); await Promise.resolve(); tree = render()
  assert.ok(text(tree).includes('new'))
  pending[0].resolve({ skills: [{ id: 'a/b/old', name: 'old', slug: 'old', source: 'a/b' }] }); await Promise.resolve(); tree = render()
  assert.ok(!text(tree).includes('old'))
  // Seed the installed-list hook; effects are inert in this isolated renderer.
  slots[5] = [{ name: 'demo', description: 'Example skill', path: '/demo', agents: ['通用'] }]
  find(tree, '已安装 (0)').props.onClick(); tree = render()
  // 点「详情」→ 独立详情页（列表让位），详情请求 pending[2]
  find(tree, '详情').props.onClick({ stopPropagation() {} }); tree = render()
  assert.ok(text(tree).includes('← 技能库'), '详情页要有返回列表入口')
  assert.ok(!find(tree, '已安装 (0)'), '详情页不再是列表视图')
  assert.match(pending[2].path, /^\/skills\/detail\?/)
  pending[2].resolve({
    ok: true,
    content: '# demo\n\n见 [state](references/state.md)。',
    files: [
      { path: 'SKILL.md', sizeBytes: 12 },
      { path: 'references/state.md', sizeBytes: 6 },
      { path: 'scripts/run.py', sizeBytes: 24 },
      { path: 'scripts/big.py', sizeBytes: 24 },
      { path: '_meta.json', sizeBytes: 20 },
      { path: 'data.csv', sizeBytes: 30 },
      { path: '.env', sizeBytes: 20 },
      { path: 'logo.png', sizeBytes: 3 },
      { path: 'bin.dat', sizeBytes: 3 },
    ],
    filesTruncated: false, sizeBytes: 12, truncated: false,
    frontmatter: { name: 'demo', description: 'Example skill', metadata: {} }, agents: ['通用'],
  })
  await Promise.resolve(); tree = render()
  // 左侧文件树：SKILL.md + 被引用的支持文件（行内预览看不到的部分）
  const treeItem = label => all(tree).find(n => n.type === 'button' && String(n.props.className || '').indexOf('wb-sk-tree-item') >= 0 && text(n).indexOf(label) >= 0)
  assert.ok(treeItem('SKILL.md'), '文件树缺少 SKILL.md')
  assert.ok(treeItem('state.md'), '文件树缺少 references/state.md')
  assert.ok(text(tree).includes('references/'), '目录分组应显示 references/')
  // SKILL.md 里的技能内相对链接 → 详情页页内打开该子文件
  const link = all(tree).find(n => n.type === 'a' && String(n.props.className || '').indexOf('wb-sk-link-file') >= 0)
  assert.ok(link, '技能内相对链接应被详情页接管')
  link.props.onClick({ preventDefault() {} }); tree = render()
  assert.match(pending[3].path, /^\/skills\/file\?/)
  assert.ok(pending[3].path.includes('file=references%2Fstate.md'), '应读取被引用的子文件: ' + pending[3].path)
  pending[3].resolve({ ok: true, file: 'references/state.md', kind: 'markdown', binary: false, truncated: false, sizeBytes: 6, content: '# state\n' })
  await Promise.resolve(); tree = render()
  assert.ok(text(tree).includes('state'), '子文件正文应渲染在详情页')
  assert.ok(treeItem('state.md'), '子文件仍在文件树里')
  // 支持文件按类型选渲染器：代码 → 宿主高亮 CodeBlock；JSON → 树；
  // CSV → 表格；.env → 键值表；图片 → 内联预览；二进制 → 提示。
  const openAndResolve = async (label, payload) => {
    const before = pending.length
    const item = treeItem(label)
    assert.ok(item, '文件树缺少 ' + label)
    item.props.onClick(); tree = render()
    assert.equal(pending.length, before + 1, label + ' 应发起 /skills/file 请求')
    pending[before].resolve(payload); await Promise.resolve(); tree = render()
  }
  const fileOk = (file, extra) => Object.assign({ ok: true, file: file, kind: 'text', binary: false, truncated: false, sizeBytes: 20, content: '', dataUrl: '' }, extra)

  await openAndResolve('run.py', fileOk('scripts/run.py', { content: 'import os\nprint("hi")\n' }))
  const code = all(tree).find(n => n.type === 'CodeBlock')
  assert.ok(code, '代码文件应交给宿主 CodeBlock 渲染')
  assert.equal(code.props.lang, 'python', '语法名按扩展名给出')
  assert.ok(String(code.props.code).includes('import os'), '正文原样交给高亮器')

  // 超大源码不交给高亮器（shiki 分词大文件会卡面板），改按纯文本并说明
  const max = module.exports.SKILL_CODE_HIGHLIGHT_MAX
  assert.equal(typeof max, 'number')
  await openAndResolve('big.py', fileOk('scripts/big.py', { content: 'y'.repeat(max + 1) }))
  assert.ok(!all(tree).find(n => n.type === 'CodeBlock'), '超大源码不交给高亮器')
  assert.ok(all(tree).some(n => n.type === 'pre'), '超大源码回落纯文本')
  assert.ok(text(tree).includes('文件较大'), '超大源码给纯文本提示')

  // JSON 文件：重排成缩进 JSON 后走高亮（宿主 JSON 树需要宿主自己的 CSS 链，
  // 这里只保证交给正确的渲染器 + 正确的语法名）
  await openAndResolve('_meta.json', fileOk('_meta.json', { content: '{"name":"demo","tags":["a"]}' }))
  const jsonCode = all(tree).find(n => n.type === 'CodeBlock' && n.props.lang === 'json')
  assert.ok(jsonCode, 'JSON 文件应走高亮渲染')
  assert.equal(jsonCode.props.code, '{\n  "name": "demo",\n  "tags": [\n    "a"\n  ]\n}')

  await openAndResolve('data.csv', fileOk('data.csv', { content: 'id,name\n1,alpha\n2,beta\n' }))
  const cells = all(tree).filter(n => n.type === 'th' || n.type === 'td').map(text)
  assert.deepEqual(cells, ['id', 'name', '1', 'alpha', '2', 'beta'], 'CSV 应渲染成表格')

  await openAndResolve('.env', fileOk('.env', { content: '# c\nAPI_KEY=abc\n' }))
  assert.ok(all(tree).some(n => n.type === 'dt' && text(n) === 'API_KEY'), '.env 应渲染成键值表')
  assert.ok(all(tree).some(n => n.type === 'dd' && text(n) === 'abc'))

  await openAndResolve('logo.png', fileOk('logo.png', { kind: 'image', binary: true, dataUrl: 'data:image/png;base64,AAAA' }))
  const img = all(tree).find(n => n.type === 'img')
  assert.ok(img, '图片应按内联预览渲染')
  assert.equal(img.props.src, 'data:image/png;base64,AAAA')
  assert.equal(img.props.alt, 'logo.png')

  await openAndResolve('bin.dat', fileOk('bin.dat', { kind: 'binary', binary: true }))
  assert.ok(!all(tree).find(n => n.type === 'img'), '非图片二进制不渲染成图片')
  assert.ok(text(tree).includes('二进制'), '二进制文件给提示')
  // 返回列表：状态回到已装视图
  find(tree, '← 技能库').props.onClick(); tree = render()
  assert.ok(find(tree, '详情'), '返回后回到已安装列表')
  assert.ok(!text(tree).includes('← 技能库'))
  // Manual install previews available skills and never submits an empty selection.
  slots[3] = { cli: { available: true }, node: { available: true } }
  tree = render()
  find(tree, '发现技能').props.onClick(); tree = render()
  assert.ok(text(tree).includes('发现技能'))
  assert.ok(!all(tree).find(n => n.props.id === 'wb-sk-package'), '仓库表单默认不占用首屏')
  find(tree, '+ 从仓库安装').props.onClick(); tree = render()
  const sourceInput = () => all(tree).find(n => n.props.id === 'wb-sk-package')
  sourceInput().props.onChange({ target: { value: 'https://skills.sh/a/b/new' } }); tree = render()
  const beforePreview = pending.length
  find(tree, '选择技能').props.onClick(); tree = render()
  assert.equal(pending[beforePreview].path, '/skills/discover')
  assert.equal(pending[beforePreview].options.body.package, 'a/b')
  pending[beforePreview].resolve({ ok: true, skills: [{ name: 'demo' }, { name: 'new', description: 'New skill' }, { name: 'other' }] })
  pending[beforePreview + 1].resolve({ ok: true, skills: [{ name: 'demo' }] })
  pending[beforePreview + 2].resolve({ ok: true, skills: [{ name: 'demo', source: 'a/b', status: 'current' }] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  const checkboxes = () => all(tree).filter(n => n.type === 'input' && n.props.type === 'checkbox' && n.props.checked !== undefined)
  const candidates = () => all(tree).filter(n => n.props.className === 'wb-sk-candidate')
  assert.deepEqual(candidates().map(n => text(n)), ['new未安装New skill', 'other未安装'])
  assert.equal(checkboxes()[0].props.checked, true, 'skills.sh link preselects its skill')
  assert.equal(checkboxes()[1].props.checked, false)
  find(tree, '取消全选')?.props.onClick()
  checkboxes()[0].props.onChange(); tree = render()
  const install = () => all(all(tree).find(n => n.props.className === 'wb-sk-install')).find(n => n.type === 'button' && n.props.className === 'glab-btn glab-btn-primary' && text(n) === '安装')
  assert.equal(install().props.disabled, true)
  checkboxes()[1].props.onChange(); tree = render()
  const beforeInstall = pending.length
  install().props.onClick(); tree = render()
  assert.equal(pending[beforeInstall].path, '/skills/install')
  assert.deepEqual(pending[beforeInstall].options.body.skills, ['other'])
  pending[beforeInstall].resolve({ ok: false, error: 'test failure' })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  const repoUrl = 'https://github.com/jimliu/baoyu-design'
  sourceInput().props.onChange({ target: { value: repoUrl } }); tree = render()
  const urlPreview = pending.length
  find(tree, '选择技能').props.onClick(); tree = render()
  assert.equal(pending[urlPreview].options.body.package, repoUrl)
  pending[urlPreview].resolve({ ok: true, skills: [{ name: 'url-skill' }] })
  pending[urlPreview + 1].resolve({ ok: true, skills: [] })
  pending[urlPreview + 2].resolve({ ok: true, skills: [] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  checkboxes()[0].props.onChange(); tree = render()
  const urlInstall = pending.length
  install().props.onClick(); tree = render()
  assert.equal(pending[urlInstall].path, '/skills/install')
  assert.equal(pending[urlInstall].options.body.package, repoUrl)
  assert.deepEqual(pending[urlInstall].options.body.skills, ['url-skill'])
  pending[urlInstall].resolve({ ok: false, error: 'test failure' })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  const scopeSelect = all(tree).find(n => n.type === 'select' && n.props['aria-label'] === '技能作用域')
  scopeSelect.props.onChange({ target: { value: 'project' } }); tree = render()
  assert.equal(candidates().length, 0, 'scope change invalidates preview')
  assert.equal(install().props.disabled, true)
  sourceInput().props.onChange({ target: { value: 'c/d' } }); tree = render()
  const stale = pending.length
  find(tree, '选择技能').props.onClick(); tree = render()
  sourceInput().props.onChange({ target: { value: 'e/f' } }); tree = render()
  pending[stale].resolve({ ok: true, skills: [{ name: 'stale' }] })
  pending[stale + 1].resolve({ ok: true, skills: [] })
  pending[stale + 2].resolve({ ok: true, skills: [] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.equal(candidates().length, 0, 'changed source rejects stale preview')
  find(tree, '已安装 (1)').props.onClick(); tree = render()
  const beforeCheck = pending.length
  find(tree, '检查更新').props.onClick(); tree = render()
  assert.match(pending[beforeCheck].path, /^\/skills\/check\?scope=project/)
  assert.equal(pending.length, beforeCheck + 1, 'check must not call update')
  pending[beforeCheck].resolve({ ok: true, skills: [{ name: 'demo', source: 'a/b', status: 'update' }] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.ok(text(tree).includes('可更新'))
  find(tree, '发现技能').props.onClick(); tree = render()
  const failedPreview = pending.length
  find(tree, '选择技能').props.onClick(); tree = render()
  pending[failedPreview].resolve({ ok: false, error: 'The --json flag cannot be combined with --list.' })
  pending[failedPreview + 1].resolve({ ok: true, skills: [] })
  pending[failedPreview + 2].resolve({ ok: true, skills: [] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.ok(text(tree).includes('cannot be combined'))
  assert.ok(!text(tree).includes('没有可安装或更新的技能'), 'enumeration failure must not appear as an empty source')
  assert.equal(install().props.disabled, true)
  // Search/category compose one request, sort remains local, and install stays on discovery.
  const searchInput = all(tree).find(n => n.props.id === 'wb-sk-search')
  searchInput.props.onChange({ target: { value: 'react' } }); tree = render()
  const beforeSearch = pending.length
  all(tree).find(n => n.props.id === 'wb-sk-search').props.onKeyDown({ key: 'Enter' })
  assert.match(decodeURIComponent(pending[beforeSearch].path), /q=react testing/)
  pending[beforeSearch].resolve({ ok: true, skills: [
    { id: 'a/b/z', source: 'a/b', slug: 'z', name: 'z', installs: 50 },
    { id: 'a/b/a', source: 'a/b', slug: 'a', name: 'a', installs: 2 },
  ] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  const cards = () => all(tree).filter(n => n.type === 'article')
  assert.match(text(cards()[0]), /^z/)
  assert.ok(!all(cards()[0]).some(n => n.props.className === 'wb-sk-description' || n.props.className === 'wb-sk-card-agents'), '缺失描述和 Agent 信息时不渲染占位区域')
  all(tree).find(n => n.props['aria-label'] === '技能排序').props.onChange({ target: { value: 'name' } }); tree = render()
  assert.match(text(cards()[0]), /^a/)
  const beforeCardInstall = pending.length
  all(cards()[0]).find(n => n.type === 'button').props.onClick(); tree = render()
  assert.ok(cards().every(n => all(n).find(x => x.type === 'button').props.disabled))
  pending[beforeCardInstall].resolve({ ok: true, installed: [{ name: 'a' }] })
  await new Promise(resolve => setImmediate(resolve))
  pending[beforeCardInstall + 1].resolve({ ok: true, skills: [] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.ok(text(cards()[0]).includes('已安装'))
  assert.equal(all(tree).find(n => n.props.className === 'wb-sk-tab wb-sk-tab-active').children.map(text).join(''), '发现技能')
  delete globalThis.__skillFetch
})

// 停用/启用：行内二次确认 → POST /skills/disable → 状态徽标/按钮切换。
test('技能交互：停用/启用走 /skills/disable 并更新状态徽标', async () => {
  const slots = []; let cursor = 0
  const pending = []
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback: fn => fn, useEffect() {},
  }
  const result = await build({ entryPoints: ['src/client/components/skills.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const useWsData=()=>null; export const forgeFetch=(...args)=>globalThis.__skillFetch(...args);', loader: 'js' }))
  } }] })
  globalThis.__skillFetch = (path, options) => new Promise(resolve => pending.push({ path, options, resolve }))
  delete globalThis.localStorage
  const module = { exports: {} }
  const primitives = { CodeBlock: 'CodeBlock' }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : primitives, module, module.exports)
  const render = () => { cursor = 0; return module.exports.SkillPanel({}) }
  const all = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(all)]
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || ''
  const find = (tree, label) => all(tree).find(n => n.type === 'button' && text(n) === label)

  const warnChip = () => all(tree).find(n => n && typeof n === 'object' && n.props && n.props.kind === 'warn')
  const rowChips = () => (all(tree).find(n => n && typeof n === 'object' && n.props && n.props.className === 'wb-item-chips')?.children || []).map(text)

  // 与同文件另一个用例相同的 hook 位：slots[3]=status、slots[5]=rows。
  slots[3] = { cli: { available: true }, node: { available: true } }
  slots[5] = [{ name: 'demo', description: 'Example', path: '/demo', agents: ['通用'] }]
  let tree = render()
  assert.ok(find(tree, '停用'), '启用态技能要有停用入口')
  assert.ok(!warnChip(), '启用态没有停用徽标')
  assert.deepEqual(rowChips(), ['已启用', '通用'], '启用态显示状态与 agent 目标徽标')

  // 停用：先弹共享确认框（ConfirmDialog，同卸载），再 POST /skills/disable { disabled: true }。
  // 本用例的 all() 不展开函数组件，弹窗以 props 断言、onOk/onCancel 直调。
  const dialog = () => all(tree).find(n => n.props && n.props.okLabel === '停用')
  find(tree, '停用').props.onClick({ stopPropagation() {} }); tree = render()
  assert.ok(dialog(), '停用前弹共享确认框')
  assert.ok((dialog().props.lines || []).join(' ').includes('不再被模型自动触发'), '确认框说明停用语义')
  assert.ok((dialog().props.lines || []).join(' ').includes('demo'), '确认框点名技能')
  dialog().props.onCancel(); tree = render()
  assert.ok(!dialog(), '取消关闭确认框且不发请求')
  const before = pending.length
  find(tree, '停用').props.onClick({ stopPropagation() {} }); tree = render()
  dialog().props.onOk(); tree = render()
  assert.equal(pending[before].path, '/skills/disable')
  assert.deepEqual(pending[before].options.body, { name: 'demo', scope: 'global', disabled: true, cwd: null })
  pending[before].resolve({ ok: true, disabled: true, invocation: { disableModelInvocation: true, userInvocable: undefined } })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.match(pending[before + 1].path, /^\/skills\/list\?/, '停用后要刷新列表')
  pending[before + 1].resolve({ ok: true, skills: [{ name: 'demo', description: 'Example', path: '/demo', agents: ['通用'], disabled: true }] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.ok(warnChip() && text(warnChip()) === '已停用', '停用后要显示已停用徽标（短文案，不撑高卡片）')
  assert.deepEqual(rowChips(), ['已停用'], '停用后行内只留已停用徽标，agent 目标不再显示')
  assert.ok(find(tree, '启用'), '停用态提供启用入口')
  assert.ok(!find(tree, '停用'), '停用态不再显示停用按钮')

  // 启用：直接执行，不二次确认
  const before2 = pending.length
  find(tree, '启用').props.onClick({ stopPropagation() {} }); tree = render()
  assert.equal(pending[before2].path, '/skills/disable')
  assert.equal(pending[before2].options.body.disabled, false)
  pending[before2].resolve({ ok: true, disabled: false })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  pending[before2 + 1].resolve({ ok: true, skills: [{ name: 'demo', description: 'Example', path: '/demo', agents: ['通用'] }] })
  await new Promise(resolve => setImmediate(resolve)); tree = render()
  assert.ok(!warnChip(), '启用后徽标消失')
  assert.deepEqual(rowChips(), ['已启用', '通用'], '启用后状态与 agent 目标徽标恢复')
  assert.ok(find(tree, '停用'), '启用后恢复停用入口')
  delete globalThis.__skillFetch
})
