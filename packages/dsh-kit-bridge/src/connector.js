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
  BridgeError, ERR, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, connect, createLineSplitter,
  judgeProtocolVersion,
} from '../../dsh-vscode-kit/src/protocol.js'
import { discoveryDir, listLiveBridges } from '../../dsh-vscode-kit/src/discovery.js'
import {
  GrantStore, extensionWriteGate, isWriteMethod,
} from '../../dsh-vscode-kit/src/grant.js'
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
 * @param {import('../../dsh-vscode-kit/src/grant.js').GrantStore} [deps.grants]
 *        会话授权表。**必须与能力层共用同一个实例**（否则收下的 grant 与判定的 grant 是两份）。
 * @param {{link: object|null}} [deps.linkState]
 *        "当前活连接"共享槽：本层写，能力层的绑定门读。不给就自己建一个（单测够用）。
 * @param {() => boolean} [deps.isTrusted]
 *        工作区信任（判序在 grant 之前，评审 F7）。不给则信任门不参与判定 ——
 *        能力层的 `assertTrusted` 仍会在 handler 里守住 -32006。
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
    grants: injectedGrants,
    linkState: injectedLinkState,
  } = deps

  /** 会话授权表（§6.1.1 ①-b(2)）：本端只**存** DSH 发来的 grant，绝不自己生成。 */
  const grants = injectedGrants ?? new GrantStore()
  /** 当前活连接（对象引用；绑定门按**身份**判，不按任何序号）。 */
  const linkState = injectedLinkState ?? { link: null }

  /**
   * 绑定门（契约 §6.1.1 ②A：`handleInbound` 交给 `dispatch` 之前）。
   * 与能力层那道门是**同一个函数**（`extensionWriteGate`）：两道门位置不同、
   * 判定同源，改一处不会让另一处偷偷失效。
   */
  // 信任优先（评审 F7）：未信任工作区时不在这道门里下结论，让 dispatch 的
  // `assertTrusted` 给出 -32006 —— 用户该看到"工作区没被信任"，不是"没授权"。
  const isTrusted = typeof deps.isTrusted === 'function' ? deps.isTrusted : null
  const grantGate = extensionWriteGate(grants, { isTrusted })

  /**
   * 连接消失的唯一收口：清共享槽 + 让挂在这条连接上的 grant 全部失效。
   * `cause:'disconnected'` 由**本端本地**完成（§6.1.1 ①-b(2)），不依赖 DSH 事后补发 ——
   * 断线时 DSH 可能自己都不在了。
   */
  function forgetLink(gone) {
    if (linkState.link === gone) linkState.link = null
    if (!gone) return 0
    const n = grants.closeLink(gone)
    if (n > 0) log(`edit grant invalidated by disconnect (${n})`, 'info')
    return n
  }

  /**
   * DSH 侧发来的入站方法（编辑器 → DSH 是请求方向，DSH → 编辑器是能力方向）。
   *
   * `bridge.grant` / `bridge.grantRevoke` 属于**授权生命周期**，不是业务能力：
   * 它们必须能在版本门之前处理（甚至版本不兼容时也要能收，才好把凭证清掉），
   * 所以放在这张表里，而不是丢给 capabilities。
   */
  const inbound = {
    'bridge.ping': (params) => ({ pong: true, at: Date.now(), echo: params }),
    /**
     * DSH 发放/覆盖授权（契约 §6.1.1 ①-b）。
     * ★ 单一生成方是 DSH：本端**只存**，绝不自己算 id/epoch、也不补默认值。
     * `ctx.link` 是承载这条报文的连接实例 —— 存下来的就是它（对象身份，§6.1.1 ①-c 第 6 行）。
     */
    'bridge.grant': (params, ctx) => {
      const g = params?.grant ?? params
      const record = grants.adopt({
        id: g?.id,
        epoch: g?.epoch,
        link: ctx?.link ?? null,
        sessionId: g?.sessionId ?? null,
        windowId: g?.windowId ?? null,
      })
      log(`edit grant adopted (id ${String(record.id).slice(0, 8)}…)`, 'info')
      return { ok: true, id: record.id }
    },
    /**
     * DSH 撤销授权（契约 §6.1.1 ①-b(2)：会话侧撤销 → `cause:'revoked'`）。
     * 幂等：id 已经不在（或从没收到过）也回 ok —— 撤销是"确保它不再有效"，
     * 不是"必须曾经存在"，报错只会让 DSH 侧多做一次无意义重试。
     */
    'bridge.grantRevoke': (params) => {
      const id = params?.id
      if (typeof id !== 'string' || id === '') {
        throw new BridgeError(ERR.INVALID_PARAMS, 'params.id must be a non-empty string',
          { method: 'bridge.grantRevoke' })
      }
      const revoked = grants.revoke(id, 'revoked')
      if (revoked) log(`edit grant revoked (id ${id.slice(0, 8)}…)`, 'info')
      return { ok: true, revoked }
    },
    'bridge.hello': (params) => {
      // DSH 连上后主动 hello（协议 §3.4：每条连接的第一条消息由服务端下发）。
      // 扩展侧在这里做**对等自检**（契约 §4.1 ②）：判 DSH 的 ptv，不兼容就地降级。
      recordPeerHello(params)
      return {
        ok: true,
        client: CLIENT_ID,
        extensionVersion: EXTENSION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: CAPABILITIES,
      }
    },
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

  /**
   * 对端（DSH）协议版本协商结果 —— 扩展侧对等自检层（契约 §4.1 ②）。
   *
   * 状态：`pending`（还没收到 DSH 的 hello，版本未知）→ `compatible` / `incompatible`。
   * 只有 `compatible` 才允许执行业务能力：未知与不兼容一律 fail-closed（-32008）。
   * @type {{status: 'pending'|'compatible'|'incompatible',
   *         protocolVersion: unknown, present: boolean, reason: string,
   *         echo: number|string|boolean|null, peerType: string,
   *         client?: string, seenAt?: number}}
   */
  let peer = pendingPeer()

  function pendingPeer() {
    return {
      status: 'pending', protocolVersion: undefined, present: false,
      reason: 'awaiting-hello', echo: null, peerType: 'undefined',
    }
  }

  /**
   * 构造 `-32008 protocol-incompatible`（契约 §4.1 ③ 的 data 形状，side 固定 'extension'）。
   * @param {string} [method] 业务方法名；hello 阶段没有方法名就不带（契约里 method? 是可选的）。
   */
  function incompatibleError(method) {
    const [min, max] = SUPPORTED_PROTOCOL
    return new BridgeError(
      ERR.PROTOCOL_INCOMPATIBLE,
      `protocol version incompatible: peer protocolVersion is ${peer.reason}`
        + ` (supported ${min}..${max}); business capabilities fail-closed`,
      {
        required: { min, max },
        peer: peer.echo,
        peerType: peer.peerType,
        reason: peer.reason,
        helloReceived: peer.status !== 'pending',
        ...(method === undefined ? {} : { method }),
        side: 'extension',
      },
    )
  }

  /**
   * 就地判定 DSH 的 hello（对等自检）。不兼容时**不得**再呈现为可用：
   * 旧写法只 log 一句、状态仍是 ready —— 那正是契约点名的隐患（「ready 不代表兼容」）。
   */
  function recordPeerHello(params) {
    const hasPtv = !!params && typeof params === 'object'
      && Object.prototype.hasOwnProperty.call(params, 'protocolVersion')
    const ptv = hasPtv ? params.protocolVersion : undefined
    const verdict = judgeProtocolVersion(ptv)
    peer = {
      status: verdict.compatible ? 'compatible' : 'incompatible',
      protocolVersion: ptv,
      present: hasPtv,
      reason: verdict.reason,
      echo: verdict.peer,
      peerType: verdict.peerType,
      client: (params && params.client) || 'unknown',
      seenAt: Date.now(),
    }
    if (verdict.compatible) return

    const err = incompatibleError()
    // ★ 评审 F4：状态里补 `reason` —— 状态栏原来是 `s.reason ?? '无'`，不给就显示
    //   「原因 无」，排障时等于没信息。这里与 hello 判定的 reason 同源（'missing' /
    //   'out-of-range' / 'not-a-number' …），不是另起一套词表。
    setState('incompatible', {
      port: state.port, pid: state.pid, dshVersion: state.dshVersion,
      reason: verdict.reason,
      error: { code: err.code, message: err.message, data: err.data },
    })
    log(`protocol-incompatible: DSH protocolVersion is ${verdict.reason}`
      + ` (ptv=${JSON.stringify(verdict.peer)}, present=${hasPtv},`
      + ` supported ${SUPPORTED_PROTOCOL.join('..')}); business capabilities disabled`, 'warn')
  }

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
    if (fn) return fn(params, ctx)
    // ★ 协议兼容门（契约 §4.1 硬规则）：版本未知/不兼容时**不得执行任何业务能力**。
    //   ★ 评审 F3：这一层必须跑在 `onRequest` 注入点**之前** —— 注入点可以把任意业务
    //   方法接走（`custom !== undefined` 直接 return），门若在它后面，将来往注入点挂
    //   业务方法就绕过了判定。此时既不能执行，也不能把原因说成 -32005（方法缺失）。
    //   协议层方法（bridge.*）豁免：否则连「问对方是几版」都做不到。
    if (!String(method).startsWith('bridge.') && peer.status !== 'compatible') {
      throw incompatibleError(method)
    }
    // ★ 绑定门第一处（契约 §6.1.1 ②A）：`handleInbound` 交给 `dispatch` 之前。
    //   位置在版本门之后（版本不兼容时先说 -32008，不必谈凭证）、onRequest 之前
    //   （注入点同样不许绕门）。第二处在 capabilities.dispatch 里，两处同源。
    grantGate(method, params, ctx)
    if (onRequest) {
      const custom = onRequest(method, params, ctx)
      if (custom !== undefined) return custom
    }
    // 未实现的能力由 capabilities.dispatch 回 -32005（可与「协议层方法不存在」区分）。
    return dispatch(method, params, ctx)
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
    // 新连接 = 新一轮协商：上一轮的版本判定不得为新对端背书。
    peer = pendingPeer()
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
    // 这是"当前活连接"的**唯一**写入口；绑定门读的就是它（对象身份，不是序号）。
    linkState.link = link

    const feed = createLineSplitter((line) => link.handleLine(line))
    s.on('data', (chunk) => {
      try { feed(chunk) } catch (err) { log(`framing: ${err?.message ?? err}`, 'warn') }
    })
    s.on('close', () => {
      if (socket !== s) return
      const gone = link
      socket = null
      link = null
      // ★ 断开即失效（§6.1.1 ①-b(2)）：挂在这条连接上的 grant 全部 `cause:'disconnected'`。
      //   本端本地完成 —— 不依赖 DSH 补发、也不靠任何计数器。
      forgetLink(gone)
      setState('idle', { reason: 'disconnected' })
      log('disconnected from DSH', 'warn')
    })
    s.on('error', (err) => { log(`socket: ${err?.message ?? err}`, 'warn') })
    s.unref?.()

    // 注意语义：这里的 ready 只表示「链路通了」，**不代表版本兼容**。
    // 版本判定要等 DSH 的 hello 到达；不兼容时状态随即被降为 'incompatible'
    // （见 recordPeerHello），业务能力从此 fail-closed。
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
    // 'incompatible' 也在此列：连接还在，重连不会让对端升级，只会刷日志。
    // 真正的恢复点是断线（socket close → idle → 下一轮重连重新协商）。
    if (stopped || state.state === 'ready' || state.state === 'connecting'
        || state.state === 'incompatible') return
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
    /** 立刻重连（忽略当前轮询节奏）。旧的 grant 随旧连接一起作废。 */
    reconnect() {
      if (socket || link) {
        const gone = link
        try { socket?.destroy() } catch { /* ignore */ }
        socket = null
        link = null
        // 新连接会取代旧连接：按连接**对象身份**判失效，旧 grant 一律 disconnected。
        forgetLink(gone)
      }
      setState('idle', { reason: 'manual-reconnect' })
      return tick()
    },
    stop() {
      stopped = true
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      const gone = link
      if (link) link.close('connector stopped')
      if (socket) {
        // 与 DSH 侧同一个教训：协议层 close ≠ 传输层 close。
        try { socket.destroy() } catch { /* ignore */ }
      }
      socket = null
      link = null
      forgetLink(gone)
      setState('idle', { reason: 'stopped' })
    },
    get state() { return state },
    get connected() { return state.state === 'ready' },
    /** 对端版本协商结果（诊断/测试用；不属于协议契约字段）。 */
    get peer() { return peer },
    get attempts() { return attempts },
    /** 会话授权表（扩展宿主内唯一一份；测试与诊断用）。 */
    get grants() { return grants },
    /** 当前活连接的共享槽（`{link}`）；绑定门读的就是它。 */
    get linkState() { return linkState },
    /** 供测试/扩展调用 DSH 侧方法。 */
    request(method, params, opts) {
      if (!link) {
        return Promise.reject(new BridgeError(ERR.DISCONNECTED, 'not connected to DSH',
          { method, reason: 'not-connected' }))
      }
      // 出站业务请求同样过门（契约 §4.1：不兼容时一个业务方法都不发）。
      // bridge.* 豁免：握手本身必须先能发出去，否则版本永远协商不出来。
      if (!String(method).startsWith('bridge.') && peer.status !== 'compatible') {
        return Promise.reject(incompatibleError(method))
      }
      return link.request(method, params, opts)
    },
    /** 测试用：直接注入一条入站行。 */
    _handleLine(line) { return link?.handleLine(line) },
  }
}
