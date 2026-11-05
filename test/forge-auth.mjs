import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAuthHosts } from '../index.js'

// glab offline：token 在本地、API 探测失败时会打印 "x <host>: API call failed"
// 与 "✓ Token found"，没有 "Logged in to"。这是「登录着但暂时连不上」，不能读成未登录。
const GLAB_OFFLINE = `gitlab.com
  x gitlab.com: API call failed: Get "https://gitlab.com/api/v4/user": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ✓ REST API Endpoint: https://gitlab.com/api/v4/
  ! No token found (checked config file, keyring, and environment variables).
gitlab.example.com
  x gitlab.example.com: API call failed: Get "https://gitlab.example.com/api/v4/user": proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused
  ✓ Git operations for gitlab.example.com configured to use ssh protocol.
  ✓ Token found: **************************
          
   ERROR  
  X could not authenticate to one or more of the configured GitLab instances.`

test('glab 在线输出按 Logged in 提取实例与账号', () => {
  const text = `gitlab.example.com
  ✓ Logged in to gitlab.example.com as alice (/Users/u/.config/glab-cli/config.yml)
  ✓ Token found: **************************
`
  assert.deepEqual(parseAuthHosts(text), [{ host: 'gitlab.example.com', user: 'alice' }])
})

test('glab 离线（有 token、API 探测失败）仍算已登录，无 token 的实例不算', () => {
  assert.deepEqual(parseAuthHosts(GLAB_OFFLINE), [{ host: 'gitlab.example.com', user: '' }])
})

test('glab 401 是 token 不可用，不算已登录', () => {
  const text = `gitlab.example.com
  x gitlab.example.com: API call failed: GET https://gitlab.example.com/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Token found: **************************
`
  assert.deepEqual(parseAuthHosts(text), [])
})

test('gh 在线输出按 account 提取账号', () => {
  const text = `github.com
  ✓ Logged in to github.com account samanhappy (keyring)
  - Active account: true
`
  assert.deepEqual(parseAuthHosts(text), [{ host: 'github.com', user: 'samanhappy' }])
})

test('gh 离线（token 校验失败但账号已配置）仍算已登录', () => {
  const text = `github.com
  X Failed to log in to github.com account samanhappy (keyring)
  - Active account: true
  - The token in keyring is invalid.
`
  assert.deepEqual(parseAuthHosts(text), [{ host: 'github.com', user: 'samanhappy' }])
})

test('同一实例重复出现时只保留首次结果', () => {
  const text = `gitlab.example.com
  ✓ Logged in to gitlab.example.com as alice (config.yml)
  ✓ Token found: ****
`
  assert.deepEqual(parseAuthHosts(text + '\n' + text), [{ host: 'gitlab.example.com', user: 'alice' }])
})
