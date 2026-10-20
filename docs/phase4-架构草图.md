# 阶段 4 架构草图：VSCode ↔ DSH 桥接协议库（v0.1 打样版）

> 状态：完成。经主人确认后可进入阶段 5 模板打样。
> 日期：2026-10-21。

---

## 一、四段式链路（总览）

```
┌─────────────┐   公开 API    ┌──────────────┐  loopback TCP   ┌──────────────┐  vscode API   ┌──────────┐
│ 消费者插件   │ ───────────→ │ 协议库        │ ──────────────→ │ 薄扩展         │ ────────────→ │ VS Code  │
│ (demo 等)   │              │ dsh-vscode-kit│   ndjson        │ dsh-kit-bridge │              │ 官方能力 │
│             │ ←─────────── │ (DSH 侧)     │   JSON-RPC 2.0  │ (VSCode 侧)   │ ←──────────── │          │
└─────────────┘  响应/事件    └──────┬───────┘                 └──────────────┘               └──────────┘
                                    │ 写发现文件 ~/.dsh/dsh-vscode-kit/<pid>.json（0600）
                                    ▼
                              ┌─────────────┐
                              │ 发现文件目录 │ ← VSCode 扩展轮询/监听，连 startedAt 最新者
                              └─────────────┘
```

消费者（DSH 插件）永远只 import 协议库的公开 API，不知道 TCP/端口/发现文件的存在 —— 这就是解耦的命根子。

## 二、包结构（单 repo 三包，不用 monorepo 工具）

```
projects/dsh-vscode-dev/
├── packages/
│   ├── dsh-vscode-kit/        # ① DSH 侧协议库（npm 包）：cordis 插件 + 客户端 API
│   │   ├── package.json       #   name: dsh-vscode-kit（已查证未占用）
│   │   ├── src/
│   │   │   ├── index.js       #   cordis 插件入口：apply(ctx) 起 TCP server + 注册 service
│   │   │   ├── server.js      #   TCP server、端口扫描、发现文件、死 pid 清扫
│   │   │   ├── protocol.js    #   ndjson 分帧、JSON-RPC 配对、超时、错误传播
│   │   │   ├── registry.js    #   能力注册表 + namespace 路由
│   │   │   └── client.js      #   消费者 API（request/notify + 糖衣方法）
│   │   └── test/              #   node:test 单测
│   ├── dsh-kit-bridge/        # ② VSCode 侧薄扩展（本地 vsix，不上 Marketplace）
│   │   ├── package.json       #   name: dsh-kit-bridge
│   │   ├── src/
│   │   │   ├── extension.js   #   activate：发现文件监听、连接管理、生命周期
│   │   │   ├── authorizer.js  #   token 校验 + 首次握手确认（globalState 记住）
│   │   │   └── capabilities.js#   openFile / getSelection 实现
│   │   └── test/
│   └── dsh-kit-demo/          # ③ 示例消费者插件（证明第三方零耦合接入）
│       └── src/index.js       #   只 import dsh-vscode-kit 公开 API
├── docs/                      # 各阶段文档（已在）
└── scripts/                   # E2E 辅助脚本
```

## 三、协议规范：DSH Editor Bridge Protocol v1

### 3.1 传输与分帧

- TCP，仅 127.0.0.1；端口区间 **7410–7419** 扫描取首个空闲（避开 dsh-vscode-bridge 的 7310–7319）。
- ndjson：每行一条 JSON-RPC 2.0 消息；分帧用 Node 内置 `readline`（JSON 内换行已被 stringify 转义，无粘包问题）。
- 每请求顶层带 `token` 字段（照抄 dsh-vscode-bridge 已验证模式）。

### 3.2 发现文件

`~/.dsh/dsh-vscode-kit/<pid>.json`：

```json
{
  "port": 7413,
  "token": "<hex64>",
  "pid": 12345,
  "startedAt": 1792519000000,
  "dshVersion": "0.2.1-rc.2",
  "protocolVersion": 1,
  "capabilities": ["vscode.openFile", "vscode.getSelection"]
}
```

规则：0600、临时文件 + rename 原子写、进程退出删除、server 启动时清扫死 pid 残留。目录名与 Fengze233 的 `~/.dsh/vscode-bridge/` 隔离，互不干扰。

### 3.3 消息与错误码

```
请求: {"jsonrpc":"2.0","id":1,"method":"vscode.openFile","params":{"path":"...","line":1},"token":"..."}
响应: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}
错误: {"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"unauthorized"}}
```

| 错误码 | 含义 | 触发 |
|---|---|---|
| -32001 | unauthorized | token 错误/缺失 |
| -32002 | declined | 用户在首次握手弹窗点了拒绝 |
| -32003 | not-found | 文件不存在 / 无活动编辑器 |
| -32004 | timeout | 请求超时（默认 30s） |
| -32005 | unsupported | 能力族缺失（服务降级路径） |
| -32006 | untrusted-workspace | Workspace Trust 受限 |
| -32600/-32601/-32602 | 标准 JSON-RPC | 非法请求/方法不存在/参数非法 |

### 3.4 握手（连接建立后第一件事）

```
→ {"jsonrpc":"2.0","id":0,"method":"bridge.hello","params":{"client":"dsh-vscode-kit","protocolVersion":1,"dshVersion":"...","capabilities":[...]},"token":"..."}
← {"jsonrpc":"2.0","id":0,"result":{"ok":true,"authorized":true|false,"extensionVersion":"0.1.0"}}
```

扩展侧：token 校验通过但未授权 → 弹窗「允许 DSH 桥接请求吗？（身份：dsh-vscode-kit）」；同意后 `globalState` 记 token 哈希（再次连接免弹）；拒绝回 -32002。**这是首版唯一授权面**（逐能力白名单明确 out of scope）。

## 四、公开 API 面（解耦的命根子，先定死）

### 4.1 DSH 侧消费者 API（v1 只此一面）

```js
// 消费者插件里：
const kit = ctx.dshVscodeKit;                    // cordis service 注入（注册方式见 4.3）

await kit.request('vscode.openFile', { path, line?, column? });
const sel = await kit.request('vscode.getSelection');
// sel = { status:'ok', text, path, line, column } 或 { status:'no-editor'|'empty' }

// 糖衣（可选，等价）：
await kit.vscode.openFile({ path });
const sel = await kit.vscode.getSelection();
```

- 方法名 = 能力命名空间（`vscode.` 前缀），registry 按前缀路由 —— 未来多扩展/多能力族只需加前缀。
- 多消费者：同一 DSH 进程内共享协议库单例（cordis 按包名去重），请求 id 全局唯一（单调 + 随机前缀），响应按 id 路由回发起者，天然并发安全。
- 版本升级只扩 API、不破坏 v1 语义；能力缺失返回 -32005 而非崩溃。

### 4.2 VSCode 侧扩展对外只有「能力实现 + 授权」

- 实现：`openFile` = `openTextDocument` + `showTextDocument` + `revealRange`（line/column 映射为 Range + selection）；`getSelection` = `activeTextEditor` 选中区文本，无编辑器/空选区返回结构化状态而非报错。
- 配置项最小集：`kit.portRange`（默认 7410-7419）、`kit.enabled`。其余一律不加。

### 4.3 DSH 侧 cordis 集成方式（待打样核实的点）

- 插件入口 = 函数式 cordis 插件 `apply(ctx)`；服务注册计划用 `ctx.provide('dshVscodeKit', instance)`（若 0.2.1 线有 schemastery 类型注入则换 `ctx.service(...)`——**此 API 形态以打样时实测为准**，属版本走廊风险 #1）。
- 目标：消费者拿服务的姿势与官方插件拿官方服务一致，不发明新机制。

## 五、技术栈与依赖清单

| 包 | 运行时依赖 | 开发依赖 | 打包 |
|---|---|---|---|
| dsh-vscode-kit | **无**（net/fs/crypto/readline 全 Node 内置） | 无（node:test 即可） | 不需要 |
| dsh-kit-bridge | 无（net/fs 内置 + vscode API） | @types/vscode、esbuild | esbuild 单文件出 out/extension.js（学 Fengze233） |
| dsh-kit-demo | 仅 dsh-vscode-kit（file: 本地依赖） | 无 | 不需要 |

零运行时依赖是刻意选择：DSH client 插件有 `ERR_MODULE_NOT_FOUND` 前科，内置模块是最稳的依赖面。

## 六、安全模型（首版边界）

1. 传输仅 127.0.0.1；token 每实例随机（crypto.randomBytes(32)）。
2. 发现文件 0600 + 原子写 + 退出回收 + 死 pid 清扫。
3. 首次握手弹窗授权，globalState 按 token 哈希记住。
4. 所有拒绝路径返回结构化错误码，不静默挂起。
5. 明确不做：注入/编辑、逐能力白名单、远程隧道。

## 七、版本走廊与降级

- 握手双向报版本；扩展收到未知 protocolVersion 拒绝连接并提示升级。
- capabilities 列表驱动：扩展只实现列出的能力；DSH 侧对缺失能力回 -32005。
- 协议库自检：启动时探测 cordis 关键 API 是否存在，缺失则在发现文件里标 `degraded:true` 并降级为仅日志模式。

## 八、待验证点（打样前必须实测，不赌）

1. `ctx.provide` vs `ctx.service` 在 DSH 0.2.1-rc.2 的确切用法（影响 API 面 4.1）。
2. 函数式 cordis 插件 + 独立 npm 包（有真实 node_modules）在正常 DSH GUI 进程的加载行为（与「扩展 spawn 的 dsh」是两种环境，前者应支持正常 import——待实测）。
3. 同包多拷贝时 cordis 是否按包名去重为单 server。
4. VSCode 扩展发现文件监听（fs.watch 在 Windows 的行为）+ 多实例仲裁。

## 九、打样里程碑（阶段 5 的路线）

1. 协议核心库 + 单测（分帧/配对/超时/错误/并发）→ 绿。
2. TCP server + 发现文件 + 死 pid 清扫 → 单测绿。
3. VSCode 薄扩展 + 授权弹窗 → 手动装 vsix。
4. demo 插件 → 真机 E2E：DSH 里调 openFile/getSelection 全链路打通。
5. 验收对照 phase2 第六节 6 条标准。
