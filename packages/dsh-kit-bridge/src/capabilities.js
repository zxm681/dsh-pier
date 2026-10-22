/**
 * 能力实现：VS Code 能力的唯一实现处。
 *
 * 设计要点：
 *  - **不直接 import 'vscode'**，全部经 `host` 注入 —— 这样能在 node:test 里单测，
 *    不必起 Electron / 扩展宿主。
 *  - 每个能力先做三项前置检查（信任 / 可用性 / 参数），再做实际动作。
 *  - 失败一律抛 BridgeError 带稳定错误码，让 DSH 侧拿到结构化原因而不是字符串。
 *
 * 坐标约定：协议对外一律 **1-based** 的 line/column（人和日志都好读），
 * 在调用 VSCode API 的边界上转成内部的 0-based。
 */

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import {
  GRANT_REASONS, editNotBoundError, extensionWriteGate, isWriteMethod,
} from '../../dsh-vscode-kit/src/grant.js'
import {
  resolveWorkspaceFile, revalidateWriteTarget, assertTargetUnchanged,
  assertWrittenDocumentIdentity,
} from './workspace-paths.js'

/** 本扩展声明支持的能力清单（写进发现文件 / hello 的 capabilities）。 */
export const CAPABILITIES = [
  'vscode.openFile',
  'vscode.getSelection',
  'vscode.getDiagnostics',
  'vscode.listOpenEditors',
  'vscode.applyEdit',
  // 写入锚点的读侧（T30）：`applyEdit` 的 `expectedVersion` 只能从这里拿。
  // 只读，不改宿主状态，因此**不要求** grant（写入才要求，契约 §6.1）。
  'vscode.getDocumentState',
]

/**
 * `includeText:true` 时允许随响应带回的文档文本上限（**字节**，UTF-8）。
 *
 * 为什么是 8 MiB 而不是"字符数"或"不设上限"：这条能力的返回会经过 ndjson 分帧、
 * loopback TCP、以及 DSH 侧的消费者（通常还要塞进模型上下文）。**超限必须整份不给**
 * （`textUnavailable:true`），绝不许截断后当全文 —— 一份被悄悄截断的"全文"是比报错
 * 危险得多的失败形态：调用方会拿它去算坐标、比对范围，然后在错的地方写字。
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** 二进制文件的扩展名黑名单：这些用普通文本编辑器打开会报 "File seems to be binary"（issue #33 教训）。 */
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
  'pdf', 'zip', 'gz', 'tar', '7z', 'rar',
  'mp3', 'wav', 'mp4', 'webm', 'mov', 'avi',
  'exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
])

/** 1-based → 0-based（并夹到合法范围，避免 VSCode 抛 "Illegal argument"）。 */
function toZeroBased(n, fallback) {
  if (!Number.isInteger(n) || n < 1) return fallback
  return n - 1
}

/**
 * 1-based → 0-based 的**唯一一次**转换（铁律 6）。
 *
 * 入口（`params.range`）永远是 1-based，交给 host 的永远是 0-based，中间不许出现
 * 第二次减法：`line 1` 再减一次就是 `-1`，`vscode.Range` 会当场抛 "Illegal argument"，
 * 而更糟的形态是"不抛但整体错一行"——写入到错误的位置还报成功。
 * 所以转换只写在这里，且**只被调用一次**（见 applyEdit）。
 */
export function toApiRange(range) {
  return {
    start: { line: range.start.line - 1, column: range.start.column - 1 },
    end: { line: range.end.line - 1, column: range.end.column - 1 },
  }
}

/** 读一个 1-based 位置；非法就 -32602（范围校验属于参数校验，不是业务判断）。 */
function readPosition(pos, label, method) {
  if (!pos || typeof pos !== 'object' || Array.isArray(pos)) {
    throw new BridgeError(ERR.INVALID_PARAMS, `params.range.${label} must be an object`,
      { method })
  }
  const { line, column } = pos
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      `params.range.${label}.line/column must be integers >= 1 (1-based)`,
      { method, got: { line: typeof line, column: typeof column } })
  }
  return { line, column }
}

/** 读整个 range：两端都要合法，且 start 不得在 end 之后（否则是"反向选区"）。 */
function readRange(range, method) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) {
    throw new BridgeError(ERR.INVALID_PARAMS, 'params.range must be an object', { method })
  }
  const start = readPosition(range.start, 'start', method)
  const end = readPosition(range.end, 'end', method)
  const after = start.line > end.line
    || (start.line === end.line && start.column > end.column)
  if (after) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.range.start must not be after params.range.end',
      { method, start, end })
  }
  return { start, end }
}

/**
 * 读目标文档的形状（行数 + 关心的那几行的行长），**从文档而不是磁盘**读：
 * 缓冲区可能有未落盘的改动，按磁盘算行数会把合法范围判成越界（反之也会）。
 *
 * 宿主太老/替身没实现 → **失败闭合**（评审 F8）：宁可拒绝，也不把没校验过的范围
 * 交给 `vscode.Range` —— 宿主会自己 clamp，于是「写到第 999 行」静默变成
 * 「写到文件末尾」并且报 `applied:true`，这是最坏的一种假成功。
 *
 * @param {object} host
 * @param {string} abs    已通过路径守卫的真实路径
 * @param {number[]} lines 关心的 1-based 行号（按给定顺序回行长）
 * @param {string} method
 * @returns {Promise<{lineCount: number, lineLengths: Array<number|null>}>}
 */
async function readDocumentShape(host, abs, lines, method) {
  if (typeof host.readDocumentShape !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readDocumentShape; refusing to apply an unbounded range',
      { method, hostField: 'readDocumentShape' })
  }
  let shape
  try {
    shape = await host.readDocumentShape(abs, lines)
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
    }
    throw new BridgeError(ERR.INTERNAL,
      `cannot read document shape for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  if (!shape || !Number.isInteger(shape.lineCount) || shape.lineCount < 1) {
    throw new BridgeError(ERR.INTERNAL,
      `host returned an invalid document shape for ${abs}`, { method, path: abs })
  }
  // ★ 评审 R2-3：不许把「宿主给的形状不对」悄悄折成 `[]`。
  //   第一版写的是 `Array.isArray(shape.lineLengths) ? shape.lineLengths : []`，
  //   于是 `lineLengths` 缺失 / 拼错名 / 给了个字符串时，它变成空数组，而空数组在
  //   下面的边界检查里表现成"这个文档没有行长信息" —— 检查被**静默跳过**，
  //   越行的写入照样交给宿主（宿主会 clamp 到行尾，等于替调用方改内容）。
  //   形状错误是内部故障，不是"信息不足"：直接 -32603，一个字节都不交给写宿主。
  //   ★ 判序也在这里：整条 `lineLengths` 是否数组**留到 assertRangeInBounds 里判** ——
  //   那里先看 end.line 有没有越过文档，才轮到"行长能不能用"。否则"行数越界"这个
  //   调用方能自证的 -32602 会被形状问题抢先，判序就和契约反了（R2-3 明文要求：
  //   越行号仍先报 `-32602 range-beyond-document`）。
  return { lineCount: shape.lineCount, lineLengths: shape.lineLengths }
}

/**
 * 范围边界检查（评审 F8、R2-3）。
 *
 * 只给出 1-based 范围，不给出「文档有多大」时，「越界」是**调用方可以自证**的错误，
 * 所以报 -32602（参数错），并且**一个字节都不交给宿主**。
 *
 * ★ R2-3：结构错误（形状不对）与越界错误（数字超了）是两类事，判序也是契约的一部分：
 *  - 行数越界仍旧先报（`-32602 range-beyond-document`）：调用方给的 end.line 超了文档，
 *    这是可自证的参数错，哪怕行长信息也缺着，说"行数越界"比说"内部故障"更有用。
 *  - 之后**行长必须齐全且合法**（两个端点都在、都是非负整数）。缺一个、给了 `null`、
 *    负数、`NaN`、非数字 → `-32603`，**不调用** `applyEditText`。
 *    第一版那行 `if (!Number.isInteger(len)) continue` 就是 R2-3 的病根：
 *    "不知道多长"被当成"没有上界"，于是检查放过、写入交出去、宿主把行尾 clamp 一下
 *    就当成功了 —— 用户看到的报错是"成功"，文件里多了一截他不知道的内容。
 */
function assertRangeInBounds(shape, range, method) {
  const { lineCount, lineLengths } = shape
  if (range.end.line > lineCount) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      `params.range.end.line ${range.end.line} is beyond the document (${lineCount} lines)`,
      { method, reason: 'range-beyond-document', lineCount, end: range.end })
  }
  const ends = [range.start, range.end]
  // 行长必须**先存在**：缺失 / 不是数组 = 宿主形状错误（内部故障），
  // 不是"这个文档没有上界"。放在越行号之后，是为了让可自证的参数错先说话。
  if (!Array.isArray(lineLengths)) {
    throw new BridgeError(ERR.INTERNAL,
      'host returned a document shape without a usable lineLengths array; '
      + 'refusing to apply an unverified range',
      {
        method,
        reason: 'line-length-unavailable',
        hostField: 'lineLengths',
        got: typeof lineLengths,
      })
  }
  for (let i = 0; i < ends.length; i++) {
    const pos = ends[i]
    const len = lineLengths[i]
    // 上界检查必须有上界可用。缺失 ≠ 无上界。
    if (!Number.isInteger(len) || len < 0) {
      throw new BridgeError(ERR.INTERNAL,
        `document shape has no usable length for range endpoint line ${pos.line} `
        + `(got ${String(len)}); refusing to apply an unchecked range`,
        {
          method,
          reason: 'line-length-unavailable',
          line: pos.line,
          endpoint: i === 0 ? 'start' : 'end',
          got: typeof len === 'number' && Number.isNaN(len) ? 'NaN' : typeof len === 'number' ? len : typeof len,
        })
    }
    // 1-based column → 0-based 偏移；超出行长会被宿主 clamp 成"行尾"。
    if (pos.column - 1 > len) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.range line ${pos.line} column ${pos.column} is beyond the line (${len} chars)`,
        { method, reason: 'range-beyond-line', line: pos.line, lineLength: len, column: pos.column })
    }
  }
}

/**
 * 出口路径规范化（Windows 盘符统一大写）。
 *
 * 真机自检抓到的坑：同一个文件，`vscode.openFile` 回传的是调用方传入的
 * `C:\Users\...`，而 `vscode.getSelection` / `listOpenEditors` 回传的是
 * VSCode URI 的 `fsPath`，在 Windows 上盘符被小写化成 `c:\Users\...`。
 * 消费者若按字符串比较（`list.some(e => e.file === p)`）会静默失败。
 * 协议是对外契约，出口必须只有一种写法 —— 这里统一成大写盘符。
 */
function canonicalPath(p) {
  if (typeof p !== 'string') return p
  return /^[a-z]:/.test(p) ? p[0].toUpperCase() + p.slice(1) : p
}

/**
 * 串行化键（**锁身份**）：只给 `serializeByPath` 用，不参与任何对外输出。
 *
 * 为什么不能直接用 `canonicalPath(real)`（T33 / 评审 T31 第二轮 I1 的实证）：
 * `realpath` 会展开链接、8.3 短名、`\\?\` 前缀，但**不统一段名大小写** —— 真机
 * （Node v24 / Windows）上 `D:\ws\a.txt` 与 `D:\WS\A.TXT` 是**同一个文件**（同为
 * dev+ino），`realpath` 却分别原样返回调用方拼的大小写。于是两条写请求落在两条 promise
 * 链上、并发通过前置版本检查、双双摸到写宿主：队列被别名绕过（事务 CAS 只保住了"至多
 * 一次落点"，没有保住"一次只有一个在读版本"）。锁键必须是**文件身份**，不是"一个看起来
 * 规范过的字符串"。
 *
 * 归一策略**按平台**，不许无条件折小写：
 *  - `win32`：整体 `toLowerCase()`。NTFS 默认不区分大小写，`a.txt` / `A.TXT` 本来就是
 *    同一个文件 —— 不折就必然出现两条链，那是本函数的全部理由。
 *  - 其它平台：**原样返回**。Linux 的 ext4/xfs **区分**大小写，`a.txt` 与 `A.TXT` 是两个
 *    不同的文件：无条件下折会把两个本来**可以并行写**的文件塞进同一条链（把并行误伤成
 *    串行），归属判定还可能与事务层不一致。macOS 默认卷不区分大小写但保留大小写，这里
 *    也按"其它平台"处理 —— 宁可少归并（两条链写两个不同文件，事务 CAS 照样挡住双成功），
 *    不要错归并。
 *
 * 其余别名形态**到不了这张表**，所以这里不做猜测式归一（T33 实测，见报告）：
 *  - 符号链接 / junction：路径守卫逐段 lstat，链上有链接直接 `-32602`（`reason:'symlink'`）。
 *  - 8.3 短名：**实测 `realpath` 并不展开**（`T33SHO~1\a.txt` 原样返回），但短名写法在守卫的
 *    "在根之内 + 逐段同名"判定里被判 `-32602`（fail-closed），同样进不了锁。
 *  - `\\localhost\C$\...` 这类卷别名：守卫判 `outside-workspace` 拒写。
 *  - `\\?\` 长路径前缀：上游 `stripLongPrefix` 已剥；相对路径与 `..`：`path.resolve` 已消。
 * 所以**唯一会以两种字符串指向同一文件、且两种字符串都能进锁**的形态，就是段名大小写 ——
 * 也就是本函数要折的那一件。
 */
function serializeKeyFor(real) {
  if (typeof real !== 'string') return real
  return process.platform === 'win32' ? real.toLowerCase() : real
}

// ─────────────────────────────────────────────────────────────────────────────
// 写入锚点（T30）：`expectedVersion` / `expectedRangeText` / 文档状态
//
// 为什么需要它（T4 的 NO-GO 根因）：写入请求原本只有「路径 + 坐标 + 文本」，而坐标是
// **调用方自己记的视图**。中间只要有人（用户、另一个插件、格式化）改过缓冲区，同一组
// 坐标就指向了别的内容 —— 宿主会老老实实按坐标替换，人工改动无声消失，`applied` 还是
// `true`。版本号是编辑器自己维护的单调计数器（`TextDocument.version`），它是「我基于
// 哪一刻的内容写了这组坐标」唯一能被机制证明的锚点。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读并校验 `params.expectedVersion`（**必填**）。
 *
 * 必填的理由：可选的锚点等于没有锚点 —— 调用方（尤其在上下文里丢过字段的模型）会
 * 一直走"不带版本"的路径，而那正是 T4 判 NO-GO 的那条路径。宁可让它在这里报一个
 * 说得清的参数错，也不许它拿到一个"看起来成功了"的静默覆盖。
 *
 * `data.reason` 把四种坏输入分开（缺 / 不是数字 / 不是整数 / 负数），只回类型与原因，
 * **不回显值**（与 response-contract.js 的口径一致：错误 data 里不放对端数据）。
 *
 * @returns {number} 合法的 0-based 整数版本号
 * @throws {BridgeError} -32602
 */
function readExpectedVersion(params, method) {
  const v = params?.expectedVersion
  const reason = v === undefined ? 'expected-version-missing'
    : typeof v !== 'number' ? 'expected-version-not-a-number'
      : !Number.isInteger(v) ? 'expected-version-not-an-integer'
        : v < 0 ? 'expected-version-negative'
          : null
  if (reason) {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.expectedVersion is required and must be an integer >= 0; '
      + 'read it from vscode.getDocumentState.version and pass it back unchanged',
      { method, reason, got: { type: typeof v } })
  }
  return v
}

/**
 * 读并校验可选的 `params.expectedRangeText`。
 *
 * 给 `undefined` = 不做内容比对（版本仍然必填）。给了别的类型就是参数错 ——
 * 不许"当成没给"静默降级，那等于让一个拼错的字段名把内容比对悄悄关掉。
 */
function readExpectedRangeText(params, method) {
  const v = params?.expectedRangeText
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new BridgeError(ERR.INVALID_PARAMS,
      'params.expectedRangeText must be a string when provided',
      { method, reason: 'expected-range-text-not-a-string', got: { type: typeof v } })
  }
  return v
}

/**
 * 读**文档**状态（版本 / 脏标记 / 换行 / 行数 / 长度 / 可选全文）。
 *
 * 形状校验与 `readDocumentShape` 同一套理由（评审 R2-3）：宿主回的字段缺一个就说明
 * 这个适配器不可信，此时**失败闭合**（-32603），绝不许把 `undefined` 当版本号去比 ——
 * `undefined !== 5` 会让每次写入都报冲突，或者更糟：`undefined === undefined` 一路放行。
 *
 * @param {{includeText: boolean}} wanted
 * @returns {Promise<{version:number, isDirty:boolean, eol:'lf'|'crlf', lineCount:number,
 *   textLength:number, byteLength:number, text?:string}>}
 */
async function readDocumentState(host, abs, wanted, method) {
  if (typeof host.readDocumentState !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readDocumentState; refusing to write without a version anchor',
      { method, hostField: 'readDocumentState' })
  }
  let state
  try {
    state = await host.readDocumentState(abs, { includeText: wanted?.includeText === true })
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`, { method, path: abs })
    }
    throw new BridgeError(ERR.INTERNAL,
      `cannot read document state for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  const bad = []
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    bad.push('state')
  } else {
    if (!Number.isInteger(state.version) || state.version < 0) bad.push('version')
    if (typeof state.isDirty !== 'boolean') bad.push('isDirty')
    if (state.eol !== 'lf' && state.eol !== 'crlf') bad.push('eol')
    if (!Number.isInteger(state.lineCount) || state.lineCount < 1) bad.push('lineCount')
    if (!Number.isInteger(state.textLength) || state.textLength < 0) bad.push('textLength')
    if (!Number.isInteger(state.byteLength) || state.byteLength < 0) bad.push('byteLength')
  }
  if (bad.length > 0) {
    throw new BridgeError(ERR.INTERNAL,
      `host returned an invalid document state for ${abs} (bad fields: ${bad.join(', ')})`,
      { method, path: abs, fields: bad })
  }
  return state
}

/**
 * 版本锚点判定 —— 写前的**第一道实质门**（参数形状之后、范围之前）。
 *
 * 比的是等值，不是"小于/大于"：版本号只增不减，但"我的版本比它大"同样意味着中间
 * 发生过我不知道的改动（例如用户撤销）。任何不等都按冲突处理，`data` 里给三个数：
 * 文件、我以为的、实际的 —— 让调用方能立刻判断"重读一次再试"还是"放弃"。
 */
function assertVersionMatches(actual, expected, file, method) {
  if (actual === expected) return
  throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
    `document version is ${actual}, but the request was prepared for version ${expected}; `
    + 're-read vscode.getDocumentState and re-apply against the current version',
    { method, file, expected, actual })
}

/**
 * 读目标范围的**当前文本**，用于 `expectedRangeText` 逐字比对。
 *
 * 为什么还要这一道（版本已经保证了"中间没被改过"）：版本只能证明"文档没变"，
 * 证明不了"调用方记的那组坐标当时取的就是这两个字符"。坐标算错一位时版本照样匹配，
 * 而内容比对会当场发现 —— data 里带 `reason:'range-text-mismatch'`，处置与版本冲突一样。
 */
async function readTargetRangeText(host, abs, apiRange, method) {
  if (typeof host.readRangeText !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'host does not implement readRangeText; cannot verify params.expectedRangeText',
      { method, hostField: 'readRangeText' })
  }
  let actual
  try {
    actual = await host.readRangeText(abs, apiRange)
  } catch (err) {
    throw new BridgeError(ERR.INTERNAL,
      `cannot read range text for ${abs}: ${err?.message ?? err}`, { method, path: abs })
  }
  if (typeof actual !== 'string') {
    throw new BridgeError(ERR.INTERNAL,
      'host returned a non-string range text; refusing to compare',
      { method, path: abs, got: { type: typeof actual } })
  }
  return actual
}

/**
 * 创建能力实现集合。
 *
 * @param {object} host 注入的宿主能力，全部可替身：
 * @param {(p: string) => boolean}                    host.fileExists
 * @param {(p: string) => string}                     host.resolvePath   相对路径 → 绝对路径（锚工作区根）
 * @param {() => string[]}                            host.workspaceRoots
 * @param {() => boolean}                             host.isTrusted
 * @param {(p: string, opts) => Promise<void>}        host.openTextDocument 打开文本文件并定位
 * @param {(p: string) => Promise<void>}              host.openExternalFile  用系统方式打开二进制文件
 * @param {() => object|null}                         host.activeEditor  返回 {file, text, start, end} 或 null
 * @param {(abs: string|null) => Array<{file: string, diagnostics: Array<{severity:string,line:number,character:number,message:string,source?:string,code?:any}>}>} host.collectDiagnostics
 * @param {() => Array<{file: string, isActive?: boolean, isDirty?: boolean, languageId?: string}>} host.listEditors
 * @param {(abs: string, range: {start:{line:number,column:number}, end:{line:number,column:number}}, text: string, expectedVersion: number) => Promise<{applied: boolean, documentPath?: string|null, version?: number|null}>} [host.applyEditText]
 *        在**缓冲区**里替换一段文本（0-based range，已在校验层转过一次）。**不许保存**。
 *        **`expectedVersion` 必须由这一层在提交那一刻再判一次**（T32 / 评审 T31 的 B1）：
 *        适配器实现见 `edit-transaction.js` —— 在 `TextEditor.edit` 的**同步 callback** 里
 *        读 `document.version`、与 `expectedVersion` 比对，不等就**不构造任何 edit** 并报
 *        `-32012`（`data = { file, expected, actual }`，与前置检查同形）。
 *        只收一个"前置检查已通过"的布尔值是不够的：能力层到这一层之间隔着 await，
 *        人工编辑就发生在那几个让出点里（T31 实证 RACE_* 四行 `applied=true`）。
 *        `documentPath` 是**编辑器报告的文档身份**（VS Code 里即 `document.uri.fsPath`），
 *        必须由适配器提供：它是"写到底落在哪个文档"的唯一真值（评审 R3-1）。
 *        报不出来 → handler 失败闭合（`-32603 document-identity-unavailable`），不报成功。
 * @param {(abs: string, lines: number[]) => Promise<{lineCount: number, lineLengths?: Array<number|null>}>} [host.readDocumentShape]
 *        读**文档**（不是磁盘）的行数与指定 1-based 行的行长；用于范围边界检查（评审 F8）。
 *        缺失即失败闭合：没有它就证明不了范围合法，宁可拒也不交给宿主 clamp。
 * @param {(abs: string, opts: {includeText: boolean}) => Promise<{version: number, isDirty: boolean, eol: 'lf'|'crlf', lineCount: number, textLength: number, byteLength: number, text?: string}>} [host.readDocumentState]
 *        读**文档**（不是磁盘）的状态：`version` 是 VS Code 的 `TextDocument.version`
 *        （每次缓冲区被改动就 +1，**不是**磁盘 mtime、不是内容哈希）。
 *        `text` 只在 `includeText === true` 时给出（全集，绝不许是截断的一段）。
 *        缺失即失败闭合：没有它就没有写入锚点，写入一律拒（T30）。
 * @param {(abs: string, range: {start:{line:number,column:number}, end:{line:number,column:number}}) => Promise<string>} [host.readRangeText]
 *        读**文档**里 0-based range 的当前文本，用于 `expectedRangeText` 逐字比对（T30）。
 *        缺失即失败闭合（只在调用方给了 `expectedRangeText` 时才需要）。
 * @param {(msg: string) => void}                     [host.log]
 * @param {object} [opts]
 * @param {import('../../dsh-vscode-kit/src/grant.js').GrantStore} [opts.grants]
 *        会话授权表（与 connector 共用**同一个实例** —— 另建一份等于另立一套判定）。
 * @param {() => boolean} [opts.isTrusted]  工作区信任（判序在 grant 之前，评审 F7）
 * @param {(method, params, ctx) => void} [opts.grantGate] 自定义绑定门（测试用）
 */
export function createCapabilities(host, opts = {}) {
  const log = host.log ?? (() => {})
  const grants = opts.grants ?? null
  // 信任来源优先取调用方注入（connector 侧无 host），否则用宿主自己那份。
  const isTrusted = opts.isTrusted ?? (typeof host.isTrusted === 'function' ? host.isTrusted : null)

  /**
   * 同文件写入串行化（T32 / 评审 T31-B1 建议 ③）：`规范化路径 → promise 链尾`。
   *
   * 解决的是**两个请求之间**的竞争（不是"请求与人之间"的竞争 —— 那个只能靠事务内判定）：
   * 两条同版本的重放在同一个文件上并发时，没有这条链，两个请求的前置检查会读到同一个
   * 旧版本、双双走到写宿主（事务内判定会把第二个拒掉，但"宿主零调用"的便宜就丢了，
   * 而且错误更晚才出现）。
   *
   * 键是**同一文件的稳定身份**（`resolveWorkspaceFile` 证明过的 realpath，再走
   * `serializeKeyFor` 按平台归一；Windows 折小写是因为 NTFS 不区分大小写，其它平台原样）：
   * 同一个文件的不同写法（相对/绝对、段名大小写、8.3 短名）落在同一条链上 —— 否则
   * "串行化"只对写法一致的那一半请求生效，等于没做（T33 实证：大写别名会让同文件进两条链）。
   * **不是全局锁**：不同文件各有一条链，互不排队（写入不同文件本来就该并行）。
   *
   * 释放靠 `tail`（永不 reject 的链尾）：任务失败也必须把锁让出去，否则一条出错的任务
   * 会让后面所有排队者永远挂着。`run` 才是给调用方的 promise —— 它照常带着错误和结果。
   */
  const writeChains = new Map()

  function serializeByPath(key, task) {
    const prev = writeChains.get(key) ?? Promise.resolve()
    const run = prev.then(() => task())
    // 链尾吞掉错误：链上任何一个任务失败都不许传染给排队者（它们各有各的判定）。
    const tail = run.then(() => {}, () => {})
    writeChains.set(key, tail)
    const release = () => { if (writeChains.get(key) === tail) writeChains.delete(key) }
    tail.then(release, release)
    return run
  }

  /**
   * 绑定门（契约 §6.1.1 ②）：**分派进 handler 之前**判一次。
   * 没注入授权表时 fail-closed —— 写入类一律 no-grant，读操作照旧（读不要求授权）。
   */
  const grantGate = opts.grantGate ?? (grants
    ? extensionWriteGate(grants, { isTrusted })
    : (method) => {
        if (isWriteMethod(method)) throw editNotBoundError(method, GRANT_REASONS.NO_GRANT, 1)
      })

  /** 所有能力共用的前置检查：工作区信任。 */
  function assertTrusted(method) {
    if (!host.isTrusted()) {
      throw new BridgeError(ERR.UNTRUSTED_WORKSPACE,
        'workspace is not trusted; refusing to expose editor capabilities', { method })
    }
  }

  /**
   * vscode.openFile
   * params: { path: string, line?: number(1-based), column?: number(1-based), preview?: boolean }
   * result: { opened: true, path: string, mode: 'text'|'external' }
   */
  async function openFile(params) {
    assertTrusted('vscode.openFile')
    const raw = params?.path
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.path must be a non-empty string',
        { method: 'vscode.openFile' })
    }

    const abs = host.resolvePath(raw)
    if (!host.fileExists(abs)) {
      throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`,
        { method: 'vscode.openFile', path: abs })
    }

    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase()
    const line = toZeroBased(params?.line, 0)
    const column = toZeroBased(params?.column, 0)

    // 二进制文件交给系统默认程序：文本编辑器打开会抛 "File seems to be binary"。
    if (BINARY_EXT.has(ext)) {
      await host.openExternalFile(abs)
      log(`openFile: ${abs} opened externally (binary .${ext})`)
      return { opened: true, path: canonicalPath(abs), mode: 'external' }
    }

    await host.openTextDocument(abs, { line, column, preview: params?.preview === true })
    log(`openFile: ${abs} opened at ${line + 1}:${column + 1}`)
    return { opened: true, path: canonicalPath(abs), mode: 'text' }
  }

  /**
   * vscode.getSelection
   * params: {} （未来可加 format）
   * result: { text, file, start:{line,column}, end:{line,column}, isEmpty } —— line/column 为 1-based
   */
  async function getSelection() {
    assertTrusted('vscode.getSelection')
    const sel = host.activeEditor()
    if (!sel) {
      throw new BridgeError(ERR.NOT_FOUND, 'no active editor',
        { method: 'vscode.getSelection' })
    }
    return {
      text: sel.text,
      file: canonicalPath(sel.file),
      start: { line: sel.start.line + 1, column: sel.start.character + 1 },
      end: { line: sel.end.line + 1, column: sel.end.character + 1 },
      isEmpty: sel.isEmpty === true,
    }
  }

  /**
   * vscode.getDiagnostics
   * params: { path?: string, severity?: 'error'|'warning'|'info'|'hint', limit?: number }
   *   不给 path 就取工作区全部（只取有诊断的文件，避免遍历整个工作区）。
   * result: { total, files: [{file, diagnostics: [{severity, line, column, message, source, code}]}] }
   *   line/column 为 1-based；severity 用字符串而不是 VSCode 的数字枚举（跨进程契约不暴露第三方枚举）。
   * 用途：让 DSH 侧知道「我刚改的文件有没有编译错误」，这是编辑闭环里最常问的问题。
   */
  async function getDiagnostics(params) {
    assertTrusted('vscode.getDiagnostics')
    const severity = params?.severity
    const SEV = new Set(['error', 'warning', 'info', 'hint'])
    if (severity !== undefined && !SEV.has(severity)) {
      throw new BridgeError(ERR.INVALID_PARAMS,
        `params.severity must be one of ${[...SEV].join('|')}`, { method: 'vscode.getDiagnostics' })
    }
    const limit = Number.isInteger(params?.limit) && params.limit > 0
      ? Math.min(params.limit, 500)
      : 200

    let target
    if (params?.path !== undefined) {
      if (typeof params.path !== 'string' || params.path.trim() === '') {
        throw new BridgeError(ERR.INVALID_PARAMS, 'params.path must be a non-empty string when given',
          { method: 'vscode.getDiagnostics' })
      }
      target = host.resolvePath(params.path)
      if (!host.fileExists(target)) {
        throw new BridgeError(ERR.NOT_FOUND, `file not found: ${target}`,
          { method: 'vscode.getDiagnostics', path: target })
      }
    }

    // host.collectDiagnostics 返回 [{file, diagnostics:[{severity:'error', line, character, message, source, code}]}]
    // line/character 已是 0-based；本层负责转 1-based 与过滤/截断。
    const raw = host.collectDiagnostics(target ?? null)
    const files = []
    let total = 0
    for (const entry of raw) {
      const picked = []
      for (const d of entry.diagnostics) {
        if (severity !== undefined && d.severity !== severity) continue
        picked.push({
          severity: d.severity,
          line: d.line + 1,
          column: d.character + 1,
          message: d.message,
          ...(d.source === undefined ? {} : { source: d.source }),
          ...(d.code === undefined ? {} : { code: d.code }),
        })
        if (total + picked.length >= limit) break
      }
      if (picked.length === 0) continue
      total += picked.length
      files.push({ file: canonicalPath(entry.file), diagnostics: picked })
      if (total >= limit) break
    }
    log(`getDiagnostics: ${total} diagnostic(s) in ${files.length} file(s)`)
    return { total, files, truncated: total >= limit }
  }

  /**
   * vscode.listOpenEditors
   * params: { limit?: number }
   * result: { editors: [{file, isActive, isDirty, languageId}], total }
   * 用途：让 DSH 侧知道用户眼下开着哪些文件，不用问人。
   */
  async function listOpenEditors(params) {
    assertTrusted('vscode.listOpenEditors')
    const limit = Number.isInteger(params?.limit) && params.limit > 0
      ? Math.min(params.limit, 200)
      : 50
    const all = host.listEditors()
    const editors = all.slice(0, limit).map((e) => ({
      file: canonicalPath(e.file),
      isActive: e.isActive === true,
      isDirty: e.isDirty === true,
      ...(e.languageId === undefined ? {} : { languageId: e.languageId }),
    }))
    return { editors, total: all.length, truncated: all.length > editors.length }
  }

  /**
   * vscode.getDocumentState —— 写入锚点的读侧（T30）。
   *
   * params: { file: string, includeText?: boolean }
   * result: { file, version, isDirty, eol: 'lf'|'crlf', lineCount, textLength,
   *           textUnavailable?: true, text?: string }
   *
   * 为什么需要这条能力：`applyEdit` 的 `expectedVersion` 只能从对端读到的
   * `TextDocument.version` 来。没有读侧，写入锚点就成了"猜一个数字"。
   *
   * 三件事刻意不做：
   *  1. **不读磁盘**：`version` / `lineCount` / `text` 全部来自编辑器持有的文档
   *     （缓冲区可能已改未存，按磁盘读到的行数与用户眼前看到的不一致 —— 正是 T4 里
   *     「坐标漂移」的成因之一）。
   *  2. **不截断**：`includeText:true` 且文档超过 `MAX_TEXT_BYTES` 时**整份不给**，
   *     改回 `textUnavailable:true`。截断后当全文是最坏的形态（见 MAX_TEXT_BYTES 注释）。
   *  3. **不写、不保存、不开新窗口**：纯读，因此**不要求** grant（写入才要求）。
   */
  async function getDocumentState(params) {
    const method = 'vscode.getDocumentState'
    assertTrusted(method)

    const file = params?.file
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const rawInclude = params?.includeText
    if (rawInclude !== undefined && typeof rawInclude !== 'boolean') {
      throw new BridgeError(ERR.INVALID_PARAMS,
        'params.includeText must be a boolean when provided',
        { method, reason: 'include-text-not-a-boolean', got: { type: typeof rawInclude } })
    }
    const includeText = rawInclude === true

    // 路径守卫与 applyEdit **同一套**（拒链接、拒多根、必须在工作区内）：
    // 读的路径和写的路径必须是同一类证明，否则"读得到但写不了"或反之的错配就是新缺口。
    // 失败码与 openFile 同族：-32602（路径不合法）/ -32003（不存在）。
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    const state = await readDocumentState(host, real, { includeText }, method)
    const out = {
      // 与其它能力同一口径：回规范化绝对路径，不回调用方写的那一串。
      file: canonicalPath(abs),
      version: state.version,
      isDirty: state.isDirty,
      eol: state.eol,
      lineCount: state.lineCount,
      textLength: state.textLength,
    }

    if (!includeText) {
      log(`getDocumentState: ${abs} v${state.version}${state.isDirty ? ' (dirty)' : ''}`)
      return out
    }
    if (state.byteLength > MAX_TEXT_BYTES) {
      // 超限 = 整份不给。**不许**截断后当全文：调用方会拿它算坐标。
      log(`getDocumentState: ${abs} v${state.version} text withheld `
        + `(${state.byteLength} bytes > ${MAX_TEXT_BYTES})`)
      return { ...out, textUnavailable: true }
    }
    if (typeof state.text !== 'string') {
      // 要了全文、体积也没超限，宿主却没给 —— 适配器故障，失败闭合。
      throw new BridgeError(ERR.INTERNAL,
        `host did not return text for ${abs} although it was requested and within ${MAX_TEXT_BYTES} bytes`,
        { method, path: abs, hostField: 'readDocumentState', textLength: state.textLength })
    }
    log(`getDocumentState: ${abs} v${state.version} text=${state.textLength} chars`)
    return { ...out, text: state.text }
  }

  /**
   * vscode.applyEdit —— 协作编辑的第一个写入类能力（契约 §6.1.1）。
   *
   * params: { file: string, range: {start:{line,column}, end:{line,column}}（1-based）,
   *           text: string, **expectedVersion: number（必填，整数 ≥ 0）**,
   *           expectedRangeText?: string, grant: {id, epoch} }
   * result: { applied: boolean, file: string（规范化绝对路径）, saved: false, textLength: number }
   *
   * **不保存**：只改缓冲区（`TextEditor.edit`），落盘是 T4 的事。
   * 返回值里的 `saved:false` 不是装饰 —— 它是给 DSH 侧的业务承诺，`response-contract.js`
   * 会把它当谓词校验（`saved === false`），谁把保存加进来谁就得先改契约。
   *
   * **版本锚点（T30）**：`expectedVersion` 必填，值取 `vscode.getDocumentState` 回的
   * `version`（编辑器的 `TextDocument.version`，缓冲区每次被改动 +1）。
   *  - 缺失 / 非整数 / 负数 → `-32602`（`data.reason` 区分四种：见 `readExpectedVersion`），
   *    **宿主零调用**；
   *  - 与文档实际版本不等 → `-32012`，`data = { file, expected, actual }`。
   *    **前置检查里就不等** → 宿主零调用；**到了写入事务内才不等**（检查之后有人改了
   *    缓冲区）→ 宿主被调用但**零构造 edit**（`builder.replace` 一次都不执行，一个字没写）。
   *    后者才是 B1 的保证，见下面的"判序"。
   *  - 可选的 `expectedRangeText`（目标范围当前应有的文本）：给了就必须与
   *    `host.readRangeText` 读到的当前文本**逐字相等**，否则 `-32012`，
   *    `data = { file, expectedVersion, actualVersion, reason:'range-text-mismatch',
   *    expectedTextLength, actualTextLength }`，**宿主零调用**。
   *    它补的是版本锚点的盲区：版本相同但调用方记错了坐标时，只有内容比对能发现。
   *
   * **校验顺序（契约：判序本身就是契约）**：
   *   ① 路径守卫（`resolveWorkspaceFile`）→ ② 锚点形状（-32602）
   *   → ③ 版本等值（前置，-32012）→ ④ range 形状/越界（-32602）
   *   → ⑤ `expectedRangeText` 内容比对（-32012）→ ⑥ 授权绑定门（执行前复核）
   *   → ⑦ 写宿主；**宿主在提交那一刻再判一次版本（事务内判定，-32012）**。
   *
   * ⚠️ **前置检查不是保证，事务内判定才是**（T32 / 评审 T31 的 B1）。
   *   ③ 与 ⑦ 之间隔着 ④ 的 `readDocumentShape`、⑤ 的 `readRangeText` 两个 await ——
   *   用户敲一个字、格式化插件跑一次，都发生在这些让出点里。所以 ③ 只是**便宜的早失败**
   *   （错误更早、宿主零调用、日志更好读），真正"绝不覆盖人工内容"的保证在
   *   `edit-transaction.js`：`TextEditor.edit` 的 callback 里同步读 `document.version`、
   *   比对、构造 edit，中间没有让出点。谁把 ⑦ 挪走、或让 ⑦ 退回
   *   `vscode.workspace.applyEdit`（没有版本 CAS），B1 就地复现。
   *   同一文件的**并发重放**另由 `serializeByPath` 串行化（②之后入队，键=`serializeKeyFor(real)`）。
   *
   * 线性化点（契约 §6.1.1 ④）= `host.applyEditText` 这一次调用：它之前失败 = 零落点，
   * 它之后（含超时/断线）结果未知，按"可能已落点"处理。
   */
  async function applyEdit(params, ctx) {
    const method = 'vscode.applyEdit'
    assertTrusted(method)

    const file = params?.file
    if (typeof file !== 'string' || file.trim() === '') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.file must be a non-empty string', { method })
    }
    const text = params?.text
    if (typeof text !== 'string') {
      throw new BridgeError(ERR.INVALID_PARAMS, 'params.text must be a string', { method })
    }

    // ── ① 路径守卫 ──
    // 工作区内、真实路径、不是链接（详细规则见 workspace-paths.js）。
    // 排在锚点判定之前：路径不合法时连"这个文档的版本是多少"都不该讨论。
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    // ── ② 锚点形状（纯参数检查、零 await）──
    // 形状错误（-32602）与排队无关，放锁外：非法请求不必排在别人后面等。
    const expectedVersion = readExpectedVersion(params, method)
    const expectedRangeText = readExpectedRangeText(params, method)

    // ── 同一文件的写入排队（T32 建议 ③）──
    // 从这里到写宿主**整段串行**：第二个请求是在锁内才读版本的，所以它必然看到第一个
    // 请求 bump 之后的版本、拿到 -32012；而不是两个都拿着旧版本一起摸到写宿主。
    // 键是同一文件的**稳定身份**（见 `serializeKeyFor`）—— 同文件的不同写法落在同一条链上，
    // 不同文件互不排队。这里**不许**退回 `canonicalPath(real)`：那只统一盘符，段名大小写
    // 在 Windows 上会让同一文件进两条链（T33 / 评审 I1）。
    // 展示与错误 data 里的 `file` 仍然走 `canonicalPath(abs)`，锁键不参与对外输出。
    return serializeByPath(serializeKeyFor(real),
      () => writeUnderLock({ method, abs, real, text, expectedVersion, expectedRangeText, params, ctx }))
  }

  /**
   * 写入主体：判序 ③–⑦（说明见 `applyEdit` 的 JSDoc）。**只在同文件的排队链里执行**，
   * 所以这里可以放心用"读版本 → 用坐标"的写法：同一文件的另一条写入不可能插进来。
   * 但**人工编辑**仍然可以插进来 —— 那只能由 ⑦ 的事务内判定挡住。
   */
  async function writeUnderLock({ method, abs, real, text, expectedVersion, expectedRangeText, params, ctx }) {
    // ── ③ 版本等值（前置检查：不是保证，见 JSDoc 的 ⚠️）──
    // 这里读到的是"这一刻"的版本；下面的 ④⑤ 都是让出点，人工编辑可以在其中发生。
    const state = await readDocumentState(host, real, { includeText: false }, method)
    assertVersionMatches(state.version, expectedVersion, canonicalPath(abs), method)

    // ── ④ 范围形状 / 越界 ──
    const range = readRange(params?.range, method)
    // 范围边界（评审 F8）：越界不许交给宿主自己 clamp —— clamp 之后
    // 「写到第 999 行」会静默变成「写到文件末尾」还报 applied:true。
    // 与路径守卫同层：都是**调用方可以自证**的参数错误（-32602），都在绑定门之前。
    const shape = await readDocumentShape(host, real, [range.start.line, range.end.line], method)
    assertRangeInBounds(shape, range, method)

    // ── ⑤ 范围内容比对（可选，但给了就必须逐字相等） ──
    // 版本只能证明"文档没变"，证明不了"你这组坐标当时取的就是这几个字符"。
    if (expectedRangeText !== undefined) {
      const actualText = await readTargetRangeText(host, real, toApiRange(range), method)
      if (actualText !== expectedRangeText) {
        throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
          'params.expectedRangeText does not match the current text of the target range; '
          + 'nothing was written — re-read the document and re-derive the range',
          {
            method,
            file: canonicalPath(abs),
            expectedVersion,
            actualVersion: state.version,
            reason: 'range-text-mismatch',
            // 只回长度，不回内容：错误 data 会进日志，文档内容不该跟着跑。
            expectedTextLength: expectedRangeText.length,
            actualTextLength: actualText.length,
          })
      }
    }

    if (typeof host.applyEditText !== 'function') {
      // 宿主太老（或测试替身没实现）：说清楚缺哪个字段，别让它变成"静默不生效"。
      throw new BridgeError(ERR.INTERNAL,
        'host does not implement applyEditText; this extension build cannot edit buffers',
        { method, hostField: 'applyEditText' })
    }

    // ── ⑥ 执行前复核（契约 §6.1.1 ②B / ③）：线性化点之前再判一次 ──
    // 分派前的门与这里之间有 await/入队缝隙，凭证可能刚被撤销、连接可能刚被取代；
    // 只看"进门时是好的"是不够的 —— 真正要保证的是"动手那一刻还是好的"。
    grantGate(method, params, ctx)

    // ── 写前重验 + 贴着写（评审 R2-1 ①②） ──
    // 上面 `await readDocumentShape` 是一个真实的让出点（打开文档、可能要等 VS Code
    // 加载文本），目录可以在其间被换成 junction。所以紧贴写宿主再验一次，
    // 并且**把刚验到的那个字符串交给宿主** —— 不许验一个、传另一个。
    // 这一段与下面的 applyEditText 之间没有别的 await：窗口缩到一次同步调用。
    const writeTarget = revalidateWriteTarget({ abs, real }, host.workspaceRoots(), { method })

    // ── ⑦ 写宿主：版本等值的**唯一保证**在这一次调用的内部（T32）──
    // 传下去的是**锚点本身**（`expectedVersion`），不是一个"我已检查过"的布尔值：
    // 宿主/适配器在 `TextEditor.edit` 的同步 callback 里读 `document.version` 再比一次。
    // 上面 ④⑤ 已经跑过几个 await，人工编辑完全可能就发生在其中 —— 所以这一道不是重复劳动，
    // 而是唯一真正挡住 B1 的那一道（`edit-transaction.js`）。
    const outcome = await host.applyEditText(writeTarget, toApiRange(range), text, expectedVersion)
    // ── 写后复核（评审 R2-1 ③） ──
    // 写入已经发生，本步阻止不了"落到了被换掉的目录"；它只是在**采样到路径差异/解析失败**
    // 时拒报成功（-32603）。它是采样而不是写入历史：替换持续到此刻才算数，
    // "没采样到差异"不代表没被替换过（换出再换回就看不出来）—— 完整判据在下一行。
    assertTargetUnchanged(writeTarget, { method })
    // ── 写入文档身份（评审 R3-1：这才是"写到底落在哪个文档"的判据） ──
    // 写宿主必须报出它实际编辑的那个文档的规范化路径（`document.uri.fsPath` 之类）；
    // 与写前验过的 `writeTarget` 不一致 → 不报成功（-32602）；报不出来 → 失败闭合（-32603）。
    // 在此之前的所有检查都只能证明"这个路径此刻指向哪"，只有文档身份能证明"写进了哪个文档"。
    assertWrittenDocumentIdentity(outcome, writeTarget, { method })
    const applied = outcome?.applied !== false
    log(`applyEdit: ${abs} ${applied ? 'applied' : 'rejected by host'}`
      + ` ${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`
      + ` (${text.length} chars, buffer only — not saved)`)
    return {
      applied,
      // 回传**规范化后的绝对路径**（与 openFile/getSelection 同一口径），
      // 而不是调用方传进来的那个写法：消费者按字符串比较时才不会静默失败。
      file: canonicalPath(abs),
      saved: false,
      textLength: text.length,
    }
  }

  const handlers = {
    'vscode.openFile': openFile,
    'vscode.getSelection': getSelection,
    'vscode.getDiagnostics': getDiagnostics,
    'vscode.listOpenEditors': listOpenEditors,
    'vscode.applyEdit': applyEdit,
    'vscode.getDocumentState': getDocumentState,
  }

  /**
   * 统一分派入口 —— 交给协议层当 onRequest。
   * 未实现的方法回 -32005（不是 -32601）：让 DSH 侧能区分「对端不支持」与「协议层方法不存在」，
   * 前者应降级、后者是编程错误。
   *
   * 三道门的顺序（契约 §6.1 / §6.1.1 ②）：
   *   ① 方法存在与否 → ② 工作区信任（-32006）→ ③ 绑定门（-32010）→ handler。
   * 信任排在建前面：工作区不受信任时连"你的凭证对不对"都不该讨论（一律不暴露能力）。
   * `ctx` 是协议层的消息上下文（含 `link` = 承载这条请求的连接实例），绑定门判的就是它的**对象身份**。
   */
  async function dispatch(method, params, ctx) {
    const handler = handlers[method]
    if (!handler) {
      throw new BridgeError(ERR.UNSUPPORTED, `capability not implemented: ${method}`, { method })
    }
    assertTrusted(method)
    grantGate(method, params, ctx)
    return handler(params, ctx)
  }

  return { dispatch, handlers, CAPABILITIES }
}
