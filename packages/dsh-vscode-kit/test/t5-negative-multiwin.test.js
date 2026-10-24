/**
 * T5 负例（多窗口）：**读目标与写目标不是同一条连接**。
 *
 * 背景（评审 T31 文末遗留、T4 报告 §9 明确未做）：「两个窗口同时打开同一文件」
 * 下写目标是否按 grant 绑定、版本锚点还成不成立、会不会一个窗口的写落到另一个窗口。
 *
 * 实测结论按两半拆开（这一组用例各守一半）：
 *
 *  ① **写目标由 grant 记录决定**（`src/index.js:713-731` 的写路径分支 +
 *     `_bindWriteTarget` `src/index.js:250-265`）：B 后连**不会**让写入漂到 B。
 *     这是评审 F3 修的东西，用例 ① 守住它。
 *
 *  ② **读目标由"当前活跃连接"决定**（同文件 `else` 分支 `await this._waitForEditor()`
 *     → `_activeLink()` `src/index.js:316-334`，取 `connSeq` 最大**活**连接）：
 *     B 后连之后，`vscode.getDocumentState` **永远**落在 B —— A 上零次。
 *     于是「锚点」描述的是 B 的那份 `TextDocument`，而「写入」施加在 A 的那份上
 *     （两个窗口各自独立的模型实例，`document.version` 各数各的）。
 *     用例 ② 守住这条**不对称**：它在数字相等时静默通过（A 的 version 恰好也是那个数
 *     → 写入落到 A 的缓冲区），在数字不等时以 `-32012` 拒绝。
 *
 * 为什么这一组只能断到"帧去哪条连接"：进程内的假编辑器没有真的 `TextDocument`，
 * 版本是否相等由**对端**决定。真机上"数字相等 → 静默写入"的完整链路在
 * `work/安全负例-T5-多窗口与生命周期.md` 里以源码 + 帧证据给出。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { BridgeError, ERR, PROTOCOL_VERSION, connect, createLineSplitter } from '../src/protocol.js'

/**
 * 测试消费者身份（T38 白名单落地后，**写类调用必须来自已绑定身份的入口**）。
 *
 * 这一行不是"为了跑通而加的胶水"：它把既有 135 处调用点的身份显式化 ——
 * 以前它们全都经 `ctx.provide` 出去的共享 facade，而那个 facade 现在**只能是 read**。
 * 档位给到 `delete` 是为了让本文件继续测**它本来要测的那道门**（会话授权绑定 / 锚点 / 响应形状），
 * 不被白名单挡在前面；白名单自己的用例在 `test/t38-whitelist.test.js`。
 */
const TEST_CONSUMER = 'dsh-kit-test'
const TEST_CONSUMERS = { [TEST_CONSUMER]: 'delete' }
const boundSvc = (ctx) => {
  const shared = ctx.provided.get('dshVscodeKit').v
  return shared.forPlugin(TEST_CONSUMER, { declared: 'delete' })
}


const S1 = 'sess-alpha'
const FILE = '/ws/a.js'

/** A 窗口里那份文档的真实版本（只有 A 自己知道 —— 读路径不会问它）。 */
const A_VERSION = 7
/** B 窗口里那份文档的版本（数值上故意与"任何人可能拿来写的锚点"重合）。 */
const B_VERSION = 1
/** 两份文档的**实例身份**（T34；★ T35 起它是必填锚点的另一半，也是本文件的分水岭）。 */
const A_INCARNATION = 'inc-A'
const B_INCARNATION = 'inc-B'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-t5-multiwin-'))
}

function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v, check) { provided.set(n, { v, check }) },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    runDisposers() {
      while (disposers.length) {
        const d = disposers.pop()
        try { d() } catch { /* 卸载失败不影响其它清理 */ }
      }
    },
  }
}

function applyEditResult({ applied = true, file = FILE, saved = false, textLength = 5 } = {}) {
  return { applied, file, saved, textLength }
}

function stateResult(version, incarnation) {
  return {
    file: FILE, version, incarnation, isDirty: false, eol: 'lf', lineCount: 3, textLength: 11,
  }
}

/**
 * 窗口侧的写入判据（与 `vscode-host.js` → `edit-transaction.js` 同语义）：
 * 版本**和**化身都要与"我这窗口里那份文档"相等，否则零写入 + -32012。
 *
 * 这个假窗口原先无条件 `applied:true` —— 那让本文件只能测到"帧发给了谁"，
 * 测不到"这一帧该不该被收下"。★ T35 把判据搬进来，于是"两个窗口版本数字相同"
 * 不再等于"写得进去"。
 */
function judgeWrite(params, { version, incarnation }) {
  if (params?.expectedIncarnation !== incarnation) {
    throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
      `this window's document is ${incarnation}, the request was prepared for `
      + `${params?.expectedIncarnation ?? 'unknown'}`,
      {
        method: 'vscode.applyEdit', reason: 'incarnation-mismatch',
        expected: params?.expectedIncarnation ?? null, actual: incarnation,
      })
  }
  if (params?.expectedVersion !== version) {
    throw new BridgeError(ERR.DOCUMENT_VERSION_CONFLICT,
      `this window's document is at version ${version}, the request was prepared for `
      + `${params?.expectedVersion}`,
      {
        method: 'vscode.applyEdit', reason: 'version-mismatch',
        expected: params?.expectedVersion, actual: version,
      })
  }
  return applyEditResult()
}

/**
 * 一个"窗口"：裸 TCP 连桥，按自己的那份文档回答 `vscode.getDocumentState`，
 * 并记录收到的每一条帧（含通知）。
 */
async function windowClient(server, { label, docVersion, docIncarnation }) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'vscode.applyEdit') {
        return judgeWrite(params, { version: docVersion, incarnation: docIncarnation })
      }
      if (method === 'vscode.getDocumentState') return stateResult(docVersion, docIncarnation)
      throw new Error(`unexpected method ${method}`)
    },
  })
  socket.on('data', createLineSplitter((line) => {
    const msg = JSON.parse(line)
    seen.push(msg)
    link.handleLine(line)
  }))
  socket.on('error', () => {})
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    label,
    socket,
    seen,
    count(method) { return seen.filter((m) => m.method === method).length },
    last(method) { return seen.filter((m) => m.method === method).at(-1) },
    hello(ptv = PROTOCOL_VERSION, capabilities = ['vscode.applyEdit', 'vscode.getDocumentState', 'vscode.getSelection']) {
      return link.request('bridge.hello', {
        client: `win-${label}`, extensionVersion: '0.3.0', protocolVersion: ptv, capabilities,
      })
    },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

async function withKit() {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)
  const server = handle.kit.server
  const clients = []
  const open = async (opts) => {
    const c = await windowClient(server, opts)
    await c.hello()
    clients.push(c)
    return c
  }
  const cleanup = async () => {
    for (const c of clients) if (!c.socket.destroyed) await c.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, server, clients, open, cleanup }
}

/**
 * 写入参数（1-based）。默认取 **A 窗口**的锚点 = "拿获准写入的那份文档的锚点去写它"，
 * 这是唯一正确的用法。想造跨越窗口的错配，用例显式传 B 的版本 + 化身。
 */
function writeParams(extra = {}) {
  return {
    file: FILE,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
    text: 'hello',
    expectedVersion: A_VERSION,
    expectedIncarnation: A_INCARNATION,
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 写目标按 grant 绑定：后连的窗口收不到写入帧
// ─────────────────────────────────────────────────────────────────────────────

test('★ T5 多窗口：写目标按 grant 绑定，B 后连接收不到写入帧（F3 成立）', async () => {
  const kit = await withKit()
  try {
    const A = await kit.open({ label: 'A', docVersion: A_VERSION, docIncarnation: A_INCARNATION })
    // 只有 A 在的时候发 grant → 记录里承载连接就是 A。
    await kit.svc.editing.grant({ sessionId: S1, windowId: kit.svc.vscode.windows.list().at(-1).windowId })

    // B 后连（connSeq 更大 = 更"活跃"）。
    const B = await kit.open({ label: 'B', docVersion: B_VERSION, docIncarnation: B_INCARNATION })

    const result = await kit.svc.vscode.applyEdit(writeParams(), { sessionId: S1 })
    assert.equal(result.applied, true)
    assert.equal(result.saved, false)

    assert.equal(A.count('vscode.applyEdit'), 1, '写入必须落在发放 grant 的窗口 A')
    assert.equal(B.count('vscode.applyEdit'), 0, 'B 后连不得把写入吸过去（F3 的回归点）')
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 读目标按活跃连接：锚点来自 B、写目标是 A —— 本端来源门先挡，收端化身门兜底
// ─────────────────────────────────────────────────────────────────────────────

test('★ T35 跨窗口锚点：读活跃视图 B、写会话 S1 的 A → 本地 -32602 anchor-source-mismatch、零发送', async () => {
  const kit = await withKit()
  try {
    const A = await kit.open({ label: 'A', docVersion: A_VERSION, docIncarnation: A_INCARNATION })
    await kit.svc.editing.grant({ sessionId: S1, windowId: kit.svc.vscode.windows.list().at(-1).windowId })
    const B = await kit.open({ label: 'B', docVersion: B_VERSION, docIncarnation: B_INCARNATION })

    // 读路径：`request()` 的 else 分支 → `_activeLink()`（connSeq 最大）→ B。
    const state = await kit.svc.vscode.getDocumentState({ file: FILE })
    assert.equal(state.version, B_VERSION, '读到的必须是 B 的版本（B 更活跃）')
    assert.equal(state.incarnation, B_INCARNATION, '读到的化身也是 B 那份文档的')
    assert.equal(A.count('vscode.getDocumentState'), 0, 'A 上零次读 —— 这条锚点不是"获准写入的那份文档"的')

    // 用 B 的锚点写 A：这一层（来源门）就看得出"锚点来自活跃视图、写目标是会话绑定的窗口"。
    // ★ T35 之前这条请求能一路走到 A 并 applied:true —— 因为 A 与 B 的版本号最容易撞在一起。
    const err = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: state.version, expectedIncarnation: state.incarnation }),
      { sessionId: S1 },
    ).then(() => null, (e) => e)
    assert.ok(err, '跨窗口锚点必须失败，不许静默写进 A')
    assert.equal(err.code, ERR.INVALID_PARAMS, '本端拒（-32602），不改写成 -32012')
    assert.equal(err.data.reason, 'anchor-source-mismatch')
    assert.equal(err.data.stage, 'local', '本地拒 = 一个字节都没发')
    assert.equal(A.count('vscode.applyEdit'), 0, '宿主零写入')
    assert.equal(B.count('vscode.applyEdit'), 0)

    // 正路：会话绑定读拿到的锚点，写同一个会话 —— 照常成功。
    const bound = await kit.svc.editing.stateFor(S1, FILE)
    assert.equal(bound.incarnation, A_INCARNATION, 'stateFor 读的必须是 grant 记录里那条连接（A）')
    const ok = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: bound.version, expectedIncarnation: bound.incarnation }),
      { sessionId: S1 },
    )
    assert.equal(ok.applied, true)
    assert.equal(ok.saved, false)
    assert.equal(A.count('vscode.applyEdit'), 1)
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 正常路径：同会话 stateFor + applyEdit（T35 不许把正常写也一起收紧掉）
// ─────────────────────────────────────────────────────────────────────────────

test('★ T35 正常路径仍成功：同会话 stateFor + applyEdit，saved:false', async () => {
  const kit = await withKit()
  try {
    // A 绑授权；B 后连、更"活跃" —— 正常路径也不许被活跃连接带偏。
    const A = await kit.open({ label: 'A', docVersion: A_VERSION, docIncarnation: A_INCARNATION })
    await kit.svc.editing.grant({ sessionId: S1, windowId: kit.svc.vscode.windows.list().at(-1).windowId })
    const B = await kit.open({ label: 'B', docVersion: B_VERSION, docIncarnation: B_INCARNATION })

    const state = await kit.svc.editing.stateFor(S1, FILE)
    assert.equal(state.version, A_VERSION)
    assert.equal(state.incarnation, A_INCARNATION)
    assert.equal(A.count('vscode.getDocumentState'), 1, '绑定读落在 A（不是活跃的 B）')
    assert.equal(B.count('vscode.getDocumentState'), 0)

    const result = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: state.version, expectedIncarnation: state.incarnation }),
      { sessionId: S1 },
    )
    assert.equal(result.applied, true)
    assert.equal(result.saved, false, '写入不落盘：applied 但 saved:false')
    assert.equal(A.count('vscode.applyEdit'), 1)
    assert.equal(B.count('vscode.applyEdit'), 0)
    const frame = A.last('vscode.applyEdit')
    assert.equal(frame.params.expectedIncarnation, A_INCARNATION, '两条锚点原样上线')
    assert.equal(frame.params.expectedVersion, A_VERSION)
  } finally {
    await kit.cleanup()
  }
})
