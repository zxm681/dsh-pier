# 安全缺陷修复方案（三个洞）

> 状态：**洞 1 ✅（commit 0268b87）· 洞 2 ✅（准入标志位）· 洞 3 ✅（结论：架构本已闭合，只补测试）**。
> 三洞已于 2026-10-21 全部关闭，回归基线 kit 48 / bridge 23 / demo 7 / E2E 13 全绿。
> 发现过程见 `docs/教学-从零读懂DSH-Pier.md` 的「第 3 课答疑（第二轮）」。
> 发现时间 2026-10-21。
>
> **实际修法与本方案初稿的差异（重要）**：初稿建议「hello 用裸 `write()` 绕开协议的
> token 附加」。实际改的是**协议层默认值** —— `notify`/`respond` 默认不再附带 token，
> 要带必须显式 `{ withToken: true }`。理由：裸 write 只治 hello 这一条消息，下一个人
> 新增第二条通知时照样会重犯；改默认值是把「凭据必须显式」变成协议层的规则。
> 代价是行为变更（对端若依赖通知带 token 会收到 -32001），实测两侧业务代码都只走
> `request()`，无人依赖，故无兼容问题。

## 洞 1：hello 白送 token —— ✅ 已修

**现状**（`packages/dsh-vscode-kit/src/server.js:130-156`）

```js
const link = connect({ write, onRequest, timeoutMs, token, authorize: (i) => i === token })
link.notify('bridge.hello', { client, protocolVersion, dshVersion, capabilities })
```

`notify()` 无条件附加 token（`protocol.js:174-178`），而 hello 是**客户端还没证明身份时**就发出的第一条消息。**任何人连上就拿到 token。**

**修法**：hello 用裸 `write()`，绕开协议的 token 附加。

```js
// server.js 的 makeLink 里
import { createLineSplitter } from './protocol.js'   // 已有
// hello 必须不带 token —— 它在对方证明身份之前发出，
// 带上 token 等于把通行证寄给陌生人（见安全审计 洞 1）。
const helloLine = JSON.stringify({
  jsonrpc: '2.0',
  method: 'bridge.hello',
  params: { client: 'dsh-vscode-kit', protocolVersion: PROTOCOL_VERSION, dshVersion, capabilities },
}) + '\n'
write(helloLine)
```

**影响面**：`server.test.js:117-135, 264` 的 hello 断言需要改（现在会没有顶层 token）。应用层 `apply.test.js:109` 同理。

### 实际落地（与上面的初稿不同）

改了 `packages/dsh-vscode-kit/src/protocol.js` 的**两条默认值**：

```js
function notify(method, params, opts) {
  const msg = { jsonrpc: '2.0', method, params: params ?? {} }
  if (opts?.withToken === true && token !== undefined) msg.token = token   // ← 默认不发
  send(msg)
}

function respond(id, result, opts) {
  const msg = { jsonrpc: '2.0', id, result }
  if (opts?.withToken === true && token !== undefined) msg.token = token   // ← 默认不发
  send(msg)
}
// respondError 同理由，现在也不带 token
```

**为什么不是裸 write**：裸 write 只堵住 hello 这一条消息，下一个人新增第二条通知时照样会重犯。
改默认值是把「发凭据必须显式」变成协议层的规则 —— 漏写只会「该带的没带」（对端回
-32001，立刻暴露），不会「不该带的带了」（悄悄泄露）。**安全默认值就该选失败可见的那一侧。**

### 连带修的一处（不改会引入新噪声）

`packages/dsh-kit-bridge/src/connector.js:141` 的入站 `authorize` 原本要求**所有**入站消息带 token。
hello 现在不带 token 了，于是编辑器侧把它当未认证消息拒掉，E2E 日志出现：
```
[editor] conn: protocol: unauthorized notification dropped
```
修法（已落地）：
```js
authorize: (incoming, method) => method === 'bridge.hello' || incoming === info.token,
```
放行 hello 不削弱安全：它不含任何秘密，只作协议版本公告，不触发任何动作。

### 验证（全绿）

| 项目 | 结果 |
|---|---|
| kit 单测 | **43/43**（原 38 + 新增 5 条安全断言） |
| bridge 单测 | 23/23 |
| demo 单测 | 7/7 |
| 跨进程 E2E | 13/13，且 `unauthorized notification dropped` 噪声消失 |
| 真机 hello 探针 | `{"jsonrpc":"2.0","method":"bridge.hello","params":{...}}` —— **无 token 字段** |
| 真机 smoke | PASS（openFile + getSelection 全通） |

五条新测试里最关键的一条是**真起 server + 真 socket** 那条：它不 mock，锁的是
「未认证连接收到的 hello 里没有 token」这个安全性质本身。

---

## 洞 2：谁最后连上，谁就是"编辑器"

**现状**

- `server.js:148` `links.add(link)` 在连接建立时就执行，跟 token 无关
- `index.js:64-66` `_activeLink()` 取 `links` 的最后一个

**修法（两种，需选）**

### 方案 A：登记推迟到"证明身份之后"（推荐）

```js
// server.js：连接建立时不 add，改在握手成功后 add
socket.on('data', ...)   // 照旧
// 不在 makeLink 里 links.add(link)

// 在 authorize 之外，增加一个「已认证」标志
let authenticated = false
const link = connect({
  write,
  onRequest: async (method, params, msgCtx) => {
    // 第一条合法消息即视为认证完成
    if (!authenticated) { authenticated = true; links.add(link) }
    return onRequest(method, params, msgCtx)
  },
  ...
})
```

**问题**：`_activeLink()` 的语义从"最后一个连接"变成"最后一个认证的连接"，仍然没有区分"哪个是真编辑器"（本机攻击者拿到 token 后照样能认证）。

### 方案 B：由 `bridge.hello` 的内容决定身份（更彻底）

只有**由编辑器主动发起、且带正确 token、且 srcClient 是 vscode 扩展**的 `bridge.hello` 才把该连接标记为 editor。DSH 只在标记为 editor 的连接里挑 active。

```js
// index.js handleInbound 已经处理 'bridge.hello'
// 增加：只有通过 authorize 的 hello 才把 link.editor = true
```

**问题**：token 一旦泄露（洞 1 未修时它是白送的），攻击者仍能伪造 hello。**所以洞 2 必须与洞 1 一起修才有意义。**

**建议**：先修洞 1（5 行，低风险），第 2 天再看方案 A/B。只修洞 1 就能让"劫持"从"连上就行"变成"必须先偷到 token"。

---

## 洞 3：响应不过鉴权门

**现状**

- `protocol.js:197-210` 响应分支直接 resolve，不调 authorize
- `protocol.js:181-183` `respond()` 不带 token

**修法**

> ⚠️ **2026-10-21 更新：下面这个初稿方案已被先例调研否掉，不要照着做。**
> 见 `docs/先例调研-鉴权放在哪一层.md` §2。
>
> 初稿是「`respond` 附 token + 响应分支先验 token」。三个问题：
> 1. **与洞 1 的铁律直接冲突**：洞 1 刚定下「出站默认不带 token」，洞 3 又要响应带 token，
>    两条规则互相打架，下一个人必然写错一边。
> 2. **没有解决真正的威胁**：洞 3 的攻击面是「未准入的裸连接冒充对端回响应」，
>    根因在洞 2（裸连接被当成了对端）。洞 2 修好后，请求根本不会发给未准入的连接。
> 3. **多此一举的性能开销**：1000 次响应 = 1000 次比较，还要把 token 传遍协议层。

### ✅ 采纳的修法：响应必须来自「这条请求实际发往的那条连接」

依据 [microsoft/vscode](https://github.com/microsoft/vscode)（194k stars）的做法：
凭证只在**建连时**验一次，此后靠「这条 socket 已被信任」，
不在每条消息里重复携带（`serverConnectionToken.ts` 的 `requestHasValidConnectionToken` +
`remoteExtensionHostAgentServer.ts:157` 的 403 门）。

落到我们身上，洞 3 只需一个**本地、零成本**的检查：发请求时记住「发给了谁」，收到响应时比对来源。

```js
// protocol.js —— request() 里登记目标 link 身份
// connect(opts) 增加 opts.selfId（本端标识）；link.send 时带上 from 字段？不行，会多一个字段进协议。
// 更简单：connect() 的 handleMessage 增加第二个参数 from（由 write 的调用方在装配时绑定）。
```

**具体实现（`packages/dsh-vscode-kit/src/server.js` 装配处）**：

```js
// makeLink 里：每个 link 有自己的 connect() 实例，pending 天然隔离。
// 「这条响应来自谁」== 「哪个 link 的 handleLine 收到它的」—— 因为
// socket.on('data') → splitter → link.handleLine，一个 link 只对应一条 socket。
// 故：只要 socket 不共用 handleLine，洞 3 在当前架构下**天然不成立**。
// 需要验证的是：pending 是否真的 per-link（是），以及有没有跨 link 复用 handleLine（没有）。
```

**因此洞 3 的正确结论是**：先写一条**攻击回归测试**证明「攻击者的响应无法完成真编辑器的 pending」，
若测试通过则洞 3 在架构上本已闭合（需在文档里写清为什么），若失败再补显式检查。
**先测后改**，不要再凭直觉加 token。

**影响面**：无（若验证通过）；仅补测试。

---

## 修复顺序与验证

| 步骤 | 改什么 | 验证 | 状态 |
|---|---|---|---|
| 1 | 洞 1：hello 不附 token | 跑 `lesson3-verify-hello.mjs`，期望「两者相同吗？ 否」 | ✅ **已完成**（commit 0268b87） |
| 2 | 洞 2：准入标志位 + active 只在准入连接里挑 | 跑 `lesson3-hijack.mjs`，期望「结果来自真编辑器」 | ✅ **已完成**（真机 46/46 已验） |
| 3 | 洞 3：先写攻击回归测试验证架构是否已闭合 | 见下节 | ✅ **已完成（结论：架构本已闭合，只补测试）** |

**当前回归基线**：kit 48 / bridge 23 / demo 7 / E2E 13。

---

## 洞 3 的结论：不是漏洞，是缺测试（2026-10-21）

**证据（变异测试，见下）先行**：洞 3 描述的攻击「未准入连接冒充对端回响应」
在当前架构下**不成立**，因为 `pending` 是 `connect()` 里的闭包变量（`protocol.js:110`
`const pending = new Map()`），而 `server.js:126 makeLink(socket)` 给每条 socket
各造一个独立的 `connect()` 实例。

于是「响应来自谁」= 「哪个 link 的 handleLine 收到它」，天然隔离。

**这类结论必须被测试锁住，否则哪天真把 pending 提到模块级就没人发现。**
故新增两条回归（`test/server.test.js` 末尾）：

1. `★安全回归（洞 3）：攻击者答不掉服务端发给真编辑器的请求`
   —— 真编辑器收到请求后不回包，攻击者（错 token、未准入）拿**真实 id** 抢答，
   断言真编辑器侧只能超时，拿不到 `FAKE-FROM-ATTACKER`。
2. `★安全回归（洞 3）：pending 表是每连接独立的`
   —— 直接断言 `linkA.pendingCount === 1` 时 `linkB.pendingCount === 0`。

### ★ 变异测试：证明这两条测试真的会红

```bash
# 故意引入 bug：把 pending 从 per-connect 闭包改成全局共享
sed -i 's|const pending = new Map()|const pending = globalThis.__SHARED_PENDING__ ??= new Map()|' src/protocol.js
node --test "test/*.test.js"
```

实测结果：

```
✖ ★安全回归（洞 3）：攻击者答不掉服务端发给真编辑器的请求 (3.8403ms)
    AssertionError [ERR_ASSERTION]: Missing expected rejection:
    真编辑器的请求被攻击者的伪造响应完成了（洞 3 未闭合）
✖ ★安全回归（洞 3）：pending 表是每连接独立的 (23.9256ms)
ℹ tests 48 / pass 46 / fail 2
```

恢复后 48/48 全绿。**「写了测试」和「测试能抓到 bug」是两件事，
后者必须用变异测试证明。**

### 也踩过一个坑：第一版这两条测试是假测试

- 第一条**硬编码 id=2** 猜 id，实为 1 —— 攻击者的伪造响应根本没命中任何 pending，
  「测试通过」只证明了自己的猜错，不证明任何安全性。变异测试第一次跑时它**没红**，
  才暴露了这个假测试。修法：让攻击者从 `real.next()` **真实收到的那条请求里取 id**。
- 第二条第一版有个 `let leaked = false` 从不被赋值的断言 —— 永远为 true 的死代码。
  修法：直接断言 `pendingCount`，去掉所有中间变量。
- 顺带修：断言失败时 `pa` 会留下未处理的 rejection 掩盖真实错误，
  先挂 `pa.catch(() => {})`。

教训：**「测试全绿」可能是测试自己有病。** 变异测试是唯一能区分
「测试在守门」与「测试在睡觉」的方法，成本只有一次 sed + 一次跑。

