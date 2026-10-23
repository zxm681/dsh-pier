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
import {
  connect, createLineSplitter, BridgeError, ERR, PROTOCOL_VERSION,
  judgeProtocolVersion, SUPPORTED_PROTOCOL,
} from './protocol.js'
// 发现文件规则由 DSH 侧与 VSCode 侧共用同一份实现（写/读必须同一套权限与原子性）。
// 这里 re-export，保持既有 import 路径（含单测）不变。
import {
  DISCOVERY_DIR_NAME, resolveDshHome, discoveryDir, writeDiscoveryFile,
  removeDiscoveryFile, isProcessAlive, sweepDiscoveryDir, listLiveBridges,
} from './discovery.js'
// 写入类方法的入口护栏（评审 F5）：广播没有回执，不许承载写入类方法。
import { assertWritableNotNotified } from './grant.js'

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
 * 从 `trusted` 里取出「还活着」的连接（多窗口寻址 W1 起提为公开定义，= §8 的「只读访问器」）。
 *
 * 为什么提出来而不是各写一遍：`broadcast` 的投递面、`windows.list()` 的可见面、
 * target 解析的候选面**必须是同一个集合**。三处各写一份判断，迟早有一处忘了跳过已关闭
 * 的连接 —— 那种 bug 的表现是"表里有、一发就断"，最难查。
 *
 * 「活」只有两条：连接没标记关闭、socket 没销毁。**不看 `authorized`**：
 * 传进来的集合本来就是 `trusted`（准入过的那批），准入判定不在这里，也不许在这里补。
 *
 * @param {Iterable<any>} trusted
 * @returns {any[]} 保持 `trusted` 的插入顺序（即首连顺序；排序由调用方自己定）
 */
export function liveTrustedLinks(trusted) {
  const out = []
  if (!trusted || typeof trusted[Symbol.iterator] !== 'function') return out
  for (const link of trusted) {
    if (!link) continue
    if (link.closed === true) continue
    if (link.socket?.destroyed) continue
    out.push(link)
  }
  return out
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
 * @returns {Promise<{port, token, pid, links: Set, trusted: Set, liveTrusted, close, server, discoveryPath, broadcast}>}
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
    /**
     * 连接消失（close/error/server 关闭）回调 —— 插件层用它回收挂在该连接上的
     * 会话授权（`grants.closeLink(link)`，契约 §6.1.1 ①-b(2)「执行端本地完成」）。
     * 传的是**连接对象本身**：回收判据是对象身份，不是序号。
     */
    onLinkClosed,
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
      if (socket.destroyed || !socket.writable) {
        if (opts.events === true) throw new BridgeError(ERR.DISCONNECTED, 'socket not writable')
        return // retain the legacy writer behavior when events are disabled
      }
      return socket.write(line)
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
      events: opts.events === true,
      writableLength: () => socket.writableLength,
      eventAllowed: () => trusted.has(link) && !socket.destroyed,
      onEvent: opts.onEvent,
      onEventState: opts.onEventState,
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
    if (opts.events === true) socket.on('drain', () => link.events.drain())
    const feed = createLineSplitter((line) => link.handleLine(line))
    socket.on('data', (chunk) => {
      try { feed(chunk) } catch (err) { onError?.(err); socket.destroy() }
    })
    socket.on('close', () => {
      // ★ 会话授权绑定（契约 §6.1.1 ①-b(2)）：承载连接消失 → 该连接上的 grant 立刻失效。
      //   判据是**连接对象身份**（grant 表里存的就是这个 link 引用），不碰序号/计数。
      //   顺序：先关协议终端（此后这条连接既不能发也不能收），再通知插件层回收凭证。
      link.close('peer disconnected')
      trusted.delete(link)
      links.delete(link)
      try { onLinkClosed?.(link) } catch (err) { onError?.(err) }
    })
    socket.on('error', (err) => {
      onError?.(err)
      link.close(err.message)
      trusted.delete(link)
      links.delete(link)
      try { onLinkClosed?.(link) } catch (e) { onError?.(e) }
    })
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
      ...(opts.events === true ? { eventChannel: link.events.hello } : {}),
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
      // 关闭服务 = 所有承载连接都没了：挂在它们上面的编辑授权一并失效
      // （契约 §6.1.1 ①-b(2)：宿主重启后不落盘、全消失）。
      try { onLinkClosed?.(link) } catch (err) { onError?.(err) }
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

  /**
   * 广播业务通知：**只投给版本兼容的连接**（评审 N1）。
   *
   * 有意收紧的契约变更之一：通知只发给已准入连接；未认证者收内容属洞 1 同类外泄。
   *
   * ★ 评审 N1（同族旁路）：这里曾经只遍历 `trusted` 直接 `notify`，**完全绕过版本门**
   *   —— 与 `VscodeKit.notify()`（评审 F2）是同一个洞的两种形态：不兼容对端照样收到
   *   业务帧。现在按**每条连接自己的**版本事实逐条判定：
   *   判据是 `link.editor`（由入站 `bridge.hello` 落位，经 protocol.js 的 `ctx.link`
   *   绑在「这条连接」上），**不再引入全局槽** —— 全局槽正是评审 F1 的双源根因。
   *   判定核心与 `index.js` 的 `_assertProtocolCompatible` 共用同一份
   *   `judgeProtocolVersion` / `SUPPORTED_PROTOCOL`，两处只有「错误怎么长」不同。
   *
   * 语义：
   *  - 兼容连接：正常投递；
   *  - 版本缺失 / 不兼容 / 已关闭的连接：**跳过**。既不发业务帧，也不给它们回错误帧
   *    （广播没有「对端侧」的错误通道；往不兼容对端写错误帧同样算业务帧泄漏）；
   *  - **一条兼容连接都没有：抛 -32008**，data 形状对齐契约 §4.1 ③，让调用方知道
   *    「发了但没人在听」，而不是静默成功（静默成功正是 N1 暴露的问题形态）；
   *  - `bridge.*` 协议层方法继续**豁免**（协商通道不能自己堵死），此时照常返回计数。
   *
   * @param {string} method
   * @param {any} [params]
   * @returns {number} 实际投递到的连接数（0 只可能出现在 `bridge.*` 豁免路径上）
   * @throws {BridgeError} -32602 方法名非法 / -32008 没有任何版本兼容的连接
   */
  function broadcast(method, params) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string', { method })
    }
    // ★ 评审 F5：写入类方法**不许**走广播。广播是无回执的「发出去就算」，既过不了
    //   会话绑定门，也拿不到扩展侧落点前的复核与回执；入口直接拒，要求改用 request()。
    assertWritableNotNotified(method, 'broadcast')

    /** 只对「还活着」的连接投递：socket 已销毁 / 终端已关的连接收不到。 */
    const live = () => liveTrustedLinks(trusted)

    // 协议层方法豁免版本门：否则版本不兼容时连「问一句对方是几版」都做不到。
    // 豁免口径必须与 index.js `_assertProtocolCompatible` 一致（同一条规则两处用）。
    if (method.startsWith('bridge.')) {
      const targets = live()
      for (const link of targets) link.notify(method, params)
      return targets.length
    }

    // 逐条连接判定：判定对象 = 将要收包的那条连接，不多不少。
    const candidates = live().map((link) => {
      const editor = link.editor ?? null
      return { link, verdict: judgeProtocolVersion(editor ? editor.protocolVersion : undefined) }
    })

    let delivered = 0
    for (const { link, verdict } of candidates) {
      if (!verdict.compatible) continue
      link.notify(method, params)
      delivered++
    }
    if (delivered > 0) return delivered

    // ── 零投递：必须可被调用方感知（不许静默成功）──
    const [min, max] = SUPPORTED_PROTOCOL
    // 只有一个候选时，它的判定就是结论，回显原始值最利于排障；
    // 多个候选时「谁不兼容」有歧义，peer 取不到就给 null（契约 §4.1 ③ 的归一规则）。
    const single = candidates.length === 1 ? candidates[0].verdict : null
    const zeroReason = candidates.length === 0 ? 'no-editor' : 'no-compatible-connection'
    throw new BridgeError(
      ERR.PROTOCOL_INCOMPATIBLE,
      candidates.length === 0
        ? `protocol version incompatible: no connection to broadcast "${method}" to`
          + ` (supported ${min}..${max})`
        : `protocol version incompatible: no compatible connection among ${candidates.length}`
          + ` (supported ${min}..${max}); refusing to broadcast "${method}"`,
      {
        required: { min, max },
        peer: single ? single.peer : null,
        peerType: single ? single.peerType : (candidates.length === 0 ? 'undefined' : 'null'),
        reason: single ? single.reason : zeroReason,
        helloReceived: candidates.some(({ link }) => link.editor !== null),
        method,
        side: 'dsh',
        // 以下为排障字段（不属于契约 §4.1 ③ 的必填集）
        delivered: 0,
        connections: candidates.length,
      },
    )
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
    /**
     * 只读访问器：已准入且仍活着的连接（`windows.list()` / target 解析共用）。
     *
     * **只读**：返回新数组，调用方拿到的不是 `trusted` 本身，改它不影响投递面。
     */
    liveTrusted: () => liveTrustedLinks(trusted),
    close,
    get closed() { return closed },
  }
}
