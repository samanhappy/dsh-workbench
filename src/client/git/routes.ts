// Host calls: same-origin authenticated Fetch routes served by the plugin's
// host half. The browser uses the document-relative form so the request carries
// the session cookie and passes the Connection fence.

import type {
  AiMessagePayload,
  CommitDetailPayload,
  AiModelsPayload,
  DiffPayload,
  HistoryPayload,
  MutationPayload,
  OpenPayload,
  OpenTarget,
  RefsPayload,
  GitStatusPayload,
  WorkspacesPayload,
} from './types'

/** Authenticated exact Fetch routes served by the host half (document-relative). */
const STATUS_ROUTE = 'api/workbench/git/status'
const WORKSPACES_ROUTE = 'api/workbench/git/workspaces'
const DIFF_ROUTE = 'api/workbench/git/diff'
const REFS_ROUTE = 'api/workbench/git/refs'
const HISTORY_ROUTE = 'api/workbench/git/history'
const COMMIT_INFO_ROUTE = 'api/workbench/git/commit-info'
const CHECKOUT_ROUTE = 'api/workbench/git/checkout'
const DISCARD_ROUTE = 'api/workbench/git/discard'
const REMOVE_ROUTE = 'api/workbench/git/remove'
const MERGE_ROUTE = 'api/workbench/git/merge'
const PULL_ROUTE = 'api/workbench/git/pull'
const PUSH_ROUTE = 'api/workbench/git/push'
const BRANCH_CREATE_ROUTE = 'api/workbench/git/branch/create'
const BRANCH_RENAME_ROUTE = 'api/workbench/git/branch/rename'
const BRANCH_DELETE_ROUTE = 'api/workbench/git/branch/delete'
const STAGE_ROUTE = 'api/workbench/git/stage'
const UNSTAGE_ROUTE = 'api/workbench/git/unstage'
const COMMIT_ROUTE = 'api/workbench/git/commit'
const OPEN_ROUTE = 'api/workbench/git/open'
const AI_MODELS_ROUTE = 'api/workbench/git/ai/models'
const AI_MODEL_ROUTE = 'api/workbench/git/ai/model'
const COMMIT_MESSAGE_ROUTE = 'api/workbench/git/commit-message'

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, value)
  const text = search.toString()
  return text === '' ? '' : '?' + text
}

async function getJson<T>(
  route: string,
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(route + query(params), {
    signal,
    headers: { accept: 'application/json' },
  })
  const payload = (await response.json()) as T
  return payload
}

async function postJson<T>(route: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: 'POST',
    signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as T
}

export function fetchWorkspaces(signal?: AbortSignal): Promise<WorkspacesPayload> {
  return getJson<WorkspacesPayload>(WORKSPACES_ROUTE, {}, signal)
}

export function fetchStatus(cwd?: string, signal?: AbortSignal): Promise<GitStatusPayload> {
  return getJson<GitStatusPayload>(STATUS_ROUTE, { cwd }, signal)
}

export function fetchDiff(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<DiffPayload> {
  return getJson<DiffPayload>(DIFF_ROUTE, params, signal)
}

export function fetchRefs(cwd?: string, signal?: AbortSignal): Promise<RefsPayload> {
  return getJson<RefsPayload>(REFS_ROUTE, { cwd }, signal)
}

export function fetchCommitInfo(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<CommitDetailPayload> {
  return getJson<CommitDetailPayload>(COMMIT_INFO_ROUTE, params, signal)
}

export function fetchHistory(
  params: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<HistoryPayload> {
  return getJson<HistoryPayload>(HISTORY_ROUTE, params, signal)
}

export function pullBranch(cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(PULL_ROUTE + query({ cwd }), {})
}

export function pushBranch(cwd?: string, remote?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(PUSH_ROUTE + query({ cwd }), { remote })
}

export function mergeBranch(branch: string, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(MERGE_ROUTE + query({ cwd }), { branch })
}

export function discardPaths(paths: string[], side: 'staged' | 'unstaged', cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(DISCARD_ROUTE + query({ cwd }), { paths, side })
}

export function removePaths(paths: string[], untracked: boolean, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(REMOVE_ROUTE + query({ cwd }), { paths, untracked })
}

export function checkoutBranch(branch: string, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(CHECKOUT_ROUTE + query({ cwd }), { branch })
}

export function createBranch(name: string, cwd?: string, start?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(BRANCH_CREATE_ROUTE + query({ cwd }), { name, start })
}

export function renameBranch(from: string, to: string, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(BRANCH_RENAME_ROUTE + query({ cwd }), { from, to })
}

export function deleteBranch(name: string, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(BRANCH_DELETE_ROUTE + query({ cwd }), { name })
}

export function stagePaths(paths: string[], cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(STAGE_ROUTE + query({ cwd }), { paths })
}

export function unstagePaths(paths: string[], cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(UNSTAGE_ROUTE + query({ cwd }), { paths })
}

export function commitChanges(message: string, cwd?: string): Promise<MutationPayload> {
  return postJson<MutationPayload>(COMMIT_ROUTE + query({ cwd }), { message })
}

export function openLocal(target: OpenTarget, cwd?: string): Promise<OpenPayload> {
  return postJson<OpenPayload>(OPEN_ROUTE + query({ cwd }), { target })
}

export function fetchAiModels(signal?: AbortSignal): Promise<AiModelsPayload> {
  return getJson<AiModelsPayload>(AI_MODELS_ROUTE, {}, signal)
}

export function saveAiModel(provider: string, model: string): Promise<AiModelsPayload> {
  return postJson<AiModelsPayload>(AI_MODEL_ROUTE, { provider, model })
}

/** Ask the selected model to write a commit message for the given files. */
export function generateCommitMessage(
  input: {
    side: 'staged' | 'unstaged'
    files: { path: string; status: string }[]
    locale: string
    language?: string
    prompt?: string
  },
  cwd?: string,
): Promise<AiMessagePayload> {
  return postJson<AiMessagePayload>(COMMIT_MESSAGE_ROUTE + query({ cwd }), input)
}
