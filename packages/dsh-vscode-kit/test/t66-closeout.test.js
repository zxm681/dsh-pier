/**
 * T66 收尾三件（DSH 侧守门）—— 契约 §6.1.1 / §6.2。
 *
 * 这一组要守住三件事，每件都对应一个"改坏了没人发现"的形态：
 *
 *  1. **`-32010` 的 `data.missing`**：缺凭证与缺会话身份原本长一模一样，
 *     调用方只能猜。补的这个字段**只加诊断，不动判序** —— 所以每条用例都同时断言
 *     `reason`（判序的产物）一字未变，`missing` 只是补充。
 *  2. **T64 `grant({windowId})` fail-closed**：`windowId` 与承载连接不一致时必须
 *     **当场拒**（`-32014 target-not-routable`），宿主零调用、零帧。改回旧行为
 *     （把 `windowId` 当纯元数据）就等于让"挑对窗口 ≠ 绑对连接"重新成立。
 *  3. **T65 `rebase` 控制面**：`document-dirty` 唯一的解除通道必须在，且线上四元
 *     （`expectedVersion` / `expectedIncarnation` / `contentHash`）一个不少地送到扩展侧。
 *     判定本身在扩展侧（`test/t66-rebase.test.js`），这里守的是"路铺好了"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { ERR, PROTOCOL_VERSION, connect, createLineSplitter } from '../src/protocol.js'
import {
  BINDING_MISSING, GrantStore, dshWriteGate, documentContentHash, extensionWriteGate,
} from '../src/grant.js'

const TEST_CONSUMER = 'dsh-kit-test'
const TEST_CONSUMERS = { [TEST_CONSUMER]: 'delete' }

const S1 = 'sess-alpha'
const S2 = 'sess-beta'
const FILE = '/ws/a.js'
const VERSION = 7
const INCARNATION = 'inc-t66'
const HASH = documentContentHash('hello world\nsecond line\n')

/** 会答 rebase 的对端能力清单（缺了会被 `_assertCapability` 报 -32005）。 */
const PEER_CAPS = [
  'vscode.applyEdit', 'vscode.getSelection', 'vscode.getDocumentState',
  'vscode.rebaseBaseline',
]

const WIN_A = {
  sessionId: S1, workspace: { name: 'ws-alpha', folders: ['/ws/alpha'] }, uiKind: 1, remoteName: null,
}
const WIN_B = {
  sessionId: S2, workspace: { name: 'ws-beta', folders: ['/ws/beta'] }, uiKind: 1, remoteName: null,
}

const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-kit-t66-'))

function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v, check) { provided.set(n, { v, check }) },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
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

/** 默认的宿主应答：写类回执形状要过 `validateResponse`，rebase 回执回显四元。 */
function defaultOnRequest(method, params) {
  if (method === 'bridge.grant') return { ok: true, id: params?.grant?.id }
  if (method === 'bridge.ping') return { pong: true }
  if (method === 'vscode.applyEdit') {
    return { applied: true, file: FILE, saved: false, textLength: (params?.text ?? '').length }
  }
  if (method === 'vscode.getDocumentState') {
    return {
      file: FILE, version: VERSION, incarnation: INCARNATION,
      isDirty: false, eol: 'lf', lineCount: 3, textLength: 24,
    }
  }
  if (method === 'vscode.getSelection') {
    return { text: 'hi', file: FILE, start: { line: 1, column: 1 }, end: { line: 1, column: 3 }, isEmpty: false }
  }
  if (method === 'vscode.rebaseBaseline') {
    return { ok: true, file: params.file, version: params.expectedVersion, incarnation: params.expectedIncarnation }
  }
  throw new Error(`unexpected method ${method}`)
}

async function fakeEditor(server, { onRequest = defaultOnRequest } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest,
  })
  socket.on('data', createLineSplitter((line) => {
    seen.push(JSON.parse(line))
    link.handleLine(line)
  }))
  socket.on('error', () => {})
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    link,
    socket,
    seen,
    count(method) { return seen.filter((m) => m.method === method).length },
    last(method) { return seen.filter((m) => m.method === method).at(-1) },
    /** 收到过的**业务**帧总数（不含 bridge.* 协商帧）。 */
    businessFrames() { return seen.filter((m) => typeof m.method === 'string' && !m.method.startsWith('bridge.')).length },
    async hello(capabilities = PEER_CAPS, window = undefined) {
      const params = { client: 'fake-editor', extensionVersion: '0.3.3', protocolVersion: PROTOCOL_VERSION, capabilities }
      if (window) params.window = window
      return link.request('bridge.hello', params)
    },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

/** 起 apply + n 个已报身份的假编辑器（window 块由调用方决定给不给）。 */
async function withKit(n = 1, { windows = [] } = {}) {
  const home = tmpHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers: TEST_CONSUMERS, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v.forPlugin(TEST_CONSUMER, { declared: 'delete' })
  const editors = []
  for (let i = 0; i < n; i++) {
    const editor = await fakeEditor(handle.kit.server)
    await editor.hello(PEER_CAPS, windows[i])
    editors.push(editor)
  }
  const cleanup = async () => {
    for (const e of editors) if (!e.socket.destroyed) await e.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, handle, editors, cleanup }
}

function writeParams(extra = {}) {
  return {
    file: FILE,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } },
    text: 'hello',
    expectedVersion: VERSION,
    expectedIncarnation: INCARNATION,
    ...extra,
  }
}

function rebaseConfirmation(extra = {}) {
  return { file: FILE, version: VERSION, incarnation: INCARNATION, contentHash: HASH, ...extra }
}

async function capture(promise) {
  let caught = null
  try { await promise } catch (err) { caught = err }
  assert.ok(caught, 'expected the call to be rejected')
  return caught
}

function captureSync(fn) {
  let caught = null
  try { fn() } catch (err) { caught = err }
  assert.ok(caught, 'expected the call to throw')
  return caught
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) `-32010` 的 `data.missing`：三种取值各一条，且 `reason` 一字未变
// ─────────────────────────────────────────────────────────────────────────────

test('★ T66-1 missing：缺 grant（有会话身份）→ 行 1 no-grant + missing:grant', () => {
  const store = new GrantStore()
  const link = { name: 'link-a' }
  const gate = dshWriteGate(store)

  const err = captureSync(() => gate('vscode.applyEdit', {}, link, { sessionId: S1 }))
  assert.equal(err.code, ERR.EDIT_NOT_BOUND)
  assert.equal(err.data.reason, 'no-grant', 'reason 是判序的产物，必须一字未变')
  assert.equal(err.data.row, 1, '一行都没过：先到先报')
  assert.equal(err.data.missing, BINDING_MISSING.GRANT)
  assert.equal(err.data.missing, 'grant', '线上字面值就是 grant')
})

test('★ T66-1 missing：凭证在但缺会话身份 → 行 8 grant-mismatch + missing:session', () => {
  const store = new GrantStore()
  const link = { name: 'link-a' }
  const record = store.issue({ link, sessionId: S1, windowId: 'tmp-1' })
  const gate = dshWriteGate(store)

  const err = captureSync(() => gate('vscode.applyEdit', { grant: { id: record.id, epoch: record.epoch } }, link, {}))
  assert.equal(err.code, ERR.EDIT_NOT_BOUND)
  assert.equal(err.data.reason, 'grant-mismatch', 'reason 不变：会话判还是那一行')
  assert.equal(err.data.row, 8)
  assert.equal(err.data.missing, BINDING_MISSING.SESSION)
  assert.equal(err.data.missing, 'session')
})

test('★ T66-1 missing：两样都没有 → 仍是行 1（先到先报），missing:both', () => {
  const store = new GrantStore()
  const link = { name: 'link-a' }
  const gate = dshWriteGate(store)

  const err = captureSync(() => gate('vscode.applyEdit', {}, link, {}))
  assert.equal(err.code, ERR.EDIT_NOT_BOUND)
  assert.equal(err.data.reason, 'no-grant', '★ 判序不许改：缺两样也必须先报行 1')
  assert.equal(err.data.row, 1)
  assert.equal(err.data.missing, BINDING_MISSING.BOTH)
  assert.equal(err.data.missing, 'both')
})

test('★ T66-1 missing：扩展侧只可能报 grant（它没有会话事实源）', () => {
  const store = new GrantStore()
  const link = { name: 'link-a' }
  const gate = extensionWriteGate(store, { isTrusted: () => true })

  const err = captureSync(() => gate('vscode.save', {}, { link }))
  assert.equal(err.data.reason, 'no-grant')
  assert.equal(err.data.missing, 'grant', '扩展侧不许凭空造一个 session')
})

test('★ T66-1 missing：真机上带出来 —— applyEdit 缺凭证时 data.missing=grant 且宿主零帧', async () => {
  const { svc, editors, cleanup } = await withKit(1)
  const [editor] = editors
  try {
    const err = await capture(svc.vscode.applyEdit(writeParams(), { sessionId: S1 }))
    assert.equal(err.code, ERR.EDIT_NOT_BOUND)
    assert.equal(err.data.reason, 'no-grant')
    assert.equal(err.data.missing, 'grant')
    assert.equal(editor.count('vscode.applyEdit'), 0, '门在发线路之前')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 2) T64：windowId 与承载连接不一致 → 当场拒，宿主零调用、零帧
// ─────────────────────────────────────────────────────────────────────────────

test('★ T64 grant({windowId})：挑错窗口 → -32014 target-not-routable，两条连接零业务帧', async () => {
  const { svc, handle, editors, cleanup } = await withKit(2, { windows: [WIN_A, WIN_B] })
  const [A, B] = editors
  try {
    const rows = svc.vscode.windows.list()
    assert.equal(rows.length, 2, '两个窗口都要被看见')
    const [idA, idB] = [rows[0].windowId, rows[1].windowId]
    assert.notEqual(idA, idB, '两个窗口必须是两个号（不然这条用例测不到任何东西）')
    assert.equal(rows[1].active, true, '承载连接 = connSeq 最大的那条（口径是"连接先后"，不是"最后准入"）')

    // 承载连接是 B（后连的），调用方却挑了 A 的号 —— 旧实现会把 grant 绑到 B 还回 ok，
    // 于是"以为绑了 A、实际写向 B"，直到 stateFor 报 outside-workspace 才暴露。
    const before = [A.businessFrames(), B.businessFrames()]
    const err = await capture(svc.editing.grant({ sessionId: S1, windowId: idA }))
    assert.equal(err.code, ERR.WINDOW_TARGET_FAILED, `期望 -32014，实际 ${err.code}（${err.message}）`)
    assert.equal(err.data.reason, 'target-not-routable')
    assert.equal(err.data.granted, false, '拒就要拒得干净：不许说 granted')
    assert.equal(err.data.boundWindow, idB, 'data 要写清"我这条连接是谁"')
    assert.equal(err.data.targetWindow, idA, '以及"你挑的是谁"')

    assert.equal(A.count('bridge.grant'), 0, '★ 不许落到挑中的那个窗口头上')
    assert.equal(B.count('bridge.grant'), 0, '宿主的承载连接也不许收到帧（零调用）')
    assert.deepEqual([A.businessFrames(), B.businessFrames()], before, '业务帧增量为 0')
    assert.equal(handle.kit.grants.size, 0, '被拒的发放不许在授权表里留半条记录')

    // 正向对照：挑**对**的窗口（承载连接自己）照常放行，否则这道门就成了一刀切。
    const ok = await svc.editing.grant({ sessionId: S1, windowId: idB })
    assert.equal(ok.delivered, true)
    assert.equal(ok.windowId, idB)
    assert.equal(B.count('bridge.grant'), 1, '对的窗口收到 1 帧 grant')
    assert.equal(A.count('bridge.grant'), 0, '另一个窗口始终零帧')
  } finally {
    await cleanup()
  }
})

test('★ T64 grant({windowId})：号解析不到（窗口已关/从没有过）也拒，不回退活跃连接', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    const err = await capture(svc.editing.grant({ sessionId: S1, windowId: 'win-99' }))
    assert.equal(err.code, ERR.WINDOW_TARGET_FAILED)
    assert.equal(err.data.reason, 'target-not-routable')
    assert.equal(A.count('bridge.grant'), 0, '解析不到就不许"反正只有一条连接"地改投')
  } finally {
    await cleanup()
  }
})

test('★ T64 grant({windowId})：不给 windowId 时行为照旧（绑活跃连接）', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    const grant = await svc.editing.grant({ sessionId: S1 })
    assert.equal(grant.delivered, true)
    assert.equal(grant.windowId, svc.vscode.windows.list()[0].windowId, '发放记录里的号来自承载连接')
    assert.equal(A.count('bridge.grant'), 1)
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3) T65：rebase 控制面（路铺好了没有）
// ─────────────────────────────────────────────────────────────────────────────

test('★ T65 rebase：四元原样上线路，且一个写帧都不发（它不写盘）', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    await svc.editing.grant({ sessionId: S1 })
    const result = await svc.editing.rebase(S1, rebaseConfirmation())
    assert.deepEqual(result, { ok: true, file: FILE, version: VERSION, incarnation: INCARNATION })

    const frame = A.last('vscode.rebaseBaseline')
    assert.ok(frame, 'rebase 必须真的发出去一帧（不是本地假装成功）')
    assert.equal(frame.params.file, FILE)
    assert.equal(frame.params.expectedVersion, VERSION, 'version 走线上锚点字段名')
    assert.equal(frame.params.expectedIncarnation, INCARNATION, 'incarnation 走线上锚点字段名')
    assert.equal(frame.params.contentHash, HASH, 'contentHash 必须原样到达扩展侧')
    assert.ok(frame.params.grant?.id, '绑 grant：它和写同门')

    assert.equal(A.count('vscode.applyEdit'), 0, 'rebase 不写盘：不许借道 applyEdit')
    assert.equal(A.count('vscode.save'), 0, 'rebase 不写盘：不许借道 save')
  } finally {
    await cleanup()
  }
})

test('★ T65 rebase：本地四元形状门（零发送）', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    await svc.editing.grant({ sessionId: S1 })
    const cases = [
      [{ ...rebaseConfirmation(), file: '' }, 'file-required'],
      [{ ...rebaseConfirmation(), version: 1.5 }, 'version-required'],
      [{ ...rebaseConfirmation(), incarnation: '' }, 'incarnation-required'],
      [{ ...rebaseConfirmation(), contentHash: 'not-a-hash' }, 'content-hash-required'],
    ]
    for (const [confirmation, reason] of cases) {
      const err = await capture(svc.editing.rebase(S1, confirmation))
      assert.equal(err.code, ERR.INVALID_PARAMS, `${reason}: 期望 -32602`)
      assert.equal(err.data.reason, reason)
      assert.equal(err.data.stage, 'local', `${reason}: 必须本地拒`)
    }
    assert.equal(A.count('vscode.rebaseBaseline'), 0, '形状不合格就一个字节都不发')
  } finally {
    await cleanup()
  }
})

test('★ T65 rebase：别的会话的 grant → -32010，且零帧', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    const grant = await svc.editing.grant({ sessionId: S1 })
    const before = A.count('vscode.rebaseBaseline')

    // S2 拿着 S1 的凭证来调（借用 = 越权）。
    const err = await capture(svc.editing.rebase(S2, rebaseConfirmation({ grant })))
    assert.equal(err.code, ERR.EDIT_NOT_BOUND, `期望 -32010，实际 ${err.code}（${err.message}）`)
    assert.equal(err.data.reason, 'grant-mismatch', '凭证有效但会话不匹配 = 行 8')
    assert.equal(A.count('vscode.rebaseBaseline'), before, '越权的 rebase 一个字节都不许发')
  } finally {
    await cleanup()
  }
})

test('★ T65 rebase：撤销后的旧 grant → -32010（grant-revoked），且零帧', async () => {
  const { svc, editors, cleanup } = await withKit(1, { windows: [WIN_A] })
  const [A] = editors
  try {
    const stale = await svc.editing.grant({ sessionId: S1 })
    await svc.editing.revoke(S1)
    const fresh = await svc.editing.grant({ sessionId: S1 })
    assert.notEqual(stale.id, fresh.id)

    const before = A.count('vscode.rebaseBaseline')
    const err = await capture(svc.editing.rebase(S1, rebaseConfirmation({ grant: stale })))
    assert.equal(err.code, ERR.EDIT_NOT_BOUND)
    assert.equal(err.data.reason, 'grant-revoked')
    assert.equal(err.data.missing, undefined,
      '撤销的凭证名正言顺地带着 grant，不该被标成 missing')
    assert.equal(A.count('vscode.rebaseBaseline'), before, '旧凭证不许重启基线')
  } finally {
    await cleanup()
  }
})
