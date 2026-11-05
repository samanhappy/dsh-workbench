// dsh-workbench — item → workspace session bridge.
//
// Both the MR/PR 「评审」 and the Issue 「处理」 buttons resolve the Workspace
// owning the item's repo, connect a fresh Session there through the shell's
// official uiWorkspace service (connectWorkspace reuses the workspace's blank
// draft session or creates a new one and guarantees addressability on
// resolution), open it, rename it for the sidebar, and submit a structured
// prompt. One session per click; the current conversation is never touched.
//
// The pure helpers (URL parsing / workspace resolution / retain) are exported
// for the node --test suites (test/review-session.mjs, test/current-session.mjs);
// startItemSession is the shared click-time routine (评审 / 处理) and lives
// here so both panels drive the session controller identically.
//
// 「评审」可带一个配置好的模型（prompts.ts 的 REVIEW_MODEL_KEY）：在 retain
// 之后、prompt 之前经 session.selectModel 装到这个新会话的「下一次请求」上。
// 切换失败不阻断评审——降级为默认模型并把原因放进 SessionStartResult.warning。

import { repoPathFromUrl, repoPathFromIssueUrl } from './format'
import { selectSessionModel } from './models'
import { getPluginCtx, getSessionsService } from './runtime'
import type { ModelRef } from './models'
import type { ISessions, SessionBinding, SessionListRow, ForgeItem, WorkspaceMeta, WorkspaceView } from './types'

/**
 * Resolve the Workspace that owns a repo path. The panel's active workspace
 * cwd wins (the normal case — the list is queried through that workspace);
 * otherwise match the repo path parsed from the item's web_url against the
 * /forge/workspaces detection (registered workspace × git remote × CLI auth)
 * and map it onto the workspace-registry view. Both halves are required: the
 * /forge half proves a CLI is authorized for that repo's host, the registry
 * view carries the workspaceId the session controller needs.
 * @returns { view, meta } or null when no corresponding workspace exists.
 */
export function findRepoWs(
  repoPath: string | null,
  activeCwd: string | null,
  wsData: { workspaces?: WorkspaceMeta[] } | null,
  wsItems: WorkspaceView[],
): { view: WorkspaceView; meta: WorkspaceMeta } | null {
  const detected = wsData && Array.isArray(wsData.workspaces) ? wsData.workspaces : []
  const views = Array.isArray(wsItems) ? wsItems : []
  const pairUp = function (meta: WorkspaceMeta | null | undefined): { view: WorkspaceView; meta: WorkspaceMeta } | null {
    if (!meta) return null
    for (const view of views) {
      if (view.path === meta.path) return { view: view, meta: meta }
    }
    return null
  }
  if (activeCwd) {
    const hit = pairUp(detected.find(function (ws) { return ws.path === activeCwd }) || null)
    if (hit) return hit
  }
  if (repoPath) {
    const hit = pairUp(detected.find(function (ws) { return ws.repoPath === repoPath }) || null)
    if (hit) return hit
  }
  return null
}

/** MR/PR 「评审」: resolve the workspace owning the item's repo. */
export function findReviewWs(
  item: ForgeItem,
  activeCwd: string | null,
  wsData: { workspaces?: WorkspaceMeta[] } | null,
  wsItems: WorkspaceView[],
): { view: WorkspaceView; meta: WorkspaceMeta } | null {
  return findRepoWs(repoPathFromUrl(item && item.web_url), activeCwd, wsData, wsItems)
}

/** Issue 「处理」: same resolution over an Issue web_url. */
export function findIssueWs(
  item: { web_url?: string } | null | undefined,
  activeCwd: string | null,
  wsData: { workspaces?: WorkspaceMeta[] } | null,
  wsItems: WorkspaceView[],
): { view: WorkspaceView; meta: WorkspaceMeta } | null {
  return findRepoWs(repoPathFromIssueUrl(item && item.web_url), activeCwd, wsData, wsItems)
}

/** Best-effort session rename so the sidebar row shows the review context
 * (the host normalizes acceptance; a failure is invisible to the review). */
export function renameSessionQuiet(session: { rename?(title: string): unknown } | null | undefined, title: string): void {
  if (!session || typeof session.rename !== 'function') return
  try {
    Promise.resolve(session.rename(String(title).slice(0, 80))).catch(function () {})
  } catch (e) {}
}

/** Resolve the live business Session of a just-connected workspace session.
 *
 * A freshly created session has no materialized scope yet: the one-shot
 * `sessions.binding(id)` returns undefined on first access, which made the
 * first 「评审」 click fail with "评审会话已打开，但无法自动发送评审指令"
 * (the prompt was only sent on the second click, once the session had been
 * retained by the main view). Retaining instead materializes the scope, and
 * `reference.ready` resolves with the binding only once the session is open
 * and addressable — exactly what connectWorkspace guarantees on resolution.
 *
 * Returns `{ session, release }` when the sessions service supports retain,
 * or null when unavailable (the caller keeps the legacy fallback alert).
 * The caller must call `release()` when done so an unopened fresh session is
 * not kept alive by this reference. Exported for test/review-session.mjs.
 */
export async function retainBoundSession(
  sessionsService: ISessions | null,
  sessionId: string,
): Promise<{ session: SessionBinding['session']; release: () => void } | null> {
  if (!sessionsService || typeof sessionsService.retain !== 'function') return null
  const reference = sessionsService.retain(sessionId as never, { source: 'workspaceOperation' })
  try {
    const binding = await reference.ready
    return {
      session: binding.session,
      release: function () {
        try { reference.release() } catch (e) {}
      },
    }
  } catch (e) {
    try { reference.release() } catch (e2) {}
    throw e
  }
}

/** Why startItemSession could not submit the prompt (callers map these onto
 *  their own user-facing wording). */
export type SessionStartCode = 'no-uiworkspace' | 'no-prompt' | 'prompt-failed' | 'connect-failed'

export interface SessionStartResult {
  ok: boolean
  code?: SessionStartCode
  error?: string
  /** 非致命降级说明（如评审模型切换失败，已按默认模型发起）。 */
  warning?: string
}

/** Minimal structural view of the shell's uiWorkspace service (the bundle
 *  resolves it at click time — it may mount after this bundle's apply). */
interface UiWorkspaceLike {
  connectWorkspace(id: string): Promise<string>
  openSession(id: string): void
}

interface PromptableSession {
  beginSubmission?(o: { mode: string; text: string; attachments: unknown[] }): { requestId?: string }
  prompt?(parts: unknown[], mode: string, a?: unknown, requestId?: string): Promise<{ ok?: boolean; error?: { message?: string } }>
  rename?(t: string): unknown
}

/**
 * Open a NEW session in `ws` and submit `text` into it, renaming the session
 * to `title` for the sidebar. Shared by MR/PR 「评审」 and Issue 「处理」:
 *   connectWorkspace (reuse blank draft / create) → retain (materialize the
 *   scope so a first click resolves the session) → optional model selection
 *   (评审模型; failure degrades to the default and is reported as `warning`)
 *   → local echo (beginSubmission, renders as the conversation's opening user
 *   bubble) → openSession (navigate + close side panels) → rename → prompt.
 * Never throws: failures come back as `{ ok: false, code, error }` so each
 * caller can keep its own wording.
 */
export async function startItemSession(
  ws: { view: { workspaceId: string; path: string } },
  text: string,
  title: string,
  model?: ModelRef | null,
): Promise<SessionStartResult> {
  const ctx = getPluginCtx()
  const uiWs = ctx ? ctx.get('uiWorkspace') : null
  if (!uiWs || typeof (uiWs as { connectWorkspace?: unknown }).connectWorkspace !== 'function') {
    return { ok: false, code: 'no-uiworkspace', error: '当前 DSH 未提供 uiWorkspace 服务（请升级 DSH）' }
  }
  let held: { session: SessionBinding['session']; release(): void } | null = null
  try {
    const svc = uiWs as unknown as UiWorkspaceLike
    const sessionId = await svc.connectWorkspace(ws.view.workspaceId)
    // A freshly created session has no materialized scope yet: the one-shot
    // binding(sessionId) returns undefined on first access, which used to
    // surface the "会话已打开，但无法自动发送指令" alert and require a second
    // click. retainBoundSession retains the session instead — materializing
    // the scope and resolving only once it is open and addressable.
    held = await retainBoundSession(getSessionsService(), sessionId)
    const session = held ? held.session : null
    // 评审模型（可选）：装在「下一次请求」上，必须在 prompt 之前；失败不阻断
    // 评审，降级为 DSH 默认模型并经 warning 回报给调用方。
    let warning: string | undefined
    if (model) {
      const applied = await selectSessionModel(sessionId, model)
      if (!applied.ok) {
        warning = '评审模型（' + model.provider + '/' + model.model + '）切换失败，已按默认模型发起评审：' + applied.error
      }
    }
    // Local echo first (renders as the conversation's opening user bubble),
    // then navigate (closes this panel), rename for the sidebar, then send.
    const s = session as unknown as PromptableSession | null
    const handle = s && typeof s.beginSubmission === 'function'
      ? s.beginSubmission({ mode: 'queue', text: text, attachments: [] })
      : null
    svc.openSession(sessionId)
    renameSessionQuiet(s, title)
    if (!s || typeof s.prompt !== 'function') {
      return { ok: false, code: 'no-prompt', error: '会话已打开，但无法自动发送指令' }
    }
    const result = await s.prompt(
      [{ type: 'text', text: text }],
      'queue',
      undefined,
      handle ? handle.requestId : undefined,
    )
    if (result && result.ok === false) {
      return { ok: false, code: 'prompt-failed', error: (result.error && result.error.message) || '未知错误' }
    }
    return warning === undefined ? { ok: true } : { ok: true, warning: warning }
  } catch (e) {
    return { ok: false, code: 'connect-failed', error: String(e instanceof Error ? e.message : e) }
  } finally {
    if (held) held.release()
  }
}

/** The session the main view currently shows, from the useSessions snapshot.
 *
 * dsh 0.1.6-alpha.2 (commit 6830e1460d) removed `current` from
 * SessionListState; the shipped UI now derives the main-view session from the
 * retention counts on each byId row (mainSessionId in
 * packages/client/ui-workspace/src/client/tree.ts). Read the legacy field
 * first so older dsh keeps working, then fall back to the retainedBy scan.
 * Exported for tests (test/current-session.mjs).
 */
export function currentSessionIdOf(list: { current?: string | null; byId?: Record<string, SessionListRow> } | null | undefined): string | null {
  if (!list) return null
  if (list.current) return list.current
  if (list.byId && typeof list.byId === 'object') {
    for (const row of Object.values(list.byId)) {
      if (row && row.retainedBy && Number(row.retainedBy.mainView || 0) > 0 && row.id) return row.id
    }
  }
  return null
}
