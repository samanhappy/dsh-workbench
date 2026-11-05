// History view: commits newest-first with a lane graph, five columns, a branch
// scope switch and paged loading. Selecting a commit opens the detail pane with
// its changed files and the per-file diff.

import { h } from '../../react'
import type { CommitDetailPayload, DiffPayload, HistoryCommit, HistoryScope, Translate } from '../../types'
import { DiffFileBlock } from '../DiffView'

const LANE_GAP = 14
const GRAPH_WIDTH = 88
const ROW_HEIGHT = 24

function laneX(lane: number): number {
  return 12 + lane * LANE_GAP
}

function formatDate(value: string): string {
  const text = String(value || '')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text)
  return match ? match[1] + '-' + match[2] + '-' + match[3] + ' ' + match[4] + ':' + match[5] : text
}

function graphOf(commit: HistoryCommit): any {
  const y = ROW_HEIGHT / 2
  const x = laneX(commit.lane)
  const edges = commit.parentLanes.map((parentLane, index) =>
    h('line', {
      key: 'edge:' + String(index),
      x1: x,
      y1: y + 4,
      x2: laneX(parentLane),
      y2: ROW_HEIGHT,
      stroke: 'currentColor',
      strokeWidth: 1.6,
    }),
  )
  return h(
    'svg',
    {
      className: 'wb-git-graph',
      width: GRAPH_WIDTH,
      height: ROW_HEIGHT,
      'aria-hidden': 'true',
      focusable: 'false',
      style: { color: 'var(--wb-git-lane-' + String(commit.lane % 5) + ')' },
    },
    edges,
    h('circle', { cx: x, cy: y, r: 4, fill: 'currentColor' }),
  )
}

function Detail(props: {
  detail: CommitDetailPayload | null
  detailLoading: boolean
  detailError: string
  selectedFile: string
  fileDiff: DiffPayload | null
  fileDiffLoading: boolean
  t: Translate
  onSelectFile: (path: string) => void
  onParent: (sha: string) => void
}): any {
  const { detail, t } = props
  if (props.detailLoading && detail === null) {
    return h('div', { className: 'wb-git-detail' }, h('div', { className: 'wb-git-placeholder' }, t('loading')))
  }
  if (props.detailError !== '') {
    return h('div', { className: 'wb-git-detail' }, h('div', { className: 'wb-git-placeholder wb-git-error' }, props.detailError))
  }
  if (detail === null) {
    return h('div', { className: 'wb-git-detail' }, h('div', { className: 'wb-git-placeholder' }, t('selectCommit')))
  }

  const files = detail.files ?? []
  const parents = detail.parents ?? []

  return h(
    'div',
    { className: 'wb-git-detail' },
    h(
      'div',
      { className: 'wb-git-detail-side' },
      h(
        'div',
        { className: 'wb-git-detail-meta' },
        h('div', { className: 'wb-git-detail-subject', title: detail.subject }, detail.subject ?? ''),
        h('div', { className: 'wb-git-detail-sha' }, detail.sha ?? ''),
        h('div', { className: 'wb-git-detail-line' }, (detail.author ?? '') + (detail.authorEmail ? ' <' + detail.authorEmail + '>' : '')),
        h('div', { className: 'wb-git-detail-line' }, formatDate(detail.date ?? '')),
        parents.length > 0
          ? h(
              'div',
              { className: 'wb-git-detail-line' },
              h('span', { className: 'wb-git-detail-label' }, t('parentsField') + ': '),
              parents.map((sha, index) =>
                h(
                  'button',
                  {
                    key: sha + ':' + String(index),
                    type: 'button',
                    className: 'wb-git-link',
                    onClick: () => props.onParent(sha),
                  },
                  sha.slice(0, 8),
                ),
              ),
            )
          : null,
        detail.body ? h('pre', { className: 'wb-git-detail-body' }, detail.body) : null,
      ),
      h('div', { className: 'wb-git-detail-head' }, t('changedFiles') + ' · ' + String(files.length)),
      files.length === 0
        ? null
        : h(
            'div',
            { className: 'wb-git-detail-list' },
            files.map((file) =>
              h(
                'button',
                {
                  key: file.path,
                  type: 'button',
                  className: 'wb-git-detail-file',
                  'data-active': props.selectedFile === file.path || undefined,
                  title: file.origPath ? file.path + ' ← ' + file.origPath : file.path,
                  onClick: () => props.onSelectFile(file.path),
                },
                h('span', { className: 'wb-git-detail-letter', 'data-status': file.status }, file.status[0].toUpperCase()),
                h('span', { className: 'wb-git-detail-path' }, file.path),
              ),
            ),
          ),
    ),
    h(
      'div',
      { className: 'wb-git-detail-diff' },
      files.length === 0
        ? h('div', { className: 'wb-git-empty' }, t('noFiles'))
        : props.selectedFile === ''
          ? h('div', { className: 'wb-git-empty' }, t('selectCommitFile'))
          : props.fileDiffLoading
            ? h('div', { className: 'wb-git-empty' }, t('loading'))
            : props.fileDiff && props.fileDiff.ok === false
              ? h('div', { className: 'wb-git-empty' }, props.fileDiff.error || t('diffFailed'))
              : props.fileDiff && props.fileDiff.binary
                ? h('div', { className: 'wb-git-empty' }, t('binaryFile'))
                : props.fileDiff && props.fileDiff.files && props.fileDiff.files.length > 0
                  ? props.fileDiff.files.map((file, index) =>
                      h(DiffFileBlock, { key: 'detail-file:' + String(index), file, t }),
                    )
                  : h('div', { className: 'wb-git-empty' }, t('noDiff')),
    ),
  )
}

export function HistoryView(props: {
  commits: HistoryCommit[]
  laneCount: number
  hasMore: boolean
  loading: boolean
  error: string
  scope: HistoryScope
  mode: 'history' | 'search'
  query: string
  author: string
  path: string
  onQuery: (value: string) => void
  onAuthor: (value: string) => void
  onPath: (value: string) => void
  selectedSha: string
  detail: CommitDetailPayload | null
  detailLoading: boolean
  detailError: string
  selectedFile: string
  fileDiff: DiffPayload | null
  fileDiffLoading: boolean
  t: Translate
  onScope: (scope: HistoryScope) => void
  onSelect: (commit: HistoryCommit) => void
  onLoadMore: () => void
  onSelectFile: (path: string) => void
  onParent: (sha: string) => void
  onClearScope: () => void
  onContextMenu: (commit: HistoryCommit, event: any) => void
}): any {
  const { commits, t } = props
  const scoped = props.scope.startsWith('branch:') || props.scope.startsWith('tag:')

  return h(
    'div',
    { className: 'wb-git-main' },
    h(
      'div',
      { className: 'wb-git-history' },
      h(
        'div',
        { className: 'wb-git-htoolbar' },
        h(
          'div',
          { className: 'wb-git-seg', role: 'group' },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-git-seg-btn',
              'data-active': props.scope === 'all' || undefined,
              onClick: () => props.onScope('all'),
            },
            t('allBranches'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'wb-git-seg-btn',
              'data-active': props.scope === 'current' || undefined,
              onClick: () => props.onScope('current'),
            },
            t('currentBranchOnly'),
          ),
        ),
        h('span', { className: 'wb-git-resultcount' }, String(commits.length) + ' ' + t('commitsUnit')),
        scoped
          ? h(
              'span',
              { className: 'wb-git-scope' },
              props.scope.replace(/^(branch|tag):/, ''),
              h(
                'button',
                {
                  type: 'button',
                  className: 'wb-git-scope-clear',
                  title: t('showAllBranches'),
                  'aria-label': t('showAllBranches'),
                  onClick: props.onClearScope,
                },
                '×',
              ),
            )
          : null,
        props.mode === 'search'
          ? h(
              'div',
              { className: 'wb-git-searchbar' },
              h(
                'label',
                { className: 'wb-git-filter' },
                h('span', null, t('filterMessage')),
                h('input', {
                  className: 'glab-input wb-git-search-input',
                  value: props.query,
                  placeholder: t('searchPlaceholder'),
                  'aria-label': t('searchPlaceholder'),
                  spellCheck: false,
                  onChange: (event: any) => props.onQuery(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'wb-git-filter wb-git-filter-narrow' },
                h('span', null, t('filterAuthor')),
                h('input', {
                  className: 'glab-input wb-git-search-input',
                  value: props.author,
                  'aria-label': t('searchAuthorPlaceholder'),
                  spellCheck: false,
                  onChange: (event: any) => props.onAuthor(event.target.value),
                }),
              ),
              h(
                'label',
                { className: 'wb-git-filter wb-git-filter-narrow' },
                h('span', null, t('filterPath')),
                h('input', {
                  className: 'glab-input wb-git-search-input',
                  value: props.path,
                  'aria-label': t('searchPathPlaceholder'),
                  spellCheck: false,
                  onChange: (event: any) => props.onPath(event.target.value),
                }),
              ),
            )
          : null,
      ),
      h(
        'div',
        { className: 'wb-git-hhead', role: 'row' },
        h('span', null, t('historyColumn')),
        h('span', null, t('description')),
        h('span', null, t('refsColumn')),
        h('span', null, t('commitColumn')),
        h('span', null, t('authorColumn')),
        h('span', null, t('dateColumn')),
      ),
      h(
        'div',
        { className: 'wb-git-hscroll' },
        props.loading && commits.length === 0
          ? h('div', { className: 'wb-git-placeholder' }, t('loading'))
          : props.error !== ''
            ? h('div', { className: 'wb-git-placeholder wb-git-error' }, props.error)
            : commits.length === 0
              ? h(
                  'div',
                  { className: 'wb-git-empty' },
                  props.mode === 'search' && props.query.trim() === '' && props.author.trim() === '' && props.path.trim() === ''
                    ? t('searchEmptyPrompt')
                    : t('noCommits'),
                )
              : h(
                  'div',
                  { className: 'wb-git-hlist' },
                  commits.map((commit) =>
                    h(
                      'div',
                      {
                        key: commit.sha,
                        className: 'wb-git-hrow',
                        'data-active': commit.sha === props.selectedSha || undefined,
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => props.onSelect(commit),
                        onContextMenu: (event: any) => {
                          event.preventDefault()
                          props.onContextMenu(commit, event)
                        },
                        onKeyDown: (event: any) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            props.onSelect(commit)
                          }
                        },
                      },
                      h('span', { className: 'wb-git-hgraph' }, graphOf(commit)),
                      h(
                        'span',
                        { className: 'wb-git-hsubject', title: commit.subject },
                        h('span', { className: 'wb-git-hsubject-text' }, commit.subject),
                      ),
                      h(
                        'span',
                        { className: 'wb-git-hrefs' },
                        commit.refs.slice(0, 2).map((ref) =>
                          h(
                            'span',
                            { key: ref.kind + ':' + ref.name, className: 'wb-git-refchip', 'data-kind': ref.kind, title: ref.name },
                            ref.name,
                          ),
                        ),
                        commit.refs.length > 2
                          ? h('span', { className: 'wb-git-refchip', 'data-kind': 'more' }, '+' + String(commit.refs.length - 2))
                          : null,
                      ),
                      h('span', { className: 'wb-git-hsha' }, commit.sha.slice(0, 8)),
                      h('span', { className: 'wb-git-hauthor', title: commit.author }, commit.author),
                      h('span', { className: 'wb-git-hdate' }, formatDate(commit.date)),
                    ),
                  ),
                  props.hasMore
                    ? h(
                        'div',
                        { className: 'wb-git-hmore' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'glab-btn',
                            onClick: props.onLoadMore,
                            disabled: props.loading,
                          },
                          t('loadMore'),
                        ),
                      )
                    : null,
                ),
      ),
      h(Detail, {
        detail: props.detail,
        detailLoading: props.detailLoading,
        detailError: props.detailError,
        selectedFile: props.selectedFile,
        fileDiff: props.fileDiff,
        fileDiffLoading: props.fileDiffLoading,
        t,
        onSelectFile: props.onSelectFile,
        onParent: props.onParent,
      }),
    ),
  )
}
