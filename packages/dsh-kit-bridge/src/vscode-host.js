/**
 * VS Code 宿主适配器：把 vscode API 包成 capabilities/connector 需要的形状。
 *
 * 隔离目的很实在：能力实现与连接管理都不 import 'vscode'，因此能在 node:test 里
 * 用假 host 跑真 TCP 端到端。**只有这个文件**知道 vscode 长什么样。
 */

import path from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import * as vscode from 'vscode'

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities } from './capabilities.js'
import { applyEditAtomically } from './edit-transaction.js'

// ─────────────────────────────────────────────────────────────────────────────
// 文档化身（incarnation，T34）：每个 `TextDocument` **实例**一个不透明身份
//
// 为什么版本号不够（T5 的 Q3）：`TextDocument.version` 是**每个文档实例**自己的计数器。
// 关闭再打开（或撤销回到初始态）拿到的是**新实例**，版本又从 1 开始数 —— 于是"旧实例
// 的版本 1"与"新实例的版本 1"数字相等，版本门放行，写入按旧视角的坐标落进新缓冲区。
//
// 身份必须绑在**对象实例**上，而不是绑在 uri 上：同一个 uri 先后可以对应多个实例，
// 而"我准备这组坐标时看到的是哪一份"只能由实例回答。`WeakMap` 恰好是这个语义 ——
// 键是对象身份，实例被回收时条目自动消失，不占内存、不会把旧 id 分给新实例。
//
// 不透明、随机、与磁盘无关：`inc-<8字节 hex>`。它对外只作**等值比对**用，
// 不携带任何文档内容，也不该被当成持久标识（进程重启即失效，这是特性不是缺陷）。
// ─────────────────────────────────────────────────────────────────────────────
const documentIncarnations = new WeakMap()

/**
 * 取（首次则分配）这个文档实例的 incarnation。
 *
 * 同一个实例永远回同一个 id；新实例（关闭重开 / 撤销到初始态 / 另一个窗口打开的
 * 同一文件）必然是新 id。**只在宿主持有文档对象的地方调用** —— 本函数是
 * `getDocumentState.incarnation` 与写入事务内比对的**唯一**生成点，两处必须同源，
 * 否则"读到的 id"和"判的 id"会漂移成两套。
 *
 * @param {{}} doc `vscode.TextDocument`
 * @returns {string}
 */
function incarnationOf(doc) {
  const hit = documentIncarnations.get(doc)
  if (hit) return hit.id
  const id = `inc-${randomBytes(8).toString('hex')}`
  documentIncarnations.set(doc, { id })
  return id
}

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
   * 读**文档**状态：版本号 / 脏标记 / 换行 / 行数 / 长度 /（可选）全文（T30）。
   *
   * `version` 取 `TextDocument.version` —— 编辑器自己维护的单调计数器，缓冲区每被改动
   * 一次就 +1（用户手打、另一个插件、格式化、DSH 自己上一次写入，全都算）。
   * 它是"我基于哪一刻的内容写了这组坐标"唯一能被机制证明的锚点：
   * **不要**换成年月日、内容哈希或 `mtime` —— 哈希要整份算、`mtime` 只在落盘时变，
   * 而 T4 的错就发生在"缓冲区改了但磁盘没变"的那个窗口里。
   *
   * `text` 只在 `includeText:true` 时给出，且必须是**全集**：超限的判定与整份不给
   * 的动作都在能力层（`MAX_TEXT_BYTES`），适配器不许自己截一刀再交出去。
   *
   * 成本说明：`doc.getText()` 是一次 O(n) 拷贝，未 dirty 时理论上可用磁盘大小替代，
   * 但那样 `textLength`（UTF-16 码元数）就得另算一遍，两个口径混在一起更容易出错；
   * 何况 VS Code 默认拒绝打开 >50MB 的文本文件，能走到这里的文档本来就有上界。
   * 8 MiB 这道坎保护的是**协议通道与消费者上下文**，不是宿主内存。
   */
  async function readDocumentState(abs, opts = {}) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    const text = doc.getText()
    return {
      version: doc.version,
      // ★ T34：实例身份与版本同一次读取、同一个文档对象 —— 两半锚点必须同源，
      //   否则"版本来自 A 实例、化身来自 B 实例"就是新的错配形态。
      incarnation: incarnationOf(doc),
      isDirty: doc.isDirty === true,
      eol: doc.eol === vscode.EndOfLine.CRLF ? 'crlf' : 'lf',
      lineCount: doc.lineCount,
      textLength: text.length,
      byteLength: Buffer.byteLength(text, 'utf8'),
      ...(opts?.includeText === true ? { text } : {}),
    }
  }

  /**
   * 读**文档**里 0-based `range` 的当前文本 —— `expectedRangeText` 逐字比对的唯一数据源（T30）。
   *
   * 同样走 `openTextDocument`（已打开的文档返回同一个内存实例），所以读到的是用户
   * 眼前缓冲区里的那几个字符，不是磁盘上的。
   */
  async function readRangeText(abs, range) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    const start = new vscode.Position(range.start.line, range.start.column)
    const end = new vscode.Position(range.end.line, range.end.column)
    return doc.getText(new vscode.Range(start, end))
  }

  /**
   * 拿「这个 uri 的**编辑器**」—— 写入事务只能在 `TextEditor` 上做（T32）。
   *
   * 为什么非要编辑器（上游语义，见 `edit-transaction.js` 头注释）：`TextEditor.edit` 的
   * 提交路径会**带着构造时的文档版本号**交给主线程做 CAS，而 `WorkspaceEdit` 那条路
   * 只能表达"按提交那一刻的当前版本改"。拿不到编辑器就**失败闭合**（`-32603`），
   * **绝不退回** `vscode.workspace.applyEdit` —— 退回去等于把 B1（版本检查与写入不原子）
   * 原样留着，还多一层"看起来成了"的假象。
   *
   * 优先用已经可见的编辑器（零成本、不动用户布局）；否则 `showTextDocument` 建一个：
   * `preserveFocus` 不抢焦点，`preview` 用预览页签（不在用户标签栏里插一条常驻）。
   * 副作用如实记在这里：**给没有打开的文件写入，会顺手把它以预览页签打开**。这是为了
   * 拿到版本 CAS 付的代价，比"静默吃掉人工改动"便宜得多。
   *
   * @param {import('vscode').Uri} uri
   * @param {string} abs 规范化后的绝对路径（只用于错误信息）
   * @returns {Promise<import('vscode').TextEditor>}
   */
  async function editorFor(uri, abs) {
    const want = uri.toString()
    let doc
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch (err) {
      throw new BridgeError(ERR.NOT_FOUND,
        `cannot open ${abs} as a text document: ${err?.message ?? err}`,
        { method: 'vscode.applyEdit', path: abs, reason: 'document-unavailable' })
    }
    const visible = (vscode.window.visibleTextEditors ?? [])
      .find((e) => e?.document?.uri?.toString() === want)
    if (visible) return visible
    try {
      return await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true })
    } catch (err) {
      throw new BridgeError(ERR.INTERNAL,
        `cannot obtain a text editor for ${abs}: ${err?.message ?? err}`,
        { method: 'vscode.applyEdit', path: abs, reason: 'editor-unavailable' })
    }
  }

  /**
   * 在**缓冲区**里替换一段文本（`vscode.applyEdit` 的唯一落点）。
   *
   * **版本等值的判定在事务内部**（`edit-transaction.js`）：这里先把编辑器拿到手
   * （这一步的 await 允许存在 —— 它发生在事务**之前**），然后由事务在
   * `editor.edit(callback)` 的同步 callback 里读 `document.version`、比对、构造 edit。
   * 本文件只负责把 0-based `range` 塞进 `vscode.Range` 并调 `builder.replace`。
   *
   * `range` 是 **0-based**（转换在 capabilities 层做完了，见 `toApiRange`）——
   * **一次减法都不许再出现在本文件**：边界之上的层已经保证"一个 1-based 输入只被减一次"。
   *
   * **绝不保存**：不调 `document.save()`、不调 `workbench.action.files.save`。
   * 返回 `{applied, documentPath, version}`：`applied:false` 表示编辑器拒绝了这次编辑，
   * 必须如实上报，不许当成成功；`documentPath` 是**编辑器报告的文档身份**
   * （评审 R3-1：就是那个实际收到这次编辑的 `TextEditor.document.uri.fsPath`，
   * 比"按 uri 再查一次"更直接 —— 它是写入对象的本身）—— 拿不到就是 null，
   * 让能力层失败闭合，而不是编一个"就是我传进去的路径"糊过去。
   *
   * @param {string} abs
   * @param {{start:{line:number,column:number}, end:{line:number,column:number}}} range 0-based
   * @param {string} text
   * @param {number} expectedVersion 调用方准备这组坐标时所基于的 `document.version`（**必填**）
   * @param {string} expectedIncarnation 同一刻这份**文档实例**的身份（T34 引入；
   *        ★ T35 起**无条件必填**，能力层从 `vscode.getDocumentState.incarnation` 原样传下来）。
   *        事务在提交那一刻**无条件**比对，不符 → 零构造 + `-32012`
   *        （`data.reason === 'incarnation-mismatch'`）；缺 / 空串在能力层就是 `-32602`，
   *        走到这里是"事务被绕过"的最后一道失败闭合。旧宿主给不出化身 ⇒ 拒写
   *        （有意的不兼容收紧：没有实例身份就证明不了"写的是同一个文档实例"）。
   */
  async function applyEditText(abs, range, text, expectedVersion, expectedIncarnation) {
    const editor = await editorFor(vscode.Uri.file(abs), abs)
    const outcome = await applyEditAtomically({
      editor,
      file: abs,
      expectedVersion,
      expectedIncarnation,
      // 与 `readDocumentState` **同一个** `incarnationOf`：读侧报的 id 与写侧判的 id
      // 同源，否则"我读到的化身"和"你比对的化身"会是两套。
      readIncarnation: (doc) => incarnationOf(doc),
      apply: (builder) => {
        // Range 在**事务的同步区间里**构造：坐标与版本属于同一刻，不许在事务外先算好。
        builder.replace(
          new vscode.Range(
            new vscode.Position(range.start.line, range.start.column),
            new vscode.Position(range.end.line, range.end.column),
          ),
          text,
        )
      },
      log,
    })
    log(`applyEditText: ${abs} [${range.start.line}:${range.start.column}-`
      + `${range.end.line}:${range.end.column}] ${text.length} chars → applied=${outcome.applied}`
      + ` v${outcome.version}${outcome.incarnation ? ` ${outcome.incarnation}` : ''}`
      + ` (not saved; document=${outcome.documentPath ?? 'unknown'})`)
    return {
      applied: outcome.applied === true,
      documentPath: outcome.documentPath,
      version: outcome.version,
      incarnation: outcome.incarnation ?? null,
    }
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
    readDocumentState,
    readRangeText,
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
