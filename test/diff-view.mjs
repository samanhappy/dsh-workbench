// MR/PR 详情 diff 视图测试（parseUnifiedDiff / hunkRows / renderedHunks）。
//
// 详情页的代码差异不再 dump 原始 unified diff 文本，而是移植 DSH harness
// ReviewTab 的渲染核心：unified diff 文本（glab mr diff / gh pr diff 的输出）
// 先解析成按文件分组的 hunk 结构（对齐 workspace-changes 的 WorkspaceDiffHunk
// 形状），再按行号 + 增删着色渲染。解析层契约：
//   - 按 `diff --git` 分节解析：一节坏掉只降级该节，其余文件存活；
//   - 先剥离 ANSI 色码（glab 可能带色输出，否则文件名解析不出来）；
//   - /dev/null 识别新建 / 删除；`Binary files … differ` 识别二进制；
//   - 纯权限变更（old/new mode、无 hunk）标注 modeChange；
//   - 引号 + 八进制转义的路径（git 对含空格 / 非 ASCII 路径的默认处理）解码；
//   - 任何输入都不抛异常：空 / 乱文本 → 空数组。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

const { parseUnifiedDiff, hunkRows, renderedHunks, fileStatus } = loadClientModule()

const GIT_MULTIFILE = [
  'diff --git a/src/foo.java b/src/foo.java',
  'index 1111..2222 100644',
  '--- a/src/foo.java',
  '+++ b/src/foo.java',
  '@@ -1,3 +1,4 @@',
  ' context',
  '-old line',
  '+new line',
  '+added line',
  ' context2',
  '@@ -10,3 +11,4 @@ ctx',
  ' c1',
  '-d1',
  '+a1',
  '+a2',
  ' c2',
  'diff --git a/README.md b/README.md',
  'index 3333..4444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,1 +1,2 @@',
  ' title',
  '+new readme line',
].join('\n') + '\n'

test('parseUnifiedDiff: 多文件 git diff 按文件分组，路径剥 a/ b/ 前缀', () => {
  const files = parseUnifiedDiff(GIT_MULTIFILE)
  assert.deepEqual(files.map((f) => f.path), ['src/foo.java', 'README.md'])
  const foo = files[0]
  assert.equal(foo.hunks.length, 2)
  assert.deepEqual(
    foo.hunks.map((hk) => [hk.oldStart, hk.oldLines, hk.newStart, hk.newLines]),
    [[1, 3, 1, 4], [10, 3, 11, 4]],
  )
  assert.deepEqual(foo.hunks[0].lines, [' context', '-old line', '+new line', '+added line', ' context2'])
  assert.equal(foo.added, 4)
  assert.equal(foo.deleted, 2)
  assert.equal(foo.before, true)
  assert.equal(foo.after, true)
  assert.equal(foo.binary, false)
})

test('parseUnifiedDiff: /dev/null 识别新建与删除', () => {
  const text = [
    'diff --git a/new.md b/new.md',
    'new file mode 100644',
    'index 0000000..3333',
    '--- /dev/null',
    '+++ b/new.md',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    'diff --git a/gone.md b/gone.md',
    'deleted file mode 100644',
    'index 4444..0000000',
    '--- a/gone.md',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-gone line',
  ].join('\n') + '\n'
  const [created, deleted] = parseUnifiedDiff(text)
  assert.equal(created.path, 'new.md')
  assert.equal(created.before, false)
  assert.equal(created.after, true)
  assert.equal(created.added, 2)
  assert.equal(deleted.path, 'gone.md')
  assert.equal(deleted.after, false)
  assert.equal(deleted.before, true)
  assert.equal(deleted.added, 0)
  assert.equal(deleted.deleted, 1)
})

test('parseUnifiedDiff: Binary files 标记 → binary，无 hunks', () => {
  const text = [
    'diff --git a/logo.png b/logo.png',
    'index 4444..5555 100644',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n') + '\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'logo.png')
  assert.equal(file.binary, true)
  assert.deepEqual(file.hunks, [])
})

test('parseUnifiedDiff: ANSI 色码先剥离再解析（否则文件名出不来）', () => {
  const text = '\x1b[32mdiff --git a/x.py b/x.py\x1b[m\n'
    + '\x1b[36mindex 1111..2222 100644\x1b[m\n'
    + '\x1b[31m--- a/x.py\x1b[m\n'
    + '\x1b[32m+++ b/x.py\x1b[m\n'
    + '\x1b[36m@@ -1,1 +1,1 @@\x1b[m\n'
    + '-a\n'
    + '+b\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'x.py')
  assert.deepEqual(file.hunks[0].lines, ['-a', '+b'])
})

test('parseUnifiedDiff: 引号 + 八进制转义路径解码（git 对空格 / 非 ASCII 路径的默认输出）', () => {
  const text = [
    'diff --git a/docs/\\344\\272\\214.md b/docs/\\344\\272\\214.md',
    'index 1111..2222 100644',
    '--- "a/docs/\\344\\272\\214.md"',
    '+++ "b/docs/\\344\\272\\214.md"',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
    'diff --git a/my file.md b/my file.md',
    'index 1111..2222 100644',
    '--- "a/my file.md"',
    '+++ "b/my file.md"',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n') + '\n'
  const files = parseUnifiedDiff(text)
  assert.deepEqual(files.map((f) => f.path), ['docs/二.md', 'my file.md'])
})

test('parseUnifiedDiff: 纯权限变更标注 modeChange，无 hunks', () => {
  const text = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'run.sh')
  assert.equal(file.modeChange, '100644 → 100755')
  assert.deepEqual(file.hunks, [])
})

test('parseUnifiedDiff: 一节坏 hunk 只降级该节，其余文件存活', () => {
  const text = GIT_MULTIFILE
    + 'diff --git a/broken.md b/broken.md\n'
    + '--- a/broken.md\n'
    + '+++ b/broken.md\n'
    + '@@ -1,2 +1,2 @@\n' // 声明 2 行但只给 1 行 → parsePatch 抛错
    + '-only one\n'
  const files = parseUnifiedDiff(text)
  assert.deepEqual(files.map((f) => f.path), ['src/foo.java', 'README.md'])
})

test('parseUnifiedDiff: 无 diff --git 头的朴素 unified diff 也能解析', () => {
  const text = '--- a/plain.txt\n+++ b/plain.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'plain.txt')
  assert.equal(file.added, 1)
  assert.equal(file.deleted, 1)
})

test('parseUnifiedDiff: 旧式 --- 路径 + 制表符时间戳剥掉', () => {
  const text = '--- a/old.txt\t2026-09-18 10:00:00\n+++ b/old.txt\t2026-09-18 11:00:00\n@@ -1,1 +1,1 @@\n-a\n+b\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'old.txt')
})

test('parseUnifiedDiff: 空 / 乱文本 → 空数组，不抛异常', () => {
  assert.deepEqual(parseUnifiedDiff(''), [])
  assert.deepEqual(parseUnifiedDiff('hello world\nnot a diff\n'), [])
  assert.deepEqual(parseUnifiedDiff(null), [])
  assert.deepEqual(parseUnifiedDiff(undefined), [])
})

test('hunkRows: 行号编号 —— 删除记旧侧、新增记新侧、上下文两侧都记', () => {
  const rows = hunkRows({ oldStart: 7, oldLines: 3, newStart: 5, newLines: 4, lines: [' ctx', '-del', '+add1', '+add2', ' ctx2'] })
  assert.deepEqual(rows, [
    { kind: 'context', old: 7, new: 5, text: 'ctx' },
    { kind: 'del', old: 8, new: undefined, text: 'del' },
    { kind: 'add', old: undefined, new: 6, text: 'add1' },
    { kind: 'add', old: undefined, new: 7, text: 'add2' },
    { kind: 'context', old: 9, new: 8, text: 'ctx2' },
  ])
})

test('renderedHunks: 超预算截断最后一个 hunk 并置 truncated', () => {
  const hunks = [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', ' b', ' c'] },
    { oldStart: 9, oldLines: 4, newStart: 9, newLines: 4, lines: [' d', '-e', '+f', ' g'] },
  ]
  const cut = renderedHunks(hunks, 5)
  assert.equal(cut.truncated, true)
  assert.equal(cut.hunks.length, 2)
  assert.deepEqual(cut.hunks[0].lines, [' a', ' b', ' c'])
  assert.deepEqual(cut.hunks[1].lines, [' d', '-e'])

  const full = renderedHunks(hunks, 5000)
  assert.equal(full.truncated, false)
  assert.deepEqual(full.hunks, hunks)
})

test('parseUnifiedDiff: glab 风格（无 diff --git / 无 a b 前缀）多文件拼接 → 逐文件拆分', () => {
  // glab mr diff 输出形状：GitLab API 的 per-file diff 直接
  // 拼接，只有 --- 全路径 / +++ 全路径，没有 diff --git 行。
  const text = [
    '--- demo-service/api/DemoReq.java',
    '+++ demo-service/api/DemoReq.java',
    '@@ -7,4 +7,5 @@ public class DemoReq {',
    '  private Long personCorpId;',
    '  private String contactUserid;',
    '  private String personUserid;',
    '+  private String contactMobile;',
    ' }',
    '--- demo-service/api/DemoResp.java',
    '+++ demo-service/api/DemoResp.java',
    '@@ -33,4 +33,5 @@ public class DemoResp {',
    '  private String systemTags;',
    '  private String personalName;',
    '  private List<String> agentMobile;',
    '+  private Boolean bindDemoAccount;',
    ' }',
    '--- demo-service/biz/DemoConfig.java',
    '+++ demo-service/biz/DemoConfig.java',
    '@@ -59,6 +59,9 @@ public class DemoConfig {',
    ' ',
    '  private String otherReply = "This request type is not supported.";',
    ' ',
    '+  /** Reply text when the demo account is not bound. */',
    '+  private String demoUnboundReply = "This account is not bound. Contact the administrator to bind it.";',
    '+',
    '  // -------------------------------------------------------',
    '  // Demo feedback loop',
    '  // -------------------------------------------------------',
  ].join('\n') + '\n'
  const files = parseUnifiedDiff(text)
  assert.deepEqual(files.map((f) => f.path), [
    'demo-service/api/DemoReq.java',
    'demo-service/api/DemoResp.java',
    'demo-service/biz/DemoConfig.java',
  ])
  assert.equal(files[0].added, 1)
  assert.equal(files[0].deleted, 0)
  assert.equal(files[2].added, 3)
  assert.equal(files[2].hunks[0].lines[0], ' ')
})

test('parseUnifiedDiff: hunk 体内的 ---/+++ 行不误判为文件边界', () => {
  const text = [
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,3 +1,3 @@',
    ' ctx',
    '--- gone line',
    '+++ new line',
    ' ctx2',
    '--- a/y.md',
    '+++ b/y.md',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n') + '\n'
  const files = parseUnifiedDiff(text)
  assert.deepEqual(files.map((f) => f.path), ['x.md', 'y.md'])
  assert.deepEqual(files[0].hunks[0].lines, [' ctx', '--- gone line', '+++ new line', ' ctx2'])
  assert.equal(files[0].added, 1)
  assert.equal(files[0].deleted, 1)
})

test('parseUnifiedDiff: \\ No newline at end of file 不占 hunk 行数、不破坏后续拆分', () => {
  const text = [
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '--- a/b.txt',
    '+++ b/b.txt',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n') + '\n'
  const files = parseUnifiedDiff(text)
  assert.deepEqual(files.map((f) => f.path), ['a.txt', 'b.txt'])
  assert.deepEqual(files[0].hunks[0].lines, ['-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file'])
})

test('parseUnifiedDiff: glab 风格下真实以 a/ 开头的路径不被误剥前缀', () => {
  const text = [
    '--- a/legacy.txt',
    '+++ a/legacy.txt',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n') + '\n'
  const [file] = parseUnifiedDiff(text)
  assert.equal(file.path, 'a/legacy.txt')
})

test('fileStatus: /dev/null 旧侧 → A（新建），/dev/null 新侧 → D（删除）', () => {
  assert.equal(fileStatus(parseUnifiedDiff([
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,1 @@',
    '+x',
  ].join('\n') + '\n')[0]), 'A')
  assert.equal(fileStatus(parseUnifiedDiff([
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-x',
  ].join('\n') + '\n')[0]), 'D')
})

test('fileStatus: 两侧都在 → M（修改）', () => {
  const files = parseUnifiedDiff(GIT_MULTIFILE)
  assert.equal(fileStatus(files[0]), 'M')
  assert.equal(fileStatus(files[1]), 'M')
})
