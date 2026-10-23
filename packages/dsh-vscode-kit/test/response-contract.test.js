/**
 * 测试：facade 出口的形状校验（契约 §5.1，`-32009 invalid-response`）。
 *
 * 守门目标（三条，缺一条这层就是空转）：
 *  1. **正常响应必须放行** —— 上一稿把 listOpenEditors 写成「必须是 Array」，
 *     每次正常响应都被判死。所以每条能力都有「合法形状放行」用例（含可选字段缺失）。
 *  2. **不合规必须拒** —— 缺字段 / 类型错 / 嵌套路径错 / undefined / null / 顶层数组。
 *  3. **不越界** —— `bridge.*` 与未登记方法不受形状约束；既有 -32004/-32005 不被包成 -32009。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VscodeKit, apply } from '../src/index.js'
import { BridgeError, ERR, ERR_NAME, connect, createLineSplitter } from '../src/protocol.js'
import {
  MIN_RESPONSE_EXPECTED, REGISTERED_METHODS, validateResponse,
} from '../src/response-contract.js'

/**
 * 测试消费者身份（T38 白名单落地后，**写类调用必须来自已绑定身份的入口**）。
 *
 * 这一行不是"为了跑通而加的胶水"：它把既有 135 处调用点的身份显式化 ——
 * 以前它们全都经 `ctx.provide` 出去的共享 facade，而那个 facade 现在**只能是 read**。
 * 档位给到 `delete` 是为了让本文件继续测**它本来要测的那道门**（会话授权绑定 / 锚点 / 响应形状），
 * 不被白名单挡在前面；白名单自己的用例在 `test/t38-whitelist.test.js`。
 */
const TEST_CONSUMER = 'dsh-kit-test'
const TEST_CONSUMERS = { [TEST_CONSUMER]: 'delete' }
const boundSvc = (ctx) => {
  const shared = ctx.provided.get('dshVscodeKit').v
  return shared.forPlugin(TEST_CONSUMER, { declared: 'delete' })
}


const HERE = dirname(fileURLToPath(import.meta.url))

/** 四条能力的**合法**响应（形状逐字对照契约 §5.1 第 3 条表格 + bridge handler 的真实返回）。 */
const VALID = {
  'vscode.openFile': { opened: true, path: '/ws/e2e/target.txt', mode: 'text' },
  'vscode.getSelection': {
    text: 'selected-text',
    file: '/ws/e2e.js',
    start: { line: 5, column: 1 },
    end: { line: 7, column: 9 },
    isEmpty: false,
  },
  'vscode.getDiagnostics': {
    total: 1,
    truncated: false,
    files: [{
      file: '/ws/a.js',
      diagnostics: [{
        severity: 'warning', line: 2, column: 3, message: 'unused var', source: 'eslint', code: 6133,
      }],
    }],
  },
  'vscode.listOpenEditors': {
    total: 2,
    truncated: false,
    editors: [{ file: '/ws/a.js', isActive: true, isDirty: false, languageId: 'javascript' }],
  },
}

/** 深拷一份合法响应供改写（避免用例之间互相污染）。 */
const clone = (method) => JSON.parse(JSON.stringify(VALID[method]))

/** 断言抛出的是 -32009，且 data 形状为 { method, got, expected }。 */
function assertInvalidResponse(fn, { method, at, expected } = {}) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof BridgeError, `应为 BridgeError，实际 ${err?.constructor?.name}`)
    assert.equal(err.code, ERR.INVALID_RESPONSE, `应为 -32009，实际 ${err.code}（${err.message}）`)
    assert.equal(err.code, -32009)
    assert.equal(ERR_NAME[err.code], 'invalid-response')
    assert.deepEqual(Object.keys(err.data).sort(), ['expected', 'got', 'method'],
      'data 只许有 method / got / expected 三个键（契约 §5.1 第 1 条）')
    assert.equal(err.data.method, method)
    assert.equal(typeof err.data.expected, 'string')
    assert.ok(err.data.expected.length > 0, 'expected 必须是能读的清单')
    assert.equal(typeof err.data.got.type, 'string', 'got 必须带类型摘要')
    if (at !== undefined) {
      assert.equal(err.data.got.at, at, `失败位置应是 ${at}，实际 ${err.data.got.at}`)
    }
    if (expected !== undefined) assert.equal(err.data.expected, expected)
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 正常响应放行（这一环是防「校验过严」的守门，千万别删）
// ─────────────────────────────────────────────────────────────────────────────

test('放行：四条能力的合法响应全部原样通过', () => {
  for (const [method, result] of Object.entries(VALID)) {
    const out = validateResponse(method, result)
    assert.equal(out, result, `${method}: 合法响应必须原样返回（不是拷贝、不是包装）`)
  }
})

test('放行：可选字段缺失（键不存在）不算错 —— 可选 = 「没给这个键」', () => {
  const editors = clone('vscode.listOpenEditors')
  delete editors.editors[0].languageId // handler 是 `{ ...(languageId ? { languageId } : {}) }`
  validateResponse('vscode.listOpenEditors', editors)
  assert.ok(!('languageId' in editors.editors[0]), '这一条必须是真删，不能只靠标题声称')

  const diags = clone('vscode.getDiagnostics')
  delete diags.files[0].diagnostics[0].source
  validateResponse('vscode.getDiagnostics', diags)
  assert.ok(!('source' in diags.files[0].diagnostics[0]), '这一条必须是真删，不能只靠标题声称')

  // 键存在但值是 undefined 也等同未提供（JSON 表达不了 undefined，进程内直连才可能出现）。
  const undefinedKeys = clone('vscode.listOpenEditors')
  undefinedKeys.editors[0].languageId = undefined
  validateResponse('vscode.listOpenEditors', undefinedKeys)
  const undefinedSource = clone('vscode.getDiagnostics')
  undefinedSource.files[0].diagnostics[0].source = undefined
  validateResponse('vscode.getDiagnostics', undefinedSource)

  // code 契约是 `code?:any`：number / string / {value,target} 都合法，不校验类型。
  for (const code of [6133, 'TS6133', { value: 'x', target: '/ws/a.js' }]) {
    const d = clone('vscode.getDiagnostics')
    d.files[0].diagnostics[0].code = code
    validateResponse('vscode.getDiagnostics', d)
  }

  // 数组为空 / total 为 0 也是合法返回（真机上常见）。
  validateResponse('vscode.getDiagnostics', { total: 0, truncated: false, files: [] })
  validateResponse('vscode.listOpenEditors', { total: 0, truncated: false, editors: [] })
  // 选区为空文本（isEmpty=true、text=''）同样合法。
  validateResponse('vscode.getSelection', {
    text: '', file: '/ws/a.js', start: { line: 1, column: 1 }, end: { line: 1, column: 1 }, isEmpty: true,
  })
  // openFile 的两种 mode 都合法。
  for (const mode of ['text', 'external']) {
    validateResponse('vscode.openFile', { opened: true, path: '/ws/x.png', mode })
  }
})

test('放行：可选字段给了正确类型照样放行（可选 ≠ 必填）', () => {
  const editors = clone('vscode.listOpenEditors')
  editors.editors[0].languageId = 'javascript' // 字符串 → 过
  validateResponse('vscode.listOpenEditors', editors)

  const diags = clone('vscode.getDiagnostics')
  diags.files[0].diagnostics[0].source = 'eslint' // 字符串 → 过
  validateResponse('vscode.getDiagnostics', diags)
})

test('★ 拒：可选字段是显式 null 时按类型谓词拒绝（契约是 string?，不是 string|null）', () => {
  // 评审 F1 的复现：null 曾被当「未提供」整体跳过，于是 editors[0].languageId=null 放行。
  const editors = clone('vscode.listOpenEditors')
  editors.editors[0].languageId = null
  assertInvalidResponse(() => validateResponse('vscode.listOpenEditors', editors), {
    method: 'vscode.listOpenEditors',
  })
  assert.throws(() => validateResponse('vscode.listOpenEditors', editors), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.at, 'editors[0].languageId', 'null 要在该字段上报，不能静默跳过')
    assert.equal(e.data.got.value, 'null', 'got.value 只报类型')
    assert.match(e.data.expected, /languageId\?:string/)
    return true
  })

  // 同一口径：诊断的 source=null 也必须拒（F1 里 source 的字符串谓词被同一分支绕过）。
  const diags = clone('vscode.getDiagnostics')
  diags.files[0].diagnostics[0].source = null
  assertInvalidResponse(() => validateResponse('vscode.getDiagnostics', diags), {
    method: 'vscode.getDiagnostics',
  })
  assert.throws(() => validateResponse('vscode.getDiagnostics', diags), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.at, 'files[0].diagnostics[0].source')
    assert.equal(e.data.got.value, 'null')
    assert.match(e.data.expected, /source\?:string/)
    return true
  })

  // code 是 `code?:any`（契约 §5.1 表格），不在可选字符串口径内 —— null 也合法，不许误伤。
  const coed = clone('vscode.getDiagnostics')
  coed.files[0].diagnostics[0].code = null
  validateResponse('vscode.getDiagnostics', coed)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 最低校验：undefined / null / 非对象（顶层数组也算非对象）
// ─────────────────────────────────────────────────────────────────────────────

test('拒：undefined / null / 非对象 / 顶层数组（所有能力都过这道）', () => {
  const bad = [undefined, null, 42, 0, 'ok', true, [], [VALID['vscode.openFile']], () => {}, Symbol('x')]
  for (const method of Object.keys(VALID)) {
    for (const result of bad) {
      assertInvalidResponse(() => validateResponse(method, result), { method })
    }
  }
})

test('拒：顶层数组不是对象（旧稿「listOpenEditors 必须是 Array」已撤销）', () => {
  // 四条能力的顶层都是对象外壳；数组只出现在字段里。
  const editorsArray = VALID['vscode.listOpenEditors'].editors
  assertInvalidResponse(() => validateResponse('vscode.listOpenEditors', editorsArray), {
    method: 'vscode.listOpenEditors',
  })
  // 传数组时的 got 必须自己说明是 array（不是含糊的 'object'）。
  assert.throws(
    () => validateResponse('vscode.listOpenEditors', editorsArray),
    (e) => e.data.got.type === 'array',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 逐能力：缺字段 + 类型错
// ─────────────────────────────────────────────────────────────────────────────

test('vscode.openFile：缺字段 / 类型错 / mode 越界', () => {
  const cases = [
    ['opened', (r) => { delete r.opened }, { at: 'opened', field: 'opened===true' }],
    ['opened=false', (r) => { r.opened = false }, { at: 'opened', field: 'opened===true' }],
    ['opened="true"', (r) => { r.opened = 'true' }, { at: 'opened', field: 'opened===true' }],
    ['path 缺失', (r) => { delete r.path }, { at: 'path', field: 'path:string(non-empty)' }],
    ['path 空串', (r) => { r.path = '' }, { at: 'path', field: 'path:string(non-empty)' }],
    ['path 空白串', (r) => { r.path = '   ' }, { at: 'path', field: 'path:string(non-empty)' }],
    ['path 非串', (r) => { r.path = 42 }, { at: 'path', field: 'path:string(non-empty)' }],
    ['mode 越界', (r) => { r.mode = 'binary' }, { at: 'mode', field: 'mode:in{text,external}' }],
    ['mode 缺失', (r) => { delete r.mode }, { at: 'mode', field: 'mode:in{text,external}' }],
  ]
  for (const [label, mutate, want] of cases) {
    const r = clone('vscode.openFile')
    mutate(r)
    assert.throws(() => validateResponse('vscode.openFile', r), (e) => {
      assert.equal(e.code, ERR.INVALID_RESPONSE, `${label}: ${e.message}`)
      assert.equal(e.data.got.at, want.at, `${label}: got.at`)
      // expected 是整条人能读的清单（契约 §5.1 第 1 条），里面点明是哪一项不合格。
      assert.ok(e.data.expected.includes(want.field), `${label}: expected=${e.data.expected}`)
      return true
    })
  }
})

test('vscode.getSelection：顶层字段缺失 / 类型错', () => {
  const cases = [
    ['text 缺失', (r) => { delete r.text }, 'text'],
    ['text 非串', (r) => { r.text = null }, 'text'],
    ['file 缺失', (r) => { delete r.file }, 'file'],
    ['file 空串', (r) => { r.file = '' }, 'file'],
    ['file 非串', (r) => { r.file = 7 }, 'file'],
    ['isEmpty 缺失', (r) => { delete r.isEmpty }, 'isEmpty'],
    ['isEmpty 非 bool', (r) => { r.isEmpty = 'false' }, 'isEmpty'],
    ['start 缺失', (r) => { delete r.start }, 'start'],
    ['start 非对象', (r) => { r.start = '1:1' }, 'start'],
    ['start 是数组', (r) => { r.start = [1, 1] }, 'start'],
    ['end 缺失', (r) => { delete r.end }, 'end'],
  ]
  for (const [label, mutate, at] of cases) {
    const r = clone('vscode.getSelection')
    mutate(r)
    assert.throws(() => validateResponse('vscode.getSelection', r), (e) => {
      assert.equal(e.code, ERR.INVALID_RESPONSE, `${label}: ${e.message}`)
      assert.equal(e.data.got.at, at, label)
      return true
    })
  }
})

test('★ vscode.getSelection 走的是嵌套路径 start.line / end.column（不是顶层 line/column）', () => {
  const cases = [
    ['start.line 缺失', (r) => { delete r.start.line }, 'start.line'],
    ['start.line=0（0-based 漏转）', (r) => { r.start.line = 0 }, 'start.line'],
    ['start.line=-1', (r) => { r.start.line = -1 }, 'start.line'],
    ['start.line 是小数', (r) => { r.start.line = 1.5 }, 'start.line'],
    ['start.line 是字符串', (r) => { r.start.line = '5' }, 'start.line'],
    ['start.column=0', (r) => { r.start.column = 0 }, 'start.column'],
    ['start.column 缺失', (r) => { delete r.start.column }, 'start.column'],
    ['end.line 缺失', (r) => { delete r.end.line }, 'end.line'],
    ['end.line 非整数', (r) => { r.end.line = null }, 'end.line'],
    ['end.column=0', (r) => { r.end.column = 0 }, 'end.column'],
    ['end.column 字符串', (r) => { r.end.column = '9' }, 'end.column'],
  ]
  for (const [label, mutate, at] of cases) {
    const r = clone('vscode.getSelection')
    mutate(r)
    assert.throws(() => validateResponse('vscode.getSelection', r), (e) => {
      assert.equal(e.code, ERR.INVALID_RESPONSE, `${label}: ${e.message}`)
      assert.equal(e.data.got.at, at, label)
      assert.match(e.data.expected, /start:\{line:int>=1,column:int>=1\}/, `${label}: expected 会写明嵌套路径`)
      return true
    })
  }

  // 反面：把坐标放顶层、start/end 只剩空对象 —— 正是旧稿认错的那个形状，必须拒。
  const misplaced = {
    text: 'x', file: '/ws/a.js', line: 5, column: 1, isEmpty: false, start: {}, end: {},
  }
  assert.throws(() => validateResponse('vscode.getSelection', misplaced), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.at, 'start.line', '顶层 line/column 不能代替 start.line')
    return true
  })
})

test('vscode.getDiagnostics：顶层字段 / files 元素 / 诊断元素逐层校验', () => {
  const cases = [
    ['total 缺失', (r) => { delete r.total }, 'total'],
    ['total=-1', (r) => { r.total = -1 }, 'total'],
    ['total 是字符串', (r) => { r.total = '1' }, 'total'],
    ['total 是小数', (r) => { r.total = 0.5 }, 'total'],
    ['truncated 缺失', (r) => { delete r.truncated }, 'truncated'],
    ['truncated 非 bool', (r) => { r.truncated = 0 }, 'truncated'],
    ['files 缺失', (r) => { delete r.files }, 'files'],
    ['files 非数组', (r) => { r.files = { 0: {} } }, 'files'],
    ['files 元素非对象', (r) => { r.files = ['/ws/a.js'] }, 'files[0]'],
    ['元素 file 缺失', (r) => { delete r.files[0].file }, 'files[0].file'],
    ['元素 file 空串', (r) => { r.files[0].file = '' }, 'files[0].file'],
    ['diagnostics 缺失', (r) => { delete r.files[0].diagnostics }, 'files[0].diagnostics'],
    ['diagnostics 非数组', (r) => { r.files[0].diagnostics = 'x' }, 'files[0].diagnostics'],
    ['诊断元素非对象', (r) => { r.files[0].diagnostics = ['boom'] }, 'files[0].diagnostics[0]'],
    ['severity 越界', (r) => { r.files[0].diagnostics[0].severity = 'fatal' },
      'files[0].diagnostics[0].severity'],
    ['severity 缺失', (r) => { delete r.files[0].diagnostics[0].severity },
      'files[0].diagnostics[0].severity'],
    ['诊断 line=0', (r) => { r.files[0].diagnostics[0].line = 0 }, 'files[0].diagnostics[0].line'],
    ['诊断 column=0', (r) => { r.files[0].diagnostics[0].column = 0 },
      'files[0].diagnostics[0].column'],
    ['诊断 message 缺失', (r) => { delete r.files[0].diagnostics[0].message },
      'files[0].diagnostics[0].message'],
    ['诊断 message 非串', (r) => { r.files[0].diagnostics[0].message = 1 },
      'files[0].diagnostics[0].message'],
    ['source 类型错', (r) => { r.files[0].diagnostics[0].source = 123 },
      'files[0].diagnostics[0].source'],
  ]
  for (const [label, mutate, at] of cases) {
    const r = clone('vscode.getDiagnostics')
    mutate(r)
    assert.throws(() => validateResponse('vscode.getDiagnostics', r), (e) => {
      assert.equal(e.code, ERR.INVALID_RESPONSE, `${label}: ${e.message}`)
      assert.equal(e.data.got.at, at, label)
      return true
    })
  }
})

test('★ vscode.listOpenEditors 元素字段名是 file，不是 path', () => {
  const r = clone('vscode.listOpenEditors')
  r.editors[0].path = r.editors[0].file
  delete r.editors[0].file
  assert.throws(() => validateResponse('vscode.listOpenEditors', r), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.at, 'editors[0].file', '缺 file 要在 file 上报，不能容忍 path 顶替')
    assert.match(e.data.expected, /file:string\(non-empty\)/)
    return true
  })

  const cases = [
    ['total 缺失', (r2) => { delete r2.total }, 'total'],
    ['total=-1', (r2) => { r2.total = -1 }, 'total'],
    ['truncated 非 bool', (r2) => { r2.truncated = 'no' }, 'truncated'],
    ['editors 缺失', (r2) => { delete r2.editors }, 'editors'],
    ['editors 非数组', (r2) => { r2.editors = '/ws/a.js' }, 'editors'],
    ['元素非对象', (r2) => { r2.editors = [null] }, 'editors[0]'],
    ['isActive 缺失', (r2) => { delete r2.editors[0].isActive }, 'editors[0].isActive'],
    ['isActive 非 bool', (r2) => { r2.editors[0].isActive = 1 }, 'editors[0].isActive'],
    ['isDirty 缺失', (r2) => { delete r2.editors[0].isDirty }, 'editors[0].isDirty'],
    ['isDirty 非 bool', (r2) => { r2.editors[0].isDirty = 'no' }, 'editors[0].isDirty'],
    ['languageId 类型错', (r2) => { r2.editors[0].languageId = 42 }, 'editors[0].languageId'],
  ]
  for (const [label, mutate, at] of cases) {
    const r2 = clone('vscode.listOpenEditors')
    mutate(r2)
    assert.throws(() => validateResponse('vscode.listOpenEditors', r2), (e) => {
      assert.equal(e.code, ERR.INVALID_RESPONSE, `${label}: ${e.message}`)
      assert.equal(e.data.got.at, at, label)
      return true
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) got 摘要不得倾泻响应体（响应里可能有选区文本）
// ─────────────────────────────────────────────────────────────────────────────

test('★ 错误里不许带响应体内容：got 只有 typeof / 键名摘要', () => {
  const SECRET = 'TOP-SECRET-SELECTION-TEXT'
  const r = clone('vscode.getSelection')
  r.text = SECRET
  r.end = { line: SECRET, column: 3 } // 把秘密塞进一个**非字符串字段**，最容易漏出去

  assert.throws(() => validateResponse('vscode.getSelection', r), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    const dump = JSON.stringify(e.data) + e.message + JSON.stringify(e.toJSON?.() ?? {})
    assert.ok(!dump.includes(SECRET), `错误对象泄露了响应体内容: ${dump}`)
    assert.equal(e.data.got.at, 'end.line')
    assert.equal(e.data.got.value, 'string', 'got.value 只报类型，不回显字符串')
    assert.equal(e.data.got.type, 'object')
    assert.deepEqual([...e.data.got.keys].sort(),
      ['end', 'file', 'isEmpty', 'start', 'text'], 'got.keys 允许有键名（摘要），但键名≠内容')
    return true
  })
})

test('★ 数值 / 布尔哨兵也不许回显：got.value 与 message 都只含类型', () => {
  // 评审 F2 的复现：只把 end.line 设成一个哨兵整数，就曾在 JSON.stringify(err) 里
  // 看到 `"value":"number(-8675309123)"`，message 同样带
  // `number(-8675309123) at end.line`。契约只允许 typeof / 键名摘要。
  const NUM_SENTINEL = -8675309123
  const r = clone('vscode.getSelection')
  r.end.line = NUM_SENTINEL

  assert.throws(() => validateResponse('vscode.getSelection', r), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    const whole = JSON.stringify(e) + JSON.stringify(e.data) + e.message
      + JSON.stringify(e.toJSON?.() ?? {})
    assert.ok(!whole.includes(String(NUM_SENTINEL)),
      `错误对象回显了响应里的数值哨兵 ${NUM_SENTINEL}: ${whole}`)
    assert.ok(!whole.includes('8675309123'), `错误对象含哨兵片段: ${whole}`)
    assert.ok(!whole.includes('number('), `不许出现 number(值) 形式: ${whole}`)
    assert.equal(e.data.got.at, 'end.line')
    assert.equal(e.data.got.value, 'number', 'got.value 只报类型')
    assert.ok(e.message.includes('number at end.line'), `message 只拼脱敏摘要: ${e.message}`)
    return true
  })

  // 布尔哨兵：opened=false 会撞上 `opened === true` 谓词，旧实现回显 boolean(false)。
  const bool = clone('vscode.openFile')
  bool.opened = false
  assert.throws(() => validateResponse('vscode.openFile', bool), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    const whole = JSON.stringify(e) + JSON.stringify(e.data) + e.message
    assert.ok(!/boolean\((true|false)\)/.test(whole), `错误对象回显了布尔值: ${whole}`)
    assert.equal(e.data.got.value, 'boolean', 'got.value 只报类型')
    assert.ok(!e.message.includes('boolean('), `message 含布尔回显: ${e.message}`)
    assert.equal(e.data.got.at, 'opened')
    return true
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5) 边界：bridge.* 与未登记方法
// ─────────────────────────────────────────────────────────────────────────────

test('不越界：bridge.* 不在管辖内（协议层协商，返回值任意）', () => {
  assert.equal(validateResponse('bridge.ping', undefined), undefined)
  validateResponse('bridge.ping', null)
  validateResponse('bridge.hello', { ok: true })
})

test('未登记方法只做最低校验：对象放行、非对象抛 -32009', () => {
  // 将来新增的能力在登记形状之前就走这条路：不许因为「没登记」就全拒。
  const obj = { whatever: 1 }
  assert.equal(validateResponse('vscode.someFutureCapability', obj), obj)
  for (const method of ['vscode.someFutureCapability', 'vscode.diff']) {
    for (const bad of [undefined, null, [], 'x']) {
      assertInvalidResponse(() => validateResponse(method, bad), {
        method, expected: MIN_RESPONSE_EXPECTED,
      })
    }
  }
})

test('★ 结构：bridge 声明的每个能力都必须登记返回形状（新能力别只看最低校验）', () => {
  const capsPath = join(HERE, '../../dsh-kit-bridge/src/capabilities.js')
  if (!existsSync(capsPath)) {
    // kit 允许单独跑测试；桥包不在时跳过（monorepo 里必然存在，这条守门是有效的）。
    return
  }
  return import(pathToFileURL(capsPath).href).then(({ CAPABILITIES }) => {
    assert.ok(Array.isArray(CAPABILITIES) && CAPABILITIES.length > 0)
    const missing = CAPABILITIES.filter((m) => !REGISTERED_METHODS.includes(m))
    assert.deepEqual(missing, [],
      `这些能力在 capabilities.js 里已发布，但 response-contract.js 的 RESPONSE_CONTRACTS 没登记形状：${missing.join(', ')}`)
    // 反向：登记了但桥包没声明 —— 只是脏数据，不判死，但要说出来。
    const extra = REGISTERED_METHODS.filter((m) => !CAPABILITIES.includes(m))
    assert.deepEqual(extra, [], `response-contract.js 登记了桥包不存在的能力：${extra.join(', ')}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6) facade 出口：经由 VscodeKit.request（糖衣方法就是它的一行转发）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 白盒：一个带假对端的 VscodeKit。
 *
 * 假 link 的 request 直接返回给定值（或抛给定错误），这样能把「任意畸形返回」精确喂到
 * facade 出口，不必绕 TCP —— TCP 那半边另有一条真 socket 用例（见文件末尾）。
 */
function kitWith(resultOrError) {
  const link = {
    connSeq: 1,
    socket: { destroyed: false },
    editor: { client: 'fake', extensionVersion: '0.1.0', protocolVersion: 1, capabilities: Object.keys(VALID) },
    async request() {
      if (resultOrError instanceof Error) throw resultOrError
      return resultOrError
    },
    notify() {},
  }
  return new VscodeKit({
    server: { trusted: new Set([link]) }, dshVersion: 't', connectWaitMs: 0, helloWaitMs: 0, onLog: () => {},
  })
}

test('★ 执行点在 facade：糖衣方法拿到畸形响应也抛 -32009（不是把畸形值交给消费者）', async () => {
  const bad = clone('vscode.getSelection')
  delete bad.start

  await assert.rejects(kitWith(bad).vscode.getSelection(), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.method, 'vscode.getSelection')
    assert.equal(e.data.got.at, 'start')
    return true
  })
  // raw request() 与糖衣同一条闸。
  await assert.rejects(
    kitWith(bad).request('vscode.getSelection', {}, { waitForEditor: false }),
    (e) => e.code === ERR.INVALID_RESPONSE,
  )
  // 合法响应照旧穿过去（防「校验把正常路径判死」）。
  const ok = clone('vscode.getSelection')
  assert.deepEqual(await kitWith(ok).vscode.getSelection(), ok)
})

test('★ undefined 不许原样交给上层：未回应 result 的响应在 facade 出口就被拦下', async () => {
  await assert.rejects(kitWith(undefined).vscode.openFile(), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.type, 'undefined')
    return true
  })
  await assert.rejects(kitWith(null).vscode.listOpenEditors(), (e) => {
    assert.equal(e.code, ERR.INVALID_RESPONSE)
    assert.equal(e.data.got.type, 'null')
    return true
  })
})

test('不包装既有失败路径：-32005 / -32004 / -32008 原样上浮（不是 -32009）', async () => {
  const cases = [
    new BridgeError(ERR.UNSUPPORTED, 'capability not implemented: vscode.diff', { method: 'vscode.diff' }),
    new BridgeError(ERR.TIMEOUT, 'request timed out after 100ms', { method: 'vscode.getSelection' }),
    new BridgeError(ERR.NOT_FOUND, 'no such file', { method: 'vscode.openFile' }),
    new BridgeError(ERR.PROTOCOL_INCOMPATIBLE, 'peer protocolVersion is 9', { method: 'vscode.getSelection' }),
  ]
  for (const err of cases) {
    await assert.rejects(kitWith(err).request('vscode.getSelection', {}, { waitForEditor: false }), (e) => {
      assert.equal(e, err, `必须是同一个错误对象（不许包一层）`)
      assert.equal(e.code, err.code)
      return true
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7) 真 socket：无 result 的响应帧（wire 上的 undefined）也走同一道闸
// ─────────────────────────────────────────────────────────────────────────────

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-32009-'))
}

function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v, check) { provided.set(n, { v, check }) },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    runDisposers() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d() } catch { /* 卸载失败不影响其它清理 */ }
      }
    },
  }
}

test('真 socket：对端回一条「既无 result 也无 error」的响应帧 → 消费者拿到 -32009', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)

  const socket = createConnection({ port: handle.kit.server.port, host: '127.0.0.1' })
  const link = connect({
    write: (l) => socket.write(l),
    token: handle.kit.server.token,
    // 故意不回应 result：直接写一条只有 id 的帧，让对端 resolve(undefined)。
    onRequest: (method, params, c) => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: c.id })}\n`)
      return new Promise(() => {}) // 永不 settle：抑制库默认的 respond(null)
    },
  })
  const feed = createLineSplitter((line) => link.handleLine(line))
  socket.on('data', feed)
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })

  try {
    await link.request('bridge.hello', {
      client: 'fake', extensionVersion: '0.1.0', protocolVersion: 1, capabilities: ['vscode.getSelection'],
    })
    await assert.rejects(
      svc.request('vscode.getSelection', {}, { waitForEditor: false }),
      (e) => {
        assert.equal(e.code, ERR.INVALID_RESPONSE, `实际 ${e.code} ${e.message}`)
        assert.equal(e.data.method, 'vscode.getSelection')
        assert.equal(e.data.got.type, 'undefined', 'wire 上没有 result 字段 = undefined')
        return true
      },
    )
  } finally {
    socket.destroy()
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})
