/**
 * 桥接服务端：loopback TCP 监听 + 发现文件 + 死 pid 清扫。
 *
 * 安全边界（阶段4 §6）：
 *  - 只监听 127.0.0.1，永不监听 0.0.0.0（防止局域网暴露）。
 *  - token 每实例随机 32 字节；发现文件 0600 权限。
 *  - 发现文件原子写（临时文件 + rename），读者永远看到完整内容。
 *  - 进程退出时删除发现文件；启动时清扫死 pid 留下的残留。
 *
 * 零依赖：只用 node:net / node:fs / node:crypto / node:os / node:path。
 */

import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { connect, createLineSplitter, BridgeError, ERR, PROTOCOL_VERSION } from './protocol.js'
// 发现文件规则由 DSH 侧与 VSCode 侧共用同一份实现（写/读必须同一套权限与原子性）。
// 这里 re-export，保持既有 import 路径（含单测）不变。
import {
  DISCOVERY_DIR_NAME, resolveDshHome, discoveryDir, writeDiscoveryFile,
  removeDiscoveryFile, isProcessAlive, sweepDiscoveryDir, listLiveBridges,
} from './discovery.js'

export {
  DISCOVERY_DIR_NAME, resolveDshHome, discoveryDir, writeDiscoveryFile,
  removeDiscoveryFile, isProcessAlive, sweepDiscoveryDir, listLiveBridges,
}

/** 默认端口区间，刻意避开 dsh-vscode-bridge 的 7310–7319（阶段3 风险 #2）。 */
export const DEFAULT_PORT_RANGE = [7410, 7419]

/**
 * 全进程共享的退出清理注册表。
 *
 * 每个 startBridgeServer 把自己的 cleanup 放进来；进程退出或收到信号时
 * 统一跑一遍。这样无论起多少个桥，process 上永远只有一组监听器。
 */
const exitCleanupRegistry = new Set()
let exitHooksInstalled = false

function runExitCleanup() {
  for (const fn of [...exitCleanupRegistry]) {
    try { fn() } catch { /* 退出路径上不许抛 */ }
  }
  exitCleanupRegistry.clear()
}

/**
 * 安装进程级退出钩子。无论起多少个桥，这里只执行一次。
 * 覆盖：正常退出（exit）、Ctrl+C（SIGINT）、kill（SIGTERM）、终端关闭（SIGHUP）。
 */
function ensureExitHooks() {
  if (exitHooksInstalled) return
  exitHooksInstalled = true
  process.once('exit', runExitCleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => { runExitCleanup(); process.exit(0) })
  }
}

/** 在端口区间里找一个可监听的端口；全被占则抛错。 */
async function listenOnFreePort(host, range, createBridgeFor, onConnection) {
  const [from, to] = range
  let lastErr = null
  for (let port = from; port <= to; port++) {
    const server = createServer(onConnection(createBridgeFor))
    const bound = await new Promise((resolve) => {
      const cleanup = () => {
        server.removeListener('error', onError)
        server.removeListener('listening', onListening)
      }
      const onError = (err) => { cleanup(); lastErr = err; resolve(false) }
      const onListening = () => { cleanup(); resolve(true) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
    if (bound) return { server, port }
    try { server.close() } catch { /* ignore */ }
  }
  throw new BridgeError(ERR.INTERNAL,
    `no free port in range ${from}-${to}`, { lastError: lastErr?.message })
}

/**
 * 启动桥接服务端。
 *
 * @param {object} opts
 * @param {number[]} [opts.portRange]  默认 [7410, 7419]
 * @param {string}  [opts.host]        默认 '127.0.0.1'（永不可配成 0.0.0.0）
 * @param {string}  [opts.dshHome]     DSH_HOME，决定发现文件位置
 * @param {string}  [opts.dshVersion]  握手时上报的 DSH 版本
 * @param {string[]}[opts.capabilities] 本端声明支持的能力（方法族）
 * @param {(method, params, ctx) => any} [opts.onRequest] 处理 VSCode 侧发来的请求
 * @param {(err) => void} [opts.onError]
 * @param {number}  [opts.timeoutMs]
 * @param {boolean} [opts.sweep]       启动时清扫死 pid，默认 true
 * @returns {Promise<{port, token, pid, links: Set, trusted: Set, close, server, discoveryPath, broadcast}>}
 */
export async function startBridgeServer(opts = {}) {
  const {
    portRange = DEFAULT_PORT_RANGE,
    host = '127.0.0.1',
    dshHome,
    dshVersion = 'unknown',
    capabilities = [],
    onRequest,
    onError,
    timeoutMs,
    sweep = true,
    onConnected,
    onAuthorized,
  } = opts

  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new BridgeError(ERR.INTERNAL, `refusing to bind non-loopback host "${host}"`)
  }

  const dir = discoveryDir(dshHome)
  if (sweep) sweepDiscoveryDir(dir)

  const token = randomBytes(32).toString('hex')
  /** 所有活 socket：只供关闭时资源回收，不可用来挑请求或广播目标。 */
  const links = new Set()
  /** 已通过 token 校验的活连接：唯一可选请求目标。 */
  const trusted = new Set()
  /**
   * 单调递增的**连接序号**：建连时赋值一次，与准入先后无关。
   *
   * ★ 回归（评审 R1）：`trusted` 是在**首次准入**时 add 的，所以集合顺序是
   *   「准入先后」；而拆分前的实现（`[...links].filter(authorized).at(-1)`）
   *   里 `links` 在建连时 add，取末项是「连接先后」。两者都合法时目标会漂移：
   *   connect A → connect B → 先准入 B → 后准入 A，旧算法给 B，只取 trusted 末项给 A，
   *   于是 vscode.openFile 之类的请求会送到另一个编辑器窗口 —— 属于意外的契约变更。
   *   现在目标统一按 connSeq 最大者挑选，行为与旧实现一致（见 index.js _activeLink）。
   */
  let connSeq = 0

  const makeLink = (socket) => {
    const write = (line) => {
      if (socket.destroyed || !socket.writable) return
      socket.write(line)
    }
    // ★ 安全：连接建立 ≠ 准入。links 收纳全部 socket 以便 close() 销毁；
    // trusted 只收经过 token 校验的活连接，_activeLink() 不遍历 links。
    // authorized 仍保留供旧诊断使用，但不再承担目标选择的安全边界。
    let link
    link = connect({
      write,
      onRequest,
      timeoutMs,
      token,
      onError,
      // 所有入站消息都要求顶层 token 与本实例 token 一致（协议 §3.3）。
      authorize: (incoming) => {
        if (incoming !== token) return false
        // 第一条通过校验的消息即为准入时刻。此后这条连接才有资格当 active。
        if (!trusted.has(link) && links.has(link) && !socket.destroyed) {
          trusted.add(link) // 先升格，再同步通知；回调内即可安全挑 active。
          link.authorized = true
          try { onAuthorized?.(link) } catch (err) { onError?.(err) }
        }
        return true
      },
    })
    link.authorized = false
    link.socket = socket
    const feed = createLineSplitter((line) => link.handleLine(line))
    socket.on('data', (chunk) => {
      try { feed(chunk) } catch (err) { onError?.(err); socket.destroy() }
    })
    socket.on('close', () => { link.close('peer disconnected'); trusted.delete(link); links.delete(link) })
    socket.on('error', (err) => { onError?.(err); link.close(err.message); trusted.delete(link); links.delete(link) })
    // 允许进程在只剩空闲连接时也能退出（测试与 CLI 场景都需要）
    socket.unref?.()
    // 连接序号在 links.add 的同一处赋值：一条连接一个序号，建连那一刻定死，
    // 之后「第几条准入」不再影响目标选择。_activeLink() 按它挑最后连接的那条。
    link.connSeq = ++connSeq
    links.add(link)
    // 协议 §3.4：hello 必须是每条连接的第一条消息，由服务端主动下发。
    // 这属于协议层行为，放 server 本体；onConnected 只是插件层的附加钩子。
    link.notify('bridge.hello', {
      client: 'dsh-vscode-kit',
      protocolVersion: PROTOCOL_VERSION,
      dshVersion,
      capabilities,
    })
    // 连接建立回调（插件层用来记录身份/唤醒等待者）。
    // 回调放 try/catch：插件层抛错不允许毒化连接建立。
    try { onConnected?.(link) } catch (err) { onError?.(err) }
    return link
  }

  const { server, port } = await listenOnFreePort(
    host, portRange, makeLink, (fn) => (socket) => fn(socket),
  )

  const payload = {
    port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    dshVersion,
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
  }
  const discoveryPath = writeDiscoveryFile(dir, payload)

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    for (const link of links) {
      link.close('server shutting down')
      // 关键：只 close 协议终端不会断 TCP，server.close() 会一直等连接结束。
      try { link.socket?.destroy() } catch { /* ignore */ }
    }
    links.clear()
    trusted.clear()
    removeDiscoveryFile(dir, process.pid)
  }

  // 退出回收：正常退出与 SIGINT/SIGTERM 都清理发现文件。
  //
  // 为什么用「进程级单例 + 注册表」而不是每个实例各挂一次监听：
  // 一个 DSH 进程里可能起多个桥（多 profile / 测试），每个都挂 SIGINT/SIGTERM
  // 会撞 MaxListeners=10 警告，而且在 MaxListeners=0 的宿主里会静默泄漏。
  // 这里只挂一次，用注册表分发。
  ensureExitHooks()
  exitCleanupRegistry.add(cleanup)

  function close() {
    return new Promise((resolve) => {
      cleanup()
      exitCleanupRegistry.delete(cleanup)
      server.close(() => resolve())
      // server.close() 只停止接受新连接；残留连接已在 cleanup 里 destroy。
      // 某些 Node 版本上 close 回调可能因定时器不触发，兜底一次。
      setTimeout(resolve, 500).unref?.()
    })
  }

  /** 有意收紧的契约变更：通知只发给已准入连接；未认证者收内容属洞 1 同类外泄。 */
  function broadcast(method, params) {
    for (const link of trusted) link.notify(method, params)
  }

  return {
    port,
    token,
    pid: process.pid,
    server,
    links,
    trusted,
    discoveryPath,
    capabilities,
    onConnected,
    broadcast,
    close,
    get closed() { return closed },
  }
}
