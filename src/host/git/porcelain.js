/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * Record shapes (git-status(1), NUL-terminated because of `-z`):
 *   `1 XY sub mH mI mW hH hI <path>`
 *   `2 XY sub mH mI mW hH hI <X><score> <newPath>` then `<origPath>` as the next field
 *   `u XY sub m1 m2 m3 mW h1 h2 h3 <path>`
 *   `? <path>` / `! <path>`
 *   `# branch.oid|head|upstream|ab ...`
 *
 * This module has no DSH dependencies: it is a pure function over git output,
 * importable from a plain Node unit test.
 */

/** Maximum entries kept from one status call; the rest are reported as truncated. */
export const MAX_ENTRIES = 5000

/** Fields before the path, per record type. */
const FIELDS_BEFORE_PATH = { 1: 8, 2: 9, u: 10 }

function splitRecord(record) {
  const fields = record.split(' ')
  const xy = fields[1] ?? '..'
  return { fields, xy }
}

function normaliseKind(letter, x, y) {
  if (letter === '?') return 'untracked'
  if (letter === '!') return 'ignored'
  if (letter === 'u') return 'conflicted'
  if (x === 'R') return 'renamed'
  if (x === 'C') return 'copied'
  return 'changed'
}

export function parsePorcelainV2(text) {
  const entries = []
  let branch = ''
  let oid = ''
  let upstream = ''
  let ahead = 0
  let behind = 0
  let truncated = false
  /** Set while the next NUL field is the original path of a rename/copy. */
  let awaitingOrigPath = null

  for (const record of text.split('\0')) {
    if (!record) continue

    if (awaitingOrigPath) {
      awaitingOrigPath.origPath = record
      awaitingOrigPath = null
      continue
    }

    if (record.startsWith('# branch.oid ')) {
      oid = record.slice('# branch.oid '.length).trim()
      continue
    }
    if (record.startsWith('# branch.head ')) {
      branch = record.slice('# branch.head '.length).trim()
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length).trim()
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /\+(\d+)\s+-(\d+)/.exec(record)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
      continue
    }
    if (record.startsWith('#')) continue

    const letter = record[0]
    if (letter !== '1' && letter !== '2' && letter !== 'u' && letter !== '?' && letter !== '!') continue

    const { fields, xy } = splitRecord(record)
    const before = FIELDS_BEFORE_PATH[letter] ?? 0
    const path =
      letter === '1' || letter === '2' || letter === 'u'
        ? fields.slice(before).join(' ')
        : record.slice(2)
    if (!path) continue

    const x = xy[0] ?? '.'
    const y = xy[1] ?? '.'
    const kind = normaliseKind(letter, x, y)

    /** @type {Record<string, unknown>} */
    const entry = { path, x, y, kind }
    if (letter === '1' || letter === '2') {
      entry.staged = x !== '.'
      entry.unstaged = y !== '.'
    } else if (letter === '?') {
      entry.staged = false
      entry.unstaged = true
    } else {
      entry.staged = false
      entry.unstaged = false
    }
    entry.conflicted = kind === 'conflicted'

    if (entries.length >= MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push(entry)
    // In `-z` the original path of a rename/copy is the next NUL field.
    if (letter === '2') awaitingOrigPath = entry
  }

  return { oid, branch, upstream, ahead, behind, entries, truncated }
}

/** Counts the panel shows in its group headers. */
export function summariseEntries(entries) {
  let staged = 0
  let unstaged = 0
  let conflicted = 0
  for (const entry of entries) {
    if (entry.conflicted) conflicted += 1
    if (entry.staged) staged += 1
    if (entry.unstaged) unstaged += 1
  }
  return { staged, unstaged, conflicted }
}
