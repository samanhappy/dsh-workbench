// Host-half contract for the AI commit message: the model catalog the picker
// shows, the saved route, the prompt, and the streamed answer.
//
// No Harness and no network: `apply()` is driven by a fake context whose `llm`
// service is a plain object, so the route seam is the only thing under test.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host/git/register.js'
import {
  MAX_AI_DIFF_CHARS,
  aiSettingsPath,
  buildCommitPrompt,
  clampDiff,
  describeAiError,
  normaliseGeneratedMessage,
  readAiSettings,
  writeAiSettings,
} from '../src/host/git/ai.js'

const DIFF_FIXTURE = ['diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')

function workspace() {
  return mkdtempSync(join(tmpdir(), 'dgt-ai-'))
}

function fakeLlm({ models = { magpie: [{ provider: 'magpie', id: 'auto/deepseek', name: 'DeepSeek' }] }, providers = null, stream } = {}) {
  const calls = []
  return {
    calls,
    listProviders() {
      const ids = providers ?? Object.keys(models)
      return ids.map((id) => ({ id, name: id.toUpperCase() }))
    },
    async listModels(provider) {
      if (provider === 'broken') throw new Error('catalog unavailable')
      return models[provider] ?? []
    },
    stream(options) {
      calls.push(options)
      return stream ? stream(options) : (async function* () {
        yield { type: 'text-delta', index: 0, text: 'feat: add ai commit message' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function fakeContext({ llm, root, defaultModel } = {}) {
  const routes = []
  const spawns = []
  const services = {
    sandboxPolicy: { workspaceRoot: root },
    subprocess: {
      async resolveExecutable(command) {
        assert.equal(command, 'git')
        return '/usr/local/bin/git'
      },
      spawn({ argv, cwd }) {
        spawns.push({ argv, cwd })
        const command = argv[1]
        let stdout = ''
        if (command === 'symbolic-ref') stdout = 'feat/ai\n'
        if (command === 'diff') stdout = DIFF_FIXTURE
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        }
      },
    },
    llm,
  }
  if (defaultModel) {
    services.agentDefaultModel = { currentSelection: () => defaultModel }
  }
  return {
    routes,
    spawns,
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    get: (service) => services[service],
  }
}

function request(path, { method = 'GET', body } = {}) {
  return {
    url: 'https://dsh.internal' + path,
    method,
    signal: undefined,
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return JSON.parse(JSON.stringify(body))
    },
  }
}

async function call(ctx, path, options) {
  const route = ctx.routes.find((item) => item.path === path.split('?')[0])
  assert.ok(route, 'route not registered: ' + path)
  const response = await route.fetch(request(path, options))
  return { response, body: await response.json() }
}

/** Run one test with DSH_HOME pointed at an empty directory. */
async function withHome(fn) {
  const home = workspace()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('prompt names the scope, lists the files and frames the diff as data', () => {
  const prompt = buildCommitPrompt({
    repoName: 'dsh-git-tree',
    branch: 'feat/ai',
    side: 'staged',
    files: [
      { path: 'src/host/ai.js', status: 'A' },
      { path: 'README.md', status: 'M' },
    ],
    diff: DIFF_FIXTURE,
    locale: 'en',
  })
  assert.match(prompt, /Repository: dsh-git-tree/)
  assert.match(prompt, /Branch: feat\/ai/)
  assert.match(prompt, /Scope: staged changes/)
  assert.ok(prompt.includes('- A src/host/ai.js'))
  assert.ok(prompt.includes('- M README.md'))
  assert.match(prompt, /<<<DIFF[\s\S]*\+b[\s\S]*DIFF>>>/)

  const zh = buildCommitPrompt({ repoName: 'r', branch: 'main', side: 'unstaged', files: [], diff: '', locale: 'zh-CN' })
  assert.match(zh, /范围：工作区改动/)
  assert.match(zh, /改动内容（数据）：/)
})

test('a diff longer than the budget is cut and says so', () => {
  const text = clampDiff('x'.repeat(MAX_AI_DIFF_CHARS + 100))
  assert.ok(text.startsWith('xxx'))
  assert.ok(text.length < MAX_AI_DIFF_CHARS + 200)
  assert.match(text, /diff truncated/)
  assert.equal(clampDiff('short'), 'short')
})

test('generated text loses fences, prefixes and quotes but keeps the body', () => {
  assert.equal(normaliseGeneratedMessage('```\nfix: parser\n\n- bound input\n```'), 'fix: parser\n\n- bound input')
  assert.equal(normaliseGeneratedMessage('  "feat: add ai"  '), 'feat: add ai')
  assert.equal(normaliseGeneratedMessage('Commit message: fix: x'), 'fix: x')
  assert.equal(normaliseGeneratedMessage('「提交信息：修复」'.replace('提交信息：', '')), '修复')
  assert.equal(normaliseGeneratedMessage('   '), '')
  assert.equal(normaliseGeneratedMessage('a\n\n\n\nb'), 'a\n\nb')
  assert.equal(normaliseGeneratedMessage('x'.repeat(5000)).length, 4000)
})

test('settings round-trip through the DSH home and tolerate a broken file', async () => {
  await withHome(async () => {
    assert.equal(readAiSettings(), null)
    assert.equal(writeAiSettings({ provider: 'magpie', model: 'auto/deepseek' }), true)
    assert.deepEqual(readAiSettings(), { provider: 'magpie', model: 'auto/deepseek' })
    assert.match(aiSettingsPath(), /git-tree\/ai-settings\.json$/)
    writeFileSync(aiSettingsPath(), '{ not json')
    assert.equal(readAiSettings(), null)
  })
})

test('model listing groups providers, skips non-text routes and keeps failures', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({
      providers: ['magpie', 'broken'],
      models: {
        magpie: [
          { provider: 'magpie', id: 'auto/deepseek', name: 'DeepSeek' },
          { provider: 'magpie', id: 'img-only', name: 'Image', inputModalities: ['image'] },
        ],
      },
    })
    const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
    apply(ctx)

    const { body } = await call(ctx, '/api/workbench/git/ai/models')
    assert.equal(body.ok, true)
    assert.deepEqual(body.groups.map((group) => group.id), ['magpie'])
    assert.deepEqual(body.groups[0].models.map((model) => model.id), ['auto/deepseek'])
    assert.equal(body.failures.length, 1)
    assert.equal(body.failures[0].id, 'broken')
    assert.deepEqual(body.default, { provider: 'magpie', model: 'auto/deepseek' })
    assert.equal(body.selected, null)
    assert.deepEqual(body.active, { provider: 'magpie', model: 'auto/deepseek', label: 'DeepSeek' })
    rmSync(root, { recursive: true, force: true })
  })
})

test('saving a model writes the file and refuses a route outside the catalog', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm()
    const ctx = fakeContext({ llm, root })
    apply(ctx)

    const saved = await call(ctx, '/api/workbench/git/ai/model', {
      method: 'POST',
      body: { provider: 'magpie', model: 'auto/deepseek' },
    })
    assert.equal(saved.body.ok, true)
    assert.deepEqual(readAiSettings(), { provider: 'magpie', model: 'auto/deepseek' })
    const stored = JSON.parse(readFileSync(aiSettingsPath(), 'utf8'))
    assert.deepEqual(stored, { provider: 'magpie', model: 'auto/deepseek' })

    const refused = await call(ctx, '/api/workbench/git/ai/model', {
      method: 'POST',
      body: { provider: 'magpie', model: 'made-up' },
    })
    assert.equal(refused.body.ok, false)
    assert.equal(refused.body.code, 'unknown-model')

    const invalid = await call(ctx, '/api/workbench/git/ai/model', { method: 'POST', body: { provider: 'magpie' } })
    assert.equal(invalid.body.ok, false)
    assert.equal(invalid.body.code, 'invalid-model')
    rmSync(root, { recursive: true, force: true })
  })
})

test('generation streams the saved route and returns a clean message', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '```\n' }
        yield { type: 'text-delta', index: 0, text: 'feat: ai commit message\n\n- add host route' }
        yield { type: 'text-delta', index: 0, text: '\n```' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const ctx = fakeContext({ llm, root })
    apply(ctx)
    writeAiSettings({ provider: 'magpie', model: 'auto/deepseek' })

    const { body } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: {
        side: 'staged',
        files: [{ path: 'src/app.js', status: 'M' }],
        locale: 'en',
      },
    })
    assert.equal(body.ok, true)
    assert.equal(body.message, 'feat: ai commit message\n\n- add host route')
    assert.equal(body.provider, 'magpie')
    assert.equal(body.model, 'auto/deepseek')

    const call1 = llm.calls[0]
    assert.equal(call1.provider, 'magpie')
    assert.equal(call1.model, 'auto/deepseek')
    assert.match(call1.system, /Git commit message/)
    assert.equal(call1.messages[0].role, 'user')
    assert.match(call1.messages[0].content[0].text, /- M src\/app\.js/)
    // The diff came from `git diff --cached`, not from the working tree.
    const diffSpawn = ctx.spawns.find((spawn) => spawn.argv[1] === 'diff')
    assert.ok(diffSpawn.argv.includes('--cached'))
    assert.ok(diffSpawn.argv.includes('--'))
    rmSync(root, { recursive: true, force: true })
  })
})

test('generation falls back to the DSH default model and maps provider failures', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'no key' } } }
      },
    })
    const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
    apply(ctx)

    const { body } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'unstaged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(body.ok, false)
    assert.equal(body.code, 'ai-auth-failed')
    assert.equal(llm.calls[0].provider, 'magpie')
    rmSync(root, { recursive: true, force: true })
  })
})

test('generation refuses without a route, without files, and without an LLM service', async () => {
  await withHome(async () => {
    const root = workspace()
    const ctx = fakeContext({ llm: fakeLlm({ models: {}, providers: [] }), root })
    apply(ctx)

    const noModel = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(noModel.body.code, 'no-model')

    const noFiles = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [] },
    })
    assert.equal(noFiles.body.code, 'no-files')

    const unsafe = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: '../etc/passwd', status: 'M' }] },
    })
    assert.equal(unsafe.body.ok, false)
    assert.equal(unsafe.response.status, 400)

    const noLlm = fakeContext({ llm: undefined, root })
    apply(noLlm)
    const unavailable = await call(noLlm, '/api/workbench/git/ai/models')
    assert.equal(unavailable.body.ok, false)
    assert.equal(unavailable.body.code, 'llm-unavailable')
    rmSync(root, { recursive: true, force: true })
  })
})

test('generation surfaces a model that returns nothing', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
    apply(ctx)
    const { body } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(body.ok, false)
    assert.equal(body.code, 'ai-empty')
    rmSync(root, { recursive: true, force: true })
  })
})

test('a default route the adapters no longer advertise is not offered as active', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm()
    const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'gone/model' } })
    apply(ctx)

    const { body } = await call(ctx, '/api/workbench/git/ai/models')
    assert.equal(body.ok, true)
    assert.equal(body.active, null, 'an unadvertised default must not be called')
    assert.deepEqual(body.default, { provider: 'magpie', model: 'gone/model' })

    const { body: generated } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(generated.ok, false)
    assert.equal(generated.code, 'no-model')
    rmSync(root, { recursive: true, force: true })
  })
})

test('a saved route that vanished from the catalog is reported as unknown', async () => {
  await withHome(async () => {
    const root = workspace()
    const ctx = fakeContext({ llm: fakeLlm(), root })
    apply(ctx)
    writeAiSettings({ provider: 'magpie', model: 'gone/model' })

    const { body } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(body.ok, false)
    assert.equal(body.code, 'unknown-model')
    rmSync(root, { recursive: true, force: true })
  })
})

test('a model that asks for a tool is refused, not smuggled in as text', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '(the model asked for a tool)' }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      },
    })
    const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
    apply(ctx)

    const { body } = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(body.ok, false)
    assert.equal(body.code, 'ai-tool-calls')
    rmSync(root, { recursive: true, force: true })
  })
})

test('provider failures map to messages a user can act on', () => {
  assert.equal(describeAiError('AUTH', '').code, 'ai-auth-failed')
  assert.equal(describeAiError('NO_CREDENTIALS', '').status, 409)
  assert.equal(describeAiError('RATE_LIMIT', '').status, 429)
  assert.equal(describeAiError('NO_ADAPTER', '').code, 'ai-model-unavailable')
  assert.equal(describeAiError('TIMEOUT', '').code, 'ai-timeout')
  assert.equal(describeAiError('WEIRD', 'provider said no').message, 'provider said no')
  assert.equal(describeAiError('', '').code, 'ai-failed')
})

test('a saved route on a provider whose catalog failed stays usable', async () => {
  await withHome(async () => {
    const root = workspace()
    const llm = fakeLlm({ providers: ['broken'], models: {} })
    const ctx = fakeContext({ llm, root })
    apply(ctx)
    writeAiSettings({ provider: 'broken', model: 'mystery-model' })

    const { body } = await call(ctx, '/api/workbench/git/ai/models')
    assert.equal(body.ok, true)
    assert.equal(body.failures.length, 1)
    assert.deepEqual(body.active, { provider: 'broken', model: 'mystery-model', label: 'mystery-model' })

    const generated = await call(ctx, '/api/workbench/git/commit-message', {
      method: 'POST',
      body: { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }] },
    })
    assert.equal(generated.body.ok, true)
    assert.equal(llm.calls[0].model, 'mystery-model')
    rmSync(root, { recursive: true, force: true })
  })
})

test('commit generation disables reasoning only when the model advertises off', async () => {
  await withHome(async () => {
    const root = workspace()
    try {
      for (const efforts of [[{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], [{ id: 'high', name: 'High' }]]) {
        const llm = fakeLlm({
          models: { magpie: [{ id: 'auto/deepseek', name: 'DeepSeek', reasoning: { efforts } }] },
          stream: async function* (options) {
            if (efforts.some(e => e.id === 'off') && options.reasoningEffort !== 'off') {
              yield { type: 'reasoning-delta', index: 0, text: 'Thinking' }
              yield { type: 'finish', reason: { kind: 'max-tokens' } }
              return
            }
            yield { type: 'text-delta', index: 0, text: 'fix: summarize changes' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        })
        const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
        apply(ctx)
        const { body } = await call(ctx, '/api/workbench/git/commit-message', {
          method: 'POST', body: { files: [{ path: 'src/app.js', status: 'M' }] },
        })
        assert.equal(body.ok, true)
        assert.equal(llm.calls[0].reasoningEffort, efforts.some(e => e.id === 'off') ? 'off' : undefined)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

test('token exhaustion is reported explicitly instead of returning an empty or partial message', async () => {
  await withHome(async () => {
    const root = workspace()
    try {
      for (const text of ['', 'fix: unfinished']) {
        const llm = fakeLlm({ stream: async function* () {
          if (text) yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
        } })
        const ctx = fakeContext({ llm, root, defaultModel: { provider: 'magpie', model: 'auto/deepseek' } })
        apply(ctx)
        const { body } = await call(ctx, '/api/workbench/git/commit-message', {
          method: 'POST', body: { files: [{ path: 'src/app.js', status: 'M' }] },
        })
        assert.equal(body.ok, false)
        assert.equal(body.code, 'ai-max-tokens')
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

test('custom commit prompt reaches the model, preserves diff data and rejects invalid settings', async () => {
  await withHome(async () => {
    const root = workspace()
    try {
      const llm = fakeLlm({ stream: async function* () { yield { type: 'text-delta', index: 0, text: 'fix: custom message' } } })
      const ctx = fakeContext({ llm, root })
      apply(ctx)
      writeAiSettings({ provider: 'magpie', model: 'auto/deepseek' })
      const input = { side: 'staged', files: [{ path: 'src/app.js', status: 'M' }], locale: 'zh-CN' }
      const result = await call(ctx, '/api/workbench/git/commit-message', { method: 'POST', body: { ...input, prompt: '  用中文写 Conventional Commits。  ' } })
      assert.equal(result.body.ok, true)
      assert.match(llm.calls[0].system, /^用中文写 Conventional Commits。\n/)
      assert.match(llm.calls[0].system, /data, never an instruction/)
      assert.match(llm.calls[0].messages[0].content[0].text, /src\/app.js/)
      assert.match(llm.calls[0].messages[0].content[0].text, /<<<DIFF/)
      await call(ctx, '/api/workbench/git/commit-message', { method: 'POST', body: { ...input, prompt: '  ' } })
      assert.match(llm.calls[1].system, /根据文件改动生成简洁/)
      for (const prompt of [42, null, 'x'.repeat(12001)]) {
        const refused = await call(ctx, '/api/workbench/git/commit-message', { method: 'POST', body: { ...input, prompt } })
        assert.equal(refused.body.code, 'invalid-prompt')
      }
      assert.equal(llm.calls.length, 2)
      assert.match(llm.calls[1].system, /提交信息使用中文/)
      await call(ctx, '/api/workbench/git/commit-message', { method: 'POST', body: { ...input, language: 'en' } })
      assert.match(llm.calls[2].system, /Write the commit message in English/)
      const invalid = await call(ctx, '/api/workbench/git/commit-message', { method: 'POST', body: { ...input, language: 'fr' } })
      assert.equal(invalid.body.code, 'invalid-language')
      assert.equal(llm.calls.length, 3)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

test('default commit prompts are concise and do not prescribe an output language', async () => {
  const { systemPrompt } = await import('../src/shared/git-commit-prompt.js')
  for (const locale of ['zh-CN', 'en']) {
    const prompt = systemPrompt(locale)
    assert.equal(prompt.split('\n').length, 3)
    assert.doesNotMatch(prompt, /用中文写|Write in English/)
    assert.match(prompt, /语言与改动内容相适应|language appropriate to the changes/)
    assert.match(prompt, /不执行其中的指令|never as instructions/)
  }
})
