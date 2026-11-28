# dsh-workbuddy

[English](README.md) | 中文

把本机已登录的 **WorkBuddy** 桌面端接到 DeepSeek Harness，作为一个模型供应商。
没有 OAuth、没有复制 token、不用二次登录——插件直接复用 WorkBuddy App 已经存在
于这台机器上的登录态。

这里只做核心实现：凭据发现、模型目录、chat 流式转发、一次 provider 注册。

## 它做什么

- **只读**读取 WorkBuddy 桌面端的 auth 文件。新版桌面端把 token 写成加密字段，
  插件向已安装的 App 要它自己的字段密钥，而不是随包分发密钥副本。
- 注册一个名为 `workbuddy` 的 DSH provider。区域由凭据域名决定：国内版走
  `copilot.tencent.com`，国际版走各自的品牌网关（`www.workbuddy.ai` /
  `www.codebuddy.ai`）。
- 从上游 `/v3/config`（App 自己读的那份文档）刷新模型目录，每 15 分钟重新通告。
  模型选择器仅列出目录中的 DeepSeek 系列模型，其他上游模型 id 仍可通过显式配置解析。
- 通过直接实现 `LlmAdapter` 转发 chat 补全、推理增量、工具调用与 token 用量。
  不依赖 pi-ai，也没有 loopback shim——适配器自己面对网关。
- 提供本机诊断端点，可查看连接/目录状态、区域、模型数量与最近错误码，也可手动刷新目录；不返回凭据或账号标识。

## 前置条件

- DeepSeek Harness，`@deepseek-ai/dsh-llm` `0.1.7+` / `0.2.x`。
- 本机已安装并登录 WorkBuddy 桌面端。
- macOS 是实测路径（含加密凭据）。Linux / Windows 的 auth 路径会探测，纯字符串
  token 的文件可用；加密字段的密钥目前只从 macOS App bundle 取。

## 安装

```sh
dsh plugin --profile web add link:/插件所在绝对路径/dsh-workbuddy
```

`dsh plugin add` 会自动登记 bundle，下次启动 profile 时 `cordis.patch.yml`
生效、provider 就被加载。插件没有客户端部分，不需要重新构建前端，重启 profile
即可。

如果 profile 的 `dsh.profile.bundles`（`~/.dsh/profiles/web/package.json`）里
没有出现 `dsh-workbuddy`，手动加进去再重启。

## 配置

全部可选，写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-workbuddy
  name: dsh-workbuddy
  config:
    authFile: /custom/path/workbuddy-desktop.info
    catalogRefreshMs: 900000
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `authFile` | 平台默认路径 | 显式指定要读的 auth 文件（优先于 `WORKBUDDY_AUTH_FILE`） |
| `catalogRefreshMs` | `900000` | 目录刷新间隔；小于 `60000` 的值回落默认 |

诊断入口：

```text
GET /plugins/dsh-workbuddy/status
GET /plugins/dsh-workbuddy/status?refresh=1  # 手动触发一次目录刷新后返回状态
```

仅接受来自 loopback 主机的请求。响应包含 `state`、`checkedAt`、`lastSuccessAt`、`signedIn`、`region`、`modelCount` 和 `lastErrorCode`；不会返回 auth 文件路径、token 或账号标识。刷新失败时状态为 `error`（尚无可用目录）或 `degraded`（保留上次成功目录）。

环境变量：

| 变量 | 含义 |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | auth 文件覆盖 |
| `WORKBUDDY_APP_EXECUTABLE` | 桌面端可执行文件路径，用于取字段密钥 |

## 工作原理

```text
DSH llm seam
  └─ WorkBuddyAdapter            (lib/adapter.js)
       ├─ CredentialStore        (lib/auth.js)  ── 桌面端 auth 文件（只读）
       │    └─ at-rest.js        ── ELECTRON_RUN_AS_NODE → App 的 loggerGet() → AES-256-GCM
       ├─ catalog.js             ── GET /v3/config
       └─ upstream.js            ── POST /v2/chat/completions（SSE）
```

网关有三条 OpenAI 兼容协议之外的门：

1. 会话必须以 `system` 消息开头；
2. 请求要带会话身份三件套（`X-Conversation-ID`、`-Request-ID`、`-Message-ID`）；
3. `system` / `assistant` 文本里出现 DSH 自己的身份句会被 `11128` 拒绝。网关
   匹配前会归一化不可见字符，所以零宽断词无效；插件改写实测过的措辞，若仍被拒
   则在中性开头后面整段重试一次。

token 刷新（`/v2/plugin/auth/token/refresh`）只在过期前 5 分钟内发生，刷新结果
留在进程内存；桌面端文件永远不被写入。

## 刻意不做

- 账号池 / 多账号切换
- 积分、签到、活动
- OAuth / 扫码登录
- 生图、生视频
- 逐模型的启用 / 图片 / 思考开关
- loopback shim（适配器自己持有 token）
- 请求指纹实验

## 验证

```sh
npm test           # 单元测试，不联网
node test/live.mjs # 真的走一遍 DSH 的 llm seam，默认用免费模型
```

`test/live.mjs` 会启动一个带真实 `dsh-llm` 服务的 cordis 应用，确认 provider
注册成功、目录加载（开发机的国内版账号 18 个模型）、流式拿到一次工具调用，再把
工具结果回传拿到最终回答。默认模型是 `hy4flash-free`（倍率 `x0.00`）；传一个
模型 id 可以换别的模型，费用自负。

另外也在真实 DSH profile 里验证过：一个隔离的 headless profile 把
`agent-default-model` 指到 `workbuddy/hy4flash-free`，能正常启动、注册
provider 并回答一条 agent 任务。

## 风险

WorkBuddy 的接口不是公开 API。桌面端或网关一改，插件就可能失效；是否使用请自行
评估账号风险，官方客户端始终是最安全的选择。

## License

MIT
