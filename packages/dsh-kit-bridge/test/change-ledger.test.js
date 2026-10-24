/**
 * A1 / T61 —— 文档变更关联账本（`src/change-ledger.js`）。
 *
 * 本文件守的是一句很容易被"顺手优化"掉的话：
 *
 *   **版本号增长不是"人工作者"的证明，我发起过写入也不是"这些变化都是我造成的"的证明。**
 *
 * 所以两层都要测：
 *  ① **账本层**（纯函数 + 事件流）：只有四条判据同时成立才允许 `bridge-correlated`，
 *     其余一律落到 `unknown` / `mixed` 并带 `reason`。这里逐条把"不许说成我的"的
 *     情形钉死（预先 dirty、无干净基线、格式化/undo-redo、关闭重开、同 version 不同
 *     incarnation、账本淘汰/超限/监听失步、事件早于/晚于 Promise、no-op、拒写、抛异常、超时、重入）。
 *  ② **能力层**（`createCapabilities` + 真文件系统 + 假宿主）：回执里真的带上了这些字段、
 *     `applied` / `saved:false` 的既有语义一个字没改、且 after 是**实测**读回来的。
 *
 * 变异测试（铁律 9）针对本文件：M1~M4 四条变异（见 work/A1-变更账本-实现报告.md），
 * 每条都有至少一条用例变红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { validateResponse } from '../../dsh-vscode-kit/src/response-contract.js'
import {
  ATTRIBUTION, ATTRIBUTION_VALUES, applyExpectedEdits, createChangeLedger, hashText,
} from '../src/change-ledger.js'
import { createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 账本层脚手架
// ---------------------------------------------------------------------------

/** 单元测试用的合成路径（`canonicalPath` / `pathIdentityKey` 只做字符串归一，不碰 fs）。 */
const FILE_A = 'C:/ws/proj/a.js'
const FILE_B = 'C:/ws/proj/b.js'

const INC_A = 'inc-A'
const INC_B = 'inc-B'

/** 一份"文档快照"。`text` 走 hash；`version` / `incarnation` 是锚点。 */
function snap(text, version, incarnation = INC_A, extra = {}) {
  return { version, incarnation, text, textLength: text.length, ...extra }
}

/** 一次编辑（0-based character 口径，与 `contentChanges[].range` 同形）。 */
function edit(line, from, to, text) {
  return {
    start: { line, character: from },
    end: { line, character: to },
    text,
  }
}

/** 事件样本（宿主 `onDidChangeTextDocument` 归一化后的形状）。 */
function change(file, version, changes, incarnation = INC_A, reasonCode = 1) {
  return { file, version, incarnation, changes, reasonCode }
}

/**
 * 开一条记录并**在同步区间里**交 before 基准 —— 与 `capabilities.js` 的调用顺序一致。
 * @returns {string} operationId
 */
function beginWithBaseline(ledger, { file = FILE_A, beforeText, beforeVersion = 5, beforeIncarnation = INC_A, edits, dirty = false } = {}) {
  const handle = ledger.begin({
    file,
    grant: { id: 'grant-1', resolved: true, sessionId: 'sess-1', epoch: 3 },
    edits: edits ?? [edit(0, 0, 5, 'HELLO')],
    expectedVersion: beforeVersion,
    expectedIncarnation: beforeIncarnation,
    dirty,
  })
  ledger.construct(handle, {
    version: beforeVersion,
    incarnation: beforeIncarnation,
    documentPath: file,
    text: beforeText,
  })
  return handle
}

// ---------------------------------------------------------------------------
// ① 账本层：唯一能报 bridge-correlated 的那条路
// ---------------------------------------------------------------------------

test('T61/A1 ★ 事件**早于** Promise：四条判据齐了才报 bridge-correlated', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\nsecond line\n'
  const afterText = 'HELLO world\nsecond line\n'
  const edits = [edit(0, 0, 5, 'HELLO')]

  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  // 事件先到（宿主在 `TextEditor.edit` 回调里就把事件发出去了）。
  ledger.observeChange(change(FILE_A, 6, edits))
  const summary = ledger.settle(handle, { outcome: 'applied', after: snap(afterText, 6) })

  assert.equal(summary.attribution, ATTRIBUTION.BRIDGE_CORRELATED,
    `判据齐了应当 bridge-correlated，实际 ${summary.attribution}(${summary.attributionReason})`)
  assert.equal(summary.attributionReason, 'event-chain-matched')

  // 回执必须自带 before/after 锚点（version / incarnation / hash 三件套都在）。
  assert.deepEqual(Object.keys(summary.before).sort(),
    ['dirty', 'hash', 'incarnation', 'textLength', 'version'])
  assert.equal(summary.before.version, 5)
  assert.equal(summary.after.version, 6)
  assert.equal(summary.before.incarnation, INC_A)
  assert.equal(summary.after.incarnation, INC_A)
  assert.equal(summary.before.hash, hashText(before), 'before.hash 必须是 before 文本的 sha256')
  assert.equal(summary.after.hash, hashText(afterText), 'after.hash 必须是**实测** after 文本的 sha256')
  // operationId 由账本签发（`op-<n>-<hex>`），不是调用方填的。
  assert.match(summary.operationId, /^op-\d+-[0-9a-f]{8}$/)
})

test('T61/A1 ★ 事件**晚于** Promise：只能 self-only（不许因为"我发起的"就报关联）', async () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\nsecond line\n'
  const afterText = 'HELLO world\nsecond line\n'
  const edits = [edit(0, 0, 5, 'HELLO')]

  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  const summary = ledger.settle(handle, { outcome: 'applied', after: snap(afterText, 6) })

  assert.equal(summary.attribution, ATTRIBUTION.SELF_ONLY,
    'after 逐字相等只证明"这一笔是真的"，事件还没到 ⇒ 不能升级成因果关系')
  assert.equal(summary.attributionReason, 'event-chain-pending')

  // 晚到的事件**不改写**已经发出去的回执（回执是快照，不是活引用）。
  ledger.observeChange(change(FILE_A, 6, edits))
  assert.equal(summary.attribution, ATTRIBUTION.SELF_ONLY)
})

test('T61/A1 no-op（builder 没有任何实际改动）→ unknown，且不许冒充成功写入', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  // 用"替换成同样字节"造 no-op：预期结果与 before 逐字相同。
  const edits = [edit(0, 0, 5, 'hello')]

  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  ledger.observeChange(change(FILE_A, 6, edits))
  const summary = ledger.settle(handle, { outcome: 'applied', after: snap(before, 6) })

  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'no-op')
})

test('T61/A1 宿主拒写（applied:false）→ unknown host-rejected', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const handle = beginWithBaseline(ledger, { beforeText: before, edits: [edit(0, 0, 5, 'HELLO')] })

  const summary = ledger.settle(handle, { outcome: 'rejected', after: snap(before, 5) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'host-rejected')
})

test('T61/A1 写宿主抛异常 / 超时 → unknown（两种证据状态分开记）', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'

  const errHandle = beginWithBaseline(ledger, { beforeText: before, edits: [edit(0, 0, 5, 'HELLO')] })
  const errSummary = ledger.settle(errHandle, { outcome: 'error', after: null })
  assert.equal(errSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(errSummary.attributionReason, 'host-error')

  const timeoutHandle = beginWithBaseline(ledger, { beforeText: before, edits: [edit(0, 0, 5, 'HELLO')] })
  const timeoutSummary = ledger.settle(timeoutHandle, { outcome: 'timeout', after: null })
  assert.equal(timeoutSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(timeoutSummary.attributionReason, 'host-timeout',
    '超时与普通失败必须分开（一个"可能落了点"，一个"确定没写"）')
})

test('T61/A1 ★ 重入（同文件上一笔还没结算）→ 两条都 unknown，谁都不许认领', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'

  const first = beginWithBaseline(ledger, { beforeText: before, edits: [edit(0, 0, 5, 'A')] })
  const second = beginWithBaseline(ledger, { beforeText: before, edits: [edit(0, 0, 5, 'B')] })

  const firstSummary = ledger.settle(first, { outcome: 'applied', after: snap('A world\n', 6) })
  const secondSummary = ledger.settle(second, { outcome: 'applied', after: snap('B world\n', 7) })

  assert.equal(firstSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(secondSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(firstSummary.attributionReason, 'concurrent-write')
  assert.equal(secondSummary.attributionReason, 'concurrent-write')
})

// ---------------------------------------------------------------------------
// ② 账本层：这些情形一律**不许** self-only
// ---------------------------------------------------------------------------

test('T61/A1 ★ 预先 dirty（缓冲里已有别人/人的改动）→ unknown pre-dirty', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits, dirty: true })
  ledger.observeChange(change(FILE_A, 6, edits))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\n', 6) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'pre-dirty')
})

test('T61/A1 无干净基线（before 快照没交上来）→ unknown no-baseline', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const handle = ledger.begin({
    file: FILE_A,
    edits: [edit(0, 0, 5, 'HELLO')],
    expectedVersion: 5,
    expectedIncarnation: INC_A,
  })
  // 故意不调 construct：模拟"事务没进同步区间就失败了/宿主不认识观察回调"。
  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\n', 6) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'no-baseline')
})

test('T61/A1 人工交错（同一化身里的额外变化）→ mixed extra-changes，不是 self-only', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\nsecond line\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })

  // 我的那一笔（v6）……
  ledger.observeChange(change(FILE_A, 6, edits))
  // ……然后人在同一段里又敲了一个字符（v7，range 与我的 edit 不同）。
  ledger.observeChange(change(FILE_A, 7, [edit(1, 0, 0, 'X')]))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\nXsecond line\n', 7) })
  assert.equal(summary.attribution, ATTRIBUTION.MIXED,
    '写完之后又出现了别的修改 ⇒ 必须 mixed（或 unknown），不许把整段增量算成我的')
  assert.equal(summary.attributionReason, 'extra-changes')
})

test('T61/A1 格式化 / undo-redo（增量与预期不符）→ mixed after-content-differs', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\nsecond line\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits, dirty: true })
  ledger.observeChange(change(FILE_A, 6, edits))

  // 保存时的格式化把整行重排了：after 与"before + 我这组 edits"逐字不等。
  const summary = ledger.settle(handle, {
    outcome: 'applied',
    after: snap('HELLO   world\nsecond line\n', 6),
  })
  // 预先 dirty 的那条更早命中 ⇒ pre-dirty；这条用例守的是"无论如何都不是 self-only"。
  assert.notEqual(summary.attribution, ATTRIBUTION.SELF_ONLY)
  assert.notEqual(summary.attribution, ATTRIBUTION.BRIDGE_CORRELATED)
})

test('T61/A1 ★ 关闭后重开（同 version 不同 incarnation）→ unknown incarnation-changed', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  ledger.observeChange(change(FILE_A, 6, edits, INC_A))

  // 关掉再打开：版本号可能恰好也是 6，但那是**另一份文档实例**。
  const summary = ledger.settle(handle, {
    outcome: 'applied',
    after: { version: 6, incarnation: INC_B, text: 'HELLO world\n', textLength: 12 },
  })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'incarnation-changed')
})

test('T61/A1 双窗口（另一个化身在同一窗口里改过）→ mixed other-window-incarnation', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\nsecond line\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })

  // 另一个窗口（INC_B）先改了同一行 —— 它的事件带着自己的化身。
  ledger.observeChange(change(FILE_A, 3, [edit(1, 0, 6, 'OTHER')], INC_B))
  ledger.observeChange(change(FILE_A, 6, edits, INC_A))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\nOTHER line\n', 6) })
  assert.equal(summary.attribution, ATTRIBUTION.MIXED)
  assert.equal(summary.attributionReason, 'other-window-incarnation')
})

test('T61/A1 监听失步（事件链跳号）→ unknown event-gap', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })

  // 6 → 8：中间那条事件我们没收到（监听失步 / 宿主合并事件）。
  ledger.observeChange(change(FILE_A, 6, edits))
  ledger.observeChange(change(FILE_A, 8, [edit(0, 6, 6, '!')]))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO! world\n', 8) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'event-gap')
})

test('T61/A1 账本淘汰（事件被挤出环形缓冲）→ unknown ledger-event-dropped', () => {
  // 每个文件只留 2 条事件：第 3 条进来时，第 1 条会落在我这条记录的窗口里 ⇒ 必须降级。
  const ledger = createChangeLedger({ maxEventsPerFile: 2 })
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })

  ledger.observeChange(change(FILE_A, 6, edits))
  ledger.observeChange(change(FILE_A, 7, [edit(1, 0, 0, 'A')]))
  ledger.observeChange(change(FILE_A, 8, [edit(1, 0, 0, 'B')]))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\nBAsecond line\n', 8) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'ledger-event-dropped')
})

test('T61/A1 账本超限（记录表满了且一条都淘汰不了）→ unknown ledger-overflow', () => {
  const ledger = createChangeLedger({ maxRecords: 1 })
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]

  const first = beginWithBaseline(ledger, { beforeText: before, edits })
  const second = beginWithBaseline(ledger, { file: FILE_B, beforeText: before, edits })

  // 第一条还没结算 ⇒ 第二条无处可放，只能标记超限。
  const secondSummary = ledger.settle(second, { outcome: 'applied', after: snap('HELLO world\n', 6) })
  assert.equal(secondSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(secondSummary.attributionReason, 'ledger-overflow')
  assert.equal(ledger.status().overflowed, 1)
  ledger.settle(first, { outcome: 'rejected', after: null })
})

test('T61/A1 观察器缺失（老宿主）→ unknown observer-unavailable，绝不假装"没看到别人"', () => {
  const ledger = createChangeLedger()
  // 故意不 markObserverAttached：等价于宿主没有 `onDidChangeTextDocument`。
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  ledger.observeChange(change(FILE_A, 6, edits))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO world\n', 6) })
  assert.equal(summary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(summary.attributionReason, 'observer-unavailable')
})

test('T61/A1 after 没实测到 → unknown（失败 ≠ 没有变化）', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]

  const noAfter = beginWithBaseline(ledger, { beforeText: before, edits })
  const noAfterSummary = ledger.settle(noAfter, { outcome: 'applied', after: null, afterError: 'boom' })
  assert.equal(noAfterSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(noAfterSummary.attributionReason, 'after-unmeasured')

  const noText = beginWithBaseline(ledger, { beforeText: before, edits })
  ledger.observeChange(change(FILE_A, 6, edits))
  const noTextSummary = ledger.settle(noText, {
    outcome: 'applied',
    after: { version: 6, incarnation: INC_A, text: null, textLength: 12 },
  })
  assert.equal(noTextSummary.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(noTextSummary.attributionReason, 'after-text-unavailable')
})

test('T61/A1 写后内容与预期不等 → mixed after-content-differs（不许回显期望值）', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]
  const handle = beginWithBaseline(ledger, { beforeText: before, edits })
  ledger.observeChange(change(FILE_A, 6, edits))

  const summary = ledger.settle(handle, { outcome: 'applied', after: snap('HELLO WORLD\n', 6) })
  assert.equal(summary.attribution, ATTRIBUTION.MIXED)
  assert.equal(summary.attributionReason, 'after-content-differs')
  // ★ after 是实测值，不是预期值：hash 必须等于实测文本的 hash。
  assert.equal(summary.after.hash, hashText('HELLO WORLD\n'))
  assert.notEqual(summary.after.hash, hashText(applyExpectedEdits(before, edits).text))
})

// ---------------------------------------------------------------------------
// ③ 入参自报一律不采信
// ---------------------------------------------------------------------------

test('T61/A1 ★ 调用方自报的 operationId / attribution 不产生任何效果', () => {
  const ledger = createChangeLedger()
  ledger.markObserverAttached()
  const before = 'hello world\n'
  const edits = [edit(0, 0, 5, 'HELLO')]

  const handle = ledger.begin({
    file: FILE_A,
    operationId: 'op-evil',
    attribution: 'bridge-correlated',
    attributionReason: 'trust-me',
    edits,
    expectedVersion: 5,
    expectedIncarnation: INC_A,
  })
  assert.notEqual(handle.operationId, 'op-evil', 'operationId 必须由账本签发')
  ledger.construct(handle, { version: 5, incarnation: INC_A, documentPath: FILE_A, text: before })
  ledger.observeChange(change(FILE_A, 6, edits))

  const summary = ledger.settle(handle, {
    outcome: 'applied',
    after: snap('HELLO world\n', 6),
    attribution: 'bridge-correlated',
  })
  assert.notEqual(summary.attributionReason, 'trust-me')
  // 这条用例真值是 bridge-correlated（证据齐全），关键是**不因为入参这么说**才这么说。
  assert.equal(summary.attributionReason, 'event-chain-matched')

  // 拿一个从没签发过的 id 去结算：账本里没有证据链 ⇒ unknown。
  const ghost = ledger.settle({ operationId: 'op-evil' }, { outcome: 'applied', after: snap('x', 1) })
  assert.equal(ghost.attribution, ATTRIBUTION.UNKNOWN)
  assert.equal(ghost.attributionReason, 'ledger-record-missing')
})

test('T61/A1 归属取值与 kit 响应契约里的字面量逐字一致（防两处各写一份漂移）', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const contractSrc = readFileSync(
    join(here, '..', '..', 'dsh-vscode-kit', 'src', 'response-contract.js'), 'utf8',
  )
  for (const value of ATTRIBUTION_VALUES) {
    assert.ok(contractSrc.includes(`'${value}'`),
      `response-contract.js 里缺少归属取值 '${value}'（两侧字面量必须一致）`)
  }
  assert.deepEqual([...ATTRIBUTION_VALUES].sort(),
    ['bridge-correlated', 'mixed', 'self-only', 'unknown'])
})

// ---------------------------------------------------------------------------
// ④ 能力层：回执字段 + 既有语义不变
// ---------------------------------------------------------------------------

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-change-ledger-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 带缓冲区的假宿主（比 `apply-edit.test.js` 里的多两样东西）：
 *  - `observeTextChanges`：把变更事件交给账本（`emit` 决定事件早于还是晚于 Promise）；
 *  - `applyEditText` 第 6 个参数 `observation.observe(...)`：在**同步区间**里交 before 基准。
 */
function makeBufferHost(root, {
  fileName = 'a.js',
  text = 'hello world\nsecond line\n',
  version = 5,
  incarnation = INC_A,
  behaviour = 'accept',
  emitted = 'early',
  dirty = false,
  withObserver = true,
} = {}) {
  const abs = join(root, fileName)
  writeFileSync(abs, text)
  const buffer = { text, version, incarnation, dirty }
  const calls = []
  const listeners = []
  let pendingEmit = null

  const emit = (changes) => {
    buffer.version += 1
    for (const fn of listeners) {
      fn({ file: abs, version: buffer.version, incarnation: buffer.incarnation, changes, reasonCode: 1 })
    }
    return buffer.version
  }

  /**
   * 把 0-based 位置换算成绝对偏移。
   *
   * 两种列名都要认：能力层交给宿主的 range 用 `column`（`toApiRange` 的口径），
   * 而 `contentChanges[].range` 用的是 `character`（VS Code 的口径）。
   * 假宿主若只在事件里回 `column`，账本的逐条比对就永远对不上 —— 那是**假宿主**的错，
   * 不是产品的错，所以这里显式归一。
   */
  const offsetOf = (position) => {
    const lines = buffer.text.split('\n')
    let offset = 0
    for (let i = 0; i < position.line; i += 1) offset += lines[i].length + 1
    return offset + (position.character ?? position.column)
  }
  /** 把能力层给的 range（`column` 口径）翻成事件里那种 `character` 口径。 */
  const asChangeRange = (range) => ({
    start: { line: range.start.line, character: range.start.character ?? range.start.column },
    end: { line: range.end.line, character: range.end.character ?? range.end.column },
  })

  const host = {
    calls,
    buffer,
    listeners,
    emit,
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(root, p)),
    workspaceRoots: () => [root],
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    readDocumentState: async (abs2, options = {}) => ({
      version: buffer.version,
      incarnation: buffer.incarnation,
      isDirty: buffer.dirty,
      eol: 'lf',
      lineCount: buffer.text.split('\n').length,
      textLength: buffer.text.length,
      byteLength: Buffer.byteLength(buffer.text, 'utf8'),
      ...(options?.includeText === true ? { text: buffer.text } : {}),
    }),
    readRangeText: async (abs2, range) => buffer.text.slice(offsetOf(range.start), offsetOf(range.end)),
    readDocumentShape: async (abs2, lines = []) => {
      const all = buffer.text.split(/\r?\n/)
      return {
        lineCount: all.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= all.length ? all[n - 1].length : null)),
      }
    },
    applyEditText: async (abs2, range, writeText, expectedVersion, expectedIncarnation, observation) => {
      calls.push({ abs: abs2, range, text: writeText })
      // ★ 同步区间：before 基准**先交**。真实 `edit-transaction.js` 也是这样排的
      //   （`observe(...)` 在 `apply(builder)` 之前），所以"宿主拒写"与"抛异常"也必须
      //   先有基准 —— 否则拒写会被误判成"没有干净基线"（no-baseline），证据链丢了。
      if (typeof observation?.observe === 'function') {
        observation.observe({
          version: buffer.version,
          incarnation: buffer.incarnation,
          documentPath: abs2,
          text: buffer.text,
        })
      }
      if (behaviour === 'throw') {
        throw Object.assign(new Error('host exploded'), { code: ERR.TIMEOUT })
      }
      if (behaviour === 'reject') return { applied: false, documentPath: abs2 }
      const start = offsetOf(range.start)
      const end = offsetOf(range.end)
      buffer.text = buffer.text.slice(0, start) + writeText + buffer.text.slice(end)
      const changes = [{ ...asChangeRange(range), text: writeText }]
      if (emitted === 'early') {
        emit(changes)
      } else if (emitted === 'late') {
        pendingEmit = changes
      }
      return { applied: true, documentPath: abs2 }
    },
  }
  if (withObserver) {
    host.observeTextChanges = (handler) => {
      listeners.push(handler)
      return { dispose: () => { listeners.splice(listeners.indexOf(handler), 1) } }
    }
  }
  host.flushLateEvents = () => {
    if (pendingEmit) {
      const changes = pendingEmit
      pendingEmit = null
      emit(changes)
    }
  }
  return host
}

function grantedEnv(root, hostOptions = {}) {
  const grants = new GrantStore()
  const link = { name: 'link-a' }
  grants.adopt({ id: ID_A, epoch: EPOCH_A, link })
  const host = makeBufferHost(root, hostOptions)
  const caps = createCapabilities(host, { grants })
  return { grants, host, caps, link }
}

function editParams(file, extra = {}) {
  return {
    file,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    text: 'HELLO',
    expectedVersion: 5,
    expectedIncarnation: INC_A,
    grant: { id: ID_A, epoch: EPOCH_A },
    ...extra,
  }
}

test('T61/A1 ★ 能力层：回执带归属字段，applied / saved:false 语义不变', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv(ws.root)
    const file = join(ws.root, 'a.js')
    const res = await caps.dispatch('vscode.applyEdit', editParams(file), { link })

    assert.equal(res.applied, true)
    assert.equal(res.saved, false, '这一刀仍然只改缓冲区')
    assert.equal(res.file, file)
    assert.equal(res.textLength, 5)
    assert.equal(res.attribution, ATTRIBUTION.BRIDGE_CORRELATED)
    assert.match(res.operationId, /^op-\d+-[0-9a-f]{8}$/)
    assert.equal(res.before.version, 5)
    assert.equal(res.after.version, 6)
    assert.equal(res.before.incarnation, INC_A)
    assert.equal(res.after.hash, hashText(host.buffer.text), 'after 必须是**实测**读回来的')

    // 回执本身要过 kit 的响应契约（新增字段已登记，且整组可选）。
    assert.doesNotThrow(() => validateResponse('vscode.applyEdit', res))
  } finally {
    ws.dispose()
  }
})

test('T62/A2 能力层：老宿主（没有观察器）→ **拒写** -32011 observation-gap，宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv(ws.root, { withObserver: false })
    let err = null
    try {
      await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    } catch (e) { err = e }
    assert.equal(err?.code, ERR.DOCUMENT_DIRTY,
      '没有同源观察器 ⇒ 连"干净基线"都建立不起来 ⇒ 失败闭合（默认放行是绝不能有的）')
    assert.equal(err?.data?.reason, 'observation-gap')
    assert.equal(err?.data?.attribution, 'unknown')
    assert.equal(err?.data?.mayHaveApplied, false)
    assert.equal(host.calls.length, 0, '拒绝路径上宿主一次都不许被调用')
    // 读路径不受影响：没有观察器照样能读（老宿主只是不能写）。
    const state = await caps.dispatch('vscode.getDocumentState', { file: join(ws.root, 'a.js') }, { link })
    assert.equal(state.version, 5)
  } finally {
    ws.dispose()
  }
})

test('T61/A1 能力层：宿主拒写 → applied:false 且归属 unknown', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv(ws.root, { behaviour: 'reject' })
    const res = await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    assert.equal(res.applied, false)
    assert.equal(res.attribution, ATTRIBUTION.UNKNOWN)
    assert.equal(res.attributionReason, 'host-rejected')
  } finally {
    ws.dispose()
  }
})

test('T61/A1 能力层：写宿主抛超时 → 错误仍按原样上浮（账本不影响判序）', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv(ws.root, { behaviour: 'throw' })
    let code = null
    try {
      await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    } catch (err) {
      code = err.code
    }
    assert.equal(code, ERR.TIMEOUT, '归属是证据层，不许改变既有的错误码')
  } finally {
    ws.dispose()
  }
})

test('T61/A1 能力层：事件晚于 Promise → self-only（而且不是 bridge-correlated）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv(ws.root, { emitted: 'late' })
    const res = await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    assert.equal(res.attribution, ATTRIBUTION.SELF_ONLY)
    assert.equal(res.attributionReason, 'event-chain-pending')
    // 晚到的事件不会改写已发回执。
    host.flushLateEvents()
    assert.equal(res.attribution, ATTRIBUTION.SELF_ONLY)
    assert.equal(host.buffer.version, 6)
  } finally {
    ws.dispose()
  }
})

test('T62/A2 能力层：预先 dirty 的缓冲区（基线之前就有别人的字）→ 拒写 -32011', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv(ws.root, { dirty: true })
    let err = null
    try {
      await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    } catch (e) { err = e }
    // 账本会说 `pre-dirty`（证据层的判断没变）；写许可层的结论是"来源不明 ⇒ 拒"，
    // 因为这份脏**早于**我的基线，我拿不出任何证据说它是我写的。
    assert.ok(err, '脏且不可归属必须拒写，不许沿用"照写"的旧行为')
    assert.equal(err.code, ERR.DOCUMENT_DIRTY)
    assert.equal(err.data.reason, 'dirty-quarantine')
    assert.equal(err.data.isDirty, true)
    assert.equal(err.data.retryable, false)
    assert.equal(host.calls.length, 0, '宿主零调用')
    assert.equal(host.buffer.text.includes('hello world'), true, '缓冲区原样不动')
  } finally {
    ws.dispose()
  }
})

test('T62/A2 能力层：`opts.changeLedger === false` ⇒ 没有证据源 ⇒ 一起拒写', async () => {
  const ws = tempWorkspace()
  try {
    const grants = new GrantStore()
    const link = { name: 'link-a' }
    grants.adopt({ id: ID_A, epoch: EPOCH_A, link, allowDirtySave: true })
    const host = makeBufferHost(ws.root)
    const caps = createCapabilities(host, { grants, changeLedger: false })
    let err = null
    try {
      await caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link })
    } catch (e) { err = e }
    // ★ 语义变更（v1→v2）：`changeLedger:false` 在 A1 里只是"回执少几个字段"，
    //   A2 之后它等于"这个桥接没有归属证据源" ⇒ 和"老宿主没有观察器"同一条结论：
    //   拒写（observation-gap）。这个开关现在是**只读桥接**的开关，不再是兼容出口。
    assert.equal(err?.code, ERR.DOCUMENT_DIRTY, '关掉账本 = 没有证据源 ⇒ 失败闭合')
    assert.equal(err?.data?.reason, 'observation-gap')
    assert.equal(host.calls.length, 0)
  } finally {
    ws.dispose()
  }
})

test('T61/A1 响应契约：新字段类型不对 / 只给一半 → -32009', () => {
  const base = { applied: true, file: 'C:/ws/a.js', saved: false, textLength: 5 }
  const anchors = {
    version: 6, incarnation: INC_A, hash: hashText('x'), textLength: 1, dirty: false,
  }
  // ① 只给 attribution 不给锚点：整组要么一起给，要么都不给。
  assert.throws(() => validateResponse('vscode.applyEdit', { ...base, attribution: 'unknown' }),
    (err) => err.code === ERR.INVALID_RESPONSE)
  // ② 归属取值不在全集里。
  assert.throws(() => validateResponse('vscode.applyEdit', {
    ...base, operationId: 'op-1', attribution: 'trust-me', attributionReason: 'x',
    before: anchors, after: anchors,
  }), (err) => err.code === ERR.INVALID_RESPONSE)
  // ③ 锚点形状错（hash 不是 sha256）。
  assert.throws(() => validateResponse('vscode.applyEdit', {
    ...base, operationId: 'op-1', attribution: 'unknown', attributionReason: 'r',
    before: { ...anchors, hash: 'NOT-A-HASH' }, after: anchors,
  }), (err) => err.code === ERR.INVALID_RESPONSE)
  // ④ 齐全且合法 → 放行（既有四个字段的语义没被动过）。
  const ok = validateResponse('vscode.applyEdit', {
    ...base, operationId: 'op-1', attribution: 'unknown', attributionReason: 'r',
    before: anchors, after: { ...anchors, hash: null, incarnation: null, version: null },
  })
  assert.equal(ok.attribution, 'unknown')
  // ⑤ 老形状（完全没有归属字段）继续放行。
  assert.doesNotThrow(() => validateResponse('vscode.applyEdit', base))
})
