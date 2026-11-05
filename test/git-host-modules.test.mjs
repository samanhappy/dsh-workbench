// Unit contract for the extracted host modules.
//
// These tests pin the seam ticket #2 created (host modules importable in plain
// Node, no DSH context) plus the parsers' record vocabulary: porcelain v2 with
// renames/conflicts/two-sided changes, and the structured diff the panel renders.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execGit, git, gitEnvironment, operatorGitConfig } from '../src/host/git/git.js'
import { openArgv } from '../src/host/git/open.js'
import { RequestError } from '../src/host/git/errors.js'
import { parsePorcelainV2, summariseEntries } from '../src/host/git/porcelain.js'
import { parseUnifiedDiff } from '../src/host/git/diff.js'
import { parseRefs } from '../src/host/git/refs.js'
import { assignLanes, isSafeBranchName, parseHistoryLog } from '../src/host/git/history.js'

const STATUS_FIXTURE =
  [
    '# branch.oid 0123456789abcdef',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/app.js',
    '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/staged.js',
    '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/two.js',
    '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 docs/new name.md',
    'old/name.md',
    'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.js',
    '? docs/untracked.md',
    '! scratch/ignored.log',
  ].join('\u0000') + '\u0000'

const DIFF_FIXTURE = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,3 +1,4 @@ function main()',
  ' console.log("app")',
  '-export const a = 1',
  '+export const a = 2',
  '+export const b = 3',
  ' // tail',
  '\\ No newline at end of file',
  'diff --git a/old.md b/new.md',
  'similarity index 100%',
  'rename from old.md',
  'rename to new.md',
  'diff --git a/img.png b/img.png',
  'index 1111111..2222222 100644',
  'Binary files a/img.png and b/img.png differ',
  '',
].join('\n')

function fakeSubprocess({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const spawns = []
  return {
    spawns,
    async resolveExecutable(command) {
      assert.equal(command, 'git')
      return '/usr/local/bin/git'
    },
    spawn(options) {
      spawns.push(options)
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
      }
    },
  }
}

test('porcelain parser understands every v2 record in plain Node', () => {
  const parsed = parsePorcelainV2(STATUS_FIXTURE)

  assert.equal(parsed.oid, '0123456789abcdef')
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 2)
  assert.equal(parsed.behind, 1)
  assert.equal(parsed.truncated, false)

  const byPath = Object.fromEntries(parsed.entries.map((entry) => [entry.path, entry]))
  assert.deepEqual(byPath['src/app.js'], {
    path: 'src/app.js',
    x: '.',
    y: 'M',
    kind: 'changed',
    staged: false,
    unstaged: true,
    conflicted: false,
  })
  assert.equal(byPath['src/two.js'].staged, true)
  assert.equal(byPath['src/two.js'].unstaged, true)
  assert.equal(byPath['docs/new name.md'].kind, 'renamed')
  assert.equal(byPath['docs/new name.md'].origPath, 'old/name.md')
  assert.equal(byPath['src/conflict.js'].kind, 'conflicted')
  assert.equal(byPath['src/conflict.js'].conflicted, true)
  assert.equal(byPath['docs/untracked.md'].kind, 'untracked')
  assert.equal(byPath['scratch/ignored.log'].kind, 'ignored')

  assert.deepEqual(summariseEntries(parsed.entries), { staged: 3, unstaged: 3, conflicted: 1 })
})

test('porcelain parser caps the entry list and reports truncation', () => {
  const records = []
  for (let index = 0; index < 5005; index += 1) records.push('? file-' + String(index) + '.txt')
  const parsed = parsePorcelainV2(records.join('\u0000') + '\u0000')

  assert.equal(parsed.entries.length, 5000)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.entries[4999].path, 'file-4999.txt')
})

test('diff parser keeps line numbers, hunk headers, rename and binary markers', () => {
  const parsed = parseUnifiedDiff(DIFF_FIXTURE)

  assert.deepEqual(parsed.stats, { additions: 2, deletions: 1 })
  assert.equal(parsed.files.length, 3)

  const [modified, renamed, binary] = parsed.files
  assert.equal(modified.newPath, 'src/app.js')
  assert.equal(modified.hunks[0].heading, 'function main()')
  assert.deepEqual(
    modified.hunks[0].lines.map((line) => [line.kind, line.oldNo, line.newNo]),
    [
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['meta', null, null],
    ],
  )

  assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.oldPath, 'old.md')
  assert.equal(renamed.newPath, 'new.md')

  assert.equal(binary.binary, true)
  assert.equal(parsed.binary, false, 'a mixed diff is not all-binary')
})

test('diff parser reports a fully binary diff', () => {
  const parsed = parseUnifiedDiff(
    [
      'diff --git a/img.png b/img.png',
      'index 1111111..2222222 100644',
      'Binary files a/img.png and b/img.png differ',
      '',
    ].join('\n'),
  )
  assert.equal(parsed.binary, true)
  assert.equal(parsed.files[0].status, 'modified')
})

test('refs parser groups refs and marks the current branch', () => {
  const parsed = parseRefs(
    [
      'refs/heads/topic\u0000def5678\u0000\u00001780000000\u0000Topic work',
      'refs/heads/main\u0000abc1234\u0000origin/main\u00001790000000\u0000Initial commit',
      'refs/remotes/origin/main\u0000abc1234\u0000\u00001790000000\u0000Initial commit',
      'refs/tags/v0.1.0\u0000abc1234\u0000\u00001790000000\u0000Release',
    ].join('\n'),
    'main',
  )
  assert.deepEqual(parsed.branches.map((branch) => branch.name), ['main', 'topic'])
  assert.equal(parsed.branches[0].current, true)
  assert.equal(parsed.branches[0].upstream, 'origin/main')
  assert.equal(parsed.branches[1].current, false)
  assert.equal(parsed.remotes.length, 1)
  assert.equal(parsed.tags.length, 1)
})

test('history parser reads fields, decorations and merges', () => {
  const text =
    [
      ['c3', 'c2 c1', 'Ann', 'ann@example.com', '2026-10-20T10:00:00+08:00', "Merge topic", 'HEAD -> refs/heads/main, refs/remotes/origin/main'],
      ['c2', 'c1', 'Bob', 'bob@example.com', '2026-10-19T10:00:00+08:00', 'fix', ''],
      ['c1', '', 'Ann', 'ann@example.com', '2026-10-18T10:00:00+08:00', 'initial', 'tag: refs/tags/v1'],
    ].map((row) => row.join('\u0000')).join('\u001e') + '\u001e'
  const commits = parseHistoryLog(text)
  assert.equal(commits.length, 3)
  assert.deepEqual(commits[0].parents, ['c2', 'c1'])
  assert.deepEqual(commits[0].refs, [{ name: 'main', kind: 'branch' }])
  assert.deepEqual(commits[2].refs, [{ name: 'v1', kind: 'tag' }])
})

test('lane assignment continues the first parent and opens a lane for a merge', () => {
  const commits = parseHistoryLog(
    [
      ['c3', 'c2 c1', 'A', 'a@x', '2026-10-20T00:00:00+08:00', 'merge', ''],
      ['c2', 'c1', 'A', 'a@x', '2026-10-19T00:00:00+08:00', 'side', ''],
      ['c1', '', 'A', 'a@x', '2026-10-18T00:00:00+08:00', 'base', ''],
    ].map((row) => row.join('\u0000')).join('\u001e') + '\u001e',
  )
  const laneCount = assignLanes(commits)
  assert.equal(commits[0].lane, 0)
  assert.equal(commits[0].parentLanes[0], 0, 'first parent continues the lane')
  assert.equal(commits[0].parentLanes[1], 1, 'merge parent opens a second lane')
  assert.ok(laneCount >= 2)
})

test('branch names are validated before they can reach argv', () => {
  for (const good of ['main', 'feature/x-1', 'release/2026.10']) assert.equal(isSafeBranchName(good), true, good)
  for (const bad of ['-rf', '../x', 'a..b', 'a b', 'x.lock', '/lead', 'trail/', 'a@{1}', '']) {
    assert.equal(isSafeBranchName(bad), false, bad)
  }
})

test('git runner spawns argv directly, with the scrubbed git environment', async () => {
  const subprocess = fakeSubprocess({ stdout: 'status text' })
  const signal = new AbortController().signal

  const result = await execGit(subprocess, ['status', '--porcelain=v2'], '/tmp/workspace', {
    maxBytes: 1234,
    signal,
  })

  assert.deepEqual(result, { code: 0, out: 'status text', err: '' })
  assert.equal(subprocess.spawns.length, 1)
  const spawn = subprocess.spawns[0]
  assert.deepEqual(spawn.argv, ['/usr/local/bin/git', 'status', '--porcelain=v2'])
  assert.equal(spawn.cwd, '/tmp/workspace')
  assert.equal(spawn.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(spawn.env.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(spawn.env.GIT_CONFIG_COUNT, '0')
  assert.equal(spawn.stdio.stdin, 'ignore')
  assert.deepEqual(spawn.stdio.stdout, { maxBytes: 1234 })
  assert.equal(spawn.signal, signal)
})

test('git helper rejects a failed command with git stderr as the message', async () => {
  const subprocess = fakeSubprocess({ exitCode: 128, stderr: 'fatal: not a git repository\n' })

  await assert.rejects(
    () => git(subprocess, ['status'], '/tmp/workspace'),
    (error) => error.code === 'git-failed' && error.message === 'fatal: not a git repository',
  )
})

test('git runs as the operator, never with a plugin-injected global config', async () => {
  const home = mkdtempSync(join(tmpdir(), 'git-operator-'))
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Operator\n')
  const dshHome = join(home, '.dsh')
  const injected = join(dshHome, 'state/agent/worker-gitconfig')

  // Unset, or a value the operator chose, is inherited untouched.
  assert.equal(operatorGitConfig({ HOME: home, DSH_HOME: dshHome }), undefined)
  assert.equal(operatorGitConfig({ HOME: home, DSH_HOME: dshHome, GIT_CONFIG_GLOBAL: '' }), undefined)
  assert.equal(operatorGitConfig({ HOME: home, DSH_HOME: dshHome, GIT_CONFIG_GLOBAL: join(home, 'work.gitconfig') }), undefined)
  // An injected config under the harness home is replaced by the operator's.
  assert.equal(operatorGitConfig({ HOME: home, DSH_HOME: dshHome, GIT_CONFIG_GLOBAL: injected }), join(home, '.gitconfig'))
  // The harness home defaults to ~/.dsh when DSH_HOME is not exported.
  assert.equal(operatorGitConfig({ HOME: home, GIT_CONFIG_GLOBAL: injected }), join(home, '.gitconfig'))
  // An XDG-only operator config is used when there is no ~/.gitconfig.
  const xdgHome = mkdtempSync(join(tmpdir(), 'git-operator-xdg-'))
  const xdgConfig = join(xdgHome, 'xdg', 'git', 'config')
  mkdirSync(dirname(xdgConfig), { recursive: true })
  writeFileSync(xdgConfig, '[user]\n\tname = Operator\n')
  assert.equal(
    operatorGitConfig({ HOME: xdgHome, XDG_CONFIG_HOME: join(xdgHome, 'xdg'), GIT_CONFIG_GLOBAL: join(xdgHome, '.dsh/state/agent/worker-gitconfig') }),
    xdgConfig,
  )
  // Without any operator config the path stays operator-side, never the injected one.
  assert.equal(
    operatorGitConfig({ HOME: xdgHome, DSH_HOME: join(xdgHome, '.dsh'), GIT_CONFIG_GLOBAL: join(xdgHome, '.dsh/state/agent/worker-gitconfig') }),
    join(xdgHome, '.gitconfig'),
  )
  // A harness that replaces the global config also suppresses the machine config,
  // where macOS keeps the credential helper a push needs: restore both or neither.
  assert.equal('GIT_CONFIG_NOSYSTEM' in gitEnvironment({ HOME: home, DSH_HOME: dshHome }), false)
  assert.equal(gitEnvironment({ HOME: home, DSH_HOME: dshHome, GIT_CONFIG_GLOBAL: injected }).GIT_CONFIG_NOSYSTEM, '0')

  // The runner wires it into the child environment.
  const saved = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL }
  process.env.HOME = home
  process.env.DSH_HOME = dshHome
  process.env.GIT_CONFIG_GLOBAL = injected
  try {
    const subprocess = fakeSubprocess({ stdout: 'status text' })
    await execGit(subprocess, ['status'], '/tmp/workspace')
    assert.equal(subprocess.spawns[0].env.GIT_CONFIG_GLOBAL, join(home, '.gitconfig'))
    assert.equal(subprocess.spawns[0].env.GIT_CONFIG_NOSYSTEM, '0')
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved.DSH_HOME
    if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL
    rmSync(home, { recursive: true, force: true })
    rmSync(xdgHome, { recursive: true, force: true })
  }
})

test('open argv is fixed per target and refuses unknown targets or non-macOS hosts', () => {
  assert.deepEqual(openArgv('finder', '/tmp/workspace', 'darwin'), ['/tmp/workspace'])
  assert.deepEqual(openArgv('terminal', '/tmp/workspace', 'darwin'), ['-a', 'Terminal', '/tmp/workspace'])

  for (const target of ['explorer', '', '-a', 'finder; rm -rf /']) {
    assert.throws(
      () => openArgv(target, '/tmp/workspace', 'darwin'),
      (error) => error instanceof RequestError && error.code === 'unknown-target',
      'must refuse target ' + JSON.stringify(target),
    )
  }

  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.throws(
      () => openArgv('finder', '/tmp/workspace', platform),
      (error) => error instanceof RequestError && error.code === 'unsupported-platform',
      'must refuse ' + platform,
    )
  }
})
