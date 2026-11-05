// dsh-workbench — icons and small shared presentational components.
//
// All rendering uses h() (React.createElement) directly — no JSX — matching
// the original single-file implementation and the sim-panel mini-React harness.

import { h } from './react'
import type { ForgeKey } from './types'

// ── icons ───────────────────────────────────────────────────────────────────

// GitLab tanuki logo (Phosphor GitlabLogo, currentColor fill).
const GL_LOGO_PATH = 'M230.15 117.1 210.25 41a11.94 11.94 0 0 0-22.79-1.11L169.78 88H86.22L68.54 39.87A11.94 11.94 0 0 0 45.75 41l-19.9 76.1a57.19 57.19 0 0 0 22 61l73.27 51.76a11.91 11.91 0 0 0 13.74 0l73.27-51.76a57.19 57.19 0 0 0 22.02-61ZM58 57.5l15.13 41.26a8 8 0 0 0 7.51 5.24h94.72a8 8 0 0 0 7.51-5.24L198 57.5l13.07 50L128 166.21 44.9 107.5Zm-17.32 66.61L114.13 176l-20.72 14.65L57.09 165a41.06 41.06 0 0 1-16.41-40.89Zm87.32 91-20.73-14.65L128 185.8l20.73 14.64ZM198.91 165l-36.32 25.66L141.87 176l73.45-51.9a41.06 41.06 0 0 1-16.41 40.9Z'

// GitHub mark (Simple Icons, currentColor fill).
const GH_LOGO_PATH = 'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z'

export function tanukiIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 256 256',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, h('path', { d: GL_LOGO_PATH }))
}

export function githubIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'currentColor',
    'aria-hidden': 'true',
  }, h('path', { d: GH_LOGO_PATH }))
}

// Neutral git-merge glyph (stroke), used for the 自动 platform mode.
export function mergeGlyph(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('circle', { cx: '6', cy: '6', r: '2' }),
    h('circle', { cx: '6', cy: '18', r: '2' }),
    h('circle', { cx: '18', cy: '18', r: '2' }),
    h('path', { d: 'M6 8v8' }),
    h('path', { d: 'M6 12h8a4 4 0 0 1 4 4v1' })
  )
}

// Workbench panel (Lucide PanelsTopLeft, stroke) — the sidebar icon for
// dsh-workbench: a window with a docked side panel, i.e. a workbench. Stroke
// 1.5 on the 24 box = 0.0625 relative weight, matching the native sidebar
// primitives (16 box, strokeWidth 1 "Regular one-pixel" artwork), so the row
// reads at the same line weight as the shipped 插件 / 自动化任务 icons.
export function workbenchIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }),
    h('path', { d: 'M3 9h18' }),
    h('path', { d: 'M9 21V9' })
  )
}

// 首页 (Lucide House, stroke) — the 需要我关注 aggregation landing page.
export function homeIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('path', { d: 'M3 10.5 12 3l9 7.5' }),
    h('path', { d: 'M5 10.5V21h14V10.5' }),
    h('path', { d: 'M9.5 21v-6h5v6' })
  )
}

// DMS 工单 panel (Lucide Database, stroke) — kept for reuse: the Aliyun DMS
// ticket dashboard is driven by the local aliyun CLI. The page glyphs are the
// ticket icons below.
export function dmsIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }),
    h('path', { d: 'M3 5v14a9 3 0 0 0 18 0V5' }),
    h('path', { d: 'M3 12a9 3 0 0 0 18 0' })
  )
}

// 仓库页 (Lucide FolderGit2): covers both MR/PR and Issues.
export function repositoryIcon(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M18 19a5 5 0 0 1-5-5v8' }),
    h('path', { d: 'M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5' }),
    h('circle', { cx: '13', cy: '12', r: '2' }),
    h('circle', { cx: '20', cy: '19', r: '2' }),
  ])
}

// DMS 工单 (Lucide Ticket, stroke) — the ticket glyph with a perforation line:
// reads as 工单/审批 where the old database cylinder read as "database".
export function ticketIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('path', { d: 'M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z' }),
    h('path', { d: 'M13 5v2' }),
    h('path', { d: 'M13 17v2' }),
    h('path', { d: 'M13 11v2' })
  )
}

// SLS 日志 (Lucide Logs): rows of log entries.
export function slsIcon(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M3 5h1' }),
    h('path', { d: 'M3 12h1' }),
    h('path', { d: 'M3 19h1' }),
    h('path', { d: 'M8 5h1' }),
    h('path', { d: 'M8 12h1' }),
    h('path', { d: 'M8 19h1' }),
    h('path', { d: 'M13 5h8' }),
    h('path', { d: 'M13 12h8' }),
    h('path', { d: 'M13 19h8' }),
  ])
}

// PingCode 研发管理 (Lucide ClipboardList, stroke) — the work-item dashboard
// glyph: a task board on a clipboard, distinct from the other page icons.
export function pingcodeIcon(size: number) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('rect', { x: '8', y: '2', width: '8', height: '4', rx: '1' }),
    h('path', { d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2' }),
    h('path', { d: 'M12 11h4' }),
    h('path', { d: 'M12 16h4' }),
    h('path', { d: 'M8 11h.01' }),
    h('path', { d: 'M8 16h.01' })
  )
}

// 技能管理 (Lucide Blocks): installable, composable capabilities.
export function skillIcon(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2' }),
    h('rect', { x: '14', y: '2', width: '8', height: '8', rx: '1' }),
  ])
}

export function forgeIcon(forge: ForgeKey | null, size: number) {
  if (forge === 'gitlab') return tanukiIcon(size)
  if (forge === 'github') return githubIcon(size)
  return mergeGlyph(size)
}

// Small stroke glyphs (Lucide geometry, 24 box) shared by the redesigned UI.
export function strokeGlyph(size: number, children: React.ReactNode) {
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }, children)
}
export function chevronGlyph(size: number) {
  return strokeGlyph(size, h('path', { d: 'm6 9 6 6 6-6' }))
}
/** 右向 chevron（列表行尾 / 「查看全部」行尾箭头）。 */
export function chevronRightGlyph(size: number) {
  return strokeGlyph(size, h('path', { d: 'm9 6 6 6-6 6' }))
}
export function plusGlyph(size: number) {
  return strokeGlyph(size, [h('path', { d: 'M5 12h14' }), h('path', { d: 'M12 5v14' })])
}
export function checkGlyph(size: number) {
  return strokeGlyph(size, h('path', { d: 'M20 6 9 17l-5-5' }))
}
export function dotsGlyph(size: number) {
  return strokeGlyph(size, [
    h('circle', { cx: '5', cy: '12', r: '1.2' }),
    h('circle', { cx: '12', cy: '12', r: '1.2' }),
    h('circle', { cx: '19', cy: '12', r: '1.2' }),
  ])
}
export function externalGlyph(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M15 3h6v6' }),
    h('path', { d: 'M10 14 21 3' }),
    h('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
  ])
}
export function xGlyph(size: number) {
  return strokeGlyph(size, [h('path', { d: 'M18 6 6 18' }), h('path', { d: 'm6 6 12 12' })])
}
export function copyGlyph(size: number) {
  return strokeGlyph(size, [
    h('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
    h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
  ])
}
export function gearGlyph(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M20 7h-9' }),
    h('path', { d: 'M14 17H5' }),
    h('circle', { cx: '17', cy: '17', r: '3' }),
    h('circle', { cx: '7', cy: '7', r: '3' }),
  ])
}
export function inboxGlyph(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M22 12h-6l-2 3h-4l-2-3H2' }),
    h('path', { d: 'M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }),
  ])
}

// Issues 页 glyphs（Lucide geometry）：开启=时钟圆圈、关闭=对勾圆圈、搜索、
// 排序（上下箭头）、评论气泡、人员。
export function clockCircleGlyph(size: number) {
  return strokeGlyph(size, [
    h('circle', { cx: '12', cy: '12', r: '9' }),
    h('path', { d: 'M12 7v5l3 2' }),
  ])
}
export function checkCircleGlyph(size: number) {
  return strokeGlyph(size, [
    h('circle', { cx: '12', cy: '12', r: '9' }),
    h('path', { d: 'm8.5 12.2 2.4 2.4 4.8-5' }),
  ])
}
export function searchGlyph(size: number) {
  return strokeGlyph(size, [
    h('circle', { cx: '11', cy: '11', r: '7' }),
    h('path', { d: 'm20.5 20.5-4-4' }),
  ])
}
export function sortGlyph(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'm21 16-4 4-4-4' }),
    h('path', { d: 'M17 20V4' }),
    h('path', { d: 'm3 8 4-4 4 4' }),
    h('path', { d: 'M7 4v16' }),
  ])
}
export function bubbleGlyph(size: number) {
  return strokeGlyph(size, [
    h('path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }),
  ])
}
export function userGlyph(size: number) {
  return strokeGlyph(size, [
    h('circle', { cx: '12', cy: '8', r: '3.5' }),
    h('path', { d: 'M5.5 20a6.5 6.5 0 0 1 13 0' }),
  ])
}

export function RefreshGlyph(busy: boolean) {
  return h('svg', {
    viewBox: '0 0 24 24', width: 13, height: 13, fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    className: busy ? 'glab-spin' : undefined,
  },
    h('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
    h('path', { d: 'M21 3v5h-5' })
  )
}

// ── small shared components ─────────────────────────────────────────────────

export interface WbProps {
  children?: unknown
  [key: string]: unknown
}

export function Chip(props: { kind?: string; title?: string; children?: React.ReactNode } & Record<string, unknown>) {
  const cls = ['glab-chip']
  if (props.kind) cls.push('glab-chip-' + props.kind)
  return h('span', { className: cls.join(' '), title: props.title }, props.children)
}

// Empty state: icon + title + one-line hint (replaces the bare text line).
export function EmptyState(props: { icon?: React.ReactNode; title?: string; hint?: React.ReactNode }) {
  return h('div', { className: 'wb-empty' },
    h('div', { className: 'wb-empty-icon' }, props.icon || inboxGlyph(28)),
    props.title ? h('div', { className: 'wb-empty-title' }, props.title) : null,
    props.hint || null
  )
}

// Official Git mark: https://git-scm.com/images/logos/downloads/Git-Icon-1788C.svg
export function gitIcon(size: number) {
  return h('svg', { viewBox: '0 0 78 78', width: size, height: size, 'aria-hidden': 'true' },
    h('path', { fill: 'currentColor', transform: 'translate(10 10) rotate(-45 29 29)',
      d: 'M5,58c-2.76142,0 -5,-2.23858 -5,-5v-48c0,-2.76142 2.23858,-5 5,-5h33v12.54404c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,0.73514 0.13221,1.43941 0.37415,2.09031l-15.28384,15.28384c-0.6509,-0.24194 -1.35517,-0.37415 -2.09031,-0.37415c-3.31371,0 -6,2.68629 -6,6c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-0.73514 -0.13221,-1.43941 -0.37415,-2.09031l14.87415,-14.87415l0,11.50851c-2.06553,0.94801 -3.5,3.03446 -3.5,5.45596c0,3.31371 2.68629,6 6,6c3.31371,0 6,-2.68629 6,-6c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.08808c2.06553,-0.94801 3.5,-3.03446 3.5,-5.45596c0,-2.42149 -1.43447,-4.50795 -3.5,-5.45596l0,-12.54404h10c2.76142,0 5,2.23858 5,5v48c0,2.76142 -2.23858,5 -5,5z' }))
}
