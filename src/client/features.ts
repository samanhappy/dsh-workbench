// dsh-workbench — 功能开关读取层（仓库 / DMS / SLS / PingCode）。
//
// 开关本身登记在配置注册表（prompts.ts 的 CONFIG_ITEMS，kind 'toggle'），
// 覆盖值按人存在本机 localStorage。这里只做两件事：
//   - 把注册表开关折成布尔快照（featureFlags）供 UI 与外壳轮询读取；快照按
//     「生效值指纹」缓存——值没变就复用同一对象（useSyncExternalStore 要求
//     引用稳定），值变了就换新对象。指纹取自实际取值而非写入计数，所以本插件
//     之外改了覆盖值（另一个标签页）也会立即反映。
//   - 订阅配置写入（subscribeConfig）：设置页里一改开关，页签 / 侧栏常显入口 /
//     徽标 / 助手按钮立即跟着变，无需重启或刷新。
//
// 「关闭」的语义 = 隐藏入口 + 不挂载功能页 + 不再发起该域的请求；host 路由
// 仍然注册（同源围栏不变），所以这不是权限边界，而是使用者的功能裁剪。

import { React } from './react'
import { FEATURE_CONFIG_KEYS, shortcutConfigKey, loadConfig, resolveConfigToggle, subscribeConfig } from './prompts'
import type { FeatureKey } from './prompts'

export type { FeatureKey }

/** 生效的开关快照：每个功能域一个布尔。 */
export type FeatureFlags = Record<FeatureKey, boolean>

/** 功能页 / 侧栏常显入口的固定顺序（也是「全部关闭时」的落点顺序）。 */
export const FEATURE_ORDER: FeatureKey[] = ['forge', 'git', 'dms', 'sls', 'pingcode', 'skills', 'notifications']

let shortcutCache: { fingerprint: string; flags: FeatureFlags } | null = null
let cache: { fingerprint: string; flags: FeatureFlags } | null = null

/** 当前生效开关（快照按取值指纹缓存；无 localStorage 时全部取默认）。 */
export function featureFlags(): FeatureFlags {
  const overrides = loadConfig()
  const flags = {} as FeatureFlags
  let fingerprint = ''
  for (const key of FEATURE_ORDER) {
    const on = resolveConfigToggle(FEATURE_CONFIG_KEYS[key], overrides)
    flags[key] = on
    fingerprint += on ? '1' : '0'
  }
  if (cache === null || cache.fingerprint !== fingerprint) cache = { fingerprint: fingerprint, flags: flags }
  return cache.flags
}

/** 快捷入口只影响侧栏显示，仍受功能总开关约束。 */
export function shortcutFlags(): FeatureFlags {
  const overrides = loadConfig()
  const enabled = featureFlags()
  const flags = {} as FeatureFlags
  for (const key of FEATURE_ORDER) {
    flags[key] = key !== 'git' && enabled[key] && resolveConfigToggle(shortcutConfigKey(FEATURE_CONFIG_KEYS[key]), overrides)
  }
  const fingerprint = FEATURE_ORDER.map(key => flags[key] ? '1' : '0').join('')
  if (!shortcutCache || shortcutCache.fingerprint !== fingerprint) shortcutCache = { fingerprint, flags }
  return shortcutCache.flags
}

export function isFeatureEnabled(key: FeatureKey): boolean {
  return featureFlags()[key]
}

/** 订阅开关变化并重渲染（无 useSyncExternalStore 的环境退化为 useState +
 *  useEffect，模拟器 / 老 React 同样成立）。 */
export function useFeatureFlags(readFlags: () => FeatureFlags = featureFlags): FeatureFlags {
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(subscribeConfig, readFlags, readFlags)
  }
  const [flags, setFlags] = React.useState<FeatureFlags>(readFlags)
  React.useEffect(function () {
    return subscribeConfig(function () { setFlags(readFlags()) })
  }, [readFlags])
  return flags
}
