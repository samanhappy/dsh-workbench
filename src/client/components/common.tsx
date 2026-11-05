// dsh-workbench — small shared interactive pieces used by more than one page.
//
// Extracted from forge.tsx so the Issues page can reuse the toast stack and
// the inline note composer without forge↔issues import cycles (both pages are
// React-render-time consumers, but a one-directional dependency graph keeps
// the esbuild CJS module init order trivially safe).

import { React, h, useLayout } from '../react'

// ── toast (replaces blocking alert()) ───────────────────────────────────────

export interface Toast { id: number; kind: 'ok' | 'err'; text: string }

type ToastEntry = { id: object; content: React.ReactNode }
const ToastContext = React.createContext<{
  entries: ToastEntry[]
  publish(id: object, content: React.ReactNode): void
} | null>(null)

export function ToastProvider(props: { children?: React.ReactNode }) {
  const [entries, setEntries] = React.useState<ToastEntry[]>([])
  const publish = React.useCallback(function (id: object, content: React.ReactNode) {
    setEntries(function (prev) {
      const rest = prev.filter(entry => entry.id !== id)
      return content == null ? rest : rest.concat({ id, content })
    })
  }, [])
  const value = React.useMemo(() => ({ entries, publish }), [entries, publish])
  return h(ToastContext.Provider, { value }, props.children)
}

export function ToastOutlet() {
  const context = React.useContext(ToastContext)
  return h('div', { className: 'wb-toasts' }, context?.entries.map((entry, index) =>
    h(React.Fragment, { key: index }, entry.content)))
}

export function ToastLayer(props: { children?: React.ReactNode; active?: boolean }) {
  const context = React.useContext(ToastContext)
  const publish = context?.publish
  const id = React.useRef({}).current
  useLayout(function () {
    publish?.(id, props.active === false ? null : props.children)
  }, [publish, id, props.children, props.active])
  useLayout(function () {
    return function () { publish?.(id, null) }
  }, [publish, id])
  return null
}

export function ToastStack(props: { toasts: Toast[]; onDismiss(id: number): void; active?: boolean }) {
  return h(ToastLayer, { active: props.active },
    props.toasts.map(function (t) {
      return h('div', { key: t.id, className: 'wb-toast wb-toast-' + t.kind, role: 'status' },
        h('span', { className: 'wb-toast-dot' }),
        h('span', { className: 'wb-toast-text' }, t.text),
        h('button', { className: 'wb-toast-x', onClick: function () { props.onDismiss(t.id) }, 'aria-label': '关闭' }, '×'))
    }))
}

/** Toast queue helper: `const [toasts, pushToast, dismissToast] = useToasts()`. */
export function useToasts(): [Toast[], (kind: 'ok' | 'err', text: string) => void, (id: number) => void] {
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const seq = React.useRef(0)
  const pushToast = React.useCallback(function (kind: 'ok' | 'err', text: string) {
    const id = ++seq.current
    setToasts(function (prev) { return prev.concat({ id: id, kind: kind, text: text }) })
    setTimeout(function () {
      setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id }) })
    }, 4200)
  }, [])
  const dismissToast = React.useCallback(function (id: number) {
    setToasts(function (prev) { return prev.filter(function (t) { return t.id !== id }) })
  }, [])
  return [toasts, pushToast, dismissToast]
}

/** Inline note composer shared by the forge detail 评论 tab and the Issue
 *  detail 评论 tab. Module-scope component so its hooks don't live in a closure. */
export function NoteComposer(props: {
  target: string
  busy: boolean
  onSubmit(text: string): Promise<boolean>
  onCancel?(): void
  placeholder?: string
}) {
  const [text, setText] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const locked = props.busy || sending
  async function submit() {
    const value = text.trim()
    if (locked || !value) return
    setSending(true)
    try {
      if (await props.onSubmit(value)) setText('')
    } finally {
      setSending(false)
    }
  }
  return h('div', { className: 'wb-note-box' },
    h('textarea', {
      className: 'glab-input glab-textarea', value: text,
      placeholder: props.placeholder || ('评论 ' + props.target + '（支持 Markdown）'),
      'aria-label': '评论 ' + props.target,
      disabled: locked,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
      onKeyDown: function (e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void submit()
        }
      },
    }),
    h('div', { className: 'wb-note-actions' },
      h('button', {
        className: 'glab-btn glab-btn-primary', disabled: locked || !text.trim(),
        title: 'Cmd/Ctrl+Enter 发表',
        onClick: function () { void submit() },
      }, locked ? '发表中…' : '发表评论'),
      props.onCancel
        ? h('button', { className: 'glab-btn', disabled: locked, onClick: props.onCancel }, '取消')
        : null,
    ),
  )
}
