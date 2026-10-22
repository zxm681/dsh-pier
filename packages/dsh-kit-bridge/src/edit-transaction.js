/**
 * 写入事务：版本等值的**唯一保证处**（T32 / 评审 T31 的 B1）。
 *
 * ## 要解决的问题
 *
 * B1 的实证：能力层比对完 `expectedVersion` 之后，到真正写入之间还有两个 await
 * （`readDocumentShape`、可选的 `readTargetRangeText`）。让出点里用户可以敲键盘、
 * 另一个插件可以格式化、上一次写入可以落地 —— 于是「我基于版本 1 算的坐标」被按到
 * 版本 2 的缓冲区上，人工内容被静默吃掉，`applied` 还是 `true`。
 *
 * **再读一次版本也没用**：`await readVersion(); applyEdit()` 中间仍然有让出点，
 * 只是把窗口挪了个位置（评审原话：仅再 await 读一次版本仍有竞态）。
 *
 * ## 修法：把判定搬进「提交那一刻」的同步区间
 *
 * `TextEditor.edit(callback)` 的 callback 是**同步执行**的。同一段同步代码里做三件事：
 *
 *   ① 读 `document.version`；
 *   ② 与 `expectedVersion` 等值比对；
 *   ③ 构造 edit（`builder.replace(...)`）。
 *
 * 同步执行期间事件循环不跑别的任务，用户输入的处理函数排在这段之后才执行，所以
 * ①读到的版本与 ③提交的 edit 是同一刻的 —— 这就是本模块存在的全部理由。
 * **本模块里从 ① 到 ③ 之间不许出现任何 `await`**（`no-await-in-transaction` 用例守着）。
 *
 * 不等就 `return`（不构造任何 edit），把冲突记在 cb 外抛出（`-32012`）。调用方看到的
 * 是「没写」而不是「先写再报错」。
 *
 * ## 为什么必须是 `TextEditor.edit` 而不是 `workspace.applyEdit`
 *
 * 上游语义（microsoft/vscode `main`，2026-10 拉的源码）：
 *
 *  - `src/vs/workbench/api/common/extHostTextEditor.ts:492` `edit(callback)` →
 *    `_applyEdit`(:624) → `this._proxy.$tryApplyEdits(this.id, editData.documentVersionId,
 *    edits, ...)`(:671) —— 每条 edit 都**带着构造时的文档版本号**交给主线程；
 *  - `src/vs/workbench/api/browser/mainThreadEditors.ts:342`
 *    `$tryApplyEdits(id, modelVersionId, edits, opts)` → `editor.applyEdits(modelVersionId,
 *    ...)`(:347) —— 主线程拿这个版本号做 **CAS**，不一致就整个拒绝。
 *
 * 也就是说 `TextEditor.edit` 的提交路径本身就带版本条件；`WorkspaceEdit` 那条路只能
 * 表达「按提交那一刻的当前版本改」，表达不了「我要求的是版本 7」。所以 B1 在宿主侧
 * 也必须留一道 —— 光靠能力层比对，永远差一个让出点。
 *
 * ## 本模块的边界
 *
 * 不 import `vscode`：`editor` / `builder` 由适配器（vscode-host.js）传入，于是能在
 * `node:test` 里用假编辑器穷举「版本相等 / 不等 / edit 返回 false / edit 抛异常」，
 * 而真机那半边由扩展自检（`extension.js` 的 selfTest）覆盖。
 */

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'

/** 事务的方法名（错误 data 里带它，日志与测试都用这一份）。 */
export const TRANSACTION_METHOD = 'vscode.applyEdit'

/**
 * 事务内的版本冲突错误（`-32012`）。
 *
 * `data` 的键与能力层 `assertVersionMatches` **故意一致**（`file` / `expected` / `actual`）：
 * 调用方不该因为「是哪一层抓到的」而收到两种形状 —— 那会让"按 data 重试"的代码要分支。
 * 两层只是**抓到的时机**不同（前置早、事务内准），语义完全相同。
 *
 * @param {{file: string, expected: number, actual: number, method?: string}} p
 * @returns {BridgeError}
 */
export function versionConflictError({ file, expected, actual, method = TRANSACTION_METHOD }) {
  return new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
    `document version is ${actual}, but the request was prepared for version ${expected}; `
    + 'nothing was written — re-read vscode.getDocumentState and re-apply against the current version',
    { method, file, expected, actual })
}

/**
 * 在**提交那一刻**校验版本，相等才构造 edit；不等则零构造、抛 `-32012`。
 *
 * @param {object} p
 * @param {{document: {version: number, uri?: {fsPath?: string}}, edit: (cb: (builder: any) => void) => Promise<boolean>}} p.editor
 *        `TextEditor` 的最小形状（真机是 `vscode.TextEditor`，测试里是假编辑器）。
 * @param {string} p.file      规范化后的绝对路径，只用于错误 data 与日志（不参与判定）。
 * @param {number} p.expectedVersion 调用方准备这组坐标时所基于的 `document.version`。
 * @param {(builder: any) => void} p.apply  构造 edit 的函数。**只在版本相等时被调用**，
 *        且它在 cb 内部同步执行 —— 适配器把 `builder.replace(new vscode.Range(...), text)`
 *        放在这里，于是 `vscode.Range` 的构造也落在同一个同步区间里。
 * @param {(msg: string) => void} [p.log]
 * @param {string} [p.method]
 * @returns {Promise<{applied: boolean, documentPath: string|null, version: number|null}>}
 *        `applied` 是编辑器的返回值（`false` = 编辑器拒绝，可能是只读/文档被关）；
 *        `documentPath` 是**编辑器报告的文档身份**（`document.uri.fsPath`），
 *        能力层拿它判「写到底落在哪个文档」；`version` 是事务内读到的真实版本。
 * @throws {BridgeError} `-32012`（版本不等）/ `-32603`（传进来的不是编辑器）
 */
export async function applyEditAtomically({
  editor, file, expectedVersion, apply, log, method = TRANSACTION_METHOD,
}) {
  const doc = editor?.document
  if (!doc || typeof doc !== 'object' || typeof editor?.edit !== 'function') {
    throw new BridgeError(ERR.INTERNAL,
      'the write transaction needs a text editor ({document, edit}); refusing to write without one',
      { method, path: file, hostField: 'applyEditText' })
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    // 走到这里说明能力层的形状检查被绕过了 —— 失败闭合，绝不"当成没给"。
    throw new BridgeError(ERR.INTERNAL,
      'the write transaction requires an integer expectedVersion >= 0',
      { method, path: file, got: { type: typeof expectedVersion } })
  }

  /** 事务内读到的真实版本（证据：写入成功时它就是"我基于哪一刻写的"）。 */
  let observedVersion = null
  /** 事务内发现的冲突 —— 在 cb 里只记录，抛出放在 cb 外（cb 里抛会被编辑器吞成 false）。 */
  let conflict = null
  /** edit 是否被构造过。**零构造**是"宿主零写入"的唯一判据（测试按它断言）。 */
  let constructed = false

  const applied = await editor.edit((builder) => {
    // ───────────────────────────────────────────────────────────────────────
    // 同步区间开始：从这一行到 apply(builder) 返回，**不许出现任何 await**。
    // 事件循环在这段期间不跑别的任务，所以下面读到的版本与提交的 edit 是同一刻的。
    // ───────────────────────────────────────────────────────────────────────
    const actual = editor.document.version
    observedVersion = actual
    if (actual !== expectedVersion) {
      conflict = { expected: expectedVersion, actual }
      return // ← 不构造任何 edit
    }
    constructed = true
    apply(builder)
    // ───────────────────────────────────────────────────────────────────────
    // 同步区间结束
    // ───────────────────────────────────────────────────────────────────────
  })

  if (conflict) {
    // 版本在"我准备坐标"与"提交"之间变了：一个字都没写。
    // data 与能力层前置检查同形（file/expected/actual），只是这次是从事务内报出来的。
    log?.(`applyEdit transaction: ${file} version ${conflict.actual} != ${conflict.expected}`
      + ' — no edit constructed')
    throw versionConflictError({ file, expected: conflict.expected, actual: conflict.actual, method })
  }

  const documentPath = typeof editor.document?.uri?.fsPath === 'string'
    ? editor.document.uri.fsPath
    : null

  if (applied !== true) {
    // 编辑器拒绝了这次编辑。两种可能必须分开报（否则"版本冲突"会被误当成"宿主抽风"）：
    //  ① 构造之后到提交之间版本又变了 → 仍然是版本冲突（-32012），且这次也没有落点；
    //  ② 版本没变（只读 / 文档被关闭 / 编辑为空）→ 如实回 applied:false，由上层决定。
    const actualNow = editor.document?.version
    if (Number.isInteger(actualNow) && actualNow !== expectedVersion) {
      throw versionConflictError({ file, expected: expectedVersion, actual: actualNow, method })
    }
    log?.(`applyEdit transaction: ${file} edit rejected by host (v${observedVersion}) — not applied`)
    return { applied: false, documentPath, version: observedVersion }
  }

  log?.(`applyEdit transaction: ${file} v${observedVersion} edit accepted`
    + ` (${constructed ? 'constructed+submitted' : 'no-op'} — not saved)`)
  return { applied: true, documentPath, version: observedVersion }
}
