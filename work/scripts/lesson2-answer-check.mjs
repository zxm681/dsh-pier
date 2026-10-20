// 第 2 课练习题验证：如果 openFile 用「通知」发，失败会怎样？
// 跑法：node work/scripts/lesson2-answer-check.mjs
//
// 关键：通知没有 id → 没有回包通道 → 对面失败了也无法告诉你

import { connect, BridgeError, ERR } from '../../packages/dsh-vscode-kit/src/protocol.js'

console.log('=== 场景：DSH 想打开一个不存在的文件 ===\n')

// ---------- 情况 A：用「请求」（有 id） ----------
console.log('【A】用请求（有 id）：')
let serverA = null
const clientA = connect({
  write: (line) => serverA.handleLine(line),
  timeoutMs: 2000,
})
serverA = connect({
  write: (line) => clientA.handleLine(line),
  onRequest: async (method, params) => {
    // 模拟 capabilities.js 第 94 行的真实行为
    throw new BridgeError(ERR.NOT_FOUND, `file not found: ${params.path}`, {
      method,
      path: params.path,
    })
  },
})

try {
  await clientA.request('vscode.openFile', { path: 'D:/nope.txt' })
  console.log('  成功了？（不应该）')
} catch (err) {
  console.log('  ✅ 调用方收到错误：')
  console.log('     code    =', err.code, '( -32003 = 找不到 )')
  console.log('     message =', err.message)
  console.log('     data    =', JSON.stringify(err.data))
  console.log('  → DSH 能据此告诉 agent「文件不存在，换个路径」')
}
clientA.close()
serverA.close()

// ---------- 情况 B：用「通知」（无 id） ----------
console.log('\n【B】用通知（没有 id）：')
let serverB = null
const clientB = connect({
  write: (line) => serverB.handleLine(line),
  timeoutMs: 2000,
})
let errorReportedToServer = null
serverB = connect({
  write: (line) => clientB.handleLine(line),
  onRequest: async (method, params) => {
    throw new BridgeError(ERR.NOT_FOUND, `file not found: ${params.path}`, { method })
  },
  onError: (err) => {
    errorReportedToServer = err
  },
})

clientB.notify('vscode.openFile', { path: 'D:/nope.txt' })
await new Promise((r) => setTimeout(r, 100))

console.log('  通知发出去了，然后呢？')
console.log('  → 客户端这边：什么都没发生')
console.log('     （没有 Promise 可以 await，也没有异常可 catch）')
console.log('  → 服务端这边：错误只记在它自己的 onError 里')
if (errorReportedToServer) {
  console.log('     onError 收到:', errorReportedToServer.message)
}
console.log('  ❌ DSH 永远不知道失败了')
console.log('     agent 会以为文件打开了，继续往下做 —— 这就是静默失败')

clientB.close()
serverB.close()

console.log('\n=== 结论 ===')
console.log('两件事都需要知道结果，所以两个都必须用「请求」：')
console.log('  · vscode.openFile    → 要回执，因为可能失败（文件不存在/二进制/未信任）')
console.log('  · vscode.getSelection → 要内容，本来就得等回包')
console.log('')
console.log('通知只适合「不在乎结果」的场景，例如：')
console.log('  · bridge.hello      → 我告诉你我支持哪些能力，你收下就行')
console.log('  · 日志、心跳、遥测  → 丢了也不影响业务')
