import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('评论：失败保留草稿，成功清空，快捷键不打断中文输入或重复发送', async () => {
  const slots = []; let cursor = 0
  const React = {
    createContext: () => ({}), createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = init; return [slots[i], value => { slots[i] = value }] },
  }
  const output = await build({ entryPoints: ['src/client/components/common.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output.outputFiles[0].text)(id => id === 'react' ? React : {}, module, module.exports)
  const requests = []
  const props = { target: '#42', busy: false, onSubmit(text) { return new Promise(resolve => requests.push({ text, resolve })) } }
  const render = () => { cursor = 0; const tree = module.exports.NoteComposer(props); return { input: tree.children[0], button: tree.children[1].children[0] } }
  let view = render()
  view.input.props.onChange({ target: { value: '  评论草稿  ' } }); view = render()
  const event = composing => ({ key: 'Enter', ctrlKey: true, nativeEvent: { isComposing: composing }, preventDefault() {} })
  view.input.props.onKeyDown(event(true)); assert.equal(requests.length, 0)
  view.input.props.onKeyDown(event(false)); view = render()
  assert.equal(requests[0].text, '评论草稿'); assert.equal(view.input.props.disabled, true)
  assert.equal(view.button.props.disabled, true)
  view.input.props.onKeyDown(event(false)); assert.equal(requests.length, 1)
  requests[0].resolve(false); await new Promise(resolve => setImmediate(resolve)); view = render()
  assert.equal(view.input.props.value, '  评论草稿  '); assert.equal(view.button.props.disabled, false)
  view.button.props.onClick(); requests[1].resolve(true)
  await new Promise(resolve => setImmediate(resolve)); view = render()
  assert.equal(view.input.props.value, ''); assert.equal(view.button.props.disabled, true)
})
