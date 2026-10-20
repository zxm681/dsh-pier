import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name, inject } from '../src/index.js'
import { ERR, connect, createLineSplitter } from '../src/protocol.js'
import { discoveryDir, listLiveBridges } from '../src/server.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-apply-'))
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
  const handle = apply(ctx, { dshHome: home, onLog: (l, m) => logs.push(`${l}:${m}`) })
  await handle.boot
  assert.equal(handle.disposed, false)

  // 服务已注册且就绪
  assert.ok(ctx.provided.has('dshVscodeKit'))
  const svc = ctx.provided.get('dshVscodeKit').v
  assert.equal(svc.ready, true)

  // 假编辑器：应答 vscode.getSelection
  const editor = await fakeEditor(handle.kit.server, {
    onRequest: (method, params) => {
      if (method === 'vscode.getSelection') return { status: 'ok', text: 'hello-from-vscode' }
      throw new Error(`unexpected method ${method}`)
    },
  })

  // 1) 编辑器收到 hello（协议 §3.4：每连接第一条消息）
  const hello = await editor.next()
  assert.equal(hello.method, 'bridge.hello')
  assert.equal(hello.params.protocolVersion, 1)

  // 2) 编辑器 → DSH 方向：bridge.ping 由 handleInbound 应答
  const pong = await editor.link.request('bridge.ping', { x: 1 })
  assert.equal(pong.pong, true)
  assert.deepEqual(pong.echo, { x: 1 })

  // 3) 消费者 → 编辑器方向：vscode.getSelection 转发并拿到假编辑器的返回
  const sel = await svc.request('vscode.getSelection')
  assert.deepEqual(sel, { status: 'ok', text: 'hello-from-vscode' })

  // 4) 糖衣等价
  const sel2 = await svc.vscode.getSelection()
  assert.deepEqual(sel2, sel)

  // 5) 编辑器报身份 → lastEditor 记录（能力降级判据）
  await editor.link.request('bridge.hello', {
    client: 'fake-editor', extensionVersion: '0.1.0', capabilities: ['vscode.getSelection'],
  })
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
 * 现在的口径：server.js 在 authorize 通过第一条 token 正确的消息时才置
 * `link.authorized = true`；`_activeLink()` 只在 authorized 连接里挑。
 * 下面三条按「没准入门 → 抢不到」的顺序钉住它。
 */
test('安全回归：裸连接（不带 token、不发消息）抢不到 active 位', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v

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
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v

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
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v

  // 1) 真编辑器先来并报身份 → 准入
  const editor = await fakeEditor(handle.kit.server, {
    onRequest: (method) => (method === 'vscode.getSelection' ? { text: 'REAL' } : undefined),
  })
  await editor.link.request('bridge.ping', {})
  assert.equal([...handle.kit.server.links][0].authorized, true, 'token 通过即准入')

  // 2) 攻击者随后裸连 —— 它是「最后连上的」，但没准入
  const attacker = createConnection({ port: handle.kit.server.port, host: '127.0.0.1' })
  await new Promise((r, j) => { attacker.once('connect', r); attacker.once('error', j) })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(handle.kit.server.links.size, 2, '两条连接都在册')
  assert.equal(handle.kit._activeLink()?.authorized, true, 'active 必须还是已准入的那条')

  // 3) 请求必须落到真编辑器，不能被攻击者截走
  const sel = await svc.request('vscode.getSelection', {}, { waitForEditor: false })
  assert.equal(sel.text, 'REAL', '结果必须来自真编辑器')

  attacker.destroy()
  await editor.close()
  ctx.runDisposers()
  await handle.stopped
  rmSync(home, { recursive: true, force: true })
})

test('无编辑器连接时 request 得到结构化 -32007，不静默挂起', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 100, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v

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
  apply(ctx, { dshHome: home, enabled: false, onLog: () => {} })
  const svc = ctx.provided.get('dshVscodeKit').v
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
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 100, onLog: () => {} })
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
