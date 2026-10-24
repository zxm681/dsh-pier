/**
 * E3 —— 事件订阅：**按消费者分区、可取消、有界队列**。
 *
 * E1 给了传输（一条 link 一条流、信封校验、gap/stale、背压），E2 给了生产者
 * （`editor-events.js` 的 delta/metadata）。本文件补的是**中间那一层**：
 *
 *   bridge 侧（服务端）   createEventBroker          —— 登记订阅、开流、回执、推策略给 E2
 *   DSH 侧（客户端）      createEventSubscriptions   —— 每消费者一个分区（过滤器 + 队列），交付给 listener
 *
 * 三条硬口径（规划 §5 决策 2 / 决策 5，照此实现，不再询问）：
 *
 *  ① **未显式订阅时一律关闭**。公共流不是"默认开着、没人听而已"：没有订阅就
 *     `allowsPublish() === false`，E2 一个字节都不会发。
 *  ② **`textMode` 默认 `metadata`**；带正文的 `delta` 必须显式选、**且必须给 `files`
 *     白名单**（`files-required-for-delta`），禁止"全窗全文"默认。
 *  ③ **慢消费者有界队列 + gap/stale + 显式重订阅**：队列满了丢最旧的、投一条 `gap`
 *     并记 `stale`；不做无限缓存、不做持久重放、不做恰好一次。
 *
 * 零依赖、零 `vscode` import：两侧共用同一份契约（`normalizeEventFilter` /
 * `eventCursorError` / `subscriptionReceiptError` / `eventPartitionKey`），
 * 于是"DSH 以为订上了、bridge 以为没订"这类漂移在结构上就不成立。
 *
 * ★ 身份的固定口径：分区键 = 消费者名；**未绑定消费者**（`apply()` 提供的 facade、
 *   `VscodeKit` 实例自身）固定落在 `EVENT_CONSUMER_UNBOUND` 分区。它不是"特权消费者"：
 *   过滤器、队列、正文门槛与插件完全同款 —— 「默认消费者」拿不到 delta，除非它自己
 *   显式要 `textMode:'delta'` 并给出 `files`。
 */

import {
  EVENT_MAX_BYTES,
  EVENT_QUEUE_MAX_BYTES,
  EVENT_QUEUE_MAX_COUNT,
  EVENT_SUBSCRIBE_METHOD,
  EVENT_TYPES,
  EVENT_UNSUBSCRIBE_METHOD,
  eventEnvelopeError,
} from './event-contract.js'
import { BridgeError, ERR } from './protocol.js'
// ★ T60：路径形态只有一份规则（见 paths.js 文件头）。过滤比较、正文门、出站 payload
// 全部过同一个 canon —— 缺陷①（`filter.files` 静默零命中）的根因就是"RPC 出口与事件
// 管线各写各的盘符大小写，然后拿字符串精确比较"。
import { canonicalPath, isUsableFilterPath } from './paths.js'

/** API 身份约定：基础 facade 固定为 `unbound`，与 forPlugin(name) 同样按名分区，无特权。 */
export const EVENT_CONSUMER_UNBOUND = 'unbound'

/** 单个订阅的 `files` 白名单上限（"文件列表有限"，规划决策 2）。 */
export const EVENT_SUBSCRIPTION_MAX_FILES = 256

/** 单条 link 上同时在册的消费者上限。 */
export const EVENT_SUBSCRIPTION_MAX_CONSUMERS = 64

/** 单个文件路径的字符上限（防超长串撑爆策略比较）。 */
export const EVENT_FILE_MAX_CHARS = 4096

/** 诊断环缓冲长度（只留"哪个类型 / 哪个字段"，不留正文）。 */
export const EVENT_DIAGNOSTIC_LIMIT = 32

/** 控制态类型：由传输层产出，消费者**不能**订阅它们（订阅表里只许业务类型）。 */
export const EVENT_CONTROL_TYPES = Object.freeze(['gap', 'streamClosed'])

/** 消费者可订阅的业务类型（9 条）。 */
export const EVENT_BUSINESS_TYPES = Object.freeze(
  EVENT_TYPES.filter((type) => !EVENT_CONTROL_TYPES.includes(type)),
)

const INTERNAL_ERROR = -32603

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 消费者 → 分区键。
 *
 * `forPlugin(name)` 的名字就是分区键；没有名字的消费者（`apply()` 的 facade、
 * `VscodeKit` 实例自身）落 `unbound`。**不许**用"是不是默认消费者"来决定过滤/队列，
 * 分区只看这一个字符串。
 *
 * @param {{name?: string|null}|null|undefined} consumer
 * @returns {string}
 */
export function eventPartitionKey(consumer) {
  const name = consumer?.name
  if (typeof name === 'string' && name.trim() !== '') return name.trim()
  return EVENT_CONSUMER_UNBOUND
}

function invalidParamsError(reason, field, message, method = EVENT_SUBSCRIBE_METHOD) {
  return new BridgeError(ERR.INVALID_PARAMS, message, { method, reason, field, stage: 'local' })
}

/**
 * 归一化订阅过滤器。
 *
 * 接受字段（**只有这些**，未知字段忽略而不是报错——前向兼容）：
 *
 * | 字段 | 类型 | 默认 | 说明 |
 * |---|---|---|---|
 * | `types` / `type` | `string[]`（业务类型子集）/ `string` | 除 visibleRangesChanged 外的业务类型 | types 优先；visibleRangesChanged 仅显式订阅 |
 * | `files` | 非空字符串数组（≤256） | `null` = 不限文件 | `textMode:'delta'` 时**必填** |
 * | `textMode` | `'metadata'|'delta'` | `'metadata'` | 带正文要显式选 |
 * | `windowId` | string / number | — | 与 `sessionId` 至少给一个 |
 * | `sessionId` | string | — | 同上；两者都给且冲突 → `-32014` |
 *
 * @param {any} raw
 * @returns {{ok: true, filter: object}|{ok: false, error: {code: number, reason: string, field: string, message: string}}}
 */
export function normalizeEventFilter(raw) {
  const value = isObject(raw) ? raw : {}
  const fail = (reason, field, message) => ({
    ok: false,
    error: { code: ERR.INVALID_PARAMS, reason, field, message },
  })

  // ① 类型
  let types = EVENT_BUSINESS_TYPES.filter((type) => type !== 'visibleRangesChanged')
  const rawTypes = value.types === undefined ? (value.type === undefined ? null : [value.type]) : value.types
  if (rawTypes !== null) {
    if (!Array.isArray(rawTypes)) {
      return fail('invalid-types', 'types', 'filter.types must be an array of event type names')
    }
    const seen = new Set()
    for (const one of rawTypes) {
      if (typeof one !== 'string' || !EVENT_BUSINESS_TYPES.includes(one)) {
        return fail('invalid-types', 'types',
          `filter.types may only contain business event types (${EVENT_BUSINESS_TYPES.join(', ')}); `
          + 'control types gap/streamClosed are produced by the transport, not subscribable')
      }
      seen.add(one)
    }
    if (seen.size === 0) return fail('invalid-types', 'types', 'filter.types must not be empty')
    types = [...seen]
  }

  // ② 文件白名单
  //
  // ★ T60：条目在这里就**规范成对外可见形态**（`canonicalPath`），而不是等到比较时再说。
  // 理由是可观测性：回执里的 `subscription.files` 就是"这条订阅实际拿去过滤的白名单"，
  // 让它与消费者写下的字节一致（只是盘符大小写被统一），排查时不用在两个字符串之间做心算。
  let files = null
  if (value.files !== undefined && value.files !== null) {
    if (!Array.isArray(value.files) || value.files.length === 0) {
      return fail('invalid-files', 'files', 'filter.files must be a non-empty array of file paths')
    }
    if (value.files.length > EVENT_SUBSCRIPTION_MAX_FILES) {
      return fail('too-many-files', 'files',
        `filter.files is limited to ${EVENT_SUBSCRIPTION_MAX_FILES} paths per subscription`)
    }
    const seen = new Set()
    for (const one of value.files) {
      if (typeof one !== 'string') {
        return fail('invalid-files', 'files', 'filter.files entries must be strings')
      }
      const text = one.trim()
      if (!isUsableFilterPath(text, EVENT_FILE_MAX_CHARS)) {
        return fail('invalid-files', 'files', 'filter.files entries must be non-empty, NUL-free paths')
      }
      seen.add(canonicalPath(text))
    }
    files = [...seen]
  }

  // ③ 正文模式
  const rawMode = value.textMode === undefined ? 'metadata' : value.textMode
  if (rawMode !== 'metadata' && rawMode !== 'delta') {
    return fail('invalid-text-mode', 'textMode', "filter.textMode must be 'metadata' or 'delta'")
  }
  // ④ delta 必须显式给白名单（禁止"全窗全文"默认）
  if (rawMode === 'delta' && files === null) {
    return fail('files-required-for-delta', 'files',
      "filter.textMode:'delta' requires an explicit files whitelist — "
      + 'the public stream never defaults to "every file in the window"')
  }

  // ⑤ 寻址：windowId 或 sessionId 至少一个
  let windowId = null
  if (typeof value.windowId === 'string' && value.windowId.trim() !== '') windowId = value.windowId.trim()
  else if (typeof value.windowId === 'number' && Number.isFinite(value.windowId)) windowId = String(value.windowId)
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.trim() !== ''
    ? value.sessionId.trim()
    : null
  if (windowId === null && sessionId === null) {
    return fail('target-required', 'windowId',
      'a subscription must name its window explicitly: pass windowId, sessionId, or both')
  }

  return { ok: true, filter: Object.freeze({
    types: types === null ? null : Object.freeze(types),
    files: files === null ? null : Object.freeze(files),
    textMode: rawMode, windowId, sessionId,
  }) }
}

/** 归一化后的过滤器 → 线上参数（只带出现的字段）。 */
export function filterToParams(filter = {}) {
  const params = { textMode: filter.textMode === 'delta' ? 'delta' : 'metadata' }
  if (Array.isArray(filter.types)) params.types = [...filter.types]
  if (Array.isArray(filter.files)) params.files = [...filter.files]
  if (typeof filter.windowId === 'string') params.windowId = filter.windowId
  if (typeof filter.sessionId === 'string') params.sessionId = filter.sessionId
  return params
}

/**
 * 快照 cursor 的结构校验。
 *
 * 订阅回执冻结当前流位置 `{subscriptionId, streamEpoch, startSeq}`；快照也可带同形 cursor。
 * 消费从 nextSeq（含）开始；cursor 缺了或者指向另一条流，"订阅成功但初态屏障不存在"
 * 就成了静默数据丢失 —— 所以它必须能单独被判。
 *
 * @param {any} cursor
 * @returns {string|null} 失败原因（只回原因名，不回显任何值）；合格返回 null
 */
export function eventCursorError(cursor) {
  if (!isObject(cursor)) return 'cursor'
  if (typeof cursor.subscriptionId !== 'string' || cursor.subscriptionId === '') return 'cursor-subscription-id'
  if (typeof cursor.streamEpoch !== 'string' || cursor.streamEpoch === '') return 'cursor-stream-epoch'
  if (!Number.isSafeInteger(cursor.nextSeq) || cursor.nextSeq < 1) return 'cursor-next-seq'
  return null
}

/**
 * 订阅回执的**统一结构校验**（两侧同一份）。
 *
 * 除了各字段自身，还判三件互相自洽的事：cursor 的订阅 id、流世代必须与回执同一份，
 * cursor 的起点必须就是 `startSeq`。任一条不成立 = 对端没有给出可用的初态屏障。
 *
 * @param {any} receipt
 * @returns {string|null}
 */
export function subscriptionReceiptError(receipt) {
  if (!isObject(receipt)) return 'receipt'
  if (receipt.ok !== true) return 'ok'
  if (typeof receipt.subscriptionId !== 'string' || receipt.subscriptionId === '') return 'subscription-id'
  if (typeof receipt.streamEpoch !== 'string' || receipt.streamEpoch === '') return 'stream-epoch'
  if (!Number.isSafeInteger(receipt.startSeq) || receipt.startSeq < 1) return 'start-seq'
  const cursorError = eventCursorError(receipt.cursor)
  if (cursorError) return cursorError
  if (receipt.cursor.subscriptionId !== receipt.subscriptionId) return 'cursor-mismatch'
  if (receipt.cursor.streamEpoch !== receipt.streamEpoch) return 'cursor-mismatch'
  if (receipt.cursor.nextSeq !== receipt.startSeq) return 'cursor-start'
  if (!isObject(receipt.subscription)) return 'subscription'
  if (typeof receipt.subscription.id !== 'string' || receipt.subscription.id === '') return 'subscription-id-field'
  return null
}

/** 退订回执的结构校验。 */
export function unsubscribeReceiptError(receipt) {
  if (!isObject(receipt)) return 'receipt'
  if (receipt.ok !== true) return 'ok'
  if (typeof receipt.unsubscribed !== 'boolean') return 'unsubscribed'
  return null
}

/**
 * 按消费者的 `textMode` 剥正文。
 *
 * `metadata` 消费者永远拿不到 `text` / `changes`，即使 bridge 侧因为**另一个** delta
 * 消费者把联合策略调到了 `delta` —— 隔离是逐消费者的，不是逐连接的。
 *
 * @param {any} payload
 * @returns {any}
 */
export function stripEventBodies(payload) {
  if (!isObject(payload)) return payload
  if (!('text' in payload) && !('changes' in payload)) return payload
  const copy = { ...payload }
  delete copy.text
  delete copy.changes
  copy.textOmitted = true
  return copy
}

function describeError(err) {
  if (isObject(err) && typeof err.code === 'number') {
    return {
      code: err.code,
      reason: typeof err.data?.reason === 'string' ? err.data.reason : null,
      stage: typeof err.data?.stage === 'string' ? err.data.stage : null,
      message: typeof err.message === 'string' ? err.message : '',
    }
  }
  return { code: INTERNAL_ERROR, reason: null, stage: null, message: String(err?.message ?? err ?? '') }
}

/**
 * bridge 侧（服务端）订阅登记处。
 *
 * 一个 broker 管**一条扩展进程里所有消费者**：登记 → 开流 → 回执 → 把联合策略推给
 * E2（`editor-events.js`）。它同时是"未订阅就不许广播"的唯一判据
 * （`allowsPublish()`，connector 的 `emit` 必须先过它）。
 *
 * @param {object} [opts]
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {string[]|(() => string[])} [opts.roots] 正文允许的根（工作区根，来自 `editorEventFilter`）
 * @param {(() => string[]) | null} [opts.openFiles]
 *   目标窗口里**此刻打开的文件**（规范形态，由宿主给：bridge 侧是 `host.listEditors()`）。
 *   只用于回执的诊断字段 `filterMatch`（T60 缺陷①）：一条 `files` 白名单可能因为拼写差异
 *   一个文件都不命中，而消费者拿到的仍是 `ok:true` —— 那是静默零命中。本钩子让"建立过滤那一刻
 *   到底命中几个"变成回执里的一个数字。**它不参与任何放行判定**，取不到就不报（`null`）。
 * @param {((sessionId: string) => any)|null} [opts.sessionLinkOf] 会话 → 绑定连接（冲突判定用）
 */
export function createEventBroker({
  log = () => {}, now = Date.now, roots = [], sessionLinkOf = null, openFiles = null,
} = {}) {
  const subs = new Map()
  const streams = new Map()
  const diagnostics = []
  let hooks = { configure: null, activate: null, release: null, sessionLinkOf: null }
  let counter = 0
  let closed = false

  function note(reason, extra = {}) {
    diagnostics.push({ reason, at: now(), ...extra })
    if (diagnostics.length > EVENT_DIAGNOSTIC_LIMIT) diagnostics.shift()
  }

  function policyFor() {
    const rootList = typeof roots === 'function' ? roots() : roots
    const base = Array.isArray(rootList) ? [...rootList] : []
    const list = [...subs.values()]
    if (list.length === 0) {
      return { roots: base, types: null, files: null, textMode: 'metadata' }
    }
    const types = new Set()
    const files = new Set()
    const bodyFiles = new Set()
    let allFiles = false
    let delta = false
    for (const record of list) {
      for (const one of record.filter.types ?? EVENT_BUSINESS_TYPES) types.add(one)
      if (record.filter.files === null) allFiles = true
      else for (const one of record.filter.files) files.add(one)
      if (record.filter.textMode === 'delta') {
        delta = true
        for (const one of record.filter.files ?? []) bodyFiles.add(one)
      }
    }
    return {
      roots: base,
      types: [...types],
      files: allFiles ? null : [...files],
      // 元数据的文件并集不能缩成 delta 文件集；正文另设严格白名单。
      bodyFiles: [...bodyFiles],
      textMode: delta ? 'delta' : 'metadata',
    }
  }

  function sync() {
    if (typeof hooks.configure !== 'function') return
    try {
      hooks.configure(policyFor())
    } catch (err) {
      log('warn', 'event policy configure failed', { message: err?.message })
      note('configure-failed')
    }
  }

  function attach(next = {}) {
    hooks = { ...hooks, ...next }
    if (typeof hooks.configure === 'function') sync()
  }

  function unsupported(method, reason) {
    return new BridgeError(ERR.UNSUPPORTED,
      'the event channel is not available on this connection — the peer did not '
      + 'advertise an event stream, so a subscription cannot be installed',
      { method, reason })
  }

  function windowConflict(method, target) {
    return new BridgeError(ERR.WINDOW_TARGET_FAILED,
      'target-unauthorized: this subscription asked for another window, but this '
      + 'extension instance only serves its own',
      { method, target, rawTarget: target, reason: 'target-unauthorized', side: 'bridge' })
  }

  /**
   * 建立过滤那一刻的**命中诊断**（T60 缺陷①的可观测化）。
   *
   * 语义（回执里的 `filterMatch`，只读、不参与任何放行判定）：
   *  - `openFiles`：目标窗口里**此刻**打开的文件数（按规范形态去重）；
   *  - `matched`：其中**能通过本订阅 `filter.files` 白名单**的文件数。`filterFiles === null`
   *    （没有文件白名单）时等于 `openFiles` —— 那时不存在"零命中"这回事；
   *  - `filterFiles`：白名单条目数；`null` = 不限文件；
   *  - `notOpen`：白名单里**当时没在这个窗口打开**的前几个条目（最多 3 个，按白名单顺序）。
   *
   * 为什么必须放在回执里而不是只写日志：缺陷①的形态是"`ok:true` + 一条事件都不来"。
   * 消费者唯一能据以判断"我这串字节写错了"的地方就是回执；把它做成字段，调用方
   * 一次 `assert.equal(receipt.filterMatch.matched, 1)` 就能在 CI 里守住协议兼容性。
   * 拿不到宿主文件列表（或宿主没接这个钩子）时整块为 `null`，**不猜**。
   *
   * @param {Readonly<{files: readonly string[]|null}>} filter 已归一化的过滤器
   * @returns {{openFiles: number, matched: number, filterFiles: number|null, notOpen: string[]|null}|null}
   */
  function filterMatchFor(filter) {
    if (typeof openFiles !== 'function') return null
    let list = []
    try {
      const raw = openFiles()
      if (Array.isArray(raw)) list = raw.filter((one) => typeof one === 'string' && one !== '')
    } catch (err) {
      log('warn', 'open file list unavailable for filter diagnostics', { message: err?.message })
      return null
    }
    const open = new Set(list.map((one) => canonicalPath(one)))
    const whitelist = Array.isArray(filter.files) ? filter.files : null
    let matched = 0
    for (const file of open) {
      if (whitelist === null || whitelist.includes(file)) matched += 1
    }
    return {
      openFiles: open.size,
      matched,
      filterFiles: whitelist === null ? null : whitelist.length,
      notOpen: whitelist === null ? null : whitelist.filter((one) => !open.has(one)).slice(0, 3),
    }
  }

  function subscribe(params, ctx) {
    const method = EVENT_SUBSCRIBE_METHOD
    if (closed) throw new BridgeError(ERR.DISCONNECTED, 'event broker is closed', { method })
    const normalized = normalizeEventFilter(params)
    if (!normalized.ok) {
      throw invalidParamsError(normalized.error.reason, normalized.error.field, normalized.error.message, method)
    }
    const filter = normalized.filter

    const link = ctx?.link ?? null

    // 窗口/会话归属（E3）：订阅只许观察**本条连接**服务的那个窗口。
    // 口径不能靠"对端自称"：`filter.sessionId` 是 DSH 侧的授权会话 id，只有本端的 grant
    // 表知道它绑在哪条连接上。有记录就要求是这一条（否则 -32014，不回退"活跃窗口"）；
    // 没有本端绑定记录同样 -32010 fail-closed；任意 sessionId 不是来源凭据。
    const resolveSessionLink = hooks.sessionLinkOf ?? sessionLinkOf
    if (filter.sessionId && typeof resolveSessionLink === 'function') {
      let bound = null
      try {
        bound = resolveSessionLink(filter.sessionId)
      } catch {
        bound = null
      }
      if (!bound) throw new BridgeError(ERR.EDIT_NOT_BOUND, 'session has no bound connection',
        { method, reason: 'no-grant' })
      if (bound !== link) throw windowConflict(method, filter.sessionId)
    }

    if (subs.size >= EVENT_SUBSCRIPTION_MAX_CONSUMERS) {
      throw invalidParamsError('too-many-subscriptions', 'consumer',
        `at most ${EVENT_SUBSCRIPTION_MAX_CONSUMERS} live subscriptions per connection`, method)
    }

    if (!link || typeof link.events?.openStream !== 'function') throw unsupported(method, 'no-event-channel')
    if (link.events.ready !== true) throw unsupported(method, 'event-channel-not-ready')

    let descriptor = streams.get(link) ?? null
    if (!descriptor) {
      descriptor = link.events.openStream(`events-${++counter}`)
      if (!descriptor) throw unsupported(method, 'event-channel-not-ready')
      streams.set(link, descriptor)
    }

    const id = `sub-${++counter}`
    // ★ T60：诊断要在**登记之前**算好（登记会 sync→推策略，那条链不该被诊断的 I/O 拖慢）。
    const filterMatch = filterMatchFor(filter)
    const record = {
      id, link, filter, filterMatch, consumer: eventPartitionKey({ name: params.consumer }), at: now(),
    }
    subs.set(id, record)

    if (typeof hooks.activate === 'function') {
      try {
        hooks.activate()
      } catch (err) {
        subs.delete(id)
        throw err
      }
    }
    sync()

    log('info', 'event subscription installed', {
      id,
      consumer: record.consumer,
      textMode: filter.textMode,
      types: filter.types ?? 'all',
      files: Array.isArray(filter.files) ? filter.files.length : 'all',
      filterMatch,
    })
    // 静默零命中的最后一层防线：即使调用方不看回执，诊断环里也留一条**可读的**记录。
    if (filterMatch && filterMatch.filterFiles !== null && filterMatch.matched === 0) {
      note('filter-no-open-file-match', {
        consumer: record.consumer,
        filterFiles: filterMatch.filterFiles,
        openFiles: filterMatch.openFiles,
      })
      log('warn', 'event subscription filter matches no open file in this window '
        + '(the whitelist is compared as-is; paths come from listOpenEditors)', {
        consumer: record.consumer,
        filterFiles: filterMatch.filterFiles,
        openFiles: filterMatch.openFiles,
        notOpen: filterMatch.notOpen,
      })
    }

    return {
      ok: true,
      subscriptionId: descriptor.subscriptionId,
      streamEpoch: descriptor.streamEpoch,
      startSeq: descriptor.startSeq,
      cursor: {
        subscriptionId: descriptor.subscriptionId,
        streamEpoch: descriptor.streamEpoch,
        nextSeq: descriptor.startSeq,
      },
      // 诊断字段：不是契约值，缺了也能用（老消费者忽略即可），但它能让"零命中"当场可见。
      filterMatch,
      subscription: {
        id,
        consumer: record.consumer,
        types: filter.types,
        files: filter.files,
        textMode: filter.textMode,
      },
    }
  }

  function unsubscribe(params, ctx) {
    const method = EVENT_UNSUBSCRIBE_METHOD
    const id = typeof params?.id === 'string'
      ? params.id
      : (typeof params?.subscription?.id === 'string' ? params.subscription.id : null)
    if (!id) {
      throw invalidParamsError('subscription-id-required', 'id',
        'vscode.events.unsubscribe needs the subscription id handed out by subscribe', method)
    }
    const link = ctx?.link ?? null
    const record = subs.get(id)
    if (!record) {
      note('unsubscribe-unknown')
      return { ok: true, unsubscribed: false, subscriptionId: null, streamClosed: false }
    }
    if (link && record.link !== link) {
      throw invalidParamsError('subscription-owner-mismatch', 'id',
        'this subscription belongs to another connection', method)
    }
    const descriptor = streams.get(record.link) ?? null
    subs.delete(record.id)
    let streamClosed = false
    if (![...subs.values()].some((one) => one.link === record.link)) {
      streams.delete(record.link)
      try {
        record.link.events.dispose()
        streamClosed = true
      } catch (err) {
        log('warn', 'closing the event stream failed', { message: err?.message })
      }
      if (typeof hooks.release === 'function') {
        try {
          hooks.release()
        } catch (err) {
          log('warn', 'releasing editor events failed', { message: err?.message })
        }
      }
    }
    sync()
    log('info', 'event subscription removed', { id: record.id, consumer: record.consumer, streamClosed })
    return {
      ok: true,
      unsubscribed: true,
      subscriptionId: descriptor?.subscriptionId ?? null,
      streamClosed,
    }
  }

  /** 某条连接的订阅全部作废（连接没了，流也没了）——**不**再对端 dispose。 */
  function dropLink(link) {
    let removed = 0
    for (const [id, record] of [...subs]) {
      if (record.link === link) {
        subs.delete(id)
        removed += 1
      }
    }
    streams.delete(link)
    if (removed > 0) {
      if (subs.size === 0 && typeof hooks.release === 'function') {
        try {
          hooks.release()
        } catch {
          /* 连接都没了，释放失败没有第二件事可做 */
        }
      }
      sync()
      note('link-dropped', { removed })
    }
    return removed
  }

  function dispose() {
    for (const record of subs.values()) {
      try {
        record.link?.events?.dispose?.()
      } catch {
        /* ignore */
      }
    }
    subs.clear()
    streams.clear()
    closed = true
    if (typeof hooks.release === 'function') {
      try {
        hooks.release()
      } catch {
        /* ignore */
      }
    }
  }

  return {
    subscribe,
    unsubscribe,
    dropLink,
    dispose,
    attach,
    policyFor,
    canRelease(params, ctx) {
      const id = params?.id ?? params?.subscription?.id
      const record = typeof id === 'string' ? subs.get(id) : null
      return !!record && !!ctx?.link && record.link === ctx.link
    },
    cursorFor(link) {
      const descriptor = streams.get(link)
      return descriptor ? { subscriptionId: descriptor.subscriptionId,
        streamEpoch: descriptor.streamEpoch, nextSeq: descriptor.startSeq } : null
    },
    // connector 仅在 publish 成功后推进；后订阅者的 cursor 是当前流位置。
    published(link) {
      const descriptor = streams.get(link)
      if (descriptor) descriptor.startSeq += 1
    },
    allowsPublish: () => !closed && subs.size > 0,
    get count() {
      return subs.size
    },
    snapshot: () => ({
      closed,
      count: subs.size,
      allowsPublish: !closed && subs.size > 0,
      policy: policyFor(),
      subscriptions: [...subs.values()].map((record) => ({
        id: record.id,
        consumer: record.consumer,
        types: record.filter.types,
        files: record.filter.files,
        textMode: record.filter.textMode,
        // 建立时的命中诊断（T60）随快照一起露出，排查"这条订阅到底看没看见任何文件"。
        filterMatch: record.filterMatch ?? null,
      })),
      diagnostics: [...diagnostics],
    }),
  }
}

/** `kit is not ready yet` 的结构化失败句柄（**不抛**裸 TypeError，铁律 2）。 */
export function notReadyEventHandle(consumer, {
  method = EVENT_SUBSCRIBE_METHOD, message = 'dsh-vscode-kit is not listening yet',
} = {}) {
  return {
    ok: false,
    subscriptionId: null,
    consumer: eventPartitionKey(consumer),
    filter: null,
    cursor: null,
    filterMatch: null,
    error: { code: ERR.DISCONNECTED, reason: 'server-not-ready', stage: 'local', message },
    ready: Promise.resolve(),
    dispose: () => {},
  }
}

/**
 * DSH 侧（客户端）订阅宿主：每消费者一个分区。
 *
 * 分区 = 过滤器 + 有界队列 + 顺序交付。四件事必须逐消费者成立（每一条都是变异靶子）：
 *
 *  - **过滤**：`types` / `files` / `textMode` / 窗口（订阅时解析成**具体 link**，
 *    之后只有该 link 上的事件能进这个分区）。
 *  - **隔离**：listener 抛错、Promise 拒绝、慢到爆队列，都只影响自己那一个分区。
 *  - **有界**：队列超 `EVENT_QUEUE_MAX_COUNT` / `EVENT_QUEUE_MAX_BYTES` 就丢最旧的、
 *    投一条 `gap{reason:'queue-overflow'}`，并把分区标 `stale`（不无限缓存）。
 *  - **零残留**：`dispose()` 之后本分区零回调，并且向上游发一次 `unsubscribe`。
 *
 * @param {object} opts
 * @param {(method: string, params: object, transport: object, consumer: object) => Promise<any>} opts.request
 * @param {(ctx: {consumer: object, filter: object, opts: object}) => Promise<{link: object|null, transport: object}>} [opts.resolve]
 * @param {(link: object|null) => {windowId?: string|null, sessionId?: string|null}} [opts.attribute]
 * @param {(link: object|null, descriptor: object) => boolean} [opts.accept]
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxCount]
 * @param {number} [opts.maxBytes]
 */
export function createEventSubscriptions({
  request,
  resolve = null,
  attribute = null,
  accept = null,
  log = () => {},
  now = Date.now,
  maxCount = EVENT_QUEUE_MAX_COUNT,
  maxBytes = EVENT_QUEUE_MAX_BYTES,
} = {}) {
  if (typeof request !== 'function') {
    throw new TypeError('createEventSubscriptions requires a request() function')
  }

  const subs = new Map()
  const streams = new Map()
  const facades = new Map()
  const diagnostics = []
  let counter = 0
  let disposed = false

  function note(reason, extra = {}) {
    diagnostics.push({ reason, at: now(), ...extra })
    if (diagnostics.length > EVENT_DIAGNOSTIC_LIMIT) diagnostics.shift()
  }

  function eventsFor(consumer) {
    const partition = eventPartitionKey(consumer)
    let facade = facades.get(partition)
    if (!facade) {
      facade = {
        consumer: partition,
        subscribe: (filter, listener, opts) => subscribe(consumer, filter, listener, opts),
        unsubscribe: (id) => unsubscribe(consumer, id),
        snapshot: () => snapshot(partition),
      }
      facades.set(partition, facade)
    }
    return facade
  }

  function subscribe(consumer, filterInput, listener, opts = {}) {
    const partition = eventPartitionKey(consumer)
    const handle = {
      ok: false,
      subscriptionId: null,
      consumer: partition,
      filter: null,
      cursor: null,
      // 字段**始终存在**（铁律 2：facade 形状稳定）——未就绪/被拒时是 `null`。
      filterMatch: null,
      error: null,
      ready: null,
      dispose: () => {},
    }
    if (disposed) {
      Object.assign(handle, {
        error: { code: ERR.DISCONNECTED, reason: 'disposed', stage: 'local', message: 'event subscriptions are disposed' },
        ready: Promise.resolve(),
      })
      return handle
    }
    const normalized = normalizeEventFilter({
      ...(isObject(filterInput) ? filterInput : {}),
      windowId: filterInput?.windowId ?? opts?.target,
      sessionId: filterInput?.sessionId ?? opts?.sessionId,
    })
    if (!normalized.ok) {
      handle.error = { ...normalized.error }
      handle.ready = Promise.resolve()
      return handle
    }
    if (typeof listener !== 'function') {
      handle.error = {
        code: ERR.INVALID_PARAMS,
        reason: 'listener-required',
        field: 'listener',
        stage: 'local',
        message: 'vscode.events.subscribe(filter, listener) requires a listener function',
      }
      handle.ready = Promise.resolve()
      return handle
    }

    const id = `sub-${++counter}`
    const sub = {
      id,
      consumer,
      partition,
      filter: normalized.filter,
      listener,
      closed: false,
      queue: [],
      bytes: 0,
      delivering: false,
      inFlightBytes: 0,
      inFlight: false,
      seenSeq: 0,
      link: null,
      descriptor: null,
      cursor: null,
      transport: {},
      lastSeq: 0,
      stale: null,
      dropped: 0,
      listenerErrors: 0,
      notes: [],
    }
    subs.set(id, sub)

    handle.ok = true
    handle.subscriptionId = id
    handle.filter = normalized.filter
    handle.dispose = () => unsubscribe(consumer, id)

    const settle = async () => {
      try {
        await install(sub, handle, opts)
      } catch (err) {
        closeSub(sub)
        subs.delete(id)
        await releaseSub(sub)
        handle.ok = false
        handle.error = describeError(err)
        note('subscribe-failed', {
          consumer: partition,
          code: handle.error.code,
          reason: handle.error.reason,
        })
        throw err
      }
    }
    handle.ready = settle()
    sub.installing = handle.ready
    // 拿住拒绝，避免调用方不 await 时变成 unhandled rejection（`ready` 本身仍可 await/拒）。
    handle.ready.catch(() => {})
    return handle
  }

  async function install(sub, handle, opts) {
    let target = { link: null, transport: {} }
    if (typeof resolve === 'function') {
      target = (await resolve({ consumer: sub.consumer, filter: sub.filter, opts })) ?? target
    }
    if (sub.closed) return

    const box = { link: target.link ?? null }
    const transport = { ...(target.transport ?? {}) }
    // 已解析的目标不可被 opts 二次覆盖（过滤窗口必须就是请求窗口）。
    if (Number.isFinite(opts?.timeoutMs)) transport.timeoutMs = opts.timeoutMs
    transport.waitForEditor = false
    // 观察钩子：记住**这条请求实际走的那条连接**。它不参与选路（选路仍在 request() 里），
    // 只是让"订阅绑哪条连接"与"事件从哪条连接来"用的是同一个事实。
    transport.onLink = (link) => {
      if (link) box.link = link
    }
    sub.transport = { target: transport.target, sessionId: transport.sessionId }

    const params = { ...filterToParams(sub.filter), consumer: sub.partition, id: sub.id }
    const receipt = await request(EVENT_SUBSCRIBE_METHOD, params, transport, sub.consumer)

    const bad = subscriptionReceiptError(receipt)
    if (bad) {
      throw new BridgeError(ERR.INVALID_RESPONSE,
        `invalid response for "${EVENT_SUBSCRIBE_METHOD}": ${bad}`, {
          method: EVENT_SUBSCRIBE_METHOD,
          reason: bad,
          stage: 'local',
          got: { type: typeof receipt },
          expected: 'receipt with subscriptionId, streamEpoch, startSeq and a cursor pointing at the same stream',
        })
    }

    sub.link = box.link ?? target.link ?? null
    sub.remoteId = receipt.subscription.id
    sub.cursor = receipt.cursor
    sub.descriptor = {
      subscriptionId: receipt.subscriptionId,
      streamEpoch: receipt.streamEpoch,
      startSeq: receipt.startSeq,
    }
    sub.lastSeq = receipt.startSeq - 1
    handle.cursor = receipt.cursor
    // T60：对端的命中诊断原样收下（老扩展不给 ⇒ null）。消费者据 `handle.filterMatch`
    // 就能在"订阅成功但零事件"时立刻分辨"是过滤写错了"还是"真的没变化"。
    sub.filterMatch = isObject(receipt.filterMatch) ? { ...receipt.filterMatch } : null
    handle.filterMatch = sub.filterMatch
    if (sub.filterMatch && sub.filterMatch.filterFiles !== null && sub.filterMatch.matched === 0) {
      note('filter-no-open-file-match', {
        consumer: sub.partition,
        filterFiles: sub.filterMatch.filterFiles,
        openFiles: sub.filterMatch.openFiles,
      })
    }

    const previous = sub.link ? streams.get(sub.link) : null
    if (!previous || previous.streamEpoch !== receipt.streamEpoch) {
      const taken = typeof accept === 'function'
        ? accept(sub.link, sub.descriptor)
        : false
      if (taken !== true) {
        throw new BridgeError(ERR.INVALID_RESPONSE,
          'the transport refused to install the event stream offered by the peer', {
            method: EVENT_SUBSCRIBE_METHOD,
            reason: 'stream-rejected',
            stage: 'local',
          })
      }
      if (sub.link) streams.set(sub.link, sub.descriptor)
    }
    if (sub.closed) {
      // 订阅在途时就被取消了：立刻向对端退订，别留上游残留。
      await releaseSub(sub).catch(() => {})
    }
  }

  function closeSub(sub) {
    sub.closed = true
    sub.queue.length = 0
    sub.bytes = 0
  }

  async function releaseSub(sub) {
    const descriptor = sub.descriptor
    sub.descriptor = null
    if (sub.link) {
      const stillUsed = [...subs.values()].some((one) => one.link === sub.link && one.descriptor !== null)
      if (!stillUsed) {
        streams.delete(sub.link)
        sub.link.events?.dispose?.()
      }
    }
    if (!descriptor) {
      return { ok: true, unsubscribed: true, subscriptionId: null, streamClosed: false }
    }
    let reply
    try {
      reply = await request(EVENT_UNSUBSCRIBE_METHOD,
        { id: sub.remoteId, subscriptionId: descriptor.subscriptionId },
        { ...sub.transport, waitForEditor: false },
        sub.consumer)
    } catch (err) {
      note('unsubscribe-failed', { consumer: sub.partition, reason: describeError(err).reason })
      return {
        ok: false, unsubscribed: true, subscriptionId: descriptor.subscriptionId, streamClosed: false, error: describeError(err),
      }
    }
    const bad = unsubscribeReceiptError(reply)
    if (bad) {
      note('unsubscribe-invalid-receipt', { consumer: sub.partition, reason: bad })
      return { ok: false, unsubscribed: true, subscriptionId: descriptor.subscriptionId, streamClosed: false }
    }
    return {
      ok: true,
      unsubscribed: reply.unsubscribed,
      subscriptionId: descriptor.subscriptionId,
      streamClosed: reply.streamClosed === true,
    }
  }

  function unsubscribe(consumer, id) {
    const partition = eventPartitionKey(consumer)
    const sub = subs.get(id)
    if (!sub || sub.partition !== partition) {
      // 别人的分区：既不认，也不泄漏它存在。
      return Promise.resolve({ ok: true, unsubscribed: false, subscriptionId: null, streamClosed: false })
    }
    const wasClosed = sub.closed
    closeSub(sub) // ★ 先关本地分区：之后的任何事件都进不来，零回调是同步生效的
    subs.delete(id)
    if (wasClosed) {
      return Promise.resolve({ ok: true, unsubscribed: true, subscriptionId: sub.cursor?.subscriptionId ?? null, streamClosed: false })
    }
    return (sub.installing ?? Promise.resolve()).catch(() => {}).then(() => releaseSub(sub))
  }

  function accepts(filter, envelope) {
    if (Array.isArray(filter.types) && !filter.types.includes(envelope.type)) return false
    // 与 E2 `selected()` 同口径：带 file 的事件才比白名单；不带 file 的控制/窗口态事件放行。
    //
    // ★ T60：两侧都比**规范形态**（`canonicalPath`）。`filter.files` 在归一化时已规范过，
    // 这里再规范一次入站值 —— 对端可能是还没升级的老扩展（它发小写盘符），也可能是
    // 未来某个忘了规范的宿主。这一行不改变任何"本来就能对上"的比较结果，只把"盘符大小写
    // 不同就静默丢事件"这条路堵死。
    if (Array.isArray(filter.files)) {
      const file = envelope.payload?.file
      if (typeof file === 'string' && !filter.files.includes(canonicalPath(file))) return false
    }
    return true
  }

  /**
   * 出站 payload 的路径形态统一（T60）：`file` 与 `tabsChanged` 的 `opened[]/closed[]` 里的
   * `files`。事件是**对外可见面**的一部分，与 RPC 返回值必须同一种写法 —— 否则消费者
   * 用 `listOpenEditors` 的返回值去比事件里的 `file`（或反过来）就会失配。
   *
   * 只在真的需要改的时候新建对象（多数事件本就已是规范形态，避免无谓分配）。
   */
  function canonicalPayload(payload) {
    if (!isObject(payload)) return payload
    let out = payload
    if (typeof payload.file === 'string') {
      const file = canonicalPath(payload.file)
      if (file !== payload.file) out = { ...out, file }
    }
    for (const key of ['opened', 'closed']) {
      const rows = payload[key]
      if (!Array.isArray(rows)) continue
      let touched = false
      const mapped = rows.map((row) => {
        if (!isObject(row) || !Array.isArray(row.files)) return row
        const files = row.files.map((one) => canonicalPath(one))
        if (files.every((one, i) => one === row.files[i])) return row
        touched = true
        return { ...row, files }
      })
      if (touched) out = { ...out, [key]: mapped }
    }
    return out
  }

  function shapeEvent(sub, envelope, link) {
    const source = (typeof attribute === 'function' ? attribute(link) : null) ?? {}
    // ★ 来源只认链路事实（attribute(link)），**绝不**读 payload 自报的 windowId/sessionId。
    // delta 的文件白名单也是正文门；缺失 file 的帧不能借窗口态绕过它。
    // ★ T60：正文门与过滤门用同一个规范形态比较（见 accepts 上面的说明）。
    const bodyAllowed = sub.filter.textMode === 'delta'
      && typeof envelope.payload.file === 'string'
      && sub.filter.files?.includes(canonicalPath(envelope.payload.file))
    const payload = bodyAllowed ? canonicalPayload(envelope.payload) : stripEventBodies(canonicalPayload(envelope.payload))
    return {
      type: envelope.type,
      subscriptionId: envelope.subscriptionId ?? sub.descriptor?.subscriptionId ?? null,
      streamEpoch: envelope.streamEpoch ?? sub.descriptor?.streamEpoch ?? null,
      seq: Number.isSafeInteger(envelope.seq) ? envelope.seq : null,
      observedAt: Number.isFinite(envelope.observedAt) ? envelope.observedAt : now(),
      source: {
        windowId: typeof source.windowId === 'string' ? source.windowId : null,
        sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
      },
      payload,
    }
  }

  function controlEvent(sub, reason, link) {
    const source = (typeof attribute === 'function' ? attribute(link) : null) ?? {}
    return {
      type: 'gap',
      subscriptionId: sub.descriptor?.subscriptionId ?? null,
      streamEpoch: sub.descriptor?.streamEpoch ?? null,
      seq: null,
      observedAt: now(),
      source: {
        windowId: typeof source.windowId === 'string' ? source.windowId : null,
        sessionId: typeof source.sessionId === 'string' ? source.sessionId : null,
      },
      payload: { reason },
    }
  }

  function enqueue(sub, event) {
    if (sub.closed) return
    // 溢出后只保留一次 gap；必须重订阅才能恢复，不再积累正文。
    if (sub.stale?.reason === 'queue-overflow') { sub.dropped += 1; return }
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(event))
    } catch {
      bytes = EVENT_MAX_BYTES
    }
    // 容量包括 listener 正在处理的事件，而不只是等待队列。
    if (sub.queue.length + (sub.inFlight ? 1 : 0) + 1 > maxCount
      || sub.bytes + sub.inFlightBytes + bytes > maxBytes) {
      overflow(sub, 'queue-overflow')
      return
    }
    sub.queue.push({ event, bytes })
    sub.bytes += bytes
    pump(sub)
  }

  function overflow(sub, reason) {
    sub.queue.length = 0
    sub.bytes = 0
    sub.dropped += 1
    sub.stale = { reason, at: now() }
    note('queue-overflow', { consumer: sub.partition })
    sub.queue.push({ event: controlEvent(sub, reason, sub.link), bytes: 0 })
    pump(sub)
  }

  function markStale(sub, reason) {
    sub.stale = { reason, at: now() }
    note('stream-state', { consumer: sub.partition, reason })
    sub.queue.length = 0
    sub.bytes = 0
    sub.queue.push({ event: controlEvent(sub, reason, sub.link), bytes: 0 })
    pump(sub)
  }

  function pump(sub) {
    if (sub.delivering || sub.closed) return
    sub.delivering = true
    Promise.resolve().then(async () => {
      try {
        while (!sub.closed && sub.queue.length > 0) {
          const item = sub.queue.shift()
          sub.bytes -= item.bytes
          if (sub.bytes < 0) sub.bytes = 0
          sub.inFlight = true
          sub.inFlightBytes = item.bytes
          try {
            await sub.listener(item.event)
          } catch (err) {
            // ★ 单个 listener 的失败只记在自己分区上，不进别人的队列、不中断本分区的后续交付。
            sub.listenerErrors += 1
            sub.notes.push({ reason: 'listener-failed', type: item.event?.type ?? null, at: now() })
            if (sub.notes.length > EVENT_DIAGNOSTIC_LIMIT) sub.notes.shift()
            note('listener-failed', { consumer: sub.partition, type: item.event?.type ?? null })
          } finally {
            sub.inFlight = false
            sub.inFlightBytes = 0
          }
        }
      } finally {
        sub.delivering = false
        if (!sub.closed && sub.queue.length > 0) pump(sub)
      }
    })
  }

  /**
   * 一条入站事件 → 分发给**每一条匹配的本地分区**。
   *
   * @param {any} envelope
   * @param {object|null} link 传输层给的**真实**连接（`ctx.link`）
   * @returns {number} 实际入队的分区数
   */
  function onEvent(envelope, link) {
    if (disposed) return 0
    if (!isObject(envelope)) {
      note('invalid-event', { field: 'envelope' })
      return 0
    }
    const envelopeError = eventEnvelopeError(envelope)
    if (envelopeError) {
      // ★ 零正文投递：诊断只带类型与字段名（reason 本身就是字段名），不带任何 payload 片段。
      note('invalid-event', {
        field: envelopeError,
        type: EVENT_TYPES.includes(envelope.type) ? envelope.type : null,
      })
      return 0
    }
    let delivered = 0
    for (const sub of subs.values()) {
      if (sub.closed) continue
      if (!sub.link || sub.link !== link) continue
      if (sub.descriptor) {
        if (sub.descriptor.subscriptionId !== envelope.subscriptionId) continue
        if (sub.descriptor.streamEpoch !== envelope.streamEpoch) continue
      }
      if (EVENT_CONTROL_TYPES.includes(envelope.type)) {
        markStale(sub, typeof envelope.payload?.reason === 'string' ? envelope.payload.reason : 'stream-error')
        delivered += 1
        continue
      }
      // 传输序号在过滤前连续推进；别把其他类型/文件的过滤误报成丢帧。
      const previousSeq = sub.seenSeq || sub.descriptor.startSeq - 1
      const gap = envelope.seq !== previousSeq + 1
      if (envelope.seq <= previousSeq) continue
      sub.seenSeq = envelope.seq
      if (!accepts(sub.filter, envelope)) continue
      if (gap && sub.stale?.reason !== 'queue-overflow') markStale(sub, 'seq-gap')
      sub.lastSeq = envelope.seq
      enqueue(sub, shapeEvent(sub, envelope, link))
      delivered += 1
    }
    return delivered
  }

  /** 传输层的 stale/gap 通知（E1 `onEventState`）→ 只波及该连接上的分区。 */
  function onEventState(state) {
    if (disposed || !isObject(state)) return 0
    const reason = typeof state.reason === 'string' ? state.reason : 'stream-error'
    let marked = 0
    for (const sub of subs.values()) {
      if (sub.closed) continue
      if (state.link && sub.link && sub.link !== state.link) continue
      if (state.subscriptionId && sub.descriptor
        && sub.descriptor.subscriptionId !== state.subscriptionId) continue
      if (state.streamEpoch && sub.descriptor && sub.descriptor.streamEpoch !== state.streamEpoch) continue
      markStale(sub, reason)
      marked += 1
    }
    return marked
  }

  function snapshot(partition = null) {
    const list = [...subs.values()].filter((sub) => partition === null || sub.partition === partition)
    return {
      consumer: partition,
      count: list.length,
      subscriptions: list.map((sub) => ({
        id: sub.id,
        consumer: sub.partition,
        types: sub.filter.types,
        files: sub.filter.files,
        textMode: sub.filter.textMode,
        windowId: sub.filter.windowId,
        sessionId: sub.filter.sessionId,
        queued: sub.queue.length,
        bytes: sub.bytes,
        lastSeq: sub.lastSeq,
        dropped: sub.dropped,
        listenerErrors: sub.listenerErrors,
        stale: sub.stale,
        boundToLink: sub.link !== null,
      })),
      diagnostics: [...diagnostics],
    }
  }

  function dispose() {
    for (const sub of subs.values()) {
      closeSub(sub)
      releaseSub(sub).catch(() => {})
    }
    subs.clear()
    streams.clear()
    facades.clear()
    disposed = true
  }

  return {
    eventsFor,
    onEvent,
    onEventState,
    snapshot,
    dispose,
    get count() {
      return subs.size
    },
  }
}
