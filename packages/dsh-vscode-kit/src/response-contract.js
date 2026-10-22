/**
 * facade 出口的响应形状校验 —— 协议码 `-32009 invalid-response`（契约 §5.1）。
 *
 * 零依赖，只 import 同目录的 protocol.js。
 *
 * ## 为什么在这一层
 *
 * 协议层（protocol.js 的 handleMessage 响应分支）只判断「有没有 error」：有就
 * `reject(BridgeError.from(...))`，没有就把 `msg.result` 原样 resolve。成功结果的**形状**
 * 无人过问 —— 对端漏字段 / 类型漂移 / 坐标基准写错（0-based vs 1-based），畸形值会一路
 * 传到消费者手里，报错点离根因很远（甚至静默，比如 `sel.text` 拿到 undefined）。
 *
 * 契约 §5.1 冻结的落点是 **facade 出口**：`VscodeKit.request()` 把结果交回调用方之前
 * （糖衣方法 `kit.vscode.*` 就是 `request()` 的一行转发，所以校验在它们返回之前生效）。
 * 校验**只许新增在这一层**：不许改 bridge 侧 handler 的已发布返回，也不许改协议层的
 * 响应识别分支（契约 §5.1「校验的边界」）。
 *
 * ## 覆盖范围
 *
 * - 只管 `vscode.*` 能力调用（CAPABILITY_NAMESPACE）。`bridge.ping` / `bridge.hello`
 *   是协议层协商，不在范围内；`waitReady` / `ready` / `notify` / `snapshot` 不经过本模块。
 * - **所有** `vscode.*` 能力都过最低校验：拒 `undefined` / `null` / 非对象。
 *   顶层数组也算非对象 —— 四条能力的顶层都是对象外壳，数组只出现在字段里。
 * - 已发布能力按契约 §5.1 表格逐字校验，清单集中在 RESPONSE_CONTRACTS。
 * - 未登记的方法**只有**最低校验（向后兼容：将来新增能力不会因为没登记就被判死）。
 *
 * ## ★ 新增能力时的义务
 *
 * 在 `packages/dsh-kit-bridge/src/capabilities.js` 的 CAPABILITIES 里加条目的**同时**，
 * 必须往下面 RESPONSE_CONTRACTS 登记返回形状，否则这条能力只有最低校验 ——
 * test/response-contract.test.js 会点名未登记的能力。
 *
 * ## 不做的事（契约 §5.1「校验的边界」）
 *
 * - 不查业务语义：路径是否真存在、选区是否为空、诊断是否可信，都不在本模块职责内。
 * - 不为迎合校验去改 handler 的已发布返回。
 * - 不把畸形响应当成 -32005（那是「方法不存在」）。本模块只处理**成功返回**；
 *   `-32004` / `-32005` / `-32008` 等既有失败路径在到达这里之前就已 reject，原样上浮。
 * - 不把响应体倾泻进错误：响应里可能有选区文本，`data.got` 只留 typeof 与键名摘要。
 */

import { BridgeError, ERR } from './protocol.js'

/** 能力命名空间：只有这个前缀的方法在形状校验管辖内。 */
export const CAPABILITY_NAMESPACE = 'vscode.'

/** 未登记方法的最低要求（人能读的清单，直接进 `data.expected`）。 */
export const MIN_RESPONSE_EXPECTED = 'object (non-null, non-array)'

/** `got.keys` 最多列几个键名（超出的只报到数量，避免巨型响应撑爆错误）。 */
const MAX_KEY_NAMES = 12

const OPEN_MODES = ['text', 'external']
const SEVERITIES = ['error', 'warning', 'info', 'hint']

// ── 值谓词：只判「存在 + 类型 + 坐标基准」，不判业务语义 ────────────────────────

const isString = (v) => typeof v === 'string'
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''
const isBoolean = (v) => typeof v === 'boolean'
const oneOf = (...allowed) => (v) => allowed.includes(v)
const isIntegerAtLeast = (min) => (v) => Number.isInteger(v) && v >= min

/** 本模块的「对象」口径：排除 null 与顶层数组（契约 §5.1 第 2 条）。 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 已发布能力的返回形状清单（契约 §5.1 第 3 条表格，逐字对应）。
 *
 * 结构：
 * - `expected`：人能读的完整清单，失败时原样进 `data.expected`。
 * - `fields`：`[路径, 谓词, 标签]`，路径用点号表示嵌套（`start.line` 是**嵌套**路径，
 *   不是顶层 `line` —— VSCode 的 position 就是 `{line, character}`）。
 * - `arrays`：`{ path, fields, optional, arrays }`，逐元素校验；元素内的数组可再套一层。
 * - `optional`：**只有「没给这个键」才算可选**。键不存在 / 值为 `undefined` → 跳过；
 *   显式 `null` 是「给了值」，必须过类型谓词并被拒（契约是 `languageId?:string`，
 *   不是 `string|null`）。
 */
const RESPONSE_CONTRACTS = Object.freeze({
  'vscode.openFile': {
    expected: 'object with opened===true, path:string(non-empty), mode:in{text,external}',
    fields: [
      ['opened', (v) => v === true, 'opened===true'],
      ['path', isNonEmptyString, 'path:string(non-empty)'],
      ['mode', oneOf(...OPEN_MODES), 'mode:in{text,external}'],
    ],
  },

  'vscode.getSelection': {
    expected: 'object with text:string, file:string(non-empty), '
      + 'start:{line:int>=1,column:int>=1}, end:{line:int>=1,column:int>=1}, isEmpty:boolean',
    fields: [
      ['text', isString, 'text:string'],
      ['file', isNonEmptyString, 'file:string(non-empty)'],
      // 先要求容器是对象，再逐字段查嵌套路径：漏了 `start` 时报的是 start 而不是 start.line。
      ['start', isObject, 'start:object'],
      ['start.line', isIntegerAtLeast(1), 'start.line:int>=1'],
      ['start.column', isIntegerAtLeast(1), 'start.column:int>=1'],
      ['end', isObject, 'end:object'],
      ['end.line', isIntegerAtLeast(1), 'end.line:int>=1'],
      ['end.column', isIntegerAtLeast(1), 'end.column:int>=1'],
      ['isEmpty', isBoolean, 'isEmpty:boolean'],
    ],
  },

  'vscode.getDiagnostics': {
    expected: 'object with total:int>=0, truncated:boolean, files:array of '
      + '{file:string(non-empty), diagnostics:array of {severity:in{error,warning,info,hint}, '
      + 'line:int>=1, column:int>=1, message:string, source?:string, code?:any}}',
    fields: [
      ['total', isIntegerAtLeast(0), 'total:int>=0'],
      ['truncated', isBoolean, 'truncated:boolean'],
    ],
    arrays: [
      {
        path: 'files',
        fields: [['file', isNonEmptyString, 'file:string(non-empty)']],
        arrays: [
          {
            path: 'diagnostics',
            fields: [
              ['severity', oneOf(...SEVERITIES), 'severity:in{error,warning,info,hint}'],
              ['line', isIntegerAtLeast(1), 'line:int>=1'],
              ['column', isIntegerAtLeast(1), 'column:int>=1'],
              ['message', isString, 'message:string'],
            ],
            // `source` 只在宿主给了才存在（handler 是 `...(source ? {source} : {})`）。
            // `code` 故意不校验：VSCode 的 Diagnostic.code 有 string / number / {value,target}
            // 三种形态，契约写的是 `code?:any`。
            optional: [['source', isString, 'source?:string']],
          },
        ],
      },
    ],
  },

  'vscode.listOpenEditors': {
    expected: 'object with total:int>=0, truncated:boolean, editors:array of '
      + '{file:string(non-empty), isActive:boolean, isDirty:boolean, languageId?:string}',
    fields: [
      ['total', isIntegerAtLeast(0), 'total:int>=0'],
      ['truncated', isBoolean, 'truncated:boolean'],
    ],
    arrays: [
      {
        path: 'editors',
        fields: [
          // ★ 元素字段名是 `file`，不是 `path`（handler: capabilities.js 的 listOpenEditors）。
          ['file', isNonEmptyString, 'file:string(non-empty)'],
          ['isActive', isBoolean, 'isActive:boolean'],
          ['isDirty', isBoolean, 'isDirty:boolean'],
        ],
        optional: [['languageId', isString, 'languageId?:string']],
      },
    ],
  },
})

/** 已登记形状的能力名（测试与诊断用）。 */
export const REGISTERED_METHODS = Object.freeze(Object.keys(RESPONSE_CONTRACTS))

/** 结果的类型摘要（typeof 口径，额外把 null / array 区分出来）。 */
function typeOf(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 单个值的类型摘要 —— **只回类型，绝不回显值**（契约 §5.1 第 1 条：只许 typeof / 键名摘要）。
 *
 * 数字与布尔同样不回显：它们不是字符串凭证，但仍是**对端数据**，而这个摘要会同时进
 * `data.got.value` 和错误 `message`，两者都会被日志与上层原样带走（评审 F2：
 * `end.line = -8675309123` 曾以 `number(-8675309123)` 整条泄漏）。排查够用的信息是
 * 「哪个字段 + 它是什么类型」。
 */
function describeLeaf(value) {
  return typeOf(value)
}

/** 按点号路径读值；读不到时返回 `{ ok:false, at }`（at = 断在哪一段）。 */
function readPath(object, path) {
  const segments = path.split('.')
  let cursor = object
  let walked = ''
  for (const segment of segments) {
    walked = walked ? `${walked}.${segment}` : segment
    if (!isObject(cursor) || !(segment in cursor)) return { ok: false, at: walked }
    cursor = cursor[segment]
  }
  return { ok: true, value: cursor }
}

const join = (prefix, path) => (prefix ? `${prefix}.${path}` : path)

/**
 * 按清单校验一个对象（会递归进数组元素）。
 * @returns {null|{at:string, value:string, label:string}} 第一个不合格项
 */
function checkFields(object, contract, prefix) {
  for (const [path, test, label] of contract.fields ?? []) {
    const read = readPath(object, path)
    if (!read.ok) return { at: join(prefix, read.at), value: 'missing', label }
    if (!test(read.value)) return { at: join(prefix, path), value: describeLeaf(read.value), label }
  }

  for (const group of contract.arrays ?? []) {
    const at = join(prefix, group.path)
    const read = readPath(object, group.path)
    if (!read.ok) return { at, value: 'missing', label: 'array' }
    if (!Array.isArray(read.value)) return { at, value: describeLeaf(read.value), label: 'array' }
    for (let i = 0; i < read.value.length; i += 1) {
      const atElement = `${at}[${i}]`
      const element = read.value[i]
      if (!isObject(element)) return { at: atElement, value: describeLeaf(element), label: 'object' }
      const inner = checkFields(element, group, atElement)
      if (inner) return inner
    }
  }

  for (const [path, test, label] of contract.optional ?? []) {
    const read = readPath(object, path)
    // ① 键不存在 → 这才是「可选」的语义，跳过。
    if (!read.ok) continue
    // ② 键存在但值是 undefined → 等同未提供（JSON 表达不了 undefined，wire 上不出现；
    //    只有进程内直连的假对端才可能给出来），跳过。
    if (read.value === undefined) continue
    // ③ 显式 null 是「给出了值」，必须走类型谓词并被拒。
    //    契约是 `languageId?:string` / `source?:string`，不是 `string|null`
    //    （评审 F1：此处曾把 null 当未提供，于是 null 被放行）。
    if (!test(read.value)) return { at: join(prefix, path), value: describeLeaf(read.value), label }
  }

  return null
}

/** 拼 `data.got`：typeof / 键名摘要 + 失败位置，**绝不**带响应体内容。 */
function describeGot(result, failure) {
  const got = { type: typeOf(result) }
  if (isObject(result)) {
    const keys = Object.keys(result)
    got.keys = keys.slice(0, MAX_KEY_NAMES)
    if (keys.length > MAX_KEY_NAMES) got.keyCount = keys.length
  }
  if (failure) {
    got.at = failure.at
    got.value = failure.value
  }
  return got
}

const summarizeGot = (got) => (got.at ? `${got.value} at ${got.at}` : got.type)

/**
 * 校验一次成功响应；不合格就抛 `-32009`。
 *
 * 只处理**成功返回**：调用方必须在既有失败路径（超时 / 不支持 / 版本不兼容 / 断线）
 * 之后、把结果交回消费者之前调用本函数。抛出的错误 `data = { method, got, expected }`
 * （契约 §5.1 第 1 条）。
 *
 * @param {string} method 方法名
 * @param {any} result 对端返回的成功结果
 * @returns {any} 原样返回 result（便于流水线写法）
 * @throws {BridgeError} -32009 invalid-response
 */
export function validateResponse(method, result) {
  // 非能力命名空间（bridge.*、自定义方法）不在管辖内：原样放行。
  if (typeof method !== 'string' || !method.startsWith(CAPABILITY_NAMESPACE)) return result

  // ① 最低校验：所有能力都过（undefined / null / 非对象 / 顶层数组）。
  if (!isObject(result)) {
    const got = describeGot(result, null)
    throw new BridgeError(
      ERR.INVALID_RESPONSE,
      `invalid response for "${method}": expected ${MIN_RESPONSE_EXPECTED}; got ${summarizeGot(got)}`,
      { method, got, expected: MIN_RESPONSE_EXPECTED },
    )
  }

  // ② 形状校验：只对已登记的能力；未登记 = 只有最低校验（见文件头「新增能力时的义务」）。
  const contract = RESPONSE_CONTRACTS[method]
  if (!contract) return result

  const failure = checkFields(result, contract, '')
  if (failure) {
    const got = describeGot(result, failure)
    throw new BridgeError(
      ERR.INVALID_RESPONSE,
      `invalid response for "${method}": expected ${contract.expected}; got ${summarizeGot(got)}`,
      { method, got, expected: contract.expected },
    )
  }
  return result
}
