## Summary

<!-- What does this pull request change, and why? Link related issues with "Fixes #123". -->

## Verification

<!-- How did you verify the change? Commands run, scenarios exercised, CLIs involved. -->

## Checklist

- [ ] `npm run build` has been run and the rebuilt `index.js` / `lib/client.js` are part of this PR. They are committed artifacts and must never be hand-edited.
- [ ] `npm test` passes, and behaviour changes come with tests.
- [ ] New test files were added to the explicit `test` file list in `package.json`.
- [ ] No secrets, tokens, customer data, internal hostnames or personal absolute paths are introduced — including test fixtures and screenshots.
- [ ] Documentation was touched only for changed contracts, boundaries or invariants, per `AGENTS.md`; implementation details are not restated in `docs/`.
- [ ] UI changes include a screenshot or short screen recording in this PR.
- [ ] Any new CLI call keeps the whitelist rule: fixed argv, validated and bounded external arguments, no shell interpolation.
- [ ] Remote rich text that reaches `dangerouslySetInnerHTML` goes through the host sanitizer (`sanitizeRichText`).
