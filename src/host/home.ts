// dsh-workbench — 首页（跨工作区「需要我关注」会话聚合）host 半。
//
// 直接读 DSH 会话存储（$DSH_HOME/sessions + storages/session_projcache.json），
// 把「所有工作区」的会话按需要关注的粒度归一成 HomeSessionRow，由 /home/sessions
// 路由供首页渲染。这是 DSH 内部存储（session.v{N}.jsonl(.zstd) 多帧拼接 +
// projcache JSON），不是官方契约：
//   - 版本演进有迁移（v1→v2→v3→v4），这里按「最高版本优先」选取日志文件；
//   - 读取/解析失败一律降级（该会话少些字段或直接剔除），绝不抛错打断首页；
//   - 锁探测依赖 python3（与 pingcode 同款软依赖）；缺失时按「无运行中」处理。
//
// 过滤口径（与产品确认）：保留「进行中（flock 被持有）或 待处理（proj 有开放
// 步骤/挂起工具调用）或 近 24h 活跃」，排除空白会话（blank）与子会话
// （parentSession），最近活跃上限 recentCap（默认 10）。扫描阶段用 48h 缓冲
// 窗口做快速剪枝（不深解析日志）：先对全部 session.lock 做一次批量 flock 探测，
// 未持有且不在窗口内、无待处理的会话直接跳过——注意 session.lock 文件常驻，
// 「文件存在」≠「锁被持有」，拿文件存在性做剪枝会把所有会话都当候选全量解压
// （曾致每次扫描都重解析全部日志，见 cachedParseLog 注释）；命中窗口的候选
// 才解码，并按（路径, mtime, size）缓存解析结果，两次扫描间未变化的日志不
// 重复解压。
//
// 状态语义：`running` = session.lock 的 flock 被持有。flock 是写柄租约——
// 会话在 GUI 里开着（写句柄存活）即被持有，与是否正在产出无关，因此这里只是
// 兜底值；客户端会用宿主会话状态（sessions.list，侧边栏同源）覆盖它。
// `waiting` = projcache 统计里有开放步骤或挂起工具调用（agent 卡住或在等你）。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

export interface HomeSessionRow {
  sessionId: string
  /** 会话所属工作区路径（日志头部 cwd，缺省回退 projcache）。 */
  cwd: string | null
  title: string | null
  createdAt: number
  /** max(createdAt, lastPromptAt, 最后事件时间, 日志 mtime)。保留窗口
   *  （近 24h 活跃）与剪枝用它；右栏「最近完成」的展示与排序也用它（最后活动）。 */
  updatedAt: number
  /** max(createdAt, 最后一条用户消息时间)——侧边栏行尾时间同源口径
   *  （sessionListMetadata.lastPromptAt 只认 source.kind=user；助手回复、
   *  工具调用等任意活动都不推进它）。左栏展示与组内排序按它。 */
  promptedAt: number
  /** flock 被持有（会话当前打开/正在写入）。 */
  running: boolean
  /** proj 统计有开放步骤或挂起工具调用。 */
  waiting: boolean
  /** 从未发过消息。 */
  blank: boolean
  /** 子会话（header 带 parentSession）。 */
  child: boolean
  userMsgs: number
  assistantMsgs: number
  turns: number
  toolCalls: number
  /** projcache 里的权限 preset（permissions.preset），不是 agent preset。 */
  preset: string | null
  /** agent preset 属于 HOME_BACKGROUND_PRESETS（后台常驻会话）。 */
  background: boolean
}

export interface HomeSessionsPayload {
  ok: true
  updatedAt: number
  /** 保留的全部会话（三组并集，按 promptedAt 倒序）。 */
  sessions: HomeSessionRow[]
  groups: { running: HomeSessionRow[]; waiting: HomeSessionRow[]; recent: HomeSessionRow[] }
  counts: { running: number; waiting: number; recent24h: number }
  /** 扫描阶段被快速剪枝的会话数（调试/测试用）。 */
  skipped: number
}

/** 扫描阶段的剪枝缓冲窗口：候选 = 锁持有 || 日志 mtime 近 48h || proj 近 48h ||
 *  待处理。真正保留的最近窗口见 selectHomeSessions 的 recentMs（24h）。 */
export const HOME_SCAN_KEEP_MS = 48 * 3600 * 1000
/** 首页「最近活跃」窗口（毫秒）。 */
export const HOME_RECENT_MS = 24 * 3600 * 1000
/** 最近活跃分组上限。 */
export const HOME_RECENT_CAP = 10
/** 后台常驻会话的 agent preset：由后台 agent 自驱（非人工发起）、长期存在且可能
 *  一直有活动。首页照常展示这些会话，但行上标「后台」并允许每栏过滤掉。
 *  只认 preset（会话头/投影里的 agentPreset）：标题、cwd、id 前缀都可变或属于
 *  其他 bundle 的实现细节。 */
export const HOME_BACKGROUND_PRESETS = new Set(['dsh-superagent-router'])
/** 会话日志解析元数据缓存上限；超限丢最旧一条（保持最近访问的会话）。 */
export const HOME_LOG_CACHE_MAX = 512

/** $DSH_HOME（缺省 ~/.dsh）。测试通过环境变量覆盖。 */
export function sessionRoot(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 会话目录里的日志文件：最高版本优先（v4 > v3 > v2 > v1），zstd 优先于明文。 */
export function sessionLogOf(dir: string): string | null {
  for (const v of ['v4', 'v3', 'v2', 'v1']) {
    for (const ext of ['jsonl.zstd', 'jsonl']) {
      const p = join(dir, 'session.' + v + '.' + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** zstd 会话日志是多帧拼接（每批写入一帧）：按帧魔数切分后逐帧解压拼接。
 *  非 zstd 输入（明文 / 空）原样返回。 */
export function decompressAll(buf: Buffer): Buffer {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const idxs: number[] = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { idxs.push(i); i += 4 }
  if (idxs.length === 0) return buf
  const chunks: Buffer[] = []
  for (let k = 0; k < idxs.length; k++) {
    const end = k + 1 < idxs.length ? idxs[k + 1] : buf.length
    chunks.push(zstdDecompressSync(buf.subarray(idxs[k], end)))
  }
  return Buffer.concat(chunks)
}

export interface ParsedSessionLog {
  header: Record<string, unknown> | null
  title: string | null
  /** 会话当前的 agent preset（header.agentPreset，后续被 agent-preset/selected 事件覆盖）。 */
  agentPreset: string | null
  lastEventAt: number | null
  /** 最后一条 source.kind=user 的用户消息时间（其余 user/message 是系统注入）。 */
  lastPromptAt: number | null
  userMsgs: number
  assistantMsgs: number
  turns: number
  toolCalls: number
}

/** 解析一个会话日志文件：首行是会话头，后续是事件行；session/title 事件带标题。
 *  文件缺失/损坏时降级返回空字段（header=null）。 */
export function parseSessionLog(file: string): ParsedSessionLog {
  const out: ParsedSessionLog = { header: null, title: null, agentPreset: null, lastEventAt: null, lastPromptAt: null, userMsgs: 0, assistantMsgs: 0, turns: 0, toolCalls: 0 }
  let text: string
  try {
    const raw = readFileSync(file)
    text = file.endsWith('.zstd') ? decompressAll(raw).toString('utf8') : raw.toString('utf8')
  } catch (e) {
    return out
  }
  const lines = text.split('\n').filter(Boolean)
  try { out.header = JSON.parse(lines[0] || '') } catch (e) {}
  if (out.header && typeof out.header.agentPreset === 'string') out.agentPreset = out.header.agentPreset
  for (const l of lines) {
    let ev: { type?: string; time?: number; data?: Record<string, unknown> }
    try { ev = JSON.parse(l) } catch (e) { continue }
    if (typeof ev.time === 'number' && (out.lastEventAt === null || ev.time > out.lastEventAt)) out.lastEventAt = ev.time
    if (ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string') out.title = ev.data.title
    else if (ev.type === 'user/message') {
      out.userMsgs += 1
      const src = (ev.data as { source?: { kind?: string } } | undefined)?.source
      if (src?.kind === 'user' && typeof ev.time === 'number' &&
        (out.lastPromptAt === null || ev.time > out.lastPromptAt)) out.lastPromptAt = ev.time
    } else if (ev.type === 'assistant/message') out.assistantMsgs += 1
    else if (ev.type === 'agent-preset/selected' && ev.data && typeof ev.data.agentPreset === 'string') out.agentPreset = ev.data.agentPreset
    else if (ev.type === 'turn/start') out.turns += 1
    else if (ev.type === 'tool/call') out.toolCalls += 1
  }
  return out
}

// ── 解析元数据缓存 ──────────────────────────────────────────────────────────
// 一次全量扫描要解压并逐行解析每个候选日志（zstd 多帧只能整解），而两次扫描
// （30s TTL / 60s 轮询）之间绝大多数日志没有变化。以（路径, mtime, size）为键
// 缓存解析结果：文件未变 → 直接复用，只有真正被写入的日志（如正在运行的会话）
// 才重新解压。键含 size/mtime 可防同路径内容替换后的脏命中；进程内缓存，上限
// HOME_LOG_CACHE_MAX，超限丢最旧。

const logParseCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedSessionLog }>()

/** 清空解析元数据缓存（测试隔离用）。 */
export function clearHomeLogCache(): void {
  logParseCache.clear()
}

function cachedParseLog(file: string, mtimeMs: number, size: number, parse: (f: string) => ParsedSessionLog): ParsedSessionLog {
  const hit = logParseCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.parsed
  const parsed = parse(file)
  if (logParseCache.size >= HOME_LOG_CACHE_MAX) {
    const oldest = logParseCache.keys().next().value as string | undefined
    if (oldest !== undefined) logParseCache.delete(oldest)
  }
  logParseCache.set(file, { mtimeMs, size, parsed })
  return parsed
}

/** projcache 里一个会话的可用投影行（缺失字段为 undefined）。 */
export interface ProjectionRow {
  createdAt?: number
  cwd?: string
  title?: string
  blank?: boolean
  lastPromptAt?: number | null
  turns?: number
  steps?: number
  openStep?: unknown
  pendingCalls?: unknown
  preset?: string
}

/** 读 session_projcache.json → sessionId → 投影行。坏文件返回空表。 */
export function loadProjectionCache(file: string): Map<string, ProjectionRow> {
  const out = new Map<string, ProjectionRow>()
  let raw: unknown
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return out }
  const table = raw && typeof raw === 'object'
    ? (raw as { tables?: { sessions?: Record<string, unknown> } }).tables?.sessions
    : undefined
  if (!table || typeof table !== 'object') return out
  for (const [id, entryRaw] of Object.entries(table)) {
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw as { identity?: Record<string, unknown>; rows?: Record<string, unknown> } : {}
    const rows = entry.rows || {}
    const identity = entry.identity || {}
    const meta = rows.sessionListMetadata as { val?: { blank?: unknown; lastPromptAt?: unknown } } | undefined
    const stats = rows.sessionStats as { val?: { turns?: unknown; steps?: unknown; openStep?: unknown; pendingCalls?: unknown } } | undefined
    const perms = rows.permissions as { val?: { preset?: unknown } } | undefined
    const titleRow = rows.title as { val?: unknown } | undefined
    const s = stats?.val
    const row: ProjectionRow = {
      createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : undefined,
      cwd: typeof identity.cwd === 'string' ? identity.cwd : undefined,
      title: typeof titleRow?.val === 'string' ? titleRow.val : undefined,
      blank: meta?.val && typeof meta.val.blank === 'boolean' ? meta.val.blank : undefined,
      lastPromptAt: meta?.val && typeof meta.val.lastPromptAt === 'number' ? meta.val.lastPromptAt : undefined,
      turns: s && typeof s.turns === 'number' ? s.turns : undefined,
      steps: s && typeof s.steps === 'number' ? s.steps : undefined,
      openStep: s ? s.openStep : undefined,
      pendingCalls: s ? s.pendingCalls : undefined,
      preset: perms?.val && typeof perms.val.preset === 'string' ? perms.val.preset : undefined,
    }
    out.set(id, row)
  }
  return out
}

/** 一次 python3 批量 flock 探测：输入全部 session.lock 路径，返回当前被持有的
 *  子集。任何失败（python3 缺失 / 路径打不开 / 超时）都按「无运行中」处理。 */
export function probeLockHeld(lockPaths: string[]): Set<string> {
  if (!lockPaths.length) return new Set()
  const script = [
    'import fcntl, os, sys',
    'for p in sys.stdin.read().splitlines():',
    '    try:',
    '        fd = os.open(p, os.O_RDONLY)',
    '    except OSError:',
    '        print("ERR")',
    '        continue',
    '    try:',
    '        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)',
    '        print("FREE")',
    '    except BlockingIOError:',
    '        print("HELD")',
    '    finally:',
    '        os.close(fd)',
  ].join('\n')
  let r: { status: number | null; stdout: string }
  try {
    r = spawnSync('python3', ['-c', script], { input: lockPaths.join('\n'), encoding: 'utf8', timeout: 10000 })
  } catch (e) {
    return new Set()
  }
  if (r.status !== 0) return new Set()
  const held = new Set<string>()
  r.stdout.split('\n').forEach((line, i) => {
    if (line === 'HELD' && lockPaths[i]) held.add(lockPaths[i])
  })
  return held
}

export interface ScanOptions {
  root?: string
  now?: number
  scanKeepMs?: number
  recentMs?: number
  recentCap?: number
  /** 锁探测注入点（测试桩）；缺省用 probeLockHeld。 */
  lockHeld?: (paths: string[]) => Set<string>
  /** 日志解析注入点（测试桩/计数）；缺省 parseSessionLog，结果按
   *  （路径, mtime, size）缓存，未变化的日志不重复解析。 */
  parseLog?: (file: string) => ParsedSessionLog
}

/** 扫描 $DSH_HOME/sessions 全工作区，返回「需要关注」会话（含分组与计数）。
 *  不抛错：任何子步骤失败都只影响对应会话。 */
export async function scanHomeSessions(opts?: ScanOptions): Promise<HomeSessionsPayload> {
  const now = opts?.now ?? Date.now()
  const scanKeepMs = opts?.scanKeepMs ?? HOME_SCAN_KEEP_MS
  const recentMs = opts?.recentMs ?? HOME_RECENT_MS
  const recentCap = Math.max(1, opts?.recentCap ?? HOME_RECENT_CAP)
  const root = opts?.root ?? join(sessionRoot(), 'sessions')
  const proj = loadProjectionCache(join(dirname(root), 'storages', 'session_projcache.json'))

  interface Candidate { sid: string; log: string | null; mtime: number; size: number; lock: string | null; pj?: ProjectionRow }
  const candidates: Candidate[] = []
  const lockPaths: string[] = []
  let skipped = 0
  if (existsSync(root)) {
    for (const ws of readdirSync(root)) {
      if (!ws.startsWith('--')) continue
      const wsDir = join(root, ws)
      let dirs: string[]
      try { dirs = readdirSync(wsDir) } catch (e) { continue }
      for (const sid of dirs) {
        // 会话目录名 = 会话 id（DSH 的 encodeSegment）。标准会话是 session-<uuid>，
        // 但不全是：Superagent 的 orchestrator-… / worker-… 也是侧边栏里真实可点的
        // 会话行。不能按前缀过滤——这些目录没有日志时已由下面的 !log 跳过，按前缀
        // 跳过则会让侧栏胶囊计数（读宿主会话列表）与首页两栏对不上（看得见「1」、
        // 列表里却没有那一行）。
        const dir = join(wsDir, sid)
        const log = sessionLogOf(dir)
        const lockPath = join(dir, 'session.lock')
        const hasLock = existsSync(lockPath)
        const pj = proj.get(sid)
        let mtime = 0
        let size = 0
        if (log) {
          try { const st = statSync(log); mtime = st.mtimeMs; size = st.size } catch (e) {}
        }
        if (!log) {
          // 未物化的空会话目录：无日志即无内容，直接跳过。
          skipped += 1
          continue
        }
        if (hasLock) lockPaths.push(lockPath)
        candidates.push({ sid, log, mtime, size, lock: hasLock ? lockPath : null, pj })
      }
    }
  }

  // 先批量探测全部 session.lock（一次 python 进程，~几十 ms）：session.lock 文件
  // 常驻，「文件存在」≠「锁被持有」，必须以 flock 探测结果做剪枝，否则老会话
  // 全部变成候选、每次扫描都对全量日志做整文件解压解析。
  const held = (opts?.lockHeld ?? probeLockHeld)(lockPaths)
  const parse = opts?.parseLog ?? parseSessionLog
  const rows: HomeSessionRow[] = []
  for (const c of candidates) {
    const pj = c.pj
    const pjRecent = pj && typeof pj.lastPromptAt === 'number' && pj.lastPromptAt >= now - scanKeepMs
    const pjWaiting = !!(pj && (pj.openStep !== undefined && pj.openStep !== null ||
      (pj.pendingCalls && typeof pj.pendingCalls === 'object' && Object.keys(pj.pendingCalls).length > 0)))
    const running = c.lock !== null && held.has(c.lock)
    // 剪枝：未持有 && 不在扫描窗口 && 无待处理 → 不深解析（输出与「解析后剔除」
    // 等价——这类会话 updatedAt 必然早于保留窗口，本就不会出现在结果里）。
    if (!running && !pjRecent && !pjWaiting && c.mtime < now - scanKeepMs) {
      skipped += 1
      continue
    }
    const parsed = c.log ? cachedParseLog(c.log, c.mtime, c.size, parse) : null
    const header = parsed ? parsed.header : null
    const createdAt = header && typeof header.createdAt === 'number' ? header.createdAt : (pj?.createdAt ?? 0)
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : (pj?.cwd ?? null)
    const title = (parsed && parsed.title) || pj?.title || null
    const userMsgs = parsed ? parsed.userMsgs : 0
    const turns = (parsed && parsed.turns) || (pj?.turns ?? 0)
    const waiting = pjWaiting
    const agentPreset = parsed?.agentPreset ?? null
    const background = agentPreset !== null && HOME_BACKGROUND_PRESETS.has(agentPreset)
    const blank = parsed ? userMsgs === 0 && turns === 0 : (pj?.blank ?? true)
    const updatedAt = Math.max(createdAt, pj?.lastPromptAt ?? 0, parsed?.lastEventAt ?? 0, c.mtime)
    // 行尾时间与侧边栏同源：日志解析（source.kind=user）优先——投影缓存只是它的
    // 持久化快照，可能落后；解析失败回退缓存，再回退会话创建时间。
    const lastPrompt = parsed?.lastPromptAt ?? (pj?.lastPromptAt ?? 0)
    const promptedAt = Math.max(createdAt, lastPrompt) || updatedAt
    rows.push({
      sessionId: c.sid,
      cwd,
      title,
      createdAt,
      updatedAt,
      promptedAt,
      running,
      waiting,
      blank,
      child: !!(header && header.parentSession),
      userMsgs,
      assistantMsgs: parsed ? parsed.assistantMsgs : 0,
      turns,
      toolCalls: parsed ? parsed.toolCalls : 0,
      preset: pj?.preset ?? null,
      background,
    })
  }
  return selectHomeSessions(rows, now, recentMs, recentCap, skipped)
}

/** 纯筛选分组：剔除空白（运行中的空白草稿保留）与子会话；保留运行中 / 待处理 /
 *  最近 recentMs 内活跃（保留窗口按 updatedAt=最近任意活动）。左栏两组按 promptedAt
 *  （侧边栏行尾时间，最后一条用户消息）倒序——与侧边栏排序一致；右栏「最近完成」
 *  按 updatedAt（最后活动）倒序，历史分页也按这个序切片，客户端按同一口径重排。 */
export function selectHomeSessions(
  rows: HomeSessionRow[],
  now: number,
  recentMs: number,
  recentCap: number,
  skipped = 0,
): HomeSessionsPayload {
  const kept = rows.filter((r) => (!r.blank || r.running) && !r.child)
  const byPrompted = (a: HomeSessionRow, b: HomeSessionRow) => b.promptedAt - a.promptedAt
  const running = kept.filter((r) => r.running).sort(byPrompted)
  const waiting = kept.filter((r) => !r.running && r.waiting).sort(byPrompted)
  const recent = kept.filter((r) => !r.running && !r.waiting && r.updatedAt >= now - recentMs)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, recentCap)
  const sessions = [...running, ...waiting, ...recent].sort(byPrompted)
  return {
    ok: true,
    updatedAt: now,
    sessions,
    groups: { running, waiting, recent },
    counts: {
      running: running.length,
      waiting: waiting.length,
      recent24h: kept.filter((r) => r.updatedAt >= now - recentMs).length,
    },
    skipped,
  }
}
