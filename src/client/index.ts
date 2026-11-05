// dsh-workbench — client plugin entry (browser half).
//
// Registers the workbench sidebar row, main panel and assistant submit action.
// Enabled feature pages keep their state across page switches.
//
// `inject` declares hard dependencies so cordis defers apply() until they are
// mounted: 'slots' (SlotRegistry, ui-renderer) and 'sessions' (ISessions,
// api-session-controller) — without the declaration the capture can run
// before the service exists. The package.json `dsh.client.inject` list names
// the profile-roster client modules the bundle's factory requires
// (ui-primitives) plus the service-owner packages it composes with.
//
// The pure helpers re-exported at the bottom are consumed by the node --test
// suites (test/prompt-config.mjs / current-session.mjs / review-session.mjs)
// through the built bundle's factory result.

import { bindRuntime, startWorkbenchPolling } from './runtime'
import { GL_CSS } from './styles'
import { GitCommitButton } from './components/git'
import { PanelIcon, WorkbenchPanel, SubmitButton } from './components/shell'
import type { ClientContext } from './types'
import { h } from './react'
import { registerWorkbenchShortcuts } from './shortcuts'

// Pure logic exported for tests.
export { renderTemplate, resolveConfigText, spliceToken, saveConfig, resetConfig, resetConfigKeys, configItemsFor, buildReviewPrompt, buildIssuePrompt, buildSubmitPrompt, CONFIG_ITEMS, resolveConfigToggle, setConfigToggle, defaultToggleOf, FEATURE_CONFIG_KEYS, configRevision, subscribeConfig, REVIEW_MODEL_KEY, formatModelRef, parseModelRef, resolveReviewModel } from './prompts'
export { featureFlags, shortcutFlags, isFeatureEnabled, FEATURE_ORDER } from './features'
export { currentSessionIdOf, retainBoundSession, startItemSession, findReviewWs, findIssueWs } from './session'
export { flattenModelCatalog, loadModelChoices, selectSessionModel, remoteErrorText } from './models'
export { bindRuntime, dmsOrdersUrl, filterDmsOrders, refreshDmsOrders, isHiddenFromHome } from './runtime'
export { repoPathFromUrl, repoPathFromIssueUrl, fmtTimeRelFloor } from './format'
export { looksLikeHtml, STATE_FILTERS as PC_STATE_FILTERS, STATE_DOTS as PC_STATE_DOTS } from './components/pingcode'
export { parseUnifiedDiff, hunkRows, renderedHunks, fileStatus } from './components/diffview'
export { WB_PAGE_EVENT, isWbPage, requestWorkbenchPage, isPageEnabled, fallbackPage, workbenchRowClickHandler, sessionBadgeCounts } from './components/shell'
export { cardValue, workspaceName, sessionWorkspaceLabel, homeSessionColumns, filterBackgroundRows, applyRunningOverlay, sessionRowState, visiblePendingKind, pendingSessionIds, pendingLabel, HOME_POLL_MS, HOME_NOTES_MAX } from './components/home'
export {
  SKILLS_INSTALL_SCOPES, SKILLS_SEARCH_PRESETS, SKILLS_TARGET_AGENTS, buildSkillInstallBody,
  codeLangOf, dotenvRows, formatInstalls, installCandidates, installedMatchesQuery, isSkillScope, parseDelimitedRows,
  parseJsonForView, parseMdInline, prettyJsonForView, renderMarkdown, resolveSkillFileLink, safeHref, safeImageDataUrl,
  skillAgentLabel, skillFileGroups, skillFileView,
  SKILL_ENV_MAX_ROWS, SKILL_TABLE_MAX_COLS, SKILL_TABLE_MAX_ROWS,
} from './components/skills'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  // Capture the client session service for the turn-action button (optional:
  // the button hides itself when absent) and keep the context for click-time
  // resolution of OPTIONAL services the bundle does not inject (uiWorkspace
  // may mount after this bundle's apply).
  bindRuntime(ctx)
  registerWorkbenchShortcuts(ctx)

  ctx.effect(function () {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = '@samanhappy/dsh-workbench'
    tag.dataset.pluginCss = '@samanhappy/dsh-workbench/styles'
    tag.textContent = GL_CSS
    document.head.appendChild(tag)
    return function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag)
    }
  }, 'dsh-workbench: styles')

  // 外壳层轮询：随浏览器会话存活（与工作台面板开闭无关）。每 5 分钟刷新
  // DMS 待审批列表 / forge 工作区与最近查看视图的 host 缓存并 bump 心跳，
  // 面板订阅读心跳后以 force=false 重拉——命中缓存即返回，不重复执行 CLI。
  ctx.effect(function () {
    return startWorkbenchPolling()
  }, 'dsh-workbench: background polling')

  // 单一侧边栏 entry「工作台」：main key "workbench" 挂 WorkbenchPanel，
  // 功能页（仓库 / DMS 工单）在面板内以顶级页签切换。
  ctx.slots.inject('sidebar.panellist', function () {
    return ctx.slots.register(
      // label: shown next to the icon in the sidebar panel list
      // (falls back to the lowercase id "workbench" when absent).
      { name: 'sidebar.panellist', id: 'workbench', label: '工作台', order: 10 },
      PanelIcon
    )
  })

  ctx.slots.inject('main', function () {
    return ctx.slots.register(
      { name: 'main', key: 'workbench' },
      (props: Record<string, unknown>) => h(WorkbenchPanel, { ...props })
    )
  })

  // One 「提交 MR/PR」 button on every finalized assistant message — the same
  // additive slot the shipped message-feedback buttons occupy. The slot name
  // is declared by the monorepo ui-conversation contract and live at runtime
  // (the shipped message-feedback bundle registers into it); the locally
  // installed ui-conversation types predate the declaration, so the key is
  // narrowed to the SlotMap domain explicitly.
  ctx.slots.inject('conversation.chat.assistant-actions' as never, function () {
    return ctx.slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'workbench-git-commit', order: 99 } as any,
      GitCommitButton
    )
  })
  ctx.slots.inject('conversation.chat.assistant-actions' as never, function () {
    return ctx.slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'workbench-submit', order: 100 } as any,
      SubmitButton
    )
  })
}
