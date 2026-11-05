# Contributing to dsh-workbench

Thanks for your interest. This document covers everything you need to build,
test, and submit a change. Please also read:

- [AGENTS.md](AGENTS.md) — the project brief, commands, and documentation convention (this is the rule that code, not docs, is the fine-grained source of truth).
- [docs/conventions.md](docs/conventions.md) — the invariants and external contracts a change must not break.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities privately.

## Ways to contribute

- **Bug reports** — use the bug report issue form. Include the DSH version, OS, Node version, the CLI versions (`glab`, `gh`, `aliyun`, `npx skills`), and redacted logs. Never paste credentials, tokens, internal hostnames, or customer data.
- **Feature requests** — use the feature request form. Describe user-visible behaviour and the problem it solves; note that the workbench is deliberately a *client* of the CLIs you already use.
- **Code, tests, docs** — open a pull request against `main`.

Security problems are never handled in public issues; follow [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- **Node.js >= 22.15.0** (`engines`), with npm. The `.nvmrc` pins Node 24, so `nvm use` is enough if you use nvm.
- A POSIX-ish shell (macOS, Linux, or WSL). Some test suites use `chmod` and symlinks, and CI is ubuntu-latest.
- `git` on `PATH` — the Git-related tests run real `git` commands.

You do **not** need DSH, `glab`, `gh`, or `aliyun` to build, test, or typecheck.

```bash
git clone https://github.com/samanhappy/dsh-workbench.git
cd dsh-workbench
nvm use        # optional; otherwise any Node >= 22.15.0 works
npm ci
npm run build
```

## Commands

| Command | What it does | What it verifies |
| --- | --- | --- |
| `npm run build` | esbuild → `index.js` (host half), `lib/client.js` (client half) | Bundles `src/host/**` and `src/client/**` |
| `npm test` | `pretest` rebuilds, then `node --test` over the explicit suite list | Pure functions and contracts: host modules, config registry and feature flags, session bridge, diff rendering, routes |
| `npm run sim` | Rebuilds, then `sim-panel.mjs` on the built client bundle | Client behaviour: navigation, request scoping/races, confirmation flows, saved settings |
| `npm run typecheck:setup` | Installs the pinned public `@deepseek-ai/*` contract packages with `--no-save` | Resolves what `tsconfig.json` type-only imports need |
| `npm run typecheck` | `tsc --noEmit` | Type contracts of the sources, tests, and build scripts |
| `npm run smoke` | Rebuilds, then `smoke.mjs` against real CLIs | Maintainer-only: needs logged-in `glab` / `gh` / `aliyun` |

`npm run smoke` is never run in CI — it talks to real accounts and repositories.

### Build artifacts are committed

`index.js` and `lib/client.js` are build outputs of `build.mjs` and are committed on purpose: `dsh plugin add` installs the package without building it. Therefore:

- **Run `npm run build` after any change under `src/`, and commit both rebuilt files.** CI fails if a fresh build differs from the committed bundles.
- **Never hand-edit `index.js` or `lib/client.js`** (or `lib/_client.bundle.js`, the temporary intermediate).
- The bundles must be byte-reproducible on any machine: bundling uses `tsconfig.build.json` (no environment-specific `paths`) and resolves the lockfile-pinned `node_modules`.

### Notes

- The test suites are an **explicit file list** in the `test` script in `package.json`, not a glob — add new test files there.
- Tests and the simulation load the **built artifacts**, not the TypeScript sources, which is why `pretest`/`sim` rebuild first.
- `npm run typecheck` is intentionally not part of `npm test`: it needs the pinned public DSH contract packages installed by `npm run typecheck:setup` (network), while `npm test` must stay runnable offline after `npm ci`.
- After replacing `node_modules` or changing the pinned DSH contract versions, re-run `npm run typecheck:setup`.

## Code conventions

The detailed rules live in [docs/conventions.md](docs/conventions.md) and [AGENTS.md](AGENTS.md). The ones that most often break in pull requests:

- **Reuse the existing building blocks.** Before adding UI, look at a comparable page and the shared components, styles, icons, and runtime helpers. Add feature-specific components/CSS only for the actual difference; do not copy shared styles or override them with near-identical values.
- **Whitelisted CLI argv.** Routes construct fixed argv arrays and never interpolate user input into a shell. Every external argument needs validation and bounds.
- **No credentials.** The plugin stores no tokens; it reads data through the CLIs the user has already logged in.
- **Sanitize remote rich text.** Any remote HTML that reaches `dangerouslySetInnerHTML` must go through the host's `sanitizeRichText` (tag/attribute/URL-scheme whitelist, escaping, structural repair).
- **Same-origin trust.** Routes rely on DSH's connection trust fence; do not widen it.
- **Write tests for behaviour changes.** Add pure-function or contract tests under `test/`; the suites assert against the built bundles.
- **No internal data in fixtures or screenshots.** Replace internal hostnames, employee names, ticket IDs, and tokens with obvious placeholders.

### Commit and pull-request style

- Use [Conventional Commits](https://www.conventionalcommits.org/) with an imperative subject: `feat(forge): ...`, `fix(dms): ...`, `test: ...`, `docs: ...`, `chore: ...`, `ci: ...`. Reference the issue when there is one (`Fixes #123`).
- Keep a pull request to one logical change. Update the tests and, when a contract or boundary changed, the relevant docs in the same PR.
- UI changes need a screenshot or short recording in the PR description.
- Confirm the checklist in the pull-request template — especially that `npm run build` was run and the rebuilt artifacts are committed.
- CI must be green: the test matrix (Node 22.15.0 and 24.x), the artifact-drift job, and typecheck. `CODEOWNERS` assigns review; the maintainer merges.

### Language

The README exists in English ([README.md](README.md)) and Chinese ([README.zh.md](README.zh.md)); `docs/` is currently written in Chinese, and code comments are a mix of Chinese and English. Keep new content consistent with the file you are editing, and update both READMEs when a user-facing statement changes. A wholesale documentation translation should be a separate, explicitly discussed change.

## Documentation convention

Code is the single fine-grained source of truth. `docs/` only carries what cannot be inferred from the source, or what breaks if someone gets it wrong: purpose and boundaries, module responsibilities, external contracts and invariants, flow semantics, extension points, known limitations, operational steps.

Do not restate implementation details (route/parameter lists, CLI argv, cache TTL values and defaults, data-structure field tables, per-button UI behaviour, DOM/CSS details, build-artifact internals). A normal feature change is **code + tests**; touch `docs/` only when a capability boundary, external contract, invariant, or user-visible semantic changes. Before adding a doc line, ask: would a reader learn this by reading the code? If yes, don't write it.

## Releasing (maintainers)

- Version bumps, tags, and publishing are maintainer steps, not part of a contribution PR.
- A `v*` tag triggers `.github/workflows/release.yml`: it rebuilds and diffs the bundles, runs `npm test`, publishes to npm with trusted publishing (`--provenance --access public`, environment `npm-publish`), then creates the GitHub release with generated notes.
- Releases are categorized by [.github/release.yml](.github/release.yml); label pull requests accordingly.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) (inbound = outbound). There is no separate CLA.
