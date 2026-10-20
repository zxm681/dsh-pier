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
})

/** 协议版本。扩展与 DSH 侧双向校验，不匹配即拒绝连接（阶段4 §7）。 */
export const PROTOCOL_VERSION = 1

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
 * @param {(method: string, params: any, ctx: {id: any, token?: string}) => any|Promise<any>} [opts.onRequest]
 *        处理对端发来的请求；抛 BridgeError 会转成 error 响应。
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.token] 每个出站请求自动附带（协议 §3.3 顶层 token 字段）
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

  /** 应答一个入站请求（错误）。 */
  function respondError(id, code, message, data) {
    // 错误响应同样默认不带 token（见 respond 的说明）。
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

    const ctx = { id: msg.id, token: msg.token }

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

  return {
    request,
    notify,
    respond,
    respondError,
    handleLine,
    handleMessage,
    close,
    get closed() {
      return closed
    },
    get pendingCount() {
      return pending.size
    },
  }
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
