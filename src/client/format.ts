// dsh-workbench — small pure formatting helpers shared by the panels.

import type { ForgeItem } from './types'

/** Repository breadcrumb target for both platforms' review and issue pages. */
export function repoHomeUrl(webUrl: string | undefined): string {
  if (!webUrl) return ''
  const match = webUrl.match(/^(https?:\/\/.+?)(?:\/-\/(?:merge_requests|issues)\/\d+|\/(?:pull|issues)\/\d+)(?:[/?#]|$)/)
  return match ? match[1] : webUrl
}

export const fmtTime = (iso: string | number | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** Full timestamp including year (title attribute of relative labels). */
export const fmtTimeFull = (iso: string | number | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * Compact relative time for recent activity: 刚刚 / N 分钟前 / N 小时前 /
 * N 天前; older than 30 days falls back to the year-aware absolute label.
 * Returns '' for unparseable input so callers can hide the row.
 */
export const fmtTimeRel = (iso: string | number | null | undefined, now: number = Date.now()): string => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const mins = Math.max(0, Math.round((now - t) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return mins + ' 分钟前'
  const hours = Math.round(mins / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.round(hours / 24)
  if (days < 30) return days + ' 天前'
  return fmtTimeFull(iso)
}

/**
 * Relative time with the host sidebar's bucketing (dsh-client-ui-primitives
 * relativeTime): floor in every bucket, so a label computed from the same
 * instant matches the sidebar's row time exactly. Used where dsh-workbench
 * shows the same quantity as a host row (首页会话行尾时间); 刚刚 / N 分钟前 /
 * N 小时前 / N 天前 / N 个月前 / N 年前, '' for unparseable input.
 */
export const fmtTimeRelFloor = (iso: string | number | null | undefined, now: number = Date.now()): string => {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Math.max(0, now - t)
  if (diff < 60000) return '刚刚'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return mins + ' 分钟前'
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(diff / 86400000)
  if (days < 30) return days + ' 天前'
  if (days < 365) return Math.floor(days / 30) + ' 个月前'
  return Math.floor(days / 365) + ' 年前'
}

/** Parse the OWNER/REPO path out of an MR/PR web_url
 *  (https://host/group/proj/-/merge_requests/12 or
 *   https://host/OWNER/REPO/pull/12 → "group/proj" / "OWNER/REPO"). */
export const repoPathFromUrl = (url: string | null | undefined): string | null => {
  const s = String(url || '')
  let m = s.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/)
  if (m) return m[1]
  m = s.match(/^https?:\/\/[^/]+\/(.+?)\/pull\/\d+/)
  return m ? m[1] : null
}

/** Parse the OWNER/REPO path out of an Issue web_url
 *  (https://host/group/proj/-/issues/12 or https://host/OWNER/REPO/issues/12). */
export const repoPathFromIssueUrl = (url: string | null | undefined): string | null => {
  const s = String(url || '')
  let m = s.match(/^https?:\/\/[^/]+\/(.+?)\/-\/issues\/\d+/)
  if (m) return m[1]
  m = s.match(/^https?:\/\/[^/]+\/(.+?)\/issues\/\d+/)
  return m ? m[1] : null
}

/** MR !12 / PR #12 label. */
export const numLabel = (item: Pick<ForgeItem, 'forge' | 'num'> | null | undefined): string =>
  (item && item.forge === 'github' ? '#' : '!') + (item ? String(item.num) : '')

/** DMS 时间是 "2022-04-08 11:15:46" 字符串（Safari 不认空格分隔的 Date），直接切片。 */
export const dmsShortTime = (s: string | null | undefined): string => {
  const t = String(s || '')
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t) ? t.slice(5, 16) : t
}
