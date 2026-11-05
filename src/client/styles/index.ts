import { CSS as gitCss } from '../git/styles'
// dsh-workbench — styles assembly.
//
// The panel's CSS lives in per-section .css files (base / topbar / picker /
// config / chrome / tabs / badges / list / actions / empty / detail / forms /
// turnbtn), imported here as plain text and concatenated in that order into
// the single injected stylesheet. build.mjs loads `.css` as text, so these
// imports are strings at runtime; the order below matches the original
// single GL_CSS string byte-for-byte (verified by test).
//
// Design language: ONE accent (GitLab orange) + four semantic hues, two
// radii (8px controls / 999px pills), one hairline. Everything else is
// neutral so the content carries the page. All layout blocks (top bar, repo
// bar, picker, list rows) share a 16px horizontal text grid. The panel is a
// deliberate centered column: it fills its slot up to 1200px, so on very
// wide windows the toolbars don't stretch into an unbalanced strip.
//
// Typography contract (mirrors the host sheets in dsh ui-theme):
//   - The panel rides the host font ramp: primary chrome at 14px (panel
//     base, bar titles, tabs, segmented switcher, buttons, inputs),
//     secondary rows at 13px, dense meta/code at 12px, and the 11px floor
//     (tags, badges, captions, code blocks) — the host never goes below 11.
//   - Mono text uses var(--ds-font-family-code) — the host stack has NO bare
//     `monospace` tail (Windows CJK would fall back to SimSun).
//   - List row titles ride --dsh-content-font-size-secondary and the detail
//     title rides --dsh-content-font-delta, so the panel tracks the Settings
//     font-size axis like native tool rows.
//   - Every font-size is paired with a px line-height from the host ramp
//     (11/16, 12/18-19, 13/20, 14/22; code 12/19, code-block 11/19).
//   - Small text weights cap at 500 (600 only for the 14px detail title,
//     the host markdown-h4 role); state text colors alias the host
//     --dsw-alias-state-* tokens so light/dark both stay legible.

import base from './base.css'
import topbar from './topbar.css'
import picker from './picker.css'
import config from './config.css'
import chrome from './chrome.css'
import tabs from './tabs.css'
import badges from './badges.css'
import list from './list.css'
import actions from './actions.css'
import empty from './empty.css'
import detail from './detail.css'
import diff from './diff.css'
import forms from './forms.css'
import turnbtn from './turnbtn.css'
import sls from './sls.css'
import issues from './issues.css'
import pingcode from './pingcode.css'
import skills from './skills.css'
import workbench from './workbench.css'
import notifications from './notifications.css'
import home from './home.css'

/** The full injected stylesheet (one <style data-plugin> tag per bundle). */
export const GL_CSS = gitCss + base + topbar + picker + config + chrome + tabs + badges + list + actions + empty + detail + diff + forms + turnbtn + sls + issues + pingcode + skills + workbench + notifications + home
