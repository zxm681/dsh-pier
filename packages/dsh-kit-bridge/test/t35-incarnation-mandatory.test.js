/**
 * T35（扩展侧）：**文档实例锚点 `expectedIncarnation` 无条件必填**。
 *
 * ## 守的是 T6 终审的 H1
 *
 * T34 把化身做成"给了才判"：省略 `expectedIncarnation` ⇒ 能力层早失败跳过 + 事务内比较跳过
 * ⇒ 只剩整数版本比较。而版本号是**每个文档实例**各自的计数器 —— 两个窗口都停在 v7 时
 * （A=v7/inc-A，B=v7/inc-B），一条省略化身的 `vscode.applyEdit` 被两道门一起放过，
 * 按另一窗口的视图覆盖了授权窗口里的人工内容，还返回 `applied:true`。
 *
 * 三条线（与用户卡 T35 的修法一一对应）：
 *  ① 能力层：缺 / 空串 / 非字符串 → `-32602`（`reason:'expected-incarnation-missing'` 等），
 *     **在 `applyEditText` 之前**，宿主零写入 —— 与对端是否公告 features 无关；
 *  ② 事务内：版本与化身**都无条件判**（同一同步区间、零 await）；
 *  ③ 语义是**有意的不兼容收紧**：旧扩展（不返回 `incarnation`）从此不能被写。
 *
 * 与 T34 的分工：T34 证明"化身能区分实例"，T35 证明"这条判据没有关掉它的公开开关"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { PEER_FEATURE_DOCUMENT_INCARNATION } from '../../dsh-vscode-kit/src/index.js'
import { applyEditAtomically } from '../src/edit-transaction.js'
import { createCapabilities } from '../src/capabilities.js'

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-t35-incarnation-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  // 两个文件 = 两个窗口里各自打开的那份文档；内容相同、版本同为 1（这才是 H1 的土壤）。
  writeFileSync(join(root, 'a.js'), 'line1\nline2\nline3\n')
  writeFileSync(join(root, 'b.js'), 'line1\nline2\nline3\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 假宿主：**每个文件一个文档实例**（`incarnation` 稳定、版本各自计数）。
 *
 * 与 `vscode-host.js` 同构的那一半很重要：`applyEditText` 先拿到"此刻的编辑器"，
 * 再把版本判定交给**真事务**在 `edit(callback)` 的同步区间里做。
 */
function makeHost(root) {
  const files = new Map([
    [join(root, 'a.js'), { id: 'inc-A', version: 1, text: 'line1\nline2\nline3\n' }],
    [join(root, 'b.js'), { id: 'inc-B', version: 1, text: 'line1\nline2\nline3\n' }],
  ])
  const calls = []   // 宿主被要求写入的次数（能力层前置门拦住时必须是 0）
  const edits = []   // 事务里真正构造出 edit 的数量（零构造 = 宿主零写入）

  const resolve = (p) => (isAbsolute(p) ? normalize(p) : join(root, p))
  const doc = (p) => {
    const found = files.get(resolve(p))
    if (!found) throw new Error(`no open document for ${p}`)
    return found
  }

  const host = {
    calls,
    edits,
    docs: files,
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: resolve,
    workspaceRoots: () => [root],
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    log: () => {},
    readDocumentState: async (p, { includeText = false } = {}) => {
      const d = doc(p)
      return {
        version: d.version,
        incarnation: d.id,
        isDirty: false,
        eol: 'lf',
        lineCount: d.text.split('\n').length,
        textLength: d.text.length,
        byteLength: Buffer.byteLength(d.text, 'utf8'),
        ...(includeText === true ? { text: d.text } : {}),
      }
    },
    readDocumentShape: async (p, lines = []) => {
      const buf = doc(p).text.split('\n')
      return {
        lineCount: buf.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= buf.length ? buf[n - 1].length : null)),
      }
    },
    readRangeText: async () => '',
    applyEditText: async (p, range, text, expectedVersion, expectedIncarnation) => {
      calls.push({ file: resolve(p), range, text, expectedVersion, expectedIncarnation })
      const d = doc(p)
      const live = { version: d.version, id: d.id, text: d.text, uri: { fsPath: resolve(p) } }
      const editor = {
        document: live,
        edit: async (cb) => {
          let constructed = false
          cb({
            replace: (r, value) => {
              constructed = true
              const buf = live.text.split('\n')
              const head = buf[r.start.line].slice(0, r.start.column)
              const tail = buf[r.end.line].slice(r.end.column)
              live.text = [
                ...buf.slice(0, r.start.line),
                ...(head + value + tail).split('\n'),
                ...buf.slice(r.end.line + 1),
              ].join('\n')
              live.version += 1
            },
          })
          if (constructed) {
            edits.push({ expectedIncarnation })
            d.version = live.version
            d.text = live.text
          }
          return constructed ? true : false
        },
      }
      return applyEditAtomically({
        editor,
        file: resolve(p),
        expectedVersion,
        expectedIncarnation,
        readIncarnation: (docObj) => docObj.id,
        apply: (builder) => builder.replace(range, text),
      })
    },
  }
  return host
}

function setup({ features } = {}) {
  const ws = tempWorkspace()
  const link = { name: 'link-t35', ...(features === undefined ? {} : { features }) }
  const store = new GrantStore()
  store.adopt({ id: ID_A, epoch: EPOCH_A, link })
  const host = makeHost(ws.root)
  const caps = createCapabilities(host, { grants: store })
  return {
    ws, host, caps, link, store,
    a: join(ws.root, 'a.js'),
    b: join(ws.root, 'b.js'),
    dispose: () => ws.dispose(),
  }
}

function writeParams(file, extra = {}) {
  return {
    file,
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
    text: 'LINE2',
    grant: { id: ID_A, epoch: EPOCH_A },
    ...extra,
  }
}

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
// ① H1 的直接复现：两窗口版本数字相同、双方公告化身支持，按另一窗口的视图写
// ---------------------------------------------------------------------------

test('★ T35 两窗口版本数字相同 + 双方公告 → -32012 reason=incarnation-mismatch（主机零写入）', async () => {
  const t = setup({ features: [PEER_FEATURE_DOCUMENT_INCARNATION] })
  try {
    // 两个窗口各自读自己那份文档 —— 都会拿到 version:1，但实例身份不同。
    const anchorA = await t.caps.dispatch('vscode.getDocumentState', { file: t.a }, { link: t.link })
    const anchorB = await t.caps.dispatch('vscode.getDocumentState', { file: t.b }, { link: t.link })
    assert.equal(anchorA.version, anchorB.version, '前提：两个窗口的版本数字相同（H1 的土壤）')
    assert.equal(anchorA.version, 1)
    assert.notEqual(anchorA.incarnation, anchorB.incarnation, '前提：实例身份不同')
    assert.equal(t.host.calls.length, 0, '读不是写')

    // ── (a) H1 的**原形状**：调用方省略 `expectedIncarnation`（锚点来自 B 的视图）。
    //    T34 时代这一幕就是"按 B 的视图覆盖 A"的入口：省略字段 ⇒ 能力层早失败跳过。
    const omitted = await expectCode(
      t.caps.dispatch('vscode.applyEdit', writeParams(t.a, { expectedVersion: anchorB.version }),
        { link: t.link }),
      ERR.INVALID_PARAMS, '省略化身（H1 原形状）')
    assert.equal(omitted.data.reason, 'expected-incarnation-missing')
    assert.equal(t.host.calls.length, 0, '省略化身的写一次都没到宿主')

    // ── (b) 化身**给了**、但来自另一份文档（版本数字恰好相同）──
    // 授权窗口是 A（grant 绑 A 那条 link）；这一条写却带着 B 的锚点。
    // ★ T35 前：省略化身 / 或只比版本 ⇒ 版本数字相等 ⇒ 放行 ⇒ 按 B 的视图覆盖 A。
    const err = await expectCode(
      t.caps.dispatch('vscode.applyEdit', writeParams(t.a, {
        expectedVersion: anchorB.version,
        expectedIncarnation: anchorB.incarnation,
      }), { link: t.link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '按另一窗口的视图写')
    assert.equal(err.data.reason, 'incarnation-mismatch', '理由是实例不符，不是版本不符')
    assert.equal(err.data.expected, anchorB.incarnation, '错误点名调用方给的锚点来自哪份文档')
    assert.equal(err.data.actual, anchorA.incarnation, '也点名即将被写的那份文档是谁')
    assert.equal(t.host.calls.length, 0, '前置门就拦住了：宿主一次都没被要求写入')
    assert.equal(t.host.edits.length, 0, '零构造 edit')

    // ── 同一情形的**事务内**那一半（前置门被绕过的情形）──
    // 为什么这条也放在本用例：H1 是**两道门同时**跳过才成立的。上面的前置检查只是便宜
    // 的早失败，真正的保证是事务里那次同步比较 —— 所以"两窗口版本数字相同"这件事，
    // 必须在两道门上分别红一次（见本卡变异记录 ①/②）。
    // 此刻 A 那份文档仍是 v1 —— 与 B 的版本数字**真的**相同（控制写在下面才跑）。
    const liveA = t.host.docs.get(t.a)
    assert.equal(liveA.version, anchorB.version, '前提：事务这条路上两个版本数字也相同')
    let constructed = false
    const editorOnA = {
      document: { version: liveA.version, id: liveA.id, text: liveA.text, uri: { fsPath: t.a } },
      edit: async (cb) => { cb({ replace: () => { constructed = true } }); return constructed },
    }
    const viaTxn = await expectCode(
      applyEditAtomically({
        editor: editorOnA,
        file: t.a,
        expectedVersion: anchorB.version,         // 版本数字恰好相同
        expectedIncarnation: anchorB.incarnation, // 却是 B 那份文档的实例
        readIncarnation: (doc) => doc.id,
        apply: (builder) => builder.replace({ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, 'X'),
      }),
      ERR.DOCUMENT_VERSION_CONFLICT, '事务内也要按实例拒')
    assert.equal(viaTxn.data.reason, 'incarnation-mismatch')
    assert.equal(viaTxn.data.expected, anchorB.incarnation)
    assert.equal(viaTxn.data.actual, anchorA.incarnation)
    assert.equal(constructed, false, '零构造 edit')
    assert.equal(t.host.edits.length, 0, '连对照写都还没发生：此时 edits 必须是 0')

    // ── (c) 前置门被绕过、事务收到**缺**化身：失败闭合（-32603），零构造。
    //    这条是"事务内比较无条件"在 H1 情形下的形态：可选项恢复了就会静默放行。
    let constructed2 = false
    const viaTxnUndef = await expectCode(
      applyEditAtomically({
        editor: {
          document: { version: liveA.version, id: liveA.id, text: liveA.text, uri: { fsPath: t.a } },
          edit: async (cb) => { cb({ replace: () => { constructed2 = true } }); return constructed2 },
        },
        file: t.a,
        expectedVersion: anchorB.version,
        expectedIncarnation: undefined, // ← H1：省略字段
        readIncarnation: (doc) => doc.id,
        apply: (builder) => builder.replace({ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, 'X'),
      }),
      ERR.INTERNAL, '事务入口缺化身')
    assert.match(viaTxnUndef.message, /mandatory since T35/)
    assert.equal(constructed2, false, '零构造 edit = 宿主零写入')
    // 对照：同一份文档的锚点（版本相同、实例相同）照常写进去 —— 挡住 H1 的是化身，不是版本。
    const ok = await t.caps.dispatch('vscode.applyEdit', writeParams(t.a, {
      expectedVersion: anchorA.version,
      expectedIncarnation: anchorA.incarnation,
    }), { link: t.link })
    assert.equal(ok.applied, true)
    assert.equal(ok.saved, false, '写入按"不落盘"的契约：applied 但 saved:false')
    assert.equal(t.host.calls.length, 1)
    // `saved:false` ⇒ 缓冲区改了、磁盘没改。落点确实在 A 那份文档的缓冲区里。
    assert.match(t.host.docs.get(t.a).text, /LINE2/, '落到的确实是 A 那份文档的缓冲区')
    assert.equal(readFileSync(t.a, 'utf8').split('\n')[1], 'line2', '不落盘：磁盘还是原文')
    assert.equal(t.host.docs.get(t.b).text.split('\n')[1], 'line2', 'B 那份文档一个字节都没动')


  } finally { t.dispose() }
})

// ---------------------------------------------------------------------------
// ② 无条件必填：缺 / 空串 / 非字符串一律 -32602，且**在 applyEditText 之前**
// ---------------------------------------------------------------------------

test('★ T35 无条件必填：缺/空串/非字符串 → -32602，宿主零写入，与对端公告无关', async () => {
  const variants = [
    ['缺字段', {}, 'expected-incarnation-missing'],
    ['空串', { expectedIncarnation: '' }, 'expected-incarnation-not-a-non-empty-string'],
    ['数字', { expectedIncarnation: 7 }, 'expected-incarnation-not-a-non-empty-string'],
    ['null', { expectedIncarnation: null }, 'expected-incarnation-not-a-non-empty-string'],
  ]
  // 两个对端：一个公告化身支持（升级过），一个不公告（旧版扩展）。
  for (const features of [[PEER_FEATURE_DOCUMENT_INCARNATION], undefined]) {
    const t = setup({ features })
    try {
      for (const [label, extra, reason] of variants) {
        const err = await expectCode(
          t.caps.dispatch('vscode.applyEdit', writeParams(t.a, { expectedVersion: 1, ...extra }),
            { link: t.link }),
          ERR.INVALID_PARAMS, `${label}（features=${JSON.stringify(features)}）`)
        assert.equal(err.data.reason, reason, label)
        assert.equal(err.data.method, 'vscode.applyEdit')
      }
      assert.equal(t.host.calls.length, 0,
        '全部在 applyEditText 之前拒掉：宿主零写入（旧版扩展也不能被写 —— 有意的不兼容收紧）')
    } finally { t.dispose() }
  }
})

// ---------------------------------------------------------------------------
// ③ 事务内无条件比较：绕过能力层，直接调事务；缺化身 = 失败闭合（-32603），零构造
// ---------------------------------------------------------------------------

test('★ T35 事务内无条件判：绕过能力层直接调事务，缺化身 → -32603 且零构造 edit', async () => {
  const t = setup()
  try {
    const d = t.host.docs.get(t.a)
    const before = { version: d.version, text: d.text }
    const live = { version: d.version, id: d.id, text: d.text, uri: { fsPath: t.a } }
    let constructed = false
    const editor = {
      document: live,
      edit: async (cb) => {
        cb({ replace: () => { constructed = true } })
        return constructed
      },
    }

    // 版本完全正确、唯一缺的就是化身：这正是 H1 的形状（只比版本 ⇒ 放行）。
    const err = await expectCode(
      applyEditAtomically({
        editor,
        file: t.a,
        expectedVersion: before.version,
        expectedIncarnation: undefined,
        readIncarnation: (doc) => doc.id,
        apply: (builder) => builder.replace({ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, 'X'),
      }),
      ERR.INTERNAL, '事务入口缺化身')
    assert.match(err.message, /mandatory since T35/)
    assert.equal(constructed, false, '零构造 edit = 宿主零写入')
    assert.equal(d.version, before.version)
    assert.equal(d.text, before.text)

    // 同一入口给出**别的实例**的化身（版本仍然相等）→ 事务内那道比较也要拦。
    const mismatch = await expectCode(
      applyEditAtomically({
        editor,
        file: t.a,
        expectedVersion: before.version,
        expectedIncarnation: 'inc-B',
        readIncarnation: (doc) => doc.id,
        apply: (builder) => builder.replace({ start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }, 'X'),
      }),
      ERR.DOCUMENT_VERSION_CONFLICT, '事务内实例不符')
    assert.equal(mismatch.data.reason, 'incarnation-mismatch')
    assert.equal(mismatch.data.expected, 'inc-B')
    assert.equal(mismatch.data.actual, 'inc-A')
    assert.equal(constructed, false, '仍然零构造')
  } finally { t.dispose() }
})
