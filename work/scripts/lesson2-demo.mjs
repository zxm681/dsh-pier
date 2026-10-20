// 第 2 课演示：用项目里真实的 protocol.js 讲 JSON-RPC 的三件事
// 跑法：node work/scripts/lesson2-demo.mjs
import { pathToFileURL } from 'node:url'
import { connect } from '../../packages/dsh-vscode-kit/src/protocol.js'

console.log('=== 演示 1：换行分帧为什么安全 ===')
const raw = '第一行\n第二行'
const encoded = JSON.stringify({ text: raw })
console.log('  原文里有真换行吗？      ', raw.includes('\n'))
console.log('  JSON.stringify 之后：    ', encoded)
console.log('  序列化后还有真换行吗？  ', encoded.includes('\n'))
console.log('  → 按 \\n 切行，绝不会把一个 JSON 切两半')

console.log('\n=== 演示 2：乱序回包靠 id 认领 ===')
const toB = []
const toA = []

// A 端：发请求
const a = connect({
  write: (line) => toB.push(line),
  onRequest: async (method) => ({ handledByA: method }),
})

// B 端：收到后，慢的故意晚回
const b = connect({
  write: (line) => toA.push(line),
  onRequest: async (method) => {
    if (method === 'slow') {
      await new Promise((r) => setTimeout(r, 80))
      return { who: 'slow' }
    }
    return { who: 'fast' }
  },
})

// 电线：把两边写出的行互相喂进去
const pump = setInterval(() => {
  while (toB.length) b.handleLine(toB.shift())
  while (toA.length) a.handleLine(toA.shift())
}, 5)

console.log('  同时发 slow 和 fast，其中 slow 要 80ms 才回')
const [slowResult, fastResult] = await Promise.all([
  a.request('slow'),
  a.request('fast'),
])
console.log('  fast 先回来：', JSON.stringify(fastResult))
console.log('  slow 后回来：', JSON.stringify(slowResult))
console.log('  → 两个结果没串位，因为每个请求带唯一 id，回包按 id 认领')

clearInterval(pump)
a.close()
b.close()

console.log('\n=== 演示 3：没有 id 的消息叫「通知」（不回包）===')
const notes = []
const receiver = connect({
  write: () => {},
  onRequest: async (method, params) => {
    notes.push({ method, params })
    return { shouldBeIgnored: true }
  },
})
receiver.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'bridge.hello', params: { x: 1 } }))
await new Promise((r) => setTimeout(r, 10))
console.log('  收到的通知：', JSON.stringify(notes[0]))
console.log('  → 处理完了，但因为没 id，不产生任何回包')

console.log('\n=== 演示 4：token 错了会收到 -32001 ===')
// 两端直接对接：client 写什么就喂给 server，server 写什么就喂给 client
let server = null
const client = connect({
  write: (line) => server.handleLine(line),
  token: '错的token',
  timeoutMs: 1000,
})
server = connect({
  write: (line) => client.handleLine(line),
  authorize: (token) => token === '对的token',
  onRequest: async () => ({ ok: true }),
})

try {
  await client.request('vscode.openFile', {})
  console.log('  居然成功了？（不应该）')
} catch (err) {
  console.log('  错误码：', err.code, '（-32001 = 未授权）')
  console.log('  原因：  ', err.data?.reason)
}

client.close()
server.close()
