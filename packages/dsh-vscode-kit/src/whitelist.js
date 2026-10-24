/**
 * per-plugin 能力白名单（契约 §6.2.5 / §6.2.8 第 3 条）。
 *
 * ## 这个文件判什么
 *
 * 一句话：**这次调用，这个消费者配不配。**
 *
 * 判据只有一条轴（契约 §6.2.5 的分档结论）：
 *
 *     read  <  buffer-edit  <  disk-write  <  delete
 *
 * 判定 = 消费者**声明的**最高档位 ≤ 配置里给该消费者的**最高档位**，
 * 且被调用的方法本身**落在哪一档**也不能超过两者中的小者：
 *
 *     effective = min(declared, allowed)          ← 消费者这一侧的天花板
 *     ok        = tier(method) <= effective       ← 这一次操作够不够格
 *
 * 为什么轴要按「动作类别」而不是按方法粒度：Codex 的 `GranularApprovalConfig` 也是
 * 按动作类别分层（§6.2.8 第 3 条的引证）——「能读」和「能删」不是同一根轴上的刻度，
 * 给一个插件开「能改缓冲区」时不该顺带把「能删文件」也开出去。四个档位就是四个
 * 授权台阶，配置里只写一个词。
 *
 * ## ★ 这一层是 advisory，不是沙箱（必须写在代码里，别让后来人误会）
 *
 * 身份由**消费者自己声明**（`kit.forPlugin('我的插件名', { declared: 'buffer-edit' })`）。
 * 一个诚实的插件报自己真实的身份，白名单就能挡住它的**误用**：调错方法、把
 * 「改缓冲区」写成「删文件」、模型幻觉生出一个它本来没有的能力调用。但一个**恶意**的
 * 插件可以谎报任意名字，也可以想办法拿到 `dsh-host` 那条 owner 通道 —— 这层**不防**它。
 *
 * 防恶意插件的正确位置不是这里，而是进程/权限边界（DSH 宿主信任的插件本来就能
 * 直接 `fs.rm`）。所以本模块的价值是：**减少误用 + 让"谁在什么时候被拒"有记录**，
 * 契约 §6.2.5 已写明白名单是必要条件而不是充分条件。
 *
 * ## 威胁模型（与契约 §6.2.5 的 T-A / T-B / T-C 对齐）
 *
 *  - **T-A 误调 / 幻觉**：挡得住。这是本层的主要战果 —— 一个只该读选中文本的插件
 *    从此调不动 `applyEdit`，更调不动 `deleteFile`。
 *  - **T-B 提示注入**：挡不住。注入进来的指令如果诱导的是一个**有 buffer-edit 或更高**
 *    档位的插件，白名单照放。§6.2.5 `[规定]`：T-B 只能靠人工确认 + 内容快照收口。
 *  - **T-C 归因**：帮得上。每次拒绝都进 `snapshot().consumerPolicy.denials`，
 *    带 `{consumer, declared, allowed, tier, reason}` —— 事后能说清"这次不是人干的"。
 *
 * @see docs/协作编辑-钩子契约.md §6.2.5（分档结论与威胁模型）、§6.2.8 第 3 条（粒度）
 */

import { BridgeError, ERR } from './protocol.js'

/**
 * 档位轴，从低到高（下标就是等级，比较只比下标）。
 *
 * 顺序即权限序：`read` 只能看，`buffer-edit` 能改编辑器里的缓冲区（**不落盘**），
 * `disk-write` 能把缓冲区写进磁盘，`delete` 能让磁盘上的文件消失。
 * 后两档已落地：`vscode.save`（T39 / Tier 3）与 `vscode.deleteFile`（T40 / Tier 4）都实现了，
 * 档位表当初先定好，落地时判定表确实没改一行 —— 这是"判据是表不是开关"的一次兑现。
 *
 * @type {readonly string[]}
 */
export const TIERS = Object.freeze(['read', 'buffer-edit', 'disk-write', 'delete'])

/** 最低档：只读。也是**未声明身份**与**未登记消费者**的天花板。 */
export const TIER_READ = 'read'

/** 最高档：`delete`。未知方法的兜底档也是它（见 `tierOf`）。 */
export const TIER_DELETE = 'delete'

/**
 * 方法 → 档位（**唯一一张表**）。
 *
 * 新增能力只加一行，白名单判定自动生效 —— 与 `grant.js` 的 `WRITE_METHODS` 同一种做法：
 * 判据是一张表而不是一个开关，开关会被忘，表会被 diff 看见。
 *
 * 只登记 `vscode.*` 业务能力。`bridge.*` 是协商通道（hello / ping / grant / revoke），
 * 不是编辑器能力 —— 它不在这张表里，也不受白名单约束（见 `index.js` 里 `isBridgeMethod`）。
 */
export const METHOD_TIERS = Object.freeze({
  // ── Tier 1：只读（已实现，契约 §6.2.1）──
  'vscode.openFile': TIER_READ,
  'vscode.getSelection': TIER_READ,
  'vscode.getDiagnostics': TIER_READ,
  'vscode.listOpenEditors': TIER_READ,
  // 绑定读（T34）：读的是"我获准写的那份文档"的锚点，本质仍是读。
  'vscode.getDocumentState': TIER_READ,
  // 多窗口视图（W1）：列的是**本端**握着的那几条连接，一个字节都不发给对端，
  // 所以它是最纯的读 —— 未声明的消费者（unbound）也按 read 档放行。
  'vscode.windows.list': TIER_READ,

  // 事件订阅（E3）：订的是**观察**，不是写；退订更只是撤掉一条观察。
  // 档位定在 `read` 是有意的：插件不需要任何写权限就能拿到"我关心的窗口里发生了什么"，
  // 而"能不能拿到正文"不由白名单决定（那是 `textMode` + `files` 白名单的独立门槛，
  // 见 `event-subscriptions.js` 的 `normalizeEventFilter`）。档位放宽不会放宽正文。
  'vscode.events.subscribe': TIER_READ,
  'vscode.events.unsubscribe': TIER_READ,

  // ── Tier 2：缓冲区编辑（已实现；**本层收口的正是这笔债**，契约 §6.2.5）──
  'vscode.applyEdit': 'buffer-edit',

  // ── Tier 3 / 4：落盘与删除（均已实现：T39 / T40）──
  'vscode.save': 'disk-write',
  'vscode.createFile': 'disk-write',
  'vscode.deleteFile': TIER_DELETE,

  // 基线重建（T65）：**不写盘**，但它清掉的是 `document-dirty`（`ERR.DOCUMENT_DIRTY`）那把锁 —— 谁能让一份被冻结的
  // 缓冲区重新可写，谁就间接握住了写权限。所以档位定在**删除档**（授权控制面动作），
  // 不是 `disk-write`：这是"能不能改动这套授权状态"的问题，不是"能不能落一次盘"。
  'vscode.rebaseBaseline': TIER_DELETE,
})

/**
 * 某个方法落在哪一档。
 *
 * ★ **未知方法按最高档**（fail-closed）。理由：一个我们没登记的方法，它的爆炸半径
 *   也就没被评估过 —— 这种时候给低档消费者放行，等于"新方法一加，白名单就自动漏一格"。
 *   代价是未登记方法对低档消费者一律拒（它们本来也该拿到 `-32005 unsupported`，
 *   但那是**对端**的答复，本端不该先把未评估的帧发出去）。
 *
 * @param {string} method
 * @returns {string}
 */
export function tierOf(method) {
  if (typeof method !== 'string') return TIER_DELETE
  // ★ 只认**自有**登记项（T42 / 评审 I2）。`METHOD_TIERS[method]` 会顺着原型链取值：
  //   `toString` / `constructor` / `valueOf` 拿到函数，`__proto__` 拿到对象 —— 它们都不是
  //   档位字符串，于是 `tierRank` 回 `-1`，而 `-1 <= 0` 会让 read 消费者**通过**白名单。
  //   `Object.hasOwn` 把"查表"变成"只查这张表自己写下的键"，原型链上的名字一律落到兜底档。
  if (!Object.hasOwn(METHOD_TIERS, method)) return TIER_DELETE
  const tier = METHOD_TIERS[method]
  // 表里写坏的档位（typo / 非字符串）同样按最高档 —— fail-closed 不许有第二个出口。
  return isTier(tier) ? tier : TIER_DELETE
}

/**
 * 档位等级（比较用的下标）。非法档位返回 -1 —— 调用方必须当"最坏情况"处理，
 * 不许让 `-1` 顺带通过任何 `<=` 比较。
 * @param {string} tier
 * @returns {number}
 */
export function tierRank(tier) {
  return TIERS.indexOf(tier)
}

/**
 * 合法档位吗。
 * @param {unknown} tier
 * @returns {boolean}
 */
export function isTier(tier) {
  return typeof tier === 'string' && TIERS.includes(tier)
}

/**
 * 两档中较低的那个（非法档位按最低处理：配置写错时**收紧**，不放松）。
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
export function minTier(a, b) {
  const ra = tierRank(a)
  const rb = tierRank(b)
  if (ra < 0 || rb < 0) return TIER_READ
  return ra <= rb ? a : b
}

/**
 * 「未绑定身份」的消费者 —— 就是 `ctx.provide('dshVscodeKit', facade)` 出去那个共享 facade。
 *
 * 它的天花板**硬编码**为 `read`（契约要求：写入类必须来自已绑定身份的入口）。
 * 硬编码而不是查配置，是因为它压根没有名字 —— 配置里没法给它开档，
 * 这才是"写入必须显式声明身份"这句话的落点：想写，就必须先报名字。
 */
export const UNBOUND_CONSUMER = Object.freeze({
  name: null,
  declared: TIER_READ,
  source: 'unbound',
})

/**
 * 宿主自己（`VscodeKit` 实例 = `apply()` 返回的 `handle.kit`）。
 *
 * 为什么它拿到 `delete`：
 *  - 它**不是插件可达的对象**。`ctx.provide` 出去的是 facade，facade 不持有实例引用；
 *  - 持有实例的人本来就能调 `kit.editing.grant()` 直接发授权、能 `kit.server.close()`，
 *    白名单对他没有任何约束意义 —— 他就是 owner；
 *  - 真实调用方是 E2E 夹具与类直构单测（`new VscodeKit(...)`），它们扮演的是宿主角色。
 *
 * ★ 这一条**不是后门**，而是把"信任边界在哪里"写明白：白名单的边界是**插件**，
 *   不是持有服务实例的宿主。谁能改 `cordis.yml` 里的 `consumers`，谁就在边界外。
 */
export const HOST_CONSUMER = Object.freeze({
  name: 'dsh-host',
  declared: TIER_DELETE,
  source: 'host',
})

/**
 * 归一化配置里的 `consumers` 段（`{ 插件名: 档位 }`）。
 *
 * 非法条目的处置是**记下来 + 当没配**（= 该消费者落回默认 `read`，写类一律拒），
 * 不是抛错也不是忽略成静默：配置写错了要响（`invalid` 会进 snapshot 与加载期日志），
 * 但**不能**因此把插件加载整个炸掉 —— 那会让"配置里有个 typo"变成"整个桥不工作"。
 * 方向永远选收紧的那一边。
 *
 * @param {unknown} raw
 * @returns {{consumers: Map<string, string>, invalid: object[]}}
 */
export function normalizePolicy(raw) {
  const consumers = new Map()
  const invalid = []
  if (raw === undefined || raw === null) return { consumers, invalid }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    invalid.push({ name: null, value: raw, reason: 'consumers-not-an-object' })
    return { consumers, invalid }
  }
  for (const [rawName, value] of Object.entries(raw)) {
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    if (name === '') {
      invalid.push({ name: null, value, reason: 'empty-consumer-name' })
      continue
    }
    if (!isTier(value)) {
      invalid.push({
        name,
        value,
        reason: typeof value === 'string' ? 'unknown-tier' : 'tier-not-a-string',
      })
      continue
    }
    consumers.set(name, value)
  }
  return { consumers, invalid }
}

/**
 * 判定一次调用。
 *
 * @param {{policy: {consumers: Map<string,string>}, consumer: {name: string|null, declared: string, source: string}, method: string}} input
 * @returns {{ok: true, method: string, tier: string, declared: string, allowed: string, effective: string, consumer: string|null, reason: null}
 *   | {ok: false, method: string, tier: string, declared: string, allowed: string, effective: string, consumer: string|null, reason: string, source: string}}
 */
export function judgeCall({ policy, consumer, method }) {
  const source = consumer?.source ?? 'plugin'
  const name = typeof consumer?.name === 'string' && consumer.name !== '' ? consumer.name : null
  const declared = isTier(consumer?.declared) ? consumer.declared : TIER_READ
  const tier = tierOf(method)

  // ⓪ ★ 非法档位一律拒（T42 / 评审 I2）：`tierRank` 对非法档位回 `-1`，而
  //   `-1 <= 0` 会让任何"最低档消费者"顺着比较通过。所以**比较之前**先把非法档位
  //   拦住，并按最高档处置（连无条件放行的宿主 owner 通道也不例外 —— 表坏了就该响，
  //   而不是让一个 typo 变成一次静默的越档放行）。
  if (!isTier(tier)) {
    return {
      ok: false,
      method,
      tier: TIER_DELETE,
      declared,
      allowed: TIER_READ,
      effective: TIER_READ,
      consumer: name,
      source,
      reason: 'tier-unknown',
    }
  }

  // ① 未绑定身份：天花板是硬编码的 `read`，与配置无关（没有名字，配置无从开档）。
  if (source === 'unbound' || name === null) {
    const verdict = {
      method, tier, declared, allowed: TIER_READ, effective: TIER_READ, consumer: null, source: 'unbound',
    }
    if (tierRank(tier) <= tierRank(TIER_READ)) return { ok: true, ...verdict, reason: null }
    return { ok: false, ...verdict, reason: 'consumer-unbound' }
  }

  // ② 宿主 owner 通道：不参与配置（信任边界在插件侧，不在持有实例的人身上）。
  if (source === 'host') {
    return {
      ok: true,
      method,
      tier,
      declared: TIER_DELETE,
      allowed: TIER_DELETE,
      effective: TIER_DELETE,
      consumer: name,
      source: 'host',
      reason: null,
    }
  }

  // ③ 已绑定身份的插件：未登记的消费者默认 `read`（写类一律拒 —— 契约 §6.2.5 的默认值）。
  const configured = policy?.consumers instanceof Map ? policy.consumers.get(name) : undefined
  const allowed = isTier(configured) ? configured : TIER_READ
  const effective = minTier(declared, allowed)
  const base = { method, tier, declared, allowed, effective, consumer: name, source: 'plugin' }
  if (tierRank(tier) <= tierRank(effective)) return { ok: true, ...base, reason: null }

  // 拒绝理由要分清是"配置没给它"还是"它自己声明得比配置高"还是"它自己声明得太低"：
  // 三种情形的修法完全不同（改配置 / 改声明 / 改声明），混成一个 reason 排障会绕远路。
  const reason = configured === undefined
    ? 'consumer-not-configured'
    : tierRank(allowed) < tierRank(tier) ? 'declared-above-allowed' : 'declared-below-required'
  return { ok: false, ...base, reason }
}

/**
 * 拒绝错误（**码位复用 `-32602`，不自造新码**）。
 *
 * ## 为什么是 `-32602` 而不是 `-32001`
 *
 *  - `-32001` 在本协议里**已经有确定含义且被文档写死**：`docs/README.md:119`
 *    「`-32001 | unauthorized | token 缺失或错误`」，唯一抛出点是入站鉴权
 *    （`protocol.js:371/374`）。拿它表示"这个插件没进白名单"，会让调用方
 *    把"桥接 token 被拒（该重连/该重新授权）"和"你没这个能力（该找宿主改配置）"
 *    混成一个分支 —— 这正是 §6.2.7 说的"码位只在处置相同时复用"。
 *  - 本仓既有的**本地前置门家族**（`expected-version-missing` /
 *    `expected-incarnation-missing` / `anchor-source-mismatch`）统一是
 *    `-32602 + data.reason + data.stage:'local'`：一道门一个码，用 `reason` 区分。
 *    白名单属于同一家族 —— 同样在**发送前**判，同样"一个字节都没发出去"。
 *  - §6.2.7 自己也把非参数性的 `untitled-document` 放进 `-32602 + reason`，
 *    说明这一格在本协议里的实际语义是「本端拒绝发送 + 结构化原因」，不只是"参数拼错"。
 *
 * `data` 里的 `{consumer, declared, allowed}` 是**契约要求的三元组**（谁 / 它说它能到哪 /
 * 配置允许它到哪），另外补 `method` / `tier` / `effective` / `reason` / `stage` 供排障。
 *
 * @param {object} denial `judgeCall` 的拒绝结果
 * @returns {BridgeError}
 */
export function consumerDeniedError(denial) {
  const { consumer, declared, allowed, effective, tier, method, reason } = denial
  const who = consumer === null ? 'an unbound consumer' : `consumer "${consumer}"`
  const fix = consumer === null
    ? 'call kit.forPlugin(<your plugin name>, { declared }) to bind an identity — writes are only '
      + 'accepted from a bound entry point'
    : `add { consumers: { "${consumer}": "${tier}" } } to the dsh-vscode-kit plugin config `
      + '(or relax `declared` if this call was not intended)'
  return new BridgeError(
    ERR.INVALID_PARAMS,
    `${method} needs the "${tier}" capability but ${who} may only reach "${effective}" `
    + `(declared "${declared}", config allows "${allowed}"). Refusing to send: ${fix}.`,
    {
      method,
      reason,
      stage: 'local',
      // 契约要求的三元组，逐字给全。
      consumer,
      declared,
      allowed,
      // 排障补充（snapshot 里也有同一份记录）。
      tier,
      effective,
    },
  )
}

/**
 * 白名单本体：策略 + 绑定记录 + 拒绝记录。
 *
 * 只做三件事，且都只有一处实现：`bind()` 领身份、`judge()` 判定、`snapshot()` 出诊断。
 * 没有任何 I/O —— 配置从 cordis 传进来（`apply(ctx, { consumers })`），这里不读文件。
 */
export class Whitelist {
  /**
   * @param {unknown} rawConsumers 配置里的 `consumers` 段
   * @param {{onLog?: (level: string, msg: string, extra?: any) => void, denialLimit?: number}} [opts]
   */
  constructor(rawConsumers, { onLog, denialLimit = 16 } = {}) {
    const { consumers, invalid } = normalizePolicy(rawConsumers)
    /** @type {Map<string, string>} 插件名 → 允许的最高档位 */
    this.consumers = consumers
    /** @type {object[]} 配置里被拒的条目（写错了要响，但不炸加载） */
    this.invalid = invalid
    /** @type {number} 拒绝记录的环形缓冲上限 */
    this.denialLimit = Number.isInteger(denialLimit) && denialLimit > 0 ? denialLimit : 16
    /** @type {Map<string, {name: string, declared: string, at: number}>} 谁领过身份 */
    this.bindings = new Map()
    /** @type {object[]} 最近若干次拒绝（旧 → 新） */
    this.denials = []
    this.onLog = onLog

    for (const bad of invalid) {
      // ★ 配置写错必须响：静默按 read 处理会让"我明明配了 delete"变成永远查不出的谜。
      this.onLog?.('error', `consumer whitelist: ignoring invalid entry `
        + `${JSON.stringify(bad.name)} (${bad.reason}: ${JSON.stringify(bad.value)}); `
        + 'that consumer falls back to "read"', { consumer: bad.name, reason: bad.reason })
    }
  }

  /**
   * 领一个身份（`kit.forPlugin(name, { declared })`）。
   *
   * 名字必须是调用方**自己的** cordis 插件名 —— 这不是校验出来的，是约定（advisory）：
   * 本层无法证明"你是谁"，只能要求"你说，并且说的这句和你配置里那行对得上"。
   *
   * `declared` 缺失/非法时**降到 `read`**（最省事的那半边）：想写就必须显式写出来，
   * 拼错的档位不许被当成"大概是最高档"。
   *
   * @param {string} name
   * @param {{declared?: string}} [opts]
   * @returns {{name: string, declared: string, source: 'plugin'}}
   */
  bind(name, opts = {}) {
    if (typeof name !== 'string' || name.trim() === '') {
      // 开发期错误，要立刻响亮：一个匿名 forPlugin 等于把自己钉死在 read 上。
      throw new TypeError(
        'kit.forPlugin(name) requires a non-empty plugin name (use your own cordis plugin name)',
      )
    }
    const clean = name.trim()
    const rawDeclared = opts?.declared
    let declared = TIER_READ
    if (isTier(rawDeclared)) {
      declared = rawDeclared
    } else if (rawDeclared !== undefined) {
      this.onLog?.('warn', `forPlugin("${clean}"): unknown declared tier `
        + `${JSON.stringify(rawDeclared)}; falling back to "read"`, { consumer: clean })
    }
    this.bindings.set(clean, { name: clean, declared, at: Date.now() })
    return { name: clean, declared, source: 'plugin' }
  }

  /**
   * 判定一次调用；拒绝时抛 `-32602`（`stage:'local'`）**并**记一条可观测记录。
   *
   * 记录 + 日志都在抛出之前完成：真机上"能力不存在"这种误导性失败，
   * 唯一能救回来的就是这条 warn 与 snapshot 里的那一行。
   *
   * @param {{name: string|null, declared: string, source: string}} consumer
   * @param {string} method
   * @returns {{method: string, tier: string, effective: string, declared: string, allowed: string, consumer: string|null}}
   * @throws {BridgeError} `-32602` + `data.reason`
   */
  judge(consumer, method) {
    const verdict = judgeCall({ policy: this, consumer, method })
    if (verdict.ok) return verdict

    const record = {
      at: Date.now(),
      method: verdict.method,
      tier: verdict.tier,
      consumer: verdict.consumer,
      declared: verdict.declared,
      allowed: verdict.allowed,
      effective: verdict.effective,
      reason: verdict.reason,
    }
    this.denials.push(record)
    if (this.denials.length > this.denialLimit) this.denials.shift()
    this.onLog?.('warn', `capability denied: ${verdict.method} needs "${verdict.tier}" but `
      + `${verdict.consumer === null ? '<unbound consumer>' : verdict.consumer} may only reach `
      + `"${verdict.effective}" (declared "${verdict.declared}", allowed "${verdict.allowed}", `
      + `reason "${verdict.reason}")`, record)
    throw consumerDeniedError(verdict)
  }

  /** 加载期一句话摘要（配置对不对，看这一行）。 */
  summary() {
    if (this.consumers.size === 0 && this.invalid.length === 0) {
      return 'consumer whitelist: no consumers configured; unlisted plugins get "read" only '
        + '(buffer-edit and above are refused unless bound AND configured)'
    }
    const listed = [...this.consumers.entries()]
      .map(([n, t]) => `${n}=${t}`)
      .join(', ')
    const bad = this.invalid.length > 0 ? `; ${this.invalid.length} invalid entr${this.invalid.length === 1 ? 'y' : 'ies'} ignored` : ''
    return `consumer whitelist: ${listed}${bad}`
  }

  /**
   * 诊断视图（进 `snapshot().consumerPolicy`）。
   *
   * 这里要能回答真机上的三个问题：①这个消费者被判成哪一档；②它为什么被拒；
   * ③配置里哪几行没生效。所以 `bindings` / `denials` / `invalid` 三份都在。
   */
  snapshot() {
    return {
      tiers: [...TIERS],
      defaultTier: TIER_READ,
      unboundTier: TIER_READ,
      hostTier: TIER_DELETE,
      consumers: [...this.consumers.entries()].map(([name, allowed]) => ({ name, allowed })),
      invalid: this.invalid.map((b) => ({ ...b })),
      bindings: [...this.bindings.values()].map((b) => ({ ...b })),
      denials: this.denials.map((d) => ({ ...d })),
      methodTiers: { ...METHOD_TIERS },
    }
  }
}
