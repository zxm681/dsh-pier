/**
 * T5 负例（磁盘外部改动 / 缓冲区生命周期 / 删除能力不存在）。
 *
 * 三条都是评审 T31 三轮判卷**没覆盖**的负例，本文件各自守一条：
 *
 *  ★ Q2a 干净文档被外部改写 → 编辑器静默重载并 `version+1` → 旧锚点 `-32012`，零 edit 构造。
 *        真机证据：`solo.txt` v1 clean，外部 `printf` 写入后 2s 内 `getDocumentState`
 *        返回 `version:2` 且文本已含外部行；旧锚点写入回 `-32012 {expected:1, actual:2}`。
 *
 *  ★ Q2b 脏缓冲区 + 外部改写 → 编辑器**不重载**、`version` 不变 → 旧锚点放行；
 *        写入只落缓冲区（`saved:false`），**磁盘一个字节都没变**。
 *        真机证据：`shared.txt` dirty v2，外部写入后版本仍 2、缓冲区未重载；
 *        `expectedVersion:2` 写入 `applied:true`，磁盘仍是外部内容。
 *        残留风险（本用例有意记录，不是缺陷消失）：DSH 感知不到"磁盘与缓冲区已分叉"，
 *        它写的是缓冲区；之后**任何**一次保存（用户或别的工具）都会把外部改动覆盖掉。
 *
 *  ★ Q3 缓冲区生命周期：整份判定就是一个**整数相等**（`edit-transaction.js:115-131`）。
 *        主机侧没有任何「这份文档是哪一次打开」的身份，因此只要两份incarnation 的
 *        `document.version` 数字相同，旧锚点就能重新匹配。
 *        这一条在真机上**未能测完**（桌面输入被中断，见报告"未判定"一节）：
 *        `solo.txt`/`shared.txt`/`other.txt` 首次创建时版本都是 1（已实测），
 *        但"关闭再打开"后是否回到 1 没有真机数据。本用例只证明**机制**：
 *        版本数字相等 ⇒ 门无法区分 incarnation（无论重开后是否复位，只要数字撞上就成立）。
 *
 *  ★ Q4 删除/保存能力仍然不存在：`vscode.save` / `vscode.deleteFile` /
 *        `vscode.getDocumentText` 一律 `-32005`，**即使**工作区可信、grant 有效、
 *        参数合法也一样（能力门在授权门之前）；能力清单与 handler 表里都没有它们，
 *        且没有任何注册入口。附带记录一条**不可利用**的原型链遗留（见用例内注释）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { createCapabilities, CAPABILITIES } from '../src/capabilities.js'
import { applyEditAtomically } from '../src/edit-transaction.js'

const ID = 'c'.repeat(32)
const EPOCH = 'd'.repeat(32)

/** 0-based range 替换（等价 `vscode.Range` + `builder.replace` 的落点语义）。 */
function applyReplace(doc, range, value) {
  const { start, end } = range
  const head = doc.lines[start.line].slice(0, start.column)
  const tail = doc.lines[end.line].slice(end.column)
  const merged = (head + value + tail).split('\n')
  doc.lines = [...doc.lines.slice(0, start.line), ...merged, ...doc.lines.slice(end.line + 1)]
}

/**
 * 假宿主：一个可换的缓冲区（`doc`）+ 磁盘文件 + 真事务。
 *
 * `doc.isDirty` 参与 `externalWrite()` 的决策，因为真机上"重不重载"就取决于它（已实测）。
 * `replaceDocument()` 用来模拟**新的 incarnation**（关掉再打开 = 新建一个 `TextDocument`）。
 */
function makeHost(root, abs, { lines, version = 1 } = {}) {
  // ★ T35：文档实例身份。**每次 `replaceDocument` 都换一个新的**——这正是 H1 的场景：
  // 版本数字可以被复用（v1 → v1），化身不会。
  let incSeq = 0
  const nextInc = () => `inc-t5-${++incSeq}`
  let doc = { version, incarnation: nextInc(), lines: [...lines], isDirty: false, uri: { fsPath: abs } }
  const calls = []
  const builtEdits = []
  const host = {
    get doc() { return doc },
    calls,
    builtEdits,
    buffer: () => doc.lines.join('\n'),
    disk: () => readFileSync(abs, 'utf8'),
    /** 外部手段改磁盘（脚本/别的编辑器），并按真机行为决定是否重载缓冲区。 */
    externalWrite(nextLines) {
      writeFileSync(abs, `${nextLines.join('\n')}\n`, 'utf8')
      if (!doc.isDirty) {
        // 实测：干净文档检测到磁盘变化 → 静默重载，`document.version + 1`。
        doc.lines = [...nextLines]
        doc.version += 1
      }
      // 实测：脏缓冲区**不**重载，版本也不动（编辑器保留用户的改动）。
    },
    /** 关掉再打开 = 全新 `TextDocument`（版本从 1 起，与旧实例无任何关联）。 */
    replaceDocument(nextLines, nextVersion = 1) {
      doc = {
        version: nextVersion, incarnation: nextInc(), lines: [...nextLines],
        isDirty: false, uri: { fsPath: abs },
      }
    },
    fileExists: (p) => p === abs,
    resolvePath: (p) => p,
    workspaceRoots: () => [root],
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    log: () => {},
    readDocumentShape: async (_abs, lines2 = []) => ({
      lineCount: doc.lines.length,
      lineLengths: lines2.map((n) => (n >= 1 && n <= doc.lines.length
        ? doc.lines[n - 1].length
        : null)),
    }),
    readDocumentState: async (_abs, { includeText = false } = {}) => {
      const text = doc.lines.join('\n')
      return {
        version: doc.version,
        incarnation: doc.incarnation,
        isDirty: doc.isDirty,
        eol: 'lf',
        lineCount: doc.lines.length,
        textLength: text.length,
        byteLength: Buffer.byteLength(text, 'utf8'),
        ...(includeText === true ? { text } : {}),
      }
    },
    readRangeText: async (_abs, range) => {
      const at = (i) => doc.lines[i] ?? ''
      if (range.start.line === range.end.line) {
        return at(range.start.line).slice(range.start.column, range.end.column)
      }
      const parts = [at(range.start.line).slice(range.start.column)]
      for (let i = range.start.line + 1; i < range.end.line; i += 1) parts.push(at(i))
      parts.push(at(range.end.line).slice(0, range.end.column))
      return parts.join('\n')
    },
    applyEditText: async (_abs, range, text, expectedVersion, expectedIncarnation) => {
      calls.push({ range, text, expectedVersion, expectedIncarnation, versionAtEntry: doc.version })
      const target = doc
      const editor = {
        document: target,
        async edit(cb) {
          const ops = []
          cb({ replace: (r, v) => ops.push({ r, v }) })
          builtEdits.push(ops.length)
          for (const op of ops) { applyReplace(target, op.r, op.v); target.version += 1 }
          return true
        },
      }
      const outcome = await applyEditAtomically({
        editor, file: abs, expectedVersion, expectedIncarnation,
        readIncarnation: (d) => d.incarnation,
        apply: (builder) => builder.replace(range, text),
      })
      if (outcome.applied === true) target.isDirty = true // 真机：改了缓冲区就是脏
      return { applied: outcome.applied, documentPath: abs, version: outcome.version }
    },
  }
  return host
}

function env({ lines = ['alpha', 'beta', 'gamma'], version = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-t5-life-'))
  const abs = join(root, 'a.txt')
  writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8')
  const host = makeHost(root, abs, { lines, version })
  const grants = new GrantStore()
  const link = { name: 'link-t5' }
  grants.adopt({ id: ID, epoch: EPOCH, link })
  const caps = createCapabilities(host, { grants })
  return {
    root, abs, host, caps, link,
    dispose() { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } },
  }
}

function params(abs, extra = {}) {
  return {
    file: abs,
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
    text: 'DSH!',
    expectedVersion: 1,
    // ★ T35：化身无条件必填。默认给"命令式信封里那条 1 号文档"，缺字段的用例显式传 undefined。
    expectedIncarnation: 'inc-t5-1',
    grant: { id: ID, epoch: EPOCH },
    ...extra,
  }
}

/** 发一条写入请求。`ctx.link` 必须是**发放这条 grant 的那条连接对象**（按进程内引用比较）。 */
function write(env, paramsOrExtra, extra) {
  const p2 = (paramsOrExtra && typeof paramsOrExtra === 'object' && !('file' in paramsOrExtra))
    ? params(env.abs, { ...paramsOrExtra, ...(extra ?? {}) })
    : paramsOrExtra
  return env.caps.dispatch('vscode.applyEdit', p2, { link: env.link })
}

/** 真正构造出来的 `builder.replace` 个数（0 = 宿主一个字节都没被动过）。 */
function totalOps(host) {
  return host.builtEdits.reduce((sum, n) => sum + n, 0)
}

async function expectCode(promise, code, label) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code} (${err.message})`)
    return err
  }
  return assert.fail(`${label}: expected ${code}, but the call succeeded`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ Q2a 干净文档 + 外部磁盘改写 → 重载 → 旧锚点被拒
// ─────────────────────────────────────────────────────────────────────────────

test('★ T5 Q2a 干净文档被外部改写（编辑器重载 version+1）→ 旧锚点 -32012、零 edit 构造', async () => {
  const e = env({ lines: ['alpha one', 'beta two', 'gamma three'], version: 1 })
  try {
    // DSH 先读锚点（=1），随后**非编辑器**手段改磁盘。
    const before = await e.host.readDocumentState(e.abs)
    assert.equal(before.version, 1)
    e.host.externalWrite(['alpha one', 'beta two', 'EXTERNAL-A', 'gamma three'])

    // 干净文档被重载：版本已经漂到 2，缓冲区跟着磁盘走。
    const after = await e.host.readDocumentState(e.abs)
    assert.equal(after.version, 2)
    assert.equal(after.isDirty, false)

    const err = await expectCode(
      write(e, { range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, text: 'DSH!', expectedVersion: 1, grant: { id: ID, epoch: EPOCH } }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'Q2a 旧锚点',
    )
    assert.deepEqual({ expected: err.data.expected, actual: err.data.actual }, { expected: 1, actual: 2 })
    assert.equal(totalOps(e.host), 0, '版本门必须在构造任何 edit 之前返回')
    assert.equal(e.host.buffer(), 'alpha one\nbeta two\nEXTERNAL-A\ngamma three',
      '外部内容必须原样留在缓冲区里')
    assert.equal(e.host.disk(), 'alpha one\nbeta two\nEXTERNAL-A\ngamma three\n')
  } finally {
    e.dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ Q2b 脏缓冲区 + 外部磁盘改写 → 不重载 → 旧锚点放行，写只落缓冲区
// ─────────────────────────────────────────────────────────────────────────────

test('★ T5 Q2b 脏缓冲区+外部改写：版本不变、旧锚点放行；写只落缓冲区，磁盘不动', async () => {
  const e = env({ lines: ['alpha one', 'beta two', 'gamma three'], version: 1 })
  try {
    // 先让缓冲区变脏（模拟用户已键入、未保存）。
    e.host.doc.lines = ['alpha one', 'USER-EDIT beta two', 'gamma three']
    e.host.doc.version = 2
    e.host.doc.isDirty = true

    // 外部改写磁盘：脏缓冲区不重载，版本一个数都不动（实测行为）。
    e.host.externalWrite(['alpha one', 'beta two', 'EXTERNAL-B', 'gamma three'])
    const state = await e.host.readDocumentState(e.abs)
    assert.equal(state.version, 2, '脏缓冲区不因磁盘变化而换版本')
    assert.equal(state.isDirty, true)
    assert.match(e.host.buffer(), /USER-EDIT/, '缓冲区保留用户改动，没被磁盘内容替换')

    // 旧锚点（=2）写入：门按"缓冲区版本"判，相等 → 放行。
    const result = await write(e, {
      range: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } },
      text: 'DSH-STALE',
      expectedVersion: 2,
      grant: { id: ID, epoch: EPOCH },
    })
    assert.equal(result.applied, true)
    assert.equal(result.saved, false, 'DSH 从不保存（capabilities 里没有 save）')
    assert.match(e.host.buffer(), /DSH-STALE/, '写入落在缓冲区')
    assert.equal(e.host.disk(), 'alpha one\nbeta two\nEXTERNAL-B\ngamma three\n',
      '磁盘上的外部改动必须一个字节都没被动过 —— DSH 没有写磁盘的路径')
  } finally {
    e.dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ Q3 缓冲区生命周期：整数相等**不再**等于同一份文档（T35 收紧）
//
// 本组的前身是"新的 incarnation 版本数字相同时，旧锚点重新匹配"—— 它把 H1 写成了
// 期望行为：两个窗口/两次打开都从 v1 起，于是同一个整数锚点能在另一份内容上再放一次。
// ★ T35 把结局翻过来：版本数字相等、实例不同 ⇒ 拒写（-32012 `incarnation-mismatch`），
// 宿主零构造。**不是删掉这个场景，而是把它的期望改成正确的那一个** —— 可复现的问题
// 必须留在测试里，只是从"漏洞证据"变成"守门证据"。
// ─────────────────────────────────────────────────────────────────────────────

test('★ T35 Q3 版本数字相同但实例不同 → 旧锚点被拒（-32012 incarnation-mismatch，零写入）', async () => {
  const e = env({ lines: ['alpha', 'beta', 'gamma'], version: 1 })
  try {
    // ① 旧实例：读出两条锚点，写入成功。
    const state = await e.host.readDocumentState(e.abs)
    assert.equal(state.version, 1)
    const first = await write(e, {
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
      text: 'OLD!', expectedVersion: 1, expectedIncarnation: state.incarnation,
      grant: { id: ID, epoch: EPOCH },
    })
    assert.equal(first.applied, true)

    // ② 关闭再打开 = 另一个 `TextDocument`，内容完全不同（磁盘也被换过）。
    e.host.replaceDocument(['REOPENED alpha', 'REOPENED beta', 'REOPENED gamma'], 1)
    const reopened = await e.host.readDocumentState(e.abs)
    assert.equal(reopened.version, 1, '新实例的版本数字与旧实例**相同**（这正是 H1 的条件）')
    assert.notEqual(reopened.incarnation, state.incarnation, '但实例身份不同')

    // ③ 同一个版本数字 + 旧化身 ⇒ 拒。只剩整数相等已经不够证明"是同一份文档"。
    const opsBefore = totalOps(e.host)
    const err = await expectCode(
      write(e, {
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
        text: 'REPLAY!', expectedVersion: 1, expectedIncarnation: state.incarnation,
        grant: { id: ID, epoch: EPOCH },
      }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'Q3 新实例 + 旧化身',
    )
    assert.equal(err.data.reason, 'incarnation-mismatch', '冲突原因是实例不符，不是版本不符')
    assert.equal(err.data.expected, state.incarnation)
    assert.equal(err.data.actual, reopened.incarnation)
    // ④ 新内容一个字都没被碰过（旧坐标没有落进别人的上下文）
    assert.equal(totalOps(e.host), opsBefore, '宿主零构造 edit')
    assert.equal(e.host.buffer(), ['REOPENED alpha', 'REOPENED beta', 'REOPENED gamma'].join(String.fromCharCode(10)),
      '新实例的缓冲区原样保留')
  } finally {
    e.dispose()
  }
})

test('★ T5 Q3 版本数字不相等时被拒（说明门只靠这一个整数）', async () => {
  const e = env({ lines: ['alpha', 'beta', 'gamma'], version: 6 })
  try {
    await expectCode(
      write(e, {
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
        text: 'X!', expectedVersion: 1, grant: { id: ID, epoch: EPOCH },
      }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'Q3 版本不等',
    )
    assert.equal(totalOps(e.host), 0)
  } finally {
    e.dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ Q4 删除能力仍然不存在（保存已于 T39 落地，见 test/t39-save.test.js）
// ─────────────────────────────────────────────────────────────────────────────

test('★ T5 Q4 删除/改名/写文件能力仍不存在：deleteFile/renameFile/writeFile/getDocumentText 一律 -32005', async () => {
  const e = env()
  try {
    // 前置：工作区可信、grant 有效 —— 授权与信任都拉满。
    const ok = await write(e, {
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
      text: 'OK!', expectedVersion: 1, grant: { id: ID, epoch: EPOCH },
    })
    assert.equal(ok.applied, true)

    // ① 仍然未实现的能力：给多少授权都是 -32005（「对端不支持」，不是「你没权限」）。
    //    ★ T40 把 `vscode.deleteFile` 从这张名单里移走了（它现在是真能力，见 ②b）——
    //    这张名单是"能力清单变了"的守门人，加能力的人必须回来改它，这是有意的摩擦。
    for (const method of [
      'vscode.getDocumentText',
      'vscode.renameFile', 'vscode.writeFile', 'fs.delete', 'bridge.save',
    ]) {
      const err = await expectCode(
        e.caps.dispatch(method, { file: e.abs }, { link: e.link }),
        ERR.UNSUPPORTED, `${method} 必须 -32005`,
      )
      assert.equal(err.data.method, method)
    }

    // ② `vscode.save`（T39 已实现）不再是 -32005：它现在是一条**写入类**能力，
    //    没有 grant 时由绑定门拒（-32010）。这条是"能力清单变了"的可观测证据 ——
    //    免得以后有人把它误加回"未实现"名单里。
    const noGrant = await expectCode(
      e.caps.dispatch('vscode.save', { file: e.abs }, { link: e.link }),
      ERR.EDIT_NOT_BOUND, 'vscode.save 没有 grant 时必须 -32010（不是 -32005）',
    )
    assert.equal(noGrant.data.reason, 'no-grant')

    // ②b `vscode.deleteFile`（T40 已实现，**不可逆**）同理：没有 grant ⇒ -32010。
    //    顺序上看不出区别（门在 handler 之前），但这一点对删除格外重要：
    //    拒发生在**弹确认框之前**，所以未授权的删除连"骚扰人一下"都做不到。
    const delNoGrant = await expectCode(
      e.caps.dispatch('vscode.deleteFile', { file: e.abs }, { link: e.link }),
      ERR.EDIT_NOT_BOUND, 'vscode.deleteFile 没有 grant 时必须 -32010（不是 -32005）',
    )
    assert.equal(delNoGrant.data.reason, 'no-grant')

    // 能力清单与 handler 表里都没有它们；`CAPABILITIES` 是唯一对外声明源。
    //
    // ★ T58（E3）：**追加**两条事件订阅能力（`vscode.events.subscribe` /
    //   `vscode.events.unsubscribe`）。断言强度不变（仍是整份清单 deepEqual，
    //   少一条/多一条都红），加它们也不是"实现顺带加了方法"：
    //   `test/capabilities.test.js` 要求 `CAPABILITIES` 与 `handlers` 一一对应，
    //   kit 的 `test/response-contract.test.js` 又要求 `CAPABILITIES` 与
    //   `REGISTERED_METHODS` 双向相等 —— 也就是"能被处理的业务方法"必须
    //   同时被声明、被登记形状、被对端看见。三条既有契约合起来只允许这一种加法。
    assert.deepEqual([...CAPABILITIES], [
      'vscode.openFile', 'vscode.getSelection', 'vscode.getDiagnostics',
      'vscode.listOpenEditors', 'vscode.applyEdit', 'vscode.getDocumentState',
      'vscode.save', 'vscode.deleteFile',
      'vscode.events.subscribe', 'vscode.events.unsubscribe',
    ])
    const own = Object.keys(e.caps.handlers)
    assert.deepEqual(own.sort(), [...CAPABILITIES].sort(), 'handler 表与能力清单必须一一对应')
    for (const method of ['vscode.writeFile', 'vscode.renameFile', 'deleteFile']) {
      assert.equal(Object.hasOwn(e.caps.handlers, method), false, `handlers 不得有 ${method}`)
    }

    // 附带记录（**不可利用**，信息级）：handler 表是普通对象字面量，取键走原型链，
    // 于是 `constructor` / `toString` 这类名字能跳过 "-32005 未实现"，拿到的是
    // 参数回显 / 字符串 / TypeError —— 与删除、保存、写文件**无关**，一个字节都动不了。
    // 线路上还有两道门（kit 的 `_assertCapability` 回 -32005、DSH 入站白名单回 -32601，
    // 真机实测），所以这不是可利用路径，只是加固建议（`Object.hasOwn` / `Object.create(null)`）。
    assert.equal(Object.hasOwn(e.caps.handlers, 'constructor'), false)
    const echo = await e.caps.dispatch('constructor', { file: e.abs }, { link: e.link })
    assert.deepEqual(echo, { file: e.abs }, '原型链取到的是 `Object`：只回显参数')
    assert.equal(totalOps(e.host), 1, '除前面那次合法写入外，没有任何额外 edit 被构造')
    assert.equal(e.host.disk(), 'alpha\nbeta\ngamma\n', '磁盘未被任何一条未实现方法触碰')
  } finally {
    e.dispose()
  }
})
