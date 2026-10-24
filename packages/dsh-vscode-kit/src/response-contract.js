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
import { eventCursorError, subscriptionReceiptError } from './event-subscriptions.js'

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

/**
 * 64 位小写十六进制 —— `sha256` 的形状。
 *
 * 为什么要这么死：这个值唯一的用途是**和别的工具算出来的 sha256 对照**
 * （`sha256sum`、`git hash-object`、恢复脚本）。大写、省略前导零、带 `0x` 前缀
 * 全都是"看起来像但对不上"，而排查它的人会去怀疑文件本身，不会怀疑编码。
 */
const isSha256Hex = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

/** 本模块的「对象」口径：排除 null 与顶层数组（契约 §5.1 第 2 条）。 */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A1（T61）归属字段的**取值全集**，与 bridge 侧 `change-ledger.js` 的 `ATTRIBUTION`
 * 逐字一致。这里必须抄一份而不 import：kit 是**零依赖协议库**，反向往 bridge 里
 * import 会把扩展侧的实现拖进协议层（铁律 3）。防漂移的手段是 bridge 的
 * `test/change-ledger.test.js` 里那条静态比对（读本文件的字面量对账）。
 *
 * ★ `unknown` 是**正常结果**，不是失败：它表达"我说不清这些变化是谁造成的"，
 *   正是本卡要求的保留态。把 unknown 判成畸形响应会逼对端去猜一个更好看的答案。
 */
const ATTRIBUTION_VALUES = ['bridge-correlated', 'self-only', 'mixed', 'unknown']

/** 可空整数（锚点字段在没有基线时是 `null`，不是缺失）。 */
const isNullableIntegerAtLeast = (min) => (v) => v === null || (Number.isInteger(v) && v >= min)
/** 可空非空字符串（`incarnation`）。 */
const isNullableNonEmptyString = (v) => v === null || (typeof v === 'string' && v.trim() !== '')
/** 可空 sha256（`hash`：算不出/文本不可用时是 `null`）。 */
const isNullableSha256Hex = (v) => v === null || isSha256Hex(v)
/** 可空布尔。 */
const isNullableBoolean = (v) => v === null || typeof v === 'boolean'

/**
 * 锚点字段清单（`before` / `after` 共用**同一份**形状定义）。
 *
 * 为什么两边必须同形：消费者会把 `before.version` 与 `after.version` 直接相减/相比，
 * 一边允许 `undefined`、另一边要求整数，就会出现"看着像缺字段"的静默分支。
 * 所以两个锚点的字段集在契约里是同一份，差异只在**值**上。
 */
function anchorFields(prefix) {
  return [
    [`${prefix}.version`, isNullableIntegerAtLeast(0), `${prefix}.version:int|null`],
    [`${prefix}.incarnation`, isNullableNonEmptyString, `${prefix}.incarnation:string(non-empty)|null`],
    [`${prefix}.hash`, isNullableSha256Hex, `${prefix}.hash:sha256|null`],
    [`${prefix}.textLength`, isNullableIntegerAtLeast(0), `${prefix}.textLength:int|null`],
    [`${prefix}.dirty`, isNullableBoolean, `${prefix}.dirty:boolean|null`],
  ]
}

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

  /**
   * 写入类能力的返回形状（契约 §5.1：新增能力**必须**登记返回清单，否则不许进
   * `CAPABILITIES`；test/response-contract.test.js 有双向守门）。
   *
   * ★ `saved` 不是"布尔字段"，是**业务承诺**：T3 的 applyEdit 只改缓冲区、绝不落盘。
   *   所以谓词写成 `v === false` 而不是 `isBoolean` —— 对端一旦回 `saved:true`，
   *   本端必须判成畸形响应（-32009），而不是"看起来成功了"。
   *   `file` 是规范化后的绝对路径（对端 realpath 过的那个），非空字符串。
   *   `textLength` = 本次写入文本的长度（UTF-16 码元数，即 `text.length`）。
   */
  'vscode.applyEdit': {
    expected: 'object with applied:boolean, file:string(non-empty), saved===false, textLength:int>=0, '
      + 'and optionally operationId:string(non-empty), attribution:in{'
      + ATTRIBUTION_VALUES.join(',') + '}, attributionReason:string(non-empty), '
      + 'before:{version:int|null, incarnation:string(non-empty)|null, hash:sha256|null, '
      + 'textLength:int|null, dirty:boolean|null}, after:{…same shape…}',
    fields: [
      ['applied', isBoolean, 'applied:boolean'],
      ['file', isNonEmptyString, 'file:string(non-empty)'],
      ['saved', (v) => v === false, 'saved===false'],
      ['textLength', isIntegerAtLeast(0), 'textLength:int>=0'],
    ],
    // ── A1（T61）归属字段：**只增不改**，且**整组可选** ──
    // ① 既有四个字段的语义一字未动（`saved === false` 仍是业务承诺）。
    // ② 整组可选的理由是**向后兼容**：老扩展（没有账本）根本不回这些键，
    //    把任何一个改成必填，都会让旧对端在一夜之间变成 `-32009` 畸形响应。
    // ③ 但"可选"只表示**可以不给**，不表示"给了可以乱给"：键一旦出现就走类型谓词，
    //    显式 `null` 对非可空字段同样被拒（与 `languageId?` 同一口径）。
    optional: [
      ['operationId', isNonEmptyString, 'operationId?:string(non-empty)'],
      ['attribution', oneOf(...ATTRIBUTION_VALUES), `attribution?:in{${ATTRIBUTION_VALUES.join(',')}}`],
      ['attributionReason', isNonEmptyString, 'attributionReason?:string(non-empty)'],
      ['before', isObject, 'before?:object'],
      ['after', isObject, 'after?:object'],
      ...anchorFields('before'),
      ...anchorFields('after'),
    ],
    // 归属字段是**一组**：只给 `attribution` 却不给锚点，消费者没法自己核对，
    // 等于把一个"结论"当证据发出去（本卡明确不要这种东西）。所以要么一起给，要么都不给。
    consistency: [
      [(r) => r.attribution === undefined
        || (typeof r.operationId === 'string' && isObject(r.before) && isObject(r.after)),
      'attribution requires operationId + before + after (or none of them at all)'],
    ],
  },

  /**
   * 落盘（T39 / 契约 §6.2.1 Tier 3）。
   *
   * ★ 谓词方向与 `applyEdit` **相反**，这是有意的一对：
   *   `applyEdit` 承诺"我只碰缓冲区" ⇒ `saved` 必须是 `false`；
   *   `vscode.save` 承诺"我真的落盘了" ⇒ `saved` 必须是 `true`。
   *   两边都写成"值断言"而不是 `isBoolean`：对端回错方向的布尔不是小毛病，
   *   是**成功外形的错误结果**（§5.1），必须判 `-32009` 而不是替它猜。
   *
   * `disk` 是**保存之后重新 stat 的真值**（不是回显 `expectedDisk`），所以两个字段
   * 都必须是整数：`mtime` 是毫秒，`size` 是字节。让浮点/字符串混进来，消费者下一次
   * 拿它当锚点就会"永远冲突"。
   * `dirtyBefore` = 保存**之前**缓冲区是否脏（`true` 说明这次落盘把人工改动一起写下去了，
   * 也正是 grant 上 `allowDirtySave` 才放行的情形）。
   */
  'vscode.save': {
    expected: 'object with saved===true, file:string(non-empty), '
      + 'disk:{mtime:int>=0, size:int>=0}, dirtyBefore:boolean',
    fields: [
      ['saved', (v) => v === true, 'saved===true'],
      ['file', isNonEmptyString, 'file:string(non-empty)'],
      ['disk.mtime', isIntegerAtLeast(0), 'disk.mtime:int>=0'],
      ['disk.size', isIntegerAtLeast(0), 'disk.size:int>=0'],
      ['dirtyBefore', isBoolean, 'dirtyBefore:boolean'],
    ],
  },

  /**
   * 归档（T40 / 契约 §6.2.1 Tier 4；**T44 改成"移入隔离区，永不删"**）。
   *
   * ★ 为什么不再有 `deleted` / `trashed`：T44 的裁决是"这条能力不销毁任何字节"。
   *   返回体里出现 `deleted:true` 就等于替一个不存在的动作作证；`trashed` 更是必须
   *   消失的字段 —— 隔离区**不是**回收站（没有 `restore` 入口、没有系统集成），
   *   说"进回收站了"会让人去找一个找不到的东西。旧口径里"`trashed` 只接受 `'unknown'`"
   *   的整段论证因此作废：字段本身没了，就没有"诚实的取值"这回事。
   *
   * 所以判据换成三个**可核对的事实**：
   *  - `quarantined===true` + `from`/`to`：移动真的发生了，新位置在 `to`；
   *  - `confirmedSha256`/`confirmedByteLength`：**人看着点确认**的那份字节（= `snapshot`
   *    与 `backup` 指的那份，三处必须一致 —— 见 `consistency`）；
   *  - `quarantinedSha256`/`quarantinedByteLength`：**移动完成之后**在隔离体上实测的。
   *    它必须来自归档后的实测，而 `bytesChanged` 就是"两者是否相同"的判定结果 ——
   *    不是对端可以自选的布尔。T43 评审的 open-writer 窗口正是"两份不同"的情形
   *    （用写句柄在归档后改了隔离体）：此时**两份都没丢**（确认时那份在 `snapshot` 里，
   *    现在这份在 `to` 下），所以这是一次**成功**，但必须 `bytesChanged:true` 并给出
   *   说明（`bytesChangedNote`），不许隐瞒差异。
   *
   * `snapshot` 是**恢复材料**（§6.2.4 ③），不是"关于这份字节的元数据"：
   *  - `sha256` 必须是 64 位小写十六进制：它要能直接和 `sha256sum` / `git hash-object`
   *    的结果对照，混进大写或长度不对就等于没给（人拿去核时会"永远对不上"）；
   *  - `byteLength` 非负整数：交出去的是 0 字节文件还是 2 MB 文件是两件事；
   *  - `encoding` 必须是 `utf8` / `binary` 之一：`binary` 表示"没有文本形态"，
   *    此时**不给** `text` / `textLength`，整份字节走 `base64`（见 `consistency`）。
   *
   * ★ T42 / 评审 I1 的结论继续有效：`sha256` **恢复不出**任何字节，它只证明"是同一份"。
   *   所以合同要求**整份字节必须在响应里**（`text` 或 `base64`），并用
   *   `backup.delivered===true` 显式声明"我交出来了"。做不到就该是一次失败
   *   （`-32603 reason:'backup-undeliverable'`），而不是一次"归档了但没材料"的成功。
   */
  'vscode.deleteFile': {
    expected: "object with quarantined===true, file:string(non-empty), from:string(non-empty), "
      + 'to:string(non-empty), confirmedSha256:64-hex, confirmedByteLength:int>=0, '
      + 'quarantinedSha256:64-hex, quarantinedByteLength:int>=0, bytesChanged:boolean, '
      + 'backup:{delivered===true, form:in{utf8-text,base64}, byteLength:int>=0, sha256:64-hex}, '
      + 'snapshot:{sha256:64-hex-lowercase, byteLength:int>=0, encoding:in{utf8,binary}, '
      + 'textLength?:int>=0, text?:string, base64?:string}',
    fields: [
      ['quarantined', (v) => v === true, 'quarantined===true'],
      ['file', isNonEmptyString, 'file:string(non-empty)'],
      ['from', isNonEmptyString, 'from:string(non-empty)'],
      ['to', isNonEmptyString, 'to:string(non-empty)'],
      ['confirmedSha256', isSha256Hex, 'confirmedSha256:64-hex-lowercase'],
      ['confirmedByteLength', isIntegerAtLeast(0), 'confirmedByteLength:int>=0'],
      ['quarantinedSha256', isSha256Hex, 'quarantinedSha256:64-hex-lowercase'],
      ['quarantinedByteLength', isIntegerAtLeast(0), 'quarantinedByteLength:int>=0'],
      ['bytesChanged', isBoolean, 'bytesChanged:boolean'],
      ['snapshot.sha256', isSha256Hex, 'snapshot.sha256:64-hex-lowercase'],
      ['snapshot.byteLength', isIntegerAtLeast(0), 'snapshot.byteLength:int>=0'],
      ['snapshot.encoding', oneOf('utf8', 'binary'), 'snapshot.encoding:in{utf8,binary}'],
      // ★ 备份交付声明（I1）。`delivered:false` 的归档返回是畸形，不是"小瑕疵"。
      ['backup.delivered', (v) => v === true, 'backup.delivered===true'],
      ['backup.form', oneOf('utf8-text', 'base64'), 'backup.form:in{utf8-text,base64}'],
      ['backup.byteLength', isIntegerAtLeast(0), 'backup.byteLength:int>=0'],
      ['backup.sha256', isSha256Hex, 'backup.sha256:64-hex'],
    ],
    optional: [
      ['snapshot.textLength', isIntegerAtLeast(0), 'snapshot.textLength:int>=0'],
      // 空文件是合法的（`text:''`），所以 isString 而不是非空。
      ['snapshot.text', isString, 'snapshot.text:string'],
      // 二进制整份字节的 base64（逐字节可逆；比"替换字符版正文"诚实得多）。
      ['snapshot.base64', isString, 'snapshot.base64:string'],
      // `bytesChanged:true` 时的**人话说明**（"两份都在"）。见 consistency。
      ['bytesChangedNote', isNonEmptyString, 'bytesChangedNote:string(non-empty)'],
      // 隔离体现在在哪（`{path, original, retained, restored}`）。
      ['quarantine', (v) => typeof v === 'object' && v !== null, 'quarantine:object'],
      ['nameCollision', isBoolean, 'nameCollision:boolean'],
    ],
    consistency: [
      // 声明的"人确认过的那份"必须就是交出去的那份（三处同源，对不上 = 对端在猜）。
      [
        (r) => r.snapshot.sha256 === r.confirmedSha256
          && r.snapshot.byteLength === r.confirmedByteLength,
        'snapshot.{sha256,byteLength} === {confirmedSha256,confirmedByteLength}',
      ],
      // `bytesChanged` 是**判定结果**，不是自选布尔：必须等于两个 hash/长度比出来的事实。
      [
        (r) => r.bytesChanged === (r.quarantinedSha256 !== r.confirmedSha256
          || r.quarantinedByteLength !== r.confirmedByteLength),
        'bytesChanged === (quarantined* !== confirmed*)',
      ],
      // 差异必须被说出来（不许报成功却隐瞒）。反方向不要求：没差异就不该有说明。
      [
        (r) => r.bytesChanged !== true || (typeof r.bytesChangedNote === 'string'
          && r.bytesChangedNote.length > 0),
        "bytesChanged===true ⇒ bytesChangedNote 非空",
      ],
      // 移动必须有两端，而且不是同一个位置（否则"归档"是空话）。
      [
        (r) => r.from !== r.to,
        'from !== to',
      ],
      // `encoding:'binary'` 不许带文本形态：`toString('utf8')` 的结果不是"正文"。
      [
        (r) => r.snapshot.encoding !== 'binary'
          || (!('text' in r.snapshot) && !('textLength' in r.snapshot)),
        "snapshot.encoding==='binary' ⇒ 无 text / textLength",
      ],
      // 给了正文，长度就必须等于正文长度（UTF-16 code unit 口径，与 JS 消费者一致）。
      [
        (r) => !('text' in r.snapshot) || r.snapshot.text.length === r.snapshot.textLength,
        'snapshot.text.length === snapshot.textLength',
      ],
      // ★ I1 的核心：**整份字节必须在响应里** —— hash 不是恢复材料。
      [
        (r) => (r.snapshot.encoding === 'utf8'
          ? 'text' in r.snapshot
          : 'base64' in r.snapshot),
        '完整备份：encoding==utf8 ⇒ snapshot.text / encoding==binary ⇒ snapshot.base64',
      ],
      // base64 反解回来必须正好是声明的字节数（挡"半截 base64 冒充整份"）。
      [
        (r) => !('base64' in r.snapshot)
          || Buffer.from(r.snapshot.base64, 'base64').length === r.snapshot.byteLength,
        'snapshot.base64 解码后长度 === snapshot.byteLength',
      ],
      // 备份声明与载荷必须指同一份字节（两处 sha256/长度对不上 = 对端在猜）。
      [
        (r) => r.backup.sha256 === r.snapshot.sha256
          && r.backup.byteLength === r.snapshot.byteLength,
        'backup.{sha256,byteLength} === snapshot.{sha256,byteLength}',
      ],
      // 形态声明与载荷一致（utf8-text ↔ text / base64 ↔ base64）。
      [
        (r) => (r.backup.form === 'base64') === ('base64' in r.snapshot),
        "backup.form==='base64' ⇔ snapshot.base64 存在",
      ],
    ],
  },

  /**
   * 文档状态（T30：写入锚点的读侧）。
   *
   * `version` 是**写入前置条件**的唯一凭据，所以它必须是非负整数：对端回 `"12"`、
   * `12.5`、`null` 都不是"小毛病" —— 拿它去和 `expectedVersion` 比会得到
   * "永远冲突"或（string/int 混比时）"永远不等"两种极难排查的行为，在这里拦最省事。
   *
   * `eol` 收窄成 `'lf'|'crlf'`：它是给消费者判断"要不要按行拼回去"用的，枚举比布尔清楚；
   * 对端将来要加 `'cr'` 必须先改契约（这正是契约该有的摩擦）。
   *
   * `textUnavailable` **只能**是 `true`（`v === true`，不是 `isBoolean`）：
   * 出现这个键 = 一句事实陈述"文本超限、整份没给"。回 `false` 或 `null` 说明对端把
   * 语义搞混了，此时更该判畸形响应（-32009），而不是替它猜。
   * 且它与 `text` **互斥** —— 见 `consistency`。
   */
  'vscode.getDocumentState': {
    expected: 'object with file:string(non-empty), version:int>=0, isDirty:boolean, '
      + "eol:in{lf,crlf}, lineCount:int>=1, textLength:int>=0, "
      + 'and at most one of text?:string / textUnavailable===true',
    fields: [
      ['file', isNonEmptyString, 'file:string(non-empty)'],
      ['version', isIntegerAtLeast(0), 'version:int>=0'],
      ['isDirty', isBoolean, 'isDirty:boolean'],
      ['eol', oneOf('lf', 'crlf'), 'eol:in{lf,crlf}'],
      ['lineCount', isIntegerAtLeast(1), 'lineCount:int>=1'],
      ['textLength', isIntegerAtLeast(0), 'textLength:int>=0'],
    ],
    optional: [
      ['cursor', (v) => eventCursorError(v) === null, 'cursor:{subscriptionId,streamEpoch,nextSeq}'],
      ['textUnavailable', (v) => v === true, 'textUnavailable===true'],
      // 空文本是合法值（空文件 `includeText:true` 回 `text:''`），所以用 isString 而不是非空。
      ['text', isString, 'text:string'],
    ],
    consistency: [
      [
        (r) => !('text' in r && 'textUnavailable' in r),
        'text and textUnavailable are mutually exclusive',
      ],
      [
        // `text` 是**全集**：长度必须与 `textLength` 自洽，否则消费者拿到的"全文"
        // 和它算坐标用的行长度是两套数（T4 的坐标漂移有同一类成因）。
        (r) => (typeof r.text !== 'string' ? true : r.text.length === r.textLength),
        'text.length must equal textLength',
      ],
    ],
  },

  /**
   * 事件订阅回执（E3）。**这张表是"订阅成功但初态屏障不存在"的第一道门**：
   *
   * 订阅回执不只是一个 ok —— 它同时钉住了这条流的位置（`subscriptionId` +
   * `streamEpoch` + `startSeq`）。消费者要先装观察、再取快照、只消费 `startSeq` 之后
   * 的事件（规划 §4.3）。回执里少一个字段，初态屏障就没了，之后所有"漏了一条"
   * 都无从解释。`cursor` 不是冗余：它把同一份位置用**消费方视角**再表达一次
   * （`nextSeq` = 下一条要消费的），两侧是否自洽在这里用 `consistency` 硬校验。
   */
  'vscode.events.subscribe': {
    expected: 'object with ok===true, subscriptionId:string(non-empty), streamEpoch:string(non-empty), '
      + 'startSeq:int>=1, cursor:{subscriptionId,streamEpoch,nextSeq:int>=1}, '
      + 'subscription:{id,consumer,types?,files?,textMode}',
    fields: [
      ['ok', (v) => v === true, 'ok===true'],
      ['subscriptionId', isNonEmptyString, 'subscriptionId:string(non-empty)'],
      ['streamEpoch', isNonEmptyString, 'streamEpoch:string(non-empty)'],
      ['startSeq', isIntegerAtLeast(1), 'startSeq:int>=1'],
      ['cursor.subscriptionId', isNonEmptyString, 'cursor.subscriptionId:string(non-empty)'],
      ['cursor.streamEpoch', isNonEmptyString, 'cursor.streamEpoch:string(non-empty)'],
      ['cursor.nextSeq', isIntegerAtLeast(1), 'cursor.nextSeq:int>=1'],
      ['subscription.id', isNonEmptyString, 'subscription.id:string(non-empty)'],
      ['subscription.consumer', isNonEmptyString, 'subscription.consumer:string(non-empty)'],
      ['subscription.textMode', oneOf('metadata', 'delta'), 'subscription.textMode:in{metadata,delta}'],
    ],
    optional: [
      ['subscription.files', (v) => v === null || Array.isArray(v), 'subscription.files:array|null'],
      ['subscription.types', (v) => v === null || Array.isArray(v), 'subscription.types:array|null'],
    ],
    consistency: [
      [(r) => r.cursor.subscriptionId === r.subscriptionId, 'cursor.subscriptionId must equal subscriptionId'],
      [(r) => r.cursor.streamEpoch === r.streamEpoch, 'cursor.streamEpoch must equal streamEpoch'],
      [(r) => r.cursor.nextSeq === r.startSeq, 'cursor.nextSeq must equal startSeq'],
      [(r) => subscriptionReceiptError(r) === null, 'subscription receipt and cursor must be structurally valid'],
    ],
  },

  /**
   * 退订回执（E3）。`unsubscribed:false` 是**合法结果**（幂等：这个 id 本来就不存在，
   * 比如重复退订、或流已经因为缺口语义被对端关掉）—— 与"退订失败"不是一回事。
   */
  'vscode.events.unsubscribe': {
    expected: 'object with ok===true, unsubscribed:boolean, subscriptionId?:string|null, streamClosed:boolean',
    fields: [
      ['ok', (v) => v === true, 'ok===true'],
      ['unsubscribed', isBoolean, 'unsubscribed:boolean'],
      ['streamClosed', isBoolean, 'streamClosed:boolean'],
    ],
    optional: [
      ['subscriptionId', (v) => v === null || isNonEmptyString(v), 'subscriptionId:string|null'],
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

  // 跨字段一致性（T30 起支持）：单字段谓词表达不了「二者互斥」「最多出现一个」这类约束，
  // 而这类约束恰恰是消费者会拿来分派逻辑的东西 —— 两个都给出来时它该信谁？
  // 谓词只回布尔，不读内容、不回显值（与其余校验同一口径）。
  for (const [test, label] of contract.consistency ?? []) {
    let ok = false
    try {
      ok = test(object) === true
    } catch {
      ok = false
    }
    if (!ok) return { at: prefix || '(result)', value: 'inconsistent', label }
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
