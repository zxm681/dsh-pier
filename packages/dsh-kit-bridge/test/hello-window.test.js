/**
 * W3（多窗口寻址 §6）：扩展侧 `bridge.hello` 里的 `window` 块。
 *
 * 这个块是**身份候选**，只有一个用途：让 DSH 签发 / 匹配 `windowId`。
 * 它不参与任何判定，因此这一组守的是三件事：
 *
 *  ① 有采集器时，字段**原样**带出去（不在扩展侧加工，加工就等于悄悄扩大上报面）；
 *  ② 没有采集器（老宿主 / 单测）时，hello **照发**、且 `window` 键**整个不出现**
 *     —— 不是 `window:null`。两种"没有"必须是同一种形状，否则 DSH 侧要写两套判断；
 *  ③ 采集器抛错时，hello **仍然发出去**。窗口身份拿不到不该把整次握手带崩：
 *     连不上意味着用户彻底没有编辑器支持，比"号退化成 tmp-1"严重得多。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PROTOCOL_VERSION } from '../../dsh-vscode-kit/src/protocol.js'
import { startBridgeServer } from '../../dsh-vscode-kit/src/server.js'
import { createCapabilities } from '../src/capabilities.js'
import { createConnector, CLIENT_ID, EXTENSION_VERSION } from '../src/connector.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-hello-'))
}

/** 假 VS Code 宿主（与 connector.test.js 同形状）。 */
function fakeHost() {
  return {
    fileExists: () => true,
    resolvePath: (p) => (p.startsWith('/') ? p : `/ws/${p}`),
    workspaceRoots: () => ['/ws'],
    // A2（T62）：本桥接**没有同源变更观察器就不许写**（observation-gap）。这些用假宿主
    // 的用例关心的是别的东西（编辑语义 / 锚点 / 删除），所以给一个"什么都不发生"的真实
    // 观察器：宿主确实实现了这个口，只是这个假宿主永远不报变更。
    observeTextChanges: () => ({ dispose() {} }),
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => ({
      file: '/ws/a.js', text: 'picked', start: { line: 0, character: 2 },
      end: { line: 1, character: 0 }, isEmpty: false,
    }),
    log: () => {},
  }
}

/** 起一个只认协商通道的 kit server，并把收到的请求记下来。 */
async function startServer(home) {
  const requests = []
  const server = await startBridgeServer({
    dshHome: home,
    dshVersion: '0.2.1-rc.2',
    capabilities: ['bridge.ping', 'bridge.hello'],
    portRange: [7540, 7549],
    onRequest: (method, params) => {
      requests.push({ method, params })
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'bridge.hello') return { ok: true, protocolVersion: PROTOCOL_VERSION }
      throw new Error(`unexpected ${method}`)
    },
  })
  return { server, requests, stop: () => server.close() }
}

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

const SAMPLE = {
  sessionId: 'sess-abc',
  workspace: { name: 'dsh-pier', folders: ['/ws/dsh-pier'] },
  uiKind: 1,
  remoteName: null,
}

test('★ W3 ①：hello 带 window 块，字段原样透传（扩展侧不加工、不判定）', async () => {
  const home = tempHome()
  const { server, requests, stop } = await startServer(home)
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({
    dispatch, dshHome: home, pollIntervalMs: 20, describeWindow: () => ({ ...SAMPLE }),
  })
  try {
    await conn.reconnect()
    await waitFor(() => requests.some((r) => r.method === 'bridge.hello'), { label: 'hello' })
    const hello = requests.find((r) => r.method === 'bridge.hello')

    assert.deepEqual(hello.params.window, SAMPLE, 'window 块必须原样到达（含 folders 顺序）')
    // 既有字段一个字都没变 —— W3 只加一块，不改协议。
    assert.equal(hello.params.client, CLIENT_ID)
    assert.equal(hello.params.extensionVersion, EXTENSION_VERSION)
    assert.equal(hello.params.protocolVersion, PROTOCOL_VERSION)
    assert.ok(Array.isArray(hello.params.capabilities))
    assert.equal(conn.connected, true)
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('★ W3 ②：没有采集器（老宿主）⇒ hello 照发，且 window 键整个不出现', async () => {
  const home = tempHome()
  const { server, requests, stop } = await startServer(home)
  const { dispatch } = createCapabilities(fakeHost())
  const conn = createConnector({ dispatch, dshHome: home, pollIntervalMs: 20 })
  try {
    await conn.reconnect()
    await waitFor(() => requests.some((r) => r.method === 'bridge.hello'), { label: 'hello' })
    const hello = requests.find((r) => r.method === 'bridge.hello')

    assert.equal('window' in hello.params, false, '拿不到就是"没有这个键"，不是 window:null')
    assert.equal(hello.params.client, CLIENT_ID, '其余字段照旧')
    assert.equal(conn.connected, true, '缺这一块不影响建连')
  } finally {
    conn.stop()
    await stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('★ W3 ③：采集器抛错 / 返回非对象 ⇒ hello 照发、window 缺席、连接仍 ready', async () => {
  for (const broken of [
    () => { throw new Error('vscode.env is gone') },
    () => null,
    () => 'not-an-object',
    () => ['nope'],
  ]) {
    const home = tempHome()
    const { server, requests, stop } = await startServer(home)
    const { dispatch } = createCapabilities(fakeHost())
    const conn = createConnector({
      dispatch, dshHome: home, pollIntervalMs: 20, describeWindow: broken,
    })
    try {
      await conn.reconnect()
      await waitFor(() => requests.some((r) => r.method === 'bridge.hello'), { label: 'hello' })
      const hello = requests.find((r) => r.method === 'bridge.hello')
      assert.equal('window' in hello.params, false, `${broken} 不该出现在 hello 里`)
      assert.equal(conn.connected, true, `${broken} 不该把握手带崩`)
    } finally {
      conn.stop()
      await stop()
      rmSync(home, { recursive: true, force: true })
    }
  }
})
