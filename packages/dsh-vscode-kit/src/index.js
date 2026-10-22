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
import {
  BridgeError, ERR, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, hasCapability, judgeProtocolVersion,
} from './protocol.js'

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
 * 默认等待对端 hello（拿协议版本）的时间。
 *
 * hello 之前没有对端版本 —— 契约 §4.1 ① 第 3 行 + §7 #3 要求「未知版本保守处理」，
 * 即不得推断成 v1。所以先等一小段（扩展连上后立刻会报 hello），等不到就 fail-closed。
 */
const DEFAULT_HELLO_WAIT_MS = 1_000

/**
 * 消费者拿到的服务对象。
 *
 * 只暴露两个入口：request（万能）与 vscode（糖衣）。其余字段以 `_` 前缀标为内部，
 * 消费者插件不该碰，但排障时可读。
 */
class VscodeKit {
  constructor({ server, dshVersion, connectWaitMs, helloWaitMs, onLog }) {
    this.server = server
    this.dshVersion = dshVersion
    this.connectWaitMs = connectWaitMs
    this.helloWaitMs = helloWaitMs ?? DEFAULT_HELLO_WAIT_MS
    this.onLog = onLog

    // 这里**故意没有** lastEditor 槽：对端身份（协议版本 / 能力清单）挂在
    // 「这条连接」自己身上（`link.editor`，由 protocol.js 的 `ctx.link` 落位），
    // `lastEditor` 只是读当前目标连接那一份的只读视图。
    // 双源是评审 F1 的根因：全局槽记「最后一次 hello」，而目标按 connSeq 挑，
    // 目标切换/交错时两者不是同一条连接 → 门拿 A 的背书放行了 B 的包。
    /** 等待连接时的等待者队列。 */
    this.waiters = new Set()
    /** 等对端 hello（拿协议版本）的等待者队列。 */
    this.helloWaiters = new Set()

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
   * 内部：取当前活跃连接 —— **只在已准入的连接里挑，且按连接序号挑**。
   *
   * ★ 安全（洞 2）：不能简单取「最后连上的」。裸连一个 socket、什么都不发，
   *   就能把 active 位抢走，之后 DSH 的 vscode.* 请求全被它接走
   *   （work/scripts/lesson3-hijack.mjs 是复现）。
   *   准入 = 至少发过一条 token 正确的消息（server.js 的 authorize 升格到 trusted）。
   *   不遍历 links：即使以后忘写 authorized 过滤，也不会选中未准入 socket。
   *
   * ★ 回归（评审 R1）：目标必须按**连接先后**（server.js 的 connSeq），不是准入先后。
   *   trusted 在首次准入时 add，取集合末项等于「最后准入优先」；拆分前的实现是
   *   「最后连接优先」（links 在建连时 add）。两条都合法时两种口径会选出不同连接，
   *   connect A → connect B → 先准入 B → 后准入 A：旧算法给 B，取末项给 A。
   *   所以这里扫 trusted 取 connSeq 最大者 —— 与旧行为一致，且不回退到 links。
   */
  _activeLink() {
    let best = null
    let bestSeq = -Infinity
    for (const link of this.server.trusted) {
      // 未带序号的连接（白盒/旧对象）排在所有带序号的连接之后；
      // 同序号时保留先遇到的那条，结果稳定可测。
      const seq = typeof link.connSeq === 'number' ? link.connSeq : -Infinity
      if (best !== null && seq <= bestSeq) continue
      // 活连接才可当目标：socket 已销毁但 'close' 事件还没派发的那一下不选它，
      // 否则请求会写进一条死 socket。
      if (link.socket?.destroyed) continue
      // 协议层已关掉的连接同理（评审 F1 回归 ②：目标窗口关掉后必须回退到**另一条**，
      // 而不是继续选它；connSeq 更大的死连接会被跳过）。
      if (link.closed === true) continue
      best = link
      bestSeq = seq
    }
    return best
  }

  /**
   * 当前目标连接上报的身份（诊断用）。**只是视图，不是事实源**。
   *
   * 事实源只有一处：目标连接自己的 `link.editor`（由 hello 写入、随连接回收）。
   * 所以 `kit.lastEditor` 与兼容门读的必然是同一份 —— 这正是 F1 要求的「同源读法」。
   * @returns {object|null} 目标连接没报过 hello（或没有目标）时为 null
   */
  get lastEditor() {
    return this._activeLink()?.editor ?? null
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
   * 内部：某条连接报了自己的 hello（协议版本）时唤醒等待者。
   *
   * 只唤醒等**这条连接**的等待者（`_waitForHello(link, …)` 里的 waiter 会比对 link）——
   * 别的连接的 hello 不得给它的等待者「解围」，那正是 F1 的 fail-open 入口。
   */
  _notifyHello(link) {
    for (const waiter of [...this.helloWaiters]) waiter(link ?? null)
  }

  /**
   * 内部：等**指定连接**的 hello（协议版本）到达。
   *
   * hello 之前没有对端版本 = 契约里的「未知版本」，不得推断为 v1
   * （§4.1 ① 第 3 行、§7 #3「hello 前必须按未知版本保守处理」）。
   *
   * ★ 评审 F1：以前是「等任意一条连接的 hello」（读全局槽 `this.lastEditor`），
   *   多窗口时 A 的 hello 会给 B 的目标位背书。现在只认传进来的这条。
   *
   * @param {object|null} link 目标连接
   * @param {number} waitMs 上限
   * @returns {Promise<boolean>} 该连接是否在时限内报过 hello
   */
  _waitForHello(link, waitMs) {
    if (!link) return Promise.resolve(false)
    if (link.editor) return Promise.resolve(true)
    if (!(waitMs > 0)) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timer)
        this.helloWaiters.delete(waiter)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), waitMs)
      if (typeof timer.unref === 'function') timer.unref()
      const waiter = (who) => {
        if (who === link) finish(true)
      }
      this.helloWaiters.add(waiter)
    })
  }

  /**
   * 协议兼容门（契约 §4.1 ②：「DSH 侧 kit = 权威判定层」）。
   *
   * 判定表见 `judgeProtocolVersion`：整数且落在 `SUPPORTED_PROTOCOL` 区间内才放行；
   * 整数越界 / 缺失 / 非整数 / 非数字一律按**不兼容**处理（不得推断为 v1）。
   * 必须跑在能力预检**之前**、发包**之前** —— 不兼容时一个业务方法都不执行，
   * 连「旧方法」也不放行（§4.1 硬规则 + 「先过门、再谈降级」）。
   *
   * 豁免 `bridge.*` 协议层方法（ping/hello）：它们不是业务能力，不受版本门约束 ——
   * 否则版本不兼容时连「问一句对方是几版」都做不到。业务能力（`vscode.*`）没有豁免。
   *
   * @throws {BridgeError} -32008，data = { required:{min,max}, peer, peerType, reason, helloReceived, method, side:'dsh' }
   * @param {string} method
   * @param {object|null} [link] 判定与发包必须是**同一条连接**；省略时取当前目标
   */
  _assertProtocolCompatible(method, link) {
    if (typeof method === 'string' && method.startsWith('bridge.')) return
    // ★ 评审 F1：判据只取这一条连接自己上报的版本（`link.editor`），不再有全局槽。
    //   调用方（request/notify）已经选好了 link 并会用它发包，所以「判的」=「发的」。
    const target = link ?? this._activeLink()
    const editor = target?.editor ?? null
    const verdict = judgeProtocolVersion(editor ? editor.protocolVersion : undefined)
    if (verdict.compatible) return

    const [min, max] = SUPPORTED_PROTOCOL
    throw new BridgeError(
      ERR.PROTOCOL_INCOMPATIBLE,
      `protocol version incompatible: peer protocolVersion is ${verdict.reason}`
        + ` (supported ${min}..${max}); refusing to send "${method}"`,
      {
        required: { min, max },
        peer: verdict.peer,
        peerType: verdict.peerType,
        reason: verdict.reason,
        helloReceived: editor !== null,
        method,
        side: 'dsh',
      },
    )
  }

  /**
   * 能力降级预检（协议 §7）：只认**这条连接**在 hello 里声明的能力清单。
   *
   * 空清单 / 未声明 = 不预检（旧扩展不报 capabilities，不能因此全拒）。
   * `bridge.*` 与入站能力族不受约束（前者是协议层，后者是编辑器发给我们调的）。
   *
   * @throws {BridgeError} -32005 不支持
   */
  _assertCapability(method, link) {
    if (typeof method === 'string' && method.startsWith('bridge.')) return
    const caps = (link ?? this._activeLink())?.editor?.capabilities
    if (Array.isArray(caps) && caps.length > 0 && !hasCapability(caps, method)
        && !INBOUND_CAPABILITIES.includes(method)) {
      throw new BridgeError(ERR.UNSUPPORTED,
        `editor does not advertise capability for "${method}"`,
        { method, capabilities: caps })
    }
  }

  /**
   * 发起一次桥接请求。
   *
   * @param {string} method 形如 'vscode.openFile'，方法名即能力命名空间。
   * @param {object} [params]
   * @param {{timeoutMs?: number, waitForEditor?: boolean}} [opts]
   * @returns {Promise<any>}
   * @throws {BridgeError} -32001 未授权 / -32003 不存在 / -32004 超时 / -32005 不支持
   *   / -32007 未连接 / -32008 协议版本不兼容（契约 §4.1，发包前就拒）
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

    // ── 协议兼容门（契约 §4.1 ②）：跑在能力预检之前、发包之前 ──
    // hello 之前没有对端版本，属于「未知版本」：先等一小段（扩展连上后立刻报 hello），
    // 等不到就按不兼容处理 —— 绝不把「还没报」推断成 v1。
    // ★ 评审 F1：等的是**这条连接**的 hello，判的也是这条连接，发还是这条连接。
    //   以前读全局槽，A 的 hello 会给 B 的目标位背书（探针 B/D 实测 fail-open）。
    if (!link.editor && waitForEditor && this.helloWaitMs > 0) {
      await this._waitForHello(link, Math.min(this.helloWaitMs, waitMs))
    }
    this._assertProtocolCompatible(method, link)
    this._assertCapability(method, link)

    // 断线不清任何「版本槽」：版本事实挂在连接上，连接没了自然失效。
    // （旧实现这里清全局 lastEditor，会导致下一条连接继承/丢失判定，见 F1。）
    return link.request(method, params, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)
  }

  /**
   * 单向通知（不等待响应）。
   *
   * ★ 评审 F2：业务方法同样过版本门 + 能力预检 —— 单向不等于可以绕过判定，
   *   否则不兼容对端照样收到业务帧（探针 C：notify 业务方法 threw=null、对端增量 1）。
   *   `bridge.*` 继续豁免（协商通道不能被自己堵死，见上一轮裁决）。
   *   不改成 request：那会把「发了就算」变成「等回执」，改变语义与阻塞行为；
   *   判定失败时抛错，错误契约与 request 一致。
   */
  notify(method, params = {}) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string')
    }
    const link = this._activeLink()
    if (!link) throw new BridgeError(ERR.DISCONNECTED, 'no editor connected', { method })
    this._assertProtocolCompatible(method, link)
    this._assertCapability(method, link)
    link.notify(method, params)
  }

  /**
   * 诊断快照：排障时打印用，不属于稳定 API。
   *
   * `protocolCompatible` / `lastEditor` 与兼容门**同源**：都从当前目标连接的
   * `link.editor` 取（评审 F1：snapshot 不得另算一份）。
   */
  snapshot() {
    const editor = this.lastEditor
    return {
      port: this.server.port,
      pid: process.pid,
      dshVersion: this.dshVersion,
      protocolVersion: PROTOCOL_VERSION,
      // 兼容区间（契约 §4.1 ①）与对端判定结果都放进诊断快照：
      // snapshot 不属于稳定 API，增删字段不算破坏性变更。
      supportedProtocol: SUPPORTED_PROTOCOL,
      protocolCompatible: editor ? editor.protocolCompatible : false,
      // 没有目标 / 目标没报 hello 时给出原因，排障不用猜（与评审 F4 同精神）。
      protocolReason: editor ? editor.protocolReason : 'no-target',
      connections: this.server.links.size,
      lastEditor: editor,
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
 * @param {number}   [config.helloWaitMs]   请求前等对端 hello（协议版本）的时长，默认 1000
 * @param {boolean}  [config.enabled]    置 false 则只注册服务不监听（便于排障）
 * @param {(level: string, msg: string, extra?: any) => void} [config.onLog]
 */
export function apply(ctx, config = {}) {
  const {
    portRange,
    dshHome,
    connectWaitMs = DEFAULT_CONNECT_WAIT_MS,
    helloWaitMs = DEFAULT_HELLO_WAIT_MS,
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
          // ★ 新准入对端 = 新身份：上一轮 hello 的版本/能力不得为它背书（契约 §4.1）。
          //   这一步现在是**结构上自动成立**的：身份挂在连接自己身上（`link.editor`），
          //   新连接生来没有 hello 记录，不需要（也不再允许）去清一个全局槽。
          //   （旧实现是 `kit.lastEditor = null`，那正是评审 F1 的双源。）
          kit._notifyConnected(link)
        },
      })

      kit = new VscodeKit({
        server,
        dshVersion: readDshVersion(),
        connectWaitMs,
        helloWaitMs,
        onLog: log,
      })

      // 服务端反向收到的编辑器身份存在 lastEditor（能力降级的判据）。
      // 编辑器连上后也会主动发 bridge.hello 请求，handleInbound 里记录。

      // 补通知空窗期内已准入的连接（它们可能比 kit 装配更早到）。
      // 这个窗口是真的：startBridgeServer 内部 await 期间端口已在监听，
      // 扩展正好轮询到就会连上并发消息 —— 那条消息的准入发生在 kit 装配之前。
      // 不打日志就会在真机上「凭空少一条 authorized」，排障时极易误判。
      replayPendingAuthorized(server, pendingAuthorized, (link) => {
        log('info', 'editor authorized during startup (notified after wiring)')
        kit._notifyConnected(link)
      })

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
      case 'bridge.hello': {
        // 编辑器主动报身份（本协议服务端先发 hello，这里兜住对端也发的情况）。
        // 记录**协议版本**与能力清单：版本是 §4.1 兼容门的唯一判据（只认 hello 携带的 ptv），
        // 能力清单是能力预检的判据。
        if (kit && params && typeof params === 'object') {
          // 「没有这个字段」和「有字段但值非法」必须能分开 —— 前者绝不补成 1。
          const present = Object.prototype.hasOwnProperty.call(params, 'protocolVersion')
          const ptv = present ? params.protocolVersion : undefined
          const verdict = judgeProtocolVersion(ptv)
          const editor = {
            client: params.client ?? 'unknown',
            extensionVersion: params.extensionVersion ?? null,
            protocolVersion: ptv,
            protocolVersionPresent: present,
            protocolCompatible: verdict.compatible,
            protocolReason: verdict.reason,
            capabilities: Array.isArray(params.capabilities) ? params.capabilities : [],
            seenAt: Date.now(),
          }
          // ★ 评审 F1：写在**这条连接**身上（`ctx.link`，protocol.js 提供），
          //   不再写全局槽。这样「谁报的 hello」与「包发给谁」永远是同一条连接。
          if (msgCtx?.link) {
            msgCtx.link.editor = editor
            kit._notifyHello(msgCtx.link)
          } else {
            // 理论上到不了：协议层给每次分派都带 ctx.link。真到了就 fail-closed ——
            // 不记身份等于「这条连接版本未知」，业务方法会被门拒，不会误放行。
            log('warn', 'bridge.hello without link context; peer identity not recorded '
              + '(business calls will fail-closed with -32008)')
          }
          if (!verdict.compatible) {
            log('warn', `editor protocol incompatible (${verdict.reason}: `
              + `ptv=${JSON.stringify(verdict.peer)} present=${present}); `
              + 'business capabilities fail-closed with -32008')
          }
        }
        return { ok: true, protocolVersion: PROTOCOL_VERSION, dshVersion: readDshVersion() }
      }
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

/**
 * 内部：补通知「启动空窗期」内已准入的连接给等待中消费者。
 *
 * 这个窗口是真的：startBridgeServer 内部 await 期间端口已在监听，扩展正好轮询到
 * 就会连上并发消息 —— 那条消息的准入发生在 kit 装配之前。单纯丢掉它们会让
 * 「扩展恰好比 kit 快一步」变成一次静默失败，所以要记下来、装配完补通知。
 *
 * ★ 必须先查 `server.trusted` 再通知：空窗期准入后又断线的连接已不在 trusted，
 *   唤醒等待者会让消费者拿一条死连接发请求。`pendingAuthorized` 无论跳过几条都必须清空，
 *   否则装配完成后它还会留在集合里，下次再也清不掉。
 *
 * @internal 导出仅为单测直接守门这条分支：该时间窗无法通过公开 API 稳定复现
 *   （listen 到 kit 装配之间只有微任务，测试进程插不进去）。不属于稳定 API。
 * @param {{trusted: Set<any>}} server
 * @param {Set<any>} pendingAuthorized
 * @param {(link: any) => void} notify
 */
export function replayPendingAuthorized(server, pendingAuthorized, notify) {
  for (const link of pendingAuthorized) {
    if (!server.trusted.has(link)) continue // 空窗期断线后不能唤醒等待者。
    notify(link)
  }
  pendingAuthorized.clear()
}

/** 读 DSH 版本，失败返回 'unknown'（绝不因为版本探测失败影响插件加载）。 */
function readDshVersion() {
  // 环境变量优先（宿主若注入），否则从 process.argv/包路径都不可靠时不猜
  return process.env.DSH_VERSION || 'unknown'
}

// 注：曾有 `export function onEditorConnected(kit, link)` —— 全仓零调用方的死代码，
// 且它维护的是已删除的全局 lastEditor 槽（评审 F5）。与会话状态有关的两件事现在各有
// 明确归属：唤醒等待者由 `apply()` 的 onAuthorized / replayPendingAuthorized 做，
// 对端身份由 hello 写到 `link.editor`。删掉不影响任何消费者（无导入点、无文档引用）。

export { VscodeKit }
export {
  BridgeError, ERR, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, hasCapability,
} from './protocol.js'
export {
  startBridgeServer, listLiveBridges, discoveryDir, resolveDshHome,
  writeDiscoveryFile, sweepDiscoveryDir, isProcessAlive, DEFAULT_PORT_RANGE,
} from './server.js'
