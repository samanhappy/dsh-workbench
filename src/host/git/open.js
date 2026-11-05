/**
 * Local "open" actions for the selected repository.
 *
 * The argv is fixed per target and the directory is the cwd the route already
 * resolved to a registered workspace, so no user input ever reaches argv. The
 * actions only exist on macOS; the client hides the buttons on other platforms
 * and the host refuses them too, so a hand-built request cannot bypass that.
 */

import { RequestError } from './errors.js'

/** The two local actions the toolbar exposes. */
export const OPEN_TARGETS = Object.freeze(['finder', 'terminal'])

/**
 * Fixed argv (without the `open` executable) for one action.
 * Finder: `open <cwd>`; Terminal: `open -a Terminal <cwd>`.
 */
export function openArgv(target, cwd, platform = process.platform) {
  if (!OPEN_TARGETS.includes(target)) {
    throw new RequestError('未知的打开目标', 400, 'unknown-target')
  }
  if (platform !== 'darwin') {
    throw new RequestError('当前平台不支持本地打开动作', 400, 'unsupported-platform')
  }
  return target === 'terminal' ? ['-a', 'Terminal', cwd] : [cwd]
}
