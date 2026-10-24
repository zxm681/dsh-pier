import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'

import { apply, name } from '../src/index.js'
import { PROTOCOL_VERSION, connect, createLineSplitter } from '../src/protocol.js'
import { EVENT_SUBSCRIBE_METHOD, EVENT_UNSUBSCRIBE_METHOD } from '../src/event-contract.js'
import {
  EVENT_CONSUMER_UNBOUND,
  createEventSubscriptions,
  eventPartitionKey,
  normalizeEventFilter,
  notReadyEventHandle,
  stripEventBodies,
  subscriptionReceiptError,
} from '../src/event-subscriptions.js'

/**
 * E3 事件订阅：**按消费者隔离、可取消**的入口。
 *
 * 本文件分三层，层次是有意义的 —— 它们各自证明不同的事：
 *  ① 纯逻辑层（`createEventSubscriptions`）：分区、队列、过滤、坏帧、退订；
 *  ② facade 层（`apply()` 注册出去的那个面）：铁律 2（未就绪也稳定存在）+ 固定身份；
 *  ③ 真 TCP 端到端：`vscode.events.subscribe` 走 request（有回执）、
 *     反向 `vscode.events.event` 只收不发、delta 真的只在显式选且给白名单时才带正文、
 *     事件里的 incarnation **不能**变成可写锚点。
 *
 * 每条安全断言都配了"改回去就红"的变异证据（`work/t58-mutation/`），
 * 因为"测试全绿"和"测试在守门"是两件事（铁律 9）。
 */

// ── ① 纯逻辑层 ────────────────────────────────────────────────

/** 一条测试连接。`windowId` 是链路事实（`attribute` 从这里取），不是 payload 自报。 */
const LINK = { windowId: 'win-07' }
const OTHER_LINK = { windowId: 'win-99' }

const EVENT_SUB = { subscriptionId: 'tx-sub', streamEpoch: 'tx-epoch', startSeq: 1 }

/** 造一条**结构合法**的订阅回执（含 cursor，故意在测试里逐字段比对）。 */
function receiptFor(id, extra = {}) {
  return {
    ok: true,
    subscriptionId: EVENT_SUB.subscriptionId,
    streamEpoch: EVENT_SUB.streamEpoch,
    startSeq: EVENT_SUB.startSeq,
    cursor: {
      subscriptionId: EVENT_SUB.subscriptionId,
      streamEpoch: EVENT_SUB.streamEpoch,
      nextSeq: EVENT_SUB.startSeq,
    },
    subscription: { id, consumer: 'dsh-kit-test', textMode: 'metadata' },
    ...extra,
  }
}

/** 一条结构合法的入站信封（字段集与 `EVENT_ENVELOPE_FIELDS` 一致）。 */
function envelope(seq, type, payload = {}, extra = {}) {
  return {
    subscriptionId: EVENT_SUB.subscriptionId,
    streamEpoch: EVENT_SUB.streamEpoch,
    seq,
    type,
    observedAt: 1700000000000,
    payload,
    ...extra,
  }
}

/**
 * 逻辑层夹具：`request` 只记调用并回一条合法回执；`resolve` 直接给 LINK。
 *
 * 不碰 socket、不碰 vscode —— 这一层只该证明分发语义。
 */
function harness({ request = null, resolve = null, attribute = null, accept = null, maxCount, maxBytes } = {}) {
  const calls = []
  const subs = createEventSubscriptions({
    request: request ?? (async (method, params, transport, consumer) => {
      calls.push({ method, params, transport, consumer })
      if (method === EVENT_SUBSCRIBE_METHOD) return receiptFor(params.id, {
        subscription: {
          id: params.id,
          consumer: typeof consumer?.name === 'string' ? consumer.name : EVENT_CONSUMER_UNBOUND,
          textMode: params.textMode,
        },
      })
      return { ok: true, unsubscribed: true, subscriptionId: params.id ?? null, streamClosed: true }
    }),
    resolve: resolve ?? (async () => ({ link: LINK, transport: {} })),
    attribute: attribute ?? ((link) => ({ windowId: link?.windowId ?? null, sessionId: null })),
    accept: accept ?? (() => true),
    now: () => 1700000000000,
    ...(maxCount === undefined ? {} : { maxCount }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })
  return { subs, calls }
}

const consumerOf = (name) => ({ name, declared: 'read', source: 'plugin' })

test('E3 subscribe 返回含 dispose 的 handle，订阅回执带 cursor（初态屏障）', async () => {
  const { subs, calls } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (event) => seen.push(event),
  )
  assert.equal(typeof handle.dispose, 'function', 'handle 必须有 dispose()')
  assert.equal(handle.ok, true)
  assert.equal(handle.consumer, 'dsh-kit-test', 'handle 上带着分区键，调用方看得见自己是谁')
  await handle.ready

  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, EVENT_SUBSCRIBE_METHOD)
  assert.deepEqual(handle.cursor, receiptFor(handle.subscriptionId).cursor)
  assert.equal(handle.filter.textMode, 'metadata', 'textMode 默认 metadata')
  assert.equal(handle.filter.files, null, '未显式给 files 时不许有"全窗"白名单')
  subs.dispose()
})

test('E3 过滤拒绝：delta 必须给 files、必须给目标、类型只许业务事件', async () => {
  const { subs, calls } = harness()
  const events = subs.eventsFor(consumerOf('dsh-kit-test'))

  const noFiles = events.subscribe({ windowId: 'win-07', textMode: 'delta' }, () => {})
  assert.equal(noFiles.ok, false)
  assert.equal(noFiles.error.reason, 'files-required-for-delta')

  const noTarget = events.subscribe({ types: ['selectionChanged'] }, () => {})
  assert.equal(noTarget.ok, false)
  assert.equal(noTarget.error.reason, 'target-required')

  const control = events.subscribe({ windowId: 'win-07', types: ['gap'] }, () => {})
  assert.equal(control.ok, false, '控制态类型不是可订阅类型')
  assert.equal(control.error.reason, 'invalid-types')

  const noListener = events.subscribe({ windowId: 'win-07' }, null)
  assert.equal(noListener.ok, false)
  assert.equal(noListener.error.reason, 'listener-required')

  assert.equal(calls.length, 0, '本地就能拒的请求一帧都不许发出去')
  subs.dispose()
})

test('E3 回执结构校验：cursor 缺失/错流/startSeq 不符都算 -32009，不许"订阅成功但没屏障"', async () => {
  const bad = [
    [(() => { const r = receiptFor('sub-1'); delete r.cursor; return r })(), 'cursor'],
    [receiptFor('sub-1', { cursor: { subscriptionId: 'other', streamEpoch: 'tx-epoch', nextSeq: 1 } }), 'cursor-mismatch'],
    [receiptFor('sub-1', { cursor: { subscriptionId: 'tx-sub', streamEpoch: 'other', nextSeq: 1 } }), 'cursor-mismatch'],
    [receiptFor('sub-1', { cursor: { streamEpoch: 'tx-epoch', nextSeq: 1 } }), 'cursor-subscription-id'],
    [receiptFor('sub-1', { cursor: { subscriptionId: 'tx-sub', streamEpoch: 'tx-epoch', nextSeq: 0 } }), 'cursor-next-seq'],
    [receiptFor('sub-1', { cursor: { subscriptionId: 'tx-sub', streamEpoch: 'tx-epoch', nextSeq: 9 } }), 'cursor-start'],
    [receiptFor('sub-1', { subscription: { consumer: 'x', textMode: 'metadata' } }), 'subscription-id-field'],
  ]
  for (const [payload, reason] of bad) {
    assert.equal(subscriptionReceiptError(payload), reason, `应当判 ${reason}`)
  }
  assert.equal(subscriptionReceiptError(receiptFor('sub-1')), null, '正面样本必须过')

  // 线上路径同样要拦：回执不合格时 ready 拒绝，且订阅不落地（不会"半订上"）。
  const { subs } = harness({
    request: async (method, params) => (method === EVENT_SUBSCRIBE_METHOD
      ? receiptFor(params.id, { cursor: undefined })
      : { ok: true, unsubscribed: true, subscriptionId: params.id ?? null, streamClosed: true }),
  })
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe({ windowId: 'win-07' }, () => {})
  await assert.rejects(handle.ready, (err) => err?.code === -32009)
  assert.equal(handle.ok, false)
  assert.equal(handle.error.code, -32009)
  assert.equal(subs.count, 0, '回执不合格的订阅不能留在登记表里')
  subs.dispose()
})

test('E3 分区隔离：两个消费者各有自己的过滤与队列，事件只进匹配的那个', async () => {
  const { subs } = harness()
  const a = []
  const b = []
  const one = subs.eventsFor(consumerOf('plugin-a')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (e) => a.push(e),
  )
  const two = subs.eventsFor(consumerOf('plugin-b')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'] },
    (e) => b.push(e),
  )
  await Promise.all([one.ready, two.ready])

  subs.onEvent(envelope(1, 'selectionChanged', { file: 'C:/ws/a.txt' }), LINK)
  await turn()

  assert.deepEqual(a.map((e) => e.type), ['selectionChanged'])
  assert.deepEqual(b, [], 'B 没订 selectionChanged，一条都不许收到')

  // 队列与统计必须分开算：分区隔离不是"过滤器分开"就完了。
  assert.equal(subs.snapshot('plugin-a').subscriptions[0].lastSeq, 1)
  assert.equal(subs.snapshot('plugin-b').subscriptions[0].lastSeq, 0)
  subs.dispose()
})

test('E3 慢消费者：自己那条队列有界，溢出只给自己发 stale，别人照旧', async () => {
  const { subs } = harness({ maxCount: 2 })
  const slow = []
  const fast = []
  const slowHandle = subs.eventsFor(consumerOf('slow')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    async (e) => {
      slow.push(e)
      await new Promise((r) => setTimeout(r, 200))
    },
  )
  const fastHandle = subs.eventsFor(consumerOf('fast')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (e) => fast.push(e),
  )
  await Promise.all([slowHandle.ready, fastHandle.ready])

  for (let seq = 1; seq <= 3; seq += 1) {
    subs.onEvent(envelope(seq, 'selectionChanged', { file: 'C:/ws/a.txt' }), LINK)
    // 让"快"那条分区在这轮里排空；"慢"那条还卡在自己 listener 上（200ms 才回来）。
    await turn()
  }
  // 等慢的那条把第一条跑完 → 它才有机会收到"我自己溢出了"这条 gap。
  await new Promise((r) => setTimeout(r, 300))
  for (let i = 0; i < 20; i += 1) await turn()

  const gaps = slow.filter((e) => e.type === 'gap')
  assert.equal(gaps.length, 1, '溢出只发一条 gap，不是每丢一条发一次')
  assert.equal(gaps[0].payload.reason, 'queue-overflow')
  assert.equal(fast.filter((e) => e.type === 'gap').length, 0, '慢消费者不许连累别人')
  assert.equal(fast.length, 3, '没有订阅的背压时不该丢事件')
  const state = subs.snapshot('slow').subscriptions[0]
  assert.equal(state.stale.reason, 'queue-overflow')
  assert.ok(state.dropped >= 1)
  subs.dispose()
})

test('E3 listener 抛错/拒绝只记在自己分区上，后续事件照投、别人不受影响', async () => {
  const { subs } = harness()
  const bad = []
  const good = []
  const one = subs.eventsFor(consumerOf('throws')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (e) => {
      bad.push(e)
      if (bad.length === 1) throw new Error('boom')
      return Promise.reject(new Error('async boom'))
    },
  )
  const two = subs.eventsFor(consumerOf('fine')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (e) => good.push(e),
  )
  await Promise.all([one.ready, two.ready])

  for (let seq = 1; seq <= 3; seq += 1) {
    subs.onEvent(envelope(seq, 'selectionChanged'), LINK)
  }
  for (let i = 0; i < 20; i += 1) await turn()

  assert.equal(bad.length, 3, '抛错的 listener 仍要收到后续事件（不是一次失败就停摆）')
  assert.equal(good.length, 3, '别人的投递不受影响')
  const state = subs.snapshot('throws').subscriptions[0]
  assert.equal(state.listenerErrors, 3, '同步抛 + 两次 Promise 拒绝都要记数')
  assert.equal(subs.snapshot('fine').subscriptions[0].listenerErrors, 0)
  subs.dispose()
})

test('E3 取消：dispose 之后零回调，且线上退订发出去、登记表清空', async () => {
  const { subs, calls } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe(
    { windowId: 'win-07', types: ['selectionChanged'] },
    (e) => seen.push(e),
  )
  await handle.ready
  subs.onEvent(envelope(1, 'selectionChanged'), LINK)
  await turn()
  assert.equal(seen.length, 1)

  handle.dispose()
  assert.equal(subs.count, 0, '取消后登记表里不许留残骸')
  subs.onEvent(envelope(2, 'selectionChanged'), LINK)
  await turn()
  assert.equal(seen.length, 1, '取消之后零回调')

  const unsub = calls.filter((c) => c.method === EVENT_UNSUBSCRIBE_METHOD)
  assert.equal(unsub.length, 1, '上游订阅必须显式退掉（不留对端残留）')
  assert.equal(typeof unsub[0].params.id, 'string')
  subs.dispose()
})

test('E3 入站坏帧：零正文投递，诊断只带字段名与事件类型', async () => {
  const { subs } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe(
    { windowId: 'win-07' },
    (e) => seen.push(e),
  )
  await handle.ready

  const secret = 'TOPSECRET-BODY-should-never-leak'
  const broken = [
    { ...envelope(1, 'documentChanged', { text: secret }), extraField: secret }, // unknown-field
    { ...envelope(2, 'documentChanged', { text: secret }), seq: 0 }, // seq
    { ...envelope(3, 'documentChanged', { text: secret }), type: 'notARealType' }, // type
    { ...envelope(4, 'documentChanged', { text: secret }), streamEpoch: '' }, // streamEpoch
    'not-an-object',
  ]
  for (const frame of broken) subs.onEvent(frame, LINK)
  await turn()

  assert.deepEqual(seen, [], '坏帧一条都不许投递（哪怕是"看起来像业务事件"的那条）')
  const diagnostics = subs.snapshot('dsh-kit-test').diagnostics
  assert.ok(diagnostics.length >= 4)
  for (const row of diagnostics) {
    assert.equal(row.reason, 'invalid-event')
    assert.ok(typeof row.field === 'string' && row.field !== '')
  }
  assert.equal(JSON.stringify(diagnostics).includes(secret), false,
    '诊断里不许出现任何正文片段，只许字段名')
  subs.dispose()
})

test('E3 窗口归属只认链路事实：payload 自报的 windowId/sessionId 一个字都不采信', async () => {
  const { subs } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe(
    { windowId: 'win-07' },
    (e) => seen.push(e),
  )
  await handle.ready

  subs.onEvent(envelope(1, 'selectionChanged', {
    file: 'C:/ws/a.txt',
    windowId: 'win-ATTACKER',
    sessionId: 'sess-ATTACKER',
    source: { windowId: 'win-ATTACKER' },
  }), LINK)
  await turn()

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].source, { windowId: 'win-07', sessionId: null },
    '归属只能来自 attribute(link)，不能来自 payload 自报')
  assert.notEqual(seen[0].source.windowId, seen[0].payload.windowId)
  assert.notEqual(seen[0].source.sessionId, seen[0].payload.sessionId)
  subs.dispose()
})

test('E3 流不认识那条连接：事件从别的 link 来就一条都不投', async () => {
  const { subs } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe({ windowId: 'win-07' }, (e) => seen.push(e))
  await handle.ready

  subs.onEvent(envelope(1, 'selectionChanged'), OTHER_LINK)
  await turn()
  assert.deepEqual(seen, [], '订阅绑的是 LINK，OTHER_LINK 上没有这条订阅')
  assert.equal(subs.snapshot('dsh-kit-test').subscriptions[0].lastSeq, 0)
  subs.dispose()
})

test('E3 seq 断层 → 该分区 stale（gap），不是静默丢一条', async () => {
  const { subs } = harness()
  const seen = []
  const handle = subs.eventsFor(consumerOf('dsh-kit-test')).subscribe({ windowId: 'win-07' }, (e) => seen.push(e))
  await handle.ready

  subs.onEvent(envelope(1, 'selectionChanged'), LINK)
  await turn()
  subs.onEvent(envelope(4, 'selectionChanged'), LINK)
  await turn()

  assert.equal(seen[0].seq, 1)
  const gapAt = seen.findIndex((e) => e.type === 'gap')
  assert.equal(gapAt, 1, '断层要显式发一条 gap，而不是静默丢一条')
  assert.equal(seen[gapAt].payload.reason, 'seq-gap')
  assert.equal(seen.at(-1).seq, 4, 'gap 之后照常从新序号续投')
  assert.equal(subs.snapshot('dsh-kit-test').subscriptions[0].stale.reason, 'seq-gap')
  subs.dispose()
})

test('E3 metadata 消费者拿不到正文：text/changes 在交付前剥掉（delta 才带）', async () => {
  assert.deepEqual(
    stripEventBodies({ file: 'C:/ws/a.txt', text: 'SECRET', changes: [{ text: 'SECRET' }], version: 2 }),
    { file: 'C:/ws/a.txt', version: 2, textOmitted: true },
  )

  const { subs } = harness()
  const meta = []
  const delta = []
  const one = subs.eventsFor(consumerOf('meta')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'] },
    (e) => meta.push(e),
  )
  const two = subs.eventsFor(consumerOf('delta')).subscribe(
    { windowId: 'win-07', types: ['documentChanged'], textMode: 'delta', files: ['C:/ws/a.txt'] },
    (e) => delta.push(e),
  )
  await Promise.all([one.ready, two.ready])

  subs.onEvent(envelope(1, 'documentChanged', {
    file: 'C:/ws/a.txt',
    version: 2,
    text: 'SECRET',
    changes: [{ range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }, text: 'SECRET' }],
  }), LINK)
  await turn()

  assert.equal(meta.length, 1)
  assert.equal('text' in meta[0].payload, false, 'metadata 消费者不许拿到正文')
  assert.equal('changes' in meta[0].payload, false)
  assert.equal(meta[0].payload.textOmitted, true)

  assert.equal(delta.length, 1)
  assert.equal(delta[0].payload.text, 'SECRET', '显式选了 delta 且给了白名单，才该拿到正文')
  subs.dispose()
})

test('E3 未就绪的句柄是结构化失败，不是裸 TypeError（铁律 2）', async () => {
  const handle = notReadyEventHandle(consumerOf('dsh-kit-test'))
  assert.equal(handle.ok, false)
  assert.equal(handle.error.code, -32007)
  assert.equal(handle.error.reason, 'server-not-ready')
  assert.equal(typeof handle.dispose, 'function')
  await handle.ready
})

test('E3 分区键：名字是身份，没名字的一律进 unbound，不许"默认即特权"', () => {
  assert.equal(eventPartitionKey(consumerOf('plugin-a')), 'plugin-a')
  assert.equal(eventPartitionKey({ name: '  plugin-b  ' }), 'plugin-b')
  assert.equal(eventPartitionKey({ name: null }), EVENT_CONSUMER_UNBOUND)
  assert.equal(eventPartitionKey(undefined), EVENT_CONSUMER_UNBOUND)
  assert.equal(eventPartitionKey({ name: '' }), EVENT_CONSUMER_UNBOUND)
})

test('E3 normalizeEventFilter 收 type 单数、去重、textMode 只认两个值', () => {
  const one = normalizeEventFilter({ windowId: 'win-07', type: 'selectionChanged' })
  assert.equal(one.ok, true)
  assert.deepEqual(one.filter.types, ['selectionChanged'])

  const dup = normalizeEventFilter({ windowId: 'win-07', types: ['selectionChanged', 'selectionChanged'] })
  assert.deepEqual(dup.filter.types, ['selectionChanged'])

  assert.equal(normalizeEventFilter({ windowId: 'win-07', textMode: 'full' }).error.reason, 'invalid-text-mode')
  assert.equal(normalizeEventFilter({ windowId: 'win-07', files: [] }).error.reason, 'invalid-files')
  assert.equal(normalizeEventFilter({ windowId: 'win-07', files: ['a', 'a'] }).filter.files.length, 1)
})

// ── ② facade 层 ───────────────────────────────────────────────

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

test('E3 未就绪时 subscribe 仍稳定存在，且返回结构化失败（不是抛裸 TypeError）', async () => {
  const ctx = fakeCtx()
  // `enabled:false` 时 apply 只注册服务、不监听（返回 undefined 是既有行为，本卡不动它）。
  apply(ctx, { enabled: false })
  const svc = ctx.provided.get('dshVscodeKit')
  assert.ok(svc, '服务必须注册（铁律 1：不传 check 谓词）')

  const events = svc.v.vscode.events
  assert.equal(typeof events.subscribe, 'function', 'facade 上必须稳定存在 events.subscribe')
  assert.equal(typeof events.unsubscribe, 'function')
  assert.equal(typeof events.snapshot, 'function')

  const sub = events.subscribe({ windowId: '#1' }, () => {})
  assert.equal(sub.ok, false)
  assert.equal(sub.error.code, -32007)
  assert.equal(typeof sub.dispose, 'function')

  const off = await events.unsubscribe('sub-1')
  assert.equal(off.ok, true)
  assert.equal(off.unsubscribed, false)
  assert.equal(events.snapshot().count, 0)

  // 未绑定面与绑定面的身份**必须不同**：名字是分区键，不是装饰。
  assert.equal(events.consumer, EVENT_CONSUMER_UNBOUND)
  const bound = svc.v.forPlugin('plugin-x', { declared: 'read' })
  assert.equal(bound.vscode.events.consumer, 'plugin-x')
  assert.notEqual(bound.vscode.events.consumer, events.consumer, '基础 facade 不许借"默认"混进别人分区')
})

// ── ③ 真 TCP 端到端 ───────────────────────────────────────────

const TEST_CONSUMERS = { 'dsh-kit-test': 'delete' }
const CAPS = [
  'vscode.openFile', 'vscode.getSelection', 'vscode.getDiagnostics',
  'vscode.listOpenEditors', 'vscode.applyEdit', 'vscode.getDocumentState',
  'vscode.save', 'vscode.deleteFile',
  'vscode.events.subscribe', 'vscode.events.unsubscribe',
]

async function waitFor(predicate, ms = 2000, what = 'condition') {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`waitFor timed out: ${what}`)
}

/**
 * 假编辑器：一条真 TCP 连接 + 真协议层（compatible 版本 + 事件通道协商）。
 *
 * 关键点：**hello 是从编辑器发往 DSH 的 request**，事件通道的协商条件在两侧都得过
 * （`judgeProtocolVersion` 兼容 + `params.eventChannel.version === 1`）——
 * 少一边，`link.events.ready` 就是 false，subscribe 必须回 `-32005` 而不是"降级轮询"。
 */
async function fakeEditor(server, { events = true, capabilities = CAPS, onRequest = null } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const frames = []
  const requests = []
  const pushed = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    events,
    eventAllowed: () => true,
    onEvent: (envelope) => pushed.push(envelope),
    onRequest: (method, params) => {
      requests.push(method)
      if (onRequest) return onRequest(method, params, { link })
      // 假编辑器默认只做一件事：把 grant 收下并回显 id（DSH 侧会核对 `ack.id`）。
      if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id ?? null }
      return { ok: true }
    },
  })
  const feed = createLineSplitter((line) => {
    try { frames.push(JSON.parse(line)) } catch { /* 残缺行不算 */ }
    link.handleLine(line)
  })
  socket.on('data', feed)
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })

  const hello = await link.request('bridge.hello', {
    client: 'fake-editor',
    extensionVersion: '0.0.1',
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    ...(events ? { eventChannel: { version: 1 } } : {}),
  })
  return {
    link, socket, frames, requests, pushed, hello,
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
    sent: (method) => frames.filter((f) => f.method === method),
  }
}

test('E3 端到端：subscribe 走 request 拿回执，反向事件只收不发', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-kit-events-'))
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, events: true })
  await handle.boot
  let editor = null
  try {
    editor = await fakeEditor(handle.kit.server, {
      onRequest: (method) => {
        if (method === EVENT_SUBSCRIBE_METHOD) {
          const descriptor = editor.link.events.openStream('bridge-sub')
          assert.ok(descriptor, '假编辑器必须能开出一条出站流')
          return {
            ok: true,
            subscriptionId: descriptor.subscriptionId,
            streamEpoch: descriptor.streamEpoch,
            startSeq: descriptor.startSeq,
            cursor: {
              subscriptionId: descriptor.subscriptionId,
              streamEpoch: descriptor.streamEpoch,
              nextSeq: descriptor.startSeq,
            },
            subscription: { id: descriptor.subscriptionId, consumer: 'dsh-kit-test', textMode: 'metadata' },
          }
        }
        if (method === EVENT_UNSUBSCRIBE_METHOD) {
          return { ok: true, unsubscribed: true, subscriptionId: null, streamClosed: true }
        }
        return { ok: true }
      },
    })
    await waitFor(() => editor.link.events.ready, 2000, 'editor event channel ready')

    const svc = ctx.provided.get('dshVscodeKit').v.forPlugin('dsh-kit-test', { declared: 'read' })
    const seen = []
    const sub = svc.vscode.events.subscribe({ windowId: '#1', types: ['selectionChanged'] }, (e) => seen.push(e))
    assert.equal(sub.ok, true)
    await sub.ready
    assert.equal(sub.error, null)
    assert.equal(typeof sub.cursor.nextSeq, 'number', '回执里的 cursor 是初态屏障')
    assert.equal(editor.sent(EVENT_SUBSCRIBE_METHOD).length, 1, '订阅必须走真的 request（有回执）')

    // 反向：编辑器推一条事件 → DSH 侧收下（`vscode.events.event` 只接收）
    assert.equal(editor.link.events.publish('selectionChanged', { file: 'C:/ws/a.txt', text: 'SECRET' }), true)
    await waitFor(() => seen.length === 1, 2000, 'first event')
    assert.equal(seen[0].type, 'selectionChanged')
    assert.equal(typeof seen[0].source.windowId, 'string')
    assert.notEqual(seen[0].source.windowId, '', '归属来自链路（windows 注册表签发的号），不是 payload 自报')
    assert.equal(seen[0].source.sessionId, null)

    // DSH 侧从不主动向编辑器发 `vscode.events.event`（反向只收）
    assert.equal(editor.sent('vscode.events.event').length, 0)

    // 取消：零回调 + 线上退订
    sub.dispose()
    await waitFor(() => editor.sent(EVENT_UNSUBSCRIBE_METHOD).length === 1, 2000, 'unsubscribe request')
    editor.link.events.publish('selectionChanged', { file: 'C:/ws/a.txt' })
    await turn()
    assert.equal(seen.length, 1, '退订之后零回调')
  } finally {
    await editor?.close().catch(() => {})
    ctx.runDisposers()
    await handle.kit?.server?.close?.().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('E3 端到端：对端不支持事件通道 → -32005，绝不偷偷降级成轮询', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-kit-events-nosup-'))
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, events: true })
  await handle.boot
  let editor = null
  try {
    // 老对端：hello 里没有 eventChannel，capabilities 里也没有订阅能力。
    editor = await fakeEditor(handle.kit.server, {
      events: false,
      capabilities: CAPS.filter((m) => m !== 'vscode.events.subscribe'),
    })
    await waitFor(() => handle.kit.lastEditor !== null, 2000, 'peer hello')

    const svc = ctx.provided.get('dshVscodeKit').v.forPlugin('dsh-kit-test', { declared: 'read' })
    const seen = []
    const sub = svc.vscode.events.subscribe({ windowId: '#1' }, (e) => seen.push(e))
    await assert.rejects(sub.ready, (err) => err?.code === -32005)
    assert.equal(sub.ok, false)
    assert.equal(sub.error.code, -32005, '不支持就是 -32005，不许"我帮你轮询"')

    // 零帧：既没有订阅请求，也没有任何轮询形态的替代请求。
    await turn()
    assert.equal(editor.sent(EVENT_SUBSCRIBE_METHOD).length, 0)
    assert.equal(seen.length, 0)
  } finally {
    await editor?.close().catch(() => {})
    ctx.runDisposers()
    await handle.kit?.server?.close?.().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('E3 端到端：delta 只在显式选且给白名单时带正文；事件里的 incarnation 不能当写锚点', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-kit-events-delta-'))
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, events: true })
  await handle.boot
  const FILE = '/ws/delta.txt'
  const EVENT_INCARNATION = 'inc-from-event-stream'
  let editor = null
  let opened = null
  try {
    editor = await fakeEditor(handle.kit.server, {
      onRequest: (method, params, { link }) => {
        if (method === EVENT_SUBSCRIBE_METHOD) {
          // 一条连接只开一条出站流（协议层同 link 已有 outgoing 时 openStream 返回 null）。
          const descriptor = opened ?? (opened = link.events.openStream('bridge-delta'))
          return {
            ok: true,
            subscriptionId: descriptor.subscriptionId,
            streamEpoch: descriptor.streamEpoch,
            startSeq: descriptor.startSeq,
            cursor: {
              subscriptionId: descriptor.subscriptionId,
              streamEpoch: descriptor.streamEpoch,
              nextSeq: descriptor.startSeq,
            },
            subscription: { id: descriptor.subscriptionId, consumer: 'dsh-kit-test', textMode: 'delta' },
          }
        }
        if (method === EVENT_UNSUBSCRIBE_METHOD) {
          return { ok: true, unsubscribed: true, subscriptionId: null, streamClosed: true }
        }
        if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id ?? null }
        if (method === 'vscode.getDocumentState') {
          return {
            file: FILE, version: 2, isDirty: false, eol: 'lf',
            lineCount: 1, textLength: 0, text: '', incarnation: 'inc-bound-read',
          }
        }
        if (method === 'vscode.applyEdit') {
          return { applied: true, file: FILE, saved: false, textLength: 0 }
        }
        return { ok: true }
      },
    })
    await waitFor(() => editor.link.events.ready, 2000, 'editor event channel ready')
    const svc = ctx.provided.get('dshVscodeKit').v.forPlugin('dsh-kit-test', { declared: 'delete' })

    const metaEvents = []
    const meta = svc.vscode.events.subscribe(
      { windowId: '#1', types: ['documentChanged'] },
      (e) => metaEvents.push(e),
    )
    await meta.ready
    assert.equal(meta.filter.textMode, 'metadata')

    const deltaEvents = []
    const delta = svc.vscode.events.subscribe(
      { windowId: '#1', types: ['documentChanged'], textMode: 'delta', files: [FILE] },
      (e) => deltaEvents.push(e),
    )
    await delta.ready

    assert.equal(editor.link.events.publish('documentChanged', {
      file: FILE,
      version: 2,
      beforeVersion: 1,
      incarnation: EVENT_INCARNATION,
      text: 'SECRET-BODY',
    }), true)
    await waitFor(() => metaEvents.length === 1 && deltaEvents.length === 1, 2000, 'both partitions')

    assert.equal(metaEvents[0].payload.textOmitted, true)
    assert.equal('text' in metaEvents[0].payload, false, 'metadata 消费者拿不到正文')
    assert.equal(deltaEvents[0].payload.text, 'SECRET-BODY', '显式 delta + 白名单才带正文')

    // ★ 负例：拿事件里的 incarnation 去拼一个写请求 —— 不许绕过 stateFor 的来源核验。
    const grant = await handle.kit.grantEditing({ sessionId: 'sess-A' })
    assert.equal(grant.delivered, true)
    assert.equal(typeof grant.id, 'string')

    const viaEvent = await handle.kit.applyEditAs(svc.consumer, [
      { file: FILE, expectedVersion: 2, expectedIncarnation: EVENT_INCARNATION },
      { sessionId: 'sess-A' },
    ]).then((r) => ({ ok: true, r }), (err) => ({ ok: false, err }))
    assert.equal(viaEvent.ok, false, '事件里的化身不能当可写锚点')
    assert.equal(viaEvent.err.code, -32602)
    assert.equal(viaEvent.err.data.reason, 'anchor-source-mismatch')
    assert.equal(viaEvent.err.data.source, 'event', '必须说清"这个化身来自事件流，不是读取"')
    assert.equal(editor.sent('vscode.applyEdit').length, 0, '本地拒了就不许发出去')

    // 正面对照：同一个消费者从绑定读拿到的化身，来源门放行（证明拒绝的是"来源"，不是"化身"）。
    const state = await handle.kit.readStateFor('sess-A', FILE)
    assert.equal(typeof state.incarnation, 'string')
    const viaRead = await handle.kit.applyEditAs(svc.consumer, [
      { file: FILE, expectedVersion: 2, expectedIncarnation: state.incarnation },
      { sessionId: 'sess-A' },
    ])
    assert.equal(viaRead.applied, true, '绑定读来的化身必须依然能写')
  } finally {
    await editor?.close().catch(() => {})
    ctx.runDisposers()
    await handle.kit?.server?.close?.().catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
})

test('E3 包名仍在（防止本文件把 apply 换成别的入口）', () => {
  assert.equal(name, 'dsh-vscode-kit')
})
