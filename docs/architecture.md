# 包结构与工作原理

## 两半模型

插件是一个**静态 bundle**，由两半组成，边界就是 DSH 的进程边界。
包身份：npm `@samanhappy/dsh-workbench`；profile 里的插件行 id 为 `dsh-workbench-samanhappy`；
client 模块 id 与包名相同，`cordis.patch.yml` 声明 bundle 补丁。

| 半 | 产物 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| HOST | `index.js` | DSH 进程（cordis 插件行） | 注册同源 HTTP 路由，调用本机 `git` / `glab` / `gh` / `aliyun`、pingcode 技能脚本（`python3`）与 `npx skills`，做参数校验、数据归一化与缓存 |
| CLIENT | `lib/client.js` | 浏览器（DSH module-loader 工厂） | 侧边栏入口、工作台面板与功能页 + 配置页（功能开关 / 提示词）、会话类操作 |

浏览器**不直接执行 CLI**：外部数据经 host 路由取回。后台评审由 host 调度，
复用 DSH 官方会话服务；处理 Issue 与提交 MR-PR 仍由客户端发起。
本地 Git 子页直接操作已注册工作区；AI 提交信息通过 DSH 的模型服务生成，
只填入草稿，由使用者检查并提交。

## 目录职责

```
src/host/    index.ts   路由接线与 apply()          runner.ts  CLI 执行与错误分类
             config.ts  部署可调参数                issues.ts / dms.ts / sls.ts / pingcode.ts / skills.ts / home.ts / notifications.ts  各域的参数校验、argv 构造与归一化
             git/       本地 Git 路由与命令薄封装    auto-review.ts 后台评审调度
src/client/  index.ts   apply() 与槽位注册          runtime.ts 同源 fetch、共享 store、外壳轮询、服务捕获
             session.ts 会话桥                      prompts.ts 配置注册表（提示词 / 功能开关）+ 存取层
             features.ts 功能开关读取与订阅          format.ts  纯格式化                    components/*.tsx 面板与子视图   styles/*.css 注入式样式
             git/       本地 Git 面板（随包分发的受信静态代码）          models.ts  DSH 模型目录读取
src/shared/  本地 Git 提交提示词与类型声明
test/        node --test（加载构建产物）             sim-panel.mjs 客户端行为模拟   smoke.mjs host 冒烟
```

具体文件、函数与字段以源码为准。

## 一次请求怎么走

```
UI 事件 → fetch('/forge|/dms|/sls|/pingcode|/home|/notifications|…')（同源）
        → host 路由：信任围栏 → 参数白名单校验 → 固定 argv 调用 CLI
        → 归一化成统一视图 → JSON（命中缓存则跳过 CLI）
        → 客户端共享 store 更新 → 组件重渲染
```

- 客户端不做数据加工（除展示格式化）；两端数据的差异在 host 归一化阶段抹平。
- 写操作成功后由 host 失效相关缓存，客户端随即强刷列表与统计。

## 状态与刷新

- **客户端共享 store**（`runtime.ts`）：工作区检测、Issue meta、DMS 待审批数、外壳心跳。多个消费者共用一次拉取。
- **外壳层轮询**：插件 `apply()` 启动，与面板开闭无关；后台刷新完成后 bump 心跳，面板据此以「允许命中缓存」的方式重拉——面板关闭期间缓存保持新鲜，徽标持续更新。轮询与功能开关联动：关掉的域不预热、不发请求。
- **功能开关**（`features.ts`）：开关值来自配置注册表（`prompts.ts`，kind `'toggle'`），快照按取值指纹缓存，配置写入广播后 UI 与轮询即时重渲染。
- **host 缓存**：列表 / 状态 / CLI 登录探测分级缓存，写操作即时失效。TTL 与分页上限是**部署可调参数**（`src/host/config.ts`，写在插件行的 `config` 里），文档不复述默认值。

## 会话类能力

评审优先由 host 创建独立的 DSH 会话，手动与自动入口共享任务记录，
不依赖浏览器在线。host 会话服务缺失时，仅手动评审回退到客户端会话桥。
Issue 处理与提交 MR-PR 仍走客户端官方服务；会话桥负责新会话的 retain 生命周期。
插件不自建 agent runner，也不维护自己的模型目录。

## 扩展点

| 要加什么 | 动哪里 |
| --- | --- |
| 新的 CLI 数据能力 | host 加一个域文件（参数校验 + argv 构造 + 归一化）+ `index.ts` 注册路由；客户端加 fetch 与视图 |
| 新的可定制提示词 | `prompts.ts` 注册表加一项并声明 `scope`（面板自动渲染），业务侧用 `resolveConfigText` 读取 |
| 新的功能开关（功能域裁剪） | `prompts.ts` 注册表加一项 `kind: 'toggle'` + `FEATURE_CONFIG_KEYS`，在 `features.ts` 声明读取；页签 / 侧栏常显入口 / 轮询按开关过滤 |
| 新的功能页 / 入口 | 客户端组件 + `shell.tsx` 的页签与侧边栏常显快捷入口；跨面板状态放 `runtime.ts` 的 store |
| 新的部署可调参数 | `src/host/config.ts` 的 schema |

## 依赖边界

- 客户端只把 `react` 与官方 `@deepseek-ai/dsh-client-ui-primitives` 作为 external；其余官方 client 模块契约是 **type-only** import，不参与构建。类型声明来自 `npm run typecheck:setup` 安装的固定版本公开契约包，`tsconfig.json` 不包含机器相关路径。
- host 只依赖 Node 内置模块与 schemastery。
- 没有动态 runner、审批与 steering：自动评审只向独立会话提交明确的评审请求，不操控用户当前会话。
- 技能页的目录搜索走 skills.sh **公开** `/api/search`（host 侧 fetch），技能写操作走本机 `npx skills` CLI——两条数据链路的取舍见 `src/host/skills.ts` 头注与 [conventions](conventions.md)。
- 本地 Git 子页的代码来自随包分发的受信静态代码（见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)），与其余功能页共用同一套同源路由与信任围栏。

## GitHub 通知边界

通知页查询 `gh` 在 github.com 上的当前登录账号，跨仓库查询，独立于工作区。
点击通知标题或外链入口直接打开 GitHub，并自动标为已读；标记失败时在列表提示。
完成仍由用户显式操作，不改变 PR / Issue 状态。
通知不设顶级页签与侧栏常显入口：未读通知在首页展示（GitHub 未读统计卡 +
最近未读通知区），「查看全部」与统计卡直达通知列表页（页面仍常挂载、受功能
开关约束）。通知功能开启时，即使面板关闭也会后台查询未读通知，以工作台图标
红点提示；列表页进入时查询并支持手动刷新。需要账号令牌具备通知访问权限；
GitHub 通知 API 不支持 fine-grained PAT 或 GitHub App 令牌。
