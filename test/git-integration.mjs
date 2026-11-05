import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { loadClientModule } from './load-client.mjs'

test('workbench composes Git Fetch routes without registering a second plugin', () => {
  const gitRoutes = []
  const webRoutes = []
  apply({
    connection: { fetch: { register: route => gitRoutes.push(route) } },
    webServer: { register: route => webRoutes.push(route) },
    effect(fn) { fn() },
    get() { return undefined },
  }, { selfUpdateIntervalMs: 0, skillsAutoUpdateIntervalMs: 0 })
  assert.equal(gitRoutes.length, 22)
  assert.ok(gitRoutes.every(route => route.path.startsWith('/api/workbench/git/')))
  assert.deepEqual(gitRoutes.find(route => route.path.endsWith('/push')).methods, ['POST'])
  assert.ok(webRoutes.some(route => route.path === '/forge/state'))
})

test('Git participates in workbench navigation and feature preferences', () => {
  const store = {}
  const client = loadClientModule({ getItem: key => store[key] ?? null, setItem: (key, value) => { store[key] = value } })
  assert.equal(client.shortcutFlags().git, false)
  client.setConfigToggle('shortcut.git', true)
  assert.equal(client.shortcutFlags().git, false)
  assert.ok(client.isWbPage('git'))
  assert.ok(client.isPageEnabled('git', client.featureFlags()))
  client.setConfigToggle('feature.git', false)
  assert.equal(client.isPageEnabled('git', client.featureFlags()), false)
  client.setConfigToggle('feature.git', true)
  client.setConfigToggle('feature.forge', false)
  assert.equal(client.isPageEnabled('forge', client.featureFlags()), true)
  assert.equal(client.fallbackPage(client.featureFlags()), 'forge')
  client.requestWorkbenchPage('git')
  assert.equal(store['samanhappy.dsh-workbench.page'], 'forge')
  const view = JSON.parse(store['samanhappy.dsh-workbench.forge-view'])
  assert.equal(view.subNav, 'git')
})

test('repository subpages share cwd and allow local Git without a forge', async () => {
  const { build } = await import('esbuild')
  const slots = [], effects = []
  let cursor = 0
  const flags = { git: true, forge: true }
  const data = { workspaces: [{ path: '/a', title: 'A', forge: 'github', repoPath: 'team/a' }] }
  const effect = (fn, deps) => {
    const i = cursor++, old = slots[i]
    if (!old || deps.some((v, n) => v !== old.deps[n])) { slots[i] = { deps }; effects.push(fn) }
  }
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => v !== old.deps[n])) slots[i] = { fn, deps }; return slots[i].fn },
    useEffect: effect, useLayoutEffect: effect,
  }
  globalThis.__nestedGitFlags = flags
  globalThis.__nestedGitData = data
  globalThis.__nestedGitView = { cwd: '/a', subNav: 'git', scope: 'mine' }
  const savedDocument = globalThis.document
  globalThis.document = { addEventListener() {}, removeEventListener() {} }
  const savedFetch = globalThis.fetch
  globalThis.fetch = async () => ({ json: async () => ({ ok: true, workspaces: [{ path: '/local', title: 'Local' }] }) })
  try {
    const result = await build({ entryPoints: ['src/client/components/forge.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'nested-git', setup(b) {
      b.onLoad({ filter: /src\/client\/features\.ts$/ }, () => ({ contents: 'export const useFeatureFlags=()=>globalThis.__nestedGitFlags', loader: 'js' }))
      b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: `
        export const WB_PAGE_EVENT='samanhappy.dsh-workbench:page';
        export const forgeFetch=async()=>({ok:true,repo:{forge:'github'},myOpen:[],allOpen:[],reviewRequests:[]});
        export const useShellTick=()=>0;
        export const useWsData=()=>globalThis.__nestedGitData;
        export const refreshWorkspaces=()=>{};
        export const saveForgeView=v=>{globalThis.__nestedGitView=v};
        export const loadForgeView=()=>globalThis.__nestedGitView;
        export const getPluginCtx=()=>null;
        export const getSessionsService=()=>null;
        export const useIssueMeta=()=>null;
        export const refreshIssueMeta=()=>{};
      `, loader: 'js' }))
    } }] })
    const mod = { exports: {} }
    Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports)
    const render = () => { cursor = 0; const tree = mod.exports.ForgePanel({ active: true }); while (effects.length) effects.shift()(); return tree }
    const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
    const find = (tree, label) => nodes(tree).find(n => n.type === 'button' && n.children.includes(label))
    const git = tree => nodes(tree).find(n => n.type?.name === 'GitPanel')
    let tree = render()
    await new Promise(resolve => setImmediate(resolve)); tree = render()
    assert.equal(git(tree).props.cwd, '/a')
    assert.equal(git(tree).props.active, true)
    find(tree, 'MR / PR').props.onClick(); tree = render()
    assert.equal(git(tree).props.cwd, '/a')
    assert.equal(git(tree).props.active, false)
    find(tree, 'Issues').props.onClick(); tree = render()
    assert.equal(nodes(tree).find(n => n.props.activeCwd).props.activeCwd, '/a')
    nodes(tree).find(n => n.props.title === '切换工作区').props.onClick(); tree = render()
    nodes(tree).find(n => n.props.className === 'wb-picker-item' && nodes(n).some(c => c.children.includes('Local'))).props.onClick()
    tree = render()
    assert.equal(git(tree).props.cwd, '/local')
    assert.ok(nodes(tree).some(n => n.props.title === '该工作区尚未关联可用的 GitLab / GitHub 仓库'))
    find(tree, 'Git').props.onClick(); tree = render()
    assert.equal(git(tree).props.active, true)
    flags.forge = false; tree = render()
    assert.equal(find(tree, 'MR / PR'), undefined)
    assert.equal(git(tree).props.cwd, '/local')
    flags.forge = true; flags.git = false; tree = render()
    assert.equal(git(tree), undefined)
    assert.equal(find(tree, 'Git'), undefined)
  } finally {
    globalThis.document = savedDocument
    globalThis.fetch = savedFetch
    delete globalThis.__nestedGitFlags
    delete globalThis.__nestedGitData
    delete globalThis.__nestedGitView
  }
})

test('conversation Git action opens the owning workspace and respects the Git flag', async () => {
  const { build } = await import('esbuild')
  let open = false, enabled = true
  const React = {
    Fragment: 'fragment',
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState: () => [open, value => { open = value }],
    useRef: () => ({ current: null }),
  }
  globalThis.__gitActionEnabled = () => enabled
  try {
    const result = await build({ entryPoints: ['src/client/components/git.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], plugins: [{ name: 'git-action', setup(b) {
      b.onLoad({ filter: /src\/client\/features\.ts$/ }, () => ({ contents: 'export const useFeatureFlags=()=>({git:globalThis.__gitActionEnabled()})', loader: 'js' }))
    } }] })
    const mod = { exports: {} }
    Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports)
    const props = { sessionId: 's2', useWorkspaces: select => select({ items: [
      { path: '/other', sessionIds: ['s1'] }, { path: '/own', sessionIds: ['s2'] },
    ] }) }
    const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
    let tree = mod.exports.GitCommitButton(props)
    assert.equal(nodes(tree).find(n => n.type === 'button').props['aria-label'], 'Git')
    assert.equal(nodes(tree).find(n => n.type === 'svg').props.viewBox, '0 0 78 78')
    assert.equal(nodes(tree).find(n => n.type === 'path').props.fill, 'currentColor')
    nodes(tree).find(n => n.type === 'button').props.onClick()
    tree = mod.exports.GitCommitButton(props)
    const workspace = nodes(tree).find(n => n.type?.name === 'Workspace')
    assert.equal(workspace.props.cwd, '/own')
    assert.equal(workspace.props.autoGenerate, undefined)
    assert.equal(workspace.props.active, true)
    nodes(tree).find(n => n.type === 'button' && n.children.includes('关闭')).props.onClick()
    assert.equal(open, false)
    assert.equal(mod.exports.GitCommitButton({ ...props, sessionId: 'missing' }), null)
    enabled = false
    assert.equal(mod.exports.GitCommitButton(props), null)
  } finally { delete globalThis.__gitActionEnabled }
})

test('file filtering, directory folding and batch staging keep conflicts out of staging', async () => {
  const { build } = await import('esbuild')
  let state = ['', 'all', {}], cursor = 0
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState: () => { const index = cursor++; return [state[index], value => { state[index] = value }] },
  }
  const result = await build({ entryPoints: ['src/client/git/components/ChangeList.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(() => React, mod, mod.exports)
  const entry = path => ({ path, x: '.', y: 'M', kind: 'changed', staged: false, unstaged: true, conflicted: false })
  const a = entry('src/a.ts'), b = entry('docs/b.md'), conflict = { ...entry('src/conflict.ts'), conflicted: true }
  const batches = []
  const props = { status: { entries: [a, b, conflict] }, statusError: '', rows: { staged: [], unstaged: [a, b], conflicted: [conflict] }, selectedKey: '', stats: {}, t: x => x, onBatch: (...args) => batches.push(args) }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
  const render = () => { cursor = 0; return nodes(mod.exports.ChangeList(props)) }
  let tree = render()
  tree.find(n => n.type === 'input').props.onChange({ target: { value: 'src/' } })
  tree = render()
  tree.find(n => n.type === 'button' && n.props['aria-label'] === '暂存全部可见文件').props.onClick()
  assert.deepEqual(batches, [[['src/a.ts'], 'unstaged']])
  assert.equal(tree.filter(n => n.type?.name === 'FileRow').length, 2)
  tree.find(n => n.props.className === 'wb-git-directory-head').props.onClick()
  tree = render()
  assert.equal(tree.filter(n => n.type?.name === 'FileRow').length, 1)
  tree.find(n => n.props.role === 'tab' && n.children.includes('已暂存 0')).props.onClick()
  assert.equal(render().filter(n => n.type?.name === 'FileRow').length, 0)
})

test('commit and commit-and-push are separate actions; remote and commit prerequisites disable them', async () => {
  const { build } = await import('esbuild')
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }),
    useState: initial => [initial, () => {}], useRef: () => ({ current: null }), useCallback: fn => fn, useEffect: () => {},
  }
  const result = await build({ entryPoints: ['src/client/git/components/CommitBox.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(() => React, mod, mod.exports)
  const calls = []
  const props = { status: { counts: { staged: 1, unstaged: 0, conflicted: 0 } }, message: 'fix: layout', busy: false, hint: '', t: x => x, canPush: true, collapsed: false, onCommit: push => calls.push(push), ai: { groups: [], failures: [], active: null } }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(nodes)]
  const buttons = overrides => nodes(mod.exports.CommitBox({ ...props, ...overrides })).filter(n => n.type === 'button' && n.props.className === 'glab-btn glab-btn-primary')
  const [commit, push] = buttons({})
  assert.equal(commit.props.disabled, false)
  assert.equal(push.props.disabled, false)
  commit.props.onClick(); push.props.onClick()
  assert.deepEqual(calls, [false, true])
  assert.equal(buttons({ canPush: false })[0].props.disabled, false)
  assert.equal(buttons({ canPush: false })[1].props.disabled, true)
  for (const overrides of [{ message: '' }, { busy: true }, { status: { counts: { staged: 0, conflicted: 0 } } }, { status: { counts: { staged: 1, conflicted: 1 } } }]) {
    assert.ok(buttons(overrides).every(n => n.props.disabled))
  }
  assert.equal(nodes(mod.exports.CommitBox(props)).some(n => n.props.className === 'wb-git-commit-check'), false)
  const pending = { ...props, status: { counts: { staged: 0, unstaged: 2, conflicted: 0 } }, ai: { ...props.ai, active: { model: 'test' } } }
  const pendingNodes = nodes(mod.exports.CommitBox(pending))
  assert.equal(pendingNodes.find(n => n.props.className === 'glab-btn glab-btn-primary wb-git-ai-generate').props.disabled, false)
  assert.ok(buttons(pending).every(n => !n.props.disabled))
  assert.ok(pendingNodes.some(n => n.children.includes('将提交全部 2 个变更文件')))
  assert.equal(nodes(mod.exports.CommitBox({ ...pending, status: props.status })).find(n => n.props.className === 'glab-btn glab-btn-primary wb-git-ai-generate').props.disabled, false)
  const folded = nodes(mod.exports.CommitBox({ ...props, collapsed: true }))
  assert.ok(folded.some(n => n.children.includes('提交本次更改')))
  assert.ok(folded.some(n => n.children.includes('将提交 1 个已暂存文件')))
  assert.ok(!folded.some(n => n.props.className === 'wb-git-commit-author'))
  assert.ok(folded.some(n => n.props.className === 'wb-git-commit-body' && n.props['aria-hidden'] === 'true'))
  const quickCalls = []
  const quickButtons = overrides => nodes(mod.exports.CommitBox({ ...pending, message: '', collapsed: true, onQuickCommit: push => quickCalls.push(push), ...overrides })).filter(n => n.props.className === 'glab-btn glab-btn-primary wb-git-quick-commit')
  const quick = quickButtons({})
  assert.equal(quick.length, 2)
  assert.ok(quick.every(n => !n.props.disabled))
  quick.forEach(n => n.props.onClick({ stopPropagation() {} }))
  assert.deepEqual(quickCalls, [false, true])
  assert.equal(quickButtons({ canPush: false })[1].props.disabled, true)
  for (const overrides of [{ busy: true }, { ai: { ...pending.ai, active: null } }, { status: { counts: { unstaged: 1, conflicted: 1 } } }]) assert.ok(quickButtons(overrides).every(n => n.props.disabled))

  // A repository with no git identity cannot commit: say so instead of letting
  // the click stage everything and fail at git commit.
  const noIdentity = { counts: { staged: 1, unstaged: 0, conflicted: 0 }, identity: null }
  assert.ok(buttons({ status: noIdentity }).every(n => n.props.disabled))
  const identityQuick = nodes(mod.exports.CommitBox({ ...pending, status: { counts: { staged: 0, unstaged: 2, conflicted: 0 }, identity: null }, message: '', collapsed: true }))
    .filter(n => n.props.className === 'glab-btn glab-btn-primary wb-git-quick-commit')
  assert.equal(identityQuick.length, 2)
  assert.ok(identityQuick.every(n => n.props.disabled))
  assert.ok(nodes(mod.exports.CommitBox({ ...props, status: noIdentity, collapsed: true })).some(n => n.children.includes('identityMissing')))
  assert.equal(nodes(mod.exports.CommitBox({ ...props, status: noIdentity, collapsed: false })).find(n => n.props.className === 'glab-btn glab-btn-primary').props.disabled, true)
})

test('Git diff exclusively uses DSH DiffBlock and reports unsupported hosts', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/client/git/components/DiffView.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const React = { createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }), useState: x => [x, () => {}], useRef: () => ({ current: null }), useEffect() {} }
  let wrapEffect
  React.useEffect = effect => { wrapEffect = effect }
  const native = () => null
  const load = primitive => { const mod = { exports: {} }; Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : primitive, mod, mod.exports); return mod.exports }
  const file = { oldPath: 'a.json', newPath: 'a.json', hunks: [{ header: '@@ -5,2 +5,2 @@', lines: [{ kind: 'context', text: '{' }, { kind: 'del', text: '旧内容' }, { kind: 'add', text: '新内容' }, { kind: 'meta', text: 'no newline' }] }] }
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]
  const block = load({ DiffBlock: native }).DiffFileBlock({ file, native: true, t: x => x })
  assert.deepEqual(nodes(block).find(n => n.type === native).props.diffs, [{ path: 'a.json', oldText: '{\n旧内容', newText: '{\n新内容' }])
  let wraps = 0
  block.props.ref.current = { querySelectorAll(selector) {
    assert.equal(selector, '[data-diff] button[aria-label="自动换行"][aria-pressed="false"]')
    return [{ click() { wraps++ } }]
  } }
  wrapEffect()
  assert.equal(wraps, 1)
  const fallback = load({}).DiffFileBlock({ file, native: true, t: x => x })
  assert.equal(nodes(fallback).filter(n => typeof n.type === 'function').length, 0)
  assert.ok(nodes(fallback).some(n => n.props.role === 'status'))
  assert.ok(!nodes(load({ DiffBlock: native }).DiffView({ selected: null, t: x => x })).some(n => n.type === 'select'))
})

test('compact branch selector uses existing checkout action and blocks while busy', async () => {
  const { build } = await import('esbuild')
  const React = { createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null) }) }
  const result = await build({ entryPoints: ['src/client/git/components/TopBar.tsx'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', '@deepseek-ai/dsh-client-ui-primitives'] })
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? React : {}, mod, mod.exports)
  const nodes = n => !n || typeof n !== 'object' ? [] : [n, ...(n.children || []).flatMap(nodes)]
  const calls = []
  const props = { status: { branch: 'main', counts: {} }, refs: { branches: [{ name: 'main' }, { name: 'feature' }] }, t: x => x, onCheckout: name => calls.push(name), onCommitFocus: () => calls.push('focus-commit') }
  const tree = mod.exports.TopBar(props)
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.role, 'toolbar')
  const pullButton = nodes(mod.exports.TopBar({ ...props, canPull: true, onPull: () => calls.push('pull') })).find(n => n.props['aria-label'] === 'pull')
  assert.equal(pullButton.props.disabled, undefined)
  pullButton.props.onClick()
  assert.equal(calls.pop(), 'pull')
  const actions = nodes(tree).filter(n => n.type === 'button')
  assert.equal(actions[0].props['aria-label'], 'pull')
  assert.equal(actions[1].props['aria-label'], 'push main')
  const remotePush = nodes(mod.exports.TopBar({ ...props, canPush: true, onPushRemotes: () => calls.push('push-remotes') })).find(n => n.props['aria-label'] === 'pushRemotes')
  assert.ok(!remotePush.props.disabled)
  remotePush.props.onClick()
  assert.equal(calls.pop(), 'push-remotes')
  assert.equal(actions[2].props['aria-label'], 'pushRemotes')
  assert.equal(actions[2].props.disabled, true)

  assert.equal(actions[0].props.disabled, true)
  assert.equal(nodes(mod.exports.TopBar({ ...props, canPull: true, busy: true })).find(n => n.props['aria-label'] === 'pull').props.disabled, true)

  const selector = nodes(tree).find(n => n.type === 'select')
  assert.equal(selector.props.value, 'main')
  selector.props.onChange({ target: { value: 'feature' } })
  assert.deepEqual(calls, ['feature'])
  const commitEntry = nodes(tree).find(n => n.type === 'button' && n.props['aria-label'] === 'commit')
  assert.ok(!commitEntry.props.disabled)
  commitEntry.props.onClick()
  assert.equal(calls.at(-1), 'focus-commit')
  assert.equal(nodes(mod.exports.TopBar({ ...props, busy: true })).find(n => n.type === 'select').props.disabled, true)
})


test('AI and smart commit share scope, preserving partial staging and excluding ignored/conflicted files', async () => {
  const { build } = await import('esbuild')
  const result = await build({ entryPoints: ['src/client/git/model.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
  const mod = { exports: {} }
  Function('module', 'exports', result.outputFiles[0].text)(mod, mod.exports)
  const { commitScope } = mod.exports
  const pending = { path: 'new.txt', unstaged: true, kind: 'untracked' }
  const partial = { path: 'partial.txt', staged: true, unstaged: true, kind: 'modified' }
  const excluded = [{ path: 'ignored', kind: 'ignored', unstaged: true }, { path: 'conflict', conflicted: true, unstaged: true }]
  assert.deepEqual(commitScope([pending, ...excluded]), { side: 'unstaged', entries: [pending] })
  assert.deepEqual(commitScope([pending, partial, ...excluded]), { side: 'staged', entries: [partial] })
  assert.deepEqual(commitScope([]), { side: 'unstaged', entries: [] })
})


test('quick commit generates before staging and committing; AI failure stops mutations', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/client/git/components/Workspace.tsx', import.meta.url), 'utf8')
  const { transform } = await import('esbuild')
  const start = source.indexOf('    const scope = commitScope', source.indexOf('const commit = React.useCallback'))
  const end = source.indexOf('\n  }, [afterPush', start)
  const body = (await transform('async function execute(pushAfter, generate) {' + source.slice(start, end) + '}', { loader: 'ts' })).code
  const calls = []
  let fail = false
  const scope = { side: 'unstaged', entries: [{ path: 'new.ts' }] }
  const env = {
    commitScope: () => scope, status: { counts: {}, remotes: [{}] }, busyRef: { current: false }, aiBusy: false, message: '',
    setBusy() {}, setActionError: x => { if (x) calls.push('error') },
    statusLetter: () => '?', props: { locale: () => 'zh' }, resolveConfigText: () => 'custom prompt', repoPath: '/repo',
    generateCommitMessage: async input => { calls.push('ai'); assert.equal(input.prompt, 'custom prompt'); if (fail) throw Error('AI failed'); return { ok: true, message: 'feat: generated' } },
    setMessage() {}, stagePaths: async () => { calls.push('stage'); return { ok: true } },
    commitChanges: async text => { assert.equal(text, 'feat: generated'); calls.push('commit'); return { ok: true } },
    setSelected() {}, setDiff() {}, pushBranch: async () => { calls.push('push'); return { ok: true } },
    setCommitFold: folded => { calls.push(folded ? 'fold' : 'unfold') },
    showToast: text => { calls.push('toast:' + text) }, afterPush: async () => {}, t: x => x,
  }
  const run = new Function(...Object.keys(env), body + '; return execute')(...Object.values(env))
  await run(true, true)
  assert.deepEqual(calls, ['ai', 'stage', 'commit', 'push', 'toast:commitDone · pushed'])
  calls.length = 0; fail = true
  await run(false, true)
  // A rejected commit must unfold the card and toast its reason, not just set a hint inside the fold.
  assert.deepEqual(calls, ['ai', 'error', 'unfold', 'toast:AI failed'])
  assert.equal(env.busyRef.current, false)
})

test('commit details wrap long titles and scroll metadata without shrinking its contents', async () => {
  const { readFileSync } = await import('node:fs')
  const css = readFileSync(new URL('../src/client/git/styles.ts', import.meta.url), 'utf8')
  const rule = selector => css.slice(css.indexOf(selector + '{') + selector.length + 1).split('}')[0]
  assert.match(rule('.wb-git-detail-meta'), /overflow:auto/)
  assert.match(rule('.wb-git-detail-meta>*'), /flex-shrink:0/)
  assert.match(rule('.wb-git-detail-meta>*'), /overflow-wrap:anywhere/)
  assert.match(rule('.wb-git-detail-subject'), /white-space:normal/)
  assert.doesNotMatch(rule('.wb-git-detail-subject'), /overflow:hidden|text-overflow:ellipsis/)
  assert.doesNotMatch(rule('.wb-git-detail-body'), /max-height|overflow:auto/)
})

test('all-remotes push runs directly, continues after failures and blocks duplicate submissions', async () => {
  const { readFileSync } = await import('node:fs')
  const { transform } = await import('esbuild')
  const source = readFileSync(new URL('../src/client/git/components/Workspace.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('  const pushRemotes = React.useCallback(async () => {') + '  const pushRemotes = React.useCallback(async () => {'.length
  const end = source.indexOf('\n  }, [afterPush, repoPath, status, t])', start)
  const body = (await transform('async function execute() {' + source.slice(start, end) + '}', { loader: 'ts' })).code
  const calls = [], notices = [], busy = []
  let release, completed = 0
  const env = {
    status: { branch: 'main', remotes: ['origin', 'github', 'backup'] }, busyRef: { current: false }, repoPath: '/repo',
    setBusy: value => busy.push(value), setActionError() {}, setNotice: text => notices.push(text), t: key => key,
    pushBranch: async (cwd, remote) => {
      assert.equal(cwd, '/repo')
      calls.push(remote)
      if (remote === 'origin') { await new Promise(resolve => { release = resolve }); throw Error('network failed') }
      return remote === 'backup' ? { ok: false, error: 'rejected' } : { ok: true }
    },
    afterPush: async () => { completed++ },
  }
  const run = new Function(...Object.keys(env), body + '; return execute')(...Object.values(env))
  const pending = run()
  await run()
  assert.deepEqual(calls, ['origin'])
  release()
  await pending
  assert.deepEqual(calls, ['origin', 'github', 'backup'])
  assert.deepEqual(busy, [true, false])
  assert.equal(completed, 1)
  assert.match(notices.at(-1), /origin\/main：network failed；github\/main：pushed；backup\/main：rejected/)
  assert.equal(env.busyRef.current, false)
  env.status.branch = '(detached)'
  await run()
  env.status.branch = 'main'; env.status.remotes = []
  await run()
  assert.equal(calls.length, 3)
  assert.match(source, /onPushRemotes: \(\) => void pushRemotes\(\)/)
  assert.doesNotMatch(source, /PushRemotesDialog|kind: 'push-remotes'/)
})
