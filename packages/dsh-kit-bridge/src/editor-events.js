/**
 * E2: host-injected editor observation, no VS Code dependency and no subscription RPC.
 * API audit: microsoft/vscode ea1445cc7016315d0f5728f8e8b12a45dc0a7286 (1.91.0,
 * 2024-07-01). vscode.d.ts TextDocumentChangeEvent: "An array of content changes."
 * TextDocumentContentChangeEvent: "The range that got replaced." / "The offset
 * of the range that got replaced." These declarations DO NOT specify array bases.
 * pieceTreeTextBuffer.ts:293-294 computes all offsets before _doApplyEdits;
 * :480 "operations.sort(PieceTreeTextBuffer._sortOpsDescending)"; :484
 * "operations are from bottom to top". BUT textModelEvents.ts:377 merges with
 * "([] as IModelContentChange[]).concat(a.changes).concat(b.changes)".
 * Therefore common-before deltas are emitted ONLY after bounded replay == actual
 * after text; mixed/ambiguous batches become stale, never blindly re-sorted.
 * extHostDocuments.ts:149-166 updates the document BEFORE firing the event.
 * Never obtain old offsets by calling offsetAt on that updated document.
 *
 * Minimum ^1.91.0 audit (same commit vscode.d.ts): window events :10361-10377,
 * :10469; tabGroups :10342 / onDidChangeTabs :18234; workspace events
 * :13429-13468, textDocuments :13355, isTrusted :13681 all exist. No engine bump.
 * Only onDidGrantWorkspaceTrust exists (:13686), NOT a trust-revocation event;
 * recheck isTrusted at every delivery, never fabricate such an event.
 * UTF-16 clarification: vscode 8ea9487b0f76b9779071dca0e4bba7166683f67d
 * vscode.d.ts:203 "A valid zero-based offset in UTF-16 ... code units";
 * :279 "Character offsets are expressed using UTF-16 ... code units".
 * Wire positions alone become 1-based here, once. Offsets/lengths stay UTF-16;
 * UTF-8 is used ONLY for byte limits. No attribution or write permission here.
 */
import path from 'node:path'
import {
  EVENT_MAX_BYTES, EVENT_QUEUE_MAX_BYTES, EVENT_QUEUE_MAX_COUNT,
  SELECTION_COALESCE_MS, EVENT_TYPES,
} from '../../dsh-vscode-kit/src/event-contract.js'
// ★ T60：对外可见路径只有一个形态出口。事件 payload 里的 `file` 与过滤白名单
// 都走它 —— 以前 `fileOf()` 直接用宿主 `doc.uri.fsPath`（Windows 盘符小写），
// 而 RPC 出口是大写，两串字节精确比较 ⇒ 消费者照 `listOpenEditors` 写白名单就零命中。
import { canonicalPath } from '../../dsh-vscode-kit/src/paths.js'

const point = (p) => ({ line: p.line + 1, column: p.character + 1 })
const range = (r) => ({ start: point(r.start), end: point(r.end) })
const integer = (n) => Number.isSafeInteger(n) && n >= 0
const contains = (root, file) => {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !path.isAbsolute(file)) return false
  const rel = path.relative(root, file)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}
const validPoint = (p) => p && integer(p.line) && integer(p.character)

/** Internal filter only. E3 owns authorization, consumer partitions and stream installation. */
export function createEditorEvents({ host, emit, filter = {}, timers = {}, now = Date.now }) {
  if (!host || typeof host.incarnationOf !== 'function' || typeof emit !== 'function') {
    throw new TypeError('editor-events requires host.incarnationOf and emit')
  }
  const later = timers.setTimeout ?? setTimeout
  const cancel = timers.clearTimeout ?? clearTimeout
  let active = false
  let disposables = []
  let policy
  let cache = new Map(), cacheBytes = 0
  let pendingClose = new Set(), closed = new WeakSet()
  let pending = new Map(), timer = null
  let viewIds = new WeakMap(), nextViewId = 1

  function setPolicy(value) {
    policy = {
      roots: Array.isArray(value.roots) ? value.roots.filter((r) => typeof r === 'string').slice(0, EVENT_QUEUE_MAX_COUNT) : [],
      // ★ T60：白名单在**收进来的那一步**就规范化；之后与 `fileOf()` 的比较是同一形态的精确比较，
      // 白名单里写 `c:/...` 还是 `C:/...` 都能命中（老版本 DSH 侧发的是小写盘符）。
      files: Array.isArray(value.files) ? value.files.filter((r) => typeof r === 'string').map((r) => canonicalPath(r)) : null,
      bodyFiles: Array.isArray(value.bodyFiles) ? value.bodyFiles.filter((r) => typeof r === 'string').map((r) => canonicalPath(r)) : null,
      types: Array.isArray(value.types) ? value.types.filter((t) => EVENT_TYPES.includes(t)) : null,
      textMode: value.textMode === 'delta' ? 'delta' : 'metadata',
    }
  }
  setPolicy(filter)
  // ★ T60：**唯一**的 payload.file 出口。所有事件的 `file` 都从这里来（含 opened/closed 的 files），
  // 因此只要这里规范，事件面就不可能出现第二种写法。
  const fileOf = (doc) => {
    const fsPath = doc?.uri?.fsPath
    return typeof fsPath === 'string' ? canonicalPath(fsPath) : (fsPath ?? null)
  }
  function bodyAllowed(doc) {
    const file = fileOf(doc)
    return host.isTrusted() === true && doc?.uri?.scheme === 'file'
      && typeof file === 'string' && policy.roots.some((root) => contains(root, file))
      && (!policy.files || policy.files.includes(file))
      && (!policy.bodyFiles || policy.bodyFiles.includes(file))
  }
  function selected(type, payload) {
    return (!policy.types || policy.types.includes(type))
      && (!policy.files || !payload.file || policy.files.includes(payload.file))
  }
  function metadata(doc) {
    return { file: fileOf(doc), scheme: doc.uri.scheme, incarnation: host.incarnationOf(doc),
      version: doc.version, isDirty: doc.isDirty === true, textLength: host.textLength(doc) }
  }
  function forget(doc) {
    const old = cache.get(doc)
    if (old) cacheBytes -= old.bytes
    cache.delete(doc)
  }
  function remember(doc) {
    forget(doc)
    if (policy.textMode !== 'delta' || !bodyAllowed(doc)
        || host.textLength(doc) > EVENT_QUEUE_MAX_BYTES / 2) return
    const text = doc.getText(), bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > EVENT_QUEUE_MAX_BYTES) return
    while (cache.size && (cache.size >= EVENT_QUEUE_MAX_COUNT || cacheBytes + bytes > EVENT_QUEUE_MAX_BYTES)) {
      forget(cache.keys().next().value)
    }
    cache.set(doc, { text, bytes, version: doc.version })
    cacheBytes += bytes
  }
  function send(type, payload, doc) {
    if (!active || !selected(type, payload)) return
    // Live trust/path gate AGAIN at flush: queued selection metadata never contains text.
    if (doc && !bodyAllowed(doc)) {
      payload = { ...payload, textOmitted: true }
      delete payload.text
      delete payload.changes
      // Do not retain content after losing trust, even when no revocation API exists.
      forget(doc)
    }
    // Reserve worst-case 128-byte E1 identifiers + framing. E1 measures the final
    // token/envelope too; it remains the authoritative exact EVENT_MAX_BYTES gate.
    if (Buffer.byteLength(JSON.stringify({ type, payload }), 'utf8') + 1024 > EVENT_MAX_BYTES) {
      payload = doc ? { ...metadata(doc), stale: true, reason: 'event-too-large' }
        : { stale: true, reason: 'event-too-large' }
    }
    emit(type, payload, now())
  }
  function viewId(editor) {
    if (!viewIds.has(editor)) viewIds.set(editor, `view-${nextViewId++}`)
    return viewIds.get(editor)
  }
  function coalesce(type, payload, doc, editor) {
    const key = `${type}:${viewId(editor)}`
    if (!pending.has(key) && pending.size >= EVENT_QUEUE_MAX_COUNT) {
      send(type, { ...metadata(doc), stale: true, reason: 'queue-overflow' }, doc)
      return
    }
    pending.set(key, { type, payload, doc })
    if (timer === null) {
      timer = later(() => {
        timer = null
        const batch = pending; pending = new Map()
        for (const item of batch.values()) send(item.type, item.payload, item.doc)
      }, SELECTION_COALESCE_MS)
      timer.unref?.()
    }
  }
  function snapshot(doc, { includeText = false } = {}) {
    const result = metadata(doc)
    if (includeText && bodyAllowed(doc)) {
      if (result.textLength * 2 > EVENT_QUEUE_MAX_BYTES) return { ...result, stale: true, reason: 'snapshot-too-large' }
      const text = doc.getText()
      if (Buffer.byteLength(JSON.stringify(text), 'utf8') + 1024 > EVENT_MAX_BYTES) {
        return { ...result, stale: true, reason: 'snapshot-too-large' }
      }
      result.text = text
    } else if (includeText) result.textOmitted = true
    return result
  }
  function onChange(event) {
    const doc = event.document, before = cache.get(doc)
    const payload = { ...metadata(doc), beforeVersion: before?.version ?? null,
      afterVersion: doc.version, changeKind: event.contentChanges.length ? 'content' : 'dirty',
      changeCount: event.contentChanges.length,
      ...(event.reason === undefined ? {} : { changeReason: event.reason }) }
    if (event.contentChanges.length && policy.textMode === 'delta' && bodyAllowed(doc)) {
      const changes = event.contentChanges
      // Bound work BEFORE cloning/serializing a potentially huge insertion.
      let size = 0
      for (const c of changes) {
        size += typeof c.text === 'string' ? Buffer.byteLength(c.text, 'utf8') + 160 : EVENT_MAX_BYTES
        if (size > EVENT_MAX_BYTES) break
      }
      let reason = size + 1024 > EVENT_MAX_BYTES ? 'event-too-large' : null
      if (!reason && (!before || doc.version <= before.version)) reason = 'missing-baseline'
      let normalized
      if (!reason) {
        normalized = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
        let upper = before.text.length, replay = before.text
        for (const c of normalized) {
          if (!integer(c.rangeOffset) || !integer(c.rangeLength) || typeof c.text !== 'string'
              || !validPoint(c.range?.start) || !validPoint(c.range?.end)
              || c.rangeOffset + c.rangeLength > upper) { reason = 'unsupported-change-basis'; break }
          // Verify range against OLD text (including CRLF), not updated document.
          const at = (offset) => {
            const prefix = before.text.slice(0, offset), lines = prefix.split(/\r\n|\r|\n/)
            return { line: lines.length - 1, character: lines.at(-1).length }
          }
          const start = at(c.rangeOffset), end = at(c.rangeOffset + c.rangeLength)
          if (start.line !== c.range.start.line || start.character !== c.range.start.character
              || end.line !== c.range.end.line || end.character !== c.range.end.character) {
            reason = 'unsupported-change-basis'; break
          }
          upper = c.rangeOffset
          replay = replay.slice(0, c.rangeOffset) + c.text + replay.slice(c.rangeOffset + c.rangeLength)
        }
        if (!reason && (host.textLength(doc) > EVENT_QUEUE_MAX_BYTES / 2 || replay !== doc.getText())) {
          reason = 'unsupported-change-basis'
        }
      }
      if (reason) Object.assign(payload, { stale: true, reason })
      else payload.changes = normalized.map((c) => ({ range: range(c.range),
        rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text, textLength: c.text.length }))
    } else if (event.contentChanges.length) payload.textOmitted = true
    remember(doc)
    send('documentChanged', payload, doc)
  }
  function hasView(doc) {
    const uri = doc.uri.toString()
    return host.visibleTextEditors().some((e) => e.document.uri.toString() === uri)
      || host.tabs().some((tab) => host.tabUris(tab).some((u) => u.toString() === uri))
  }
  function flushClosed() {
    for (const doc of pendingClose) {
      if (hasView(doc)) continue
      pendingClose.delete(doc)
      if (!closed.has(doc)) {
        closed.add(doc)
        forget(doc)
        send('documentClosed', metadata(doc), doc)
      }
    }
  }
  function tabMetadata(tab) {
    // No label, tooltip or unknown input object: those may contain arbitrary text.
    // ★ T60：`files` 同样是**对外可见路径**，与 `payload.file` 用同一个形态出口。
    return { files: host.tabUris(tab).map((u) => canonicalPath(u.fsPath)),
      viewColumn: tab.group?.viewColumn ?? null,
      isPreview: tab.isPreview === true }
  }
  function onTabs(event) {
    send('tabsChanged', { opened: event.opened.map(tabMetadata), closed: event.closed.map(tabMetadata) })
    // A tab-close alone NEVER enqueues a document-close. Only a real workspace
    // onDidCloseTextDocument can do that; hidden tabs count as remaining views.
    flushClosed()
  }
  function activate() {
    if (active) return
    active = true
    const listen = (name, handler) => {
      const source = host[name]
      if (typeof source !== 'function') throw new TypeError(`editor-events host missing ${name}`)
      disposables.push(source(handler))
    }
    try {
      listen('onDidOpenTextDocument', (doc) => { remember(doc); send('documentOpened', metadata(doc), doc) })
      listen('onDidCloseTextDocument', (doc) => {
        forget(doc)
        if (pendingClose.size >= EVENT_QUEUE_MAX_COUNT) {
          send('documentChanged', { ...metadata(doc), stale: true, reason: 'queue-overflow' }, doc)
          return
        }
        pendingClose.add(doc); flushClosed()
      })
      listen('onDidSaveTextDocument', (doc) => send('documentSaved', metadata(doc), doc))
      listen('onDidChangeTextDocument', onChange)
      listen('onDidChangeTextEditorSelection', (e) => coalesce('selectionChanged', {
        ...metadata(e.textEditor.document), viewId: viewId(e.textEditor),
        selections: e.selections.map((s) => ({ ...range(s), anchor: point(s.anchor), active: point(s.active) })),
        ...(e.kind === undefined ? {} : { kind: e.kind }),
      }, e.textEditor.document, e.textEditor))
      listen('onDidChangeTextEditorVisibleRanges', (e) => coalesce('visibleRangesChanged', {
        ...metadata(e.textEditor.document), viewId: viewId(e.textEditor), ranges: e.visibleRanges.map(range),
      }, e.textEditor.document, e.textEditor))
      listen('onDidChangeVisibleTextEditors', flushClosed)
      listen('onDidChangeTabs', onTabs)
      listen('onDidChangeActiveTextEditor', (e) => send('activeEditorChanged', e
        ? { ...metadata(e.document), viewId: viewId(e) } : { file: null }, e?.document))
      listen('onDidChangeWindowState', (e) => send('windowFocusChanged', { focused: e.focused === true }))
      for (const doc of host.textDocuments()) remember(doc)
    } catch (err) { dispose(); throw err }
  }
  function dispose() {
    active = false
    for (const d of disposables.splice(0)) d.dispose()
    if (timer !== null) { cancel(timer); timer = null }
    pending.clear(); pendingClose.clear(); cache.clear(); cacheBytes = 0
    closed = new WeakSet(); viewIds = new WeakMap(); nextViewId = 1
  }
  return { activate, dispose, snapshot,
    configure(value = {}) {
      if (timer !== null) { cancel(timer); timer = null }
      pending.clear(); cache.clear(); cacheBytes = 0
      setPolicy(value)
      if (active) for (const doc of host.textDocuments()) remember(doc)
    },
    get stats() { return { active, listeners: disposables.length, timers: timer === null ? 0 : 1,
      pending: pending.size, cachedDocuments: cache.size, cachedBytes: cacheBytes } },
  }
}
