/**
 * 扩展侧对等自检（契约 §4.1 ②，错误码 -32008 protocol-incompatible）的守门测试。
 *
 * 为什么要单独造一个假 DSH：`startBridgeServer` 的 hello 里 ptv 固定是真版本，
 * 造不出「对端是 v2 / 对端没报 ptv / 对端还没报」这三种场景。这里用裸 TCP 假 DSH
 * （+ 一张真发现名片）把三种对端都摆出来，验的是连接管理器的准入行为：
 *
 *   1. 兼容        → 状态 ready，DSH 的业务请求照常执行；
 *   2. 不兼容/未知 → 状态**不得**呈现为可用，业务请求回 -32008，宿主 dispatch 一次都不跑；
 *   3. 只豁免 bridge.*（协商通道），业务能力没有豁免。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ERR, createLineSplitter } from '../../dsh-vscode-kit/src/protocol.js'
import { discoveryDir, writeDiscoveryFile } from '../../dsh-vscode-kit/src/discovery.js'
import { createCapabilities } from '../src/capabilities.js'
import { createConnector } from '../src/connector.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-gate-ext-'))
}

function fakeHost() {
  const calls = []
  return {
    calls,
    fileExists: () => true,
    resolvePath: (p) => (p.startsWith('/') ? p : `/ws/${p}`),
    workspaceRoots: () => ['/ws'],
    isTrusted: () => true,
    openTextDocument: async (p, o) => { calls.push(['openTextDocument', p, o]) },
    openExternalFile: async (p) => { calls.push(['openExternalFile', p]) },
    activeEditor: () => ({
      file: '/ws/a.js', text: 'picked', start: { line: 0, character: 2 },
      end: { line: 1, character: 0 }, isEmpty: false,
    }),
    log: () => {},
  }
}

/**
 * 假 DSH：连上就发 hello（可延迟、可缺 ptv、可用任意 ptv），并应答入站请求。
 *
 * `methods` 记下它**实际收到**的每个方法名 —— 业务方法有没有漏过来就看它。
 */
async function fakeDsh({ token = 'x'.repeat(64), ptv = 1, includePtv = true, helloDelayMs = 0 } = {}) {
  const methods = []
  const responses = []
  let connections = 0
  const sockets = new Set()
  const server = createServer((sock) => {
    connections += 1
    const connIndex = connections
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
    sock.on('error', () => {})
    const send = (obj) => { if (!sock.destroyed && sock.writable) sock.write(`${JSON.stringify({ token, ...obj })}\n`) }
    const sendHello = () => {
      const params = { client: 'dsh-vscode-kit', dshVersion: '9.9.9-test', capabilities: ['bridge.ping'] }
      if (includePtv) params.protocolVersion = typeof ptv === 'function' ? ptv(connIndex) : ptv
      send({ method: 'bridge.hello', params })
    }
    if (helloDelayMs > 0) setTimeout(sendHello, helloDelayMs)
    else sendHello()
    const feed = createLineSplitter((line) => {
      const msg = JSON.parse(line)
      // 客户端（扩展）回的应答：id 有、method 没有
      if (msg.id !== undefined && msg.method === undefined) { responses.push(msg); return }
      if (msg.method === undefined || msg.id === undefined) return
      methods.push(msg.method)
      send({ id: msg.id, result: { done: msg.method } })
    })
    sock.on('data', (chunk) => { try { feed(chunk) } catch { /* 忽略坏帧 */ } })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return {
    port, token, methods, responses,
    get connections() { return connections },
    close() {
      for (const s of sockets) { try { s.destroy() } catch { /* ignore */ } }
      return new Promise((r) => server.close(r))
    },
  }
}

/** 写一张发现名片（pid 用当前进程，保证 listLiveBridges 认它活着）。 */
function announceBridge(home, { port, token, pid = process.pid }) {
  return writeDiscoveryFile(discoveryDir(home), {
    pid, port, token, dshVersion: '9.9.9-test', startedAt: Date.now(),
  })
}

/** 等条件成立（带上限，避免测试挂死）。 */
function waitFor(fn, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve() }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(iv); reject(new Error(`timed out waiting for ${label}`))
      }
    }, intervalMs)
    iv.unref?.()
  })
}

async function setup(opts = {}) {
  const home = tempHome()
  const dsh = await fakeDsh(opts)
  announceBridge(home, dsh)
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  const states = []
  const logs = []
  const conn = createConnector({
    dispatch,
    dshHome: home,
    pollIntervalMs: 20,
    onStateChange: (s) => states.push(s.state),
    log: (m, l) => logs.push(`${l ?? 'info'}:${m}`),
    // 评审 F3：注入点可选 —— 用来证明「门排在它前面」
    ...(opts.onRequest ? { onRequest: opts.onRequest } : {}),
  })
  await conn.reconnect()
  await waitFor(() => dsh.connections > 0, { label: 'fake DSH sees connection' })
  const cleanup = async () => {
    conn.stop()
    await dsh.close()
    rmSync(home, { recursive: true, force: true })
  }
  return { conn, dsh, host, states, logs, cleanup }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 兼容：对端声明 v1 → 一切照旧
// ─────────────────────────────────────────────────────────────────────────────
test('对端 hello 声明 ptv=1 → 判定兼容，业务能力正常执行', async () => {
  const { conn, dsh, host, cleanup } = await setup({ ptv: 1 })
  try {
    await waitFor(() => conn.peer.status === 'compatible', { label: 'compatible' })
    assert.equal(conn.connected, true, '兼容时仍是可用状态')
    assert.equal(conn.peer.protocolVersion, 1)
    assert.equal(conn.state.state, 'ready')

    // 出站：协议层方法（自证通道可用）
    assert.deepEqual(await conn.request('bridge.ping', {}), { done: 'bridge.ping' })
    await waitFor(() => dsh.methods.includes('bridge.hello'), { label: 'hello reached DSH' })

    // 入站：带正确 token 的业务请求，兼容时应当真被执行（宿主被调用）
    conn._handleLine(`${JSON.stringify({
      token: dsh.token, id: 11, method: 'vscode.openFile', params: { path: 'a.txt' },
    })}
`)
    await waitFor(() => host.calls.some((c) => c[0] === 'openTextDocument'),
      { label: 'host called' })
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. 不兼容：整数越界 → 状态不得呈现为可用，业务能力 fail-closed
// ─────────────────────────────────────────────────────────────────────────────
test('对端 hello 声明 ptv=2 → 状态降为 incompatible，业务请求回 -32008 且不执行', async () => {
  const { conn, states, logs, cleanup } = await setup({ ptv: 2 })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'incompatible' })
    assert.equal(conn.connected, false, '不兼容时绝不能还报「可用」')
    assert.equal(conn.state.state, 'incompatible')
    assert.ok(states.includes('ready'), '连接建立时确实是 ready（这就是契约点名的隐患起点）')
    assert.ok(states.includes('incompatible'), '随后必须被降级，而不是留一个 log 了事')

    // 状态里带着结构化的 -32008（扩展侧上报口径）
    assert.equal(conn.state.error.code, ERR.PROTOCOL_INCOMPATIBLE)
    assert.deepEqual(conn.state.error.data.required, { min: 1, max: 1 })
    assert.equal(conn.state.error.data.peer, 2)
    assert.equal(conn.state.error.data.reason, 'out-of-range')
    assert.equal(conn.state.error.data.side, 'extension')
    assert.ok(logs.some((l) => l.includes('protocol-incompatible')), '必须留下可检索的日志')
    // 评审 F4：状态里要带 reason —— 状态栏原来是 `s.reason ?? '无'`，不给就显示「原因 无」。
    assert.equal(conn.state.reason, 'out-of-range', '状态栏要能直接显示原因，不许是「无」')

    // 出站业务请求同样拒（不兼容时一个业务方法都不该发出去）
    await assert.rejects(conn.request('vscode.getSelection', {}), (e) => {
      assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE)
      assert.equal(e.data.side, 'extension')
      assert.equal(e.data.method, 'vscode.getSelection')
      return true
    })
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 缺字段：不得推断成 v1
// ─────────────────────────────────────────────────────────────────────────────
test('对端 hello 缺 protocolVersion → 按不兼容处理（不得当成 v1）', async () => {
  const { conn, cleanup } = await setup({ includePtv: false })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'incompatible' })
    assert.equal(conn.peer.present, false, '要能区分「没有这个字段」')
    assert.equal(conn.peer.reason, 'missing')
    assert.equal(conn.connected, false)
    await assert.rejects(conn.request('vscode.openFile', { path: 'a' }),
      (e) => e.code === ERR.PROTOCOL_INCOMPATIBLE && e.data.reason === 'missing')
  } finally {
    await cleanup()
  }
})

test('对端 hello 的 ptv 非法（字符串）→ 按不兼容处理，且带上 peerType', async () => {
  const { conn, cleanup } = await setup({ ptv: '1' })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'incompatible' })
    assert.equal(conn.peer.present, true, '「有字段但值非法」要和「没字段」分开')
    assert.equal(conn.peer.reason, 'not-a-number')
    assert.equal(conn.peer.peerType, 'string')
    assert.equal(conn.connected, false)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. hello 尚未到达：未知版本，业务能力先关门（协商通道留开）
// ─────────────────────────────────────────────────────────────────────────────
test('hello 还没到 → 业务请求拒 -32008，bridge.* 仍可发（先把版本问出来）', async () => {
  const { conn, dsh, cleanup } = await setup({ ptv: 1, helloDelayMs: 400 })
  try {
    // 此刻链路已通但没有版本信息
    assert.equal(conn.state.state, 'ready')
    assert.equal(conn.peer.status, 'pending')

    await assert.rejects(conn.request('vscode.getSelection', {}), (e) => {
      assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE)
      assert.equal(e.data.reason, 'awaiting-hello')
      assert.equal(e.data.helloReceived, false)
      return true
    })
    // 协议层方法照发（否则版本永远协商不出来）
    const pong = await conn.request('bridge.ping', {})
    assert.deepEqual(pong, { done: 'bridge.ping' })

    // hello 到了之后放行
    await waitFor(() => conn.peer.status === 'compatible', { label: 'hello arrived' })
    assert.equal(conn.connected, true)
    assert.ok(dsh.methods.includes('bridge.ping'))
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. 入站业务能力：协议端口上真发过来时，不得执行宿主能力
// ─────────────────────────────────────────────────────────────────────────────
test('不兼容时 DSH 直接请求业务能力 → 回 -32008，宿主 dispatch 一次都没跑', async () => {
  const { conn, dsh, host, cleanup } = await setup({ ptv: 2 })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'incompatible' })
    // ★ token 必须给对：给错就变成「被鉴权挡掉」，测出来的 -32001 会替版本门背锅
    //   （初版就少了 token，结果门删掉测试照样绿 —— 典型假测试，铁律 9 抓出来的）。
    conn._handleLine(`${JSON.stringify({
      token: dsh.token, id: 7, method: 'vscode.openFile', params: { path: 'evil.txt' },
    })}\n`)
    await waitFor(() => dsh.responses.some((r) => r.id === 7), { label: 'response for id 7' })
    const resp = dsh.responses.find((r) => r.id === 7)
    assert.ok(resp.error, `必须回错误（实际 ${JSON.stringify(resp)}）`)
    assert.equal(resp.error.code, ERR.PROTOCOL_INCOMPATIBLE, '必须回 -32008，不是 -32005/-32601')
    assert.equal(resp.error.data.side, 'extension')
    assert.equal(resp.error.data.method, 'vscode.openFile')
    assert.deepEqual(host.calls, [], '版本不兼容时宿主能力一次都不许被调用')
    assert.equal(conn.peer.status, 'incompatible')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 重连 = 新一轮协商：上一轮的判定不得沿用
// ─────────────────────────────────────────────────────────────────────────────
test('重连后重新协商：对端换成 v1 就恢复可用（旧判定不沿用）', async () => {
  const { conn, dsh, cleanup } = await setup({ ptv: (n) => (n === 1 ? 2 : 1) })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'first negotiation' })
    assert.equal(conn.connected, false)

    await conn.reconnect()
    await waitFor(() => dsh.connections >= 2, { label: 'second connection' })
    await waitFor(() => conn.peer.status === 'compatible', { label: 'renotiated' })
    assert.equal(conn.connected, true, '对端升级后重连应恢复可用')
    assert.equal(conn.peer.protocolVersion, 1)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. ★ 评审 F3 回归：门必须跑在 onRequest 注入点**之前**
//
// 注入点是「谁先接走谁说了算」的设计（`custom !== undefined` 直接 return）。
// 门若排在它后面，将来往注入点挂业务方法就绕过了版本判定 —— 两条用例一正一反。
// ─────────────────────────────────────────────────────────────────────────────
test('★ F3 回归：不兼容时 onRequest 注入点接不走业务方法（门在前面，仍回 -32008）', async () => {
  const hijacked = []
  const { conn, dsh, cleanup } = await setup({
    ptv: 2,
    onRequest: (method) => { hijacked.push(method); return { hijacked: method } },
  })
  try {
    await waitFor(() => conn.peer.status === 'incompatible', { label: 'incompatible' })
    conn._handleLine(`${JSON.stringify({
      token: dsh.token, id: 21, method: 'vscode.openFile', params: { path: 'a.txt' },
    })}
`)
    await waitFor(() => dsh.responses.some((r) => r.id === 21), { label: 'response for id 21' })
    const resp = dsh.responses.find((r) => r.id === 21)
    assert.ok(resp.error, `注入点若先接走就会变成成功应答（实际 ${JSON.stringify(resp)}）`)
    assert.equal(resp.error.code, ERR.PROTOCOL_INCOMPATIBLE)
    assert.deepEqual(hijacked, [], '不兼容时注入点一次都不该被调用')
  } finally {
    await cleanup()
  }
})

test('★ F3 回归：兼容时 onRequest 注入点照常工作（只是顺序在门之后，没被废掉）', async () => {
  const { conn, dsh, cleanup } = await setup({
    ptv: 1,
    onRequest: (method) => (method === 'vscode.custom' ? { custom: true } : undefined),
  })
  try {
    await waitFor(() => conn.peer.status === 'compatible', { label: 'compatible' })
    conn._handleLine(`${JSON.stringify({
      token: dsh.token, id: 22, method: 'vscode.custom', params: {},
    })}
`)
    await waitFor(() => dsh.responses.some((r) => r.id === 22), { label: 'response for id 22' })
    const resp = dsh.responses.find((r) => r.id === 22)
    assert.equal(resp.error, undefined, `兼容时注入点应正常应答（实际 ${JSON.stringify(resp)}）`)
    assert.deepEqual(resp.result, { custom: true })
  } finally {
    await cleanup()
  }
})
