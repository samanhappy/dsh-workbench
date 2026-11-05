/**
 * Parse `git diff` output into a structure the panel can render line by line.
 *
 * The browser half renders rows, gutters and hunk headers; it never parses
 * unified diff text itself. Keeping the parse here means one implementation to
 * test and the same shapes any later hunk-level staging needs.
 *
 * Supported: multiple files, multi-hunk, add/delete/modify, rename/copy,
 * mode changes, binary files, `\ No newline at end of file`.
 */

/** File-level status letters used by the renderer. */
const STATUS_BY_PREFIX = { 'new file': 'added', 'deleted file': 'deleted' }

function emptyFile(fromPath, toPath) {
  return {
    oldPath: fromPath ?? null,
    newPath: toPath ?? null,
    status: 'modified',
    binary: false,
    hunks: [],
  }
}

/** Parse one `@@ -a,b +c,d @@ heading` line. */
function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
  if (!match) return null
  return {
    header: line,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
    heading: match[5].trim(),
    lines: [],
  }
}

export function parseUnifiedDiff(text) {
  const files = []
  let file = null
  let hunk = null
  let oldNo = 0
  let newNo = 0
  let additions = 0
  let deletions = 0

  const startFile = () => {
    file = emptyFile(null, null)
    files.push(file)
    hunk = null
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')

    if (line.startsWith('diff --git ')) {
      startFile()
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      if (match) {
        file.oldPath = match[1]
        file.newPath = match[2]
      }
      continue
    }

    if (file === null) {
      if (line === '') continue
      // A diff that starts mid-file (should not happen) is still rendered.
      startFile()
    }

    if (hunk === null && file.hunks.length === 0) {
      if (line.startsWith('old mode ')) {
        file.status = 'mode-changed'
        continue
      }
      if (line.startsWith('new mode ')) continue
      if (line.startsWith('new file mode ')) {
        file.status = 'added'
        continue
      }
      if (line.startsWith('deleted file mode ')) {
        file.status = 'deleted'
        continue
      }
      if (line.startsWith('similarity index ')) continue
      if (line.startsWith('dissimilarity index ')) continue
      if (line.startsWith('rename from ')) {
        file.oldPath = line.slice('rename from '.length)
        file.status = 'renamed'
        continue
      }
      if (line.startsWith('rename to ')) {
        file.newPath = line.slice('rename to '.length)
        file.status = 'renamed'
        continue
      }
      if (line.startsWith('copy from ')) {
        file.oldPath = line.slice('copy from '.length)
        file.status = 'copied'
        continue
      }
      if (line.startsWith('copy to ')) {
        file.newPath = line.slice('copy to '.length)
        file.status = 'copied'
        continue
      }
      if (line.startsWith('index ')) continue
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        file.binary = true
        continue
      }
      if (line.startsWith('--- ')) {
        const target = line.slice(4)
        if (target !== '/dev/null') file.oldPath = target.replace(/^a\//, '')
        continue
      }
      if (line.startsWith('+++ ')) {
        const target = line.slice(4)
        if (target !== '/dev/null') file.newPath = target.replace(/^b\//, '')
        continue
      }
    }

    const nextHunk = parseHunkHeader(line)
    if (nextHunk) {
      hunk = nextHunk
      file.hunks.push(hunk)
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      continue
    }

    if (hunk === null) continue

    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line })
      continue
    }
    if (line === '') {
      // Trailing newline of the diff body, or a genuinely empty context line
      // (context lines always carry a leading space, so this is the terminator).
      continue
    }

    const marker = line[0]
    const text = line.slice(1)
    if (marker === ' ') {
      hunk.lines.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text })
    } else if (marker === '-') {
      hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text })
      deletions += 1
    } else if (marker === '+') {
      hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text })
      additions += 1
    } else if (marker === '\\') {
      hunk.lines.push({ kind: 'meta', oldNo: null, newNo: null, text: line })
    }
  }

  const kept = files.filter((entry) => entry.hunks.length > 0 || entry.binary || entry.status !== 'modified')
  return {
    files: kept,
    binary: kept.length > 0 && kept.every((entry) => entry.binary),
    stats: { additions, deletions },
  }
}
