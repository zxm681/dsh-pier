/**
 * 连接管理器：发现 DSH → 连上 → 握手 → 维持/重连。
 *
 * 刻意**不碰 vscode**：所有宿主能力经 `deps` 注入，因此可以用真 TCP + 假宿主跑单测。
 * 这一层是「薄扩展」里唯一有状态的部件，其余文件都是纯函数。
 *
 * 状态机：
 *   idle → connecting → ready → (断开) → idle → ……
 *             ↓ 失败
 *          idle（等下一次轮询）
 */

import { createConnection } from 'node:net'

import {
  BridgeError, ERR, PROTOCOL_VERSION, connect, createLineSplitter,
} from '../../dsh-vscode-kit/src/protocol.js'
import { discoveryDir, listLiveBridges } from '../../dsh-vscode-kit/src/discovery.js'
import { CAPABILITIES } from './capabilities.js'

/** 扩展对外声明的身份（写进 hello，DSH 侧据此判能力）。 */
export const CLIENT_ID = 'dsh-kit-bridge'
export const EXTENSION_VERSION = '0.2.0'

/**
 * @param {object} deps
 * @param {(method, params) => Promise<any>} deps.dispatch   能力分派（capabilities.dispatch）
 * @param {(msg: string, level?: string) => void} [deps.log]
 * @param {() => string|undefined} [deps.dshHome]            发现文件根目录
 * @param {number} [deps.pollIntervalMs]                     轮询间隔
 * @param {number} [deps.connectTimeoutMs]                   单次连接超时
 * @param {number} [deps.requestTimeoutMs]                   出站请求默认超时
 * @param {(info) => void} [deps.onStateChange]              状态变化观测点
 * @param {(method, params, ctx) => any} [deps.onRequest]    额外入站处理方法（测试/扩展用）
 */
export function createConnector(deps) {
  const {
    dispatch,
    log = () => {},
    dshHome,
    pollIntervalMs = 2000,
    connectTimeoutMs = 3000,
    requestTimeoutMs = 30_000,
    onStateChange = () => {},
    onRequest,
  } = deps

  /**
   * DSH 侧发来的入站方法（编辑器 → DSH 是请求方向，DSH → 编辑器是能力方向）。
   * 首版只有 ping；保留 onRequest 注入点给测试与未来扩展。
   */
  const inbound = {
    'bridge.ping': (params) => ({ pong: true, at: Date.now(), echo: params }),
    'bridge.hello': (params) => {
      // DSH 侧极少主动 hello（协议约定由 DSH 先发），但兜住：对端若发，回自己的身份。
      return {
        ok: true,
        client: CLIENT_ID,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
      }
    },
    ...(undefined), // 自定义 onRequest 在 handleInbound 里串接，不放进这张表
  }

  /** @type {{state: string, port?: number, pid?: number, dshVersion?: string, since: number}} */
  let state = { state: 'idle', since: Date.now() }
  /** @type {import('node:net').Socket|null} */
  let socket = null
  /** @type {ReturnType<typeof connect>|null} */
  let link = null
  let pollTimer = null
  let stopped = false
  /** 已自动重连的次数（诊断用） */
  let attempts = 0

  function setState(next, patch = {}) {
    state = { state: next, since: Date.now(), ...patch }
    try { onStateChange(state) } catch { /* 观测点异常不许影响连接 */ }
  }

  /**
   * DSH 侧发来的入站请求分派。
   *
   * 顺序很重要：先认协议层方法（ping/hello），**其余一律交给能力分派**。
   * 早期版本忘了最后这一步 fallthrough，结果 vscode.* 全被当成未知方法回 -32601 ——
   * 端到端测试当场抓到（见打样日志坑 11）。
   */
  function handleInbound(method, params, ctx) {
    const fn = inbound[method]
    if (fn) return fn(params)
    if (onRequest) {
      const custom = onRequest(method, params, ctx)
      if (custom !== undefined) return custom
    }
    // 未实现的能力由 capabilities.dispatch 回 -32005（可与「协议层方法不存在」区分）。
    return dispatch(method, params)
  }

  /** 连一个具体实例。失败 reject，不重试（重试交给轮询）。 */
  function connectTo(info) {
    return new Promise((resolve, reject) => {
      const s = createConnection({ port: info.port, host: '127.0.0.1' })
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { s.destroy() } catch { /* ignore */ }
        reject(new BridgeError(ERR.TIMEOUT, `connect to 127.0.0.1:${info.port} timed out`,
          { port: info.port }))
      }, connectTimeoutMs)
      timer.unref?.()

      s.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(s)
      })
      s.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new BridgeError(ERR.DISCONNECTED, `connect failed: ${err.message}`,
          { port: info.port, code: err.code }))
      })
    })
  }

  /** 接上一条 socket，装配协议终端。 */
  function attach(s, info) {
    socket = s
    link = connect({
      write: (line) => { if (!s.destroyed && s.writable) s.write(line) },
      onRequest: handleInbound,
      timeoutMs: requestTimeoutMs,
      token: info.token,
      onError: (err) => log(`protocol: ${err?.message ?? err}`, 'warn'),
      // 入站鉴权：DSH 侧发的消息必须带同一个 token（对端被冒名时我们能发现）。
      // 例外是 bridge.hello：它是 DSH 侧连上后主动打的招呼，发生在双方互相确认之前，
      // 按协议**不允许携带 token**（曾经携带过，等于把通行证寄给任何连上端口的人）。
      // 放行它不会削弱安全：hello 里没有任何秘密，且它只作协议版本公告，不触发任何动作。
      authorize: (incoming, method) => method === 'bridge.hello' || incoming === info.token,
    })
    link.socket = s

    const feed = createLineSplitter((line) => link.handleLine(line))
    s.on('data', (chunk) => {
      try { feed(chunk) } catch (err) { log(`framing: ${err?.message ?? err}`, 'warn') }
    })
    s.on('close', () => {
      if (socket !== s) return
      socket = null
      link = null
      setState('idle', { reason: 'disconnected' })
      log('disconnected from DSH', 'warn')
    })
    s.on('error', (err) => { log(`socket: ${err?.message ?? err}`, 'warn') })
    s.unref?.()

    setState('ready', { port: info.port, pid: info.pid, dshVersion: info.dshVersion })
    log(`connected to DSH pid=${info.pid} port=${info.port} dsh=${info.dshVersion ?? 'unknown'}`)

    // 主动回报身份：DSH 侧据 capabilities 做能力降级判定。
    // 这是请求（要拿到对端确认），失败只记日志不推翻连接。
    link.request('bridge.hello', {
      client: CLIENT_ID,
      extensionVersion: EXTENSION_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      capabilities: CAPABILITIES,
    }).catch((err) => log(`hello failed: ${err?.message ?? err}`, 'warn'))
  }

  /** 一次轮询：没连上就找最新的实例连；已连上就检查对端是否还活着。 */
  async function tick() {
    if (stopped || state.state === 'ready' || state.state === 'connecting') return
    const dir = discoveryDir(dshHome)
    const bridges = listLiveBridges(dir)
    if (bridges.length === 0) return

    // 多实例仲裁：连 startedAt 最新的（用户刚起的那个）。
    const target = bridges[0]
    setState('connecting', { port: target.port, pid: target.pid })
    attempts += 1
    try {
      const s = await connectTo(target)
      if (stopped) { s.destroy(); return }
      attach(s, target)
    } catch (err) {
      setState('idle', { reason: err?.message ?? String(err), attempts })
      log(`connect attempt #${attempts} failed: ${err?.message ?? err}`, 'warn')
    }
  }

  function schedule() {
    if (stopped) return
    pollTimer = setTimeout(() => {
      tick().finally(schedule)
    }, pollIntervalMs)
    pollTimer.unref?.()
  }

  return {
    /** 开始轮询（幂等）。 */
    start() {
      if (stopped) return
      if (pollTimer) return
      tick().finally(schedule)
    },
    /** 立刻重连（忽略当前轮询节奏）。 */
    reconnect() {
      if (socket) {
        try { socket.destroy() } catch { /* ignore */ }
        socket = null
        link = null
      }
      setState('idle', { reason: 'manual-reconnect' })
      return tick()
    },
    stop() {
      stopped = true
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (link) link.close('connector stopped')
      if (socket) {
        // 与 DSH 侧同一个教训：协议层 close ≠ 传输层 close。
        try { socket.destroy() } catch { /* ignore */ }
      }
      socket = null
      link = null
      setState('idle', { reason: 'stopped' })
    },
    get state() { return state },
    get connected() { return state.state === 'ready' },
    get attempts() { return attempts },
    /** 供测试/扩展调用 DSH 侧方法。 */
    request(method, params, opts) {
      if (!link) {
        return Promise.reject(new BridgeError(ERR.DISCONNECTED, 'not connected to DSH',
          { method, reason: 'not-connected' }))
      }
      return link.request(method, params, opts)
    },
    /** 测试用：直接注入一条入站行。 */
    _handleLine(line) { return link?.handleLine(line) },
  }
}
