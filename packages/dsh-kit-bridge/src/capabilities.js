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

/** 本扩展声明支持的能力清单（写进发现文件 / hello 的 capabilities）。 */
export const CAPABILITIES = [
  'vscode.openFile',
  'vscode.getSelection',
  'vscode.getDiagnostics',
  'vscode.listOpenEditors',
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
 * @param {(msg: string) => void}                     [host.log]
 */
export function createCapabilities(host) {
  const log = host.log ?? (() => {})

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

  const handlers = {
    'vscode.openFile': openFile,
    'vscode.getSelection': getSelection,
    'vscode.getDiagnostics': getDiagnostics,
    'vscode.listOpenEditors': listOpenEditors,
  }

  /**
   * 统一分派入口 —— 交给协议层当 onRequest。
   * 未实现的方法回 -32005（不是 -32601）：让 DSH 侧能区分「对端不支持」与「协议层方法不存在」，
   * 前者应降级、后者是编程错误。
   */
  async function dispatch(method, params) {
    const handler = handlers[method]
    if (!handler) {
      throw new BridgeError(ERR.UNSUPPORTED, `capability not implemented: ${method}`, { method })
    }
    return handler(params)
  }

  return { dispatch, handlers, CAPABILITIES }
}
