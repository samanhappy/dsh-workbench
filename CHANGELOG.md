# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- _(nothing yet)_

### Changed

- _(nothing yet)_

### Fixed

- _(nothing yet)_

## [0.9.0] - 2026-11-06

First public release. `@samanhappy/dsh-workbench` is a DeepSeek Harness (DSH)
web plugin: a single "workbench" sidebar entry whose panel covers the daily
MR/PR, approval, log, work-item and skills workflows, driven entirely by the
CLIs already installed and logged in on your machine.

### Added

- **Workbench shell** — sidebar entry and panel with Home, Repo, DMS, SLS,
  PingCode, Skills, Notifications and Settings pages, per-browser feature
  toggles, and DSH unified keyboard shortcuts for the feature pages.
- **Home dashboard** — cross-workspace "needs my attention" sessions
  (in progress / pending / recently active) plus cards for in-flight sessions,
  MRs awaiting review, pending DMS approvals, unread GitHub notifications, and
  recent unread notifications.
- **Repo page** — GitLab MR and GitHub PR lists (mine / awaiting my review /
  all), full diff, review (reusing one session per commit), approve, merge,
  comment, close; Issues as a secondary navigation inside the same page
  (browse, search, filter, edit, close/reopen, and "handle" an open issue in a
  DSH session); a "submit MR/PR" button on each finished assistant message.
- **Background auto-review** — per-repository opt-in with scope, cooldown,
  publish-comment policy, review-model choice, deduplication by source commit,
  and a baseline that avoids re-reviewing existing items.
- **Local Git page** — status, staged/unstaged diffs, commit (optionally with a
  model-generated message), push to the configured remotes (never forced),
  fast-forward-only pull, and conflict handling in the working tree.
- **DMS approvals** — pending / all / mine views, ticket details including SQL,
  and approve/reject from the pending view.
- **SLS logs** — environment-mapped project/logstore queries, quick time
  ranges, structured detail with SQL and JSON tabs, trace drill-down and a
  waterfall view.
- **PingCode work items** — read-only list (project / type / assignee / keyword
  filters, status buckets) and details with comments, plus a connection probe.
- **Skills management** — installed-skill list, a read-only detail page that
  renders `SKILL.md` and its referenced support files (Markdown, highlighted
  code, CSV/TSV tables, `.env` tables, images), uninstall, update checks,
  enable/disable via frontmatter, and search/install from the skills.sh catalog
  (global or workspace, optionally across agents).
- **Notifications** — GitHub notification inbox with unread/all filtering and
  an unread badge shared with the Home dashboard.
- **Settings** — per-feature toggles (per person, per browser), review
  model, and customizable prompts for review / issue handling / MR-PR
  submission.
- **Packaging** — MIT license, third-party notices, and committed,
  byte-reproducible build artifacts (`index.js`, `lib/client.js`) so the package
  installs without a build step.

### Integrations (optional, each requires its CLI to be installed and logged in)

- `git` — local Git page and repository backend.
- `glab` (GitLab) and `gh` (GitHub) — MR/PR, Issues and notifications.
- `aliyun` (Aliyun CLI) — DMS approvals and SLS log queries.
- `python3` plus the pingcode skill — PingCode work items (read-only).
- `node`/`npx` with the `skills` CLI — skill install / update; installed skills
  and local detail pages work without it.

### Security

- No credentials are stored by the plugin; every read goes through the local
  CLIs as the logged-in user.
- Routes are same-origin only; new CLI calls use fixed whitelisted argv with
  validated, bounded arguments and never go through a shell.
- Remote rich text (PingCode descriptions/comments) is re-serialized through a
  host-side sanitizer before rendering.

### Known limitations

See [docs/limitations.md](docs/limitations.md). Highlights: lists and badges
are bounded by a single CLI fetch; DMS ticket lists are first-page only;
PingCode is read-only; skills installation needs network and the `skills` CLI;
auto-review runs only while DSH is running; the Home dashboard reads DSH's
internal session storage (not a public contract) and may need adaptation after
a DSH upgrade; feature toggles trim this browser's UI and requests, they are
not a permission boundary.

### Requirements

- **DSH** providing the sidebar/main-panel client slots and the public
  `@deepseek-ai/dsh-client-ui-*` contract packages the plugin is built against
  (`0.1.6-alpha.2`). Older DSH builds can still run the built bundle, but the
  unified shortcuts service and its settings UI require a DSH version that
  ships them.
- **Node.js >= 22.15.0** to build, test, or typecheck from source (the committed
  artifacts make this unnecessary for normal installation).

[Unreleased]: https://github.com/samanhappy/dsh-workbench/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/samanhappy/dsh-workbench/releases/tag/v0.9.0
