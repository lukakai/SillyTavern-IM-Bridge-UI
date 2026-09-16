# SillyTavern-IM-Bridge-UI

SillyTavern UI 扩展，作为 [SillyTavern-IM-Bridge](https://github.com/lukakai/SillyTavern-IM-Bridge) server plugin 的前端控制面板和网页完整模式执行器。

> 完整项目交接文档：server plugin 仓库根目录的 `PROJECT_HANDOVER.md`

## 安装

1. 先按 server plugin 仓库 README 安装并启用 `st-im-bridge`。
2. 在 SillyTavern 网页中：Extensions → **Install Extension** → 粘贴：
   ```
   https://github.com/lukakai/SillyTavern-IM-Bridge-UI.git
   ```
3. 刷新 ST 网页 → 在「Extensions」抽屉中找到「IM Bridge」并展开。

> manifest 的 `auto_update: true` **只在 ST 容器/进程启动时**对 server plugin 生效，对放在 `data/<handle>/extensions/` 下的 UI 扩展并不会随浏览器刷新自动 git pull。如果需要拉新版本，参见 `PROJECT_HANDOVER.md` 坑点 1（手动 `git fetch + git reset --hard origin/main` + 浏览器 `Ctrl+Shift+R` 硬刷新）。

## 功能

- **个人 Bot**：填写 Telegram Bot Token、启停按钮、状态/Username/最新错误。
- **TG 绑定**：网页内点「生成绑定码」获取 6 位短码（5 分钟内 mm:ss 倒计时），用户在 Telegram 私聊 bot 发送 `/bind <code>` 即可把自己的 numeric ID 加入白名单。已绑定列表中每个用户带「解绑」按钮。
- **压缩配置**：调整 keepRecent / batchSize / timeoutMs / retryCount / retryDelayMs。
- **管理员视图**（admin 用户可见）：跨账号查看与启停他人 bot。
- **网页完整模式中继**：在当前浏览器中显式启用后，领取 Telegram 生成任务，切换到指定角色/会话并调用 SillyTavern 原生 `Generate()`。世界书、预设、Persona、Regex 和生成拦截器等均由网页前端按正常流程运行。
- **酒馆全局设置中继**：执行 Telegram `/api`、`/preset`、`/model` 和 `/settingsundo` 请求，复用 SillyTavern 官方前端命令；对于“双人成行”这类带网页控制面板的预设，还会同步面板顶部模型方案与当前分类布局。结果与网页全局设置一致并对所有聊天生效，只向 Telegram 返回配置名称、预设名、模型名和 prompt 开关，不返回 API 地址、密钥或 Secret ID。

## 网页完整模式

1. server plugin 和本 UI 扩展都更新到支持 `/prompt web` 的版本。
2. 使用一个专用 Chromium/Chrome profile 打开并登录 SillyTavern。
3. Extensions → IM Bridge →「网页完整模式中继」→「在此浏览器启用网页中继」。
4. Telegram 发送 `/prompt`，看到中继在线后发送 `/prompt web`。

启用状态保存在这个浏览器 profile 的 `localStorage`，不会同步到其他浏览器。同一 profile 打开多个标签页时使用 Web Locks 只允许一个标签页执行任务。中继会自动切换当前角色和会话，所以不要在日常使用的浏览器配置中启用。首次配置应使用可见窗口完成登录；之后可以复用同一 profile 启动 headless Chromium。

每次领取生成任务后，中继会清空 SillyTavern 前端的世界书读取缓存。这样通过 Telegram `/worldbook` 保存的独立世界书内容会在下一次原生生成时重新读取，无需手动刷新页面。

全局设置任务只在页面空闲时执行；网页正在生成时会直接拒绝。每次修改前会在当前专用浏览器 profile 的 `localStorage` 保存一层完整状态（当前连接配置、预设、预设内模型方案、酒馆模型及 prompt 开关），供 `/settingsundo` 恢复。快照只保存在该 profile，不上传 GitHub，也不会经 Telegram 传输。连接设置当前没有绑定已保存 Connection Manager 配置时，为保证能完整恢复，中继会拒绝从 Telegram 切换连接配置。

中继只访问同源 `/api/plugins/st-im-bridge/web-relay/*` 路由，复用 SillyTavern 登录态与 CSRF Token，不保存 Telegram Token、Basic Auth 密码或模型密钥。

### Mac mini 无头运行

仓库的 `relay-runner/` 使用系统已安装的 Google Chrome，不会另外下载 Chromium。Basic Auth 密码优先从 macOS 钥匙串读取：

```sh
cd relay-runner
cp config.example.json config.json
nano config.json
npm install --omit=dev
security add-generic-password -U \
  -a '你的 Basic Auth 用户名' \
  -s 'SillyTavern IM Bridge Basic Auth' \
  -T /usr/bin/security \
  -w
node runner.mjs config.json
```

`security` 会安全提示输入密码，不必把密码写入命令历史或 `config.json`。运行器启动独立 Chrome profile，并在页面加载前启用中继。若酒馆还启用了用户账号登录，把 `headless` 暂时改为 `false`，在可见窗口完成一次登录后再切回 `true`。

### Telegram 远程控制无头浏览器

`/relay refresh` 可以直接让已经在线的中继页面刷新。要从 Telegram 启动、停止或重启 Mac mini 上的无头浏览器，还需要在 Mac mini 安装固定动作控制器；它只接受 `start`、`stop`、`restart`、`refresh` 和 `status`，不能执行任意命令。

先在 Mac mini 为控制器写入一个至少 24 位的随机 Token 到钥匙串（此 Token 不要提交到 Git）：

```sh
security add-generic-password -U \
  -a 'relay-control' \
  -s 'SillyTavern IM Bridge Relay Control' \
  -w
```

然后在 `relay-runner/config.json` 中保留 `controller` 配置，并安装控制器：

```sh
cd relay-runner
node install-controller.mjs config.json
```

控制器默认监听 `0.0.0.0:38712`，Tower 需要能通过内网访问 Mac mini 的这个端口。将相同 Token 作为 Tower 的 `RELAY_SUPERVISOR_TOKEN`，并设置 `RELAY_SUPERVISOR_URL=http://MAC-MINI-LAN-IP:38712` 后重启 SillyTavern。完成后 Telegram 可用：

```text
/relay status
/relay refresh
/relay start
/relay stop
/relay restart
```

## 探测与降级

展开「IM Bridge」抽屉时，扩展会先 `GET /api/plugins/st-im-bridge/probe`：
- 返回 204 → 正常渲染主面板。
- 任何失败（404 / 网络错误 / 插件未启用）→ 渲染「IM Bridge 服务端插件未安装」提示页（含 `enableServerPlugins: true` 与 `git clone` 步骤），不抛异常、不影响其他扩展。

抽屉关闭时不发任何请求；`probe()` 仅在抽屉首次展开时跑一次。

## 数据流

写操作经 `api(method, path, body)` 工具函数：
1. 自动 `GET /csrf-token` 缓存 token。
2. 写请求带 `x-csrf-token` 头与 `credentials: same-origin`。
3. 收到 `403` 且响应含 `csrf` 字样 → 清缓存重试 1 次。
4. 错误统一通过 `toastr.error` 弹窗提示。

SSE 路由（`/messages/send-stream`、`/messages/redo-stream`、`/compress/run`）由 server 端推送 `started` / `delta` / `progress` / `done` / `error` 事件，UI 实时更新进度。
