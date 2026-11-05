// Host-half route contract: what the plugin registers and how it refuses
// unsafe input. No git and no Harness needed — `apply()` is driven by a fake
// context, and the handlers answer from a fake subprocess routed by argv.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/host/git/register.js'
import { isSafeBranchName } from '../src/host/git/history.js'

const WORKSPACE = '/tmp/fake-workspace'

const STATUS_FIXTURE =
  [
    '# branch.oid 0123456789abcdef',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/app.js',
    '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/staged.js',
    '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/two.js',
    '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 docs/name.txt',
    'old/name.txt',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.js',
    '? docs/new-note.md',
  ].join('\u0000') + '\u0000'

const DIFF_FIXTURE = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@',
  ' console.log("app")',
  '-export const a = 1',
  '+export const a = 2',
  '+export const b = 3',
  ' // tail',
  '\\ No newline at end of file',
  '',
].join('\n')

const LOG_FIELDS = '\u0000'
const LOG_RECORD = '\u001e'
const LOG_FIXTURE = [
  ['c4', 'c3 c2', 'Ann', 'ann@example.com', '2026-10-20T10:00:00+08:00', "Merge branch 'topic'", 'HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1'],
  ['c3', 'c1', 'Bob', 'bob@example.com', '2026-10-19T10:00:00+08:00', 'fix: parser', 'refs/heads/topic'],
  ['c2', 'c1', 'Ann', 'ann@example.com', '2026-10-18T10:00:00+08:00', 'docs: readme', ''],
  ['c1', '', 'Ann', 'ann@example.com', '2026-10-17T10:00:00+08:00', 'initial commit', ''],
].map((fields) => fields.join(LOG_FIELDS)).join(LOG_RECORD) + LOG_RECORD

const REFS_FIXTURE = [
  'refs/heads/main\u0000abc1234\u0000origin/main\u00001790000000\u0000Initial commit',
  'refs/heads/topic\u0000def5678\u0000\u00001780000000\u0000Topic work',
  'refs/remotes/origin/main\u0000abc1234\u0000\u00001790000000\u0000Initial commit',
  'refs/tags/v0.1.0\u0000abc1234\u0000\u00001790000000\u0000Release',
  '',
].join('\n')

const SHOW_FIXTURE =
  ['c3c3c3c', 'Ann', 'ann@example.com', '2026-10-20T10:00:00+08:00', 'fix: parser', 'body line', 'c2c2c2c', 'HEAD -> refs/heads/main, tag: refs/tags/v1']
    .join('\u0000') + '\u001e'
const NAME_STATUS_FIXTURE = ['M\tsrc/app.js', 'A\tdocs/new.md', 'R100\told.md\tnew.md', ''].join('\n')

function defaultResult(argv) {
  const command = argv[1]
  if (command === 'status') return { exitCode: 0, stdout: STATUS_FIXTURE, stderr: '' }
  if (command === 'rev-parse') {
    if (argv.includes('@{u}')) return { exitCode: 128, stdout: '', stderr: 'no upstream configured' }
    return { exitCode: 0, stdout: WORKSPACE + '\n', stderr: '' }
  }
  if (command === 'remote') return { exitCode: 0, stdout: 'origin\n', stderr: '' }
  if (command === 'config') {
    return { exitCode: 0, stdout: 'user.name Fixture Dev\nuser.email fixture@example.com\n', stderr: '' }
  }
  if (command === 'diff') return { exitCode: 0, stdout: DIFF_FIXTURE, stderr: '' }
  if (command === 'for-each-ref') return { exitCode: 0, stdout: REFS_FIXTURE, stderr: '' }
  if (command === 'log') return { exitCode: 0, stdout: LOG_FIXTURE, stderr: '' }
  if (command === 'show') {
    return {
      exitCode: 0,
      stdout: argv.includes('--name-status') ? NAME_STATUS_FIXTURE : SHOW_FIXTURE,
      stderr: '',
    }
  }
  if (command === 'symbolic-ref') return { exitCode: 0, stdout: 'main\n', stderr: '' }
  if (command === 'ls-files') return { exitCode: 0, stdout: '', stderr: '' }
  if (command === 'commit') return { exitCode: 0, stdout: '[main abc1234] message\n', stderr: '' }
  return { exitCode: 0, stdout: '', stderr: '' }
}

function fakeContext({ handler = defaultResult, workspaceRoot = WORKSPACE, registry } = {}) {
  const routes = []
  const spawns = []
  const services = {
    sandboxPolicy: { workspaceRoot },
    workspaceRegistry: {
      list:
        registry ??
        (() => [
          { id: 'w-main', path: WORKSPACE, title: 'fake-workspace' },
          { id: 'w-other', path: '/tmp/other-repo', title: 'other-repo' },
        ]),
    },
    subprocess: {
      async resolveExecutable(command) {
        if (command === 'open') return '/usr/bin/open'
        if (command !== 'git') throw new Error('unexpected executable')
        return '/usr/local/bin/git'
      },
      spawn({ argv, cwd }) {
        spawns.push({ argv, cwd })
        const result = handler(argv)
        return {
          done: Promise.resolve({ exitCode: result.exitCode ?? 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: result.stdout ?? '', lossy: false }) },
            stderr: { readFrom: () => ({ text: result.stderr ?? '', lossy: false }) },
          },
        }
      },
    },
  }
  return {
    routes,
    spawns,
    connection: { fetch: { register: (route) => { routes.push(route); return () => {} } } },
    get: (service) => services[service],
  }
}

function request(path, { method = 'GET', body } = {}) {
  return {
    url: 'https://dsh.internal' + path,
    method,
    signal: undefined,
    json: async () => {
      if (body === undefined) throw new Error('no body')
      return JSON.parse(JSON.stringify(body))
    },
  }
}

function routeFor(ctx, path) {
  const route = ctx.routes.find((item) => item.path === path)
  assert.ok(route, 'route not registered: ' + path)
  return route
}

async function call(ctx, path, options) {
  const route = routeFor(ctx, path.split('?')[0])
  const response = await route.fetch(request(path, options))
  return { response, body: await response.json() }
}

test('host plugin declares its name and hard service dependencies', () => {
  assert.equal(name, 'dsh-git-tree')
  assert.deepEqual(inject, ['connection', 'subprocess'])
})

test('apply registers the twenty-one authenticated exact Fetch routes', () => {
  const ctx = fakeContext()
  apply(ctx)

  assert.deepEqual(
    ctx.routes.map((route) => route.path).sort(),
    [
      '/api/workbench/git/ai/model',
      '/api/workbench/git/ai/models',
      '/api/workbench/git/branch/create',
      '/api/workbench/git/branch/delete',
      '/api/workbench/git/branch/rename',
      '/api/workbench/git/checkout',
      '/api/workbench/git/commit',
      '/api/workbench/git/commit-info',
      '/api/workbench/git/commit-message',
      '/api/workbench/git/diff',
      '/api/workbench/git/discard',
      '/api/workbench/git/history',
      '/api/workbench/git/merge',
      '/api/workbench/git/open',
      '/api/workbench/git/pull',
      '/api/workbench/git/push',
      '/api/workbench/git/refs',
      '/api/workbench/git/remove',
      '/api/workbench/git/stage',
      '/api/workbench/git/status',
      '/api/workbench/git/unstage',
      '/api/workbench/git/workspaces',
    ],
  )
  for (const route of ctx.routes) {
    assert.equal(route.requestBody, 'buffered')
    assert.equal(route.kind, undefined, 'connection.fetch routes take no kind')
    const expected = [
      '/api/workbench/git/stage',
      '/api/workbench/git/unstage',
      '/api/workbench/git/commit',
      '/api/workbench/git/commit-message',
      '/api/workbench/git/ai/model',
      '/api/workbench/git/checkout',
      '/api/workbench/git/discard',
      '/api/workbench/git/remove',
      '/api/workbench/git/merge',
      '/api/workbench/git/open',
      '/api/workbench/git/pull',
      '/api/workbench/git/push',
      '/api/workbench/git/branch/create',
      '/api/workbench/git/branch/rename',
      '/api/workbench/git/branch/delete',
    ].includes(route.path)
      ? ['POST']
      : ['GET']
    assert.deepEqual(route.methods, expected, 'unexpected methods for ' + route.path)
  }
})

test('workspaces route lists the registered workspaces and the current one', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/workspaces')
  assert.equal(body.ok, true)
  assert.equal(body.current, WORKSPACE)
  assert.deepEqual(
    body.workspaces.map((workspace) => workspace.path).sort(),
    ['/tmp/fake-workspace', '/tmp/other-repo'],
  )
  assert.equal(body.workspaces.find((workspace) => workspace.path === '/tmp/other-repo').title, 'other-repo')
})

test('cwd inside another registered workspace is allowed, an unregistered one is refused', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const allowed = await call(ctx, '/api/workbench/git/status?cwd=' + encodeURIComponent('/tmp/other-repo'))
  assert.equal(allowed.body.ok, true)
  const statusCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'status')
  assert.equal(statusCall.cwd, '/tmp/other-repo')

  const refused = await call(ctx, '/api/workbench/git/status?cwd=' + encodeURIComponent('/tmp/not-a-workspace'))
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.code, 'outside-workspace')
})

test('without a cwd the default is a registered workspace that is a repository', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'dgt-default-'))
  mkdirSync(join(repo, '.git'))
  const ctx = fakeContext({
    workspaceRoot: '/tmp/not-a-repository',
    registry: () => [{ id: 'w-repo', path: repo, title: 'repo' }],
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/status')
  assert.equal(body.ok, true)
  const statusCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'status')
  assert.equal(statusCall.cwd, realpathSync.native(repo))
})

test('an opaque ctx.fs target never leaks into a child-process cwd', async () => {
  // ctx.fs.resolve() returns an opaque FsTarget for the model's file view; a
  // cwd must be resolved with node:path instead (regression: ENOENT on spawn).
  const ctx = fakeContext({ fs: { resolve: () => ({ opaqueTarget: true }) } })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/status?cwd=' + encodeURIComponent('/tmp/other-repo'))
  assert.equal(body.ok, true)
  const statusCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'status')
  assert.equal(statusCall.cwd, '/tmp/other-repo')
})

test('status route reports the real change model: rename, conflict, two-sided, untracked', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/status')

  assert.equal(body.ok, true)
  assert.equal(body.platform, process.platform, 'status must report the host platform')
  assert.equal(body.branch, 'main')
  assert.equal(body.upstream, 'origin/main')
  assert.equal(body.ahead, 2)
  assert.equal(body.behind, 1)
  assert.deepEqual(body.identity, { name: 'Fixture Dev', email: 'fixture@example.com' })

  const byPath = Object.fromEntries(body.entries.map((entry) => [entry.path, entry]))
  assert.equal(byPath['src/app.js'].unstaged, true)
  assert.equal(byPath['src/app.js'].staged, false)
  assert.equal(byPath['src/staged.js'].staged, true)
  assert.equal(byPath['src/staged.js'].unstaged, false)
  assert.equal(byPath['src/two.js'].staged, true, 'two-sided change keeps its index side')
  assert.equal(byPath['src/two.js'].unstaged, true, 'two-sided change keeps its work-tree side')
  assert.equal(byPath['docs/name.txt'].kind, 'renamed')
  assert.equal(byPath['docs/name.txt'].origPath, 'old/name.txt')
  assert.equal(byPath['src/conflict.js'].conflicted, true)
  assert.equal(byPath['src/conflict.js'].x, 'U')
  assert.equal(byPath['docs/new-note.md'].kind, 'untracked')
  assert.equal(byPath['docs/new-note.md'].unstaged, true)

  assert.deepEqual(body.remotes, ['origin'])
  assert.deepEqual(body.counts, { staged: 3, unstaged: 3, conflicted: 1 })
  assert.equal(body.truncated, false)

  const statusCall = ctx.spawns.find((call) => call.argv[1] === 'status')
  assert.ok(statusCall, 'status must be spawned')
  assert.ok(statusCall.argv.includes('--porcelain=v2'))
  assert.ok(!statusCall.argv.includes('--no-renames'), 'renames must not be flattened')
  assert.equal(statusCall.cwd, WORKSPACE)
})

test('diff route returns a structured diff and guards the path', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/diff?path=src/app.js')

  assert.equal(body.ok, true)
  assert.equal(body.side, 'unstaged')
  assert.deepEqual(body.stats, { additions: 2, deletions: 1 })
  assert.equal(body.files.length, 1)
  const [file] = body.files
  assert.equal(file.newPath, 'src/app.js')
  assert.equal(file.hunks.length, 1)
  const [hunk] = file.hunks
  assert.equal(hunk.oldStart, 1)
  assert.equal(hunk.newStart, 1)
  assert.deepEqual(
    hunk.lines.map((line) => [line.kind, line.oldNo, line.newNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['meta', null, null],
    ],
  )
  assert.equal(hunk.lines[5].text, '\\ No newline at end of file')

  const diffCall = ctx.spawns.find((call) => call.argv[1] === 'diff')
  const dashDash = diffCall.argv.indexOf('--')
  assert.ok(dashDash > 0, 'diff argv must contain --')
  assert.equal(diffCall.argv[dashDash + 1], 'src/app.js')
  assert.ok(!diffCall.argv.includes('--cached'))
})

test('untracked diff previews additions without staging and accepts no-index exit 1', async () => {
  const patch = 'diff --git a/docs/new-note.md b/docs/new-note.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new-note.md\n@@ -0,0 +1,2 @@\n+新文件\n+second line\n'
  for (const binary of [false, true]) {
    const ctx = fakeContext({ handler(argv) {
      if (argv[1] === 'ls-files') return { stdout: 'docs/new-note.md\0' }
      if (argv[1] === 'diff') return argv.includes('--no-index')
        ? { exitCode: 1, stdout: binary ? 'diff --git a/docs/new-note.md b/docs/new-note.md\nnew file mode 100644\nBinary files /dev/null and b/docs/new-note.md differ\n' : patch }
        : { stdout: '' }
      return defaultResult(argv)
    } })
    apply(ctx)
    const { body } = await call(ctx, '/api/workbench/git/diff?path=docs/new-note.md')
    assert.equal(body.ok, true)
    assert.equal(body.binary, binary)
    assert.equal(body.files[0].status, 'added')
    assert.equal(body.stats.additions, binary ? 0 : 2)
    assert.ok(!ctx.spawns.some(c => ['add', 'reset'].includes(c.argv[1])))
  }
})

test('diff route asks for the index side when side=staged', async () => {
  const ctx = fakeContext()
  apply(ctx)
  await call(ctx, '/api/workbench/git/diff?path=src/staged.js&side=staged')
  const diffCall = ctx.spawns.find((call) => call.argv[1] === 'diff')
  assert.ok(diffCall.argv.includes('--cached'))
})

test('diff route rejects traversal, absolute and option-shaped paths', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const cases = ['../etc/passwd', '/etc/passwd', '-rf', 'src/../../secret']
  for (const bad of cases) {
    const { body } = await call(ctx, '/api/workbench/git/diff?path=' + encodeURIComponent(bad))
    assert.equal(body.ok, false, 'must refuse ' + bad)
    assert.equal(body.code, 'bad-request', 'must classify ' + bad + ' as bad-request')
  }
  assert.equal(ctx.spawns.length, 0, 'no git process may run for a rejected path')
})

test('a cwd outside the workspace is refused', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/status?cwd=' + encodeURIComponent('/etc'))
  assert.equal(body.ok, false)
  assert.equal(body.code, 'outside-workspace')
  assert.equal(ctx.spawns.length, 0)
})

test('missing subprocess degrades instead of throwing', async () => {
  const ctx = fakeContext()
  ctx.get = () => undefined
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/status')
  assert.equal(body.ok, false)
  assert.equal(body.code, 'subprocess-unavailable')
})

test('history route parses commits, drops remote refs and assigns lanes', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/history')
  assert.equal(body.ok, true)
  assert.equal(body.scope, 'all')
  assert.equal(body.commits.length, 4)
  assert.equal(body.hasMore, false)
  assert.ok(body.laneCount >= 1)

  const [merge] = body.commits
  assert.equal(merge.sha, 'c4')
  assert.deepEqual(merge.parents, ['c3', 'c2'])
  assert.deepEqual(merge.refs, [
    { name: 'main', kind: 'branch' },
    { name: 'v1', kind: 'tag' },
  ], 'remote refs and HEAD are dropped')
  assert.equal(typeof merge.lane, 'number')
  assert.equal(merge.parentLanes.length, 2)

  const logCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'log')
  assert.ok(logCall, 'history must come from git log')
  assert.ok(logCall.argv.includes('--branches'))
  assert.ok(logCall.argv.includes('--decorate=full'))
})

test('history route paginates and reports hasMore', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/history?limit=2&skip=1')
  assert.equal(body.commits.length, 2)
  assert.equal(body.hasMore, true)
  const logCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'log')
  assert.ok(logCall.argv.includes('--max-count=3'), 'one extra record detects hasMore')
  assert.ok(logCall.argv.includes('--skip=1'))
})

test('history route maps search filters to fixed-string args and guards paths', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(
    ctx,
    '/api/workbench/git/history?query=fix&author=Ann&path=' + encodeURIComponent('src/app.js'),
  )
  assert.equal(body.ok, true)
  const logCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'log')
  assert.ok(logCall.argv.includes('--grep=fix'))
  assert.ok(logCall.argv.includes('--author=Ann'))
  assert.ok(logCall.argv.includes('--fixed-strings'))
  assert.ok(logCall.argv.includes('--regexp-ignore-case'))
  assert.equal(logCall.argv[logCall.argv.indexOf('--') + 1], 'src/app.js')
})

test('history route scopes to a validated local branch', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/history?scope=branch:topic')
  assert.equal(body.ok, true)
  const logCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'log')
  assert.ok(logCall.argv.includes('refs/heads/topic'))

  const bad = await call(ctx, '/api/workbench/git/history?scope=branch:' + encodeURIComponent('../escape'))
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'invalid-branch-name')
})

test('commit-info route returns metadata, refs and the changed files', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/commit-info?sha=c3c3c3c')
  assert.equal(body.ok, true)
  assert.equal(body.sha, 'c3c3c3c')
  assert.equal(body.subject, 'fix: parser')
  assert.equal(body.body, 'body line')
  assert.deepEqual(body.parents, ['c2c2c2c'])
  assert.deepEqual(body.refs, [
    { name: 'main', kind: 'branch' },
    { name: 'v1', kind: 'tag' },
  ])
  assert.deepEqual(body.files, [
    { status: 'modified', path: 'src/app.js' },
    { status: 'added', path: 'docs/new.md' },
    { status: 'renamed', path: 'new.md', origPath: 'old.md' },
  ])
  const showCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'show' && spawn.argv.includes('--no-patch'))
  assert.ok(showCall, 'metadata must come from git show --no-patch')
})

test('commit-info route refuses non-hex shas before spawning git', async () => {
  const ctx = fakeContext()
  apply(ctx)
  for (const bad of ['--output=x', 'HEAD~1', 'main', '']) {
    const { body } = await call(ctx, '/api/workbench/git/commit-info?sha=' + encodeURIComponent(bad))
    assert.equal(body.ok, false, 'must refuse ' + bad)
    assert.equal(body.code, 'invalid-sha')
  }
  assert.equal(ctx.spawns.length, 0)
})

test('diff route reads one file out of a commit when commit is given', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/diff?commit=c3c3c3c&path=src/app.js')
  assert.equal(body.ok, true)
  const callRecord = ctx.spawns.find((spawn) => spawn.argv[1] === 'show')
  assert.ok(callRecord, 'a commit diff must come from git show')
  assert.ok(callRecord.argv.includes('c3c3c3c'))
  assert.ok(callRecord.argv.includes('--format='))
  assert.equal(callRecord.argv[callRecord.argv.length - 1], 'src/app.js')

  const bad = await call(ctx, '/api/workbench/git/diff?commit=' + encodeURIComponent('../x') + '&path=src/app.js')
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'invalid-sha')
})

test('checkout refuses a dirty working copy without running checkout', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/checkout', {
    method: 'POST',
    body: { branch: 'feature/lanes' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'dirty-worktree')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'checkout').length, 0)
})

test('checkout switches on a clean working copy with a fixed argv', async () => {
  const clean =
    '# branch.oid abc\u0000# branch.head main\u0000? scratch.md\u0000'
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'status') return { exitCode: 0, stdout: clean, stderr: '' }
      if (argv[1] === 'checkout') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/checkout', {
    method: 'POST',
    body: { branch: 'feature/lanes' },
  })
  assert.equal(body.ok, true)
  assert.equal(body.branch, 'feature/lanes')
  const checkoutCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'checkout')
  assert.deepEqual(checkoutCall.argv.slice(1), ['checkout', '--quiet', 'feature/lanes'])
})

test('checkout reports an unknown branch as a 404', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse') return { exitCode: 128, stdout: '', stderr: 'fatal: needed a single revision' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/checkout', {
    method: 'POST',
    body: { branch: 'nope' },
  })
  assert.equal(response.status, 404)
  assert.equal(body.code, 'unknown-branch')
})

test('history can be scoped to a tag', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/history?scope=tag:v0.2-demo')
  assert.equal(body.ok, true)
  const logCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'log')
  assert.ok(logCall.argv.includes('refs/tags/v0.2-demo'))
})

test('branch create validates the name, refuses duplicates and uses HEAD by default', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse' && argv.includes('--verify')) return { exitCode: 128, stdout: '', stderr: 'not found' }
      if (argv[1] === 'branch') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/branch/create', { method: 'POST', body: { name: 'topic/new' } })
  assert.equal(body.ok, true)
  const callRecord = ctx.spawns.find((spawn) => spawn.argv[1] === 'branch')
  assert.deepEqual(callRecord.argv.slice(1), ['branch', 'topic/new', 'HEAD'])

  const bad = await call(ctx, '/api/workbench/git/branch/create', { method: 'POST', body: { name: '../x' } })
  assert.equal(bad.body.code, 'invalid-branch-name')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'branch').length, 1, 'invalid name must not reach git')
})

test('branch create refuses an existing branch', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/branch/create', {
    method: 'POST',
    body: { name: 'existing' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'branch-exists')
})

test('branch rename refuses an existing target and runs a fixed argv', async () => {
  const free = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse' && argv.includes('--verify') && argv.includes('refs/heads/target')) {
        return { exitCode: 128, stdout: '', stderr: 'not found' }
      }
      if (argv[1] === 'branch') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(free)
  const renamed = await call(free, '/api/workbench/git/branch/rename', {
    method: 'POST',
    body: { from: 'old', to: 'target' },
  })
  assert.equal(renamed.body.ok, true)
  const callRecord = free.spawns.find((spawn) => spawn.argv[1] === 'branch')
  assert.deepEqual(callRecord.argv.slice(1), ['branch', '-m', 'old', 'target'])

  const ctx = fakeContext()
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/branch/rename', {
    method: 'POST',
    body: { from: 'old', to: 'existing' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'branch-exists')
})

test('branch delete refuses the current branch and unmerged branches', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const current = await call(ctx, '/api/workbench/git/branch/delete', {
    method: 'POST',
    body: { name: 'main' },
  })
  assert.equal(current.response.status, 409)
  assert.equal(current.body.code, 'current-branch')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'branch').length, 0)

  const unmerged = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'symbolic-ref') return { exitCode: 0, stdout: 'main\n', stderr: '' }
      if (argv[1] === 'branch') return { exitCode: 1, stdout: '', stderr: 'error: the branch is not fully merged' }
      return defaultResult(argv)
    },
  })
  apply(unmerged)
  const refused = await call(unmerged, '/api/workbench/git/branch/delete', {
    method: 'POST',
    body: { name: 'topic' },
  })
  assert.equal(refused.response.status, 409)
  assert.equal(refused.body.code, 'branch-not-merged')
})

test('discard restores the work tree or both sides with a fixed argv', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const unstaged = await call(ctx, '/api/workbench/git/discard', {
    method: 'POST',
    body: { paths: ['src/app.js'], side: 'unstaged' },
  })
  assert.equal(unstaged.body.ok, true)
  const restore = ctx.spawns.find((spawn) => spawn.argv[1] === 'restore')
  assert.deepEqual(restore.argv.slice(1), ['restore', '--worktree', '--', 'src/app.js'])

  const staged = fakeContext()
  apply(staged)
  await call(staged, '/api/workbench/git/discard', { method: 'POST', body: { paths: ['src/app.js'], side: 'staged' } })
  const restore2 = staged.spawns.find((spawn) => spawn.argv[1] === 'restore')
  assert.deepEqual(restore2.argv.slice(1), ['restore', '--staged', '--worktree', '--', 'src/app.js'])
})

test('remove deletes tracked files with git rm and untracked with git clean', async () => {
  const ctx = fakeContext()
  apply(ctx)
  await call(ctx, '/api/workbench/git/remove', { method: 'POST', body: { paths: ['old.md'] } })
  const rm = ctx.spawns.find((spawn) => spawn.argv[1] === 'rm')
  assert.deepEqual(rm.argv.slice(1), ['rm', '-f', '--quiet', '--', 'old.md'])

  const untracked = fakeContext()
  apply(untracked)
  await call(untracked, '/api/workbench/git/remove', {
    method: 'POST',
    body: { paths: ['scratch.txt'], untracked: true },
  })
  const clean = untracked.spawns.find((spawn) => spawn.argv[1] === 'clean')
  assert.deepEqual(clean.argv.slice(1), ['clean', '-f', '--', 'scratch.txt'])
})

test('discard and remove refuse unsafe paths before spawning git', async () => {
  const ctx = fakeContext()
  apply(ctx)
  for (const route of ['/api/workbench/git/discard', '/api/workbench/git/remove']) {
    const { body } = await call(ctx, route, { method: 'POST', body: { paths: ['../escape'] } })
    assert.equal(body.ok, false, route + ' must refuse traversal')
  }
  assert.equal(ctx.spawns.length, 0)
})

test('merge merges a local branch into the current one, unicode names included', async () => {
  const clean = '# branch.oid abc\u0000# branch.head main\u0000'
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'status') return { exitCode: 0, stdout: clean, stderr: '' }
      if (argv[1] === 'merge') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/merge', {
    method: 'POST',
    body: { branch: 'feature-chz-ui改版' },
  })
  assert.equal(body.ok, true)
  const mergeCall = ctx.spawns.find((spawn) => spawn.argv[1] === 'merge')
  assert.deepEqual(mergeCall.argv.slice(1), ['merge', '--no-edit', 'feature-chz-ui改版'])
})

test('merge lets git decide about local changes, refuses self and unknown', async () => {
  const dirty = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'merge') {
        return {
          exitCode: 2,
          stdout: '',
          stderr: 'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/app.js\nPlease commit your changes or stash them before you merge.\nAborting',
        }
      }
      return defaultResult(argv)
    },
  })
  apply(dirty)
  const refused = await call(dirty, '/api/workbench/git/merge', { method: 'POST', body: { branch: 'topic' } })
  assert.equal(refused.response.status, 409)
  assert.equal(refused.body.code, 'dirty-worktree')
  assert.equal(dirty.spawns.filter((spawn) => spawn.argv[1] === 'merge').length, 1, 'git runs and decides')

  const self = fakeContext()
  apply(self)
  const same = await call(self, '/api/workbench/git/merge', { method: 'POST', body: { branch: 'main' } })
  assert.equal(same.response.status, 409)
  assert.equal(same.body.code, 'same-branch')

  const unknown = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse' && argv.includes('--verify')) return { exitCode: 128, stdout: '', stderr: 'not found' }
      return defaultResult(argv)
    },
  })
  apply(unknown)
  const missing = await call(unknown, '/api/workbench/git/merge', { method: 'POST', body: { branch: 'nope' } })
  assert.equal(missing.response.status, 404)
  assert.equal(missing.body.code, 'unknown-branch')
})

test('merge reports unmerged entries separately from local changes', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'merge') {
        return { exitCode: 2, stdout: '', stderr: 'error: Merging is not possible because you have unmerged files.' }
      }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/merge', { method: 'POST', body: { branch: 'topic' } })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'unmerged')
})

test('merge maps conflicts to a 409 instead of throwing', async () => {
  const clean = '# branch.oid abc\u0000# branch.head main\u0000'
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'status') return { exitCode: 0, stdout: clean, stderr: '' }
      if (argv[1] === 'merge') return { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/app.js' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/merge', { method: 'POST', body: { branch: 'topic' } })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'merge-conflict')
})

test('branch names may contain unicode but not characters git forbids', () => {
  for (const good of ['feature-chz-ui改版', '功能/中文分支', 'main']) assert.equal(isSafeBranchName(good), true, good)
  for (const bad of ['a b', 'x~1', 'a..b', 'a:b', 'x.lock', '-rf', '@']) {
    assert.equal(isSafeBranchName(bad), false, bad)
  }
})

test('push uses the upstream when one exists and never forces', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse' && argv.includes('@{u}')) return { exitCode: 0, stdout: 'origin/main\n', stderr: '' }
      if (argv[1] === 'push') return { exitCode: 0, stdout: 'Everything up-to-date', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(body.ok, true)
  assert.equal(body.branch, 'main')
  const push = ctx.spawns.find((spawn) => spawn.argv[1] === 'push')
  assert.deepEqual(push.argv.slice(1), ['push', 'origin', 'main:main'])
  assert.ok(!push.argv.includes('--force'))
})

test('push follows the upstream remote and branch, not push.default', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse' && argv.includes('@{u}')) return { exitCode: 0, stdout: 'upstream/dev\n', stderr: '' }
      if (argv[1] === 'push') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  await call(ctx, '/api/workbench/git/push', { method: 'POST', body: {} })
  const push = ctx.spawns.find((spawn) => spawn.argv[1] === 'push')
  assert.deepEqual(push.argv.slice(1), ['push', 'upstream', 'main:dev'])
})

test('push sets the upstream when the branch has none', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'push') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(body.ok, true)
  const push = ctx.spawns.find((spawn) => spawn.argv[1] === 'push')
  assert.deepEqual(push.argv.slice(1), ['push', '-u', 'origin', 'main'])
})

test('push refuses when there is no origin and the branch has no upstream', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'remote') return { exitCode: 0, stdout: 'backup\n', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(body.code, 'no-remote')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'push').length, 0)
})

test('push refuses without a remote or on a detached head', async () => {
  const noRemote = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'remote') return { exitCode: 0, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(noRemote)
  const { body } = await call(noRemote, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(body.code, 'no-remote')
  assert.equal(noRemote.spawns.filter((spawn) => spawn.argv[1] === 'push').length, 0)

  const detached = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'symbolic-ref') return { exitCode: 1, stdout: '', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(detached)
  const result = await call(detached, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(result.body.code, 'detached-head')
})

test('push translates authentication and non-fast-forward failures', async () => {
  const auth = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'push') return { exitCode: 128, stdout: '', stderr: 'fatal: Authentication failed for https://example/repo.git' }
      return defaultResult(argv)
    },
  })
  apply(auth)
  const authResult = await call(auth, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(authResult.response.status, 409)
  assert.equal(authResult.body.code, 'auth-failed')

  const behind = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'push') {
        return { exitCode: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind' }
      }
      return defaultResult(argv)
    },
  })
  apply(behind)
  const behindResult = await call(behind, '/api/workbench/git/push', { method: 'POST', body: {} })
  assert.equal(behindResult.body.code, 'non-fast-forward')
})

test('refs route parses branches, remotes and tags and marks the current branch', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/refs')

  assert.equal(body.ok, true)
  assert.deepEqual(
    body.branches.map((branch) => [branch.name, branch.current, branch.subject]),
    [
      ['main', true, 'Initial commit'],
      ['topic', false, 'Topic work'],
    ],
  )
  assert.equal(body.remotes[0].name, 'origin/main')
  assert.equal(body.tags[0].name, 'v0.1.0')
  const refsCall = ctx.spawns.find((call) => call.argv[1] === 'for-each-ref')
  assert.ok(refsCall, 'refs must come from for-each-ref')
})

test('stage route passes paths after -- and refuses unsafe ones', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/stage', {
    method: 'POST',
    body: { paths: ['src/app.js', 'docs/new-note.md'] },
  })
  assert.equal(body.ok, true)
  const callRecord = ctx.spawns.find((spawn) => spawn.argv[1] === 'add')
  assert.ok(callRecord, 'stage must run git add')
  const dashDash = callRecord.argv.indexOf('--')
  assert.deepEqual(callRecord.argv.slice(dashDash + 1), ['src/app.js', 'docs/new-note.md'])

  const before = ctx.spawns.length
  const bad = await call(ctx, '/api/workbench/git/stage', { method: 'POST', body: { paths: ['../escape'] } })
  assert.equal(bad.body.ok, false)
  assert.equal(ctx.spawns.length, before, 'no git process may run for a rejected path')
})

test('unstage route resets the index without touching the work tree', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/unstage', {
    method: 'POST',
    body: { paths: ['src/staged.js'] },
  })
  assert.equal(body.ok, true)
  const callRecord = ctx.spawns.find((spawn) => spawn.argv[1] === 'reset')
  assert.deepEqual(callRecord.argv.slice(1, 4), ['reset', '--quiet', 'HEAD'])
  assert.deepEqual(callRecord.argv.slice(callRecord.argv.indexOf('--') + 1), ['src/staged.js'])
})

test('commit route refuses an empty message before calling git', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/commit', { method: 'POST', body: { message: '   ' } })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'empty-message')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'commit').length, 0)
})

test('commit route refuses while conflicts remain', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'ls-files') return { exitCode: 0, stdout: '100644 aaaa 0\tsrc/conflict.js\u0000', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/commit', {
    method: 'POST',
    body: { message: 'try to commit' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'conflicts-present')
  assert.equal(ctx.spawns.filter((spawn) => spawn.argv[1] === 'commit').length, 0)
})

test('commit route passes one -m argv and returns a receipt', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: 'abcdef1234567890\n', stderr: '' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const message = 'fix: panel\n\nbody line'
  const { body } = await call(ctx, '/api/workbench/git/commit', { method: 'POST', body: { message } })
  assert.equal(body.ok, true)
  assert.equal(body.shortSha, 'abcdef1')
  assert.equal(body.subject, 'fix: panel')

  const callRecord = ctx.spawns.find((spawn) => spawn.argv[1] === 'commit')
  assert.deepEqual(callRecord.argv.slice(1), ['commit', '-m', message])
})

test('commit route maps git\'s nothing-to-commit to a 409', async () => {
  const ctx = fakeContext({
    handler: (argv) => {
      if (argv[1] === 'commit') return { exitCode: 1, stdout: '', stderr: 'nothing to commit, working tree clean' }
      return defaultResult(argv)
    },
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/commit', {
    method: 'POST',
    body: { message: 'noop' },
  })
  assert.equal(response.status, 409)
  assert.equal(body.code, 'nothing-to-commit')
})

test('open route reveals the selected repository in Finder with a fixed argv', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/open', {
    method: 'POST',
    body: { target: 'finder' },
  })
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.target, 'finder')
  assert.equal(body.cwd, WORKSPACE)

  const openCall = ctx.spawns.find((spawn) => spawn.argv[0] === '/usr/bin/open')
  assert.ok(openCall, 'Finder action must run open')
  assert.deepEqual(openCall.argv, ['/usr/bin/open', WORKSPACE])
  assert.equal(openCall.cwd, WORKSPACE)
})

test('open route opens Terminal in the selected repository with a fixed argv', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/open', {
    method: 'POST',
    body: { target: 'terminal' },
  })
  assert.equal(body.ok, true)
  assert.equal(body.target, 'terminal')

  const openCall = ctx.spawns.find((spawn) => spawn.argv[0] === '/usr/bin/open')
  assert.deepEqual(openCall.argv, ['/usr/bin/open', '-a', 'Terminal', WORKSPACE])
  assert.equal(openCall.cwd, WORKSPACE)
})

test('open route rejects an unknown target with 400 and runs nothing', async () => {
  const ctx = fakeContext()
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/open', {
    method: 'POST',
    body: { target: 'explorer' },
  })
  assert.equal(response.status, 400)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'unknown-target')
  assert.equal(ctx.spawns.length, 0)
})

test('open route keeps the argv fixed and the cwd inside a registered workspace', async () => {
  const ctx = fakeContext()
  apply(ctx)
  // Extra body fields are ignored; the target must not contribute argv entries.
  const { body } = await call(ctx, '/api/workbench/git/open?cwd=' + encodeURIComponent('/tmp/other-repo'), {
    method: 'POST',
    body: { target: 'finder', argv: ['-a', 'Calculator'], path: '/etc/passwd' },
  })
  assert.equal(body.ok, true)
  assert.equal(body.cwd, '/tmp/other-repo')
  const openCall = ctx.spawns.find((spawn) => spawn.argv[0] === '/usr/bin/open')
  assert.deepEqual(openCall.argv, ['/usr/bin/open', '/tmp/other-repo'])
  assert.equal(openCall.cwd, '/tmp/other-repo')

  const before = ctx.spawns.length
  const outside = await call(ctx, '/api/workbench/git/open?cwd=' + encodeURIComponent('/etc'), {
    method: 'POST',
    body: { target: 'finder' },
  })
  assert.equal(outside.body.ok, false)
  assert.equal(outside.body.code, 'outside-workspace')
  assert.equal(ctx.spawns.length, before, 'no process may run for a cwd outside the registry')

  const injected = await call(ctx, '/api/workbench/git/open', {
    method: 'POST',
    body: { target: 'finder; open -a Calculator' },
  })
  assert.equal(injected.response.status, 400)
  assert.equal(injected.body.code, 'unknown-target')
  assert.equal(ctx.spawns.length, before, 'an option-shaped target may not reach argv')
})

test('open route reports a failed open as ok:false instead of throwing', async () => {
  const ctx = fakeContext({
    handler: (argv) =>
      argv[0] === '/usr/bin/open'
        ? { exitCode: 1, stdout: '', stderr: 'Unable to find application named Terminal' }
        : defaultResult(argv),
  })
  apply(ctx)
  const { response, body } = await call(ctx, '/api/workbench/git/open', {
    method: 'POST',
    body: { target: 'terminal' },
  })
  assert.equal(response.status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'open-failed')
  assert.match(body.error, /Terminal/)
})

test('pull only fast-forwards the tracked branch and disables autostash', async () => {
  const ctx = fakeContext({ handler: argv => {
    if (argv[1] === 'rev-parse' && argv.includes('@{u}')) return { exitCode: 0, stdout: 'origin/main\n', stderr: '' }
    if (argv[1] === 'pull') return { exitCode: 0, stdout: '', stderr: '' }
    return defaultResult(argv)
  } })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/pull', { method: 'POST', body: {} })
  assert.equal(body.ok, true)
  assert.equal(body.upstream, 'origin/main')
  assert.deepEqual(ctx.spawns.find(s => s.argv[1] === 'pull').argv.slice(1), ['pull', '--ff-only', '--no-rebase', '--no-autostash'])
})

test('pull refuses missing upstream and detached HEAD before mutation', async () => {
  for (const detached of [false, true]) {
    const ctx = fakeContext({ handler: argv => {
      if (detached && argv[1] === 'symbolic-ref') return { exitCode: 1, stdout: '', stderr: '' }
      return defaultResult(argv)
    } })
    apply(ctx)
    const { body } = await call(ctx, '/api/workbench/git/pull', { method: 'POST', body: {} })
    assert.equal(body.ok, false)
    assert.equal(ctx.spawns.some(s => s.argv[1] === 'pull'), false)
  }
})

test('pull reports diverged branches without attempting a merge or rebase', async () => {
  const ctx = fakeContext({ handler: argv => {
    if (argv[1] === 'rev-parse' && argv.includes('@{u}')) return { exitCode: 0, stdout: 'origin/main\n', stderr: '' }
    if (argv[1] === 'pull') return { exitCode: 128, stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' }
    return defaultResult(argv)
  } })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/pull', { method: 'POST', body: {} })
  assert.equal(body.ok, false)
  assert.match(body.error, /分叉/)
  assert.equal(ctx.spawns.some(s => ['merge', 'rebase'].includes(s.argv[1])), false)
})

test('explicit remote push targets the same branch without changing upstream', async () => {
  const ctx = fakeContext({ handler: argv => {
    if (argv[1] === 'remote') return { exitCode: 0, stdout: 'origin\ngithub\n', stderr: '' }
    if (argv[1] === 'rev-parse' && argv.includes('@{u}')) return { exitCode: 0, stdout: 'origin/dev\n', stderr: '' }
    return defaultResult(argv)
  } })
  apply(ctx)
  const { body } = await call(ctx, '/api/workbench/git/push', { method: 'POST', body: { remote: 'github' } })
  assert.equal(body.ok, true)
  assert.equal(body.upstream, 'github/main')
  assert.deepEqual(ctx.spawns.find(s => s.argv[1] === 'push').argv.slice(1), ['push', 'github', 'refs/heads/main:refs/heads/main'])
})

test('explicit push rejects unconfigured, option-like and malformed remote targets', async () => {
  for (const remote of ['https://example.com/repo', '--all', '', null, ['origin']]) {
    const ctx = fakeContext()
    apply(ctx)
    const { body } = await call(ctx, '/api/workbench/git/push', { method: 'POST', body: { remote } })
    assert.equal(body.code, 'invalid-remote')
    assert.equal(ctx.spawns.some(s => s.argv[1] === 'push'), false)
  }
})
