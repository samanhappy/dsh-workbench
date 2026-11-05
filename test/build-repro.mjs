// Guards build reproducibility — regression for the issue where the committed
// index.js baked in a machine-specific tsconfig `paths` location
// (~/.nvm/.../@deepseek-ai/dsh/...), so any rebuild on a machine without that
// exact install produced different bytes, dirtied `git status`, and blocked
// the auto-updater ("安装目录有本地修改").
//
// Two contracts, both asserted byte-for-byte against the committed artifacts:
//   1. A fresh build with the production options reproduces the committed
//      index.js / lib/client.js exactly.
//   2. The output is identical even when tsconfig `paths` resolve to an
//      install location that does not exist (the machine-dependent case) —
//      bundling must not depend on tsconfig at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildHostBundle, buildClientBundle } from '../build.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMITTED_HOST = join(ROOT, 'index.js')
const COMMITTED_CLIENT = join(ROOT, 'lib', 'client.js')

// Simulates a machine whose DSH install is not at the absolute path that
// tsconfig.json `paths` maps @deepseek-ai/* to (e.g. app-bundle / pnpm-store
// installs). It mirrors tsconfig.build.json exactly but adds dead `paths`, so
// the only variable under test is whether bundling depends on `paths`.
const deadTsconfig = join(tmpdir(), `wb-build-repro-dead-tsconfig-${process.pid}.json`)

test('committed artifacts are reproducible and independent of tsconfig paths', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-build-repro-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(deadTsconfig, { force: true })
  })
  // tsconfig.build.json carries explanatory comments, so strip full-line
  // comments before parsing.
  const buildConfig = JSON.parse((await readFile(join(ROOT, 'tsconfig.build.json'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''))
  await writeFile(deadTsconfig, JSON.stringify({
    ...buildConfig,
    compilerOptions: {
      ...buildConfig.compilerOptions,
      baseUrl: '.',
      paths: { '@deepseek-ai/*': ['/nonexistent/.nvm/versions/node/v99.99.99/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*'] },
    },
  }))

  const hostDefault = join(dir, 'index.js')
  const clientDefault = join(dir, 'client.js')
  await buildHostBundle(hostDefault)
  await buildClientBundle(clientDefault)

  const hostDead = join(dir, 'index-dead.js')
  const clientDead = join(dir, 'client-dead.js')
  await buildHostBundle(hostDead, { tsconfig: deadTsconfig })
  await buildClientBundle(clientDead, { tsconfig: deadTsconfig })

  const committedHost = await readFile(COMMITTED_HOST)
  const committedClient = await readFile(COMMITTED_CLIENT)

  // Note: use Buffer#equals (boolean), not assert.deepEqual — Node's deepEqual
  // diff generation on large differing Buffers hangs.
  assert.ok((await readFile(hostDefault)).equals(committedHost),
    'fresh host build must byte-match the committed index.js')
  assert.ok((await readFile(clientDefault)).equals(committedClient),
    'fresh client build must byte-match the committed lib/client.js')
  assert.ok((await readFile(hostDead)).equals(committedHost),
    'host build must not depend on tsconfig paths (machine without the hard-coded install)')
  assert.ok((await readFile(clientDead)).equals(committedClient),
    'client build must not depend on tsconfig paths')
})
