# 阶段 1 盘点报告：VSCode ↔ DSH 桥接生态

> 状态：**阶段 1 完成**。本地拆解 + 生态调研（子代理 2ded82fa）均已合并进本文件；方向已定（B：桥接协议库），下一步进入需求访谈。
> 方法：直接阅读本机实际安装的产物（`C:\Users\zxm\.vscode\extensions\fengze233.dsh-vscode-panel-0.4.3\` 与 `C:\Users\zxm\.dsh\profiles\node_modules\dsh-vscode-bridge\`），结合 `readme.md` / `changelog.md` 作者自述；生态侧以 `npm view <pkg> readme` 一手全文为主、web_search 为辅（本环境 web_fetch 不可用）。

---

## 一、结论先行

1. **VSCode 原生不接入 DSH 是事实**，但现成的成熟方案已存在且作者是国人、MIT 协议、文档极好：`Fengze233/dsh-vscode`（扩展 `dsh-vscode-panel` 0.4.3 + 桥接 `dsh-vscode-bridge` 0.4.3，同版本号绑定发布）。
2. 它已经解决的问题恰好覆盖主人设想的大部分「痛苦点」：自动启动/鉴权/桥接文件跳转/剪贴板/图片降级。
3. **但它的桥接通道是「点对点消息协议」，不是「DSH 插件 ↔ VSCode 通用能力面」**。留给我们的空间不是「再造一个面板」，而是：
   - 给 dsh-vscode 加能力（比如：把 DSH 工具调 VSCode、会话上下文注入编辑器选择）；或
   - 做一个「桥接协议库」供其它 DSH 插件复用；或
   - 补作者明确砍掉的能力（0.4.2 撤回的「编辑器上下文联动」是重灾区，值得研究）。
4. 本机 DSH 是 **0.2.1-rc.2**（最新线，19 条破坏性变更适用），扩展自述兼容 DSH 0.1.2+。

---

## 二、dsh-vscode-panel 扩展结构（VS Code 侧）

构建产物单文件 `out/extension.js`（约 3080 行，esbuild 打包），逻辑模块清晰：

| 模块 | 职责 | 关键函数 |
|---|---|---|
| 服务管理 | 探测/启动/复用 `dsh web` | `resolveLaunch`（解析 stdout 的 launch URL 与 token）、进程管理、启动超时 45s |
| 鉴权 | 一次性 token 换会话 cookie | `exchangeSession`：请求 launch URL → 303 响应 → `extractDshCookie`（`dsh-auth-` 前缀）→ 存 keyed by authority，30 天 |
| 中继 | loopback 反向代理 | `createDshProxy`：随机 127.0.0.1 端口，注入 cookie、改写 Host、**剥掉浏览器 Origin/Sec-Fetch 头**（过 DSH 浏览器信任围栏），转发 SSE/WebSocket/上传流 |
| 桥接安装 | 把 bridge 包注入 DSH profile | `installBridge` / `uninstallBridge` / `writePatchEntry` / `dedupeBridgeEntries` |
| Webview | iframe 承载 DSH 页面 | 各状态页（loading/error/disconnected/auth/stopped/ready）+ 握手脚本 |

### 桥接安装机制（要复用必须吃透）

1. `detectProfileDir(dshHome, profile)`：找 `$DSH_HOME/profiles/<dsh.profile>`（默认 `web`）。
2. 目标目录候选（按序）：`<profile>/node_modules/dsh-vscode-bridge` → `<profiles>/node_modules/dsh-vscode-bridge` → npm 全局 node_modules。
3. 把内置的 `out/bridge-client/` 整个复制过去（`copyBridgeDir`），bridge 包版本必须与扩展版本一致，不一致强制重装。
4. 在 `<profile>/cordis.patch.yml` 写入标记段：

```yaml
# dsh-vscode-bridge: begin
- insert:
    - id: dsh-vscode-bridge
      name: dsh-vscode-bridge
# dsh-vscode-bridge: end
```

5. 卸载 = 移除标记段 + 删目录；特判 `was-empty-array`（原 patch 是空数组时恢复成 `[]`）；多 profile 共享副本时只有最后一个卸载才删共享副本。
6. 安全细节（changelog 0.4.3）：遍历 `profiles/` 时要求「名字合法、非符号链接、realpath 仍在 profiles 内」，防符号链接把 DSH_HOME 之外的文件改写。

**本机现状**：`C:\Users\zxm\.dsh\profiles\web\cordis.patch.yml` 已含该 insert 段，`profiles\node_modules\dsh-vscode-bridge\` 存在且版本 0.4.3。

## 三、dsh-vscode-bridge（DSH 侧 client 插件）

`lib/index.js`（host 侧，25 行）+ `lib/client.js`（浏览器端，1344 行）。**零依赖是硬约束**。

### 零依赖的根因（重要工程教训）

VS Code 扩展宿主 spawn 的 dsh 进程拿不到 dsh 内部模块加载 hook，include 条目回退「裸 ESM import」路径，解析锚点是 cordis-plugin-loader 自身位置。任何外部 import（如 `@deepseek-ai/cordis`）都会 `ERR_MODULE_NOT_FOUND`。解法：**cordis 函数式插件**（`typeof plugin === "function"` 直接作为插件回调）→ 零 import 单文件。注意 ESM 严格模式函数 `name` 属性只读，须 `Object.defineProperty(plugin, "name", …)` 且 name 必须等于 package.json 的 name。

### 注册方式（DSH 官方 client 插件扩展点）

```js
window.__ModuleLoader__.load({
  id: "dsh-vscode-bridge",           // 必须等于 package.json name
  factory: (require) => { /* 纯逻辑 core.js 内联，exports.apply = (ctx) => { dshCtx = ctx } */ }
});
```

`package.json` 有 `"dsh": { "client": { "inject": [], "platform": "web" } }` —— `inject` 必须静态数组。

### 消息协议（iframe ↔ 扩展宿主，postMessage）

| 方向 | kind | 载荷 |
|---|---|---|
| 宿主→页面 | `bridgeHello` | `{ token, imageFallback }`（握手，token 非空才生效） |
| 页面→宿主 | `bridgeAck` | `{ ok, version }`（握手回执，version=BRIDGE_VERSION 供扩展日志核对） |
| 页面→宿主 | `openExternal` | `{ url }`（http/https 白名单校验后才转） |
| 页面→宿主 | `openFile` | `{ path, cwd?, missReason? }`（cwd 取法 = DSH 官方前端 `ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd`） |
| 页面→宿主 | `saveImage` / `deleteImages` | 图片降级落盘 |
| 双向 | `copyText`/`copyTextAck`、`readText`/`readTextAck` | 剪贴板桥接，带 requestId 配对 |

### 页面内能力（client.js 全览）

- **外链拦截**：捕获阶段 click，`isAllowedExternalUrl` 只放行 http/https，其余（javascript:/file:）拒绝。
- **文件入口**：`FILE_ENTRY_SELECTOR = button[class*="fileMention"], [data-produced-files-row] button[title], [data-presented-file] button[title]`，排除 `[aria-haspopup]`（宿主原生菜单）。这是 issue #22 的教训：**CSS Module 哈希类名不能 classList.contains 判断，title 才是路径**。
- **剪贴板**：覆写 `navigator.clipboard.writeText/readText` 走桥接。
- **快捷键仿真**：keydown 捕获仿真 Cmd/Ctrl+C/V/A/X/Z；手动 undo 栈（每元素、连续输入 400ms 归组、上限 100）——VS Code 吞嵌套 iframe 快捷键、React 受控输入无原生 undo 栈。
- **自定义右键菜单**：VS Code 不向 iframe 弹原生菜单，弹自定义菜单（复制/粘贴/剪切/全选/撤销/重做）。
- **图片降级**（v0.3.0，dsh.image.fallback=true 默认开）：change/drop/paste 三路捕获图片字节 → 拦截 `session.prompt` RPC 的 fetch → 模型拒绝（`attachment-error` 等码）时把图片落盘到工作区、改写消息为「原文+图片路径」重发、用新 rpcId 顶替被拒响应。生命周期：批次管理 + TTL 5 分钟 + 会话新建/切换/卸载清理。

## 四、扩展的配置与贡献点（我们加功能时的落点）

- **viewsContainers**：activitybar `dsh` + secondarySidebar `dsh-secondary`；webview 视图 `dsh.panel` / `dsh.panel.secondary`。
- **12 条命令**：openPanel/openSecondary/openExternal/restart/stop/copyUrl/showLogs/copyLogs/bridge.retry/bridge.uninstall/cleanupImageCache/openFromTitle。
- **19 项配置** `dsh.*`：profile、launchPreference(auto/npm/desktop)、desktopCommandPath、host、port、autoStart、stopOnExit、extraArgs、bridge.enabled、workspaceRootIndex、bridge.silenceWarning、executablePath、openInBrowser、remote.enabled、image.fallback、startTimeoutMs、env、useEnvProxy、panel.zoomLevel。
- **菜单**：编辑器标题栏鲸鱼图标（editor/title）、视图标题工具条 4 项。
- 构建：esbuild + tsc + node:test（318 用例），`npm run package` 出 vsix；`uninstall` 钩子走 `out/uninstall.js`。

## 五、changelog 里的踩坑史（对后续开发最有价值的肉沫）

| 坑 | 编号 | 教训 |
|---|---|---|
| DSH 文件名按钮是 CSS Module 哈希类名，`classList.contains` 恒 false | #22 | 桥接选择器必须用属性通配/结构选择器，且 title 优先 |
| macOS 吞嵌套 iframe 的 Cmd+C/V/A 与右键菜单 | vscode#129178/#180234 | 需自建快捷键仿真与右键菜单 |
| Windows cmd.exe 含空格路径二次转义报「文件名、目录名或卷标语法不正确」 | 0.4.3-test2/3 | Desktop 启动优先 `node bin.js`；cmd 用 `windowsVerbatimArguments` + `/s` 引号规则 |
| SameSite=Strict cookie 在跨站 iframe 永不可用 | 0.1.2 | 必须 loopback 中继注入 cookie + 剥 Origin 头 |
| DSH 浏览器信任围栏（Origin.host===Host 且拒 Sec-Fetch-Site: cross-site） | 0.1.2 | 中继剥头充当受信中介 |
| 相对路径按错误基准解析 | #32 | 转发携带会话 cwd（取法同官方前端），取不到不阻塞、带诊断码 |
| 切换 host/port 后桥接误报健康 | #35 | 端点变化一律作废旧握手 |
| 卸载钩子遍历 profiles 可能被符号链接引出 DSH_HOME | #35 | realpath 校验 |
| 「编辑器上下文联动」整功能撤回（注入固定当前文件路径、直接发进会话、无法选择） | #11→0.4.2 | **交互设计教训：注入内容必须让用户选择/编辑，不能静默发消息** |
| dsh 版本无稳定版、Desktop 与 npm 布局不同 | #30/#31 | 启动来源探测要双路兜底 |

## 六、生态调研合并（子代理 2ded82fa，2026-10-21）

### 6.1 重大发现：同名不同包

`dsh-vscode-bridge` 这个 npm 包名被两套方案占用，检索/装包时极易混淆：

| 包 | 作者 | 形态 | 关系 |
|---|---|---|---|
| `dsh-vscode-bridge`（npm，EPCN-fla） | EPCN-fla | DSH 侧 TCP JSON-RPC 桥 | 为 `dsh-lite-vscode` 扩展服务 |
| `dsh-vscode-bridge@0.4.3`（本机 profiles/node_modules） | Fengze233 | DSH web client 插件（零依赖函数式） | 为 `dsh-vscode-panel` 扩展服务，由扩展安装进 profile，**不在 npm 公开？**（本机副本来自扩展内置 out/bridge-client） |

### 6.2 现有方案对比表

| 方案 | 类型 | 通信机制 | 许可证 | 结论 |
|---|---|---|---|---|
| @deepseek-ai/dsh-acp | DSH 官方 ACP 服务器 | JSON-RPC over stdio（进程启动时挂接） | BSD-3-Clause | 用（官方正路；stdio 限制 + 会话不进 registry 两大缺口） |
| dsh-acp-door | 运行中内核的 ACP 接入点 | loopback TCP 每连接挂 ACP bridge；v0.2.0 加 IDE Bridge v1 | MIT | 用/参考（「驱动已运行 GUI」最直接方案） |
| dsh-vscode-bridge（EPCN-fla） | DSH 侧 TCP JSON-RPC 桥 | 端口 7310–7319 扫描 + 随机 token + `~/.dsh/vscode-bridge/<pid>.json` 发现文件（0600 原子写）+ ndjson JSON-RPC 2.0 | MIT | 参考（协议/发现文件/能力上报/多实例共存可整套照搬） |
| dsh-lite-vscode | VS Code 扩展 | 面板嵌 DSH Web UI + postMessage | 扩展侧未查证 | 参考（成品案例） |
| dsh-vscode（rainfishs）等 8+ | VS Code 扩展 | 多数是 webview 嵌 UI 型 | 未查证 | 参考（嵌 UI 是另一条路，深度桥不选） |
| dsh-vsceditor | DSH 侧插件 | webServer 控制面 + SSE 下行 + POST 上行 + 文件锁定 | 未查证 | 参考（Electron↔VSCode 完整实例，可抄架构） |
| dsh-editor-link | DSH 插件+编辑器桥 | 回环+认证；approvals/questions/editor context | 未查证 | 参考 |
| deepseekharness-acp-interactive | 面向编辑器的 ACP stdio 服务器 | JSON-RPC stdio，Zed 注册 | MIT | 参考（编辑器侧 ACP 呈现最佳实践） |
| @alex-dsh-plugin/open-in-vscode | DSH web 插件（单向） | 探测/调用 code CLI（含 Cursor shim 识别与回退） | 未查证 | 用/参考（code CLI 探测顺序可直接借鉴） |
| dsh-vscode-mode | DSH 侧 Monaco 插件 | 无（方向相反） | MIT | 不用 |

### 6.3 关键技术事实（均带来源）

1. vscode API 只在扩展宿主可用；扩展 spawn 的子进程也拿不到（issue #213521 未合入）→ 必须「DSH ↔ loopback ↔ 薄扩展 ↔ 官方 API」四段式。
2. ACP stdio 只能进程启动时挂接；驱动已运行 GUI 必须 door/bridge 型插件 + 发现文件。
3. ACP 会话不进 DSH workspace registry → Web UI 全落「未分组」；dsh-vscode-bridge（EPCN-fla）整包就是补这个缺口（workspace.attach / session.setTitle / preset.select）。
4. 对标架构：Cline/Roo Code=webview postMessage（hub-spoke）；Cody=扩展 spawn agent + JSON-RPC stdio（最接近 ACP 模型）；Continue=server-based + WebSocket。
5. DSH 插件自建本地 HTTP/TCP 服务是成熟姿势：deepseek-harness-win-desktop（8765 REST）、dsh-vsceditor（webServer + SSE）。

### 6.4 推荐通信机制（本调研结论）

- **候选 1（主推）**：loopback TCP + token 鉴权 + 发现文件 + ndjson JSON-RPC（bridge/door 模式）。DSH 侧纯 Cordis 插件、能挂已运行 GUI；扩展侧零依赖 `net.connect`；发现文件解决端口漂移与多实例；需要时把 ACP 语义作为方法子集叠上去。
- **候选 2（演进备选）**：ACP over stdio（Cody 模型，扩展 spawn 独立 DSH 进程）。协议标准、生态兼容；代价是开新内核（配置/记忆/会话不共享）。

### 6.5 12 条坑（合并 changelog 踩坑史后共 19 条，见第八节）

见下方「八、踩坑总表」。其中生态侧新增重点：

- 端口不能固定：区间扫描取空闲；多实例按 `<pid>.json` 共存，扩展取 startedAt 最新。
- 安全边界 = loopback + 发现文件：token 必须 0600 原子写、退出回收、死 pid 残留清扫。
- 版本走廊敏感：自建桥握手必须报 dshVersion + capabilities，服务缺失降级方法族而非整体崩。
- 会话状态契约：预设切换仅限空白会话、删除=归档、活会话/存储态会话方法各异——桥 API 设计要直接体现。

---

## 七、待办更新

- [ ] 作者仓库 `Fengze233/dsh-vscode` 源码结构（本机是编译产物；GitHub 细节本环境 web_fetch 不可用，未查证）——可在打样时按需补
- [x] 生态方案对比表 —— 见 6.2
- [ ] DSH 官方 client 插件扩展点 0.2.1 线确切契约（`dsh.client.inject`、`window.__ModuleLoader__` 稳定性）——需求访谈后可行性分析时核
- [x] 发力方向三选一 —— 已定：**B：桥接协议库（通用能力面），起步用 A 的通道做最小验证**（m00325 与用户确认）

## 八、踩坑总表（合并去重）

第五节 changelog 踩坑史共 10 条（A1–A10），生态调研 12 条（B1–B12），其中「DOM 漂移」「iframe 快捷键」两处重叠，去重后合计 19 条：

| 编号 | 坑 | 来源 | 对策要点 |
|---|---|---|---|
| 1 | CSS Module 哈希类名，classList.contains 恒 false | A1/B7 | 属性通配/结构选择器，title 优先 |
| 2 | VS Code 吞嵌套 iframe 快捷键与右键菜单 | A2/B6 | 自建快捷键仿真 + undo 栈 + 自定义右键菜单 |
| 3 | Windows cmd.exe 含空格路径二次转义 | A3 | Desktop 启动优先 node；/s 引号规则 |
| 4 | SameSite=Strict cookie 跨站 iframe 不可用 | A4 | loopback 中继注入 cookie |
| 5 | DSH 浏览器信任围栏（Origin/Sec-Fetch） | A5 | 中继剥头充当受信中介 |
| 6 | 相对路径按错误基准解析 | A6 | 转发携带会话 cwd，取不到不阻塞 |
| 7 | 切换 host/port 后桥接误报健康 | A7 | 端点变化一律作废旧握手 |
| 8 | 卸载钩子被符号链接引出 DSH_HOME | A8 | realpath 校验 |
| 9 | 编辑器上下文联动整功能撤回（静默注入） | A9 | 注入内容必须让用户选择/编辑，不能静默发消息 |
| 10 | dsh 无稳定版、Desktop/npm 布局不同 | A10 | 启动来源双路兜底；自建桥握手报 dshVersion |
| 11 | 外部进程永远拿不到 vscode API | B1 | 四段式：DSH ↔ loopback ↔ 薄扩展 ↔ 官方 API |
| 12 | ACP stdio 只能进程启动时挂接 | B2 | door/bridge 型插件 + 发现文件 |
| 13 | ACP 会话不进 workspace registry | B3 | 桥 API 补 workspace.attach / session.setTitle / preset.select |
| 14 | 端口不能固定 | B5 | 区间扫描取空闲；多实例按 <pid>.json 共存 |
| 15 | token/发现文件安全 | B4 | 0600 原子写、退出回收、死 pid 残留清扫 |
| 16 | Workspace Trust 禁扩展 API | B8 | restricted mode 下不启动后端/不读凭据，引导用户信任 |
| 17 | WSL2 单向连通 / Remote-SSH 端口不共享 | B9 | localhostForwarding；远端用 asExternalUri |
| 18 | code CLI 同名 shim（Cursor 等） | B10 | 探测顺序：配置 → 标准路径 → PATH；失败回退系统默认打开 |
| 19 | 会话状态契约（预设/删除/活会话） | B12 | 桥 API 设计直接体现上游契约，不发明新语义 |
