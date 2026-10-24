/**
 * T62 / A2：`-32011 document-dirty` 在 **kit 侧**（DSH 这一端）的合同。
 *
 * 本文件守三件事：
 *  ① 码本身：数字、名字、与 `-32012` / `-32013` 分家（三者处置完全不同，混用就是骗消费者）；
 *  ② 协议版本：整版升到 v2 —— 新旧混配统一 `-32008`，`hello` 仍可协商（这里只验常量与判定，
 *     端到端协商在 `test/compat-gate.test.js`）；
 *  ③ 客户端行为：收到 `-32011` 时**原样上浮**，绝不折叠成 `-32012`，也不自动重发
 *     （`-32012` 的处置是"重读锚点重发"，`-32011` 的处置是"停在这个文件上"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BridgeError,
  ERR,
  ERR_NAME,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL,
  connect,
  judgeProtocolVersion,
} from '../src/protocol.js'

function capture() {
  const lines = []
  const write = (line) => { lines.push(JSON.parse(line)) }
  return { lines, write }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 码
// ─────────────────────────────────────────────────────────────────────────────

test('T62 码表：-32011 = document-dirty，且与 -32012 / -32013 三个数字互不相同', () => {
  assert.equal(ERR.DOCUMENT_DIRTY, -32011)
  assert.equal(ERR_NAME[ERR.DOCUMENT_DIRTY], 'document-dirty')
  assert.equal(ERR.DOCUMENT_VERSION_CONFLICT, -32012)
  assert.equal(ERR.DISK_STATE_CONFLICT, -32013)
  // 三者混用会让消费者做错动作：
  //  -32012 → 重读锚点重发；-32013 → 磁盘被别人改了，重发也没用；-32011 → 别重发，先让人处理。
  const codes = [ERR.DOCUMENT_DIRTY, ERR.DOCUMENT_VERSION_CONFLICT, ERR.DISK_STATE_CONFLICT]
  assert.equal(new Set(codes).size, 3, '三个码必须是三个不同的数字')
})

test('T62 错误对象：-32011 的 data 原样跨线往返（结构化的东西不许丢字段）', () => {
  const data = {
    method: 'vscode.save',
    file: 'C:/ws/a.js',
    reason: 'foreign-change',
    isDirty: true,
    attribution: 'unknown',
    version: 7,
    incarnation: 'inc-a',
    retryable: false,
    recovery: 'human-rebase',
    mayHaveApplied: false,
  }
  const wire = new BridgeError(ERR.DOCUMENT_DIRTY, 'refusing to write', data).toJSON()
  const back = BridgeError.from(wire)
  assert.equal(back.code, -32011)
  assert.deepEqual(back.data, data)
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 协议版本
// ─────────────────────────────────────────────────────────────────────────────

test('T62 版本：PROTOCOL_VERSION=2 且 SUPPORTED_PROTOCOL=[2,2]（不拿 [1,2] 伪造兼容）', () => {
  assert.equal(PROTOCOL_VERSION, 2)
  assert.deepEqual([...SUPPORTED_PROTOCOL], [2, 2],
    '「新旧都能读」不等于「新旧都兼容」：范围写成 [1,2] 会让 v1 对端被当成兼容，语义分歧就被掩盖了')
  assert.ok(Object.isFrozen(SUPPORTED_PROTOCOL))
})

test('T62 混配：v1 对端在 v2 本端一律判不兼容（out-of-range），且理由不撒谎', () => {
  const v1 = judgeProtocolVersion(1)
  assert.equal(v1.compatible, false, '★ v2 本端不许把 v1 对端当兼容：脏态语义已经变了')
  assert.equal(v1.reason, 'out-of-range')
  assert.equal(v1.peer, 1, '对端声明值要如实回显（否则现场没法查）')
  assert.equal(judgeProtocolVersion(2).compatible, true)
  assert.equal(judgeProtocolVersion(3).compatible, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ 客户端行为：原样上浮 + 不自动重试
// ─────────────────────────────────────────────────────────────────────────────

test('T62 ★ 收到 -32011 时原样上浮成 BridgeError（不折叠成 -32012、不改 reason）', async () => {
  const { lines, write } = capture()
  const c = connect({ write })
  const p = c.request('vscode.save', { file: 'C:/ws/a.js' })
  const { id } = lines[0]
  const data = {
    method: 'vscode.save', file: 'C:/ws/a.js', reason: 'observation-gap',
    isDirty: false, attribution: 'unknown', retryable: false,
  }
  c.handleLine(JSON.stringify({
    jsonrpc: '2.0', id, error: { code: -32011, message: 'refusing to write', data },
  }))
  await assert.rejects(p, (err) => {
    assert.ok(err instanceof BridgeError)
    assert.equal(err.code, -32011, '★ 码不许在客户端被"翻译"成 -32012：那会让调用方按重发合同处理')
    assert.deepEqual(err.data, data)
    return true
  })
})

test('T62 ★ -32011 不是可重试失败：协议层不许因为它自动重发（重试只发生在明确的地方）', async () => {
  const { lines, write } = capture()
  const c = connect({ write })
  const p = c.request('vscode.applyEdit', { file: 'C:/ws/a.js' })
  assert.equal(lines.length, 1, '一次请求 = 一帧')
  const { id } = lines[0]
  c.handleLine(JSON.stringify({
    jsonrpc: '2.0', id, error: { code: -32011, message: 'refusing to write', data: { reason: 'dirty-quarantine' } },
  }))
  await assert.rejects(p)
  assert.equal(lines.length, 1, '★ 被拒之后不再多发任何一帧（-32011 的处置是"停下"，不是"再试一次"）')
  assert.equal(c.pendingCount, 0, '请求已经结算，不许挂着等着"稍后重试"')
})

test('T62 静态守门：-32011 只在 protocol.js 里定义一次，src 里没有任何地方把它改写成别的码', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url))
  const hits = []
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.js')) continue
    const source = readFileSync(new URL(name, new URL('../src/', import.meta.url)), 'utf8')
    if (source.includes('-32011')) hits.push(name)
  }
  assert.deepEqual(hits, ['protocol.js'],
    '别的文件里出现 -32011 多半是在做"翻译"（比如折叠成 -32012）；码只该在码表里出现')
})
