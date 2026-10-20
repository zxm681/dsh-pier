import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startBridgeServer,
  listLiveBridges,
  isProcessAlive,
  sweepDiscoveryDir,
  discoveryDir,
  resolveDshHome,
  writeDiscoveryFile,
  DEFAULT_PORT_RANGE,
} from '../src/server.js'
import { connect, createLineSplitter, ERR } from '../src/protocol.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-test-'))
}

/** 哨兵：dial({token: NO_TOKEN}) 表示「本次连接不带 token」。 */
const NO_TOKEN = Symbol('no-token')

/** 起一个 server 并返回一个已握手的客户端 link。 */
async function withServer(opts, fn) {
  const home = tempHome()
  const server = await startBridgeServer({ dshHome: home, ...opts })
  const sockets = []
  try {
    await fn(server, {
      home,
      /** 裸 TCP 客户端，返回 {link, socket, next(method), close} */
      async dial({ token: dialToken } = {}) {
        const socket = createConnection({ port: server.port, host: '127.0.0.1' })
        sockets.push(socket)
        const inbox = []
        const waiters = []
        const link = connect({
          write: (line) => socket.write(line),
          onRequest: opts?.onRequest,
          // 默认带正确 token；需要测未授权路径时用 dial({ token: 'wrong' }) 或 NO_TOKEN
          token: dialToken === NO_TOKEN ? undefined : (dialToken ?? server.token),
        })
        const feed = createLineSplitter((line) => {
          const msg = JSON.parse(line)
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            link.handleLine(line)
            return
          }
          // 有等待者就直接交给它，绝不能再入队——否则同一条消息会被消费两次
          const w = waiters.shift()
          if (w) w(msg)
          else inbox.push(msg)
        })
        socket.on('data', (chunk) => feed(chunk))
        await new Promise((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('error', reject)
        })
        return {
          link,
          socket,
          inbox,
          /** 等下一条通知（hello 等） */
          next(timeoutMs = 2000) {
            if (inbox.length) return Promise.resolve(inbox.shift())
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('next() timed out')), timeoutMs)
              waiters.push((msg) => { clearTimeout(timer); resolve(msg) })
            })
          },
          close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
        }
      },
    })
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
}

test('默认端口区间避开现有桥接的 7310-7319', () => {
  const [from, to] = DEFAULT_PORT_RANGE
  assert.ok(from > 7319, `${from} must be greater than 7319`)
  assert.ok(to >= from)
})

test('只监听 127.0.0.1，拒绝非 loopback 绑定', async () => {
  await assert.rejects(
    startBridgeServer({ dshHome: tempHome(), host: '0.0.0.0', sweep: false }),
    (e) => e.code === ERR.INTERNAL && /refusing to bind/i.test(e.message),
  )
})

test('启动后写发现文件，字段齐全且 0600', async () => {
  await withServer({ dshVersion: '0.2.1-rc.2', capabilities: ['vscode'] }, async (server, { home }) => {
    const dir = discoveryDir(home)
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 1)
    const info = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
    assert.equal(info.port, server.port)
    assert.equal(info.token, server.token)
    assert.equal(info.pid, process.pid)
    assert.equal(info.dshVersion, '0.2.1-rc.2')
    assert.deepEqual(info.capabilities, ['vscode'])
    assert.equal(info.protocolVersion, 1)
    assert.ok(info.startedAt > 0)
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs')
      assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600)
    }
  })
})

test('连接后立刻收到 bridge.hello，带协议版本与能力', async () => {
  await withServer({ dshVersion: '9.9.9', capabilities: ['vscode.openFile'] }, async (server, { dial }) => {
    const c = await dial()
    const hello = await c.next()
    assert.equal(hello.method, 'bridge.hello')
    assert.equal(hello.params.client, 'dsh-vscode-kit')
    assert.equal(hello.params.protocolVersion, 1)
    assert.equal(hello.params.dshVersion, '9.9.9')
    assert.deepEqual(hello.params.capabilities, ['vscode.openFile'])
    await c.close()
  })
})

// 回归：真机踩到过 —— hello 走 notify()，而 notify 当时无条件附加 token，
// 于是服务端在对方证明身份之前就把通行证寄出去了。任何人连上端口、什么都不发，
// 就能从 hello 里读到 token，再拿去冒充合法对端（实测可劫持调用并伪造返回值）。
// 这条断言锁的是**安全性质**，不是消息形状：hello 里永远不许出现 token。
test('★ hello 绝不携带 token（回归：通知默认附 token 导致白送凭证）', async () => {
  await withServer({}, async (server, { dial }) => {
    // 用 NO_TOKEN 哨兵模拟「完全未认证的连接」——它同样会收到 hello，
    // 这正是洞的入口：握手发生在鉴权之前。
    const c = await dial({ token: NO_TOKEN })
    const hello = await c.next()
    assert.equal(hello.method, 'bridge.hello')
    assert.ok(
      !Object.prototype.hasOwnProperty.call(hello, 'token'),
      `hello 不许带 token，实际带的是 ${String(hello.token).slice(0, 12)}…`,
    )
    // 连 params 里也不许夹带（防止有人换个位置继续泄露）
    assert.ok(
      !Object.values(hello.params ?? {}).some((v) => typeof v === 'string' && v === server.token),
      'hello.params 里不许出现 token 原文',
    )
    await c.close()
  })
})

test('多条连接互不干扰，各自独立收 hello', async () => {
  await withServer({}, async (server, { dial }) => {
    const a = await dial()
    const b = await dial()
    assert.equal((await a.next()).method, 'bridge.hello')
    assert.equal((await b.next()).method, 'bridge.hello')
    assert.equal(server.links.size, 2)
    await a.close()
    await b.close()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(server.links.size, 0)
  })
})

test('出站请求能拿到服务端 onRequest 的返回值', async () => {
  await withServer({
    onRequest: (method, params) => {
      if (method === 'echo') return { got: params }
      throw new Error('nope')
    },
  }, async (server, { dial }) => {
    const c = await dial()
    await c.next() // hello
    const res = await c.link.request('echo', { a: 1 })
    assert.deepEqual(res, { got: { a: 1 } })
    await assert.rejects(c.link.request('missing', {}), (e) => e.code === ERR.INTERNAL)
    await c.close()
  })
})

test('服务端可向所有连接广播通知', async () => {
  await withServer({}, async (server, { dial }) => {
    const a = await dial()
    const b = await dial()
    await a.next(); await b.next()
    server.broadcast('vscode.selectionChanged', { text: 'hi' })
    const [na, nb] = await Promise.all([a.next(), b.next()])
    assert.equal(na.method, 'vscode.selectionChanged')
    assert.deepEqual(nb.params, { text: 'hi' })
    await a.close(); await b.close()
  })
})

test('close() 删除发现文件并断开所有连接', async () => {
  const home = tempHome()
  const server = await startBridgeServer({ dshHome: home })
  const dir = discoveryDir(home)
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 1)
  await server.close()
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0)
  assert.equal(server.closed, true)
  rmSync(home, { recursive: true, force: true })
})

test('端口被占时自动顺延到下一个端口', async () => {
  const home = tempHome()
  const a = await startBridgeServer({ dshHome: home, portRange: [7420, 7421] })
  const b = await startBridgeServer({ dshHome: home, portRange: [7420, 7421] })
  try {
    assert.equal(a.port, 7420)
    assert.equal(b.port, 7421)
    assert.notEqual(a.token, b.token)
  } finally {
    await a.close(); await b.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('端口区间全满时报错而不是静默失败', async () => {
  const home = tempHome()
  const a = await startBridgeServer({ dshHome: home, portRange: [7430, 7430] })
  try {
    await assert.rejects(
      startBridgeServer({ dshHome: home, portRange: [7430, 7430] }),
      (e) => e.code === ERR.INTERNAL && /no free port/i.test(e.message),
    )
  } finally {
    await a.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('两个实例共存于同一 DSH_HOME，发现文件按 pid 分开', async () => {
  const home = tempHome()
  // 同 pid 会互相覆盖，所以这里只验证 listLiveBridges 能读到本进程的
  const server = await startBridgeServer({ dshHome: home })
  try {
    const live = listLiveBridges(discoveryDir(home))
    assert.ok(live.some((i) => i.port === server.port))
  } finally {
    await server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('死 pid 残留会被清扫，活的不动', () => {
  const home = tempHome()
  const dir = discoveryDir(home)
  // 找一个几乎肯定不存在的 pid
  const deadPid = 999999
  assert.equal(isProcessAlive(deadPid), false)
  writeDiscoveryFile(dir, { pid: deadPid, port: 1, token: 'x', startedAt: 1 })
  writeDiscoveryFile(dir, { pid: process.pid, port: 2, token: 'y', startedAt: 2 })
  const { removed, kept } = sweepDiscoveryDir(dir)
  assert.deepEqual(removed, [`${deadPid}.json`])
  assert.deepEqual(kept, [`${process.pid}.json`])
  assert.equal(listLiveBridges(dir).length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('损坏的发现文件被忽略而不是抛错', () => {
  const home = tempHome()
  const dir = discoveryDir(home)
  writeDiscoveryFile(dir, { pid: process.pid, port: 3, token: 'z', startedAt: 3 })
  writeFileSync(join(dir, '444444.json'), '{ broken')
  assert.doesNotThrow(() => listLiveBridges(dir))
  assert.equal(listLiveBridges(dir).length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('resolveDshHome 优先级：显式 > 环境变量 > ~/.dsh', () => {
  assert.equal(resolveDshHome('/explicit'), '/explicit')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/from-env'
  assert.equal(resolveDshHome(), '/from-env')
  delete process.env.DSH_HOME
  assert.match(resolveDshHome(), /\.dsh$/)
  if (prev !== undefined) process.env.DSH_HOME = prev
})

test('不带 token 的请求被拒 -32001（结构化，不静默挂起）', async () => {
  await withServer({}, async (server, { dial }) => {
    const c = await dial({ token: NO_TOKEN }) // 显式不带 token
    const hello = await c.next() // hello 是服务端主动下发，不需要 token
    assert.equal(hello.method, 'bridge.hello')
    await assert.rejects(
      c.link.request('vscode.getSelection', {}),
      (e) => e.code === -32001 && e.data?.reason === 'missing-token',
    )
    await c.close()
  })
})

test('token 错误的请求被拒 -32001 且 reason=bad-token', async () => {
  await withServer({}, async (server, { dial }) => {
    const c = await dial({ token: 'a'.repeat(64) })
    await c.next()
    await assert.rejects(
      c.link.request('vscode.openFile', { path: 'x' }),
      (e) => e.code === -32001 && e.data?.reason === 'bad-token',
    )
    await c.close()
  })
})

test('带正确 token 的请求通过鉴权', async () => {
  await withServer({
    onRequest: (method) => (method === 'ping' ? { ok: true } : undefined),
  }, async (server, { dial }) => {
    const c = await dial() // 默认带正确 token
    await c.next()
    assert.deepEqual(await c.link.request('ping', {}), { ok: true })
    await c.close()
  })
})

test('token 是 64 位 hex（32 字节熵）', async () => {
  await withServer({}, async (server) => {
    assert.match(server.token, /^[0-9a-f]{64}$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 洞 3 的攻击回归：未准入的连接能不能「冒充对端」把别人的请求答掉？
// 依据 docs/先例调研-鉴权放在哪一层.md §2（VS Code 只在建连时验一次凭证，
// 之后靠「这条 socket 已被信任」）。这里的假设是：pending 是 per-connect 的
// 闭包变量，两条 socket 各有一个 connect() 实例，所以响应天然不能串台。
// 假设必须用测试锁住 —— 把 pending 提到模块级、或让两条 socket 共用
// handleLine，这两条测试就会红（用变异测试验证过）。
// ─────────────────────────────────────────────────────────────────────────────

test('★安全回归（洞 3）：攻击者答不掉服务端发给真编辑器的请求', async () => {
  await withServer({}, async (server, { dial }) => {
    const real = await dial()
    await real.next() // 吃掉 hello
    // 发一条带正确 token 的请求，让服务端把这条连接标记为准入
    await real.link.request('noop', {}, { timeoutMs: 200 }).catch(() => {})

    const attacker = await dial({ token: 'f'.repeat(64) })
    await attacker.next()

    // links 是 Set，保持插入顺序
    const [realLink, attackerLink] = [...server.links]
    assert.ok(realLink && attackerLink, '两条连接都应在册')
    assert.equal(realLink.authorized, true)
    assert.equal(attackerLink.authorized, false, '错 token 的连接不该被标记为准入')

    // 洞 3 的攻击面：服务端 → 编辑器方向。真编辑器不回包，
    // 所以这条请求只能超时；期间攻击者用同一个 id 抢答。
    const pending = realLink.request('vscode.getSelection', {}, { timeoutMs: 250 })

    // ★ 不猜 id：真编辑器确实收到了这条请求，攻击者是「看到」它才谈得上抢答。
    //   （上一版硬编码 id=2 猜错了，变异测试暴露出那是条假测试。）
    const outbound = await real.next()
    assert.equal(outbound.method, 'vscode.getSelection')
    assert.ok(outbound.id !== undefined, '请求必须带 id')

    attacker.socket.write(JSON.stringify({
      jsonrpc: '2.0', id: outbound.id, result: { text: 'FAKE-FROM-ATTACKER' },
    }) + '\n')

    await assert.rejects(pending, (e) => {
      assert.ok(!JSON.stringify(e.data ?? {}).includes('FAKE'), '拿到了攻击者的伪造结果')
      return e.code === ERR.TIMEOUT
    }, '真编辑器的请求被攻击者的伪造响应完成了（洞 3 未闭合）')

    await attacker.close()
    await real.close()
  })
})

test('★安全回归（洞 3）：pending 表是每连接独立的（架构不变量直接断言）', async () => {
  await withServer({}, async (server, { dial }) => {
    const a = await dial()
    await a.next()
    const b = await dial({ token: 'f'.repeat(64) })
    await b.next()

    const [linkA, linkB] = [...server.links]
    assert.ok(linkA && linkB)
    assert.notEqual(linkA, linkB, '两条连接必须各有独立的协议终端')

    // A 上挂一个请求，B 的 pendingCount 必须仍然是 0 —— 一旦共用 pending 就会相等。
    // 先挂一个空 catch：断言失败时不留下未处理的 rejection 掩盖真正的错误。
    const pa = linkA.request('vscode.getSelection', {}, { timeoutMs: 120 })
    pa.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(linkA.pendingCount, 1, 'A 上应有一条挂起请求')
    assert.equal(linkB.pendingCount, 0, 'B 的 pending 被 A 污染了 —— pending 不是每连接独立的')
    await assert.rejects(pa, (e) => e.code === ERR.TIMEOUT)

    await b.close()
    await a.close()
  })
})
