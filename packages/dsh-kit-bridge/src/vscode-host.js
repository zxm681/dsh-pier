/**
 * VS Code 宿主适配器：把 vscode API 包成 capabilities/connector 需要的形状。
 *
 * 隔离目的很实在：能力实现与连接管理都不 import 'vscode'，因此能在 node:test 里
 * 用假 host 跑真 TCP 端到端。**只有这个文件**知道 vscode 长什么样。
 */

import path from 'node:path'
import { existsSync, statSync } from 'node:fs'

import * as vscode from 'vscode'

import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities } from './capabilities.js'

/**
 * 建适配器。`output` 是扩展的日志通道（可选）。
 * @param {import('vscode').OutputChannel} [output]
 */
export function createHost(output) {
  const log = (msg) => { try { output?.appendLine(msg) } catch { /* ignore */ } }

  /** 工作区根（可能多个；首版只取第一个非空）。 */
  function workspaceRoots() {
    return (vscode.workspace.workspaceFolders ?? [])
      .map((f) => f.uri.fsPath)
      .filter(Boolean)
  }

  /**
   * 相对路径锚到工作区根。绝对路径原样返回。
   * 与 Fengze233 的教训对应（#32）：会话 cwd 与工作区根常不一致，
   * 调用方应尽量传绝对路径；这里只做兜底。
   */
  function resolvePath(p) {
    if (path.isAbsolute(p)) return path.normalize(p)
    const roots = workspaceRoots()
    if (roots.length === 0) {
      // 无工作区时锚到用户主目录，而不是 process.cwd()（扩展宿主的 cwd 无意义）
      return path.resolve(process.env.USERPROFILE ?? process.env.HOME ?? '.', p)
    }
    return path.resolve(roots[0], p)
  }

  async function openTextDocument(abs, { line = 0, column = 0, preview = false } = {}) {
    const uri = vscode.Uri.file(abs)
    const doc = await vscode.workspace.openTextDocument(uri)
    const pos = new vscode.Position(
      Math.max(0, Math.min(line, Math.max(0, doc.lineCount - 1))),
      Math.max(0, column),
    )
    const sel = new vscode.Selection(pos, pos)
    await vscode.window.showTextDocument(doc, {
      preview,
      selection: sel,
      viewColumn: vscode.ViewColumn.Active,
    })
  }

  async function openExternalFile(abs) {
    // 用默认程序打开：文本编辑器对图片/PDF 会报 "File seems to be binary"（#33）。
    const ok = await vscode.env.openExternal(vscode.Uri.file(abs))
    if (!ok) throw new Error(`no application could open ${abs}`)
  }

  function activeEditor() {
    const editor = vscode.window.activeTextEditor
    if (!editor) return null
    const sel = editor.selection
    return {
      file: editor.document.uri.fsPath,
      text: editor.document.getText(sel),
      start: { line: sel.start.line, character: sel.start.character },
      end: { line: sel.end.line, character: sel.end.character },
      isEmpty: sel.isEmpty,
    }
  }

  /**
   * 收集诊断。`abs` 为 null 时取工作区全部（只遍历「有诊断的文件」，不扫磁盘）。
   * 返回 0-based 的 line/character，与 VSCode 内部一致；1-based 转换在 capabilities 层做。
   */
  function collectDiagnostics(abs) {
    const SEVERITY_NAME = ['error', 'warning', 'info', 'hint']
    const mapOne = (uri, diags) => ({
      file: uri.fsPath,
      diagnostics: diags.map((d) => ({
        severity: SEVERITY_NAME[d.severity] ?? 'info',
        line: d.range.start.line,
        character: d.range.start.character,
        message: d.message,
        ...(d.source === undefined ? {} : { source: d.source }),
        ...(d.code === undefined
          ? {}
          : { code: typeof d.code === 'object' ? d.code.value : d.code }),
      })),
    })

    if (abs) {
      return [mapOne(vscode.Uri.file(abs), vscode.languages.getDiagnostics(vscode.Uri.file(abs)))]
        .filter((e) => e.diagnostics.length > 0)
    }
    // 全工作区：getDiagnostics() 无参返回 [Uri, Diagnostic[]][]，只含有诊断的条目。
    return vscode.languages.getDiagnostics()
      .filter(([, diags]) => diags.length > 0)
      .map(([uri, diags]) => mapOne(uri, diags))
  }

  /** 打开的编辑器列表（按 VSCode 的展示顺序）。 */
  function listEditors() {
    const active = vscode.window.activeTextEditor
    return (vscode.window.tabGroups?.all ?? [])
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText)
      .map((t) => {
        const uri = t.input.uri
        const editor = vscode.window.visibleTextEditors.find(
          (e) => e.document.uri.toString() === uri.toString(),
        )
        return {
          file: uri.fsPath,
          isActive: active?.document.uri.toString() === uri.toString(),
          isDirty: t.isDirty === true,
          ...(editor === undefined ? {} : { languageId: editor.document.languageId }),
        }
      })
  }

  /**
   * 读**文档**（不是磁盘）的行数与指定行行长 —— 范围边界检查的唯一数据源（评审 F8）。
   *
   * 为什么用 `openTextDocument` 而不是 `readFileSync`：真机里缓冲区可能已改未存，
   * 按磁盘算行数会把合法范围判成越界（或者更糟：把越界判成合法，然后被
   * `vscode.Range` clamp 成「写到最后一行」）。
   * `openTextDocument` 对已打开的文档返回**同一个**内存实例，不会读盘覆盖改动。
   */
  async function readDocumentShape(abs, lines = []) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    const requested = Array.isArray(lines) ? lines : []
    return {
      lineCount: doc.lineCount,
      lineLengths: requested.map((n) => (n >= 1 && n <= doc.lineCount
        ? doc.lineAt(n - 1).text.length
        : null)),
    }
  }

  /**
   * 编辑器对「这个 uri」持有的那个文档的规范化路径 —— 也就是**缓冲区身份**
   * （评审 R3-1：能力层拿它判定"写到底落在哪个文档"）。
   *
   * 为什么要绕一圈从编辑器取、而不是把传进来的 `abs` 原样回传：传进来的字符串只能证明
   * "请求发到了哪"，证明不了"编辑器把它落到哪个文档"。`uri.fsPath` 是编辑器自己的视图
   * （大小写规范化、盘符统一、将来换成别的 scheme 也是它说了算），所以只有它算身份。
   *
   * 优先在已打开的文档里找（同步、零成本）；找不到再 `openTextDocument` 一次
   * （对已打开的文档返回同一个内存实例，不会读盘覆盖未保存改动）。这一步在写入**之后**，
   * 所以它的 await 不构成写前窗口。
   *
   * @param {import('vscode').Uri} uri
   * @returns {Promise<string|null>} 拿不到就返回 null（由能力层失败闭合）
   */
  async function documentIdentity(uri) {
    try {
      const want = uri.toString()
      const open = (vscode.workspace.textDocuments ?? [])
        .find((d) => d?.uri?.toString() === want)
      if (open) return typeof open.uri.fsPath === 'string' ? open.uri.fsPath : null
      const doc = await vscode.workspace.openTextDocument(uri)
      return typeof doc?.uri?.fsPath === 'string' ? doc.uri.fsPath : null
    } catch (err) {
      log(`documentIdentity: cannot resolve ${uri?.fsPath ?? uri}: ${err?.message ?? err}`)
      return null
    }
  }

  /**
   * 在**缓冲区**里替换一段文本（`vscode.applyEdit` 的唯一落点）。
   *
   * `range` 是 **0-based**（转换在 capabilities 层做完了，见 `toApiRange`）——
   * 这里只负责把它原样塞进 `vscode.Range`。**一次减法都不许再出现在本文件**：
   * 边界之上的层已经保证"一个 1-based 输入只被减一次"，这里再减就是错行。
   *
   * **绝不保存**：不调 `document.save()`、不调 `workbench.action.files.save`。
   * 返回 `{applied, documentPath}`：`vscode.workspace.applyEdit` 返回 false 表示编辑器拒绝了
   * 这次编辑（例如文件被外部改动导致版本不匹配），必须如实上报，不许当成成功。
   * `documentPath` 是**编辑器报告的文档身份**（评审 R3-1）—— 拿不到就是 null，
   * 让能力层失败闭合，而不是编一个"就是我传进去的路径"糊过去。
   */
  async function applyEditText(abs, range, text) {
    const uri = vscode.Uri.file(abs)
    const edit = new vscode.WorkspaceEdit()
    const start = new vscode.Position(range.start.line, range.start.column)
    const end = new vscode.Position(range.end.line, range.end.column)
    edit.replace(uri, new vscode.Range(start, end), text)
    const applied = await vscode.workspace.applyEdit(edit)
    // 身份在写入**之后**取：它要回答的是"这次编辑落到哪个文档"，不是"我们请求了哪个路径"。
    const documentPath = await documentIdentity(uri)
    log(`applyEditText: ${abs} [${range.start.line}:${range.start.column}-`
      + `${range.end.line}:${range.end.column}] ${text.length} chars → applied=${applied}`
      + ` (not saved; document=${documentPath ?? 'unknown'})`)
    return { applied: applied === true, documentPath }
  }

  return {
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath,
    workspaceRoots,
    isTrusted: () => vscode.workspace.isTrusted,
    openTextDocument,
    openExternalFile,
    activeEditor,
    collectDiagnostics,
    listEditors,
    readDocumentShape,
    applyEditText,
    log,
  }
}

/**
 * 一步到位：从 vscode 搭出能力分派函数。
 *
 * 授权表在这里建（`grants`），**同一个实例**同时给能力层（执行前复核）和连接层
 * （收 `bridge.grant` / 断线置失效）—— 两份实例 = 两套判定，那是 bug 温床。
 * `linkState` 是"当前活连接"的共享槽：connector 写，诊断/观测量读。
 * 写入门**不再**从这里取"活连接"（评审 F4：判定表第 3 行才是连接存活的唯一出处），
 * 只取工作区信任 —— 信任判序在 grant 之前（评审 F7）。
 */
export function createDispatcher(output, { grants } = {}) {
  const host = createHost(output)
  const store = grants ?? new GrantStore()
  const linkState = { link: null }
  const caps = createCapabilities(host, {
    grants: store,
    isTrusted: () => vscode.workspace.isTrusted,
  })
  return {
    dispatch: caps.dispatch,
    capabilities: caps.CAPABILITIES,
    host,
    grants: store,
    linkState,
  }
}
