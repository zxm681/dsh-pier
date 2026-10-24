/**
 * T32：**写入事务** —— 版本等值的唯一保证处（评审 T31 的阻断 B1）。
 *
 * B1 的实证（`work/t31-independent.log`）：版本检查之后、真正写入之前的异步窗口里人工
 * 插一行，四个入口**全部**写入成功并吃掉人工内容，`applied` 还是 `true`：
 *
 *   RACE_raw        expectedVersion=1 versionAtWrite=2 applied=true calls=1
 *   RACE_object     expectedVersion=1 versionAtWrite=2 applied=true calls=1
 *   RACE_positional expectedVersion=1 versionAtWrite=2 applied=true calls=1
 *   RACE-range-text expectedVersion=1 versionAtWrite=2 applied=true calls=1
 *   CONCURRENT_REPLAY results=[applied:true,applied:true] calls=2 version=3
 *
 * 这个文件的作用只有一个：**让上面那两行再也复现不出来**，并且用的是会真的变红的方式
 * （判卷要求的三次变异：把事务内判定改成只看前置结果 → 用例 ① 红；去掉同文件串行化 →
 * 用例 ② 红；事务内判定用 `expected` 回显代替 `document.version` → 用例 ① 红）。
 *
 * 假宿主的取舍（为什么这里要自己搭一套，不复用 `apply-edit.test.js` 的 `makeHost`）：
 *  - 这里要的是**真事务**：`applyEditText` 内部调真正的 `applyEditAtomically`
 *    （`src/edit-transaction.js`），因此"版本在提交那一刻再判一次"这条性质是被**执行**
 *    出来的，不是被断言假装的。别的文件里的假宿主是"永远配合"的替身，它们不承担这件事。
 *  - 假宿主提供两个**注入点**（真实让出点的等价物）：
 *      `hooks.afterVersionCheck`  —— 在 `readDocumentShape`（能力层 ④）里，即前置检查之后；
 *      `hooks.beforeTransaction`  —— 在 `applyEditText` 入口，即事务开始之前。
 *    钩子改的是**假宿主的缓冲区与 version**（真机上人工键入也是改内存 document、version+1），
 *    不是往请求里塞假数字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'
import { createCapabilities } from '../src/capabilities.js'
import { applyEditAtomically, TRANSACTION_METHOD } from '../src/edit-transaction.js'

// ---------------------------------------------------------------------------
// 脚手架：缓冲区 + 版本号 + 真事务
// ---------------------------------------------------------------------------

const ID = 'c'.repeat(32)
const EPOCH = 'd'.repeat(32)
const LINES = ['line1', 'line2', 'line3']
/**
 * 假文档的实例身份（T34 引入；★ T35 起 `expectedIncarnation` **无条件必填**）。
 *
 * 脚手架默认带上它，与 `expectedVersion: 0` 同理：本文件要验的是"人工编辑能不能插进事务
 * 的窗口"，而缺锚点会在**锚点形状门**就短路，那些窗口根本跑不到。
 */
const INCARNATION = 'inc-t32'

/** 0-based range 的替换（等价 `vscode.Range` + `builder.replace` 的落点语义）。 */
function applyReplace(doc, range, value) {
  const { start, end } = range
  const head = doc.lines[start.line].slice(0, start.column)
  const tail = doc.lines[end.line].slice(end.column)
  const merged = (head + value + tail).split('\n')
  doc.lines = [...doc.lines.slice(0, start.line), ...merged, ...doc.lines.slice(end.line + 1)]
}

/** 模拟**人工编辑**：改缓冲区 + `version + 1`（真机键入与 `WorkspaceEdit` 都是这个效果）。 */
function humanInsert(doc, line, column, value) {
  applyReplace(doc, { start: { line, column }, end: { line, column } }, value)
  doc.version += 1
  doc.dirty = true
}

/**
 * 假宿主：缓冲区（`doc`）+ 一个**真事务**的写宿主。
 *
 * 与 `vscode-host.js` 的 `applyEditText` 同构：先把编辑器拿到手（`doc` 本身就是"那个编辑器
 * 的 document"），再交给 `applyEditAtomically` 在 `edit(callback)` 的同步 callback 里判版本。
 */
function makeHost(root, abs, { hooks = {} } = {}) {
  const doc = {
    version: 0,
    // A2（T62）：缓冲区是否**未保存**。真机的 `isDirty` 就是这么来的：改了就脏，保存才清。
    // 旧版本这个假宿主恒报 `isDirty: true`，v2 之后那等于"每个文件天生来源不明"——全部拒写。
    dirty: false,
    // ★ T35：化身无条件必填 ⇒ 假文档必须带实例身份（写侧在事务里比对的就是它）。
    incarnation: INCARNATION,
    lines: readFileSync(abs, 'utf8').split(/\r?\n/),
    uri: { fsPath: abs },
  }
  const calls = []
  const builtEdits = []
  const listeners = []
  /** 走观察器报一次变更（真机：`onDidChangeTextDocument`）。位置是 `character` 口径。 */
  const emit = (changes) => {
    for (const fn of listeners.slice()) {
      fn({ file: abs, version: doc.version, incarnation: doc.incarnation, changes, reasonCode: 1 })
    }
  }
  const host = {
    doc,
    calls,
    builtEdits,
    buffer: () => doc.lines.join('\n'),
    fileExists: (p) => p === abs,
    resolvePath: (p) => p,
    workspaceRoots: () => [root],
    listeners,
    // A2（T62）：真观察器。没有它桥接拒绝一切写入（observation-gap），有它才能把
    // "人工键入"与"我这笔写的"分开 —— B1 那些用例正是"两笔变更落在同一个窗口里"的故事。
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
    log: () => {},
    // 范围边界的数据源：报**缓冲区**的形状（真适配器读的也是 document，不是磁盘）。
    readDocumentShape: async (_abs, lines = []) => {
      // 让出点①：前置版本检查已经过了，人工编辑可以在这里发生（评审 B1 的原始窗口）。
      await hooks.afterVersionCheck?.(doc)
      return {
        lineCount: doc.lines.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= doc.lines.length
          ? doc.lines[n - 1].length
          : null)),
      }
    },
    readDocumentState: async (_abs, { includeText = false } = {}) => {
      const text = doc.lines.join('\n')
      return {
        version: doc.version,
        incarnation: doc.incarnation,
        isDirty: doc.dirty,
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
    /**
     * 真事务的写宿主。`expectedVersion` 是能力层传下来的**锚点本身**（不是一个布尔值）；
     * 判定发生在 `applyEditAtomically` 里 —— 版本不等就**一次 edit 都不构造**。
     */
    applyEditText: async (_abs, range, text, expectedVersion, expectedIncarnation, observation) => {
      calls.push({
        range, text, expectedVersion, expectedIncarnation, versionAtEntry: doc.version,
      })
      // 让出点②：事务开始之前（最后一道 await 之外）。人工编辑落在这里也照样被挡住。
      await hooks.beforeTransaction?.(doc)
      const editor = {
        document: doc,
        async edit(cb) {
          const ops = []
          // 真机 `TextEditor.edit` 的 callback 也是**同步执行**的：这里不许 await。
          cb({ replace: (r, v) => ops.push({ r, v }) })
          builtEdits.push(ops.length)
          for (const op of ops) { applyReplace(doc, op.r, op.v); doc.version += 1 }
          if (ops.length > 0) {
            doc.dirty = true
            // 真机：WorkspaceEdit 落地同样触发 onDidChangeTextDocument（在写窗口内）。
            emit(ops.map((op) => ({ start: op.r.start, end: op.r.end, text: op.v })))
          }
          return true
        },
      }
      const outcome = await applyEditAtomically({
        editor, file: abs, expectedVersion, expectedIncarnation,
        readIncarnation: (d) => d.incarnation,
        // A1/A2：两个回调都**原样**下到事务 —— 只在同步区间里各调一次。
        ...(typeof observation?.observe === 'function' ? { observe: observation.observe } : {}),
        ...(typeof observation?.verify === 'function' ? { verify: observation.verify } : {}),
        apply: (builder) => builder.replace(range, text),
      })
      return { applied: outcome.applied, documentPath: abs, version: outcome.version }
    },
  }
  return host
}

/** 一套环境：临时工作区 + 真事务假宿主 + 已授权的能力层。 */
function env({ hooks, lines = LINES } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-t32-'))
  const abs = join(root, 'a.js')
  writeFileSync(abs, `${lines.join('\n')}\n`, 'utf8')
  const host = makeHost(root, abs, { hooks })
  const grants = new GrantStore()
  const link = { name: 'link-t32' }
  // ★ A2（T62）：脏缓冲的写入许可来自 **grant**（生产链路上扩展就是这么签发的），
  // 调用方传参一律不读。这里带上它，因为本文件的用例讲的是"锚点/事务窗口"，
  // 不是"授权表里没有这条"。
  grants.adopt({ id: ID, epoch: EPOCH, link, allowDirtySave: true })
  const caps = createCapabilities(host, { grants })
  return {
    root, abs, host, caps, link,
    dispose() { try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ } },
  }
}

/** 协议对外的 1-based 参数（`expectedVersion` 必填，从 getDocumentState 拿）。 */
/**
 * 累计**真正构造出来的 edit 数**。能力层里 `editor.edit(cb)` 总会先被调用一次（那是提交
 * 入口），所以"宿主零写入"的判据不是 `edit()` 没被叫，而是 **callback 里一个 `builder.replace`
 * 都没发生** —— 也就是这个和必须是 0。真机语义一致：空 edit 集提交等于什么都没做。
 */
function totalOps(host) {
  return host.builtEdits.reduce((sum, n) => sum + n, 0)
}

/**
 * 发一条写入请求。`ctx.link` 必须是**发放这条 grant 的那条连接对象**（`judgeGrant` 第 6 行
 * 按进程内引用比较），缺了它连门都过不去，根本走不到本卡要验的地方。
 */
function write(caps, link, paramsOrExtra) {
  return caps.dispatch('vscode.applyEdit', paramsOrExtra, { link })
}

function params(abs, extra = {}) {
  return {
    file: abs,
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
    text: 'DSH!!',
    expectedVersion: 0,
    expectedIncarnation: INCARNATION,
    grant: { id: ID, epoch: EPOCH },
    ...extra,
  }
}

async function expectCode(promise, code, label) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code,
      `${label}: expected ${code}, got ${err.code} (${err.message})`)
    return err
  }
  return assert.fail(`${label}: expected ${code}, but the call succeeded`)
}

// ---------------------------------------------------------------------------
// ① 事务本身（不起能力层）——机制的最小可执行描述
// ---------------------------------------------------------------------------

test('T32 事务：版本相等 → 构造并提交 edit；返回编辑器报的版本与文档身份', async () => {
  const e = env()
  try {
    const result = await write(e.caps, e.link, params(e.abs))
    assert.equal(result.applied, true)
    assert.equal(result.saved, false)
    assert.equal(e.host.buffer().split('\n')[1], 'DSH!!', '第 2 行被替换')
    assert.equal(e.host.doc.version, 1, '写入让版本 +1（与真机一致）')
  } finally { e.dispose() }
})

test('T32 事务：版本不等 → builder 零调用、抛 -32012（data: file/expected/actual）', async () => {
  const e = env()
  try {
    humanInsert(e.host.doc, 0, 5, ' HUMAN') // 缓冲区被人工改过：version 0 → 1
    const err = await expectCode(
      write(e.caps, e.link, params(e.abs, { expectedVersion: 0 })),
      ERR.DOCUMENT_VERSION_CONFLICT, 'stale write',
    )
    assert.deepEqual(
      { file: err.data.file, expected: err.data.expected, actual: err.data.actual },
      { file: err.data.file, expected: 0, actual: 1 },
      'data 三个数与前置检查同形（file/expected/actual）',
    )
    assert.equal(err.data.method, TRANSACTION_METHOD)
    assert.equal(totalOps(e.host), 0, '宿主零构造 edit（builder.replace 零次）')
  } finally { e.dispose() }
})

test('T32 事务：从读版本到构造 edit 全在同步区间 —— 排队中的 microtask 插不进来', async () => {
  // 这是"本卡核心"的可执行表述：如果事务在版本守卫与 edit 构造之间引入任何 await，
  // 下面这个已经排进 microtask 队列的回调就会先跑，`sawMicrotask` 变 true，用例立刻红。
  let sawMicrotask = false
  const doc = { version: 3, lines: ['a'], uri: { fsPath: '/tmp/x.js' } }
  const editor = {
    document: doc,
    async edit(cb) {
      cb({ replace: () => { assert.equal(sawMicrotask, false, '构造 edit 之前有让出点：事务不再原子') } })
      return true
    },
  }
  const outcome = applyEditAtomically({
    editor,
    file: '/tmp/x.js',
    expectedVersion: 3,
    expectedIncarnation: INCARNATION,
    readIncarnation: (d) => d.incarnation ?? INCARNATION,
    apply: (b) => b.replace({}, 'X'),
  })
  queueMicrotask(() => { sawMicrotask = true })
  await outcome
  assert.equal(sawMicrotask, true, 'microtask 最终会跑（只是不许跑在事务中间）')
})

test('T32 事务：edit 返回 false 且版本已变 → 仍按冲突报；版本没变 → applied:false', async () => {
  const base = { lines: ['a'], uri: { fsPath: '/tmp/x.js' } }
  // 情形①：构造之后、提交之前又被改（主线程 CAS 拒绝）→ 冲突
  {
    const doc = { ...base, version: 1 }
    const editor = {
      document: doc,
      async edit(cb) {
        cb({ replace: () => {} })
        doc.version = 2 // 主线程拒绝了这次提交，同时缓冲区被改
        return false
      },
    }
    const err = await expectCode(
      applyEditAtomically({
        editor,
        file: '/tmp/x.js',
        expectedVersion: 1,
        expectedIncarnation: INCARNATION,
        readIncarnation: (d) => d.incarnation ?? INCARNATION,
        apply: (b) => b.replace({}, 'X'),
      }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'rejected-by-cas',
    )
    assert.equal(err.data.actual, 2)
  }
  // 情形②：版本没变、编辑器就是拒绝了（只读/文档被关）→ 如实报 applied:false
  {
    const doc = { ...base, version: 7 }
    const editor = { document: doc, edit: async (cb) => { cb({ replace: () => {} }); return false } }
    const outcome = await applyEditAtomically({
      editor,
      file: '/tmp/x.js',
      expectedVersion: 7,
      expectedIncarnation: INCARNATION,
      readIncarnation: (d) => d.incarnation ?? INCARNATION,
      apply: (b) => b.replace({}, 'X'),
    })
    assert.deepEqual(outcome, {
      applied: false, documentPath: '/tmp/x.js', version: 7, incarnation: INCARNATION,
    })
  }
})

test('T32 事务：拿不到编辑器 / 锚点不是整数 → -32603 失败闭合（不许"当成没给"）', async () => {
  await expectCode(
    applyEditAtomically({
      editor: {}, file: '/tmp/x.js', expectedVersion: 1,
      expectedIncarnation: INCARNATION, apply: () => {},
    }),
    ERR.INTERNAL, 'not-an-editor',
  )
  await expectCode(
    applyEditAtomically({
      editor: { document: { version: 1 }, edit: async () => true },
      file: '/tmp/x.js',
      expectedVersion: undefined,
      expectedIncarnation: INCARNATION,
      readIncarnation: () => INCARNATION,
      apply: () => {},
    }),
    ERR.INTERNAL, 'no-anchor',
  )
})

// ---------------------------------------------------------------------------
// ② ★ 判卷要求的三条回归（都用真事务的假宿主）
// ---------------------------------------------------------------------------

test('★ B1 版本检查后人工插行 → 宿主零调用写入（builder.replace 零次）+ -32012', async () => {
  // 钩子在**事务开始之前**改真缓冲区、真 version（不是假数字）：这正是 T31 的 RACE_raw。
  const e = env({
    hooks: { beforeTransaction: (doc) => humanInsert(doc, 0, 5, ' HUMAN') },
  })
  try {
    // 人工插行之后的**唯一**正确内容（钩子在请求处理中途才改缓冲区，所以这份期望值
    // 就是"人工编辑 + 一次成功的 DSH 写入"该长什么样 —— 后者必须没有发生）。
    const humanOnly = ['line1 HUMAN', 'line2', 'line3', ''].join('\n')
    const err = await expectCode(
      write(e.caps, e.link, params(e.abs, { expectedVersion: 0 })),
      ERR.DOCUMENT_VERSION_CONFLICT, 'race-after-check',
    )
    // ① 请求确实走到了写宿主（修法把判定搬进事务内部，宿主必然被调用）……
    assert.equal(e.host.calls.length, 1, '写宿主被调用了一次')
    assert.equal(e.host.calls[0].expectedVersion, 0, '锚点原样到达写宿主')
    // ……② 但**一次 edit 都没有构造** —— 这就是"宿主零写入"的判据
    assert.equal(totalOps(e.host), 0, '宿主零构造 edit（builder.replace 零次）')
    // ③ 人工内容原样留着，一个字都没被吃掉
    assert.equal(e.host.buffer(), humanOnly, '缓冲区与人工编辑后完全一致（DSH 一个字都没写进去）')
    assert.match(e.host.buffer(), /HUMAN/, '人工插入的那一行还在')
    assert.deepEqual(
      { expected: err.data.expected, actual: err.data.actual },
      { expected: 0, actual: 1 },
      '冲突的 data 给出"我以为的 / 实际的"',
    )
    // ④ 磁盘更没动（缓冲区都没动过）
    assert.equal(readFileSync(e.abs, 'utf8'), `${LINES.join('\n')}\n`)
  } finally { e.dispose() }
})

test('★ B1 版本检查后人工插行（更早的让出点：readDocumentShape 内）→ 同样 -32012、零写入', async () => {
  // 能力层 ④（`readDocumentShape`）也是一个真实让出点 —— 评审 B1 点名的那个位置。
  const e = env({ hooks: { afterVersionCheck: (doc) => humanInsert(doc, 0, 0, 'HUMAN ') } })
  try {
    await expectCode(
      write(e.caps, e.link, params(e.abs, { expectedVersion: 0 })),
      ERR.DOCUMENT_VERSION_CONFLICT, 'race-in-shape',
    )
    assert.equal(totalOps(e.host), 0, '宿主零构造 edit（builder.replace 零次）')
    assert.equal(e.host.buffer().split('\n')[0], 'HUMAN line1', '人工前缀留下，没有被覆盖')
  } finally { e.dispose() }
})

test('★ B1 同版本并发重放 → 恰好一次成功、另一次 -32012（宿主只被调一次）', async () => {
  const e = env()
  try {
    const p = params(e.abs, { expectedVersion: 0 })
    const [a, b] = await Promise.allSettled([
      write(e.caps, e.link, { ...p, text: 'ONCE' }),
      write(e.caps, e.link, { ...p, text: 'ONCE' }),
    ])
    const settled = [a, b]
    const ok = settled.filter((r) => r.status === 'fulfilled')
    const bad = settled.filter((r) => r.status === 'rejected')

    assert.equal(ok.length, 1, '恰好一次成功（不是两次）')
    assert.equal(bad.length, 1, '另一次被拒')
    assert.equal(bad[0].reason.code, ERR.DOCUMENT_VERSION_CONFLICT, '被拒的那次是 -32012')
    assert.equal(ok[0].value.applied, true)
    // 串行化的直接证据：第二个请求是在锁内才读版本的，所以它**根本没摸到写宿主**。
    assert.equal(e.host.calls.length, 1, '写宿主只被调用一次（第二个被前置检查挡在锁内）')
    assert.equal(totalOps(e.host), 1, '只有一次 edit 构造')

    // 文件内容与"只写一次"完全一致 —— 没有被写两遍，也没有人被打成 ONCEONCE。
    const expected = ['line1', 'ONCE', 'line3', ''].join('\n')
    assert.equal(e.host.buffer(), expected, '内容等于只写一次的结果')
    assert.equal(e.host.doc.version, 1, '版本只 +1')
  } finally { e.dispose() }
})

test('★ B1 四个入口一致 → 同一处事务内判定保护（raw / 对象 / 位置 / expectedRangeText）', async () => {
  // 「入口」是**消费端**的四种写法（`kit.request(...)` / `kit.vscode.applyEdit(obj)` /
  // `kit.vscode.applyEdit(file, range, text, opts)` / 带 `expectedRangeText` 的分支）。
  // 三种前者的归一化在 kit 侧 `test/document-version.test.js` 的归一化用例里守着
  // （产出**同一份** params），所以这里按线上**参数形态**枚举四种，全部必须被同一处事务判定
  // 挡住 —— 没有哪个入口能绕开"提交那一刻再判一次"。
  const cases = [
    ['raw request（kit.request 直发）', (abs) => params(abs)],
    ['对象形态（applyEdit(obj)，含等价坐标写法）', (abs) => params(abs, {
      range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
    })],
    ['位置参数（applyEdit(file, range, text, opts)）', (abs) => params(abs, {
      range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
      grant: { id: ID, epoch: EPOCH },
    })],
    ['expectedRangeText 分支', (abs) => params(abs, { expectedRangeText: 'line2' })],
  ]
  for (const [label, build] of cases) {
    const e = env({ hooks: { beforeTransaction: (doc) => humanInsert(doc, 0, 5, ' HUMAN') } })
    try {
      await expectCode(
        write(e.caps, e.link, build(e.abs)),
        ERR.DOCUMENT_VERSION_CONFLICT, label,
      )
      assert.equal(totalOps(e.host), 0, `${label}: 零 edit 构造`)
      assert.match(e.host.buffer(), /HUMAN/, `${label}: 人工内容留下`)
    } finally { e.dispose() }
  }
})

test('T32 串行化按**文件**分键：不同文件并行（不是全局锁），同一文件排队', async () => {
  const e = env()
  const other = join(e.root, 'b.js')
  writeFileSync(other, 'b1\nb2\nb3\n', 'utf8')
  // 让两个文件的读都"卡住"直到两边都到齐：全局锁会让这里永远等不到 → 用例超时红。
  let arrived = 0
  let release
  const both = new Promise((r) => { release = r })
  const host = e.host
  const shape = host.readDocumentShape
  const otherHost = makeHost(e.root, other)
  // 复用同一套能力层：把 b.js 交给同一个假宿主（同实例 = 同一条锁表）
  host.readDocumentShape = async (abs, lines) => {
    arrived += 1
    if (arrived === 2) release()
    await both
    return shape(abs, lines)
  }
  host.fileExists = (p) => p === e.abs || p === other
  host.readDocumentState = async (abs, opts) => (abs === other
    ? otherHost.readDocumentState(abs, opts)
    : readStateOf(e.host, abs, opts))
  host.applyEditText = async (abs, range, text, expectedVersion, expectedIncarnation) => (
    abs === other
      ? otherHost.applyEditText(abs, range, text, expectedVersion, expectedIncarnation)
      : applyToMain(e, abs, range, text, expectedVersion, expectedIncarnation))

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('排队跨文件了：全局锁？')), 2000))
  try {
    const [ra, rb] = await Promise.race([
      Promise.all([
        write(e.caps, e.link, params(e.abs, { expectedVersion: 0 })),
        write(e.caps, e.link, params(other, { expectedVersion: 0 })),
      ]),
      timeout,
    ])
    assert.equal(ra.applied, true)
    assert.equal(rb.applied, true)
    assert.equal(e.host.buffer().split('\n')[1], 'DSH!!', 'a.js 写成功')
    assert.equal(otherHost.buffer().split('\n')[1], 'DSH!!', 'b.js 也写成功（并行）')
  } finally { e.dispose() }
})

/** `host.readDocumentState` 的原始实现（上面为了造 barrier 覆盖过它）。 */
async function readStateOf(host, abs, { includeText = false } = {}) {
  const text = host.doc.lines.join('\n')
  return {
    version: host.doc.version,
    incarnation: host.doc.incarnation,
    isDirty: host.doc.dirty === true,
    eol: 'lf',
    lineCount: host.doc.lines.length,
    textLength: text.length,
    byteLength: Buffer.byteLength(text, 'utf8'),
    ...(includeText === true ? { text } : {}),
  }
}

/** 走真事务写主文件（上面覆盖 `applyEditText` 时复用）。 */
async function applyToMain(e, abs, range, text, expectedVersion, expectedIncarnation) {
  const doc = e.host.doc
  const editor = {
    document: doc,
    async edit(cb) {
      const ops = []
      cb({ replace: (r, v) => ops.push({ r, v }) })
      e.host.builtEdits.push(ops.length)
      for (const op of ops) { applyReplace(doc, op.r, op.v); doc.version += 1 }
      return true
    },
  }
  const outcome = await applyEditAtomically({
    editor, file: abs, expectedVersion, expectedIncarnation,
    readIncarnation: (d) => d.incarnation,
    apply: (builder) => builder.replace(range, text),
  })
  return { applied: outcome.applied, documentPath: abs, version: outcome.version }
}

// ---------------------------------------------------------------------------
// T33：锁键必须是**同一文件的稳定身份**（评审 T31 第二轮 I1）
//
// 实证（`work/评审-T31-版本锚点-第二轮.md` I1）：`realpath` 不统一段名大小写，`C:\ws\a.txt`
// 与 `c:\ws\A.TXT` 是同一文件（同 dev 同 ino）却算出两条锁键 → 两条写并发通过前置版本检查、
// 双双摸到写宿主。事务内 CAS 只保住了"至多一次落点"，没有保住"一次只有一个在读版本"。
//
// 下面两条用例的分工：
//   ① 同文件的三种写法**只能进一条链**（读阶段 1 次、写宿主 1 次）；
//   ② 不同文件**仍然并行**（键不许退化成常量 —— 那是全局锁，会死在 barrier 超时上）。
// ---------------------------------------------------------------------------

/**
 * 同一个文件的三种写法：真机上三者 `stat` 出来同 dev 同 ino（用例 ① 里会先自证这件事，
 * 免得测试在没有别名语义的环境里"绿得没意义"）。
 */
function aliasSpellings(abs) {
  const lowerDrive = abs[0] === abs[0].toUpperCase()
    ? abs[0].toLowerCase() + abs.slice(1)
    : abs
  return [['原始绝对路径', abs], ['段名全大写', abs.toUpperCase()], ['盘符小写', lowerDrive]]
}

test('★ T33 Windows 大小写别名 → 同一文件串行化（同一条链：旧锚点只被读进判定一次）',
  {
    // NTFS 的大小写不敏感是 Windows 独有的语义；其它平台上 `A.TXT` 是**另一个文件**
    // （`realpath` 直接 ENOENT），这条用例在那里没有可验证的东西。
    skip: process.platform !== 'win32'
      ? 'Windows 段名大小写别名只在 win32 上有意义'
      : false,
  },
  async () => {
    const e = env()
    try {
      // ── 先自证：三种写法指向同一个 inode（不是靠"文件名长得像"来假装同一文件）──
      const spellings = aliasSpellings(e.abs)
      const stats = spellings.map(([, p]) => statSync(p))
      for (const [label, s] of spellings.map((sp, i) => [sp[0], stats[i]]).slice(1)) {
        assert.deepEqual({ dev: s.dev, ino: s.ino }, { dev: stats[0].dev, ino: stats[0].ino },
          `${label}: 必须与原始路径同 dev 同 ino`)
      }

      // ── 判别式①：**同一个旧锚点被读进判定的次数**。锁键正确 = 1；别名绕过 = 3 ──
      // （排队者也会读版本 —— 它读到的应该是第一个请求 bump 之后的 1，所以这里数的是
      //  "读到 version 0 的次数"，不是"读了几次"。）
      let staleReads = 0
      const readState = e.host.readDocumentState
      e.host.readDocumentState = async (abs, opts) => {
        const state = await readState(abs, opts)
        if (state.version === 0) staleReads += 1
        return state
      }

      const settled = await Promise.allSettled(spellings.map(([, p]) => write(e.caps, e.link,
        params(p, { expectedVersion: 0, text: 'ONCE' }))))

      const ok = settled.filter((r) => r.status === 'fulfilled')
      const bad = settled.filter((r) => r.status === 'rejected')
      assert.equal(ok.length, 1, '恰好一次 applied:true（不是两次/三次）')
      assert.equal(bad.length, 2, '另外两次被拒')
      for (const r of bad) {
        assert.equal(r.reason.code, ERR.DOCUMENT_VERSION_CONFLICT, '被拒的都是 -32012')
      }
      assert.equal(ok[0].value.applied, true)

      // ── 判别式②（这条才是抓 I1 的那条）：别名必须共享一条链 ──
      // 事务 CAS 单独也能让上面的 ok/bad 成立（评审原话："CAS 保住了至多一成功，但队列确实
      // 已被绕过"）。真正的区别在**后两条请求有没有在锁内才读版本**：共享链 = 后两条在
      // 前置检查就被挡住、根本不摸写宿主。
      assert.equal(staleReads, 1,
        '同一个旧锚点只许被读进判定一次（别名进了两条链 → 三次都读到 version 0）')
      assert.equal(e.host.calls.length, 1, '写宿主只被调用一次（后两条被前置检查挡在锁内）')
      assert.equal(totalOps(e.host), 1, '只有一次 edit 构造')

      // ── 最终内容等于"只写一次" ──
      const expected = ['line1', 'ONCE', 'line3', ''].join('\n')
      assert.equal(e.host.buffer(), expected, '内容等于只写一次的结果（没有人被打成 ONCEONCE）')
      assert.equal(e.host.doc.version, 1, '版本只 +1')
    } finally { e.dispose() }
  })

test('★ T33 不同文件仍可并行（大写别名没把锁做成全局锁）', async () => {
  const e = env()
  const other = join(e.root, 'b.js')
  writeFileSync(other, 'b1\nb2\nb3\n', 'utf8')
  try {
    // A 用**大写别名**写 a.js，B 用原样路径写 b.js。两者必须在各自的锁内**同时**待住：
    // 键若是常量（全局锁）或把不同文件错误归并，两边都到不齐 → 死在下面的 2s 超时上。
    const aliasA = aliasSpellings(e.abs)[1][1]
    const otherHost = makeHost(e.root, other)
    const host = e.host
    const shape = host.readDocumentShape
    let arrived = 0
    let release
    const both = new Promise((r) => { release = r })
    host.readDocumentShape = async (abs, lines) => {
      arrived += 1
      if (arrived === 2) release()
      await both
      return shape(abs, lines)
    }
    host.fileExists = (p) => p === e.abs || p === other
    host.readDocumentState = async (abs, opts) => (abs === other
      ? otherHost.readDocumentState(abs, opts)
      : readStateOf(host, abs, opts))
    host.applyEditText = async (abs, range, text, expectedVersion, expectedIncarnation) => (
      abs === other
        ? otherHost.applyEditText(abs, range, text, expectedVersion, expectedIncarnation)
        : applyToMain(e, abs, range, text, expectedVersion, expectedIncarnation))

    const timeout = new Promise((_, rej) => setTimeout(
      () => rej(new Error('锁变全局了：两个不同文件没能同时进锁（键不是按文件身份分的？）')), 2000))

    const [ra, rb] = await Promise.race([
      Promise.all([
        write(e.caps, e.link, params(aliasA, { expectedVersion: 0 })),
        write(e.caps, e.link, params(other, { expectedVersion: 0 })),
      ]),
      timeout,
    ])
    assert.equal(ra.applied, true, 'a.js（大写别名）写成功')
    assert.equal(rb.applied, true, 'b.js 也写成功')
    assert.equal(e.host.buffer().split('\n')[1], 'DSH!!', 'a.js 落点正确')
    assert.equal(otherHost.buffer().split('\n')[1], 'DSH!!', 'b.js 落点正确（并行）')
  } finally { e.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ T62（A2）：写许可的**第二道**在构造 builder 的同步区间里
//
// 排队时判一次（宿主零调用的早拒），构造 builder 前再判一次 —— 后者是"从判定到落笔之间
// 没有 await"的唯一区间。这条用例把"判定之后、落笔之前**新来一份证据**"的情形钉死：
// 少了这道复核，旧代码会照写下去（变异 M1 就红在这里）。
// ─────────────────────────────────────────────────────────────────────────────

test('★ T62 门在同步区间：排队后、构造前来了冻结证据 → 零构造 + -32011', async () => {
  const e = env({
    hooks: {
      // 让出点：排队判定已经过了（干净），事务还没开始构造 builder。
      // 这里模拟"同一刻别处报来一条本桥接无法归属的证据"（真实的例子：另一个工具
      // 通过适配器报了 `markForeign`，或者上一笔写结算后判成 mixed-origin）。
      beforeTransaction: () => {
        const key = pathIdentityKey(e.abs)
        e.caps.writePolicy.markForeign(key, { reason: 'foreign-change', note: 'landed after queue gate' })
      },
    },
    lines: ['alpha one', 'beta two'],
  })
  try {
    let err = null
    try {
      await write(e.caps, e.link, params(e.abs, { expectedVersion: 0, text: 'DSH!!' }))
    } catch (x) { err = x }
    assert.equal(err?.code, ERR.DOCUMENT_DIRTY, '构造前必须再判一次：这道门晚了就等于没有')
    assert.equal(err?.data?.phase, undefined, 'phase 只是诊断，不进 data；这里确认码本身')
    assert.equal(err?.data?.reason, 'foreign-change')
    assert.equal(totalOps(e.host), 0, '★ 一个 builder.replace 都不许发生')
    assert.equal(e.host.buffer().includes('DSH!!'), false, '缓冲区一个字都没变')
  } finally { e.dispose() }
})
