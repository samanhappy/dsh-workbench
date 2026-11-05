import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('自动评审 UI：仓库页概览+两栏、继承含义、紧凑记录与会话/重试入口', async () => {
  const slots = [], effects = [], requests = [], opened = []
  let cursor = 0, cwd = '/a', compact = false, num
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter((x) => x != null) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(init) { const i = cursor++; return slots[i] ||= { current: init } },
    useCallback(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, n) => d !== prev.deps[n])) slots[i] = { fn, deps }; return slots[i].fn },
    useLayoutEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, n) => d !== prev.deps[n])) { slots[i] = { deps }; effects.push(fn) } },
  }
  const result = await build({ entryPoints: ['src/client/components/auto-review.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs', plugins: [{ name: 'runtime', setup(b) {
    b.onLoad({ filter: /src\/client\/runtime\.ts$/ }, () => ({ contents: 'export const useShellTick=()=>0; export const forgeFetch=(...args)=>globalThis.__reviewFetch(...args); export const getPluginCtx=()=>globalThis.__reviewCtx;', loader: 'js' }))
  } }] })
  globalThis.__reviewFetch = (path, opts) => new Promise((resolve) => requests.push({ path, opts, resolve }))
  globalThis.__reviewCtx = { get: (name) => name === 'uiWorkspace' ? { openSession: (id) => opened.push(id) } : null }
  const mod = { exports: {} }
  Function('require', 'module', 'exports', result.outputFiles[0].text)((name) => name === 'react' ? React : {}, mod, mod.exports)
  const render = () => { cursor = 0; const tree = mod.exports.AutoReviewPanel({ cwd, compact, num }); while (effects.length) effects.shift()(); return tree }
  const all = (n) => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(all)]
  const text = (n) => typeof n === 'string' ? n : n?.children?.map(text).join('') || ''
  const button = (tree, label) => all(tree).find((n) => n.type === 'button' && text(n) === label)
  const isRow = (n) => typeof n.props.className === 'string' && n.props.className.split(' ').includes('wb-review-row')
  const snap = (path) => ({ ok: true, supported: true, defaults: { trigger: 'push', model: '' }, repo: { cwd: path, enabled: false, trigger: 'inherit', forge: 'gitlab' }, tasks: [] })
  const task = (over) => ({ id: over.id, num: over.num, head: over.head || 'abcdef123456', title: over.title ?? '评审 !' + over.num + ' 变更标题', sessionId: over.sessionId ?? 'session-' + over.id, status: over.status, createdAt: over.createdAt ?? Date.now(), finishedAt: over.finishedAt, error: over.error })
  try {
    // ── 防串仓：/a 的迟到响应不覆盖 /b ──
    render()
    cwd = '/b'; render()
    for (const r of requests.filter((r) => r.path.includes('cwd=%2Fb'))) r.resolve(snap('/b'))
    await Promise.resolve(); render()
    for (const r of requests.filter((r) => r.path.includes('cwd=%2Fa'))) r.resolve(snap('/a'))
    await Promise.resolve()
    let tree = render()
    // ── 仓库页：概览 + 两栏布局（非 details 折叠块） ──
    assert.equal(tree.type, 'div')
    assert.match(tree.props.className, /wb-auto-review/)
    assert.match(tree.props.className, /wb-review-page/)
    // 概览横贯页首：标题/副标题居左，统计靠右（右上），两栏卡片其下
    const overview = all(tree).find((n) => n.props.className === 'wb-review-overview')
    assert.match(text(overview), /自动评审/)
    const cols = all(tree).find((n) => n.props.className === 'wb-review-cols')
    assert.equal(cols.children[0].props.className, 'wb-review-card')
    assert.equal(cols.children[1].props.className, 'wb-review-card')
    // 空记录：统计隐藏、右卡空态
    assert.equal(all(tree).find((n) => n.props.className === 'wb-review-stats'), undefined)
    assert.match(text(tree), /暂无评审记录/)
    // 概览行：标题 + 启用状态 chip + 一句副标题
    const titleRow = all(tree).find((n) => n.props.className === 'wb-review-title-row')
    assert.match(text(titleRow), /自动评审/)
    assert.match(text(titleRow), /未启用/)
    // 副标题说明行已按要求移除
    assert.doesNotMatch(text(tree), /自动发现并评审新的 MR \/ PR/)
    // ── 「跟随默认」选项显示实际含义（默认 trigger=push / scope 缺省 review / publish 缺省发布） ──
    const select = all(tree).find((n) => n.props['aria-label'] === '仓库自动评审触发时机')
    assert.equal(select.props.value, 'inherit')
    assert.match(text(select), /跟随默认（首次进入待评审及每次新提交）/)
    const scopeSel = all(tree).find((n) => n.props['aria-label'] === '仓库自动评审范围')
    assert.match(text(scopeSel), /跟随默认（指派给我为 reviewer）/)
    const pubSel = all(tree).find((n) => n.props['aria-label'] === '仓库自动评审发布评论')
    assert.match(text(pubSel), /跟随默认（自动发表评论）/)
    // ── 启用开关：载荷与旧版一致 ──
    const enable = all(tree).find((n) => n.props.role === 'switch' && n.props['aria-label'] === '启用自动评审')
    assert.equal(enable.props['aria-checked'], false)
    enable.props.onClick()
    const write = requests.at(-1)
    assert.equal(write.opts.method, 'POST')
    assert.deepEqual(write.opts.body, { cwd: '/b', enabled: true, trigger: 'inherit', scope: 'inherit', publish: 'inherit' })
    // ── 有记录：概览统计取自真实任务（累计 4 · 已完成 2 · 已过期 1 · 已失败 1） ──
    const fresh = { ...snap('/b'), repo: { cwd: '/b', enabled: true, trigger: 'inherit', forge: 'gitlab' }, tasks: [
      task({ id: 't3', num: '3', head: 'dc5321920000', title: '评审 !3 fix(sidebar): stop counting sessions', status: 'completed', createdAt: new Date('2026-10-19T12:04:00').getTime(), finishedAt: new Date('2026-10-19T12:06:00').getTime() }),
      task({ id: 't2', num: '2', head: '89951bec0000', title: '评审 !2 fix(sidebar): stop counting sessions', status: 'stale', createdAt: new Date('2026-10-19T11:29:00').getTime() }),
      task({ id: 't1', num: '1', head: '4535c4ef0000', title: '评审 !1 feat(home): redesign session status', status: 'completed', createdAt: new Date('2026-10-16T09:58:00').getTime() }),
      task({ id: 'f4', num: '4', title: '评审 !4 add dark mode', status: 'failed', error: '会话已结束，但没有生成评审报告' }),
    ] }
    write.resolve(fresh)
    await Promise.resolve(); tree = render()
    assert.equal(all(tree).find((n) => n.props['aria-label'] === '启用自动评审').props['aria-checked'], true)
    assert.match(text(all(tree).find((n) => n.props.className === 'wb-review-title-row')), /已启用/)
    const stats = all(tree).find((n) => n.props.className === 'wb-review-stats')
    assert.ok(stats, '有记录时应挂载统计')
    const statValues = all(stats).filter((n) => n.props.className === 'wb-review-stat-value').map((n) => text(n))
    assert.deepEqual(statValues, ['4', '2', '1', '1'])
    assert.match(text(stats), /累计评审/)
    assert.match(text(stats), /已完成/)
    assert.match(text(stats), /已过期/)
    assert.match(text(stats), /已失败/)
    // ── 紧凑记录行：!num + 标题 + 状态 chip + 打开会话 + 时间 · head ──
    const rows = all(tree).filter(isRow)
    assert.equal(rows.length, 4)
    assert.match(text(rows[0]), /!3/)
    assert.match(text(rows[0]), /fix\(sidebar\): stop counting sessions/)
    assert.match(text(rows[0]), /已完成/)
    assert.match(text(rows[0]), /10\/19 12:06 · dc532192/)
    // 整行可点跳转 DSH 会话：行即 button 语义（无外部链接图标按钮）
    assert.equal(rows[0].props.role, 'button')
    assert.equal(rows[0].props['aria-label'], '查看评审结果')
    assert.equal(all(rows[0]).find((n) => n.type === 'button' && n.props['aria-label'] === '查看评审结果'), undefined, '不再渲染外部链接图标按钮')
    rows[0].props.onClick()
    assert.equal(opened.at(-1), 'session-t3')
    assert.match(text(rows[1]), /已过期/)
    assert.equal(rows[1].props.role, 'button')
    // 失败任务：错误文案 + 重试载荷不变（重试不触发行跳转）
    assert.match(text(rows[3]), /已失败/)
    assert.match(text(rows[3]), /会话已结束，但没有生成评审报告/)
    const retry = button(tree, '重试')
    assert.ok(retry)
    const openedBefore = opened.length
    retry.props.onClick({ stopPropagation() {} })
    assert.equal(opened.length, openedBefore, '重试不应触发行级跳转')
    assert.deepEqual(requests.at(-1).opts.body, { cwd: '/b', num: '4', retry: true, force: false })
    requests.at(-1).resolve({ ok: true })
    await Promise.resolve()
    requests.at(-1).resolve(fresh)
    await Promise.resolve(); tree = render()
    // ── 刷新按钮：图标按钮（aria-label），点击重新拉取 ──
    const before = requests.length
    all(tree).find((n) => n.type === 'button' && n.props['aria-label'] === '刷新状态').props.onClick()
    assert.ok(requests.length > before, '刷新应发起新请求')
    requests.at(-1).resolve(fresh)
    await Promise.resolve()
    // ── 超过 5 条：先收 5 条，摘要「查看全部 N 条记录」收纳其余 ──
    // 排队任务没有会话，行不可点（无 button 语义）
    const many = [...Array.from({ length: 6 }, (_, i) => task({ id: 'm' + i, num: String(10 - i), status: i % 2 ? 'stale' : 'completed', createdAt: Date.now() - i * 60000 })), task({ id: 'mq', num: '99', status: 'queued' })]
    all(tree).find((n) => n.props.role === 'switch' && n.props['aria-label'] === '启用自动评审').props.onClick()
    const writeOff = requests.at(-1)
    assert.deepEqual(writeOff.opts.body, { cwd: '/b', enabled: false, trigger: 'inherit', scope: 'inherit', publish: 'inherit' })
    writeOff.resolve({ ...snap('/b'), repo: { cwd: '/b', enabled: false, trigger: 'inherit', forge: 'gitlab' }, tasks: many })
    await Promise.resolve(); tree = render()
    // 主列表只渲染 5 行；其余 2 行在收起的 details 里（真实浏览器中不可见）
    assert.equal(all(tree).filter(isRow).length, 7)
    const rowContainers = all(tree).filter((n) => n.props.className === 'wb-review-rows')
    assert.equal(rowContainers[0].children.length, 5)
    const more = all(tree).find((n) => n.type === 'details' && n.props.className === 'wb-review-more')
    assert.ok(more, '超出 5 条应出现查看全部入口')
    assert.match(text(more.children[0]), /查看全部 7 条记录/)
    assert.equal(all(more).filter(isRow).length, 2)
    const queuedRow = all(more).find((n) => isRow(n) && text(n).includes('排队中'))
    assert.ok(queuedRow, '排队任务应渲染行')
    assert.equal(queuedRow.props.role, undefined, '排队任务没有会话，行不可点')
    // ── 继承含义随默认变化：默认 publish=false 时选项显示真实含义 ──
    scopeSel.props.onChange({ target: { value: 'mine' } })
    const writeScope = requests.at(-1)
    assert.deepEqual(writeScope.opts.body, { cwd: '/b', enabled: false, trigger: 'inherit', scope: 'mine', publish: 'inherit' })
    writeScope.resolve({ ...snap('/b'), repo: { cwd: '/b', enabled: false, trigger: 'inherit', scope: 'mine', forge: 'gitlab' }, defaults: { trigger: 'first', model: '', publish: false } })
    await Promise.resolve(); tree = render()
    assert.match(text(all(tree).find((n) => n.props['aria-label'] === '仓库自动评审触发时机')), /跟随默认（首次进入待评审）/)
    assert.match(text(all(tree).find((n) => n.props['aria-label'] === '仓库自动评审发布评论')), /跟随默认（仅在会话内出报告）/)
    assert.equal(all(tree).find((n) => n.props['aria-label'] === '仓库自动评审范围').props.value, 'mine')
    // 关闭发布：保存载荷带 publish=false，并保留 enabled/trigger/scope
    all(tree).find((n) => n.props['aria-label'] === '仓库自动评审发布评论').props.onChange({ target: { value: 'off' } })
    const writePublish = requests.at(-1)
    assert.deepEqual(writePublish.opts.body, { cwd: '/b', enabled: false, trigger: 'inherit', scope: 'mine', publish: false })
    writePublish.resolve({ ...snap('/b'), repo: { cwd: '/b', enabled: false, trigger: 'inherit', scope: 'mine', publish: false, forge: 'gitlab' }, defaults: { trigger: 'first', model: '', publish: false } })
    await Promise.resolve(); tree = render()
    // ── 页脚说明条（频率 meta + 高级设置）已按要求整体移除 ──
    assert.equal(all(tree).find((n) => n.type === 'details' && n.props.className === 'wb-review-advanced'), undefined)
    assert.doesNotMatch(text(tree), /高级设置|首次开启跳过已有项|由本机 DSH 保存并运行|每 \d+ 秒检查/)
    // 不伪造发布状态：只有会话入口，没有「已发布」类文案
    assert.doesNotMatch(text(tree), /已发布/)
    // ── compact 变体（MR 详情评审记录）：口径不变，状态用语更新 ──
    compact = true; num = '7'
    tree = render()
    assert.equal(tree.props['aria-label'], '此项评审记录')
    assert.equal(button(tree, '查看评审结果'), undefined)
    button(tree, '刷新状态').props.onClick()
    requests.at(-1).resolve({ ...snap('/b'), tasks: [
      { id: 'other', num: '8', head: 'otherhead', sessionId: 'other-session', status: 'running', createdAt: 30 },
      { id: 'done', num: '7', head: 'abcdef1234', sessionId: 'done-session', status: 'completed', createdAt: 20 },
      { id: 'queue', num: '7', head: 'queuedhead', sessionId: 'not-created', status: 'queued', createdAt: 10 },
    ] })
    await Promise.resolve(); tree = render()
    assert.match(text(tree), /已完成 · abcdef12/)
    assert.match(text(tree), /排队中/)
    assert.doesNotMatch(text(tree), /otherhead|当前仓库已开启|触发时机/)
    assert.equal(button(tree, '打开评审会话'), undefined, '排队任务没有可打开的会话')
    button(tree, '查看评审结果').props.onClick()
    assert.equal(opened.at(-1), 'done-session')
    compact = false; num = undefined
    // ── 默认设置面板（配置页）：结构与载荷保持，open 仍由调用方决定 ──
    cwd = ''
    tree = render()
    for (const r of requests.filter((r) => r.path === '/forge/reviews?cwd=')) r.resolve({ ...snap(''), defaults: { trigger: 'first', model: '' } })
    await Promise.resolve(); tree = render()
    assert.equal(tree.type, 'details')
    assert.equal(tree.props.open, undefined, '默认设置面板 open 仍由调用方决定')
    const defScope = all(tree).find((n) => n.props['aria-label'] === '自动评审默认范围')
    assert.ok(defScope, '默认设置面板应挂载默认范围下拉')
    assert.equal(defScope.props.value, 'review')
    defScope.props.onChange({ target: { value: 'all' } })
    await Promise.resolve(); tree = render()
    // ── 默认面板的发布开关：未配置时勾选（默认发布），保存载荷带 publish ──
    const defPublish = all(tree).find((n) => n.type === 'input' && n.props.type === 'checkbox')
    assert.ok(defPublish, '默认设置面板应挂载发布评论开关')
    assert.equal(defPublish.props.checked, true)
    assert.match(text(tree), /评审后自动发布评论/)
    defPublish.props.onChange({ target: { checked: false } })
    await Promise.resolve(); tree = render()
    button(tree, '保存默认设置').props.onClick()
    const writeDefaults = requests.at(-1)
    assert.equal(writeDefaults.opts.body.defaults.scope, 'all')
    assert.equal(writeDefaults.opts.body.defaults.publish, false)
    writeDefaults.resolve({ ok: true, supported: true, defaults: { trigger: 'first', model: '', scope: 'all', publish: false }, repo: null, tasks: [] })
  } finally { delete globalThis.__reviewFetch; delete globalThis.__reviewCtx }
})
