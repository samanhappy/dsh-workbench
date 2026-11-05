import { React, h } from '../react'
import { forgeFetch, applyNotificationUnread, refreshNotificationUnread, useShellTick } from '../runtime'
import { fmtTime } from '../format'
import { EmptyState } from '../icons'
import type { GithubNotification } from '../../host/notifications'

const REASONS: Record<string, string> = { state_change: '状态更新', subscribed: '订阅', comment: '新评论', mention: '提及你', review_requested: '请求评审', assign: '指派给你', author: '你创建的', team_mention: '提及团队', ci_activity: 'CI 更新' }
export { REASONS }
export function NotificationsPanel(props: { active: boolean }) {
  const host = 'github.com'
  const tick = useShellTick()
  const [all, setAll] = React.useState(true)
  const [page, setPage] = React.useState(1)
  const [revision, setRevision] = React.useState(0)
  const [items, setItems] = React.useState<GithubNotification[]>([])
  const [hasMore, setHasMore] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const pendingActions = React.useRef(0)

  React.useEffect(function () {
    if (!props.active) return
    let cancelled = false
    setLoading(true)
    setError('')
    setItems([])
    setHasMore(false)
    void forgeFetch('/notifications/list?host=' + encodeURIComponent(host) + '&all=' + all + '&page=' + page)
      .then(data => {
        if (cancelled) return
        if (!data.ok) throw new Error(data.error || '查询通知失败')
        // 本页拉取会刷新 host 缓存：恰好是未读数口径（未读筛选第一页）时把
        // 同一份响应喂给共享计数，返回首页的统计卡/徽标才不会停在上一轮。
        if (!all && page === 1) applyNotificationUnread(data)
        setItems(data.items)
        setHasMore(data.hasMore)
      }).catch(err => { if (!cancelled) setError(String(err.message || err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [props.active, host, all, page, revision, tick])

  async function act(id: string, action: 'read' | 'done') {
    pendingActions.current += 1
    setBusy(true)
    setError('')
    try {
      const data = await forgeFetch('/notifications/action', { method: 'POST', body: { host, id, action } })
      if (!data.ok) throw new Error(data.error || '处理通知失败')
      void refreshNotificationUnread()
      setRevision(v => v + 1)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally { pendingActions.current -= 1; setBusy(pendingActions.current > 0) }
  }

  return h('div', { className: 'glab-panel wb-notifications' },
    h('form', { className: 'wb-bar wb-notification-toolbar', onSubmit: (ev: React.FormEvent) => {
      ev.preventDefault()
      setPage(1)
      setRevision(v => v + 1)
    } },
      h('span', { className: 'wb-title' }, 'GitHub 账号通知'),
      h('div', { className: 'wb-item-actions' },
        h('select', { className: 'glab-input', 'aria-label': '通知筛选', value: all ? 'all' : 'unread', disabled: busy, onChange: (ev: React.ChangeEvent<HTMLSelectElement>) => { setAll(ev.target.value === 'all'); setPage(1) } },
          h('option', { value: 'unread' }, '未读'), h('option', { value: 'all' }, '全部')),
        h('button', { className: 'glab-btn', type: 'submit', disabled: loading || busy }, '刷新'))),
    h('div', { className: 'glab-body' },
      error ? h('div', { className: 'glab-error', role: 'alert' }, error) : null,
      loading ? h(EmptyState, { title: '加载通知…' }) : null,
      !loading && !error && items.length === 0 ? h(EmptyState, { title: '暂无通知' }) : null,
      ...items.map(it => h('div', { key: it.id, className: 'wb-notification-row' + (it.unread ? ' wb-notification-unread' : '') },
        h('div', { className: 'wb-notification-content' },
        h('a', { className: 'wb-notification-title', href: it.url, target: '_blank', rel: 'noopener noreferrer', onClick: () => { if (it.unread) void act(it.id, 'read') }, onAuxClick: (ev: React.MouseEvent) => { if (ev.button === 1 && it.unread) void act(it.id, 'read') } }, it.title),
        h('div', { className: 'wb-notification-meta' }, [it.repo, it.type === 'PullRequest' ? 'PR' : it.type, REASONS[it.reason] || it.reason, fmtTime(it.updatedAt)].filter(Boolean).join(' · '))),
        h('div', { className: 'wb-notification-actions' },
          h('a', { className: 'wb-act', href: it.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': '在 GitHub 打开', title: '在 GitHub 打开', onClick: () => { if (it.unread) void act(it.id, 'read') }, onAuxClick: (ev: React.MouseEvent) => { if (ev.button === 1 && it.unread) void act(it.id, 'read') } }, '↗'),
          it.unread ? h('button', { className: 'wb-act', disabled: busy || loading, onClick: () => { void act(it.id, 'read') } }, '标为已读') : null,
          h('button', { className: 'wb-act', disabled: busy || loading, onClick: () => { void act(it.id, 'done') }, title: '移出通知收件箱，不关闭 PR / Issue' }, '标为完成')))),
      h('div', { className: 'wb-notification-pagination' },
        h('button', { className: 'glab-btn', disabled: page === 1 || loading || busy, onClick: () => setPage(v => v - 1) }, '上一页'),
        h('span', null, '第 ' + page + ' 页'),
        h('button', { className: 'glab-btn', disabled: !hasMore || loading || busy, onClick: () => setPage(v => v + 1) }, '下一页'))))
}
