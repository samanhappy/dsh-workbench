/**
 * One commit's metadata and changed files (the commit detail pane).
 *
 * Metadata and the name-status list are two cheap git calls; the per-file diff
 * is served by the existing diff route with a `commit` parameter.
 */

const FIELD = '\u0000'
const RECORD = '\u001e'

/** `git show --no-patch` field order. */
export const COMMIT_FORMAT = ['%H', '%an', '%ae', '%aI', '%s', '%b', '%P', '%D'].join('%x00') + '%x1e'

/** Accept only a plain hex object name; never an option or a revision expression. */
export function isSafeCommitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{4,40}$/i.test(value)
}

export function parseCommitShow(text) {
  const first = String(text).split(RECORD)[0] || ''
  const fields = first.replace(/^\n+/, '').split(FIELD)
  if (fields.length < 8) return null
  const [sha, author, authorEmail, date, subject, body, parents, decoration] = fields
  return {
    sha,
    author: author || '',
    authorEmail: authorEmail || '',
    date: date || '',
    subject: subject || '',
    body: (body || '').trim(),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    decoration,
  }
}

/** Parse `git show --name-status` lines: `M\tpath`, `R100\told\tnew`, … */
export function parseNameStatus(text) {
  const files = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    const code = parts[0].trim()
    const letter = code[0]
    const status =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'R' ? 'renamed' : letter === 'C' ? 'copied' : 'modified'
    if (letter === 'R' || letter === 'C') {
      if (parts.length < 3) continue
      files.push({ status, path: parts[2], origPath: parts[1] })
    } else {
      files.push({ status, path: parts[1] })
    }
  }
  return files
}
