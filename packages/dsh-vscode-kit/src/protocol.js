/**
 * DSH Editor Bridge Protocol v1 —— 传输无关的协议核心。
 *
 * 设计原则（阶段4 架构草图 §3）：
 *  1. 零依赖：只用 Node 内置模块，绝 import @deepseek-ai/*（ERR_MODULE_NOT_FOUND 前科）。
 *  2. 传输无关：本文件不碰 net/fs，只做「字节行 ↔ JSON-RPC 消息 ↔ 待决 Promise」。
 *  3. 可单测：connect() 注入任意可写流 + 可喂入任意行，无端口无进程。
 *
 * 分帧：ndjson。JSON.stringify 会把内部换行转义为 \n，故按 '\n' 切行无粘包歧义。
 */

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
})

/**
 * 协议版本（本端声明值）。
 *
 * 注意：这个常量只是「我这边是第几版」，**不是判据**。能不能和对端通话只看
 * 对端 hello 携带的 `protocolVersion` 是否落在 `SUPPORTED_PROTOCOL` 区间内（契约 §4.1 ①）。
 */
export const PROTOCOL_VERSION = 1

/**
 * 协议兼容区间 `[min, max]`（契约 §4.1 ①：形状必须是**区间**，不是单值）。
 *
 * 今天等于 `[1, 1]`——只认 v1。值由 `PROTOCOL_VERSION` 派生，避免「版本号升了、
 * 区间忘了改」这种静默不兼容；真要放宽到同时兼容多版，必须在这里显式写区间。
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

  function send(obj) {
    if (closed) return false
    try {
      write(JSON.stringify(obj) + '\n')
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
  function handleMessage(msg) {
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
    handleMessage(msg)
  }

  // 连接终端本体。先起名再返回，是为了让 handleMessage 能把 ctx.link 指向**这条连接**
  // ——上层据此把对端身份（协议版本/能力）存成「本连接的属性」，而不是一个全局槽。
  const self = {
    request,
    notify,
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
