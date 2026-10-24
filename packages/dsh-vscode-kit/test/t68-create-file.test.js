import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/index.js'
import { connect, PROTOCOL_VERSION, createLineSplitter } from '../src/protocol.js'
import { WRITE_METHODS } from '../src/grant.js'
import { tierOf } from '../src/whitelist.js'
import { validateResponse } from '../src/response-contract.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../work/t68-fixtures')
mkdirSync(fixtures, { recursive: true })
const SESSION = 't68-session'
const params = (extra = {}) => ({ file: '/ws/new.txt', text: '中文😀', expectedDisk: null, ...extra })
async function withKit() {
  const home = mkdtempSync(join(fixtures, 'kit-'))
  const provided = new Map(), disposers = []
  const ctx = {
    provide: (name, value) => provided.set(name, value),
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  }
  const handle = apply(ctx, { dshHome: home, consumers: { p: 'disk-write', r: 'read' }, onLog: () => {} })
  await handle.boot
  const editors = []
  async function editor() {
    const socket = createConnection({ port: handle.kit.server.port, host: '127.0.0.1' })
    const seen = []
    const link = connect({ token: handle.kit.server.token, write: (line) => socket.write(line),
      onRequest: (method, p) => {
        if (method === 'bridge.grant') return { ok: true, id: p.grant.id }
        if (method === 'vscode.createFile') {
          seen.push(p)
          const bytes = Buffer.byteLength(p.text)
          return { created: true, file: p.file, bytes, disk: { mtime: 123, size: bytes } }
        }
        if (method === 'bridge.ping') return { pong: true }
        throw new Error(`unexpected ${method}`)
      },
    })
    socket.on('data', createLineSplitter((line) => link.handleLine(line)))
    socket.on('error', () => {})
    await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
    await link.request('bridge.hello', { client: 't68-editor', extensionVersion: '0.3.3',
      protocolVersion: PROTOCOL_VERSION, capabilities: ['vscode.createFile'] })
    const result = { socket, link, seen }
    editors.push(result)
    return result
  }
  const first = await editor()
  const shared = provided.get('dshVscodeKit')
  const svc = shared.forPlugin('p', { declared: 'disk-write' })
  return { svc, shared, handle, first, editor,
    async cleanup() {
      for (const e of editors) {
        if (!e.socket.destroyed) await new Promise((r) => { e.socket.once('close', r); e.socket.destroy() })
      }
      while (disposers.length) disposers.pop()()
      await handle.stopped
    },
  }
}
const opts = { sessionId: SESSION }

test('T68 发送面：disk-write + WRITE_METHODS 登记，三个稳定糖衣入口存在', async () => {
  assert.equal(tierOf('vscode.createFile'), 'disk-write')
  assert.ok(WRITE_METHODS.includes('vscode.createFile'))
  const e = await withKit()
  try {
    for (const svc of [e.svc, e.shared, e.handle.kit]) assert.equal(typeof svc.vscode.createFile, 'function')
  } finally { await e.cleanup() }
})

test('T68 正向 TCP：自动补 grant，无文档化身要求，回执字段齐且 disk.size===bytes', async () => {
  const e = await withKit()
  try {
    await e.svc.editing.grant(opts)
    const result = await e.svc.vscode.createFile(params(), opts)
    assert.deepEqual(Object.keys(result).sort(), ['bytes', 'created', 'disk', 'file'])
    assert.equal(result.created, true)
    assert.equal(result.disk.size, result.bytes)
    assert.equal(e.first.seen.length, 1)
    assert.ok(e.first.seen[0].grant.id)
    assert.equal(e.first.seen[0].expectedIncarnation, undefined)
  } finally { await e.cleanup() }
})

test('T68 read 档白名单拒且宿主零调用/对端零业务帧', async () => {
  const e = await withKit()
  try {
    const reader = e.shared.forPlugin('r', { declared: 'read' })
    await assert.rejects(reader.vscode.createFile(params(), opts), (err) => {
      assert.equal(err.code, -32602)
      assert.equal(err.data?.tier, 'disk-write')
      return true
    })
    assert.equal(e.first.seen.length, 0)
  } finally { await e.cleanup() }
})

test('T68 缺 grant → -32010 missing=grant，零业务帧', async () => {
  const e = await withKit()
  try {
    await assert.rejects(e.svc.vscode.createFile(params(), opts), (err) => {
      assert.equal(err.code, -32010)
      assert.equal(err.data?.missing, 'grant')
      return true
    })
    assert.equal(e.first.seen.length, 0)
  } finally { await e.cleanup() }
})

test('T68 糖衣与 raw request：expectedDisk 缺失/非 null 本地拒，零业务帧', async () => {
  const e = await withKit()
  try {
    await e.svc.editing.grant(opts)
    for (const call of [e.svc.vscode.createFile, (p, o) => e.svc.request('vscode.createFile', p, o)]) {
      for (const expectedDisk of [undefined, { mtime: 1, size: 1 }, false]) {
        await assert.rejects(call(params({ expectedDisk }), opts), (err) => {
          assert.equal(err.code, -32602)
          assert.equal(err.data?.stage, 'local')
          assert.equal(err.data?.reason, expectedDisk === undefined ? 'expected-disk-missing' : 'expected-disk-not-null')
          return true
        })
      }
    }
    assert.equal(e.first.seen.length, 0)
  } finally { await e.cleanup() }
})

test('T68 UTF-8 1 MiB 边界：正好出门，+1、本地孤立代理项拒绝，零额外帧', async () => {
  const e = await withKit()
  try {
    await e.svc.editing.grant(opts)
    const text = 'a'.repeat(1024 * 1024)
    assert.equal((await e.svc.vscode.createFile(params({ text }), opts)).bytes, 1024 * 1024)
    for (const [text, reason] of [['a'.repeat(1024 * 1024 + 1), 'payload-too-large'], ['\ud800', 'not-encodable'], [undefined, 'text-not-a-string']]) {
      await assert.rejects(e.svc.vscode.createFile(params({ text }), opts), (err) => {
        assert.equal(err.code, -32602)
        assert.equal(err.data?.reason, reason)
        return true
      })
    }
    assert.equal(e.first.seen.length, 1)
  } finally { await e.cleanup() }
})

test('T68 notify/broadcast 入口拒，零业务帧', async () => {
  const e = await withKit()
  try {
    assert.throws(() => e.svc.notify('vscode.createFile', params()), (err) => err.code === -32600 && err.data.reason === 'write-requires-request')
    assert.throws(() => e.handle.kit.server.broadcast('vscode.createFile', params()), (err) => err.code === -32600 && err.data.reason === 'write-requires-request')
    assert.equal(e.first.seen.length, 0)
  } finally { await e.cleanup() }
})

test('T68 写目标只认 grant 的 link，不认最后连接；target 仍在绑定前拒', async () => {
  const e = await withKit()
  try {
    await e.svc.editing.grant(opts)
    const second = await e.editor()
    await e.svc.vscode.createFile(params(), opts)
    assert.equal(e.first.seen.length, 1)
    assert.equal(second.seen.length, 0)
    await assert.rejects(e.svc.vscode.createFile(params(), { ...opts, target: '#1' }),
      (err) => err.code === -32014 && err.data.reason === 'target-not-routable')
    assert.equal(e.first.seen.length, 1)
  } finally { await e.cleanup() }
})

test('T68 响应门：缺字段/size 不等/伪覆盖回执拒为 -32009', () => {
  const good = { created: true, file: '/ws/new.txt', bytes: 1, disk: { mtime: 1, size: 1 } }
  assert.equal(validateResponse('vscode.createFile', good), good)
  for (const result of [{ ...good, created: false }, { ...good, bytes: undefined },
    { ...good, disk: { mtime: 1, size: 2 } }, { ...good, overwritten: false }, { ...good, replaced: true }]) {
    assert.throws(() => validateResponse('vscode.createFile', result), (err) => err.code === -32009)
  }
})
