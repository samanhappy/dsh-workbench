// Small toolbar and row glyphs. Inline SVG so the panel ships no image assets
// and inherits `currentColor` from the theme.

import { h } from './react'

function svg(children: any, extra?: Record<string, unknown>): any {
  return h(
    'svg',
    { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', ...extra },
    children,
  )
}

export function RefreshIcon(): any {
  return svg([
    h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    h('path', { d: 'M13 2.4V5h-2.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])
}

export function CommitIcon(): any {
  return svg([
    h('circle', { cx: 8, cy: 8, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
    h('path', { d: 'M8 1.4v2.4M8 12.2v2.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
  ])
}

export function PullIcon(): any {
  return svg(h('g', { transform: 'rotate(180 8 8)' }, h(PushIcon)))
}

export function PushRemotesIcon(): any {
  return svg(h('path', {
    d: 'M8 14V9M8 9 3 5V2M8 9l5-4V2M1 4l2-2 2 2M11 4l2-2 2 2',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

export function PushIcon(): any {
  return svg([
    h('path', { d: 'M8 13V3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
    h('path', { d: 'M4.8 6.4 8 3.2l3.2 3.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
  ])
}

export function BranchIcon(): any {
  return svg([
    h('path', { d: 'M4.5 3v6.2a2.6 2.6 0 0 0 2.6 2.6h3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
    h('circle', { cx: 4.5, cy: 2.6, r: 1.25, fill: 'currentColor' }),
    h('circle', { cx: 11.6, cy: 11.8, r: 1.25, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
  ])
}

export function TagIcon(): any {
  return svg(
    h('path', {
      d: 'M2.6 3.6h4.2l6.2 6.2a1.3 1.3 0 0 1 0 1.8l-1.6 1.6a1.3 1.3 0 0 1-1.8 0L3.4 7V3.6Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinejoin: 'round',
    }),
  )
}

export function MoreIcon(): any {
  return h(
    'svg',
    { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    h('circle', { cx: 3.4, cy: 8, r: 1.15, fill: 'currentColor' }),
    h('circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor' }),
    h('circle', { cx: 12.6, cy: 8, r: 1.15, fill: 'currentColor' }),
  )
}

export function FolderIcon(): any {
  return svg(
    h('path', {
      d: 'M1.8 4.2a1.2 1.2 0 0 1 1.2-1.2h3l1.3 1.5h5.7a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3a1.2 1.2 0 0 1-1.2-1.2V4.2Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinejoin: 'round',
    }),
  )
}

export function TerminalIcon(): any {
  return svg([
    h('rect', { x: 1.9, y: 2.6, width: 12.2, height: 10.8, rx: 1.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
    h('path', { d: 'M4.4 6.2 6.6 8l-2.2 1.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('path', { d: 'M8.2 10.1h3.2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
  ])
}

/** The "write it for me" spark: four points, inheriting the text colour. */
export function SparkIcon(): any {
  return svg([
    h('path', {
      d: 'M8 1.9 9.35 6.1 13.6 7.4 9.35 8.7 8 12.9 6.65 8.7 2.4 7.4 6.65 6.1 8 1.9Z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.15,
      strokeLinejoin: 'round',
    }),
    h('path', {
      d: 'M12.6 2.2v2.1M11.55 3.25h2.1',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1,
      strokeLinecap: 'round',
    }),
  ])
}
