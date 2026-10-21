# DSH Pier

**让 DSH 插件停靠 VS Code 的码头。**

把 VS Code 的能力（打开文件、读选区、读诊断、列已开编辑器）开放给**任意 DSH 插件**，
方式是标准化的通道 + 公开 API，而不是让每个插件各自去写一遍 VSCode 集成。

> 项目内部代号 `dsh-vscode-dev`（目录名沿用），对外名 **DSH Pier**（仓库 `dsh-pier`）。

## 这个项目解决什么

DSH 是一个跑在自己进程里的 agent 宿主；VS Code 是另一个进程里的编辑器。
DSH 插件想"帮用户打开某个文件"时，**两边内存不共享，`vscode` 模块在 DSH 进程里根本不存在**。

现有方案（`dsh-vscode-panel`）走的是另一条路：把 DSH 页面塞进 VS Code 面板的 iframe，
靠 webview postMessage 传消息。那条路要改 DSH 页面、要处理 cookie 与快捷键穿透，
而且能力只对"那个 iframe 里的页面"有效，第三方 DSH 插件用不上。

我们走对等发现：

```
消费者 DSH 插件 (dsh-kit-demo)
      ↓ 只用公开 API：kit.vscode.openFile / getSelection / getDiagnostics
协议库 (dsh-vscode-kit)          ← 零依赖、传输无关、不 import cordis
      ↓ loopback TCP + ndjson + token（+ 发现文件）
VS Code 薄扩展 (dsh-kit-bridge)  ← 全项目唯一 import 'vscode' 的地方
      ↓ 官方 API
VS Code
```

## 现状

**打样完成，六条验收标准全过。** 四段式链路已在真机（真 DSH 进程 + 真 VS Code）跑通。

| 阶段 | 产物 | 状态 |
|---|---|---|
| 1 盘点 | `phase1-盘点报告.md` | ✅ |
| 2 需求 | `phase2-需求文档.md` | ✅ |
| 3 可行性 | `phase3-可行性分析.md` | ✅ GO |
| 4 架构 | `phase4-架构草图.md` | ✅ |
| 5 打样 | `phase5-打样日志.md` + `packages/` | ✅ |
| 6 验收 | `phase6-验收报告.md` | ✅ 6/6 |
| 7 经验 | `phase7-经验手册.md` | ✅ |
| 8 手册指导开发 | 按手册加了 `getDiagnostics` / `listOpenEditors` | ✅ 抓到出口路径 bug |
| 9 安全审计 | 教学答疑时挖出三个安全洞 | 洞 1、2 已修并真机复验；洞 3 已知未修 |

## 三个包

| 包 | 作用 | 版本 | 测试 |
|---|---|---|---|
| `packages/dsh-vscode-kit` | DSH 侧协议库 + TCP server + 发现文件 + 插件入口 | 0.1.0 | 48 ✅ |
| `packages/dsh-kit-bridge` | VS Code 侧薄扩展（VSIX 可装） | 0.2.0 | 23 ✅ |
| `packages/dsh-kit-demo` | 示例消费者，证明零耦合接入 | 0.1.0 | 7 ✅ |

合计 **76 条单测 + 13 项跨进程 E2E**，全绿。

## 快速开始

```bash
# 1. 装 VS Code 扩展
code --install-extension packages/dsh-kit-bridge/dsh-kit-bridge-0.2.0.vsix --force

# 2. 把库放进共享 node_modules（DSH 的 bare import 从 profiles/node_modules 解析）
cp -r packages/dsh-vscode-kit  ~/.dsh/profiles/node_modules/
cp -r packages/dsh-kit-demo    ~/.dsh/profiles/node_modules/

# 3. 起 DSH（overlay 注入，不改任何 profile 文件）
dsh --profile web --patch ./work/realtest-overlay.yml --port 3099 --no-open
```

消费者插件这么用：

```js
export const name = 'my-plugin'
export const inject = ['dshVscodeKit']

export function apply(ctx) {
  const kit = ctx.get('dshVscodeKit')
  // 一行调用，不知道 TCP / 端口 / token / 发现文件的存在
  await kit.waitReady(5000)
  await kit.vscode.openFile({ path: 'D:/x/y.txt', line: 2, column: 1 })
  const sel = await kit.vscode.getSelection()
}
```

## 跑测试

```bash
cd packages/dsh-vscode-kit   && node --test "test/*.test.js"   # 48
cd packages/dsh-kit-bridge   && node --test "test/*.test.js"   # 23
cd packages/dsh-kit-demo     && node --test "test/*.test.js"   # 7
cd packages/dsh-kit-bridge   && node scripts/e2e.mjs           # 13 跨进程
```

打包 VSIX：

```bash
cd packages/dsh-kit-bridge && node scripts/build.mjs && npx --yes @vscode/vsce package --no-dependencies
```

## 能力面

| 能力 | 参数 | 返回 |
|---|---|---|
| `vscode.openFile` | `{path, line?, column?, preview?}` | `{opened, path, mode:'text'\|'external'}` |
| `vscode.getSelection` | — | `{text, file, start:{line,column}, end, isEmpty}` |
| `vscode.getDiagnostics` | `{path?, severity?, limit?}` | `{total, files:[{file, diagnostics:[…]}], truncated}` |
| `vscode.listOpenEditors` | `{limit?}` | `{editors:[{file, isActive, isDirty, languageId?}], total, truncated}` |

**坐标约定**：协议对外一律 **1-based**（line/column），只在调用 VS Code API 的边界转 0-based。
**路径约定**：对外一律 `C:\…` 大写盘符（出口归一化，见经验手册 §4.7）。

错误码：

| 码 | 名字 | 含义 |
|---|---|---|
| -32001 | `unauthorized` | token 缺失或错误 |
| -32002 | `declined` | 用户拒绝 |
| -32003 | `not-found` | 文件/编辑器不存在 |
| -32004 | `timeout` | 对端未及时响应 |
| -32005 | `unsupported` | 对端不支持该方法（**应降级**） |
| -32006 | `untrusted-workspace` | 工作区未信任 |
| -32007 | `disconnected` | 没有编辑器连上 |

`-32005` 与 `-32601` 的区别：前者是"能力协商没通过，你该降级"，
后者是"方法名根本不存在，是编程错误"。

## 安全模型

这条通道被授予的是**编辑器能力**，所以边界要说清楚。

| 防线 | 拦什么 | 拦不住什么 |
|---|---|---|
| 只监听 `127.0.0.1` | 局域网、外网 | **本机任何进程**（同用户下的任意程序都够得着） |
| 256 位随机 token | 猜不到的凭证 | 凭证本身被读到（同用户可读发现文件） |
| **准入集合 `trusted`** | 不带正确 token 的连接抢走 active 位、收到广播 | —— |
| 只读或打开动作 | 改动你代码内容 | —— |

七条诚实的说明：

1. **本机不是安全边界**。token 防的是「本机别的进程冒充编辑器」，不是防「本机进程读你的文件」。
   同用户下任何进程都能读发现文件拿到 token —— 这是设计上的取舍，不是遗漏。
2. **首版刻意不做编辑器内容注入**。能读选区、能开文件，但不能往你正在写的文件里写东西。
3. **洞 3 仍开着**：协议层的响应分支不做 token 校验（见 `phase7-经验手册.md` §5.9 与
   `phase5-打样日志.md` 阶段 9）。它需要单独一轮设计，不要顺手改。
4. **出站消息带不带 token，按消息类型区分**（`packages/dsh-vscode-kit/src/protocol.js`）：
   `request()` 自动附带（`protocol.js:174`）；`notify()` 与 `respond()` **默认不带**，
   调用点显式 `{withToken:true}` 才带（`protocol.js:200`、`protocol.js:212`）——
   曾经默认就带，等于把通行证白送（洞 1）。
   **已知限制**：`respondError()` 没有 `withToken` 通道（`protocol.js:219`、`protocol.js:229`），
   错误响应恒不带 token。这是接口不对称，不是文档矛盾。而未认证者收到的 `-32001`
   **绝不附送凭据**——那条响应本身就是对「凭证无效」的回答。
5. **准入由 `trusted` 集合表达，不靠 `link.authorized`**。连接建立 ≠ 准入：至少发过一条
   token 正确的消息才算准入，此时这条连接从 `links` 升格进 `trusted`（`server.js:124-126`、
   `server.js:155-166`、`server.js:171-179`）。`link.authorized` 只保留作诊断/兼容，
   **不再承担安全边界**；`links` 只做存活登记与关闭时的资源销毁，**不作请求/广播目标池**。
   换句话说，以后即使有人忘写过滤，也挑不到未准入的 socket。
6. **活跃目标 = 已准入连接里 `connSeq` 最大的那条**，即按「连接先后」挑（`index.js:78-93`）。
   这里刻意不写成「最后准入」：`trusted` 是在首次准入时 add 的，取集合末项等于「最后准入优先」；
   而拆分前的实现（`[...links].filter(authorized).at(-1)`）是「最后连接优先」。逆序握手
   （connect A → connect B → 先准入 B → 后准入 A）时两种口径会选出**不同窗口** ——
   这是评审 R1 抓到的回归，所以在 `server.js:130-137` 定死连接序号，`_activeLink()` 比 `connSeq`。
7. **广播只发给已准入连接**（`server.js:243-246`）。这是**有意收紧的契约变更**，不是实现细节：
   未准入的连接不该收到通知，因为通知里可能带选区文本这类内容。

**已知限制与残余风险**（证据与判断边界见 `docs/威胁模型-通道可达面.md`；以下按该文的措辞，不拔高也不淡化）：

- **发现文件里的 token 是明文**，同用户进程可读 —— 这是设计取舍，不是遗漏。
- **Windows 上 `chmod 0600` 不具强制力**：Node 里对文件设 `0600` 后实测 `stat` 得到的仍是
  `666`（`discovery.js:44-55` 把 chmod 标为 Windows 上的 best effort），所以 Windows 侧的保护
  实际依赖发现目录的位置与回环绑定 —— 不要把它当成 DACL 隔离承诺。
- **不能宣称「浏览器绝对不可达」**：已有抽样显示 HTTP POST 正文含合法 ndjson 且携带**正确
  token** 时 `dispatched=1`；但 DNS rebinding 把主机名解析到 loopback，**不等于能取到 token**。
  请求体可控性 ≠ 知道凭据。
- **仍未验证，不要读成已支持**：多窗口仲裁的实际行为、macOS/Linux、VS Code 1.91–1.141
  版本区间、长期运行稳定性。

## 明确不做

编辑器内容注入、逐能力授权白名单、多 VSCode 仲裁、Remote/WSL 反向、
Marketplace 发布、面板 UI。详见 `phase2-需求文档.md` 的 out-of-scope。

## 已知未验证

多窗口仲裁行为、macOS/Linux、VS Code 1.91–1.141、长期运行稳定性。
详见 `phase7-经验手册.md` §8。

## 文档导览

| 想了解 | 读这个 |
|---|---|
| 现有方案怎么做的、我们差在哪 | `phase1-盘点报告.md` |
| 需求边界与验收标准 | `phase2-需求文档.md` |
| 为什么可行、哪些确实不可行 | `phase3-可行性分析.md` |
| 架构与协议细节 | `phase4-架构草图.md` |
| 打样过程（含 19 个坑） | `phase5-打样日志.md` |
| 验收证据 | `phase6-验收报告.md` |
| **要动手改代码就先读这个** | `phase7-经验手册.md` |
