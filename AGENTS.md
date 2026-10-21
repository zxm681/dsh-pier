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
cd packages/dsh-vscode-kit && node --test "test/*.test.js"   # 56
cd packages/dsh-kit-bridge && node --test "test/*.test.js"   # 23
cd packages/dsh-kit-demo   && node --test "test/*.test.js"   # 7
cd packages/dsh-kit-bridge && node scripts/e2e.mjs           # 13
```

涉及真实宿主语义的改动（服务注册、配置监听、VSCode API 调用）**必须真机验证**，
单测和 E2E 都用假宿主，证明不了那半边。步骤见 `docs/phase6-验收报告.md` §6。

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
