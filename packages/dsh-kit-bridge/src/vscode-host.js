/**
 * VS Code 宿主适配器：把 vscode API 包成 capabilities/connector 需要的形状。
 *
 * 隔离目的很实在：能力实现与连接管理都不 import 'vscode'，因此能在 node:test 里
 * 用假 host 跑真 TCP 端到端。**只有这个文件**知道 vscode 长什么样。
 */

import path from 'node:path'
import { existsSync, statSync } from 'node:fs'

import * as vscode from 'vscode'

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
    log,
  }
}

/** 一步到位：从 vscode 搭出能力分派函数。 */
export function createDispatcher(output) {
  const host = createHost(output)
  const caps = createCapabilities(host)
  return { dispatch: caps.dispatch, capabilities: caps.CAPABILITIES, host }
}
