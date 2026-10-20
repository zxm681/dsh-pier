# 安全缺陷修复方案（三个洞）

> 状态：**洞 1 已修（2026-10-21，用户选方案 B：只修洞 1）**；洞 2、洞 3 **待修**。
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

```js
// 1. respond / respondError 附带 token
function respond(id, result) {
  const msg = { jsonrpc: '2.0', id, result }
  if (token !== undefined) msg.token = token
  send(msg)
}
function respondError(id, code, message, data) {
  const msg = { jsonrpc: '2.0', id, error: new BridgeError(code, message, data).toJSON() }
  if (token !== undefined) msg.token = token
  send(msg)
}

// 2. 响应分支先验 token，失败则丢弃（不能 reject —— 那会把劫持变成"服务不可用"攻击）
const isResponse = msg.id !== undefined && msg.method === undefined
if (isResponse) {
  if (authorize && !authorize(msg.token, '<response>')) {
    reportError(new BridgeError(ERR.UNAUTHORIZED, 'unauthorized response dropped',
      { id: msg.id, reason: msg.token === undefined ? 'missing-token' : 'bad-token' }))
    return
  }
  ...
}
```

**影响面**：
- 双向都要改。`connector.js:135` 的 `write` 已经是 `(line) => s.write(line)`，protocol 内部附加 token，所以客户端侧自动生效。
- `server.js` 侧同理。
- **测试影响**：所有手工构造响应的测试（`server.test.js` 的 `dial()` 脚手架、`apply.test.js` 的 `fakeEditor`）现在必须回带 token 的响应，否则会被丢弃 → 超时。这是**有意的不兼容**，测试要跟着改，正好验证了防护生效。

---

## 修复顺序与验证

| 步骤 | 改什么 | 验证 | 状态 |
|---|---|---|---|
| 1 | 洞 1：hello 不附 token | 跑 `lesson3-verify-hello.mjs`，期望「两者相同吗？ 否」 | ✅ **已完成** |
| 2 | 洞 3：响应附 token + 验 token | 跑 `lesson3-hijack.mjs`，期望「请求失败」或「结果来自真编辑器」 | ⬜ 待做 |
| 3 | 洞 2：身份由 hello 决定 | 跑 `lesson3-hijack.mjs`，期望攻击者的连接完全不登记 | ⬜ 待做 |

三步都完成后：kit / bridge / demo 单测 + E2E 必须全绿（测试脚手架需同步改）。

**当前回归基线（修完洞 1 之后）**：kit 43 / bridge 23 / demo 7 / E2E 13。

**注**：洞 1 修完后再跑 `work/scripts/lesson3-hijack.mjs`，劫持**仍然成功** —— 这是预期的，
因为劫持走的是洞 2（谁最后连上谁就是 active）与洞 3（响应不过鉴权门），两者都还没修。
洞 1 修完的确切效果是：攻击者从「连上就白拿 token」变成「必须先偷到 token（读名片文件、
抓包、或先成为 active 连接接走一条请求）」。**这不是修完了，只是提高了门槛。**

