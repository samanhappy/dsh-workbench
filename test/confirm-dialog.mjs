import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

test('确认弹窗：Tab 循环、Esc 取消、关闭恢复焦点', async () => {
  const previous = globalThis.document
  let restored = 0; let cancelled = 0; let cleanup
  const opener = { isConnected: true, focus() { restored++ } }
  globalThis.document = { activeElement: opener }
  try {
    const React = {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useRef: value => ({ current: value }),
      useEffect: fn => { cleanup = fn() },
    }
    const result = await build({ entryPoints: ['src/client/components/confirmdialog.tsx'], bundle: true, external: ['react', '@deepseek-ai/dsh-client-ui-primitives'], write: false, platform: 'node', format: 'cjs' })
    const module = { exports: {} }
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(id => id === 'react' ? React : {}, module, module.exports)
    const tree = module.exports.ConfirmDialog({ title: '关闭 Issue', okLabel: '关闭', onOk() {}, onCancel() { cancelled++ } })
    const card = tree.children[0]
    const first = { focus() { document.activeElement = first } }
    const last = { focus() { document.activeElement = last } }
    let prevented = 0; let stopped = 0
    const event = (key, shiftKey = false) => ({ key, shiftKey, currentTarget: { querySelectorAll: selector => { assert.match(selector, /input:not\(:disabled\)/); return [first, last] } }, preventDefault() { prevented++ }, stopPropagation() { stopped++ } })
    document.activeElement = last; card.props.onKeyDown(event('Tab'))
    assert.equal(document.activeElement, first)
    card.props.onKeyDown(event('Tab', true)); assert.equal(document.activeElement, last)
    assert.equal(prevented, 2)
    document.activeElement = first; card.props.onKeyDown(event('Tab')); assert.equal(prevented, 2)
    card.props.onKeyDown(event('Escape')); assert.equal(cancelled, 1); assert.equal(stopped, 1)
    cleanup(); assert.equal(restored, 1)
    opener.isConnected = false; cleanup(); assert.equal(restored, 1)
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
