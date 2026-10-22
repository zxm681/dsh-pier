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
]

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
 * @param {(abs: string, range: {start:{line:number,column:number}, end:{line:number,column:number}}, text: string) => Promise<{applied: boolean, documentPath?: string|null}>} [host.applyEditText]
 *        在**缓冲区**里替换一段文本（0-based range，已在校验层转过一次）。**不许保存**。
 *        `documentPath` 是**编辑器报告的文档身份**（VS Code 里即 `document.uri.fsPath`），
 *        必须由适配器提供：它是"写到底落在哪个文档"的唯一真值（评审 R3-1）。
 *        报不出来 → handler 失败闭合（`-32603 document-identity-unavailable`），不报成功。
 * @param {(abs: string, lines: number[]) => Promise<{lineCount: number, lineLengths?: Array<number|null>}>} [host.readDocumentShape]
 *        读**文档**（不是磁盘）的行数与指定 1-based 行的行长；用于范围边界检查（评审 F8）。
 *        缺失即失败闭合：没有它就证明不了范围合法，宁可拒也不交给宿主 clamp。
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
   * vscode.applyEdit —— 协作编辑的第一个写入类能力（契约 §6.1.1）。
   *
   * params: { file: string, range: {start:{line,column}, end:{line,column}}（1-based）,
   *           text: string, grant: {id, epoch} }
   * result: { applied: boolean, file: string（规范化绝对路径）, saved: false, textLength: number }
   *
   * **不保存**：只改缓冲区（`vscode.workspace.applyEdit`），落盘是 T4 的事。
   * 返回值里的 `saved:false` 不是装饰 —— 它是给 DSH 侧的业务承诺，`response-contract.js`
   * 会把它当谓词校验（`saved === false`），谁把保存加进来谁就得先改契约。
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
    const range = readRange(params?.range, method)

    // 路径守卫：工作区内、真实路径、不是链接（详细规则见 workspace-paths.js）。
    const { abs, real } = resolveWorkspaceFile(file, host.workspaceRoots(), { method })

    // 范围边界（评审 F8）：越界不许交给宿主自己 clamp —— clamp 之后
    // 「写到第 999 行」会静默变成「写到文件末尾」还报 applied:true。
    // 与路径守卫同层：都是**调用方可以自证**的参数错误（-32602），都在绑定门之前。
    const shape = await readDocumentShape(host, real, [range.start.line, range.end.line], method)
    assertRangeInBounds(shape, range, method)

    if (typeof host.applyEditText !== 'function') {
      // 宿主太老（或测试替身没实现）：说清楚缺哪个字段，别让它变成"静默不生效"。
      throw new BridgeError(ERR.INTERNAL,
        'host does not implement applyEditText; this extension build cannot edit buffers',
        { method, hostField: 'applyEditText' })
    }

    // ── 执行前复核（契约 §6.1.1 ②B / ③）：线性化点之前再判一次 ──
    // 分派前的门与这里之间有 await/入队缝隙，凭证可能刚被撤销、连接可能刚被取代；
    // 只看"进门时是好的"是不够的 —— 真正要保证的是"动手那一刻还是好的"。
    grantGate(method, params, ctx)

    // ── 写前重验 + 贴着写（评审 R2-1 ①②） ──
    // 上面 `await readDocumentShape` 是一个真实的让出点（打开文档、可能要等 VS Code
    // 加载文本），目录可以在其间被换成 junction。所以紧贴写宿主再验一次，
    // 并且**把刚验到的那个字符串交给宿主** —— 不许验一个、传另一个。
    // 这一段与下面的 applyEditText 之间没有别的 await：窗口缩到一次同步调用。
    const writeTarget = revalidateWriteTarget({ abs, real }, host.workspaceRoots(), { method })

    const outcome = await host.applyEditText(writeTarget, toApiRange(range), text)
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
