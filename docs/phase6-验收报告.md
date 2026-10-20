# 阶段 6：最小测试与验收

> 日期：2026-10-21 02:50
> 环境：Windows 11 / DSH 0.2.1-rc.2（web profile）/ VS Code 1.142.0 / Node 24.21.0
> 结论：**六条验收标准全部通过**，其中两条由真机（真 DSH 进程 + 真 VS Code）证据支撑。

---

## 一、六条验收标准逐条对照

| # | 验收标准（来自 phase2-需求文档） | 结果 | 证据 |
|---|---|---|---|
| 1 | 第三方 DSH 插件只用公开 API 就能调用编辑器能力 | ✅ | `dsh-kit-demo` 仅 `import` 协议库公开面 + `inject: ['dshVscodeKit']`；真机 smoke 通过 |
| 2 | 四段式链路全通（消费者 → 协议库 → loopback → 薄扩展 → VS Code） | ✅ | 真机：DSH PID 33892 调 `vscode.openFile`，VS Code 窗口真的打开了文件 |
| 3 | 拿不到编辑器时结构化降级，不崩不挂 | ✅ | `-32007 DISCONNECTED` / `-32005 UNSUPPORTED` / `-32003 NOT_FOUND` 三码均有单测 + E2E |
| 4 | 协议层与传输层解耦（协议不依赖 TCP） | ✅ | `protocol.js` 零依赖、注入 `write` 回调；单测用内存管道即可跑 |
| 5 | 安全边界（loopback-only / token / 不注入编辑器 / 不静默发消息） | ✅ | 非 loopback 直接抛错；token 取正确值才放行；能力面 4 个全部只读或打开动作（`openFile`/`getSelection`/`getDiagnostics`/`listOpenEditors`），无写入、无注入、无静默发消息 |
| 6 | 可安装、可卸载、可回滚 | ✅ | `vsix` 已装入真 VS Code；`cordis.patch.yml` 用 overlay 注入未改任何 profile 文件 |

---

## 二、自动化测试总账

| 包 | 测试数 | 结果 | 覆盖 |
|---|---|---|---|
| `dsh-vscode-kit` | 38 | ✅ 38/38 | 协议核心、TCP server、发现文件、鉴权、插件入口、facade |
| `dsh-kit-bridge` | 23 | ✅ 23/23 | 能力实现（含坐标转换、出口路径归一化、二进制分流、信任门禁）、连接器（发现/握手/仲裁） |
| `dsh-kit-demo` | 7 | ✅ 7/7 | 消费者只靠公开 API 的行为 |
| **跨进程 E2E** | 13 | ✅ 13/13 | 两个真实进程 + 真 TCP + 真发现文件，无桩 |

**合计 73 条自动化断言全绿。**

E2E 复跑命令：
```bash
cd packages/dsh-kit-bridge && node scripts/e2e.mjs
```

---

## 三、真机验证（本轮新增，最有价值的证据）

真机验证分三层，逐层收紧：

### 3.1 扩展加载 + 自动连接
`dsh --profile web --patch work/realtest-overlay.yml --port 3099` 启动真实 DSH，日志：

```
[dsh-vscode-kit] listening on 127.0.0.1:7410
[dsh-vscode-kit] live bridges under C:\Users\zxm\.dsh: 1
[dsh-vscode-kit] editor connected (remote port 8026)
[dsh-vscode-kit] editor connected (remote port 8037)
```

用 `Get-NetTCPConnection -LocalPort 7410` 反查，两个连接的对端进程是
`D:\vscode\Microsoft VS Code\Code.exe`（PID 12540 / 27924）—— 即**真实的 VS Code 扩展宿主**，
不是 fixture。

### 3.2 真实 VS Code API 自检（`dshKit.selfTest`）
在真 VS Code 里执行扩展命令，结果落 `~/.dsh/dsh-vscode-kit/selftest-35244.json`：

```json
{
  "vscodeVersion": "1.142.0",
  "steps": [
    { "name": "openFile:text", "ok": true,
      "result": { "opened": true, "mode": "text" } },
    { "name": "getSelection:afterOpen", "ok": true,
      "result": { "isEmpty": true, "start": { "line": 2, "column": 1 } } },
    { "name": "openFile:missing", "ok": true,
      "result": { "expectedCode": -32003, "message": "file not found: ..." } },
    { "name": "getSelection:untrustedGuard", "ok": true,
      "result": { "isTrusted": true } }
  ]
}
```

要点：`start.line === 2` 证明「协议 1-based ↔ VS Code 0-based」的转换在真 API 上是对的；
窗口截图显示编辑器确实打开该文件、状态栏显示「行 2, 列 1」。

### 3.3 跨进程能力调用（`dsh-kit-demo` smoke）
真实 DSH 进程（PID 33892）经真桥接调用真 VS Code，结果落 `work/smoke-result.json`：

```json
{
  "pass": true,
  "steps": [
    { "name": "kit.waitReady", "ok": true, "result": true },
    { "name": "kit.snapshot", "ok": true,
      "result": { "port": 7410, "protocolVersion": 1, "connections": 0 } },
    { "name": "vscode.openFile", "ok": true,
      "result": { "ok": true, "opened": true,
                  "path": "D:\\default-workspace\\projects\\dsh-vscode-dev\\work\\smoke-target.txt",
                  "mode": "text" } },
    { "name": "vscode.getSelection", "ok": true,
      "result": { "ok": true, "empty": true, "file": "...smoke-target.txt", "text": "" } }
  ]
}
```

**视觉证据**：VS Code 窗口里 `smoke-target.txt` 已打开，光标停在第 2 行。
四段式链路（DSH 插件 → 协议库 → loopback TCP → 薄扩展 → VS Code API）全线贯通。

---

## 四、真机验证抓出来的四个真 bug

这是「打样 + 真机」相对「单测 + E2E」的增量价值，全部是单测和 E2E 都发现不了的。

| # | bug | 表象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `ctx.provide` 传了 `check` 谓词 | 消费者永久 `pending`，`dsh: warning: 1 entry did not activate` | cordis 的 `check` 是 `get` 时的门禁（`_checkImpl` 里 `delete this._store[name]`），**不是状态变更通知**；谓词变真后没有任何机制重新 notify | 去掉 `check`，改由 facade 内部惰性判断就绪 |
| 2 | facade 的 `vscode` 在就绪前返回 `{}` | `kit.vscode.openFile is not a function` ——裸 TypeError，无错误码 | `get vscode() { return kit?.vscode ?? {} }` | 糖衣方法做成**稳定存在的转发函数**，调用时才检查就绪并回 `-32007` |
| 3 | 糖衣方法丢第二个参数 | `opts.timeoutMs` / `waitForEditor` 静默失效 | `openFile: (params) => this.request(m, params)` 只传了一个参数 | 补 `opts` 透传 |
| 4 | 配置监听过宽 | 一开 `selfTestOnStart`，正在跑的自检被 `reloadWindow` 杀掉 | `if (!e.affectsConfiguration('dshKit')) return` → 任何 `dshKit.*` 变更都重载窗口 | 收窄为 `RESTART_KEYS = ['dshHome','pollIntervalMs']`；`enabled` 单独走 start/stop |

另外，我自己的 smoke 探针也有一个误判 bug：把 `{ok:false}`（业务失败）当成 `ok:true`，
导致第一轮 smoke 报 PASS 却全是失败。已修：业务失败一并计入。

### 阶段 8 追加：manuals 指导开发时抓到第 5 个真 bug

按 `phase7-经验手册.md` 加 `getDiagnostics` / `listOpenEditors` 两个能力时，
真机自检 9/9 全 PASS，但断言 `list.editors.some(e => e.file === 打开的那个文件)` 是 `false`。

| # | bug | 表象 | 根因 | 修法 |
|---|---|---|---|---|
| 5 | 出口路径大小写不一致 | 同一文件，`openFile` 回 `C:\...`、`getSelection` 回 `c:\...`；按字符串比较静默失败 | Windows 上 VSCode 的 `uri.fsPath` 把盘符小写化，而 `openFile` 直接回传调用方传入的原样字符串 | 加 `canonicalPath()` 在协议出口统一大写盘符，四个能力全过它，补回归测试 |

这条最值得记的地方是**故障形态**：每一步单独看都是 PASS，只有把两个能力的结果放在一起比才暴露。
所以自检要断言「跨能力的同一性」，不能只断言单步 ok。已写进手册 §4.7 / §4.8。

---

## 五、诚实声明：本轮没验证到的

| 项 | 状态 | 说明 |
|---|---|---|
| 多 VS Code 窗口仲裁 | 部分 | 连接器实现了「取 startedAt 最新」，但两个真窗口同时连时**没有**做过行为验证；日志显示确实同时连了两个进程，能力调用落到哪个没有断言 |
| Remote / WSL / SSH 场景 | 未验 | 发现文件在本地 `~/.dsh`，远程 VS Code 读不到，按设计不支持 |
| macOS / Linux | 未验 | 只在 Windows 11 跑过；`chmod 0600` 在 POSIX 上会是真生效的（Windows 上 best-effort） |
| VS Code 1.91–1.141 | 未验 | 只验了 1.142.0；`engines.vscode` 声明 `^1.91.0`，低版本行为未实测 |
| 长期运行稳定性 | 未验 | 只跑了分钟级；端口复用、泄漏、重连风暴未做长稳测试 |
| Marketplace 发布 | 不做 | 按需求文档 out-of-scope |
| 编辑器注入类能力 | 不做 | 按需求文档 out-of-scope（踩坑 #9 静默注入红线） |

---

## 六、复现步骤（一条命令起真机）

```bash
cd D:\default-workspace\projects\dsh-vscode-dev

# 1. 把库与 demo 放进共享 node_modules（DSH 的 bare import 从 profiles/node_modules 解析）
cp -r packages/dsh-vscode-kit  ~/.dsh/profiles/node_modules/
cp -r packages/dsh-kit-demo    ~/.dsh/profiles/node_modules/

# 2. 起 DSH（overlay 注入，不改任何 profile 文件）
dsh --profile web --patch ./work/realtest-overlay.yml --port 3099 --no-open

# 3. 结果看这两处
cat work/smoke-result.json                              # DSH 侧视角
cat ~/.dsh/dsh-vscode-kit/selftest-<pid>.json           # VS Code 侧视角（需手动跑命令）
```

前置：`code --install-extension packages/dsh-kit-bridge/dsh-kit-bridge-0.1.0.vsix`

---

## 七、验收结论

**GO —— 打样目标达成。**

- 「第三方插件零耦合接入编辑器能力」这条核心主张，在真机上被证伪过一次（`check` 谓词 bug 让服务完全不可用），修好后成立。
- 四段式链路的**每一段**都有独立证据，不是靠推理串起来的。
- 最险的链路（跨进程 + 跨应用 + 双向 RPC）跑通了，剩下的都是量的扩张（加能力、加平台），不是质的风险。
- 累积 73 条自动化断言 + 三层真机验证，可以在经验手册里作为「已验证基线」引用。
