/**
 * Commit history for the history and search views.
 *
 * One bounded `git log` feeds both views; this module parses its records and
 * assigns graph lanes so the browser only has to draw dots and lines.
 */

/** Field separator inside a record; the record separator ends each commit. */
const FIELD = '\u0000'
const RECORD = '\u001e'

/** `git log --format=…` value; `--decorate=full` keeps ref prefixes parseable. */
export const HISTORY_FORMAT =
  ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join('%x00') + '%x1e'

export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 500
export const MAX_LANES = 8

/**
 * Ref-name check that follows git's own forbidden characters but stays Unicode
 * friendly: Chinese branch names are legal refs and must work like any other.
 */
export function isSafeBranchName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return false
  if (value.endsWith('.') || value.endsWith('.lock') || value.includes('.lock/')) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  if (value === '@') return false
  if (/[ ~^:?*\[\\\u0000-\u001f\u007f]/.test(value)) return false
  return true
}

/** Turn `%D` into local branch and tag chips; remote refs are dropped. */
export function parseDecoration(decoration) {
  const out = []
  for (const raw of String(decoration || '').split(',')) {
    let token = raw.trim()
    if (!token) continue
    if (token.startsWith('HEAD -> ')) token = token.slice('HEAD -> '.length)
    if (token === 'HEAD') continue
    if (token.startsWith('tag: ')) {
      const name = token.slice('tag: '.length).replace(/^refs\/tags\//, '')
      if (name && !name.includes('refs/remotes/')) out.push({ name, kind: 'tag' })
      continue
    }
    if (token.startsWith('refs/heads/')) {
      out.push({ name: token.slice('refs/heads/'.length), kind: 'branch' })
      continue
    }
    // --decorate=full still prints bare remote refs; they are out of scope.
    if (token.startsWith('refs/remotes/')) continue
  }
  return out
}

export function parseHistoryLog(text) {
  const commits = []
  for (const record of String(text).split(RECORD)) {
    const line = record.replace(/^\n+/, '')
    if (!line) continue
    const fields = line.split(FIELD)
    if (fields.length < 7) continue
    const [sha, parents, author, authorEmail, date, subject, decoration] = fields
    commits.push({
      sha,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author || '',
      authorEmail: authorEmail || '',
      date: date || '',
      subject: subject || '',
      refs: parseDecoration(decoration),
    })
  }
  return commits
}

/**
 * Assign each commit a lane and remember which lane each parent sits on.
 *
 * Walks newest-first keeping an array of "the sha this lane is waiting for".
 * The first parent continues the commit's lane; extra parents (merges) take a
 * free lane. Lanes beyond MAX_LANES are folded onto the last lane.
 */
export function assignLanes(commits, maxLanes = MAX_LANES) {
  const lanes = []
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha)
    if (lane === -1) {
      lane = lanes.indexOf(null)
      if (lane === -1) {
        if (lanes.length < maxLanes) {
          lane = lanes.length
          lanes.push(null)
        } else {
          lane = maxLanes - 1
        }
      }
      lanes[lane] = commit.sha
    }
    commit.lane = lane

    const parentLanes = []
    const parents = commit.parents
    for (let index = 0; index < parents.length; index += 1) {
      const parent = parents[index]
      let parentLane = lanes.indexOf(parent)
      if (parentLane === -1) {
        if (index === 0) {
          parentLane = lane
          lanes[lane] = parent
        } else {
          parentLane = lanes.indexOf(null)
          if (parentLane === -1) {
            if (lanes.length < maxLanes) {
              parentLane = lanes.length
              lanes.push(parent)
            } else {
              parentLane = lane
            }
          } else {
            lanes[parentLane] = parent
          }
        }
      } else if (index === 0 && parentLane !== lane) {
        lanes[lane] = null
      }
      parentLanes.push(parentLane)
    }
    commit.parentLanes = parentLanes
    if (parents.length === 0) lanes[lane] = null
  }
  return Math.max(1, lanes.length)
}
