// 第 3 课演示：发现文件 + 端口 + token + loopback 怎么配合
// 跑法：cd projects/dsh-vscode-dev && node work/scripts/lesson3-demo.mjs
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoveryDir,
  isProcessAlive,
  listLiveBridges,
  removeDiscoveryFile,
  sweepDiscoveryDir,
  writeDiscoveryFile,
} from '../../packages/dsh-vscode-kit/src/discovery.js'
import { startBridgeServer } from '../../packages/dsh-vscode-kit/src/server.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-lesson3-'))
const dir = discoveryDir(home)

console.log('=== 演示 1：名片放在哪儿 ===')
console.log('  我们伪造一个 DSH_HOME：', home)
console.log('  发现目录：            ', dir)
console.log('  → 真实运行时这里是 C:\\Users\\<你>\\.dsh\\dsh-vscode-kit\\')

console.log('\n=== 演示 2：起一个真的 TCP 桥，看它写出的名片 ===')
const server = await startBridgeServer({
  dshHome: home,
  dshVersion: 'lesson3-demo',
  capabilities: ['bridge.ping'],
  onRequest: async () => ({ ok: true }),
})
const files = readdirSync(dir).filter((n) => n.endsWith('.json'))
const card = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
console.log('  目录里出现了：', files.join(', '))
console.log('  名片内容：')
for (const [k, v] of Object.entries(card)) {
  const shown = String(v)
  console.log(`    ${k.padEnd(16)} = ${shown.length > 40 ? shown.slice(0, 20) + '…(共' + shown.length + '字符)' : shown}`)
}

console.log('\n=== 演示 3：名片权限位 ===')
const mode = (statSync(join(dir, files[0])).mode & 0o777).toString(8)
console.log('  代码里写的是 0600（只允许自己读写）')
console.log('  实际 stat 出来：', mode)
if (mode !== '600') {
  console.log('  ⚠️ Windows 上 chmod 的语义与 POSIX 不同，这里拿不到 600')
  console.log('  → 所以「靠权限位保护 token」在 Windows 上靠不住')
  console.log('  → 真正兜底的是：目录在用户 home 下 + 只监听 127.0.0.1')
}
console.log('  文件名只用 pid：', files[0])
console.log('  → 文件名会被 ls / 日志 / 报错信息带出去，token 放进去等于到处宣传')

console.log('\n=== 演示 4：死 pid 留下的名片会被清扫 ===')
// 伪造一张死名片：pid 用一个肯定不存在的
const fakeDead = { port: 9999, token: 'x'.repeat(64), pid: 999999, startedAt: 0, protocolVersion: 1, capabilities: [] }
writeDiscoveryFile(dir, fakeDead)
console.log('  伪造死名片后，目录里有：', readdirSync(dir).filter((n) => n.endsWith('.json')).join(', '))
console.log('  pid 999999 还活着吗？', isProcessAlive(999999))
const live = listLiveBridges(dir)
console.log('  listLiveBridges 只返回：', live.map((b) => b.pid).join(', '), '（死的那张被跳过了）')
const swept = sweepDiscoveryDir(dir)
console.log('  sweepDiscoveryDir 删掉了：', swept.removed.join(', ') || '（无）')
console.log('  → 编辑器不会被一张过期名片骗去连一个不存在的端口')

console.log('\n=== 演示 5：多实例仲裁规则 ===')
console.log('  ⚠️ 注意：一个进程里起两个 server 造不出「两个实例」')
console.log('     名片文件名是 <pid>.json，同进程 pid 相同 → 后起的覆盖前一个')
console.log('     → 多实例仲裁只在「不同进程」时才成立')
console.log('     真实场景：你开两个 dsh web，就是两个 pid，两张名片')
console.log('')
// 造第二张名片，用父进程 pid（它确实活着，能通过 isProcessAlive）。
// 不能再用 process.pid —— 那会覆盖掉真实 server 的名片（文件名就是 <pid>.json）。
const fakePid = process.ppid
console.log('  再塞一张「另一个实例」的名片，pid 用父进程', fakePid, '（真实存活）')
writeDiscoveryFile(dir, {
  port: 7422,
  token: 'b'.repeat(64),
  pid: fakePid,
  startedAt: Date.now(), // 比真实例晚，所以排第一
  protocolVersion: 1,
  capabilities: [],
  _note: '假实例（演示排序用）',
})
const all = listLiveBridges(dir)
console.log('  listLiveBridges 返回顺序（startedAt 降序 = 最新的在前）：')
all.forEach((b, i) => console.log(`    [${i}] port=${b.port} pid=${b.pid} ${b._note ?? '(真实例)'}`))
console.log('  → 编辑器取 [0]（startedAt 最大的那个），这就是多实例仲裁规则')

console.log('\n=== 演示 6：loopback 是什么意思 ===')
console.log('  服务端 bind 的地址是 127.0.0.1（不是 0.0.0.0）')
console.log('  → 127.0.0.1 = 「只接受本机进程连接」，路由器/局域网上的机器都连不进来')
console.log('  → 如果 bind 0.0.0.0，同一 WiFi 下的任何人都能连你的 7410 端口')

// 清理
removeDiscoveryFile(dir, server.pid)
await server.close()
console.log('\n（演示结束，临时目录已清理）')
