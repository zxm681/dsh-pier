/**
 * 会话授权绑定门（`-32010`）的 DSH 侧守门测试 —— 契约 §6.1 / §6.1.1。
 *
 * 这一组用例要守住的东西，按「改坏了会怎样」排序：
 *
 *  1. **判定序只有一份**（§6.1.1 ①-c）：`judgeGrant` 的七行顺序、两侧 reason 映射；
 *  2. **发送前门真的在发线路之前**（§6.1）：失败时对端**零业务帧**；
 *  3. **失效由连接生命周期驱动**（§6.1.1 ①-b(2)）：断开 / 覆盖 / 撤销各自落到
 *     正确的 `data.reason`，且判据是连接对象身份而不是任何计数器；
 *  4. **单一生成方**（§6.1.1 ①）：`id`/`epoch` 只在本端生成一次，扩展侧只存不算。
 *
 * 每个「门必须拦住」的用例都同时断言**对端收不到业务帧** —— 只断言错误码的测试
 * 挡不住「先发出去再把错误写回去」这种回归（那正是 ①-c 的跳过语义要防的）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, VscodeKit } from '../src/index.js'
import { ERR, ERR_NAME, PROTOCOL_VERSION, connect, createLineSplitter } from '../src/protocol.js'
import {
  GrantStore, GRANT_REASONS, GRANT_TOMBSTONE_LIMIT, WRITE_METHODS,
  isWriteMethod, checkGrantShape, judgeGrant, dshWriteGate, extensionWriteGate,
  editNotBoundError,
} from '../src/grant.js'

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


const HEX_32 = /^[0-9a-f]{32}$/

/**
 * 会话标识（评审 F2）。**只经调用方上下文传递**（`opts.sessionId`），
 * 绝不进业务 `params` —— 后者会被 `rejectParamsSessionId` 直接拒掉。
 */
const S1 = 'sess-alpha'
const S2 = 'sess-beta'

/** 某会话发放一条 grant（sessionId 走 opts，模拟消费者从自己的 DSH 上下文取）。 */
const grantAs = (svc, sessionId = S1, opts = {}) => svc.editing.grant({ sessionId, ...opts })

/**
 * 某条连接（按连接先后，0-based）的**真实** `windowId`。
 *
 * T64 起 `windowId` 不再是"随便贴的标签"：它必须能解析到**承载这条 grant 的连接**，
 * 解析不到或不一致就拒 `-32014 target-not-routable`（宿主零调用、零帧）。所以用例要给
 * 真实值 —— 去 `windows.list()` 取，别把 `tmp-1` 这种实现推导值抄进断言。
 */
async function windowIdAt(svc, index = 0) {
  const rows = await svc.vscode.windows.list()
  assert.ok(rows[index], `window #${index} must be listed by windows.list()`)
  return rows[index].windowId
}

/** 某会话发起一次写入（同样走 opts）。 */
const writeAs = (svc, params, sessionId = S1, opts = {}) =>
  svc.vscode.applyEdit(params, { sessionId, ...opts })

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-grant-'))
}

/** 最小 cordis ctx 模拟（effect 立刻执行 fn 并把返回值当 disposer）。 */
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

/** 契约 §5.1：`vscode.applyEdit` 的合法返回形状（response-contract.js 逐字对应）。 */
function applyEditResult({ applied = true, file = '/ws/a.js', saved = false, textLength = 5 } = {}) {
  return { applied, file, saved, textLength }
}

/**
 * 假编辑器：裸 TCP 连桥，**记录每一条收到的帧**（含通知），供「零业务帧」断言。
 */
async function fakeEditor(server, { onRequest } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const notifies = []
  const waiters = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: onRequest ?? ((method, params) => {
      // 评审 F9：grant 的回执是真回执 —— 扩展侧先存档，再回 `{ok:true, id}`。
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'bridge.ping') return { pong: true }
      throw new Error(`unexpected method ${method}`)
    }),
  })
  const feed = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    seen.push(msg)
    const isResponse = msg.id !== undefined && msg.method === undefined
    const isRequest = msg.id !== undefined && msg.method !== undefined
    if (isResponse || isRequest) { link.handleLine(line); return }
    // 有等待者就交出去，不再进队列 —— 否则同一条通知会被 next() 消费两次，
    // 后面那条断言就会拿到上一条帧（第一版就是栽在这里：grant 帧被 hello 顶掉）。
    const w = waiters.shift()
    if (w) w(msg)
    else notifies.push(msg)
  })
  socket.on('data', feed)
  // 评审 R2-2：发放失败时本端会**主动收口**（给那一个 id 发撤销，见 `_abortPendingGrant`）。
  // 评审 R3-2 之后收口**不再终止承载连接**，所以正常情况下这里不会 EPIPE；
  // 监听器保留：用例里若有别的原因让对端先断（cleanup / 连接被测行为），
  // 写入侧的 EPIPE 不该炸掉测试进程。
  socket.on('error', () => {})
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    link,
    socket,
    seen,
    notifies,
    /** 收到过多少条**业务**帧（按方法名数，通知与请求都算）。 */
    count(method) {
      return seen.filter((m) => m.method === method).length
    },
    /**
     * 等到某条**出站帧**出现（按方法名）。已收到的直接返回，否则轮询 —— TCP 投递是异步的，
     * 同步断言 notifies 会稳定地假红（第一版就这么错的）。
     */
    async waitFrame(method, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const hit = seen.filter((m) => m.method === method).at(-1)
        if (hit) return hit
        if (Date.now() > deadline) throw new Error(`waitFrame(${method}) timed out`)
        await new Promise((r) => setTimeout(r, 5))
      }
    },
    next(timeoutMs = 2000) {
      if (notifies.length) return Promise.resolve(notifies.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('next() timed out')), timeoutMs)
        waiters.push((m) => { clearTimeout(t); resolve(m) })
      })
    },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

/** 让假编辑器报身份（协议版本 + 能力清单）。 */
async function announce(editor, { ptv = PROTOCOL_VERSION, capabilities = ['vscode.applyEdit', 'vscode.getSelection'] } = {}) {
  const params = { client: 'fake-editor', extensionVersion: '0.1.0', capabilities }
  if (ptv !== undefined) params.protocolVersion = ptv
  return editor.link.request('bridge.hello', params)
}

/** 起一个 apply 实例 + 若干已报身份的假编辑器（editors 按连接先后排列）。 */
async function withKit(n = 1, { onRequest } = {}) {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)
  const server = handle.kit.server
  const editors = []
  for (let i = 0; i < n; i++) {
    const editor = await fakeEditor(server, {
      onRequest: onRequest ?? ((method, params) => {
        if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
        if (method === 'bridge.ping') return { pong: true }
        if (method === 'vscode.applyEdit') return applyEditResult()
        if (method === 'vscode.getSelection') {
          return {
            text: 'hi',
            file: '/ws/a.js',
            start: { line: 1, column: 1 },
            end: { line: 1, column: 3 },
            isEmpty: false,
          }
        }
        throw new Error(`unexpected method ${method}`)
      }),
    })
    await announce(editor)
    editors.push(editor)
  }
  const cleanup = async () => {
    for (const e of editors) if (!e.socket.destroyed) await e.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, server, handle, editors, cleanup }
}

/**
 * 一条形状合法的写入请求参数（不含 grant —— 由用例决定给不给）。
 *
 * T30 起还**必须**带版本锚点：本文件这些用例测的是"绑定门"这一层，所以给一个固定的
 * 版本号（`VERSION`），让请求能走到门那里；专门测版本锚点的用例在
 * `test/document-version.test.js` 里。
 */
const VERSION = 4

/**
 * 假的对端化身（T34 引入；★ T35 起 `expectedIncarnation` **无条件必填**）。
 * 本文件测的是**绑定门**那一层，锚点只是"让请求能走到门那里"的入场券。
 */
const INCARNATION = 'inc-kit-gate'

function writeParams(extra = {}) {
  return {
    file: '/ws/a.js',
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
    text: 'hello',
    expectedVersion: VERSION,
    expectedIncarnation: INCARNATION,
    ...extra,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 错误码只加不改
// ─────────────────────────────────────────────────────────────────────────────

test('协议：-32010 只加码，不改既有码语义（T62 之后整版在 v2）', () => {
  assert.equal(ERR.EDIT_NOT_BOUND, -32010)
  assert.equal(ERR_NAME[-32010], 'edit-not-bound')
  assert.equal(typeof ERR_NAME[-32010], 'string')
  // ★ T62：加码本身不改版本，但 A2 改的不止是码——脏缓冲的拒绝码从 -32012 换成了 -32011，
  //   处置也从「重读重发」变成「别重发」，所以整版升 v2。
  assert.equal(PROTOCOL_VERSION, 2, 'v2：-32011 与 -32012 的应对方式相反，不能不升版')
  // 既有码不动（这些数字一旦漂移，扩展侧与本侧的判定就全错位）
  assert.equal(ERR.PROTOCOL_INCOMPATIBLE, -32008)
  assert.equal(ERR.INVALID_RESPONSE, -32009)
  assert.equal(ERR.DISCONNECTED, -32007)
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) 单一判定函数：七行序 + 两侧 reason 映射（纯函数层，不起 socket）
// ─────────────────────────────────────────────────────────────────────────────

test('judgeGrant：七行判定序逐行命中（先命中先返回，不合并）', () => {
  const linkA = { id: 'conn-a' }
  const linkB = { id: 'conn-b' }
  const store = new GrantStore()
  const g = store.issue({ link: linkA, windowId: 'w1' })

  // 行 1：没带凭证（连形状都不对也走这行）
  assert.deepEqual(judgeGrant({ store, grant: undefined, link: linkA }).row, 1)
  assert.equal(judgeGrant({ store, grant: { id: 'nope' }, link: linkA }).reason,
    GRANT_REASONS.NO_GRANT)
  // 行 2：id 查不到
  const row2 = judgeGrant({ store, grant: { id: 'f'.repeat(32), epoch: g.epoch }, link: linkA })
  assert.equal(row2.row, 2)
  assert.equal(row2.reason, GRANT_REASONS.NO_GRANT)
  // 行 5：epoch 不等（等值判据，绝不排序）
  const row5 = judgeGrant({ store, grant: { id: g.id, epoch: '0'.repeat(32) }, link: linkA })
  assert.equal(row5.row, 5)
  assert.equal(row5.reason, GRANT_REASONS.GRANT_GENERATION_STALE)
  // 行 6：承载连接对象身份不等（D=别的窗口 → grant-mismatch；扩展侧 → stale）
  const row6dsh = judgeGrant({ store, grant: g, link: linkB, side: 'dsh' })
  assert.equal(row6dsh.row, 6)
  assert.equal(row6dsh.reason, GRANT_REASONS.GRANT_MISMATCH)
  assert.equal(judgeGrant({ store, grant: g, link: linkB, side: 'extension' }).reason,
    GRANT_REASONS.GRANT_GENERATION_STALE)
  // 行 7：全等放行
  assert.deepEqual(judgeGrant({ store, grant: g, link: linkA, side: 'dsh' }),
    { ok: true, row: 7, grant: { id: g.id, epoch: g.epoch } })

  // 行 3：墓碑 disconnected（D=target-gone；扩展侧=stale）
  store.closeLink(linkA)
  const row3dsh = judgeGrant({ store, grant: g, link: linkB, side: 'dsh' })
  assert.equal(row3dsh.row, 3)
  assert.equal(row3dsh.reason, GRANT_REASONS.TARGET_GONE)
  assert.equal(judgeGrant({ store, grant: g, link: linkB, side: 'extension' }).reason,
    GRANT_REASONS.GRANT_GENERATION_STALE)

  // 行 4：墓碑 superseded / revoked（两侧同词：grant-revoked）
  const g2 = store.issue({ link: linkB })
  store.issue({ link: linkB }) // 同连接再发一次 → 旧的 superseded
  const row4 = judgeGrant({ store, grant: g2, link: linkB })
  assert.equal(row4.row, 4)
  assert.equal(row4.reason, GRANT_REASONS.GRANT_REVOKED)
})

test('judgeGrant：墓碑永远不放行，且不参与放行判定（只有 reason 受影响）', () => {
  const store = new GrantStore()
  const link = { id: 'conn' }
  const g = store.issue({ link })
  store.revoke(g.id, 'revoked')
  const verdict = judgeGrant({ store, grant: g, link })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, GRANT_REASONS.GRANT_REVOKED)
})

test('GrantStore：墓碑上限 32，最老的被淘汰后按「id 查不到」→ no-grant 处理', () => {
  assert.equal(GRANT_TOMBSTONE_LIMIT, 32)
  const store = new GrantStore()
  const link = { id: 'conn' }
  const ids = []
  for (let i = 0; i < GRANT_TOMBSTONE_LIMIT + 1; i++) {
    const g = store.issue({ link })
    ids.push(g.id)
    store.revoke(g.id, 'revoked')
  }
  assert.equal(store.size, 0, '撤销后有效表必须为空')
  assert.equal(store.tombstoneSize, GRANT_TOMBSTONE_LIMIT, '墓碑只留最近 32 条')
  assert.equal(store.lookup(ids[0]), null, '最老的墓碑被淘汰')
  const evicted = judgeGrant({ store, grant: { id: ids[0], epoch: 'a'.repeat(32) }, link })
  assert.equal(evicted.row, 2)
  assert.equal(evicted.reason, GRANT_REASONS.NO_GRANT)
  // 最新的一条仍在墓碑里 → 说的是 grant-revoked，不是 no-grant（诊断价值就在这里）
  assert.equal(store.lookup(ids.at(-1)).kind, 'tombstone')
})

test('写入类清单：只有登记进 WRITE_METHODS 的方法过门（读操作不要求 grant）', () => {
  // ★ T39：`vscode.save` 是第二件写入类 —— 它接进门的唯一方式就是往这张表里加名字
  //   （契约 §6.2.6：「判据是一张表，不是一个开关」，门自己就会生效）。
  // ★ T40：`vscode.deleteFile` 是第三件，也是第一件**不可逆**的。它进这张表的后果要看清：
  //   绑定门 + `request()` 里"写入类必带 expectedIncarnation"（T35）两条同时继承，
  //   所以删除的双锚点是这张表**顺带**守住的，不是删除自己另加的规矩。
  // T65：`vscode.rebaseBaseline` 也在表里 —— 它能清掉「脏缓冲禁写」那把锁，必须与写同门。
  assert.deepEqual([...WRITE_METHODS],
    ['vscode.applyEdit', 'vscode.save', 'vscode.deleteFile', 'vscode.rebaseBaseline'])
  assert.equal(isWriteMethod('vscode.applyEdit'), true)
  assert.equal(isWriteMethod('vscode.save'), true)
  assert.equal(isWriteMethod('vscode.deleteFile'), true)
  assert.equal(isWriteMethod('vscode.getSelection'), false)
  assert.equal(isWriteMethod('vscode.getDocumentState'), false)
  assert.equal(isWriteMethod('bridge.ping'), false)
  // 门对非写入方法必须原样放过（不抛），否则读操作会被误伤
  const gate = dshWriteGate(new GrantStore())
  assert.doesNotThrow(() => gate('vscode.getSelection', {}, { id: 'x' }))
  assert.doesNotThrow(() => extensionWriteGate(new GrantStore())('vscode.listOpenEditors', {}, {}))
})

test('checkGrantShape：只认 128-bit hex（id/epoch 同形），其它一律拒', () => {
  assert.equal(checkGrantShape({ id: 'a'.repeat(32), epoch: 'b'.repeat(32) }).ok, true)
  assert.equal(checkGrantShape({ id: 'A'.repeat(32), epoch: 'b'.repeat(32) }).ok, false)
  assert.equal(checkGrantShape({ id: 'a'.repeat(31), epoch: 'b'.repeat(32) }).ok, false)
  assert.equal(checkGrantShape({ id: 'a'.repeat(32) }).ok, false)
  assert.equal(checkGrantShape(null).ok, false)
  assert.equal(checkGrantShape('x').ok, false)
})

test('editNotBoundError：code 恒为 -32010，data 带 reason/method', () => {
  const err = editNotBoundError('vscode.applyEdit', GRANT_REASONS.NO_GRANT, 1)
  assert.equal(err.code, ERR.EDIT_NOT_BOUND)
  assert.equal(err.data.reason, 'no-grant')
  assert.equal(err.data.method, 'vscode.applyEdit')
  assert.equal(err.data.row, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) 发放：只在有「已准入且协议兼容」的目标时发放，无目标就抛，不排队不缓存
// ─────────────────────────────────────────────────────────────────────────────

test('grant：没有目标连接 → -32007 且不缓存（再调还是抛，表里始终为空）', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 0, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        async () => svc.editing.grant(),
        (e) => e.code === ERR.DISCONNECTED && e.data.reason === 'no-editor',
        `第 ${i + 1} 次：无目标必须抛 -32007，而不是排队等一个不知何时会来的连接`,
      )
    }
    assert.equal(handle.kit.grants.size, 0, '不排队的含义：没有任何 grant 被暂存')
    assert.deepEqual(svc.editing.list(), [])
  } finally {
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('grant：目标已准入但没报协议版本 → -32008，且不发任何 grant 帧', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)
  const editor = await fakeEditor(handle.kit.server)
  try {
    // 报身份但**不报** protocolVersion：这是「准入 ≠ 可授权」的最小反例。
    // （准入要求先有带 token 的报文；所以「压根没说过话」的连接连准入都没有，
    //   那种情况走的是上面的 -32007，不是这一条。）
    // 注意别写 `announce(editor,{ptv:undefined})` —— 解构默认值会把 undefined 顶回 1，
    // 于是这条用例会静默退化成「一切正常」（第一版就这么假绿过）。
    await editor.link.request('bridge.hello', {
      client: 'fake-editor', extensionVersion: '0.1.0', capabilities: ['vscode.applyEdit'],
    })
    assert.equal(handle.kit._activeLink().editor.protocolVersionPresent, false,
      '构造前提：这条连接确实没报版本')
    await assert.rejects(
      async () => svc.editing.grant({ sessionId: S1 }),
      (e) => e.code === ERR.PROTOCOL_INCOMPATIBLE,
      '未知版本 = 不兼容（不得推断成 v1）：bridge.grant 发的是写权限凭证，必须强制过版本门',
    )
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(editor.count('bridge.grant'), 0, '版本门之后才轮到发放，一个 grant 帧都不许出门')
    assert.equal(handle.kit.grants.size, 0)
  } finally {
    await editor.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('grant：发放生成 32 hex 的 id/epoch，并以 bridge.grant 显式带 token 送达', async () => {
  const { svc, server, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const before = editor.count('bridge.grant')
    // T64: windowId 必须是这条连接的真实身份（挑错窗口会被拒），所以从注册表取。
    const wid = await windowIdAt(svc, 0)
    const grant = await grantAs(svc, S1, { windowId: wid })
    assert.match(grant.id, HEX_32, 'id 必须是 randomBytes(16) 的 32 hex')
    assert.match(grant.epoch, HEX_32, 'epoch 必须与 id 同批生成，形状一致')
    assert.equal(grant.delivered, true)

    const frame = await editor.waitFrame('bridge.grant')
    assert.equal(editor.count('bridge.grant'), before + 1)
    // ★ 契约 §6.1.1 ①-b + 铁律 8：凭证只在显式要求时带，这条通知**必须**显式带 token
    assert.equal(frame.token, server.token, 'bridge.grant 必须走 {withToken:true}')
    assert.deepEqual(frame.params.grant, {
      // 评审 F2 起 grant 必须有会话：发放时就没有会话的凭证永远不能授权写入
      id: grant.id, epoch: grant.epoch, sessionId: S1, windowId: wid,
    })

    assert.equal(handle.kit.grants.size, 1)
    const listed = svc.editing.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, grant.id)
    assert.equal(listed[0].active, true)
  } finally {
    await cleanup()
  }
})

test('grant：同连接再发一次 → 旧的立刻 superseded（每窗口最多 1 个有效 grant）', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const first = await grantAs(svc)
    const second = await grantAs(svc)
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.epoch, second.epoch)
    assert.equal(handle.kit.grants.size, 1, '有效 grant 只能有一条')
    assert.equal(handle.kit.grants.lookup(first.id).kind, 'tombstone')
    assert.equal(handle.kit.grants.lookup(first.id).record.cause, 'superseded')

    // 旧 grant 的写入请求：被覆盖 → grant-revoked，且编辑器收不到业务帧
    const before = editor.count('vscode.applyEdit')
    await assert.rejects(
      async () => svc.request('vscode.applyEdit', writeParams({ grant: first })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'grant-revoked',
    )
    assert.equal(editor.count('vscode.applyEdit'), before, '门拦下的请求一个字节都不许出门')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4) 发送前门：失败时零业务帧；成功时 grant 原样随请求下发
// ─────────────────────────────────────────────────────────────────────────────

test('发送前门：没有 grant 的写入 → -32010 no-grant，对端零业务帧', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const before = editor.seen.length
    await assert.rejects(
      async () => svc.request('vscode.applyEdit', writeParams()),
      (e) => {
        assert.equal(e.code, ERR.EDIT_NOT_BOUND)
        assert.equal(e.data.reason, 'no-grant')
        assert.equal(e.data.method, 'vscode.applyEdit')
        return true
      },
    )
    // 「一个业务字节都不发」的严格口径：整条连接上新增帧数必须是 0
    // （不是"没有 vscode.applyEdit" —— 先发业务帧再补错误帧也是一种泄放）。
    assert.equal(editor.seen.length, before, '门在发线路之前，帧数不许增加')
    assert.equal(editor.count('vscode.applyEdit'), 0)
  } finally {
    await cleanup()
  }
})

test('发送前门：糖衣 kit.vscode.applyEdit 走同一道门（绕过糖衣走 raw request 也一样）', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    for (const call of [
      () => svc.vscode.applyEdit(writeParams()),
      () => svc.vscode.applyEdit(writeParams({ grant: { id: 'f'.repeat(32), epoch: 'e'.repeat(32) } })),
    ]) {
      await assert.rejects(call, (e) => e.code === ERR.EDIT_NOT_BOUND)
    }
    assert.equal(editor.count('vscode.applyEdit'), 0)
  } finally {
    await cleanup()
  }
})

test('门只看写入类：无 grant 时读操作照常（读不要求授权）', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const sel = await svc.vscode.getSelection()
    assert.equal(sel.text, 'hi')
    assert.equal(editor.count('vscode.getSelection'), 1)
  } finally {
    await cleanup()
  }
})

test('放行：grant 与目标连接一致时请求出门，params.grant 原样带给扩展', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc)
    const result = await writeAs(svc, writeParams({ grant: { id: grant.id, epoch: grant.epoch } }))
    assert.deepEqual(result, applyEditResult())
    const frame = editor.seen.filter((m) => m.method === 'vscode.applyEdit').at(-1)
    assert.deepEqual(frame.params.grant, { id: grant.id, epoch: grant.epoch })
    // 写请求就是普通 RPC：`request()` 按协议 §3.3 **自动**附连接凭据（这是既有行为，
    // 与 `notify`/`respond`「默认不带、要显式 withToken」是两套规则，别混）。
    // 这里要守住的是另一件事：grant 只带 id/epoch 两个字段，不许把 sessionId/windowId
    // 这类内部字段顺手下发给扩展当判据（§6.1.1 ① 禁止两端各自算）。
    assert.deepEqual(Object.keys(frame.params.grant).sort(), ['epoch', 'id'])
    assert.ok(!('sessionId' in frame.params.grant))
  } finally {
    await cleanup()
  }
})

test('放行后响应形状不合格（saved:true）→ -32009，不冒充成功', async () => {
  const { svc, editors, cleanup } = await withKit(1, {
    onRequest: (method, params) => {
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'vscode.applyEdit') return applyEditResult({ saved: true })
      throw new Error(`unexpected method ${method}`)
    },
  })
  try {
    const grant = await grantAs(svc)
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant })),
      (e) => e.code === ERR.INVALID_RESPONSE && e.data.method === 'vscode.applyEdit',
      'saved 是业务承诺（T3 绝不落盘），不是普通布尔字段',
    )
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 5) 失效：撤销 / 断开 / 目标换成另一条连接（三种 reason 各就各位）
// ─────────────────────────────────────────────────────────────────────────────

test('撤销：本地先失效（权威），并尽力用带 token 的 bridge.grantRevoke 通知对端', async () => {
  const { svc, server, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc)
    await editor.waitFrame('bridge.grant') // 先把发放通知消费掉，别让它冒充撤销帧
    const res = svc.editing.revoke(grant.id)
    assert.deepEqual(res, { revoked: [grant.id], count: 1 })
    assert.equal(handle.kit.grants.size, 0)

    const frame = await editor.waitFrame('bridge.grantRevoke')
    assert.ok(frame, '撤销要尽力通知对端（对端才知道自己手里的凭证作废了）')
    assert.equal(frame.token, server.token, '撤销通知同样显式带 token')
    assert.equal(frame.params.id, grant.id)

    const before = editor.count('vscode.applyEdit')
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'grant-revoked',
    )
    assert.equal(editor.count('vscode.applyEdit'), before, '撤销后的请求零出门')

    // 幂等：再撤一次不抛、不重复通知
    assert.deepEqual(svc.editing.revoke(grant.id), { revoked: [], count: 0 })
  } finally {
    await cleanup()
  }
})

test('断开：承载连接消失 → grant 失效，另一个窗口成为目标后写入报 target-gone', async () => {
  const { svc, handle, editors, cleanup } = await withKit(2)
  const [editorA, editorB] = editors
  try {
    // 目标 = 后连接的 B，grant 发给 B
    const grant = await grantAs(svc)
    assert.equal(handle.kit.grants.forLink(handle.kit._activeLink()).length, 1)

    await editorB.close()
    // 等协议层把 close 事件处理完（连接生命周期驱动，不是定时器驱动的失效）
    for (let i = 0; i < 200 && handle.kit.grants.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(handle.kit.grants.size, 0, '连接一断，挂在上面的 grant 立刻失效（本地完成）')
    assert.equal(handle.kit.grants.lookup(grant.id).record.cause, 'disconnected')

    // 目标回落到 A：这条连接从来没拿到过 grant
    const beforeA = editorA.count('vscode.applyEdit')
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'target-gone',
      'DSH 视角：我本来要发的那条连接没了',
    )
    assert.equal(editorA.count('vscode.applyEdit'), beforeA, '绝不改投另一条连接重发（③ 失败闭合）')
  } finally {
    await cleanup()
  }
})

test('★ F3 写目标按 grant 记录路由：B 后连也不许改投，A 消失只失败不回落', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1)
  const [editorA] = editors
  const server = handle.kit.server
  try {
    // A 是唯一连接 → grant 绑 A
    const grant = await grantAs(svc)
    const linkA = handle.kit._activeLink()
    assert.equal(handle.kit.grants.lookup(grant.id).record.link, linkA)

    // B 后连上 → `_activeLink()` 变成 B（读路径的目标确实换了）
    const editorB = await fakeEditor(server, {
      onRequest: (method, params) => {
        if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
        if (method === 'vscode.applyEdit') return applyEditResult()
        throw new Error(`unexpected method ${method}`)
      },
    })
    await editorB.next()
    await announce(editorB)
    assert.notEqual(handle.kit._activeLink(), linkA, '新连接按连接先后成为目标')

    // ★ 评审 F3 的核心：A 手里的合法写请求**仍然写给 A**。
    //   旧预期是"目标漂移 → grant-mismatch"，那等于让 B 的出现把 A 的授权作废 ——
    //   而契约 §6.1.1 明令写目标是保存的 `grant.link`，不是"当前活跃窗口"。
    const beforeA = editorA.count('vscode.applyEdit')
    const beforeB = editorB.count('vscode.applyEdit')
    const ok = await writeAs(svc, writeParams({ grant }))
    assert.equal(ok.applied, true, 'A 的有效 grant 在 B 出现后依然可写')
    assert.equal(editorA.count('vscode.applyEdit'), beforeA + 1, '落点是 A —— 授权那一端')
    assert.equal(editorB.count('vscode.applyEdit'), beforeB, '绝不改投没绑定过的 B（也不许广播）')

    // A 消失：只失败（target-gone），**不许**回落到 B
    await editorA.close()
    for (let i = 0; i < 200 && handle.kit.grants.size > 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const beforeB2 = editorB.count('vscode.applyEdit')
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'target-gone',
      '承载连接没了 → 只失败，不把这条凭证改用到另一条连接上',
    )
    assert.equal(editorB.count('vscode.applyEdit'), beforeB2, '回落就是越权：B 一个字节都不许收到')

    // B 自己拿到 grant 后即可正常写（"去那个窗口申请"的最小闭环）
    const grantB = await grantAs(svc, S1)
    const okB = await writeAs(svc, writeParams({ grant: grantB }))
    assert.equal(okB.applied, true)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.5) 会话一致性（评审 F2）：身份只从调用方上下文来，绝不从 params 自证
// ─────────────────────────────────────────────────────────────────────────────

test('★ F2 越权：会话 S1 的 grant，会话 S2 拿来写 → -32010（grant-mismatch，零业务帧）', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc, S1)
    const before = editor.count('vscode.applyEdit')
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant }), S2),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'grant-mismatch',
      '连接身份相同、凭证也有效，但不是发放它的那个会话 → 拒绝',
    )
    assert.equal(editor.count('vscode.applyEdit'), before, '拒绝发生在写线路之前')

    // 同一个 grant 回到 S1 手里就正常：差别只有会话身份，证明判的确实是它
    const ok = await writeAs(svc, writeParams({ grant }), S1)
    assert.equal(ok.applied, true)
  } finally {
    await cleanup()
  }
})

test('★ F2 缺会话：凭证有效但调用方不给会话身份 → -32010（不许默认放行）', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc, S1)
    const before = editor.count('vscode.applyEdit')
    // 不带 opts.sessionId（消费方上下文缺失）：run level 下降，不得退化成"没人比对就放行"
    await assert.rejects(
      async () => svc.vscode.applyEdit(writeParams({ grant })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'grant-mismatch',
    )
    assert.equal(editor.count('vscode.applyEdit'), before)
    assert.equal(handle.kit.grants.size, 1, '拒绝不消耗凭证：补上会话身份后还能用')
    const ok = await writeAs(svc, writeParams({ grant }), S1)
    assert.equal(ok.applied, true)
  } finally {
    await cleanup()
  }
})

test('★ F2 params 里出现 sessionId → -32602（会话身份不许由线路数据自证）', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc, S1)
    const before = editor.count('vscode.applyEdit')
    await assert.rejects(
      async () => svc.vscode.applyEdit(writeParams({ grant, sessionId: S1 })),
      (e) => e.code === ERR.INVALID_PARAMS && e.data.field === 'sessionId',
      '允许它存在就等于告诉调用方"它起作用"，而判定绝不能读它',
    )
    assert.equal(editor.count('vscode.applyEdit'), before)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.6) 多因同时命中（评审 F4）：先命中先返回，不合并、可预期
// ─────────────────────────────────────────────────────────────────────────────

test('★ F4 多因优先：墓碑 + epoch 错 + 连接错 → 墓碑那行先说话', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc)
    const otherLink = { id: 'not-this-conn' }
    svc.editing.revoke(grant.id) // 行 4 的因（同时 epoch 与连接也都是"错"的）
    assert.equal(handle.kit.grants.lookup(grant.id).record.cause, 'revoked')
    for (const g of [
      { id: grant.id, epoch: '0'.repeat(32) }, // epoch 也错
      grant, // 原样（连接也不同）
    ]) {
      await assert.rejects(
        async () => writeAs(svc, writeParams({ grant: g })),
        (e) => e.data.reason === 'grant-revoked' && e.data.row === 4,
        '墓碑优先于 epoch / 连接：多因同时命中时不许改口',
      )
    }
    assert.equal(editor.count('vscode.applyEdit'), 0)
    assert.ok(otherLink)
  } finally {
    await cleanup()
  }
})

test('★ F4 多因优先：id 查不到 + epoch 错 → 行 2（no-grant）而不是行 5', async () => {
  const store = new GrantStore()
  const link = { id: 'conn-x' }
  store.issue({ link, sessionId: S1 })
  // 两种"错 epoch"都试：等值不符（0×32）与**类型不符**（'zzz'）。
  // 契约 ①-c 把 epoch 的两类问题都放在第 5 行，所以它们都不许抢到第 2 行前面。
  for (const epoch of ['0'.repeat(32), 'zzz']) {
    for (const side of ['dsh', 'extension']) {
      const v = judgeGrant({ store, grant: { id: 'a'.repeat(32), epoch }, link, side })
      assert.equal(v.row, 2, `${side}/${epoch}: id 查不到就该在第 2 行收口`)
      assert.equal(v.reason, GRANT_REASONS.NO_GRANT)
    }
  }
})

test('★ F4 多因优先：epoch 错 + 连接错 → 行 5（epoch 先于连接）', async () => {
  const store = new GrantStore()
  const linkA = { id: 'conn-a' }
  const linkB = { id: 'conn-b' }
  const g = store.issue({ link: linkA, sessionId: S1 })
  const v = judgeGrant({ store, grant: { id: g.id, epoch: '0'.repeat(32) }, link: linkB, side: 'dsh' })
  assert.equal(v.row, 5)
  assert.equal(v.reason, GRANT_REASONS.GRANT_GENERATION_STALE)
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.7) 写入类不许走无回执通道（评审 F5）
// ─────────────────────────────────────────────────────────────────────────────

test('★ F5 notify 不许发写入类：入口即拒，且对端零业务帧（FIFO 栅栏判定）', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc)
    const before = editor.seen.length
    assert.throws(
      () => handle.kit.notify('vscode.applyEdit', writeParams({ grant })),
      (e) => e.code === ERR.INVALID_REQUEST && e.data.reason === 'write-requires-request',
      '通知没有回执：既过不了会话门，也证明不了落点前复核',
    )
    // FIFO 栅栏：用同一条流上的 bridge.ping 收口，收到 pong 就说明"该到的都到了"，
    // 不需要 sleep 去赌 TCP 的时序。
    const pong = await handle.kit.request('bridge.ping', {})
    assert.ok(pong, '栅栏请求必须成功')
    assert.equal(editor.count('vscode.applyEdit'), 0, '零业务帧：不是"发了再补错"')
    assert.equal(editor.seen.length, before + 1, '整条流上只多了栅栏那一帧')
  } finally {
    await cleanup()
  }
})

test('★ F5 broadcast 不许发写入类：入口即拒，且对端零业务帧（FIFO 栅栏判定）', async () => {
  const { handle, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const before = editor.seen.length
    assert.throws(
      () => handle.kit.server.broadcast('vscode.applyEdit', writeParams()),
      (e) => e.code === ERR.INVALID_REQUEST && e.data.entry === 'broadcast',
      '广播是无回执的"发出去就算"，写入类走它就等于绕过整张判定表',
    )
    const pong = await handle.kit.request('bridge.ping', {})
    assert.ok(pong)
    assert.equal(editor.count('vscode.applyEdit'), 0)
    assert.equal(editor.seen.length, before + 1, '整条流上只多了栅栏那一帧')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4.8) grant 投递回执（评审 F9）：拿到扩展侧回执才算生效
// ─────────────────────────────────────────────────────────────────────────────

test('★ F9 没回执 = 没生效：扩展侧不回 {ok:true,id} → grant() 抛错且本地记录被撤销', async () => {
  const { svc, handle, editors, cleanup } = await withKit(1, {
    onRequest: (method) => {
      if (method === 'bridge.grant') return { ok: false } // 存档失败 / 形状不对
      throw new Error(`unexpected method ${method}`)
    },
  })
  const [editor] = editors
  try {
    await assert.rejects(
      async () => grantAs(svc),
      (e) => e.code === ERR.INTERNAL && e.data.reason === 'no-ack',
      '没有回执就没有"扩展已存档"的证据，不许报成功',
    )
    assert.equal(handle.kit.grants.size, 0, '送不出去的凭证必须就地撤销，不留一条本地放行')
    assert.equal(svc.editing.list().filter((g) => g.active).length, 0, '诊断视图里也没有有效项')
    // 撤销留墓碑（诊断价值）：以后再拿它来写，说的是 revoked 而不是 no-grant
    assert.equal(handle.kit.grants.lookup(handle.kit.grants.entries()[0]?.id ?? 'x')?.record?.cause,
      'revoked')
    // 直方图证据：确实发出去过一帧（不是"根本没发就报错"）
    assert.equal(editor.count('bridge.grant'), 1, '走的是 request 投递，不是凭空失败')
  } finally {
    await cleanup()
  }
})

test('★ F9 回执带上 ack 形状：delivered 不再自称"发出即成功"', async () => {
  const { svc, cleanup } = await withKit(1)
  try {
    const grant = await grantAs(svc, S1, { windowId: await windowIdAt(svc, 0) })
    assert.equal(grant.delivered, true)
    assert.deepEqual(grant.ack, { ok: true, id: grant.id },
      'delivered 的语义是"扩展侧已存档并回执"，所以 ack 必须随结果一起给出')
  } finally {
    await cleanup()
  }
})

test('epoch 不一致（连接没换，同一 id 换了 epoch）→ grant-generation-stale', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const grant = await grantAs(svc)
    const before = editor.count('vscode.applyEdit')
    await assert.rejects(
      async () => svc.vscode.applyEdit(writeParams({ grant: { id: grant.id, epoch: '0'.repeat(32) } })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'grant-generation-stale',
    )
    assert.equal(editor.count('vscode.applyEdit'), before)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 6) 未就绪的失败形态：不许裸 TypeError（铁律 2）
// ─────────────────────────────────────────────────────────────────────────────

test('未就绪：facade.editing.grant/revoke 抛 -32007 server-not-ready，list 返回空表', () => {
  const ctx = fakeCtx()
  apply(ctx, { consumers: TEST_CONSUMERS, dshHome: join(tmpdir(), 'never-listening'), enabled: false, onLog: () => {} })
  const svc = boundSvc(ctx)
  assert.throws(() => svc.editing.grant(), (e) => e.code === ERR.DISCONNECTED
    && e.data.reason === 'server-not-ready')
  assert.throws(() => svc.editing.revoke('x'), (e) => e.code === ERR.DISCONNECTED)
  assert.deepEqual(svc.editing.list(), [])
  assert.equal(typeof svc.vscode.applyEdit, 'function', '糖衣必须稳定存在（铁律 2）')
})

// ─────────────────────────────────────────────────────────────────────────────
// 7) 判定共用：同一份实现，两侧只是视角不同
// ─────────────────────────────────────────────────────────────────────────────

test('两侧共用同一个判定：同一状态机下 DSH 与扩展的 reason 只有措辞差异', () => {
  const link = { id: 'conn' }
  const other = { id: 'conn-2' }
  const store = new GrantStore()
  const g = store.issue({ link })

  const cases = [
    { label: '正常', grant: g, target: link, dsh: null, ext: null },
    { label: '没带', grant: undefined, target: link, dsh: 'no-grant', ext: 'no-grant' },
    { label: '换连接', grant: g, target: other, dsh: 'grant-mismatch', ext: 'grant-generation-stale' },
  ]
  for (const c of cases) {
    const d = judgeGrant({ store, grant: c.grant, link: c.target, side: 'dsh' })
    const e = judgeGrant({ store, grant: c.grant, link: c.target, side: 'extension' })
    assert.equal(d.ok, e.ok, `${c.label}: 放行结论两侧必须一致（顺序同源）`)
    assert.equal(d.row, e.row, `${c.label}: 命中的行必须一致`)
    if (c.dsh) assert.equal(d.reason, c.dsh, `${c.label}: DSH 侧措辞`)
    if (c.ext) assert.equal(e.reason, c.ext, `${c.label}: 扩展侧措辞`)
  }
})

/** VscodeKit 的形状守卫：snapshot 用的是同一份 grants 表（别另算一份）。 */
test('VscodeKit 形状：editing 三件套存在且是函数、grants 是同一个 GrantStore', () => {
  const server = { links: new Set(), trusted: new Set() }
  const kit = new VscodeKit({ server, dshVersion: 'test', connectWaitMs: 0 })
  assert.equal(typeof kit.editing.grant, 'function')
  assert.equal(typeof kit.editing.revoke, 'function')
  assert.equal(typeof kit.editing.list, 'function')
  assert.equal(typeof kit.vscode.applyEdit, 'function')
  assert.ok(kit.grants instanceof GrantStore)
  assert.equal(kit.editing.list().length, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 9) 回执之前不是权限（评审 R2-2）+ 七行表不许猜（评审 R2-4）
// ─────────────────────────────────────────────────────────────────────────────

/** 轮询等待：TCP 投递与 Promise 链都是异步的，同步断言会稳定地假红。 */
async function waitUntil(fn, what, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return
    if (Date.now() > deadline) throw new Error(`waitUntil(${what}) timed out`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('★ R2-2 ① pending 不在任何放行视图里（lookup / active() / 诊断 active 位）', () => {
  const store = new GrantStore()
  const link = { id: 'conn-1', socket: { remotePort: 1234 } }
  const pending = store.stage({ link, sessionId: S1 })
  try {
    assert.equal(store.pendingSize, 1)
    assert.equal(store.size, 0, 'pending 不许进有效表')
    assert.equal(store.lookup(pending.id), null, 'lookup 是全仓唯一放行查询入口 → 必须看不见 pending')
    assert.equal(store.active().length, 0, '按会话找凭证的入口也看不见 pending')
    // 诊断视图里要能看见它，否则"卡在等回执"就是不可观测状态；但 `active` 恒 false
    const view = store.entries().find((e) => e.id === pending.id)
    assert.ok(view, 'pending 必须在诊断视图里可见（排障需要它）')
    assert.equal(view.active, false, '诊断视图里 active 恒为 false')
    assert.equal(view.pending, true)
    assert.equal(view.cause, null, 'pending 还没有 cause —— 不许提前写一个')
    // 收口路径仍要能从 pending 找到承载连接（失败时要撤销/终止它），但这条查询不进放行路径
    assert.equal(store.pendingCarrier(pending.id), link, '失败收口需要找到承载连接')
    // 七行表：pending 的 id 即便被猜到，也落在第 2 行（与"查不到"同一行）
    assert.equal(judgeGrant({ store, grant: pending, link }).row, 2)
  } finally {
    store.discardPending(pending.id, 'revoked')
  }
  assert.equal(store.pendingSize, 0, 'discardPending 必须真的清掉')
  assert.equal(store.lookup(pending.id)?.record.cause, 'revoked', '收口后进墓碑，理由可解释')
})

test('★ R2-2 回执挂起期间：pending 不是权限（并发写 -32010、零业务帧、超时后仍不可写）', async () => {
  let releaseAck = () => {}
  const ackGate = new Promise((resolve) => { releaseAck = resolve })
  const { svc, handle, editors, cleanup } = await withKit(1, {
    onRequest: async (method, params) => {
      if (method === 'bridge.grant') {
        // 扩展侧「收到了，但还没存档完」：回执挂在这里。
        // 本端此刻**无从知道**对端到底存没存 —— 所以这条凭证一秒都不许当权限用。
        await ackGate
        return { ok: true, id: params?.grant?.id }
      }
      if (method === 'vscode.applyEdit') return applyEditResult()
      return undefined // hello / grantRevoke 之类的通知：不需要应答
    },
  })
  const [editor] = editors
  try {
    const granting = grantAs(svc, S1, { timeoutMs: 150 })
    // 提前挂一个空 catch：这条 promise 要到 ④ 才被断言，
    // 若在这之前测试已经失败，它的拒绝就会变成 unhandledRejection 把真正的断言错误盖掉。
    granting.catch(() => {})
    await waitUntil(() => handle.kit.grants.pendingSize === 1, '发放进入 pending')
    const pendingEntry = handle.kit.grants.entries().find((g) => g.pending)
    assert.ok(pendingEntry, 'pending 在诊断视图里可见（排障需要它）')

    // 视图层不变量放在上一条用例里断言（`lookup`/`active()` 看不见 pending）；
    // 这一条只问运行时行为：**回执没回来时，写能不能到达宿主**。
    assert.equal(handle.kit.grants.size, 0, 'pending 不许进有效表')

    // ② 同会话并发写：一个业务字节都不许发出去
    await assert.rejects(
      async () => writeAs(svc, writeParams()),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'no-grant',
      '回执没回来 = 对端还不知道这条凭证 → 必须拒',
    )
    // ③ 就算调用方从旁路拿到了 pending 的 id+epoch，也不是通行证
    await assert.rejects(
      async () => writeAs(svc, writeParams({ grant: { id: pendingEntry.id, epoch: pendingEntry.epoch } })),
      (e) => e.code === ERR.EDIT_NOT_BOUND && e.data.reason === 'no-grant' && e.data.row === 2,
      'pending 的 id 落第 2 行（lookup 不认它）',
    )
    assert.equal(editor.count('vscode.applyEdit'), 0, 'host 零调用：不是"先发出去再把错误写回去"')

    // ④ 超时收口：pending 清空、**承载连接保留**、之后仍然不可写
    //    （评审 R3-2：收口只作废这一个 id，不踢连接 —— 踢连接会误伤同连接上的别的授权，
    //      而且小超时可反复触发，等于断连 DoS）
    await assert.rejects(async () => granting, (e) => e.code === ERR.TIMEOUT, '等不到回执就超时')
    assert.equal(handle.kit.grants.pendingSize, 0, '超时后不许留一条挂着的 pending')
    assert.equal(handle.kit.grants.size, 0)
    assert.equal(handle.kit.grants.active().length, 0)
    await assert.rejects(
      async () => writeAs(svc, writeParams()),
      (e) => e.code === ERR.EDIT_NOT_BOUND,
      '超时之后依然不可写',
    )
    assert.equal(editor.count('vscode.applyEdit'), 0, '全程零写入帧')
  } finally {
    releaseAck()
    await cleanup()
  }
})

test('★ R2-4 ① 已带 grant 对象但 id 不成形/查不到 → 归第 2 行（不是第 1 行）', () => {
  const store = new GrantStore()
  const link = { id: 'conn-1' }
  const g = store.issue({ link, sessionId: S1 })

  // 对照：**连对象都没带**才是第 1 行
  for (const grant of [undefined, null, 'x', 42, []]) {
    for (const side of ['dsh', 'extension']) {
      const v = judgeGrant({ store, grant, link, side })
      assert.equal(v.ok, false)
      assert.equal(v.row, 1, `${side}/${String(grant)}: 形状不是对象 → 第 1 行`)
    }
  }

  // 主体：交出了一个 grant 对象、只是 id 不成形或查不到 —— 那是「查不到」，归第 2 行
  const malformed = [
    ['非 hex', { id: 'nope', epoch: g.epoch }],
    ['长度不对', { id: 'f'.repeat(31), epoch: g.epoch }],
    ['大写 hex', { id: 'F'.repeat(32), epoch: g.epoch }],
    ['类型不对', { id: 123, epoch: g.epoch }],
    ['缺 id', { id: undefined, epoch: g.epoch }],
    ['连 epoch 也没带', { id: 'nope' }],
    ['形状合法但本端没发过', { id: 'c'.repeat(32), epoch: g.epoch }],
  ]
  for (const [label, grant] of malformed) {
    for (const side of ['dsh', 'extension']) {
      const v = judgeGrant({ store, grant, link, side })
      assert.equal(v.ok, false, `${label}: 不许放行`)
      assert.equal(v.row, 2, `${label}/${side}: 带了 grant 对象 → 落第 2 行`)
      assert.equal(v.reason, GRANT_REASONS.NO_GRANT, `${label}/${side}: 措辞与第 2 行一致`)
    }
  }
})

test('★ R2-4 ② 未知 cause：写入边界就地拒、判定侧失败闭合，不许伪装成第 4 行', () => {
  // ① 状态写入边界：只接受契约集合里的 cause，且被拒时**状态不变**
  const store = new GrantStore()
  const link = { id: 'conn-1' }
  const g = store.issue({ link, sessionId: S1 })
  for (const bad of ['expired', 'DISCONNECTED', '', 'revoke', null, 42]) {
    assert.throws(
      () => store.revoke(g.id, bad),
      (e) => e.code === ERR.INTERNAL && e.data.reason === 'unknown-grant-cause',
      `revoke(cause=${String(bad)}) 必须就地抛（不许写一个表上表达不了的状态）`,
    )
    assert.equal(store.lookup(g.id)?.kind, 'active', `${String(bad)}: 被拒时凭证状态不许变`)
  }
  // 契约集合里的三个照常接受
  for (const okCause of ['revoked', 'superseded', 'disconnected']) {
    const one = store.issue({ link: { id: `conn-${okCause}` }, sessionId: S1 })
    assert.doesNotThrow(() => store.revoke(one.id, okCause), `${okCause}: 契约集合内必须接受`)
  }

  // ② 判定侧：墓碑里出现表上没有的 cause（旧数据 / 别的版本写进来的）→ 失败闭合，不猜
  const store2 = new GrantStore()
  const dead = store2.issue({ link, sessionId: S1 })
  store2.revoke(dead.id, 'revoked')
  store2._tombstones.get(dead.id).cause = 'expired' // 白盒注入：模拟不可表达的历史状态
  for (const side of ['dsh', 'extension']) {
    assert.throws(
      () => judgeGrant({ store: store2, grant: dead, link, side }),
      (e) => e.code === ERR.INTERNAL
        && e.data.reason === 'unknown-grant-cause'
        && e.data.cause === 'expired',
      `${side}: 表上表达不了的 cause 必须抛，不许落第 4 行说"已撤销"`,
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 10) 失败收口的爆炸半径（评审 R3-2）
//
// 第一版收口是"撤销 + 终止承载连接 + destroy socket"。评审实测两个后果：
//   `NEW_GRANT_COLLATERAL {socketDestroyed:true, active:0, newGrantState:'tombstone',
//    cause:'disconnected'}` —— 旧 pending 的失败把同连接上一条**健康的新授权**一起带走了；
//   `SMALL_DEADLINE_DOS` —— 小超时能被反复触发，一次失败就断一次连接。
// 下面两条守的就是"一条失败只影响它自己那一条 id，连接不许动"。
// ─────────────────────────────────────────────────────────────────────────────

test('★ R3-2 ① 旧 pending 被新 grant 取代后失败 → 不伤新 active grant、连接仍然存活', async () => {
  // 第一条 grant 的回执永远挂住（评审的"对端活着但不回执"），第二条正常回执。
  let releaseAck = () => {}
  const ackGate = new Promise((resolve) => { releaseAck = resolve })
  let grantRound = 0
  const { svc, handle, editors, cleanup } = await withKit(1, {
    onRequest: async (method, params) => {
      if (method === 'bridge.grant') {
        grantRound += 1
        if (grantRound === 1) await ackGate // 第 1 条：永不回执
        return { ok: true, id: params?.grant?.id }
      }
      if (method === 'vscode.applyEdit') return applyEditResult()
      return undefined
    },
  })
  const [editor] = editors
  try {
    // ① 第 1 条 grant：挂住，然后在超时前发起第 2 条（同连接）—— stage 会 supersede 掉第 1 条。
    const first = grantAs(svc, S1, { timeoutMs: 300 })
    await waitUntil(() => grantRound === 1, 'first grant reaches editor')
    const second = await grantAs(svc, S1, { timeoutMs: 2000 })
    assert.equal(handle.kit.grants.active().length, 1, '第 2 条已经生效')
    assert.equal(handle.kit.grants.lookup(second.id)?.kind, 'active')

    // ② 第 1 条现在才失败（超时）→ 收口只该作废它自己那条 id。
    await assert.rejects(async () => first, (e) => e.code === ERR.TIMEOUT, '第 1 条等不到回执')
    assert.equal(editor.socket.destroyed, false, '★ 收口不许终止承载连接（R3-2 ①）')
    assert.equal(editor.link.closed, false, '协议终端也不许被关（closed 是 getter，false=还开着）')
    assert.equal(handle.kit.grants.active().length, 1, '★ 新 active grant 不许被连带作废')
    assert.equal(handle.kit.grants.lookup(second.id)?.kind, 'active', '★ 新 grant 仍然是 active')

    // ③ 那条新 grant 必须仍然能放行一次真实写入（"还在表里"不等于"还能用"）。
    const r = await writeAs(svc, writeParams({ grant: { id: second.id, epoch: second.epoch } }))
    assert.equal(r.applied, true)
    assert.equal(editor.count('vscode.applyEdit'), 1, '写入帧真的发出去了，且只有这一条')

    // ④ 撤销报文只点名第 1 条那个 id（best-effort，不许波及别人）
    const revoke = await editor.waitFrame('bridge.grantRevoke')
    assert.notEqual(revoke.params?.id, second.id, '撤销帧不许点名新 grant')
    assert.equal(editor.count('bridge.grantRevoke'), 1, '一次失败只发一条撤销')
  } finally {
    releaseAck()
    await cleanup()
  }
})

test('★ R3-2 ② 反复 grant() 超时 N 次：连接不断、active 计数正确、同一连接仍可重新 grant', async () => {
  // 每一轮都不回执（评审的 DoS 面：小超时 + 反复重试）。
  const rounds = 4
  let grantRound = 0
  const { svc, handle, editors, cleanup } = await withKit(1, {
    onRequest: async (method, params) => {
      if (method === 'bridge.grant') {
        grantRound += 1
        // 前 N 轮：活着但**永不回执**（也不 reject）—— 让 request 自己超时。
        // 最后一轮（收口正确性验完之后的重新发放）正常回执，用来证明"窗口没被锁死"。
        if (grantRound <= rounds) await new Promise(() => {})
        return { ok: true, id: params?.grant?.id }
      }
      if (method === 'vscode.applyEdit') return applyEditResult()
      return undefined
    },
  })
  const [editor] = editors
  try {
    for (let i = 1; i <= rounds; i++) {
      await assert.rejects(
        async () => grantAs(svc, S1, { timeoutMs: 120 }),
        (e) => e.code === ERR.TIMEOUT,
        `第 ${i} 轮超时`,
      )
      assert.equal(editor.socket.destroyed, false, `第 ${i} 轮之后连接必须还活着（不许断连 DoS）`)
      assert.equal(editor.link.closed, false, `第 ${i} 轮之后协议终端不许被关`)
      assert.equal(handle.kit.grants.pendingSize, 0, `第 ${i} 轮之后不许留挂着 pending`)
      assert.equal(handle.kit.grants.active().length, 0, `第 ${i} 轮之后 active 必须为 0`)
    }
    assert.equal(grantRound, rounds, '每一轮都真的走到了对端（不是本地就拒了）')

    // ★ 关键的一条：一次超时不许把这个窗口永久锁死 —— 同一连接必须还能重新 grant 成功。
    assert.equal(server_usable(handle), true, '连接仍被准入（trusted）')
    const ok = await grantAs(svc, S1, { timeoutMs: 2000 })
    assert.equal(handle.kit.grants.lookup(ok.id)?.kind, 'active')
    assert.equal(handle.kit.grants.active().length, 1, '重新发放后恰好一条 active（前几轮的作废不许复活）')
  } finally {
    await cleanup()
  }
})

/** 该连接是否仍被准入（收口之后它必须还在 `trusted` 里）。 */
function server_usable(handle) {
  return handle.kit.server.trusted.size === 1
}
