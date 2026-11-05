import { React, h, useLayout } from '../react'
import { forgeFetch, getPluginCtx, useShellTick } from '../runtime'
import { loadModelChoices } from '../models'
import type { ModelChoice } from '../models'
import { formatModelRef } from '../prompts'
import { Chip, RefreshGlyph } from '../icons'
import type { ReviewSnapshot, ReviewTask, ReviewStatus } from '../../host/auto-review'

const STATUS: Record<ReviewStatus, string> = { queued: '排队中', starting: '启动中', running: '评审中', waiting: '等待处理', completed: '已完成', failed: '已失败', stale: '已过期', skipped: '已跳过' }
/** 任务状态 → 状态色语义：进行中=info、完成=ok、过期=warn、失败=danger、跳过=中性。 */
const STATUS_CHIP: Partial<Record<ReviewStatus, string>> = { queued: 'review', starting: 'review', running: 'review', waiting: 'review', completed: 'merged', failed: 'closed', stale: 'draft' }
const SCOPE_LABEL: Record<string, string> = {
  review: '指派给我为 reviewer',
  mine: '指派给我为 reviewer 或我提交的',
  all: '全部',
}
export function openReviewSession(sessionId: string): void {
  const service = getPluginCtx()?.get('uiWorkspace') as { openSession?(id: string): void } | undefined
  if (!service?.openSession) throw new Error('当前 DSH 无法打开评审会话')
  service.openSession(sessionId)
}
/** 紧凑时间：M/D HH:mm（跨年补年份）；任务记录 90 天保留期内足够定位。 */
function fmtClock(ts: number | undefined): string {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const md = (d.getMonth() + 1) + '/' + d.getDate()
  return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '/' : '') + md + ' ' + hhmm
}
/** 任务标题带「评审 !<num> 」前缀，行内已单独渲染编号，这里剥掉避免重复。 */
function bareTitle(title: string): string { return title.replace(/^评审\s*[!#]?\d+\s*/, '') }

/** Server-owned preferences: the browser switch never owns the scheduler. */
export function AutoReviewPanel(props: { cwd?: string; num?: string; compact?: boolean; active?: boolean; refresh?: number; open?: boolean; onSaved?: () => void }) {
  const cwd = props.cwd || ''
  const [data, setData] = React.useState<(ReviewSnapshot & { schedulerError?: string }) | null>(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [choices, setChoices] = React.useState<ModelChoice[]>([])
  const [defaultTrigger, setDefaultTrigger] = React.useState('first')
  const [defaultScope, setDefaultScope] = React.useState('review')
  const [defaultPublish, setDefaultPublish] = React.useState(true)
  const [intervalSeconds, setIntervalSeconds] = React.useState(60)
  const [cooldownSeconds, setCooldownSeconds] = React.useState(0)
  const [model, setModel] = React.useState('')
  const tick = useShellTick()
  const sequence = React.useRef(0)
  const load = React.useCallback(async () => {
    if (props.active === false) return
    const seq = ++sequence.current
    try {
      const result = await forgeFetch('/forge/reviews?cwd=' + encodeURIComponent(cwd))
      if (seq !== sequence.current) return
      if (!result.ok || !result.defaults || !Array.isArray(result.tasks)) throw new Error(result.error || '无法读取自动评审状态')
      setData(result); setError('')
    } catch (e) { if (seq === sequence.current) { setError(String(e instanceof Error ? e.message : e)) } }
  }, [cwd, props.active])
  useLayout(() => {
    setData(null)
    return () => { sequence.current++ }
  }, [load])
  useLayout(() => { void load() }, [load, tick, props.refresh])
  useLayout(() => {
    if (cwd || props.active === false) return
    let live = true
    void loadModelChoices().then((r) => { if (live && r.ok) setChoices(r.choices) })
    return () => { live = false }
  }, [cwd, props.active])
  useLayout(() => {
    if (data) { setDefaultTrigger(data.defaults.trigger); setDefaultScope(data.defaults.scope || 'review'); setDefaultPublish(data.defaults.publish ?? true); setModel(data.defaults.model); setIntervalSeconds((data.defaults.intervalMs || 60000) / 1000); setCooldownSeconds((data.defaults.cooldownMs ?? 0) / 1000) }
  }, [data?.defaults?.trigger, data?.defaults?.scope, data?.defaults?.publish, data?.defaults?.model, data?.defaults?.intervalMs, data?.defaults?.cooldownMs])

  async function save(body: Record<string, unknown>) {
    setBusy(true)
    const seq = ++sequence.current
    try {
      const result = await forgeFetch('/forge/reviews/config', { method: 'POST', body: { cwd, ...body } })
      if (seq !== sequence.current) return
      if (!result.ok || !result.defaults || !Array.isArray(result.tasks)) throw new Error(result.error || '保存失败')
      setData(result); setError(''); props.onSaved?.()
    } catch (e) { if (seq === sequence.current) setError(String(e instanceof Error ? e.message : e)) }
    finally { setBusy(false) }
  }
  async function retry(task: ReviewTask, force = false) {
    setBusy(true)
    try {
      const result = await forgeFetch('/forge/reviews/start', { method: 'POST', body: { cwd, num: task.num, retry: !force, force } })
      if (!result.ok) throw new Error(result.error || '重试失败')
      await load()
    } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
    finally { setBusy(false) }
  }
  function open(task: ReviewTask) {
    try { openReviewSession(task.sessionId) } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
  }
  if (!data) return h('div', { className: 'wb-config-help', role: error ? 'alert' : 'status' }, error || (props.compact ? '正在读取评审记录…' : '正在读取自动评审配置…'), error ? h('button', { type: 'button', className: 'glab-btn', onClick: () => { void load() } }, '重试读取') : null)
  const repo = data.repo
  const tasks = data.tasks.filter((t) => !props.num || t.num === props.num).slice(0, 20)
  if (props.compact) {
    const recent = tasks.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 3)
    return h('div', { className: 'wb-review-context', 'aria-label': '此项评审记录' },
      h('span', { className: 'wb-config-help' }, '评审记录'),
      recent.length ? recent.map((task) => h('div', { key: task.id, className: 'wb-review-context-task' },
        h('span', { className: 'wb-config-help', role: 'status', title: task.model || 'DSH 默认模型' }, STATUS[task.status] + ' · ' + task.head.slice(0, 8)),
        task.sessionId && task.status !== 'queued' && task.status !== 'skipped'
          ? h('button', { type: 'button', className: 'glab-btn', onClick: () => open(task) }, task.status === 'completed' ? '查看评审结果' : '打开评审会话') : null,
        task.error ? h('span', { className: 'glab-error' }, task.error) : null))
        : h('span', { className: 'wb-config-help' }, '暂无记录'),
      h('button', { type: 'button', className: 'glab-btn', onClick: () => { void load() } }, '刷新状态'),
      error ? h('span', { className: 'glab-error', role: 'alert' }, error) : null)
  }
  if (cwd) {
    // 仓库页：概览 + 「配置 | 记录」两栏的整页布局（页签本身就是导航，不再套
    // details 折叠）。统计直接数本仓库的任务记录（90 天保留口径），没有的后端
    // 数据（如评论是否已发布）不展示。禁用态与旧版一致：busy 或宿主不支持时锁定。
    const repoScope = repo?.scope && repo.scope !== 'inherit' ? repo.scope : (data.defaults.scope || 'review')
    const effectivePublish = repo?.publish === true || repo?.publish === false ? repo.publish : (data.defaults.publish ?? true)
    const effTriggerLabel = data.defaults.trigger === 'push' ? '首次进入待评审及每次新提交' : '首次进入待评审'
    const shown = tasks.slice(0, 5)
    const hidden = tasks.slice(5)
    const counts = { completed: 0, stale: 0, failed: 0 }
    for (const t of tasks) if (t.status === 'completed') counts.completed++
      else if (t.status === 'stale') counts.stale++
      else if (t.status === 'failed') counts.failed++
    const stat = (v: number, label: string) => h('div', { className: 'wb-review-stat' },
      h('span', { className: 'wb-review-stat-value' }, String(v)),
      h('span', { className: 'wb-review-stat-label' }, label))
    // 记录行：跳转目标是本机 DSH 会话（内部），有会话的行整行可点，
    // 不再渲染外部链接图标；排队/跳过的行没有会话，保持不可点。
    const openable = (t: ReviewTask) => !!t.sessionId && t.status !== 'queued' && t.status !== 'skipped'
    const row = (t: ReviewTask) => {
      const canOpen = openable(t)
      return h('div', {
        key: t.id, className: 'wb-review-row' + (canOpen ? ' wb-review-row-open' : ''),
        role: canOpen ? 'button' : undefined, tabIndex: canOpen ? 0 : undefined,
        'aria-label': canOpen ? (t.status === 'completed' ? '查看评审结果' : '打开评审会话') : undefined,
        title: canOpen ? '评审过程与结果在会话内，点击打开' : undefined,
        onClick: canOpen ? () => open(t) : undefined,
        onKeyDown: canOpen ? (e: { key: string; preventDefault(): void }) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(t) } } : undefined,
      },
      h('div', { className: 'wb-review-row-top' },
        h('span', { className: 'wb-review-row-num' }, (repo?.forge === 'gitlab' ? '!' : '#') + t.num),
        h('span', { className: 'wb-review-row-title', title: t.title || undefined }, bareTitle(t.title)),
        h('span', { className: 'wb-bar-spacer' }),
        h(Chip, { kind: STATUS_CHIP[t.status], title: '任务状态：' + STATUS[t.status] }, STATUS[t.status]),
        t.status === 'failed' ? h('button', { type: 'button', className: 'glab-btn wb-review-retry', disabled: busy,
          onClick: (e: { stopPropagation(): void }) => { e.stopPropagation(); void retry(t) } }, '重试') : null),
      h('div', { className: 'wb-review-row-meta' }, [fmtClock(t.finishedAt || t.createdAt), t.head.slice(0, 8)].filter(Boolean).join(' · ')),
      t.error ? h('div', { className: 'wb-review-row-err', title: t.error }, t.error) : null)
    }
    return h('div', { className: 'wb-auto-review wb-review-page' },
      // 概览横贯页首：标题/副标题居左，统计靠右上（右上不留空带），两栏卡片其下。
      h('div', { className: 'wb-review-overview' },
        h('div', { className: 'wb-review-headline' },
          h('div', { className: 'wb-review-title-row' },
            h('span', { className: 'wb-review-title' }, '自动评审'),
            h(Chip, { kind: repo?.enabled ? 'ok' : undefined, title: repo?.enabled ? '自动评审已开启' : '自动评审未开启' }, repo?.enabled ? '已启用' : '未启用'))),
        tasks.length ? h('div', { className: 'wb-review-stats', role: 'group', 'aria-label': '评审统计' },
          stat(tasks.length, '累计评审'), stat(counts.completed, '已完成'), stat(counts.stale, '已过期'),
          counts.failed ? stat(counts.failed, '已失败') : null) : null),
      h('div', { className: 'wb-review-cols' },
        h('div', { className: 'wb-review-card' },
          h('div', { className: 'wb-review-card-head' }, h('span', { className: 'wb-review-card-title' }, '评审配置')),
          !data.supported ? h('p', { role: 'alert' }, '当前 DSH 未提供后台会话服务，无法开启自动评审。') : null,
          h('div', { className: 'wb-review-enable' },
            h('span', { className: 'wb-config-title' }, '启用自动评审'),
            h('span', { className: 'wb-bar-spacer' }),
            h('button', { type: 'button', role: 'switch', 'aria-checked': !!repo?.enabled, 'aria-label': '启用自动评审',
              disabled: busy || !data.supported, className: 'wb-switch' + (repo?.enabled ? ' wb-switch-on' : ''),
              title: repo?.enabled ? '已开启，点击关闭' : '已关闭，点击开启',
              onClick: () => { void save({ enabled: !repo?.enabled, trigger: repo?.trigger || 'inherit', scope: repo?.scope || 'inherit', publish: repo?.publish ?? 'inherit' }) } },
              h('span', { className: 'wb-switch-knob' }))),
          h('label', { className: 'wb-config-help' }, '触发时机', h('select', { className: 'glab-input wb-config-select', 'aria-label': '仓库自动评审触发时机', value: repo?.trigger || 'inherit', disabled: busy || !data.supported,
            onChange: (e: { target: { value: string } }) => { void save({ enabled: !!repo?.enabled, trigger: e.target.value, scope: repo?.scope || 'inherit', publish: repo?.publish ?? 'inherit' }) } },
            h('option', { value: 'inherit' }, '跟随默认（' + effTriggerLabel + '）'),
            h('option', { value: 'first' }, '首次进入待评审'), h('option', { value: 'push' }, '首次进入待评审及每次新提交'))),
          h('label', { className: 'wb-config-help' }, '评审范围', h('select', { className: 'glab-input wb-config-select', 'aria-label': '仓库自动评审范围', value: repo?.scope || 'inherit', disabled: busy || !data.supported,
            onChange: (e: { target: { value: string } }) => { void save({ enabled: !!repo?.enabled, trigger: repo?.trigger || 'inherit', scope: e.target.value, publish: repo?.publish ?? 'inherit' }) } },
            h('option', { value: 'inherit' }, '跟随默认（' + (SCOPE_LABEL[repoScope] || repoScope) + '）'),
            h('option', { value: 'review' }, '指派给我为 reviewer'),
            h('option', { value: 'mine' }, '指派给我为 reviewer 或我提交的'),
            h('option', { value: 'all' }, '全部'))),
          h('label', { className: 'wb-config-help' }, '结果发布', h('select', { className: 'glab-input wb-config-select', 'aria-label': '仓库自动评审发布评论', value: repo?.publish === true ? 'on' : repo?.publish === false ? 'off' : 'inherit', disabled: busy || !data.supported,
            onChange: (e: { target: { value: string } }) => { void save({ enabled: !!repo?.enabled, trigger: repo?.trigger || 'inherit', scope: repo?.scope || 'inherit', publish: e.target.value === 'on' ? true : e.target.value === 'off' ? false : 'inherit' }) } },
            h('option', { value: 'inherit' }, '跟随默认（' + (effectivePublish ? '自动发表评论' : '仅在会话内出报告') + '）'),
            h('option', { value: 'on' }, '自动发表评论'),
            h('option', { value: 'off' }, '仅在会话内出报告'))),
          repo?.error ? h('p', { role: 'alert', className: 'glab-error' }, repo.error) : null),
        h('div', { className: 'wb-review-card' },
          h('div', { className: 'wb-review-card-head' },
            h('span', { className: 'wb-review-card-title' }, '最近评审'),
            h('span', { className: 'wb-bar-spacer' }),
            h('button', { type: 'button', className: 'wb-review-refresh', 'aria-label': '刷新状态', title: '刷新状态', disabled: busy, onClick: () => { void load() } }, RefreshGlyph(busy))),
          shown.length ? h('div', { className: 'wb-review-rows' }, shown.map(row))
            : h('p', { className: 'wb-config-help' }, '暂无评审记录'),
          hidden.length ? h('details', { className: 'wb-review-more' },
            h('summary', null, '查看全部 ' + tasks.length + ' 条记录'),
            h('div', { className: 'wb-review-rows' }, hidden.map(row))) : null)),
      data.schedulerError || error ? h('p', { role: 'alert', className: 'glab-error' }, error || data.schedulerError) : null)
  }
  // Host 默认设置面板（配置页）：保留 details 折叠块，open 由调用方决定；
  // 展开态是 DOM 状态（默认值只在挂载时落一次 open 属性），轮询重渲染不
  // 打断用户已收起/展开的面板。
  return h('details', { open: props.open, className: 'wb-auto-review wb-config-item wb-config-row' },
    h('summary', { className: 'wb-config-head' },
      h('span', { className: 'wb-config-title' }, '自动评审默认设置'),
      h('span', { className: 'wb-bar-spacer' }),
      h('span', { className: 'wb-meta wb-config-row-state' }, data.defaults.trigger === 'push' ? '每次新提交' : '首次进入待评审')),
    h('div', { className: 'wb-config-body' },
      h('label', { className: 'wb-config-help' }, '检查间隔（秒）', h('input', { className: 'glab-input', type: 'number', min: 10, max: 86400, step: 1, 'aria-label': '自动评审检查间隔（秒）', value: intervalSeconds, disabled: busy, onChange: (e: { target: { value: string } }) => setIntervalSeconds(Number(e.target.value)) })),
      h('p', { className: 'wb-config-help' }, '所有已开启仓库共用，10–86400 秒；保存即生效。'),
      h('label', { className: 'wb-config-help' }, '推送冷却（秒）', h('input', { className: 'glab-input', type: 'number', min: 0, max: 86400, step: 1, 'aria-label': '自动评审推送冷却（秒）', value: cooldownSeconds, disabled: busy, onChange: (e: { target: { value: string } }) => setCooldownSeconds(Number(e.target.value)) })),
      h('p', { className: 'wb-config-help' }, '冷却期内多次推送只评最新提交；0 关闭冷却。'),
      h('label', { className: 'wb-config-help' }, '默认触发时机', h('select', { className: 'glab-input wb-config-select', 'aria-label': '自动评审默认触发时机', value: defaultTrigger, disabled: busy,
        onChange: (e: { target: { value: string } }) => setDefaultTrigger(e.target.value) },
        h('option', { value: 'first' }, '首次进入待评审'), h('option', { value: 'push' }, '首次进入待评审及每次新提交'))),
      h('label', { className: 'wb-config-help' }, '默认评审范围', h('select', { className: 'glab-input wb-config-select', 'aria-label': '自动评审默认范围', value: defaultScope, disabled: busy,
        onChange: (e: { target: { value: string } }) => setDefaultScope(e.target.value) },
        h('option', { value: 'review' }, '指派给我为 reviewer'),
        h('option', { value: 'mine' }, '指派给我为 reviewer 或我提交的'),
        h('option', { value: 'all' }, '全部'))),
      h('label', { className: 'wb-config-help' }, '自动评审模型', h('select', { className: 'glab-input wb-config-select', 'aria-label': '自动评审模型', value: model, disabled: busy,
        onChange: (e: { target: { value: string } }) => setModel(e.target.value) },
        h('option', { value: '' }, '沿用 DSH 默认模型'),
        model && !choices.some((c) => formatModelRef(c.provider, c.model) === model) ? h('option', { value: model }, model) : null,
        choices.map((c) => h('option', { key: formatModelRef(c.provider, c.model), value: formatModelRef(c.provider, c.model) }, c.label)))),
      h('p', { className: 'wb-config-help' }, '指定模型会同时更新 DSH 的全局默认模型；模型不可用时任务失败，不自动降级消费。仓库规则从 AGENTS.md 读取。'),
      h('label', { className: 'wb-config-help' }, h('input', { type: 'checkbox', checked: defaultPublish, disabled: busy, onChange: (e: { target: { checked: boolean } }) => setDefaultPublish(e.target.checked) }), ' 评审后自动发布评论'),
      h('p', { className: 'wb-config-help' }, '关闭后自动评审只在会话内给出报告，不发表评论；手动评审不受影响。'),
      h('button', { type: 'button', className: 'glab-btn', disabled: busy || !data.supported || !Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86400 || !Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 86400, onClick: () => { void save({ defaults: { trigger: defaultTrigger, model, intervalMs: intervalSeconds * 1000, cooldownMs: cooldownSeconds * 1000, scope: defaultScope, publish: defaultPublish } }) } }, busy ? '保存中…' : '保存默认设置'),
      data.schedulerError || error ? h('p', { role: 'alert', className: 'glab-error' }, error || data.schedulerError) : null,
    ),
  )
}
