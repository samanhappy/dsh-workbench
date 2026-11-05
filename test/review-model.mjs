// 「评审模型」点击链路测试：点「评审」时把配置好的模型装到新评审会话上。
//
// 配置项 review.model 的取值解析 / 注册表契约在 test/prompt-config.mjs；本
// 文件回归运行期部分：
//   - flattenModelCatalog：Host 目录（provider 分组）→ 下拉项，畸形输入不抛；
//   - loadModelChoices / selectSessionModel：remote.session 可用性降级
//     （不可用时返回结构化失败，不抛错、不影响评审）；
//   - startItemSession 带模型参数：**先 selectModel 再 prompt**，切换失败只
//     降级为默认模型并经 warning 回报，绝不阻断评审。
//
// 桩的都是 DSH 官方客户端服务的结构契约（uiWorkspace / ISessions /
// remote.session），与 test/review-session.mjs 同一套做法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

/** remote.session 桩：记录 selectModel 调用；catalog 固定返回一个分组。 */
function makeRemote(options) {
  const calls = []
  const opts = options || {}
  return {
    calls,
    session: {
      modelCatalog: async () => {
        if (opts.catalogError) return { ok: false, error: opts.catalogError }
        return {
          ok: true,
          value: {
            default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' },
            routableProviders: ['deepseek-account', 'deepseek-official'],
            groups: [
              { id: 'deepseek-account', name: 'DeepSeek 账号', models: [
                { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '快' },
                { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
              ] },
              { id: 'deepseek-official', name: 'DeepSeek 官方', models: [
                { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
              ] },
              { id: 'broken-provider', name: '坏掉的 provider', models: [] },
            ],
            failures: [{ id: 'broken-provider', name: '坏掉的 provider', message: 'nope' }],
          },
        }
      },
      selectModel: async (request) => {
        calls.push(request)
        if (opts.selectError) return { ok: false, error: opts.selectError }
        return { ok: true, value: { selected: { provider: request.provider, model: request.model } } }
      },
    },
  }
}

/** 让 startItemSession 可跑的桩 ctx：uiWorkspace + ISessions + remote.session；
 *  `order` 记录 selectModel 与 prompt 的调用顺序。 */
function bindReviewCtx(remote) {
  const order = []
  const session = {
    sessionId: 's-review',
    beginSubmission: () => ({ requestId: 'req-1' }),
    rename: async () => ({ ok: true }),
    prompt: async () => { order.push('prompt'); return { ok: true } },
  }
  const sessions = {
    retain: (id) => ({ sessionId: id, ready: Promise.resolve({ sessionId: id, session }), release() {} }),
  }
  const uiWorkspace = { connectWorkspace: async () => 's-review', openSession: () => {} }
  loadClientModule().bindRuntime({
    get: (name) => (name === 'sessions' ? sessions : name === 'uiWorkspace' ? uiWorkspace : name === 'remote.session' ? remote?.session : null),
    get remote() { throw new Error('cannot get property "remote" without inject') },
  })
  return { order }
}

const WS = { view: { workspaceId: 'ws-a', path: '/ws/a' } }

test('flattenModelCatalog: provider 分组展平为下拉项，失败分组不产生垃圾项', () => {
  const { flattenModelCatalog } = loadClientModule()
  const source = {
    default: { provider: 'deepseek-account', model: 'deepseek-v4-flash' },
    groups: [
      { id: 'p1', name: 'Provider One', models: [{ id: 'm1', name: 'M1', description: 'd' }, { id: 'm2', name: 'M2' }] },
      { id: 'p2', name: 'Provider Two', models: [{ id: 'm1' }] },
      { id: '', name: 'no id', models: [{ id: 'x' }] }, // 无 provider id → 跳过
      { id: 'p3', models: [{ id: '' }] },               // 无 model id → 跳过
    ],
  }
  const out = flattenModelCatalog(source)
  assert.equal(out.choices.length, 3)
  assert.equal(out.choices[0].provider, 'p1')
  assert.equal(out.choices[0].providerName, 'Provider One')
  assert.equal(out.choices[0].label, 'M1')
  assert.equal(out.choices[0].description, 'd')
  assert.equal(out.choices[1].label, 'M2', '缺 name 时回退用模型 id')
  assert.equal(out.choices[2].provider, 'p2')
  assert.equal(out.defaultRef.provider, 'deepseek-account')
  assert.equal(out.defaultRef.model, 'deepseek-v4-flash')

  // 畸形输入不抛（remote 版本差异 / 半截响应）
  assert.deepEqual(flattenModelCatalog(null).choices, [])
  assert.deepEqual(flattenModelCatalog({}).choices, [])
  assert.equal(flattenModelCatalog({}).defaultRef, null)
  assert.deepEqual(flattenModelCatalog({ groups: 'nope' }).choices, [])
})

test('loadModelChoices: 读 Host 目录（分组 + 默认模型）', async () => {
  const { loadModelChoices } = loadClientModule()
  const remote = makeRemote()
  bindReviewCtx(remote)
  const res = await loadModelChoices()
  assert.equal(res.ok, true)
  assert.equal(res.choices.length, 3, 'deepseek-account 两个 + deepseek-official 一个；空分组不产生项')
  assert.equal(res.defaultRef.provider, 'deepseek-account')
  assert.equal(res.defaultRef.model, 'deepseek-v4-flash')
})

test('loadModelChoices: DSH 无 remote.session 时结构化失败（不抛错）', async () => {
  const { loadModelChoices } = loadClientModule()
  bindReviewCtx(null)
  const res = await loadModelChoices()
  assert.equal(res.ok, false)
  assert.ok(res.error.includes('remote.session'))
})

test('loadModelChoices: Host 报错时返回失败文案', async () => {
  const { loadModelChoices } = loadClientModule()
  bindReviewCtx(makeRemote({ catalogError: { code: 'gateway/internal', message: '目录挂了' } }))
  const res = await loadModelChoices()
  assert.equal(res.ok, false)
  assert.equal(res.error, '目录挂了')
})

test('selectSessionModel: 把 provider/model 与 sessionId 一起交给 Host', async () => {
  const { selectSessionModel } = loadClientModule()
  const remote = makeRemote()
  bindReviewCtx(remote)
  const res = await selectSessionModel('s-1', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(res.ok, true)
  assert.equal(remote.calls.length, 1)
  assert.equal(remote.calls[0].sessionId, 's-1')
  assert.equal(remote.calls[0].provider, 'deepseek-official')
  assert.equal(remote.calls[0].model, 'deepseek-v4-pro')
})

test('selectSessionModel: Host 拒绝 / 无 remote 时返回失败，不抛错', async () => {
  const { selectSessionModel } = loadClientModule()
  bindReviewCtx(makeRemote({ selectError: { code: 'session/model-unavailable', message: '模型不可用' } }))
  const rejected = await selectSessionModel('s-1', { provider: 'p', model: 'm' })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error, '模型不可用')

  bindReviewCtx(null)
  const missing = await selectSessionModel('s-1', { provider: 'p', model: 'm' })
  assert.equal(missing.ok, false)
  assert.ok(missing.error.includes('remote.session'))
})

test('startItemSession: 带评审模型 → 先 selectModel 再 prompt，warning 为空', async () => {
  const { startItemSession } = loadClientModule()
  const remote = makeRemote()
  const { order } = bindReviewCtx(remote)
  const original = remote.session.selectModel
  remote.session.selectModel = async (request) => { order.push('select'); return original(request) }

  const res = await startItemSession(WS, '评审指令', '评审 !12', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  assert.equal(res.ok, true)
  assert.equal(res.warning, undefined)
  assert.deepEqual(order, ['select', 'prompt'], '模型必须在 prompt 之前装好，否则首轮用的是旧模型')
  assert.equal(remote.calls[0].provider, 'deepseek-official')
  assert.equal(remote.calls[0].model, 'deepseek-v4-pro')
  assert.equal(remote.calls[0].sessionId, 's-review')
})

test('startItemSession: 未配置模型 → 不调用 selectModel（老用户零感知）', async () => {
  const { startItemSession } = loadClientModule()
  const remote = makeRemote()
  bindReviewCtx(remote)
  for (const arg of [undefined, null]) {
    const res = await startItemSession(WS, '评审指令', '评审 !12', arg)
    assert.equal(res.ok, true)
    assert.equal(remote.calls.length, 0)
  }
})

test('startItemSession: 模型切换失败仍发起评审，经 warning 如实回报', async () => {
  const { startItemSession } = loadClientModule()
  const remote = makeRemote({ selectError: { code: 'session/model-unavailable', message: '模型不可用' } })
  const { order } = bindReviewCtx(remote)
  const res = await startItemSession(WS, '评审指令', '评审 !12', { provider: 'p', model: 'm' })
  assert.equal(res.ok, true, '模型切换失败不得阻断评审')
  assert.ok(res.warning.includes('p/m'), 'warning 要指明是哪个模型没切上')
  assert.ok(res.warning.includes('模型不可用'), 'warning 要带上 Host 的原因')
  assert.deepEqual(order, ['prompt'], '失败后照常发送评审指令')
})

test('startItemSession: DSH 无 remote.session → 照常评审（可选增强）', async () => {
  const { startItemSession } = loadClientModule()
  const { order } = bindReviewCtx(null)
  const res = await startItemSession(WS, '评审指令', '评审 !12', { provider: 'p', model: 'm' })
  assert.equal(res.ok, true)
  assert.ok(res.warning.includes('remote.session'))
  assert.deepEqual(order, ['prompt'])
})
