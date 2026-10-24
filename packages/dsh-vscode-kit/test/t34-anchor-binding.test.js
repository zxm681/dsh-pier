/**
 * T34（DSH 侧）：**读也要绑到 grant 的那条连接**，并且锚点必须带文档实例身份。
 *
 * ## 守的是 T5 的 Q1（高危）
 *
 * 写路径从 F3 起就按 `grants[session].link` 选目标了，但**读**路径还在走
 * `_activeLink()`（扫 `trusted` 取 `connSeq` 最大）—— 于是 A 拿 grant、B 后连时，
 * `vscode.getDocumentState` 永远问 B，拿回来的版本号是 B 那份 `TextDocument` 的，
 * 写入却落在 A 上。两个窗口版本数字一重合，版本门放行，坐标按 B 的视角落进 A 的
 * 缓冲区：**静默错配**（T5 报告 §1.4/§1.5 给了帧证据）。
 *
 * 这个文件守两件事：
 *  ① `vscode.getDocumentState` 一旦拿到 `opts.sessionId`，目标**必须是**该会话 grant
 *     记录里的那条 link；没有有效记录 ⇒ `-32010`，**一个读帧都不发**，绝不回退活跃连接。
 *  ② `kit.vscode.applyEdit` 在本地就拒掉"锚点来自别的窗口/别的会话"的写请求：
 *     `incarnation → link` 的来源表 + 目标 link 的对象身份比对，**一个写帧都不发**。
 *
 * ## 为什么只能断到"帧去哪条连接"
 *
 * 进程内的假窗口没有真的 `TextDocument`；断言落点是**帧**（`seen`）而不是缓冲区。
 * 真机上"数字相等 ⇒ 静默写入"的完整链路在 `work/安全负例-T5-多窗口与生命周期.md`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, PEER_FEATURE_DOCUMENT_INCARNATION } from '../src/index.js'
import { ERR, PROTOCOL_VERSION } from '../src/protocol.js'
import { connect, createLineSplitter } from '../src/protocol.js'

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
const S2 = 'sess-beta'
const FILE = '/ws/a.js'

const A_VERSION = 7
const B_VERSION = 7          // 数字**故意相等**：版本门在这种情形下什么也挡不住
const A_INC = 'inc-aaaaaaaaaaaaaaaa'
const B_INC = 'inc-bbbbbbbbbbbbbbbb'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-t34-anchor-'))
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

function stateResult({ version, incarnation }) {
  return {
    file: FILE,
    version,
    ...(incarnation === undefined ? {} : { incarnation }),
    isDirty: false,
    eol: 'lf',
    lineCount: 3,
    textLength: 11,
  }
}

function applyEditResult() {
  return { applied: true, file: FILE, saved: false, textLength: 5 }
}

/**
 * 一个"窗口"：裸 TCP 连桥，按自己那份文档回答 `vscode.getDocumentState`，
 * 并记录收到的每一条帧。`features` 决定它在 hello 里怎么声明语义能力（T34）。
 */
async function windowClient(server, { label, docVersion, docIncarnation, features }) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'vscode.applyEdit') return applyEditResult()
      if (method === 'vscode.getDocumentState') {
        return stateResult({ version: docVersion, incarnation: docIncarnation })
      }
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
  await link.request('bridge.hello', {
    client: `win-${label}`,
    extensionVersion: '0.3.0',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: ['vscode.applyEdit', 'vscode.getDocumentState', 'vscode.getSelection'],
    // T64：windowId 必须是这条连接的**真实**身份，所以窗口块要真报（否则只有 tmp-<connSeq>）。
    window: { sessionId: `sess-${label}`, workspace: { name: `ws-${label}`, folders: [] }, uiKind: 1, remoteName: null },
    ...(features === undefined ? {} : { features }),
  })
  return {
    label,
    socket,
    seen,
    count(method) { return seen.filter((m) => m.method === method).length },
    last(method) { return seen.filter((m) => m.method === method).at(-1) },
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
  const cleanup = async () => {
    for (const c of clients) if (!c.socket.destroyed) await c.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, server, clients, cleanup }
}

/**
 * 某个假窗口的**真实** `windowId`（按 hello 窗口块里的 `workspace.name` 反查）。
 *
 * T64 起 grant 的 `windowId` 必须解析到承载那条 grant 的连接，编一个 `win-A` 会直接
 * 拒 `-32014 target-not-routable` —— 用例要么给真值，要么就是在测那条拒绝。
 */
async function windowIdOf(svc, name) {
  const rows = await svc.vscode.windows.list()
  const row = rows.find((w) => typeof w.label === 'string' && w.label.startsWith(`ws-${name} · `))
  assert.ok(row, `window ws-${name} must be listed by windows.list()`)
  return row.windowId
}

/** 写入参数（1-based 坐标）。锚点由用例自己填 —— 这正是被测的东西。 */
function writeParams(extra = {}) {
  return {
    file: FILE,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
    text: 'hello',
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

// ─────────────────────────────────────────────────────────────────────────────
// ① 跨窗口锚点错配 → 本地拒，且**一个写帧都不发**
// ─────────────────────────────────────────────────────────────────────────────

test('★ T34 跨窗口锚点错配 → 本地拒/不写入：A 读到的锚点写不进 B 的会话', async () => {
  const kit = await withKit()
  try {
    // A 先连、先拿 grant（记录里的承载连接就是 A）。
    const A = await windowClient(kit.server, {
      label: 'A', docVersion: A_VERSION, docIncarnation: A_INC,
      features: [PEER_FEATURE_DOCUMENT_INCARNATION],
    })
    kit.clients.push(A)
    await kit.svc.editing.grant({ sessionId: S1, windowId: await windowIdOf(kit.svc, 'A') })

    // B 后连（connSeq 更大 = 更"活跃"），拿自己的 grant。
    const B = await windowClient(kit.server, {
      label: 'B', docVersion: B_VERSION, docIncarnation: B_INC,
      features: [PEER_FEATURE_DOCUMENT_INCARNATION],
    })
    kit.clients.push(B)
    await kit.svc.editing.grant({ sessionId: S2, windowId: await windowIdOf(kit.svc, 'B') })

    // ── 绑定读：锚点必须来自 **S1 的 grant 连接**（A），不是活跃连接（B）──
    const anchor = await kit.svc.editing.stateFor(S1, FILE)
    assert.equal(anchor.version, A_VERSION)
    assert.equal(anchor.incarnation, A_INC, '锚点必须带 A 那份文档的实例身份')
    assert.equal(anchor.boundTo, 'session', '绑定读必须标明"这是会话视角"')
    assert.equal(anchor.boundSessionId, S1)
    assert.equal(A.count('vscode.getDocumentState'), 1, '读帧必须落在 A（grant 的连接）')
    assert.equal(B.count('vscode.getDocumentState'), 0,
      'B 更活跃也一个字都不许读 —— 读不能再用 _activeLink() 挑目标')

    // ── 拿 A 的锚点去写 S2（B 的会话）：本地拒，零帧 ──
    const err = await expectCode(
      kit.svc.vscode.applyEdit(
        writeParams({
          expectedVersion: anchor.version,
          expectedIncarnation: anchor.incarnation,
        }),
        { sessionId: S2 },
      ),
      ERR.INVALID_PARAMS, 'A 的锚点 → S2 的写')
    assert.equal(err.data.reason, 'anchor-source-mismatch')
    assert.equal(err.data.stage, 'local', '必须是本地拒（没经过网络）')
    assert.equal(err.data.anchor.sessionId, S1, '错误里点名锚点来自哪个会话')
    assert.equal(err.data.target.sessionId, S2, '也点名这次要写哪个会话')
    assert.equal(B.count('vscode.applyEdit'), 0,
      '错配的写请求**一个字节都不许发** —— 发出去就只能靠版本号拦住它')
    assert.equal(A.count('vscode.applyEdit'), 0)

    // ── 同样的锚点写给它自己的会话：成功（本地拒没有把正确路径连坐）──
    const ok = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: anchor.version, expectedIncarnation: anchor.incarnation }),
      { sessionId: S1 },
    )
    assert.equal(ok.applied, true)
    assert.equal(ok.saved, false)
    assert.equal(A.count('vscode.applyEdit'), 1, '正确锚点写到正确的窗口')
    assert.equal(B.count('vscode.applyEdit'), 0)
    const frame = A.last('vscode.applyEdit')
    assert.equal(frame.params.expectedIncarnation, A_INC, '化身必须原样上线（留在 opts 里宿主收不到）')
    assert.equal(frame.params.expectedVersion, A_VERSION)
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 绑定读没有有效 grant → -32010，绝不回退活跃连接
// ─────────────────────────────────────────────────────────────────────────────

test('★ T34 绑定读：会话没有有效 grant → -32010，不回退活跃编辑器（零读帧）', async () => {
  const kit = await withKit()
  try {
    const A = await windowClient(kit.server, {
      label: 'A', docVersion: A_VERSION, docIncarnation: A_INC,
    })
    kit.clients.push(A)

    // ① 从未发放 grant 的会话：行 1（no-grant）
    const err = await expectCode(
      kit.svc.editing.stateFor('sess-never', FILE), ERR.EDIT_NOT_BOUND, '没有 grant 的会话')
    assert.equal(err.data.reason, 'no-grant')
    assert.equal(A.count('vscode.getDocumentState'), 0, '没有有效 grant 就不该去问任何一个窗口')

    // ② 有记录但承载连接已死：行 3（target-gone）；此时另一条连接还活着（活跃）
    await kit.svc.editing.grant({ sessionId: S1, windowId: await windowIdOf(kit.svc, 'A') })
    const B = await windowClient(kit.server, {
      label: 'B', docVersion: B_VERSION, docIncarnation: B_INC,
    })
    kit.clients.push(B)
    await A.close()
    const err2 = await expectCode(
      kit.svc.editing.stateFor(S1, FILE), ERR.EDIT_NOT_BOUND, 'grant 的连接已死')
    // 连接 close 会先把记录置墓碑（`grants.closeLink`），于是这里通常是 `no-grant`；
    // 若 close 事件还排在队列里没派发，则走 `target-gone`（判定表行 3）。
    // 两种都算"没有有效 grant" —— 断言 reason 属于这一族就够，**不允许**任何第三种结果。
    assert.equal(['no-grant', 'target-gone'].includes(err2.data.reason), true,
      `reason 必须是 no-grant / target-gone，实际 ${err2.data.reason}`)
    assert.equal(B.count('vscode.getDocumentState'), 0,
      '记录里的连接死了也不许改问活跃窗口 —— 那就是 Q1 原地复现')

    // ③ 对照：不给 sessionId 时仍是"活跃视角"，且返回体自己标明这一点
    const active = await kit.svc.vscode.getDocumentState(FILE)
    assert.equal(active.boundTo, 'active')
    assert.equal(B.count('vscode.getDocumentState'), 1)
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 同一会话正常路径仍成功
// ─────────────────────────────────────────────────────────────────────────────

test('★ T34 同一会话正常路径仍成功：stateFor + applyEdit 一条龙，saved:false', async () => {
  const kit = await withKit()
  try {
    const A = await windowClient(kit.server, {
      label: 'A', docVersion: 3, docIncarnation: A_INC,
      features: [PEER_FEATURE_DOCUMENT_INCARNATION],
    })
    kit.clients.push(A)
    await kit.svc.editing.grant({ sessionId: S1, windowId: await windowIdOf(kit.svc, 'A') })

    const anchor = await kit.svc.editing.stateFor(S1, FILE)
    assert.equal(anchor.boundTo, 'session')
    assert.equal(anchor.incarnation, A_INC)

    const result = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: anchor.version, expectedIncarnation: anchor.incarnation }),
      { sessionId: S1 },
    )
    assert.equal(result.applied, true)
    assert.equal(result.saved, false, '只改缓冲区，绝不保存')
    assert.equal(A.count('vscode.applyEdit'), 1)
    const frame = A.last('vscode.applyEdit')
    assert.equal(frame.params.expectedVersion, 3)
    assert.equal(frame.params.expectedIncarnation, A_INC)
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ④ 必填口径**无条件**（T35：不再看对端在 hello 里声明什么）
// ─────────────────────────────────────────────────────────────────────────────

test('★ T35 无条件必填：对端声明与不声明都一样拒（旧版扩展从此不能写）', async () => {
  const kit = await withKit()
  try {
    // A 声明了 features ⇒ 强制
    const A = await windowClient(kit.server, {
      label: 'A', docVersion: 1, docIncarnation: A_INC,
      features: [PEER_FEATURE_DOCUMENT_INCARNATION],
    })
    kit.clients.push(A)
    await kit.svc.editing.grant({ sessionId: S1, windowId: await windowIdOf(kit.svc, 'A') })
    const err = await expectCode(
      kit.svc.vscode.applyEdit(writeParams({ expectedVersion: 1 }), { sessionId: S1 }),
      ERR.INVALID_PARAMS, '声明支持却缺化身')
    assert.equal(err.data.reason, 'expected-incarnation-missing')
    assert.equal(err.data.stage, 'local')
    assert.equal(A.count('vscode.applyEdit'), 0, '缺锚点的写一个字节都不许发')

    // A 关掉，换一个**不声明** features 的窗口（旧版扩展）。
    // ★ T35 前这里期望"放行" —— 那正是 H1 的态度问题：安全不变量挂在对方的公告上，
    //   "对端不公告"就成了关掉判据的一条路径。现在**一样拒**。
    //   代价是被接受的：旧版扩展不返回 incarnation ⇒ 无法证明"写的是同一个文档实例" ⇒ 不能写。
    await A.close()
    const C = await windowClient(kit.server, { label: 'C', docVersion: 1, docIncarnation: 'inc-c' })
    kit.clients.push(C)
    await kit.svc.editing.grant({ sessionId: 'sess-old', windowId: await windowIdOf(kit.svc, 'C') })
    const legacy = await expectCode(
      kit.svc.vscode.applyEdit(writeParams({ expectedVersion: 1 }), { sessionId: 'sess-old' }),
      ERR.INVALID_PARAMS, '未声明支持也照样缺化身')
    assert.equal(legacy.data.reason, 'expected-incarnation-missing')
    assert.equal(legacy.data.stage, 'local')
    assert.equal(C.count('vscode.applyEdit'), 0, '旧版扩展也收不到"少判一半"的写帧')

    // 给了化身就照常放行（拒的是"缺锚点"，不是"旧对端"）。
    const ok = await kit.svc.vscode.applyEdit(
      writeParams({ expectedVersion: 1, expectedIncarnation: 'inc-c' }), { sessionId: 'sess-old' },
    )
    assert.equal(ok.applied, true)
    assert.equal(C.count('vscode.applyEdit'), 1)
  } finally {
    await kit.cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ ★ T35 H1 直接复现口：raw request（绕过糖衣）省略化身 → 本地 -32602、零发送
// ─────────────────────────────────────────────────────────────────────────────

test('★ T35 raw request 省略化身 → 本地 -32602、宿主零写入（绕过糖衣也一样）', async () => {
  const kit = await withKit()
  try {
    // 两端都公告化身支持：H1 的条件就是"大家看起来都支持"，只是有人省略了字段。
    const A = await windowClient(kit.server, {
      label: 'A', docVersion: A_VERSION, docIncarnation: A_INC,
      features: [PEER_FEATURE_DOCUMENT_INCARNATION],
    })
    kit.clients.push(A)
    await kit.svc.editing.grant({ sessionId: S1, windowId: await windowIdOf(kit.svc, 'A') })

    const body = {
      file: FILE,
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
      text: 'hello',
      expectedVersion: A_VERSION,
    }

    // ① 不经糖衣，直接 request —— 这正是终审用来复现 H1 的那条路。
    const err = await expectCode(
      kit.svc.request('vscode.applyEdit', { ...body }, { sessionId: S1 }),
      ERR.INVALID_PARAMS, 'raw request 缺化身')
    assert.equal(err.data.reason, 'expected-incarnation-missing')
    assert.equal(err.data.stage, 'local', '必须本地拒：发出去就只能靠期望对端配合')
    assert.equal(err.data.method, 'vscode.applyEdit')
    assert.equal(A.count('vscode.applyEdit'), 0, '宿主零写入（一个写帧都没发）')

    // ② 空串是同一族错误：空串会让"宿主读不到化身"与"调用方给了空串"匹配成功。
    const empty = await expectCode(
      kit.svc.request('vscode.applyEdit',
        { ...body, expectedIncarnation: '' }, { sessionId: S1 }),
      ERR.INVALID_PARAMS, 'raw request 空串化身')
    assert.equal(empty.data.reason, 'expected-incarnation-not-a-non-empty-string')
    assert.equal(A.count('vscode.applyEdit'), 0)

    // ③ 对照：带上两条锚点，同一个 raw 入口照常放行（门只拒"少判一半"的那种写）。
    const ok = await kit.svc.request('vscode.applyEdit',
      { ...body, expectedIncarnation: A_INC }, { sessionId: S1 })
    assert.equal(ok.applied, true)
    assert.equal(A.count('vscode.applyEdit'), 1)
    assert.equal(A.last('vscode.applyEdit').params.expectedIncarnation, A_INC)
  } finally {
    await kit.cleanup()
  }
})
