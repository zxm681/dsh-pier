/**
 * 第 3 课答疑用的测量脚本：回答「这样的方式是否有性能浪费」。
 *
 * 全部是真实测量，不估算。
 * 跑法：cd projects/dsh-vscode-dev && node work/scripts/lesson3-cost.mjs
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createConnection } from 'node:net'

const here = dirname(fileURLToPath(import.meta.url))
const kitSrc = join(here, '..', '..', 'packages', 'dsh-vscode-kit', 'src')
const { startBridgeServer, discoveryDir, listLiveBridges, sweepDiscoveryDir } = await import(
  'file://' + join(kitSrc, 'server.js').replace(/\\/g, '/')
)
const { connect, createLineSplitter } = await import(
  'file://' + join(kitSrc, 'protocol.js').replace(/\\/g, '/')
)

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-cost-'))
const dir = discoveryDir(home)

function bench(label, fn, n) {
  // 先热身一次，避免把首次 JIT 编译算进去
  fn()
  const t0 = performance.now()
  for (let i = 0; i < n; i++) fn()
  const total = performance.now() - t0
  return { label, n, totalMs: total, perCallUs: (total / n) * 1000 }
}

console.log('=== 测量 1：编辑器每 2 秒那一轮「扫描」到底花多少时间 ===')
const server = await startBridgeServer({
  dshHome: home,
  dshVersion: 'cost-demo',
  capabilities: ['bridge.ping'],
  sweep: false,
})
console.log(`  桥已起在 127.0.0.1:${server.port}，名片 ${dir}\\${server.pid}.json`)

const r1 = bench('listLiveBridges（读目录 + 读文件 + pid 探活 + 排序）', () => listLiveBridges(dir), 2000)
console.log(`  ${r1.n} 次，共 ${r1.totalMs.toFixed(1)} ms`)
console.log(`  单次 ≈ ${r1.perCallUs.toFixed(1)} 微秒`)
console.log('')

console.log('=== 测量 2：一轮扫描的间隔成本 ===')
console.log(`  每 2000 ms 跑一次 / 单次 ≈ ${(r1.perCallUs / 1000).toFixed(3)} ms`)
console.log(`  → CPU 占用率 ≈ ${(((r1.perCallUs / 1000) / 2000) * 100).toFixed(4)} %`)
console.log(`  → 一天跑 ${((24 * 3600 * 1000) / 2000).toFixed(0)} 次，累计 ≈ ${(((24 * 3600 * 1000) / 2000) * (r1.perCallUs / 1000) / 1000).toFixed(1)} 秒`)
console.log('')

console.log('=== 测量 3：真连上要花多久（连接 + hello 到达） ===')
async function fullConnect() {
  const info = listLiveBridges(dir)[0]
  const s = createConnection({ port: info.port, host: '127.0.0.1' })
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  // 直接在原始字节层等 hello —— 不要试图替换 link.handleMessage，
  // 它只是对外暴露的引用，内部 dispatch 走的是闭包里的同名函数（踩过这个坑）。
  let buf = ''
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hello timeout')), 3000)
    s.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.method === 'bridge.hello') { clearTimeout(timer); resolve(msg.params) }
        } catch { /* 半截 JSON，等下一块 */ }
      }
    })
  })
  s.destroy()
  return hello
}
await fullConnect() // 热身
const t0 = performance.now()
const N = 30
for (let i = 0; i < N; i++) await fullConnect()
const connMs = (performance.now() - t0) / N
console.log(`  连一次（含 hello 往返）≈ ${connMs.toFixed(2)} ms`)
console.log('  → 这只在「启动/重连」时发生，空闲时不连')
console.log('')

console.log('=== 测量 4：空闲时到底消耗什么 ===')
const before = process.cpuUsage()
await new Promise((r) => setTimeout(r, 1000))
const after = process.cpuUsage(before)
console.log(`  这一个进程空闲 1 秒的 CPU：user ${(after.user / 1000).toFixed(2)} ms + system ${(after.system / 1000).toFixed(2)} ms`)
console.log('  → 连接建立后双方都不轮询、不发心跳、不查存活')
console.log('  → 消息来了才醒（TCP 是事件驱动的，socket 空闲时内核里睡觉）')
console.log(`  注意：上面的数字含了本脚本自己在等的开销，真实连接空闲时更接近 0`)
console.log('')

console.log('=== 测量 5：token 在线上是明文吗 ===')
const info = listLiveBridges(dir)[0]
const s = createConnection({ port: info.port, host: '127.0.0.1' })
await new Promise((res) => s.once('connect', res))
let captured = ''
s.on('data', (c) => { captured += c.toString('utf8') })
// 发一条带正确 token 的原始请求（BSH 侧没有注册 handler，会回 -32601，但这不重要 ——
// 我们要看的是「字节里有没有 token」）
const sentBytes = JSON.stringify({ id: 1, method: 'bridge.ping', params: {}, token: info.token }) + '\n'
s.write(sentBytes)
s.write(JSON.stringify({ id: 2, method: 'bridge.ping', params: {}, token: 'wrong' }) + '\n')
await new Promise((r) => setTimeout(r, 300))
s.destroy()
console.log('  ★ 我们发出去的原始字节（就是这段明文）：')
console.log('    ' + sentBytes.trim().slice(0, 170))
console.log('')
console.log('  服务端回给我们的原始字节：')
for (const line of captured.split('\n').filter(Boolean).slice(0, 3)) {
  console.log('    ' + line.slice(0, 170))
}
console.log('')
console.log('  ★ 关键事实：token 是在 TCP 上以明文 JSON 字段传输的，双向都是。')
console.log('    谁能在网络上抓包，谁就能直接看到它。')
console.log('    TCP 没有任何加密，这是「必须只监听 127.0.0.1」的真正原因。')
console.log('')
console.log('  ★ 第二个事实（看第 2 行的错误码）：带错 token 的请求被 -32001 拒绝，')
console.log('    但 连接本身没被断开 —— 所以爆破者可以在一条连接上无限次试。')
console.log('    真正挡住爆破的不是「试错成本」，而是「127.0.0.1 让外部根本连不进来」。')
console.log('')

await server.close()
rmSync(home, { recursive: true, force: true })
console.log('（临时目录已清理）')
