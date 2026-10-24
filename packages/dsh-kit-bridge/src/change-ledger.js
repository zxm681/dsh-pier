/**
 * 文档变更关联账本（A1）：把「这次桥接写入引起的增量」与「别人引起的增量」分开，
 * 并且**保留未知态**。
 *
 * ## 这份模块存在的理由（先读，再改）
 *
 * `vscode.applyEdit` 的回执原来只有 `applied`。`applied:true` 只说"宿主接受了这次
 * `TextEditor.edit`"，它**证明不了**"文档里现在的差异都是我造成的"，更证明不了
 * "没有别人插入的改动"。两种常见的错误推理，本模块的全部结构就是为了挡住它们：
 *
 *  ① **把 version 增长当成"我的"证据**。`TextDocument.version` 只说明"文档变过"，
 *     人工键入、格式化、别的扩展、另一个窗口的写入，都会让它 +1。它**不是作者**。
 *  ② **把"我发起过写入"当成"这些变化都是我造成的"**。写入窗口是异步的
 *     （`applyEditText` 内部要 await 编辑器、`TextEditor.edit` 的提交在主线程），
 *     窗口里的人为操作既可能与我交错、也可能被我之后的格式化盖住。
 *
 * 所以归属只有四种取值，且**越靠后越保守**：
 *
 *  - `bridge-correlated`：**四条证据同时成立**才报 ——
 *      ① 宿主真实接受（`applied === true`）；
 *      ② 事件链匹配（窗口内恰好一条变更事件，版本恰为 `before.version + 1`，
 *         化身相同，且 `contentChanges` 与本次 edits 逐条同范围同文本）；
 *      ③ after 快照与**预期结果逐字相等**（预期结果 = before 文本应用本次 edits）；
 *      ④ 没有插入的额外变化（窗口内没有第二条事件、没有版本跳号、账本没丢事件）。
 *  - `self-only`：**写入本身被证明**（after 与预期逐字相等），但"只有我这一笔"证明不了
 *      —— 典型是事件还没到（VS Code 的事件相对 Promise 可能晚到）。它绝不声称因果相关。
 *  - `mixed`：能证明"有别人/别的东西的增量"（额外事件、after 与预期不符但仍变了、
 *     另一个窗口的化身在同一窗口内改过同一个文件）。
 *  - `unknown`：其余一切，带 `reason`。**预先 dirty、没有干净基线、监听失步、账本淘汰/
 *     超限、关闭重开（同版本不同化身）、超时、抛异常、no-op —— 一律落到这里。**
 *
 * ## 调用方 params 里的 `operationId` / `source` **不能自证**
 *
 * `operationId` 由本账本自己签发，**不采信**入参；回执里的归属字段全部来自本账本
 * 记下的证据链。调用方往 params 里塞 `attribution:'bridge-correlated'` 不会有任何作用
 * （本模块从不读入参里的这些键）。
 *
 * ## 证据的时间窗（为什么 `construct` 必须同步）
 *
 * `before` 锚点（version / incarnation / hash / 文本）必须在**构造 edit 的同一个同步区间**
 * 里取 —— 那是"这份坐标所基于的那一版"唯一可靠的时刻。事务（`edit-transaction.js`）在
 * 版本/化身双锚点都判过、`builder.replace` 之前那一刻回调 `observe`，本模块的
 * `construct()` 就在那里读快照。`after` 锚点由能力层**写后实测**（重新
 * `readDocumentState(includeText:true)`），**绝不回显期望值**。
 *
 * ## 成本与有界
 *
 *  - 每条记录的 before 文本最多留 `maxTextChars`（默认 1 Mi 字符）；超了**不留**文本
 *    （`textTooLarge:true`，归属降级为 unknown），绝不静默截断 —— 半份文本算出来的
 *    "预期结果"是错的，而错的预期会把"我"和"别人"判反。
 *  - 事件流按文件保留最近 `maxEventsPerFile` 条；记录上限 `maxRecords`，超限时**淘汰
 *    最老的已结算记录**，若全是未结算的就把新记录标成 `ledger-overflow`（不是悄悄丢）。
 *    任何"我丢过证据"的路径都必须让归属降级，不许当成"没有别人"。
 *
 * 零依赖（只 import 兄弟库的路径工具与 node 内置 crypto）。
 */

import { createHash, randomBytes } from 'node:crypto'

import { canonicalPath, pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'

/** 归属取值（对外字符串，进回执，逐字稳定）。 */
export const ATTRIBUTION = Object.freeze({
  BRIDGE_CORRELATED: 'bridge-correlated',
  SELF_ONLY: 'self-only',
  MIXED: 'mixed',
  UNKNOWN: 'unknown',
})

/** 归属取值全集（响应契约的谓词与测试都用它，避免两处各写一份）。 */
export const ATTRIBUTION_VALUES = Object.freeze(Object.values(ATTRIBUTION))

/** before 文本的保留上限（UTF-16 码元）。超限 → 不保留文本、归属降级。 */
export const MAX_LEDGER_TEXT_CHARS = 1_048_576

/** 同时存在的记录上限（写并发下按文件串行，正常使用时个位数）。 */
export const MAX_LEDGER_RECORDS = 64

/** 每个文件保留的变更事件条数（判断"窗口内有没有第二条变化"够用即可）。 */
export const MAX_LEDGER_EVENTS_PER_FILE = 32

/** sha256 十六进制；`null` 表示"没有可用的文本"。 */
export function hashText(text) {
  if (typeof text !== 'string') return null
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 文本里每一行的起始偏移（UTF-16 码元下标）。
 *
 * 只认 `\r\n` / `\n` / `\r` 三种行尾 —— 与 VS Code 的 `Position.line` 口径一致，
 * 也与 `document.getText()` 的返回一致（换行符原样保留）。
 */
function lineStartsOf(text) {
  /** `{start, end}`：`end` 是行内容结束处（**换行符之前**）的下标。 */
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\n' && ch !== '\r') continue
    lines.push({ start, end: i })
    if (ch === '\r' && text[i + 1] === '\n') i += 1
    start = i + 1
  }
  lines.push({ start, end: text.length })
  return lines
}

/** `{line, character}`（0-based）→ 绝对偏移；越界回 null（**不 clamp**）。 */
function offsetOf(lines, position) {
  if (!position || typeof position !== 'object') return null
  const { line, character } = position
  if (!Number.isInteger(line) || !Number.isInteger(character)) return null
  if (line < 0 || character < 0) return null
  if (line >= lines.length) return null
  const { start, end } = lines[line]
  if (character > end - start) return null
  return start + character
}

/**
 * 把一组 edits 应用到 `beforeText` 上，得到"预期的 after 文本"。
 *
 * edits 的坐标是 **0-based** `{start:{line,character}, end:{...}, text}`（与协议层
 * `toApiRange` 的出口、与 VS Code 事件里的 `contentChanges[].range` 同一套）。
 * 任何一处不成立都回 `{ok:false, reason}` —— **绝不猜**：判据错一点，"我"与"别人"
 * 就可能判反。
 *
 * @param {string} beforeText
 * @param {Array<{start:{line:number,character:number}, end:{line:number,character:number}, text:string}>} edits
 * @returns {{ok:true, text:string}|{ok:false, reason:string}}
 */
export function applyExpectedEdits(beforeText, edits) {
  if (typeof beforeText !== 'string') return { ok: false, reason: 'before-text-unavailable' }
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: 'no-edits' }
  const lines = lineStartsOf(beforeText)
  const resolved = []
  for (const edit of edits) {
    if (typeof edit?.text !== 'string') return { ok: false, reason: 'edit-text-not-string' }
    const start = offsetOf(lines, edit.start)
    const end = offsetOf(lines, edit.end)
    if (start === null || end === null) return { ok: false, reason: 'range-out-of-bounds' }
    if (end < start) return { ok: false, reason: 'range-inverted' }
    resolved.push({ start, end, text: edit.text })
  }
  resolved.sort((a, b) => b.start - a.start)
  for (let i = 1; i < resolved.length; i += 1) {
    if (resolved[i].end > resolved[i - 1].start) return { ok: false, reason: 'overlapping-edits' }
  }
  let out = beforeText
  for (const item of resolved) {
    out = out.slice(0, item.start) + item.text + out.slice(item.end)
  }
  return { ok: true, text: out }
}

/** 归一化一条事件里的 `contentChanges`（形状坏的元素保留为 null，判据那边会拒）。 */
function normalizeChanges(changes) {
  if (!Array.isArray(changes)) return null
  return changes.map((change) => ({
    start: change?.start && typeof change.start === 'object'
      ? { line: change.start.line, character: change.start.character }
      : null,
    end: change?.end && typeof change.end === 'object'
      ? { line: change.end.line, character: change.end.character }
      : null,
    text: typeof change?.text === 'string' ? change.text : null,
  }))
}

/** 一条 edit 与一条 contentChange 是不是"同一个范围"。 */
function sameRange(a, b) {
  const eq = (x, y) => x && y && x.line === y.line && x.character === y.character
  return eq(a.start, b.start) && eq(a.end, b.end)
}

/** 位置排序键（只用于把两组变化摆成同一个顺序再比）。 */
function posKey(position) {
  if (!position) return 'x'
  return `${String(position.line).padStart(9, '0')}:${String(position.character).padStart(9, '0')}`
}

/** 把一组变化摆成稳定顺序（先按起点，再按终点）。 */
function normalizeEditOrder(items) {
  return items
    .map((item) => ({
      start: item?.start ?? null,
      end: item?.end ?? null,
      text: typeof item?.text === 'string' ? item.text : null,
    }))
    .sort((a, b) => (posKey(a.start) < posKey(b.start) ? -1 : posKey(a.start) > posKey(b.start) ? 1 : 0)
      || (posKey(a.end) < posKey(b.end) ? -1 : posKey(a.end) > posKey(b.end) ? 1 : 0))
}

/**
 * 一组变化与本次 edits 是否逐条同范围同文本。
 *
 * 只判"形状"，不判数量以外的语义 —— 数量不等由调用方按"多出/少了"分别归因。
 */
function changesMatchEdits(changes, edits) {
  const want = normalizeEditOrder(edits)
  const got = normalizeEditOrder(changes)
  if (want.length !== got.length) return false
  for (let i = 0; i < want.length; i += 1) {
    if (!sameRange(want[i], got[i])) return false
    if (want[i].text !== got[i].text) return false
  }
  return true
}

/** 空锚点（没有基线 / 没有 after 时的稳定形状：字段永远在，值为 null）。 */
function emptyAnchors() {
  return { version: null, incarnation: null, hash: null, textLength: null, dirty: null }
}

/** 从宿主的"文本快照"整理成对外锚点形状。 */
function anchorsOf(sample) {
  if (!sample) return emptyAnchors()
  return {
    version: Number.isInteger(sample.version) ? sample.version : null,
    incarnation: typeof sample.incarnation === 'string' && sample.incarnation !== ''
      ? sample.incarnation
      : null,
    hash: hashText(typeof sample.text === 'string' ? sample.text : null),
    textLength: typeof sample.text === 'string'
      ? sample.text.length
      : (Number.isInteger(sample.textLength) ? sample.textLength : null),
    dirty: typeof sample.dirty === 'boolean' ? sample.dirty : null,
  }
}

/** 把 settle 的结论整理成回执要带的字段（全部 JSON-safe，无 undefined）。 */
function summaryOf(operationId, decision, before, after) {
  return {
    operationId,
    attribution: decision.attribution,
    attributionReason: decision.reason,
    before: before ?? emptyAnchors(),
    after: after ?? emptyAnchors(),
  }
}

/**
 * 建一个账本。
 *
 * @param {object} [opts]
 * @param {(level: string, msg: string, extra?: object) => void} [opts.log]
 * @param {number}  [opts.maxTextChars]         before 文本保留上限（UTF-16 码元）
 * @param {number}  [opts.maxRecords]           同时在册的记录上限
 * @param {number}  [opts.maxEventsPerFile]     每文件保留的事件条数
 * @param {() => number} [opts.now]             时钟（测试可注入；只用于诊断时间戳）
 */
export function createChangeLedger(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const maxTextChars = Number.isInteger(opts.maxTextChars) && opts.maxTextChars > 0
    ? opts.maxTextChars
    : MAX_LEDGER_TEXT_CHARS
  const maxRecords = Number.isInteger(opts.maxRecords) && opts.maxRecords > 0
    ? opts.maxRecords
    : MAX_LEDGER_RECORDS
  const maxEventsPerFile = Number.isInteger(opts.maxEventsPerFile) && opts.maxEventsPerFile > 0
    ? opts.maxEventsPerFile
    : MAX_LEDGER_EVENTS_PER_FILE
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()

  /** operationId → 记录（插入顺序即时间顺序，淘汰用）。 */
  const records = new Map()
  /** 文件身份键 → 正在进行的 operationId（重入检测）。 */
  const pendingByKey = new Map()
  /**
   * 文件身份键 → 事件流状态。
   *  `seq`        单调事件序号（记录用 `beginSeq` 划窗）；
   *  `ring`       最近若干条事件；
   *  `chains`     每个化身自己的版本链（**按化身分开**：双窗口互不污染）；
   *  `desyncSeq`  最近一次"链断裂"发生时的 seq（窗口跨过它 → 归属降级）。
   */
  const files = new Map()
  /** 观察器状态：'unattached' | 'attached' | 'unavailable'。 */
  let observer = 'unattached'
  let operationCounter = 0
  const stats = {
    begun: 0, settled: 0, evicted: 0, overflowed: 0, events: 0, desyncs: 0, unavailable: 0,
  }

  function fileState(key) {
    if (!files.has(key)) {
      files.set(key, { seq: 0, ring: [], chains: new Map(), desyncSeq: 0 })
    }
    return files.get(key)
  }

  /** 开一条记录（`begin`）。 */
  function begin(input = {}) {
    const file = typeof input.file === 'string' && input.file !== '' ? input.file : null
    const key = file === null ? null : pathIdentityKey(file)
    operationCounter += 1
    const operationId = `op-${operationCounter}-${randomBytes(4).toString('hex')}`
    const created = now()
    const record = {
      operationId,
      fileKey: typeof key === 'string' ? key : null,
      file: file === null ? null : canonicalPath(file),
      // 授权身份**只记录、不判**：判定归 `judgeGrant`，这里留证据（谁发起的这一笔）。
      grant: input.grant ?? null,
      edits: Array.isArray(input.edits) ? input.edits : [],
      expectedVersion: Number.isInteger(input.expectedVersion) ? input.expectedVersion : null,
      expectedIncarnation: typeof input.expectedIncarnation === 'string'
        ? input.expectedIncarnation
        : null,
      dirtyBefore: typeof input.dirty === 'boolean' ? input.dirty : null,
      createdAt: created,
      beginSeq: 0,
      endSeq: null,
      before: null,
      constructed: false,
      dropped: false,
      deny: null,
      observerAtBegin: observer,
      settled: false,
    }
    stats.begun += 1

    if (record.fileKey === null) record.deny = 'no-file'
    else {
      const st = fileState(record.fileKey)
      record.beginSeq = st.seq
      // 重入：同一文件上一条还没结算 —— 两条都拿不到肯定归属（谁是谁分不清）。
      const inflight = pendingByKey.get(record.fileKey)
      if (inflight && records.has(inflight)) {
        const other = records.get(inflight)
        if (!other.settled) other.deny = other.deny ?? 'concurrent-write'
        record.deny = record.deny ?? 'concurrent-write'
      }
    }

    // 容量：先淘汰已结算（最老优先）；一条都淘汰不了 → 本条标 overflowed。
    if (records.size >= maxRecords) {
      let evicted = false
      for (const [id, rec] of records) {
        if (rec.settled) {
          records.delete(id)
          if (rec.fileKey !== null && pendingByKey.get(rec.fileKey) === id) {
            pendingByKey.delete(rec.fileKey)
          }
          stats.evicted += 1
          evicted = true
          break
        }
      }
      if (!evicted) {
        record.deny = record.deny ?? 'ledger-overflow'
        stats.overflowed += 1
      }
    }

    records.set(operationId, record)
    if (record.fileKey !== null && record.deny === null) {
      pendingByKey.set(record.fileKey, operationId)
    }
    return { operationId }
  }

  /** 记录"构造 edit 那一刻"的 before 基准（**事务的同步区间里**调用）。 */
  function construct(handle, sample = {}) {
    const record = handle ? records.get(handle.operationId) : null
    if (!record || record.settled) return false
    record.constructed = true
    const text = typeof sample.text === 'string' ? sample.text : null
    const tooLarge = typeof text === 'string' && text.length > maxTextChars
    record.before = {
      version: Number.isInteger(sample.version) ? sample.version : null,
      incarnation: typeof sample.incarnation === 'string' && sample.incarnation !== ''
        ? sample.incarnation
        : null,
      hash: tooLarge ? null : hashText(text),
      textLength: typeof text === 'string' ? text.length : null,
      // 正文**不保留**时明确记下来：判据那边要降级，不许拿"没有文本"当"没有差别"。
      text: tooLarge ? null : text,
      textTooLarge: tooLarge,
      documentPath: typeof sample.documentPath === 'string' ? sample.documentPath : null,
    }
    // 锚点与请求前提不一致 = 有人在这两条路径之间改了文档 —— 不能归因给"我的写入"。
    if (record.before.version !== null && record.expectedVersion !== null
      && record.before.version !== record.expectedVersion) {
      record.deny = record.deny ?? 'anchor-moved'
    }
    if (record.before.incarnation !== null && record.expectedIncarnation !== null
      && record.before.incarnation !== record.expectedIncarnation) {
      record.deny = record.deny ?? 'anchor-moved'
    }
    return true
  }

  /**
   * 收一条**变更事件**（宿主 `onDidChangeTextDocument` 的归一化样本）。
   *
   * 只做记录与"链连续性"判定，**不参与写入**：观察器抛异常也不许影响编辑器。
   */
  function observeChange(sample) {
    const file = typeof sample?.file === 'string' && sample.file !== '' ? sample.file : null
    if (file === null) return
    const key = pathIdentityKey(file)
    if (typeof key !== 'string') return
    const st = fileState(key)
    stats.events += 1
    const version = Number.isInteger(sample.version) ? sample.version : null
    const incarnation = typeof sample.incarnation === 'string' && sample.incarnation !== ''
      ? sample.incarnation
      : null

    // ── 链连续性：同一个化身上版本必须 +1。差了就是"我们漏了事件" ──
    if (version !== null) {
      const chainKey = incarnation ?? '(unknown)'
      const last = st.chains.get(chainKey)
      if (Number.isInteger(last) && version !== last + 1) {
        st.desyncSeq = st.seq + 1
        stats.desyncs += 1
        log('warn', `change-ledger: event chain gap for ${file} (${last} → ${version})`,
          { incarnation: chainKey })
      }
      st.chains.set(chainKey, version)
    }

    st.seq += 1
    st.ring.push({
      seq: st.seq,
      version,
      incarnation,
      changes: normalizeChanges(sample.changes),
      kind: typeof sample.reasonCode === 'number' ? sample.reasonCode : null,
    })
    if (st.ring.length > maxEventsPerFile) {
      const dropped = st.ring.shift()
      // 丢掉的那条如果落在某条在册记录的窗口里 → 那条记录**必须**降级。
      for (const record of records.values()) {
        if (record.settled || record.fileKey !== key) continue
        if (dropped.seq > record.beginSeq) record.dropped = true
      }
      stats.evicted += 1
    }
  }

  /** 窗口内的事件（按文件 + `beginSeq` 之后）。 */
  function eventsFor(record) {
    if (record.fileKey === null) return []
    const st = files.get(record.fileKey)
    if (!st) return []
    return st.ring.filter((event) => event.seq > record.beginSeq)
  }

  /** 一条事件是否"就是本次写入那一笔"。 */
  function eventMatches(record, event) {
    if (!record.before) return false
    if (event.version === null || record.before.version === null) return false
    if (event.version !== record.before.version + 1) return false
    if (event.incarnation !== null && record.before.incarnation !== null
      && event.incarnation !== record.before.incarnation) return false
    if (!Array.isArray(event.changes)) return false
    return changesMatchEdits(event.changes, record.edits)
  }

  /**
   * 归属判定 —— 本模块的**唯一**一处结论来源。
   *
   * 判序（顺序即语义，前面每一条都是"别把未知说成已知"）：
   *  deny（重入/超限/锚点漂移/无文件） → 观察器缺失 → 账本丢过事件 → 链断裂 →
   *  无基线 → 文本超限 → 宿主没接受 → after 没测到 → 化身变了 → 内容判据。
   */
  function decide(record, { outcome, after, afterError }) {
    const unknown = (reason) => ({ attribution: ATTRIBUTION.UNKNOWN, reason })
    if (record.deny) return unknown(record.deny)
    // 观察器**没挂上**（宿主没这条 API）或**装失败**：我们看不到任何事件，
    // 于是"没有额外变化"这件事根本无从证明 —— 一律 unknown，绝不因为看不见就当没有。
    if (record.observerAtBegin !== 'attached') return unknown('observer-unavailable')
    const st = record.fileKey === null ? null : files.get(record.fileKey)
    const endSeq = record.endSeq ?? (st ? st.seq : record.beginSeq)
    if (st && st.desyncSeq > record.beginSeq && st.desyncSeq <= endSeq) return unknown('event-gap')
    if (record.dropped) return unknown('ledger-event-dropped')
    if (!record.before) return unknown(record.constructed ? 'no-baseline' : 'no-baseline')
    if (record.before.textTooLarge) return unknown('text-too-large')

    const events = eventsFor(record)
    // 预先 dirty：缓冲区内已有**不是我写的**内容。这一笔引起的增量与那些内容无法分离，
    // 无论版本怎么长都不许说成 self-only（契约/规划的硬判据）。
    if (record.dirtyBefore === true) return unknown('pre-dirty')

    if (outcome !== 'applied') {
      const afterText = typeof after?.text === 'string' ? after.text : null
      const beforeText = typeof record.before.text === 'string' ? record.before.text : null
      const changed = afterText !== null && beforeText !== null && afterText !== beforeText
      if (outcome === 'timeout') return unknown('host-timeout')
      if (outcome === 'error') return unknown('host-error')
      return unknown(changed ? 'host-rejected-with-other-changes' : 'host-rejected')
    }
    if (afterError) return unknown('after-unmeasured')
    if (!after) return unknown('after-unmeasured')

    // 化身变了 = 关掉重开（或另一个实例接管）。版本数字再怎么一致也不能当同一份文档。
    if (after.incarnation !== null && record.before.incarnation !== null
      && after.incarnation !== record.before.incarnation) {
      return unknown('incarnation-changed')
    }

    const beforeText = record.before.text
    const afterText = typeof after.text === 'string' ? after.text : null
    if (afterText === null) return unknown('after-text-unavailable')
    const expected = applyExpectedEdits(beforeText, record.edits)
    const exact = expected.ok === true && afterText === expected.text
    const unchanged = afterText === beforeText

    if (unchanged && expected.ok === true && expected.text === beforeText) {
      // no-op：builder 没有任何实际改动 —— 没有增量可以"关联"，也不许冒充成功写入。
      return unknown('no-op')
    }

    const extras = events.filter((event) => !eventMatches(record, event))
    if (extras.length > 0) {
      // 别的窗口（另一个化身）在同一窗口里改过这个文件 —— 双窗口的典型形态。
      const otherInstance = extras.some((event) => event.incarnation !== null
        && record.before.incarnation !== null
        && event.incarnation !== record.before.incarnation)
      if (otherInstance) return { attribution: ATTRIBUTION.MIXED, reason: 'other-window-incarnation' }
      // ★ 这里**不许**再拿"each event version !== before+1"当跳号判据：
      //   我这一笔（v6）之后人再敲一下就是 v7，那不是"漏了事件"，那是**额外的正常变化**。
      //   真正的失步由观察侧自己记（`observeChange` 的链连续性 → `desyncSeq` → `event-gap`），
      //   两处各判一套只会把"人工交错"误报成"监听坏了"，把有用的 mixed 信息丢掉。
      return { attribution: ATTRIBUTION.MIXED, reason: 'extra-changes' }
    }

    if (!exact) {
      if (unchanged) return unknown('write-not-visible')
      return { attribution: ATTRIBUTION.MIXED, reason: 'after-content-differs' }
    }

    // 文本与预期逐字相等：写入本身被证明。再看证据链能不能升级成"因果关系"。
    if (events.length === 0) {
      // 事件可能**晚于 Promise**（VS Code 不保证顺序）。此刻只能说"这一笔是真的"，
      // 不能说"只有这一笔" —— 所以是 self-only，不是 bridge-correlated。
      return { attribution: ATTRIBUTION.SELF_ONLY, reason: 'event-chain-pending' }
    }
    if (events.length === 1 && eventMatches(record, events[0])) {
      return { attribution: ATTRIBUTION.BRIDGE_CORRELATED, reason: 'event-chain-matched' }
    }
    return { attribution: ATTRIBUTION.SELF_ONLY, reason: 'event-chain-unverifiable' }
  }

  /**
   * 结算一条记录。
   *
   * @param {{operationId: string}} handle `begin` 的返回
   * @param {object} input
   * @param {'applied'|'rejected'|'error'|'timeout'} [input.outcome]
   * @param {{version?:number, incarnation?:string, text?:string, textLength?:number, dirty?:boolean}|null} [input.after]
   * @param {string} [input.afterError] 写后实测失败的原因（**实测失败 ≠ 没有变化**）
   */
  function settle(handle, input = {}) {
    const operationId = handle?.operationId ?? null
    const record = operationId === null ? null : records.get(operationId)
    const after = input.after ?? null
    const afterAnchors = anchorsOf(after)
    if (!record) {
      // 记录被淘汰/不存在：证据链没了，只能 unknown（**不许**因为"我发起过"就归给我）。
      return summaryOf(operationId, { attribution: ATTRIBUTION.UNKNOWN, reason: 'ledger-record-missing' },
        null, afterAnchors)
    }
    if (record.settled) {
      return summaryOf(operationId, { attribution: ATTRIBUTION.UNKNOWN, reason: 'already-settled' },
        record.before ? anchorsOf(record.before) : null, afterAnchors)
    }
    record.settled = true
    record.endSeq = record.fileKey === null ? record.beginSeq : (files.get(record.fileKey)?.seq ?? record.beginSeq)
    const decision = decide(record, {
      outcome: input.outcome ?? 'applied',
      after,
      afterError: typeof input.afterError === 'string' ? input.afterError : null,
    })
    stats.settled += 1
    if (record.fileKey !== null && pendingByKey.get(record.fileKey) === operationId) {
      pendingByKey.delete(record.fileKey)
    }
    const summary = summaryOf(operationId,
      decision,
      record.before ? anchorsOf(record.before) : null,
      afterAnchors)
    log('info', `change-ledger: ${record.file ?? '(no file)'} ${summary.attribution}`
      + ` (${summary.attributionReason})${record.grant ? ` grant=${record.grant.id ?? '?'}` : ''}`)
    return summary
  }

  /** 观察器装不上（宿主老 / 抛异常）：之后所有记录一律降级为 unknown。 */
  function markObserverUnavailable(reason) {
    observer = 'unavailable'
    stats.unavailable += 1
    log('warn', `change-ledger: change observer unavailable (${reason ?? 'no source'});`
      + ' attribution will stay unknown')
  }

  /** 观察器挂上了（宿主真的给了 `onDidChangeTextDocument`）。 */
  function markObserverAttached() {
    observer = 'attached'
  }

  /** 诊断读数（`vscode.getEditLedger` 之类的未来能力用；当前只给测试与日志）。 */
  function status() {
    const pending = [...records.values()].filter((record) => !record.settled).length
    return {
      observer,
      records: records.size,
      pending,
      files: files.size,
      ...stats,
    }
  }

  return {
    begin,
    construct,
    observeChange,
    settle,
    markObserverAttached,
    markObserverUnavailable,
    status,
  }
}
