import type { ClientContext } from './types'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { featureFlags } from './features'
import { isPageEnabled, requestWorkbenchPage, type WbPage } from './components/shell'

// The installed DSH may predate shortcuts; keep only the contributed service face here.
interface ShortcutCommand {
  id: string
  label(): string
  aliases: string[]
  defaults: Record<string, { code: string; modifiers: readonly ['primary', 'alt'] }>
  regions: ['page', 'editable', 'terminal']
  modals: []
  resolve(): { status: 'blocked'; reason: string } | { status: 'handled'; run(): void }
}

const PAGES: readonly [WbPage, string][] = [
  ['home', '首页'], ['git', 'Git'], ['forge', '仓库'], ['dms', 'DMS'],
  ['sls', 'SLS'], ['pingcode', 'PingCode'], ['skills', '技能管理'],
  ['notifications', '通知'], ['config', '配置'],
]

export function registerWorkbenchShortcuts(ctx: ClientContext): void {
  ctx.inject(['shortcuts', 'layout'], scope => {
    const shortcuts = (scope as ClientContext & {
      shortcuts: { register(command: ShortcutCommand): () => void }
    }).shortcuts
    for (const [index, [page, label]] of PAGES.entries()) {
      const binding = { code: `Digit${index + 1}`, modifiers: ['primary', 'alt'] as const }
      scope.effect(() => shortcuts.register({
        id: `workbench.open.${page}`,
        label: () => `工作台：${label}`,
        aliases: ['workbench', page, label],
        defaults: {
          'desktop:macos': binding, 'desktop:windows': binding, 'desktop:linux': binding,
          'web:macos': binding, 'web:windows': binding,
        },
        regions: ['page', 'editable', 'terminal'], modals: [],
        resolve: () => {
          if (!isPageEnabled(page, featureFlags())) return { status: 'blocked', reason: '工作台功能已关闭' }
          return { status: 'handled', run: () => {
            requestWorkbenchPage(page)
            scope.layout.selectPanel('workbench' as MainPanelId)
          } }
        },
      }), `workbench: shortcut ${page}`)
    }
  })
}
