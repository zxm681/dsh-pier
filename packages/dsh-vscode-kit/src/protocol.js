/**
 * DSH Editor Bridge Protocol v2 —— 传输无关的协议核心。
 *
 * 设计原则（阶段4 架构草图 §3）：
 *  1. 零依赖：只用 Node 内置模块，绝 import @deepseek-ai/*（ERR_MODULE_NOT_FOUND 前科）。
 *  2. 传输无关：本文件不碰 net/fs，只做「字节行 ↔ JSON-RPC 消息 ↔ 待决 Promise」。
 *  3. 可单测：connect() 注入任意可写流 + 可喂入任意行，无端口无进程。
 *
 * 分帧：ndjson。JSON.stringify 会把内部换行转义为 \n，故按 '\n' 切行无粘包歧义。
 */

import { randomBytes } from 'node:crypto'
import {
  EVENT_METHOD, EVENT_CHANNEL_VERSION, EVENT_CHANNEL_HELLO, EVENT_TYPES,
  EVENT_QUEUE_MAX_COUNT, EVENT_QUEUE_MAX_BYTES, EVENT_MAX_BYTES,
  validEventStream, eventEnvelopeError,
} from './event-contract.js'

/** JSON-RPC 2.0 标准错误码 + 本协议扩展码（阶段4 §3.3）。 */
export const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,

  UNAUTHORIZED: -32001,
  DECLINED: -32002,
  NOT_FOUND: -32003,
  TIMEOUT: -32004,
  UNSUPPORTED: -32005,
  UNTRUSTED_WORKSPACE: -32006,
  DISCONNECTED: -32007,
  /**
   * 协议版本不兼容（契约 §4.1）。**新增**码位，不破坏既有契约：
   * 旧端不会遇到它，它只在兼容门内产生。
   * 不许拿 -32005（方法缺失）/ -32601（协议层写错）/ -32007（未就绪）代替。
   */
  PROTOCOL_INCOMPATIBLE: -32008,
  /**
   * 对端响应形状不合格（契约 §5.1）。**新增**码位，不破坏既有契约：
   * 只在 facade 出口（`VscodeKit.request()` 把成功结果交回调用方之前）产生。
   * 不许拿 -32005（方法缺失）/ -32601（协议层写错）/ -32004（超时）代替。
   */
  INVALID_RESPONSE: -32009,
  /**
   * 会话授权绑定门（契约 §6.1 / §6.1.1）。**新增**码位，不动既有码语义。
   * 两个时点各判一次：DSH 侧发送前、扩展侧执行前（逐操作）。
   * 五种 `data.reason`（no-grant / grant-mismatch / grant-revoked / target-gone /
   * grant-generation-stale）都归本码 —— 处置完全一样：停下、重新申请、不得重试。
   * 不许拿 -32001（未授权）/ -32005（能力缺失）/ -32007（未连接）/ -32008（版本不兼容）代替。
   */
  EDIT_NOT_BOUND: -32010,
  /**
   * 文档**来源不明**（A2 / T62：逐文件失败闭合的写许可；协议 v2 新增码位）。
   *
   * 说的是"这个文件里现在有本端**证明不出来源**的内容，所以不许写"——不是"你的锚点过期了"
   * （那是 `-32012`），也不是"磁盘上那份变了"（那是 `-32013`）。三者处置完全不同：
   *
   *  - `-32012`：重读双锚点 → **可以**用新版本重发；
   *  - `-32013`：磁盘冲突 → **永不**自动重试（那盘字节不是本端写的）；
   *  - `-32011`：来源不明 → **停在这个文件上**，不得自动重发（重读锚点不消除它）。
   *
   * `data = { method, file, reason, isDirty, attribution, version, incarnation,
   *           retryable:false, recovery:'human-rebase' }`，`reason` 五选一：
   *  - `foreign-change`：观察到**不是本 grant 写入**引起的文档变更（人 / 别的扩展 / 别的窗口）；
   *  - `mixed-origin`：本端写入窗口里混进了别人的增量（账本判 `mixed`）；
   *  - `attribution-unknown`：缓冲区有脏内容，但本端证不出那是自己写的（含**实例已换**：
   *    上一份证据对应的文档实例已经不在，默认 unknown）；
   *  - `observation-gap`：没有同源变更观察器 / 账本被关掉 —— 看不见别人不等于没有别人；
   *  - `dirty-quarantine`：脏缓冲区在没有 grant 级许可时要求写盘或归档
   *    （grant 缺 `allowDirtySave`，或归档本身要求干净基线）。
   *
   * ★ **不许复用 `-32012`**：`-32012` 的处置是"重读锚点、重发"，本码的处置是"别重发"
   * —— 共用一个码等于让消费者把"来源不明"当成"锚点过期"来自动重试，那正是 A2 要挡的事。
   * 也不许用 `-32013`：磁盘冲突说的是**盘上**那份字节，本码说的是**缓冲区/观察链**里的来源。
   */
  DOCUMENT_DIRTY: -32011,
  /**
   * 文档版本锚点冲突（T30：`vscode.applyEdit` 的前置条件）。**新增**码位，不动既有码语义。
   *
   * 只在写入类能力上产生，两种情形共用本码、处置**完全一样**（停下、重新读
   * `vscode.getDocumentState`、用新版本重发；**不得**拿旧版本重试）：
   *  - 版本不符：`data = { file, expected, actual }`
   *    —— 调用方基于的版本已不是目标文档的版本（缓冲区在中间被人改过）；
   *  - 范围文本不符：`data = { file, expectedVersion, actualVersion,
   *    reason:'range-text-mismatch', expectedTextLength, actualTextLength }`
   *    —— 版本对得上，但那一块内容不是调用方以为的内容（典型：同版本下范围记错）。
   *
   * 不许拿 -32004（超时）/ -32005（能力缺失）/ -32010（没有授权绑定）代替：
   * 那三个说的是"这次没谈成"，本码说的是"谈成了，但你的锚点过期了"。
   */
  DOCUMENT_VERSION_CONFLICT: -32012,
  /**
   * 磁盘状态锚点冲突（契约 §6.2.3 / §6.2.7：`vscode.save` 的前置条件）。
   * **新增**码位，不动既有码语义。
   *
   * `params.expectedDisk = {mtime, size}` 与保存前 `workspace.fs.stat` 的真值不符
   * （文件被别的进程/别的编辑器改过、删掉了、或换成了目录）→ 本码，
   * `data = { file, expected, actual }`（`actual` 为 `null` 表示磁盘上已经没有了）。
   *
   * ★ **不许复用 `-32012`**（契约 §6.2.3 / §6.2.7 的结论）：
   * `-32012` 的处置是"重读锚点、用新版本**重发**"——它对缓冲区冲突成立，因为重读
   * `getDocumentState` 就能拿到新锚点；而磁盘冲突**永远不能自动重试**：本端无从知道
   * 磁盘上那份内容是谁写的（不是它写的），拿旧缓冲区内容覆盖一份没见过的人工改动
   * 正是 Tier 3 要挡的事。复用同一个码等于让两条处置完全相反的失败共用一套自动重试逻辑。
   *
   * 也不许拿 -32003（不存在）/ -32004（超时）/ -32603（宿主错误）代替：
   * 那三个说的是"没读到 / 没谈成"，本码说的是"读到了，但磁盘已经不是你以为的那一份"。
   */
  DISK_STATE_CONFLICT: -32013,
  /**
   * 窗口寻址失败（多窗口寻址设计 §5）。**新增**码位，不动既有码语义。
   *
   * 一个码 + `data.reason` 五选一（`reason` 才是处置依据，码本身只说"寻址没成"）：
   *  - `window-not-found`：target 解析不到任何已准入的活连接
   *    （**未准入的连接与"不存在"同码** —— 不许让 target 变成准入探针）；
   *  - `window-closed`：这个 windowId / connSeq 曾经有过，但记录或连接已经关了；
   *  - `window-ambiguous`：target 命中不止一条活连接（同一个 windowId 挂在两条连接上、
   *    或者给的是 label）；
   *  - `target-unauthorized`：读路径同时给了 `sessionId` 与 `target`，且两者不是同一条
   *    连接（绑定读的视角冲突 —— 见 §3.1 ③）；
   *  - `target-not-routable`：**写路径**带 target。写目标只由 grant 决定（§3.2），
   *    带 target 一律拒，不做"就近解释"。
   *
   * 不许拿 -32003（不存在）/ -32007（未连接）/ -32010（没有授权绑定）代替：
   * 那三个回答的是"这次通话成不成"，本码回答的是"你指的是哪一个窗口，我没法确认"。
   */
  WINDOW_TARGET_FAILED: -32014,
})

/** 错误码 → 稳定诊断串（日志与测试断言都用它，改动即破坏契约）。 */
export const ERR_NAME = Object.freeze({
  [ERR.PARSE]: 'parse-error',
  [ERR.INVALID_REQUEST]: 'invalid-request',
  [ERR.METHOD_NOT_FOUND]: 'method-not-found',
  [ERR.INVALID_PARAMS]: 'invalid-params',
  [ERR.INTERNAL]: 'internal-error',
  [ERR.UNAUTHORIZED]: 'unauthorized',
  [ERR.DECLINED]: 'declined',
  [ERR.NOT_FOUND]: 'not-found',
  [ERR.TIMEOUT]: 'timeout',
  [ERR.UNSUPPORTED]: 'unsupported',
  [ERR.UNTRUSTED_WORKSPACE]: 'untrusted-workspace',
  [ERR.DISCONNECTED]: 'disconnected',
  [ERR.PROTOCOL_INCOMPATIBLE]: 'protocol-incompatible',
  [ERR.INVALID_RESPONSE]: 'invalid-response',
  [ERR.EDIT_NOT_BOUND]: 'edit-not-bound',
  [ERR.DOCUMENT_DIRTY]: 'document-dirty',
  [ERR.DOCUMENT_VERSION_CONFLICT]: 'document-version-conflict',
  [ERR.DISK_STATE_CONFLICT]: 'disk-state-conflict',
  [ERR.WINDOW_TARGET_FAILED]: 'window-target-failed',
})

/**
 * 协议版本（本端声明值）。**v2**（T62 / A2）。
 *
 * 注意：这个常量只是「我这边是第几版」，**不是判据**。能不能和对端通话只看
 * 对端 hello 携带的 `protocolVersion` 是否落在 `SUPPORTED_PROTOCOL` 区间内（契约 §4.1 ①）。
 *
 * v1 → v2 到底改了什么（为什么这必须是一次**版本升级**，而不是"加一个错误码"）：
 *  - 新增 `-32011 document-dirty`：脏缓冲区的写许可从"调用方传个 `params.allowDirtySave`
 *    就能过"改成"grant 级显式许可"，**同一份调用在 v1/v2 下会得到不同结果**；
 *  - `vscode.save` / `vscode.deleteFile` 上"脏缓冲区"的拒绝码从 `-32012` 改为 `-32011`
 *    （`-32012` 的处置是自动重读重发，而脏缓冲区**不能**自动重发）；
 *  - 旧参数 `params.allowDirtySave` 在 v2 下**不再有任何效力**。
 *  这三条都是**语义变更**，不是可选扩展：v1 对端依约传 `allowDirtySave:true` 却能保存，
 * 接上 v2 之后会被明确拒绝——所以只能升版本 + 混配一律 `-32008`，不许拿 `[1, 2]` 装兼容。
 */
export const PROTOCOL_VERSION = 2

/**
 * 协议兼容区间 `[min, max]`（契约 §4.1 ①：形状必须是**区间**，不是单值）。
 *
 * 今天等于 `[2, 2]`——**只认 v2**。值由 `PROTOCOL_VERSION` 派生，避免「版本号升了、
 * 区间忘了改」这种静默不兼容；真要放宽到同时兼容多版，必须在这里显式写区间。
 *
 * ★ 明确**不写** `[1, 2]`：v1 ↔ v2 的差异落在**写许可**上（见 `PROTOCOL_VERSION` 的说明），
 * 说"兼容"等于让 v1 对端以为传 `allowDirtySave:true` 还算数。混配只能拒（`-32008`），
 * 且拒绝点在 hello 协商：hello 本身仍可被读到（对端能拿到明确的 incompat 诊断，
 * 而不是连接被静默掐断）。
 */
export const SUPPORTED_PROTOCOL = Object.freeze([PROTOCOL_VERSION, PROTOCOL_VERSION])

/**
 * 契约 §4.1 ① 判定表：对端 `ptv`（hello 里的 `protocolVersion`）是否兼容。
 *
 * | 对端 ptv | 判定 |
 * |---|---|
 * | 整数且 `min ≤ ptv ≤ max` | 放行 |
 * | 整数但越界 | 不兼容 → fail-closed |
 * | 缺失 / 非整数 / 非数字 | 不兼容（**不得推断为 v1**） |
 *
 * 两侧共用这一份判定（DSH 侧权威判定 + 扩展侧对等自检），避免各写一份之后漂移。
 *
 * @param {unknown} peer 对端声明的 protocolVersion（字段缺失时传 undefined）
 * @returns {{compatible: boolean,
 *            reason: 'ok'|'missing'|'not-a-number'|'not-an-integer'|'out-of-range',
 *            peer: number|string|boolean|null,
 *            peerType: string}}
 *   `peer` 只回显**原始标量**（NaN / 对象 / 函数统一归一为 null，避免把任意结构塞进
 *   错误 data —— 那会导致序列化失败或把无关内容发到对端）；
 *   `peerType` 保留类型信息，用来区分「没有这个字段」与「有字段但值非法」。
 */
export function judgeProtocolVersion(peer) {
  const [min, max] = SUPPORTED_PROTOCOL
  const peerType = peer === null ? 'null' : typeof peer
  const echo = (typeof peer === 'number' && Number.isFinite(peer))
    || typeof peer === 'string'
    || typeof peer === 'boolean'
    ? peer
    : null

  if (peer === undefined || peer === null) {
    return { compatible: false, reason: 'missing', peer: null, peerType }
  }
  if (typeof peer !== 'number' || !Number.isFinite(peer)) {
    return { compatible: false, reason: 'not-a-number', peer: echo, peerType }
  }
  if (!Number.isInteger(peer)) {
    return { compatible: false, reason: 'not-an-integer', peer: echo, peerType }
  }
  if (peer < min || peer > max) {
    return { compatible: false, reason: 'out-of-range', peer: echo, peerType }
  }
  return { compatible: true, reason: 'ok', peer: echo, peerType }
}

/** 默认请求超时。 */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * 结构化协议错误。
 * `code` 是 JSON-RPC 数字码；`data` 放诊断信息（如 missReason 风格的原因串）。
 */
export class BridgeError extends Error {
  constructor(code, message, data) {
    super(message || ERR_NAME[code] || 'bridge-error')
    this.name = 'BridgeError'
    this.code = code
    if (data !== undefined) this.data = data
  }

  /** 转成 JSON-RPC error 对象。 */
  toJSON() {
    const error = { code: this.code, message: this.message }
    if (this.data !== undefined) error.data = this.data
    return error
  }

  /** 从 JSON-RPC error 对象还原。 */
  static from(obj) {
    const err = new BridgeError(obj?.code ?? ERR.INTERNAL, obj?.message, obj?.data)
    return err
  }
}

/**
 * 连接级协议终端。
 *
 * 一个实例 = 一条连接。负责：
 *  - 出站消息序列化并写入 writer（保证单次 write 一行，避免交错）
 *  - 入站行解析、按 id 路由回待决 Promise
 *  - 超时、断连时批量拒绝待决请求
 *  - 入站请求交给 handler 处理（双向调用：扩展也能反向调用 DSH 侧）
 *
 * @param {object} opts
 * @param {(line: string) => void} opts.write 写入一行（不含换行，本类补）
 * @param {(method: string, params: any, ctx: {id: any, token?: string, link: object}) => any|Promise<any>} [opts.onRequest]
 *        处理对端发来的请求；抛 BridgeError 会转成 error 响应。
 *        `ctx.link` 是**这条连接**的终端对象（`connect()` 的返回值本体），
 *        上层靠它把「对端在这条连接上上报的身份」绑到连接上 —— 多连接时
 *        判定必须落到「将要收包的那条连接」，不能落在全局槽（评审 F1）。
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.token] 连接级凭据（协议 §3.3 顶层 token 字段）。**出站附带规则按消息类型区分**：
 *        `request()` **自动附带**（`if (token !== undefined) msg.token = token`，见 request）；
 *        `notify()` / `respond()` **默认不带**，调用点显式 `{withToken: true}` 才带（见各自「安全边界」段）；
 *        `respondError()` **恒不带** —— 它没有 withToken 通道（见其 JSDoc 的已知限制）。
 *        换句话说：本字段是「凭据来源」，不是「所有出站消息都带 token」的总开关。
 * @param {boolean} [opts.events=false] E1 transport opt-in (strict true only).
 * @param {() => boolean} [opts.eventAllowed] Live admission/trust gate; missing = denied.
 * @param {() => number} [opts.writableLength] Socket buffered bytes (separate from event queues).
 * @param {(event, ctx) => any} [opts.onEvent] Internal E2/E3 boundary, not service subscription API.
 * @param {(state) => void} [opts.onEventState] Metadata-only stale observation.
 * @param {(err: Error) => void} [opts.onError] 协议层内部异常（解析失败等）观察点
 * @param {(token: string|undefined, method: string) => boolean} [opts.authorize]
 *        入站请求/通知的鉴权钩子。返回 false → 请求方收到 -32001（通知则静默丢弃并上报）。
 *        不传则不做鉴权（单测与纯内存用法）。
 */
export function connect(opts) {
  const {
    write,
    onRequest,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    token,
    onError,
    authorize,
  } = opts

  if (typeof write !== 'function') throw new TypeError('connect: opts.write must be a function')

  /** id → { resolve, reject, timer, method } */
  const pending = new Map()
  let nextId = 1
  let closed = false
  let closeReason = null

  // E1 is opt-in. One internal stream per direction/link keeps the total bounded;
  // E3 will multiplex consumer subscriptions ABOVE this transport, not in pending.
  const eventsEnabled = opts.events === true
  let eventPeer = false
  let blocked = false
  let outgoing = null
  let incoming = null
  let outQueue = []
  let outBytes = 0
  let inQueue = []
  let inBytes = 0
  let delivering = false

  function eventAllowed() {
    return eventsEnabled && !closed && eventPeer && opts.eventAllowed?.() === true
  }
  function eventState(stream, reason) {
    if (!stream || stream.stale) return
    stream.stale = true
    stream.reason = reason
    try {
      opts.onEventState?.({ subscriptionId: stream.subscriptionId,
        streamEpoch: stream.streamEpoch, stale: true, reason, link: self })
    } catch { /* diagnostics must not poison RPC */ }
  }
  function clearInbound() {
    // The running callback cannot be recalled; retain/count it until settlement.
    inQueue = delivering ? inQueue.slice(0, 1) : []
    inBytes = inQueue.reduce((sum, entry) => sum + entry.bytes, 0)
  }
  function invalidateEvents() {
    eventState(outgoing, 'not-allowed'); eventState(incoming, 'not-allowed')
    outQueue = []; outBytes = 0; clearInbound()
  }
  function eventFrame(envelope) {
    return { jsonrpc: '2.0', method: EVENT_METHOD, params: envelope }
  }
  function flushEvents() {
    while (!closed && !blocked && outQueue.length) {
      if (!eventAllowed()) {
        invalidateEvents()
        return
      }
      if ((opts.writableLength?.() ?? 0) >= EVENT_QUEUE_MAX_BYTES) {
        blocked = true
        outgoingGap('queue-overflow')
        return
      }
      const entry = outQueue.shift()
      outBytes -= entry.bytes
      try {
        // false means ACCEPTED by Writable, but STOP until drain. Never retry it.
        if (write(entry.line) === false) blocked = true
      } catch {
        eventState(outgoing, 'write-failed')
        close('event write failed')
      }
    }
  }
  function outgoingGap(reason) {
    if (!outgoing || outgoing.stale) return
    eventState(outgoing, reason)
    outQueue = []; outBytes = 0
    if (outgoing.nextSeq >= Number.MAX_SAFE_INTEGER) return close('event sequence exhausted')
    const envelope = { subscriptionId: outgoing.subscriptionId, streamEpoch: outgoing.streamEpoch,
      seq: outgoing.nextSeq++, type: 'gap', observedAt: Date.now(), payload: { reason } }
    // Explicit credentials, just like publish(): never rely on notify defaults.
    const msg = eventFrame(envelope)
    msg.token = token
    const line = JSON.stringify(msg) + '\n'
    outQueue.push({ line, bytes: Buffer.byteLength(line) })
    outBytes = Buffer.byteLength(line)
    flushEvents()
  }
  function enqueueEvent(msg) {
    if (!eventAllowed()) { invalidateEvents(); return false }
    if (!outgoing || outgoing.stale || msg.token !== token
        || typeof token !== 'string' || token === '') return false
    if (msg.params?.subscriptionId !== outgoing.subscriptionId
        || msg.params?.streamEpoch !== outgoing.streamEpoch) return false
    if (msg.params?.seq !== outgoing.nextSeq) { outgoingGap('invalid-event'); return false }
    let line
    try {
      if (eventEnvelopeError(msg.params)) throw new Error('invalid event')
      line = JSON.stringify(msg) + '\n'
    } catch { outgoingGap('invalid-event'); return false }
    const bytes = Buffer.byteLength(line)
    if (bytes > EVENT_MAX_BYTES) { outgoingGap('event-too-large'); return false }
    if (outQueue.length >= EVENT_QUEUE_MAX_COUNT || outBytes + bytes > EVENT_QUEUE_MAX_BYTES) {
      outgoingGap('queue-overflow'); return false
    }
    outgoing.nextSeq++
    outQueue.push({ line, bytes }); outBytes += bytes
    flushEvents()
    return !closed && outgoing?.stale === false
  }
  function deliverEvents() {
    if (delivering || !inQueue.length) return
    const entry = inQueue[0]
    delivering = true
    Promise.resolve().then(() => {
      if (incoming !== entry.stream || entry.stream.stale) return
      if (!eventAllowed()) { eventState(entry.stream, 'not-allowed'); clearInbound(); return }
      return opts.onEvent?.(entry.envelope, { link: self })
    }).catch(() => {
      eventState(entry.stream, 'listener-failed'); clearInbound()
    }).finally(() => {
      if (inQueue[0] === entry) { inQueue.shift(); inBytes -= entry.bytes }
      delivering = false
      deliverEvents()
    })
  }
  function receiveEvent(msg, wireBytes) {
    // A dedicated per-frame token check also protects pure in-memory terminals.
    if (typeof token !== 'string' || token === '' || msg.token !== token) return
    if (!eventAllowed()) { invalidateEvents(); return }
    if (!incoming || incoming.stale) return
    const envelope = msg.params
    if (envelope?.subscriptionId !== incoming.subscriptionId
        || envelope?.streamEpoch !== incoming.streamEpoch) return
    let bytes
    try {
      if (eventEnvelopeError(envelope)) throw new Error('invalid event')
      bytes = wireBytes ?? Buffer.byteLength(JSON.stringify(msg) + '\n')
    } catch { eventState(incoming, 'invalid-event'); clearInbound(); return }
    if (bytes > EVENT_MAX_BYTES) {
      eventState(incoming, 'event-too-large'); clearInbound(); return
    }
    if (envelope.seq <= incoming.lastSeq) return // duplicate, NEVER redeliver
    if (envelope.seq !== incoming.lastSeq + 1) {
      eventState(incoming, 'seq-gap'); clearInbound(); return
    }
    incoming.lastSeq = envelope.seq // synchronous admission, before any await
    if (envelope.type === 'gap' || envelope.type === 'streamClosed') {
      eventState(incoming, envelope.payload.reason); clearInbound(); return
    }
    if (inQueue.length >= EVENT_QUEUE_MAX_COUNT || inBytes + bytes > EVENT_QUEUE_MAX_BYTES) {
      eventState(incoming, 'queue-overflow'); clearInbound(); return
    }
    // Snapshot at boundary: caller mutation cannot change queued bytes/fields.
    inQueue.push({ envelope: JSON.parse(JSON.stringify(envelope)), bytes, stream: incoming })
    inBytes += bytes
    deliverEvents()
  }
  const eventChannel = {
    get hello() { return eventsEnabled ? EVENT_CHANNEL_HELLO : undefined },
    get ready() { return eventAllowed() },
    // Internal transport installation only; NOT a consumer subscription API or RPC.
    openStream(subscriptionId) {
      const descriptor = { subscriptionId, streamEpoch: randomBytes(16).toString('hex'), startSeq: 1 }
      if (!eventAllowed() || !validEventStream(descriptor)) return null
      if (outgoing) return null // dispose before installing another stream
      outgoing = { ...descriptor, nextSeq: descriptor.startSeq, stale: false }
      return { ...descriptor }
    },
    acceptStream(descriptor) {
      if (!eventAllowed() || !validEventStream(descriptor) || incoming || delivering) return false
      incoming = { subscriptionId: descriptor.subscriptionId, streamEpoch: descriptor.streamEpoch,
        startSeq: descriptor.startSeq, lastSeq: descriptor.startSeq - 1, stale: false }
      return true
    },
    publish(type, payload, observedAt = Date.now()) {
      if (!eventAllowed()) { invalidateEvents(); return false }
      if (!outgoing || outgoing.stale) return false
      if (!EVENT_TYPES.includes(type) || type === 'gap' || type === 'streamClosed') return false
      if (outgoing.nextSeq >= Number.MAX_SAFE_INTEGER) { close('event sequence exhausted'); return false }
      return notify(EVENT_METHOD, { subscriptionId: outgoing.subscriptionId,
        streamEpoch: outgoing.streamEpoch, seq: outgoing.nextSeq, type, observedAt, payload },
      { withToken: true })
    },
    dispose() {
      eventState(outgoing, 'unsubscribed'); eventState(incoming, 'unsubscribed')
      outgoing = null; incoming = null
      outQueue = []; outBytes = 0; clearInbound()
    },
    drain() { blocked = false; flushEvents() },
    snapshot() {
      const state = (s) => s ? { subscriptionId: s.subscriptionId, streamEpoch: s.streamEpoch,
        stale: s.stale, reason: s.reason ?? null } : null
      return { enabled: eventsEnabled, ready: eventAllowed(), blocked,
        outgoing: state(outgoing), incoming: state(incoming),
        outCount: outQueue.length, outBytes, inCount: inQueue.length, inBytes }
    },
  }

  function send(obj) {
    if (closed) return false
    try {
      const accepted = write(JSON.stringify(obj) + '\n')
      if (eventsEnabled && accepted === false) blocked = true
      return true
    } catch (err) {
      onError?.(err)
      return false
    }
  }

  function reportError(err) {
    onError?.(err)
  }

  /** 主动关闭：拒绝所有待决请求，后续 send 静默丢弃。 */
  function close(reason) {
    if (closed) return
    closed = true
    closeReason = reason || 'connection closed'
    eventState(outgoing, 'closed'); eventState(incoming, 'closed')
    outQueue = []; outBytes = 0; clearInbound()
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new BridgeError(ERR.DISCONNECTED, closeReason, { method: entry.method }))
    }
    pending.clear()
  }

  /**
   * 发起请求，等待响应。
   *
   * ★ 凭据：构造时给了 `token` 就**自动附带**（见下方 msg 组装那两行）。
   * 这是本函数与 `notify()` / `respond()` 的**默认不发**之间唯一的差异，
   * 它描述的是"出站消息怎么组装"，不是"请求免于鉴权"——授权判定在入站侧
   * （`handleMessage` 里的 authorize 调用），与本函数的出站附带无关。
   *
   * @returns {Promise<any>} 成功时 resolve result；失败 reject BridgeError。
   */
  function request(method, params, reqOpts = {}) {
    if (eventsEnabled && method === EVENT_METHOD) {
      return Promise.reject(new BridgeError(ERR.INVALID_REQUEST, 'events must be notifications'))
    }
    if (closed) {
      return Promise.reject(new BridgeError(ERR.DISCONNECTED, closeReason || 'connection closed', { method }))
    }
    const id = reqOpts.id ?? nextId++
    const waitMs = reqOpts.timeoutMs ?? timeoutMs

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return
        reject(new BridgeError(ERR.TIMEOUT, `request timed out after ${waitMs}ms`, { method, id }))
      }, waitMs)
      // 超时定时器不应阻止进程退出（单测/CLI 场景友好）
      if (typeof timer.unref === 'function') timer.unref()

      pending.set(id, { resolve, reject, timer, method })

      const msg = { jsonrpc: '2.0', id, method, params: params ?? {} }
      if (token !== undefined) msg.token = token
      if (!send(msg)) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new BridgeError(ERR.DISCONNECTED, 'write failed', { method }))
      }
    })
  }

  /**
   * 单向通知，不等待响应（无 id）。
   *
   * ★ 安全边界：**默认不附带 token**。
   *
   * 这里的默认值不是风格问题。曾经写成「有 token 就附上」，结果是
   * `link.notify('bridge.hello', …)` —— 服务端在对方还没证明身份之前发出的
   * 第一条消息 —— 把整个连接的通行证一起寄了出去。任何人连上端口、什么都不发，
   * 就能从 hello 里读到 token，然后冒充合法对端（真机实测可劫持调用并伪造返回值）。
   *
   * 所以凭据必须是**显式**的：谁要发凭据，谁在调用点写明 `withToken: true`。
   * 默认不发，写代码的人就不可能"没意识到自己在发凭证"。
   *
   * 正常的业务通知本身也不需要 token —— 对方若要求鉴权，会回 -32001 让上层处理。
   */
  function notify(method, params, opts) {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} }
    if (opts?.withToken === true && token !== undefined) msg.token = token
    if (eventsEnabled && method === EVENT_METHOD) return enqueueEvent(msg)
    send(msg)
  }

  /**
   * 应答一个入站请求。
   *
   * ★ 安全边界：**默认不附带 token**，理由同 notify。
   * 对端若对响应也做鉴权（应当如此），需要显式 `{ withToken: true }`。
   */
  function respond(id, result, opts) {
    const msg = { jsonrpc: '2.0', id, result }
    if (opts?.withToken === true && token !== undefined) msg.token = token
    send(msg)
  }

  /**
   * 应答一个入站请求（错误）。
   *
   * ★ 已知限制：**没有 `withToken` 通道**，错误响应恒不带 token。
   * 也就是 `respond()` 能显式送凭据、`respondError()` 不能 —— 这是接口不对称，
   * 不是文档矛盾；要补就得给签名加 opts，属接口变更，不顺手做。
   *
   * 不对称不构成风险：响应不参与本协议鉴权（`handleMessage` 先把 isResponse 分流，
   * 之后才走 authorize），所以不带 token 的错误响应不会被对端拒收。
   * **尤其是未认证者收到的 -32001 绝不附送凭据** —— 那条响应本身就是对「凭证无效」的回答，
   * 给它带上 token 等于把通行证发给刚被拒绝的一方。
   */
  function respondError(id, code, message, data) {
    // 错误响应恒不带 token：本函数没有 withToken 通道，见上方「已知限制」。
    send({ jsonrpc: '2.0', id, error: new BridgeError(code, message, data).toJSON() })
  }

  /** 处理一条入站消息对象（已解析）。 */
  function handleMessage(msg, wireBytes) {
    if (!msg || typeof msg !== 'object') {
      reportError(new BridgeError(ERR.INVALID_REQUEST, 'message is not an object'))
      return
    }

    const isResponse = msg.id !== undefined && msg.method === undefined
    if (isResponse) {
      const entry = pending.get(msg.id)
      // 迟到的响应（已超时）静默丢弃，不算错误
      if (!entry) return
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error !== undefined && msg.error !== null) {
        entry.reject(BridgeError.from(msg.error))
      } else {
        entry.resolve(msg.result)
      }
      return
    }

    const method = msg.method
    if (typeof method !== 'string') {
      // 无 method 也无 id：非法
      if (msg.id !== undefined) respondError(msg.id, ERR.INVALID_REQUEST, 'missing method')
      else reportError(new BridgeError(ERR.INVALID_REQUEST, 'missing method'))
      return
    }

    // ctx.link 是**这条连接**的终端本体：上层把对端上报的身份（协议版本/能力）
    // 挂在它上面，判定与收包因此永远是同一条连接。缺了它，上层只能记「最后一次
    // hello」，多编辑器窗口时会把业务请求发给声明不兼容版本的对端（评审 F1）。
    const ctx = { id: msg.id, token: msg.token, link: self }

    // 鉴权先于一切业务分派（协议 §6.3）。token 不在连接建立时校验，而是每条消息，
    // 这样连接本身不泄露「token 对不对」，且断线重连不必重开 socket。
    if (authorize && !authorize(msg.token, method)) {
      if (msg.id !== undefined) {
        respondError(msg.id, ERR.UNAUTHORIZED, 'unauthorized',
          { method, reason: msg.token === undefined ? 'missing-token' : 'bad-token' })
      } else {
        reportError(new BridgeError(ERR.UNAUTHORIZED, 'unauthorized notification dropped',
          { method, reason: msg.token === undefined ? 'missing-token' : 'bad-token' }))
      }
      return
    }

    if (eventsEnabled && method === 'bridge.hello') {
      eventPeer = judgeProtocolVersion(msg.params?.protocolVersion).compatible
        && msg.params?.eventChannel?.version === EVENT_CHANNEL_VERSION
      if (!eventPeer) {
        eventState(outgoing, 'not-allowed'); eventState(incoming, 'not-allowed')
        outQueue = []; outBytes = 0; clearInbound()
      }
    }
    if (eventsEnabled && method === EVENT_METHOD) {
      if (msg.id !== undefined) respondError(msg.id, ERR.INVALID_REQUEST, 'events must be notifications')
      else receiveEvent(msg, wireBytes)
      return // Never call a business/write handler, never touch the pending map.
    }

    if (msg.id === undefined) {
      // 入站通知：处理但不回包
      if (onRequest) {
        Promise.resolve()
          .then(() => onRequest(method, msg.params ?? {}, ctx))
          .catch(reportError)
      }
      return
    }

    if (!onRequest) {
      respondError(msg.id, ERR.METHOD_NOT_FOUND, `no handler for method "${method}"`, { method })
      return
    }

    Promise.resolve()
      .then(() => onRequest(method, msg.params ?? {}, ctx))
      .then(
        (result) => respond(msg.id, result === undefined ? null : result),
        (err) => {
          if (err instanceof BridgeError) {
            respondError(msg.id, err.code, err.message, err.data)
          } else {
            respondError(msg.id, ERR.INTERNAL, err?.message || String(err))
          }
        },
      )
  }

  /** 喂入一条入站行（不含换行符）。 */
  function handleLine(line) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line
    if (text.trim() === '') return
    let msg
    try {
      msg = JSON.parse(text)
    } catch (err) {
      // 无法确定 id，只能上报（不毒化连接）
      reportError(new BridgeError(ERR.PARSE, `invalid JSON: ${err.message}`))
      return
    }
    // Count original wire bytes: whitespace and \\u escapes must not bypass the cap.
    handleMessage(msg, eventsEnabled ? Buffer.byteLength(line) + 1 : undefined)
  }

  // 连接终端本体。先起名再返回，是为了让 handleMessage 能把 ctx.link 指向**这条连接**
  // ——上层据此把对端身份（协议版本/能力）存成「本连接的属性」，而不是一个全局槽。
  const self = {
    request,
    notify,
    // Internal link-only control plane; deliberately absent from the service facade.
    events: eventChannel,
    respond,
    respondError,
    handleLine,
    handleMessage,
    close,
    // 对端身份（协议版本/能力/客户端名），由上层在收到 hello 时写入**这条连接**。
    // null = 这条连接还没报过 hello。协议层不解释它，只保证「每条连接各有一份」。
    editor: null,
    get closed() {
      return closed
    },
    get pendingCount() {
      return pending.size
    },
  }
  return self
}

/**
 * 按行切分流式入站数据。
 *
 * 单测友好：纯函数式累加器，不依赖 net.Socket。
 * 处理半行（一次 chunk 可能只有半条消息）。
 *
 * @param {(line: string) => void} onLine
 * @returns {(chunk: string|Buffer) => void}
 */
export function createLineSplitter(onLine) {
  let buf = ''
  return function feed(chunk) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      // CRLF 兼容：Windows 上若对端回显时带 \r，在分帧层就剥掉，
      // 不要指望 JSON.parse 容忍（它对尾部 \r 是 UTF-8 空白，能过，但
      // 后续若做字符串级比较会踩坑）。
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.trim() !== '') onLine(line)
    }
    // 防御：对端不换行导致缓冲区无限增长
    if (buf.length > 8 * 1024 * 1024) {
      buf = ''
      throw new BridgeError(ERR.PARSE, 'inbound line exceeded 8MiB without newline')
    }
  }
}

/** 反向能力清单工具：判断能力是否被声明（方法族缺失的降级依据）。 */
export function hasCapability(capabilities, method) {
  if (!Array.isArray(capabilities)) return false
  if (capabilities.includes(method)) return true
  // 允许声明命名空间前缀（'vscode' 覆盖 'vscode.openFile'）
  const ns = method.includes('.') ? method.slice(0, method.indexOf('.')) : null
  return ns !== null && capabilities.includes(ns)
}
