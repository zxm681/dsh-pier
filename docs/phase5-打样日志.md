# 阶段 5 打样日志：DSH Editor Bridge Protocol v1

> 状态：进行中。每个里程碑记实际做法、实测结果、踩到的坑。
> 日期：2026-10-21。

---

## 一、待验证点实测结果（阶段4 §8 提出的 4 个问题）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | `ctx.provide` vs `Service` 基类 | **用 `ctx.provide(name, 普通对象)`**，不需要 cordis | 见下 1.1 |
| 2 | 独立 npm 包的第三方插件能否 bare-import `@deepseek-ai/*` | 能（GUI 进程内有 loader hook），但**我们不需要**——零依赖可行 | 见下 1.2 |
| 3 | 同包多拷贝是否被 cordis 去重 | 待测（里程碑 4 时验） | — |
| 4 | `fs.watch` 在 Windows 的行为 + 多实例仲裁 | 待测（里程碑 3 时验） | — |

### 1.1 `ctx.provide` 是可传普通对象的底层原语

实测脚本 `work/scripts/probe-cordis-api.mjs`，用 asar 里的 cordis 4.0.5 真身跑：

```
ctx.provide: function        ctx.reflect.provide: function
ctx.provide('dshVscodeKit', {hello:()=>'world'}) 成功，dispose 类型 = function
ctx.get('dshVscodeKit') === plain ? true
ctx.dshVscodeKit === plain ? true
dispose 后 ctx.get: undefined
inject: ['foo'] 的插件 apply(c) 里 c.foo = { v: 42 }   ← 纯字符串数组够用
```

**结论**：`Service` 基类只是糖衣，`Service` 构造器内部走的就是 `ctx.reflect.provide(name, this, check)`。
所以协议库可以**完全零依赖**：DSH 侧不 import `@deepseek-ai/cordis`，消费者也不 import。

### 1.2 第三方插件在 GUI 进程里确实能 bare-import `@deepseek-ai/*`

- `dsh-agy-link@...` 的 `dist/index.js` 第 6-9 行是运行时真 import：
  `import * as dshLlm from "@deepseek-ai/dsh-llm"`、`import { defineTool } from "@deepseek-ai/dsh-tools"`。
- 而 `~/.dsh/profiles/desktop/node_modules/@deepseek-ai/` 里**只有** `cosmokit` 和 `schemastery`，没有 `dsh-llm`/`dsh-tools`。
- `@deepseek-ai/cordis@4.0.5` 与全部 `dsh-*` 都在 `resources/app.asar/dsh/node_modules/@deepseek-ai/` 里（asar 内 100+ 包）。
- 结论：正常 GUI 进程有模块解析 hook，插件能 bare-import asar 里的包。这与「VSCode 扩展 spawn 的 dsh 子进程拿不到 hook」是两个不同环境（见 phase1 报告）。

**但打样仍然选择零依赖**，理由：asar 内的解析 hook 属未公开契约，版本走廊风险 #1 正对着它；
`ctx.provide` 已经证明零依赖可行，没有任何理由去赌那个 hook。

### 1.3 配置 schema 的取舍（偏离官方约束，需记录）

`dsh-plugin-guide` 要求「配置用 Schemastery `Schema<Config>`，禁止普通对象」。
但实测第三方插件 `dsh-agy-link` 的声明是：

```ts
declare function apply(ctx: Context, entryConfig?: Record<string, unknown>): void;
```

即纯 `Record`，且在真实 profile 里正常工作。判断：该约束面向仓库内官方插件。
**打样按 `dsh-agy-link` 先例用普通对象 + 防御性解析**，把这条写进经验手册（阶段 7）供后续决策。

---

## 二、里程碑 1：协议核心库（src/protocol.js）

- 316 行，零依赖，只做「字节行 ↔ JSON-RPC 消息 ↔ 待决 Promise」，不碰 net/fs。可注入任意 writer 单测。
- 15 条单测全绿。

### 踩到的坑

**坑 1（真 bug，已修）**：`createLineSplitter` 原本没剥 CRLF，只有 `handleLine` 剥。
测试用例 `'{"c":3}\r\n'` 直接暴露——期望 `{"c":3}`，实际拿到 `{"c":3}\r`。
虽然 `JSON.parse` 容忍尾部 `\r`，但一旦做字符串级比较或日志就会踩。修在分帧层（更靠前）。

**坑 2（设计决定）**：超时定时器要 `unref()`。
否则 CLI/单测里一个挂起的请求会让 Node 进程退不出去。

**坑 3**：迟到响应必须静默丢弃，不能当错误上报。
超时后对端仍可能回包，若上报会污染 `onError` 观测点。

---

## 三、里程碑 2：TCP server + 发现文件（src/server.js）

- 端口区间 7410–7419（避开 dsh-vscode-bridge 的 7310–7319），全占则显式报错不静默。
- 发现文件 `~/.dsh/dsh-vscode-kit/<pid>.json`：临时文件 → chmod 0600 → rename（原子）。
- 死 pid 清扫用 `process.kill(pid, 0)`；`EPERM` 视为存活。
- 15 条单测全绿（含端口顺延、死 pid 清扫、损坏文件容错、只监听 loopback）。

### 踩到的坑

**坑 4（真 bug，已修，最值得记）**：`server.close()` 挂死 120 秒。
根因：`cleanup()` 只 `link.close()`（协议层关闭），**没有 destroy socket**；
`server.close()` 要等所有连接结束，于是永远等不到。
修法：`cleanup()` 里 `link.socket?.destroy()`；`close()` 再加一次 `setTimeout(resolve, 500).unref()` 兜底。
👉 **经验：任何「优雅关闭」都必须显式销毁底层资源，协议层的 close ≠ 传输层的 close。**

**坑 5（真 bug，已修）**：每个 server 实例各挂一套 `SIGINT`/`SIGTERM`/`exit` 监听，
起第 11 个实例时触发 `MaxListenersExceededWarning`。
修法：进程级单例钩子 `ensureExitHooks()` + `exitCleanupRegistry` Set 分发。
👉 **经验：可多次实例化的库，绝不能把 `process.on(...)` 写在构造函数/工厂里。**

**坑 6（测试自身的 bug，但教训通用）**：测试里的收件箱 `inbox.push(msg)` + 同时 `resolve` 等待者，
导致同一条消息被消费两次（先给等待者，又留在队列里）。
修法：有等待者就直接交付，**不要先入队**。
👉 **经验：写测试脚手架时，「队列 + 等待者」二选一路径必须互斥，否则会造出假 bug 掩盖真 bug。**

**坑 7**：Windows 上 `chmod` 常被忽略，`writeFileSync(..., {mode:0o600})` 不一定生效。
处理：显式再 `chmodSync` 一次并 try/catch 兜住，不因此让启动失败。

---

## 四点五、里程碑 2.5：DSH 侧插件入口（src/index.js）

- 330 行。插件形状照 `dsh-agy-link` 先例：`export const name` / `export const inject = []` / `export function apply(ctx, config)`。
- **零依赖**：不 `import '@deepseek-ai/cordis'`，服务注册走 `ctx.provide('dshVscodeKit', facade, check)`。
- `apply` 立即返回 handle（`{boot, kit, disposed, stopped}`），真正的 server 启动挂在 `boot` Promise 上，**不阻塞 DSH 启动**。
- 生命周期：`ctx.effect(() => () => { ... })` —— effect 返回 disposer，卸载时关 server、删发现文件、断开所有等待者。
- `process.on` 钩子放在**模块级单例**里（`ensureExitHooks()`），不在 apply 里注册（对应坑 5）。
- 消费者 API：`ctx.dshVscodeKit.request(method, params, opts)` + 糖衣 `kit.vscode.openFile()/getSelection()`。
- 21 条单测（含 4 条 apply 端到端）全绿，总计 37 条。

### 踩到的坑

**坑 8（测试脚手架的 bug，白查两轮）**：假 cordis ctx 的 `effect` 实现错了。
`effect(fn)` 在 cordis 里的契约是**立刻执行 fn，并把 fn 的返回值当 disposer**；
我写成了 `disposers.push(fn)`，于是 `runDisposers()` 又跑了一遍 fn、拿到一个没人执行的 dispose 函数。
表象极具误导性：①「卸载后发现文件还在」②`await handle.stopped` 永久挂起 → 单测 90 秒超时。
👉 **经验：写 fake ctx / mock 之前，先读一遍真实实现的契约。** mock 写错造成的假 bug 比真 bug 更贵，因为它伪装成产品 bug。
👉 同时顺手改产品代码：给 handle 加 `stopped` Promise，让「等等，卸载真的完成了吗」有可等待的锚点，而不是 `setTimeout(50)` 赌运气。

**坑 9（脚手架路由第三次踩）**：假编辑器的三路消息分流（响应 / 请求 / 通知）必须互斥。
早期版本把「服务端→客户端的请求」当通知吞进 inbox，导致 `svc.request('vscode.getSelection')` 永远没人应答。
👉 **经验：写双向协议的测试替身时，先写一张「消息种类 → 去处」的表，再落代码。**
   - 有 id + 无 method → 响应 → `link.handleLine`
   - 有 id + 有 method → 请求 → `link.handleLine`
   - 无 id → 通知 → inbox/waiters

**坑 10（测试设计）**：`bridge.ping` 是**编辑器 → DSH** 方向的协议方法，不是消费者 API。
第一版测试用 `svc.request('bridge.ping')` 验证消费者链路，方向反了，自然超时。
👉 **经验：验收测试要照着「用户故事的方向」写**——消费者要的是 `vscode.getSelection`，就用它验。

---

## 五、里程碑 3：VSCode 薄扩展（dsh-kit-bridge）

**结果：完成。17 条单测全绿，vsix 打包成功（11 KB）。**

### 5.1 分层与「可测性」的取舍

一开始想直接 `import * as vscode from 'vscode'` 写能力实现，试了一下发现全部逻辑都被
绑死在扩展宿主里，`node --test` 一行都跑不了。最终分三层：

| 文件 | 是否 import 'vscode' | 职责 |
|---|---|---|
| `src/capabilities.js` | **否**（host 注入） | 能力的唯一实现处，可单测 |
| `src/connector.js` | **否**（deps 注入） | 发现/连接/握手/重连，可单测 |
| `src/vscode-host.js` | 是（唯一） | vscode API 适配器，薄到几乎没有逻辑 |
| `src/extension.js` | 是 | activate/deactivate 胶水 |

**收益是立刻可见的**：`capabilities.test.js` 10 条 + `connector.test.js` 7 条都在
普通 node 里跑，总耗时不到 300ms。如果不分层，这些测试要么写不了，要么得靠
`@vscode/test-electron` 起整个 VSCode（打样阶段太重了）。

### 5.2 三个刻意的协议决定

1. **坐标 1-based 对外**。VSCode API 内部是 0-based，但协议对外一律 1-based ——
   DSH 侧是给人和 AI 看的，日志里 `line 3` 比 `line 2` 少一次脑内换算。
   转换只发生在 `capabilities.js` 的边界上（`toZeroBased`），且非法值退回 0 而不是抛错
   （AI 传 `line: 0` 很常见，不该让整次调用失败）。
2. **未实现能力回 `-32005` 而不是 `-32601`**。`-32601` 是「协议层方法不存在」= 编程错误；
   `-32005` 是「对端不支持这个能力」= 应该降级。DSH 侧据此决定是重试还是换路子。
3. **二进制文件走系统打开**。`pic.png` 用文本编辑器打开会抛
   `File seems to be binary`（Fengze233 的 issue #33），所以 `BINARY_EXT` 集合里的
   一律 `env.openExternal`，返回 `mode: 'external'` 让调用方知道发生了什么。

### 5.3 坑 11：分派链忘了 fallthrough（E2E 抓到的真 bug）

`connector.js` 的 `handleInbound` 最初只认 `bridge.ping` / `bridge.hello`，
**漏了把能力分派接进去**：

```js
// 错的版本
function handleInbound(method, params) {
  const fn = inbound[method]
  if (fn) return fn(params)
  throw new BridgeError(ERR.METHOD_NOT_FOUND, ...)   // ← vscode.* 全落这里
}
```

后果：DSH 侧发任何 `vscode.openFile` 都收到 `-32601 unsupported inbound method`。
**单测完全测不出来** —— 我的单测是直接测 `capabilities.dispatch`，绕过了 connector 的分派；
只有 `connector.test.js` 的真 TCP 端到端测试才暴露它。

修法是补 fallthrough 到 `dispatch`。教训：**中间层的分派链必须从最外层入口测起**
（DSH 侧 `link.request` → 走完整条链路），不能只测它下面那一层的函数。所谓「被测单元」
如果选错了层，覆盖率高也是假的。

### 5.4 坑 12：unref() 让裸 node 进程秒退

connector 里所有定时器与 socket 都 `unref()`——这是**故意的**：库不许延长宿主进程寿命。
但写 E2E fixture 时踩了：裸 node 脚本 `start()` 之后进程立刻 exit 0，测试报
「editor exited early」。

修法是在 fixture 里自己 `setInterval(() => {}, 1000)`。真实 VSCode 扩展宿主本身长活，
不受影响。**教训**：库代码 `unref()` 是对的，但所有「用裸 node 跑这个库」的场景
（E2E、CLI、脚本）都必须自己挂 keepalive，这件事得写进使用说明，否则每个使用者都会踩一次。

### 5.5 坑 13：refactor 抽包时删掉了仍在用的 import

把发现文件逻辑从 `server.js` 抽到 `discovery.js` 时，我把 `randomBytes`、`join`、
`mkdirSync` 等 import 一起从 `server.js` 删了——但那几个符号在 `server.js` 里还有别处要用。
结果 15 条 server 测试全红，报 `ReferenceError: randomBytes is not defined`。

这次恢复很快（跑一次测试就看到），但教训明确：**抽包改 import 后必须立刻跑全量单测**，
只跑新包会漏。而且"这个 import 只给那段代码用"这个判断经常是错的。

## 六、里程碑 4：demo 消费者 + 真机 E2E

**结果：完成。demo 7 条单测全绿；真机 E2E 11/11 通过。**

### 6.1 demo 是「解耦度」的试金石

`packages/dsh-kit-demo/src/index.js` 存在的唯一理由是回答一个问题：
**第三方插件接这个桥，要耦合多少东西？**

答案是：只 import 协议库的公开 API，且这个文件里**搜不到** `tcp`、`port`、`token`、
`discovery`、`vscode`、`cordis` 任何一个词。它只做：

```js
export const inject = ['dshVscodeKit']          // 纯声明，不 import cordis
const kit = ctx.get('dshVscodeKit')
const sel = await kit.vscode.getSelection()     // 全部复杂度都在这一行背后
```

7 条单测里有 3 条在验降级：无活动编辑器、服务缺失、空选区。打样阶段刻意把
**失败路径的测试写得比成功路径多** —— 因为失败路径才是插件装到别人机器上时最常走的。

### 6.2 真机 E2E：为什么非做不可

单测都在同一进程里，用假 ctx / 假 host。这带来一个危险的假象：
**所有东西看起来都通，因为根本没有进程边界。** 真正会出问题的地方恰恰在边界上：

- 发现文件的写入与读取是两个进程、两个时刻，原子性够不够；
- token 真的跨进程传递了吗（还是被同一进程的内存共享蒙过去了）；
- DSH 重启后端口可能变、pid 变、发现文件换名，编辑器能不能重新找到它；
- 一方进程死掉时另一方是立刻知道还是永远等下去。

`scripts/e2e.mjs` 起**两个真实进程**，中间只有 loopback TCP 与真实文件，11 项断言全过：

```
PASS 无 DSH 时编辑器保持 idle 不崩
PASS DSH 侧插件启动并监听
PASS 编辑器自动发现并连上 DSH（跨进程）
PASS 发现文件字段齐全 — port=7410 proto=1
PASS token 是 64 位 hex
PASS vscode.openFile 跨进程成功 — {"opened":true,"path":"/ws/e2e/target.txt","mode":"text"}
PASS 编辑器侧真的执行了打开动作
PASS vscode.getSelection 跨进程成功 — {"text":"selected-text",...}
PASS 选区坐标 1-based — {"line":5,"column":1}
PASS 未实现能力回 -32005
PASS DSH 重启后编辑器自动重连
=== 11/11 passed ===
```

### 6.3 坑 14：E2E 脚手架自己会竞态

`waitLine(child, /OPENED/)` 一开始用一次性 `stdout.on('data')` 监听，结果 `OPENED` 那行
在挂监听之前就被消费掉了 → 误报失败。修法是**按进程累积全部输出**（`child.output += s`），
`waitLine` 先查已累积字符串再挂监听。

同类坑还有一个：`stdio: ['ignore','pipe','pipe']` 会让 `child.stdin` 是 `null`，
写进去就 `Cannot read properties of null`。要驱动子进程必须给 `'pipe'`。

**教训**：测试脚手架 bug 的代价被严重低估 —— 它伪装成产品 bug，让人去改没坏的东西。
三次 E2E 失败里有两次最后发现是脚手架问题（另一个是 5.4 的 unref）。

### 6.4 打样交叉验证的完整数字

| 层 | 测试 | 数量 | 结果 |
|---|---|---|---|
| kit（DSH 侧） | protocol / server / apply | 37 | 全绿 |
| bridge（编辑器侧） | capabilities / connector | 17 | 全绿 |
| demo（消费者） | 降级与形状 | 7 | 全绿 |
| 跨进程 | scripts/e2e.mjs | 11 项断言 | 全过 |

total: **61 条单测 + 11 项真机断言**。

### 6.5 vsix 产物

```
dsh-kit-bridge-0.1.0.vsix  (5 files, 11 KB)
├─ extension/package.json
├─ extension/readme.md
└─ extension/out/extension.cjs   (23.83 KB, 零外部依赖)
```

用 stub 的 `vscode` 模块验证过 `require('./out/extension.cjs')` 能加载，
exports = `activate, deactivate`。本机 VSCode 1.142.0，可 `code --install-extension`。

---

## 十、真机验证抓出的四个真 bug（阶段6 回顾补充）

真机验证（真 DSH 进程 + 真 VS Code）抓出四个单测和 E2E 都发现不了的缺陷，
全部已修并加回归测试：

### 坑 15 ★：`ctx.provide` 的 check 谓词不是「异步就绪」的表达方式

写成 `ctx.provide('dshVscodeKit', facade, () => kit !== null)`，期望「监听就绪后消费者才可用」。

**实际行为**（cordis `lib/index.js:1306-1315`）：check 是 `get` 时的门禁，
谓词为假就把实现从 store 删掉；谓词变真之后**没有任何机制重新 notify**。

真机现象：`dsh: warning: 1 entry did not activate` + `waiting for services: unknown`，
消费者永久 pending。

探针对照（`work/scripts/probe-provide-check.mjs`）：
- 不传 check → 消费者正常激活
- check 恒 false → 消费者永不激活
- check 恒 true → 正常

**修法**：去掉 check，无条件 expose facade；需要等的消费者显式调 `waitReady(ms)`。

### 坑 16：facade 的就绪前占位返 `{}` 制造裸 TypeError

`get vscode() { return kit?.vscode ?? {} }` → 监听未就绪时消费者拿到 `{}`，
调用得 `kit.vscode.openFile is not a function` —— 没有错误码、没有原因，最糟的失败形态。
更隐蔽的后果：消费者若解构方法（`const { openFile } = kit.vscode`），监听后来就绪了也永远好不了。

**修法**：糖衣方法做成稳定存在的转发函数，调用时才判断就绪并回 `-32007 server-not-ready`。

### 坑 17：糖衣方法丢参数

`openFile: (params) => this.request('vscode.openFile', params)` 只传一个参数，
消费者传的 `opts`（`timeoutMs` / `waitForEditor`）被静默吞掉。
单测没发现，因为单测没走糖衣传 opts 的路径。**修法**：补 `opts` 透传。

### 坑 18：配置监听过宽会杀掉正在执行的操作

`if (!e.affectsConfiguration('dshKit')) return` → 任何 `dshKit.*` 变更都 `reloadWindow`。
真机事故：临时打开 `dshKit.selfTestOnStart` 的瞬间，正在跑的自检被 reload 杀掉，
结果 JSON 没写出来，表现像「代码没跑完」。

**修法**：枚举需要重建宿主的键（`RESTART_KEYS = ['dshHome','pollIntervalMs']`），
`enabled` 走 start/stop 热切换，其余键直接忽略。

### 附：我自己的 smoke 探针也有一个误判 bug

demo 的 `openFile` 把错误吞成 `{ok:false}`（不抛），而探针只 catch 异常、不看返回值，
于是第一轮 smoke 报 `pass: true` 却三步全失败。
**教训**：探针的判定要连「业务失败」一起看，不能只 catch 异常。

---

## 阶段 8（手册指导开发）：加两个新能力，验证手册可操作性

按 `phase7-经验手册.md` 的「加新能力三步」实践，新增 `vscode.getDiagnostics`
与 `vscode.listOpenEditors`（都是只读，不注入编辑器、不静默发消息，符合 phase2 红线）。

### 结果：手册有效，但漏了一条

三步流程本身对：①capabilities.js 加 handler + CAPABILITIES ②扩展自检加步骤
③重打包装真机。两个能力一次通过单测与 E2E。

**但真机自检抓到一个手册没写的问题**：`hasFixture: false` —— 见下。

### 坑 19：同一个文件，两个能力回传的路径大小写不同

真机自检 9/9 全 PASS，但断言 `list.editors.some(e => e.file === target)` 返回 `false`。

| 来源 | 返回值 |
|---|---|
| `vscode.openFile` | `C:\Users\...\selftest.txt`（调用方传入的原样） |
| `vscode.getSelection` | `c:\Users\...\selftest.txt`（VSCode URI 的 fsPath，盘符小写） |

**根因**：Windows 上 VSCode 的 `uri.fsPath` 会把盘符小写化，而 `openFile` 直接回传
`host.resolvePath()` 的结果。消费者按字符串比较同一文件必然失败。

**修法**：加 `canonicalPath()` 在协议出口统一大写盘符，四个能力全部过它，
并补回归测试（`test/capabilities.test.js` 末条）。

**教训（已写进手册 §4.7/§4.8）**：
- 一个值若会从两个以上来源回传给同一个消费者，出口必须归一化。
- 自检不能只断言单步 ok，要断言**跨能力的同一性**。单步 ok 只证明没抛错。

### 版本与产物
- `packages/dsh-kit-bridge` 0.1.0 → **0.2.0**（`package.json` + `EXTENSION_VERSION` 同步）
- vsix：`dsh-kit-bridge-0.2.0.vsix`（5 files, 13.7 KB），`code --install-extension --force` 装真机
- 自检 9 步全 PASS：`~/.dsh/dsh-vscode-kit/selftest-21788.json`（VSCode 1.142.0）

### 全量回归
```
kit   38 / 38
bridge 23 / 23   ← 新增 1 条 canonicalPath 回归
demo   7 / 7
E2E   13 / 13
合计   68 单测 + 13 E2E 断言
```
