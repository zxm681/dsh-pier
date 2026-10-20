# 安全缺陷修复方案（三个洞）

> 状态：**待批准**。三条都是行为变更，不是纯内部重构。
> 发现过程见 `docs/教学-从零读懂DSH-Pier.md` 的「第 3 课答疑（第二轮）」。
> 发现时间 2026-10-21。

## 洞 1：hello 白送 token

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

| 步骤 | 改什么 | 验证 |
|---|---|---|
| 1 | 洞 1：hello 不附 token | 跑 `lesson3-verify-hello.mjs`，期望「两者相同吗？ 否」 |
| 2 | 洞 3：响应附 token + 验 token | 跑 `lesson3-hijack.mjs`，期望「请求失败」或「结果来自真编辑器」 |
| 3 | 洞 2：身份由 hello 决定 | 跑 `lesson3-hijack.mjs`，期望攻击者的连接完全不登记 |

三步都完成后：kit 38 / bridge 23 / demo 7 + E2E 13 必须全绿（测试脚手架需同步改）。
