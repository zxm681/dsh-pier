import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWritePolicy } from '../src/document-write-policy.js'

const A = 'D:/t70/a.txt'
const input = {
  method: 'vscode.deleteFile', fileKey: A, version: 1, incarnation: 'i',
  isDirty: false, hasEvidenceSource: true,
}
const frozen = { allowed: false, reason: 'foreign-change', attribution: 'unknown' }

function pressure(policy) {
  // 不注入 maxFiles：必须跨真实默认512容量，而不是缩小配置。
  for (let i = 0; i < 600; i += 1) {
    policy.noteChange({ file: `D:/t70/other-${i}.txt`, version: 1, incarnation: 'other' })
  }
}

test('T70 default512: foreign taint survives 600 other files; only human baseline clears it', () => {
  const policy = createWritePolicy()
  policy.markForeign(A)
  assert.deepEqual(policy.judge(input), frozen)
  pressure(policy)
  assert.ok(policy.status().stats.evicted > 0, 'pressure must actually exercise eviction')
  assert.deepEqual(policy.judge(input), frozen, 'capacity must not turn frozen archive into allowed:true')
  assert.equal(policy.inspect(A).taint.reason, 'foreign-change')
  policy.establishBaseline(A, { version: 1, incarnation: 'i' })
  assert.equal(policy.judge(input).allowed, true, 'explicit human handoff remains the clearing path')
})

test('T70 default512: inflight count and window evidence survive 600 other files', () => {
  const policy = createWritePolicy()
  policy.establishBaseline(A, { version: 1, incarnation: 'i', dirtyOwned: true })
  policy.beginWrite(A, { method: 'vscode.save' })
  policy.beginWrite(A, { method: 'vscode.save' })
  pressure(policy)
  assert.equal(policy.inspect(A)?.inflight, 2, 'capacity must not discard active holders')
  assert.equal(policy.noteChange({ file: A, version: 2, incarnation: 'i' }).classified, 'inflight')
  assert.equal(policy.inspect(A).windowEvents, 1)
  assert.deepEqual(policy.endWrite(A, { verdict: { attribution: 'unknown' } }), { settled: false, inflight: 1 })
  assert.equal(policy.endWrite(A, { verdict: { attribution: 'unknown' } }).dirtyOwned, false)
  assert.equal(policy.inspect(A).inflight, 0)
  assert.equal(policy.noteChange({ file: A, version: 3, incarnation: 'i' }).classified, 'foreign')
  assert.deepEqual(policy.judge({ ...input, version: 3 }), frozen)
})

test('T70 default512: all-protected pressure retains new taints and inflight states, never orphaning them', () => {
  const policy = createWritePolicy()
  for (let i = 0; i < 600; i += 1) policy.markForeign(`D:/t70/frozen-${i}.txt`)
  for (let i = 0; i < 600; i += 1) {
    const fileKey = `D:/t70/frozen-${i}.txt`
    assert.deepEqual(policy.judge({ ...input, fileKey }), frozen)
  }
  policy.beginWrite(A, { method: 'vscode.save' })
  assert.equal(policy.inspect(A)?.inflight, 1, 'new holder must not be detached when all older entries are protected')
  assert.equal(policy.endWrite(A, { verdict: { attribution: 'unknown' } }).inflight, undefined)
  assert.equal(policy.inspect(A).inflight, 0)
})
