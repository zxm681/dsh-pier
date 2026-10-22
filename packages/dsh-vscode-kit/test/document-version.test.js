/**
 * T30（DSH 侧）：`-32012` 错误码、`vscode.applyEdit` 的版本锚点、`vscode.getDocumentState`。
 *
 * 这层只守两件事，都发生在**请求出门之前 / 响应进门之后**：
 *  ① **本地闸**：`kit.vscode.applyEdit(...)` 缺 `expectedVersion` 就地拒（`-32602`，
 *     `data.stage === 'local'`），`request` **零调用** —— 安全路径必须成为唯一路径。
 *  ② **形状契约**：`vscode.getDocumentState` 的返回清单（含 `text` / `textUnavailable`
 *     互斥、`text.length === textLength` 这类跨字段一致性），以及 `applyEdit` 的返回形状
 *     一字未变（`saved === false` 仍是业务承诺）。
 *
 * 判序（`applyEdit` 内部）：路径 → 版本 → range 形状/越界 → expectedRangeText → 写宿主。
 * 桥侧对这套判序的逐条验证在 `packages/dsh-kit-bridge/test/document-version.test.js`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VscodeKit } from '../src/index.js'
import { BridgeError, ERR, ERR_NAME, PROTOCOL_VERSION } from '../src/protocol.js'
import { REGISTERED_METHODS, validateResponse } from '../src/response-contract.js'

// ---------------------------------------------------------------------------
// 脚手架：只隔离糖衣层 —— `request` 换成探针，协议/授权/网络由别的文件守
// ---------------------------------------------------------------------------

/** 一个带探针 `request` 的 kit：记录每一次「本会出门」的调用。 */
function kitSpy() {
  const sent = []
  const kit = new VscodeKit({
    server: { trusted: new Set(), port: 0 },
    dshVersion: 'test',
    connectWaitMs: 0,
    helloWaitMs: 0,
    onLog: () => {},
  })
  kit.request = async (method, params, opts) => {
    sent.push({ method, params, opts })
    return { applied: true, file: params.file, saved: false, textLength: 0 }
  }
  return { kit, sent }
}

const FILE = '/ws/a.js'
const RANGE = { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }
const GRANT = { id: 'a'.repeat(32), epoch: 'b'.repeat(32) }

// ---------------------------------------------------------------------------
// ① 错误码：只加不改
// ---------------------------------------------------------------------------

test('T30 协议：-32012 document-version-conflict 只加码，既有码与协议版本一字未动', () => {
  assert.equal(ERR.DOCUMENT_VERSION_CONFLICT, -32012)
  assert.equal(ERR_NAME[-32012], 'document-version-conflict')
  // 紧邻 -32010，且 -32011 仍是空位（没有偷偷占用邻居的名字）
  assert.equal(ERR.EDIT_NOT_BOUND, -32010)
  assert.equal(ERR_NAME[-32011], undefined)
  // 既有码不许动：这些数字一旦漂移，两侧判定就整体错位
  assert.equal(ERR.INVALID_PARAMS, -32602)
  assert.equal(ERR.INVALID_RESPONSE, -32009)
  assert.equal(PROTOCOL_VERSION, 1, '加一个错误码不改协议版本：旧端只是收不到这条错误')

  // 能原样跨线往返（-32012 的 data 是结构化对象，序列化后必须还原）
  const round = BridgeError.from({
    code: ERR.DOCUMENT_VERSION_CONFLICT,
    message: 'stale',
    data: { file: FILE, expected: 1, actual: 2 },
  })
  assert.equal(round.code, -32012)
  assert.deepEqual(round.data, { file: FILE, expected: 1, actual: 2 })
})

// ---------------------------------------------------------------------------
// ② 本地闸：缺锚点的写入不许出门
// ---------------------------------------------------------------------------

test('T30 ★ 缺 expectedVersion（位置形态 applyEdit(file,range,text)）→ 本地 -32602，request 零调用', async () => {
  const { kit, sent } = kitSpy()
  await assert.rejects(kit.vscode.applyEdit(FILE, RANGE, 'HELLO'), (err) => {
    assert.equal(err.code, ERR.INVALID_PARAMS)
    assert.equal(err.data.stage, 'local', '明确标出是本地拦的，不是对端回的')
    assert.equal(err.data.reason, 'expected-version-missing')
    assert.equal(err.data.method, 'vscode.applyEdit')
    assert.match(err.message, /expectedVersion/)
    return true
  })
  assert.deepEqual(sent, [], '安全路径必须成为唯一路径：这条路一个字节都不许出门')
})

test('T30 ★ 缺 expectedVersion（对象形态 applyEdit(params)）→ 本地 -32602，request 零调用', async () => {
  const { kit, sent } = kitSpy()
  await assert.rejects(
    kit.vscode.applyEdit({ file: FILE, range: RANGE, text: 'HELLO' }),
    (err) => err.code === ERR.INVALID_PARAMS && err.data.reason === 'expected-version-missing')
  assert.deepEqual(sent, [])
})

test('T30 ★ expectedVersion 形状不对（字符串 / 小数 / 负数 / null）→ 本地 -32602，四种原因各不相同', async () => {
  const { kit, sent } = kitSpy()
  const cases = [
    ['1', 'expected-version-not-a-number'],
    [1.5, 'expected-version-not-an-integer'],
    [-3, 'expected-version-negative'],
    [null, 'expected-version-not-a-number'],
  ]
  for (const [value, reason] of cases) {
    await assert.rejects(
      kit.vscode.applyEdit(FILE, RANGE, 'HELLO', { expectedVersion: value }),
      (err) => err.code === ERR.INVALID_PARAMS && err.data.reason === reason,
      `expectedVersion=${JSON.stringify(value)}`)
  }
  assert.deepEqual(sent, [])
})

test('T30 ★ expectedVersion=0 是合法值（空文件/新文档的版本就是 0）', async () => {
  const { kit, sent } = kitSpy()
  await kit.vscode.applyEdit(FILE, RANGE, 'HELLO', { expectedVersion: 0 })
  assert.equal(sent.length, 1, '0 不许被当成"没给"')
})

// ---------------------------------------------------------------------------
// ③ 放行：锚点与 grant 一起进 params，传输选项留在 opts
// ---------------------------------------------------------------------------

test('T30 位置形态带锚：锚点/grant 提升进 params，opts 只留传输选项', async () => {
  const { kit, sent } = kitSpy()
  await kit.vscode.applyEdit(FILE, RANGE, 'HELLO', {
    expectedVersion: 7, expectedRangeText: 'hello', grant: GRANT, timeoutMs: 1234,
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, 'vscode.applyEdit')
  assert.deepEqual(sent[0].params, {
    file: FILE, range: RANGE, text: 'HELLO', expectedVersion: 7, expectedRangeText: 'hello', grant: GRANT,
  })
  assert.deepEqual(sent[0].opts, { expectedVersion: 7, expectedRangeText: 'hello', grant: GRANT, timeoutMs: 1234 },
    'opts 原样往下传（timeoutMs 这类传输选项不许被糖衣吞掉）')
})

test('T30 对象形态带锚：params 原样转发，opts 只作传输选项', async () => {
  const { kit, sent } = kitSpy()
  await kit.vscode.applyEdit(
    { file: FILE, range: RANGE, text: 'HELLO', expectedVersion: 7, grant: GRANT },
    { timeoutMs: 500 },
  )
  assert.deepEqual(sent[0].params,
    { file: FILE, range: RANGE, text: 'HELLO', expectedVersion: 7, grant: GRANT })
  assert.deepEqual(sent[0].opts, { timeoutMs: 500 })
})

test('T32 ★ 四个入口归一化到**同一份** params（位置 / 对象 与 raw request 一字不差）', async () => {
  // 判卷要求"四个入口一致"，本文件负责**前半句**：三种写法出门时是同一份 params，
  // `expectedRangeText` 分支只多那一个字段。后半句（四种参数形态都受**同一处事务内判定**
  // 保护）在 `packages/dsh-kit-bridge/test/edit-transaction.test.js` 的 ★ 用例里。
  //
  // 这条归一化是"一致"的**前提**：只要有一处自己拼参数，锚点就可能被吞掉或改名，
  // 而能力层的前置检查**不是保证**（评审 T31-B1：前置检查过了之后缓冲区还能被改），
  // 真正的保证只有写事务内部那一次 `document.version` 比对 —— 那份 params 必须原样到达它。
  const raw = { file: FILE, range: RANGE, text: 'HELLO', expectedVersion: 7, grant: GRANT }

  const rawSpy = kitSpy() // ① raw request：消费者自己组参，直接 request（基准，零归一化）
  await rawSpy.kit.request('vscode.applyEdit', { ...raw })

  const objectSpy = kitSpy() // ② 对象形态：applyEdit(params)
  await objectSpy.kit.vscode.applyEdit({ ...raw })

  const positionalSpy = kitSpy() // ③ 位置形态：applyEdit(file, range, text, opts)
  await positionalSpy.kit.vscode.applyEdit(FILE, RANGE, 'HELLO', { expectedVersion: 7, grant: GRANT })

  const rangeTextSpy = kitSpy() // ④ expectedRangeText 分支
  await rangeTextSpy.kit.vscode.applyEdit({ ...raw, expectedRangeText: 'hello' })

  assert.deepEqual(rawSpy.sent[0].params, raw)
  assert.deepEqual(objectSpy.sent[0].params, raw, '对象形态与 raw 一字不差')
  assert.deepEqual(positionalSpy.sent[0].params, raw, '位置形态与 raw 一字不差')
  assert.deepEqual(rangeTextSpy.sent[0].params, { ...raw, expectedRangeText: 'hello' },
    'expectedRangeText 分支只多这一个字段（锚点不许被它挤掉）')
  // 字面相等（含键序）：锚点一旦被谁改名/重排，这里就红。
  assert.equal(JSON.stringify(positionalSpy.sent[0].params), JSON.stringify(rawSpy.sent[0].params))
})

test('T30 ★ getDocumentState：includeText 是业务参数，必须进 params（真机踩过：留在 opts 里宿主收不到）', async () => {
  const { kit, sent } = kitSpy()
  assert.equal(typeof kit.vscode.getDocumentState, 'function')
  await kit.vscode.getDocumentState(FILE)
  await kit.vscode.getDocumentState(FILE, { includeText: true, timeoutMs: 99 })
  await kit.vscode.getDocumentState({ file: FILE, includeText: true })
  await kit.vscode.getDocumentState({ file: FILE }, { includeText: true })
  assert.deepEqual(sent.map((s) => s.method), Array(4).fill('vscode.getDocumentState'))
  assert.deepEqual(sent[0].params, { file: FILE }, '不给 includeText 就不带（能力层按缺省处理）')
  // 这一条是真机验出来的回归：`includeText` 留在 opts 里时，请求体里没有它，
  // 扩展侧永远按"不要文本"处理 —— 于是 `{textLength}` 且既无 text 也无 textUnavailable。
  assert.deepEqual(sent[1].params, { file: FILE, includeText: true },
    'includeText 必须提升进请求参数（决定宿主给不给全文的那一位）')
  assert.equal(sent[1].opts.timeoutMs, 99, 'timeoutMs 才是传输选项，留在 opts')
  assert.deepEqual(sent[2].params, { file: FILE, includeText: true })
  assert.deepEqual(sent[3].params, { file: FILE, includeText: true }, '对象形态也要接受第二个参数里的 includeText')
})

// ---------------------------------------------------------------------------
// ④ 响应形状：getDocumentState 登记了，applyEdit 一字未变
// ---------------------------------------------------------------------------

const VALID_STATE = {
  file: FILE, version: 3, isDirty: false, eol: 'lf', lineCount: 12, textLength: 240,
}

test('T30 getDocumentState 合法形状放行（含 includeText 与 textUnavailable 两种可选形态）', () => {
  assert.equal(REGISTERED_METHODS.includes('vscode.getDocumentState'), true)
  assert.equal(REGISTERED_METHODS.includes('vscode.applyEdit'), true)
  assert.equal(validateResponse('vscode.getDocumentState', VALID_STATE), VALID_STATE)
  // includeText:true 的"给了全文"
  assert.doesNotThrow(() => validateResponse('vscode.getDocumentState',
    { ...VALID_STATE, textLength: 5, text: 'hello' }))
  // 超限的"整份没给"
  assert.doesNotThrow(() => validateResponse('vscode.getDocumentState',
    { ...VALID_STATE, textUnavailable: true }))
  // 空文件：text 是空串，也是合法值
  assert.doesNotThrow(() => validateResponse('vscode.getDocumentState',
    { ...VALID_STATE, lineCount: 1, textLength: 0, text: '' }))
})

test('T30 ★ getDocumentState 畸形形状 → -32009：坏 version / 坏 eol / text 与 textUnavailable 并存 / 长度不自洽', () => {
  const cases = [
    ['version 是字符串', { ...VALID_STATE, version: '3' }, 'version'],
    ['version 负数', { ...VALID_STATE, version: -1 }, 'version'],
    ['eol 不在枚举内', { ...VALID_STATE, eol: 'cr' }, 'eol'],
    ['lineCount 为 0', { ...VALID_STATE, lineCount: 0 }, 'lineCount'],
    ['缺 file', { version: 3, isDirty: false, eol: 'lf', lineCount: 1, textLength: 0 }, 'file'],
    // 跨字段：两个都给出来时消费者该信谁？不许猜。
    ['text 与 textUnavailable 并存',
      { ...VALID_STATE, textUnavailable: true, text: 'x' }, '(result)'],
    // 截断后当全文的典型破相：长度对不上
    ['text 长度与 textLength 不一致',
      { ...VALID_STATE, textLength: 240, text: 'truncated' }, '(result)'],
    // textUnavailable 只能是 true（回 false 说明语义被搞混）
    ['textUnavailable:false', { ...VALID_STATE, textUnavailable: false }, 'textUnavailable'],
  ]
  for (const [label, result, at] of cases) {
    assert.throws(() => validateResponse('vscode.getDocumentState', result), (err) => {
      assert.equal(err.code, ERR.INVALID_RESPONSE, label)
      assert.equal(err.data.method, 'vscode.getDocumentState')
      assert.equal(err.data.got.at, at, `${label}: 断在 ${at}`)
      return true
    }, label)
  }
})

test('T30 applyEdit 返回形状一字未变：saved 必须是 false（加锚点没有放松"绝不落盘"）', () => {
  const ok = { applied: true, file: FILE, saved: false, textLength: 5 }
  assert.equal(validateResponse('vscode.applyEdit', ok), ok)
  assert.throws(() => validateResponse('vscode.applyEdit', { ...ok, saved: true }),
    (err) => err.code === ERR.INVALID_RESPONSE && err.data.got.at === 'saved')
  // 加锚点后仍**不许**多出"版本/冲突"字段来暗示成功语义（判定是前置条件，不是返回内容）
  assert.throws(() => validateResponse('vscode.applyEdit', { applied: true, file: FILE, textLength: 5 }),
    (err) => err.code === ERR.INVALID_RESPONSE && err.data.got.at === 'saved')
})
