import {
  handleBranchCreate,
  handleBranchDelete,
  handleBranchRename,
  handleCheckout,
  handleCommit,
  handleCommitInfo,
  handleDiscard,
  handleDiff,
  handleOpen,
  handlePush,
  handlePull,
  handleHistory,
  handleMerge,
  handleRefs,
  handleRemove,
  handleStage,
  handleStatus,
  handleUnstage,
  handleWorkspaces,
} from './handlers.js'
import { guard } from './http.js'
import { handleAiModels, handleAiModelSave, handleGenerateCommitMessage } from './ai.js'

/** Stable Cordis plugin name (not strictly required; matches the patch row id). */
export const name = 'dsh-git-tree'

/**
 * Hard dependencies: without the Fetch-route registry or the subprocess
 * capability the plugin has nothing to do, so Cordis keeps it inactive instead
 * of letting `apply` throw.
 */
export const inject = ['connection', 'subprocess']

/** Exact Fetch route paths. */
const ROUTES = [
  { path: '/api/workbench/git/workspaces', methods: ['GET'], handler: handleWorkspaces },
  { path: '/api/workbench/git/status', methods: ['GET'], handler: handleStatus },
  { path: '/api/workbench/git/diff', methods: ['GET'], handler: handleDiff },
  { path: '/api/workbench/git/refs', methods: ['GET'], handler: handleRefs },
  { path: '/api/workbench/git/history', methods: ['GET'], handler: handleHistory },
  { path: '/api/workbench/git/merge', methods: ['POST'], handler: handleMerge },
  { path: '/api/workbench/git/pull', methods: ['POST'], handler: handlePull },
  { path: '/api/workbench/git/push', methods: ['POST'], handler: handlePush },
  { path: '/api/workbench/git/commit-info', methods: ['GET'], handler: handleCommitInfo },
  { path: '/api/workbench/git/checkout', methods: ['POST'], handler: handleCheckout },
  { path: '/api/workbench/git/branch/create', methods: ['POST'], handler: handleBranchCreate },
  { path: '/api/workbench/git/branch/rename', methods: ['POST'], handler: handleBranchRename },
  { path: '/api/workbench/git/branch/delete', methods: ['POST'], handler: handleBranchDelete },
  { path: '/api/workbench/git/stage', methods: ['POST'], handler: handleStage },
  { path: '/api/workbench/git/unstage', methods: ['POST'], handler: handleUnstage },
  { path: '/api/workbench/git/commit', methods: ['POST'], handler: handleCommit },
  { path: '/api/workbench/git/discard', methods: ['POST'], handler: handleDiscard },
  { path: '/api/workbench/git/remove', methods: ['POST'], handler: handleRemove },
  { path: '/api/workbench/git/open', methods: ['POST'], handler: handleOpen },
  { path: '/api/workbench/git/ai/models', methods: ['GET'], handler: handleAiModels },
  { path: '/api/workbench/git/ai/model', methods: ['POST'], handler: handleAiModelSave },
  { path: '/api/workbench/git/commit-message', methods: ['POST'], handler: handleGenerateCommitMessage },
]

/**
 * Register the routes. Each registration is owned by this plugin's fiber:
 * `ctx.connection.fetch.register` wraps it in an effect, so unloading the row
 * (or disabling the bundle) removes the routes with no extra cleanup here.
 */
export function apply(ctx) {
  for (const route of ROUTES) {
    ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: guard((request) => route.handler(ctx, request)),
    })
  }
}
