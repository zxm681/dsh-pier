/**
 * `vscode.deleteFile` 的 DSH 侧守门测试（T40 / 契约 §6.2.1 Tier 4、§6.2.5、§6.2.7）。
 *
 * 能力层（确认框、快照、`workspace.fs.delete` 前后怎么判）在
 * `dsh-kit-bridge/test/t40-delete.test.js`；这里守的是**发送前与出口**：
 *
 *  ★① 缺磁盘锚点 → `-32602 stage:'local'`，对端**零业务帧**（一个字节都不许出门）。
 *  ★② 白名单档位：`vscode.deleteFile` 是 `delete` 档 —— 配置只给 `disk-write` 的消费者
 *     删不了（`declared-above-allowed`），零帧。让"删除比保存更容易授权"这件事不可能发生。
 *  ★③ 继承双锚点：`expectedIncarnation` 缺了也拒（进了 `WRITE_METHODS` 就必须带）。
 *  ★④ 未授权（没 grant）→ `-32010`，零帧：确认框都没机会弹。
 *  ★⑤ 出口合同：对端回 `trashed:true` → `-32009`（"乐观的不可逆声明"是畸形响应）。
 *  ★⑥ 请求级超时：删除走**独立长超时**（`DELETE_REQUEST_TIMEOUT_MS`），且必须比执行端
 *     的确认超时（120s）**宽** —— 否则人还在看确认框，请求就先被我们掐了，
 *     `-32004 reason:'confirm-timeout'` 永远到不了调用方手里。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DELETE_REQUEST_TIMEOUT_MS, apply } from '../src/index.js'
import { ERR, ERR_NAME, connect, createLineSplitter } from '../src/protocol.js'
import { validateResponse } from '../src/response-contract.js'
import { METHOD_TIERS, judgeCall, tierOf } from '../src/whitelist.js'

const FILE = '/ws/a.txt'
const VERSION = 3
const INC = 'inc-kit-delete'
const DISK = { mtime: 1_700_000_100_000, size: 18 }
const SESSION = 'sess-delete'
const SHA = 'c'.repeat(64)

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-delete-'))
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
 * 假编辑器。`deleteResult` 决定它回什么；`silent` 里的方法**永不回话**
 * （用来验请求级超时——超时必须是我们自己数出来的，不是对端告诉我们的）。
 */
async function fakeEditor(server, { deleteResult, silent = [] } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const grants = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (silent.includes(method)) return new Promise(() => {})
      if (method === 'bridge.grant') {
        grants.push(params?.grant)
        return { ok: true, id: params?.grant?.id }
      }
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'vscode.deleteFile') {
        return deleteResult ?? {
          deleted: true,
          file: FILE,
          trashed: 'unknown',
          snapshot: { sha256: SHA, byteLength: 18, encoding: 'utf8', textLength: 18, text: 'line one\nline two\n' },
        }
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
    grants,
    business() { return seen.filter((m) => typeof m.method === 'string' && m.method.startsWith('vscode.')).length },
    count(method) { return seen.filter((m) => m.method === method).length },
    close() { return new Promise((r) => { socket.once('close', r); socket.end() }) },
  }
}

const DELETE_CAPS = [
  'vscode.openFile', 'vscode.getSelection', 'vscode.getDiagnostics', 'vscode.listOpenEditors',
  'vscode.applyEdit', 'vscode.getDocumentState', 'vscode.save', 'vscode.deleteFile',
]

async function withKit({ consumers, deleteResult, silent } = {}) {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const shared = ctx.provided.get('dshVscodeKit').v
  const editor = await fakeEditor(handle.kit.server, { deleteResult, silent })
  await editor.link.request('bridge.hello', {
    client: 'fake-editor', extensionVersion: '0.1.0', protocolVersion: 1, capabilities: DELETE_CAPS,
  })
  const cleanup = async () => {
    if (!editor.socket.destroyed) await editor.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { shared, handle, editor, cleanup }
}

const deleteParams = (extra = {}) => ({
  file: FILE,
  expectedVersion: VERSION,
  expectedIncarnation: INC,
  expectedDisk: DISK,
  ...extra,
})

// ─────────────────────────────────────────────────────────────────────────────
// 码表 / 档位表
// ─────────────────────────────────────────────────────────────────────────────

test('T40 码表：-32002 declined 有名字（不是空号），且不新增任何码', () => {
  assert.equal(ERR.DECLINED, -32002)
  // T40 是 `-32002` 在**本仓第一次真正被抛出**：先确认它在名字表里有个像样的名字，
  // 否则日志/指标里会是一条 "code -32002" 的无名词条。
  assert.equal(ERR_NAME[ERR.DECLINED], 'declined')
  assert.equal(ERR_NAME[-32011], undefined, '-32011 仍然保持空号（不许往这里塞确认超时）')
  assert.equal(ERR.TIMEOUT, -32004, '确认超时复用 -32004，靠 reason 区分')
  assert.equal(ERR.DISK_STATE_CONFLICT, -32013, '磁盘锚点复用 T39 的 -32013')
})

test('T40 档位表：vscode.deleteFile 是最高档 delete，且"删除比保存更容易授权"被判定挡住', () => {
  assert.equal(METHOD_TIERS['vscode.deleteFile'], 'delete')
  assert.equal(tierOf('vscode.deleteFile'), 'delete')
  // 配置只给到 disk-write（保存档）的消费者，删不了 —— 同为"写"但爆炸半径不同。
  const verdict = judgeCall({
    policy: { consumers: new Map([['p', 'disk-write']]) },
    consumer: { name: 'p', source: 'plugin', declared: 'delete' },
    method: 'vscode.deleteFile',
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'declared-above-allowed')
  assert.equal(verdict.tier, 'delete')
  assert.equal(verdict.allowed, 'disk-write')
  // 反过来：自己声明 disk-write 而配置给 delete → 天花板按自己声明算，仍然拒。
  const low = judgeCall({
    policy: { consumers: new Map([['p', 'delete']]) },
    consumer: { name: 'p', source: 'plugin', declared: 'disk-write' },
    method: 'vscode.deleteFile',
  })
  assert.equal(low.ok, false)
  assert.equal(low.reason, 'declared-below-required')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 发送前的本地门
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ① 缺 expectedDisk → -32602 stage:local，对端零业务帧', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'delete' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams({ expectedDisk: undefined }), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.stage, 'local')
        assert.equal(err.data?.reason, 'expected-disk-missing')
        assert.equal(err.data?.method, 'vscode.deleteFile')
        return true
      },
    )
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams({ expectedDisk: { mtime: DISK.mtime } }), { sessionId: SESSION }),
      (err) => err.data?.reason === 'expected-disk-size-not-a-number',
    )
    assert.equal(editor.business(), 0, '本地门拒绝时一个业务字节都不许出门')
  } finally {
    await cleanup()
  }
})

test('★ T40 ② 白名单档位不足（配置 disk-write）→ declared-above-allowed，零帧', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.stage, 'local')
        assert.equal(err.data?.reason, 'declared-above-allowed')
        assert.equal(err.data?.tier, 'delete')
        assert.equal(err.data?.allowed, 'disk-write')
        return true
      },
    )
    assert.equal(editor.business(), 0, '档位不足时不许发帧')
  } finally {
    await cleanup()
  }
})

test('★ T40 ③ 进了 WRITE_METHODS 就继承双锚点：缺 expectedIncarnation 也被本地拒', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'delete' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams({ expectedIncarnation: undefined }), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.reason, 'expected-incarnation-missing')
        return true
      },
    )
    assert.equal(editor.business(), 0)
  } finally {
    await cleanup()
  }
})

test('★ T40 ④ 没 grant → -32010，零帧（确认框都没机会弹）', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'delete' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    // 没走 editing.grant：写目标无法确定，绑定门必须先拒。
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.EDIT_NOT_BOUND)
        assert.equal(err.data?.method, 'vscode.deleteFile')
        return true
      },
    )
    assert.equal(editor.business(), 0, '绑定门在发送前判，一个业务帧都不许发')
  } finally {
    await cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 出口合同
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ⑤ 对端回旧合同的 deleted:true（没有 quarantined）→ -32009', async () => {
  const { shared, editor, cleanup } = await withKit({
    consumers: { p: 'delete' },
    deleteResult: {
      // 旧形状：声称"删了"。T44 之后这条能力只归档，语汇里没有 `deleted` ——
      // 对端还在说"删了"，人就不知道该去隔离区哪儿找东西，所以这是畸形响应。
      deleted: true,
      file: FILE,
      trashed: 'unknown',
      snapshot: { sha256: SHA, byteLength: 18, encoding: 'utf8', textLength: 18 },
    },
  })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    await svc.editing.grant({ sessionId: SESSION })
    await assert.rejects(
      svc.vscode.deleteFile(deleteParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_RESPONSE)
        assert.equal(err.data?.method, 'vscode.deleteFile')
        assert.equal(err.data?.got?.at, 'quarantined')
        return true
      },
    )
    assert.equal(editor.count('vscode.deleteFile'), 1)
  } finally {
    await cleanup()
  }
})

test('T40 合同自测：合法归档返回原样放行，且不改写任何字段', () => {
  const good = {
    quarantined: true,
    file: FILE,
    from: FILE,
    to: '/ws/.dsh-quarantine/20261023-101010-a.txt',
    confirmedSha256: SHA,
    confirmedByteLength: 18,
    quarantinedSha256: SHA,
    quarantinedByteLength: 18,
    bytesChanged: false,
    backup: { delivered: true, form: 'utf8-text', byteLength: 18, sha256: SHA },
    snapshot: { sha256: SHA, byteLength: 18, encoding: 'utf8', textLength: 18, text: 'line one\nline two\n' },
  }
  assert.equal(validateResponse('vscode.deleteFile', good), good, '原样放行（流水线友好）')
  assert.throws(
    () => validateResponse('vscode.deleteFile', {
      ...good, snapshot: { sha256: 'too-short', byteLength: 18, encoding: 'utf8' },
    }),
    (err) => err.code === ERR.INVALID_RESPONSE && err.data?.got?.at === 'snapshot.sha256',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ T42 / 评审 I1：没有交付完整备份 = 畸形返回（不是"删了但没材料"的成功）
// ─────────────────────────────────────────────────────────────────────────────

test('T42 ★ I1：删除返回必须带整份可恢复字节；delivered:false / 只给 hash 都判 -32009', () => {
  const base = {
    quarantined: true,
    file: FILE,
    from: FILE,
    to: '/ws/.dsh-quarantine/20261023-101010-a.txt',
    confirmedSha256: SHA,
    confirmedByteLength: 18,
    quarantinedSha256: SHA,
    quarantinedByteLength: 18,
    bytesChanged: false,
    backup: { delivered: true, form: 'utf8-text', byteLength: 18, sha256: SHA },
    snapshot: { sha256: SHA, byteLength: 18, encoding: 'utf8', textLength: 18, text: 'line one\nline two\n' },
  }
  // 整份字节在 → 放行（对照组）。
  assert.equal(validateResponse('vscode.deleteFile', base), base)

  // ① 对端自己承认"没交出去"：直接拒在最前面的声明上。
  assert.throws(
    () => validateResponse('vscode.deleteFile', {
      ...base, backup: { ...base.backup, delivered: false },
    }),
    (err) => err.code === ERR.INVALID_RESPONSE && err.data?.got?.at === 'backup.delivered',
    'backup.delivered===false 必须判畸形 —— 那正是"删了但没恢复材料"的形态',
  )

  // ② 旧口径的 `textOmitted` 形态（只给 sha256 冒充材料）现在整体不合法：
  //    encoding 仍说 utf8，却拿不出 bytes → 违反"整份字节必须在响应里"。
  assert.throws(
    () => validateResponse('vscode.deleteFile', {
      ...base,
      snapshot: { sha256: SHA, byteLength: 18, encoding: 'utf8', textLength: 18, textOmitted: 'too-large' },
    }),
    (err) => err.code === ERR.INVALID_RESPONSE
      && /snapshot\.text|完整备份|textLength/.test(String(err.data?.expected ?? err.message)),
    '只给 hash/长度的快照不再是合法恢复材料',
  )

  // ③ 声明了 base64 而载荷是半截（解码长度 ≠ byteLength）也要拒。
  assert.throws(
    () => validateResponse('vscode.deleteFile', {
      ...base,
      backup: { delivered: true, form: 'base64', byteLength: 18, sha256: SHA },
      snapshot: { sha256: SHA, byteLength: 18, encoding: 'binary', base64: 'AAAA' },
    }),
    (err) => err.code === ERR.INVALID_RESPONSE,
    'base64 解码长度与 byteLength 不符 = 半截备份',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 超时口径
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ⑥ 请求级超时必须比执行端确认超时宽（180s > 120s），且可被逐次覆盖', async () => {
  assert.equal(DELETE_REQUEST_TIMEOUT_MS, 180_000)
  // 执行端确认超时的出厂值就是 120s。请求级必须**更宽**：反了的话人还在看确认框，
  // 请求先被掐，`-32004 reason:'confirm-timeout'` 永远送不到调用方。
  assert.ok(DELETE_REQUEST_TIMEOUT_MS > 120_000, '请求级超时不得窄于执行端确认超时')
  assert.ok(DELETE_REQUEST_TIMEOUT_MS >= 120_000 + 30_000, '至少留 30s 余量')

  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'delete' }, silent: ['vscode.deleteFile'] })
  try {
    const svc = shared.forPlugin('p', { declared: 'delete' })
    await svc.editing.grant({ sessionId: SESSION })
    const started = Date.now()
    await assert.rejects(
      // 逐次覆盖到 80ms：证明删除请求走的是**可覆盖的 per-request 超时**，
      // 不是那条 30s 的默认连接级超时。
      svc.vscode.deleteFile(deleteParams(), { sessionId: SESSION, timeoutMs: 80 }),
      (err) => {
        assert.equal(err.code, ERR.TIMEOUT)
        assert.equal(err.data?.method, 'vscode.deleteFile')
        return true
      },
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 5_000, `必须按覆盖值超时（实测 ${elapsed}ms，默认 30s 早就超了）`)
    assert.equal(editor.count('vscode.deleteFile'), 1, '请求确实发出去了（超时是本地的）')
  } finally {
    await cleanup()
  }
})

test('T40 三个入口都有 deleteFile：共享 facade / forPlugin / kit 根对象', async () => {
  const { shared, handle, cleanup } = await withKit({ consumers: { p: 'delete' } })
  try {
    assert.equal(typeof shared.vscode.deleteFile, 'function')
    assert.equal(typeof shared.forPlugin('p', { declared: 'delete' }).vscode.deleteFile, 'function')
    assert.equal(typeof handle.kit.vscode.deleteFile, 'function')
    assert.equal(typeof handle.kit.deleteFileAs, 'function')
  } finally {
    await cleanup()
  }
})

test('T40 未绑定 facade 删不了：白名单先拒（consumer-unbound），零帧', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'delete' } })
  try {
    await assert.rejects(
      shared.vscode.deleteFile(deleteParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.reason, 'consumer-unbound')
        return true
      },
    )
    assert.equal(editor.business(), 0)
  } finally {
    await cleanup()
  }
})
