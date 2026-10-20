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
 * @returns {Promise<{port, token, pid, links: Set, close, server, discoveryPath, broadcast}>}
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
  /** 每条连接一个协议终端 */
  const links = new Set()

  const makeLink = (socket) => {
    const write = (line) => {
      if (socket.destroyed || !socket.writable) return
      socket.write(line)
    }
    // ★ 安全：连接建立 ≠ 准入。
    //
    // TCP 连上只证明「有个进程够得着这个端口」，不证明它是合法编辑器。
    // 所以这里先打成未准入，只有通过 token 校验的入站消息才把它升为准入连接。
    // 上层（index.js 的 _activeLink）只在准入连接里挑 active —— 否则任何一个
    // 本机进程裸连上来、什么都不发，靠「最后连上的赢」就能截走 DSH 的调用
    // （安全审计 洞 2；work/scripts/lesson3-hijack.mjs 是它的复现）。
    //
    // 注意：仍要照常 links.add(link)，因为 close() 靠这个集合销毁底层 socket
    // （踩过：只 close 协议终端不断 TCP，server.close() 会永久挂住）。
    // 「准入」是另一个维度，用标志位表达，不要和「连接存在」混为一谈。
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
        if (link.authorized !== true) {
          link.authorized = true
          // 准入是「异步才可能发生」的事件，必须在这里通知，不能靠连接建立。
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
    socket.on('close', () => { link.close('peer disconnected'); links.delete(link) })
    socket.on('error', (err) => { onError?.(err); link.close(err.message); links.delete(link) })
    // 允许进程在只剩空闲连接时也能退出（测试与 CLI 场景都需要）
    socket.unref?.()
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

  /** 向所有已连接的对端广播通知（不等待响应）。 */
  function broadcast(method, params) {
    for (const link of links) link.notify(method, params)
  }

  return {
    port,
    token,
    pid: process.pid,
    server,
    links,
    discoveryPath,
    capabilities,
    onConnected,
    broadcast,
    close,
    get closed() { return closed },
  }
}
