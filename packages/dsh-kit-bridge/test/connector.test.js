/**
 * connector 端到端测试：真 TCP + 真 kit server（DSH 侧）+ 假 VS Code 宿主。
 *
 * 这是打样最关键的一条测试 —— 它横穿四段式链路的全部四段：
 *   消费者式调用 → kit server（DSH 侧）→ loopback TCP → connector（编辑器侧）→ 假宿主能力
 * 除了 vscode API 本身，其余全是真实实现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startBridgeServer } from '../../dsh-vscode-kit/src/server.js'
import { ERR, PROTOCOL_VERSION } from '../../dsh-vscode-kit/src/protocol.js'
import { createCapabilities, CAPABILITIES } from '../src/capabilities.js'
import { createConnector, CLIENT_ID, EXTENSION_VERSION } from '../src/connector.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-conn-'))
}

/** 假 VS Code 宿主（与 capabilities.test.js 同形状）。 */
function fakeHost() {
  const calls = []
  return {
    calls,
    fileExists: () => true,
    resolvePath: (p) => (p.startsWith('/') ? p : `/ws/${p}`),
    workspaceRoots: () => ['/ws'],
    // A2（T62）：本桥接**没有同源变更观察器就不许写**（observation-gap）。这些用假宿主
    // 的用例关心的是别的东西（编辑语义 / 锚点 / 删除），所以给一个"什么都不发生"的真实
    // 观察器：宿主确实实现了这个口，只是这个假宿主永远不报变更。
    observeTextChanges: () => ({ dispose() {} }),
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

/** 起一个 kit server，返回 {server, stop, requests}。 */
async function startServer(home, { onRequestExtra } = {}) {
  const requests = []
  const server = await startBridgeServer({
    dshHome: home,
    dshVersion: '0.2.1-rc.2',
    capabilities: ['bridge.ping', 'bridge.hello'],
    portRange: [7540, 7549],
    onRequest: (method, params) => {
      requests.push({ method, params })
      if (onRequestExtra) return onRequestExtra(method, params)
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'bridge.hello') return { ok: true, protocolVersion: PROTOCOL_VERSION }
      throw new Error(`unexpected ${method}`)
    },
  })
  return { server, requests, stop: () => server.close() }
}

/** 等 connector 进入某状态（带上限，避免测试挂死）。 */
function waitFor(fn, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
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

test('connector 发现发现文件、连上、完成握手并上报身份', async () => {
  const home = tempHome()
  const { server, requests, stop } = await startServer(home)
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  const states = []
  const conn = createConnector({
    dispatch, dshHome: home, pollIntervalMs: 20,
    onStateChange: (s) => states.push(s.state),
  })
  try {
    await conn.reconnect()
    assert.equal(conn.connected, true, 'connector should be ready after reconnect')
    assert.ok(states.includes('connecting') && states.includes('ready'))

    // connector 连上后主动发 bridge.hello，服务端应收到身份
    await waitFor(() => requests.some((r) => r.method === 'bridge.hello'), { label: 'hello' })
    const hello = requests.find((r) => r.method === 'bridge.hello')
    assert.equal(hello.params.client, CLIENT_ID)
    assert.equal(hello.params.extensionVersion, EXTENSION_VERSION)
    // 断言「hello 带上声明清单」而不是硬编码全等 —— 硬编码会让每加一个能力都要改测试，
    // 而测试要锁的是「capabilities 被正确传过去」这个行为，不是清单本身的快照。
    assert.deepEqual(hello.params.capabilities, CAPABILITIES)
    assert.ok(CAPABILITIES.includes('vscode.openFile'))

    // 反向：connector → DSH 侧的 ping（证明双向调用都通）
    const pong = await conn.request('bridge.ping', { n: 1 })
    assert.equal(pong.pong, true)
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH 侧请求 vscode.getSelection → connector 经假宿主返回真实选区', async () => {
  const home = tempHome()
  const { server, stop } = await startServer(home)
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    // reconnect() 返回只代表客户端 socket 已连上；服务端 'connection' 事件可能稍后到。
    await waitFor(() => server.links.size > 0, { label: 'server registers link' })
    // DSH 侧向已连接的编辑器发请求（server.links 里唯一那条）
    const [link] = [...server.links]
    assert.ok(link, 'server should have one connected editor')
    const sel = await link.request('vscode.getSelection', {})
    assert.equal(sel.text, 'picked')
    assert.equal(sel.file, '/ws/a.js')
    assert.deepEqual(sel.start, { line: 1, column: 3 }, '1-based 对外坐标')
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH 侧请求 vscode.openFile → 假宿主的 openTextDocument 被调用', async () => {
  const home = tempHome()
  const { server, stop } = await startServer(home)
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    await waitFor(() => server.links.size > 0, { label: 'server registers link' })
    const [link] = [...server.links]
    const r = await link.request('vscode.openFile', { path: 'a.txt', line: 3 })
    assert.deepEqual(r, { opened: true, path: '/ws/a.txt', mode: 'text' })
    const call = host.calls.find((c) => c[0] === 'openTextDocument')
    assert.deepEqual(call[2], { line: 2, column: 0, preview: false })
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH 侧请求未实现能力 → 编辑器回 -32005，不是断连', async () => {
  const home = tempHome()
  const { server, stop } = await startServer(home)
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    await waitFor(() => server.links.size > 0, { label: 'server registers link' })
    const [link] = [...server.links]
    await assert.rejects(link.request('vscode.diff', {}),
      (e) => e.code === ERR.UNSUPPORTED)
    // 连接仍然可用
    const sel = await link.request('vscode.getSelection', {})
    assert.equal(sel.text, 'picked')
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('无 DSH 实例时保持 idle，不抛错不挂死', async () => {
  const home = tempHome()  // 空目录，没有任何发现文件
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    assert.equal(conn.connected, false)
    assert.equal(conn.state.state, 'idle')
    await assert.rejects(conn.request('bridge.ping', {}),
      (e) => e.code === ERR.DISCONNECTED)
  } finally {
    conn.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('DSH 侧关闭后 connector 自动回到 idle（断线感知）', async () => {
  const home = tempHome()
  const { server, stop } = await startServer(home)
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    assert.equal(conn.connected, true)
    await stop()
    await waitFor(() => !conn.connected, { label: 'disconnect detection' })
    assert.equal(conn.state.state, 'idle')
  } finally {
    conn.stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('多实例仲裁：连 startedAt 最新的那个', async () => {
  const home = tempHome()
  const older = await startServer(home)
  // 保证 startedAt 有差异（发现文件按 ms 记时间）
  await new Promise((r) => setTimeout(r, 15))
  const newer = await startServer(home)
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    assert.equal(conn.connected, true)
    assert.equal(conn.state.port, newer.server.port, 'should connect to the newest instance')
    assert.notEqual(conn.state.port, older.server.port)
  } finally {
    conn.stop()
    await older.stop()
    await newer.stop()
    rmSync(home, { recursive: true, force: true })
  }
})
