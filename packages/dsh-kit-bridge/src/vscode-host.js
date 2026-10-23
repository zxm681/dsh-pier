/**
 * VS Code 宿主适配器：把 vscode API 包成 capabilities/connector 需要的形状。
 *
 * 隔离目的很实在：能力实现与连接管理都不 import 'vscode'，因此能在 node:test 里
 * 用假 host 跑真 TCP 端到端。**只有这个文件**知道 vscode 长什么样。
 */

import path from 'node:path'
import { existsSync, statSync, readFileSync, promises as fsp } from 'node:fs'
import { randomBytes } from 'node:crypto'

import * as vscode from 'vscode'

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities } from './capabilities.js'
import { applyEditAtomically } from './edit-transaction.js'
import { isInside, samePath } from './workspace-paths.js'

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
      // ★ T39：`untitled` —— 这份文档有没有**盘上的家**。`Uri.file()` 打开的文档永远是
      //   file scheme，所以这条在正常路径上是 false；它是一个**判据**而不是装饰：
      //   `vscode.save` 在动手前要能回答"这是不是一份从来没落过盘的文档"。
      untitled: doc.uri.scheme !== 'file',
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

  /**
   * 读**磁盘**上的 `{mtime, size}` —— `vscode.save` 磁盘锚点的唯一数据源（T39 / 契约 §6.2.3）。
   *
   * 为什么是"整数毫秒"而不是 `Date` / `mtimeMs` 原样：这个值要过 JSON、还要**逐字等值**
   * 比较。`mtimeMs` 是浮点，序列化/反序列化后可能差一个 ULP —— 那种锚点会永远"差一点点"，
   * 看起来像磁盘一直在变。`Math.floor` 之后两边（本端 / 对端消费者）算出来的整数一致。
   *
   * 返回 `null` = 磁盘上没有这个文件（被删 / 还没落过盘）。**不是**"跳过判定"：
   * 调用方必须把它当成"锚点不可能匹配"处理（磁盘上已经没有我以为的那份了）。
   */
  async function readDiskStat(abs) {
    try {
      const st = statSync(abs)
      return { mtime: Math.floor(st.mtimeMs), size: st.size }
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
      throw err
    }
  }

  /**
   * 保存文档（`vscode.save` 的唯一落点）。
   *
   * ★ **这里没有 CAS，也不假装有**（契约 §6.2.3 / §6.2.6）：`TextDocument.save()` 的签名是
   *   `save(): Thenable<boolean>`，它不接受"只写在我锚定的那一版上"这种参数。版本与化身
   *   在本函数**之前**已经判过（能力层，同一文件的排队链里），传进来的 `expectedVersion` /
   *   `expectedIncarnation` 只用于日志对照 —— 不在这里再判一次，因为那样只会制造
   *   "已经原子了"的错觉：读完版本到 `save()` 真正落盘之间，人工编辑照样可以插进来。
   *
   * 返回值语义（能力层据此定错误码，§6.2.7）：
   *  - `{saved: true, documentPath, version, incarnation}`：编辑器**明确**回了 `true`；
   *  - `{saved: false, reason: 'untitled-document'}`：没有盘上的家，无处可写；
   *  - `{saved: false, reason: 'host-save-failed'}`：`save()` 回了 `false`（编辑器拒绝）。
   *  **绝不**把"没拿到布尔"包装成成功 —— 非布尔由能力层判 `-32009`。
   *
   * `documentPath` 是**编辑器报告的文档身份**（`doc.uri.fsPath`），与 `applyEditText`
   * 同一判据：能力层用它证明"存下去的就是验过的那个文档"。拿不到就是 null（失败闭合）。
   *
   * @param {string|{abs:string,real:string}} target 能力层刚验过的路径（字符串或其 {abs,real}）
   * @param {{expectedVersion?:number, expectedIncarnation?:string}} anchors 仅用于日志对照
   */
  async function saveDocument(target, anchors = {}) {
    const abs = typeof target === 'string' ? target : target?.abs ?? target?.real
    let doc
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs))
    } catch (err) {
      throw new BridgeError(ERR.NOT_FOUND,
        `cannot open ${abs} as a text document: ${err?.message ?? err}`,
        { method: 'vscode.save', path: abs, reason: 'document-unavailable' })
    }
    if (doc.uri.scheme !== 'file') {
      // 没有盘上的家 → 能力层报 -32602 reason:'untitled-document'（§6.2.1 ⑭）。
      return { saved: false, reason: 'untitled-document', documentPath: null }
    }
    const versionBefore = doc.version
    const incarnation = incarnationOf(doc)
    let saved
    try {
      saved = await doc.save()
    } catch (err) {
      log(`saveDocument: ${abs} threw ${err?.message ?? err} (v${versionBefore}, `
        + `anchors v${anchors?.expectedVersion ?? '?'})`)
      throw new BridgeError(ERR.INTERNAL,
        `TextDocument.save() failed for ${abs}: ${err?.message ?? err}`,
        { method: 'vscode.save', path: abs, reason: 'host-save-failed' })
    }
    log(`saveDocument: ${abs} → ${saved === true} (v${versionBefore} -> v${doc.version}, `
      + `anchors v${anchors?.expectedVersion ?? '?'}/${anchors?.expectedIncarnation ?? '?'}, `
      + `incarnation ${incarnation})`)
    return {
      saved,
      documentPath: doc.uri.fsPath,
      version: doc.version,
      incarnation,
    }
  }

  /** 确认框里正文预览最多展示几个**字符**（不是字节：人读的是字）。 */
  const DELETE_CONFIRM_PREVIEW_CHARS = 400

  /** 读字节时若调用方没给上限，用这个（与能力层的 8 MiB 同源，仅作兜底）。 */
  const READ_FILE_BYTES_DEFAULT_MAX = 8 * 1024 * 1024

  /**
   * 读**整份**文件字节（`vscode.deleteFile` 的内容快照，T40 / 契约 §6.2.4 ③）。
   *
   * 先 `statSync` 再读：体积超限时连读都不读（8 MiB 打满内存只为立刻丢掉是浪费）。
   * 读完之后按 `buffer.length` **再判一次** —— 两次都判才叫"不截断"：
   * stat 与 read 之间文件可以长大，只信 stat 就会出现"读了 9 MiB 却按 8 MiB 记账"。
   *
   * 返回 `{tooLarge:true, size}` 而不是抛错：体积是**决策依据**（能力层据此写
   * `-32603 reason:'snapshot-unavailable', why:'too-large'`），不是适配层的失败。
   *
   * @param {string} abs 绝对路径（能力层已用它做过路径守卫）
   * @param {{maxBytes?:number}} [opts]
   * @returns {Promise<{tooLarge:boolean, size:number, buffer?:Buffer}>}
   */
  async function readFileBytes(abs, opts = {}) {
    const maxBytes = Number.isInteger(opts?.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : READ_FILE_BYTES_DEFAULT_MAX
    let st
    try {
      st = statSync(abs)
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        throw new BridgeError(ERR.NOT_FOUND, `file not found: ${abs}`,
          { method: 'vscode.deleteFile', path: abs })
      }
      throw new BridgeError(ERR.INTERNAL,
        `stat failed for ${abs}: ${err?.message ?? err}`,
        { method: 'vscode.deleteFile', path: abs, reason: 'snapshot-unavailable' })
    }
    if (st.size > maxBytes) return { tooLarge: true, size: st.size }
    const buffer = readFileSync(abs)
    if (buffer.length > maxBytes) return { tooLarge: true, size: buffer.length }
    return { tooLarge: false, size: buffer.length, buffer }
  }

  /**
   * 人工确认删除 —— `vscode.window.showWarningMessage(..., {modal:true}, '删除')`。
   *
   * 为什么必须 `modal`：非 modal 的警告会进通知中心、几秒后自己缩成图标，而"一次不可逆
   * 动作的同意"不能长在一个会自己消失的东西上（契约 §6.2.4 ② 引的
   * `explorer.confirmDelete` 默认 true 就是这个立场：宿主自己都不敢不问就删）。
   *
   * 为什么要带预览：§6.2.4 ② 要的是"人看着**内容**点删除"，只给文件名等于让人凭路径
   * 记忆担保。预览只放前 `DELETE_CONFIRM_PREVIEW_CHARS` 个字符 —— 确认框不是阅读器，
   * 它的作用是让人**认得出**这是不是那个文件。
   *
   * 超时**不在这里**：本函数只负责"问"。等多久、超时后许可是作废还是顺延，是安全语义，
   * 属能力层（§7 #5），不该埋在 UI 适配层里。
   *
   * @returns {Promise<{choice:'delete'|'not-confirmed'}>}
   *   VS Code 的 modal 对"点取消"与"关掉窗口"都回 `undefined`（分不开，也不该假装分得开），
   *   所以这里只有两种答案：明确点了删除 / 其余一切。
   */
  async function confirmDelete(abs, opts = {}) {
    const snapshot = opts?.snapshot ?? {}
    const name = path.basename(abs)
    const preview = typeof snapshot.text === 'string'
      ? snapshot.text.slice(0, DELETE_CONFIRM_PREVIEW_CHARS)
      : null
    const sizeLine = snapshot.encoding === 'binary'
      ? `二进制内容 ${snapshot.byteLength} 字节（不做文本预览）`
      : preview === null
        ? `文本 ${snapshot.textLength ?? '?'} 字符 / ${snapshot.byteLength} 字节（正文过大，不在此预览）`
        : `内容预览（共 ${snapshot.textLength} 字符，下面是最多前 `
          + `${DELETE_CONFIRM_PREVIEW_CHARS} 个）：\n${preview}`
    const detail = `${abs}\n\n${sizeLine}\n\nsha256: ${snapshot.sha256 ?? '?'}\n\n`
      + '删除后没有撤销，也不保证进入回收站。'
    const accept = '删除'
    let picked
    try {
      picked = await vscode.window.showWarningMessage(
        `DSH 请求删除文件：${name}`, { modal: true, detail }, accept,
      )
    } catch (err) {
      // 对话框本身失败 = 没得到同意（不是同意）。能力层会把它当 `-32002 declined`。
      log(`confirmDelete: ${abs} dialog threw ${err?.message ?? err}`)
      return { choice: 'not-confirmed' }
    }
    log(`confirmDelete: ${abs} → ${picked === accept ? 'delete' : 'not-confirmed'}`)
    return { choice: picked === accept ? 'delete' : 'not-confirmed' }
  }

  /**
   * 建目录（T44）：`workspace.fs.createDirectory`。**幂等** —— 已存在也算成功，
   * 所以归档前无脑调一次，不必先 stat 再决定要不要建。
   *
   * 为什么隔离目录得由宿主建：能力层手里只有路径字符串，没有"能在这台机器上创建
   * 目录"的能力（它连 `node:fs` 都不该碰，见文件头）。而 `workspace.fs` 用的正是
   * 编辑器自己的文件系统实现（远程 / 虚拟工作区下也对）。
   *
   * @param {string} abs 目标目录的绝对路径
   * @returns {Promise<{created:true}>}
   */
  async function ensureDirectory(abs) {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(abs))
    } catch (err) {
      const code = err?.code ?? err?.name
      throw new BridgeError(ERR.INTERNAL,
        `workspace.fs.createDirectory failed for ${abs}: ${err?.message ?? err}`,
        {
          method: 'vscode.deleteFile',
          path: abs,
          reason: 'quarantine-dir-failed',
          hostCode: typeof code === 'string' ? code : String(code ?? 'unknown'),
        })
    }
    return { created: true }
  }

  /**
   * 文件**对象身份** `(dev, ino)`（T44 / 评审 B1-a）。这是"移走的是不是同一个对象"的
   * 唯一判据 —— 不是"再算一次 hash"（评审已否掉那条路：hash 描述名字下的字节，
   * 而 open-writer 的 fd 写、provider 消费窗口换掉的是对象，复算看不见）。
   *
   * `bigint: true` + 字符串化：`ino` 在部分文件系统上会超过 2^53，`Number` 会静默丢位，
   * 于是"两个不同对象"可能比出相等 —— 那是这条判据唯一的失败方式，必须堵死。
   *
   * 文件不在（ENOENT/ENOTDIR）→ `null`：调用方据此判断"对象不在了"，**不许**当"一致"。
   *
   * @param {string} abs
   * @returns {{dev:string, ino:string}|null}
   */
  function readFileIdentity(abs) {
    let st
    try {
      st = statSync(abs, { bigint: true })
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
      throw new BridgeError(ERR.INTERNAL,
        `stat failed for ${abs}: ${err?.message ?? err}`,
        {
          method: 'vscode.deleteFile',
          path: abs,
          reason: 'identity-unavailable',
          hostCode: typeof err?.code === 'string' ? err.code : String(err?.code ?? 'unknown'),
        })
    }
    return { dev: st.dev.toString(), ino: st.ino.toString() }
  }

  /**
   * 把目标移动进隔离区 —— T42 / 评审 B1 的那一步，T44 之后它是这条链上的**全部**动作
   * （没有后续删除了）。
   *
   * 为什么必须由宿主干：能力层手里只有路径字符串，它连 `node:fs` 都不该碰。
   *
   * ## 为什么**不能**用 `vscode.workspace.fs.rename`（T46 / 评审 B45-1）
   *
   * 这一段原先走 `workspace.fs.rename(..., {overwrite:false})`，注释里写着"绝不退化成
   * `copyFile + unlink`" —— 但**退化不在我们的代码里发生**：VS Code 的文件服务在跨卷
   * （网络盘 / subst / 指向别的卷的 junction）时，`DiskFileSystemProvider.rename` 落进
   * `pfs.Promises.rename` 的 EXDEV 分支，**先 copy 再 rimraf 源**，而且不把 EXDEV 交回来。
   * 于是"零删除"在最该成立的那种部署上恰好不成立，事后检查也补不回来：inode 复核看得见
   * "这不是同一个对象"，却看不见"刚才已经删过一次"。上游源码原文与复现记录见
   * `work/t45-probes/provider-evidence.md`（reviewer 实测 copy=1 / delete=1）。
   *
   * ## 换成什么：`fs.promises.rename` —— 系统调用本身
   *
   * 扩展宿主里就有 `node:fs`。`fs.promises.rename` 就是 `MoveFileExW` / `rename(2)`：
   *   - 同卷 → 原子改名，只动目录项，一个字节都不搬；
   *   - 跨卷 → **抛 `EXDEV`**，不复制、不删除。我们把它原样交上去（`hostCode:'EXDEV'`），
   *     能力层报 `-32603 reason:'quarantine-failed'` + `crossVolume:true`，原件原地不动。
   * 这条原语**没有"退化模式"**：要么做成，要么报错。本文件里没有任何 unlink / rm /
   * copyFile 调用 —— 任何分支都不复制、不删除。
   *
   * ## 不覆盖
   *
   * `rename(2)` 在 POSIX 上会**静默覆盖**已存在的目标，Windows 上则失败 —— 依赖平台差异
   * 不是判据。所以先 `lstat` 探一次目标：存在 → 报 `EEXIST`（上游 `pickQuarantinePath`
   * 报 `quarantine-name-collision`、`restoreQuarantined` 报 `original-occupied`，各自
   * 原有分支照旧）。探测到 rename 之间的竞争由 catch 里 `EEXIST` / `EPERM` 兜底
   * （Windows 上 rename 到已存在目标正是 `EPERM`），两条码**分开映射**、都不重试、都不删。
   *
   * 路径规范化：`from` / `to` 都过 `path.normalize`（`vscode.Uri.file().fsPath` 原本做的
   * 就是这件事），"在不在工作区里 / 是不是同一个位置"复用 `workspace-paths.js` 已有的
   * `isInside` / `samePath`，不另写一套比较规则。
   *
   * @param {string} from 当前路径（能力层刚验过的 `real` 或隔离体路径）
   * @param {string} to 目标路径（`.dsh-quarantine/` 里的名字，或归还时的原名）
   * @returns {Promise<{renamed:true}>} 只有 `fs.promises.rename` 真的 resolve 了才返回
   */
  async function quarantineRename(from, to) {
    const src = path.normalize(String(from ?? ''))
    const dest = path.normalize(String(to ?? ''))
    const codeOf = (err) => {
      const code = err?.code ?? err?.name
      return typeof code === 'string' ? code : String(code ?? 'unknown')
    }
    const fail = (hostCode, extra) => new BridgeError(ERR.INTERNAL,
      `cannot move ${src} -> ${dest} (${hostCode}); nothing was moved and nothing was deleted`
      + (hostCode === 'EXDEV'
        ? ' — the target is on another volume, and this primitive refuses to emulate a '
          + 'cross-volume move with copy+delete'
        : ''),
      {
        method: 'vscode.deleteFile',
        path: src,
        target: dest,
        reason: 'quarantine-rename-failed',
        hostCode,
        ...extra,
      })

    // ── 归属：搬家的两头都必须在这一个工作区里（宿主是唯一碰文件系统的那层，
    //    这条不变量就守在这里；判定复用 workspace-paths.js，不另写）──
    const roots = workspaceRoots()
    if (roots.length !== 1) throw fail('no-workspace-root')
    const root = path.resolve(roots[0])
    if (!isInside(src, root)) throw fail('outside-workspace', { path: src })
    if (!isInside(dest, root)) throw fail('outside-workspace')
    if (samePath(src, dest)) throw fail('same-path')

    // ── ① 不覆盖：先探目标（`lstat` 不跟随链接；探不到才算空位）──
    let occupied = false
    try {
      await fsp.lstat(dest)
      occupied = true
    } catch (err) {
      const code = codeOf(err)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw fail(code)
    }
    if (occupied) throw fail('EEXIST')

    // ── ② 搬家：系统级 rename。跨卷在这里抛 EXDEV，**不退化** ──
    try {
      await fsp.rename(src, dest)
    } catch (err) {
      // EXDEV 与 EEXIST/EPERM 分开说：前者是"这个卷组合不支持原子搬家"，
      // 后者是"目标在探测之后被别人占了"（Windows 的 rename 覆盖失败就是 EPERM）。
      throw fail(codeOf(err))
    }
    log(`quarantineRename: ${src} -> ${dest} (fs.rename; the file is archived, nothing is destroyed)`)
    return { renamed: true }
  }

  return {
    // `fileExists` 由 `openFile` 与 `deleteFile`（隔离体存在性 / 同名冲突探测）共用 ——
    // **重排这个对象时别漏掉它**。
    // 2026-10-24 的真实回归就发生在这里：T40 往返回面加三个字段时把它漏了，单测全绿
    // （假宿主都自带 `fileExists`），真机上 `openFile` 直接 `host.fileExists is not a function`。
    // 现在由 `test/t40-host-surface.test.js` 静态守门。
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath,
    workspaceRoots,
    isTrusted: () => vscode.workspace.isTrusted,
    // E2 raw API boundary; normalization is performed once by editor-events.js.
    // All fields below exist at engines ^1.91.0 (audit in editor-events.js).
    editorEvents: {
      incarnationOf, // SAME function as readDocumentState / atomic edit anchors.
      isTrusted: () => vscode.workspace.isTrusted,
      textLength: (doc) => doc.offsetAt(new vscode.Position(doc.lineCount, 0)),
      textDocuments: () => vscode.workspace.textDocuments,
      visibleTextEditors: () => vscode.window.visibleTextEditors,
      tabs: () => vscode.window.tabGroups.all.flatMap((group) => group.tabs),
      tabUris: (tab) => tab.input instanceof vscode.TabInputText ? [tab.input.uri]
        : tab.input instanceof vscode.TabInputTextDiff ? [tab.input.original, tab.input.modified] : [],
      onDidOpenTextDocument: (fn) => vscode.workspace.onDidOpenTextDocument(fn),
      onDidCloseTextDocument: (fn) => vscode.workspace.onDidCloseTextDocument(fn),
      onDidSaveTextDocument: (fn) => vscode.workspace.onDidSaveTextDocument(fn),
      onDidChangeTextDocument: (fn) => vscode.workspace.onDidChangeTextDocument(fn),
      onDidChangeTextEditorSelection: (fn) => vscode.window.onDidChangeTextEditorSelection(fn),
      onDidChangeTextEditorVisibleRanges: (fn) => vscode.window.onDidChangeTextEditorVisibleRanges(fn),
      onDidChangeVisibleTextEditors: (fn) => vscode.window.onDidChangeVisibleTextEditors(fn),
      onDidChangeTabs: (fn) => vscode.window.tabGroups.onDidChangeTabs(fn),
      onDidChangeActiveTextEditor: (fn) => vscode.window.onDidChangeActiveTextEditor(fn),
      onDidChangeWindowState: (fn) => vscode.window.onDidChangeWindowState(fn),
    },
    openTextDocument,
    openExternalFile,
    activeEditor,
    collectDiagnostics,
    listEditors,
    readDocumentShape,
    readDocumentState,
    readRangeText,
    applyEditText,
    readDiskStat,
    saveDocument,
    // T40 / Tier 4：归档三件套（读字节 → 问人 → 移进隔离区）。
    // ★ T44：这里**没有**任何删除方法 —— 宿主面不再暴露"删文件"这件事（
    //   `test/t40-host-surface.test.js` 有静态断言守着，别再把 delete 加回来）。
    readFileBytes,
    confirmDelete,
    // T44 / B1-a：对象身份 (dev, ino) —— 归档前后各取一次，判"移走的是不是同一个 inode"。
    readFileIdentity,
    // T44：隔离目录 `<root>/.dsh-quarantine/` 由宿主创建（能力层碰不到文件系统 API）。
    ensureDirectory,
    // T42 / B1：把目标 rename 进隔离区 —— 这是 T44 的**唯一**动作（移动，不销毁字节）。
    quarantineRename,
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
export function createDispatcher(output, { grants, deleteConfirmTimeoutMs } = {}) {
  const host = createHost(output)
  const store = grants ?? new GrantStore()
  const linkState = { link: null }
  const caps = createCapabilities(host, {
    grants: store,
    isTrusted: () => vscode.workspace.isTrusted,
    // 人工确认的独立长超时（§7 #5）。没配就交给能力层的默认值（120s）。
    ...(deleteConfirmTimeoutMs === undefined ? {} : { deleteConfirmTimeoutMs }),
  })
  return {
    dispatch: caps.dispatch,
    capabilities: caps.CAPABILITIES,
    host,
    grants: store,
    linkState,
  }
}
