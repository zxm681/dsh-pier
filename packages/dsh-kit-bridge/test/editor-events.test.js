import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { EVENT_MAX_BYTES, EVENT_QUEUE_MAX_BYTES, EVENT_QUEUE_MAX_COUNT } from '../../dsh-vscode-kit/src/event-contract.js'
const { createEditorEvents } = await import(process.env.T57_COLLECTOR_MODULE
  ? pathToFileURL(process.env.T57_COLLECTOR_MODULE).href : '../src/editor-events.js')

const names = ['onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidSaveTextDocument',
  'onDidChangeTextDocument', 'onDidChangeTextEditorSelection', 'onDidChangeTextEditorVisibleRanges',
  'onDidChangeVisibleTextEditors', 'onDidChangeTabs', 'onDidChangeActiveTextEditor', 'onDidChangeWindowState']
const p = (line, character) => ({ line, character })
const r = (line, start, end) => ({ start: p(line, start), end: p(line, end) })
function doc(text = 'a😀中\r\n二x', file = 'C:/root/a.txt', scheme = 'file') {
  return { text, version: 1, isDirty: false,
    uri: { fsPath: file, scheme, toString: () => `${scheme}:${file}` },
    getText() { return this.text },
  }
}
function fixture({ filter = { roots: ['C:/root'], textMode: 'delta' }, documents = [doc()] } = {}) {
  const callbacks = new Map(names.map((n) => [n, new Set()])), delivered = [], tasks = new Set()
  const ids = new WeakMap()
  let id = 0, trusted = true
  const host = {
    documents, visible: [], tabList: [], isTrusted: () => trusted,
    textDocuments: () => host.documents, visibleTextEditors: () => host.visible,
    tabs: () => host.tabList, tabUris: (t) => t.uris,
    incarnationOf(d) { if (!ids.has(d)) ids.set(d, `inc-shared-${++id}`); return ids.get(d) },
    textLength: (d) => d.text.length,
    ...Object.fromEntries(names.map((n) => [n, (fn) => {
      callbacks.get(n).add(fn)
      return { dispose: () => callbacks.get(n).delete(fn) }
    }])),
  }
  const collector = createEditorEvents({ host, filter,
    emit: (type, payload) => delivered.push({ type, payload }),
    timers: { setTimeout(fn) { const t = { fn, unref() { t.unrefed = true } }; tasks.add(t); return t },
      clearTimeout(t) { tasks.delete(t) } },
  })
  const fire = (n, value) => { for (const fn of callbacks.get(n)) fn(value) }
  return { host, collector, delivered, tasks, fire, d: documents[0],
    trust(value) { trusted = value },
    listeners: () => [...callbacks.values()].reduce((n, set) => n + set.size, 0),
    flush() { for (const t of [...tasks]) { tasks.delete(t); t.fn() } },
    change(changes, after) { const d = documents[0]; d.text = after; d.version++; d.isDirty = true
      fire('onDidChangeTextDocument', { document: d, contentChanges: changes }) },
  }
}
const edit = (rangeOffset, rangeLength, text, range) => ({ rangeOffset, rangeLength, text, range })
const changed = (f) => f.delivered.filter((e) => e.type === 'documentChanged').at(-1)?.payload

test('E2 all document/open/save/dirty/active/focus event types and no body on lifecycle', () => {
  const f = fixture(); f.collector.activate()
  f.fire('onDidOpenTextDocument', f.d); f.fire('onDidSaveTextDocument', f.d)
  f.fire('onDidChangeTextDocument', { document: f.d, contentChanges: [] })
  f.fire('onDidChangeActiveTextEditor', { document: f.d }); f.fire('onDidChangeActiveTextEditor', undefined)
  f.fire('onDidChangeWindowState', { focused: true }); f.fire('onDidCloseTextDocument', f.d)
  assert.deepEqual(f.delivered.map((e) => e.type), ['documentOpened', 'documentSaved', 'documentChanged',
    'activeEditorChanged', 'activeEditorChanged', 'windowFocusChanged', 'documentClosed'])
  assert.equal(changed(f).changeKind, 'dirty'); assert.equal(changed(f).beforeVersion, 1)
  assert.equal(changed(f).afterVersion, 1)
  assert.equal(f.delivered[4].payload.file, null)
  assert.equal(f.delivered[5].payload.focused, true)
  assert.equal(JSON.stringify(f.delivered).includes(f.d.text), false)
  f.collector.dispose()
})

test('E2 UTF16 emoji Chinese CRLF multicursor uses one coordinate conversion and old offsets', () => {
  const f = fixture(); f.collector.activate()
  const before = f.d.text
  const changes = [edit(1, 2, '鲸', r(0, 1, 3)), edit(7, 1, '😀', r(1, 1, 2))]
  f.change(changes, 'a鲸中\r\n二😀')
  const got = changed(f)
  assert.equal(got.stale, undefined)
  assert.deepEqual(got.changes.map((c) => [c.rangeOffset, c.rangeLength, c.textLength]), [[7, 1, 2], [1, 2, 1]])
  assert.deepEqual(got.changes[1].range, { start: { line: 1, column: 2 }, end: { line: 1, column: 4 } })
  assert.deepEqual(got.changes[0].range, { start: { line: 2, column: 2 }, end: { line: 2, column: 3 } })
  let replay = before
  for (const c of got.changes) replay = replay.slice(0, c.rangeOffset) + c.text + replay.slice(c.rangeOffset + c.rangeLength)
  assert.equal(replay, f.d.text); assert.equal(got.textLength, f.d.text.length)
  assert.notEqual(got.textLength, Buffer.byteLength(f.d.text, 'utf8'))
  f.collector.dispose()
})

test('E2 snapshot and delta use host incarnationOf, and reopen creates only host incarnation', () => {
  const f = fixture(); f.collector.activate()
  const snapshot = f.collector.snapshot(f.d, { includeText: true })
  assert.equal(snapshot.incarnation, f.host.incarnationOf(f.d))
  f.change([edit(0, 1, 'b', r(0, 0, 1))], 'b😀中\r\n二x')
  assert.equal(changed(f).incarnation, snapshot.incarnation)
  assert.equal(f.collector.snapshot(f.d).incarnation, snapshot.incarnation)
  const reopened = doc(); f.fire('onDidOpenTextDocument', reopened)
  assert.notEqual(f.delivered.at(-1).payload.incarnation, snapshot.incarnation)
  assert.equal(f.delivered.at(-1).payload.incarnation, f.host.incarnationOf(reopened))
  f.collector.dispose()
})

for (const mode of ['untrusted', 'non-file', 'outside-root', 'prefix-sibling', 'parent-traversal', 'metadata', 'wrong-file']) {
  test(`E2 sentinel forbidden channel zero bytes: ${mode}`, () => {
    const sentinel = `SENTINEL-DO-NOT-LEAK-${randomBytes(12).toString('hex')}`
    const d = doc(sentinel)
    if (mode === 'non-file') d.uri.scheme = 'untitled'
    if (mode === 'outside-root') d.uri.fsPath = 'C:/elsewhere/a.txt'
    if (mode === 'prefix-sibling') d.uri.fsPath = 'C:/root-evil/a.txt'
    if (mode === 'parent-traversal') d.uri.fsPath = 'C:/root/../elsewhere/a.txt'
    const f = fixture({ documents: [d], filter: { roots: ['C:/root'],
      textMode: mode === 'metadata' ? 'metadata' : 'delta',
      ...(mode === 'wrong-file' ? { files: ['C:/root/b.txt'] } : {}) } })
    if (mode === 'untrusted') f.trust(false)
    f.collector.activate()
    const snapshot = f.collector.snapshot(d, { includeText: mode !== 'metadata' })
    f.change([edit(0, sentinel.length, sentinel, r(0, 0, sentinel.length))], sentinel)
    f.fire('onDidOpenTextDocument', d); f.fire('onDidSaveTextDocument', d)
    const wire = Buffer.from(JSON.stringify({ snapshot, events: f.delivered }), 'utf8')
    assert.equal(wire.includes(Buffer.from(sentinel, 'utf8')), false, 'forbidden channel leaked sentinel bytes')
    assert.equal(f.collector.stats.cachedBytes, 0)
    f.collector.dispose()
  })
}

test('E2 sentinel detector is sensitive: the forbidden-channel assertion is not vacuous', () => {
  // Positive control for the check used above. The same `includes` predicate must
  // SEE the random sentinel when it really is on an emitted channel; otherwise an
  // encoding mistake would make every forbidden-channel assertion pass vacuously.
  const sentinel = `SENTINEL-DO-NOT-LEAK-${randomBytes(12).toString('hex')}`
  const leaky = Buffer.from(JSON.stringify({ type: 'documentChanged',
    payload: { changes: [{ rangeOffset: 0, rangeLength: 0, text: sentinel }] } }), 'utf8')
  assert.equal(leaky.includes(Buffer.from(sentinel, 'utf8')), true,
    'detector must see sentinel bytes when they are really on the wire')
  const omitted = Buffer.from(JSON.stringify({ type: 'documentChanged',
    payload: { textOmitted: true, stale: true, reason: 'event-too-large' } }), 'utf8')
  assert.equal(omitted.includes(Buffer.from(sentinel, 'utf8')), false,
    'a textOmitted/stale payload carries zero sentinel bytes')
})

test('E2 trust checked again after baseline; never delivers cached pre-trust text', () => {
  const f = fixture(); f.collector.activate(); f.trust(false)
  f.change([edit(0, 1, 'SENTINEL-DO-NOT-LEAK-revoked', r(0, 0, 1))], 'SENTINEL-DO-NOT-LEAK-revoked😀中\r\n二x')
  assert.equal(Buffer.from(JSON.stringify(f.delivered)).includes(Buffer.from('SENTINEL-DO-NOT-LEAK-revoked')), false)
  assert.equal(changed(f).changes, undefined); assert.equal(f.collector.stats.cachedBytes, 0)
  f.collector.dispose()
})

test('E2 huge change becomes stale metadata without truncation; byte limit is UTF8', () => {
  const f = fixture(); f.collector.activate()
  const text = '中'.repeat(Math.floor(EVENT_MAX_BYTES / 2))
  assert.ok(text.length < EVENT_MAX_BYTES); assert.ok(Buffer.byteLength(text) > EVENT_MAX_BYTES)
  f.change([edit(0, 1, text, r(0, 0, 1))], text + '😀中\r\n二x')
  assert.equal(changed(f).stale, true); assert.equal(changed(f).reason, 'event-too-large')
  assert.equal(changed(f).changes, undefined)
  assert.equal(Buffer.from(JSON.stringify(f.delivered)).includes(Buffer.from(text)), false)
  assert.ok(Buffer.byteLength(JSON.stringify(f.delivered)) < EVENT_MAX_BYTES)
  f.collector.dispose()
})

test('E2 JSON escaping overhead also causes stale, not truncated complete delta', () => {
  const f = fixture(); f.collector.activate(); const text = '\u0000'.repeat(50000)
  f.change([edit(0, 1, text, r(0, 0, 1))], text + '😀中\r\n二x')
  assert.equal(changed(f).stale, true); assert.equal(changed(f).reason, 'event-too-large')
  assert.equal(changed(f).changes, undefined); f.collector.dispose()
})

test('E2 merged sequential bases downgrade stale rather than invent common-before delta', () => {
  const f = fixture({ documents: [doc('abc')] }); f.collector.activate()
  f.change([edit(0, 0, 'x', r(0, 0, 0)), edit(1, 1, 'A', r(0, 1, 2))], 'xAbc')
  assert.equal(changed(f).stale, true); assert.equal(changed(f).reason, 'unsupported-change-basis')
  assert.equal(changed(f).changes, undefined); f.collector.dispose()
})

test('E2 missing baseline and overlapping/invalid ranges fail closed with metadata', () => {
  for (const changes of [[edit(0, 2, 'x', r(0, 0, 2)), edit(1, 1, 'y', r(0, 1, 2))],
    [edit(-1, 1, 'x', r(0, 0, 1))], [edit(0, 1, 'x', r(5, 0, 1))]]) {
    const f = fixture(); f.collector.activate(); f.change(changes, 'unknown')
    assert.equal(changed(f).stale, true); assert.equal(changed(f).changes, undefined); f.collector.dispose()
  }
  const f = fixture({ documents: [] }); f.collector.activate(); const d = doc('changed'); d.version = 2
  f.fire('onDidChangeTextDocument', { document: d, contentChanges: [edit(0, 1, 'c', r(0, 0, 1))] })
  assert.equal(changed(f).reason, 'missing-baseline'); f.collector.dispose()
})

function tab(d) { return { uris: [d.uri], group: { viewColumn: 1 }, isPreview: false, label: 'SENTINEL-label' } }
function closeTab(f, t) { f.fire('onDidChangeTabs', { opened: [], closed: [t], changed: [] }) }
const docCloses = (f) => f.delivered.filter((e) => e.type === 'documentClosed')

test('E2 split editor closing one split never fabricates docClosed', () => {
  const f = fixture(); f.collector.activate(); const a = tab(f.d), b = tab(f.d)
  f.host.visible = [{ document: f.d }]; f.host.tabList = [b]; closeTab(f, a)
  assert.equal(docCloses(f).length, 0, 'closing one tab must not close a document with another view')
  f.fire('onDidCloseTextDocument', f.d)
  assert.equal(docCloses(f).length, 0)
  f.host.visible = []; f.host.tabList = []; closeTab(f, b)
  assert.equal(docCloses(f).length, 1); f.collector.dispose()
})

test('E2 preview replacement is tabs lifecycle, not docClosed', () => {
  const f = fixture(); f.collector.activate(); const old = tab(f.d), next = tab(doc('other', 'C:/root/b.txt'))
  f.host.tabList = [next]
  f.fire('onDidChangeTabs', { opened: [next], closed: [old], changed: [] })
  assert.equal(docCloses(f).length, 0, 'preview replacement alone cannot dispose a document')
  assert.deepEqual(f.delivered[0].payload.opened[0].files, ['C:/root/b.txt'])
  assert.equal(JSON.stringify(f.delivered).includes('SENTINEL-label'), false)
  f.fire('onDidCloseTextDocument', f.d); assert.equal(docCloses(f).length, 1); f.collector.dispose()
})

test('E2 same file multiple views including hidden tab require last view and real close', () => {
  const f = fixture(); f.collector.activate(); const first = tab(f.d), hidden = tab(f.d)
  f.host.tabList = [hidden]; f.host.visible = []
  closeTab(f, first); f.fire('onDidCloseTextDocument', f.d)
  assert.equal(docCloses(f).length, 0, 'hidden same-file view still owns the document')
  f.host.tabList = []; f.fire('onDidChangeVisibleTextEditors', [])
  assert.equal(docCloses(f).length, 1)
  f.fire('onDidCloseTextDocument', f.d); assert.equal(docCloses(f).length, 1)
  f.collector.dispose()
})

test('E2 select/scroll preserves multiple cursors UTF16 and coalesces by distinct view', () => {
  const f = fixture(); f.collector.activate(); const editor = { document: f.d }, other = { document: f.d }
  const selections = [{ ...r(0, 1, 3), anchor: p(0, 3), active: p(0, 1) },
    { ...r(1, 0, 1), anchor: p(1, 0), active: p(1, 1) }]
  for (let i = 0; i < 3; i++) f.fire('onDidChangeTextEditorSelection', { textEditor: editor, selections, kind: 1 })
  f.fire('onDidChangeTextEditorSelection', { textEditor: other, selections })
  f.fire('onDidChangeTextEditorVisibleRanges', { textEditor: editor, visibleRanges: [r(1, 0, 2)] })
  assert.equal(f.tasks.size, 1); assert.equal([...f.tasks][0].unrefed, true)
  f.flush(); assert.equal(f.delivered.length, 3)
  const s = f.delivered[0].payload.selections
  assert.deepEqual(s[0].anchor, { line: 1, column: 4 }); assert.deepEqual(s[0].active, { line: 1, column: 2 })
  assert.equal(s.length, 2); assert.notEqual(f.delivered[0].payload.viewId, f.delivered[1].payload.viewId)
  assert.deepEqual(f.delivered[2].payload.ranges[0].start, { line: 2, column: 1 })
  assert.equal(Object.hasOwn(s[0], 'text'), false); f.collector.dispose()
})

test('E2 repeat activate dispose enabled toggle and disconnected restart have zero listener/timer residue', () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) {
    f.collector.activate(); f.collector.activate(); assert.equal(f.listeners(), 10)
    f.fire('onDidChangeTextEditorVisibleRanges', { textEditor: { document: f.d }, visibleRanges: [r(0, 0, 1)] })
    assert.equal(f.tasks.size, 1); f.collector.dispose(); f.collector.dispose()
    assert.equal(f.listeners(), 0); assert.equal(f.tasks.size, 0)
    assert.deepEqual(f.collector.stats, { active: false, listeners: 0, timers: 0, pending: 0, cachedDocuments: 0, cachedBytes: 0 })
    f.flush(); assert.equal(f.delivered.length, 0)
  }
})

test('E2 configure clears pending/cache and types filtering does not leak selection text', () => {
  const f = fixture(); f.collector.activate()
  f.fire('onDidChangeTextEditorSelection', { textEditor: { document: f.d }, selections: [] })
  f.collector.configure({ roots: [], textMode: 'metadata', types: ['windowFocusChanged'] })
  assert.equal(f.tasks.size, 0); assert.equal(f.collector.stats.cachedBytes, 0)
  f.fire('onDidSaveTextDocument', f.d); f.fire('onDidChangeWindowState', { focused: false }); f.flush()
  assert.deepEqual(f.delivered, [{ type: 'windowFocusChanged', payload: { focused: false } }]); f.collector.dispose()
})

test('E2 cache and coalescing memory are bounded by E1 constants', () => {
  const documents = Array.from({ length: EVENT_QUEUE_MAX_COUNT + 8 }, (_, i) => doc('中'.repeat(2000), `C:/root/${i}.txt`))
  const f = fixture({ documents }); f.collector.activate()
  assert.ok(f.collector.stats.cachedDocuments <= EVENT_QUEUE_MAX_COUNT)
  assert.ok(f.collector.stats.cachedBytes <= EVENT_QUEUE_MAX_BYTES)
  for (const d of documents) f.fire('onDidChangeTextEditorVisibleRanges', { textEditor: { document: d }, visibleRanges: [] })
  assert.ok(f.collector.stats.pending <= EVENT_QUEUE_MAX_COUNT)
  assert.equal(f.delivered.at(-1).payload.stale, true)
  f.collector.dispose(); assert.equal(f.tasks.size, 0)
})

test('E2 partial host registration failure releases already installed listeners', () => {
  const f = fixture(); f.host.onDidChangeTabs = undefined
  assert.throws(() => f.collector.activate(), /missing onDidChangeTabs/)
  assert.equal(f.listeners(), 0); assert.equal(f.tasks.size, 0)
})

test('E2 snapshot oversize returns stale metadata and never a truncated body', () => {
  const f = fixture({ documents: [doc('中'.repeat(EVENT_MAX_BYTES))] })
  const snapshot = f.collector.snapshot(f.d, { includeText: true })
  assert.equal(snapshot.stale, true); assert.equal(snapshot.text, undefined)
})
