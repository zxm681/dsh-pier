# DSH 插件开发经验手册

> 来源：`dsh-vscode-dev` 打样项目的真实记录（2026-10-20 ~ 10-21）。
> 编写原则：**只写踩过的坑，不写想象的最佳实践**。每条都标注证据强度与发生场景。
> 适用环境：DSH 0.2.1-rc.2 / Node 24 / Windows 11 / cordis 4.0.5。

---

## 如何使用这本手册

1. 开工前读 §1（决策速查），避免重复已经付过代价的判断。
2. 写代码时按需查 §2–§5，每条都有代码位置或实测输出作证。
3. 排障时查 §6（症状 → 根因），按表象索引。
4. §7 是仍然未知的部分，不要当成已验证结论使用。

**证据强度标记**：
- `[实测]` 真机/真进程跑出来的，最可靠
- `[单测]` 自动化测试锁定，回归安全
- `[源码]` 读实现得出的结论，可能随版本变化
- `[推断]` 未直接验证，标记为风险

---

## §1 决策速查表

| 场景 | 结论 | 依据 |
|---|---|---|
| DSH 插件能不能零依赖？ | **能，且应该**。用 `ctx.provide` / `ctx.get` / `ctx.effect` / `ctx.on` 即可，不需要 `Service` 基类 | `[实测]` §3.1 |
| 要不要 `import '@deepseek-ai/cordis'`？ | **不要**。第三方插件能 import（宿主有 loader hook），但这是**未公开契约**；零依赖不会被这个 hook 的变更带走 | `[实测]` §3.2 |
| 服务用 `ctx.provide(name, value)` 还是 `Service` 子类？ | 纯 JS 用 `provide`；要 TS 类型推导才用 `Service` | `[源码]` §3.1 |
| `provide` 的第三个参数（check 谓词）能用来表达「异步就绪」吗？ | **绝对不能**。这是 `get` 时门禁，不是状态通知，会让消费者永久 pending | `[实测]` §3.3 ★ |
| 消费者 `inject` 一个 async 就绪的服务怎么办？ | 服务价值必须是**立即可用**的（facade/惰性代理），就绪状态在方法内部判断 | `[实测]` §3.3 |
| 配置 schema 必须用 Schemastery 吗？ | 第三方插件用普通对象 + 防御性解析是**可行**的（`dsh-agy-link` 先例） | `[实测]` §3.4 |
| `peerDependencies` 写什么区间？ | `>=0.2.1-0 <0.3.0`。这是**运行时门禁**，写错会被静默 `disabled` | `[源码]` §3.5 |
| VSCode 扩展用 CJS 还是 ESM？ | `engines ^1.91` 用 **CJS**。ESM 支持要 1.94+ 且仍有边界问题 | `[实测]` §4.1 |
| 扩展要不要 bundle？ | **要**。跨包相对 import 不 bundle 就得把 node_modules 塞进 vsix | `[实测]` §4.1 |

---

## §2 DSH 插件基础

### 2.1 插件形态 `[实测]`

```js
export const name = 'my-plugin'      // 必须等于 package.json 的 name
export const inject = ['someService'] // 字符串数组，可选
export function apply(ctx, config) { /* ... */ }
```

三种形态都存在：函数式、对象式（`export default {name, inject, apply}`）、类式（`extends Service`）。
**不需要提供 service 时，一律用函数式**——最少的概念、最少的问题。

### 2.2 `inject` 是硬依赖，不是"想要" `[实测]`

`inject: ['dshVscodeKit']` 意味着：服务不存在时插件**不会加载**（状态 `pending`），
服务消失时插件会被**卸载**。所以要区分：
- 硬依赖 → 写进 `inject`
- 可选依赖 → 不写进 `inject`，用 `ctx.get('name')` 运行时判断

我们的协议库 `inject = []` 是刻意的：它不依赖任何 DSH 服务，因此不会被别人的生命周期带走。

### 2.3 `ctx.effect` 的契约 `[实测]` ★

```js
ctx.effect(() => {
  // 立刻执行
  return () => { /* dispose 时调用 */ }
})
```

**`effect(fn)` 会立刻执行 fn，并把 fn 的返回值当作 disposer。**

坑：写 mock 时把 `fn` 本身当 disposer 收集，会导致「卸载后资源没释放」+「await stopped 永久挂起」。
这类假 bug 比真 bug 更贵，因为它伪装成产品缺陷，会浪费一整轮排查。**写 mock 前先读真实实现的契约。**

### 2.4 `apply` 不要抛错 `[源码]`

插件加载失败会让整个 profile 出问题。异步启动的失败应该 log 后降级，不要 `throw`。
我们的做法：`boot` 是 async IIFE，catch 里只 `log('error', ...)`，让 `snapshot()` 暴露未就绪状态。

---

## §3 服务注册与服务发现（最容易踩的一章）

### 3.1 `ctx.provide` 可以接普通 JS 值 `[实测]`

```js
ctx.provide('myService', { doThing() {} })
```

`Service` 基类内部也只是 `self.ctx.reflect.provide(name, self, this[symbols.check])`。
纯 JS 项目用 `provide` 就够，零依赖可行。

### 3.2 兄弟插件 inject 是成立的 `[实测]`

探针 `work/scripts/probe-service-scope.mjs` 输出：
```
[provider] provided; ctx.get(self) = false
[consumer] active; got service = world
--- root.get = true
```
注意第一行：**provide 方在自己的 apply 里 `ctx.get` 拿不到自己**（此时 fiber 还没激活）。
这是正常的，不要用它判断注册成功。

### 3.3 ★★ `provide` 的 check 谓词不能表达「异步就绪」`[实测，代价最大的一条]`

cordis 源码 `lib/index.js:1306-1315`：
```js
_checkImpl(name) {
  const impl = this.ctx.reflect._getImpl(name, true);
  if (!impl) return delete this._store[name];
  try {
    if (impl.check && !impl.check.call(getTraceable(this.ctx, impl.value)))
      return delete this._store[name];   // ← 谓词为假 → 实现被删掉
  } catch (error) { ... return delete this._store[name]; }
  this._store[name] = impl;
}
```

**谓词只是 get 时的一次性门禁。谓词从 false 变 true 之后，没有任何机制重新 notify 等待者。**

真机现象：
```
dsh: warning: 1 entry did not activate
dsh-kit-demo-realtest (dsh-kit-demo): pending (waiting for services: unknown)
```
消费者永远 pending，一直等到进程结束。

探针对比 `work/scripts/probe-provide-check.mjs`：
```
[A-no-check]   consumer active; svc = world       ← 无 check，正常
[B-check-late] => consumerRan=false               ← check 恒 false，消费者永不激活
[C-check-true] consumer active; svc = world-true  ← check 恒 true，正常
```

**正确做法**：`ctx.provide(name, facade)` 无条件暴露，facade 内部判断就绪。
```js
const facade = {
  get ready() { return kit !== null },
  request: (m, p, o) => kit ? kit.request(m, p, o) : notReady(m),
  waitReady: (ms) => Promise.race([readySignal, timeout(ms)]),  // ← 需要等的消费者显式等
}
```

### 3.4 配置 schema：普通对象也活 `[实测]`

官方 guide 要求 `Schema<Config>`，但 `dsh-agy-link` 用 `Record<string, unknown>` 且在真 profile 里正常工作。
判断：该约束面向仓库内官方插件。第三方插件用普通对象 + 防御性解析（每个字段都校验类型和范围）是可接受的。
**必须做的**：所有 config 字段都要有默认值，坏值要降级而不是抛错。

### 3.5 `peerDependencies` 是运行时门禁 `[源码]`

`app-boot/src/plugin-compatibility.ts` 在插件被 import **之前**校验 peer。
不匹配的行直接置为 `disabled`，**模块永不导入，也不报错**。

- 区间必须按世代切上界（`<0.2.0` / `<0.3.0`），**禁止**写 `>=0.1.2 <0.3.0` 这种跨整代的开区间
- 门禁语义是 `includePrerelease: true`，比裸 semver 宽松
- `engines.dsh` / `dsh.manifestVersion` 是纯声明、零强制，写了不生效
- 只用 Cordis 基础能力 → `>=0.2.1-0 <0.3.0`（本机 0.2.1-rc.2 实测可用）

---

## §4 VSCode 扩展侧

### 4.1 构建形态 `[实测]`

- **CJS**，不是 ESM：`engines.vscode ^1.91` 的扩展宿主对 ESM 支持不完整
- **必须 bundle**（esbuild `format:'cjs'`）：跨包相对 import 不打进产物，vsix 里就得塞 node_modules
- `external: ['vscode']`：vscode 模块由宿主注入，不能打进去
- `activationEvents: ["onStartupFinished"]` 比 `*` 明确，比具体事件更省心

### 4.2 `engines.vscode` 与真实版本 `[实测]`

本机 `code --version` = 1.142.0。`^1.91.0` 声明允许 1.142，实测可用。
但 **没有验证过 1.91–1.141**，不要假设低版本行为一致。

### 4.3 扩展宿主的 `process.cwd()` 无意义 `[实测]`

解析相对路径时**不能锚 cwd**。要么锚工作区根（`workspace.workspaceFolders[0]`），
要么锚 `USERPROFILE`/`HOME`。我们的实现：有工作区锚工作区，没有则锚用户目录。

### 4.4 配置监听过宽会杀掉自己 `[实测]` ★

```js
// 错误：任何 dshKit.* 变更都重载
if (!e.affectsConfiguration('dshKit')) return
vscode.commands.executeCommand('workbench.action.reloadWindow')
```

真机事故：打开 `dshKit.selfTestOnStart` 这个开关的瞬间，正在执行的自检被 reload 杀掉，
结果文件写了 0 字节。表现极具误导性（「代码没跑完」而不是「被杀了」）。

**正确做法**：枚举真正需要重建宿主的键，其余走轻量分支。
```js
const RESTART_KEYS = ['dshHome', 'pollIntervalMs']
if (!RESTART_KEYS.some((k) => e.affectsConfiguration(`dshKit.${k}`))) {
  // 只处理能热切换的（比如 enabled → start/stop）
  return
}
```

### 4.5 1-based 与 0-based 的边界 `[实测]`

协议对外一律 **1-based**（用户/编辑器状态栏看到的就是 1-based），只在调 VS Code API 的边界转 0-based。
真机自检 `start.line === 2` 证明转换正确。
**所有越界值必须夹住**（退回 0 并标记），不能让 VS Code 抛 `Illegal argument`。

### 4.6 二进制文件不要走 `showTextDocument` `[实测/继承]`

`showTextDocument` 对 png/pdf/zip 会报 `File seems to be binary`（Fengze233 扩展 issue #33）。
按扩展名白名单分流到 `env.openExternal`。

### 4.7 ★ 出口路径必须在协议边界统一写法 `[实测，真机才暴露]`

同一个文件，`vscode.openFile` 回传调用方传入的 `C:\Users\...`（大写盘符），
而 `vscode.getSelection` / `listOpenEditors` / `getDiagnostics` 回传 VSCode URI 的 `fsPath`，
Windows 上盘符被**小写化**成 `c:\Users\...`。

真机自检的表现极具欺骗性：9/9 步全 PASS，但断言 `list.some(e => e.file === target)`
的结果是 `false` —— 代码没错、路径没错，只是大小写不同。

**规矩**：协议是对外契约，出口只能有一种写法。加一个 `canonicalPath()`
在返回前统一（大写盘符），并写回归测试锁住。
**凡是「回传路径」的能力都要过它**，包括诊断、编辑器列表这类间接来源。

教训推广：**只要一个值会从两个以上来源回传给同一个消费者，就必须在出口归一化**——
URI 的 `fsPath`、Node 的 `resolve`、用户传入的原始串，三者写法可能各不相同。

### 4.8 自检要断言「跨能力的同一性」，不能只断言每步 ok `[实测]`

上面那个 bug 单看每一步都是 PASS：openFile 成功、getSelection 成功、listOpenEditors 成功。
只有把**两个能力的结果放在一起比**（`hasFixture`）才暴露。

所以自检步骤里要刻意安排：
- 先用 A 能力产出一个值（打开文件），
- 再用 B 能力读回同一个值（列编辑器），
- 断言它们**指同一个东西**。

单步 ok 只证明「没抛错」，跨步一致才证明「契约成立」。

---

## §5 跨进程通信

### 5.1 发现文件必须原子写 `[实测]`

临时文件 → chmod 0600 → `rename`。直接 `writeFileSync` 会被对端读到半个 JSON。
Windows 上 chmod 常被忽略，要再显式 `chmod` 一次并 try/catch 兜住，**不因此让启动失败**。

### 5.2 死 pid 清扫 `[实测]`

`process.kill(pid, 0)`，`EPERM` 视为存活（进程属于别的用户）。
崩溃残留的发现文件不过滤，会让编辑器连到不存在的端口上反复重试。

### 5.3 优雅关闭必须显式销毁 socket `[实测]` ★

`server.close()` 只停止接受新连接，**已建立的连接会让它永远等下去**。
真机上表现为 `close()` 挂死 120 秒超时。

正确顺序：协议层 `link.close()` **之后**还要 `link.socket?.destroy()`，最后加个 `setTimeout(resolve, 500).unref()` 兜底。

### 5.4 库不许延长宿主进程寿命 `[实测]` ★

所有定时器 `unref()`，所有 socket 注意断开。
副作用：裸 node 进程会**立刻优雅退出**。E2E fixture 踩过——编辑器侧 fixture 一启动就 exit 0，
必须自己挂 `setInterval(() => {}, 1000)` keepalive。真实 VSCode 扩展宿主本身长活，没这问题。

### 5.5 进程级单例钩子 `[实测]`

```js
// 错误：工厂里直接 process.on('exit', ...)
// 11 个实例 → MaxListenersExceededWarning
```
可多次实例化的库，`process.on` 必须走进程级单例 + 注册表分发。

### 5.6 多实例仲裁 `[实测/部分]`

发现目录里可能有多个 DSH 实例。按 `startedAt` 降序取最新的。
**未验证**：两个真窗口同时连时能力调用落到哪个（日志显示确实同时连了两个）。

### 5.7 分帧层要统一处理 CRLF `[单测]`

```js
// 错误：只在 handleLine 剥 \r，分帧层不剥
// → CRLF 下产出 '{"c":3}\r'，JSON.parse 前多一步
const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw  // 分帧层统一剥
```

### 5.8 双向 RPC 的测试替身三路分流 `[单测]`

- 有 id、无 method → **响应** → `link.handleLine`
- 有 id、有 method → **请求** → `link.handleLine`
- 无 id → **通知** → inbox / waiters

三路必须互斥。写成「都先入 inbox」会让对端永远收不到请求，表现为 30 秒超时。

---

## §6 症状 → 根因速查

| 症状 | 最可能根因 | 去读 |
|---|---|---|
| 插件 `pending (waiting for services)` 永久不动 | `provide` 传了 check 谓词，且谓词当前为假 | §3.3 |
| `dsh: warning: N entry did not activate` | 同上；或 `inject` 里的服务名拼错 | §3.3 |
| `xxx is not a function`（裸 TypeError） | 服务返回了 `{}` 占位而不是稳定方法 | §3.3 |
| `close()` 挂住几分钟 | 没 destroy socket | §5.3 |
| 插件装了但完全不生效、也不报错 | `peerDependencies` 门禁把它 `disabled` 了 | §3.5 |
| `MaxListenersExceededWarning` | 工厂里挂了 `process.on` | §5.5 |
| 裸 node 进程一启动就退出 | 所有定时器 unref 了 | §5.4 |
| `Cannot find module '@deepseek-ai/cordis'` | VSCode 扩展宿主 spawn 的 dsh 拿不到模块加载 hook | §3.2 |
| 请求 30 秒超时、对端没反应 | 测试替身把请求当通知吞了 | §5.8 |
| `Cannot find module '...test'` | `node --test test/` 要写成 `node --test "test/*.test.js"` | §7.3 |
| CRLF 输入解析失败 | 分帧层没剥 `\r` | §5.7 |
| 自检/长任务「没跑完」 | 配置监听触发了 `reloadWindow` | §4.4 |
| `File seems to be binary` | 二进制走了 `showTextDocument` | §4.6 |
| 同一个文件按字符串比较不相等 | 出口路径没归一化（`c:\` vs `C:\`） | §4.7 |
| 自检每步都 PASS 但契约是错的 | 只断言单步 ok，没断言跨能力同一性 | §4.8 |

---

## §7 环境与工具坑

### 7.1 asar 里的文件读法 `[实测]`

DSH 的所有 `@deepseek-ai/*` 包都在 `app.asar` 里，**普通 ls/cat 读不了**。
必须借 Electron 的 asar 支持：
```bash
ELECTRON_RUN_AS_NODE=1 "C:/.../DeepSeek Harness.exe" script.mjs
```
ESM 里 `import('C:/...')` 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，要转 `pathToFileURL(...).href`。

### 7.2 bash 里 `cd` 进 asar 目录会失败 `[实测]`

asar 是文件不是目录。所有读取走 `ELECTRON_RUN_AS_NODE` 的 node 脚本。

### 7.3 `node --test` 的目录写法 `[实测]`

`node --test test/` → `Cannot find module '...\test'`。
必须 `node --test "test/*.test.js"` 或显式列文件名。

### 7.4 Windows 上 `dsh` 命令只在 pwsh 可用 `[实测]`

bash 的 PATH 里没有。跨 shell 调用要显式用 pwsh。

### 7.5 `dsh --patch` 的位置 `[实测]`

`--profile` 必须在 `--patch` 之前。overlay 是**追加**在 profile 之上的，不改 profile 文件本身——
这是做真机验证时最安全的注入方式。

### 7.6 编辑事故的代价 `[实测]`

一次 edit 把 `})` 和下一行拼到一起 → `SyntaxError: Unexpected identifier`，整个模块加载失败。
**改完立刻跑 import smoke**（`node -e "import('./src/index.js')"`），比跑全量测试快得多。

---

## §8 仍然未知的部分

不要把这些当已验证结论使用。

| 项 | 状态 | 风险 |
|---|---|---|
| 多 VSCode 窗口同时连时的仲裁行为 | 只实现了「取最新」，未验证 | 中 |
| Remote / WSL / SSH | 按设计不支持（发现文件在本地） | 低（已声明 out-of-scope） |
| macOS / Linux | 完全未验 | 中（chmod/进程模型差异） |
| VS Code 1.91–1.141 | 未验 | 低（`engines` 已声明） |
| 长期运行稳定性 | 只跑分钟级 | 中（泄漏、重连风暴） |
| cordis 内部 API 稳定性 | 依赖 `ctx.provide/get/effect/on` 四个原语 | 低（都是公开文档面） |
| 宿主 loader hook 的行为 | 我们没用，但它是第三方插件 import `@deepseek-ai/*` 的唯一途径 | 中（未公开契约） |

---

## §9 打样过程本身的经验（元层面）

### 9.1 打样选「最险链路」而不是「最好做的模块」 `[实测，价值最高]`

我们选的打样模板横穿：DSH 插件服务 → 自定义协议 → loopback TCP → VSCode 扩展 → 官方 API。
这是四段跨应用链路，也是全局最险的地方。

结果：**四个真 bug 全部出在这条链路上**，而且全部是单测和 E2E 发现不了的
（单测用假 ctx，E2E 用假宿主，两者都证明不了真宿主那半边）。

如果打样选了「最好做的模块」（比如只做协议解析），这轮会全绿，然后真正的集成在后面爆。

### 9.2 三层验证缺一不可 `[实测]`

| 层 | 能发现 | 不能发现 |
|---|---|---|
| 单测（假 ctx + 假宿主） | 逻辑错误、边界、分帧 | 真实宿主契约、真 API 参数 |
| E2E（两个真进程 + 假宿主） | 跨进程、发现、鉴权、重连 | 真 VSCode API 那几行 |
| 真机（真 DSH + 真 VSCode） | 服务注册语义、配置监听、真 API | 低频路径、长稳 |

**每一层的 bug 都只能被下一层发现**，所以层与层之间不能省略。

### 9.3 mock 写错 = 假 bug 制造机 `[实测，代价第二]`

`fakeCtx` 的 `effect` 契约写错，导致两个假 bug（资源没释放 + await 永远挂起），白查两轮。
教训：**写 mock 之前先读一遍真实实现的契约**，哪怕只有 20 行。

### 9.4 探针脚本值得写 `[实测]`

`probe-service-scope.mjs` / `probe-provide-check.mjs` 各 20 行，
用一个下午的排查疑问换来了确定的答案（A/B/C 三种场景的对照输出）。

写探针的判据：**当你开始怀疑文档、怀疑自己的理解、或者要连续读几百行别人源码时，就该写探针。**

### 9.5 失败的路径也要落盘 `[实测]`

这次记录下来的失败：desktop profile 不可 patch、`npx vsce` 首轮打包失败、
`ctx.provide` + check 的架构错误、smoke 探针误判。
这些比「成功了什么」对下一次更有价值，因为它们直接对应可复用的判断。

### 9.6 用户在场时，10 分钟问一次 `[约定]`

按主人 m00159 的要求：设计期间遇到问题及时沟通，不要一次思考几十分钟。
实际操作中，这个约束最大的价值是**阻止了长时间的错误方向思考**——
`check` 谓词那个 bug 一暴露就立刻汇报，比自己闷头读 cordis 源码快得多。
