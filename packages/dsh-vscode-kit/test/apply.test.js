import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject, VscodeKit, replayPendingAuthorized } from '../src/index.js'
import { ERR, connect, createLineSplitter } from '../src/protocol.js'
import { discoveryDir, listLiveBridges } from '../src/server.js'

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


function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-apply-'))
}

/** 轮询等待条件成立（用于等「服务端处理完对端断开」这类事件，不用固定睡眠）。 */
async function waitFor(predicate, ms = 2000, what = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`waitFor timed out: ${what}`)
}

/** 用客户端的 localPort 找回服务端那条连接对象（对照同一 TCP 连接的两端）。 */
function serverLinkFor(server, clientSocket) {
  return [...server.links].find((l) => l.socket?.remotePort === clientSocket.localPort)
}

/**
 * 假编辑器返回的 `vscode.getSelection` 结果，**必须是契约 §5.1 的合法形状**。
 *
 * facade 出口现在有形状校验（-32009 invalid-response）：早先这些脚手架返回
 * `{ text }` / `{ status:'ok', text }` 这种残缺形状，正常断言还能过，但现在会被
 * 判成畸形响应。**别为了让测试变绿去删校验** —— 这里改的是脚手架的返回，不是校验。
 */
function fakeSelection(text) {
  return {
    text,
    file: '/ws/fake.js',
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 + text.length },
    isEmpty: text.length === 0,
  }
}

/**
 * 最小 cordis ctx 模拟：只要 provide/effect 存在就能跑 apply。
 *
 * 必须复刻 cordis 的 effect 契约：`effect(fn)` 会**立刻执行 fn**，并把 fn 的
 * 返回值当作 disposer（dispose 时调用）。早期版本把 fn 本身塞进 disposers，
 * 结果 runDisposers() 只是又跑了一遍 fn、拿到没人执行的 disposer —— 表现为
 * 「卸载后发现文件没删」和 `await handle.stopped` 永久挂起，白查一轮。
 */
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

/**
 * 模拟编辑器：裸 TCP 连上桥，作为「假 VSCode 扩展」应答 vscode.* 请求。
 *
 * 脚手架路由规则（记取坑 6 的教训，三路互斥）：
 *  - 响应（id + result/error）→ link.handleLine（配对回 Promise）
 *  - 请求（id + method）      → link.handleLine（交给 onRequest 应答）
 *  - 通知（无 id）            → inbox/waiters（hello 等）
 */
async function fakeEditor(server, { onRequest, bypassToken } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const inbox = []
  const waiters = []
  // bypassToken：安全回归用 —— 故意用错 token 连上去，验证「连接在册但不准入」。
  const token = bypassToken ?? server.token
  const link = connect({ write: (l) => socket.write(l), token, onRequest })
  const feed = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    const isResponse = msg.id !== undefined && msg.method === undefined
    const isRequest = msg.id !== undefined && msg.method !== undefined
    if (isResponse || isRequest) { link.handleLine(line); return }
    const w = waiters.shift()
    if (w) w(msg); else inbox.push(msg)
  })
  socket.on('data', feed)
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    link, socket, inbox,
    next(timeoutMs = 2000) {
      if (inbox.length) return Promise.resolve(inbox.shift())
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('next() timed out')), timeoutMs)
        waiters.push((m) => { clearTimeout(t); resolve(m) })
      })
    },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

test('插件形状：name 与包名一致、inject 为空数组、apply 是函数', async () => {
  assert.equal(name, 'dsh-vscode-kit')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
})

test('端到端：apply → 服务注册 → 假编辑器连上 → 消费者 vscode.* 全链路', async () => {
  const home = tempHome()
  const logs = []
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, onLog: (l, m) => logs.push(`${l}:${m}`) })
  await handle.boot
  assert.equal(handle.disposed, false)

  // 服务已注册且就绪
  assert.ok(ctx.provided.has('dshVscodeKit'))
  const svc = boundSvc(ctx)
  assert.equal(svc.ready, true)

  // 假编辑器：应答 vscode.getSelection
  const editor = await fakeEditor(handle.kit.server, {
    onRequest: (method, params) => {
      if (method === 'vscode.getSelection') return fakeSelection('hello-from-vscode')
      throw new Error(`unexpected method ${method}`)
    },
  })

  // 1) 编辑器收到 hello（协议 §3.4：每连接第一条消息）
  const hello = await editor.next()
  assert.equal(hello.method, 'bridge.hello')
  assert.equal(hello.params.protocolVersion, 1)

  // 1b) 编辑器回报身份**必须带 protocolVersion**（契约 §4.1：版本门只认 hello 里的 ptv，
  //     缺它就等于「未知版本」→ 业务能力一律 -32008，见 test/compat-gate.test.js）。
  await editor.link.request('bridge.hello', {
    client: 'fake-editor', extensionVersion: '0.1.0',
    protocolVersion: 1, capabilities: ['vscode.getSelection'],
  })

  // 2) 编辑器 → DSH 方向：bridge.ping 由 handleInbound 应答
  const pong = await editor.link.request('bridge.ping', { x: 1 })
  assert.equal(pong.pong, true)
  assert.deepEqual(pong.echo, { x: 1 })

  // 3) 消费者 → 编辑器方向：vscode.getSelection 转发并拿到假编辑器的返回
  const sel = await svc.request('vscode.getSelection')
  assert.deepEqual(sel, fakeSelection('hello-from-vscode'))

  // 4) 糖衣等价
  const sel2 = await svc.vscode.getSelection()
  assert.deepEqual(sel2, sel)

  // 5) 编辑器报身份 → lastEditor 记录（兼容判据 + 能力降级判据）
  await announce(editor)
  assert.equal(handle.kit.lastEditor.client, 'fake-editor')

  // 6) 能力未声明的方法 → -32005（不崩溃，结构化降级）
  await assert.rejects(
    svc.request('vscode.openFile', { path: 'x' }),
    (e) => e.code === ERR.UNSUPPORTED,
  )

  await editor.close()
  ctx.runDisposers()
  await handle.stopped
  assert.equal(listLiveBridges(discoveryDir(home)).length, 0, '发现文件应在卸载后删除')
  assert.ok(logs.some((l) => l.includes('listening on')))

  rmSync(home, { recursive: true, force: true })
})

/**
 * 回归锁（安全审计 洞 2）：**连接建立 ≠ 准入**。
 *
 * 曾经的实现是 `links.add(link)` 之后 `_activeLink()` 直接取「最后连上的那个」，
 * 于是任何本机进程只要裸连端口、什么都不发，就能把 active 位抢走，
 * 之后 DSH 的 `vscode.*` 请求全被它接走并可伪造结果
 * （复现脚本 work/scripts/lesson3-hijack.mjs）。
 *
 * 现在的口径：server.js 在 authorize 通过 token 后将连接升入 trusted；
 * `_activeLink()` 只从 trusted 选，authorized 标志不再作为选目标的依据。
 * 下面的用例按「没准入门 → 抢不到」的顺序钉住它。
 */
test('安全回归：即使 authorized 标志被误置，目标集合也不含未准入连接', () => {
  const admitted = { authorized: true, connSeq: 1 }
  const bare = { authorized: true, connSeq: 2 } // 故意模拟标志被误写；它从未通过 token。
  const server = { links: new Set([admitted, bare]), trusted: new Set([admitted]) }
  const kit = new VscodeKit({ server, dshVersion: 'test', connectWaitMs: 0 })
  assert.equal(kit._activeLink(), admitted, '目标只能从 trusted 选，不能从 links 选')
  server.trusted.delete(admitted)
  assert.equal(kit._activeLink(), null, 'trusted 为空时不能回退到混杂的 links')
})

// 回归锁（评审 R1）：trusted 是**准入**时 add 的，集合顺序 = 准入先后；
// 挑目标必须按**连接序号**（建连先后），否则两条都合法时目标会漂移。
test('回归（R1）：目标按连接序号挑，不按 trusted 的插入（准入）顺序', () => {
  const older = { authorized: true, connSeq: 3 }
  const newer = { authorized: true, connSeq: 4 }
  // 故意把新连接放在前：按插入顺序取末项会拿到 older。
  const server = { links: new Set(), trusted: new Set([newer, older]) }
  const kit = new VscodeKit({ server, dshVersion: 'test', connectWaitMs: 0 })
  assert.equal(kit._activeLink(), newer, '必须选连接序号最大的那条')
  assert.notEqual(kit._activeLink(), [...server.trusted].at(-1), '不能按 trusted 插入顺序取末项')
})

// ─────────────────────────────────────────────────────────────────────────────
// 回归（评审 R1）：真 socket 上的「连接先 vs 准入先」交错。
// 拆分前 links 在建连时 add，取末项 = 最后连接；拆分后 trusted 在准入时 add，
// 取末项 = 最后准入。connect A → connect B → 先准入 B → 后准入 A 时两者不一致：
// 旧算法输出 B，只取 trusted 末项输出 A —— 请求会送到另一个编辑器窗口。
// 这里用行为断言（请求最终打到谁）钉住「赢家恒为最后连接的那条」。
// ─────────────────────────────────────────────────────────────────────────────

/** 起一个 apply 实例 + 若干假编辑器；editors 按连接先后排列。 */
async function withKit(editorTexts) {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)
  const server = handle.kit.server
  const editors = []
  for (const text of editorTexts) {
    const editor = await fakeEditor(server, {
      onRequest: (method) => (method === 'vscode.getSelection' ? fakeSelection(text) : undefined),
    })
    await editor.next() // 吃掉 hello
    editor.serverLink = serverLinkFor(server, editor.socket)
    editors.push(editor)
  }
  const cleanup = async () => {
    // 已断开的 socket 不再 close()：close() 等的是 'close' 事件，重放会永久挂住。
    for (const e of editors) if (!e.socket.destroyed) await e.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, server, handle, editors, cleanup }
}

/**
 * 让假编辑器「报身份」：带协议版本 + 能力清单。
 *
 * 兼容门（契约 §4.1）只认 hello 里的 `protocolVersion`：不报 = 未知版本 = 业务能力
 * 一律 -32008。所以凡是要发 `vscode.*` 的用例都得先 announce。
 * 刻意不放进 withKit —— 报身份会顺带完成准入，会打乱「准入顺序」类用例的前置条件。
 */
async function announce(editor, { ptv = 1, capabilities = ['vscode.getSelection'] } = {}) {
  const params = { client: 'fake-editor', extensionVersion: '0.1.0', capabilities }
  if (ptv !== undefined) params.protocolVersion = ptv
  return editor.link.request('bridge.hello', params)
}

test('★回归（R1）：A/B 逆序准入时目标仍是后连接的 B（按连接先后）', async () => {
  const { svc, server, handle, editors, cleanup } = await withKit(['FROM-A', 'FROM-B'])
  const [a, b] = editors
  try {
    assert.ok(a.serverLink && b.serverLink, '两条连接都应在册')
    assert.ok(b.serverLink.connSeq > a.serverLink.connSeq,
      `connSeq 必须按建连先后单调递增，实际 A=${a.serverLink.connSeq} B=${b.serverLink.connSeq}`)

    // ★ 逆序准入：B 先、A 后。trusted 的插入顺序因此是 [B, A]。
    await b.link.request('bridge.ping', {})
    await a.link.request('bridge.ping', {})
    assert.equal([...server.trusted].at(-1), a.serverLink,
      '前置条件：trusted 末项是最后准入的 A（若这里不是 A，用例没造出交错）')
    assert.equal(handle.kit._activeLink(), b.serverLink,
      '目标必须是最后连接的 B，不是最后准入的 A')

    // 过版本门：两条连接都报 v1（契约 §4.1）。放在准入断言之后，
    // 免得报身份顺带完成准入、破坏上面「逆序准入」的前置条件。
    await announce(a)
    await announce(b)

    // 行为断言：请求真的落到 B，而不只是内部引用相等。
    const sel = await svc.request('vscode.getSelection', {}, { waitForEditor: false })
    assert.equal(sel.text, 'FROM-B', 'vscode.* 请求必须送到最后连接的编辑器')
  } finally {
    await cleanup()
  }
})

test('★回归（R1）：当前目标断开后回退到次新连接（仍按连接序号）', async () => {
  const { svc, server, handle, editors, cleanup } = await withKit(['FROM-A', 'FROM-B', 'FROM-C'])
  const [a, b, c] = editors
  try {
    // 三条全准入，顺序无所谓：目标只认 connSeq。
    for (const e of [c, a, b]) await e.link.request('bridge.ping', {})
    for (const e of [c, a, b]) await announce(e) // 过版本门（都声明 v1）
    assert.equal(handle.kit._activeLink(), c.serverLink, '目标应是最后连接的 C')
    assert.equal((await svc.request('vscode.getSelection', {}, { waitForEditor: false })).text, 'FROM-C')

    await c.close()
    await waitFor(() => !server.trusted.has(c.serverLink), 2000, 'C 断开后应移出 trusted')
    assert.equal(handle.kit._activeLink(), b.serverLink, 'C 断开后应回退到次新的 B')
    assert.equal((await svc.request('vscode.getSelection', {}, { waitForEditor: false })).text, 'FROM-B')

    await b.close()
    await waitFor(() => !server.trusted.has(b.serverLink), 2000, 'B 断开后应移出 trusted')
    assert.equal(handle.kit._activeLink(), a.serverLink, 'B 断开后应回退到最早的 A（仍按序号，不是轮转）')
    assert.equal((await svc.request('vscode.getSelection', {}, { waitForEditor: false })).text, 'FROM-A')

    await a.close()
    await waitFor(() => !server.trusted.has(a.serverLink), 2000, 'A 断开后应移出 trusted')
    assert.equal(handle.kit._activeLink(), null, '全部断开后不得回退到 links 里的残留连接')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 回归（评审 S1）：启动空窗期准入、随后又断线的连接不能唤醒等待者。
// src/index.js 的 pendingAuthorized 补通知分支无法通过公开 API 稳定复现
// （listen 到 kit 装配之间只有微任务，测试进程插不进去），所以该分支被提取成
// 可单测的 replayPendingAuthorized；删掉 `trusted.has` 判断或删掉 clear() 都会红。
// ─────────────────────────────────────────────────────────────────────────────
test('回归（S1）：启动空窗期准入后断线的连接被跳过，pending 仍清空', () => {
  const stillAlive = { connSeq: 1 }
  const droppedDuringStartup = { connSeq: 2 }
  const server = { trusted: new Set([stillAlive]) } // 断线者已被移出 trusted
  const pendingAuthorized = new Set([stillAlive, droppedDuringStartup])
  const notified = []
  replayPendingAuthorized(server, pendingAuthorized, (link) => notified.push(link))

  assert.deepEqual(notified, [stillAlive], '断线连接不许被唤醒（消费者会拿到死连接）')
  assert.equal(pendingAuthorized.size, 0, 'pendingAuthorized 必须清空，不能留到下次装配')
})

test('安全回归：裸连接（不带 token、不发消息）抢不到 active 位', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)

  // 攻击者：裸 socket，不认识协议库，一个字节都不发
  const attacker = createConnection({ port: handle.kit.server.port, host: '127.0.0.1' })
  await new Promise((r, j) => { attacker.once('connect', r); attacker.once('error', j) })
  await new Promise((r) => setTimeout(r, 60))

  assert.equal(handle.kit.server.links.size, 1, '连接仍应登记（close 要靠它销毁 socket）')
  const link = [...handle.kit.server.links][0]
  assert.equal(link.authorized, false, '没通过 token 校验的连接必须是未准入')
  assert.equal(handle.kit._activeLink(), null, '未准入连接不许当 active')

  // 消费者要能力时应当得到「没有编辑器」，而不是把请求发给攻击者
  await assert.rejects(
    svc.request('vscode.getSelection', {}, { waitForEditor: false }),
    (e) => e.code === ERR.DISCONNECTED,
  )

  attacker.destroy()
  ctx.runDisposers()
  await handle.stopped
  rmSync(home, { recursive: true, force: true })
})

test('安全回归：带错 token 的连接也不算准入', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)

  const editor = await fakeEditor(handle.kit.server, { bypassToken: 'not-the-real-token' })
  // 用错 token 发一条请求：服务端会拒 -32001，但连接本身不断（协议 §3.3）
  await assert.rejects(
    editor.link.request('bridge.ping', {}),
    (e) => e.code === ERR.UNAUTHORIZED,
  )
  await new Promise((r) => setTimeout(r, 60))

  const links = [...handle.kit.server.links]
  assert.equal(links.length, 1)
  assert.equal(links[0].authorized, false, 'token 错的连接不许被准入')
  assert.equal(handle.kit._activeLink(), null)

  editor.socket.destroy()
  ctx.runDisposers()
  await handle.stopped
  rmSync(home, { recursive: true, force: true })
})

test('安全回归：真编辑器准入后抢位失败（active 位只认 token 通过者）', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)

  // 1) 真编辑器先来并报身份 → 准入
  const editor = await fakeEditor(handle.kit.server, {
    onRequest: (method) => (method === 'vscode.getSelection' ? fakeSelection('REAL') : undefined),
  })
  await editor.link.request('bridge.ping', {})
  assert.equal([...handle.kit.server.links][0].authorized, true, 'token 通过即准入')
  // 报身份带协议版本：否则兼容门按「未知版本」拒绝，这条用例要验的是抢位不是版本门。
  await editor.link.request('bridge.hello', {
    client: 'real-editor', extensionVersion: '0.1.0', protocolVersion: 1, capabilities: [],
  })

  // 2) 攻击者随后裸连 —— 它是「最后连上的」，但没准入
  const attacker = createConnection({ port: handle.kit.server.port, host: '127.0.0.1' })
  await new Promise((r, j) => { attacker.once('connect', r); attacker.once('error', j) })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(handle.kit.server.links.size, 2, '两条连接都在册')
  const [realLink, attackerLink] = handle.kit.server.links
  assert.deepEqual([...handle.kit.server.trusted], [realLink], '目标集合必须只含真实准入者')
  assert.equal(handle.kit._activeLink(), realLink, 'active 必须是已准入的那条')
  // 即使有人误把诊断标志位改成 true，也不能让连接进入目标集合。
  attackerLink.authorized = true
  assert.equal(handle.kit._activeLink(), realLink, '目标选择不能依赖可写的 authorized 标志')
  assert.equal(handle.kit.server.trusted.has(attackerLink), false)

  // 3) 请求必须落到真编辑器，不能被攻击者截走
  const sel = await svc.request('vscode.getSelection', {}, { waitForEditor: false })
  assert.equal(sel.text, 'REAL', '结果必须来自真编辑器')

  attacker.destroy()
  await editor.close()
  assert.equal(handle.kit.server.trusted.size, 0, '编辑器断开后须移出目标集合')
  assert.equal(handle.kit._activeLink(), null)
  ctx.runDisposers()
  await handle.stopped
  rmSync(home, { recursive: true, force: true })
})

test('无编辑器连接时 request 得到结构化 -32007，不静默挂起', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 100, onLog: () => {} })
  await handle.boot
  const svc = boundSvc(ctx)

  await assert.rejects(
    svc.request('vscode.openFile', { path: 'x' }),
    (e) => e.code === ERR.DISCONNECTED && /no editor connected/.test(e.message),
  )
  ctx.runDisposers()
  rmSync(home, { recursive: true, force: true })
})

test('enabled:false 只注册服务不监听，request 得到 server-not-ready', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, enabled: false, onLog: () => {} })
  const svc = boundSvc(ctx)
  assert.equal(svc.ready, false)
  assert.equal(await svc.waitReady(100), false, 'enabled:false 时 waitReady 必须超时返回 false，不许挂住')
  await assert.rejects(
    svc.request('vscode.openFile', {}),
    (e) => e.code === ERR.DISCONNECTED && e.data?.reason === 'server-not-ready',
  )
  rmSync(home, { recursive: true, force: true })
})

/**
 * 回归锁：`ctx.provide` 的第三参数 check 是 get 时的门禁，**不是**就绪通知。
 * cordis 里 check 返回 false 只会把实现从 store 删掉，谓词变真之后没有任何机制
 * 重新 notify 等待者 —— 消费者会永久 pending。
 * 真机踩过：`dsh: warning: 1 entry did not activate` + `waiting for services`。
 */
test('provide 不得传 check 谓词（否则异步就绪的消费者永久 pending）', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 100, onLog: () => {} })
  const entry = ctx.provided.get('dshVscodeKit')
  assert.ok(entry, '服务必须注册')
  assert.equal(entry.check, undefined, 'provide 不应带 check，否则监听未就绪时消费者永远拿不到服务')
  // 监听还没起来也必须能拿到可用的 facade（早到的消费者不许拿到 null）
  assert.equal(typeof entry.v.request, 'function')
  assert.equal(entry.v.ready, false)
  // ★ 糖衣方法必须稳定存在，且调用时给结构化错误而不是 TypeError。
  //   真机上 `kit.vscode.openFile is not a function` 就是这么来的。
  assert.equal(typeof entry.v.vscode.openFile, 'function')
  assert.equal(typeof entry.v.vscode.getSelection, 'function')
  await assert.rejects(
    entry.v.vscode.openFile({ path: 'x' }),
    (e) => e.code === ERR.DISCONNECTED && e.data?.reason === 'server-not-ready',
  )
  // waitReady：就绪后返回 true 且立即可重复调用。
  // 这里不断言「未就绪时返回 false」——bind 通常几毫秒就完成，那是时序竞态断言，
  // 未就绪分支的断言放在 enabled:false 的用例里（那种场景稳定未就绪）。
  await handle.boot
  assert.equal(await entry.v.waitReady(1000), true)
  assert.equal(await entry.v.waitReady(0), true, '已就绪时 waitReady 应立即 true')
  ctx.runDisposers()
  await handle.stopped
  rmSync(home, { recursive: true, force: true })
})
