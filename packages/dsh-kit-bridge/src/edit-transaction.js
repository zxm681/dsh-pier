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
 * `TextEditor.edit(callback)` 的 callback 是**同步执行**的。同一段同步代码里做四件事：
 *
 *   ① 读 `document.version` **与文档的 `incarnation`**（同一份文档对象上）；
 *   ② 与 `expectedVersion` 等值比对，再与 `expectedIncarnation` 等值比对（T34）；
 *   ③ 构造 edit（`builder.replace(...)`）。
 *
 * 两道比对**必须在同一处、同一个同步区间里**（T34）：任何一个挪到 await 之后、或
 * 挪到事务外，都会留下"我验的那个实例 ≠ 我写的那个实例"的窗口 —— 那正是
 * `version` 数字复用能骗过版本门的原因。
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
 * 事务内的**化身冲突**错误（`-32012`，`data.reason === 'incarnation-mismatch'`，T34）。
 *
 * 为什么和版本冲突共用一个码：处置完全一样 —— 停下、重新读
 * `vscode.getDocumentState`（重新拿 `version` **和** `incarnation`）、用新锚点重发；
 * **不得**拿旧锚点重试。差别只在"哪一半锚点过期了"，写在 `data.reason` 里。
 *
 * 为什么这个码比版本冲突更必要（T5 的 Q3）：`TextDocument.version` 是**每个文档实例**
 * 自己的计数器。关掉再打开（或撤销到初始态）后，同一个文件的新实例又从 1 开始数 ——
 * 于是"用旧实例的版本 1 写新实例"就成了一次**数字相等**的错配，版本门一个字都拦不住。
 * `incarnation` 是文档实例的身份，随实例生灭，不看数字，所以这种复用骗不过它。
 *
 * @param {{file: string, expected: string, actual: string|null, method?: string}} p
 * @returns {BridgeError}
 */
export function incarnationConflictError({ file, expected, actual, method = TRANSACTION_METHOD }) {
  return new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
    'the document instance is not the one this request was prepared against '
    + `(incarnation ${actual ?? 'unknown'}, expected ${expected}); nothing was written — `
    + 're-read vscode.getDocumentState and re-apply against the current document instance',
    { method, file, reason: 'incarnation-mismatch', expected, actual })
}

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
 * @param {string} p.expectedIncarnation 调用方准备这组坐标时所基于的**文档实例**身份
 *        （`vscode.getDocumentState.incarnation`，T34）。**T35 起无条件必填**：
 *        必须与提交那一刻这份文档的 incarnation **逐字相等**，否则零构造 + `-32012`
 *        （`data.reason==='incarnation-mismatch'`）。
 *        ★ **有意的不兼容收紧**：缺 / 非字符串 / 空串 ⇒ `-32603`（失败闭合），
 *        不再"当成没给、只判版本"。理由：只判版本时，两个窗口版本数字相同（v7/inc-A 与
 *        v7/inc-B）就会按另一窗口的视图覆盖本窗口的人工内容（T6 终审 H1）。旧宿主给不出
 *        化身 ⇒ 拒写 —— 这是被接受的代价，不是待修的回归。
 * @param {(document: any) => (string|undefined)} [p.readIncarnation] 从**同一份文档对象**
 *        上读 incarnation 的函数（由适配器注入，本模块不 import `vscode`）。
 *        给了 `expectedIncarnation` 却没给这个函数 → 一律当作"读不到"→ 冲突（失败闭合）。
 * @param {(builder: any) => void} p.apply  构造 edit 的函数。**只在两道锚点都相等时被调用**，
 *        且它在 cb 内部同步执行 —— 适配器把 `builder.replace(new vscode.Range(...), text)`
 *        放在这里，于是 `vscode.Range` 的构造也落在同一个同步区间里。
 * @param {(msg: string) => void} [p.log]
 * @param {string} [p.method]
 * @returns {Promise<{applied: boolean, documentPath: string|null, version: number|null,
 *          incarnation: string|null}>}
 *        `applied` 是编辑器的返回值（`false` = 编辑器拒绝，可能是只读/文档被关）；
 *        `documentPath` 是**编辑器报告的文档身份**（`document.uri.fsPath`），
 *        能力层拿它判「写到底落在哪个文档」；`version` / `incarnation` 是事务内读到的
 *        真实版本与文档实例身份（宿主读不到 incarnation 时 `incarnation` 为 null）。
 * @throws {BridgeError} `-32012`（版本不等 / 化身不符）/ `-32603`（传进来的不是编辑器、
 *         或 `expectedIncarnation` 不是非空字符串）
 */
export async function applyEditAtomically({
  editor, file, expectedVersion, expectedIncarnation, readIncarnation, apply, log,
  // A1（T61）：变更账本的 before 基准回调 —— 在同步区间里、构造 edit 之前调用一次。
  observe,
  method = TRANSACTION_METHOD,
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
  if (typeof expectedIncarnation !== 'string' || expectedIncarnation === '') {
    // 同上：形状不对就失败闭合，绝不"当成没给"。
    // ★ T35 收紧：`undefined` 不再是合法输入 —— 事务**无条件**判第二道锚点。
    // 早先是"给了才判"，那让一条省略字段的写退化成纯整数版本比较（H1）。
    // 旧宿主/旧调用方给不出化身 ⇒ 这里拒写，而不是静默地少判一半。
    throw new BridgeError(ERR.INTERNAL,
      'the write transaction requires expectedIncarnation to be a non-empty string '
      + '(the document-instance anchor is mandatory since T35: a version number alone cannot '
      + 'prove "the same document instance")',
      { method, path: file, got: { type: typeof expectedIncarnation } })
  }

  /** 事务内读到的真实版本（证据：写入成功时它就是"我基于哪一刻写的"）。 */
  let observedVersion = null
  /** 事务内读到的真实化身（同上，T34）。宿主读不到就是 null。 */
  let observedIncarnation = null
  /** 事务内发现的冲突 —— 在 cb 里只记录，抛出放在 cb 外（cb 里抛会被编辑器吞成 false）。 */
  let conflict = null
  /** edit 是否被构造过。**零构造**是"宿主零写入"的唯一判据（测试按它断言）。 */
  let constructed = false

  const applied = await editor.edit((builder) => {
    // ───────────────────────────────────────────────────────────────────────
    // 同步区间开始：从这一行到 apply(builder) 返回，**不许出现任何 await**。
    // 事件循环在这段期间不跑别的任务，所以下面读到的东西与提交的 edit 是同一刻的。
    // ───────────────────────────────────────────────────────────────────────
    const actual = editor.document.version
    observedVersion = actual
    if (actual !== expectedVersion) {
      conflict = { kind: 'version', expected: expectedVersion, actual }
      return // ← 不构造任何 edit
    }
    // ★ T34：版本相等还不够 —— 版本是**每个文档实例**自己的计数器，关掉再打开的
    //   新实例又从 1 开始数。同一处、同一同步区间里再判一次"这是不是那一份文档"。
    //   `readIncarnation` 在**同一个 document 对象**上读，所以它与我正要写的实例同源。
    // ★ T35：比较**无条件**执行 —— 这里不再有 `expectedIncarnation !== undefined` 这个条件
    //   （它曾是 H1 的另一半：省略字段 ⇒ 版本相等就构造 edit）。缺化身在函数入口就被
    //   fail-closed 拒掉了，所以走到这一行时它必然是非空字符串。
    //   注意：`readIncarnation` 读不到（宿主没提供）＝ `null` ≠ 期望值 ⇒ 冲突，同样零写入。
    {
      const actualIncarnation = typeof readIncarnation === 'function'
        ? readIncarnation(editor.document)
        : undefined
      observedIncarnation = typeof actualIncarnation === 'string' ? actualIncarnation : null
      if (observedIncarnation !== expectedIncarnation) {
        conflict = { kind: 'incarnation', expected: expectedIncarnation, actual: observedIncarnation }
        return // ← 不构造任何 edit
      }
    }
    constructed = true
    // ── A1（T61）变更账本：把 before 基准交出去 —— **只在同步区间里给** ──
    // 为什么必须在这里：这份坐标所基于的那一版，只有"构造 edit 的同一个同步区间"里
    // 读到的才算数。放到事务外（哪怕只提前一个 await）就可能读到"另一版"的快照，
    // 于是 after 与预期的比对、以及事件链的版本衔接全部判错 —— 那正好会把我跟别人判反。
    //
    // 观察者是**证据**，不是闸：它抛异常绝不许影响写入本身（`constructed` 已经置位，
    // 这里再抛会把一次本来成功的写入变成失败，那是最糟的失败形态）。
    if (typeof observe === 'function') {
      try {
        observe({
          version: actual,
          incarnation: observedIncarnation,
          documentPath: typeof editor.document?.uri?.fsPath === 'string'
            ? editor.document.uri.fsPath
            : null,
          // `getText()` 是 O(n) 的一份拷贝：调用方（账本）自己按上限决定留不留，
          // 这里只如实把"这一版是什么"交出去。
          text: typeof editor.document?.getText === 'function'
            ? editor.document.getText()
            : null,
        })
      } catch (err) {
        log?.(`applyEdit transaction: ${file} change-ledger observe failed: ${err?.message ?? err}`
          + ' (the write is unaffected)')
      }
    }
    apply(builder)
    // ───────────────────────────────────────────────────────────────────────
    // 同步区间结束
    // ───────────────────────────────────────────────────────────────────────
  })

  if (conflict?.kind === 'incarnation') {
    // 文档实例换了（关闭重开 / 撤销到初始态后版本数字复用）：一个字都没写。
    log?.(`applyEdit transaction: ${file} incarnation ${conflict.actual ?? 'unknown'} != `
      + `${conflict.expected} — no edit constructed`)
    throw incarnationConflictError({
      file, expected: conflict.expected, actual: conflict.actual, method,
    })
  }

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
    //  ① 构造之后到提交之间版本/实例又变了 → 仍然是锚点冲突（-32012），且这次也没有落点；
    //  ② 版本没变（只读 / 文档被关闭 / 编辑为空）→ 如实回 applied:false，由上层决定。
    const actualNow = editor.document?.version
    if (Number.isInteger(actualNow) && actualNow !== expectedVersion) {
      throw versionConflictError({ file, expected: expectedVersion, actual: actualNow, method })
    }
    // ★ T34：这里也补一次化身比对。它在**提交之后**才跑，所以拦不住"已经落点"的那一半；
    //   但"文档在提交瞬间被换掉"这条路上，宁可报 -32012 也不要让调用方以为写进了自己那份。
    if (expectedIncarnation !== undefined && typeof readIncarnation === 'function') {
      const nowInc = readIncarnation(editor.document)
      const nowId = typeof nowInc === 'string' ? nowInc : null
      if (nowId !== expectedIncarnation) {
        throw incarnationConflictError({
          file, expected: expectedIncarnation, actual: nowId, method,
        })
      }
    }
    log?.(`applyEdit transaction: ${file} edit rejected by host (v${observedVersion}) — not applied`)
    return {
      applied: false,
      documentPath,
      version: observedVersion,
      // 只在真读到过化身时出现：没给 `expectedIncarnation` 的调用方拿到的返回形状
      // 与 T32 时代**逐字相同**（这条形状有测试钉着，别为"多一个 null"破约）。
      ...(observedIncarnation ? { incarnation: observedIncarnation } : {}),
    }
  }

  log?.(`applyEdit transaction: ${file} v${observedVersion}`
    + `${observedIncarnation ? ` ${observedIncarnation}` : ''} edit accepted`
    + ` (${constructed ? 'constructed+submitted' : 'no-op'} — not saved)`)
  return {
    applied: true,
    documentPath,
    version: observedVersion,
    ...(observedIncarnation ? { incarnation: observedIncarnation } : {}),
  }
}
