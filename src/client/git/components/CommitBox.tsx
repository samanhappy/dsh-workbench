import { h, React } from '../react'
import { chevronGlyph } from '../../icons'
import { usePopover } from '../menu'
import { SparkIcon } from '../icons'
import type { AiModelGroup, AiModelRoute, GitStatusPayload, Translate } from '../types'

/** Short label the chip shows: the model name, trimmed to fit the card. */
function shortModelName(route: AiModelRoute | null, t: Translate): string {
  if (!route) return t('aiNoModel')
  const name = route.label || route.model
  return name.length > 26 ? name.slice(0, 25) + '…' : name
}

export function CommitBox(props: {
  status: GitStatusPayload | null
  message: string
  busy: boolean
  hint: string
  hintTone: 'error' | 'muted'
  t: Translate
  onMessage: (value: string) => void
  onQuickCommit: (push?: boolean) => void
  onCommit: (push?: boolean) => void
  inputRef?: any
  canPush: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  ai: {
    error?: string
    loading: boolean
    busy: boolean
    groups: AiModelGroup[]
    failures: { id: string; name: string; message: string }[]
    active: AiModelRoute | null
    onGenerate: () => void
    onSelect: (provider: string, model: string) => void
  }
}): any {
  const { status, t, ai } = props
  const identity = status?.identity
  const staged = status?.counts?.staged ?? 0
  const unstaged = status?.counts?.unstaged ?? 0
  const conflicts = status?.counts?.conflicted ?? 0
  const blocked = conflicts > 0
  const hasChanges = staged + unstaged > 0
  // `git commit` refuses to guess an identity: without user.name/user.email every
  // commit attempt after staging fails, so say so before the files are touched.
  const missingIdentity = status != null && status.identity === null
  const canCommit = hasChanges && props.message.trim() !== '' && !blocked && !props.busy && !ai.busy && !missingIdentity
  const canGenerate = hasChanges && !ai.busy && !props.busy && !blocked && ai.active !== null
  const picker = usePopover()
  const collapsed = props.collapsed === true
  // The menu floats in the viewport instead of the card: the fold animation
  // wraps the card body in an overflow-hidden row, which would clip it.
  const [menuBox, setMenuBox] = React.useState<{ left: number; bottom: number; width: number } | null>(null)
  const openPicker = () => {
    const trigger = picker.triggerRef.current
    if (trigger && typeof window !== 'undefined') {
      const rect = trigger.getBoundingClientRect()
      const width = Math.min(380, window.innerWidth - 24)
      setMenuBox({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 8,
        width,
      })
    }
    picker.toggle()
  }

  const defaultHint = missingIdentity
    ? t('identityMissing')
    : blocked
      ? t('conflictsBlockCommit')
      : !hasChanges
        ? t('nothingToCommit')
        : props.message.trim() === ''
          ? t('commitMessageEmpty')
          : staged === 0 ? t('commitAllHint') : t('commitShortcut')

  const generateTitle = !hasChanges
    ? t('aiNoChanges')
    : blocked
      ? t('conflictsBlockCommit')
      : ai.active === null
        ? t('aiNoModelTip')
        : staged > 0 ? t('aiFromStaged') : t('aiFromAll')

  /** The one control that folds and unfolds the card: an icon-only caret pill
   *  in the meta row (the word would be redundant next to the two action
   *  buttons); title/aria-label still carry "Fold" / "Unfold" for hover and AT. */
  const toggle = () => h(
    'button',
    {
      type: 'button',
      className: 'glab-btn wb-git-commit-toggle',
      'aria-expanded': !collapsed,
      'aria-label': collapsed ? t('expandCommit') : t('collapseCommit'),
      title: collapsed ? t('expandCommit') : t('collapseCommit'),
      onClick: (event: any) => {
        event.stopPropagation()
        props.onToggleCollapsed()
      },
      onKeyDown: (event: any) => event.stopPropagation(),
    },
    h('span', { className: 'wb-git-commit-caret', 'aria-hidden': 'true' }, chevronGlyph(18)),
  )

  const meta = h(
    'div',
    {
      className: 'wb-git-commit-meta',
      // Clicking the strip unfolds; the caret button stays the keyboard target,
      // so no interactive control is nested inside another one.
      ...(collapsed ? { title: t('expandCommit'), onClick: () => props.onToggleCollapsed() } : {}),
    },
    h('strong', null, '提交本次更改'),
    h('span',
      { className: 'wb-git-commit-branch', 'data-tone': missingIdentity ? 'error' : undefined },
      missingIdentity && collapsed
        ? t('identityMissing')
        : staged > 0 ? '将提交 ' + staged + ' 个已暂存文件' : '将提交全部 ' + unstaged + ' 个变更文件'),
    !collapsed ? h('span', { className: 'wb-git-commit-author' }, identity?.name || t('author') + ': —') : null,
    h('div', { className: 'wb-git-quick-actions' },
      ...[false, true].map(push => h('button', {
        type: 'button',
        className: 'glab-btn glab-btn-primary wb-git-quick-commit',
        disabled: !canGenerate || missingIdentity || (push && !props.canPush),
        title: missingIdentity ? t('identityMissing') : push && !props.canPush ? t('pushNoRemote') : generateTitle + '；自动生成提交信息后' + (push ? '提交并推送' : '提交'),
        onClick: (event: any) => { event.stopPropagation(); props.onQuickCommit(push) },
      }, h(SparkIcon, null), props.busy ? '处理中…' : push ? '推送' : '提交')),
    ),
    toggle(),
  )

  // Folded the body keeps its DOM (so the height can animate) but leaves the
  // tab order and the accessibility tree, and cannot be clicked through.
  const body = h(
    'div',
    {
      className: 'wb-git-commit-body',
      'data-folded': collapsed ? 'true' : undefined,
      'aria-hidden': collapsed ? 'true' : undefined,
      inert: collapsed ? '' : undefined,
    },
    h(
      'div',
      { className: 'wb-git-commit-body-inner' },
      h(
        'div',
        { className: 'wb-git-commit-label' },
        h('span', null, t('commitMessageLabel')),
        h(
          'div',
          { className: 'wb-git-ai' },
          h(
            'button',
            {
              type: 'button',
              className: 'glab-btn glab-btn-primary wb-git-ai-generate',
              'data-busy': ai.busy ? 'true' : undefined,
              disabled: !canGenerate || collapsed,
              title: generateTitle,
              onClick: ai.onGenerate,
            },
            h(SparkIcon, null),
            ai.busy ? t('aiGenerating') : t('aiGenerate'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'glab-btn wb-git-ai-chip',
              title: t('aiModelTip'),
              'aria-haspopup': 'listbox',
              'aria-expanded': picker.open,
              ref: picker.triggerRef,
              onClick: openPicker,
            },
            h('span', { className: 'wb-git-ai-chip-name' }, shortModelName(ai.active, t)),
            h('span', { className: 'wb-git-ai-caret', 'aria-hidden': 'true' }, '▾'),
          ),
          picker.open
            ? h(
                'div',
                {
                  className: 'wb-git-ai-menu',
                  role: 'listbox',
                  'aria-label': t('aiModel'),
                  ref: picker.menuRef,
                  'data-floating': true,
                  style: menuBox
                    ? { left: menuBox.left, bottom: menuBox.bottom, width: menuBox.width }
                    : undefined,
                },
                h('div', { className: 'wb-git-ai-menu-head' }, t('aiModelTip')),
                ai.loading
                  ? h('div', { className: 'wb-git-ai-menu-empty' }, t('loading'))
                  : ai.groups.length === 0
                    ? h('div', { className: 'wb-git-ai-menu-empty' }, ai.error || t('aiNoModelTip'))
                    : ai.groups.map((group) =>
                        h(
                          'div',
                          { className: 'wb-git-ai-group', key: group.id },
                          h('div', { className: 'wb-git-ai-group-title' }, group.name),
                          group.models.map((model) =>
                            h(
                              'button',
                              {
                                key: group.id + '/' + model.id,
                                type: 'button',
                                className: 'wb-git-ai-option',
                                role: 'option',
                                'aria-selected': ai.active?.provider === group.id && ai.active?.model === model.id,
                                'data-current':
                                  ai.active?.provider === group.id && ai.active?.model === model.id
                                    ? true
                                    : undefined,
                                onClick: () => {
                                  picker.close()
                                  ai.onSelect(group.id, model.id)
                                },
                              },
                              h(
                                'span',
                                { className: 'wb-git-ai-option-check' },
                                ai.active?.provider === group.id && ai.active?.model === model.id ? '✓' : '',
                              ),
                              h('span', { className: 'wb-git-ai-option-name' }, model.name || model.id),
                              model.name && model.name !== model.id
                                ? h('span', { className: 'wb-git-ai-option-id' }, model.id)
                                : null,
                            ),
                          ),
                        ),
                      ),
                ai.failures.length > 0
                  ? h(
                      'div',
                      { className: 'wb-git-ai-menu-failure' },
                      t('aiPartialCatalog') + ' ' + ai.failures.map((failure) => failure.name).join('、'),
                    )
                  : null,
              )
            : null,
        ),
      ),
      h('textarea', {
        className: 'glab-input glab-textarea wb-git-commit-input',
        ref: props.inputRef,
        value: props.message,
        placeholder: t('commitPlaceholder'),
        spellCheck: false,
        onChange: (event: any) => props.onMessage(event.target.value),
        onKeyDown: (event: any) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            if (canCommit) props.onCommit()
          }
        },
      }),
      h(
        'div',
        { className: 'wb-git-commit-foot' },
        h(
          'span',
          { className: 'wb-git-hint', 'data-tone': props.hintTone === 'error' ? 'error' : undefined },
          props.hint || defaultHint,
        ),
        h(
          'button',
          { type: 'button', className: 'glab-btn', onClick: () => props.onMessage('') },
          t('clear'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'glab-btn glab-btn-primary',
            disabled: !canCommit,
            onClick: () => props.onCommit(false),
          },
          props.busy ? t('loading') : t('commit'),
        ),
        h('button', { type: 'button', className: 'glab-btn glab-btn-primary', disabled: !canCommit || !props.canPush, title: props.canPush ? defaultHint : t('pushNoRemote'), onClick: () => props.onCommit(true) }, t('commitAndPush')),
      ),
    ),
  )

  return h('div', { className: 'wb-git-commit', 'data-collapsed': collapsed ? true : undefined }, meta, body)
}
