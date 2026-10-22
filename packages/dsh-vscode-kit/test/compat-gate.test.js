/**
 * 协议兼容门（契约 §4.1，错误码 -32008 protocol-incompatible）的守门测试。
 *
 * 判据只有一条：**对端 hello 里携带的 protocolVersion 是不是落在 SUPPORTED_PROTOCOL
 * 区间内的整数**。所以这里每一条用例都围绕「hello 报了什么版本 / 报没报」造场景，
 * 并且都断言两件事：
 *   1. 拒绝的形状（-32008 + data：required / peer / peerType / reason / side / method）；
 *   2. **门在发包之前** —— 不兼容时对端一条业务请求都没收到（`received` 为空）。
 *      只断言「抛错了」是不够的：先发出去再报错、让对端执行了副作用，也是失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, SUPPORTED_PROTOCOL } from '../src/index.js'
import {
  ERR, ERR_NAME, PROTOCOL_VERSION, connect, createLineSplitter, judgeProtocolVersion,
} from '../src/protocol.js'

// ─────────────────────────────────────────────────────────────────────────────
// 脚手架：与 apply.test.js 同构的最小 cordis ctx + 假编辑器（单文件独立，避免
// import 测试文件把对方的用例也跑一遍）。
// ─────────────────────────────────────────────────────────────────────────────

function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v) { provided.set(n, { v }) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    runDisposers() {
      while (disposers.length) {
        try { disposers.pop()() } catch { /* 卸载失败不影响其它清理 */ }
      }
    },
  }
}

/**
 * 假编辑器对 `vscode.getSelection` 的合法应答（契约 §5.1 形状）。
 *
 * facade 出口有 -32009 形状校验：`{ done: method }` 这种残缺形状会被判成畸形响应。
 * 改的是脚手架返回，**不是**校验（删校验让测试变绿是本末倒置）。
 */
const FAKE_SELECTION = Object.freeze({
  text: 'fake-selection',
  file: '/ws/fake.js',
  start: { line: 1, column: 1 },
  end: { line: 2, column: 3 },
  isEmpty: false,
})

/**
 * 假编辑器：裸 TCP 连上桥。
 *
 * `received` 只记**业务**请求（bridge.* 协议层方法不算），它就是「门有没有漏包」
 * 的权威证据 —— 业务请求一旦发出，对端必然先收到再应答。
 */
async function fakeEditor(server) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const received = []   // 只记业务方法（bridge.* 协议层方法不算）
  const allMethods = [] // 对端实际收到的每一个方法名
  const notifications = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method) => {
      allMethods.push(method)
      if (!method.startsWith('bridge.')) received.push(method)
      if (method === 'vscode.getSelection') return FAKE_SELECTION
      return { done: method }
    },
  })
  const feed = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    if (msg.id !== undefined) { link.handleLine(line); return }
    notifications.push(msg)
  })
  socket.on('data', feed)
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    link,
    received,
    allMethods,
    notifications,
    close() {
      if (socket.destroyed) return Promise.resolve()
      return new Promise((r) => { socket.once('close', r); socket.end() })
    },
  }
}

/** 起一个 apply 实例（可控 hello 等待时长）。 */
async function withKit({ helloWaitMs = 60 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-kit-gate-'))
  const ctx = fakeCtx()
  const handle = apply(ctx, {
    dshHome: home, connectWaitMs: 200, helloWaitMs, onLog: () => {},
  })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v
  const server = handle.kit.server
  const editors = []
  const connectEditor = async () => {
    const e = await fakeEditor(server)
    editors.push(e)
    return e
  }
  const cleanup = async () => {
    for (const e of editors) await e.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, kit: handle.kit, server, connectEditor, cleanup }
}

/** 编辑器报身份。`ptv` 传 `OMIT` 表示「**不带**这个字段」（模拟旧版/残缺对端）。 */
const OMIT = Symbol('omit')
async function hello(editor, ptv, capabilities = ['vscode.getSelection'], client = 'fake-editor') {
  const params = { client, extensionVersion: '0.1.0', capabilities }
  if (ptv !== OMIT) params.protocolVersion = ptv
  return editor.link.request('bridge.hello', params)
}

/** 等某个条件成立（带上限）。乐观轮询，不猜固定 sleep。 */
async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10, label = 'condition' } = {}) {
  const started = Date.now()
  for (;;) {
    if (fn()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 业务帧计数（`received` 只记业务方法，不含 bridge.* 协议层）。 */
const businessCount = (editor) => editor.received.length

/** 断言是 -32008 且 data 形状符合契约 §4.1 ③。 */
function assertIncompatible(err, { peer, peerType, reason, method, side = 'dsh' }) {
  assert.equal(err.code, ERR.PROTOCOL_INCOMPATIBLE, `应为 -32008，实际 ${err.code}: ${err.message}`)
  assert.equal(err.code, -32008, '契约 §4.1/§5 冻结的错误码')
  const d = err.data
  assert.deepEqual(d.required, { min: SUPPORTED_PROTOCOL[0], max: SUPPORTED_PROTOCOL[1] },
    'data.required 必须是兼容区间 {min,max}')
  assert.equal(d.peer, peer, 'data.peer 是对端声明值（非法/缺失归一为 null）')
  assert.equal(d.peerType, peerType, 'data.peerType 用来区分「没有字段」与「值非法」')
  assert.equal(d.reason, reason, 'data.reason 是判定表命中的那一行')
  assert.equal(d.side, side, 'data.side 标明是哪一侧做的判定')
  assert.equal(d.method, method, 'data.method 是被拦下的业务方法')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 常量：形状必须是区间（契约 §4.1 ①：写成单值就是实现错）
// ─────────────────────────────────────────────────────────────────────────────
test('SUPPORTED_PROTOCOL 是冻结的 [min,max] 区间，今天等于 [1,1]', () => {
  assert.ok(Array.isArray(SUPPORTED_PROTOCOL), '必须是数组形式的区间，不是单值')
  assert.equal(SUPPORTED_PROTOCOL.length, 2)
  assert.deepEqual([...SUPPORTED_PROTOCOL], [1, 1])
  assert.deepEqual([...SUPPORTED_PROTOCOL], [PROTOCOL_VERSION, PROTOCOL_VERSION])
  assert.ok(Object.isFrozen(SUPPORTED_PROTOCOL), '区间是契约常量，不许被运行时改写')
})

test('§5 失败表：-32008 的名字是 protocol-incompatible，且没有复用别的错误码', () => {
  assert.equal(ERR.PROTOCOL_INCOMPATIBLE, -32008)
  assert.equal(ERR_NAME[ERR.PROTOCOL_INCOMPATIBLE], 'protocol-incompatible')
  for (const other of [ERR.UNSUPPORTED, ERR.METHOD_NOT_FOUND, ERR.DISCONNECTED, ERR.INVALID_PARAMS]) {
    assert.notEqual(ERR.PROTOCOL_INCOMPATIBLE, other, '版本不兼容不得复用其它错误码表达')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 判定表本体（纯函数）：契约 §4.1 ① 的三行 + 「缺少 hello」一行
// ─────────────────────────────────────────────────────────────────────────────
test('判定表：整数且在区间内才放行，越界/缺失/非整数/非数字一律不兼容', () => {
  const cases = [
    [1, 'ok', true, true],
    [0, 'out-of-range', false, false],
    [2, 'out-of-range', false, false],
    [-1, 'out-of-range', false, false],
    [undefined, 'missing', false, false],
    [null, 'missing', false, false],
    [1.5, 'not-an-integer', false, false],
    [Number.NaN, 'not-a-number', false, false],
    [Number.POSITIVE_INFINITY, 'not-a-number', false, false],
    ['1', 'not-a-number', false, false],
    ['v1', 'not-a-number', false, false],
    [{}, 'not-a-number', false, false],
    [true, 'not-a-number', false, false],
  ]
  for (const [ptv, reason, compatible] of cases) {
    const v = judgeProtocolVersion(ptv)
    assert.equal(v.reason, reason, `ptv=${String(ptv)} 应判 ${reason}，实际 ${v.reason}`)
    assert.equal(v.compatible, compatible, `ptv=${String(ptv)} 的 compatible 判定错了`)
  }
  for (const ptv of cases.filter((c) => !c[3]).map((c) => c[0])) {
    assert.notEqual(judgeProtocolVersion(ptv).compatible, true,
      `ptv=${String(ptv)} 不得被推断成兼容（尤其不得当成 v1）`)
  }
})

test('判定结果里 peer/peerType 能区分「没有这个字段」与「值非法」', () => {
  const missing = judgeProtocolVersion(undefined)
  assert.equal(missing.peer, null)
  assert.equal(missing.peerType, 'undefined')

  const nullish = judgeProtocolVersion(null)
  assert.equal(nullish.reason, 'missing')
  assert.equal(nullish.peerType, 'null', '显式 null 与「没这个字段」在诊断上要分开')

  const badType = judgeProtocolVersion('1')
  assert.equal(badType.reason, 'not-a-number')
  assert.equal(badType.peer, '1', '标量原样回显，方便对端自查')
  assert.equal(badType.peerType, 'string')

  // NaN / 对象 / 函数不进 data.peer（否则序列化即失真，甚至把无关内容发给对端）
  for (const weird of [Number.NaN, {}, () => {}, Symbol('x')]) {
    const v = judgeProtocolVersion(weird)
    assert.equal(v.compatible, false)
    assert.equal(v.peer, null, `非法值 ${String(weird)} 的 peer 必须归一为 null`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. DSH 侧权威门：放行路径
// ─────────────────────────────────────────────────────────────────────────────
test('ptv=1 合法 → 放行，请求真的到达对端', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 1)
    const res = await svc.request('vscode.getSelection', {})
    assert.deepEqual(res, FAKE_SELECTION)
    assert.deepEqual(editor.received, ['vscode.getSelection'], '门放行后业务请求应到达对端')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. DSH 侧权威门：拒绝路径（三种：越界 / 缺失 / 类型非法）
// ─────────────────────────────────────────────────────────────────────────────
test('整数越界（2）→ -32008，且一条业务请求都没发出对端', async () => {
  const { svc, kit, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2) // 未来版本：hello 本身仍可应答（协议层不受门约束）
    assert.equal(kit.lastEditor.protocolVersion, 2)
    assert.equal(kit.lastEditor.protocolCompatible, false)

    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => { assertIncompatible(e, {
        peer: 2, peerType: 'number', reason: 'out-of-range', method: 'vscode.getSelection',
      }); return true },
    )
    assert.deepEqual(editor.received, [],
      '门必须在发包之前：不兼容时对端不得收到任何业务请求（发了再报错也算错）')
  } finally {
    await cleanup()
  }
})

test('整数越界（0）→ -32008（下界同样拦）', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 0)
    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => { assertIncompatible(e, {
        peer: 0, peerType: 'number', reason: 'out-of-range', method: 'vscode.getSelection',
      }); return true },
    )
    assert.deepEqual(editor.received, [])
  } finally {
    await cleanup()
  }
})

test('ptv 缺失 → -32008（缺字段**不得**当成 v1）', async () => {
  const { svc, kit, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, OMIT)
    assert.equal(kit.lastEditor.protocolVersionPresent, false, '缺字段必须被记录成「没有这个字段」')
    assert.equal(kit.lastEditor.protocolVersion, undefined, '不得补成 1')
    assert.equal(kit.lastEditor.protocolCompatible, false)
    assert.equal(kit.lastEditor.protocolReason, 'missing')

    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => { assertIncompatible(e, {
        peer: null, peerType: 'undefined', reason: 'missing', method: 'vscode.getSelection',
      }); return true },
    )
    assert.deepEqual(editor.received, [])
  } finally {
    await cleanup()
  }
})

test('ptv 非整数 / 字符串 / NaN → 一律 -32008，且都不发包', async () => {
  // 注意 NaN：JSON 传不了 NaN，过线后被序列化成 null —— 对端看到的就是「没这个字段」，
  // 所以线上的期望是 missing/'null'。纯函数那层的 NaN 行由上一条判定表用例直接断言。
  const cases = [
    [1.5, 1.5, 'number', 'not-an-integer'],
    ['1', '1', 'string', 'not-a-number'],
    [Number.NaN, null, 'null', 'missing'],
    [true, true, 'boolean', 'not-a-number'],
  ]
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    for (const [ptv, peer, peerType, reason] of cases) {
      await hello(editor, ptv)
      await assert.rejects(
        svc.request('vscode.getSelection', {}),
        (e) => { assertIncompatible(e, {
          peer, peerType, reason, method: 'vscode.getSelection',
        }); return true },
      )
    }
    assert.deepEqual(editor.received, [], '四种非法版本都不许把业务请求漏出去')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. hello 之前：没有对端版本 = 未知版本，保守拒绝（契约 §7 #3）
// ─────────────────────────────────────────────────────────────────────────────
test('还没收到 hello 就发请求 → 等一小段后按「未知版本」拒绝（不推断为 v1）', async () => {
  const { svc, connectEditor, cleanup } = await withKit({ helloWaitMs: 40 })
  try {
    const editor = await connectEditor()
    // 只连上还不算准入（铁律 8：连接建立 ≠ 准入）—— 先用协议层 ping 过准入，
    // 但**始终不报 hello**。这才是真实的「旧扩展/hello 丢失」场景。
    await editor.link.request('bridge.ping', {})
    const t0 = Date.now()
    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => {
        assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE)
        assert.equal(e.data.reason, 'missing')
        assert.equal(e.data.helloReceived, false, '诊断上要能看出「压根没收到 hello」')
        assert.deepEqual(e.data.required, { min: 1, max: 1 })
        return true
      },
    )
    assert.ok(Date.now() - t0 >= 30, '应当真的等过 hello（而不是立刻当成无编辑器）')
    assert.deepEqual(editor.received, [])
  } finally {
    await cleanup()
  }
})

test('新连接不给旧连接的版本背书：换了对端就要重新报版本', async () => {
  const { svc, connectEditor, cleanup } = await withKit({ helloWaitMs: 40 })
  try {
    const first = await connectEditor()
    await hello(first, 1)
    assert.deepEqual(await svc.request('vscode.getSelection', {}), FAKE_SELECTION)

    // 第二台编辑器连上并准入（活跃目标按连接序号换成它），但还没报 hello
    const second = await connectEditor()
    await second.link.request('bridge.ping', {})
    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => e.code === ERR.PROTOCOL_INCOMPATIBLE && e.data.helloReceived === false,
    )
    assert.deepEqual(second.received, [], '新对端没报版本前不得发业务请求')
    assert.deepEqual(first.received, ['vscode.getSelection'], '旧对端只收到过它当活跃目标时的那一条')

    // 新对端报了 v1 → 放行
    await hello(second, 1)
    assert.deepEqual(await svc.request('vscode.getSelection', {}), FAKE_SELECTION)
    assert.deepEqual(second.received, ['vscode.getSelection'])
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 边角：协议层方法不受版本门约束（否则不兼容时连「你是几版」都问不到）
// ─────────────────────────────────────────────────────────────────────────────
test('版本不兼容时 bridge.* 协议方法仍可通（只拦业务能力，不拦协商通道）', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2)
    assert.deepEqual(await svc.request('bridge.ping', { x: 1 }), { done: 'bridge.ping' })
    await assert.rejects(
      svc.request('vscode.openFile', { path: 'x' }),
      (e) => e.code === ERR.PROTOCOL_INCOMPATIBLE && e.data.method === 'vscode.openFile',
    )
    assert.deepEqual(editor.allMethods, ['bridge.ping'], '对端只该看到协议层 ping，业务请求一条都不许到')
    assert.deepEqual(editor.received, [], '业务请求一条都不许到对端')
  } finally {
    await cleanup()
  }
})

test('snapshot() 暴露兼容区间与对端判定结果（诊断可读）', async () => {
  const { kit, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    const before = kit.snapshot()
    assert.deepEqual(before.supportedProtocol, [1, 1])
    assert.equal(before.protocolVersion, PROTOCOL_VERSION)
    assert.equal(before.protocolCompatible, false, '还没 hello 时不得自认兼容')

    await hello(editor, 2)
    const after = kit.snapshot()
    assert.equal(after.protocolCompatible, false)
    assert.equal(after.lastEditor.protocolVersion, 2)
    assert.equal(after.lastEditor.protocolReason, 'out-of-range')

    await hello(editor, 1)
    assert.equal(kit.snapshot().protocolCompatible, true)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. ★ 评审 F1 回归：判定必须绑在「真正收包的那条连接」上
//
// 这一节的场景全部来自评审探针（work/评审探针-T16-兼容门.mjs 的 B/D）：
// 全局「最后一次 hello」槽 + 按连接序号挑目标 = 双窗口时门形同虚设。
// 所以每条都同时断言「拒了」和「对端业务帧增量 0」—— 只看抛错不算数。
// ─────────────────────────────────────────────────────────────────────────────
test('★ F1 回归①：双窗口，目标从兼容的 A 切到不兼容的 B → -32008 且 B 业务帧增量 0', async () => {
  const { svc, kit, connectEditor, cleanup } = await withKit({ helloWaitMs: 40 })
  try {
    // 窗口 A：v1，目标明确、业务正常
    const a = await connectEditor()
    await hello(a, 1, ['vscode.getSelection'], 'window-A')
    assert.deepEqual(await svc.request('vscode.getSelection', {}), FAKE_SELECTION)
    assert.equal(businessCount(a), 1, 'A 是当时的目标：应收到 1 条业务帧')

    // 窗口 B 连上（序号更大 ⇒ 立刻成为目标），但还没报 hello。
    // 旧实现读全局槽（A 刚报过 v1）→ 这里会把业务帧发给 B（fail-open）。
    const b = await connectEditor()
    await b.link.request('bridge.ping', {})
    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => {
        assertIncompatible(e, {
          peer: null, peerType: 'undefined', reason: 'missing', method: 'vscode.getSelection',
        })
        assert.equal(e.data.helloReceived, false, '目标连接自己没报过 hello')
        return true
      },
    )
    assert.equal(businessCount(b), 0, 'B 报版本前不得收到业务帧（旧实现这里是 1）')
    assert.equal(businessCount(a), 1, 'A 一条都不许多收')

    // B 明确自称 v2：拒绝理由必须是 B 的版本，不是 A 的。
    await hello(b, 2, ['vscode.getSelection'], 'window-B')
    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => {
        assertIncompatible(e, {
          peer: 2, peerType: 'number', reason: 'out-of-range', method: 'vscode.getSelection',
        })
        return true
      },
    )
    assert.equal(businessCount(b), 0, '不兼容的 B 业务帧增量必须是 0')
    assert.equal(businessCount(a), 1)
    // 同源读法：snapshot 与门看的是同一份（都来自当前目标连接 B）
    assert.equal(kit.snapshot().lastEditor.client, 'window-B')
    assert.equal(kit.snapshot().protocolCompatible, false)
  } finally {
    await cleanup()
  }
})

test('★ F1 回归②：目标窗口关掉后回退到另一条不兼容连接 → 仍然拒，业务帧增量 0', async () => {
  const { svc, kit, connectEditor, cleanup } = await withKit({ helloWaitMs: 40 })
  try {
    // B 先连、自称 v2（不兼容）；A 后连、自称 v1（兼容）→ 目标按序号是 A
    const b = await connectEditor()
    await hello(b, 2, ['vscode.getSelection'], 'window-B')
    const a = await connectEditor()
    await hello(a, 1, ['vscode.getSelection'], 'window-A')
    assert.deepEqual(await svc.request('vscode.getSelection', {}), FAKE_SELECTION)
    assert.equal(businessCount(a), 1)
    assert.equal(businessCount(b), 0, 'B 从头到尾没收到业务帧')

    // 用户把 A 那个窗口关了 → 目标回退到 B（架构不变量：不回退到 links、只挑活连接）
    await a.close()
    await waitFor(() => kit._activeLink()?.editor?.client === 'window-B', { label: 'target falls back to B' })

    await assert.rejects(
      svc.request('vscode.getSelection', {}),
      (e) => {
        assertIncompatible(e, {
          peer: 2, peerType: 'number', reason: 'out-of-range', method: 'vscode.getSelection',
        })
        return true
      },
    )
    assert.equal(businessCount(b), 0,
      'B 业务帧增量必须是 0 —— 旧实现会沿用已关窗口 A 的 v1 背书把包发给 B（评审探针 D：增量 1）')
    assert.equal(kit.snapshot().lastEditor.client, 'window-B', 'snapshot 必须跟着目标走，不许停在已关窗口')
    assert.equal(kit.snapshot().protocolCompatible, false)
    assert.equal(kit.snapshot().protocolReason, 'out-of-range')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. ★ 评审 F2 回归：notify() 也要过门（但 bridge.* 继续豁免、语义仍是单向）
// ─────────────────────────────────────────────────────────────────────────────
test('★ F2 回归：不兼容时 notify() 发业务方法同样 -32008，对端业务帧增量 0', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2) // 不兼容
    // 同步 throw ⇒ notify 仍是单向语义（没被改成「等回执的 request」）
    assert.throws(
      () => svc.notify('vscode.getSelection', {}),
      (e) => {
        assertIncompatible(e, {
          peer: 2, peerType: 'number', reason: 'out-of-range', method: 'vscode.getSelection',
        })
        return true
      },
    )
    // 真漏发的话帧是异步到达的：等一小会儿再数
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(businessCount(editor), 0, 'notify 也不许把业务帧漏给不兼容对端（探针 C：旧实现增量 1）')
  } finally {
    await cleanup()
  }
})

test('★ F2 回归：不兼容时 bridge.* 通知仍放行（协商通道不被自己堵死）', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2)
    assert.equal(svc.notify('bridge.ping', { n: 1 }), undefined, 'notify 不返回 Promise')
    await waitFor(() => editor.notifications.some((m) => m.method === 'bridge.ping'),
      { label: 'bridge.ping 到达对端' })
    assert.equal(businessCount(editor), 0, '协议层通知不算业务帧')
  } finally {
    await cleanup()
  }
})

test('★ F2：兼容时 notify() 业务方法照常发出，且能力预检同样覆盖 notify', async () => {
  const { svc, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 1, ['vscode.getSelection'])
    assert.equal(svc.notify('vscode.getSelection', { probe: true }), undefined)
    await waitFor(() => editor.notifications.some((m) => m.method === 'vscode.getSelection'),
      { label: '业务通知到达对端' })
    assert.deepEqual(editor.received, [], '通知不是请求：对端不该把它记成业务请求')

    // 能力预检以前只覆盖 request；notify 现在同一套（评审 F2「顺手覆盖」）
    assert.throws(
      () => svc.notify('vscode.openFile', { path: 'x' }),
      (e) => e.code === ERR.UNSUPPORTED && e.data.method === 'vscode.openFile'
        && deepEqualList(e.data.capabilities, ['vscode.getSelection']),
    )
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. ★ 评审 N1 回归：broadcast() 也要过门（按每条连接自己的版本事实逐条判定）
//
//    N1 是与 F2 同族的旁路：`broadcast()` 只遍历 trusted 直接 notify，版本门形同虚设。
//    这里锁四件事：
//      ① 不兼容连接在 broadcast 时**零业务帧**（且零投递抛 -32008）；
//      ② 兼容连接照常收到；
//      ③ 混合场景只投给兼容那条（不兼容那条零业务帧，用同 socket FIFO 做栅栏）；
//      ④ 没有连接 / 版本缺失 / 版本不兼容 → 一律 -32008（零投递不许静默成功），
//         而 bridge.* 广播继续豁免（协商通道不能自己堵死）。
// ─────────────────────────────────────────────────────────────────────────────

/** 某编辑器收到的**业务**通知（bridge.* 协议层不算；广播走 notify，落在这里）。 */
const businessNotifies = (editor) => editor.notifications.filter(
  (m) => !String(m.method).startsWith('bridge.'),
)

test('★ N1 回归①：不兼容连接在 broadcast 时零业务帧，且零投递抛 -32008', async () => {
  const { server, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2) // 越界 → 不兼容
    assert.equal(server.trusted.size, 1, '前置：这条连接已准入')

    assert.throws(
      () => server.broadcast('vscode.selectionChanged', { text: 'secret' }),
      (e) => {
        // 形状对齐契约 §4.1 ③；单个候选时回显它的判定
        assertIncompatible(e, {
          peer: 2, peerType: 'number', reason: 'out-of-range', method: 'vscode.selectionChanged',
        })
        assert.equal(e.data.delivered, 0)
        return true
      },
      '没有任何兼容连接时广播必须抛错（静默成功正是 N1 的形态）',
    )

    // 栅栏：同 socket FIFO。服务端若曾把广播写给这条连接，它必然排在这条协议请求的
    // 响应之前；等响应回来再数，就不需要固定观察窗（评审 S1 的老问题）。
    await editor.link.request('bridge.ping', {})
    assert.deepEqual(businessNotifies(editor), [],
      `不兼容连接收到了广播：${JSON.stringify(businessNotifies(editor).map((m) => m.method))}`)
  } finally {
    await cleanup()
  }
})

test('★ N1 回归②：兼容连接照常收到 broadcast，返回投递计数', async () => {
  const { server, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, PROTOCOL_VERSION)
    const delivered = server.broadcast('vscode.selectionChanged', { text: 'hi' })
    assert.equal(delivered, 1, '返回值 = 实际投递到的连接数')
    await waitFor(() => businessNotifies(editor).some((m) => m.method === 'vscode.selectionChanged'),
      { label: '兼容连接收到广播' })
    assert.deepEqual(businessNotifies(editor)[0].params, { text: 'hi' })
  } finally {
    await cleanup()
  }
})

test('★ N1 回归③：混合场景（一条兼容一条不兼容）只投给兼容那条', async () => {
  const { server, connectEditor, cleanup } = await withKit()
  try {
    const good = await connectEditor()
    await hello(good, PROTOCOL_VERSION)
    const bad = await connectEditor()
    await hello(bad, 3) // 越界 → 不兼容
    assert.equal(server.trusted.size, 2)

    const delivered = server.broadcast('vscode.selectionChanged', { text: 'only-compatible' })
    assert.equal(delivered, 1, '只投给兼容的那一条')

    await waitFor(() => businessNotifies(good).some((m) => m.method === 'vscode.selectionChanged'),
      { label: '兼容连接收到广播' })
    assert.deepEqual(businessNotifies(good)[0].params, { text: 'only-compatible' })

    // 不兼容那条：FIFO 栅栏之后再断言零业务帧
    await bad.link.request('bridge.ping', {})
    assert.deepEqual(businessNotifies(bad), [],
      `不兼容连接收到了广播：${JSON.stringify(businessNotifies(bad).map((m) => m.method))}`)
  } finally {
    await cleanup()
  }
})

test('★ N1 回归④：没有连接 / 版本缺失 → 一律 -32008（零投递可被调用方感知）', async () => {
  // (a) 一条连接都没有：peer 取不到 → null
  {
    const { server, cleanup } = await withKit()
    try {
      assert.throws(
        () => server.broadcast('vscode.selectionChanged', { text: 'x' }),
        (e) => {
          assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE)
          assert.equal(e.code, -32008)
          assert.deepEqual(e.data.required,
            { min: SUPPORTED_PROTOCOL[0], max: SUPPORTED_PROTOCOL[1] }, 'data.required 是兼容区间')
          assert.equal(e.data.peer, null, 'peer 取不到就给 null')
          assert.equal(e.data.reason, 'no-editor')
          assert.equal(e.data.side, 'dsh')
          assert.equal(e.data.method, 'vscode.selectionChanged')
          assert.equal(e.data.delivered, 0)
          return true
        },
      )
    } finally {
      await cleanup()
    }
  }

  // (b) 连上了但**没报** hello（版本未知，不得推断成 v1）
  {
    const { server, connectEditor, cleanup } = await withKit()
    try {
      const editor = await connectEditor()
      await editor.link.request('bridge.ping', {}) // 只准入，不报身份
      assert.equal(server.trusted.size, 1)
      assert.throws(
        () => server.broadcast('vscode.selectionChanged', { text: 'x' }),
        (e) => {
          assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE)
          assert.equal(e.data.reason, 'missing')
          assert.equal(e.data.peer, null)
          assert.equal(e.data.helloReceived, false)
          return true
        },
      )
      await editor.link.request('bridge.ping', {})
      assert.deepEqual(businessNotifies(editor), [], '版本未知的连接不许收到广播')
    } finally {
      await cleanup()
    }
  }
})

test('★ N1：bridge.* 广播继续豁免版本门（协商通道不被自己堵死）', async () => {
  const { server, connectEditor, cleanup } = await withKit()
  try {
    const editor = await connectEditor()
    await hello(editor, 2) // 不兼容
    const delivered = server.broadcast('bridge.hello', { client: 'dsh-vscode-kit' })
    assert.equal(delivered, 1, '协议层方法不受版本门约束，照常投递并返回计数')
    await waitFor(
      () => editor.notifications.filter((m) => m.method === 'bridge.hello').length === 2,
      { label: '第二条 bridge.hello 到达对端' }, // 第一条是建连时协议层自动下发的
    )
    assert.deepEqual(businessNotifies(editor), [], '豁免路径不许顺带漏业务帧')
  } finally {
    await cleanup()
  }
})

function deepEqualList(actual, expected) {
  try {
    assert.deepEqual(actual, expected)
    return true
  } catch {
    return false
  }
}
