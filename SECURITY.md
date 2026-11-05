# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.9.x | ✅ |
| < 0.9 | ❌ |

Only the latest published release receives security fixes. Fixes are released
through the normal `v*` release workflow.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security
problem.** Public disclosure before a fix puts every user who runs the plugin
at risk.

Report privately through GitHub Security Advisories:

1. Open <https://github.com/samanhappy/dsh-workbench/security/advisories/new>.
2. Describe the issue, the impact, and the affected version(s).
3. Include the DSH version, OS, and a minimal reproduction. Redact tokens,
   credentials, internal hostnames, and customer data.
4. If you have a suggested fix, attach it as a patch or a link to a private
   branch — do not push it to a public branch first.

If you are unsure whether something is a vulnerability, report it privately
anyway and it will be triaged.

## Scope and trust model

The workbench is a DSH plugin with two halves:

- a **host half** (`index.js`) that registers same-origin routes and drives
  local CLIs (`git`, `glab`, `gh`, `aliyun`, `npx skills`, `python3`);
- a **client half** (`lib/client.js`) that is served into the DSH web UI as
  trusted static code, with no per-action approval.

Design properties that security reports should be measured against:

- **No credentials are stored.** The plugin keeps no tokens or access keys; it
  reads whatever the user's already-authenticated CLIs can read, as that user.
- **Same-origin only.** Routes use DSH's connection trust fence; there is no
  unauthenticated network listener, and no cross-origin data channel.
- **Whitelisted CLI argv.** Routes build fixed argv arrays and never pass user
  input through a shell. External arguments are validated and bounded.
- **Remote rich text is sanitized.** Host-side `sanitizeRichText` re-serializes
  remote HTML against tag/attribute/URL-scheme whitelists before the client
  renders it with `dangerouslySetInnerHTML`.
- **Feature toggles are not a security boundary.** The per-browser toggles only
  trim the local UI and requests; host routes stay registered.

## What is a vulnerability

Examples of issues that are in scope:

- Command injection, argument injection, or path traversal reachable through a
  workbench route or a rendered remote payload.
- A way for a remote payload (MR/PR title, issue body, PingCode rich text,
  skill file, log line, …) to execute script, exfiltrate same-origin data, or
  reach `dangerouslySetInnerHTML` without sanitization.
- Cross-origin access to workbench routes or their response data.
- Leaking credentials, tokens, or session data into logs, responses, generated
  files, or error messages.
- Weakening of the read-only/destructive-action guards (e.g. a path that
  force-pushes or merges without the documented confirmation).
- Supply-chain issues in shipped code (unexpected code in a published tarball,
  provenance mismatch, compromised dependency).

## What is not a vulnerability

- Vulnerabilities in DSH itself — report them to the DeepSeek Harness project.
- Vulnerabilities in `glab`, `gh`, `aliyun`, `npx skills`, `python3`, or the
  pingcode skill — report them to their maintainers.
- A local user with your OS account already having your CLI access, your files,
  or your shell; the plugin runs with the same rights as that user.
- Misconfiguration (CLI not installed or not logged in, missing permissions,
  wrong tenant/project/environment settings), or destructive actions you
  explicitly confirm in the UI.
- The absence of a server-side permission model around local CLI access, and
  feature toggles not restricting other browsers or other users.
- Missing hardening that has no demonstrated impact (e.g. generic
  best-practice headers on a route that already requires same-origin).
- Social engineering, phishing, or physical access.

## Response expectations

This is a maintainer-run open-source project, handled on a best-effort basis:

- We aim to acknowledge a report within **5 business days** and to provide a
  triage decision (in scope / not in scope, severity, planned fix) within
  **10 business days**.
- Confirmed issues are fixed in a private branch and released as a patch
  version; the advisory is published after the fix is available.
- We will credit you in the advisory unless you ask to stay anonymous.
- Please give us a reasonable window (about **90 days**, or until a fix is
  released) before public disclosure.

Please do not run automated scanners against other people's accounts, data, or
CLIs while researching, and do not test against repositories or tenants you do
not own or have permission to use.
