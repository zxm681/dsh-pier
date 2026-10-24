import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { GrantStore, documentContentHash } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities } from '../src/capabilities.js'
import { createWritePolicy } from '../src/document-write-policy.js'

// 只借现存路径过真实路径门；文档/磁盘读写全在内存，不改 AGENTS.md。
const root = fileURLToPath(new URL('../../../', import.meta.url))
const file = join(root, 'AGENTS.md')
const grant = { id: 'a'.repeat(32), epoch: 'b'.repeat(32) }

function fixture(t, failure) {
  const policy = createWritePolicy()
  const link = { name: 't70-memory-host' }
  const grants = new GrantStore()
  grants.adopt({ ...grant, link, allowDirtySave: true })
  const state = { version: 1, incarnation: 'i', isDirty: true, text: 'x' }
  let observer
  let failPath = false
  const calls = { save: 0, end: 0, pathFailure: 0 }
  const originalRealpath = fs.realpathSync
  const pathMock = t.mock.method(fs, 'realpathSync', (...args) => {
    if (failPath) {
      calls.pathFailure += 1
      throw new Error('T70 injected post-save realpath failure')
    }
    return originalRealpath(...args)
  })
  const originalEnd = policy.endWrite
  policy.endWrite = (...args) => {
    calls.end += 1
    return originalEnd(...args)
  }
  const host = {
    workspaceRoots: () => [root],
    isTrusted: () => true,
    observeTextChanges: (fn) => { observer = fn; return { dispose() {} } },
    readDocumentState: async () => ({
      ...state, eol: 'lf', lineCount: 1,
      textLength: state.text.length, byteLength: Buffer.byteLength(state.text),
    }),
    readDiskStat: async () => failure === 'post-stat' && calls.save > 0
      ? null : { mtime: 1, size: 1 },
    saveDocument: async (target) => {
      calls.save += 1
      if (failure === 'throw') throw new Error('T70 injected host failure')
      if (failure === 'false') return { saved: false, documentPath: target }
      if (failure === 'malformed') return { saved: 'true', documentPath: target }
      if (failure === 'path') failPath = true
      if (failure === 'identity') return { saved: true, documentPath: null }
      if (!failure || failure === 'post-stat') state.isDirty = false
      return { saved: true, documentPath: target }
    },
  }
  const caps = createCapabilities(host, { grants, writePolicy: policy })
  const params = () => ({
    file, grant, expectedVersion: state.version, expectedIncarnation: state.incarnation,
    expectedDisk: { mtime: 1, size: 1 },
  })
  return {
    caps, policy, state, calls, link, params,
    restorePath: () => { failPath = false; pathMock.mock.restore() },
    save: () => caps.dispatch('vscode.save', params(), { link }),
    seed: () => policy.establishBaseline(file, {
      version: 1, incarnation: 'i', dirtyOwned: true,
    }),
    rebase: () => caps.dispatch('vscode.rebaseBaseline', {
      ...params(), contentHash: documentContentHash(state.text),
    }, { link }),
    foreign: () => {
      state.version = 2
      state.isDirty = true
      state.text = 'foreign'
      observer({ file, version: 2, incarnation: 'i', changes: null })
    },
    judge: () => policy.judge({
      method: 'vscode.save', fileKey: file, version: state.version, incarnation: 'i',
      isDirty: state.isDirty, grantAllowsDirty: true, hasEvidenceSource: true,
    }),
  }
}

function matchesError(expected) {
  if (expected instanceof RegExp) return expected
  return (err) => {
    assert.equal(err.code, expected.code)
    for (const [key, value] of Object.entries(expected.data)) assert.equal(err.data?.[key], value)
    return true
  }
}

async function assertFailureClosed(env, expected) {
  try {
    await assert.rejects(env.save(), matchesError(expected))
  } finally {
    env.restorePath()
  }
  assert.equal(env.calls.save, 1, 'failure must reach the real save handler host call')
  assert.equal(env.calls.end, 1, 'every save exit must call endWrite exactly once')
  assert.equal(env.policy.inspect(file).inflight, 0, 'failed save must release inflight')
  assert.equal(env.policy.inspect(file).dirtyOwned, false, 'failed save must revoke unproven dirty ownership')
  // 不等外来事件：失败本身也不能把旧的人工脏基线继续当作已证明来源。
  env.state.isDirty = true
  assert.deepEqual(env.judge(), {
    allowed: false, reason: 'attribution-unknown', attribution: 'unknown',
  })
  env.foreign()
  assert.equal(env.policy.inspect(file).taint?.reason, 'foreign-change', 'v2 external event must be foreign-change, not inflight')
  assert.deepEqual(env.judge(), {
    allowed: false, reason: 'foreign-change', attribution: 'unknown',
  })
  await assert.rejects(env.save(), matchesError({ code: -32011, data: { reason: 'foreign-change' } }))
  assert.equal(env.calls.save, 1, 'fresh v2 anchors must not reach host again')
  assert.equal(env.calls.end, 1, 'pre-write refusal must not decrement inflight again')
}

for (const [failure, expected] of [
  ['false', { code: -32603, data: { reason: 'host-save-failed' } }],
  ['malformed', { code: -32009, data: { field: 'saved' } }],
  ['path', { code: -32603, data: { reason: 'path-changed-after-write' } }],
  ['identity', { code: -32603, data: { reason: 'document-identity-unavailable' } }],
]) {
  test(`T70 save ${failure}: exactly one endWrite, foreign v2 frozen, fresh-anchor retry denied`, async (t) => {
    const env = fixture(t, failure)
    env.seed()
    await assertFailureClosed(env, expected)
    if (failure === 'path') assert.equal(env.calls.pathFailure, 1, 'must fail in post-write path check')
  })
}

test('T70 V1 probe end-to-end: real rebaseBaseline + GrantStore + observer prevents second save', async (t) => {
  const env = fixture(t, 'false')
  assert.equal((await env.rebase()).ok, true)
  assert.equal(env.policy.inspect(file).dirtyOwned, true, 'real human confirmation adopted dirty x')
  assert.equal(env.policy.inspect(file).baselineContentHash, documentContentHash('x'))
  await assertFailureClosed(env, { code: -32603, data: { reason: 'host-save-failed' } })
  console.log('T70_V1 inflight=0 dirtyOwned=false; external v2 -> foreign-change; second save=-32011 hostCalls=1')
})

test('T70 save host throw also closes exactly once and revokes ownership', async (t) => {
  const env = fixture(t, 'throw')
  env.seed()
  await assertFailureClosed(env, /T70 injected host failure/)
})

test('T70 save post-stat failure also closes exactly once', async (t) => {
  const env = fixture(t, 'post-stat')
  env.seed()
  await assertFailureClosed(env, { code: -32603, data: { reason: 'disk-stat-unavailable' } })
})

test('T70 successful save closes exactly once without double-decrementing another inflight holder', async (t) => {
  const env = fixture(t, null)
  env.seed()
  // 独立持有者用于检测重复收尾：仅断言最终0会被 endWrite 的 Math.max 掩盖。
  env.policy.beginWrite(file, { method: 'test-holder' })
  assert.equal((await env.save()).saved, true)
  assert.equal(env.calls.end, 1)
  assert.equal(env.policy.inspect(file).inflight, 1, 'save must release only its own holder')
  env.policy.endWrite(file, { verdict: { attribution: 'unknown' } })
  assert.equal(env.policy.inspect(file).inflight, 0)
})
