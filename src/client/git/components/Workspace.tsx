// The workspace shell: repository, view, status state and host calls. Each view
// renders its own surface; the shell owns the toolbar, the reference rail and
// the shared banners.

import { ToastLayer } from '../../components/common'
import { resolveConfigText } from '../../prompts'
import { h, React } from '../react'
import type {
  AiCommitControls,
  AiModelsPayload,
  EntrySide,
  GitFileEntry,
  GitStatusPayload,
  DiffPayload,
  CommitDetailPayload,
  HistoryCommit,
  HistoryScope,
  OpenTarget,
  RefsPayload,
  RefRecord,
  Translate,
} from '../types'
import {
  checkoutBranch,
  commitChanges,
  discardPaths,
  generateCommitMessage,
  mergeBranch,
  pushBranch,
  pullBranch,
  createBranch,
  deleteBranch,
  renameBranch,
  fetchAiModels,
  saveAiModel,
  fetchCommitInfo,
  fetchDiff,
  fetchHistory,
  fetchRefs,
  fetchStatus,
  openLocal,
  removePaths,
  stagePaths,
  unstagePaths,
} from '../routes'
import { commitScope, rowKey, sideFor, splitEntries, statusLetter } from '../model'
import { PanelResize } from './atoms'
import { TopBar } from './TopBar'
import { RefRail } from './RefRail'
import { StatusView } from './views/StatusView'
import { HistoryView } from './views/HistoryView'
import { ConfirmDialog, PromptDialog } from './Dialogs'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuEntry, ContextMenuState } from './ContextMenu'
import type { ViewKind } from '../types'

const POLL_MS = 2000

function findEntry(status: GitStatusPayload | null, path: string): GitFileEntry | null {
  return (status?.entries ?? []).find((entry) => entry.path === path) ?? null
}

/** Pick the side a path should be selected under after a status refresh. */
function sideOf(entry: GitFileEntry): EntrySide {
  if (entry.conflicted) return 'conflicted'
  if (entry.staged) return 'staged'
  return 'unstaged'
}

/** What the commit card needs from the AI model catalog; one object, one prop. */
export type AiCommitProps = AiCommitControls

export function Workspace(props: { t?: Translate; locale?: () => string; active?: boolean; cwd: string }): any {
  const t: Translate = typeof props.t === 'function' ? props.t : (key: string) => key

  const [status, setStatus] = React.useState<GitStatusPayload | null>(null)
  const [refs, setRefs] = React.useState<RefsPayload | null>(null)
  const repoPath = props.cwd
  const [view, setView] = React.useState<ViewKind>('status')

  const [historyCommits, setHistoryCommits] = React.useState<HistoryCommit[]>([])
  const [historyLaneCount, setHistoryLaneCount] = React.useState(1)
  const [historyHasMore, setHistoryHasMore] = React.useState(false)
  const [historyLoading, setHistoryLoading] = React.useState(false)
  const [historyError, setHistoryError] = React.useState('')
  const [historyScope, setHistoryScope] = React.useState<HistoryScope>('all')
  const [historySha, setHistorySha] = React.useState('')
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searchAuthor, setSearchAuthor] = React.useState('')
  const [searchPath, setSearchPath] = React.useState('')
  const [appliedQuery, setAppliedQuery] = React.useState('')
  const [appliedAuthor, setAppliedAuthor] = React.useState('')
  const [appliedPath, setAppliedPath] = React.useState('')
  const [commitDetail, setCommitDetail] = React.useState<CommitDetailPayload | null>(null)
  const [commitDetailLoading, setCommitDetailLoading] = React.useState(false)
  const [commitDetailError, setCommitDetailError] = React.useState('')
  const [commitFile, setCommitFile] = React.useState('')
  const [commitFileDiff, setCommitFileDiff] = React.useState<DiffPayload | null>(null)
  const [commitFileDiffLoading, setCommitFileDiffLoading] = React.useState(false)

  const [dialog, setDialog] = React.useState<{
    kind: 'create' | 'rename' | 'delete' | 'discard' | 'remove' | 'remove-untracked' | 'merge' | 'push'
    branch?: string
    start?: string
    path?: string
    side?: EntrySide
  } | null>(null)
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null)
  const [commitCollapsed, setCommitCollapsed] = React.useState(true)
  const [aiModels, setAiModels] = React.useState<AiModelsPayload | null>(null)
  const [aiLoading, setAiLoading] = React.useState(false)
  const [aiBusy, setAiBusy] = React.useState(false)
  const [dialogBusy, setDialogBusy] = React.useState(false)
  const [dialogError, setDialogError] = React.useState('')
  const [statusError, setStatusError] = React.useState('')
  const [selected, setSelected] = React.useState<{ path: string; side: EntrySide } | null>(null)
  const [diff, setDiff] = React.useState<DiffPayload | null>(null)
  const [fileStats, setFileStats] = React.useState<Record<string, { additions: number; deletions: number }>>({})
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)
  const [opening, setOpening] = React.useState(false)
  const [actionError, setActionError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [toast, setToast] = React.useState('')
  const [notice, setNotice] = React.useState('')

  const busyRef = React.useRef(false)
  const commitInput = React.useRef<any>(null)
  const toastTimer = React.useRef<any>(null)
  React.useEffect(() => {
    busyRef.current = busy
  }, [busy])

  const setCommitFold = setCommitCollapsed

  const showToast = React.useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 6000)
  }, [])

  const loadStatus = React.useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) setRefreshing(true)
      try {
        const next = await fetchStatus(repoPath || undefined)
        if (next.ok) {
          setStatus(next)
          setStatusError('')
        } else {
          setStatus(null)
          setStatusError(next.error || t('statusFailed'))
        }
      } catch (error) {
        setStatus(null)
        setStatusError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!options?.silent) setRefreshing(false)
      }
    },
    [repoPath, t],
  )

  const loadRefs = React.useCallback(async () => {
    try {
      const next = await fetchRefs(repoPath || undefined)
      if (next.ok) setRefs(next)
    } catch {
      /* the rail degrades to empty groups */
    }
  }, [repoPath])

  /** Refresh the live DSH model catalog and the route the card will call. */
  const loadAiModels = React.useCallback(async () => {
    setAiLoading(true)
    try {
      const next = await fetchAiModels()
      setAiModels(next.ok ? next : { ok: false, groups: [], failures: [], active: null, error: next.error })
    } catch {
      setAiModels({ ok: false, groups: [], failures: [], active: null })
    } finally {
      setAiLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadAiModels()
  }, [loadAiModels])

  // Match the scope used by commit, without staging during AI generation.
  const generateMessage = React.useCallback(async () => {
    if (busyRef.current || aiBusy) return
    const { side, entries } = commitScope(status?.entries ?? [])
    const source = entries.slice(0, 60)
    const files = source.map((entry) => ({ path: entry.path, status: statusLetter(entry, side) }))
    if (files.length === 0) {
      showToast(t('aiNoChanges'))
      return
    }
    setAiBusy(true)
    setActionError('')
    try {
      const locale = typeof props.locale === 'function' ? props.locale() : 'en'
      const payload = await generateCommitMessage({ side, files, locale, language: resolveConfigText('git.commit.language'), prompt: resolveConfigText('prompt.git.commit') }, repoPath || undefined)
      if (!payload.ok || typeof payload.message !== 'string' || payload.message === '') {
        throw new Error(payload.error || t('aiFailed'))
      }
      setMessage(payload.message)
      showToast(t('aiDone'))
      setTimeout(() => {
        if (commitInput.current && commitInput.current.focus) commitInput.current.focus()
      }, 0)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      setActionError(text)
      showToast(text)
    } finally {
      setAiBusy(false)
    }
  }, [aiBusy, props.locale, repoPath, showToast, status, t])

  const selectAiModel = React.useCallback(
    async (provider: string, model: string) => {
      try {
        const saved = await saveAiModel(provider, model)
        if (!saved.ok) throw new Error(saved.error || t('aiModelSaveFailed'))
        await loadAiModels()
        showToast(t('aiModelSwitched'))
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      }
    },
    [loadAiModels, showToast, t],
  )

  const aiCommit: AiCommitProps = {
    loading: aiLoading,
    busy: aiBusy,
    groups: aiModels?.groups ?? [],
    failures: aiModels?.failures ?? [],
    active: aiModels?.active ?? null,
    error: aiModels?.error || (aiModels && aiModels.ok === false ? t('aiFailed') : ''),
    onGenerate: () => void generateMessage(),
    onSelect: (provider: string, model: string) => void selectAiModel(provider, model),
  }

  const statsKey = JSON.stringify([repoPath, status?.oid, (status?.entries ?? []).map(entry => [entry.path, entry.x, entry.y])])
  React.useEffect(() => {
    if (props.active === false || view !== 'status' || !status?.ok || refreshing || !status.entries?.length) return
    const controller = new AbortController()
    setFileStats({})
    // Reuse the bounded diff endpoint for both sides instead of one request per file.
    void Promise.all((['staged', 'unstaged'] as const).map(async side => {
      try {
        const result = await fetchDiff({ cwd: repoPath, path: '.', side }, controller.signal)
        if (!result.ok || controller.signal.aborted) return
        const stats: Record<string, { additions: number; deletions: number }> = {}
        for (const file of result.files ?? []) {
          const path = file.newPath ?? file.oldPath
          if (!path || file.binary) continue
          const lines = file.hunks.flatMap(hunk => hunk.lines)
          stats[rowKey(path, side)] = { additions: lines.filter(line => line.kind === 'add').length, deletions: lines.filter(line => line.kind === 'del').length }
        }
        setFileStats(previous => ({ ...previous, ...stats }))
      } catch { /* A failed preview must not prevent staging or committing. */ }
    }))
    return () => controller.abort()
  }, [statsKey, props.active, refreshing, view])

  const openDiff = React.useCallback(async (entry: GitFileEntry, side: EntrySide) => {
    setSelected({ path: entry.path, side })
    setDiff(null)
    if (entry.kind === 'ignored') return
    setDiffLoading(true)
    try {
      const next = await fetchDiff({ path: entry.path, side: sideFor(entry, side), cwd: repoPath || undefined })
      setDiff(next)
      if (next.stats) setFileStats(previous => ({ ...previous, [rowKey(entry.path, side)]: next.stats! }))
    } catch (error) {
      setDiff({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setDiffLoading(false)
    }
  }, [repoPath])

  const loadHistory = React.useCallback(
    async (reset: boolean) => {
      setHistoryLoading(true)
      setHistoryError('')
      const skip = reset ? 0 : historyCommits.length
      const filtering = view === 'search'
      try {
        const next = await fetchHistory({
          cwd: repoPath || undefined,
          scope: historyScope,
          limit: '200',
          skip: String(skip),
          ...(filtering && appliedQuery !== '' ? { query: appliedQuery } : {}),
          ...(filtering && appliedAuthor !== '' ? { author: appliedAuthor } : {}),
          ...(filtering && appliedPath !== '' ? { path: appliedPath } : {}),
        })
        if (!next.ok) {
          setHistoryError(next.error || t('historyFailed'))
          if (reset) setHistoryCommits([])
        } else {
          const list = next.commits ?? []
          setHistoryCommits(reset ? list : [...historyCommits, ...list])
          setHistoryLaneCount(next.laneCount ?? 1)
          setHistoryHasMore(next.hasMore === true)
        }
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : String(error))
      } finally {
        setHistoryLoading(false)
      }
    },
    [appliedAuthor, appliedPath, appliedQuery, historyCommits, historyScope, repoPath, t, view],
  )

  const afterPush = React.useCallback(async () => {
    await loadStatus()
    await loadRefs()
    if (view === 'history' || view === 'search') await loadHistory(true)
  }, [loadHistory, loadRefs, loadStatus, view])

  const loadCommitDetail = React.useCallback(
    async (sha: string) => {
      setCommitDetailLoading(true)
      setCommitDetailError('')
      setCommitDetail(null)
      try {
        const next = await fetchCommitInfo({ cwd: repoPath || undefined, sha })
        if (!next.ok) {
          setCommitDetailError(next.error || t('historyFailed'))
        } else {
          setCommitDetail(next)
          // Open the first changed file so selecting a commit lands on a diff,
          // not on an empty instruction pane.
          const first = (next.files ?? [])[0]
          if (first) {
            setCommitFile(first.path)
            setCommitFileDiff(null)
            setCommitFileDiffLoading(true)
            try {
              const detail = await fetchDiff({ cwd: repoPath || undefined, path: first.path, commit: sha })
              setCommitFileDiff(detail)
            } catch (error) {
              setCommitFileDiff({ ok: false, error: error instanceof Error ? error.message : String(error) })
            } finally {
              setCommitFileDiffLoading(false)
            }
          } else {
            setCommitFile('')
            setCommitFileDiff(null)
          }
        }
      } catch (error) {
        setCommitDetailError(error instanceof Error ? error.message : String(error))
      } finally {
        setCommitDetailLoading(false)
      }
    },
    [repoPath, t],
  )

  React.useEffect(() => {
    if ((view !== 'history' && view !== 'search') || historySha === '') return
    setCommitFile('')
    setCommitFileDiff(null)
    void loadCommitDetail(historySha)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySha, view, repoPath])

  const openCommitFile = React.useCallback(
    async (path: string) => {
      if (historySha === '') return
      setCommitFile(path)
      setCommitFileDiff(null)
      setCommitFileDiffLoading(true)
      try {
        const next = await fetchDiff({ cwd: repoPath || undefined, path, commit: historySha })
        setCommitFileDiff(next)
      } catch (error) {
        setCommitFileDiff({ ok: false, error: error instanceof Error ? error.message : String(error) })
      } finally {
        setCommitFileDiffLoading(false)
      }
    },
    [historySha, repoPath],
  )

  React.useEffect(() => {
    if (view !== 'search' || historyLoading || historySha !== '') return
    const first = historyCommits[0]
    if (first) setHistorySha(first.sha)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, historyLoading, historyCommits, historySha])

  const openRef = React.useCallback((record: RefRecord, kind: 'branch' | 'tag') => {
    setHistoryScope((kind === 'branch' ? 'branch:' : 'tag:') + record.name)
    setHistorySha('')
    setView('history')
  }, [])

  const checkout = React.useCallback(
    async (name: string) => {
      setBusy(true)
      setActionError('')
      try {
        const result = await checkoutBranch(name, repoPath || undefined)
        if (!result.ok) throw new Error(result.error || t('checkOutFailed'))
        showToast(t('checkedOut') + ' · ' + name)
        setSelected(null)
        setDiff(null)
        setHistorySha('')
        await loadStatus()
        await loadRefs()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setActionError(message)
        showToast(message)
      } finally {
        setBusy(false)
      }
    },
    [loadRefs, loadStatus, repoPath, showToast, t],
  )

  const copyRef = React.useCallback(
    (name: string) => {
      try {
        void navigator.clipboard?.writeText(name)
        showToast(t('copiedPath'))
      } catch {
        showToast(name)
      }
    },
    [showToast, t],
  )

  const closeDialog = React.useCallback(() => {
    setDialog(null)
    setDialogError('')
    setDialogBusy(false)
  }, [])

  const afterBranchChange = React.useCallback(
    async (message: string) => {
      showToast(message)
      closeDialog()
      await loadRefs()
      await loadStatus()
    },
    [closeDialog, loadRefs, loadStatus, showToast],
  )

  const submitCreate = React.useCallback(
    async (name: string) => {
      setDialogBusy(true)
      setDialogError('')
      try {
        const result = await createBranch(name, repoPath || undefined, dialog?.start)
        if (!result.ok) throw new Error(result.error || t('branchActionFailed'))
        await afterBranchChange(t('branchCreated') + ' · ' + name)
      } catch (error) {
        setDialogError(error instanceof Error ? error.message : String(error))
      } finally {
        setDialogBusy(false)
      }
    },
    [afterBranchChange, dialog?.start, repoPath, t],
  )

  const submitRename = React.useCallback(
    async (to: string) => {
      const from = dialog?.branch ?? ''
      setDialogBusy(true)
      setDialogError('')
      try {
        const result = await renameBranch(from, to, repoPath || undefined)
        if (!result.ok) throw new Error(result.error || t('branchActionFailed'))
        if (historyScope === 'branch:' + from) setHistoryScope('all')
        await afterBranchChange(t('branchRenamed') + ' · ' + to)
      } catch (error) {
        setDialogError(error instanceof Error ? error.message : String(error))
      } finally {
        setDialogBusy(false)
      }
    },
    [afterBranchChange, dialog, historyScope, repoPath, t],
  )

  const submitDelete = React.useCallback(async () => {
    const name = dialog?.branch ?? ''
    setDialogBusy(true)
    setDialogError('')
    try {
      const result = await deleteBranch(name, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('branchActionFailed'))
      if (historyScope === 'branch:' + name) setHistoryScope('all')
      await afterBranchChange(t('branchDeleted') + ' · ' + name)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }, [afterBranchChange, dialog, historyScope, repoPath, t])

  // Debounce the search inputs into applied filters.
  React.useEffect(() => {
    if (view !== 'search') return
    const id = setTimeout(() => {
      setAppliedQuery(searchQuery.trim())
      setAppliedAuthor(searchAuthor.trim())
      setAppliedPath(searchPath.trim())
    }, 350)
    return () => clearTimeout(id)
  }, [view, searchQuery, searchAuthor, searchPath])

  // Reload whenever the view, repository, scope or applied filters change.
  React.useEffect(() => {
    if (view !== 'history' && view !== 'search') return
    setHistorySha('')
    if (view === 'search' && appliedQuery === '' && appliedAuthor === '' && appliedPath === '') {
      setHistoryCommits([])
      setHistoryError('')
      setHistoryLoading(false)
      return
    }
    void loadHistory(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, repoPath, historyScope, appliedQuery, appliedAuthor, appliedPath])

  React.useEffect(() => {
    if (props.active === false) return
    void loadStatus()
    void loadRefs()
  }, [loadStatus, loadRefs, props.active])

  // Keep the selection honest when the working copy changes underneath it.
  React.useEffect(() => {
    if (selected === null) return
    if (findEntry(status, selected.path) === null) {
      setSelected(null)
      setDiff(null)
    }
  }, [status, selected])

  // Poll while the panel is on screen; pause when hidden or a write is running.
  React.useEffect(() => {
    if (props.active === false) return
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (busyRef.current) return
      void loadStatus({ silent: true })
      void loadRefs()
    }, POLL_MS)
    const onFocus = () => {
      void loadStatus({ silent: true })
      void loadRefs()
    }
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') onFocus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadStatus, loadRefs, props.active])

  const toggle = React.useCallback(
    async (entry: GitFileEntry, side: EntrySide) => {
      if (entry.conflicted || side === 'conflicted') {
        setActionError(t('conflictsBlockCommit'))
        return
      }
      setBusy(true)
      setActionError('')
      try {
        const result =
          side === 'staged'
            ? await unstagePaths([entry.path], repoPath || undefined)
            : await stagePaths([entry.path], repoPath || undefined)
        if (!result.ok) throw new Error(result.error || (side === 'staged' ? t('unstageFailed') : t('stageFailed')))
        const next = await fetchStatus(repoPath || undefined)
        if (next.ok) setStatus(next)
        if (selected?.path === entry.path && next.ok) {
          const updated = findEntry(next, entry.path)
          if (updated) await openDiff(updated, sideOf(updated))
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [openDiff, repoPath, selected, t],
  )

  const toggleBatch = React.useCallback(async (paths: string[], side: EntrySide) => {
    if (busyRef.current || paths.length === 0) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try {
      const result = await (side === 'staged' ? unstagePaths : stagePaths)(paths, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('stageFailed'))
      await loadStatus({ silent: true })
      setSelected(null)
      setDiff(null)
      setFileStats({})
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [repoPath, loadStatus, t])

  const copyPath = React.useCallback(
    (entry: GitFileEntry) => {
      try {
        void navigator.clipboard?.writeText(entry.path)
        showToast(t('copiedPath'))
      } catch {
        showToast(entry.path)
      }
    },
    [showToast, t],
  )

  const copyText = React.useCallback(
    (text: string, toast: string) => {
      try {
        void navigator.clipboard?.writeText(text)
        showToast(toast)
      } catch {
        showToast(text)
      }
    },
    [showToast],
  )

  const commitThis = React.useCallback(
    async (entry: GitFileEntry, side: EntrySide) => {
      if (entry.conflicted) return
      setBusy(true)
      setActionError('')
      try {
        if (side !== 'staged') {
          const staged = await stagePaths([entry.path], repoPath || undefined)
          if (!staged.ok) throw new Error(staged.error || t('stageFailed'))
          await loadStatus({ silent: true })
        }
        setCommitFold(false)
        setTimeout(() => {
          if (commitInput.current && commitInput.current.focus) commitInput.current.focus()
        }, 0)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [loadStatus, repoPath, setCommitFold, t],
  )

  const submitDiscard = React.useCallback(async () => {
    const path = dialog?.path ?? ''
    const side = dialog?.side === 'staged' ? 'staged' : 'unstaged'
    setDialogBusy(true)
    setDialogError('')
    try {
      const result = await discardPaths([path], side, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('branchActionFailed'))
      closeDialog()
      showToast(t('discardDone') + ' · ' + path)
      setSelected(null)
      setDiff(null)
      await loadStatus()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }, [closeDialog, dialog?.path, dialog?.side, loadStatus, repoPath, showToast, t])

  const submitRemove = React.useCallback(async () => {
    const path = dialog?.path ?? ''
    const untracked = dialog?.kind === 'remove-untracked'
    setDialogBusy(true)
    setDialogError('')
    try {
      const result = await removePaths([path], untracked, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('branchActionFailed'))
      closeDialog()
      showToast(t('removeDone') + ' · ' + path)
      setSelected(null)
      setDiff(null)
      await loadStatus()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }, [closeDialog, dialog?.kind, dialog?.path, loadStatus, repoPath, showToast, t])

  const pull = React.useCallback(async () => {
    if (busyRef.current || !status?.upstream || status.branch === '(detached)') return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try {
      const result = await pullBranch(repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('pullFailed'))
      showToast(t('pulled') + ' · ' + result.upstream)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      await afterPush()
      busyRef.current = false
      setBusy(false)
    }
  }, [afterPush, repoPath, showToast, status, t])

  const pushRemotes = React.useCallback(async () => {
    const remotes = status?.remotes || []
    if (busyRef.current || !status?.branch || status.branch === '(detached)' || remotes.length === 0) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    setNotice('')
    const results: string[] = []
    try {
      for (const remote of remotes) {
        try {
          const result = await pushBranch(repoPath || undefined, remote)
          results.push(remote + '/' + status.branch + '：' + (result.ok ? t('pushed') : result.error || t('pushFailed')))
        } catch (error) {
          results.push(remote + '/' + status.branch + '：' + (error instanceof Error ? error.message : String(error)))
        }
        setNotice(results.join('；'))
      }
      await afterPush()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [afterPush, repoPath, status, t])

  const submitPush = React.useCallback(async () => {
    setDialogBusy(true)
    setDialogError('')
    try {
      const result = await pushBranch(repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('pushFailed'))
      closeDialog()
      showToast(t('pushed') + ' · ' + (result.upstream || status?.branch || ''))
      await afterPush()
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
    } finally {
      setDialogBusy(false)
    }
  }, [afterPush, closeDialog, repoPath, showToast, status?.branch, t])

  const submitMerge = React.useCallback(async () => {
    const branch = dialog?.branch ?? ''
    setDialogBusy(true)
    setDialogError('')
    try {
      const result = await mergeBranch(branch, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('mergeFailed'))
      closeDialog()
      showToast(t('merged') + ' · ' + branch)
      setSelected(null)
      setDiff(null)
      setHistorySha('')
      await loadStatus()
      await loadRefs()
      if (view === 'history' || view === 'search') await loadHistory(true)
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error))
      await loadStatus()
      await loadRefs()
    } finally {
      setDialogBusy(false)
    }
  }, [closeDialog, dialog?.branch, loadHistory, loadRefs, loadStatus, repoPath, showToast, t, view])

  const fileMenu = (entry: GitFileEntry, side: EntrySide, event: any) => {
    const conflict = side === 'conflicted' || entry.conflicted
    const untracked = entry.kind === 'untracked'
    const items: ContextMenuEntry[] = [
      {
        label: t('commitThis'),
        disabled: conflict,
        hint: conflict ? t('conflictsBlockCommit') : '⌘↵',
        onSelect: () => void commitThis(entry, side),
      },
      { divider: true },
    ]
    if (!conflict) {
      items.push({
        label: side === 'staged' ? t('unstageFile') : t('stageFile'),
        onSelect: () => void toggle(entry, side),
      })
    }
    if (!untracked) {
      items.push({
        label: t('discardChanges'),
        danger: true,
        disabled: conflict,
        hint: conflict ? t('conflictsBlockCommit') : undefined,
        onSelect: () => {
          setDialogError('')
          setDialog({ kind: 'discard', path: entry.path, side })
        },
      })
    }
    items.push({
      label: untracked ? t('removeUntracked') : t('removeFile'),
      danger: true,
      onSelect: () => {
        setDialogError('')
        setDialog({ kind: untracked ? 'remove-untracked' : 'remove', path: entry.path })
      },
    })
    items.push({ divider: true })
    items.push({ label: t('copyPath'), onSelect: () => copyPath(entry) })
    setContextMenu({ x: event.clientX, y: event.clientY, title: entry.path, items })
  }

  const refMenu = (record: RefRecord, kind: 'branch' | 'tag', event: any) => {
    const items: ContextMenuEntry[] =
      kind === 'tag'
        ? [
            { label: t('copyRefName'), onSelect: () => copyText(record.name, t('copiedPath')) },
            { label: t('history'), onSelect: () => openRef(record, 'tag') },
          ]
        : [
            {
              label: t('checkout'),
              disabled: record.current,
              hint: record.current ? t('currentBranchCannotDelete') : undefined,
              onSelect: () => void checkout(record.name),
            },
            {
              label: t('mergeIntoCurrent'),
              disabled: record.current,
              hint: record.current ? t('mergeSelfHint') : undefined,
              onSelect: () => { setDialogError(''); setDialog({ kind: 'merge', branch: record.name }) },
            },
            { label: t('renameBranch'), onSelect: () => { setDialogError(''); setDialog({ kind: 'rename', branch: record.name }) } },
            {
              label: t('deleteBranch'),
              danger: true,
              disabled: record.current,
              hint: record.current ? t('currentBranchCannotDelete') : undefined,
              onSelect: () => { setDialogError(''); setDialog({ kind: 'delete', branch: record.name }) },
            },
            { divider: true },
            { label: t('copyRefName'), onSelect: () => copyText(record.name, t('copiedPath')) },
          ]
    setContextMenu({ x: event.clientX, y: event.clientY, title: record.name, items })
  }

  const commitMenu = (commit: HistoryCommit, event: any) => {
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: commit.sha.slice(0, 12),
      items: [
        { label: t('copySha'), onSelect: () => copyText(commit.sha, t('copiedPath')) },
        {
          label: t('branchFromCommit'),
          onSelect: () => {
            setDialogError('')
            setDialog({ kind: 'create', start: commit.sha })
          },
        },
        { label: t('copyCommitMessage'), onSelect: () => copyText(commit.subject, t('copiedPath')) },
      ],
    })
  }

  const openLocalAction = React.useCallback(
    async (target: OpenTarget) => {
      setOpening(true)
      try {
        const result = await openLocal(target, repoPath || undefined)
        if (!result.ok) throw new Error(result.error || t('openFailed'))
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error))
      } finally {
        setOpening(false)
      }
    },
    [repoPath, showToast, t],
  )

  const commit = React.useCallback(async (pushAfter = false, generate = false) => {
    const scope = commitScope(status?.entries ?? [])
    const conflicts = status?.counts?.conflicted ?? 0
    if (busyRef.current || aiBusy || scope.entries.length === 0 || (!generate && message.trim() === '') || conflicts > 0 || (pushAfter && !status?.remotes?.length)) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    try {
      let commitMessage = message
      if (generate) {
        const files = scope.entries.slice(0, 60).map(entry => ({ path: entry.path, status: statusLetter(entry, scope.side) }))
        const locale = typeof props.locale === 'function' ? props.locale() : 'en'
        const payload = await generateCommitMessage({ side: scope.side, files, locale, language: resolveConfigText('git.commit.language'), prompt: resolveConfigText('prompt.git.commit') }, repoPath || undefined)
        if (!payload.ok || typeof payload.message !== 'string' || !payload.message.trim()) throw new Error(payload.error || t('aiFailed'))
        commitMessage = payload.message
        setMessage(commitMessage)
      }
      if (scope.side === 'unstaged') {
        const staged = await stagePaths(scope.entries.map(entry => entry.path), repoPath || undefined)
        if (!staged.ok) throw new Error(staged.error || t('stageFailed'))
      }
      const result = await commitChanges(commitMessage, repoPath || undefined)
      if (!result.ok) throw new Error(result.error || t('commitFailed'))
      const receipt = [t('commitDone'), result.shortSha, result.subject].filter(Boolean).join(' · ')
      setMessage('')
      setSelected(null)
      setDiff(null)
      if (pushAfter) {
        let note = ''
        try {
          const pushed = await pushBranch(repoPath || undefined)
          note = pushed.ok
            ? ' · ' + t('pushed')
            : ' · ' + t('pushFailed') + '：' + (pushed.error || '')
        } catch (error) {
          note = ' · ' + t('pushFailed') + '：' + (error instanceof Error ? error.message : String(error))
        }
        showToast(receipt + note)
      } else {
        showToast(receipt)
      }
      await afterPush()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setActionError(detail)
      // The action hint sits inside the fold: unfold it and toast as well, so a
      // rejected commit does not look like a button that staged and did nothing.
      setCommitFold(false)
      showToast(detail)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [afterPush, aiBusy, message, props.locale, repoPath, setCommitFold, showToast, status, t])

  const entries = status?.entries ?? []
  const rows = splitEntries(entries)
  const selectedKey = selected ? rowKey(selected.path, selected.side) : ''
  const selectedEntry = selected ? findEntry(status, selected.path) : null
  const diffSelection = selected && selectedEntry ? { entry: selectedEntry, side: selected.side } : null
  const truncated = status?.truncated === true
  const canPush = (status?.remotes?.length ?? 0) > 0

  const autoSelectRef = React.useRef('')
  React.useEffect(() => {
    if (view !== 'status' || status === null) return
    const key = (repoPath || status.cwd || '') + '|' + (status.oid || '')
    if (autoSelectRef.current === key) return
    autoSelectRef.current = key
    if (selected !== null) return
    const split = splitEntries(status.entries ?? [])
    // Prefer an entry that actually has a diff: untracked files open onto an
    // empty pane, which made the primary screen look blank.
    const tracked = (list: GitFileEntry[]) => list.find((entry) => entry.kind !== 'untracked')
    const first =
      split.conflicted[0] ??
      tracked(split.staged) ??
      tracked(split.unstaged) ??
      split.staged[0] ??
      split.unstaged[0]
    if (!first) return
    const side: EntrySide = split.conflicted.includes(first)
      ? 'conflicted'
      : split.staged.includes(first)
        ? 'staged'
        : 'unstaged'
    void openDiff(first, side)
  }, [status, view, selected, repoPath, openDiff])

  const railProps = {
    status,
    refs,
    view,
    t,
    onView: setView,
    onOpenRef: openRef,
    onCheckout: (name: string) => void checkout(name),
    onMerge: (name: string) => {
      setDialogError('')
      setDialog({ kind: 'merge', branch: name })
    },
    onCopyRef: copyRef,
    onContextMenu: (record: RefRecord, kind: 'branch' | 'tag', event: any) => refMenu(record, kind, event),
    onCreate: () => {
      setDialogError('')
      setDialog({ kind: 'create' })
    },
    onRename: (name: string) => {
      setDialogError('')
      setDialog({ kind: 'rename', branch: name })
    },
    onDelete: (name: string) => {
      setDialogError('')
      setDialog({ kind: 'delete', branch: name })
    },
        }

  const toolbar = h(TopBar, {
      refs,
      onCheckout: (name: string) => void checkout(name),
      status,
      busy: refreshing || busy,
      opening,
      t,
      onRefresh: () => void loadStatus(),
      onOpen: (target: OpenTarget) => void openLocalAction(target),
      canPull: !!status?.upstream && status.branch !== '(detached)',
      onPull: () => void pull(),
      canPush,
      onPushRemotes: () => void pushRemotes(),
      onPush: () => {
        setDialogError('')
        setDialog({ kind: 'push' })
      },
      onCommitFocus: () => {
        setView('status')
        setCommitFold(false)
        setTimeout(() => commitInput.current?.focus(), 0)
        if (commitInput.current && commitInput.current.focus) commitInput.current.focus()
      },
    })

  const renderView = () => {
    switch (view) {
      case 'history':
      case 'search':
        return h(HistoryView, {
          mode: view === 'search' ? 'search' : 'history',
          query: searchQuery,
          author: searchAuthor,
          path: searchPath,
          onQuery: setSearchQuery,
          onAuthor: setSearchAuthor,
          onPath: setSearchPath,
          commits: historyCommits,
          laneCount: historyLaneCount,
          hasMore: historyHasMore,
          loading: historyLoading,
          error: historyError,
          scope: historyScope,
          selectedSha: historySha,
          detail: historySha === '' ? null : commitDetail,
          detailLoading: historySha === '' ? false : commitDetailLoading,
          detailError: historySha === '' ? '' : commitDetailError,
          selectedFile: historySha === '' ? '' : commitFile,
          fileDiff: historySha === '' ? null : commitFileDiff,
          fileDiffLoading: historySha === '' ? false : commitFileDiffLoading,
          t,
          onScope: (scope: HistoryScope) => {
            setHistoryScope(scope)
            setHistorySha('')
          },
          onClearScope: () => {
            setHistoryScope('all')
            setHistorySha('')
          },
          onSelect: (commit: HistoryCommit) => setHistorySha(commit.sha),
          onSelectFile: (path: string) => void openCommitFile(path),
          onParent: (sha: string) => setHistorySha(sha),
          onContextMenu: (commit: HistoryCommit, event: any) => commitMenu(commit, event),
          onLoadMore: () => void loadHistory(false),
        })
      case 'branches':
        return h(RefRail, { ...railProps, details: true })
      case 'status':
      default:
        return h(StatusView, {
          header: toolbar,
          status,
          statusError,
          rows,
          fileStats,
          onBatch: (paths: string[], side: EntrySide) => void toggleBatch(paths, side),
          entries,
          selectedKey,
          diffSelection,
          diff,
          diffLoading,
          message,
          busy,
          actionError,
          t,
          commitInputRef: commitInput,
          commitCollapsed,
          onToggleCommitCollapsed: () => setCommitFold(!commitCollapsed),
          onSelect: (entry: GitFileEntry, side: EntrySide) => void openDiff(entry, side),
          onToggle: (entry: GitFileEntry, side: EntrySide) => void toggle(entry, side),
          onCopyPath: copyPath,
          onContextMenu: (entry: GitFileEntry, side: EntrySide, event: any) => fileMenu(entry, side, event),
          canPush,
          onMessage: setMessage,
          onCommit: (push?: boolean) => void commit(push),
          onQuickCommit: (push?: boolean) => void commit(push, true),
          ai: aiCommit,
        })
    }
  }

  return h(
    'div',
    { className: 'wb-workbench wb-git-root', 'data-plugin': 'dsh-git-tree' },
    h('div', { className: 'wb-git-surface' },


    statusError !== ''
      ? h(
          'div',
          { className: 'wb-git-banner', 'data-tone': 'error' },
          h('span', { className: 'wb-git-banner-text' }, statusError),
        )
      : null,
    truncated ? h('div', { className: 'wb-git-banner' }, h('span', { className: 'wb-git-banner-text' }, t('truncated'))) : null,

    h('div', { className: 'wb-git-body' }, h(RefRail, railProps), h(PanelResize, { label: '调整导航宽度', min: 130, max: 260 }), view === 'status' ? renderView() : h('div', { className: 'wb-git-main' }, toolbar, renderView()))),

    dialog?.kind === 'create'
      ? h(PromptDialog, {
          title: t('newBranch'),
          label: t('branchName'),
          initial: '',
          submitLabel: t('createBranchAction'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onSubmit: (value: string) => void submitCreate(value),
        })
      : null,
    dialog?.kind === 'rename'
      ? h(PromptDialog, {
          title: t('renameBranch'),
          label: t('branchName'),
          initial: dialog.branch ?? '',
          submitLabel: t('renameBranchAction'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onSubmit: (value: string) => void submitRename(value),
        })
      : null,
    dialog?.kind === 'delete'
      ? h(ConfirmDialog, {
          title: t('deleteBranch'),
          body: (dialog.branch ?? '') + ' — ' + t('deleteBranchConfirm'),
          submitLabel: t('delete'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onConfirm: () => void submitDelete(),
        })
      : null,
    contextMenu ? h(ContextMenu, { state: contextMenu, onClose: () => setContextMenu(null) }) : null,
    dialog?.kind === 'push'
      ? h(ConfirmDialog, {
          title: t('pushTitle'),
          body: status?.upstream
            ? (status?.branch || '—') +
              ' → ' +
              status.upstream +
              ' · ' +
              String(status?.ahead ?? 0) +
              ' ' +
              t('ahead') +
              ' · ' +
              t('pushBody')
            : (status?.branch || '—') + ' · ' + t('pushFirst') + ' · ' + t('pushBody'),
          submitLabel: t('push'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onConfirm: () => void submitPush(),
        })
      : null,
    dialog?.kind === 'merge'
      ? h(ConfirmDialog, {
          title: t('mergeTitle'),
          body: (dialog.branch ?? '') + ' — ' + t('mergeBody') + ' (' + (status?.branch || '—') + ')',
          submitLabel: t('mergeIntoCurrent'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onConfirm: () => void submitMerge(),
        })
      : null,
    dialog?.kind === 'discard'
      ? h(ConfirmDialog, {
          title: t('discardTitle'),
          body: (dialog.path ?? '') + ' — ' + t('discardBody'),
          submitLabel: t('discardChanges'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onConfirm: () => void submitDiscard(),
        })
      : null,
    dialog?.kind === 'remove' || dialog?.kind === 'remove-untracked'
      ? h(ConfirmDialog, {
          title: t('removeTitle'),
          body:
            (dialog.path ?? '') +
            ' — ' +
            (dialog.kind === 'remove-untracked' ? t('removeUntrackedBody') : t('removeBody')),
          submitLabel: t('removeFile'),
          busy: dialogBusy,
          error: dialogError,
          t,
          onCancel: closeDialog,
          onConfirm: () => void submitRemove(),
        })
      : null,
    h(ToastLayer, { active: props.active },
      toast ? h('div', { className: 'wb-git-toast', role: 'status' }, toast) : null,
      notice ? h('div', { className: 'wb-git-toast', role: 'status' }, notice) : null),
  )
}
