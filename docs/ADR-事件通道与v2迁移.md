# ADR：默认关闭的事件传输通道与后续 v2 迁移

## 状态与范围

T56 / backend-engineer / attempt `t56-event-channel-v3`。**本轮未切版**：运行时 `PROTOCOL_VERSION = 1`，`SUPPORTED_PROTOCOL = [1,1]`；`-32011` 仍未占用。既有测试不改。本轮仅实现 E1 传输基础设施，不是完整事件产品，不发布“完整 v2”。

实现位置：[协议终端](<../packages/dsh-vscode-kit/src/protocol.js>)、[server](<../packages/dsh-vscode-kit/src/server.js>)、[connector](<../packages/dsh-kit-bridge/src/connector.js>)、[共享 wire 定义](<../packages/dsh-vscode-kit/src/event-contract.js>)；[服务入口](<../packages/dsh-vscode-kit/src/index.js>)仅增加配置开关与向下传递。未修改白名单、能力表、VS Code 宿主与编辑事务。

## 为什么是“加新能力三步”的协议层例外

普通能力仍按“三步”增加 handler/糖衣/测试；事件不是多一个 handler 的问题。现有反向 notify 已能传数据，但缺少同步序号入队、有界内存和 `write=false`/`drain` 的传输合同。把这些塞到某个业务 handler，会在共享 socket 的其他写入和 pending 响应处形成旁路。因此经本卡明确授权扩展协议终端与双端 writer；仍用原 ndjson、JSON-RPC、端口、发现文件、token、单服务，不引入第三方执行注册器。不会改读目标、写 grant 或广播规则。

## 开关、协商和准入

- DSH `apply(ctx, {events: false})` / `startBridgeServer({events: false})`；扩展内部 `createConnector({events: false})`。缺省均关闭，只有布尔 `true` 开启，字符串等不启用。
- 本轮未修改扩展设置/激活入口；普通扩展安装链路仍不会开启事件。开启入口、采集器、公开消费者订阅分别留后续卡。
- 关闭时 hello 不增加 `eventChannel`，原请求、响应、普通 notify、广播行为保留。开启方才在 hello 添加 `eventChannel: {version: 1}`；这是**独立事件 schema 修订号，不是协议 v2**。
- 双端都开启、实际收到对端兼容的 `protocolVersion` 和匹配的事件修订号之后，才允许内部安装流。缺失/非法/不兼容版本都不投递事件；不影响原协议兼容门的错误语义。
- 服务端每次事件入队/交付/写出检查 `trusted.has(link)`，绝不回退 `links` 或诊断 `authorized`。扩展还必须收到 hello 成功回执，确认连接仍是当前 socket、对端兼容、`isTrusted() === true`；未注入信任判断按不允许处理。
- 每条事件走原逐消息 authorize，并额外检查顶层 token。普通 hello 仍不带 token；事件调用点显式 `{withToken: true}`，gap 构造点显式设置 token，绝不默认附凭据。
- 未准入且不发合法请求的对端只收到无凭证 hello；错误凭据通知不获得回复或正文。非法请求的既有无凭证错误响应行为不变。

## 冻结的 wire schema

方法名常量 `EVENT_METHOD = 'vscode.events.event'`，只接受**无 id**通知；保留 `EVENT_SUBSCRIBE_METHOD = 'vscode.events.subscribe'`、`EVENT_UNSUBSCRIBE_METHOD = 'vscode.events.unsubscribe'`，**本轮不实现这两个 RPC**。

```json
{"jsonrpc":"2.0","method":"vscode.events.event","token":"<explicit>","params":{"subscriptionId":"transport-sub","streamEpoch":"<opaque>","seq":1,"type":"documentChanged","observedAt":0,"payload":{}}}
```

| params 字段 | 类型与限制 | 含义 |
|---|---|---|
| subscriptionId | 非空非全空白 string，UTF-8 ≤128 bytes | 已安装的内部流标识；不是授权或窗口身份 |
| streamEpoch | 非空非全空白 string，UTF-8 ≤128 bytes | 发送端产生的 opaque 随机纪元；接收端原样采用 |
| seq | 正的 safe integer | 该纪元内、事件实际入队时分配的单调序号 |
| type | `EVENT_TYPES` 枚举 | 文档/页签/选区/可见范围/活动编辑器/焦点，以及 gap/streamClosed |
| observedAt | 非负 safe integer | Unix 毫秒诊断值，不作因果/授权判据 |
| payload | JSON object，不能是 null/array | 业务字段留 E2；控制态仅含枚举 reason，不附正文 |

信封额外字段拒收。业务类型集合：documentChanged/documentOpened/documentClosed/documentSaved/tabsChanged/activeEditorChanged/selectionChanged/visibleRangesChanged/windowFocusChanged。收包来源只取真实 link；payload 自报的 window/session 不形成身份或写锚点。

**seq 语义**：只在同一承载 link、已安装的 subscriptionId 与 streamEpoch 内比较，重复及回退 seq 不再交付，任何缺口立即同步 stale，后续增量不再交付。

**streamEpoch 语义**：每次发送端 `openStream` 随机产生新的 128-bit opaque 值；重连重新协商并安装新流，绝不跨窗口、跨连接或跨纪元比较 seq。

## 上限、背压和失败路径

| 常量 | 值 | 本轮用途 |
|---|---|---|
| SELECTION_COALESCE_MS | 50 ms | 冻结 E2 选区/可见范围合并初值；本轮不采集事件、不推断 view key、不合并业务事件 |
| EVENT_QUEUE_MAX_COUNT | 256 | 每 link 每方向总事件队列条数上限 |
| EVENT_QUEUE_MAX_BYTES | 1,048,576 bytes（1 MiB） | 每方向序列化字节上限；同值作为 socket.writableLength 事件暂停阈值 |
| EVENT_MAX_BYTES | 262,144 bytes（256 KiB） | 单事件整条 JSON-RPC 行 UTF-8 字节上限，包含 token、转义和行尾 |

每 link 每方向同时只允许一个内部流，避免按订阅建无限 Map。`link.events.openStream/acceptStream/publish/dispose/snapshot` 是 E2/E3 的**内部传输控制面**，不加入服务 facade，不等于消费者 subscribe API，也不自动安装任何流。

发送队列在 `write=false` 后等待 drain；false 表示该帧已被 Writable 接受，不重发。事件超大/非法或队列条数/字节超限后，该流永久 stale、停止增量、清掉未发送正文，只保留一个有界 gap。若此前清队列造成缺号，接收端会先报告 seq-gap，同样不允许继续使用旧镜像。socket 缓冲超过阈值时也暂停事件并保留 gap；无法送出时本地 stale 可见，链路断开后对端本地关闭流。本轮无超时强行补发、ACK 或断线重放。

接收在同步边界先验凭据/schema/seq、更新 watermark、入有界队列，再串行异步交付。队列计算包含已经进入异步回调、尚未结算的一条；超限、回调失败、失信、断线或卸载都使流 stale。已运行回调不能撤回，在其结算前继续计数；同步卡死的回调不承诺隔离。恢复必须显式 dispose 并采用新纪元，不能只重读一次就把旧流洗白。

RPC 请求/响应不进入事件队列，不受事件丢弃策略影响；响应仍走原 pending 表，事件无 id、不分配请求 id、不能触发任何业务/写 handler。事件通知误带 id 时回 `-32600`，但不会完成本端同 id 的 pending。非事件广播不改含义。

边界：队列限额不含调用方本来持有的 payload、JSON 序列化临时内存或 OS 内核缓冲；事件流尽力传送，不提供可靠审计日志、恰好一次、跨窗全序或 RPC/事件全序。`onEventState` 和 snapshot 只有元数据，不打印正文或 token。

## v1 → v2 发布与混配策略（未来）

1. **本轮未切版**；v1 中的新增能力只在双端显式开启且成功协商时可试验，老端/关闭方没有事件，原方法语义不变。不允许通过 `[1,2]` 冒充兼容。
2. 只有 A1/A2 的来源账本、逐文件停写与 `-32011 document-dirty`、相关契约和回归/真机验收同时就绪，才将双端 `PROTOCOL_VERSION` 改为 2，`SUPPORTED_PROTOCOL` 同步变 `[2,2]`。**切版与 A2（-32011 脏态门）属于同一发布候选**，不可单发“事件版 v2”。
3. v2 将改变 save/delete 的脏态拒绝与 allowDirtySave 迁移语义，必须显式发布迁移说明；旧调用方遇到 -32011 不自动重读重发。实现 A2 时再同步旧版本快照测试和处置测试，本轮不得提前改它们。
4. 混配 v1↔v2 或未知协议：TCP 保留、无凭证 hello 可诊断，所有业务调用由现有兼容门拒为 -32008；事件也禁止安装/投递。不得在失败后暗回 polling 或旧授权语义。需要 v1/v2 双语义互通时另立 ADR，不能自行放宽区间。
5. 即使协议同版，事件修订号缺失/不匹配仍只关闭事件能力；普通既有方法是否可用继续由协议版本门与能力表决定。

## 源码先例（实施前已查）

Node v24.0.0 的 [Writable 源码](https://raw.githubusercontent.com/nodejs/node/v24.0.0/lib/internal/streams/writable.js)：`writeOrBuffer` 在 highWaterMark 达到后设置 needDrain，`afterWrite` 在缓冲归零时 emit drain。借鉴结论是 **false != 写失败，也不能继续灌**，不是照抄其无限输入策略。钉定提交 `c5349f43cd66d2aa02d86414c9ed426f71d3ae48`，[committer 时间](https://api.github.com/repos/nodejs/node/git/commits/c5349f43cd66d2aa02d86414c9ed426f71d3ae48) `2025-05-05T13:37:49Z`；[tag 时间](https://api.github.com/repos/nodejs/node/git/tags/38ca56c5bb3bcef3003aeb4cd51c18b7c3555c4b) `2025-05-06T14:17:08Z`。

鉴权先例沿用[既有调研](<先例调研-鉴权放在哪一层.md>)的“在册与准入分集合”；其中历史“只在建连验一次”不覆盖当前逐帧 token 合同，不能据此删除消息鉴权。

## 验证与未验证

新增 [kit 单测](<../packages/dsh-vscode-kit/test/events-channel.test.js>)与 [bridge 真 TCP/假宿主测试](<../packages/dsh-kit-bridge/test/events-channel.test.js>)；四类变异的完整原始失败输出、恢复方式与数字见[验证证据](<事件通道-T56-验证证据.md>)。未启动/安装真实 VS Code 扩展，未验证真实 VS Code 事件、普通安装开启路径、真机慢读/长稳或跨平台；这些不能由假宿主单测/E2E 推成通过。
