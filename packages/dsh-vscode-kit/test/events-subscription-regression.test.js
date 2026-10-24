import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { createEventSubscriptions, normalizeEventFilter } from '../src/event-subscriptions.js'
import { METHOD_TIERS } from '../src/whitelist.js'

const link = { windowId: 'window-A' }, other = { windowId: 'window-B' }
const receipt = (id) => ({ ok: true, subscriptionId: 'stream', streamEpoch: 'epoch', startSeq: 1,
  cursor: { subscriptionId: 'stream', streamEpoch: 'epoch', nextSeq: 1 },
  subscription: { id, consumer: 'remote', textMode: 'metadata' } })
const frame = (seq, type = 'documentChanged', file = '/ws/a') => ({ subscriptionId: 'stream',
  streamEpoch: 'epoch', seq, observedAt: 1, type, payload: { file, text: 'SECRET', changes: [{ text: 'SECRET' }] } })
function fixture(options = {}) {
  const calls = []
  const s = createEventSubscriptions({ request: async (method, params) => {
    calls.push({ method, params })
    return method.endsWith('.subscribe') ? receipt(`remote-${params.id}`) : { ok: true, unsubscribed: true, streamClosed: true }
  }, resolve: async ({ filter }) => ({ link: filter.windowId === 'window-B' ? other : link, transport: {} }),
  attribute: (l) => ({ windowId: l.windowId, sessionId: null }), accept: () => true, ...options })
  return { s, calls, events: (name) => s.eventsFor({ name, declared: 'read' }) }
}

test('E3 unbound default has no body privilege and cannot cancel a plugin partition', async () => {
  const f = fixture(), base = [], plugin = []
  try {
    const h = f.events(null).subscribe({ windowId: 'window-A' }, (e) => base.push(e))
    const p = f.events('plugin').subscribe({ windowId: 'window-A', textMode: 'delta', files: ['/ws/a'] }, (e) => plugin.push(e))
    await Promise.all([h.ready, p.ready])
    assert.equal((await f.events(null).unsubscribe(p.subscriptionId)).unsubscribed, false, 'no cross-partition cancellation')
    f.s.onEvent(frame(1), link); await turn()
    assert.equal(base[0].payload.text, undefined)
    assert.equal(base[0].payload.changes, undefined)
    assert.equal(plugin[0].payload.text, 'SECRET')
    assert.equal(h.consumer, 'unbound')
    assert.throws(() => { h.filter.textMode = 'delta' }, TypeError, 'public handle must not mutate the body gate')
  } finally { f.s.dispose() }
})

test('E3 type/file/window/textMode are independent for each consumer', async () => {
  const f = fixture(), a = [], b = []
  try {
    const h = f.events('A').subscribe({ windowId: 'window-A', type: 'documentChanged', files: ['/ws/a'] }, (e) => a.push(e))
    const p = f.events('B').subscribe({ windowId: 'window-B', type: 'documentChanged', files: ['/ws/b'], textMode: 'delta' }, (e) => b.push(e))
    await Promise.all([h.ready, p.ready])
    f.s.onEvent(frame(1, 'documentChanged', '/ws/b'), link)
    f.s.onEvent(frame(2, 'documentSaved', '/ws/a'), link)
    f.s.onEvent(frame(3), link)
    f.s.onEvent(frame(1, 'documentChanged', '/ws/b'), other)
    await turn()
    assert.deepEqual(a.map((e) => e.seq), [3], 'filtered sequence gaps must not create false stale')
    assert.deepEqual(b.map((e) => e.seq), [1])
    assert.equal(a[0].payload.text, undefined)
    assert.equal(b[0].payload.text, 'SECRET')
    assert.equal(b[0].source.windowId, 'window-B')
  } finally { f.s.dispose() }
})

test('E3 overflow stays bounded with exactly one gap even after subsequent bursts', async () => {
  let resume
  const blocked = new Promise((r) => { resume = r })
  const f = fixture({ maxCount: 2 }), slow = [], fast = []
  try {
    const h = f.events('slow').subscribe({ windowId: 'window-A' }, async (e) => { slow.push(e); await blocked })
    const p = f.events('fast').subscribe({ windowId: 'window-A' }, (e) => fast.push(e))
    await Promise.all([h.ready, p.ready])
    for (let n = 1; n <= 12; n++) { f.s.onEvent(frame(n), link); await turn() }
    assert.ok(f.s.snapshot('slow').subscriptions[0].queued <= 2)
    resume(); await turn()
    f.s.onEvent(frame(13), link); await turn()
    assert.deepEqual(slow.map((e) => e.type), ['documentChanged', 'gap'])
    assert.equal(slow[1].payload.reason, 'queue-overflow')
    assert.equal(fast.length, 13)
    assert.equal(fast.some((e) => e.type === 'gap'), false)
  } finally { resume(); f.s.dispose() }
})

test('E3 cancellation waits for in-flight receipt then removes the real remote id once', async () => {
  let finish
  const pending = new Promise((r) => { finish = r })
  const calls = []
  const f = fixture({ request: async (method, params) => {
    calls.push({ method, params })
    if (method.endsWith('.subscribe')) return pending
    return { ok: true, unsubscribed: true, streamClosed: true }
  } })
  const seen = []
  const h = f.events('A').subscribe({ windowId: 'window-A' }, (e) => seen.push(e))
  await turn()
  const stopped = h.dispose()
  finish(receipt('server-generated-id'))
  await stopped
  f.s.onEvent(frame(1), link); await turn()
  assert.deepEqual(seen, [])
  assert.equal(f.s.count, 0)
  assert.deepEqual(calls.filter((c) => c.method.endsWith('.unsubscribe')).map((c) => c.params.id), ['server-generated-id'])
  f.s.dispose()
})

test('E3 failed stream admission compensates the already acknowledged upstream subscription', async () => {
  const f = fixture({ accept: () => false })
  try {
    const h = f.events('A').subscribe({ windowId: 'window-A' }, () => {})
    await assert.rejects(h.ready, (e) => e.code === -32009)
    assert.equal(h.ok, false)
    assert.equal(f.s.count, 0)
    assert.deepEqual(f.calls.filter((c) => c.method.endsWith('.unsubscribe')).map((c) => c.params.id), ['remote-sub-1'])
  } finally { f.s.dispose() }
})

test('E3 never subscribed remains off; visibleRanges is not among default event types', async () => {
  const f = fixture()
  try {
    assert.equal(f.s.onEvent(frame(1), link), 0)
    assert.equal(f.calls.length, 0)
    const filter = normalizeEventFilter({ windowId: 'window-A' }).filter
    assert.equal(filter.textMode, 'metadata')
    assert.equal(filter.types.includes('visibleRangesChanged'), false)
    assert.deepEqual(normalizeEventFilter({ windowId: 'window-A', type: 'visibleRangesChanged' }).filter.types, ['visibleRangesChanged'])
    assert.equal(METHOD_TIERS['vscode.events.subscribe'], 'read')
    assert.equal(METHOD_TIERS['vscode.events.unsubscribe'], 'read')
    assert.equal(Object.hasOwn(METHOD_TIERS, 'vscode.events.event'), false)
  } finally { f.s.dispose() }
})

test('E3 explicit delta still cannot receive bodies with no attributable file', async () => {
  const f = fixture(), seen = []
  try {
    const h = f.events('delta').subscribe({ windowId: 'window-A', files: ['/ws/a'], textMode: 'delta' }, (e) => seen.push(e))
    await h.ready
    const event = frame(1)
    delete event.payload.file
    f.s.onEvent(event, link); await turn()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].payload.text, undefined)
    assert.equal(seen[0].payload.changes, undefined)
    assert.equal(seen[0].payload.textOmitted, true)
  } finally { f.s.dispose() }
})

test('E3 opts target is an explicit alias, and a conflicting opts value cannot reroute the filter', async () => {
  const f = fixture({ resolve: async ({ filter }) => ({ link,
    transport: { target: filter.windowId } }) })
  try {
    const h = f.events('A').subscribe({}, () => {}, { target: 'window-A' })
    await h.ready
    assert.equal(h.filter.windowId, 'window-A')
    const p = f.events('B').subscribe({ windowId: 'window-A' }, () => {}, { target: 'window-B' })
    await p.ready
    assert.equal(p.filter.windowId, 'window-A')
  } finally { f.s.dispose() }
})
