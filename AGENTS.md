# dsh-vscode-dev

DSH ↔ VS Code 通用桥接通道。设计文档在 `docs/`，代码在 `packages/`。

## 铁律（都是踩过坑换来的，改动前先读 docs/phase7-经验手册.md）

1. **`ctx.provide` 不许传 check 谓词**。它是 get 时门禁，不是就绪通知；会让消费者永久 pending。
   就绪状态在 facade 方法内部判断，需要等的消费者显式 `waitReady(ms)`。
2. **服务返回的 facade 方法必须稳定存在**。不许在未就绪时返回 `{}` 或 `null`——
   裸 TypeError 是最糟的失败形态，且消费者解构后会永远好不了。
3. **协议库零依赖**，不 import `@deepseek-ai/*`（那是未公开的 loader hook 契约）。
4. **所有定时器 `unref()`**，库不许延长宿主进程寿命。E2E fixture 要自己挂 keepalive。
5. **优雅关闭要显式 `socket.destroy()`**，只 `link.close()` 会让 `server.close()` 挂死。
6. **转义/剥离在边界一次做完**。CRLF 在分帧层剥，1-based→0-based 只在 VSCode API 边界转。
7. **改完立刻跑 import smoke**：`node -e "import('./src/index.js')"`，比全量测试快。
8. **连接建立 ≠ 准入，准入 ≠ 选目标**。`links` 只做存活登记与 `close()` 时销毁底层 socket
   （server.js:124、213-219）；挑对端**只遍历 `trusted`**（server.js:126），不许从 `links` 挑、
   **不许回退 `links`**（`index.js` 的 `_activeLink()`，78-93）。活跃目标取 `trusted` 里 `connSeq`
   **最大**的**活**连接；口径是「连接先后」，不是「最后准入」（server.js:127-137、178；
   逆序握手时两种口径会选出不同窗口，这是已修的真实回归）。`broadcast()` 只发给已准入连接
   （server.js:243-246，有意收紧的契约变更：未准入连接不该收到可能含选区文本的通知）。
   `link.authorized` 仅留作诊断/兼容，**不再承担安全边界**（§5.9 里的 `links.filter(authorized)`
   是拆分前写法，已过时，以代码为准）。出站消息**不许默认附带 token**——凭证只在调用方显式要求时带。
9. **「测试全绿」不等于「测试在守门」**。每条安全回归都要做一次**变异测试**：故意把 bug 改回去，
   确认测试变红。成本只有一次 sed + 一次跑，却是唯一能区分「测试在守门」和「测试在睡觉」的办法。
   （2026-10-21 踩过：新写的两条洞 3 测试第一版都是假测试，硬编码猜 id、断言变量从不被赋值。）
10. **写入必须经绑定门**。写类方法的**目标连接由 grant 记录决定**（`grants[session].link` 对象引用），
    **不许**用「活跃编辑器」（`_activeLink()` 的 argmax）代替 —— 那是读路径的口径，拿它挑写目标
    等于把授权退化成「谁最后连上就写给谁」。同一份判定只许有一处实现（`grant.js` 的 `judgeGrant`，
    DSH 发送前与扩展执行前共用），各抄一份必然漂移。另外 **`notify` / `broadcast` 对写入类方法一律
    拒绝**（`assertWritableNotNotified`）：单向消息没有回执，发送前门判完也证明不了对端存下了，
    写入只能走 `request`。
11. **不可逆动作宁可不做**。`vscode.deleteFile` **只搬不删**：目标 `rename` 进 `<工作区根>/.dsh-quarantine/`，
    不 `unlink`、不走回收站、一个字节都不销毁（宿主原语 `fs.promises.rename`，跨卷抛 EXDEV 就整个拒，
    **绝不退化成 copy+delete** —— provider 那条路径实测会先 copy 再 rimraf 源）。所以：
    **不许**把返回体写成 `deleted`/`trashed`（只有 `quarantined:true`）；**不许**在 `packages/**` 里加任何删除方法或
    `unlink`/`rm`/`copyFile` 调用（`test/t40-host-surface.test.js` 有静态守门）。
    要改删除语义（真删、走回收站、加 `restore`）**必须在 commit message 里写明改了什么、为什么**，
    否则下一轮评审会把它当成偷偷加回来的 `unlink`。
    **唯一例外（T68）**：`vscode-host.js` 的 `removeCreatedInThisCall(absPath, identity)`
    允许一处 `unlink`，因为它只回收**本次调用自己刚创建、此前不存在的对象**，不是用户数据。
    三个前提缺一不可：仅在本调用 createFile 的失败路径（先 close）；删前 lstat 的 `(dev,ino)`
    与创建时 fstat 的 `(dev,ino)` 完全一致（不一致不删，返回 `identity-changed`）；全仓源码
    单调用点，并由 `test/t68-unlink-surface.test.js` 静态守门。除此之外任何删除限制均不放宽。

12. **连接序不是身份**。`windowId` 与 `connSeq` 必须分字段、禁止互相比；前者由 DSH 按指纹签发/复用，后者仅表示本进程连接先后。
    `target` **只影响读路径**：写路径带 target 一律 `-32014 target-not-routable`，在 `_bindWriteTarget` 前拒绝；写目标永远由 grant 记录的 link 决定。
    绑定读与 target 冲突 → `target-unauthorized`，不回退 `_activeLink()`。依据：[windows.js:217–244](<packages/dsh-vscode-kit/src/windows.js#L217-L244>)、
    [index.js:895–918](<packages/dsh-vscode-kit/src/index.js#L895-L918>)、[index.js:1663–1708](<packages/dsh-vscode-kit/src/index.js#L1663-L1708>)；完整字段/降级见[契约 §3.1](<docs/协作编辑-钩子契约.md#31-多窗口发现与读路径寻址t52按未提交实现核实>)。

## 动手之前先查先例（用户 2026-10-21 明确要求）

涉及**安全边界、鉴权、凭证、并发、协议状态机**的设计，**先去看成熟项目怎么做，再动手**。
理由不是「他们一定对」，而是这类问题**每个项目都会遇到一遍**，成熟项目的答案经过了真实攻击检验；
我们两次踩坑都是「凭直觉设计」的代价 —— 洞 2 独立走对了（socket.io 同思路），
洞 3 差点走错（准备让响应带 token，而 VS Code 源码明确走的是另一条路）。

**怎么做**：`curl` 拉 GitHub 源码原文，别读博客。源码告诉你「它们到底怎么做的」，
博客告诉你「作者以为它们怎么做的」。找到结论后连同 commit 时间记进 `docs/先例调研-*.md`。

**什么时候查 / 不查**：

| 该查 | 不该查 |
|---|---|
| 安全边界、鉴权、凭证、并发、协议状态机、跨进程通信 | 普通 CRUD、UI 渲染、目录结构、一次性脚本 |
| 已经踩了两轮还没定论 | 10 分钟能自己验证的小事 |
| 有「成熟项目一定有这个」的直觉 | 太新、没人做过（自己设计，但必须写清威胁模型） |

已沉淀的调研：`docs/先例调研-鉴权放在哪一层.md`（socket.io / VS Code / Node inspector / Jupyter）。

## 验证门槛（声称完成前必须全绿）

```bash
cd packages/dsh-vscode-kit && node --test --test-concurrency=1 "test/*.test.js"   # 299（或 npm test）
cd packages/dsh-kit-bridge && node --test "test/*.test.js"   # 295
cd packages/dsh-kit-demo   && node --test "test/*.test.js"   # 9
cd packages/dsh-kit-bridge && node scripts/e2e.mjs           # 22
```

条数是**实跑的 `pass` 计数**（T68 本轮：kit 299 / bridge 295 / demo 9 / E2E 22；相对 T67 的 290 / 271 / 9 / 22 新增 33 条，原始输出与变异证据见 `work/t68-createFile.md`），加测试就得回来改这几行。
（T54 那轮的同一门槛是 kit 213 / bridge 156 / demo 9 / E2E 22；那些数字只对当时的用例集成立，别拿它判断今天。）

**kit 必须串行执行**（包内 `npm test` 同样使用 `node --test --test-concurrency=1 "test/*.test.js"`）。
**19 个测试文件**并行启动多实例，共用默认 7410–7419 的 10 个端口（`src/server.js:35` 的 `DEFAULT_PORT_RANGE`；`:67-88` 取不到空口就 throw `no free port in range`，只有 `test/server.test.js:333-350` 显式传别的区间）。
端口区间争用是 flaky 的根因推断，串行化是测试门缓解，不是产品修复。
**并行执行会偶发红，别当成产品 bug**（若串行仍红，必须继续排查，不得套用此解释）。用户观测 5 次中两次分别 3 红、11 红；
并行下的红长这样，两种形态都不是产品缺陷：`TypeError: Cannot read properties of null (reading 'server')` 与 `BridgeError: dsh-vscode-kit is not listening yet`（[并行 1](<work/t54-parallel-1.log>) 的 :227 / :239）。
T54 在 Node v24.20.0 复现三次并行（用例集 213）：`tests/pass/fail = 213/210/3、213/202/11、213/213/0`，串行基线 `213/213/0`。
原始输出保存在 [并行 1](<work/t54-parallel-1.log>)、[并行 2](<work/t54-parallel-2.log>)、[并行 3](<work/t54-parallel-3.log>)、[串行基线](<work/t54-serial-baseline.log>)。
T54 改脚本后实际运行 `npm test` 三次，均为 `ℹ tests 213 / ℹ pass 213 / ℹ fail 0`：
[串行 1](<work/t54-serial-final-1.log>)、[串行 2](<work/t54-serial-final-2.log>)、[串行 3](<work/t54-serial-final-3.log>)；bridge 156/156、demo 9/9、E2E 22/22 亦在那一轮复跑全绿（同上，是 T54 的数）。

**多窗口真机已验证的边界**：VS Code 1.143.1，A10 两窗口不同号且 stable:true、A11 DSH 重启复用、A12 getSelection 的 target 各自命中、A13 写+target 拒绝；
见[设计稿 §7](<docs/多窗口寻址-设计.md#7-验收清单每条都能变红>)。这不代表写路径 target 路由开放，也不覆盖普通安装链路。
注册表回收仍是待办：当前源码已有 64 条上限与按 lastSeenAt 淘汰，并非完全无淘汰；运行态生效、超限加载与历史会话回收需另验（设计稿 §9）。
kit 里含两道门禁的条目：`-32009` 响应校验（`test/response-contract.test.js`）、
写入绑定门与 `vscode.applyEdit`（`test/editing-grant.test.js`）；bridge 里含
`test/apply-edit.test.js`。T38 白名单（`test/t38-whitelist.test.js`）与 T39 落盘
（两侧各一个 `test/t39-save.test.js`）各有独立文件。T40 删除（Tier 4）在 `test/t40-delete.test.js`（两侧），另有宿主面守门
`packages/dsh-kit-bridge/test/t40-host-surface.test.js`（`capabilities.js` 里用到的每个 `host.<field>`
都必须在 `vscode-host.js` 的返回面登记；真机曾因漏掉 `fileExists` 而整片全红）。
T42 在 bridge 的 `test/t40-delete.test.js` 里加了三条交错回归（B1：隔离后替换 / 隔离前顶名 /
原名被占时保留隔离文件）并把 I1 的三条旧断言改写成"交不出整份字节就不许删"（拒删 + 大文本
整份交付 + base64 无损）；白名单的原型成员回归与"删除返回必须带整份备份"的合同断言在 kit 的
`test/t38-whitelist.test.js` / `test/t40-delete.test.js`。变异证据在 `work/t42-mutation/*.log`。

涉及真实宿主语义的改动（服务注册、配置监听、VSCode API 调用）**必须真机验证**，
单测和 E2E 都用假宿主，证明不了那半边。步骤见 `docs/phase6-验收报告.md` §6。

## 改哪一半，就得让哪一半重来（部署事实）

改**哪个包**决定**怎么让它生效**，两者**不能互替**：

| 改了 | 生效条件 | 不做会怎样 |
|---|---|---|
| `packages/dsh-vscode-kit`（DSH 侧协议库） | **重启 DSH** | DSH 进程里跑的还是旧 kit |
| `packages/dsh-kit-bridge`（VS Code 扩展） | **重载 VS Code 窗口**（命令面板 → `Developer: Reload Window`） | 扩展宿主里跑的还是旧 bundle |

- 只装 vsix 不重载窗口 = **等于没装**：扩展宿主只在窗口重载时重新加载 `main`（`packages/dsh-kit-bridge/package.json:26` → `./out/extension.cjs`）。
- 重载窗口也不等于装了新包：`out/extension.cjs` 得先 `node scripts/build.mjs` 重新构建再落到扩展目录，否则重载回去的还是旧文件。
- 两边都动时：先构建 + 装 vsix → 再重载窗口 → 最后重启 DSH。顺序反过来，DSH 起的还是旧 kit。

真机证据（2026-10-24）：22:37 装完新包后只重启了 DSH、没重载窗口，结果扩展进程启动时间是 21:40，**早于**扩展文件写入时间 22:37 —— 时间戳直接证明在线跑的是旧代码，那一轮真机验证判**无效**（记录在 `work/A2-真机验证-状态.md:22`）。本地构建产物时间与之一致：`packages/dsh-kit-bridge/out/extension.cjs` 写入于 2026-10-24 22:36:44，`dsh-kit-bridge-0.3.3.vsix` 打包于 22:37:23。

## 目录

- `packages/dsh-vscode-kit/` — DSH 侧协议库（零依赖）
- `packages/dsh-kit-bridge/` — VS Code 薄扩展（CJS + esbuild bundle）
- `packages/dsh-kit-demo/` — 示例消费者
- `docs/` — 阶段文档 1–7，改设计前必读 phase2（边界）和 phase7（坑）
- `work/` — 真机验证的 overlay、探针脚本、smoke 产物

## 加新能力的三步

1. `packages/dsh-kit-bridge/src/capabilities.js`：加 `CAPABILITIES` 条目 + handler（不 import 'vscode'，走 host 注入）
2. `packages/dsh-vscode-kit/src/index.js`：`VscodeKit.vscode` 加一行糖衣转发
3. 两侧各加单测；跑 E2E；真机验一次

协议层（`protocol.js` / `server.js`）**不需要改**。如果需要改，说明能力设计有问题，先回来讨论。
