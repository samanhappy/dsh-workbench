// dsh-workbench — MR/PR 详情代码差异视图。
//
// 移植自 DeepSeek Harness ui-deliverables 的 ReviewTab 统一 diff 渲染核心
// （hunkRows / renderedHunks + 行号网格样式，MIT，Copyright (c) 2026
// DeepSeek），数据侧换成对 unified diff 文本（glab mr diff / gh pr diff 的
// 输出，经 /forge/mr/diff 路由）的解析：jsdiff parsePatch 把文本转成与
// workspace-changes 的 WorkspaceDiffHunk 同形的 hunk 结构，再按文件分组渲染
// 行号 + 增删着色 + @@ hunk 头。
//
// 解析层契约（test/diff-view.mjs 逐条断言）：
//   - 按文件分节解析，两种边界方言都认：git 风格 `diff --git` 头，以及 glab
//     风格的裸 `--- 全路径` / `+++ 全路径` 拼接（GitLab API per-file diff，实测
//     没有 diff --git 行）；hunk 体内按声明行数跟踪状态，删除内容恰以 `--`
//     开头（渲染成 `--- …`）的行不会被误判为边界；一节坏 hunk（parsePatch
//     抛错）只降级该节，其余文件存活；
//   - `a/` `b/` 前缀只在 git 配对（old a/… + new b/…）时剥离，glab 风格的
//     裸路径（可能真有 a/ 开头的文件名）原样保留；
//   - 先剥离 ANSI 色码（glab 可能带色输出，否则 ---/+++ 文件名解析不出）；
//   - /dev/null 识别新建 / 删除；`Binary files … differ` 识别二进制文件；
//   - 纯权限变更（old/new mode、无 hunk）标注 modeChange；
//   - 引号 + 八进制转义路径（git 对含空格 / 非 ASCII 路径的默认输出）解码；
//   - 任何输入都不抛异常：空 / 乱文本 → 空数组。

import { parsePatch } from 'diff'
import { React, h } from '../react'
import { chevronGlyph } from '../icons'
import type * as ReactTypes from 'react'

/** One unified-diff hunk, the same shape as workspace-changes' WorkspaceDiffHunk. */
export interface WbDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** One numbered diff row: deletions count on the old side, additions on the new. */
export interface WbDiffRow {
  kind: 'add' | 'del' | 'context'
  old: number | undefined
  new: number | undefined
  text: string
}

/** One file's parsed diff with the summary facts the header and notes draw. */
export interface WbDiffFile {
  path: string
  added: number
  deleted: number
  before: boolean
  after: boolean
  binary: boolean
  modeChange: string | null
  hunks: WbDiffHunk[]
}

/** Lines drawn before the render budget collapses the rest (harness ReviewTab parity). */
export const MAX_RENDERED_LINES = 5000

/** The subset of jsdiff's ParsedPatch this module reads (oldMode/newMode are runtime-only fields). */
interface GitParsedPatch {
  oldFileName?: string | null
  newFileName?: string | null
  oldMode?: string | null
  newMode?: string | null
  hunks: WbDiffHunk[]
}

/** Strip ANSI CSI sequences (colors et al) — glab may colorize its diff output. */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

/**
 * Decode one ---/+++ (or diff --git) path: strip old-style tab timestamps,
 * unquote, then decode git quotepath escapes (\ooo octal bytes or one literal
 * character) as UTF-8 — `docs/\344\272\214.md` → `docs/二.md`.
 */
function decodeGitPath(raw: string): string {
  let s = raw.trim()
  s = s.replace(/\t.*$/, '')
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1)
  if (!s.includes('\\')) return s
  const bytes: number[] = []
  const encoder = new TextEncoder()
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\') {
      const oct = /^[0-7]{3}/.exec(s.slice(i + 1))
      if (oct) { bytes.push(parseInt(oct[0], 8)); i += 4; continue }
      if (i + 1 < s.length) { for (const b of encoder.encode(s[i + 1])) bytes.push(b); i += 2; continue }
      i += 1
      continue
    }
    for (const b of encoder.encode(s[i])) bytes.push(b)
    i += 1
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** The display path of one side, '' for /dev/null or an unusable name. */
function toDisplayPath(raw: string | null | undefined, stripPrefix: boolean): string {
  if (!raw) return ''
  const s = decodeGitPath(raw)
  if (!s || s === '/dev/null') return ''
  return stripPrefix ? s.replace(/^[ab]\//, '') : s
}

/**
 * Whether old/new carry git's a/ b/ prefixes: strip them only for genuine git
 * pairs — `glab mr diff` emits bare full paths (GitLab API per-file diffs), so
 * a file really named `a/legacy.txt` must survive untouched there.
 */
function isGitPrefixed(oldName: string | null | undefined, newName: string | null | undefined): boolean {
  const o = !oldName || oldName === '/dev/null' ? '' : oldName
  const n = !newName || newName === '/dev/null' ? '' : newName
  if (o.startsWith('a/')) return n === '' || n.startsWith('b/')
  return o === '' && n.startsWith('b/')
}

/** A hunk header's total body-line count (context counts on both sides). */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Split a patch text into per-file sections. Two boundary dialects:
 *   - git-style `diff --git ` headers, and
 *   - glab-style bare `--- path` / `+++ path` blocks (GitLab API per-file
 *     diffs concatenated, no `diff --git` line at all),
 * whichever occurs. Hunk bodies are tracked by their declared line counts so
 * a deleted line whose text starts with `--` (rendered `--- …`) or an added
 * `++ …` line inside a hunk is never mistaken for a boundary, and
 * `\ No newline at end of file` lines don't offset the count. Text before the
 * first boundary is preamble.
 */
function diffSections(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let cur: string[] | null = null
  // Remaining hunk-body budget per side: context consumes one line from BOTH,
  // deletions from the old side, additions from the new. A hunk is over once
  // both hit zero (well-formed hunks land there exactly on the last body line).
  let oldLeft = 0
  let newLeft = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // A `--- ` boundary only opens a glab-style section; inside a git section
    // (opened by `diff --git `) the `--- ` line is that section's own header.
    const curIsGit = cur !== null && cur[0].startsWith('diff --git ')
    const startsFile = oldLeft === 0 && newLeft === 0 && (
      line.startsWith('diff --git ') ||
      (!curIsGit && line.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')))
    if (startsFile) {
      if (cur) sections.push(cur.join('\n'))
      cur = [line]
      continue
    }
    if (cur) {
      cur.push(line)
      const hunk = HUNK_HEADER_RE.exec(line)
      if (hunk) {
        oldLeft = Number(hunk[2] ?? 1)
        newLeft = Number(hunk[4] ?? 1)
      } else if ((oldLeft > 0 || newLeft > 0) && !line.startsWith('\\')) {
        if (line.startsWith('+')) newLeft = Math.max(0, newLeft - 1)
        else if (line.startsWith('-')) oldLeft = Math.max(0, oldLeft - 1)
        else { oldLeft = Math.max(0, oldLeft - 1); newLeft = Math.max(0, newLeft - 1) }
      }
    }
  }
  if (cur) sections.push(cur.join('\n'))
  return sections
}

/** parsePatch one section; a malformed section degrades to null (isolation). */
function parseSection(section: string): GitParsedPatch | null {
  try {
    return (parsePatch(section) as unknown as GitParsedPatch[])[0] ?? null
  } catch {
    return null
  }
}

/** Map one section to a file entry; null when the section yields no file at all. */
function parseFileSection(section: string): WbDiffFile | null {
  const patch = parseSection(section)
  const oldName = patch?.oldFileName ?? null
  const newName = patch?.newFileName ?? null
  const hunks = patch?.hunks ?? []
  const strip = isGitPrefixed(oldName, newName)
  const path = toDisplayPath(newName, strip) || toDisplayPath(oldName, strip)
  if (!path && hunks.length === 0) return null
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) deleted++
    }
  }
  const before = oldName != null && oldName !== '/dev/null'
  const after = newName != null && newName !== '/dev/null'
  const oldMode = patch?.oldMode ?? null
  const newMode = patch?.newMode ?? null
  const modeChange = oldMode && newMode && oldMode !== newMode && before && after
    ? oldMode + ' → ' + newMode
    : null
  return {
    path: path || '(未知文件)',
    added,
    deleted,
    before,
    after,
    binary: /^Binary files .* differ/m.test(section),
    modeChange,
    hunks,
  }
}

/**
 * Parse a unified diff text (git-style multi-file or plain) into per-file
 * entries. Never throws: empty / garbage input parses to an empty list, and a
 * malformed section is dropped while the others survive.
 */
export function parseUnifiedDiff(text: string | null | undefined): WbDiffFile[] {
  if (!text) return []
  const clean = text.replace(ANSI_RE, '').replace(/\r\n/g, '\n')
  const files: WbDiffFile[] = []
  for (const section of diffSections(clean)) {
    const file = parseFileSection(section)
    if (file) files.push(file)
  }
  return files
}

/**
 * Number a hunk's rows: context lines count on both sides, deletions on the
 * old side, additions on the new (harness ReviewTab hunkRows parity).
 */
export function hunkRows(hunk: WbDiffHunk): WbDiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    const text = line.slice(1)
    if (line.startsWith('+')) return { kind: 'add' as const, old: undefined, new: newNo++, text }
    if (line.startsWith('-')) return { kind: 'del' as const, old: oldNo++, new: undefined, text }
    return { kind: 'context' as const, old: oldNo++, new: newNo++, text }
  })
}

/**
 * The hunks to draw, cut at `budget` body lines in total, with the last one
 * shortened as needed (harness ReviewTab renderedHunks parity).
 */
export function renderedHunks(hunks: WbDiffHunk[], budget = MAX_RENDERED_LINES): { hunks: WbDiffHunk[]; truncated: boolean } {
  let left = budget
  const kept: WbDiffHunk[] = []
  for (const hunk of hunks) {
    if (left === 0) return { hunks: kept, truncated: true }
    kept.push(hunk.lines.length <= left ? hunk : { ...hunk, lines: hunk.lines.slice(0, left) })
    left -= Math.min(left, hunk.lines.length)
  }
  return { hunks: kept, truncated: kept.some((hunk, at) => hunk !== hunks[at]) }
}

const KIND_CLASS = { add: 'wb-diff-add', del: 'wb-diff-del', context: 'wb-diff-ctx' } as const

/** The one-letter status a file row shows: A created / D deleted / M modified. */
export function fileStatus(file: WbDiffFile): 'A' | 'D' | 'M' {
  if (!file.before) return 'A'
  if (!file.after) return 'D'
  return 'M'
}

const STATUS_TITLE = { A: '新建文件', D: '文件已删除', M: '修改' } as const

/** One file's diff body: fact notes + numbered, colored hunks. No hooks. */
function fileBodyNodes(file: WbDiffFile): ReactTypes.ReactNode[] {
  const { hunks, truncated } = renderedHunks(file.hunks)
  const body: ReactTypes.ReactNode[] = []
  if (file.binary) body.push(h('p', { key: 'binary', className: 'wb-diff-note' }, '二进制文件，不显示内容差异'))
  if (file.modeChange) body.push(h('p', { key: 'mode', className: 'wb-diff-note' }, '权限变更 ' + file.modeChange))
  if (!file.before) body.push(h('p', { key: 'created', className: 'wb-diff-note' }, '新建文件'))
  if (!file.after) body.push(h('p', { key: 'deleted', className: 'wb-diff-note' }, '文件已删除'))
  if (truncated) body.push(h('p', { key: 'cut', className: 'wb-diff-note' }, '差异过大，仅显示前 ' + MAX_RENDERED_LINES + ' 行'))
  for (const [hi, hunk] of hunks.entries()) {
    body.push(h('section', { key: 'h' + hi, className: 'wb-diff-hunk' },
      h('div', { className: 'wb-diff-hunk-header' },
        '@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@'),
      hunkRows(hunk).map((row, ri) => h('div', { key: ri, className: 'wb-diff-line ' + KIND_CLASS[row.kind] },
        h('span', { key: 'o', className: 'wb-diff-num' }, row.old ?? ''),
        h('span', { key: 'n', className: 'wb-diff-num' }, row.new ?? ''),
        h('span', { key: 's', className: 'wb-diff-sign' }, row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '),
        h('span', { key: 'x', className: 'wb-diff-text' }, row.text),
      )),
    ))
  }
  return body
}

/**
 * The MR/PR detail diff view (代码差异 tab): a toolbar (file/line totals,
 * name filter, expand-all / collapse-all, wrap toggle) above the file list —
 * one collapsible section per file (status letter + path + counts + chevron
 * row, expanding to its hunks), harness git-view style. Only the FIRST file
 * starts expanded (a 24-file MR otherwise renders thousands of lines at
 * once); wrap is ON by default so long lines aren't hard-clipped. Expansion
 * state lives here as the inverted `collapsed` set so the row buttons stay
 * hook-free. Module-scope component — its hooks must not live in a
 * ForgePanel closure. Mount with a per-MR `key` so switching MRs resets it.
 */
export function DiffView(props: { diffText: string }): ReactTypes.ReactNode {
  // Parse once per text (useMemo, component-scoped — the old module-global
  // single cache was shared with the badge parser and invalidated implicitly).
  const allFiles = React.useMemo(
    (): WbDiffFile[] => parseUnifiedDiff(props.diffText), [props.diffText])
  // Multi-file MRs render with only the first file open (a 24-file diff would
  // otherwise mount thousands of lines at once); tiny diffs open outright.
  const [collapsed, setCollapsed] = React.useState(
    (): Set<number> => new Set(allFiles.length > 2 ? allFiles.slice(1).map((_, i) => i + 1) : []))
  const [wrap, setWrap] = React.useState(true)
  const [filter, setFilter] = React.useState('')

  if (allFiles.length === 0) {
    return h('div', { className: 'wb-diff wb-diff-empty' }, 'diff 内容为空或无法解析')
  }
  const needle = filter.trim().toLowerCase()
  const visible = needle
    ? allFiles.map((f, i) => ({ f, i })).filter(function (x) { return x.f.path.toLowerCase().includes(needle) })
    : allFiles.map((f, i) => ({ f, i }))
  const totalAdded = allFiles.reduce((s, f) => s + f.added, 0)
  const totalDeleted = allFiles.reduce((s, f) => s + f.deleted, 0)
  const toggle = (i: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const allOpen = visible.every((x) => !collapsed.has(x.i))
  const allClosed = visible.every((x) => collapsed.has(x.i))
  return h('div', { className: 'wb-diff', 'data-diff': '', ...(wrap ? { 'data-wrap': '1' } : {}) },
    h('div', { className: 'wb-diff-toolbar' },
      h('span', { className: 'wb-diff-summary' },
        allFiles.length + ' 个文件 · ',
        h('span', { className: 'wb-diff-count-added' }, '+' + totalAdded),
        ' ',
        h('span', { className: 'wb-diff-count-deleted' }, '-' + totalDeleted)),
      h('input', {
        className: 'glab-input wb-diff-filter', type: 'search', value: filter, spellCheck: false,
        placeholder: '筛选文件名', 'aria-label': '筛选文件名',
        onChange: (e: ReactTypes.ChangeEvent<HTMLInputElement>) => setFilter(e.target.value),
      }),
      h('span', { className: 'wb-diff-toolbar-spacer' }),
      h('button', { type: 'button', className: 'wb-diff-tool', disabled: !visible.length || allOpen, onClick: () => { setCollapsed(new Set()) } }, '全部展开'),
      h('button', { type: 'button', className: 'wb-diff-tool', disabled: !visible.length || allClosed, onClick: () => { setCollapsed(new Set(visible.map((x) => x.i))) } }, '全部收起'),
      h('button', { type: 'button', className: 'wb-diff-tool', 'aria-pressed': wrap, onClick: () => { setWrap(!wrap) } }, '自动换行'),
    ),
    visible.length === 0
      ? h('div', { className: 'wb-diff-empty' }, '没有匹配「' + filter + '」的文件')
      : h('div', { className: 'wb-diff-files' },
          visible.map(({ f, i }) => {
            const open = !collapsed.has(i)
            const st = fileStatus(f)
            return h('section', { key: i, className: 'wb-diff-file-sec' },
              h('button', {
                type: 'button',
                className: 'wb-diff-file-row',
                'aria-expanded': open,
                title: STATUS_TITLE[st] + ' · ' + f.path,
                onClick: () => { toggle(i) },
              },
                h('span', { className: 'wb-diff-status wb-diff-st-' + st }, st),
                h('span', { className: 'wb-diff-file-name' }, f.path + (f.binary ? '（二进制）' : '')),
                h('span', { className: 'wb-diff-counts' },
                  h('span', { className: 'wb-diff-count-added' }, '+' + f.added),
                  ' ',
                  h('span', { className: 'wb-diff-count-deleted' }, '-' + f.deleted)),
                h('span', { className: 'wb-diff-chev' + (open ? ' wb-diff-chev-open' : '') }, chevronGlyph(14)),
              ),
              open ? h('div', { className: 'wb-diff-body' }, fileBodyNodes(f)) : null,
            )
          }),
        ),
  )
}
