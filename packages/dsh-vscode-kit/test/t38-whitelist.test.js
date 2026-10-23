/**
 * per-plugin 能力白名单（T38）—— 契约 §6.2.5 / §6.2.8 第 3 条。
 *
 * 这一组用例守的是「**谁**能调到**哪一档**」，按「改坏了会怎样」排序：
 *
 *  1. ★ 未绑定身份的消费者**调不动写**（`consumer-unbound`），且**零业务帧**出门 ——
 *     这是本次收口的那笔债（契约 §6 开头：拿到服务就能调任何 `vscode.*`）。
 *     断言里同时给了完整的写锚点，证明拦住它的是**白名单**而不是锚点门。
 *  2. ★ 白名单给到 `buffer-edit` 的插件**调不动删除类**方法（越档即拒）。
 *  3. ★ 只读四能力**在未声明身份时照样成功** —— 证明白名单没把只读误伤（兼容底线）。
 *
 * 反向（"测试在睡觉"）由 `node --test` 之外的一次**变异测试**证明：把档位比较改成恒真，
 * ①②③ 里 ①② 必须变红。见交付说明里的原始失败输出。
 *
 * 另有一类用例专门守"身份是入口决定的，不是调用方填的"：共享 facade 与绑定 facade
 * 都不接受 `opts.consumer` 自报（`forPlugin` 是唯一入口），否则白名单退化成一个可选参数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, TIERS, METHOD_TIERS, tierOf, UNBOUND_CONSUMER, HOST_CONSUMER } from '../src/index.js'
import { connect, createLineSplitter, ERR } from '../src/protocol.js'
import { judgeCall, normalizePolicy, minTier, isTier } from '../src/whitelist.js'

const FILE = '/ws/a.js'
const INC = 'inc-0001'
const RANGE = { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } }

/** 一条形状**完全合法**的写入请求（锚点给全 ⇒ 白名单是第一道能拦住它的门）。 */
const goodWrite = () => ({
  file: FILE, range: RANGE, text: 'hi', expectedVersion: 4, expectedIncarnation: INC,
})

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-whitelist-'))
}

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
 * 假编辑器：裸 TCP 连桥，记录**每一条**收到的帧（含通知），供"零业务帧"断言。
 * 与 editing-grant.test.js 的同名设施同构（各文件自带夹具是这个仓的既有做法）。
 */
async function fakeEditor(server) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'vscode.openFile') return { opened: true, path: params?.path ?? FILE, mode: 'text' }
      if (method === 'vscode.getSelection') {
        return {
          text: 'hi', file: FILE, start: { line: 1, column: 1 }, end: { line: 1, column: 3 }, isEmpty: false,
        }
      }
      if (method === 'vscode.getDiagnostics') return { total: 0, truncated: false, files: [] }
      if (method === 'vscode.listOpenEditors') return { total: 0, truncated: false, editors: [] }
      if (method === 'vscode.applyEdit') {
        return { applied: true, file: FILE, saved: false, textLength: 2 }
      }
      throw new Error(`unexpected method ${method}`)
    },
  })
  const feed = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    seen.push(msg)
    if (msg.id !== undefined) link.handleLine(line)
  })
  socket.on('data', feed)
  socket.on('error', () => {})
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    link,
    socket,
    seen,
    /** 收到过多少条**业务**帧（`vscode.*`；协商帧不算）。 */
    business() { return seen.filter((m) => typeof m.method === 'string' && m.method.startsWith('vscode.')).length },
    count(method) { return seen.filter((m) => m.method === method).length },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

/**
 * 起一套：`apply(ctx, { consumers })` + 一个已报身份的假编辑器。
 *
 * `capabilities` 里带上写方法，是为了让"过了白名单"的用例能一路走到下一道门
 * （能力预检 / 会话授权），从而区分"被白名单拦"与"被后面某道门拦"。
 */
const READ_CAPS = [
  'vscode.openFile', 'vscode.getSelection', 'vscode.getDiagnostics', 'vscode.listOpenEditors',
]

async function withKit({ consumers, caps = [...READ_CAPS, 'vscode.applyEdit'] } = {}) {
  const home = tempHome()
  const ctx = fakeCtx()
  const logs = []
  const handle = apply(ctx, {
    consumers,
    dshHome: home,
    connectWaitMs: 50,
    onLog: (level, msg, extra) => logs.push({ level, msg, extra }),
  })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v
  const server = handle.kit.server
  const editor = await fakeEditor(server)
  await editor.link.request('bridge.hello', {
    client: 'fake-editor', extensionVersion: '0.1.0', protocolVersion: 1, capabilities: caps,
  })
  const cleanup = async () => {
    if (!editor.socket.destroyed) await editor.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, ctx, handle, editor, logs, cleanup }
}

/** 断言某个 Promise 以 `-32602`（本地白名单门）被拒，并返回 `data`。 */
async function deniedWith(promise, expected) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, ERR.INVALID_PARAMS, '白名单拒绝复用 -32602（不自造新码）')
    assert.equal(err.data?.stage, 'local', '本地前置门家族：stage 必须是 local')
    for (const [k, v] of Object.entries(expected)) {
      assert.deepEqual(err.data?.[k], v, `data.${k}`)
    }
    return err.data
  }
  throw new Error('应当被拒，但它成功了')
}

// ─────────────────────────── ★ 三条主用例 ───────────────────────────

test('★ T38 ① 未绑定身份的消费者调 applyEdit：-32602 consumer-unbound，且对端**零业务帧**', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: {} })
  try {
    // 锚点给全：能拦住它的只能是白名单（不是 version / incarnation / 授权门）。
    const data = await deniedWith(svc.vscode.applyEdit(goodWrite()), {
      method: 'vscode.applyEdit',
      consumer: null,
      declared: 'read',
      allowed: 'read',
      tier: 'buffer-edit',
      effective: 'read',
      reason: 'consumer-unbound',
    })
    assert.equal(editor.business(), 0, '被白名单拒绝时一个业务字节都不许出门')
    assert.equal(editor.count('vscode.applyEdit'), 0)
    // raw request 是另一条入口，同一道门（不能被绕过）。
    await deniedWith(svc.request('vscode.applyEdit', goodWrite()), { reason: 'consumer-unbound' })
    assert.equal(editor.business(), 0)
    assert.ok(data)
  } finally {
    await cleanup()
  }
})

test('★ T38 ② 白名单只给 buffer-edit：删除类方法越档即拒，buffer-edit 本身放行', async () => {
  const { svc, editor, cleanup } = await withKit({
    consumers: { 'plugin-p1': 'buffer-edit' },
    caps: [...READ_CAPS, 'vscode.applyEdit', 'vscode.deleteFile'],
  })
  try {
    // 插件自己声明得更高（delete）也没用 —— 天花板取 min(declared, allowed)。
    const p1 = svc.forPlugin('plugin-p1', { declared: 'delete' })

    await deniedWith(p1.request('vscode.deleteFile', { file: FILE }), {
      consumer: 'plugin-p1',
      declared: 'delete',
      allowed: 'buffer-edit',
      tier: 'delete',
      reason: 'declared-above-allowed',
    })
    assert.equal(editor.count('vscode.deleteFile'), 0, '删除帧不许出门')

    // 同一身份调 buffer-edit 档 → 过白名单（随后被会话授权门 -32010 拦，正是"下一道门"）。
    await assert.rejects(p1.request('vscode.applyEdit', goodWrite()), (err) => {
      assert.notEqual(err.data?.reason, 'consumer-unbound')
      assert.notEqual(err.data?.reason, 'declared-above-allowed')
      assert.notEqual(err.data?.reason, 'consumer-not-configured')
      return true
    })
  } finally {
    await cleanup()
  }
})

test('★ T38 ③ 只读四能力在**未声明身份**时照样成功（白名单不许误伤只读）', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: {} })
  try {
    assert.equal(svc.consumer.source, 'unbound')
    const opened = await svc.vscode.openFile({ path: FILE })
    assert.equal(opened.opened, true)
    const sel = await svc.vscode.getSelection()
    assert.equal(sel.text, 'hi')
    const diag = await svc.vscode.getDiagnostics()
    assert.equal(diag.total, 0)
    const editors = await svc.vscode.listOpenEditors()
    assert.equal(editors.total, 0)
    assert.equal(editor.business(), 4, '四条只读请求都真的到了对端')
  } finally {
    await cleanup()
  }
})

// ───────────────────── 默认值 / 三种拒绝 reason 要分得清 ─────────────────────

test('T38 未登记的消费者：默认 read，写类拒且 reason=consumer-not-configured', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: { 'someone-else': 'delete' } })
  try {
    const p = svc.forPlugin('not-listed', { declared: 'buffer-edit' })
    await deniedWith(p.vscode.applyEdit(goodWrite()), {
      consumer: 'not-listed',
      declared: 'buffer-edit',
      allowed: 'read',
      reason: 'consumer-not-configured',
    })
    assert.equal(editor.business(), 0)
    // 只读仍然可以（默认 read 的正面语义）。
    await p.vscode.getSelection()
    assert.equal(editor.count('vscode.getSelection'), 1)
  } finally {
    await cleanup()
  }
})

test('T38 自己声明得太低：配置允许 buffer-edit，只声明 read → declared-below-required', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: { p2: 'buffer-edit' } })
  try {
    const p2 = svc.forPlugin('p2', { declared: 'read' })
    await deniedWith(p2.vscode.applyEdit(goodWrite()), {
      consumer: 'p2', declared: 'read', allowed: 'buffer-edit', reason: 'declared-below-required',
    })
    assert.equal(editor.business(), 0)
    // 不声明 declared 时同样落 read（想写就必须显式写出来）。
    const p2b = svc.forPlugin('p2')
    assert.equal(p2b.consumer.declared, 'read')
    await deniedWith(p2b.vscode.applyEdit(goodWrite()), { reason: 'declared-below-required' })
  } finally {
    await cleanup()
  }
})

// ───────────────────── 身份是入口给的，调用方填不进来 ─────────────────────

test('T38 ★ 身份不可自报：opts.consumer / params.consumer 都提不了权', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: { 'plugin-p1': 'buffer-edit' } })
  try {
    const forged = { name: 'plugin-p1', declared: 'delete', source: 'host' }
    // ① 共享 facade：塞一个"看起来是宿主"的身份也没用（第 4 个实参由入口给）。
    await deniedWith(svc.request('vscode.applyEdit', goodWrite(), { consumer: forged }),
      { reason: 'consumer-unbound', consumer: null })
    // ② 绑定 facade：同样塞不进来（身份由 forPlugin 决定）。
    await deniedWith(svc.forPlugin('plugin-p1', { declared: 'read' })
      .request('vscode.applyEdit', goodWrite(), { consumer: forged }),
    { reason: 'declared-below-required', declared: 'read' })
    assert.equal(editor.business(), 0, '伪造身份一条业务帧都不许换到')
  } finally {
    await cleanup()
  }
})

test('T38 forPlugin 名字必须非空（匿名 = 永远 read，等于写死自己不能写）', async () => {
  const { svc, cleanup } = await withKit({ consumers: {} })
  try {
    assert.throws(() => svc.forPlugin(''), TypeError)
    assert.throws(() => svc.forPlugin(undefined), TypeError)
    // 已绑定的 facade 再绑一次无意义，但方法必须稳定存在（铁律 2）。
    const p = svc.forPlugin('p3', { declared: 'read' })
    assert.equal(typeof p.forPlugin, 'function')
  } finally {
    await cleanup()
  }
})

// ───────────────────── 通知 / 未知方法 / 协商通道 ─────────────────────

test('T38 notify 同样过白名单；bridge.* 协商通道豁免', async () => {
  const { svc, handle, editor, cleanup } = await withKit({ consumers: {} })
  try {
    assert.throws(() => svc.notify('vscode.diff', {}), (err) => {
      assert.equal(err.code, ERR.INVALID_PARAMS)
      assert.equal(err.data?.reason, 'consumer-unbound')
      return true
    })
    assert.equal(editor.seen.filter((m) => m.method === 'vscode.diff').length, 0)
    // 协商通道不是编辑器能力：未绑定身份也能发（否则 hello/ping 都被堵死）。
    handle.kit.notify('bridge.ping', {}) // 宿主通道，不抛
    assert.equal(handle.kit.snapshot().consumerPolicy.unboundTier, 'read')
  } finally {
    await cleanup()
  }
})

test('T38 未知方法 fail-closed：按最高档 delete 判，低档消费者一律拒', async () => {
  const { svc, editor, cleanup } = await withKit({ consumers: { p4: 'buffer-edit' } })
  try {
    assert.equal(tierOf('vscode.someFutureMethod'), 'delete')
    await deniedWith(svc.forPlugin('p4', { declared: 'delete' }).request('vscode.someFutureMethod', {}),
      { tier: 'delete', allowed: 'buffer-edit', reason: 'declared-above-allowed' })
    assert.equal(editor.business(), 0)
  } finally {
    await cleanup()
  }
})

// ───────────────────── 可观测：日志 + snapshot ─────────────────────

test('T38 ★ 默认拒可观测：加载期摘要日志 + snapshot.consumerPolicy 里能看到档位与拒绝原因', async () => {
  const { svc, logs, cleanup } = await withKit({ consumers: { 'plugin-p1': 'buffer-edit' } })
  try {
    // 加载期：策略一句话说清楚（配错了不用等某次调用才被发现）。
    const summary = logs.find((l) => l.msg.includes('consumer whitelist:'))
    assert.ok(summary, '加载期必须打印白名单摘要')
    assert.match(summary.msg, /plugin-p1=buffer-edit/)

    await deniedWith(svc.vscode.applyEdit(goodWrite()), { reason: 'consumer-unbound' })
    svc.forPlugin('plugin-p1', { declared: 'buffer-edit' })

    const policy = svc.snapshot().consumerPolicy
    assert.deepEqual(policy.tiers, [...TIERS])
    assert.equal(policy.defaultTier, 'read')
    assert.equal(policy.unboundTier, 'read')
    assert.deepEqual(policy.consumers, [{ name: 'plugin-p1', allowed: 'buffer-edit' }])
    assert.deepEqual(policy.bindings.map((b) => [b.name, b.declared]), [['plugin-p1', 'buffer-edit']])
    assert.equal(policy.denials.length, 1, '每次拒绝都留一条记录（默认拒必须看得见）')
    assert.deepEqual(
      { ...policy.denials[0], at: undefined },
      {
        at: undefined,
        method: 'vscode.applyEdit',
        tier: 'buffer-edit',
        consumer: null,
        declared: 'read',
        allowed: 'read',
        effective: 'read',
        reason: 'consumer-unbound',
      },
    )
    assert.equal(policy.methodTiers['vscode.applyEdit'], 'buffer-edit')
    // 拒绝也要有 warn 日志（真机上"能力不存在"这种误导性失败，靠它才有线索）。
    assert.ok(logs.some((l) => l.level === 'warn' && /capability denied/.test(l.msg)))
  } finally {
    await cleanup()
  }
})

test('T38 配置写错不静默：非法档位进 invalid，该消费者落回 read（收紧，不放松）', async () => {
  const { svc, logs, cleanup } = await withKit({ consumers: { bad: 'root', good: 'disk-write' } })
  try {
    const policy = svc.snapshot().consumerPolicy
    assert.deepEqual(policy.invalid, [{ name: 'bad', value: 'root', reason: 'unknown-tier' }])
    assert.deepEqual(policy.consumers, [{ name: 'good', allowed: 'disk-write' }])
    assert.ok(logs.some((l) => l.level === 'error' && /invalid entry/.test(l.msg)),
      '配置错必须响亮（error 级日志）')
    await deniedWith(svc.forPlugin('bad', { declared: 'delete' }).request('vscode.applyEdit', goodWrite()),
      { reason: 'consumer-not-configured', allowed: 'read' })
  } finally {
    await cleanup()
  }
})

// ───────────────────── 随包发布的配置示例 ─────────────────────

test('T38 配置示例（cordis.patch.example.yml）跟档位模型一致，抄过去就能用', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join: joinPath } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(joinPath(here, '..', 'cordis.patch.example.yml'), 'utf8')

  // 只取 `consumers:` 下面那一小段（不引 YAML 解析器：协议库零依赖，测试也不加）。
  const start = text.indexOf('\n    consumers:\n')
  assert.ok(start > 0, '示例里必须有 consumers: 段')
  const block = text.slice(start).split('\n').slice(1)
    .filter((line) => line.startsWith('      ') && !line.trim().startsWith('#'))
    .map((line) => line.trim())

  const entries = block.map((line) => {
    const m = /^([^\s:]+):\s*(\S+)$/.exec(line)
    assert.ok(m, `示例里的消费者条目格式不对：${line}`)
    return [m[1], m[2]]
  })
  assert.ok(entries.length >= 1, '示例至少给一条真实条目，否则抄过去等于没配')
  for (const [name, tier] of entries) {
    assert.ok(TIERS.includes(tier), `示例里 ${name} 的档位 ${tier} 不在四档里（抄过去会被落回 read）`)
  }
  // 示例里真的写了 demo（它是本仓唯一的真实消费者）。
  assert.ok(entries.some(([n]) => n === 'dsh-kit-demo'))
})

// ───────────────────── 纯函数层（档位模型） ─────────────────────

test('T38 档位模型：四档有序、方法表逐条对契约 §6.2.1、minTier 收紧', () => {
  assert.deepEqual([...TIERS], ['read', 'buffer-edit', 'disk-write', 'delete'])
  assert.equal(METHOD_TIERS['vscode.openFile'], 'read')
  assert.equal(METHOD_TIERS['vscode.getDocumentState'], 'read')
  assert.equal(METHOD_TIERS['vscode.applyEdit'], 'buffer-edit')
  assert.equal(METHOD_TIERS['vscode.save'], 'disk-write')
  assert.equal(METHOD_TIERS['vscode.deleteFile'], 'delete')
  assert.equal(minTier('delete', 'buffer-edit'), 'buffer-edit')
  assert.equal(minTier('read', 'delete'), 'read')
  assert.equal(minTier('nonsense', 'delete'), 'read', '非法档位按最低处理（收紧）')
  assert.equal(UNBOUND_CONSUMER.declared, 'read')
  assert.equal(HOST_CONSUMER.declared, 'delete')
})

test('T38 纯函数：judgeCall 的三种 reason 与宿主/未绑定通道', () => {
  const policy = normalizePolicy({ a: 'buffer-edit', b: 'delete' })
  const name = (n, d) => ({ name: n, declared: d, source: 'plugin' })

  assert.equal(judgeCall({ policy, consumer: name('a', 'delete'), method: 'vscode.deleteFile' }).reason,
    'declared-above-allowed')
  assert.equal(judgeCall({ policy, consumer: name('zzz', 'read'), method: 'vscode.applyEdit' }).reason,
    'consumer-not-configured')
  assert.equal(judgeCall({ policy, consumer: name('b', 'read'), method: 'vscode.applyEdit' }).reason,
    'declared-below-required')
  assert.equal(judgeCall({ policy, consumer: UNBOUND_CONSUMER, method: 'vscode.openFile' }).ok, true)
  assert.equal(judgeCall({ policy, consumer: UNBOUND_CONSUMER, method: 'vscode.applyEdit' }).reason,
    'consumer-unbound')
  // 宿主 owner 通道不受配置约束（它不是插件，也不可达）。
  assert.equal(judgeCall({ policy, consumer: HOST_CONSUMER, method: 'vscode.deleteFile' }).ok, true)
  // 配置里的非对象值整段判非法。
  assert.deepEqual(normalizePolicy([]).invalid, [{ name: null, value: [], reason: 'consumers-not-an-object' }])
})

/**
 * ★ T42 / 评审 I2：**原型成员不许被当成档位**。
 *
 * 旧实现 `METHOD_TIERS[method]` 会顺着原型链取值：`toString` / `constructor` / `valueOf`
 * 拿到函数，`__proto__` 拿到对象 —— 都不是档位字符串，于是 `tierRank` 回 `-1`，而
 * 判据是 `-1 <= 0`，**read 消费者于是通过白名单**拿到一个从没被评估过的方法。
 * 修法两处一起：`Object.hasOwn` 只认自有键（原型名字落到兜底档），
 * `judgeCall` 在比较前用 `isTier` 拦非法档位并按最高档处置。
 *
 * 这里连"表里写坏了"也一起守：原型污染 / 手改表都不是调用方能控制的输入。
 */
test('★ T42 原型成员（toString/constructor/__proto__）一律按最高档、read 消费者必拒', () => {
  const policy = normalizePolicy({})
  const unbound = { name: null, declared: 'read', source: 'unbound' }
  const readConsumer = { name: 'r', declared: 'read', source: 'plugin' }

  for (const method of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    assert.equal(Object.hasOwn(METHOD_TIERS, method), false, `${method} 不该是登记项`)
    assert.equal(tierOf(method), TIERS[TIERS.length - 1], `${method} 必须落到最高档`)
    // 未绑定身份 + 读消费者：两条门都不许因为它"看起来不是写类方法"而放行。
    assert.equal(judgeCall({ policy, consumer: unbound, method }).reason, 'consumer-unbound')
    assert.equal(judgeCall({ policy, consumer: readConsumer, method }).reason,
      'consumer-not-configured')
  }

  // 非字符串同样落到最高档（不许 undefined/对象/符号借 `String()` 混过去）。
  for (const method of [undefined, null, 42, {}, ['vscode.openFile'], Symbol('x')]) {
    assert.equal(tierOf(method), TIERS[TIERS.length - 1])
  }

  // 表本身是**冻结**的：非法档位只能靠原型污染或手改表塞进来，而两者都被挡住。
  // (`judgeCall` 里那道 `tier-unknown` 守卫因此是纯兜底 —— 单测只能从外面断言
  //  "非法档位一律折成最高档"，断言不到那个分支，这一点写在这里免得被读成遗漏。)
  assert.equal(Object.isFrozen(METHOD_TIERS), true, '方法表必须冻结')
  for (const key of ['vscode.openFile', 'vscode.applyEdit', 'vscode.deleteFile']) {
    assert.throws(() => { METHOD_TIERS[key] = 'nonsense' }, TypeError)
    assert.equal(isTier(METHOD_TIERS[key]), true, '表里的每个值都必须是真的档位')
  }
})
