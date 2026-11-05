// dsh-workbench — module-table access.
//
// Inside the built bundle's factory, `require` is the loader's module table:
// 'react' and '@deepseek-ai/dsh-client-ui-primitives' are the only runtime
// specifiers this bundle resolves (the rest of the official client modules are
// type-only). The wrapper passes `require` as a factory parameter, so the
// runtime here is the same shape the shipped tsdown bundles use.
import type * as ReactTypes from 'react'

/** The loader module-table `require`, in scope inside the bundle factory. */
declare const require: (specifier: string) => any

export const React = require('react') as typeof ReactTypes

export const h = React.createElement
export const useLayout =
  typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

/** Tooltip is the SAME primitive the shipped message-feedback buttons use, so
 *  the hint style and placement match the siblings exactly. Older profiles
 *  without it fall back to the native title hint. */
export const TooltipPrimitive: ReactTypes.ComponentType<any> | null = (() => {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives').Tooltip || null
  } catch (e) {
    return null
  }
})()

/** MarkdownText is the SAME untrusted-markdown renderer the app's document
 *  preview uses (GFM + TeX math, URL-sanitized, styles ship inside the web
 *  bundle). Older profiles without it fall back to the plain pre-wrap text. */
export const MarkdownTextPrimitive: ReactTypes.ComponentType<any> | null = (() => {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText || null
  } catch (e) {
    return null
  }
})()

/** CodeBlock is the SAME shiki-backed source surface the app's document preview
 *  uses (its grammar loads lazily, unknown languages fall back to plain text).
 *  Older profiles without it fall back to a plain <pre>. */
export const CodeBlockPrimitive: ReactTypes.ComponentType<any> | null = (() => {
  try {
    return require('@deepseek-ai/dsh-client-ui-primitives').CodeBlock || null
  } catch (e) {
    return null
  }
})()

/** Public DSH diff surface; no local code-rendering fallback. */
export const DiffBlockPrimitive: ReactTypes.ComponentType<any> | null = (() => {
  try { return require('@deepseek-ai/dsh-client-ui-primitives').DiffBlock || null }
  catch { return null }
})()
