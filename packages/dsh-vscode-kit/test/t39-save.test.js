/**
 * `vscode.save` 的 DSH 侧守门测试（T39 / 契约 §6.2.1 Tier 3、§6.2.2、§6.2.7）。
 *
 * 能力层（落盘前后怎么判）在 `dsh-kit-bridge/test/t39-save.test.js`；这里守的是**发送前**：
 *
 *  ★① 缺磁盘锚点 → `-32602 stage:'local'`，且对端**零业务帧**（一个字节都不许出门）。
 *  ★② 白名单档位不足 → 走 T38 的 `-32602 reason:'declared-below-required'`，
 *     同样零帧 —— 证明 `vscode.save` 真的被登记成 `disk-write` 档，不是白捡的。
 *  ★③ `grant({allowDirtySave:true})` 时位落在 **grant 载荷**上、调用成功；
 *     `params.allowDirtySave` 则**不会**变成授权（这条直接对应 §6.2.2 的结论）。
 *  ★④ 对端回 `saved:false` → `-32009`（成功外形的错误结果，§5.1）。
 *
 * 反向由铁律 9 的变异测试证明：变异跑在能力层那条 `assertDiskMatches` 上，
 * ★① 的本地门不受影响 —— 文件里另有各自的手段（见交付说明的变异证据）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { ERR, ERR_NAME, PROTOCOL_VERSION, connect, createLineSplitter } from '../src/protocol.js'
import { validateResponse } from '../src/response-contract.js'
import { METHOD_TIERS, tierOf } from '../src/whitelist.js'

const FILE = '/ws/a.js'
const VERSION = 7
const INC = 'inc-kit-save'
const DISK = { mtime: 1_700_000_000_000, size: 24 }
const SESSION = 'sess-save'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-save-'))
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

/** 假编辑器：记录每一条收到的帧，回一个形状合法的保存结果。 */
async function fakeEditor(server, { saveResult } = {}) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const seen = []
  const grants = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method, params) => {
      if (method === 'bridge.grant') {
        grants.push(params?.grant)
        return { ok: true, id: params?.grant?.id }
      }
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'vscode.save') {
        return saveResult ?? {
          saved: true, file: FILE, disk: { mtime: DISK.mtime + 1, size: DISK.size + 1 }, dirtyBefore: true,
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

const SAVE_CAPS = [
  'vscode.openFile', 'vscode.getSelection', 'vscode.getDiagnostics', 'vscode.listOpenEditors',
  'vscode.applyEdit', 'vscode.getDocumentState', 'vscode.save',
]

async function withKit({ consumers, saveResult } = {}) {
  const home = tempHome()
  const ctx = fakeCtx()
  const handle = apply(ctx, { consumers, dshHome: home, connectWaitMs: 50, onLog: () => {} })
  await handle.boot
  const shared = ctx.provided.get('dshVscodeKit').v
  const editor = await fakeEditor(handle.kit.server, { saveResult })
  await editor.link.request('bridge.hello', {
    client: 'fake-editor', extensionVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION, capabilities: SAVE_CAPS,
  })
  const cleanup = async () => {
    if (!editor.socket.destroyed) await editor.close().catch(() => {})
    ctx.runDisposers()
    await handle.stopped.catch(() => {})
    rmSync(home, { recursive: true, force: true })
  }
  return { shared, handle, editor, cleanup }
}

const saveParams = (extra = {}) => ({
  file: FILE,
  expectedVersion: VERSION,
  expectedIncarnation: INC,
  expectedDisk: DISK,
  ...extra,
})

// ─────────────────────────────────────────────────────────────────────────────
// 码表
// ─────────────────────────────────────────────────────────────────────────────

test('T39 协议：-32013 只加码，且与 -32012 分家（磁盘冲突永不自动重试）', () => {
  assert.equal(ERR.DISK_STATE_CONFLICT, -32013)
  assert.equal(ERR_NAME[-32013], 'disk-state-conflict')
  assert.notEqual(ERR.DISK_STATE_CONFLICT, ERR.DOCUMENT_VERSION_CONFLICT)
  assert.equal(ERR.DOCUMENT_VERSION_CONFLICT, -32012, '旧码数字不许漂移')
  assert.equal(PROTOCOL_VERSION, 2, '★ T62：脏缓冲的拒绝码变了→整版升 v2')
  // ★ T62 把 -32011 用了：document-dirty。它与 -32013 必须分家（一个是来源不明，一个是磁盘字节变了）。
  assert.equal(ERR.DOCUMENT_DIRTY, -32011)
  assert.equal(ERR_NAME[-32011], 'document-dirty')
  // 档位表：save 属于 disk-write（白名单的判据就在这张表上）
  assert.equal(METHOD_TIERS['vscode.save'], 'disk-write')
  assert.equal(tierOf('vscode.save'), 'disk-write')
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 发送前三道门
// ─────────────────────────────────────────────────────────────────────────────

test('★ T39 ① 缺 expectedDisk → -32602 stage:local，对端零业务帧', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'disk-write' })
    await assert.rejects(
      svc.vscode.save(saveParams({ expectedDisk: undefined }), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.stage, 'local', '本地前置门家族')
        assert.equal(err.data?.reason, 'expected-disk-missing')
        assert.equal(err.data?.method, 'vscode.save')
        return true
      },
    )
    await assert.rejects(
      svc.vscode.save(saveParams({ expectedDisk: { mtime: 1.5, size: 1 } }), { sessionId: SESSION }),
      (err) => err.data?.reason === 'expected-disk-mtime-not-a-non-negative-integer',
    )
    assert.equal(editor.business(), 0, '本地门拒绝时一个业务字节都不许出门')
  } finally {
    await cleanup()
  }
})

test('★ T39 ② 白名单档位不足 → declared-below-required，零帧（save 确实归 disk-write）', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    // 配置允许 disk-write，但插件自己只声明 buffer-edit → 天花板按它自己声明算。
    const p = shared.forPlugin('p', { declared: 'buffer-edit' })
    await assert.rejects(
      p.vscode.save(saveParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_PARAMS)
        assert.equal(err.data?.stage, 'local')
        assert.equal(err.data?.reason, 'declared-below-required')
        assert.equal(err.data?.tier, 'disk-write')
        assert.equal(err.data?.declared, 'buffer-edit')
        return true
      },
    )
    assert.equal(editor.business(), 0, '档位不足时不许发帧')
  } finally {
    await cleanup()
  }
})

test('★ T39 ③ grant 上的 allowDirtySave 才是授权；params 里的同名字段进不了 grant 载荷', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'disk-write' })
    // 1) 默认不放权：发出去的 grant 载荷里没有这个键（不主动放权）。
    await svc.editing.grant({ sessionId: SESSION })
    assert.equal(Object.hasOwn(editor.grants.at(-1) ?? {}, 'allowDirtySave'), false)
    const clean = await svc.vscode.save(saveParams({ allowDirtySave: true }), { sessionId: SESSION })
    assert.equal(clean.saved, true)
    assert.doesNotThrow(() => validateResponse('vscode.save', clean))
    assert.equal(clean.dirtyBefore, true, '脏标记原样回传（能力层算的，kit 不改写）')
    assert.deepEqual(Object.keys(clean).sort(), ['dirtyBefore', 'disk', 'file', 'saved'])

    // 2) 显式放权：位落在 grant 载荷上（这是唯一入口）。
    await svc.editing.grant({ sessionId: SESSION, allowDirtySave: true })
    assert.equal(editor.grants.at(-1)?.allowDirtySave, true, '授权位必须随 grant 下发到执行侧')
    // 3) 调用方往 params 里塞同名字段也不会变成授权：wire 上的 grant 仍以 grant 记录为准。
    const res = await svc.vscode.save(saveParams({ allowDirtySave: true }), { sessionId: SESSION })
    assert.equal(res.saved, true)
    assert.equal(editor.count('vscode.save'), 2)
  } finally {
    await cleanup()
  }
})

test('★ T39 ④ 对端回 saved:false → -32009（成功外形的错误结果）', async () => {
  const { shared, cleanup, editor } = await withKit({
    consumers: { p: 'disk-write' },
    saveResult: { saved: false, file: FILE, disk: DISK, dirtyBefore: false },
  })
  try {
    const svc = shared.forPlugin('p', { declared: 'disk-write' })
    await svc.editing.grant({ sessionId: SESSION, allowDirtySave: true })
    await assert.rejects(
      svc.vscode.save(saveParams(), { sessionId: SESSION }),
      (err) => {
        assert.equal(err.code, ERR.INVALID_RESPONSE)
        assert.equal(err.data?.method, 'vscode.save')
        return true
      },
    )
    assert.equal(editor.count('vscode.save'), 1)
  } finally {
    await cleanup()
  }
})

test('★ T39 ⑤ grant({allowDirtySave}) 只收布尔 true：字符串/数字 → -32602 且零 grant 帧', async () => {
  const { shared, editor, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    const svc = shared.forPlugin('p', { declared: 'disk-write' })
    for (const bad of ['true', 1, null]) {
      await assert.rejects(
        svc.editing.grant({ sessionId: SESSION, allowDirtySave: bad }),
        (err) => {
          assert.equal(err.code, ERR.INVALID_PARAMS)
          assert.equal(err.data?.reason, 'allow-dirty-save-not-a-boolean')
          assert.equal(err.data?.granted, false)
          return true
        },
      )
    }
    assert.equal(editor.count('bridge.grant'), 0, '形状不对时连协商帧都不发')
    // 不传（undefined）是合法的"默认不放权"。
    await svc.editing.grant({ sessionId: SESSION })
    assert.equal(editor.count('bridge.grant'), 1)
  } finally {
    await cleanup()
  }
})

test('T39 三个入口都有 save：共享 facade 只能读、forPlugin 拿档位、kit 根对象有糖衣', async () => {
  const { shared, handle, cleanup } = await withKit({ consumers: { p: 'disk-write' } })
  try {
    assert.equal(typeof shared.vscode.save, 'function')
    assert.equal(typeof shared.forPlugin('p', { declared: 'disk-write' }).vscode.save, 'function')
    assert.equal(typeof handle.kit.vscode.save, 'function')
    assert.equal(typeof handle.kit.saveAs, 'function')
  } finally {
    await cleanup()
  }
})
