# Third-Party Notices

`@samanhappy/dsh-workbench` is licensed under the MIT License (see
[LICENSE](LICENSE)). It contains or is built from the third-party software
listed below. Each component remains under its own license; the notices and
license texts required by those licenses are reproduced here.

## Bundled or vendored components

| Component | Version | License | Copyright | Location in this package |
|---|---|---|---|---|
| dsh-git-tree — vendored local-Git panel, modified and reorganized | 0.7.x (checked against npm 0.7.3) | MIT | Copyright (c) 2026 chzisnull | `src/client/git/**`, `src/host/git/**`; also inlined into `index.js` and `lib/client.js` |
| DeepSeek Harness — `ui-deliverables` ReviewTab diff rendering, ported and adapted | DSH 0.1.6-alpha.2 | MIT | Copyright (c) 2026 DeepSeek | `src/client/components/diffview.tsx`, `src/client/styles/diff.css`; inlined into `lib/client.js` |
| @deepseek-ai/schemastery | 3.18.2 | MIT | Copyright (c) 2021-present Shigma | inlined into `index.js` |
| @deepseek-ai/cosmokit | 1.8.3 | MIT | Copyright (c) 2021-present Shigma | inlined into `index.js` |
| diff (jsdiff) | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015 Kevin Decker <kpdecker@gmail.com> | inlined into `lib/client.js` |
| Lucide icons | current icon set | ISC; Feather-derived subset MIT | Copyright (c) 2026 Lucide Icons and Contributors; Feather subset Copyright (c) 2013-present Cole Bemis | `src/client/icons.tsx`; inlined into `lib/client.js` |
| Phosphor Icons — GitLab logo path | current icon set | MIT | Copyright (c) 2023 Phosphor Icons | `src/client/icons.tsx`; inlined into `lib/client.js` |
| Simple Icons — GitHub mark | current icon set | CC0 1.0 | no attribution required | `src/client/icons.tsx`; inlined into `lib/client.js` |
| Git logo | Git-Icon-1788C.svg | CC BY 3.0 Unported | Jason Long | `src/client/icons.tsx`; inlined into `lib/client.js` |

Modification notes: the vendored Git panel was moved from the upstream
`src/client/components` / `src/host` layout into `src/client/git` /
`src/host/git` and adapted; the upstream MIT notice is preserved in both
directories. The DSH diff renderer was reduced and adapted to unified-diff
text. The Git logo is recolored with `currentColor`; its geometry is unchanged.

### Tests derived from dsh-git-tree

`test/git-ai.test.mjs`, `test/git-host-modules.test.mjs` and
`test/git-routes.test.mjs` contain code derived from dsh-git-tree's test suite
(same MIT license and copyright as above). The test suite is not shipped in the
npm tarball.

## Runtime dependencies provided by DSH (not redistributed here)

This package's `lib/client.js` requests `react` and
`@deepseek-ai/dsh-client-ui-primitives` from the DSH host module table, and
declares `@deepseek-ai/dsh-client-ui-renderer`, `-session`, `-workspace`,
`-conversation`, `-sidebar` as client injects. Those packages are installed and
distributed by DeepSeek Harness, not by this package: React 18 (MIT, Copyright
(c) Meta Platforms, Inc. and affiliates) and the `@deepseek-ai/dsh*` packages
(MIT, Copyright (c) 2026 DeepSeek). They are listed for transparency only.

## Build-only dependencies (not distributed)

esbuild (MIT), TypeScript (Apache-2.0), `@types/*`, `csstype`, `scheduler`,
`loose-envify`, `js-tokens`, `undici-types`, `@standard-schema/spec` — used only
to build and test; no code from them is shipped.

## MIT License

The following components are licensed under the MIT License:

- dsh-git-tree — Copyright (c) 2026 chzisnull
- DeepSeek Harness ui-deliverables — Copyright (c) 2026 DeepSeek
- @deepseek-ai/schemastery, @deepseek-ai/cosmokit — Copyright (c) 2021-present Shigma
- Phosphor Icons — Copyright (c) 2023 Phosphor Icons
- Feather-derived Lucide icons — Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## BSD 3-Clause License (diff / jsdiff)

Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## ISC License (Lucide)

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Git logo — Creative Commons Attribution 3.0

Git Logo by Jason Long is licensed under the Creative Commons Attribution 3.0
Unported License (<https://creativecommons.org/licenses/by/3.0/>).
Source: <https://git-scm.com/community/logos> (Git-Icon-1788C.svg).
Modification: recolored via `currentColor`; geometry unchanged.

## CC0 1.0 (Simple Icons GitHub mark)

The GitHub mark path is taken from Simple Icons, dedicated to the public domain
under CC0 1.0 Universal
(<https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md>).
Attribution is not required.

GitHub and the GitHub logo are trademarks of GitHub, Inc.; GitLab and the
GitLab logo are trademarks of GitLab Inc.; Aliyun, PingCode, DeepSeek Harness
and DSH are trademarks of their respective owners. Their use here is nominative,
to identify the third-party services this plugin integrates with. This project
is not affiliated with or endorsed by those companies.
