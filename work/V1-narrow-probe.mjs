import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createCapabilities } from '../packages/dsh-kit-bridge/src/capabilities.js'
import { createWritePolicy } from '../packages/dsh-kit-bridge/src/document-write-policy.js'
import { GrantStore, documentContentHash } from '../packages/dsh-vscode-kit/src/grant.js'

// Existing path is used only by the real path guards. All document/disk IO is memory-only.
const root = fileURLToPath(new URL('../', import.meta.url))
const file = join(root, 'AGENTS.md')
async function rejected(fn) {
  try { await fn() } catch (error) { return error }
  assert.fail('expected rejection')
}
async function saveCase(mode) {
  const policy = createWritePolicy()
  const grants = new GrantStore()
  const grant = { id: 'c'.repeat(32), epoch: 'd'.repeat(32) }
  const link = { name: 'V1-narrow-independent' }
  grants.adopt({ ...grant, link, allowDirtySave: true })
  const doc = { version: 1, incarnation: 'narrow-i', isDirty: true, text: 'confirmed-x' }
  let observer, calls = 0, ends = 0, postPathThrows = 0, tripPath = false
  const end = policy.endWrite
  policy.endWrite = (...args) => { ends++; return end(...args) }
  const realpath = fs.realpathSync
  fs.realpathSync = (...args) => {
    if (tripPath) { postPathThrows++; throw new Error('V1 injected post-save path failure') }
    return realpath(...args)
  }
  const host = {
    workspaceRoots: () => [root], isTrusted: () => true,
    observeTextChanges: fn => { observer = fn; return { dispose() {} } },
    readDocumentState: async () => ({ ...doc, eol: 'lf', lineCount: 1,
      textLength: doc.text.length, byteLength: Buffer.byteLength(doc.text) }),
    readDiskStat: async () => ({ mtime: 13, size: 7 }),
    saveDocument: async target => {
      calls++
      if (mode === 'false') return { saved: false, documentPath: target }
      if (mode === 'nonboolean') return { saved: 'true', documentPath: target }
      if (mode === 'null') return null
      if (mode === 'missing') return {}
      if (mode === 'identity') return { saved: true, documentPath: null }
      if (mode === 'path') tripPath = true
      return { saved: true, documentPath: target }
    },
  }
  const caps = createCapabilities(host, { grants, writePolicy: policy })
  const params = () => ({ file, grant, expectedVersion: doc.version,
    expectedIncarnation: doc.incarnation, expectedDisk: { mtime: 13, size: 7 } })
  const dispatch = method => caps.dispatch(method, params(), { link })
  try {
    const rebase = await caps.dispatch('vscode.rebaseBaseline', {
      ...params(), contentHash: documentContentHash(doc.text),
    }, { link })
    assert.equal(rebase.ok, true)
    assert.equal(policy.inspect(file).dirtyOwned, true)
    assert.equal(policy.inspect(file).baselineContentHash, documentContentHash(doc.text))
    const first = await rejected(() => dispatch('vscode.save'))
    tripPath = false
    const expected = mode === 'false' ? [-32603, 'host-save-failed']
      : mode === 'identity' ? [-32603, 'document-identity-unavailable']
      : mode === 'path' ? [-32603, 'path-changed-after-write'] : [-32009, 'saved']
    assert.equal(first.code, expected[0])
    assert.equal(first.data?.reason ?? first.data?.field, expected[1])
    assert.equal(calls, 1)
    assert.equal(ends, 1)
    const failed = policy.inspect(file)
    assert.equal(failed.inflight, 0)
    assert.equal(failed.dirtyOwned, false)
    const beforeEvent = policy.judge({ method: 'vscode.save', fileKey: file,
      version: 1, incarnation: doc.incarnation, isDirty: true,
      grantAllowsDirty: true, hasEvidenceSource: true })
    assert.equal(beforeEvent.allowed, false)
    assert.equal(beforeEvent.reason, 'attribution-unknown')
    const inflightEventsBefore = policy.status().stats.inflightEvents
    doc.version = 2; doc.text = 'external-v2'; doc.isDirty = true
    observer({ file, version: 2, incarnation: doc.incarnation, changes: null })
    const foreign = policy.inspect(file)
    assert.equal(foreign.inflight, 0)
    assert.equal(foreign.windowEvents, 0)
    assert.equal(foreign.taint?.reason, 'foreign-change')
    assert.equal(policy.status().stats.inflightEvents, inflightEventsBefore)
    const second = await rejected(() => dispatch('vscode.save'))
    assert.equal(second.code, -32011)
    assert.equal(second.data?.reason, 'foreign-change')
    assert.equal(calls, 1)
    assert.equal(ends, 1)
    if (mode === 'path') assert.equal(postPathThrows, 1)
    console.log(`SAVE ${mode} first=${first.code}/${expected[1]} rebase=true endWrite=${ends} inflight=${failed.inflight} dirtyOwned=${failed.dirtyOwned} beforeEvent=${beforeEvent.reason} foreignV2=${foreign.taint.reason} inflightEventDelta=${policy.status().stats.inflightEvents - inflightEventsBefore} retry=${second.code} hostCalls=${calls} postPathThrows=${postPathThrows}`)
  } finally { fs.realpathSync = realpath }
}
for (const mode of ['false', 'nonboolean', 'identity', 'path', 'null', 'missing']) await saveCase(mode)

const A = 'D:/V1-narrow/A.txt'
const input = { method: 'vscode.deleteFile', fileKey: A, version: 1,
  incarnation: 'i', isDirty: false, hasEvidenceSource: true }
function pressure(p) {
  for (let i = 0; i < 600; i++) p.noteChange({ file: `D:/V1-narrow/other-${i}.txt`, version: 1, incarnation: 'j' })
}
const tainted = createWritePolicy() // deliberately no maxFiles override: production default 512
 tainted.markForeign(A)
assert.equal(tainted.judge(input).allowed, false)
pressure(tainted)
assert.equal(tainted.inspect(A).taint.reason, 'foreign-change')
assert.equal(tainted.judge(input).allowed, false)
assert.equal(tainted.judge(input).reason, 'foreign-change')
assert.ok(tainted.status().stats.evicted > 0)
console.log(`LRU default=512 taint pressure=600 evicted=${tainted.status().stats.evicted} allowed=${tainted.judge(input).allowed} reason=${tainted.judge(input).reason}`)
const active = createWritePolicy()
active.establishBaseline(A, { version: 1, incarnation: 'i', dirtyOwned: true })
active.beginWrite(A); active.beginWrite(A)
pressure(active)
assert.equal(active.inspect(A).inflight, 2)
assert.equal(active.noteChange({ file: A, version: 2, incarnation: 'i' }).classified, 'inflight')
assert.equal(active.endWrite(A, { verdict: { attribution: 'unknown' } }).inflight, 1)
active.endWrite(A, { verdict: { attribution: 'unknown' } })
assert.equal(active.inspect(A).inflight, 0)
assert.equal(active.inspect(A).dirtyOwned, false)
assert.equal(active.noteChange({ file: A, version: 3, incarnation: 'i' }).classified, 'foreign')
assert.equal(active.judge({ ...input, version: 3 }).allowed, false)
console.log(`LRU default=512 inflight pressure=600 evicted=${active.status().stats.evicted} holders=2->1->0 v2=inflight v3=foreign allowed=false`)
const protectedOnly = createWritePolicy()
for (let i = 0; i < 600; i++) protectedOnly.markForeign(`D:/V1-narrow/frozen-${i}.txt`)
let retained = 0
for (let i = 0; i < 600; i++) {
  const fileKey = `D:/V1-narrow/frozen-${i}.txt`
  assert.equal(protectedOnly.inspect(fileKey)?.taint.reason, 'foreign-change')
  assert.equal(protectedOnly.judge({ ...input, fileKey }).allowed, false)
  retained++
}
protectedOnly.beginWrite(A)
assert.equal(protectedOnly.inspect(A)?.inflight, 1)
protectedOnly.endWrite(A, { verdict: { attribution: 'unknown' } })
assert.equal(protectedOnly.inspect(A).inflight, 0)
console.log(`LRU default=512 allProtected=${retained}/600 newHolder=1->0 evicted=${protectedOnly.status().stats.evicted}`)
console.log('PASS independent save cases=6 LRU cases=3; no real document/disk writes')
