import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { connect, PROTOCOL_VERSION, SUPPORTED_PROTOCOL, ERR } from '../src/protocol.js'
import {
  EVENT_METHOD, EVENT_CHANNEL_HELLO, EVENT_ENVELOPE_FIELDS, eventEnvelopeError,
  SELECTION_COALESCE_MS, EVENT_QUEUE_MAX_COUNT, EVENT_QUEUE_MAX_BYTES, EVENT_MAX_BYTES,
} from '../src/event-contract.js'

const TOKEN = 'test-only-event-token'
function terminal(extra = {}) {
  const frames = [], delivered = [], states = [], requests = []
  let allowed = true
  const link = connect({
    events: true, token: TOKEN, eventAllowed: () => allowed,
    write: (line) => { frames.push(JSON.parse(line)); return true },
    onRequest: (method) => { requests.push(method); return { ok: true } },
    onEvent: (event) => delivered.push(event), onEventState: (s) => states.push(s), ...extra,
  })
  function hello(patch = {}) {
    link.handleMessage({ jsonrpc: '2.0', method: 'bridge.hello', token: TOKEN,
      params: { protocolVersion: PROTOCOL_VERSION, eventChannel: EVENT_CHANNEL_HELLO, ...patch } })
  }
  hello()
  return { link, frames, delivered, states, requests, hello, allow: (v) => { allowed = v } }
}
function receive(t, seq, patch = {}, token = TOKEN) {
  const descriptor = t.descriptor
  t.link.handleMessage({ jsonrpc: '2.0', method: EVENT_METHOD, token,
    params: { subscriptionId: descriptor.subscriptionId, streamEpoch: descriptor.streamEpoch,
      seq, type: 'documentChanged', observedAt: 0, payload: { text: 'sentinel' }, ...patch } })
}
function receiver(extra) {
  const t = terminal(extra)
  t.descriptor = { subscriptionId: 'sub', streamEpoch: 'epoch-A', startSeq: 1 }
  assert.equal(t.link.events.acceptStream(t.descriptor), true)
  return t
}

test('E1 shared schema and limits; runtime is v2 (A2)', () => {
  assert.equal(PROTOCOL_VERSION, 2, 'A2 升到 v2：脏态门的语义变更跟着整版走')
  assert.deepEqual(SUPPORTED_PROTOCOL, [2, 2])
  assert.deepEqual([SELECTION_COALESCE_MS, EVENT_QUEUE_MAX_COUNT, EVENT_QUEUE_MAX_BYTES, EVENT_MAX_BYTES],
    [50, 256, 1048576, 262144])
  assert.deepEqual(Object.keys(EVENT_ENVELOPE_FIELDS),
    ['subscriptionId', 'streamEpoch', 'seq', 'type', 'observedAt', 'payload'])
  assert.equal(eventEnvelopeError({}), 'subscriptionId')
})

test('E1 default disabled preserves ordinary notifications and hello has no channel advertisement', async () => {
  const t = terminal({ events: undefined })
  assert.equal(t.link.events.hello, undefined)
  assert.equal(t.link.events.ready, false)
  assert.equal(t.link.events.openStream('sub'), null)
  assert.equal(t.link.events.acceptStream({ subscriptionId: 's', streamEpoch: 'e', startSeq: 1 }), false)
  t.link.notify('bridge.hello', { protocolVersion: PROTOCOL_VERSION })
  assert.equal(t.frames.at(-1).token, undefined)
  t.link.notify('ordinary.notification', { a: 1 })
  assert.equal(t.frames.at(-1).method, 'ordinary.notification')
  await turn()
})

test('E1 negotiation requires both channel version and compatible protocol, never infers missing v1', () => {
  for (const patch of [{ eventChannel: undefined }, { eventChannel: { version: 2 } },
    { protocolVersion: 3 }, { protocolVersion: undefined }, { protocolVersion: '1' }]) {
    const t = terminal()
    t.hello(patch)
    assert.equal(t.link.events.ready, false)
    assert.equal(t.link.events.openStream('sub'), null)
  }
})

test('E1 token guard rejects wrong/missing token, and valid token really delivers', async () => {
  const missing = receiver()
  missing.link.handleMessage({ method: EVENT_METHOD, params: {
    subscriptionId: 'sub', streamEpoch: 'epoch-A', seq: 1,
    type: 'documentChanged', observedAt: 0, payload: {} } })
  await turn()
  assert.equal(missing.delivered.length, 0, 'missing token must deliver zero events')
  // Separate wrong-token assertion with a fresh receiver so no legitimate frame masks the guard.
  const wrong = receiver()
  receive(wrong, 1, {}, 'wrong')
  await turn()
  assert.equal(wrong.delivered.length, 0, 'wrong token must deliver zero events')
  receive(wrong, 1)
  await turn()
  assert.equal(wrong.delivered.length, 1, 'positive control must deliver')
})

test('E1 unadmitted, unsubscribed and foreign epoch/id are never delivered', async () => {
  const t = receiver()
  t.allow(false)
  receive(t, 1)
  await turn()
  assert.equal(t.delivered.length, 0)
  assert.equal(t.link.events.snapshot().incoming.stale, true)
  t.allow(true)
  t.link.events.dispose()
  t.descriptor = { ...t.descriptor, streamEpoch: 'new-epoch' }
  assert.equal(t.link.events.acceptStream(t.descriptor), true)
  receive(t, 1, { streamEpoch: 'other-window-epoch' })
  receive(t, 1, { subscriptionId: 'not-subscribed' })
  await turn()
  assert.equal(t.delivered.length, 0)
  receive(t, 1)
  await turn()
  assert.equal(t.delivered.length, 1)
  t.link.events.dispose()
  receive(t, 2)
  await turn()
  assert.equal(t.delivered.length, 1)
})

test('E1 explicit withToken at notification call site; event never allocates request id', async () => {
  const t = terminal()
  const descriptor = t.link.events.openStream('sub')
  const params = { ...descriptor, seq: 1, type: 'documentChanged', observedAt: 1, payload: {} }
  delete params.startSeq
  assert.equal(t.link.notify(EVENT_METHOD, params), false)
  assert.equal(t.frames.length, 0)
  assert.equal(t.link.events.publish('documentChanged', { text: 'hello' }), true)
  assert.equal(t.frames[0].token, TOKEN)
  assert.equal(t.frames[0].id, undefined)
  assert.equal(t.frames[0].params.seq, 1)
  assert.equal(t.link.pendingCount, 0)
  await assert.rejects(t.link.request(EVENT_METHOD, params), (e) => e.code === ERR.INVALID_REQUEST)
  assert.equal(t.link.pendingCount, 0)
})

test('E1 duplicate seq never redelivers; seq gap immediately stales before asynchronous callbacks', async () => {
  const t = receiver()
  receive(t, 1)
  await turn()
  receive(t, 1)
  await turn()
  assert.deepEqual(t.delivered.map((e) => e.seq), [1])
  receive(t, 3)
  assert.equal(t.link.events.snapshot().incoming.stale, true, 'seq gap must stale synchronously')
  assert.equal(t.link.events.snapshot().incoming.reason, 'seq-gap')
  receive(t, 2)
  await turn()
  assert.deepEqual(t.delivered.map((e) => e.seq), [1])
})

test('E1 seq is only compared within installed epoch; reconnect/new stream starts fresh', async () => {
  const t = receiver()
  receive(t, 1); await turn()
  t.link.events.dispose()
  t.descriptor = { subscriptionId: 'sub', streamEpoch: 'epoch-B', startSeq: 40 }
  assert.equal(t.link.events.acceptStream(t.descriptor), true)
  receive(t, 500, { streamEpoch: 'epoch-A' })
  receive(t, 40); await turn()
  assert.deepEqual(t.delivered.map((e) => [e.streamEpoch, e.seq]), [['epoch-A', 1], ['epoch-B', 40]])
  const a = terminal(), b = terminal()
  assert.notEqual(a.link.events.openStream('s').streamEpoch, b.link.events.openStream('s').streamEpoch)
})

test('E1 malformed/oversized events stale with no payload delivery or text in state diagnostics', async () => {
  for (const patch of [{ seq: 1.1 }, { type: 'vscode.applyEdit' }, { extra: 'sentinel' },
    { observedAt: -1 }, { payload: [] }, { payload: { text: '中'.repeat(EVENT_MAX_BYTES) } }]) {
    const t = receiver()
    receive(t, 1, patch)
    assert.equal(t.link.events.snapshot().incoming.stale, true)
    await turn()
    assert.equal(t.delivered.length, 0)
    assert.equal(JSON.stringify(t.states.map(({ link, ...s }) => s)).includes('sentinel'), false)
  }
})

test('E1 write=false pauses events until drain, never retries the accepted frame', () => {
  const lines = []
  const t = terminal({ write: (line) => { lines.push(JSON.parse(line)); return false } })
  t.link.events.openStream('sub')
  for (let i = 0; i < 4; i++) t.link.events.publish('documentChanged', { i })
  assert.equal(lines.length, 1, 'write=false must stop subsequent socket writes')
  assert.equal(t.link.events.snapshot().outCount, 3)
  t.link.events.drain()
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((m) => m.params.seq), [1, 2])
})

test('E1 outbound count overflow emits one gap, stays bounded; RPC response bypasses event queue', async () => {
  const lines = []
  let slow = true
  const t = terminal({ write: (line) => { lines.push(JSON.parse(line)); return !slow } })
  t.link.events.openStream('sub')
  for (let i = 0; i < 260; i++) t.link.events.publish('documentChanged', { i })
  const snapshot = t.link.events.snapshot()
  assert.equal(snapshot.outgoing.stale, true)
  assert.equal(snapshot.outgoing.reason, 'queue-overflow')
  assert.equal(snapshot.outCount, 1)
  assert.ok(snapshot.outBytes <= EVENT_QUEUE_MAX_BYTES)
  t.link.handleMessage({ id: 17, method: 'bridge.ping', token: TOKEN, params: {} })
  await turn()
  assert.deepEqual(lines.find((m) => m.id === 17).result, { ok: true })
  slow = false
  t.link.events.drain()
  assert.equal(lines.filter((m) => m.params?.type === 'gap').length, 1)
  assert.equal(lines.some((m) => m.params?.i === 2), false)
})

test('E1 outbound byte cap and UTF-8/JSON single-event cap are enforced, cyclic payload fails closed', () => {
  for (const payload of [{ text: '中'.repeat(90000) }, { text: '\n'.repeat(EVENT_MAX_BYTES) }]) {
    const t = terminal()
    t.link.events.openStream('sub')
    assert.equal(t.link.events.publish('documentChanged', payload), false)
    assert.equal(t.frames.length, 1)
    assert.equal(t.frames[0].params.type, 'gap')
    assert.equal(t.frames[0].params.payload.reason, 'event-too-large')
  }
  const t = terminal({ write: () => false })
  t.link.events.openStream('sub')
  for (let i = 0; i < 8; i++) t.link.events.publish('documentChanged', { text: 'x'.repeat(200000) })
  assert.equal(t.link.events.snapshot().outgoing.reason, 'queue-overflow')
  assert.ok(t.link.events.snapshot().outBytes <= EVENT_QUEUE_MAX_BYTES)
  const cyclic = {}; cyclic.self = cyclic
  const c = terminal(); c.link.events.openStream('sub')
  assert.equal(c.link.events.publish('documentChanged', cyclic), false)
  assert.equal(c.frames[0].params.payload.reason, 'invalid-event')
})

test('E1 receiver count/byte queues include running async callback and overflow becomes stale', async () => {
  for (const bytes of [0, 200000]) {
    let release
    const running = new Promise((resolve) => { release = resolve })
    const t = receiver({ onEvent: () => running })
    receive(t, 1, { payload: { text: 'x'.repeat(bytes) } })
    await turn()
    for (let i = 2; i < 270; i++) {
      receive(t, i, { payload: { text: 'x'.repeat(bytes) } })
      const s = t.link.events.snapshot()
      assert.ok(s.inCount <= EVENT_QUEUE_MAX_COUNT)
      assert.ok(s.inBytes <= EVENT_QUEUE_MAX_BYTES)
    }
    assert.equal(t.link.events.snapshot().incoming.reason, 'queue-overflow')
    release(); await turn()
    assert.equal(t.link.events.snapshot().inCount, 0)
  }
})

test('E1 socket writableLength threshold stops events and keeps a single gap until drain', () => {
  const lines = []
  let length = EVENT_QUEUE_MAX_BYTES
  const t = terminal({ writableLength: () => length,
    write: (line) => { lines.push(JSON.parse(line)); return true } })
  t.link.events.openStream('sub')
  t.link.events.publish('documentChanged', {})
  assert.equal(lines.length, 0)
  assert.equal(t.link.events.snapshot().outgoing.reason, 'queue-overflow')
  assert.equal(t.link.events.snapshot().outCount, 1)
  length = 0
  t.link.events.drain()
  assert.equal(lines.length, 1)
  assert.equal(lines[0].params.type, 'gap')
})

test('E1 sender gap reaches receiver stale state, not the business event callback', async () => {
  const receiver = terminal()
  const sender = terminal({ write: (line) => { receiver.link.handleLine(line); return true } })
  const descriptor = sender.link.events.openStream('sub')
  assert.equal(receiver.link.events.acceptStream(descriptor), true)
  sender.link.events.publish('documentChanged', { text: 'x'.repeat(EVENT_MAX_BYTES) })
  assert.equal(receiver.link.events.snapshot().incoming.reason, 'event-too-large')
  await turn()
  assert.equal(receiver.delivered.length, 0)
})

test('E1 throwing event writer rejects pending RPC and terminates the stream visibly', async () => {
  let broken = false
  const t = terminal({ write: () => { if (broken) throw new Error('socket closed'); return true } })
  t.link.events.openStream('sub')
  const pending = t.link.request('rpc')
  const failed = assert.rejects(pending, (e) => e.code === ERR.DISCONNECTED)
  broken = true
  t.link.events.publish('documentChanged', {})
  await failed
  assert.equal(t.link.closed, true)
  assert.equal(t.link.events.snapshot().outgoing.reason, 'write-failed')
  assert.equal(t.link.events.snapshot().outCount, 0)
})

test('E1 pending responses remain connection-local; event requests never call a business handler', async () => {
  const t = receiver()
  await turn(); t.requests.length = 0
  const pending = t.link.request('ordinary.request')
  const request = t.frames.at(-1)
  receive(t, 1)
  t.link.handleMessage({ id: request.id, method: EVENT_METHOD, token: TOKEN, params: {} })
  assert.equal(t.link.pendingCount, 1)
  assert.equal(t.frames.at(-1).error.code, ERR.INVALID_REQUEST)
  const other = terminal()
  other.link.handleMessage({ id: request.id, result: { forged: true } })
  assert.equal(t.link.pendingCount, 1)
  t.link.handleMessage({ id: request.id, result: { correct: true } })
  assert.deepEqual(await pending, { correct: true })
  await turn()
  assert.deepEqual(t.requests, [])
  assert.equal(t.delivered.length, 1)
})

test('E1 close/dispose/permission loss clear queues; failed listener stales; no post-close delivery', async () => {
  const t = receiver({ onEvent: () => { throw new Error('secret-text') } })
  receive(t, 1); await turn()
  assert.equal(t.link.events.snapshot().incoming.reason, 'listener-failed')
  const slow = terminal({ write: () => false })
  slow.link.events.openStream('s')
  slow.link.events.publish('documentChanged', {})
  slow.link.events.publish('documentChanged', {})
  slow.allow(false); slow.link.events.drain()
  assert.equal(slow.link.events.snapshot().outCount, 0)
  assert.equal(slow.link.events.snapshot().outgoing.stale, true)
  const closed = receiver()
  receive(closed, 1); closed.link.close('test')
  await turn()
  assert.equal(closed.delivered.length, 0)
  assert.equal(closed.link.events.snapshot().inCount, 0)
  assert.equal(closed.link.events.snapshot().incoming.reason, 'closed')
})

test('E1 original wire byte cap cannot be bypassed with whitespace or unicode escapes', async () => {
  for (const escaped of [false, true]) {
    const t = receiver()
    let line = JSON.stringify({ jsonrpc: '2.0', method: EVENT_METHOD, token: TOKEN, params: {
      subscriptionId: 'sub', streamEpoch: 'epoch-A', seq: 1,
      type: 'documentChanged', observedAt: 0, payload: { text: 'x'.repeat(50000) } } })
    if (escaped) line = line.replaceAll('x', '\\u0078')
    else line += ' '.repeat(EVENT_MAX_BYTES)
    assert.ok(Buffer.byteLength(line) > EVENT_MAX_BYTES)
    t.link.handleLine(line)
    assert.equal(t.link.events.snapshot().incoming.reason, 'event-too-large')
    await turn()
    assert.equal(t.delivered.length, 0)
  }
})
