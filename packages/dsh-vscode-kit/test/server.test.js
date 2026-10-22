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
import { connect, createLineSplitter, ERR, PROTOCOL_VERSION } from '../src/protocol.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-test-'))
}

/** 哨兵：dial({token: NO_TOKEN}) 表示「本次连接不带 token」。 */
const NO_TOKEN = Symbol('no-token')

/** 等 socket 的 'close' 事件；用于断言 close() 真的断开了对端连接。 */
function onceClosed(socket) {
  return new Promise((resolve) => {
    if (socket.destroyed) { resolve('already-destroyed'); return }
    socket.once('close', () => resolve('closed'))
  })
}

/** 给「等某件事发生」的断言加超时，避免「永远不关闭」被当成通过。 */
function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ])
}

/**
 * 测试用「服务端记录对端身份」：把 hello 里的 `protocolVersion` 落到**这条连接自己**的
 * `link.editor` 上。
 *
 * 生产路径是 index.js 的 `handleInbound`（`msgCtx.link.editor = editor`）；裸 server 用例
 * 没有插件层，所以这里补一份最小等价物 —— 版本事实**必须挂在连接上**，因为
 * 版本门（server.js 的 `broadcast` / index.js 的 `_assertProtocolCompatible`）
 * 只认这一份，没有全局槽可退回（评审 F1/N1）。
 */
function recordHello(onRequest) {
  return (method, params, msgCtx) => {
    if (method === 'bridge.hello') {
      if (msgCtx?.link) {
        msgCtx.link.editor = {
          client: params?.client ?? 'unknown',
          protocolVersion: params?.protocolVersion,
          capabilities: Array.isArray(params?.capabilities) ? params.capabilities : [],
          seenAt: Date.now(),
        }
      }
      return { ok: true, protocolVersion: 1 }
    }
    return onRequest?.(method, params, msgCtx)
  }
}

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
          /**
           * 假编辑器上报身份（协议 §3.4）：hello 里的 `protocolVersion` 是版本门的唯一判据。
           *
           * ★ 评审 N1 之后，「假编辑器不报 hello」不再等于「可以收广播」：版本事实缺失
           *   的连接会被 `broadcast` 跳过（fail-closed）。所以凡是要收业务广播的用例，
           *   必须先让这个假编辑器把版本报出来 —— 补的是 fixture 事实，不是放宽断言。
           *   服务端侧落位由本文件的 `recordHello` 完成（生产路径见 index.js handleInbound）。
           *
           * @param {number|undefined} ptv 传 `undefined` = hello 里**不带**该字段（残缺对端）
           */
          hello(ptv, extra = {}) {
            const params = { client: 'fake-editor', extensionVersion: '0.1.0', capabilities: [], ...extra }
            if (ptv !== undefined) params.protocolVersion = ptv
            return link.request('bridge.hello', params)
          },
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

test('服务端向两个已准入连接广播通知', async () => {
  await withServer({ onRequest: recordHello(() => ({ ok: true })) }, async (server, { dial }) => {
    const a = await dial()
    const b = await dial()
    await a.next(); await b.next()
    // 两条连接都报了 v1（版本事实落在各自的 link.editor 上）——广播才允许投递。
    await a.hello(PROTOCOL_VERSION)
    await b.hello(PROTOCOL_VERSION)
    assert.equal(server.trusted.size, 2)
    const delivered = server.broadcast('vscode.selectionChanged', { text: 'hi' })
    assert.equal(delivered, 2, '两条兼容连接都该收到，返回值即投递计数')
    const [na, nb] = await Promise.all([a.next(), b.next()])
    assert.equal(na.method, 'vscode.selectionChanged')
    assert.deepEqual(nb.params, { text: 'hi' })
    await a.close(); await b.close()
  })
})

test('安全回归：未准入静默连接收不到广播内容（同连接收包栅栏，不靠固定窗口）', async () => {
  await withServer({ onRequest: recordHello(() => ({ ok: true })) }, async (server, { dial }) => {
    const real = await dial()
    const bare = await dial({ token: NO_TOKEN })
    await real.next(); await bare.next() // 建连 hello 不含 token，不能算准入。
    // real 先报版本：否则它也会被版本门跳过，这条用例就退化成空转。
    await real.hello(PROTOCOL_VERSION)
    assert.equal(server.links.size, 2)
    assert.equal(server.trusted.size, 1)
    server.broadcast('vscode.selectionChanged', { text: 'private-selection' })
    assert.deepEqual((await real.next()).params, { text: 'private-selection' })

    // ★ 栅栏（评审 S1）：以前用「bare.next(80) 必须超时」做负断言 —— 80ms 是固定
    //   观察窗，调度抖动时可能假绿。改成在**裸连接自己那条 socket** 上等一条已知消息：
    //   bare 发一条错 token 请求，服务端必定回 -32001。同 socket 是 FIFO，
    //   所以广播若曾写给 bare，必然排在这条拒绝之前，处理完请求后 inbox 就不可能为空。
    await assert.rejects(bare.link.request('ping', {}), (e) => e.code === ERR.UNAUTHORIZED)
    assert.equal(bare.inbox.length, 0,
      `未准入的静默 socket 收到了广播内容：${JSON.stringify(bare.inbox.map((m) => m.method))}`)
    await real.close(); await bare.close()
  })
})

// ★ 回归（评审 N1）：`broadcast()` 曾经完全绕过版本门 —— 只遍历 trusted 就 notify，
//   不兼容对端照样收到业务帧。这里锁住 server 层的两个性质：
//   ① 版本事实缺失的连接被**跳过**（fail-closed，不推断成 v1）；
//   ② 一条兼容连接都没有时**抛 -32008**，让调用方知道「发了但没人在听」，不许静默成功。
test('★ 回归 N1：版本事实缺失的连接不收广播，零兼容时抛 -32008', async () => {
  await withServer({ onRequest: recordHello(() => ({ ok: true })) }, async (server, { dial }) => {
    const c = await dial()
    await c.next() // 建连 hello（服务端 → 对端），不是对端上报身份
    await c.hello(undefined) // 对端 hello **不带** protocolVersion（残缺/旧版对端）
    assert.equal(server.trusted.size, 1)
    assert.equal(server.trusted.values().next().value.editor.protocolVersion, undefined,
      '前置：这条连接的版本事实确实是缺失的')

    assert.throws(
      () => server.broadcast('vscode.selectionChanged', { text: 'secret' }),
      (e) => {
        assert.equal(e.code, ERR.PROTOCOL_INCOMPATIBLE, `应为 -32008，实际 ${e.code}`)
        assert.deepEqual(e.data.required, { min: 1, max: 1 }, 'data.required 是兼容区间')
        assert.equal(e.data.peer, null, '版本缺失时 peer 归一为 null')
        assert.equal(e.data.reason, 'missing', '判定表：缺失 ≠ v1')
        assert.equal(e.data.method, 'vscode.selectionChanged')
        assert.equal(e.data.side, 'dsh')
        return true
      },
      '零兼容连接时广播不许静默成功',
    )

    // 栅栏：同 socket FIFO —— 广播若曾写给这条连接，必然排在这条协议请求的响应之前。
    await c.link.request('bridge.ping', {})
    assert.deepEqual(c.inbox.map((m) => m.method), [],
      `版本缺失的连接收到了广播：${JSON.stringify(c.inbox.map((m) => m.method))}`)
    await c.close()
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

test('trusted 在同步准入回调前升格，断开与关闭时均清空', async () => {
  const seen = []
  let activeServer
  await withServer({
    onAuthorized: (link) => {
      // 回调同步触发；等回调后才 add 会使此处可见集合仍为空。
      assert.equal(activeServer.trusted.has(link), true)
      seen.push(link)
    },
    onRequest: () => ({ ok: true }),
  }, async (server, { dial }) => {
    activeServer = server
    const real = await dial()
    const bare = await dial({ token: 'wrong' })
    await real.next(); await bare.next() // hello 已送达才可断言服务端收纳了两条连接。
    assert.equal(server.links.size, 2)
    assert.equal(server.trusted.size, 0)
    await assert.rejects(bare.link.request('ping', {}), (e) => e.code === ERR.UNAUTHORIZED)
    assert.equal(server.trusted.size, 0)
    await real.link.request('ping', {})
    assert.deepEqual([...server.trusted], seen, '准入通知和目标集合必须指向同一连接')
    assert.equal(seen.length, 1)

    // ★ 守门（评审 S1）：close() 时**同时**留下一条已准入连接和一条裸连接。
    //   旧写法先 real.close() 再 close()，届时 trusted 已空 —— 于是把 cleanup 里的
    //   trusted.clear() 删掉也能过，这条测试其实在睡觉。
    const closedBoth = Promise.all([onceClosed(real.socket), onceClosed(bare.socket)])
    const closing = server.close()
    // cleanup() 是在 close() 的 Promise 执行体里同步跑完的；此刻 socket 的 'close'
    // 事件还没派发，所以集合必须已被**显式**清空（只靠 close 事件兜底在这里过不去）。
    assert.equal(server.trusted.size, 0, 'close() 必须同步清空 trusted，不能只靠 socket close 事件')
    assert.equal(server.links.size, 0, 'close() 必须同步清空 links')
    await closing
    assert.deepEqual(
      await withTimeout(closedBoth, 2000, 'close() 没有关闭服务端已准入/裸连接的 socket'),
      ['closed', 'closed'],
    )
    assert.equal(server.closed, true)
  })
})

test('socket error 路径把连接同时移出 links 与 trusted', async () => {
  const errors = []
  await withServer({
    onRequest: () => ({ ok: true }),
    onError: (err) => errors.push(err),
  }, async (server, { dial }) => {
    const real = await dial()
    await real.next()
    await real.link.request('ping', {})
    assert.equal(server.trusted.size, 1)
    assert.equal(server.links.size, 1)

    const link = [...server.trusted][0]
    // 真机上这条分支由 ECONNRESET 触发；这里直接触发服务端 socket 的 'error'
    // 分支，避开「对端进程被杀」这种不可控时序。
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    link.socket.emit('error', reset)

    assert.equal(server.trusted.size, 0, 'error 路径必须把连接移出 trusted')
    assert.equal(server.links.size, 0, 'error 路径必须把连接移出 links')
    assert.deepEqual(errors.map((e) => e.code), ['ECONNRESET'], 'onError 必须收到原始错误')
    await real.close().catch(() => {})
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
