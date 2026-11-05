# dsh-weknora-macos

把 **WeKnora Lite（macOS Apple Silicon / arm64）** 打进一个 DeepSeek Harness 组合包：安装后自动注入一个工具
`weknora_run`，调用它就在本机拉起知识库服务并返回 Web UI 地址。

> 二进制只覆盖 **darwin-arm64**（Apple Silicon）。Intel Mac 和 Windows 需要各自的构建与平台包，
> 见 [dsh-weknora-win](https://github.com/huangmiuXyz/dsh-weknora-win)。

仓库只含源码：WeKnora 二进制与 `web/`、`config/`、`migrations/` 是分发产物，不入库。
完整包（含 247 MB 二进制）见 [Releases](https://github.com/huangmiuXyz/dsh-weknora-macos/releases)。

- 二进制与资源**随包分发**，用户不需要单独下载 WeKnora，也不需要 Go / Docker / 前端构建。
- 工具是幂等的：已经在跑就复用，绝不重复启动第二个实例。
- 默认只监听 `127.0.0.1`，数据写在 `$DSH_HOME/weknora`，不碰 `node_modules`。
- 插件卸载 / DSH 退出时停掉服务；别处启动的实例只收养、不杀。

## 安装

从 [Releases](https://github.com/huangmiuXyz/dsh-weknora-macos/releases) 下载
`dsh-weknora-macos-0.1.1.tgz`：

```sh
dsh plugin --profile <name> add ./dsh-weknora-macos-0.1.1.tgz
dsh --profile <name>             # 或重启 DSH
```

或者本地打包（先补齐 `assets/`，见下节）：

```sh
pnpm pack                        # 产出 dsh-weknora-macos-0.1.1.tgz（约 270 MB）
dsh plugin --profile <name> add ./dsh-weknora-macos-0.1.1.tgz
```

安装后工具列表里会出现 `weknora_run`。第一次调用会建库并跑迁移（通常几秒），之后
毫秒级返回。

如果 profile 里已经装了官方的 `@wxg-prc-cpg/dsh-weknora`（检索类工具），两者可以共存：
本包的行 id 是 `weknora-run`，官方的是 `weknora`，互不覆盖。

需要 Node ≥ 22 与 DSH 的 `ctx.tools` / `ctx.subprocess` 能力（桌面版与 web profile 都提供）。

## 工具：三级揭示

插件不会一次性把几百个工具塞给模型。可用工具随使用逐级展开：

```
装好插件                →  weknora_run
weknora_run 成功        →  + weknora_get_tools
weknora_get_tools([...]) →  + 该能力组的全部工具
```

### `weknora_run`

```ts
weknora_run()  →  { running, baseUrl, port, state, host, dataDir, startupMs?, note?,
                    apiKeyConfigured, apiKeyHint, capabilities }
```

| `state` | 含义 |
|---|---|
| `started` | 这次调用启动的；`startupMs` 是等待就绪的时间 |
| `already-running` | 本插件进程里已经在跑 |
| `adopted` | 已有 WeKnora 在应答（可能是上次 DSH 留下的，或用户自己启的），直接复用 |

三种 `state` 都算成功，成功后 `weknora_get_tools` 才出现。即使没有配置 API Key 也会解锁——
`weknora_get_tools` 被请求注册时会明确告诉模型缺 Key，比工具干脆不存在更容易排查。

失败会抛错，消息里带子进程最近 20 行输出（Go 的 panic 一行就能定位）。

首次打开页面需要在 WeKnora 里**注册一个本地账号**，这是它自身的行为；工具只负责把服务拉起来。

### `weknora_get_tools`

```ts
weknora_get_tools()                      →  报告当前状态，不注册任何工具
weknora_get_tools({ capability: 'search' })  →  注册 search 组
weknora_get_tools({ capability: 'faq' })     →  再注册 faq 组（另一次调用）
```

**一次只能注册一种能力。** `capability` 是单个字符串，不是数组——传数组会直接报错并列出
合法值。要启用多个组就分多次调用。

**累加、幂等**：同一组问两次是空操作；不同组叠加而不是替换。已经注册的工具在本次会话里
一直可用，只有卸载插件才会全部消失。

| 返回字段 | 含义 |
|---|---|
| `registered` | 本次新增的工具名 |
| `alreadyRegistered` | 请求过、本来就在 |
| `capabilities` | 累计生效的能力组 |
| `available` | 还能申请哪些 |
| `counts` | 每组的操作数，方便权衡要不要申请 |

未知的能力组名会直接报错并列出合法值，而不是静默失败。

### 13 个能力组

| 组 | 数量 | 内容 |
|---|---:|---|
| `documents` | 46 | 知识条目 CRUD、导入、解析、分块、标签、图片 |
| `chat` | 33 | 会话、消息、知识问答、Agent 问答 |
| `system` | 32 | 系统信息、初始化向导、模型检测、评测 |
| `mcp` | 30 | MCP 服务、MCP 端点、IM 渠道 |
| `infra` | 26 | 向量库、存储后端、网络搜索 |
| `wiki` | 21 | Wiki 页面、目录、修订、lint |
| `search` | 17 | 知识库 CRUD、检索、置顶、复制 |
| `datasource` | 16 | 数据源接入、同步、日志 |
| `memory` | 16 | 跨会话长期记忆 |
| `faq` | 13 | FAQ 条目、批量更新、导入 |
| `agents` | 12 | 智能体 CRUD、复制 |
| `models` | 11 | 模型配置 |
| `shares` | 2 | 组织共享的知识库与智能体 |

总计 **275 个工具**，覆盖本机 Lite + 工作区 API Key 真正能调通的全部操作。

### 为什么不是 432 个

WeKnora 0.9.0 的 Swagger 有 432 个操作，其中 157 个本机跑不通，注册了只会让模型白跑一趟：

| 数量 | 原因 |
|---:|---|
| 46 | `/tenants`、`/automations`、`/notifications` —— 裸 group，**API Key 默认拒绝**，只能登录用户调 |
| 27 | `/sandbox-configs`、`/skills` —— 打包的二进制没有 `desktop` tag，沙箱是 stub |
| 27 | `/auth`、`/me` —— 登录流程和个人会话，不是工具语义 |
| 25 | `/organizations` —— `not_supported_in_lite` |
| 23 | `/system/admin` —— 平台管理员，工作区 Key 一律 403 |
| 6 | `/agent/*`、`/mcp-oauth` —— 会话内审批回调 |
| 2 | `/embed/*`、`/im/callback` —— 匿名访客端点，用 Embed token |
| 1 | `graph-search` —— `NEO4J_ENABLE=false` |

## 重新生成 catalog

工具表是生成件，不要手改：

```sh
node scripts/gen-catalog.mjs <WeKnora 源码>/docs/swagger.json
```

升级内置 WeKnora 版本后重跑一次。生成器用 `openapi-mcp-generator`（现成库，MIT）解析
OpenAPI，自己的代码只做三件该库做不了的事：过滤本机跑不通的操作、给每个操作起一个
模型能读的名字、把嵌套配置裁剪到 4 层（否则单个 schema 能到 24 KB）。

## 工具卡片

`weknora_run` 在 Web GUI 里会渲染成一张卡片：

- **未配置 API Key**：显示输入框。这次调用会**挂起等你保存**（最多 5 分钟），保存成功后
  调用立即返回；超时则以 `apiKeyConfigured: false` 返回，卡片上会说明原因。
- **已配置**：显示掩码 `sk-****xxxx` 与「更换」。
- **在浏览器打开**：由 host 侧用 `open` 交给系统默认浏览器，不依赖 GUI 自己的 `window.open`。

## API Key 存在哪里

用 **DSH Credentials 服务**（`ctx.credentials`），和官方 `dsh-image-gen` 存各家 Provider Key 是同一个机制：

```
$DSH_HOME/.credentials.yaml      # 权限 0600
refs:
  { WEKNORA_API_KEY: <你的 key> }
```

- 插件只持有**引用**（环境变量名 `WEKNORA_API_KEY`），值由 DSH 自己的 credentials 服务托管。
- 设置页 / 卡片**不会回显明文**，只显示 `sk-****xxxx`。
- 不写 `~/.zshrc`、不写 LaunchAgent、不用 `launchctl`、不碰 `process.env`；这些在 macOS 上要么读不到（GUI 启动的 DSH 不 source shell profile），要么随进程消失。

命令行清除：

```sh
# 在 DSH 设置里点「清除」，或直接编辑该文件删掉 WEKNORA_API_KEY 这一行
```

**baseUrl 不是密钥**，所以留在插件自己的 Config 里（`cordis.patch.yml` 的 `host` / `port`），不占 credentials 条目。

如果某个组合没有 `credentials` 服务，插件仍会启动服务并返回地址，只是把 Key 报告为未配置——和没有 `webServer` 时卡片不可用是同一种降级。

## 配置

改 profile 的 `cordis.patch.yml` 里 `weknora-run` 这一行（或命令行 `--patch` 覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。别改成 `0.0.0.0`：服务没有额外的访问控制 |
| `port` | `18080` | 固定端口便于收藏；被占用时自动退到空闲端口，并在结果 `note` 里说明。`0` = 每次随机 |
| `dataDir` | `''` | 留空即 `$DSH_HOME/weknora`；填绝对路径可把数据放到别的盘 |
| `startupTimeoutMs` | `120000` | 首次建库较慢；之后通常 1 秒内就绪 |
| `stopOnDispose` | `true` | 插件卸载时是否停止服务 |
| `extraEnv` | `{}` | 追加给子进程的环境变量，例如 `OLLAMA_BASE_URL` |

## 运行时目录

```
$DSH_HOME/weknora/
  runtimes/<版本>/config/  migrations/sqlite/   # 从包内复制（约 0.2 MB）
  data/weknora.db  data/files/                  # 数据库与本地上传
  logs/server.log                               # 子进程完整输出
  weknora.env                                   # 自动生成，含随机 SYSTEM_AES_KEY / JWT_SECRET（0600）
  run.json                                      # 供下次启动收养的端口记录
```

二进制和前端 `web/` 留在包里只读使用（`WEKNORA_WEB_DIR` 指过去），所以升级插件即升级服务，
不需要重新解压 270 MB。

## 打包

仓库不含二进制。从一份构建好的 WeKnora checkout 复制资源：

```sh
node scripts/sync-assets.mjs --source /path/to/WeKnora
```

脚本从 WeKnora 仓库/worktree 复制 `WeKnora-lite`、`web/`、`config/`、`migrations/sqlite/`、
`licenses/` 与许可证文件，生成 `assets/manifest.json`（版本、二进制大小与 SHA-256）。
当前只提供 `darwin-arm64` 资产。

本机 `assets/darwin-arm64` 实测体积：

| 部分 | 大小 |
|---|---|
| `WeKnora-lite` | 247.4 MB |
| `web/` | 22.5 MB（227 个文件） |
| 合计 | **270.4 MB**（362 个文件） |

## 故障排查

| 现象 | 处理 |
|---|---|
| 工具报「二进制与资源缺失」 | 包内 `assets/darwin-arm64` 不完整，重新执行 `sync-assets` 后打包 |
| 保存 Key 报「没有 credentials 服务」 | 该组合未提供 `ctx.credentials`；桌面版与 web profile 都有 |
| 启动超时 | 看 `$DSH_HOME/weknora/logs/server.log`；首次建库慢属正常，可调大 `startupTimeoutMs` |
| 端口不是 18080 | 18080 被占用，结果里的 `note` 会写明实际端口 |
| 页面打不开但工具返回成功 | 确认浏览器访问的是结果里的 `baseUrl`（可能已回退端口） |
| 重启后提示「未配置 API Key」 | 检查 `$DSH_HOME/.credentials.yaml` 里是否还有 `WEKNORA_API_KEY`；没有就重新保存一次 |
| Gatekeeper 拦截二进制 | 分发的是未签名的 adhoc 二进制；`xattr -d com.apple.quarantine <path>` |
| 迁移被中断（`dirty database`） | 只可能发生在首启迁移时强杀；删掉 `$DSH_HOME/weknora/data/weknora.db*` 重新建库 |

## 许可

插件代码 MIT。随包分发的 WeKnora 为 MIT（含第三方组件声明），
见 `assets/darwin-arm64/LICENSE` 与 `assets/darwin-arm64/THIRD_PARTY_NOTICES.md`。
