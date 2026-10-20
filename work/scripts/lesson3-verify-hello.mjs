/**
 * 验证一个怀疑：服务端主动发的 hello 里是不是带着 token？
 * 如果带着，那"鉴权"就是假的 —— 任何人连上就先白拿 token。
 *
 * 跑法：cd projects/dsh-vscode-dev && node work/scripts/lesson3-verify-hello.mjs
 */

import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const kitSrc = join(here, '..', '..', 'packages', 'dsh-vscode-kit', 'src')
const { apply } = await import('file://' + join(kitSrc, 'index.js').replace(/\\/g, '/'))
const { discoveryDir } = await import('file://' + join(kitSrc, 'discovery.js').replace(/\\/g, '/'))

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-hello-'))
const dir = discoveryDir(home)

function fakeCtx() {
  const disposers = []
  return {
    provide() {},
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    async dispose() { for (const d of disposers.reverse()) { try { await d() } catch {} } },
  }
}
const ctx = fakeCtx()
const handle = apply(ctx, { dshHome: home, connectWaitMs: 0, onLog: () => {} })
await handle.boot
await new Promise((r) => setTimeout(r, 50))

const port = handle.kit.server.port

/** 建一条连接，读第一条消息 */
async function firstMessage(port) {
  const s = createConnection({ port, host: '127.0.0.1' })
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  let buf = ''
  const msg = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message in 1500ms')), 1500)
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const i = buf.indexOf('\n')
      if (i < 0) return
      clearTimeout(timer)
      resolve(JSON.parse(buf.slice(0, i)))
    })
  })
  return { socket: s, msg }
}

console.log('=== 验证 1：服务端连上就发的第一条消息，有没有 token？ ===')
const { socket: s1, msg: hello } = await firstMessage(port)
console.log('  原始消息：')
console.log('    ' + JSON.stringify(hello).slice(0, 220))
console.log('')
const leaked = hello.token
console.log(`  顶层 token 字段：${leaked ? leaked.slice(0, 24) + '…（共 ' + leaked.length + ' 字符）' : '不存在'}`)

// 跟名片里的真 token 比对
const card = JSON.parse(await (await import('node:fs/promises')).readFile(
  join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'))
console.log(`  名片里的真 token：${card.token.slice(0, 24)}…`)
console.log(`  两者相同吗？ ${leaked === card.token ? '★ 是 —— token 被白送了' : '否'}`)
console.log('')

console.log('=== 验证 2：用 hello 白拿的 token 能通过鉴权吗？ ===')
{
  s1.write(JSON.stringify({ id: 99, method: 'bridge.ping', params: { who: 'unauthenticated-then-authenticated' }, token: leaked }) + '\n')
  let buf = ''
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), 1500)
    s1.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.id === 99) { clearTimeout(timer); resolve(m) }
      }
    })
  })
  console.log('  回复：' + JSON.stringify(reply).slice(0, 200))
  console.log(`  ${reply.result ? '★ 成功 —— 攻击者用 hello 白拿的 token 就成了合法对端' : '被拒绝了'}`)
}
s1.destroy()
console.log('')

console.log('=== 验证 3：完全不带 token 的连接，还能收到 hello 吗？ ===')
{
  const { socket, msg } = await firstMessage(port)
  console.log(`  收到了：method=${msg.method}`)
  console.log(`  里面照样带 token：${msg.token ? '是' : '否'}`)
  socket.destroy()
  console.log('  → 也就是说，握手发生在鉴权之前。')
}
console.log('')

console.log('=== 验证 4：发一段 HTTP 会怎样（浏览器能不能打） ===')
{
  const s = createConnection({ port, host: '127.0.0.1' })
  await new Promise((res) => s.once('connect', res))
  let got = ''
  let closed = false
  s.on('data', (c) => { got += c.toString('utf8') })
  s.on('close', () => { closed = true })
  s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
  await new Promise((r) => setTimeout(r, 500))
  if (!closed) s.destroy()
  console.log('  收到的字节：')
  for (const line of got.split('\n').filter(Boolean).slice(0, 3)) console.log('    ' + line.slice(0, 140))
  console.log(`  连接被服务端断开？ ${closed ? '是' : '否 —— 服务端只是报了 PARSE 错，连接还活着'}`)
  console.log('  ★ 注意：这里我上一版的说法是错的，特此实测纠正。')
}
console.log('')

await handle.stopped
await ctx.dispose()
rmSync(home, { recursive: true, force: true })
console.log('（临时目录已清理）')
