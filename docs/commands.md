# 构建、类型检查与测试

包管理器为 **npm**（`package-lock.json`）。以下全部是 npm scripts。

开发需要 **Node.js >= 22.15.0**（`package.json` 的 `engines`；测试用到 zstd 解压）。
使用插件本身不需要 Node.js，除非要用技能页的安装 / 更新 / 搜索（走 `npx`）。

| 命令 | 作用 | 验证什么 |
| --- | --- | --- |
| `npm run build` | esbuild 打包 | `src/host/**` → `index.js`；`src/client/**` → `lib/client.js` |
| `npm run typecheck:setup` | 安装固定版本的公开 DSH 契约包（`--no-save`） | 为类型检查提供官方 client 模块声明，不写入 `package.json` |
| `npm run typecheck` | `tsc --noEmit` | 源码类型（官方 client 模块契约按 type-only import 解析） |
| `npm test` | `node --test`（先自动 build） | 纯函数与契约：host 各域逻辑、配置注册表与功能开关、会话桥、diff 渲染、构建可复现性 |
| `npm run sim` | `sim-panel.mjs`（先 build） | 客户端行为：用 stub 的 mini-React 驱动**构建产物**跑完整交互链路 |
| `npm run smoke` | `smoke.mjs`（先 build） | host 半对**真实** `glab` / `gh` / `aliyun` 的冒烟（需已登录；环境不满足时跳过） |

`typecheck` 依赖 `typecheck:setup` 安装的契约包；`tsconfig.json` 不再包含机器相关的 `paths`，换机器后重跑一次 `npm run typecheck:setup` 即可。

## 规则

- **改动 `src/` 下任何文件后都要 `npm run build`**：`index.js` 与 `lib/client.js` 是已提交的构建产物，由 `build.mjs` 重新生成，**不要手改**。CI 会重新构建并校验两个产物逐字节可复现；只改源码不提交产物会使校验失败。
- `index.js` 内联了 `@deepseek-ai/schemastery`，因此它（及其 `@deepseek-ai/cosmokit`）的版本属于构建输入：两者以精确版本钉在 `devDependencies`，`typecheck:setup` 的 `--no-save` 安装不得改动它们，否则产物与 CI 的 `npm ci` 不一致。
- 单元测试与行为模拟都加载**构建后的产物**（`test/load-client.mjs` 载入 `lib/client.js`，`sim-panel.mjs` 用 mini-React 驱动同一产物）：先 build 再跑，否则断言的是旧代码。
- `npm test` 不需要 DSH 安装、网络或外部集成 CLI（需要本机 `git`）；`npm run smoke` 相反，需要本机已登录的 CLI，只适合手动执行，不要放进 CI。
- `npm run sim` 使用 stub 环境，不访问真实 CLI / 网络，可进 CI。
