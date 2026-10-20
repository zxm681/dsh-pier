/**
 * dsh-vscode-kit —— DSH 侧桥接协议库的插件入口。
 *
 * 设计约束（阶段4 §4 公开 API 面，先定死）：
 *  1. 零依赖：不 import '@deepseek-ai/cordis'。服务用 ctx.provide(name, 普通对象) 注册，
 *     已实测可用（见 docs/phase5-打样日志.md §1.1）。消费者用 inject: ['dshVscodeKit'] 拿到。
 *  2. 消费者只见公开 API：request(method, params) + 糖衣 kit.vscode.*。
 *     不知道 TCP、端口、发现文件、token 的存在。
 *  3. 能力缺失降级：返回 -32005 unsupported，不崩溃。
 *
 * 插件形状：函数式 cordis 插件（export { name, inject, apply }），与 dsh-agy-link 同款。
 */

import { startBridgeServer, listLiveBridges, discoveryDir, resolveDshHome } from './server.js'
import { BridgeError, ERR, PROTOCOL_VERSION, hasCapability } from './protocol.js'

/** cordis 插件名，必须与 package.json 的 name 一致。 */
export const name = 'dsh-vscode-kit'

/**
 * 插件依赖的服务。
 *
 * 空数组是刻意的：本库不依赖任何 DSH 内部服务，才能在任何 profile 里加载而不被
 * 「服务缺失 → 插件卸载」的机制带走。
 */
export const inject = []

/** 本端（DSH 侧）声明支持的能力：DSH 能接收的入站方法族。 */
const INBOUND_CAPABILITIES = ['bridge.ping']

/** 默认等待编辑器连接的时间。 */
const DEFAULT_CONNECT_WAIT_MS = 3_000

/**
 * 消费者拿到的服务对象。
 *
 * 只暴露两个入口：request（万能）与 vscode（糖衣）。其余字段以 `_` 前缀标为内部，
 * 消费者插件不该碰，但排障时可读。
 */
class VscodeKit {
  constructor({ server, dshVersion, connectWaitMs, onLog }) {
    this.server = server
    this.dshVersion = dshVersion
    this.connectWaitMs = connectWaitMs
    this.onLog = onLog

    /** 最近一次收到 hello 的编辑器信息（诊断用，也是「有没有编辑器在」的判据）。 */
    this.lastEditor = null
    /** 等待连接时的等待者队列。 */
    this.waiters = new Set()

    // 糖衣方法族。新增能力只在这里加一行，协议层不改。
    // 注意两个参数都要往下传：早期写成 `openFile: (params) => this.request(m, params)`
    // 会把消费者传的 opts（timeoutMs / waitForEditor）静默丢掉。
    this.vscode = {
      openFile: (params, opts) => this.request('vscode.openFile', params, opts),
      getSelection: (params, opts) => this.request('vscode.getSelection', params, opts),
      getDiagnostics: (params, opts) => this.request('vscode.getDiagnostics', params, opts),
      listOpenEditors: (params, opts) => this.request('vscode.listOpenEditors', params, opts),
    }
  }

  /**
   * 内部：取当前活跃连接 —— **只在已准入的连接里挑**。
   *
   * ★ 安全（洞 2）：不能简单取「最后连上的」。裸连一个 socket、什么都不发，
   *   就能把 active 位抢走，之后 DSH 的 vscode.* 请求全被它接走
   *   （work/scripts/lesson3-hijack.mjs 是复现）。
   *   准入 = 至少发过一条 token 正确的消息（server.js 的 authorize 里打标）。
   */
  _activeLink() {
    const links = [...this.server.links].filter((l) => l.authorized === true)
    return links.length ? links[links.length - 1] : null
  }

  /** 内部：等编辑器连上，最多等 waitMs；超时返回 null。 */
  _waitForEditor(waitMs) {
    const link = this._activeLink()
    if (link) return Promise.resolve(link)
    if (waitMs <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve(null)
      }, waitMs)
      if (typeof timer.unref === 'function') timer.unref()
      const waiter = (lnk) => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(lnk)
      }
      this.waiters.add(waiter)
    })
  }

  /** 内部：编辑器连上时唤醒等待者。 */
  _notifyConnected(link) {
    for (const waiter of [...this.waiters]) waiter(link)
  }

  /**
   * 发起一次桥接请求。
   *
   * @param {string} method 形如 'vscode.openFile'，方法名即能力命名空间。
   * @param {object} [params]
   * @param {{timeoutMs?: number, waitForEditor?: boolean}} [opts]
   * @returns {Promise<any>}
   * @throws {BridgeError} -32001 未授权 / -32003 不存在 / -32004 超时 / -32005 不支持 / -32007 未连接
   */
  async request(method, params = {}, opts = {}) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string')
    }

    const waitForEditor = opts.waitForEditor !== false
    const waitMs = waitForEditor ? (opts.waitMs ?? this.connectWaitMs) : 0
    const link = await this._waitForEditor(waitMs)

    if (!link) {
      throw new BridgeError(
        ERR.DISCONNECTED,
        'no editor connected; make sure the dsh-kit-bridge VSCode extension is running',
        { method, discoveryDir: discoveryDir(), waitedMs: waitMs },
      )
    }

    // 能力降级：编辑器在 hello 里声明的能力清单决定能不能发（协议 §7）。
    const caps = this.lastEditor?.capabilities
    if (Array.isArray(caps) && caps.length > 0 && !hasCapability(caps, method)
        && !INBOUND_CAPABILITIES.includes(method) && !method.startsWith('bridge.')) {
      throw new BridgeError(ERR.UNSUPPORTED,
        `editor does not advertise capability for "${method}"`,
        { method, capabilities: caps })
    }

    try {
      return await link.request(method, params, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)
    } catch (err) {
      // 连接断了：清掉 lastEditor，让后续请求重新等连接
      if (err?.code === ERR.DISCONNECTED) this.lastEditor = null
      throw err
    }
  }

  /** 单向通知（不等待响应）。 */
  notify(method, params = {}) {
    const link = this._activeLink()
    if (!link) throw new BridgeError(ERR.DISCONNECTED, 'no editor connected', { method })
    link.notify(method, params)
  }

  /** 诊断快照：排障时打印用，不属于稳定 API。 */
  snapshot() {
    return {
      port: this.server.port,
      pid: process.pid,
      dshVersion: this.dshVersion,
      protocolVersion: PROTOCOL_VERSION,
      connections: this.server.links.size,
      lastEditor: this.lastEditor,
      discoveryPath: this.server.discoveryPath,
    }
  }
}

/**
 * cordis 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 * @param {number[]} [config.portRange]  默认 [7410, 7419]
 * @param {string}   [config.dshHome]    覆盖 DSH_HOME（测试用）
 * @param {number}   [config.connectWaitMs] 请求前等编辑器连接的时长，默认 3000
 * @param {boolean}  [config.enabled]    置 false 则只注册服务不监听（便于排障）
 * @param {(level: string, msg: string, extra?: any) => void} [config.onLog]
 */
export function apply(ctx, config = {}) {
  const {
    portRange,
    dshHome,
    connectWaitMs = DEFAULT_CONNECT_WAIT_MS,
    enabled = true,
    onLog,
  } = config ?? {}

  const log = (level, msg, extra) => {
    try {
      onLog ?. (level, `[dsh-vscode-kit] ${msg}`, extra)
      if (!onLog) {
        const line = `[dsh-vscode-kit] ${msg}`
        if (level === 'error') console.error(line, extra ?? '')
        else if (level === 'warn') console.warn(line, extra ?? '')
        else console.log(line, extra ?? '')
      }
    } catch { /* 日志不许影响主流程 */ }
  }

  /** 服务实例在监听成功后才有；消费者可能早于监听就 inject，故用惰性代理。 */
  let kit = null
  /**
   * 监听已起、但 kit 还没装配完的空窗期里通过准入的连接。
   * 单纯丢掉它们会让「扩展恰好比 kit 快一步」变成一次静默失败，
   * 所以要记下来、装配完补通知。
   */
  const pendingAuthorized = new Set()
  let disposed = false
  /**
   * 监听就绪信号。一次性 Promise：resolve 后 await 它永远立即返回 true。
   * 不用 EventEmitter —— 只需要「就绪/超时」两种结果，一个已结算的 Promise 就够。
   */
  let settleReady
  const readySignal = new Promise((resolve) => { settleReady = resolve })

  // 消费者通过 inject: ['dshVscodeKit'] 拿到的就是这个对象。
  // 用普通对象（不是 Service 子类）+ 转发方法，避免消费者在监听就绪前拿到 null。
  //
  // ★ 早期写成 `get vscode() { return kit?.vscode ?? {} }`，真机上出过两类问题：
  //   ① 监听没起来时消费者拿到 `{}`，调用得 `kit.vscode.openFile is not a function`
  //      （裸 TypeError，没有错误码、没有原因，最糟的失败形态）；
  //   ② 消费者把方法**解构**出去后（`const { bind } = kit.vscode`），就算监听后来就绪，
  //      解构出来的已经是 `undefined`，永远好不了。
  //   所以糖衣方法必须是**稳定存在**的转发函数，只在调用时检查就绪状态。
  const notReady = (method) => Promise.reject(new BridgeError(ERR.DISCONNECTED,
    'dsh-vscode-kit is not listening yet', { method, reason: 'server-not-ready' }))

  const vscode = {
    openFile: (params, opts) => (kit
      ? kit.vscode.openFile(params, opts)
      : notReady('vscode.openFile')),
    getSelection: (params, opts) => (kit
      ? kit.vscode.getSelection(params, opts)
      : notReady('vscode.getSelection')),
    getDiagnostics: (params, opts) => (kit
      ? kit.vscode.getDiagnostics(params, opts)
      : notReady('vscode.getDiagnostics')),
    listOpenEditors: (params, opts) => (kit
      ? kit.vscode.listOpenEditors(params, opts)
      : notReady('vscode.listOpenEditors')),
  }

  const facade = {
    get ready() { return kit !== null },
    get vscode() { return vscode },
    request: (method, params, opts) => (kit ? kit.request(method, params, opts) : notReady(method)),
    notify: (method, params) => {
      if (!kit) throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
        { method, reason: 'server-not-ready' })
      return kit.notify(method, params)
    },
    snapshot: () => (kit ? kit.snapshot() : { ready: false }),
    /**
     * 等监听就绪。消费者在 apply 里立刻调用能力时（真机 demo 就这么干的），
     * 服务已被 provide 但 server 还没 listen，此时 request 会得到 server-not-ready。
     * 与其让每个消费者自己写轮询，不如提供这一个等待点。
     * 超时返回 false（不抛），让调用方自己决定降级策略。
     * 一旦就绪，后续调用立即返回 true（Promise 已 resolve）。
     */
    waitReady: async (timeoutMs = 5000) => {
      if (kit !== null) return true
      if (!(timeoutMs > 0)) return false
      let timer
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref?.()
      })
      const ok = await Promise.race([readySignal, timeout])
      clearTimeout(timer)
      return ok
    },
  }

  // 注册服务：ctx.provide(name, 普通值)。
  //
  // ★ 这里**刻意不传 check 谓词**。cordis 的 check 是 `get` 时的门禁
  //   （_checkImpl 里 `if (impl.check && !impl.check(...)) return delete this._store[name]`），
  //   **不是**状态变化信号：谓词变真之后没有任何机制会重新通知等待者。
  //   真机踩过：写成 `() => kit !== null` 会让消费者永远 pending
  //   （`dsh: warning: 1 entry did not activate` / `waiting for services`）。
  //   facade 本身已经能安全承受「监听未就绪」（request 会立刻拒 server-not-ready），
  //   所以这里只要无条件暴露即可。
  ctx.provide('dshVscodeKit', facade)

  if (!enabled) {
    log('warn', 'disabled by config; service registered but not listening')
    return
  }

  // 异步启动监听。不阻塞 apply，避免 DSH 启动时被端口探测拖慢。
  const boot = (async () => {
    try {
      const server = await startBridgeServer({
        portRange,
        dshHome,
        dshVersion: readDshVersion(),
        capabilities: INBOUND_CAPABILITIES,
        onRequest: handleInbound,
        onError: (err) => log('warn', `protocol error: ${err?.message ?? err}`),
        // hello 由协议层（server.js）自动下发；这里只做插件层的事：
        // 记录连接、唤醒等待编辑器的消费者。
        onConnected: (link) => {
          // 日志是排障的第一手证据：真机上「扩展到底连上没有」不该靠猜。
          // 注意这是「连上」不是「准入」——准入（token 校验通过）另有日志。
          const peer = link.socket?.remotePort
          log('info', `editor connected (remote port ${peer ?? 'unknown'})`)
        },
        // ★ 安全（洞 2）：只有通过 token 校验的连接才通知等待者。
        // 未准入的裸连接可能永远不发消息 —— 那种连接不能被当成编辑器。
        onAuthorized: (link) => {
          if (kit === null) {
            // 监听刚起、kit 还没装配完：先记进 pending，装配后补通知。
            pendingAuthorized.add(link)
            return
          }
          log('info', 'editor authorized (token accepted)')
          kit._notifyConnected(link)
        },
      })

      kit = new VscodeKit({
        server,
        dshVersion: readDshVersion(),
        connectWaitMs,
        onLog: log,
      })

      // 服务端反向收到的编辑器身份存在 lastEditor（能力降级的判据）。
      // 编辑器连上后也会主动发 bridge.hello 请求，handleInbound 里记录。

      // 补通知空窗期内已准入的连接（它们可能比 kit 装配更早到）。
      // 这个窗口是真的：startBridgeServer 内部 await 期间端口已在监听，
      // 扩展正好轮询到就会连上并发消息 —— 那条消息的准入发生在 kit 装配之前。
      // 不打日志就会在真机上「凭空少一条 authorized」，排障时极易误判。
      for (const link of pendingAuthorized) {
        log('info', 'editor authorized during startup (notified after wiring)')
        kit._notifyConnected(link)
      }
      pendingAuthorized.clear()

      log('info', `listening on 127.0.0.1:${server.port} (discovery: ${server.discoveryPath})`)
      log('info', `live bridges under ${resolveDshHome(dshHome)}: ${listLiveBridges(discoveryDir(dshHome)).length}`)

      // 唤醒所有 waitReady 等待者（Promise 一旦 resolve，后续 await 立即返回 true）。
      settleReady(true)
    } catch (err) {
      log('error', `failed to start bridge server: ${err?.message ?? err}`)
      // 不抛：插件加载失败会让整个 profile 出问题（dsh-plugin-guide 排障提示 T3）。
      // 改为在 snapshot 里标记，消费者请求时得到结构化错误。
    }
  })()

  /** 处理编辑器发来的入站请求（首版只有 ping，留好扩展点）。 */
  function handleInbound(method, params, msgCtx) {
    switch (method) {
      case 'bridge.ping':
        return { pong: true, at: Date.now(), echo: params }
      case 'bridge.hello':
        // 编辑器主动报身份（本协议服务端先发 hello，这里兜住对端也发的情况）。
        // 记录编辑器的能力清单——request() 的能力降级判据。
        if (kit && params && typeof params === 'object') {
          kit.lastEditor = {
            client: params.client ?? 'unknown',
            extensionVersion: params.extensionVersion ?? null,
            capabilities: Array.isArray(params.capabilities) ? params.capabilities : [],
            seenAt: Date.now(),
          }
        }
        return { ok: true, protocolVersion: PROTOCOL_VERSION, dshVersion: readDshVersion() }
      default:
        throw new BridgeError(ERR.METHOD_NOT_FOUND, `unsupported inbound method "${method}"`,
          { method })
    }
  }

  // cordis 生命周期：插件卸载时关服务、删发现文件。
  // 卸载必须可等待：消费者可能紧接着断言发现文件已删 / 端口已释放。
  let disposeResolve
  const disposedPromise = new Promise((r) => { disposeResolve = r })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      disposed = true
      // 唤醒 waitReady 等待者（返回 false，让它们立刻降级而不是等到超时）
      settleReady(false)
      // 断开所有等待者，避免消费者永久挂起
      for (const waiter of [...(kit?.waiters ?? [])]) waiter(null)
      const fin = () => {
        log('info', 'bridge server closed')
        disposeResolve()
      }
      if (kit) kit.server.close().then(fin, fin)
      else fin()
    })
  } else {
    log('warn', 'ctx.effect unavailable; relying on process exit hooks for cleanup')
    disposeResolve()
  }

  return {
    boot,
    get kit() { return kit },
    get disposed() { return disposed },
    /** 等 server.close() 完成（测试/CLI 用）。 */
    get stopped() { return disposedPromise },
  }
}

/** 读 DSH 版本，失败返回 'unknown'（绝不因为版本探测失败影响插件加载）。 */
function readDshVersion() {
  // 环境变量优先（宿主若注入），否则从 process.argv/包路径都不可靠时不猜
  return process.env.DSH_VERSION || 'unknown'
}

/**
 * 编辑器连上时由 server 回调（server.js 里调用）。
 * 单独导出便于单测直接触发。
 */
export function onEditorConnected(kit, link) {
  if (!kit) return
  // hello 已在 server.onConnected 里发出；这里只记录身份与唤醒等待者。
  kit._notifyConnected(link)
}

export { VscodeKit }
export { BridgeError, ERR, PROTOCOL_VERSION, hasCapability } from './protocol.js'
export {
  startBridgeServer, listLiveBridges, discoveryDir, resolveDshHome,
  writeDiscoveryFile, sweepDiscoveryDir, isProcessAlive, DEFAULT_PORT_RANGE,
} from './server.js'
