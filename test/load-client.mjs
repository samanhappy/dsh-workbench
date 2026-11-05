// Shared loader for the BUILT client bundle (lib/client.js), used by the
// node --test suites that assert the pure helpers (prompts / session).
//
// Runs the bundle's module-loader factory exactly like the host client-modules
// service and sim-panel.mjs do: capture the factory from
// window.__ModuleLoader__.load, then invoke it with a stub module table
// (react + ui-primitives are the only runtime specifiers the bundle resolves;
// every other @deepseek-ai module is type-only and never required). The
// helpers are pure, so the exports are cached after the first load.
import { readFileSync } from 'node:fs'

function stubRequire(spec) {
  if (spec === 'react') {
    return {
      createContext: () => ({}), createElement: () => null,
      useLayoutEffect: undefined,
      useEffect: undefined,
      useState: undefined,
    }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { Tooltip: null }
  throw new Error('unexpected require: ' + spec)
}

let cached = null

/**
 * @param {object | undefined} localStorageStub - when given, installed as
 *   globalThis.localStorage before the module runs (the bundle reads it at
 *   call time, mirroring the old per-file vm sandbox); when absent, the
 *   global is cleared so the "no localStorage" path is exercised.
 * @returns the bundle factory's module exports.
 */
export function loadClientModule(localStorageStub) {
  if (localStorageStub) globalThis.localStorage = localStorageStub
  else delete globalThis.localStorage
  if (cached) return cached
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let factory = null
  const windowStub = { __ModuleLoader__: { load: (def) => { factory = def.factory } } }
  // eslint-disable-next-line no-new-func
  Function('require', 'window', 'setInterval', 'clearInterval', src)(
    stubRequire, windowStub, () => ({}), () => {},
  )
  if (!factory) throw new Error('factory not captured from lib/client.js')
  cached = factory(stubRequire)
  return cached
}
