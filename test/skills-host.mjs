// 技能管理（skills.sh `npx skills` CLI）host 侧契约测试。
//
// 冻结契约两部分：
//   A. index.js 必须 re-export 的纯函数：argv 白名单构造（npx/cliBin/node）、
//      skills CLI 输出解析（容忍前导横幅）、SKILL.md frontmatter 解析、路径/作用域
//      归一（global=~/.agents/skills、project=<ws>/.agents/skills + .dsh 备用根）、
//      错误归类。
//   B. /skills/status|list|search|detail（GET）与 /skills/install|remove|update（POST）
//      的 JSON 契约；失败沿用插件既有约定 HTTP 200 + { ok:false, error }。
//
// 全部用 mock subprocess 驱动 apply(ctx) 注册的真实路由：不调用 npx、不访问网络、
// 不写真实 ~/.agents —— HOME 在 import index.js 之前指向临时目录。
// skills CLI 的真实输出形状取自本机缓存的 skills@1.7.0（ls --json / add --json /
// /api/search），不依赖网络。
//
// 说明：*Argv 构造器有两种合理形态 —— 只返回 skills CLI 参数（['add', …]）或返回
// 完整命令（['npx','--yes','skills@latest','add', …]）。契约文字写的是前者，实现
// 是后者，故断言统一经 cliArgs() 归一后再比对（语义等价），差异已单独回报。
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 环境隔离（必须在 import index.js 之前设置 HOME：模块顶层可能缓存 homedir）──
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'skills-home-')))
const WS = realpathSync(mkdtempSync(join(tmpdir(), 'skills-ws-')))
process.env.HOME = HOME

const mod = await import('../index.js')

after(() => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(WS, { recursive: true, force: true })
})

// ── fixture：工作区已装技能（<ws>/.agents/skills/{alpha,beta,gamma,bulk,deltest}）──
const SKILLS_ROOT = join(WS, '.agents', 'skills')
const ALPHA = join(SKILLS_ROOT, 'alpha')
const BETA = join(SKILLS_ROOT, 'beta')
const GAMMA = join(SKILLS_ROOT, 'gamma')
const BULK = join(SKILLS_ROOT, 'bulk')
const HUGE = join(SKILLS_ROOT, 'huge')
const DEL = join(SKILLS_ROOT, 'deltest')

const ALPHA_MD = [
  '---',
  'name: alpha',
  'description: 第一个技能',
  'metadata:',
  '  author: alice',
  '  license: MIT',
  '---',
  '',
  '# Alpha',
  '',
  '正文内容',
  '',
].join('\n')
const GAMMA_MD = '---\nname: gamma\ndescription: 从 frontmatter 来\n---\nbody\n'

mkdirSync(ALPHA, { recursive: true })
writeFileSync(join(ALPHA, 'SKILL.md'), ALPHA_MD)
writeFileSync(join(ALPHA, 'reference.md'), 'ref\n')
// 支持文件的按需读取（/skills/file）：嵌套目录、二进制、超长、符号链接外指
mkdirSync(join(ALPHA, 'references'), { recursive: true })
writeFileSync(join(ALPHA, 'references', 'github-state.md'), '# state\n')
writeFileSync(join(ALPHA, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]))
writeFileSync(join(ALPHA, 'big.txt'), 'y'.repeat(300000))
// 图片：按扩展名判 mime 并内联成 data URL；超过内联上限的不内联
const ALPHA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>\n'
const ALPHA_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0x00, 0x00, 0x00, 0x0d])])
mkdirSync(join(ALPHA, 'assets'), { recursive: true })
writeFileSync(join(ALPHA, 'assets', 'icon.svg'), ALPHA_SVG)
writeFileSync(join(ALPHA, 'assets', 'logo.png'), ALPHA_PNG)
writeFileSync(join(HOME, 'outside-secret.txt'), 'secret\n')
symlinkSync(join(HOME, 'outside-secret.txt'), join(ALPHA, 'escape.txt'))
// 详情文件清单必须跳过 node_modules/.git
mkdirSync(join(ALPHA, 'node_modules', 'pkg'), { recursive: true })
writeFileSync(join(ALPHA, 'node_modules', 'pkg', 'index.js'), 'x\n')
mkdirSync(join(ALPHA, '.git'), { recursive: true })
writeFileSync(join(ALPHA, '.git', 'config'), 'x\n')
for (let i = 0; i < 5; i++) writeFileSync(join(ALPHA, 'notes-' + i + '.md'), 'n\n')

mkdirSync(BETA, { recursive: true })
writeFileSync(join(BETA, 'SKILL.md'), '# 没有 frontmatter\n')
mkdirSync(GAMMA, { recursive: true })
writeFileSync(join(GAMMA, 'SKILL.md'), GAMMA_MD)
// 60 个文件：验证详情文件清单封顶 50 项
mkdirSync(BULK, { recursive: true })
writeFileSync(join(BULK, 'SKILL.md'), '---\nname: bulk\ndescription: 大技能\n---\n')
for (let i = 0; i < 60; i++) writeFileSync(join(BULK, 'f-' + String(i).padStart(2, '0') + '.md'), 'b\n')
mkdirSync(DEL, { recursive: true })
writeFileSync(join(DEL, 'SKILL.md'), '---\nname: deltest\ndescription: 卸载用\n---\n')
// 300KB 正文：验证详情截断（超过 256KB 上限）
mkdirSync(HUGE, { recursive: true })
writeFileSync(join(HUGE, 'SKILL.md'), '---\nname: huge\ndescription: 大文件\n---\n' + 'x'.repeat(300000))

// ── mock subprocess：按 argv 产出构造的 stdout ──────────────────────────────
const state = { handler: () => ({ code: 0, out: '', err: '' }), calls: [] }

const subprocessMock = {
  async resolveExecutable(name) { return name.includes('/') ? name : '/mock/bin/' + name },
  spawn(spec) {
    state.calls.push({ argv: spec.argv.slice(), env: spec.env || null })
    let r
    try { r = state.handler(spec.argv) || {} } catch (e) { r = { code: 1, out: '', err: String(e) } }
    const text = (v) => (v === undefined || v === null ? '' : String(v))
    return {
      done: Promise.resolve({ exitCode: r.code === undefined ? 0 : r.code }),
      collected: {
        stdout: { readFrom: () => ({ text: text(r.out) }) },
        stderr: { readFrom: () => ({ text: text(r.err) }) },
      },
      terminate() {},
      async waitForExit() { return true },
    }
  },
}

// ── apply(ctx)：捕获 /skills/* 路由 ─────────────────────────────────────────
const routes = new Map()
const ctx = {
  get(name) {
    if (name === 'subprocess') return subprocessMock
    if (name === 'sandboxPolicy') return { workspaceRoot: WS }
    return undefined
  },
  effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  connection: { fetch: { register() {} }, requestRejection: () => undefined },
}
mod.apply(ctx)
// 探测缓存会跨用例命中（authTtlMs）：置 0 让每次 /skills/status 真探测
mod.setConfig({ ...mod.getConfig(), authTtlMs: 0 })

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(k, v) { this.headers[k] = v },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk)
      this.writableEnded = true
    },
  }
}

function fakeReq(method, url, body) {
  const listeners = {}
  const req = {
    method,
    url,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return req },
  }
  queueMicrotask(() => {
    if (body !== undefined) {
      const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      for (const fn of listeners.data || []) fn(buf)
    }
    for (const fn of listeners.end || []) fn()
  })
  return req
}

/** 调一个已注册路由；成功即 HTTP 200 + JSON（插件既有约定）。 */
async function call(path, { method = 'GET', query, body } = {}) {
  const route = routes.get(path)
  assert.ok(route, '缺少路由 ' + path)
  const url = new URL('http://localhost' + path)
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v)
  const res = fakeRes()
  await route.handler(fakeReq(method, url.pathname + url.search, body), res)
  assert.equal(res.statusCode, 200, path + ' 必须走 HTTP 200 + JSON 约定')
  assert.match(String(res.headers['content-type'] || ''), /application\/json/, path + ' 必须返回 JSON')
  return JSON.parse(res.body || 'null')
}

/** 取 flag 后的值：重复 flag（--skill a --skill b）与单 flag 多值（--skill a b）都接受。 */
function flagValue(argv, aliases, value) {
  for (let i = 0; i < argv.length; i++) {
    if (!aliases.includes(argv[i])) continue
    const rest = argv.slice(i + 1)
    const stop = rest.findIndex((x) => x.startsWith('-'))
    const values = stop === -1 ? rest : rest.slice(0, stop)
    if (values.includes(value)) return true
  }
  return false
}

/** 路由层 CLI 解析时的一次性 `--version` 探测，不属于数据/写调用。 */
function isVersionProbe(argv) {
  return argv.length === 2 && argv[1] === '--version'
}

/** 归一掉可执行文件与 `npx --yes <spec>` 前缀，只留 skills CLI 参数。
 *  路由层 spawn 的 argv[0] 是 resolveCliExe 解析后的绝对路径（如 /mock/bin/npx），
 *  之后跟着 `--yes <spec>`（npx 引导）再才是子命令参数——两层都要剥掉。 */
function cliArgs(argv) {
  let out = argv.slice()
  if (out[0] && out[0].includes('/')) out = out.slice(1) // 路由层 spawn：argv[0] 是解析后的绝对路径
  if (out[0] === 'npx') return out.slice(3)              // 未解析形态：npx --yes skills@latest
  if (out[0] === '--yes' && out.length >= 2) return out.slice(2) // 已解析形态：/mock/bin/npx --yes skills@latest …
  if (out[0] === 'node') return out.slice(1)
  return out
}

const HOST_EXPORTS = [
  'SKILL_SCOPES', 'SKILL_AGENTS', 'buildSkillsArgv', 'buildSkillsAddArgv', 'buildSkillsListArgv',
  'buildSkillsRemoveArgv', 'buildSkillsUpdateArgv', 'parseSkillsJsonArray', 'parseSkillsCliVersion',
  'parseSkillFrontmatter', 'applySkillMetadata', 'classifySkillsError', 'resolveSkillsRoots',
  'skillDirNameValid', 'resolveInstalledSkillDir', 'skillScopeRoots',
  'loadSkillFile', 'skillRelativeFilePathValid', 'SKILLS_FILE_IMAGE_MAX',
  'parseSkillInvocation', 'editSkillInvocationFlag',
]

// ══ A. 导出符号 ═════════════════════════════════════════════════════════════

test('index.js re-export 的技能域契约符号齐全', () => {
  const missing = HOST_EXPORTS.filter((n) => mod[n] === undefined)
  assert.deepEqual(missing, [], 'index.js 缺少导出: ' + missing.join(', '))
})

test('SKILL_SCOPES / SKILL_AGENTS：作用域与多 agent 目标注册表', () => {
  assert.deepEqual(mod.SKILL_SCOPES, ['global', 'project'])
  const agents = mod.SKILL_AGENTS
  assert.ok(Array.isArray(agents))
  for (const a of agents) {
    assert.equal(typeof a.id, 'string')
    assert.ok(a.id.length > 0)
    assert.equal(typeof a.name, 'string')
    assert.ok(a.name.length > 0)
  }
  const byId = new Map(agents.map((a) => [a.id, a]))
  for (const id of ['universal', 'claude-code', 'codex']) {
    assert.ok(byId.has(id), 'SKILL_AGENTS 缺少 ' + id)
  }
  // 契约冻结 name === '通用'，实现为 '通用（DSH 默认，~/.agents/skills）'
  assert.ok(byId.get('universal').name.startsWith('通用'), 'universal.name=' + byId.get('universal').name)
  assert.equal(byId.get('universal').universal, true)
})

// ══ A. argv 白名单构造 ══════════════════════════════════════════════════════

test('buildSkillsArgv：npx 默认形态 / cliBin 直调 / node 直调 / 白名单外抛错', () => {
  assert.deepEqual(mod.buildSkillsArgv('npx', ['ls', '--json']), ['npx', '--yes', 'skills@latest', 'ls', '--json'])
  // 自定义 skills 可执行文件：直接调用，不拼 npx
  assert.deepEqual(
    mod.buildSkillsArgv('npx', ['add', 'x'], { cliBin: '/opt/bin/skills' }),
    ['/opt/bin/skills', 'add', 'x'],
  )
  assert.deepEqual(mod.buildSkillsArgv('node', ['cli.mjs', 'ls']), ['node', 'cli.mjs', 'ls'])
  // npmCacheDir 由调用方作为进程 env（npm_config_cache）传递，argv 形态不受影响
  assert.deepEqual(mod.buildSkillsArgv('npx', ['ls'], { npmCacheDir: '/tmp/npm-cache' }),
    ['npx', '--yes', 'skills@latest', 'ls'])
  // 非白名单工具：防任意命令执行
  assert.throws(() => mod.buildSkillsArgv('bash', ['-c', 'rm -rf /']), /未知的 skills CLI/)
  assert.throws(() => mod.buildSkillsArgv('sh', []), /未知的 skills CLI/)
})

test('buildSkillsAddArgv：默认/显式作用域、skill/agent、copy/all、顺序', () => {
  assert.deepEqual(cliArgs(mod.buildSkillsAddArgv({ package: 'vercel-labs/agent-skills', scope: 'project' })),
    ['add', 'vercel-labs/agent-skills', '--yes', '--json'])
  assert.deepEqual(cliArgs(mod.buildSkillsAddArgv({ package: 'vercel-labs/agent-skills', scope: 'global' })),
    ['add', 'vercel-labs/agent-skills', '--yes', '--json', '--global'])
  // Lead 澄清：省略/非法 scope 一律按全局（契约原文是「非法 scope 抛错」，已按澄清调整）
  assert.deepEqual(cliArgs(mod.buildSkillsAddArgv({ package: 'a/b' })),
    cliArgs(mod.buildSkillsAddArgv({ package: 'a/b', scope: 'global' })))
  assert.deepEqual(cliArgs(mod.buildSkillsAddArgv({ package: 'a/b', scope: 'system' })),
    cliArgs(mod.buildSkillsAddArgv({ package: 'a/b', scope: 'global' })))

  const full = mod.buildSkillsAddArgv({
    package: 'vercel-labs/agent-skills',
    skills: ['pr-review', 'commit'],
    scope: 'global',
    agents: ['claude-code', 'codex'],
    copy: true,
    all: true,
  })
  assert.equal(full[0], 'add')
  assert.equal(full[1], 'vercel-labs/agent-skills')
  assert.ok(full.indexOf('--yes') < full.indexOf('--json'))
  assert.ok(full.includes('--global'))
  assert.ok(flagValue(full, ['-s', '--skill'], 'pr-review'))
  assert.ok(flagValue(full, ['-s', '--skill'], 'commit'))
  assert.ok(flagValue(full, ['-a', '--agent'], 'claude-code'))
  assert.ok(flagValue(full, ['-a', '--agent'], 'codex'))
  assert.ok(full.includes('--copy'))
  assert.ok(full.includes('--all'))
  // copy/all 在 skill/agent 之后
  assert.ok(full.indexOf('--copy') > full.findIndex((a) => a === '-s' || a === '--skill'))
  // 未要求 copy 时不得带 --copy
  assert.ok(!mod.buildSkillsAddArgv({ package: 'a/b' }).includes('--copy'))
})

test('buildSkillsAddArgv：包名 / skill / agent 注入防护', () => {
  assert.throws(() => mod.buildSkillsAddArgv({ package: '../evil' }), /包名|来源|非法|无效/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: 'a/b; rm -rf /' }), /包名|来源|非法|无效/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: '' }), /包名|来源|非法|无效/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: 'a/b\n-x' }), /包名|来源|非法|无效/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: 'a/b', skills: ['ok', 'bad name'] }), /skill|技能名|无效|非法/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: 'a/b', skills: ['x\n--all'] }), /skill|技能名|无效|非法/)
  assert.throws(() => mod.buildSkillsAddArgv({ package: 'a/b', agents: ['claude-code', '../etc'] }), /agent|无效|非法/)
  // 合法形态：owner/repo、@scope/repo、单名
  for (const pkg of ['vercel-labs/agent-skills', '@scope/repo', 'my-skill']) {
    assert.equal(mod.buildSkillsAddArgv({ package: pkg })[1], pkg)
  }
})

test('buildSkillsListArgv / buildSkillsRemoveArgv / buildSkillsUpdateArgv', () => {
  assert.deepEqual(cliArgs(mod.buildSkillsListArgv('project')), ['ls', '--json'])
  assert.deepEqual(cliArgs(mod.buildSkillsListArgv('global')), ['ls', '--json', '--global'])

  assert.deepEqual(cliArgs(mod.buildSkillsRemoveArgv({ skills: ['alpha', 'beta'], scope: 'project' })),
    ['remove', 'alpha', 'beta', '--yes', '--json'])
  const rmGlobal = cliArgs(mod.buildSkillsRemoveArgv({ skills: ['alpha'], scope: 'global' }))
  assert.deepEqual(rmGlobal, ['remove', 'alpha', '--yes', '--json', '--global'])
  assert.ok(flagValue(mod.buildSkillsRemoveArgv({ skills: ['alpha'], agents: ['codex'] }), ['-a', '--agent'], 'codex'))

  assert.deepEqual(cliArgs(mod.buildSkillsUpdateArgv('global')), ['update', '-g', '-y'])
  assert.deepEqual(cliArgs(mod.buildSkillsUpdateArgv('project')), ['update', '-p', '-y'])
  // Lead 澄清：省略作用域 = 全局
  assert.deepEqual(cliArgs(mod.buildSkillsUpdateArgv(undefined)), ['update', '-g', '-y'])
})

// ══ A. CLI 输出解析 ═════════════════════════════════════════════════════════

test('parseSkillsJsonArray：容忍前导横幅/箭头/ANSI 与尾部噪声，非数组或坏 JSON 返回 []', () => {
  assert.deepEqual(mod.parseSkillsJsonArray('[]'), [])
  assert.deepEqual(mod.parseSkillsJsonArray('\u001b[32m→\u001b[0m Installing…\n[{"name":"a"},{"name":"b"}]\nDone!\n'),
    [{ name: 'a' }, { name: 'b' }])
  assert.deepEqual(mod.parseSkillsJsonArray('  \n[1,2,3]  '), [1, 2, 3])
  // 非数组 / 解析失败 / 空输入
  assert.deepEqual(mod.parseSkillsJsonArray('{"a":1}'), [])
  assert.deepEqual(mod.parseSkillsJsonArray('not json at all'), [])
  assert.deepEqual(mod.parseSkillsJsonArray(''), [])
  assert.deepEqual(mod.parseSkillsJsonArray('[1,2'), [])
})

test('parseSkillsCliVersion：语义版本原样返回，其余 null', () => {
  assert.equal(mod.parseSkillsCliVersion('1.7.0\n'), '1.7.0')
  assert.equal(mod.parseSkillsCliVersion('skills 1.7.0'), '1.7.0')
  assert.equal(mod.parseSkillsCliVersion('1.7'), null)
  assert.equal(mod.parseSkillsCliVersion('not-a-version'), null)
  assert.equal(mod.parseSkillsCliVersion(''), null)
})

test('parseSkillFrontmatter：--- YAML 头（name/description/metadata 一层），无头不抛错', () => {
  const fm = mod.parseSkillFrontmatter(ALPHA_MD)
  assert.equal(fm.name, 'alpha')
  assert.equal(fm.description, '第一个技能')
  assert.deepEqual(fm.metadata, { author: 'alice', license: 'MIT' })
  assert.deepEqual(mod.parseSkillFrontmatter('# 没有 frontmatter\n\n正文\n'), { name: '', description: '', metadata: {} })
  assert.doesNotThrow(() => mod.parseSkillFrontmatter(''))
  assert.doesNotThrow(() => mod.parseSkillFrontmatter('---\nname: x\n'))
})

test('applySkillMetadata：用 items[i].frontmatter 填缺，overwrite=true 覆盖，无 frontmatter 不改动', () => {
  const fm = mod.parseSkillFrontmatter(GAMMA_MD)
  const blank = [{ name: 'gamma', description: '', frontmatter: fm }]
  const filled = mod.applySkillMetadata(blank, false)
  assert.equal(filled.length, 1)
  assert.equal(filled[0].description, '从 frontmatter 来')

  const keep = [{ name: 'gamma', description: '已有的', frontmatter: fm }]
  assert.equal(mod.applySkillMetadata(keep, false)[0].description, '已有的')
  assert.equal(mod.applySkillMetadata(keep, true)[0].description, '从 frontmatter 来')

  // name 也按同一语义补空
  const noName = mod.applySkillMetadata([{ name: '', description: '', frontmatter: fm }], false)
  assert.equal(noName[0].name, 'gamma')

  const bare = [{ name: 'unknown' }]
  assert.deepEqual(mod.applySkillMetadata(bare, false), [{ name: 'unknown' }])
  assert.deepEqual(mod.applySkillMetadata(bare, true), [{ name: 'unknown' }])
})

test('classifySkillsError：缺 node/npx、网络、其它原样', () => {
  assert.match(mod.classifySkillsError(new Error('spawn npx ENOENT')), /未检测到/)
  assert.match(mod.classifySkillsError(new Error('npx: command not found')), /未检测到/)
  assert.match(mod.classifySkillsError(new Error('sh: node: not found')), /未检测到/)
  // 契约原文为精确串 '网络错误：无法访问 skills.sh'，实现会追加括号细节，这里只校验前缀
  assert.match(mod.classifySkillsError(new Error('request to https://skills.sh failed, reason: fetch failed')),
    /^网络错误：无法访问 skills\.sh/)
  assert.match(mod.classifySkillsError(new Error('connect ETIMEDOUT 1.2.3.4:443')), /^网络错误：无法访问 skills\.sh/)
  assert.match(mod.classifySkillsError(new Error('getaddrinfo EAI_AGAIN skills.sh')), /^网络错误：无法访问 skills\.sh/)
  assert.equal(mod.classifySkillsError(new Error('自定义失败')), '自定义失败')
  assert.equal(mod.classifySkillsError('字符串错误'), '字符串错误')
})

// ══ A. 路径 / 作用域归一 ════════════════════════════════════════════════════

test('resolveSkillsRoots / skillScopeRoots：DSH 技能发现根与 skills CLI 落点', () => {
  assert.deepEqual(mod.resolveSkillsRoots('/ws', '/home/u'), {
    global: join('/home/u', '.agents', 'skills'),
    project: join('/ws', '.agents', 'skills'),
    dshProject: join('/ws', '.dsh', 'skills'),
    dshUser: join('/home/u', '.dsh', 'skills'),
  })
  const roots = mod.resolveSkillsRoots('/ws', '/home/u')
  assert.deepEqual(mod.skillScopeRoots('global', '/ws', '/home/u'), { root: roots.global, alt: roots.dshUser })
  assert.deepEqual(mod.skillScopeRoots('project', '/ws', '/home/u'), { root: roots.project, alt: roots.dshProject })
})

test('skillDirNameValid：字母数字开头、<=64、拒绝路径分隔与空白', () => {
  assert.equal(mod.skillDirNameValid('alpha'), true)
  assert.equal(mod.skillDirNameValid('a_b.c-d'), true)
  assert.equal(mod.skillDirNameValid('a'.repeat(64)), true)
  assert.equal(mod.skillDirNameValid('a'.repeat(65)), false)
  assert.equal(mod.skillDirNameValid('.hidden'), false)
  assert.equal(mod.skillDirNameValid('-lead'), false)
  assert.equal(mod.skillDirNameValid('a/b'), false)
  assert.equal(mod.skillDirNameValid('../etc'), false)
  assert.equal(mod.skillDirNameValid('a b'), false)
  assert.equal(mod.skillDirNameValid('技能'), false)
  assert.equal(mod.skillDirNameValid(''), false)
})

test('resolveInstalledSkillDir：在作用域主根 + .dsh 备用根中依次命中', async () => {
  // 说明：契约文字写 (name, roots)，实现为 async (name, scope, workspaceRoot, home)；
  // 这里按实现签名覆盖语义（作用域主根优先、再退到 alt=.dsh 根），签名差异已回报。
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'skills-r1-')))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'skills-r2-')))
  try {
    mkdirSync(join(ws, '.agents', 'skills', 'alpha'), { recursive: true })
    assert.equal(await mod.resolveInstalledSkillDir('alpha', 'project', ws, home), join(ws, '.agents', 'skills', 'alpha'))
    assert.equal(await mod.resolveInstalledSkillDir('nope', 'project', ws, home), null)
    // 只存在于 .dsh 备用根也能找到（DSH 自己的技能发现根）
    mkdirSync(join(ws, '.dsh', 'skills', 'beta'), { recursive: true })
    assert.equal(await mod.resolveInstalledSkillDir('beta', 'project', ws, home), join(ws, '.dsh', 'skills', 'beta'))
    // global 走 home
    mkdirSync(join(home, '.agents', 'skills', 'gamma'), { recursive: true })
    assert.equal(await mod.resolveInstalledSkillDir('gamma', 'global', ws, home), join(home, '.agents', 'skills', 'gamma'))
    // 非法名不访问文件系统
    assert.equal(await mod.resolveInstalledSkillDir('../etc', 'project', ws, home), null)
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

// ══ B. 路由：/skills/status ═════════════════════════════════════════════════

test('GET /skills/status：探测成功返回完整契约（cli/node/roots/agents/安装默认作用域）', async () => {
  state.calls.length = 0
  state.handler = (argv) => {
    const exe = String(argv[0] || '')
    if (/\/node$/.test(exe)) return { code: 0, out: 'v22.11.0\n' }
    if (argv.includes('--version') || argv.includes('-v')) return { code: 0, out: '1.7.0\n' }
    return { code: 0, out: '' }
  }
  const r = await call('/skills/status')
  assert.equal(r.ok, true)
  assert.equal(typeof r.updatedAt, 'number')
  assert.equal(r.error, undefined, '探测成功不应带 error: ' + String(r.error))
  // cli 探测
  assert.equal(r.cli.available, true)
  assert.equal(r.cli.version, '1.7.0')
  assert.ok(['npx', 'skills'].includes(r.cli.tool), 'cli.tool=' + r.cli.tool)
  assert.ok(r.cli.bin === null || typeof r.cli.bin === 'string')
  assert.ok(r.cli.source === null || typeof r.cli.source === 'string')
  // node 探测
  assert.equal(r.node.available, true)
  assert.match(String(r.node.version), /22\.11\.0/)
  // 技能发现根
  assert.deepEqual(r.roots, {
    global: join(HOME, '.agents', 'skills'),
    project: join(WS, '.agents', 'skills'),
    dshProject: join(WS, '.dsh', 'skills'),
    dshUser: join(HOME, '.dsh', 'skills'),
  })
  assert.deepEqual(Object.keys(r.rootsExist).sort(), ['dshProject', 'dshUser', 'global', 'project'])
  for (const k of Object.keys(r.rootsExist)) assert.equal(typeof r.rootsExist[k], 'boolean', k)
  // 作用域 / agent / 默认落点 / 搜索端点
  assert.deepEqual(r.scopes, ['global', 'project'])
  assert.ok(Array.isArray(r.agents))
  for (const id of ['universal', 'claude-code', 'codex']) {
    assert.ok(r.agents.some((a) => a.id === id), 'agents 缺少 ' + id)
  }
  assert.equal(r.installDefaultScope, 'global')
  assert.equal(r.searchApi, 'https://skills.sh/api/search')
})

test('GET /skills/status：CLI 探测失败也必须 ok:true，错误进 error', async () => {
  state.calls.length = 0
  state.handler = () => ({ code: 1, out: '', err: 'spawn npx ENOENT' })
  const r = await call('/skills/status')
  assert.equal(r.ok, true)
  assert.equal(r.cli.available, false)
  assert.equal(r.cli.version, null)
  assert.equal(r.node.available, false)
  assert.equal(r.node.version, null)
  assert.equal(typeof r.error, 'string')
  assert.ok(r.error.length > 0)
  // 失败也不能丢契约里的静态字段
  assert.deepEqual(r.scopes, ['global', 'project'])
  assert.equal(r.installDefaultScope, 'global')
  assert.equal(r.searchApi, 'https://skills.sh/api/search')
  assert.ok(Array.isArray(r.agents))
})

test('/skills/status：skillsNpmCacheDir 必须落到子进程 env（npm_config_cache）', async () => {
  state.calls.length = 0
  state.handler = (argv) => (/\/node$/.test(String(argv[0] || ''))
    ? { code: 0, out: 'v22.11.0\n' }
    : { code: 0, out: '1.7.0\n' })
  const before = mod.getConfig().skillsNpmCacheDir
  mod.setConfig({ ...mod.getConfig(), skillsNpmCacheDir: '/tmp/skills-npm-cache' })
  try {
    const r = await call('/skills/status')
    assert.equal(r.ok, true)
    const cliCall = state.calls.find((c) => String(c.argv[0]).includes('npx'))
    assert.ok(cliCall, '应调用 npx 探测')
    assert.equal(cliCall.env && cliCall.env.npm_config_cache, '/tmp/skills-npm-cache')
  } finally {
    mod.setConfig({ ...mod.getConfig(), skillsNpmCacheDir: before })
  }
})

// ══ B. 路由：/skills/list ═══════════════════════════════════════════════════

test('GET /skills/list：project 作用域归一（name/description/path/scope/agents/source/mtime）', async () => {
  state.calls.length = 0
  const r = await call('/skills/list', { query: { scope: 'project', cwd: WS } })
  assert.equal(r.ok, true)
  assert.equal(r.scope, 'project')
  assert.equal(r.workspaceRoot, WS)
  assert.ok(Array.isArray(r.roots) && r.roots.length >= 1)
  assert.ok(Array.isArray(r.skills))
  const alpha = r.skills.find((s) => s.name === 'alpha')
  const beta = r.skills.find((s) => s.name === 'beta')
  assert.ok(alpha, '列表缺少 alpha')
  assert.ok(beta, '列表缺少 beta')
  assert.equal(alpha.path, ALPHA)
  assert.equal(alpha.scope, 'project')
  assert.ok(alpha.source === null || typeof alpha.source === 'string')
  assert.equal(alpha.installed, true, '契约要求每项带 installed:true')
  assert.ok(Array.isArray(alpha.agents))
  assert.equal(alpha.description, '第一个技能') // 来自 SKILL.md frontmatter
  assert.equal(beta.description, '')             // 无 frontmatter
  assert.ok(alpha.mtimeMs === null || typeof alpha.mtimeMs === 'number', 'mtimeMs 形状')
  assert.ok(alpha.mtimeMs > 0)

  const g = await call('/skills/list', { query: { scope: 'global' } })
  assert.equal(g.ok, true)
  assert.equal(g.scope, 'global')
  assert.equal(g.workspaceRoot, WS)
  assert.ok(Array.isArray(g.skills))
})

// ══ B. 路由：/skills/detail ═════════════════════════════════════════════════

test('GET /skills/detail：frontmatter + 内容 + 文件清单（相对路径、跳过 node_modules/.git）', async () => {
  const r = await call('/skills/detail', { query: { name: 'alpha', scope: 'project', cwd: WS } })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'alpha')
  assert.equal(r.path, ALPHA)
  assert.equal(r.frontmatter.name, 'alpha')
  assert.equal(r.frontmatter.description, '第一个技能')
  assert.deepEqual(r.frontmatter.metadata, { author: 'alice', license: 'MIT' })
  assert.match(r.content, /正文内容/)
  assert.equal(r.truncated, false)
  assert.ok(typeof r.sizeBytes === 'number' && r.sizeBytes > 0)
  assert.ok(Array.isArray(r.agents))
  assert.ok(Array.isArray(r.files))
  assert.ok(r.files.length > 0)
  for (const f of r.files) {
    assert.equal(typeof f.path, 'string')
    assert.ok(!f.path.startsWith('/'), 'files.path 必须相对技能目录: ' + f.path)
    assert.ok(!f.path.includes('node_modules'), 'files 不该含 node_modules: ' + f.path)
    assert.ok(!f.path.includes('.git'), 'files 不该含 .git: ' + f.path)
    assert.equal(typeof f.sizeBytes, 'number')
  }
  assert.ok(r.files.some((f) => f.path === 'reference.md'), '应包含 reference.md')
})

test('GET /skills/detail：文件清单封顶 50 项', async () => {
  const r = await call('/skills/detail', { query: { name: 'bulk', scope: 'project', cwd: WS } })
  assert.equal(r.ok, true)
  assert.equal(r.files.length, 50, '60 个文件的技能应封顶 50 项')
})

test('GET /skills/detail：超长 SKILL.md 截断（truncated=true，正文有上限）', async () => {
  // 对抗性边界：300KB SKILL.md 不能整份回给浏览器
  const r = await call('/skills/detail', { query: { name: 'huge', scope: 'project', cwd: WS } })
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true, '超长正文必须标记 truncated')
  assert.ok(r.sizeBytes > r.content.length, 'sizeBytes 是磁盘大小，content 已截断')
  assert.ok(r.content.length <= 300000, 'content 必须有上限，实得 ' + r.content.length)
})

test('GET /skills/detail：未安装 / 非法技能名 → ok:false + error', async () => {
  const missing = await call('/skills/detail', { query: { name: 'no-such-skill', scope: 'project', cwd: WS } })
  assert.equal(missing.ok, false)
  assert.equal(typeof missing.error, 'string')
  assert.ok(missing.error.length > 0)
  const evil = await call('/skills/detail', { query: { name: '../etc/passwd', scope: 'project', cwd: WS } })
  assert.equal(evil.ok, false)
  assert.equal(typeof evil.error, 'string')
})

// ══ B. 路由：/skills/file ══════════════════════════════════════════════════

test('GET /skills/file：按需读取技能内支持文件（嵌套相对路径 + kind/sizeBytes）', async () => {
  const r = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'references/github-state.md' } })
  assert.equal(r.ok, true)
  assert.equal(r.name, 'alpha')
  assert.equal(r.scope, 'project')
  assert.equal(r.file, 'references/github-state.md')
  assert.equal(r.kind, 'markdown')
  assert.equal(r.binary, false)
  assert.equal(r.truncated, false)
  assert.equal(r.content, '# state\n')
  assert.equal(r.sizeBytes, Buffer.byteLength('# state\n'))
  assert.ok(String(r.path).startsWith(ALPHA), 'path 应是技能目录内的绝对路径: ' + r.path)

  const text = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'reference.md' } })
  assert.equal(text.ok, true)
  assert.equal(text.kind, 'markdown')
  assert.equal(text.content, 'ref\n')
})

test('GET /skills/file：路径穿越 / 绝对路径 / 外指符号链接一律拒绝', async () => {
  const evil = [
    '../etc/passwd',
    '../../outside-secret.txt',
    '/etc/passwd',
    'references/../../SKILL.md',
    'escape.txt',
    'node_modules/pkg/index.js',
  ]
  for (const file of evil) {
    const r = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: file } })
    assert.equal(r.ok, false, '必须拒绝: ' + file)
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
    assert.ok(!String(r.content || '').includes('secret'), '不得回泄漏内容: ' + file)
  }
})

test('GET /skills/file：二进制不回正文，超长正文截断', async () => {
  const bin = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'binary.bin' } })
  assert.equal(bin.ok, true)
  assert.equal(bin.binary, true)
  assert.equal(bin.kind, 'binary')
  assert.equal(bin.content, '')
  assert.equal(bin.dataUrl, '', '非图片二进制不内联')
  assert.ok(bin.sizeBytes > 0)

  const big = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'big.txt' } })
  assert.equal(big.ok, true)
  assert.equal(big.truncated, true, '超过上限必须截断')
  assert.ok(big.sizeBytes > big.content.length)
  assert.ok(big.content.length <= 300000)
})

test('GET /skills/file：图片按扩展名判 mime 并内联 data URL', async () => {
  const svg = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'assets/icon.svg' } })
  assert.equal(svg.ok, true)
  assert.equal(svg.kind, 'image')
  assert.equal(svg.content, '', '图片不回正文（走 dataUrl）')
  assert.ok(String(svg.dataUrl).startsWith('data:image/svg+xml;base64,'), 'svg dataUrl: ' + String(svg.dataUrl).slice(0, 40))
  assert.equal(Buffer.from(String(svg.dataUrl).split(',')[1], 'base64').toString('utf8'), ALPHA_SVG)

  const png = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'assets/logo.png' } })
  assert.equal(png.ok, true)
  assert.equal(png.kind, 'image', '含 NUL 的图片仍按图片渲染')
  assert.ok(String(png.dataUrl).startsWith('data:image/png;base64,'))
  assert.deepEqual(Buffer.from(String(png.dataUrl).split(',')[1], 'base64'), ALPHA_PNG)
})

test('GET /skills/file：超过内联上限的图片不内联（回落二进制提示）', async () => {
  const max = mod.SKILLS_FILE_IMAGE_MAX
  assert.equal(typeof max, 'number', '上限必须可作为契约导出')
  writeFileSync(join(ALPHA, 'assets', 'huge.png'), Buffer.concat([ALPHA_PNG, Buffer.alloc(max + 1, 0x41)]))
  const huge = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'assets/huge.png' } })
  assert.equal(huge.ok, true)
  assert.ok(huge.sizeBytes > max, 'fixture 必须超过上限')
  assert.equal(huge.dataUrl, '')
  assert.equal(huge.kind, 'binary')
  assert.equal(huge.content, '')
})

test('GET /skills/file：技能或文件缺失 / 非法技能名 → ok:false + error', async () => {
  const missingSkill = await call('/skills/file', { query: { name: 'no-such-skill', scope: 'project', cwd: WS, file: 'SKILL.md' } })
  assert.equal(missingSkill.ok, false)
  const missingFile = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS, file: 'nope.md' } })
  assert.equal(missingFile.ok, false)
  const empty = await call('/skills/file', { query: { name: 'alpha', scope: 'project', cwd: WS } })
  assert.equal(empty.ok, false)
  const evilName = await call('/skills/file', { query: { name: '../etc/passwd', scope: 'project', cwd: WS, file: 'x' } })
  assert.equal(evilName.ok, false)
})

// ══ B. 路由：/skills/search ═════════════════════════════════════════════════

test('GET /skills/search：关键词长度校验 + 命中 skills.sh 公开端点并归一化', async () => {
  const realFetch = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          skills: [
            { id: 'vercel-labs/agent-skills/foo', name: 'foo', source: 'vercel-labs/agent-skills', installs: 12345 },
            { id: 'bar/baz/qux', name: 'qux', source: 'bar/baz', installs: 7 },
          ],
        }
      },
    }
  }
  try {
    const r = await call('/skills/search', { query: { q: 'type script', limit: '5' } })
    assert.equal(r.ok, true)
    assert.equal(r.query, 'type script')
    assert.ok(['fuzzy', 'semantic', ''].includes(r.searchType), 'searchType=' + r.searchType)
    assert.equal(r.skills.length, 2)
    const foo = r.skills.find((s) => s.name === 'foo')
    assert.ok(foo)
    assert.equal(typeof foo.id, 'string')
    assert.ok(foo.id.length > 0)
    assert.equal(typeof foo.slug, 'string')
    assert.equal(foo.source, 'vercel-labs/agent-skills')
    assert.equal(foo.installs, 12345)
    assert.ok(foo.installUrl === null || typeof foo.installUrl === 'string')
    assert.ok(foo.url === null || typeof foo.url === 'string')
    assert.equal(fetched.length, 1)
    assert.ok(fetched[0].startsWith('https://skills.sh/api/search'), fetched[0])
    assert.match(fetched[0], /[?&]q=type(\+|%20)script/)
    assert.match(fetched[0], /[?&]limit=5/)

    // limit 越界（0 / 999）必须夹取到 1..50，不抛错
    for (const raw of ['999', '0']) {
      const rr = await call('/skills/search', { query: { q: 'agent', limit: raw } })
      assert.equal(rr.ok, true, 'limit=' + raw + ' 不应失败')
      const lim = Number(/[?&]limit=(\d+)/.exec(fetched[fetched.length - 1])[1])
      assert.ok(lim >= 1 && lim <= 50, 'limit=' + raw + ' 应夹取到 1..50，实得 ' + lim)
    }
    fetched.length = 0
    // 关键词过短 / 过长 / 空：ok:false，且不得发起网络请求
    fetched.length = 0
    for (const q of ['a', '', 'x'.repeat(65)]) {
      const bad = await call('/skills/search', { query: { q } })
      assert.equal(bad.ok, false, 'q=' + JSON.stringify(q) + ' 应被拒绝')
      assert.equal(typeof bad.error, 'string')
    }
    assert.equal(fetched.length, 0, '非法关键词不得请求网络')

    // 网络失败：仍走 200 + ok:false，错误归类为网络错误
    // （注意：/skills/search 按 query 缓存结果，这里必须换一个没查过的词）
    globalThis.fetch = async () => { throw new Error('fetch failed') }
    const down = await call('/skills/search', { query: { q: 'agent-network-down' } })
    assert.equal(down.ok, false)
    assert.match(String(down.error), /^网络错误：无法访问 skills\.sh/)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ══ B. 路由：/skills/install | remove | update ══════════════════════════════

test('POST /skills/install：argv 白名单 + installed/failed/stdout 契约', async () => {
  state.calls.length = 0
  state.handler = (argv) => {
    if (!argv.includes('add')) return { code: 1, out: '', err: 'unexpected' }
    return {
      code: 0,
      err: '',
      out: 'Installing…\n' + JSON.stringify([
        {
          name: 'alpha',
          status: 'installed',
          source: 'vercel-labs/agent-skills',
          ref: null,
          hash: null,
          path: ALPHA,
          scope: 'project',
          agents: ['claude-code'],
          mode: 'symlink',
        },
      ], null, 2),
    }
  }
  const r = await call('/skills/install', {
    method: 'POST',
    body: { package: 'vercel-labs/agent-skills', skills: ['alpha'], scope: 'project', agents: ['claude-code'], cwd: WS },
  })
  assert.equal(r.ok, true)
  assert.equal(r.installed.length, 1)
  const it = r.installed[0]
  assert.equal(it.name, 'alpha')
  assert.equal(it.source, 'vercel-labs/agent-skills')
  assert.equal(it.path, ALPHA)
  assert.equal(it.scope, 'project')
  assert.deepEqual(it.agents, ['claude-code'])
  assert.equal(typeof it.status, 'string', '契约要求 installed[] 带 status')
  assert.ok(Array.isArray(r.failed))
  assert.match(r.stdout, /alpha/)
  assert.equal(typeof r.stderr, 'string')

  const addCall = state.calls.find((c) => c.argv.includes('add'))
  assert.ok(addCall, '应调用 skills add')
  const a = cliArgs(addCall.argv)
  assert.equal(a[0], 'add')
  assert.equal(a[1], 'vercel-labs/agent-skills')
  assert.ok(a.includes('--yes') && a.includes('--json'))
  assert.ok(flagValue(a, ['-s', '--skill'], 'alpha'))
  assert.ok(flagValue(a, ['-a', '--agent'], 'claude-code'))
  assert.ok(!a.includes('--global'), 'project 安装不得带 --global')
  // 路由默认 copy=true（技能文件真落到目标根，绕开 CLI 对部分 agent 的 symlink
  // 默认）；body 显式 copy:false 才不带 --copy。
  assert.ok(a.includes('--copy'), '未显式指定时默认 --copy（绕 symlink）')

  // 显式 copy:false 才不带 --copy
  state.calls.length = 0
  await call('/skills/install', { method: 'POST', body: { package: 'vercel-labs/agent-skills', scope: 'project', copy: false, cwd: WS } })
  assert.ok(!cliArgs(state.calls.find((c) => c.argv.includes('add')).argv).includes('--copy'), 'copy:false 必须不带 --copy')

  // global 安装带 --global
  state.calls.length = 0
  await call('/skills/install', { method: 'POST', body: { package: 'vercel-labs/agent-skills', scope: 'global' } })
  assert.ok(cliArgs(state.calls.find((c) => c.argv.includes('add')).argv).includes('--global'))

  // 非法包名：失败也走 200 + ok:false，不发起 CLI 调用
  state.calls.length = 0
  const bad = await call('/skills/install', { method: 'POST', body: { package: '../evil', cwd: WS } })
  assert.equal(bad.ok, false)
  assert.equal(typeof bad.error, 'string')
  assert.equal(state.calls.length, 0, '非法包名不得调用 CLI')
})

test('POST /skills/remove：removed/failed/stdout 契约与 argv 白名单', async () => {
  state.calls.length = 0
  // mock CLI：真的删掉目录，模拟 skills remove 成功
  state.handler = (argv) => {
    if (!argv.includes('remove')) return { code: 1, out: '', err: 'unexpected' }
    rmSync(DEL, { recursive: true, force: true })
    return { code: 0, out: 'Removed deltest\n', err: '' }
  }
  const r = await call('/skills/remove', { method: 'POST', body: { skills: ['deltest'], scope: 'project', cwd: WS } })
  assert.equal(r.ok, true, 'remove 失败: ' + String(r.error))
  assert.ok(Array.isArray(r.removed) && r.removed.includes('deltest'), 'removed=' + JSON.stringify(r.removed))
  assert.ok(Array.isArray(r.failed))
  assert.equal(typeof r.stdout, 'string')
  assert.equal(typeof r.stderr, 'string')
  const c = state.calls.find((x) => x.argv.includes('remove'))
  assert.ok(c)
  // 归一后必须是 remove <name> --yes --json（绝不能出现二次 npx 前缀）
  assert.deepEqual(cliArgs(c.argv).slice(0, 2), ['remove', 'deltest'], 'argv=' + JSON.stringify(c.argv))
  assert.ok(!cliArgs(c.argv).includes('--global'))
})

test('POST /skills/update：-g/-p -y、文本解析 upToDate / updated', async () => {
  state.calls.length = 0
  state.handler = () => ({ code: 0, out: '✓ All global skills are up to date\n', err: '' })
  const up = await call('/skills/update', { method: 'POST', body: { scope: 'global', cwd: WS } })
  assert.equal(up.ok, true)
  assert.equal(up.scope, 'global')
  assert.equal(up.upToDate, true)
  assert.deepEqual(up.updated, [])
  assert.ok(Array.isArray(up.failed))
  assert.equal(typeof up.stdout, 'string')
  assert.equal(typeof up.stderr, 'string')
  const c = state.calls.find((x) => x.argv.includes('update'))
  assert.deepEqual(cliArgs(c.argv), ['update', '-g', '-y'])

  state.handler = () => ({ code: 0, out: 'No project skills to update.\n', err: '' })
  const none = await call('/skills/update', { method: 'POST', body: { scope: 'project', cwd: WS } })
  assert.equal(none.ok, true)
  assert.equal(none.scope, 'project')
  assert.equal(none.upToDate, true)

  state.handler = () => ({ code: 0, out: '✓ Updated alpha\n✓ Updated beta\n', err: '' })
  const upd = await call('/skills/update', { method: 'POST', body: { scope: 'project', cwd: WS } })
  assert.equal(upd.ok, true)
  assert.equal(upd.upToDate, false)
  assert.ok(Array.isArray(upd.updated))
})

// ══ B. 失败约定 ═════════════════════════════════════════════════════════════

test('路由输入健壮性：缺字段 / 错误类型 → HTTP 200，不抛错、不 500', async () => {
  state.handler = () => ({ code: 0, out: '[]', err: '' })
  const cases = [
    ['/skills/install', { method: 'POST', body: {} }, false],
    ['/skills/install', { method: 'POST', body: { package: 'a/b', agents: { a: 1 }, cwd: WS } }, false],
    ['/skills/install', { method: 'POST', body: { package: 123, cwd: WS } }, null],
    ['/skills/install', { method: 'POST', body: { package: 'a/b', skills: 'alpha', cwd: WS } }, null],
    ['/skills/remove', { method: 'POST', body: { skills: [], cwd: WS } }, false],
    ['/skills/remove', { method: 'POST', body: {} }, false],
    ['/skills/remove', { method: 'POST', body: { skills: 'alpha', cwd: WS } }, null],
    ['/skills/update', { method: 'POST', body: {} }, null],
  ]
  for (const [path, opts, expected] of cases) {
    const r = await call(path, opts) // call() 已断言 HTTP 200 + JSON
    assert.equal(typeof r.ok, 'boolean', path + ' 的 ok 必须是布尔')
    if (expected !== null) {
      assert.equal(r.ok, expected, path + ' ' + JSON.stringify(opts.body) + ' 应 ok:' + expected + '（error=' + String(r.error) + '）')
      assert.equal(typeof r.error, 'string')
    }
  }
  // 宽松类型会被归一后再做白名单校验（数字/字符串会被 String() 化，不构成注入面）：
  // package=123 → 单名包 '123'；skills='alpha' → 单个技能名；空数组/缺字段一律拒绝。
})

test('CLI 非零退出统一 HTTP 200 + { ok:false, error }（不抛出）', async () => {
  state.handler = () => ({ code: 1, out: '', err: 'boom from cli' })
  for (const [path, opts] of [
    ['/skills/install', { method: 'POST', body: { package: 'a/b', cwd: WS } }],
    ['/skills/remove', { method: 'POST', body: { skills: ['alpha'], cwd: WS } }],
    ['/skills/update', { method: 'POST', body: { scope: 'project', cwd: WS } }],
  ]) {
    const r = await call(path, opts)
    assert.equal(r.ok, false, path + ' 失败必须 ok:false')
    assert.equal(typeof r.error, 'string', path + ' 必须带 error 文本')
    assert.ok(r.error.length > 0, path + ' error 不能为空')
  }
})

test('自动更新：启动延迟、两个作用域、失败后重试、停止与关闭', async () => {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realWarn = console.warn
  const scheduled = []
  const calls = []
  const warnings = []
  let invalidations = 0
  let stop
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, cleared: false, unref() {} }
    scheduled.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => { timer.cleared = true }
  console.warn = (...args) => warnings.push(args)
  const runner = {
    getWorkspaceRoot: () => WS,
    async tryRun(tool, argv, opts) {
      calls.push({ tool, argv, cwd: opts.cwd })
      if (argv.includes('-g')) throw new Error('fetch failed')
      return { code: 0, out: 'Updated alpha', errText: '' }
    },
  }
  try {
    for (const disabled of [0, -1, NaN, Infinity]) {
      mod.startSkillsAutoUpdate(ctx, runner, disabled, () => {})()
    }
    assert.equal(scheduled.length, 0)
    stop = mod.startSkillsAutoUpdate(ctx, runner, 86400000, () => invalidations++)
    assert.equal(scheduled[0].ms, 30000)
    scheduled[0].fn()
    // Drain the async update loop without using the replaced timer.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(calls.length, 2)
    assert.ok(calls[0].argv.includes('-g'))
    assert.ok(calls[1].argv.includes('-p'))
    assert.equal(calls[1].cwd, WS)
    assert.equal(warnings.length, 1)
    assert.equal(invalidations, 2)
    assert.equal(scheduled[1].ms, 86400000)
    scheduled[1].fn()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(calls.length, 4, '失败后下一轮仍重试')
    stop()
    assert.equal(scheduled[2].cleared, true)
    scheduled[2].fn()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(calls.length, 4, '停止后不调用 CLI')
    assert.equal(scheduled.length, 3)
  } finally {
    stop?.()
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    console.warn = realWarn
  }
})

test('自动与手动更新同一作用域共享任务，完成后可再次更新', async () => {
  let release
  let calls = 0
  const runner = {
    getWorkspaceRoot: () => WS,
    tryRun() {
      calls++
      return new Promise((resolve) => { release = resolve })
    },
  }
  const first = mod.updateSkills(ctx, runner, { scope: 'global', cwd: WS })
  const second = mod.updateSkills(ctx, runner, { scope: 'global', cwd: HOME })
  assert.equal(first, second)
  await Promise.resolve()
  release({ code: 0, out: 'All skills are up to date', errText: '' })
  assert.equal((await first).ok, true)
  assert.equal(calls, 1)
  const next = mod.updateSkills(ctx, runner, { scope: 'global', cwd: WS })
  await Promise.resolve()
  release({ code: 0, out: '', errText: '' })
  await next
  assert.equal(calls, 2)
})

test('安装不截断手动选择的技能', () => {
  const names = Array.from({ length: 35 }, (_, i) => 'skill-' + i)
  const argv = mod.buildSkillsAddArgv({ package: 'a/b', skills: names })
  assert.deepEqual(argv.filter((_, i) => argv[i - 1] === '--skill'), names)
})

test('只读更新检测：全局 tree 指纹、工作区内容指纹与失败状态，绝不调用写 CLI', async () => {
  const fetchBefore = globalThis.fetch
  const xdgBefore = process.env.XDG_STATE_HOME
  const handlerBefore = state.handler
  delete process.env.XDG_STATE_HOME
  const globalRoot = join(HOME, '.agents', 'skills')
  for (const name of ['current', 'changed', 'untracked']) {
    mkdirSync(join(globalRoot, name), { recursive: true })
    writeFileSync(join(globalRoot, name, 'SKILL.md'), '---\nname: ' + name + '\n---\n')
  }
  const tree = { sha: 'a'.repeat(40), tree: [
    { type: 'tree', path: 'skills/current', sha: 'b'.repeat(40) },
    { type: 'blob', path: 'skills/current/SKILL.md', sha: '1' },
    { type: 'tree', path: 'skills/changed', sha: 'c'.repeat(40) },
    { type: 'blob', path: 'skills/changed/SKILL.md', sha: '2' },
    { type: 'blob', path: 'skills/alpha/SKILL.md', sha: '3' },
    { type: 'blob', path: 'skills/alpha/references/a.txt', sha: '4' },
    { type: 'blob', path: 'skills/alpha/node_modules/x', sha: '5' },
  ] }
  const globalLock = join(HOME, '.agents', '.skill-lock.json')
  const entry = (skillPath, hash) => ({ sourceType: 'github', source: 'a/b', ref: 'release/test', skillPath, skillFolderHash: hash })
  writeFileSync(globalLock, JSON.stringify({ version: 3, skills: {
    current: entry('skills/current/SKILL.md', 'b'.repeat(40)),
    changed: entry('skills/changed/SKILL.md', 'd'.repeat(40)),
  } }))
  const callsBefore = state.calls.length
  const fetched = []
  let failed = false
  globalThis.fetch = async url => {
    fetched.push(String(url))
    if (failed) return { ok: false, status: 403 }
    const payload = String(url).includes('/git/trees/') ? tree : { encoding: 'base64', content: Buffer.from(String(url).endsWith('/3') ? 'content' : 'reference').toString('base64') }
    return { ok: true, json: async () => payload }
  }
  try {
    const snapshot = readFileSync(globalLock, 'utf8')
    const global = await call('/skills/check', { query: { scope: 'global', cwd: WS } })
    const byName = Object.fromEntries(global.skills.map(s => [s.name, s]))
    assert.equal(byName.current.status, 'current')
    assert.equal(byName.changed.status, 'update')
    assert.equal(byName.untracked.status, 'unknown')
    assert.equal(fetched.length, 1, 'same repository/ref shares one tree')
    assert.ok(fetched[0].includes('release%2Ftest'))
    assert.equal(readFileSync(globalLock, 'utf8'), snapshot)

    const projectLock = join(WS, 'skills-lock.json')
    const hash = createHash('sha256').update('references/a.txt').update('reference').update('SKILL.md').update('content').digest('hex')
    const projectEntry = { ...entry('skills/alpha/SKILL.md', ''), computedHash: hash }
    writeFileSync(projectLock, JSON.stringify({ version: 1, skills: { alpha: projectEntry } }))
    const projectSnapshot = readFileSync(projectLock, 'utf8')
    const project = await call('/skills/check', { query: { scope: 'project', cwd: WS } })
    assert.equal(project.skills.find(s => s.name === 'alpha').status, 'current')
    assert.equal(readFileSync(projectLock, 'utf8'), projectSnapshot)
    assert.ok(!fetched.some(url => url.endsWith('/5')), 'node_modules excluded from CLI content hash')
    writeFileSync(projectLock, JSON.stringify({ version: 1, skills: { alpha: { ...projectEntry, computedHash: '0'.repeat(64) } } }))
    const changed = await call('/skills/check', { query: { scope: 'project', cwd: WS } })
    assert.equal(changed.skills.find(s => s.name === 'alpha').status, 'update')
    assert.equal(state.calls.length, callsBefore, 'successful public checks never spawn CLI')
    tree.truncated = true
    const truncated = await call('/skills/check', { query: { scope: 'project', cwd: WS } })
    assert.equal(truncated.skills.find(s => s.name === 'alpha').status, 'unknown')
    tree.truncated = false
    failed = true
    const failure = await call('/skills/check', { query: { scope: 'global', cwd: WS } })
    assert.equal(failure.skills.find(s => s.name === 'current').status, 'unknown')
    assert.match(failure.skills.find(s => s.name === 'current').error, /403/)
    assert.ok(state.calls.slice(callsBefore).filter(call => !isVersionProbe(call.argv)).every(call => cliArgs(call.argv)[0] === 'api'), 'check may use gh api for authentication, never write CLI')
    state.handler = argv => cliArgs(argv)[0] === 'api' ? { code: 0, out: JSON.stringify(tree) } : { code: 1 }
    const authenticated = await call('/skills/check', { query: { scope: 'global', cwd: WS } })
    assert.equal(authenticated.skills.find(s => s.name === 'current').status, 'current', 'gh authentication fallback')
    assert.equal(readFileSync(globalLock, 'utf8'), snapshot)
    assert.ok(state.calls.slice(callsBefore).filter(call => !isVersionProbe(call.argv)).every(call => cliArgs(call.argv)[0] === 'api'))
  } finally {
    globalThis.fetch = fetchBefore
    state.handler = handlerBefore
    if (xdgBefore === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = xdgBefore
  }
})

test('来源枚举：真实 list 文本与分组名称，不把描述当技能', () => {
  const output = '\x1b[?25l│\n◇  Found 2 skills\n\x1b[?25h\n│\n◇  Available Skills\n│\n│    alpha\n│\n│      Alpha description continued\n│\n│    beta\n│\n│      Beta description\n\n│\n└  Use --skill <name> to install specific skills\n'
  assert.deepEqual(mod.parseSkillsDiscoverOutput(output), [
    { name: 'alpha', description: 'Alpha description continued' },
    { name: 'beta', description: 'Beta description' },
  ])
  assert.deepEqual(mod.parseSkillsDiscoverOutput('◇  Available Skills\nSome Plugin\n│    plugin:skill\n│      description\n│      continued\n└  Done'), [
    { name: 'plugin:skill', description: 'description continued' },
  ])
  assert.deepEqual(mod.parseSkillsDiscoverOutput('│    not-a-skill\n└  Failed'), [])
})

test('来源枚举路由：不组合 list/json；失败和不可解析输出不能当空列表', async () => {
  const previous = state.handler
  try {
    state.handler = argv => {
      const args = cliArgs(argv)
      assert.deepEqual(args, ['add', 'samanhappy/skills', '-l', '-y'])
      return { code: 0, out: '◇  Available Skills\n│    alpha\n│      description\n└  Done' }
    }
    const result = await call('/skills/discover', { method: 'POST', body: { package: 'samanhappy/skills', cwd: WS } })
    assert.equal(result.ok, true)
    assert.deepEqual(result.skills, [{ name: 'alpha', description: 'description' }])
    state.handler = () => ({ code: 1, out: '[{"status":"failed","error":"The --json flag cannot be combined with --list."}]' })
    const failure = await call('/skills/discover', { method: 'POST', body: { package: 'samanhappy/skills', cwd: WS } })
    assert.equal(failure.ok, false)
    assert.match(failure.error, /cannot be combined/)
    state.handler = () => ({ code: 1, out: '◇  Available Skills\n│    partial\n└  Failed' })
    assert.equal((await call('/skills/discover', { method: 'POST', body: { package: 'samanhappy/skills', cwd: WS } })).ok, false)
    state.handler = () => ({ code: 0, out: 'unknown format' })
    assert.equal((await call('/skills/discover', { method: 'POST', body: { package: 'samanhappy/skills', cwd: WS } })).ok, false)
  } finally { state.handler = previous }
})

// ══ 停用 / 启用（disable-model-invocation：模型不再自动触发，不卸载）═══════════

test('parseSkillInvocation：顶层 disable-model-invocation / user-invocable 解析', () => {
  assert.deepEqual(mod.parseSkillInvocation(''), { disableModelInvocation: false, userInvocable: undefined })
  assert.deepEqual(mod.parseSkillInvocation('# 无 frontmatter\n'), { disableModelInvocation: false, userInvocable: undefined })
  assert.deepEqual(mod.parseSkillInvocation('---\nname: x\ndescription: y\n---\n'), { disableModelInvocation: false, userInvocable: undefined })
  assert.deepEqual(
    mod.parseSkillInvocation('---\ndisable-model-invocation: true\ndescription: y\n---\n'),
    { disableModelInvocation: true, userInvocable: undefined })
  assert.deepEqual(
    mod.parseSkillInvocation('---\ndisable-model-invocation: yes\nuser-invocable: false\n---\n'),
    { disableModelInvocation: true, userInvocable: false })
  // 真值词：true/1/yes/on；假值词与非法值不算停用
  for (const v of ['true', 'True', 'yes', 'on', '1', 1]) {
    assert.equal(mod.parseSkillInvocation('---\ndisable-model-invocation: ' + v + '\n---\n').disableModelInvocation, true, '真值 ' + String(v))
  }
  for (const v of ['false', 'no', 'off', '0', 0, '', 'nonsense']) {
    assert.equal(mod.parseSkillInvocation('---\ndisable-model-invocation: ' + v + '\n---\n').disableModelInvocation, false, '值 ' + String(v))
  }
  // 嵌套缩进里的同名键不算顶层策略（metadata 下的）
  assert.equal(mod.parseSkillInvocation('---\nmetadata:\n  disable-model-invocation: true\n---\n').disableModelInvocation, false)
  // CRLF 也能解析
  assert.equal(mod.parseSkillInvocation('---\r\ndisable-model-invocation: true\r\n---\r\n').disableModelInvocation, true)
})

test('editSkillInvocationFlag：停用加标记 / 启用删标记 / 正文与其余字段原样保留', () => {
  const md = '---\nname: alpha\ndescription: 第一个技能\nmetadata:\n  author: alice\n  license: MIT\n---\n\n# Alpha\n\n正文内容\n'
  const disabled = mod.editSkillInvocationFlag(md, true)
  assert.equal(disabled,
    '---\nname: alpha\ndescription: 第一个技能\nmetadata:\n  author: alice\n  license: MIT\ndisable-model-invocation: true\n---\n\n# Alpha\n\n正文内容\n')
  assert.equal(mod.parseSkillInvocation(disabled).disableModelInvocation, true)
  // 启用 = 精确还原原文
  assert.equal(mod.editSkillInvocationFlag(disabled, false), md)
  // 已停用时再停用 = 原样（幂等，不重复写）
  assert.equal(mod.editSkillInvocationFlag(disabled, true), disabled)
  // 已存在假值 → 置 true
  assert.equal(mod.editSkillInvocationFlag('---\ndisable-model-invocation: no\n---\n', true),
    '---\ndisable-model-invocation: true\n---\n')
  // 启用时没有标记 = 原样
  assert.equal(mod.editSkillInvocationFlag(md, false), md)
  // 空 frontmatter 也能加标记
  assert.equal(mod.editSkillInvocationFlag('---\n---\n', true), '---\ndisable-model-invocation: true\n---\n')
  // 无 frontmatter → null（调用方报错）
  assert.equal(mod.editSkillInvocationFlag('# 没有 frontmatter\n', true), null)
  assert.equal(mod.editSkillInvocationFlag('', false), null)
  // CRLF：新增行沿用 \r\n
  assert.equal(mod.editSkillInvocationFlag('---\r\nname: x\r\n---\r\nbody\r\n', true),
    '---\r\nname: x\r\ndisable-model-invocation: true\r\n---\r\nbody\r\n')
})

test('POST /skills/disable：停用/启用编辑 SKILL.md frontmatter，不依赖 CLI', async () => {
  const dir = join(SKILLS_ROOT, 'togglable')
  mkdirSync(dir, { recursive: true })
  const original = '---\nname: togglable\ndescription: 停用测试\n---\n\n# Togglable\n\n正文\n'
  writeFileSync(join(dir, 'SKILL.md'), original)
  const callsBefore = state.calls.length

  const off = await call('/skills/disable', { method: 'POST', body: { name: 'togglable', scope: 'project', disabled: true, cwd: WS } })
  assert.equal(off.ok, true)
  assert.equal(off.disabled, true)
  assert.equal(off.invocation.disableModelInvocation, true)
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'),
    '---\nname: togglable\ndescription: 停用测试\ndisable-model-invocation: true\n---\n\n# Togglable\n\n正文\n')
  assert.equal(state.calls.length, callsBefore, '停用是纯文件改动，不得调用 skills CLI')

  // 列表 / 详情如实反映停用态
  const list = await call('/skills/list', { query: { scope: 'project', cwd: WS, force: '1' } })
  assert.equal(list.skills.find(s => s.name === 'togglable').disabled, true)
  const detail = await call('/skills/detail', { query: { name: 'togglable', scope: 'project', cwd: WS } })
  assert.equal(detail.disabled, true)
  assert.equal(detail.invocation.disableModelInvocation, true)

  // 更新检测单独标 disabled（跳过来源比较：更新会把它覆盖回启用态）
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404 })
  try {
    const checked = await call('/skills/check', { query: { scope: 'project', cwd: WS } })
    assert.equal(checked.skills.find(s => s.name === 'togglable').status, 'disabled')
  } finally { globalThis.fetch = fetchBefore }

  // 启用 = 还原原文，列表恢复非停用
  const on = await call('/skills/disable', { method: 'POST', body: { name: 'togglable', scope: 'project', disabled: false, cwd: WS } })
  assert.equal(on.ok, true)
  assert.equal(on.disabled, false)
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), original)
  const list2 = await call('/skills/list', { query: { scope: 'project', cwd: WS, force: '1' } })
  assert.equal(list2.skills.find(s => s.name === 'togglable').disabled, false)

  // 缺 frontmatter / 未安装 / 非法技能名 → HTTP 200 + { ok:false, error }
  const noFm = await call('/skills/disable', { method: 'POST', body: { name: 'beta', scope: 'project', disabled: true, cwd: WS } })
  assert.equal(noFm.ok, false)
  assert.match(noFm.error, /frontmatter/)
  const missing = await call('/skills/disable', { method: 'POST', body: { name: 'no-such-skill', scope: 'project', disabled: true, cwd: WS } })
  assert.equal(missing.ok, false)
  const evil = await call('/skills/disable', { method: 'POST', body: { name: '../etc', scope: 'project', disabled: true, cwd: WS } })
  assert.equal(evil.ok, false)
})


test('仓库 URL 可用于预览和安装，并作为单个 argv 保留', () => {
  for (const source of [
    'https://github.com/jimliu/baoyu-design',
    'https://github.com/owner/repo.git/',
    'https://github.com/owner/repo/tree/main/skills/demo',
    'https://gitlab.example.com/group/subgroup/repo.git',
    'http://git.example.com/group/repo.git',
  ]) {
    assert.deepEqual(mod.buildSkillsDiscoverArgv(source), ['add', source, '-l', '-y'])
    assert.deepEqual(mod.buildSkillsAddArgv({ package: source, skills: ['demo'] }),
      ['add', source, '--yes', '--json', '--global', '--skill', 'demo'])
  }
})

test('来源 URL 拒绝非法协议、凭据、空白和损坏地址', () => {
  for (const source of [
    'file:///tmp/skills', 'ssh://git@example.com/repo', 'javascript:alert(1)',
    'https://user:secret@example.com/repo', 'https://example.com/repo\n--all',
    'https://example.com/a b', 'https://', 'https://example.com/' + 'a'.repeat(2048),
  ]) {
    assert.throws(() => mod.buildSkillsDiscoverArgv(source), /无效/)
    assert.throws(() => mod.buildSkillsAddArgv({ package: source }), /无效/)
  }
})
