/**
 * 会话授权绑定（grant）—— 发放、撤销、墓碑，以及**唯一一份**判定实现。
 *
 * 契约出处：`docs/协作编辑-钩子契约.md` §6.1（发送前表）/ §6.1.1（①-b 存储与失效、
 * ①-c 七行判定序、①-d 反例表、③ 失败闭合）。
 *
 * 设计上被这三条契约条款钉死的点，写在这里免得后人再"优化"回去：
 *
 *  1. **单一生成方**（§6.1.1 ①）：`id` 与 `epoch` 只在 DSH 侧 `GrantStore.issue()` 里
 *     由 `randomBytes(16)` 各生成一次，此后终生不变；扩展侧的 `adopt()` 只存不算。
 *     两端各自算一遍再比，等于把授权判据变成两端计数器 —— 明确禁止。
 *     同理：`epoch` 只做**等值**比较，永远不排序、不推断、不解析成数字。
 *
 *  2. **承载连接对象身份**（§6.1.1 ①-b(2) 第 6 行）：有效性绑在「收到/发出它的那条
 *     连接对象」上（`record.link`，进程内引用比较 `!==`），**不靠任何序号**。
 *     连接断开/重连 = 换了对象 = 旧 grant 自然失效；不需要（也不允许）引入计数器。
 *
 *  3. **判定序只许有一份**（§6.1.1 ①-c）：`judgeGrant()` 是本文件唯一的判定实现，
 *     DSH 侧发送前与扩展侧执行前**都调它**，只有 `side` 参数不同 —— 因为契约对
 *     同一行给两侧定义了不同的 `data.reason` 措辞（见 REASON_BY_SIDE 注释），
 *     顺序与放行判据完全一致。各写一份必然漂移，那正是"跳过语义"被绕开的入口。
 *
 * 数据结构：active（有效）/ tombstones（墓碑）两个 Map，全在**内存**里，不落盘。
 * 墓碑只保留最近 `GRANT_TOMBSTONE_LIMIT` 条，用途只有一个：把 `data.reason` 说清楚。
 * 它**不参与放行**（墓碑命中的包一律拒绝，淘汰掉了也只是换一句 reason）。
 */

import { randomBytes } from 'node:crypto'
import { BridgeError, ERR } from './protocol.js'

/**
 * `-32010` 的 `data.reason` 取值（契约 §6.1 表 + §6.1.1 ①-c 七行序）。
 *
 * 五种情形的**处置完全一样**（停下、重新申请、不得重试），区别只在排障与 UI 文案：
 *  - `no-grant`：没带凭证 / 凭证 id 查不到（含墓碑被淘汰、宿主重启）
 *  - `grant-mismatch`：凭证有效，但绑的不是这次请求的目标（别处授权过 → 去那个窗口确认）
 *  - `grant-revoked`：被主动撤销，或被新一次授权覆盖
 *  - `target-gone`：承载连接已经没了（DSH 侧视角；扩展侧同情形说 stale，见下）
 *  - `grant-generation-stale`：连接换了 / epoch 不等（扩展侧视角）
 */
export const GRANT_REASONS = Object.freeze({
  NO_GRANT: 'no-grant',
  GRANT_MISMATCH: 'grant-mismatch',
  GRANT_REVOKED: 'grant-revoked',
  TARGET_GONE: 'target-gone',
  GRANT_GENERATION_STALE: 'grant-generation-stale',
})

/** 墓碑保留条数（§6.1.1 ①-b(2)：建议 32，仅供诊断）。 */
export const GRANT_TOMBSTONE_LIMIT = 32

/**
 * 允许写进墓碑的 `cause` 合法集合（评审 R2-4 ②）。
 *
 * 墓碑的 cause **不是自由文本**：它决定第 3/4 行说哪句话（`disconnected` → target-gone /
 * stale；`superseded`、`revoked` → grant-revoked）。所以它是状态机的边，不是日志字段 ——
 * 写入边界上必须先验集合。
 *
 * 之前行 4 的实现是"不是 disconnected 就当 revoked"，那等于给未知 cause 发了一张
 * 通往表内某行的票：将来谁新增一个 `cause: 'expired'`（或手滑打错字），它会静默地
 * 变成"被撤销" —— 一张表里出现了表上没有的行，而且说得还很像真的。
 * 现在未知 cause 在**写入时**就抛（本端 bug，立刻可见），判定侧再兜一次（fail closed
 * 且不伪装成任何一行）。
 */
export const GRANT_RETIRE_CAUSES = Object.freeze(['disconnected', 'superseded', 'revoked'])

/** @param {string} cause @returns {boolean} 是不是契约认可的状态迁移原因 */
export function isRetireCause(cause) {
  return GRANT_RETIRE_CAUSES.includes(cause)
}

/**
 * 写入边界验 cause（评审 R2-4 ②）。
 * @param {string} cause
 * @param {string} where 调用点（报错里带上，便于定位是本端哪条路径写错的）
 * @returns {string} 原样返回，方便内联使用
 */
export function assertRetireCause(cause, where = 'grant') {
  if (!isRetireCause(cause)) {
    throw new BridgeError(
      ERR.INTERNAL,
      `${where}: retirement cause "${String(cause)}" is not in the contract set ` +
      `(${GRANT_RETIRE_CAUSES.join(' / ')}); refusing to write an unrepresentable state`,
      { reason: 'unknown-grant-cause', cause: String(cause), allowed: [...GRANT_RETIRE_CAUSES] },
    )
  }
  return cause
}

/**
 * 写入类能力清单（§6.1.1 ②「按该能力是否登记为写入类判，不按是否糖衣」）。
 *
 * 判据是一张表，不是一个开关：保存/新建/删除/改名往这里追加，门就是自动生效的
 * （契约 §6.2.6 已写明这是"设计时留好的口子"—— 不要为 `vscode.save` 再设计一道绑定门）。
 *
 *  - `vscode.applyEdit`（T3）：只改缓冲区；
 *  - `vscode.save`（T39 / Tier 3）：会改磁盘 —— 绑定门照旧先行，磁盘锚点（`-32013`）
 *    与意图门（`-32012 reason:'buffer-dirty'`，见 `grantAllowsDirtySave`）是**额外的**两道；
 *  - `vscode.deleteFile`（T40 / Tier 4）：**不可逆**。绑定门在这里的作用比前两条更像
 *    安全边界（前两条判错了还能再改一次，这条判错了没有第二次）。追加进来就自动继承
 *    `request()` 里"写入类必带 `expectedIncarnation`"那条（T35），所以删除的双锚点是
 *    白名单/绑定门这一层顺带守住的，不是删除自己另加的规矩。
 *    ★ 但绑定门**不等于** tiers 白名单（`whitelist.js` 的 `delete` 档）：前者管"发给谁"，
 *    后者管"消费者被允许做多重的事"，两道都要有（契约 §6.2.5）。
 */
export const WRITE_METHODS = Object.freeze([
  'vscode.applyEdit',
  'vscode.save',
  'vscode.deleteFile',
])

/** @param {string} method @returns {boolean} 该方法是否属于写入类（需要绑定门） */
export function isWriteMethod(method) {
  return typeof method === 'string' && WRITE_METHODS.includes(method)
}

/** 128-bit opaque hex（`randomBytes(16).toString('hex')` 的产物形状）。 */
const HEX_32 = /^[0-9a-f]{32}$/

/** @param {unknown} v */
export function isGrantId(v) {
  return typeof v === 'string' && HEX_32.test(v)
}

/** @param {unknown} v */
export function isGrantEpoch(v) {
  return typeof v === 'string' && HEX_32.test(v)
}

/**
 * 形状校验：`{ id, epoch }` 两个 32 hex。
 * @param {unknown} grant
 * @returns {{ok: true} | {ok: false, problem: string}}
 */
export function checkGrantShape(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    return { ok: false, problem: 'grant must be an object' }
  }
  if (!isGrantId(grant.id)) return { ok: false, problem: 'grant.id must be 32 hex chars' }
  if (!isGrantEpoch(grant.epoch)) return { ok: false, problem: 'grant.epoch must be 32 hex chars' }
  return { ok: true }
}

/** 一次发放：128-bit 随机 hex（不可排序、不可推断，§6.1.1 ①第 3 条）。 */
function newOpaqueHex() {
  return randomBytes(16).toString('hex')
}

/**
 * 授予记录表（两端同构）。
 *
 * 两侧字段语义一致，差别只在 `link` 的**方向**：
 *  - DSH 侧：`link` = 这条 grant 发往的连接（发送前门拿它比目标连接身份）；
 *  - 扩展侧：`link` = 这条 grant 从哪条连接收到（执行前复核拿它比当前承载连接）。
 *
 * 所以判定那句 `record.link !== currentLink` 在两侧是同一句话，不需要写两遍。
 */
export class GrantStore {
  /**
   * @param {{tombstoneLimit?: number}} [opts]
   */
  constructor({ tombstoneLimit = GRANT_TOMBSTONE_LIMIT } = {}) {
    /** @type {Map<string, {id: string, epoch: string, link: object, sessionId: string|null, windowId: string|null, cause: null, at: number}>} */
    this._active = new Map()
    /**
     * 已生成、**还没拿到执行端回执**的凭证（评审 R2-2）。
     *
     * 这张表存在的唯一理由是：`grant()` 要等一个跨进程回执（`await link.request`），
     * 而"等"这件事不能把权限提前给出去。所以 `pending` 与 `active` 是**两个物理表**，
     * 不是一条记录上的一个布尔字段 —— 只要仍是一张表，就总有某条放行路径顺手
     * `_active.get(id)` 把它捞出来（第一版的漏洞正是如此：`issue()` 先入 active 再等回执，
     * 结果是"没有任何回执、并发写照样到达执行端"）。
     *
     * 归口规则（一条都不能破）：
     *  - `lookup()` 只看 active + 墓碑，**永不**返回 pending；
     *  - `active()` / `forLink()` 只扫 active；
     *  - 判定表（`judgeGrant`）因此天然看不见 pending（它只经 `lookup`）；
     *  - 唯一能让 pending 变成 active 的入口是 `activate(id)`，且它同步完成、无 await。
     *
     * @type {Map<string, {id: string, epoch: string, link: object, sessionId: string|null, windowId: string|null, cause: null, at: number}>}
     */
    this._pending = new Map()
    /** @type {Map<string, {id: string, epoch: string, sessionId: string|null, windowId: string|null, cause: string, at: number, retiredAt: number}>} */
    this._tombstones = new Map()
    this._tombstoneLimit = Number.isInteger(tombstoneLimit) && tombstoneLimit > 0
      ? tombstoneLimit
      : GRANT_TOMBSTONE_LIMIT
  }

  /** 有效 grant 条数（诊断/测试用）。**不含** pending —— 那还不是权限。 */
  get size() {
    return this._active.size
  }

  /** 尚未拿到回执的 pending 条数（诊断/测试用；任何时候都不能被当成权限）。 */
  get pendingSize() {
    return this._pending.size
  }

  /** 墓碑条数（诊断/测试用）。 */
  get tombstoneSize() {
    return this._tombstones.size
  }

  /**
   * 第一步：**生成但不生效**（评审 R2-2）。
   *
   * 生成方只有 DSH（§6.1.1 ①），而"生成"与"生效"必须分开：生成之后还要把凭证送到
   * 执行端、拿到回执。中间这段时间里，本地**一条可用记录都不能有**，否则
   * `lookup-active` / `_grantForSession` / writeGate 就能在"对端还不知道这条凭证"的
   * 情况下放行 —— 评审实测的正是这条路（挂起回执期间并发写照样到达写宿主）。
   *
   * 同一连接上已有的 **active** grant 会被置为 `superseded`（§6.1.1 ①-b(2)「每窗口最多
   * 1 个有效 grant，新到即覆盖」）；同连接上残留的 pending 也一并作废
   * （新的一次发放就是"我不再等上一条了"）。
   *
   * `allowDirtySave`（T39 / 契约 §6.2.2 结论）：**这个位必须长在 grant 上**，不能是
   * `params` 里的开关 —— 放在参数上等于调用方自己给自己授权。它只对 `vscode.save` 的
   * 意图门有效（`grantAllowsDirtySave`），且**只认布尔 `true`**（`'true'`、`1`、
   * 缺失一律视为 false）：这个位放宽的是一道安全门，形状宽松就等于半个默认开启。
   *
   * @param {{link: object, sessionId?: string|null, windowId?: string|null, allowDirtySave?: boolean}} p
   * @returns {{id: string, epoch: string}}
   */
  stage({ link, sessionId = null, windowId = null, allowDirtySave = false } = {}) {
    if (!link || typeof link !== 'object') {
      throw new BridgeError(ERR.INTERNAL, 'GrantStore.stage requires the carrier link object')
    }
    this._supersedeLink(link)
    const record = {
      id: newOpaqueHex(),
      epoch: newOpaqueHex(),
      link,
      sessionId,
      windowId,
      allowDirtySave: allowDirtySave === true,
      cause: null,
      at: Date.now(),
    }
    this._pending.set(record.id, record)
    return { id: record.id, epoch: record.epoch }
  }

  /**
   * 第二步：把一条 pending **原子激活**（评审 R2-2 ②）。
   *
   * 调用方必须先自己验完「回执合格 + 承载连接仍有效」再来这里；本方法只做状态迁移。
   * 迁移是同步的（一张 Map 的 delete + set，中间没有 await），所以不存在"验完到生效
   * 之间又被谁插一脚"的窗口 —— 这是本模块唯一承诺的原子性，也只覆盖这一步。
   *
   * 返回 `false` 表示这条 pending 已经不在了（被 supersede / 连接断了 / 超时收口）。
   * 调用方必须把它当失败处理：**不许**在这里退化成"重新 stage 一次"。
   *
   * @param {string} id
   * @returns {boolean} 是否真的激活了
   */
  activate(id) {
    const record = this._pending.get(id)
    if (!record) return false
    this._pending.delete(id)
    this._active.set(id, record)
    return true
  }

  /**
   * 一条 pending 的承载连接。
   *
   * ⚠️ **只给收口用**（撤销报文要知道往哪发）。返回值是 link 对象，不是凭证状态：
   * 拿它去放行是错的 —— pending 记录本身不参与任何判定（`lookup` 看不见它）。
   *
   * @param {string} id
   * @returns {object|null}
   */
  pendingCarrier(id) {
    const record = this._pending.get(id)
    return record ? record.link : null
  }

  /**
   * 丢掉一条 pending（失败收口的一半：本地不再等它）。
   *
   * **注意**：这只解决本地半边。另一半是"执行端可能已经 adopt 了这条权限、只是回执
   * 没回来"—— 那一半由 `VscodeKit._abortPendingGrant()` 负责（给**这一个 id** 发撤销报文；
   * 评审 R3-2：**不**终止承载连接，见那里的注释）。绝不把"我没收到回执"读成"对端没存档"。
   *
   * 作废是**永久**的（进墓碑，`cause` 不进 `disconnected`——连接可能还活得好好的），
   * 但**不影响同一连接重新 `stage()`**：`stage` 只看该连接此刻的既有记录，
   * 不会因为"上一条超时过"而拒绝新的发放。
   *
   * @param {string} id
   * @param {string} [cause] 必须 ∈ GRANT_RETIRE_CAUSES
   * @returns {boolean} 是否命中一条 pending
   */
  discardPending(id, cause = 'revoked') {
    const record = this._pending.get(id)
    if (!record) return false
    this._retire(record, assertRetireCause(cause, 'GrantStore.discardPending'))
    return true
  }

  /**
   * 同步发放：`stage` + 立刻 `activate`，中间不等任何东西。
   *
   * ⚠️ 只适用于**不需要投递回执**的场景（同进程测试、纯本地凭证）。真实的发放路径
   * （`VscodeKit.grantEditing`）必须走 `stage → request → activate`：先让它生效再等回执，
   * 就是把 R2-2 那条洞原样放回来（评审实测过：挂起回执期间并发写照样到达执行端）。
   *
   * 同一连接上已有的 grant 会被置为 `superseded`（§6.1.1 ①-b(2)「每窗口最多 1 个有效
   * grant，新到即覆盖」）。旧 grant 不是"还能用一会儿"，是立刻失效。
   *
   * @param {{link: object, sessionId?: string|null, windowId?: string|null,
   *          allowDirtySave?: boolean, cause?: null}} p
   * @returns {{id: string, epoch: string}}
   */
  issue({ link, sessionId = null, windowId = null, allowDirtySave = false } = {}) {
    const { id } = this.stage({ link, sessionId, windowId, allowDirtySave })
    if (!this.activate(id)) {
      // 同步路径上不可能发生（stage 刚写完，没有 await 让出）；真发生了就是本端 bug。
      throw new BridgeError(ERR.INTERNAL, 'GrantStore.issue: staged grant vanished before activation')
    }
    return { id, epoch: this._active.get(id).epoch }
  }

  /**
   * 扩展侧登记（只存不生成，§6.1.1 ①：生成方只有 DSH）。
   *
   * `allowDirtySave` 跟着 grant 一起过来并**只存**（与 id/epoch 同一条原则：本端不补默认值、
   * 不自己推断）。DSH 没给 = 没有这个位 = 意图门默认拒脏缓冲区（fail closed）。
   *
   * @param {{id: string, epoch: string, link: object, sessionId?: string|null,
   *          windowId?: string|null, allowDirtySave?: boolean}} p
   * @returns {{id: string, epoch: string}}
   * @throws {BridgeError} -32602 形状不合格
   */
  adopt({ id, epoch, link, sessionId = null, windowId = null, allowDirtySave = false } = {}) {
    const shape = checkGrantShape({ id, epoch })
    if (!shape.ok) {
      throw new BridgeError(ERR.INVALID_PARAMS, `invalid grant: ${shape.problem}`, {
        method: 'bridge.grant', got: typeof id === 'string' ? 'string' : typeof id,
      })
    }
    if (!link || typeof link !== 'object') {
      throw new BridgeError(ERR.INTERNAL, 'GrantStore.adopt requires the carrier link object')
    }
    this._supersedeLink(link)
    this._active.set(id, {
      id, epoch, link, sessionId, windowId, allowDirtySave: allowDirtySave === true, cause: null, at: Date.now(),
    })
    return { id, epoch }
  }

  /**
   * 查一条：有效表优先，其次墓碑。**pending 永远查不到**（评审 R2-2 ①）。
   *
   * 这不是"顺手没加"，而是这条路径的契约：`lookup` 是全仓唯一的放行查询入口
   * （`judgeGrant`、`_bindWriteTarget`、`_grantForSession` 都只经它或 `active()` 看世界），
   * 所以只要它不认识 pending，"还没拿到回执的凭证"就不可能被任何一道门放行。
   *
   * @param {string} id
   * @returns {{kind: 'active'|'tombstone', record: object} | null}
   */
  lookup(id) {
    if (!isGrantId(id)) return null
    const active = this._active.get(id)
    if (active) return { kind: 'active', record: active }
    const dead = this._tombstones.get(id)
    if (dead) return { kind: 'tombstone', record: dead }
    return null
  }

  /**
   * 撤销一条（显式撤销 = `cause: 'revoked'`）。
   *
   * 本地失效是**权威**的：即使撤销报文没送到对端（断线/对端重启），本端也已经不再放行。
   * 契约 §6.1.1 ①-b(2) 说得很清楚：执行端的失效"本地完成，不依赖事后补发"。
   *
   * 也接受 pending 的 id（收口路径会用到）：撤掉一条还在等回执的凭证，效果是"不再等它"。
   *
   * @param {string} id
   * @param {string} [cause] 必须 ∈ GRANT_RETIRE_CAUSES
   * @returns {boolean} 是否命中一条有效（或 pending）grant
   */
  revoke(id, cause = 'revoked') {
    const wanted = assertRetireCause(cause, 'GrantStore.revoke')
    if (this._pending.has(id)) return this.discardPending(id, wanted)
    const record = this._active.get(id)
    if (!record) return false
    this._retire(record, wanted)
    return true
  }

  /**
   * 承载连接断了：该连接上的**所有** grant 立刻失效（`cause: 'disconnected'`）。
   *
   * 由连接生命周期驱动（server.js 的 socket close/error、connector.js 的 socket close），
   * 判据是**对象身份**（`record.link === link`），不做任何计数/序号比较。
   *
   * @param {object} link
   * @returns {number} 失效条数
   */
  closeLink(link) {
    let n = 0
    for (const record of [...this._pending.values()]) {
      if (record.link !== link) continue
      // 连接没了 → 回执永远等不到；留着它只会让发放路径等满超时。就地作废（说 disconnected）。
      this._retire(record, assertRetireCause('disconnected', 'GrantStore.closeLink'))
      n++
    }
    for (const record of [...this._active.values()]) {
      if (record.link !== link) continue
      this._retire(record, assertRetireCause('disconnected', 'GrantStore.closeLink'))
      n++
    }
    return n
  }

  /** 有效 grant 记录（只读视图；判定不读它，`judgeGrant` 走 `lookup`）。 */
  active() {
    return [...this._active.values()]
  }

  /** 该连接上的有效 grant（诊断/测试用；判定不读它）。 */
  forLink(link) {
    return [...this._active.values()].filter((r) => r.link === link)
  }

  /**
   * 诊断视图：只给排障与测试，**不是判据**。
   * 永远不返回 `link` 对象本身 —— 那会把死连接挂在快照里，也让调用方有机会拿它去比。
   *
   * pending 也列出来（`pending: true, active: false, cause: null`）：发放挂住时它是唯一
   * 能看出来的东西，藏起来等于让"卡在等回执"变成不可观测状态。但它的 `active` 恒为
   * `false`，`cause` 恒为 `null` —— 视图里它和"有效"没有任何共同表达。
   *
   * @returns {Array<{id: string, epoch: string, cause: string|null, active: boolean, pending: boolean, linkPort: number|null, at: number}>}
   */
  entries() {
    const out = []
    for (const r of this._active.values()) {
      out.push({
        id: r.id,
        epoch: r.epoch,
        cause: null,
        active: true,
        pending: false,
        linkPort: r.link?.socket?.remotePort ?? null,
        at: r.at,
      })
    }
    for (const r of this._pending.values()) {
      out.push({
        id: r.id,
        epoch: r.epoch,
        cause: null,
        active: false,
        pending: true,
        linkPort: r.link?.socket?.remotePort ?? null,
        at: r.at,
      })
    }
    for (const r of this._tombstones.values()) {
      out.push({
        id: r.id,
        epoch: r.epoch,
        cause: r.cause,
        active: false,
        pending: false,
        linkPort: null,
        at: r.at,
      })
    }
    return out
  }

  /** @param {object} link 把这条连接上的有效 grant 全部置 superseded（pending 一并作废）。 */
  _supersedeLink(link) {
    for (const record of [...this._pending.values()]) {
      if (record.link !== link) continue
      this._retire(record, assertRetireCause('superseded', 'GrantStore._supersedeLink'))
    }
    for (const record of [...this._active.values()]) {
      if (record.link !== link) continue
      this._retire(record, assertRetireCause('superseded', 'GrantStore._supersedeLink'))
    }
  }

  /**
   * 有效/pending → 墓碑。
   *
   * 墓碑里**不保留 link 引用**（它是死连接的强引用，也是别人拿来比身份的诱饵）。
   * 淘汰按插入顺序 FIFO：墓碑只解释 reason，不参与放行，所以淘汰不需要任何策略。
   *
   * `cause` 在这里再验一次（评审 R2-4 ②）：本方法是**所有**状态迁移的唯一出口，
   * 把它写成漏斗才不会漏掉将来新增的调用点。
   */
  _retire(record, cause) {
    const why = assertRetireCause(cause, 'GrantStore._retire')
    this._active.delete(record.id)
    this._pending.delete(record.id)
    this._tombstones.set(record.id, {
      id: record.id,
      epoch: record.epoch,
      sessionId: record.sessionId,
      windowId: record.windowId,
      cause: why,
      at: record.at,
      retiredAt: Date.now(),
    })
    while (this._tombstones.size > this._tombstoneLimit) {
      const oldest = this._tombstones.keys().next()
      if (oldest.done) break
      this._tombstones.delete(oldest.value)
    }
  }
}

/**
 * 七行判定序（§6.1.1 ①-c）——**全仓唯一实现**，先命中先返回，不做多因合并。
 *
 * | 行 | 条件 | reason（dsh 侧 / 扩展侧） |
 * |----|------|----------------------------|
 * | 1  | 未带 params.grant（不含对象形状 / 是数组） | no-grant / no-grant |
 * | 2  | id 查不到（含 id 形状不合法、墓碑被淘汰、宿主重启、**仍在等回执的 pending**） | no-grant / no-grant |
 * | 3  | 墓碑 cause=disconnected | target-gone / grant-generation-stale |
 * | 4  | 墓碑 cause∈{superseded,revoked} | grant-revoked / grant-revoked |
 * | 5  | 有效但 epoch 不等 | grant-generation-stale / grant-generation-stale |
 * | 6  | 有效但承载连接不是这条连接（对象身份 `!==`） | grant-mismatch / grant-generation-stale |
 * | 7  | 全等 | 放行 |
 *
 * **顺序是判据的一部分**（评审 F4）：`id` 命中之后允许出现的分歧只有"墓碑在哪一行"、
 * "epoch 与连接谁先"，不能把 epoch 提前到墓碑之前 —— 否则同一个包在两个因同时命中时
 * 会说不同的话，而 reason 正是用户决定"要不要重新申请"的唯一依据。
 * 所以下面严格按表号走，每行只问一件事。
 *
 * 第 3/6 行为什么按侧换词：契约对同一物理情形给了两种**视角**的措辞 ——
 * §6.1 发送前表（DSH 视角：我原来要发的那条连接没了 → `target-gone`；我手里这条
 * grant 绑的是别的窗口 → `grant-mismatch`，提示用户去那个窗口确认）；§6.1.1 ①-c
 * （扩展视角：请求不是从这条连接来的 / 连接已换 → `grant-generation-stale`）。
 * 判定**顺序与放行结果两侧完全一致**，只有 reason 措辞按视角分流；把顺序也分两份
 * 才是真正的漂移风险。
 *
 * @param {{store: GrantStore, grant?: any, link?: object|null,
 *          sessionId?: string|null, requireSession?: boolean, side?: 'dsh'|'extension'}} p
 * @returns {{ok: true, row: 7|8, grant: {id: string, epoch: string}}
 *   | {ok: false, row: number, reason: string}}
 */
export function judgeGrant({
  store, grant, link = null, sessionId = null, requireSession = false, side = 'extension',
} = {}) {
  if (!store) throw new BridgeError(ERR.INTERNAL, 'judgeGrant requires a GrantStore')
  if (side !== 'dsh' && side !== 'extension') {
    throw new BridgeError(ERR.INTERNAL, `judgeGrant: unknown side "${side}"`)
  }
  const dsh = side === 'dsh'

  // ── 行 1：没带凭证（对象形状都不成立） ──
  // 这里只问一件事：**调用方到底有没有交出一个 grant 对象**。
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    return { ok: false, row: 1, reason: GRANT_REASONS.NO_GRANT }
  }

  // ── 行 2：id 查不到（含 id 形状不合法、墓碑被淘汰、宿主重启、仍在等回执的 pending） ──
  // ★ 评审 R2-4 ①：**畸形 id 归第 2 行，不归第 1 行**。
  //   行 1 的语义是"这条请求没有凭证"；可是 `{id: 'nope'}` 明明交了一份凭证，只是查不到。
  //   第一版把 `!isGrantId(grant.id)` 塞进行 1，等于让"形状不合法"抢在"查不到"前面说话，
  //   于是同一个包（畸形 id + 已失效的 epoch）在两处会说出不同的行号 —— 而这张表的价值
  //   全在"先命中先返回、行号可预期"。id 是查表键，键不成形 = 查不到，落在第 2 行。
  if (!isGrantId(grant.id)) return { ok: false, row: 2, reason: GRANT_REASONS.NO_GRANT }
  const found = store.lookup(grant.id)
  if (!found) return { ok: false, row: 2, reason: GRANT_REASONS.NO_GRANT }

  // ── 行 3 / 行 4：墓碑先说死因，**先于** epoch 与连接 ──
  // 墓碑已死：即使调用方顺手改对了 epoch 也仍然拒绝，且措辞表明"重发凭证没用，要重新申请"。
  if (found.kind === 'tombstone') {
    const cause = found.record.cause
    if (cause === 'disconnected') {
      // ── 行 3：承载连接断了（DSH 视角就是我本来要发的那条连接没了） ──
      return {
        ok: false,
        row: 3,
        reason: dsh ? GRANT_REASONS.TARGET_GONE : GRANT_REASONS.GRANT_GENERATION_STALE,
      }
    }
    if (cause === 'superseded' || cause === 'revoked') {
      // ── 行 4：被撤销 / 被新一次授权覆盖 ──
      return { ok: false, row: 4, reason: GRANT_REASONS.GRANT_REVOKED }
    }
    // ★ 评审 R2-4 ②：未知 cause 不伪装成表内任何一行。
    //   第一版写的是"不是 disconnected 就当 revoked"，那会让一个本端 bug（写进一个
    //   表上没有的 cause）表现为一句听起来很正常的 grant-revoked：用户看到的建议是
    //   "重新授权"，而真实情况是状态机出现了不可表达的迁移。这种伪装比报错危险得多 ——
    //   它会一直成功说谎。这里选择**失败闭合 + 说出实情**（-32603 内部状态错误）。
    throw new BridgeError(
      ERR.INTERNAL,
      `grant ${found.record.id} retired with cause "${String(cause)}" which the ` +
      'seven-row table cannot represent; refusing to guess a reason',
      { reason: 'unknown-grant-cause', cause: String(cause), grantId: found.record.id },
    )
  }

  const record = found.record

  // ── 行 5：epoch 不等（等值判据，绝不排序、不解析） ──
  // **类型失配也归这一行**（评审 F4）：契约表把 epoch 的判定整个放在第 5 行，
  // 而"不是字符串"和"字符串不等"对外都是"这条请求的世代不对"，不该分两处报。
  if (!isGrantEpoch(grant.epoch) || grant.epoch !== record.epoch) {
    return { ok: false, row: 5, reason: GRANT_REASONS.GRANT_GENERATION_STALE }
  }

  // ── 行 6：承载连接对象身份不等（进程内引用比较，不碰任何序号） ──
  if (record.link !== link) {
    return {
      ok: false,
      row: 6,
      reason: dsh ? GRANT_REASONS.GRANT_MISMATCH : GRANT_REASONS.GRANT_GENERATION_STALE,
    }
  }

  // ── 行 7：全等放行 ──
  return { ok: true, row: 7, grant: { id: record.id, epoch: record.epoch } }
}

/**
 * 会话一致性（评审 F2）：写入请求必须来自**发放这条 grant 的那个会话**。
 *
 * 契约 §6.1/§6.1.1 把 grant 绑在「承载连接对象」上，但连接是**进程/窗口级**的：
 * 同一个窗口里可能先后（或同时）有多个 DSH 会话，A 拿到授权后 B 连上来，
 * 只比连接身份是比不出来的。所以 grant 记录里额外存 `sessionId`，并在这里比对。
 *
 * 身份**只从两个地方来**，都不经过业务 `params`：
 *  - 扩展侧：请求承载连接上 shack 的会话（`link.authorized.sessionId`，由 `bridge.hello` 登记）；
 *  - DSH 侧：调用方法时显式传入的「调用方上下文」第二个参数（`kit.vscode.*(params, ctx)`）。
 * 业务 `params.sessionId` 一律拒（见 `rejectParamsSessionId`）—— 否则调用方自证即可越权。
 *
 * 失败闭合：调用方没给会话 / 记录里没存会话 / 两者不等 → 全部 `-32010`。
 * reason 选 `grant-mismatch`：契约 §6.1 表里它正是"凭证有效，但绑的不是这次请求的目标"
 * （扩展侧同位置用 `grant-generation-stale` 的措辞），语义最贴近，不新造 reason。
 *
 * @param {object} record  有效 grant 记录（含 sessionId）
 * @param {{sessionId?: string|null, requireSession?: boolean, side?: 'dsh'|'extension'}} p
 * @returns {{ok: true} | {ok: false, row: 8, reason: string}}
 */
export function judgeSession({ record, sessionId = null, requireSession = false, side = 'extension' } = {}) {
  const recorded = typeof record?.sessionId === 'string' && record.sessionId.length > 0
    ? record.sessionId
    : null
  // 记录里没有会话（老凭证 / 发放方没传）：证明不了"就是它"，fail closed。
  if (!recorded) {
    return { ok: false, row: 8, reason: GRANT_REASONS.GRANT_MISMATCH }
  }
  const claimed = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  if (!claimed) {
    return { ok: false, row: 8, reason: GRANT_REASONS.GRANT_MISMATCH }
  }
  if (claimed !== recorded) {
    return { ok: false, row: 8, reason: GRANT_REASONS.GRANT_MISMATCH }
  }
  return { ok: true }
}

/**
 * `params.sessionId` 一律拒（评审 F2）。
 *
 * 理由不是"多此一举"，是**防误解**：如果允许它存在，调用方会以为它起作用；
 * 一旦哪天判定把它读进来，会话绑定就变成了自证。所以出现即报参数错。
 * `applyEditParams()` 是唯一构造入口，它直接扔掉这个字段（糖衣层不会把它带出去）。
 *
 * @param {any} params
 * @param {string} method
 * @throws {BridgeError} -32602
 */
export function rejectParamsSessionId(params, method) {
  if (params && typeof params === 'object' && 'sessionId' in params) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.sessionId is not accepted: session identity comes from the caller context, not from params',
      { method, field: 'sessionId' })
  }
}

/**
 * 写入类方法不许走"发出去就完事"的通道（评审 F5 / 契约 §6.1.1 ④）。
 *
 * `notify`（DSH 侧）与 `broadcast`（server 侧）都是**无回执**的：判定表 ④ 要求越过
 * 线性化点即已落点，而通知连"对端有没有收到"都证明不了，更证明不了它在落点前复核过。
 * 所以入口直接拒，要求改用 `request()`（会话绑定门 + 回执都在那条路上）。
 *
 * **不许**改成"给通知默认带上 token 让它变成可执行的写"：那只是把同一件事换个位置，
 * 回执、门、线性化点依然全缺（铁律 8：出站消息不许默认附带 token）。
 *
 * @param {string} method
 * @param {'notify'|'broadcast'} entry 触发入口（写进 data 供排障）
 * @throws {BridgeError} -32600
 */
export function assertWritableNotNotified(method, entry = 'notify') {
  if (!isWriteMethod(method)) return
  throw new BridgeError(ERR.INVALID_REQUEST,
    `write method "${method}" cannot be sent via ${entry}: it has no receipt and no write gate; use request()`,
    { method, entry, reason: 'write-requires-request', use: 'request' })
}

/**
 * 造 `-32010`（data 形状对齐契约 §6.1.1：`{reason, method}` + 行号供排障）。
 *
 * @param {string} method
 * @param {string} reason
 * @param {number} [row]
 * @returns {BridgeError}
 */
export function editNotBoundError(method, reason, row) {
  return new BridgeError(ERR.EDIT_NOT_BOUND, `edit-not-bound: ${reason} (${method})`, {
    reason,
    method,
    ...(typeof row === 'number' ? { row } : {}),
  })
}

/**
 * DSH 侧**发送前**门（契约 §6.1 表）：写入类方法在写线路之前判，失败一个字节都不发。
 *
 * 判两件事，**顺序固定**：七行判定（凭证/世代/连接）→ 会话一致性（评审 F2）。
 * `caller` 是调用方上下文（不是业务参数）：`{sessionId}` 由 kit 从消费者自己的
 * DSH 上下文取，与记录里的 `sessionId` 比对。缺 / 不等 → -32010。
 *
 * @param {GrantStore} store
 * @returns {(method: string, params: any, link: object|null,
 *            caller?: {sessionId?: string|null}) => void}
 * @throws {BridgeError} -32010
 */
export function dshWriteGate(store) {
  return (method, params, link, caller = {}) => {
    if (!isWriteMethod(method)) return
    const verdict = judgeGrant({
      store, grant: params?.grant, link, side: 'dsh', sessionId: caller?.sessionId ?? null,
    })
    if (!verdict.ok) throw editNotBoundError(method, verdict.reason, verdict.row)
    // 放行之后才比会话：先答"凭证/世代/连接对不对"，再答"是不是你"。
    // 记录到这一步必定是 active（上面第 7 行刚放行），查不到按 fail-closed 处理。
    const found = store.lookup(verdict.grant.id)
    const session = judgeSession({
      record: found?.kind === 'active' ? found.record : null,
      sessionId: caller?.sessionId ?? null,
      side: 'dsh',
    })
    if (!session.ok) throw editNotBoundError(method, session.reason, session.row)
  }
}

/**
 * 扩展侧**执行前**复核（契约 §6.1.1 ③）：真正动宿主状态之前判，失败拒绝执行并回错。
 *
 * `ctx` 是协议层的分派上下文（`{id, token, link}`，见 protocol.js 的 `handleMessage`）：
 * 承载连接对象身份从 `ctx.link` 取 —— 这是"这条请求到底从哪条连接进来的"唯一事实源，
 * **不许**退回"当前活跃连接"之类的替代品（§6.1.1 ③：不得退回当前活跃编辑器执行）。
 *
 * 判序（评审 F4 / F7）：
 *  ① **信任**：未信任工作区直接放行这道门 —— 让 dispatch 里的 `resolveWorkspaceFile`
 *     给出 -32006。以前这里先判"本端有没有活连接"，于是未信任工作区先报 -32010，
 *     用户看到的是"没授权"而不是"工作区没被信任"，指错了下一步该做什么；
 *  ② 七行判定（连接存活是第 3 行的事，**不许**在外层抢跑）；
 *  ③ 会话一致性：`ctx.link.authorized.sessionId` 由 `bridge.hello` 登记，与记录比对。
 *
 * @param {GrantStore} store
 * @param {{isTrusted?: (() => boolean) | null}} [opts]
 * @returns {(method: string, params: any, ctx: any) => void}
 * @throws {BridgeError} -32010
 */
export function extensionWriteGate(store, { isTrusted = null } = {}) {
  return (method, params, ctx) => {
    if (!isWriteMethod(method)) return
    // ① 信任优先：未信任时不在这里下结论，交给真正知道"哪个根、可不可信"的 handler。
    if (typeof isTrusted === 'function' && isTrusted() !== true) return

    const arrivedOn = ctx?.link ?? null
    // ② 七行判定。连接死了的记录已经被 forgetLink 收成墓碑（cause=disconnected），
    //    第 3 行会给出 target-gone —— 所以这里**不需要也不允许**再比一次"活跃连接"。
    const verdict = judgeGrant({ store, grant: params?.grant, link: arrivedOn, side: 'extension' })
    if (!verdict.ok) throw editNotBoundError(method, verdict.reason, verdict.row)

    // ③ 会话一致性**不在这一侧判**（评审 F2 的原话：不能只在扩展侧再加一份会话判断）。
    //    扩展没有独立的会话事实源：`link.authorized` 只是"token 被接受"的布尔，
    //    hello 里也没有 DSH 会话标识，能拿到的 `grant.sessionId` 只是把 DSH 发来的
    //    字段回读一遍 —— 那不是比对，是复述。会话权威在 DSH 侧（`dshWriteGate` 用
    //    消费者自己的上下文判），扩展侧继续守它真正能验的那部分：连接身份 + 世代。
  }
}

/**
 * 「这条 grant 是否允许保存脏缓冲区」—— 契约 §6.2.2 结论 / §6.2.8 待决 1 的落点。
 *
 * ★ **这个位为什么在 grant 上，不在 `params` 上**：`vscode.save` 的意图门要回答的是
 *   "**谁**授权了把人工改动一起写进磁盘"。`params` 是调用方自己填的字段 —— 让它在
 *   请求里带 `allowDirtySave: true`，等于让它自己给自己授权，这道门就等于没有。
 *   只有跟 `grant` 一起、由 `kit.editing.grant({allowDirtySave:true})` 发放、
 *   经 `bridge.grant` 回执确认的位，才代表**授权方**（持有 kit 实例的那一方）的表态。
 *
 * 判定口径（fail closed）：
 *  - 记录不存在 / 不是 active（墓碑、pending）→ `false`；
 *  - 记录上不是严格的布尔 `true` → `false`（`'true'`、`1` 都不算）。
 *
 * 它**不参与** `judgeGrant`：那是七行判定（凭证/世代/连接），这是能力层的意图门；
 * 混进七行表会让 `-32010` 的 reason 多出一个"意图"分支，而这两件事的处置不同
 * （授权缺失 → 重新申请；意图未授权 → 换 `save` 语义或人工确认）。所以它是一条
 * 独立的、只读的查询，放在本文件是为了让"grant 的形状"仍然只有一处定义。
 *
 * @param {GrantStore} store
 * @param {{id?: string}|null|undefined} grant 请求里那份 `{id, epoch}`
 * @returns {boolean}
 */
export function grantAllowsDirtySave(store, grant) {
  if (!store || !grant || typeof grant !== 'object') return false
  const found = store.lookup(grant.id)
  return found?.kind === 'active' && found.record.allowDirtySave === true
}
