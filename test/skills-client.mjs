// 技能管理页 client 侧契约测试。
//
// 加载构建产物 lib/client.js（见 load-client.mjs），只断言冻结的纯函数与配置
// 注册表，不触碰 DOM：
//   - SKILLS_SEARCH_PRESETS / SKILLS_TARGET_AGENTS / SKILLS_INSTALL_SCOPES 注册表
//   - buildSkillInstallBody 归一（scope 回落 global、agents 去重白名单、空 agents →
//     universal、skills 去空去重、package trim）
//   - installedMatchesQuery / skillAgentLabel / isSkillScope / formatInstalls
//   - feature.skills 开关（kind=toggle / scope=global / 默认 true）、FEATURE_ORDER
//     末尾、页可用性与回落顺序
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

const TARGET_IDS = ['universal', 'claude-code', 'codex']
const ALL_ON = { forge: true, dms: true, sls: true, pingcode: true, skills: true }

test('SKILLS_SEARCH_PRESETS：至少 3 个预设，query 长度 >= 2', () => {
  const { SKILLS_SEARCH_PRESETS } = loadClientModule()
  assert.ok(Array.isArray(SKILLS_SEARCH_PRESETS))
  assert.ok(SKILLS_SEARCH_PRESETS.length >= 3, '预设至少 3 项')
  const ids = new Set()
  for (const p of SKILLS_SEARCH_PRESETS) {
    assert.equal(typeof p.id, 'string')
    assert.ok(p.id.length > 0)
    assert.equal(typeof p.label, 'string')
    assert.ok(p.label.length > 0)
    assert.equal(typeof p.query, 'string')
    // 搜索接口要求关键词 >= 2 字符，预设必须自洽
    assert.ok(p.query.trim().length >= 2, '预设 query 太短: ' + JSON.stringify(p.query))
    assert.ok(!ids.has(p.id), '预设 id 重复: ' + p.id)
    ids.add(p.id)
  }
})

test('SKILLS_TARGET_AGENTS / SKILLS_INSTALL_SCOPES：安装目标与作用域注册表', () => {
  const a = loadClientModule()
  assert.ok(Array.isArray(a.SKILLS_TARGET_AGENTS))
  const ids = a.SKILLS_TARGET_AGENTS.map((x) => x.id)
  for (const id of TARGET_IDS) assert.ok(ids.includes(id), 'SKILLS_TARGET_AGENTS 缺少 ' + id)
  for (const x of a.SKILLS_TARGET_AGENTS) {
    assert.equal(typeof x.id, 'string')
    assert.equal(typeof x.label, 'string')
    assert.ok(x.label.length > 0)
  }

  assert.ok(Array.isArray(a.SKILLS_INSTALL_SCOPES))
  assert.deepEqual(a.SKILLS_INSTALL_SCOPES.map((s) => s.id).sort(), ['global', 'project'])
  for (const s of a.SKILLS_INSTALL_SCOPES) {
    assert.equal(typeof s.label, 'string')
    assert.ok(s.label.length > 0)
    assert.equal(typeof s.hint, 'string')
    assert.ok(s.hint.length > 0, 'scope ' + s.id + ' 需要 hint（安装落点说明）')
  }
})

test('buildSkillInstallBody：trim / 去重 / 白名单 / 默认值归一', () => {
  const { buildSkillInstallBody, SKILLS_TARGET_AGENTS } = loadClientModule()
  const body = buildSkillInstallBody({
    package: '  vercel-labs/agent-skills  ',
    skills: [' pr-review ', '', 'pr-review', '  ', 'commit'],
    scope: 'evil',
    agents: ['codex', 'codex', 'not-an-agent', 'claude-code'],
    copy: 1,
  })
  assert.equal(body.package, 'vercel-labs/agent-skills')
  assert.deepEqual(body.skills, ['pr-review', 'commit'])
  assert.equal(body.scope, 'global', '非法 scope 回落 global')
  assert.deepEqual([...body.agents].sort(), ['claude-code', 'codex'], 'agents 去重且只保留注册表 id')
  assert.equal(body.copy, true)
  assert.equal(body.cwd, null)

  // 空 agents → 默认 universal；缺省值（copy 默认 true：技能文件真落到目标根，
  // 绕开 CLI 对部分 agent 的 symlink 默认）
  const minimal = buildSkillInstallBody({ package: 'a/b' })
  assert.deepEqual(minimal.agents, ['universal'])
  assert.deepEqual(minimal.skills, [])
  assert.equal(minimal.scope, 'global')
  assert.equal(minimal.copy, true)
  assert.equal(minimal.cwd, null)

  // 合法 scope 与 cwd 原样保留；agents 顺序按注册表/入参归一
  const project = buildSkillInstallBody({ package: 'a/b', scope: 'project', cwd: '/tmp/ws', agents: ['codex'] })
  assert.equal(project.scope, 'project')
  assert.equal(project.cwd, '/tmp/ws')
  assert.deepEqual(project.agents, ['codex'])
  // 所有 agent 都必须是注册表里的 id
  const valid = new Set(SKILLS_TARGET_AGENTS.map((x) => x.id))
  for (const id of body.agents) assert.ok(valid.has(id), id + ' 不在 SKILLS_TARGET_AGENTS')
})

test('installedMatchesQuery：name/description 大小写不敏感子串', () => {
  const { installedMatchesQuery } = loadClientModule()
  const skill = { name: 'pr-review', description: 'Review GitLab merge requests' }
  assert.equal(installedMatchesQuery(skill, 'PR'), true)
  assert.equal(installedMatchesQuery(skill, 'review'), true)
  assert.equal(installedMatchesQuery(skill, 'GITLAB'), true, '匹配 description')
  assert.equal(installedMatchesQuery(skill, 'merge requests'), true)
  assert.equal(installedMatchesQuery(skill, 'nope'), false)
  assert.equal(installedMatchesQuery({ name: 'x' }, 'x'), true, '无 description 不抛错')
  assert.equal(installedMatchesQuery({ name: 'x' }, 'y'), false)
  assert.equal(installedMatchesQuery(skill, ''), true, '空关键词匹配全部')
})

test('skillAgentLabel / isSkillScope / formatInstalls', () => {
  const a = loadClientModule()
  assert.equal(a.skillAgentLabel([]), '—')
  assert.equal(a.skillAgentLabel(['通用']), '通用')
  assert.match(a.skillAgentLabel(['a', 'b']), /^a\s*,\s*b$/)
  const many = a.skillAgentLabel(['a', 'b', 'c', 'd'])
  assert.ok(many.includes('a') && many.includes('b') && many.includes('c'), many)
  assert.ok(many.endsWith('…'), '超过 3 个要省略: ' + many)
  assert.ok(!many.includes('d'), '省略项不该出现: ' + many)

  assert.equal(a.isSkillScope('global'), true)
  assert.equal(a.isSkillScope('project'), true)
  assert.equal(a.isSkillScope('GLOBAL'), false)
  assert.equal(a.isSkillScope(''), false)
  assert.equal(a.isSkillScope(undefined), false)
  assert.equal(a.isSkillScope(1), false)

  assert.equal(a.formatInstalls(1234567), '1.2M')
  assert.equal(a.formatInstalls(12345), '12.3K')
  assert.equal(a.formatInstalls(950), '950')
  assert.equal(a.formatInstalls(null), '')
})

test('skillFileView：按扩展名/文件名选择渲染方式（md/code/json/table/env/image/text）', () => {
  const a = loadClientModule()
  assert.equal(a.skillFileView('SKILL.md'), 'markdown')
  assert.equal(a.skillFileView('references/github-state.md'), 'markdown')
  assert.equal(a.skillFileView('notes.MDX'), 'markdown')
  assert.equal(a.skillFileView('scripts/_config.py'), 'code')
  assert.equal(a.skillFileView('scripts/run.sh'), 'code')
  assert.equal(a.skillFileView('src/index.ts'), 'code')
  assert.equal(a.skillFileView('_meta.json'), 'json')
  assert.equal(a.skillFileView('cfg/app.jsonc'), 'json')
  assert.equal(a.skillFileView('data/points.csv'), 'table')
  assert.equal(a.skillFileView('data/points.tsv'), 'table')
  assert.equal(a.skillFileView('.env'), 'env')
  assert.equal(a.skillFileView('.env.example'), 'env')
  assert.equal(a.skillFileView('assets/logo.png'), 'image')
  assert.equal(a.skillFileView('assets/ICON.SVG'), 'image')
  assert.equal(a.skillFileView('LICENSE'), 'text')
  assert.equal(a.skillFileView('bin/blob.bin'), 'text')
  assert.equal(a.skillFileView(undefined), 'text')
  assert.equal(a.skillFileView(7), 'text')
})

test('codeLangOf：路径 → 宿主高亮器的语法名（未识别 → 空串）', () => {
  const a = loadClientModule()
  const cases = {
    'scripts/_config.py': 'python',
    'run.sh': 'shellscript',
    'a.TS': 'typescript',
    'b.tsx': 'typescript',
    'c.mjs': 'javascript',
    'a.go': 'go',
    'main.rs': 'rust',
    'App.java': 'java',
    'a.c': 'c',
    'a.hpp': 'cpp',
    'a.cs': 'csharp',
    'a.kt': 'kotlin',
    'a.swift': 'swift',
    'a.rb': 'ruby',
    'a.php': 'php',
    'a.yaml': 'yaml',
    'a.toml': 'toml',
    'a.ini': 'ini',
    'a.cfg': 'ini',
    'a.html': 'html',
    'a.css': 'css',
    'a.scss': 'scss',
    'a.sql': 'sql',
    'a.xml': 'xml',
    'a.lua': 'lua',
    '_meta.json': 'json',
  }
  for (const [path, lang] of Object.entries(cases)) assert.equal(a.codeLangOf(path), lang, path)
  // 未识别 / 非法输入 → 不猜（宿主高亮器按纯文本回落）
  assert.equal(a.codeLangOf('LICENSE'), '')
  assert.equal(a.codeLangOf('bin/blob.bin'), '')
  assert.equal(a.codeLangOf(undefined), '')
})

test('parseDelimitedRows：引号/转义/CRLF/参差行 + 行数封顶', () => {
  const a = loadClientModule()
  assert.deepEqual(a.parseDelimitedRows('', ','), { header: [], rows: [], truncated: false })
  assert.deepEqual(a.parseDelimitedRows(null, ','), { header: [], rows: [], truncated: false })

  const csv = 'id,title,state\r\n1,"含,逗号",done\r\n2,"他说""你好""",open\r\n'
  const t = a.parseDelimitedRows(csv, ',')
  assert.deepEqual(t.header, ['id', 'title', 'state'])
  assert.deepEqual(t.rows, [['1', '含,逗号', 'done'], ['2', '他说"你好"', 'open']])
  assert.equal(t.truncated, false)

  // 参差行列数与表头对齐（短行补空串，长行按上限截断）
  const ragged = a.parseDelimitedRows('a,b\n1\n2,3,4\n', ',')
  assert.deepEqual(ragged.rows, [['1', ''], ['2', '3']])

  // TSV
  const tsv = a.parseDelimitedRows('a\tb\n1\t2\n', '\t')
  assert.deepEqual(tsv.header, ['a', 'b'])
  assert.deepEqual(tsv.rows, [['1', '2']])

  // 行数封顶：超出部分丢弃并置 truncated
  const many = ['h'].concat(Array.from({ length: a.SKILL_TABLE_MAX_ROWS + 25 }, (_, i) => 'r' + String(i))).join('\n')
  const capped = a.parseDelimitedRows(many, ',')
  assert.equal(capped.rows.length, a.SKILL_TABLE_MAX_ROWS)
  assert.equal(capped.truncated, true)
})

test('dotenvRows：注释/空行/export/引号/首个 = 分割（注释行保留为注释行）', () => {
  const a = loadClientModule()
  const rows = a.dotenvRows('# 注释\n\nA=1\nexport B="x y"\nC=\'z\'\nD=a=b\n不是赋值\n  E = 2  \n')
  assert.deepEqual(rows, [
    { key: '', value: '# 注释', comment: true },
    { key: 'A', value: '1', comment: false },
    { key: 'B', value: 'x y', comment: false },
    { key: 'C', value: 'z', comment: false },
    { key: 'D', value: 'a=b', comment: false },
    { key: 'E', value: '2', comment: false },
  ])
  assert.deepEqual(a.dotenvRows(''), [])
  assert.deepEqual(a.dotenvRows(null), [])
  // 行数封顶
  const many = Array.from({ length: a.SKILL_ENV_MAX_ROWS + 5 }, (_, i) => 'K' + String(i) + '=v').join('\n')
  assert.equal(a.dotenvRows(many).length, a.SKILL_ENV_MAX_ROWS)
})

test('parseJsonForView：只接受可树化的对象/数组，其余回落代码视图', () => {
  const a = loadClientModule()
  assert.deepEqual(a.parseJsonForView('{"a":1,"b":[1,2]}'), { a: 1, b: [1, 2] })
  assert.deepEqual(a.parseJsonForView('[1,2]'), [1, 2])
  assert.deepEqual(a.parseJsonForView('{}'), {})
  assert.equal(a.parseJsonForView('{"a":'), null)
  assert.equal(a.parseJsonForView('42'), null)
  assert.equal(a.parseJsonForView('"str"'), null)
  assert.equal(a.parseJsonForView('null'), null)
  assert.equal(a.parseJsonForView(''), null)
  assert.equal(a.parseJsonForView(undefined), null)
})

test('prettyJsonForView：可解析的对象/数组重排成缩进 2 的 JSON，其余原样', () => {
  const a = loadClientModule()
  assert.equal(a.prettyJsonForView('{"a":1}'), '{\n  "a": 1\n}')
  assert.equal(a.prettyJsonForView('{"a":{"b":[1,2]}}'), '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  }\n}')
  assert.equal(a.prettyJsonForView('[1,2]'), '[\n  1,\n  2\n]')
  // 非法 / 标量 / 空 → 原样返回（仍走高亮，不做任何猜测）
  assert.equal(a.prettyJsonForView('{"a":'), '{"a":')
  assert.equal(a.prettyJsonForView('42'), '42')
  assert.equal(a.prettyJsonForView(''), '')
  assert.equal(a.prettyJsonForView(undefined), '')
})

test('safeImageDataUrl：只放行 data:image/*;base64 内联图片', () => {
  const a = loadClientModule()
  assert.equal(a.safeImageDataUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA')
  assert.equal(a.safeImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+'), 'data:image/svg+xml;base64,PHN2Zy8+')
  assert.equal(a.safeImageDataUrl('data:image/png;base64,'), null, '空载荷不算图片')
  assert.equal(a.safeImageDataUrl('data:text/html;base64,AAAA'), null)
  assert.equal(a.safeImageDataUrl('data:image/svg+xml,<svg/>'), null)
  assert.equal(a.safeImageDataUrl('javascript:alert(1)'), null)
  assert.equal(a.safeImageDataUrl('http://x/y.png'), null)
  assert.equal(a.safeImageDataUrl(''), null)
  assert.equal(a.safeImageDataUrl(undefined), null)
})

test('resolveSkillFileLink：SKILL.md 相对链接 → 技能内可浏览文件（否则 null）', () => {
  const a = loadClientModule()
  const files = [{ path: 'SKILL.md' }, { path: 'references/github-state.md' }, { path: 'my file.md' }]
  assert.equal(a.resolveSkillFileLink('references/github-state.md', files), 'references/github-state.md')
  assert.equal(a.resolveSkillFileLink('./SKILL.md', files), 'SKILL.md')
  assert.equal(a.resolveSkillFileLink('references/github-state.md#workflow', files), 'references/github-state.md')
  assert.equal(a.resolveSkillFileLink('SKILL.md?x=1', files), 'SKILL.md')
  assert.equal(a.resolveSkillFileLink('my%20file.md', files), 'my file.md')
  // 纯字符串清单也接受
  assert.equal(a.resolveSkillFileLink('SKILL.md', ['SKILL.md']), 'SKILL.md')
  // 支持文件里的 ../ 相对引用按当前文件目录归一（真实技能常用 [SKILL.md](../SKILL.md)）
  assert.equal(a.resolveSkillFileLink('../SKILL.md', files, 'references/github-state.md'), 'SKILL.md')
  assert.equal(a.resolveSkillFileLink('issues.md', files, 'references/github-state.md'), null, '未列出的目标不接管')
  // 外部链接 / 越界路径 / 未列出的文件 → null（保持普通链接或纯文本）
  assert.equal(a.resolveSkillFileLink('https://example.com/a.md', files), null)
  assert.equal(a.resolveSkillFileLink('mailto:a@b.com', files), null)
  assert.equal(a.resolveSkillFileLink('../outside.md', files), null)
  assert.equal(a.resolveSkillFileLink('../../SKILL.md', files, 'references/github-state.md'), null, '越出技能目录不接管')
  assert.equal(a.resolveSkillFileLink('/etc/passwd', files), null)
  assert.equal(a.resolveSkillFileLink('references/missing.md', files), null)
  assert.equal(a.resolveSkillFileLink('references/', files), null)
  assert.equal(a.resolveSkillFileLink('', files), null)
  assert.equal(a.resolveSkillFileLink('SKILL.md', null), null)
})

test('skillFileGroups：根目录在前、SKILL.md 置顶，其余按目录/路径排序', () => {
  const a = loadClientModule()
  assert.deepEqual(a.skillFileGroups([]), [])
  assert.deepEqual(a.skillFileGroups(null), [])
  const groups = a.skillFileGroups([
    { path: 'references/issues.md', sizeBytes: 3 },
    { path: 'SKILL.md', sizeBytes: 1 },
    { path: 'references/github-state.md', sizeBytes: 2 },
    { path: 'scripts/run.sh', sizeBytes: 4 },
    { path: 'notes.md', sizeBytes: 5 },
    { path: 7, sizeBytes: 0 },
  ])
  assert.deepEqual(groups.map((g) => g.dir), ['', 'references', 'scripts'])
  assert.deepEqual(groups[0].files.map((f) => f.path), ['SKILL.md', 'notes.md'])
  assert.deepEqual(groups[1].files.map((f) => f.path), ['references/github-state.md', 'references/issues.md'])
  assert.deepEqual(groups[2].files.map((f) => f.path), ['scripts/run.sh'])
  for (const g of groups) for (const f of g.files) assert.equal(typeof f.sizeBytes, 'number')
})

test('feature.skills：注册表开关 + FEATURE_ORDER 顺序 + 页可用性/回落', () => {
  const a = loadClientModule()
  assert.equal(a.FEATURE_CONFIG_KEYS.skills, 'feature.skills')
  assert.deepEqual(a.FEATURE_ORDER, ['forge', 'git', 'dms', 'sls', 'pingcode', 'skills', 'notifications'])

  const item = a.CONFIG_ITEMS.find((c) => c.key === 'feature.skills')
  assert.ok(item, 'CONFIG_ITEMS 缺少 feature.skills')
  assert.equal(item.kind, 'toggle')
  assert.equal(item.scope, 'global')
  assert.equal(item.default, true)
  assert.equal(typeof item.help, 'string')
  assert.ok(item.help.length > 0)

  assert.equal(a.isPageEnabled('skills', ALL_ON), true)
  assert.equal(a.isPageEnabled('skills', Object.assign({}, ALL_ON, { skills: false })), false)
  assert.equal(a.isPageEnabled('forge', Object.assign({}, ALL_ON, { skills: false })), true)
  assert.equal(
    a.fallbackPage({ forge: false, dms: false, sls: false, pingcode: false, skills: true }),
    'skills',
    '其他功能关闭时回到 skills',
  )
})

test('安装候选过滤：只隐藏同来源已是最新项，保留更新与未知项', () => {
  const { installCandidates } = loadClientModule()
  const names = ['new', 'current', 'update', 'unknown', 'other-source']
  const available = names.map(name => ({ name, description: '' }))
  const installed = names.slice(1).map(name => ({ name }))
  const updates = [
    { name: 'current', source: 'a/b', status: 'current' },
    { name: 'update', source: 'a/b', status: 'update' },
    { name: 'other-source', source: 'c/d', status: 'current' },
  ]
  assert.deepEqual(installCandidates(available, installed, updates, 'a/b').map(r => [r.name, r.status]), [
    ['new', 'new'], ['update', 'update'], ['unknown', 'unknown'], ['other-source', 'unknown'],
  ])
})

test('installCandidates：停用中的技能不算安装候选（与「已是最新」同级隐藏）', () => {
  const { installCandidates } = loadClientModule()
  const installed = [
    { name: 'a', description: '' },
    { name: 'b', description: '' },
  ]
  const updates = [
    { name: 'a', source: 'a/b', status: 'disabled' },
    { name: 'b', source: 'a/b', status: 'current' },
  ]
  const candidates = installCandidates(
    [{ name: 'a', description: 'A' }, { name: 'b', description: 'B' }, { name: 'c', description: 'C' }],
    installed,
    updates,
    'a/b',
  )
  const names = candidates.map(r => r.name)
  assert.ok(names.includes('c'), '未安装技能仍是候选')
  assert.ok(!names.includes('a'), '已停用技能不能被当成可安装/可更新')
  assert.ok(!names.includes('b'), '已是最新技能不作为候选')
  // 停用态状态原样透出（供 UI 识别），只是被过滤
  assert.ok(updates[0].status === 'disabled')
})
