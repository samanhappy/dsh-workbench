import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('title bar messages register, update, hide and clean up independently', async () => {
  let entries = [], currentContext, effects = []
  const React = {
    createContext: () => ({ Provider: 'provider' }),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [entries, update => { entries = update(entries) }],
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useContext: () => currentContext,
    useRef: value => ({ current: value }),
    useLayoutEffect: effect => effects.push(effect),
  }
  const output = await build({ entryPoints: ['src/client/components/common.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(id => id === 'react' ? React : {}, module, module.exports)
  const { ToastProvider, ToastOutlet, ToastLayer } = module.exports
  currentContext = ToastProvider({}).props.value
  ToastLayer({ children: 'Git result' })
  effects[0]()
  const cleanup = effects[1]()
  assert.equal(entries.length, 1)
  const gitId = entries[0].id
  currentContext.publish(gitId, 'Updated result')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, 'Updated result')
  const issueId = {}
  currentContext.publish(issueId, 'Issue result')
  currentContext = { ...currentContext, entries }
  assert.equal(ToastOutlet().children[0].length, 2)
  cleanup()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].content, 'Issue result')
  effects = []
  ToastLayer({ children: 'Hidden Git result', active: false })
  effects[0]()
  assert.equal(entries.length, 1)
})
