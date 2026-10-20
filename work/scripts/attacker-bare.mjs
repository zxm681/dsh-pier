// 攻击者替身：只在真机验证时用。裸连桥端口，一个字节都不发，
// 然后看它能收到什么。目的不是演示攻击，是证明「连上 ≠ 准入」在真进程里成立。
import { createConnection } from 'node:net'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-vscode-kit')
const card = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
if (!card) { console.log('NO_CARD'); process.exit(1) }

const sock = createConnection({ port: card.port, host: '127.0.0.1' })
const got = []
sock.on('data', (c) => got.push(c.toString()))
sock.on('connect', () => {
  console.log(`ATTACKER connected to ${card.port} as pid ${process.pid} (no token, silent)`)
  // 静默挂 18 秒，覆盖 smoke 的 delayMs 窗口与请求时刻
  setTimeout(() => {
    const rx = got.join('')
    console.log(`ATTACKER received ${rx.split('\n').filter(Boolean).length} message(s)`)
    if (rx.trim()) console.log(`ATTACKER raw: ${rx.trim().slice(0, 400)}`)
    sock.destroy()
    process.exit(0)
  }, 18000)
})
sock.on('error', (e) => { console.log(`ATTACKER error: ${e.code}`); process.exit(1) })
