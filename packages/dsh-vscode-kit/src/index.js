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
import { validateResponse } from './response-contract.js'
import {
  GrantStore, GRANT_REASONS, GRANT_TOMBSTONE_LIMIT, WRITE_METHODS, isWriteMethod,
  judgeGrant, judgeSession, dshWriteGate, editNotBoundError, rejectParamsSessionId,
  assertWritableNotNotified,
} from './grant.js'

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
 * 等扩展侧 `bridge.grant` 回执的上限（评审 F9）。
 *
 * 3s 是"本机 IPC 往返 + 扩展侧存表"的量级：正常路径几毫秒就回，超时基本等于
 * handler 没装 / 连接半死。宁可让 `grant()` 报错（用户重试），也不要把
 * `delivered:true` 变成"写进 socket 了"的同义词。
 */
const DEFAULT_GRANT_ACK_TIMEOUT_MS = 3_000

/**
 * 消费者拿到的服务对象。
 *
 * 只暴露两个入口：request（万能）与 vscode（糖衣）。其余字段以 `_` 前缀标为内部，
 * 消费者插件不该碰，但排障时可读。
 */
class VscodeKit {
  constructor({ server, dshVersion, connectWaitMs, helloWaitMs, grantAckTimeoutMs, onLog }) {
    this.server = server
    this.dshVersion = dshVersion
    this.connectWaitMs = connectWaitMs
    this.helloWaitMs = helloWaitMs ?? DEFAULT_HELLO_WAIT_MS
    // 等扩展侧回 `{ok:true,id}` 的上限（评审 F9）：没回执 = 没生效，超时即撤销本地记录。
    this.grantAckTimeoutMs = Number.isInteger(grantAckTimeoutMs) && grantAckTimeoutMs > 0
      ? grantAckTimeoutMs
      : DEFAULT_GRANT_ACK_TIMEOUT_MS
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
      // 写入类：额外过会话授权绑定门（契约 §6.1，发送前）。糖衣只做转发，
      // 门在 request() 里统一判 —— 绕过糖衣走 raw request 也照样过门。
      applyEdit: (params, opts) => this.request('vscode.applyEdit', params, opts),
    }

    /**
     * 会话授权（编辑会话凭证）表 —— **本端是唯一生成方**（契约 §6.1.1 ①）。
     *
     * `link` 存的是连接**对象引用**：失效判定按对象身份比，不按任何序号（铁律 §6.1.1）。
     */
    this.grants = new GrantStore()
    /** 发送前门的唯一实例：判的是「这次要发的那条连接」，不是别的视图。 */
    this._writeGate = dshWriteGate(this.grants)

    /**
     * 编辑授权对外面（`kit.editing.*`）。
     *
     * 三个动作各有明确归属：
     *  - `grant()`：**只在有已准入且协议兼容的目标连接时**发放；没有就抛错，不排队不缓存。
     *  - `revoke(id?)`：先本地失效（权威），再尽力通知对端；通知送不到不影响撤销结论。
     *  - `list()`：诊断视图，不是判据。
     */
    this.editing = {
      grant: (opts) => this.grantEditing(opts),
      revoke: (id) => this.revokeEditing(id),
      list: () => this.grants.entries(),
    }
  }

  /**
   * 内部：写路径的目标连接 —— **只从 grant 记录来**，绝不经过 `_activeLink()`。
   *
   * ★ 评审 F3：契约 §6.1.1 明令写目标是保存的 `grant.link`。旧实现先按
   *   `_activeLink()` 选 argmax 再比 grant，于是「A 有有效 grant、B 后连」会让
   *   A 的合法写请求被拒绝（绑定门退化成"只许给当前活跃窗口写"）。
   *   这里的口径反过来：**谁能写**由记录决定，**写给谁**也是记录决定；
   *   B 后连不影响 A 一个字，A 消失也只是失败（不许回落到 B）。
   *
   * @param {any} params      业务参数（可能携带调用方显式给的 grant，用于世代判定）
   * @param {string|null} sessionId 调用方上下文里的会话身份（不来自 params）
   * @returns {{link: object|null, params: any}}
   */
  _bindWriteTarget(params, sessionId) {
    const given = params?.grant ?? null
    // ① 找记录：调用方显式给了 grant 就按 id 找（世代/形状由判定表判）；
    //    没给就按**可信会话**找 —— 契约要的是"由会话找到记录"，不是"由凭据找窗口"。
    const found = given ? this.grants.lookup(given?.id ?? null) : this._grantForSession(sessionId)
    const record = found?.kind === 'active' ? found.record : null
    const link = record ? this._liveTargetOrNull(record) : null

    // ② 补内部字段（评审 F2 后半句「第三方不应负责复制内部 grant 字段」）：
    //    只有"调用方没给"时才补，且补的是**同一条**记录。调用方给了就一个字都不改，
    //    否则错误的 epoch 会被悄悄改对，第 5 行永远命中不了。
    if (link && !given && record) {
      return { link, params: { ...params, grant: { id: record.id, epoch: record.epoch } } }
    }
    return { link: record ? link : null, params }
  }

  /**
   * 按可信会话找它当前的有效 grant（同一会话重复发放时后一条覆盖前一条，
   * 与 `issue()` 的 supersede 语义一致）。
   * @param {string|null} sessionId
   * @returns {{kind: 'active', record: object} | null}
   */
  _grantForSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    let best = null
    for (const record of this.grants.active()) {
      if (record.sessionId === sessionId) best = record
    }
    return best ? { kind: 'active', record: best } : null
  }

  /**
   * 记录里的承载连接**现在还活着吗**（评审 F3「检查该 link 的准入/版本/存活」）。
   *
   * 死连接不在这里另造一种拒绝：就地按断线回收（与 `onLinkClosed` 同一机制），
   * 然后让判定表第 3 行给出 `target-gone` —— 拒绝理由只有一处来源。
   * @param {object} record
   * @returns {object|null}
   */
  _liveTargetOrNull(record) {
    const target = record?.link ?? null
    if (!target) return null
    const dead = target.closed === true
      || target.socket?.destroyed === true
      || (this.server?.trusted instanceof Set && !this.server.trusted.has(target))
    if (!dead) return target
    this.grants.closeLink(target)
    return null
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
  _assertProtocolCompatible(method, link, opts = {}) {
    // `exempt:false` 强制不豁免 —— 授权发放用：`bridge.grant` 发的是写权限凭证，
    // 虽然名字在 `bridge.*` 里，但绝不能投给版本不兼容的对端（契约 §6.1：只有
    // 「已准入且协议兼容」的目标连接才配拿到 grant）。
    const exempt = opts.exempt ?? (typeof method === 'string' && method.startsWith('bridge.'))
    if (exempt) return
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
   * 发放编辑授权（契约 §6.1 / §6.1.1 ①）。
   *
   * v1 最小形态（本卡定的申请流程，契约把"申请"留给协作编辑）：
   *  - **只在有目标连接时发放**：没有已准入且协议兼容的目标，直接抛（-32007 / -32008）。
   *    **不排队、不缓存** —— 排队等于发放一条对端永远收不到的凭证，还留在表里放行；
   *  - `id`/`epoch` 在这里各 `randomBytes(16)` 生成一次，此后终生不变（单一生成方=DSH）；
   *  - `sessionId` 是**调用方自己的 DSH 会话标识**（消费者从它自己的上下文里取，
   *    不是线路数据、也不是 grant 的一部分）。写请求必须带来同一个值才会放行
   *    （评审 F2；判定在 `dshWriteGate` 里，与七行判定同源）。不给 = 这条 grant
   *    永远不能用于写入（fail closed），所以正常调用都必须给；
   *  - 投递用 **request 并等结构化回执**（评审 F9）：扩展侧 `bridge.grant` 的 handler
   *    先把凭证存进它自己的表，然后才回 `{ok:true, id}`。收到回执才算发放成功；
   *    送不出去 / 超时 / 回执形状不对 → **撤销本地记录**再抛（不自动重发，
   *    重发由调用方决定，因为每次重发都可能覆盖旧凭证）。
   *
   * 异步（返回 Promise）：v1 起投递语义从"写进 socket 就算送达"改成了"等到回执"。
   *
   * @param {{sessionId?: string|null, windowId?: string|null, timeoutMs?: number}} [opts]
   * @returns {Promise<{id: string, epoch: string, windowId: string|null,
   *                    delivered: true, ack: {ok: true, id: string}}>}
   * @throws {BridgeError} -32007 没有目标连接 / -32008 目标协议不兼容
   *   / -32004 等不到回执 / -32010 `sessionId` 缺失或形状不对（凭证无法参与会话绑定）
   */
  async grantEditing({ sessionId = null, windowId = null, timeoutMs } = {}) {
    const link = this._activeLink()
    if (!link) {
      throw new BridgeError(
        ERR.DISCONNECTED,
        'no editor connected; refusing to grant editing (no target to deliver the grant to)',
        { method: 'bridge.grant', reason: 'no-editor', granted: false },
      )
    }
    // 版本门：`bridge.grant` 是协议层方法，但发的是**写权限凭证**，强制不豁免。
    this._assertProtocolCompatible('bridge.grant', link, { exempt: false })

    // 没有会话标识的 grant 是"谁拿到都能用"的 bearer 凭证 —— 契约要的会话授权不允许。
    // 在发放时就拒，而不是先发出去再指望没人用得上（评审 F2：默认允许 null 会话就是洞）。
    // 判序排在「有没有目标 / 版本是否兼容」之后：那两条是更前置的前提，
    // 先回答"现在能不能发"，再回答"发给谁、能不能用"。
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        "editing.grant requires sessionId (the caller's own DSH session); "
        + 'a grant without a session can never authorize a write',
        { method: 'bridge.grant', reason: 'session-required', field: 'sessionId', granted: false })
    }

    // ★ 评审 R2-2：**先 stage，不生效**。
    //   第一版这里是 `issue()`（生成即入 active 表），于是"等回执"这段时间里
    //   `lookup` / `_grantForSession` / writeGate 已经能拿它放行 —— 评审实测：回执永不返回，
    //   同 session 的并发写照样到达写宿主。而"对端还不知道这条凭证"这件事，恰恰是
    //   最不能放行的时刻（对端没有记录可复核，写请求等于裸奔）。
    //   pending 存在两张表之外，因此没有任何放行路径能看到它。
    const { id, epoch } = this.grants.stage({ link, sessionId, windowId })
    const grant = { id, epoch, sessionId, windowId }
    const waitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : this.grantAckTimeoutMs
    let ack
    try {
      // 走 request（不是 notify）：没有回执就没有"扩展已存档"的证据（评审 F9）。
      // link.request 构造时带着 token，凭据的显式携带规则不变。
      ack = await link.request('bridge.grant', { grant }, { timeoutMs: waitMs })
      if (!ack || ack.ok !== true || ack.id !== id) {
        throw new BridgeError(ERR.INTERNAL,
          'bridge.grant was not acknowledged with {ok:true, id}; the editor did not store this grant',
          { method: 'bridge.grant', reason: 'no-ack', granted: false, ack: ack ?? null })
      }
      // ★ 回执合格还不够：承载连接/授权必须**此刻仍然有效**（评审 R2-2 ②）。
      //   等回执期间连接可能已经断了（或已被移出 trusted）—— 那时激活一条绑定在
      //   死连接上的凭证，等于制造一条永远无法复核的权限。
      if (!this._isCarrierUsable(link)) {
        throw new BridgeError(ERR.DISCONNECTED,
          'carrier connection went away while waiting for bridge.grant ack; grant not activated',
          { method: 'bridge.grant', reason: 'carrier-gone', granted: false })
      }
      // ★ 原子激活：同步一次状态迁移（Map delete+set，中间没有 await）。
      //   失败说明这条 pending 已被 supersede / 连接回收作废 —— 按"没生效"处理，绝不重试。
      if (!this.grants.activate(id)) {
        throw new BridgeError(ERR.INTERNAL,
          'staged grant was retired before activation (superseded or carrier closed); not granted',
          { method: 'bridge.grant', reason: 'grant-vanished', granted: false })
      }
    } catch (err) {
      // ★ 失败收口（评审 R2-2 ③；评审 R3-2 修正）：本地**和**对端都要处理，
      //   但**只针对这一条 id**，绝不波及承载连接。
      //   不能只清本地 pending —— 执行端可能已经 adopt 了这条权限（报文到了、回执没回来，
      //   或者回执在半路丢了），"我没收到回执"不等于"对端没存档"。所以：
      //     discard 本地 pending → 给这个 id 发 grantRevoke（尽力而为、幂等）→ 记诊断。
      //   ⚠️ 不 `link.close()`、不 `socket.destroy()`：那条连接上可能已经有一条健康的新
      //   授权（旧 pending 被 supersede 之后才失败），而且小超时可以反复触发 —— 踢连接
      //   既是误伤也是断连 DoS（评审实测，见 `_abortPendingGrant` 的注释）。
      this._abortPendingGrant(id, link, err)
      if (err instanceof BridgeError) throw err
      throw new BridgeError(ERR.INTERNAL,
        `bridge.grant delivery failed: ${err?.message ?? err}`,
        { method: 'bridge.grant', reason: 'delivery-failed', granted: false })
    }
    this.onLog?.('info', `edit grant issued (id ${id.slice(0, 8)}…, window ${windowId ?? 'n/a'})`)
    return { id, epoch, windowId, delivered: true, ack: { ok: true, id } }
  }

  /** @param {object} link 这条连接此刻还能承载凭证吗（活连接 + 仍被准入）。 */
  _isCarrierUsable(link) {
    if (!link || typeof link !== 'object') return false
    if (link.closed === true) return false
    if (link.socket?.destroyed === true) return false
    if (this.server?.trusted instanceof Set && !this.server.trusted.has(link)) return false
    return true
  }

  /**
   * 发放失败的对端收口（评审 R2-2 ③，**评审 R3-2 重做**）。
   *
   * 契约要求"失败闭合"，而**只有本端闭合是不够的**：对端可能已经存下这条凭证
   * （报文到了、回执没回来，或者回执在半路丢了）—— "我没收到回执"不等于"对端没存档"。
   *
   * 所以：本地 discard 这条 pending → 给**这一个 id** 发 `grantRevoke`（尽力而为、幂等）
   * → 记诊断。**就这三件事。**
   *
   * ⚠️ **绝不终止承载连接**（这是 R3-2 的结论，第一版写错了）：
   *  - 承载连接上可能已经有一条**另一条健康的新授权**（旧 pending 被 supersede 之后才失败），
   *    踢掉连接就是误伤它 —— 评审实测过 `NEW_GRANT_COLLATERAL {socketDestroyed:true,
   *    active:0, newGrantState:'tombstone', cause:'disconnected'}`。
   *  - 而且这是可反复触发的：小超时重试几次就能把连接反复踢断，构成断连 DoS
   *    （评审实测 `SMALL_DEADLINE_DOS`：一轮就把连接踢了）。
   * 每条失败只该影响**它自己那一条 id**。代价是"撤销报文可能没送到、对端留着一条本端
   * 已经不认的凭证"—— 但那条凭证的对端回执从没回来过，本端从头到尾没放过行，
   * 而这个残留由"连接断开时按 disconnected 回收"兜底，不需要靠主动断连来换。
   *
   * 关于"对端活着但一直不回执"（R3-2 ④）：pending 超时后按 `revoked` 永久作废
   * （不入 `disconnected`：连接还活着，这不是断连），并且**不禁**同一连接重新 `grant()`——
   * `stage()` 只作废该连接的既有记录，不会因为"上一条超时过"而拒绝新的一次发放，
   * 否则一次超时就把这个窗口永久锁死了。
   *
   * @param {string} id 已 stage 的 grant id（**只动它**）
   * @param {object} link 承载连接（只用来发撤销报文，不碰它的生命周期）
   * @param {unknown} err 触发收口的错误（只用于日志）
   */
  _abortPendingGrant(id, link, err) {
    // ① 本地：pending → 墓碑 revoked（永久作废；墓碑留给下次拿它来写时解释成 revoked
    //    而不是含糊的 no-grant）。命中不了（已被 supersede / 连接已回收）也算正常幂等。
    let discarded = false
    try {
      discarded = this.grants.discardPending(id, 'revoked')
    } catch (e) {
      this.onLog?.('warn', `abort pending grant: local discard failed: ${e?.message ?? e}`)
    }
    // ② 对端：**只给这个 id** 发撤销（带 token；不等回执 —— 拿不到回执正是这次失败的
    //    原因之一，再等一次没有意义）。连接没了就发不出去，那也无所谓：对端连接没了，
    //    它本地的 pending 也跟着没了。
    let delivered = false
    if (link && link.closed !== true && link.socket?.destroyed !== true) {
      try {
        link.notify('bridge.grantRevoke', { id, reason: 'revoked' }, { withToken: true })
        delivered = true
      } catch (e) {
        this.onLog?.('warn', `abort pending grant: revoke notify failed: ${e?.message ?? e}`)
      }
    }
    // ③ 诊断：说清"作了废什么 / 撤销有没有送到 / 连接刻意保留"。不碰连接，
    //    所以同连接上的其它 active grant 与后续 grant() 都完全不受影响。
    this.onLog?.('warn',
      `edit grant ${id.slice(0, 8)}… aborted after failed delivery: ${err?.message ?? err}`
      + ` (pending ${discarded ? 'discarded' : 'already gone'}; revoke`
      + ` ${delivered ? 'sent' : 'undeliverable'}; carrier link kept alive)`)

    // ④ 迁移合法性自检（R2-4 思想）：收口之后，这个 id **绝不能**还是 active/pending。
    //    留一条诊断比留一条隐形权限便宜得多。
    try {
      const after = this.grants.lookup(id)
      if (after?.kind === 'active') {
        this.onLog?.('error', `abort pending grant: ${id.slice(0, 8)}… is STILL active after abort`)
      }
    } catch { /* 诊断失败不影响收口结论 */ }
  }

  /**
   * 撤销编辑授权（`revoke(id?)`；省略 id 则撤销本端所有有效 grant）。
   *
   * **先本地失效，再尽力通知**：契约 §6.1.1 ①-b(2) 要求执行端的失效在本地完成、
   * 不依赖事后补发 —— 所以撤销报文丢了也不改变"已经撤销"这个结论。
   *
   * @param {string} [id]
   * @returns {{revoked: string[], count: number}}
   */
  revokeEditing(id) {
    const ids = (id === undefined || id === null)
      ? this.grants.active().map((r) => r.id)
      : [id]
    const revoked = []
    for (const one of ids) {
      const found = this.grants.lookup(one)
      if (!found) {
        // 可能是仍在等回执的 pending（`lookup` 按契约看不见它）：撤销 = 不再等它。
        // 对端这时可能已经存档，所以照样发撤销报文（拿 pendingCarrier 找到承载连接）。
        const carrier = this.grants.pendingCarrier(one)
        if (this.grants.discardPending(one, 'revoked')) {
          try { carrier?.notify('bridge.grantRevoke', { id: one, reason: 'revoked' }, { withToken: true }) } catch { /* 尽力而为 */ }
          revoked.push(one)
        }
        continue // 查不到/已是墓碑：幂等，不报错
      }
      if (found.kind !== 'active') continue
      const link = found.record.link
      this.grants.revoke(one, 'revoked') // ① 本地权威失效
      try { // ② 尽力通知（带 token；对端可能已经不在，发不出去不影响结论）
        link.notify('bridge.grantRevoke', { id: one, reason: 'revoked' }, { withToken: true })
      } catch (err) {
        this.onLog?.('warn', `edit grant revoke notify failed: ${err?.message ?? err}`)
      }
      revoked.push(one)
    }
    if (revoked.length > 0) {
      this.onLog?.('info', `edit grant revoked (${revoked.length})`)
    }
    return { revoked, count: revoked.length }
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
   *   / -32009 对端响应形状不合格（契约 §5.1，facade 出口校验）
   *   / -32010 写入类方法没有有效授权绑定（契约 §6.1，**发包前就拒，一个字节都不发**）
   */
  async request(method, params = {}, opts = {}) {
    if (typeof method !== 'string' || method === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'method must be a non-empty string')
    }

    const write = isWriteMethod(method)
    // ★ 评审 F2：`params.sessionId` 直接拒 —— 会话身份不许由业务参数自证。
    if (write) rejectParamsSessionId(params, method)

    const waitForEditor = opts.waitForEditor !== false
    const waitMs = waitForEditor ? (opts.waitMs ?? this.connectWaitMs) : 0

    // 调用方上下文里的会话身份（本端可信来源：消费者自己的 DSH 上下文，不是线路数据）。
    const sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== ''
      ? opts.sessionId
      : null

    // ── 选目标（评审 F3）──
    // 读路径：当前活跃连接；写路径：**grant 记录里的承载连接**，不经过 `_activeLink()`。
    let link
    let wireParams = params
    if (write) {
      const bound = this._bindWriteTarget(params, sessionId)
      link = bound.link
      wireParams = bound.params
    } else {
      link = await this._waitForEditor(waitMs)
      if (!link) {
        throw new BridgeError(
          ERR.DISCONNECTED,
          'no editor connected; make sure the dsh-kit-bridge VSCode extension is running',
          { method, discoveryDir: discoveryDir(), waitedMs: waitMs },
        )
      }
    }

    // ── 协议兼容门 + 能力预检：判的、发的是**同一条**连接 ──
    // hello 之前没有对端版本，属于「未知版本」：先等一小段（扩展连上后立刻报 hello），
    // 等不到就按不兼容处理 —— 绝不把「还没报」推断成 v1。
    // ★ 评审 F1：等的是**这条连接**的 hello，判的也是这条连接，发还是这条连接。
    //   以前读全局槽，A 的 hello 会给 B 的目标位背书（探针 B/D 实测 fail-open）。
    // ★ 评审 F3：写路径的 link 可能为 null（没有有效记录），此时**不**回退到
    //   `_activeLink()` —— 显式传 null 进去，让下面那道门按判定表给出 -32010。
    if (link) {
      if (!link.editor && waitForEditor && this.helloWaitMs > 0) {
        await this._waitForHello(link, Math.min(this.helloWaitMs, waitMs))
      }
      this._assertProtocolCompatible(method, link)
      this._assertCapability(method, link)
    }

    // ── 会话授权绑定门（契约 §6.1，第二个门）：版本门 / 能力预检之后，写线路之前 ──
    // 位置就是契约要的那一处：判的是「这次要发的那条连接」（link），不是别的视图。
    // 失败在这里直接抛 -32010 —— 下面的 link.request 一行都没执行，业务帧零字节出门。
    // 判据是一张表（WRITE_METHODS）而不是一个开关：新增写入类能力只加一条表项，门自动生效。
    // ★ 评审 F2：会话身份从 `opts.sessionId`（调用方上下文）来，与记录里的比对。
    if (write) this._writeGate(method, wireParams, link, { sessionId })

    if (!link) {
      // 理论上到不了：上面那道门对"没有有效记录"必然抛 -32010。留一行兜底，别让
      // 裸 TypeError 成为失败形态（铁律 2）。
      throw new BridgeError(ERR.DISCONNECTED, 'no editor connected', { method })
    }

    // 断线不清任何「版本槽」：版本事实挂在连接上，连接没了自然失效。
    // （旧实现这里清全局 lastEditor，会导致下一条连接继承/丢失判定，见 F1。）
    const result = await link.request(
      method, wireParams, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined,
    )

    // ── facade 出口形状校验（契约 §5.1，-32009 invalid-response）──
    // 位置：糖衣 `kit.vscode.*` 就是本方法的一行转发，所以这里是「结果交回调用方之前」
    // 的唯一点，raw request() 与糖衣方法共用同一道闸。
    // ★ 只处理**成功返回**：上面的版本门 / 能力预检 / link.request 抛的 -3200x 在到达
    //   这里之前就已 reject，原样上浮，不会被包装成 -32009。
    // 校验规则见 response-contract.js（已发布能力逐字对照契约表，未登记能力只有最低校验）。
    return validateResponse(method, result)
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
    // ★ 评审 F5：写入类方法**不许**走通知。通知没有回执，发送前门判完也证明不了
    //   对端存下了；而"默认给通知带 token 让它变成可执行写"是把漏洞换个位置。
    //   入口就拒，要求改用 request()（那道门与会话绑定才跑得起来）。
    assertWritableNotNotified(method, 'notify')
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
    grantAckTimeoutMs = DEFAULT_GRANT_ACK_TIMEOUT_MS,
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
    // 写入类糖衣：与 VscodeKit.vscode.applyEdit 成对出现（契约 §2.2 第②步：
    // 要加就两处都加；只加一处会让 facade 消费者拿到裸 TypeError）。
    applyEdit: (params, opts) => (kit
      ? kit.vscode.applyEdit(params, opts)
      : notReady('vscode.applyEdit')),
  }

  /**
   * 编辑授权面（`kit.editing.*`）—— 同样是**稳定存在**的转发函数。
   *
   * 未就绪时的失败形态按语义分：`grant`/`revoke` 是命令，抛 -32007 server-not-ready；
   * `list` 是只读诊断，返回空表（让排障代码不必为"还没起来"写分支）。
   */
  const editing = {
    grant: (opts) => {
      if (!kit) {
        throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
          { method: 'bridge.grant', reason: 'server-not-ready' })
      }
      return kit.editing.grant(opts)
    },
    revoke: (id) => {
      if (!kit) {
        throw new BridgeError(ERR.DISCONNECTED, 'dsh-vscode-kit is not listening yet',
          { method: 'bridge.grantRevoke', reason: 'server-not-ready' })
      }
      return kit.editing.revoke(id)
    },
    list: () => (kit ? kit.editing.list() : []),
  }

  const facade = {
    get ready() { return kit !== null },
    get vscode() { return vscode },
    get editing() { return editing },
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
        // ★ 会话授权绑定（契约 §6.1.1 ①-b(2)）：承载连接消失 → 这条连接上的编辑授权
        //   立刻失效，由**协议层的连接生命周期**驱动（不是定时器、不是轮询、不是计数器）。
        //   收回判据是换进来的这个 link 对象身份，`grants` 里存的就是它。
        //   闭包读 `kit` 变量而不是参数：监听先起、kit 后装配，空窗期内没有 grant 可回收，
        //   但绑定仍然正确（那时 `kit === null`，`?.` 安全跳过）。
        onLinkClosed: (link) => {
          const n = kit?.grants.closeLink(link) ?? 0
          if (n > 0) log('info', `edit grant invalidated by disconnect (${n})`)
        },
      })

      kit = new VscodeKit({
        server,
        dshVersion: readDshVersion(),
        connectWaitMs,
        helloWaitMs,
        grantAckTimeoutMs,
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
