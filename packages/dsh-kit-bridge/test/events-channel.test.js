import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createConnector } from '../src/connector.js'
import { startBridgeServer } from '../../dsh-vscode-kit/src/server.js'
import { EVENT_METHOD } from '../../dsh-vscode-kit/src/event-contract.js'

async function until(fn) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await delay(5) }
  assert.fail('condition did not become true')
}
async function fixture(t, serverExtra = {}, connectorExtra = {}) {
  const home = mkdtempSync(join(tmpdir(), 't56-events-'))
  const delivered = [], hellos = [], dispatches = []
  const server = await startBridgeServer({
    dshHome: home, portRange: [7550, 7559], events: true,
    onEvent: (event, ctx) => delivered.push({ event, link: ctx.link }),
    onRequest: (method, params) => {
      if (method === 'bridge.hello') { hellos.push(params); return { ok: true, protocolVersion: 1 } }
      return { pong: true }
    }, ...serverExtra,
  })
  const conn = createConnector({
    dshHome: home, events: true, isTrusted: () => true,
    dispatch: (method) => { dispatches.push(method); return { ok: true } }, ...connectorExtra,
  })
  t.after(async () => { conn.stop(); await server.close(); rmSync(home, { recursive: true, force: true }) })
  await conn.reconnect()
  await until(() => hellos.length > 0)
  await conn.request('bridge.ping') // FIFO barrier for hello/ack processing
  return { server, conn, delivered, hellos, dispatches, home }
}
async function install(f) {
  await until(() => f.conn.linkState.link?.events.ready)
  const descriptor = f.conn.linkState.link.events.openStream('transport-sub')
  const [target] = f.server.trusted
  assert.equal(target.events.acceptStream(descriptor), true)
  return { descriptor, target, source: f.conn.linkState.link }
}

test('E1 connector and server share opt-in schema; real ndjson event delivers on actual source link', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(f.hellos[0].eventChannel, { version: 1 })
  const { source, target } = await install(f)
  assert.equal(source.events.publish('documentChanged', { text: 'wire-sentinel' }), true)
  await f.conn.request('bridge.ping')
  await until(() => f.delivered.length === 1)
  assert.equal(f.delivered[0].link, target)
  assert.equal(f.delivered[0].event.payload.text, 'wire-sentinel')
  assert.equal(source.pendingCount, 0)
  assert.deepEqual(f.dispatches, [])
})

test('E1 connector defaults off and old peer without event capability stays unsupported', async (t) => {
  const f = await fixture(t, {}, { events: undefined })
  assert.equal(Object.hasOwn(f.hellos[0], 'eventChannel'), false)
  assert.equal(f.conn.linkState.link.events.ready, false)
  assert.equal(f.conn.linkState.link.events.openStream('s'), null)
  const [target] = f.server.trusted
  assert.equal(target.events.ready, false)
  assert.equal((await f.conn.request('bridge.ping')).pong, true)
})

test('E1 connector requires workspace trust and compatible event-enabled hello; no automatic subscription', async (t) => {
  const f = await fixture(t, { events: false }, { isTrusted: () => false })
  assert.equal(f.conn.linkState.link.events.ready, false)
  assert.equal(f.conn.linkState.link.events.publish('documentChanged', {}), false)
  assert.equal(f.delivered.length, 0)
})

test('E1 trust revocation, disconnect, stop and reconnect invalidate queues and epoch', async (t) => {
  let trusted = true
  const f = await fixture(t, {}, { isTrusted: () => trusted })
  const { source, target, descriptor } = await install(f)
  trusted = false
  assert.equal(source.events.publish('documentChanged', { text: 'forbidden' }), false)
  trusted = true
  await f.conn.reconnect()
  await until(() => f.conn.linkState.link?.events.ready)
  const next = f.conn.linkState.link.events.openStream('transport-sub')
  assert.notEqual(next.streamEpoch, descriptor.streamEpoch)
  assert.equal(source.closed, true)
  assert.equal(source.events.snapshot().outgoing.stale, true)
  await until(() => target.closed)
  assert.equal(target.events.snapshot().incoming.stale, true)
  const current = f.conn.linkState.link
  f.conn.stop()
  assert.equal(current.closed, true)
  assert.equal(current.events.snapshot().outCount, 0)
  assert.equal(f.delivered.length, 0)
})

test('E1 server trusted gate prevents credential/content leak even with forged authorized flag', async (t) => {
  const leaked = []
  const f = await fixture(t, {}, { onEvent: (event) => leaked.push(event) })
  const { target } = await install(f)
  // Simulate admission being withdrawn while the physical socket/hello remain live.
  // The diagnostic flag MUST NOT act as fallback to links.
  f.server.trusted.delete(target)
  target.authorized = true
  const descriptor = target.events.openStream('server-sub')
  if (descriptor) f.conn.linkState.link.events.acceptStream(descriptor)
  target.events.publish('documentChanged', { text: 'secret-sentinel' })
  // Response is never event-queued, so it is a same-link FIFO barrier after publish.
  await f.conn.request('bridge.ping')
  assert.equal(leaked.length, 0, 'links membership must not leak event content or credentials')
  assert.equal(descriptor, null, 'links membership must not grant event admission')
  assert.deepEqual(f.dispatches, [])
})

test('E1 unadmitted raw peer gets only credential-free hello; wrong token cannot install/deliver events', async (t) => {
  const f = await fixture(t)
  const frames = []
  const raw = createConnection({ host: '127.0.0.1', port: f.server.port })
  t.after(() => raw.destroy())
  let buffer = ''
  raw.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let n
    while ((n = buffer.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1)
    }
  })
  await until(() => frames.length > 0)
  assert.equal(frames[0].method, 'bridge.hello')
  assert.equal(frames[0].token, undefined)
  await until(() => f.server.links.size === 2)
  const untrusted = [...f.server.links].find((link) => !f.server.trusted.has(link))
  untrusted.authorized = true
  assert.equal(untrusted.events.openStream('forged'), null)
  raw.write(JSON.stringify({ method: EVENT_METHOD, token: 'wrong', params: { text: 'sensitive' } }) + '\n')
  // A valid peer's roundtrip is an independent barrier, then allow raw socket processing.
  await f.conn.request('bridge.ping')
  await delay(20)
  assert.equal(frames.length, 1, 'unadmitted peer must receive no credentials/content after hello')
  assert.equal(f.delivered.length, 0)
  assert.equal(f.server.trusted.has(untrusted), false)
})
