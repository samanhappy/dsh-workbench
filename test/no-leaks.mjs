// Public-repo guard: no internal company identifier, employee name/handle,
// credential or private infrastructure address may leak into a tracked file.
//
// Scans every path `git ls-files` reports (node_modules excluded, this test
// excluded — it has to spell the banned strings out), case-insensitively, and
// fails with file:line hits so the offending fixture is easy to find.
// `samanhappy` is the public GitHub account and is deliberately NOT banned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SELF = relative(ROOT, fileURLToPath(import.meta.url))

// Banned substrings (matched lowercased).
const BANNED = [
  'meibaokeji',           // internal GitLab host domain
  'mbkj',                 // internal MySQL host fragment
  'mbjj',                 // internal SLS project prefix
  'sunmeng',              // personal handle (samanhappy is the public account)
  '孙猛',                  // employee name
  '李思思',                // employee name
  'liutao',               // employee handle (OwnerNickNames fixture)
  'yangtao',              // employee handle
  '13590643742',          // real phone number
  '172.26.',              // private network range
  'rm-bp1e',              // real RDS instance prefix
  'extension_insurance',  // internal database name
  't_extend_policy',      // internal production table
  'product-center',       // internal database name
  'pd_uni_profession_mapping', // internal production table
  'gz_endorse_apply',     // internal production table
  'alglqzx7b',            // old OAuth refresh token prefix (lowercased)
  '/users/sunmeng',       // absolute home path
  'code.meibaokeji',      // internal GitLab URL
]

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

test('no internal identifiers leak into tracked files', () => {
  const hits = []
  for (const rel of files) {
    if (rel === SELF) continue
    if (rel.split('/').includes('node_modules')) continue
    let text
    try {
      text = readFileSync(join(ROOT, rel), 'utf8')
    } catch {
      continue // unreadable tracked entry (submodule/binary-permission edge)
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase()
      for (const pat of BANNED) {
        if (lower.includes(pat)) hits.push(rel + ':' + (i + 1) + ': ' + pat)
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    'banned internal identifiers found in tracked files:\n' + hits.join('\n'),
  )
})
