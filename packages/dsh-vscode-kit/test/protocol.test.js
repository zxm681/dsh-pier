import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connect,
  createLineSplitter,
  hasCapability,
  BridgeError,
  ERR,
  ERR_NAME,
  PROTOCOL_VERSION,
} from '../src/protocol.js'

/** 造一个 capture writer：写入的每一行都存进数组。 */
function capture() {
  const lines = []
  const write = (line) => { lines.push(JSON.parse(line)) }
  return { lines, write }
}

test('协议版本是 2（A2 整版升版）', () => {
  assert.equal(PROTOCOL_VERSION, 2)
})

test('请求-响应配对：并发 100 个请求按 id 正确路由', async () => {
  const { lines, write } = capture()
  const c = connect({ write })
  const promises = []
  for (let i = 0; i < 100; i++) promises.push(c.request('echo', { i }))
  assert.equal(c.pendingCount, 100)

  // 乱序回包
  const ids = lines.map((l) => l.id).reverse()
  for (const id of ids) {
    const req = lines.find((l) => l.id === id)
    c.handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: { echo: req.params.i } }))
  }

  const results = await Promise.all(promises)
  assert.equal(c.pendingCount, 0)
  for (let i = 0; i < 100; i++) assert.ok(results.some((r) => r.echo === i))
})

test('错误响应转成 BridgeError 并保留 code/data', async () => {
  const { lines, write } = capture()
  const c = connect({ write })
  const p = c.request('vscode.openFile', { path: 'x' })
  const { id } = lines[0]
  c.handleLine(JSON.stringify({
    jsonrpc: '2.0', id,
    error: { code: ERR.NOT_FOUND, message: 'file missing', data: { path: 'x' } },
  }))
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, ERR.NOT_FOUND)
    assert.equal(err.message, 'file missing')
    assert.deepEqual(err.data, { path: 'x' })
    return true
  })
})

test('超时：到点 reject TIMEOUT，且迟到响应被静默丢弃', async () => {
  const { lines, write } = capture()
  const c = connect({ write, timeoutMs: 20 })
  const p = c.request('slow', {})
  const { id } = lines[0]
  await assert.rejects(p, (err) => err.code === ERR.TIMEOUT)
  assert.equal(c.pendingCount, 0)
  // 迟到响应不应抛出、不应产生新状态
  assert.doesNotThrow(() => c.handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: 'late' })))
})

test('close 会拒绝全部待决请求，之后 send 静默丢弃', async () => {
  const { lines, write } = capture()
  const c = connect({ write })
  const a = c.request('a', {})
  const b = c.request('b', {})
  c.close('test shutdown')
  assert.equal(c.closed, true)
  assert.equal(c.pendingCount, 0)
  await assert.rejects(a, (e) => e.code === ERR.DISCONNECTED && e.message === 'test shutdown')
  await assert.rejects(b, (e) => e.code === ERR.DISCONNECTED)
  await assert.rejects(c.request('c', {}), (e) => e.code === ERR.DISCONNECTED)
  assert.equal(lines.length, 2) // 只有最初两条
})

test('入站请求由 onRequest 处理并回包（双向调用）', async () => {
  const { lines, write } = capture()
  const c = connect({
    write,
    onRequest: (method, params) => {
      if (method === 'ping') return { pong: params.n }
      throw new BridgeError(ERR.METHOD_NOT_FOUND, 'nope')
    },
  })
  c.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: { n: 42 } }))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(lines[0], { jsonrpc: '2.0', id: 7, result: { pong: 42 } })

  c.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'unknown' }))
  await new Promise((r) => setImmediate(r))
  assert.equal(lines[1].id, 8)
  assert.equal(lines[1].error.code, ERR.METHOD_NOT_FOUND)
  assert.equal(lines[1].error.message, 'nope')
})

test('入站请求抛普通 Error → 转 INTERNAL，不泄露栈', async () => {
  const { lines, write } = capture()
  const c = connect({ write, onRequest: () => { throw new Error('boom') } })
  c.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'x' }))
  await new Promise((r) => setImmediate(r))
  assert.equal(lines[0].error.code, ERR.INTERNAL)
  assert.equal(lines[0].error.message, 'boom')
  assert.equal(lines[0].error.data, undefined)
})

test('入站通知不回包', async () => {
  const { lines, write } = capture()
  let seen = null
  const c = connect({ write, onRequest: (m, p) => { seen = [m, p] } })
  c.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notify.me', params: { a: 1 } }))
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(seen, ['notify.me', { a: 1 }])
  assert.equal(lines.length, 0)
})

test('非法 JSON 不毒化连接，只上报', () => {
  const errors = []
  const c = connect({ write: () => {}, onError: (e) => errors.push(e) })
  c.handleLine('{not json')
  c.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }))
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, ERR.PARSE)
})

test('token 自动附加到出站请求', () => {
  const { lines, write } = capture()
  const c = connect({ write, token: 'secret-token' })
  c.request('x', {}).catch(() => {})
  assert.equal(lines[0].token, 'secret-token')
})

// ★ 安全性质：凭据必须是显式的。
// 曾经 notify() 无条件附加 token，导致服务端在对方证明身份前发出的第一条消息
// （bridge.hello）把通行证一起寄了出去。真机实测：任何人连上端口、什么都不发，
// 就能从 hello 里读到 token，然后冒充合法对端劫持调用并伪造返回值。
test('★ notify 默认不携带 token，必须显式 opts.withToken', () => {
  const { lines, write } = capture()
  const c = connect({ write, token: 'secret-token' })

  c.notify('plain.notice', { a: 1 })
  assert.ok(
    !Object.prototype.hasOwnProperty.call(lines[0], 'token'),
    '默认通知不许带 token',
  )

  c.notify('explicit.notice', { a: 2 }, { withToken: true })
  assert.equal(lines[1].token, 'secret-token', '显式要求时才带')
})

test('★ respond 默认不携带 token，必须显式 opts.withToken', () => {
  const { lines, write } = capture()
  const c = connect({ write, token: 'secret-token' })

  c.respond(1, { ok: true })
  assert.ok(
    !Object.prototype.hasOwnProperty.call(lines[0], 'token'),
    '默认响应不许带 token',
  )

  c.respond(2, { ok: true }, { withToken: true })
  assert.equal(lines[1].token, 'secret-token', '显式要求时才带')
})

test('★ respondError 也不携带 token', () => {
  const { lines, write } = capture()
  const c = connect({ write, token: 'secret-token' })
  c.respondError(1, ERR.NOT_FOUND, 'nope')
  assert.ok(!Object.prototype.hasOwnProperty.call(lines[0], 'token'))
})

test('★ 真跑一遍：未认证连接收到的 hello 里没有 token', async () => {
  // 这条不走 capture()，走真实的 server + 真 socket，锁住「握手不泄露凭据」。
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createConnection } = await import('node:net')
  const { startBridgeServer } = await import('../src/server.js')

  const home = mkdtempSync(join(tmpdir(), 'dsh-kit-tok-'))
  const server = await startBridgeServer({ dshHome: home, sweep: false, dshVersion: '9.9.9' })
  try {
    const socket = createConnection({ port: server.port, host: '127.0.0.1' })
    await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no hello')), 2000)
      let buf = ''
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const i = buf.indexOf('\n')
        if (i < 0) return
        clearTimeout(timer)
        resolve(JSON.parse(buf.slice(0, i)))
      })
    })
    assert.equal(hello.method, 'bridge.hello')
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hello, 'token'),
      `hello 泄露了 token：${String(hello.token).slice(0, 12)}…`,
    )
    // 顺带确认这条连接确实没带 token —— 它就是「纯攻击者视角」
    socket.destroy()
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('分帧：半行拼接、多行一次 chunk、CRLF 兼容', () => {
  const got = []
  const feed = createLineSplitter((l) => got.push(l))
  feed('{"a":1}\n{"b"')
  assert.deepEqual(got, ['{"a":1}'])
  feed(':2}\n{"c":3}\r\n')
  assert.deepEqual(got, ['{"a":1}', '{"b":2}', '{"c":3}'])
})

test('分帧：空行被忽略', () => {
  const got = []
  const feed = createLineSplitter((l) => got.push(l))
  feed('\n\n  \n{"x":1}\n')
  assert.deepEqual(got, ['{"x":1}'])
})

test('分帧：对端不换行导致缓冲区超限时报错', () => {
  const feed = createLineSplitter(() => {})
  assert.throws(() => feed('x'.repeat(8 * 1024 * 1024 + 1)), (e) => e.code === ERR.PARSE)
})

test('hasCapability 支持方法名与命名空间前缀', () => {
  assert.equal(hasCapability(['vscode.openFile'], 'vscode.openFile'), true)
  assert.equal(hasCapability(['vscode'], 'vscode.openFile'), true)
  assert.equal(hasCapability(['vscode.openFile'], 'vscode.getSelection'), false)
  assert.equal(hasCapability([], 'vscode.openFile'), false)
  assert.equal(hasCapability(null, 'vscode.openFile'), false)
})

test('每个错误码都有稳定诊断串', () => {
  for (const code of Object.values(ERR)) {
    assert.equal(typeof ERR_NAME[code], 'string', `missing ERR_NAME for ${code}`)
  }
})
