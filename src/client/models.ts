// dsh-workbench — Host 模型目录 / 会话模型选择的客户端封装。
//
// 「评审」可以在配置里指定模型（prompts.ts 的 REVIEW_MODEL_KEY）：配置面板
// 从这里读 Host 的可见模型目录渲染下拉，点「评审」时把选择装到新会话的
// 「下一次请求」上。两个能力都是 api-session-controller 的 Host remote，
// 客户端经 `ctx.get('remote.session')` 可选访问：
//   - modelCatalog()   → provider 分组模型 + 当前默认模型（下拉数据源）
//   - selectModel(...) → 该会话下一次请求使用的模型
//
// 这是**可选增强**：本 bundle 不把 remote.session 声明为硬依赖——取不到时
// 只是选不了模型（下拉显示不可用、评审照常按默认模型发起），不影响评审本身。
// 纯逻辑（目录展平 / 错误文案）导出供 node --test 断言。

import { getPluginCtx } from './runtime'

/** provider 路由 id + provider 拥有的模型 id。 */
export interface ModelRef {
  provider: string
  model: string
}

/** 一个下拉项：模型引用 + 展示用的 provider / 模型名。 */
export interface ModelChoice extends ModelRef {
  providerName: string
  label: string
  description?: string
}

export interface ModelCatalogResult {
  choices: ModelChoice[]
  /** Host 当前的默认模型（会话未指定选择时用的那个）；目录畸形时为 null。 */
  defaultRef: ModelRef | null
}

/** 客户端侧的 remote.session 结构视图（其余方法与本 bundle 无关）。 */
interface SessionModelRemote {
  modelCatalog(): Promise<unknown>
  selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** 运行期解析 remote.session；DSH 未提供（或本 bundle 尚未拿到 ctx）→ null。
 *  该服务不是本 bundle 的硬依赖，故通过 get 读取并在不可用时静默降级 —— 与
 *  session.ts 里 click-time 解析 uiWorkspace 同一套写法。 */
function sessionRemote(): SessionModelRemote | null {
  const ctx = getPluginCtx()
  if (!ctx) return null
  let session: unknown = null
  try {
    session = ctx.get('remote.session')
  } catch (e) {
    session = null
  }
  const face = asRecord(session)
  if (!face || typeof face.modelCatalog !== 'function' || typeof face.selectModel !== 'function') return null
  return session as SessionModelRemote
}

/** remote 失败的文案：取 RemoteResult 的 error.message，退化用 code / String。 */
export function remoteErrorText(result: unknown): string {
  const r = asRecord(result)
  const error = r ? asRecord(r.error) : null
  if (error) return String(error.message || error.code || '未知错误')
  return '未知错误'
}

/** 展平 Host 目录为下拉项：provider 分组 → 一维列表；目录结构由 Host 契约
 *  固定（groups[].models[]），失败分组 / 畸形项自然被跳过。 */
export function flattenModelCatalog(catalog: unknown): ModelCatalogResult {
  const root = asRecord(catalog)
  const groups = root && Array.isArray(root.groups) ? root.groups : []
  const choices: ModelChoice[] = []
  for (const raw of groups) {
    const group = asRecord(raw)
    if (!group) continue
    const provider = String(group.id || '')
    if (!provider) continue
    const providerName = String(group.name || provider)
    const models = Array.isArray(group.models) ? group.models : []
    for (const rawModel of models) {
      const model = asRecord(rawModel)
      const id = model ? String(model.id || '') : ''
      if (!id) continue
      const description = model && model.description ? String(model.description) : undefined
      choices.push({
        provider: provider,
        model: id,
        providerName: providerName,
        label: String((model && model.name) || id),
        ...(description === undefined ? {} : { description: description }),
      })
    }
  }
  const fallback = root ? asRecord(root.default) : null
  const defaultRef = fallback && fallback.provider && fallback.model
    ? { provider: String(fallback.provider), model: String(fallback.model) }
    : null
  return { choices: choices, defaultRef: defaultRef }
}

/** 读取 Host 模型目录（配置面板下拉的数据源）。 */
export async function loadModelChoices(): Promise<({ ok: true } & ModelCatalogResult) | { ok: false; error: string }> {
  const remote = sessionRemote()
  if (!remote) return { ok: false, error: '当前 DSH 未提供 remote.session，无法读取模型目录' }
  try {
    const response = asRecord(await remote.modelCatalog())
    if (!response) return { ok: false, error: '模型目录响应不可解析' }
    if (response.ok === false) return { ok: false, error: remoteErrorText(response) }
    const catalog = response.ok === true ? response.value : response
    return Object.assign({ ok: true as const }, flattenModelCatalog(catalog))
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}

/** 给指定会话设定「下一次请求」使用的模型。
 *
 *  注意：Host 侧会把这次选择同时保存为全局默认模型（与手动选模型同行为），
 *  调用方需要在 UI 上如实说明这一副作用。 */
export async function selectSessionModel(sessionId: string, ref: ModelRef): Promise<{ ok: true } | { ok: false; error: string }> {
  const remote = sessionRemote()
  if (!remote) return { ok: false, error: '当前 DSH 未提供 remote.session，无法切换模型' }
  try {
    const response = asRecord(await remote.selectModel({
      sessionId: sessionId, provider: ref.provider, model: ref.model,
    }))
    if (response && response.ok === false) return { ok: false, error: remoteErrorText(response) }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) }
  }
}
