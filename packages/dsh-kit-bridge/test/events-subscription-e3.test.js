import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as turn } from 'node:timers/promises'
import { apply } from '../../dsh-vscode-kit/src/index.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createEventBroker, eventCursorError } from '../../dsh-vscode-kit/src/event-subscriptions.js'
import { validateResponse as assertResponse } from '../../dsh-vscode-kit/src/response-contract.js'
import { createCapabilities } from '../src/capabilities.js'
import { createConnector } from '../src/connector.js'

const names = ['onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidSaveTextDocument',
  'onDidChangeTextDocument', 'onDidChangeTextEditorSelection', 'onDidChangeTextEditorVisibleRanges',
  'onDidChangeVisibleTextEditors', 'onDidChangeTabs', 'onDidChangeActiveTextEditor', 'onDidChangeWindowState']
async function until(fn) {
  for (let i = 0; i < 500; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.fail('E3 real TCP condition timed out')
}
async function fixture({ brokerOverride = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 't58-e3-'))
  const root = join(home, 'workspace').replaceAll('\\', '/')
  mkdirSync(root)
  const documents = ['a', 'b'].map((n) => {
    const file = `${root}/${n}.txt`
    writeFileSync(file, 'abc')
    return { text: 'abc', version: 1, isDirty: false,
      uri: { fsPath: file, scheme: 'file', toString: () => `file:${file}` },
      getText() { return this.text } }
  })
  let trusted = true
  const callbacks = new Map(names.map((n) => [n, new Set()]))
  const eventHost = { incarnationOf: (d) => `inc-${d.uri.fsPath}`, isTrusted: () => trusted,
    textLength: (d) => d.text.length, textDocuments: () => documents,
    visibleTextEditors: () => [], tabs: () => [], tabUris: () => [],
    ...Object.fromEntries(names.map((n) => [n, (fn) => {
      callbacks.get(n).add(fn)
      return { dispose: () => callbacks.get(n).delete(fn) }
    }])) }
  const host = { workspaceRoots: () => [root], isTrusted: () => trusted, log() {},
    readDocumentState: async () => ({ version: 1, isDirty: false, eol: 'lf', lineCount: 1,
      textLength: 3, byteLength: 3, text: 'abc', incarnation: 'read-inc' }) }
  let service
  const disposers = []
  const ctx = { provide(n, value) { if (n === 'dshVscodeKit') service = value },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d) } }
  const boot = apply(ctx, { dshHome: home, events: true, onLog() {},
    consumers: { meta: 'read', delta: 'read', other: 'read' } })
  await boot.boot
  const grants = new GrantStore(), linkState = { link: null }
  const caps = createCapabilities(host, { grants })
  if (brokerOverride) caps.dispatch.eventBroker = brokerOverride
  const conn = createConnector({ dispatch: caps.dispatch, grants, linkState, events: true,
    editorEventHost: eventHost, editorEventFilter: { roots: [root], textMode: 'metadata' },
    dshHome: home, isTrusted: () => trusted, pollIntervalMs: 20 })
  await conn.reconnect()
  await until(() => linkState.link?.events.ready === true && boot.kit.lastEditor !== null)
  const fire = (name, value) => { for (const fn of callbacks.get(name)) fn(value) }
  return { home, host, eventHost, root, documents, caps, conn, kit: boot.kit, linkState, service,
    events: (name) => service.forPlugin(name, { declared: 'read' }).vscode.events,
    fire, trust(value) { trusted = value },
    listeners: () => [...callbacks.values()].reduce((n, s) => n + s.size, 0),
    change(d, text) {
      d.text = text; d.version++
      fire('onDidChangeTextDocument', { document: d, contentChanges: [{ rangeOffset: 0,
        rangeLength: 1, text: text[0], range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] })
    },
    async close() {
      conn.stop()
      for (const d of disposers.reverse()) d()
      await boot.kit.server.close()
      rmSync(home, { recursive: true, force: true })
    } }
}

// A real broker, connector, protocol and kit are used, not hand-written receipts.
test('E3 bridge no explicit subscription means zero listeners, no stream, no broadcast', async () => {
  const f = await fixture()
  try {
    assert.equal(f.listeners(), 0, 'connection/hello must not activate editor listeners')
    assert.equal(f.caps.eventBroker.count, 0)
    assert.equal(f.caps.eventBroker.allowsPublish(), false, '未订阅仍广播 is forbidden')
    assert.equal(f.linkState.link.events.snapshot().outgoing, null)
    f.change(f.documents[0], 'xbc')
    await turn()
    assert.equal(f.linkState.link.events.snapshot().outgoing, null)
  } finally { await f.close() }
})

test('E3 connector publication gate blocks an orphan E1 stream without an E3 subscription', async () => {
  // 故意保留 E1 流和生产者：不能只靠“没监听器/没流”让零广播断言空过。
  let allowed = false
  const gate = { allowsPublish: () => allowed, published() {}, dropLink() {},
    attach(hooks) { hooks.configure({ roots: [], types: ['windowFocusChanged'], textMode: 'metadata' }); hooks.activate() } }
  const f = await fixture({ brokerOverride: gate })
  try {
    const observed = []
    f.kit.onEventEnvelope = (event) => observed.push(event)
    const descriptor = f.linkState.link.events.openStream('orphan-E1')
    assert.ok(descriptor)
    const [sourceLink] = [...f.kit.server.trusted.keys()]
    assert.equal(sourceLink.events.acceptStream(descriptor), true)
    assert.equal(f.caps.eventBroker.count, 0)
    f.fire('onDidChangeWindowState', { focused: true })
    await f.conn.request('bridge.ping') // 同 socket 的因果栅栏，不猜时间窗口。
    await turn()
    assert.equal(observed.length, 0, 'unsolicited event reached the TCP receiver without an E3 subscription')
    allowed = true
    f.fire('onDidChangeWindowState', { focused: false })
    await f.conn.request('bridge.ping'); await turn()
    assert.equal(observed.length, 1, 'positive control: same orphan stream really can deliver if gate opens')
    assert.equal(observed[0].type, 'windowFocusChanged')
  } finally { await f.close() }
})

test('E3 bridge metadata defaults, separate remote id, zero upstream residue and resubscribe', async () => {
  const f = await fixture()
  try {
    const seen = []
    const h = f.events('meta').subscribe({ windowId: '#1' }, (e) => seen.push(e))
    await h.ready
    assert.equal(h.ok, true)
    const remote = f.caps.eventBroker.snapshot().subscriptions[0]
    assert.notEqual(remote.id, h.subscriptionId, 'local handle id and broker id are different namespaces')
    assert.equal(remote.consumer, 'meta')
    f.change(f.documents[0], 'xbc')
    await until(() => seen.length === 1)
    assert.equal(seen[0].payload.changes, undefined)
    assert.equal(seen[0].payload.textOmitted, true)
    f.fire('onDidChangeTextEditorVisibleRanges', { textEditor: { document: f.documents[0] }, visibleRanges: [] })
    await new Promise((r) => setTimeout(r, 70))
    assert.deepEqual(seen.map((e) => e.type), ['documentChanged'], 'visibleRanges is opt-in')
    const result = await h.dispose()
    assert.equal(result.ok, true)
    assert.equal(f.caps.eventBroker.count, 0, 'zero upstream subscription residue')
    assert.equal(f.listeners(), 0)
    f.change(f.documents[0], 'ybc')
    await turn()
    assert.equal(seen.length, 1, 'zero callbacks after cancellation')
    const again = f.events('meta').subscribe({ windowId: '#1', type: 'windowFocusChanged' }, (e) => seen.push(e))
    await again.ready
    assert.equal(again.ok, true, 'last cancellation must release local incoming stream too')
    f.fire('onDidChangeWindowState', { focused: false })
    await until(() => seen.length === 2)
    await again.dispose()
  } finally { await f.close() }
})

test('E3 base facade keeps live receipt/failure state and uses only the unbound partition', async () => {
  const f = await fixture()
  try {
    const base = f.service.vscode.events
    const failure = base.subscribe({ windowId: 'not-a-window' }, () => {})
    await assert.rejects(failure.ready, (e) => e.code === -32014)
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, -32014)
    const seen = []
    const h = base.subscribe({ windowId: '#1' }, (e) => seen.push(e))
    await h.ready
    assert.equal(h.consumer, 'unbound')
    assert.equal(eventCursorError(h.cursor), null, 'aggregate facade must not retain pre-ready null cursor')
    f.change(f.documents[0], 'xbc')
    await until(() => seen.length === 1)
    assert.equal(seen[0].payload.changes, undefined)
    await h.dispose()
    assert.equal(f.caps.eventBroker.count, 0)
  } finally { await f.close() }
})

test('E3 bridge subscription policy actually powers E2 delta on the TCP wire', async () => {
  const f = await fixture()
  try {
    const seen = [], file = f.documents[0].uri.fsPath
    const h = f.events('delta').subscribe({ windowId: '#1', type: 'documentChanged', textMode: 'delta', files: [file] }, (e) => seen.push(e))
    await h.ready
    const policy = f.caps.eventBroker.policyFor()
    assert.deepEqual(policy.roots, [f.root])
    assert.deepEqual(policy.bodyFiles, [file])
    assert.equal(policy.textMode, 'delta')
    f.change(f.documents[0], '鲸bc')
    await until(() => seen.length === 1)
    assert.equal(seen[0].payload.stale, undefined)
    assert.deepEqual(seen[0].payload.changes.map((c) => c.text), ['鲸'])
    const state = await f.service.forPlugin('delta', { declared: 'read' }).vscode.getDocumentState({ file }, { target: '#1' })
    assert.equal(eventCursorError(state.cursor), null, 'snapshot uses the same cursor validator')
    assert.equal(state.cursor.nextSeq, 2)
    const second = f.events('other').subscribe({ windowId: '#1', type: 'documentChanged' }, () => {})
    await second.ready
    assert.equal(second.cursor.nextSeq, 2, 'late subscriber starts at current sequence, not stream creation')
    await h.dispose(); await second.dispose()
    assert.equal(f.caps.eventBroker.count, 0)
  } finally { await f.close() }
})

test('E3 bridge mixed metadata/delta union retains metadata files without leaking their bodies', async () => {
  const f = await fixture()
  try {
    const a = [], b = [], fileA = f.documents[0].uri.fsPath, fileB = f.documents[1].uri.fsPath
    const meta = f.events('meta').subscribe({ windowId: '#1', files: [fileB] }, (e) => b.push(e))
    const delta = f.events('delta').subscribe({ windowId: '#1', type: 'documentChanged', files: [fileA], textMode: 'delta' }, (e) => a.push(e))
    await Promise.all([meta.ready, delta.ready])
    f.fire('onDidSaveTextDocument', f.documents[1])
    f.change(f.documents[1], 'Sbc')
    f.change(f.documents[0], 'Xbc')
    await until(() => b.length === 2 && a.length === 1)
    assert.deepEqual(b.map((e) => e.type), ['documentSaved', 'documentChanged'])
    assert.equal(b.some((e) => e.type === 'gap'), false, 'filtered sequence is not a lost frame')
    assert.equal(b[1].payload.changes, undefined)
    assert.equal(a[0].payload.changes[0].text, 'X')
    assert.equal(a[0].payload.file, fileA)
    await meta.dispose(); await delta.dispose()
  } finally { await f.close() }
})

test('E3 bridge visibleRanges requires an explicit event type', async () => {
  const f = await fixture()
  try {
    const seen = []
    const h = f.events('meta').subscribe({ windowId: '#1', type: 'visibleRangesChanged' }, (e) => seen.push(e))
    await h.ready
    f.fire('onDidChangeTextEditorVisibleRanges', { textEditor: { document: f.documents[0] }, visibleRanges: [] })
    await until(() => seen.length === 1)
    assert.equal(seen[0].type, 'visibleRangesChanged')
    await h.dispose()
  } finally { await f.close() }
})

test('E3 bridge unknown sessions fail closed; payload identity never grants a session', async () => {
  const f = await fixture()
  try {
    const h = f.events('meta').subscribe({ windowId: '#1', sessionId: 'arbitrary-session' }, () => {})
    await assert.rejects(h.ready, (e) => e.code === -32010)
    assert.equal(f.caps.eventBroker.count, 0)
    await assert.rejects(f.caps.dispatch('vscode.events.subscribe', { sessionId: 'arbitrary-session' }, { link: f.linkState.link }), (e) => e.code === -32010)
    const seen = []
    const good = f.events('meta').subscribe({ windowId: '#1', type: 'windowFocusChanged' }, (e) => seen.push(e))
    await good.ready
    f.fire('onDidChangeWindowState', { focused: true })
    await until(() => seen.length === 1)
    assert.equal(seen[0].source.sessionId, null)
    await good.dispose()
  } finally { await f.close() }
})

test('E3 session-only pins its bound window, not newer active; conflicting window is -32014', async () => {
  const f = await fixture()
  let second
  try {
    await f.kit.grantEditing({ sessionId: 'session-A' })
    const grants = new GrantStore(), state = { link: null }
    const caps = createCapabilities(f.host, { grants })
    second = createConnector({ dispatch: caps.dispatch, grants, linkState: state, events: true,
      editorEventHost: f.eventHost, editorEventFilter: { roots: [f.root] },
      dshHome: f.home, isTrusted: () => true })
    await second.reconnect()
    await until(() => state.link?.events.ready === true && f.kit.server.trusted.size === 2)
    const seen = []
    const h = f.events('meta').subscribe({ sessionId: 'session-A', type: 'windowFocusChanged' }, (e) => seen.push(e))
    await h.ready
    assert.equal(f.caps.eventBroker.count, 1, 'session must stay on original window')
    assert.equal(caps.eventBroker.count, 0, 'new active window must not receive the subscription')
    const conflict = f.events('other').subscribe({ sessionId: 'session-A', windowId: '#2' }, () => {})
    await assert.rejects(conflict.ready, (e) => e.code === -32014)
    f.fire('onDidChangeWindowState', { focused: true })
    await until(() => seen.length === 1)
    const firstWindowId = f.kit._windowIdOf([...f.kit.server.trusted.keys()][0])
    assert.equal(seen[0].source.windowId, firstWindowId)
    assert.equal(seen[0].source.sessionId, null, 'an observed event must not impersonate a DSH session')
    await h.dispose()
  } finally { second?.stop(); await f.close() }
})

test('E3 bridge delta rejects missing files and untrusted workspace without upstream residue', async () => {
  const f = await fixture()
  try {
    const bad = f.events('delta').subscribe({ windowId: '#1', textMode: 'delta' }, () => {})
    assert.equal(bad.error.reason, 'files-required-for-delta')
    f.trust(false)
    const untrusted = f.events('meta').subscribe({ windowId: '#1' }, () => {})
    await assert.rejects(untrusted.ready)
    assert.equal(f.caps.eventBroker.count, 0)
    assert.equal(f.listeners(), 0)
  } finally { await f.close() }
})

test('E3 bridge receive-only event RPC is rejected by the real protocol', async () => {
  const f = await fixture()
  try {
    const [link] = [...f.kit.server.trusted.keys()]
    await assert.rejects(link.request('vscode.events.event', { payload: { text: 'BODY' } }, { withToken: true }), (e) => e.code === -32600)
    assert.equal(f.caps.eventBroker.count, 0)
  } finally { await f.close() }
})

test('E3 event-only incarnation is not a write anchor, even after bounded history eviction', async () => {
  const f = await fixture()
  try {
    const sourceLink = [...f.kit.server.trusted.keys()][0]
    f.kit._noteEventIncarnation('event-only')
    assert.equal(f.kit._anchorSources.has('event-only'), false)
    assert.throws(() => f.kit._assertAnchorSource('vscode.applyEdit', { expectedIncarnation: 'event-only' },
      { link: sourceLink, sessionId: 's' }), (e) => e.code === -32602 && e.data.source === 'event')
    for (let i = 0; i < 257; i++) f.kit._noteEventIncarnation(`other-${i}`)
    assert.equal(f.kit._eventIncarnations.has('event-only'), false, 'test must exercise actual eviction')
    assert.ok(f.kit._eventIncarnations.size <= 256)
    assert.throws(() => f.kit._assertAnchorSource('vscode.applyEdit', { expectedIncarnation: 'event-only' },
      { link: sourceLink, sessionId: 's' }), (e) => e.code === -32602 && e.data.source === 'event-history-overflow')
    const grant = await f.kit.grantEditing({ sessionId: 's' })
    assert.equal(grant.delivered, true)
    const state = await f.kit.readStateFor('s', f.documents[0].uri.fsPath)
    assert.doesNotThrow(() => f.kit._assertAnchorSource('vscode.applyEdit', { expectedIncarnation: state.incarnation },
      { link: sourceLink, sessionId: 's' }))
  } finally { await f.close() }
})

test('E3 trust loss still permits unsubscribe cleanup', async () => {
  const f = await fixture()
  try {
    const h = f.events('meta').subscribe({ windowId: '#1' }, () => {})
    await h.ready
    f.trust(false)
    const result = await h.dispose()
    assert.equal(result.ok, true)
    assert.equal(f.caps.eventBroker.count, 0)
    assert.equal(f.listeners(), 0)
  } finally { await f.close() }
})

test('E3 shared snapshot cursor rejects unsafe numbers and cross-stream receipts', () => {
  const state = { file: '/ws/a', version: 1, isDirty: false, eol: 'lf', lineCount: 1, textLength: 0 }
  assertResponse('vscode.getDocumentState', state)
  assert.throws(() => assertResponse('vscode.getDocumentState', { ...state, cursor: { subscriptionId: 's', streamEpoch: 'e', nextSeq: Number.MAX_SAFE_INTEGER + 1 } }), (e) => e.code === -32009)
  const broker = createEventBroker()
  assert.equal(broker.allowsPublish(), false)
  broker.dispose()
})

test('E3 extension forwards live host and explicit initial editorEventFilter to connector', () => {
  const source = readFileSync(new URL('../src/extension.js', import.meta.url), 'utf8')
  assert.match(source, /editorEventHost:\s*host\.editorEvents/)
  assert.match(source, /editorEventFilter:\s*initialEventFilter/)
  assert.match(source, /textMode:\s*'metadata'/)
})
