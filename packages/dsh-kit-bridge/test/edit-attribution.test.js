/**
 * 人工归属（T4 判 NO-GO 的那条事实）在 **T30 之后**的可执行记录。
 *
 * 这个文件原来是 T4 的"负例 / 特征化"测试：断言「写入没有任何版本/内容前置条件，
 * 人工改动会被静默吞掉，`applied` 仍为 true」。T30 给写入加了版本锚点
 * （`expectedVersion` 必填 + `-32012`），于是那几条**必须改写** —— 文件头当初就是这么写的
 * （「一旦有人补上版本校验，本文件 ★ 用例会立刻变红，逼他读完这段注释再动」）。
 *
 * 改写后的分工：
 *  ① `T30 ★ 旧版本写入` —— 人工改动后拿旧版本写，必须被 `-32012` 拦下，**人工的字留下**，
 *     宿主零调用；重读版本后同一次写入才成功。这是 T4 那个 NO-GO 的正面替代品。
 *  ② `T30/T32 ★ 锚点与观测` —— 版本既是**请求参数**、又随请求下到写宿主（宿主在
 *     提交那一刻再判一次）；观测层现在给得出内容
 *     （`vscode.getDocumentState`，正是 T4 报告里"能力清单没有读文本"的缺口）。
 *  ③ `★ 保存边界` —— 不变：写入只改缓冲区、绝不落盘（T30 没有引入保存能力）。
 *  ④ `T30 ★ 混合归属` —— 仍然**没有** per-file 停写状态：拦不拦只看"版本对不对"，
 *     没被人改过的文件照写。这条守着"别为了归属判定去发明一套每文件状态机"。
 *  ⑤ `T32 ★ 锚点下到写宿主` —— 能力层的前置检查**不是保证**：锚点现在随请求一起走到
 *     写宿主，由写宿主在**提交那一刻**再判一次（`edit-transaction.js`）。本文件的假宿主
 *     与真适配器同语义：版本不等就**不构造 edit**、抛 `-32012`。
 *
 * 「人工改动」在单测里怎么造：不模拟键盘，而是直接改**假宿主的缓冲区**（版本 +1）——
 * 这正是 `WorkspaceEdit` 与真实键入在真机上的共同效果（改内存 document，不动磁盘）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { BridgeError, ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架：一个**带缓冲区 + 版本号**的假宿主
// ---------------------------------------------------------------------------

/**
 * 与 `apply-edit.test.js` 的 `makeHost` 的区别有两处，都很关键：
 *  1. 这里的"文档"是**缓冲区**（`buffers`），磁盘是另一份状态 —— 真机上 `applyEdit`
 *     改的是内存 document（`vscode-host.js` 的 `applyEditText` 从不 save）。
 *  2. 每个文件带一个**版本号**，任何缓冲区改动（人工键入 / DSH 写入）都 +1 ——
 *     这就是 `TextDocument.version` 的语义，也是 T30 唯一的锚点来源。
 */
function makeBufferHost(roots) {
  const calls = []
  /** abs → string[]（当前缓冲区；首行在 [0]）。 */
  const buffers = new Map()
  /** abs → number（版本号，只增）。 */
  const versions = new Map()
  /** abs → true（缓冲区里有**未保存**内容）。真机的 `isDirty` 就是这么来的。 */
  const dirties = new Set()
  /** 观察器订阅者（A2：桥接判定归属的唯一证据源）。 */
  const listeners = []
  const read = (abs) => {
    if (!buffers.has(abs)) buffers.set(abs, readFileSync(abs, 'utf8').split(/\r?\n/))
    return buffers.get(abs)
  }
  const versionOf = (abs) => (versions.has(abs) ? versions.get(abs) : 0)
  /** 缓冲区被改一次，版本 +1（人工键入与 DSH 写入走同一条）。 */
  const bump = (abs) => {
    versions.set(abs, versionOf(abs) + 1)
    // 缓冲区一变就是脏的（真机语义）；只有保存才清。
    dirties.add(abs)
  }
  /** 走观察器报一次变更（对应 `vscode.workspace.onDidChangeTextDocument`）。 */
  const emit = (abs, changes) => {
    for (const fn of listeners.slice()) {
      fn({ file: abs, version: versionOf(abs), incarnation: INCARNATION, changes, reasonCode: 1 })
    }
  }
  /** 测试用：把脏标记清掉（模拟"人手动保存了"）。 */
  const markSaved = (abs) => { dirties.delete(abs) }
  const host = {
    calls,
    buffers,
    versionOf,
    bump,
    /** 测试用：模拟用户在缓冲区里键入（1-based 行列，与协议口径一致）。 */
    humanType(abs, line, column, text) {
      const buf = read(abs)
      const head = buf[line - 1].slice(0, column - 1)
      const tail = buf[line - 1].slice(column - 1)
      buf[line - 1] = head + text + tail
      bump(abs)
      // 人工键入同样要过观察器 —— 桥接就是靠这个把"不是我写的"认出来的。
      emit(abs, [{ start: { line, column }, text }])
    },
    listeners,
    markSaved,
    isDirtyOf: (abs) => dirties.has(abs),
    buffer: (abs) => read(abs).join('\n'),
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(roots[0], p)),
    workspaceRoots: () => roots.slice(),
    // A2（T62）：**同源变更观察器**。没有它桥接连干净基线都建立不起来（observation-gap），
    // 有它才能把"人工键入"与"自己写的"分开 —— 本文件的故事全靠它。
    observeTextChanges: (fn) => {
      listeners.push(fn)
      return { dispose() { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } }
    },
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    // 边界校验的数据源：报**缓冲区**的形状（真适配器读的也是 document，不是磁盘）。
    readDocumentShape: async (abs, lines = []) => {
      const buf = read(abs)
      return {
        lineCount: buf.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= buf.length ? buf[n - 1].length : null)),
      }
    },
    // T30：写入锚点的读侧。版本来自 `versions`，文本来自缓冲区（**整份**，不截断）。
    readDocumentState: async (abs, { includeText = false } = {}) => {
      const text = read(abs).join('\n')
      return {
        version: versionOf(abs),
        incarnation: INCARNATION,
        isDirty: dirties.has(abs),
        eol: 'lf',
        lineCount: read(abs).length,
        textLength: text.length,
        byteLength: Buffer.byteLength(text, 'utf8'),
        ...(includeText === true ? { text } : {}),
      }
    },
    readRangeText: async (abs, range) => {
      const buf = read(abs)
      const at = (i) => buf[i] ?? ''
      if (range.start.line === range.end.line) {
        return at(range.start.line).slice(range.start.column, range.end.column)
      }
      const parts = [at(range.start.line).slice(range.start.column)]
      for (let i = range.start.line + 1; i < range.end.line; i += 1) parts.push(at(i))
      parts.push(at(range.end.line).slice(0, range.end.column))
      return parts.join('\n')
    },
    // 等价于 `vscode.workspace.applyEdit`：按坐标替换缓冲区，**绝不碰磁盘**；版本 +1。
    // T32：这一层**也**要收 `expectedVersion` 并在提交那一刻再判一次（真适配器在
    // `edit-transaction.js` 里做同一件事）。不等 → 不构造 edit、抛 `-32012`。
    // ★ T35：`expectedIncarnation` 也是锚点的一部分，无条件必填；这一层与真适配器一样
    // 在"提交那一刻"再判一次（两条锚点都判）。
    applyEditText: async (abs, range, text, expectedVersion, expectedIncarnation, observation) => {
      const versionAtWrite = versionOf(abs)
      calls.push({ abs, range, text, expectedVersion, expectedIncarnation, versionAtWrite })
      if (expectedIncarnation !== INCARNATION) {
        throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
          `document incarnation is ${INCARNATION}, but the request was prepared for ${expectedIncarnation}`,
          { method: 'vscode.applyEdit', file: abs, reason: 'incarnation-mismatch',
            expected: expectedIncarnation, actual: INCARNATION })
      }
      if (versionAtWrite !== expectedVersion) {
        throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
          `document version is ${versionAtWrite}, but the request was prepared for version ${expectedVersion}`,
          { method: 'vscode.applyEdit', file: abs, expected: expectedVersion, actual: versionAtWrite })
      }
      // A1/A2：写宿主**必须**把这个"写之前那一刻"报给账本 —— 没有 before 基准，账本只能
      // 给出 `no-baseline`（unknown），这个文件的后续写入就全被冻结。真适配器在
      // `edit-transaction.js` 的同步区间里做同一件事。
      observation?.observe({
        version: versionOf(abs),
        incarnation: INCARNATION,
        documentPath: abs,
        text: read(abs).join('\n'),
      })
      const buf = read(abs)
      const head = buf[range.start.line].slice(0, range.start.column)
      const tail = buf[range.end.line].slice(range.end.column)
      const merged = [...buf.slice(0, range.start.line), ...(head + text + tail).split('\n'),
        ...buf.slice(range.end.line + 1)]
      buffers.set(abs, merged)
      bump(abs)
      // 真机：`WorkspaceEdit` 落地同样触发 onDidChangeTextDocument。它落在写窗口内，
      // 所以桥接把它记进"自己的窗口"，不当成别人的增量。
      // 真 VS Code 的 contentChanges 带**完整 range**（start+end）—— 账本按它逐条比对
      // 自己这一笔，所以少一个 end 就会被判成"还有别人的改动"（mixed）。
      // 事件里的位置是 VS Code 口径（`character`），能力层交给宿主的是协议口径（`column`）——
      // 真适配器（`vscode-host.js`）在这两层之间翻一次；假宿主不翻的话账本逐条比对会对不上。
      emit(abs, [{
        start: { line: range.start.line, character: range.start.character ?? range.start.column },
        end: { line: range.end.line, character: range.end.character ?? range.end.column },
        text,
      }])
      return { applied: true, documentPath: abs }
    },
    log: () => {},
  }
  return host
}

const ID = 'a'.repeat(32)
const EPOCH = 'b'.repeat(32)

/**
 * 假文档的实例身份（T34 引入；★ T35 起 `expectedIncarnation` **无条件必填**）。
 *
 * 脚手架默认带上它，与 `expectedVersion` 同理：本文件的故事是"人工编辑改了缓冲区"，
 * 缺锚点会在**锚点形状门**就短路，那个故事根本讲不到。
 */
const INCARNATION = 'inc-attrib'

function env() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-t30-attrib-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'line1\nline2\nline3\nline4\n')
  writeFileSync(join(root, 'b.js'), 'bee1\nbee2\n')
  const link = { name: 'link-t30' }
  const grants = new GrantStore()
  // ★ A2（T62）：`allowDirtySave` 从"调用方传参"改成 **grant 级显式许可**。
  // 生产链路上扩展就是这么签发 grant 的（`extension.js` 的
  // `grants.adopt({ id, epoch, link, allowDirtySave: true })`），所以这些讲"编辑语义"的
  // 用例按生产口径带许可；"没有许可就不许写脏缓冲"由 t39/t40 单独守着。
  grants.adopt({ id: ID, epoch: EPOCH, link, allowDirtySave: true })
  const host = makeBufferHost([root])
  const caps = createCapabilities(host, { grants })
  return {
    root, host, caps, link,
    file: (n) => join(root, n),
    /**
     * 一次写入；`extra` 里给 `expectedVersion`（缺了会被 -32602 拒）。
     * ★ T35：`expectedIncarnation` 同样必填，默认给 `INCARNATION`；要造漏字段就显式传
     * `{ expectedIncarnation: undefined }`。
     */
    edit(file, range, text, extra = {}) {
      return caps.dispatch('vscode.applyEdit',
        {
          file, range, text, expectedIncarnation: INCARNATION,
          grant: { id: ID, epoch: EPOCH }, ...extra,
        }, { link })
    },
    /** 读文档状态（不需要 grant：纯读）。 */
    state(file, extra = {}) {
      return caps.dispatch('vscode.getDocumentState', { file, ...extra }, { link })
    },
    dispose: () => rmSync(base, { recursive: true, force: true }),
  }
}

/** 1-based 整行范围：start 列 1，end 列 = 行长 + 1。 */
const wholeLine = (line, length) => ({ start: { line, column: 1 }, end: { line, column: length + 1 } })

async function expectCode(promise, code, label) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code} (${err.message})`)
    return err
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`)
}

// ---------------------------------------------------------------------------
// ① T4 的 NO-GO 正面替代：旧版本写入被拦，人工改动留下
// ---------------------------------------------------------------------------

test('T62 ★ 重读锚点洗不白：人工键入后拿最新 version 重写 → 仍 -32011；isDirty=false 也不解冻', async () => {
  const e = env()
  try {
    const f = e.file('a.js')

    // 第一刀：DSH 把第 1 行 `line1`（5 字符）换成自己的文本，版本 0 → 1。
    const first = await e.edit(f, wholeLine(1, 5), 'DSH-LINE1', { expectedVersion: 0 })
    assert.equal(first.applied, true)
    assert.equal(first.saved, false)
    assert.equal(e.host.versionOf(f), 1, 'DSH 的写入同样会让缓冲区版本 +1')

    // 中间态：人在同一行补了一句 —— 只改缓冲区、**不经过任何 DSH 通道**，版本 1 → 2。
    e.host.humanType(f, 1, 10, ' HUMAN-WROTE-THIS')
    assert.equal(e.host.buffer(f).split('\n')[0], 'DSH-LINE1 HUMAN-WROTE-THIS')
    assert.equal(e.host.versionOf(f), 2)

    // 第二刀：DSH 仍然按**自己记的**版本（1）发整行替换。T4 时这一刀会静默吃掉人工的字；
    // T30 之后它必须在写宿主之前就被拦下。
    const callsBefore = e.host.calls.length
    const err = await expectCode(
      e.edit(f, wholeLine(1, 9), 'DSH-LINE1-V2', { expectedVersion: 1 }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'stale-write')
    assert.equal(err.data.file, f)
    assert.equal(err.data.expected, 1)
    assert.equal(err.data.actual, 2)
    assert.equal(e.host.calls.length, callsBefore, '冲突时宿主一次都不许被调用')
    assert.equal(e.host.buffer(f).split('\n')[0], 'DSH-LINE1 HUMAN-WROTE-THIS',
      '人工改动必须原样留下 —— 这条是 T4 丢字场景的反面')
    assert.equal(e.host.buffer(f).includes('HUMAN-WROTE-THIS'), true)

    // ★ A2（T62）：**拿到最新锚点出来也仍然拒写**。
    // 版本号能重读，但"这行字是谁敲的"重读不出来 —— 账本没有这条变更的归属证据
    // （人工键入落在写窗口之外 ⇒ `foreign-change`）。冻结是**逐文件**的，与版本无关。
    const fresh = await e.state(f)
    assert.equal(fresh.version, 2)
    const callsAfterStale = e.host.calls.length
    const tainted = await expectCode(
      e.edit(f, wholeLine(1, e.host.buffer(f).split('\n')[0].length), 'DSH-LINE1-V3',
        { expectedVersion: fresh.version }),
      ERR.DOCUMENT_DIRTY, 'fresh-anchor-still-dirty')
    assert.equal(tainted.data.reason, 'foreign-change', '原因要具体到"别人的改动"')
    assert.equal(tainted.data.attribution, 'unknown')
    assert.equal(tainted.data.retryable, false, '-32011 的处置是"别重发"，不是"重读再试"')
    assert.equal(tainted.data.mayHaveApplied, false, '还没碰宿主就拒了')
    assert.equal(tainted.data.recovery, 'human-rebase')
    assert.equal(e.host.calls.length, callsAfterStale, '冻结时宿主零调用')
    assert.equal(e.host.buffer(f).includes('HUMAN-WROTE-THIS'), true,
      '人工的字必须留下 —— 这次不是"整行覆盖"的选择，而是根本不许写')

    // ★ A2：`isDirty` 转 false（人手动保存了）**不能**洗白已经观察到的非桥接修改。
    // 保存解决的是"盘上有没有这段字"，不解决"这段字是谁写的"。
    e.host.markSaved(f)
    assert.equal(e.host.isDirtyOf(f), false)
    await expectCode(
      e.edit(f, wholeLine(1, 5), 'DSH-AFTER-SAVE', { expectedVersion: e.host.versionOf(f) }),
      ERR.DOCUMENT_DIRTY, 'taint-survives-save')
    assert.equal(e.host.buffer(f).includes('HUMAN-WROTE-THIS'), true)
  } finally { e.dispose() }
})

// ---------------------------------------------------------------------------
// ② 锚点在请求里，观测层给得出内容
// ---------------------------------------------------------------------------

test('T32 ★ 锚点下到写宿主：宿主在提交那一刻自己再判一次（前置检查不是保证）', async () => {
  const e = env()
  try {
    const f = e.file('a.js')
    const shape = await e.edit(f, wholeLine(2, 5), 'X', { expectedVersion: 0 })
    assert.equal(shape.applied, true)
    // T32 之后宿主**必须**知道版本：能力层那道前置检查与写入之间还隔着 await，
    // 真正"不覆盖人工内容"的判定在写宿主内部（`edit-transaction.js`）。
    assert.equal(e.host.calls.length, 1)
    assert.equal(e.host.calls[0].expectedVersion, 0, '锚点必须原样到达写宿主')
    assert.equal(e.host.calls[0].versionAtWrite, 0, '事务内读到的真实版本')
    // ★ T35：两条锚点**一起**下到写宿主（化身不再是"想给才给"的可选字段）。
    assert.equal(e.host.calls[0].expectedIncarnation, INCARNATION, '化身锚点也必须原样到达')
    assert.deepEqual(Object.keys(e.host.calls[0]).sort(),
      ['abs', 'expectedIncarnation', 'expectedVersion', 'range', 'text', 'versionAtWrite'])

    // T4 报告里"能力清单没有读文本"的缺口现在补上了：状态里既有版本，也有（可选的）全文。
    const meta = await e.state(f)
    assert.deepEqual(Object.keys(meta).sort(),
      ['eol', 'file', 'incarnation', 'isDirty', 'lineCount', 'textLength', 'version'])
    assert.equal(meta.version, 1)
    assert.equal(meta.file, f, '出口是规范化绝对路径')

    const withText = await e.state(f, { includeText: true })
    assert.equal(withText.text, e.host.buffer(f), 'text 必须是**整份**缓冲区，不是截断的一段')
    assert.equal(withText.textLength, withText.text.length)
  } finally { e.dispose() }
})

// ---------------------------------------------------------------------------
// ③ 保存边界：`saved:false` 必须真的不落盘（T30 没有引入保存能力）
// ---------------------------------------------------------------------------

test('★ 保存边界：写入不进磁盘 —— 缓冲区变了、文件内容与 mtime 都没变（不许偷偷 save）', async () => {
  const e = env()
  try {
    const f = e.file('a.js')
    const before = { text: readFileSync(f, 'utf8'), mtimeMs: statSync(f).mtimeMs, size: statSync(f).size }

    const r1 = await e.edit(f, wholeLine(1, 5), 'BUFFER-ONLY-1', { expectedVersion: 0 })
    const r2 = await e.edit(f, wholeLine(2, 5), 'BUFFER-ONLY-2', { expectedVersion: 1 })
    assert.equal(r1.saved, false)
    assert.equal(r2.saved, false)

    // 缓冲区（= 用户在编辑器里看到的）确实变了……
    assert.equal(e.host.buffer(f).split('\n')[0], 'BUFFER-ONLY-1')
    assert.equal(e.host.buffer(f).split('\n')[1], 'BUFFER-ONLY-2')
    // ……磁盘一个字节都没动。这是**唯一**能保证"DSH 不会悄悄覆盖盘上内容"的性质，
    // 但它同时意味着：DSH 的写入**随时可能整批蒸发**（关窗口→不保存→回到磁盘旧内容）。
    const after = { text: readFileSync(f, 'utf8'), mtimeMs: statSync(f).mtimeMs, size: statSync(f).size }
    assert.equal(after.text, before.text, '写入后磁盘内容必须与写入前逐字节相同')
    assert.equal(after.mtimeMs, before.mtimeMs, '写入后磁盘 mtime 不变（没有发生任何 fs 写）')
    assert.equal(after.size, before.size)
  } finally { e.dispose() }
})

// ---------------------------------------------------------------------------
// ④ 混合归属：仍然没有 per-file 状态 —— 拦不拦只看版本对不对
// ---------------------------------------------------------------------------

test('T30 ★ 混合归属：被改过的文件按版本拒、没被改过的文件照写（没有 per-file 停写状态）', async () => {
  const e = env()
  try {
    const f = e.file('a.js')
    const g = e.file('b.js')

    await e.edit(f, wholeLine(1, 5), 'DSH-1', { expectedVersion: 0 })   // f: v1
    e.host.humanType(f, 1, 6, ' +HUMAN')                                 // f: v2

    // f 上拿旧版本继续写 → 拒（不是"把这个文件标记成停写"，只是版本对不上）。
    await expectCode(
      e.edit(f, wholeLine(1, 5), 'DSH-2', { expectedVersion: 1 }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'f-stale')
    assert.equal(e.host.buffer(f).split('\n')[0], 'DSH-1 +HUMAN', '人工改动还在')

    // g 从没被人碰过：同一套流程、同一份 grant，照写不误 —— 归属判定没有"传染"到别的文件。
    const other = await e.edit(g, wholeLine(1, 4), 'BEE1-DSH', { expectedVersion: 0 })
    assert.equal(other.applied, true)
    assert.equal(e.host.buffer(g).split('\n')[0], 'BEE1-DSH')

    // 结论：能力层**没有** per-file 停写/降级状态，只有"版本对得上 / 对不上"。
    // 谁要是为了"归属未知 → 停该文件、其他文件继续"去发明一套每文件状态机，这条会变红。
    assert.equal(e.host.calls.length, 2, '两次成功写入落到宿主，一次冲突在写前就被拦下')
  } finally { e.dispose() }
})
