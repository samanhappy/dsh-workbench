import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './load-client.mjs'

function setup(available = true) {
  const store = new Map()
  const client = loadClientModule({
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  })
  const commands = new Map()
  const disposed = []
  const panels = []
  const scope = {
    shortcuts: { register(command) {
      commands.set(command.id, command)
      return () => commands.delete(command.id)
    } },
    layout: { selectPanel: id => panels.push(id) },
    effect(fn) { disposed.push(fn()) },
  }
  client.apply({
    inject(deps, callback) {
      assert.deepEqual(deps, ['shortcuts', 'layout'])
      if (available) callback(scope)
    },
    get() {}, effect() {}, slots: { inject() {} },
  })
  return { client, store, commands, disposed, panels }
}

test('contributes editable DSH commands with unique defaults and disposes them', () => {
  const { commands, disposed } = setup()
  assert.equal(commands.size, 9)
  const codes = new Set()
  for (const [id, command] of commands) {
    assert.ok(id.startsWith('workbench.open.'))
    assert.ok(command.label().startsWith('工作台：'))
    assert.deepEqual(command.regions, ['page', 'editable', 'terminal'])
    assert.deepEqual(command.modals, [])
    assert.equal(Object.keys(command.defaults).length, 5)
    assert.equal(command.defaults['web:linux'], undefined)
    const binding = command.defaults['desktop:macos']
    assert.deepEqual(binding.modifiers, ['primary', 'alt'])
    codes.add(binding.code)
  }
  assert.equal(codes.size, 9)
  disposed.reverse().forEach(dispose => dispose())
  assert.equal(commands.size, 0)
})

test('opens every page through the existing cold/live navigation channel', () => {
  const { commands, panels, store } = setup()
  const previousWindow = globalThis.window
  const previousEvent = globalThis.CustomEvent
  const events = []
  globalThis.window = { dispatchEvent: event => events.push(event) }
  globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail } }
  try {
    for (const command of commands.values()) {
      const page = command.id.split('.').at(-1)
      const result = command.resolve()
      assert.equal(result.status, 'handled')
      assert.equal(panels.length, events.length)
      result.run()
      assert.equal(panels.at(-1), 'workbench')
      assert.equal(store.get('samanhappy.dsh-workbench.page'), page === 'git' ? 'forge' : page)
      assert.equal(events.at(-1).type, 'samanhappy.dsh-workbench:page')
      assert.equal(events.at(-1).detail, page)
      if (page === 'git') assert.equal(JSON.parse(store.get('samanhappy.dsh-workbench.forge-view')).subNav, 'git')
    }
  } finally {
    globalThis.window = previousWindow
    globalThis.CustomEvent = previousEvent
  }
})

test('reads feature toggles at invocation time, including the shared repository page', () => {
  const { client, commands, panels } = setup()
  const git = commands.get('workbench.open.git')
  assert.equal(git.resolve().status, 'handled')
  for (const feature of client.FEATURE_ORDER) client.setConfigToggle('feature.' + feature, false)
  for (const [id, command] of commands) {
    assert.equal(command.resolve().status, id.endsWith('.home') || id.endsWith('.config') ? 'handled' : 'blocked')
  }
  assert.deepEqual(panels, [])
  client.setConfigToggle('feature.git', true)
  assert.equal(git.resolve().status, 'handled')
  assert.equal(commands.get('workbench.open.forge').resolve().status, 'handled')
})

test('older DSH without the optional services still loads the workbench', () => {
  assert.equal(setup(false).commands.size, 0)
})
