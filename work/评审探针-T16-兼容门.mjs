/**
 * 评审 T16 独立探针（一次性，不提交）。
 *
 * 目的：不信实现者自述，自己验证三件事
 *   A) 不兼容时业务请求**根本没有发到对端**（不是发出去再报错）；
 *   B) lastEditor 是「整个 kit 一份」而不是「绑定目标连接」的 —— 双对端能否骗过门；
 *   C) VscodeKit.notify() 是否绕过版本门（门只加在 request() 上）。
 *
 * 用法：node work/评审探针-T16-兼容门.mjs
 */
import { createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../packages/dsh-vscode-kit/src/index.js'
import { connect, createLineSplitter } from '../packages/dsh-vscode-kit/src/protocol.js'

function fakeCtx() {
  const provided = new Map()
  const disposers = []
  return {
    provided,
    provide(n, v) { provided.set(n, { v }) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    runDisposers() { while (disposers.length) { try { disposers.pop()() } catch { /* */ } } },
  }
}

/** 裸 TCP 假编辑器：记下收到的每一个方法名（含无 id 的通知）。 */
async function fakeEditor(server) {
  const socket = createConnection({ port: server.port, host: '127.0.0.1' })
  const methods = []
  const notifications = []
  const link = connect({
    write: (l) => socket.write(l),
    token: server.token,
    onRequest: (method) => { methods.push(method); return { done: method } },
  })
  const feed = createLineSplitter((line) => {
    const msg = JSON.parse(line)
    if (msg.id !== undefined) { link.handleLine(line); return }
    if (msg.method !== undefined) methods.push(msg.method) // 通知也是业务消息，照样记
    notifications.push(msg)
  })
  socket.on('data', feed)
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j) })
  return {
    methods, notifications,
    hello: (params) => link.request('bridge.hello', params),
    ping: () => link.request('bridge.ping', {}),
    close: () => new Promise((r) => { if (socket.destroyed) return r(); socket.once('close', r); socket.end() }),
  }
}

async function withKit() {
  const home = mkdtempSync(join(tmpdir(), 't16-probe-'))
  const ctx = fakeCtx()
  const handle = apply(ctx, { dshHome: home, connectWaitMs: 200, helloWaitMs: 60, onLog: () => {} })
  await handle.boot
  const svc = ctx.provided.get('dshVscodeKit').v
  const cleanup = async () => {
    try { ctx.runDisposers() } catch { /* */ }
    try { await handle.stopped } catch { /* */ }
    rmSync(home, { recursive: true, force: true })
  }
  return { svc, kit: handle.kit, server: handle.kit.server, cleanup }
}

const out = []

// ── A) 门在发包之前 ────────────────────────────────────────────────────────────
{
  const { svc, server, cleanup } = await withKit()
  try {
    const e = await fakeEditor(server)
    await e.hello({ client: 'e', protocolVersion: 2, capabilities: ['vscode.getSelection'] })
    const before = e.methods.slice()
    let code = null, data = null
    try { await svc.request('vscode.getSelection', {}) } catch (err) { code = err.code; data = err.data }
    const after = e.methods.slice()
    out.push(['A. 不兼容(ptv=2) 业务请求', `code=${code} businessFramesAdded=${after.length - before.length} data.side=${data?.side} data.peer=${data?.peer}`])
    await e.close()
  } finally { await cleanup() }
}

// ── B) 两个已准入对端：后连的报 v2，先连的报 v1（谁能骗过门？） ─────────────────
{
  const { svc, server, cleanup } = await withKit()
  try {
    const a = await fakeEditor(server)   // connSeq=1（先连）
    const b = await fakeEditor(server)   // connSeq=2（后连 → 活跃目标）
    await a.ping()                        // 两者都准入
    await b.ping()
    await b.hello({ client: 'B', protocolVersion: 2, capabilities: ['vscode.getSelection'] })
    await a.hello({ client: 'A', protocolVersion: 1, capabilities: ['vscode.getSelection'] })
    const biz = (e) => e.methods.filter((m) => !m.startsWith('bridge.')).length
    const aBefore = biz(a), bBefore = biz(b)
    let code = null, res = null
    try { res = await svc.request('vscode.getSelection', {}, { waitForEditor: false }) } catch (err) { code = err.code }
    const active = svc.snapshot().lastEditor
    out.push(['B. 目标=B(ptv=2)，但最后一次 hello 来自 A(ptv=1)',
      `code=${code} ok=${JSON.stringify(res)} lastEditorClient=${active?.client}`
      + ` B收到业务帧增量=${biz(b) - bBefore} A收到业务帧增量=${biz(a) - aBefore}`])
    await a.close(); await b.close()
  } finally { await cleanup() }
}

// ── C) VscodeKit.notify() 是否绕过版本门 ──────────────────────────────────────
{
  const { svc, server, cleanup } = await withKit()
  try {
    const e = await fakeEditor(server)
    await e.hello({ client: 'e', protocolVersion: 2, capabilities: ['vscode.getSelection'] })
    const before = e.methods.filter((m) => !m.startsWith('bridge.')).length
    let threw = null
    try { svc.notify('vscode.getSelection', { probe: true }) } catch (err) { threw = `${err.code}` }
    await new Promise((r) => setTimeout(r, 80))
    const after = e.methods.filter((m) => !m.startsWith('bridge.')).length
    out.push(['C. 不兼容时 notify() 业务方法', `threw=${threw} 对端收到业务帧增量=${after - before}`])
    // 对照：request() 同方法必须被拒
    let rcode = null
    try { await svc.request('vscode.getSelection', {}) } catch (err) { rcode = err.code }
    out.push(['C2. 同场景 request() 对照', `code=${rcode}`])
    await e.close()
  } finally { await cleanup() }
}

// ── D) 目标切换后的陈旧背书：B 先连（v2），A 后连（v1），A 断开回退到 B ──────────
{
  const { svc, server, cleanup } = await withKit()
  try {
    const b = await fakeEditor(server)   // connSeq=1，新版扩展 ptv=2
    const a = await fakeEditor(server)   // connSeq=2，旧版扩展 ptv=1（此时是活跃目标）
    await b.ping(); await a.ping()
    await b.hello({ client: 'B-v2', protocolVersion: 2, capabilities: ['vscode.getSelection'] })
    await a.hello({ client: 'A-v1', protocolVersion: 1, capabilities: ['vscode.getSelection'] })
    const biz = (e) => e.methods.filter((m) => !m.startsWith('bridge.')).length
    const bBefore = biz(b)
    await a.close()                       // 旧版窗口关掉 → 目标回退到 B（ptv=2）
    let code = null, res = null
    try { res = await svc.request('vscode.getSelection', {}, { waitForEditor: false }) } catch (err) { code = err.code }
    out.push(['D. B(v2) 先连、A(v1) 后连并断开 → 目标回退到不兼容的 B',
      `code=${code} ok=${JSON.stringify(res)} lastEditorClient=${svc.snapshot().lastEditor?.client}`
      + ` protocolCompatible=${svc.snapshot().protocolCompatible} B收到业务帧增量=${biz(b) - bBefore}`])
    await b.close()
  } finally { await cleanup() }
}


console.log('\n=== 探针结果 ===')
for (const [k, v] of out) console.log(`${k}\n   → ${v}`)
process.exit(0)
