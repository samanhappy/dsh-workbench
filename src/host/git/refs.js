/**
 * Parse the reference list the rail shows.
 *
 * One `for-each-ref` call yields branches, remotes and tags; the separator is a
 * NUL so a subject may contain anything except a newline.
 */

const REF_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(upstream:short)',
  '%(committerdate:unix)',
  '%(contents:subject)',
].join('%00')

export const REF_ARGS = [
  'for-each-ref',
  '--sort=-committerdate',
  '--format=' + REF_FORMAT,
  'refs/heads',
  'refs/remotes',
  'refs/tags',
]

function refKind(refname) {
  if (refname.startsWith('refs/heads/')) return 'branch'
  if (refname.startsWith('refs/remotes/')) return 'remote'
  if (refname.startsWith('refs/tags/')) return 'tag'
  return null
}

function shortName(refname) {
  return refname.replace(/^refs\/(heads|remotes|tags)\//, '')
}

/**
 * @param {string} text raw for-each-ref output (one record per line)
 * @param {string} currentBranch branch name without `refs/heads/` ('' when detached)
 */
export function parseRefs(text, currentBranch) {
  const branches = []
  const remotes = []
  const tags = []

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [refname, oid, upstream, committedAt, subject = ''] = line.split('\0')
    const kind = refKind(refname || '')
    if (!kind) continue
    const name = shortName(refname)
    const record = {
      name,
      oid: oid || '',
      upstream: upstream || '',
      committedAt: Number(committedAt) || 0,
      subject: subject || '',
      current: kind === 'branch' && name === currentBranch,
    }
    if (kind === 'branch') branches.push(record)
    else if (kind === 'remote') remotes.push(record)
    else tags.push(record)
  }

  const byCurrentThenName = (left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1
    return left.name.localeCompare(right.name)
  }
  branches.sort(byCurrentThenName)
  remotes.sort((left, right) => left.name.localeCompare(right.name))
  tags.sort((left, right) => left.name.localeCompare(right.name))

  return { branches, remotes, tags }
}
