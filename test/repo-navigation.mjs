import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

test('仓库后台刷新：数量和当前 MR 列表一起更新', async () => {
  const slots = [], effects = [], requests = []
  let cursor = 0, tick = 0
  const effect = (fn, deps) => {
    const i = cursor++, prev = slots[i]
    if (!prev || deps.some((d, n) => d !== prev.deps[n])) {
      slots[i] = { deps }; effects.push(fn)
    }
  }
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback(fn, deps) { const i = cursor++, prev = slots[i]; if (!prev || deps.some((d, n) => d !== prev.deps[n])) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect: effect, useLayoutEffect: effect,
  }
  const result = await build({ entryPoints: ['src/client/components/forge.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'forge-runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: `
      export const WB_PAGE_EVENT='samanhappy.dsh-workbench:page';
      export const forgeFetch=(path)=>globalThis.__forgeRefreshFetch(path);
      export const useShellTick=()=>globalThis.__forgeRefreshTick();
      export const useWsData=()=>null;
      export const refreshWorkspaces=()=>{};
      export const saveForgeView=()=>{};
      export const loadForgeView=()=>({subNav:'mr'});
      export const getPluginCtx=()=>null;
      export const getSessionsService=()=>null;
      export const useIssueMeta=()=>null;
      export const refreshIssueMeta=()=>{};
    `, loader: 'js' }))
  } }] })
  globalThis.__forgeRefreshTick = () => tick
  globalThis.__forgeRefreshFetch = path => new Promise(resolve => requests.push({ path, resolve }))
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports)
  const render = () => { cursor = 0; const tree = mod.exports.ForgePanel({}); while (effects.length) effects.shift()(); return tree }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
  const flush = () => new Promise(resolve => setImmediate(resolve))
  try {
    render()
    slots[3] = { cwd: '/repo' } // selected workspace
    render()
    requests.find(r => r.path.startsWith('/forge/state')).resolve({ repo: { forge: 'gitlab' }, myOpen: [], allOpen: [], reviewRequests: [] })
    await flush(); render()
    requests.length = 0
    tick++; render()
    assert.equal(requests.filter(r => r.path.startsWith('/forge/state')).length, 1)
    assert.equal(requests.filter(r => r.path.startsWith('/forge/mrs')).length, 0)
    const item = { num: 3353, title: '新 MR', forge: 'gitlab' }
    requests.find(r => r.path.startsWith('/forge/state')).resolve({ repo: { forge: 'gitlab' }, myOpen: [item], allOpen: [item], reviewRequests: [] })
    await flush()
    const other = { num: 3354, title: '待评审 MR', forge: 'gitlab' }
    const snapshot = { repo: { forge: 'gitlab' }, myOpen: [item], allOpen: [item, other], reviewRequests: [other] }
    requests.length = 0
    tick++; render()
    requests.find(r => r.path.startsWith('/forge/state')).resolve(snapshot)
    await flush()
    for (const [label, expected] of [['我的', [3353]], ['待评审', [3354]], ['全部', [3353, 3354]]]) {
      let tree = render()
      const tab = nodes(tree).find(n => n.type === 'button' && n.children[0] === label)
      assert.equal(tab.children[1].children[0], String(expected.length))
      tab.props.onClick()
      tree = render()
      assert.deepEqual(nodes(tree).filter(n => n.props.item).map(n => n.props.item.num), expected)
    }
    assert.equal(requests.filter(r => r.path.startsWith('/forge/mrs')).length, 0)
    requests.length = 0
    tick++; render()
    requests.find(r => r.path.startsWith('/forge/state')).resolve({ ...snapshot, allOpen: [], allOpenError: '列表加载失败' })
    await flush()
    assert.ok(nodes(render()).some(n => n.children.includes('列表加载失败')))
  } finally {
    delete globalThis.__forgeRefreshTick
    delete globalThis.__forgeRefreshFetch
  }
})

test('MR/PR 列表：原始链接直接打开平台页面，缺失 URL 时隐藏', async () => {
  const result = await build({ entryPoints: ['src/client/components/forge.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'item-row', setup(b) {
    b.onLoad({ filter: /components\/forge\.tsx$/ }, args => ({ contents: readFileSync(args.path, 'utf8') + '\nexport { ItemRow };', loader: 'tsx' }))
  } }] })
  const React = { createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props, children: children.flat(Infinity).filter(x => x != null) }) }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(id => id === 'react' ? React : {}, module, module.exports)
  const all = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(all)]
  for (const [forge, web_url] of [['gitlab', 'https://gitlab.example.com/group/repo/-/merge_requests/42'], ['github', 'https://github.com/owner/repo/pull/42']]) {
    for (const state of ['opened', 'merged', 'closed']) {
      let opened = 0
      const props = { item: { forge, num: 42, state, web_url }, busy: true, onOpen() { opened++ } }
      const tree = module.exports.ItemRow(props)
      const link = all(tree).find(n => n.type === 'a')
      assert.equal(link.props.href, web_url)
      assert.equal(link.props.target, '_blank')
      assert.equal(link.props.rel, 'noopener noreferrer')
      assert.equal(link.children[0].type, 'svg')
      assert.equal(link.props['aria-label'], '在网页打开 ' + (forge === 'gitlab' ? '!' : '#') + '42')
      const header = tree.children[0]
      assert.equal(header.type, 'div')
      assert.equal(header.children[0].type, 'button')
      assert.equal(header.children[1], link)
      assert.equal(all(header.children[0]).some(n => n.type === 'a'), false)
      assert.equal(link.props.disabled, undefined)
      all(tree).find(n => n.type === 'button').props.onClick()
      assert.equal(opened, 1)
      assert.equal(all(module.exports.ItemRow({ ...props, item: { ...props.item, web_url: '' } })).some(n => n.type === 'a'), false)
    }
  }
})

test('仓库面包屑：GitHub / GitLab 的 Issue 与 PR/MR 都回到仓库主页', async () => {
  const result = await build({ entryPoints: ['src/client/format.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} }
  new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports)
  const { repoHomeUrl } = module.exports
  for (const path of ['issues/1283', 'pull/1284']) {
    assert.equal(repoHomeUrl('https://github.com/samanhappy/mcphub/' + path + '#comments'), 'https://github.com/samanhappy/mcphub')
  }
  for (const path of ['issues/42', 'merge_requests/42']) {
    assert.equal(repoHomeUrl('https://gitlab.example.com/group/subgroup/repo/-/' + path + '?view=1'), 'https://gitlab.example.com/group/subgroup/repo')
  }
  assert.equal(repoHomeUrl('https://github.com/samanhappy/mcphub'), 'https://github.com/samanhappy/mcphub')
  assert.equal(repoHomeUrl(undefined), '')
})

test('仓库选择列表锚定仓库栏，悬浮且独立滚动', () => {
  const source = readFileSync('src/client/components/forge.tsx', 'utf8')
  const css = readFileSync('src/client/styles/picker.css', 'utf8')
  const bar = source.slice(source.indexOf('function renderRepoBar()'), source.indexOf('function renderSubNav()'))
  assert.match(bar, /renderRepoPicker\(\)/)
  assert.equal((source.match(/renderRepoPicker\(\),/g) || []).length, 1)
  assert.match(css, /\.wb-repo-bar\{[^}]*position:relative/)
  assert.match(css, /\.wb-repo-bar \.wb-picker\{[^}]*position:absolute;top:100%/)
  assert.match(css, /\.wb-repo-bar \.wb-picker\{[^}]*max-height:[^}]*overflow:auto/)
})
