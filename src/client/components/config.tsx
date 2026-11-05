import { AutoReviewPanel } from './auto-review'
// 配置覆盖值沿用本机 localStorage；分类与展开状态仅用于本次展示。

import { React, h } from '../react'
import { chevronGlyph } from '../icons'
import {
  configItemsFor, loadConfig, saveConfig, resetConfig, resetConfigKeys, spliceToken,
  FEATURE_CONFIG_KEYS, shortcutConfigKey, resolveConfigToggle, defaultToggleOf, setConfigToggle, formatModelRef,
} from '../prompts'
import { loadModelChoices } from '../models'
import type { ModelChoice, ModelRef } from '../models'
import type { ConfigItem, ConfigScope } from '../prompts'

const SCOPE_TITLE: Record<ConfigScope, string> = {
  global: '功能开关',
  home: '首页设置',
  forge: '评审与提交默认设置',
}

const ALL_TITLE = '工作台设置'

const SECTIONS = [
  { id: 'features', title: '功能与导航', help: '关闭功能后停止加载对应数据，快捷入口可单独隐藏（DMS 有待审批时仍会显示）。' },
  { id: 'home', title: '首页', help: '设置首页显示内容' },
  { id: 'review', title: '代码评审', help: '设置评审的默认行为与模型' },
  { id: 'git', title: 'Git 提交', help: '设置提交信息的语言与提示词' },
  { id: 'prompts', title: 'AI 提示词', help: '按需展开并编辑提示词' },
] as const

function sectionOf(item: ConfigItem): string {
  if (item.scope === 'global') return 'features'
  if (item.scope === 'home') return 'home'
  if (item.key.startsWith('git.') || item.key === 'prompt.git.commit') return 'git'
  return item.kind === 'prompt' ? 'prompts' : 'review'
}

/** 模型目录的加载状态（kind 'model' 的下拉数据源；按面板挂载加载一次）。 */
interface ModelCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  choices: ModelChoice[]
  defaultRef: ModelRef | null
  error: string | null
}

export function ConfigPanel(props: { scope?: ConfigScope | 'all' }) {
  const scope: ConfigScope | 'all' = props.scope || 'all'
  const items = configItemsFor(scope)
  const [drafts, setDrafts] = React.useState<Record<string, string>>(function () { return loadConfig() })
  const [openKeys, setOpenKeys] = React.useState<Set<string>>(() => new Set())
  const [activeSection, setActiveSection] = React.useState(scope === 'home' ? 'home' : scope === 'forge' ? 'review' : 'features')
  const [saveNote, setSaveNote] = React.useState<{ ok: boolean; text: string } | null>(null) // 最近一次持久化反馈
  const [catalog, setCatalog] = React.useState<ModelCatalogState>(function () {
    return { status: 'idle', choices: [], defaultRef: null, error: null }
  })
  const taRefs = React.useRef<Record<string, HTMLTextAreaElement | null>>({})
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(function () {
    return function () { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [])

  // 模型下拉的数据源：Host 当前可路由的模型目录（可选增强，取不到就在下拉
  // 处显示不可用说明，已存的值仍可清除）。只在面板含模型项时才请求。
  const hasModelItem = items.some(function (i) { return i.kind === 'model' })
  React.useEffect(function () {
    if (!hasModelItem) return function () {}
    let alive = true
    setCatalog(function (prev) { return Object.assign({}, prev, { status: 'loading', error: null }) })
    loadModelChoices().then(function (res) {
      if (!alive) return
      if (res.ok) setCatalog({ status: 'ready', choices: res.choices, defaultRef: res.defaultRef, error: null })
      else setCatalog({ status: 'error', choices: [], defaultRef: null, error: res.error })
    })
    return function () { alive = false }
  }, [hasModelItem])

  /** 失焦 / 插入 / 重置 / 开关后的持久化反馈；localStorage 写失败（隐私模式等）
   * 也会以「保存失败」显式示警，不再静默丢弃。 */
  function flashSaved(ok: boolean) {
    setSaveNote({ ok: ok, text: ok ? '已保存' : '保存失败（本机存储不可用）' })
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(function () { setSaveNote(null) }, 1800)
  }

  function commit(key: string) {
    flashSaved(saveConfig({ [key]: String(drafts[key] || '').trim() }))
  }

  function resetOne(key: string) {
    setDrafts(function (prev) {
      const next = Object.assign({}, prev)
      delete next[key]
      return next
    })
    flashSaved(resetConfig(key))
  }

  function resetAll() {
    setDrafts({})
    // 分域恢复：只清当前面板 scope 的 key，其他域（全局等）的定制不动。
    flashSaved(resetConfigKeys(items.flatMap(function (i) { return isFeatureItem(i) ? [i.key, shortcutConfigKey(i.key)] : [i.key] })))
  }

  /** 开关：翻转后立即持久化（value 等于注册表默认时清覆盖，回到「未定制」），
   *  drafts 同步更新以驱动「已定制」标记；页签等外围 UI 由 features.ts 的
   *  配置广播重渲染，这里无需通知。 */
  function toggleSwitch(item: ConfigItem) {
    const next = !resolveConfigToggle(item.key)
    const ok = setConfigToggle(item.key, next)
    setDrafts(function (prev) {
      const draft = Object.assign({}, prev)
      if (next === defaultToggleOf(item.key)) delete draft[item.key]
      else draft[item.key] = next ? 'on' : 'off'
      return draft
    })
    flashSaved(ok)
  }

  /** 模型下拉：选定即持久化；选「沿用默认」= 清除定制（与开关同一语义）。 */
  function chooseModel(item: ConfigItem, value: string) {
    if (!value) {
      setDrafts(function (prev) {
        const next = Object.assign({}, prev)
        delete next[item.key]
        return next
      })
      flashSaved(resetConfig(item.key))
      return
    }
    setDrafts(function (prev) { return Object.assign({}, prev, { [item.key]: value }) })
    flashSaved(saveConfig({ [item.key]: value }))
  }

  function toggleItem(key: string) {
    setOpenKeys(function (prev) {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 占位符 chip：在 textarea 光标处原位插入（替换选区），不破坏句子。
   * chip 的 mousedown 已 preventDefault（不抢焦点），textarea 不会 blur，
   * blur 里的 commit 不会触发 —— 所以这里必须显式保存。 */
  function insertAtCaret(key: string, token: string) {
    const ta = taRefs.current[key] || null
    const cur = String(drafts[key] || '')
    const live = ta && typeof document !== 'undefined' && document.activeElement === ta &&
      typeof ta.selectionStart === 'number'
    const r = live
      ? spliceToken(cur, ta.selectionStart, ta.selectionEnd, token)
      : spliceToken(cur, cur.length, cur.length, token) // 未聚焦过：追加到末尾
    setDrafts(function (prev) { return Object.assign({}, prev, { [key]: r.text }) })
    flashSaved(saveConfig({ [key]: r.text.trim() }))
    if (ta && typeof requestAnimationFrame === 'function') {
      // 受控更新会把光标挪到末尾，下一帧恢复焦点并把光标放到插入内容之后
      requestAnimationFrame(function () {
        try {
          ta.focus()
          ta.setSelectionRange(r.caret, r.caret)
        } catch (e) {}
      })
    }
  }

  function isFeatureItem(item: ConfigItem) {
    return Object.values(FEATURE_CONFIG_KEYS).some(key => key === item.key)
  }

  /** 该功能域是否还有「菜单栏快捷入口」可开关。通知列表页不设页签 / 侧栏
   *  图标（入口收敛到首页），没有快捷入口可显示，开关一并隐藏。 */
  function hasShortcutEntry(item: ConfigItem) {
    return isFeatureItem(item) && item.key !== FEATURE_CONFIG_KEYS.notifications && item.key !== FEATURE_CONFIG_KEYS.git
  }

  function isCustomized(item: ConfigItem) {
    const value = String(drafts[item.key] || '').trim()
    if (item.kind === 'toggle') return resolveConfigToggle(item.key, drafts) !== defaultToggleOf(item.key) ||
      (hasShortcutEntry(item) && resolveConfigToggle(shortcutConfigKey(item.key), drafts) !== defaultToggleOf(shortcutConfigKey(item.key)))
    return Boolean(value) && value !== (item.preview ?? item.default)
  }

  function renderToggleCard(item: ConfigItem) {
    const on = resolveConfigToggle(item.key)
    const shortcutKey = shortcutConfigKey(item.key)
    const feature = item.scope === 'global'
    return h('div', { key: item.key, className: 'wb-config-item wb-config-setting' + (feature ? ' wb-config-feature' : ' wb-config-setting-toggle') },
      h('div', { className: 'wb-config-label', title: item.help },
        h('span', { className: 'wb-config-title' }, item.label),
        !feature && item.help ? h('div', { className: 'wb-config-help' }, item.help) : null),
      feature ? h('div', { className: 'wb-config-shortcut' }, hasShortcutEntry(item) ? h('input', {
        type: 'checkbox', disabled: !on, checked: resolveConfigToggle(shortcutKey),
        'aria-label': item.label + '菜单栏快捷入口',
        onChange: function () { toggleSwitch({ ...item, key: shortcutKey }) },
      }) : h('span', { className: 'wb-config-help', title: '此功能无独立菜单栏快捷入口' }, '—')) : null,
      h('div', { className: 'wb-config-controls' },
        isCustomized(item) ? h('button', {
          type: 'button', className: 'glab-btn',
          onClick: function () {
            flashSaved(resetConfigKeys(isFeatureItem(item) ? [item.key, shortcutKey] : [item.key]))
            setDrafts(loadConfig())
          },
          title: '清除此项定制，恢复默认',
        }, '恢复默认') : null,
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': item.label,
          className: 'wb-switch' + (on ? ' wb-switch-on' : ''),
          onClick: function () { toggleSwitch(item) },
        }, h('span', { className: 'wb-switch-knob' }))),
    )
  }

  /** 模型类配置：行内显示 Host 目录下拉，选定即生效。目录不可
   *  用时只保留「已存的选择 + 恢复默认」，不隐藏用户已有的定制。 */
  function renderModelCard(item: ConfigItem) {
    const value = String(drafts[item.key] || '')
    const customized = isCustomized(item)
    const ready = catalog.status === 'ready'
    const known = catalog.choices.some(function (c) { return formatModelRef(c.provider, c.model) === value })
    // provider 分组保序：目录顺序即下拉顺序（optgroup 呈现）。
    const groups: Array<{ name: string; choices: ModelChoice[] }> = []
    for (const c of catalog.choices) {
      const g = groups.find(function (x) { return x.name === c.providerName })
      if (g) g.choices.push(c)
      else groups.push({ name: c.providerName, choices: [c] })
    }
    const defaultLabel = catalog.defaultRef
      ? '沿用 DSH 默认模型（当前：' + formatModelRef(catalog.defaultRef.provider, catalog.defaultRef.model) + '）'
      : '沿用 DSH 默认模型'
    return h('div', { key: item.key, className: 'wb-config-item wb-config-setting' },
      h('div', { className: 'wb-config-label' },
        h('span', { className: 'wb-config-title' }, item.label)),
      h('div', { className: 'wb-config-controls' },
        customized ? h('button', {
          type: 'button', className: 'glab-btn', onClick: function () { resetOne(item.key) },
        }, '恢复默认') : null,
      h('select', {
        className: 'glab-input wb-config-select',
        'aria-label': item.label,
        value: value,
        // 目录未就绪且尚未定制时无从选择；已定制时必须可选，否则用户清不掉。
        disabled: !ready && !customized,
        onChange: function (e: { target: { value: string } }) { chooseModel(item, e.target.value) },
      },
        h('option', { value: '' }, defaultLabel),
        // 已定制但该模型已不在目录里（换了 provider / 撤了凭据）→ 仍然显示，
        // 否则 select 会静默落到第一项，看起来像「配置丢了」。
        customized && !known ? h('option', { value: value }, value + '（当前不可用）') : null,
        groups.map(function (g) {
          return h('optgroup', { key: g.name, label: g.name },
            g.choices.map(function (c) {
              const ref = formatModelRef(c.provider, c.model)
              return h('option', { key: ref, value: ref }, c.label)
            })
          )
        })
      ),
      catalog.status === 'loading' ? h('div', { className: 'wb-config-help' }, '正在读取模型目录…') : null,
      catalog.status === 'error'
        ? h('div', { className: 'wb-config-help' }, '无法读取模型目录（' + (catalog.error || '未知错误') + '）；已存的选择仍会生效，也可点「恢复默认」清除。')
        : null,
      ),
    )
  }

  /** 文本类配置：收起显示定制状态，展开编辑详情。 */
  function renderTextCard(item: ConfigItem) {
    const value = String(drafts[item.key] || '')
    const customized = isCustomized(item)
    const preview = item.preview != null
      ? item.preview
      : (typeof item.default === 'string' ? item.default : '')
    const open = openKeys.has(item.key)
    return h('div', { key: item.key, className: 'wb-config-item wb-config-row' },
      h('div', { className: 'wb-config-head' },
        h('button', {
          type: 'button', className: 'wb-config-toggle',
          onClick: function () { toggleItem(item.key) },
          'aria-expanded': open,
          title: open ? '收起' : '展开编辑',
        },
          h('span', { className: 'wb-config-chev' + (open ? ' wb-config-chev-open' : '') }, chevronGlyph(14)),
          h('span', { className: 'wb-config-title' }, item.label),
          h('span', { className: 'wb-bar-spacer' }),
          customized ? h('span', { className: 'wb-meta wb-config-row-state' }, '已定制') : null,
        ),
        customized ? h('button', {
          type: 'button', className: 'glab-btn',
          onClick: function () { resetOne(item.key) },
          title: '清除此条自定义，恢复默认模板',
        }, '恢复默认') : null,
      ),
      open ? h('div', { className: 'wb-config-body' },
        item.help ? h('div', { className: 'wb-config-help' }, item.help) : null,
        h('textarea', {
          className: 'glab-input glab-textarea',
          style: { minHeight: 96, fontFamily: 'var(--ds-font-family-code,ui-monospace,monospace)' },
          placeholder: '留空使用默认模板',
          'aria-label': item.label,
          ref: function (el: HTMLTextAreaElement | null) { taRefs.current[item.key] = el },
          value: value,
          onChange: function (e: React.ChangeEvent<HTMLTextAreaElement>) {
            const text = e.target.value
            setDrafts(function (prev) { return Object.assign({}, prev, { [item.key]: text }) })
          },
          onBlur: function () { commit(item.key) },
          onKeyDown: function (e: { key: string; metaKey: boolean; ctrlKey: boolean; target: { blur(): void } }) {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.target.blur()
          },
        }),
        h('div', null, h('button', { type: 'button', className: 'glab-btn', onClick: function () { commit(item.key) } }, '保存')),
        item.placeholders && item.placeholders.length
          ? h('div', { className: 'wb-config-tokens' },
              item.placeholders.map(function (p) {
                return h('button', {
                  key: p.name, type: 'button', className: 'wb-config-token',
                  onMouseDown: function (e: { preventDefault(): void }) { e.preventDefault() }, // 不抢 textarea 焦点，保住光标
                  onClick: function () { insertAtCaret(item.key, '{' + p.name + '}') },
                  title: '在光标处插入 {' + p.name + '}：' + (p.help || ''),
                }, '{' + p.name + '}')
              })
            )
          : null,
        preview && !customized
          ? h('div', { className: 'wb-config-help' }, '默认模板')
          : null,
        preview && !customized ? h('pre', { className: 'wb-config-pre' }, preview) : null,
      ) : null,
    )
  }

  function renderCard(item: ConfigItem) {
    if (item.kind === 'toggle') return renderToggleCard(item)
    if (item.kind === 'model') return renderModelCard(item)
    if (item.kind === 'select') return h('div', { key: item.key, className: 'wb-config-item wb-config-setting' },
      h('div', { className: 'wb-config-label' },
        h('label', { className: 'wb-config-title', htmlFor: item.key }, item.label),
        item.help ? h('div', { className: 'wb-config-help' }, item.help) : null),
      h('div', { className: 'wb-config-controls' },
      isCustomized(item) ? h('button', { type: 'button', className: 'glab-btn', onClick: () => resetOne(item.key) }, '恢复默认') : null,
      h('select', {
        id: item.key, className: 'glab-input wb-config-select',
        value: drafts[item.key] || item.default,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          const value = event.target.value
          setDrafts(prev => ({ ...prev, [item.key]: value }))
          flashSaved(saveConfig({ [item.key]: value }))
        },
      }, item.options?.map(option => h('option', { key: option.value, value: option.value }, option.label))),
      ),
    )
    return renderTextCard(item)
  }

  const sections = SECTIONS.filter(section => items.some(item => sectionOf(item) === section.id) ||
    (section.id === 'review' && scope === 'forge'))

  const currentSection = sections.find(section => section.id === activeSection) || sections[0]

  return h('div', { className: 'wb-config' },
    h('aside', { className: 'wb-config-sidebar' },
      h('h1', { className: 'wb-title' }, scope === 'all' ? ALL_TITLE : SCOPE_TITLE[scope]),
      h('nav', { className: 'wb-config-nav', 'aria-label': '设置分类' }, sections.map(section =>
        h('button', {
          key: section.id, type: 'button', className: 'wb-config-nav-item',
          'aria-current': activeSection === section.id ? 'location' : undefined,
          onClick: () => setActiveSection(section.id),
        }, section.title))),
    ),
    h('div', { className: 'wb-config-content' },
      h('div', { className: 'wb-config-content-head' },
        h('h2', { className: 'wb-config-group-title' }, currentSection?.title),
        h('div', { className: 'wb-config-actions' },
        saveNote ? h('span', {
          className: 'wb-meta', role: saveNote.ok ? 'status' : 'alert',
          style: { color: saveNote.ok ? 'var(--wb-ok)' : 'var(--wb-danger)' },
        }, saveNote.text) : null,
        items.some(isCustomized) ? h('button', {
          type: 'button', className: 'glab-btn', onClick: resetAll, title: '清除本面板全部自定义',
        }, '全部恢复默认') : null)),
      h('p', { className: 'wb-config-help' }, currentSection?.help),
      sections.map(section => h('section', {
        key: section.id, className: 'wb-config-section', hidden: section.id !== currentSection?.id,
        'aria-label': section.title,
      },
        section.id === 'features' ? h('div', { className: 'wb-config-feature wb-config-columns', 'aria-hidden': true },
          h('span', null, '功能模块'), h('span', null, '菜单栏快捷入口'), h('span', null, '启用')) : null,
        h('div', { className: 'wb-config-group' },
          section.id === 'review' ? h(AutoReviewPanel, {}) : null,
          items.filter(item => sectionOf(item) === section.id).map(renderCard)),
      )),
      !items.length ? h('div', { className: 'wb-config-help' }, '暂无配置项') : null,
    ),
  )
}
