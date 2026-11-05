# 前置条件与安装 / 更新 / 卸载

插件本体只需要已安装 DSH。第 2–5 节是**可选集成**：不装只是对应页面不可用，不影响工作台其余部分。

## 前置条件

1. 已安装 DSH（`dsh` CLI 在 `PATH` 上），使用带 Web UI 的 profile（如 `web`）。插件在 DSH `0.2.2-rc.1` 桌面版上测试（构建使用公开的 `@deepseek-ai/dsh-client-ui-*` `0.1.6-alpha.2` 契约包）。
   功能页快捷键复用 DSH 的统一快捷键服务，需要包含 `shortcuts` 服务与快捷键设置界面的新版 DSH；旧版仍可使用工作台，但不提供快捷键。
   按键投递、输入区域和弹窗中的响应规则遵循 DSH；Linux Web 的可用组合受 DSH 限制。

2. **（可选）GitLab / GitHub**：安装并登录 `glab`（GitLab）与 / 或 `gh`（GitHub）：

   ```bash
   brew install glab gh
   glab auth login        # 自建实例：glab auth login --hostname <你的实例>
   gh auth login
   glab auth status && gh auth status   # 能列出已登录实例即可
   ```

   Linux 下用发行版包管理器或各 CLI 官方安装说明（GitHub CLI / glab 的官方文档）。两者都按仓库 remote host 自动识别；识别不出的实例（如未出现在 `glab auth status` 的自建 GitLab）暂不支持。

3. **（可选）阿里云 DMS 与 SLS**：安装并登录 `aliyun` CLI：

   ```bash
   brew install aliyun-cli
   aliyun configure configure     # 浏览器 OAuth 登录（推荐）
   aliyun configure list          # 有 Valid 的 profile 即可
   ```

   Linux 下可下载阿里云官方 `aliyun-cli` 发行包。两个页面共用同一份 `aliyun` 登录凭证。

   - **DMS**：RAM 账号需要 DMS 只读 + 审批权限。
   - **SLS**：需要日志服务只读权限，且目标 Project / Logstore 已开通并配置索引。多租户账号可在面板顶部填租户 `Tid`。
   - **SLS 没有内置默认 Project**：安装后需在插件行配置里设置 `slsEnvironments`（见下文「插件行配置」）；未配置时页面上可直接填写 Project / Logstore，两者都非空才可查询。

4. **（可选）技能管理的安装 / 更新 / 搜索**：需要 node + npx（技能写操作与 skills.sh 搜索走 `npx skills`，首次运行联网拉取 skills 包）：

   ```bash
   brew install node        # macOS；Linux 用发行版包管理器或 nvm。自带 npm/npx
   npx skills --version     # 验证可达（会先拉包，稍候）
   ```

   已装列表与 SKILL.md 预览是**只读本地**能力，CLI 不可用时仍可用。插件行配置的 `skillsCliSpec` 可钉版本（如 `skills@1.7.0`）或指向本机已装的 skills 可执行文件；`skillsNpmCacheDir` 可把 npx 缓存指到别处（沙箱 / 无 `~/.npm` 写权限时）。

5. **（可选）PingCode 研发管理**：需要 `python3` 与 pingcode 技能目录（须含 `scripts/api_call.py` 与 `.env`）：

   ```bash
   brew install python3     # macOS；Linux 用发行版包管理器
   # 技能目录默认探测 ~/.agents/skills/pingcode 与 ~/.workbuddy/skills/pingcode；
   # 也可用插件行配置的 pingcodeSkillDir 显式指定
   ```

   技能 `.env` 二选一配置（详见技能文档）：
   - **企业令牌**（无人值守）：`PINGCODE_CLIENT_ID` / `PINGCODE_CLIENT_SECRET`（企业后台 → 应用管理 → 企业令牌）；
   - **用户令牌**（个人数据，如「我创建的」）：另建 authorization_code 应用，运行技能 `auth_user.py` 授权；token 有效期 30 天，过期后重跑。

   描述里的图片链接（`/files/public/…`）需要授权才能显示：插件请求工作项接口（列表 / 搜索 / 详情）时带上图片令牌参数，用接口返回的 `public_image_token` 自动拼到这些链接上（只对 PingCode 同租户域名 `*.pingcode.com` 或私部署 base URL 同 host 生效）。企业令牌 / 用户令牌两种模式都支持，无需额外配置；该令牌限定 public 图片，不是用户凭据。

插件**不保存任何凭据**：它每次通过你本机的 `glab` / `gh` / `aliyun`，以及 pingcode 技能脚本（凭据在技能 `.env` 里）读取你自己账号的数据。

> **macOS 专用说明：DSH 是 GUI 应用，PATH 与终端不同。** 从 Finder / LaunchServices 启动的进程
> 不加载 `~/.zshrc` / `~/.zprofile`，PATH 只有系统最小集（`/usr/bin:/bin:/usr/sbin:/sbin`）。
> 因而即便终端里 `glab` / `gh` / `aliyun` 可用（Homebrew 装在 `/opt/homebrew/bin`、`aliyun` 在
> `/usr/local/bin`），host 半也可能找不到它们。插件因此内置了 CLI 发现回退：PATH 解析失败后依次探测
> 环境变量 `<NAME>_BIN`（显式绝对路径，最高优先级，如 `GLAB_BIN`、`GH_BIN`、`ALIYUN_BIN`）、
> nvm 的 node bin 目录，以及 `~/.local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.volta/bin`、
> `/usr/local/bin`、`/opt/homebrew/bin`。npm 包装 symlink 会被进一步解析为包内自带的平台原生二进制，
> 不依赖 `node` 出现在 DSH 的 PATH 上；PATH 上连 `--version` 都跑不通的 shim 会被判为不可用。
> 仍找不到时才显示「未检测到 … 命令行工具」。Linux 下若通过桌面启动器启动，也可能遇到类似的 PATH 差异，
> 可用同样的 `<NAME>_BIN` 环境变量兜底。

## 安装

```bash
# 1. npm（推荐）
dsh plugin --profile web add @samanhappy/dsh-workbench

# 2. GitHub
dsh plugin --profile web add github:samanhappy/dsh-workbench

# 3. 本地目录
dsh plugin --profile web add /path/to/dsh-workbench
```

npm 形式要求对应版本已发布到 npm；GitHub 与本地目录形式不依赖发布。`dsh plugin` 会把包链接进 profile 依赖，并因为包声明了 `dsh.bundle` 而追加到 `dsh.profile.bundles` 层列表；然后**重启 DSH** 生效。

包内已带预构建的 `index.js`（host 半）与 `lib/client.js`（client 半），目标机无需构建。本地目录安装时，目录名不必与包名一致：`dsh plugin add` 按目录路径链接，profile 记录的是包名与补丁 id。

首次运行：

1. 重启 DSH，点击左侧边栏的「工作台」图标，默认落在首页。
2. 当前 DSH 工作区是 Git 仓库时，仓库页自动识别仓库 / 分支 / 未提交改动与平台（GitLab / GitHub）。
3. SLS 页没有默认 Project：先在插件行配置里设置 `slsEnvironments`，或在页面顶部直接填写 Project / Logstore。

## 插件行配置

所有部署级参数都配在 DSH profile 的用户 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`），
以工作台插件行的 id 定位。**patch 会整体替换该行的 `config`**，因此要写全你想保留的字段：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-workbench-samanhappy
  name: '@samanhappy/dsh-workbench'
  config:
    slsEnvironments: '[{"key":"prod","label":"生产","project":"your-project","logstore":"your-trace-logstore","logs":"your-log-store"}]'
```

`slsEnvironments` 是 JSON 字符串，元素为 `{ key, label, project, logstore, logs }`（`logs` 可省略，
用于普通日志视图；不写时回退到 `logstore`）。JSON 非法 / 非数组时按空列表处理，单条配置不合法时只忽略该条，
不会让插件启动失败。

其他已文档化的键：`pingcodeSkillDir`（PingCode 技能目录）、`skillsCliSpec` / `skillsNpmCacheDir`（skills CLI
来源与 npm 缓存）、`selfUpdateIntervalMs`（本地目录安装的自动更新间隔，`0` 关闭）。其余部署可调参数
（缓存 TTL、列表上限、自动评审间隔等）见 `src/host/config.ts`，文档不复述默认值。

部分环境改动可由 DSH HMR 热加载；未启用 HMR 时重启 DSH 生效。

## 更新

- npm / GitHub 安装：重新执行一次 `dsh plugin --profile web add <同一来源>`，取该来源解析到的新版本，然后重启 DSH。
- 本地目录安装：更新该目录的代码（或依赖下述后台自动更新）。只改**客户端**半时产物变化会推给已打开的页面（未自动生效就刷新一次）；动了 **host** 半必须重启 DSH。
- 本地目录安装支持后台自动更新：跟踪当前分支上游，仅在工作区干净且没有本地提交时快进，构建成功后提示重启 DSH。构建失败会尝试恢复原提交与两个产物；恢复失败时需手动处理。安装目录必须是独立仓库，并已具备构建依赖和可用的 Git 认证；更新期间请勿编辑该目录。插件行配置 `selfUpdateIntervalMs: 0` 可关闭自动更新；Git URL、npm 和 tarball 安装暂不自动更新。
- 提交的 `index.js` / `lib/client.js` 是 `npm install && npm run build` 在**任意机器**上可逐字节复现的产物（构建统一按锁定的本地 `node_modules` 解析，不读取 tsconfig 的 `paths`），因此在安装目录里跑过构建 / 测试也不会弄脏工作区，不会误拦自动更新；更新环节只在真正出现文件改动时提示「本地修改」。

## 卸载

```bash
dsh plugin --profile web remove @samanhappy/dsh-workbench
```

之后重启 DSH 即卸载。
