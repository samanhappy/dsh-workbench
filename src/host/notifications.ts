import type { Runner } from './runner'

export function notificationHost(value: unknown): string {
  const host = String(value || 'github.com').trim().toLowerCase()
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)) throw new Error('无效的 GitHub host')
  return host
}

export function notificationListArgv(query: Record<string, string>): string[] {
  const page = Number(query.page || 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new Error('无效的通知页码')
  return ['api', '--hostname', notificationHost(query.host), '-H', 'Accept: application/vnd.github+json',
    `notifications?all=${query.all === 'true'}&per_page=50&page=${page}`]
}

export function notificationActionArgv(body: Record<string, unknown>): string[] {
  const id = String(body.id || '')
  if (!/^\d+$/.test(id)) throw new Error('无效的通知编号')
  if (body.action !== 'read' && body.action !== 'done') throw new Error('无效的通知操作')
  return ['api', '--hostname', notificationHost(body.host), '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2026-03-10', '--method', body.action === 'read' ? 'PATCH' : 'DELETE',
    'notifications/threads/' + id]
}

export interface GithubNotification {
  id: string
  title: string
  repo: string
  type: string
  reason: string
  unread: boolean
  updatedAt: string
  url: string
}

export function parseNotifications(raw: string, host: string): GithubNotification[] {
  const rows = JSON.parse(raw)
  if (!Array.isArray(rows)) throw new Error('通知响应不是列表')
  return rows.filter(it => it && /^\d+$/.test(String(it.id))).map(it => {
    // Use a web URL on the selected host, never a CLI-provided arbitrary link.
    let url = `https://${host}/notifications?query=thread%3A${it.id}`
    const repo = String(it.repository?.full_name || '')
    const subject = String(it.subject?.url || '').match(/\/repos\/([^/]+\/[^/]+)\/(issues|pulls|discussions)\/(\d+)$/)
    if (subject && subject[1] === repo && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) url = `https://${host}/${repo}/${subject[2] === 'pulls' ? 'pull' : subject[2]}/${subject[3]}`
    const comment = String(it.subject?.latest_comment_url || '').match(/\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/comments\/(\d+)$/)
    if (subject && comment && comment[1] === repo && !url.includes('/notifications?')) {
      url += '#' + (comment[2] === 'issues' ? 'issuecomment-' : 'discussion_r') + comment[3]
    }
    return { id: String(it.id), title: String(it.subject?.title || '通知'), repo,
      type: String(it.subject?.type || ''), reason: String(it.reason || ''), unread: it.unread === true,
      updatedAt: String(it.updated_at || ''), url }
  })
}

export async function loadNotifications(runner: Runner, query: Record<string, string>) {
  const host = notificationHost(query.host)
  const items = parseNotifications(await runner.forgeRun('github', notificationListArgv(query)), host)
  const advisories = items.filter(it => it.type === 'RepositoryAdvisory' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(it.repo)
    && it.repo.split('/').every(part => part !== '.' && part !== '..'))
  await Promise.all([...new Set(advisories.map(it => it.repo))].map(async repo => {
    try {
      // Advisory notifications can omit both subject URLs; resolve only unambiguous titles.
      const pages = JSON.parse(await runner.forgeRun('github', ['api', '--hostname', host, '--paginate', '--slurp',
        `repos/${repo}/security-advisories?per_page=100`]))
      const rows = pages.flat()
      for (const item of advisories.filter(it => it.repo === repo)) {
        const matches = rows.filter((row: any) => row?.summary === item.title)
        if (matches.length === 1 && /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/.test(matches[0].ghsa_id)) {
          item.url = `https://${host}/${repo}/security/advisories/${matches[0].ghsa_id}`
        }
      }
    } catch { /* Keep the notification link when advisory access is unavailable. */ }
  }))
  return { ok: true, items, hasMore: items.length === 50 }
}
