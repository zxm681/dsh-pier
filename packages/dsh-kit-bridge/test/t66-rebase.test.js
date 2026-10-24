/**
 * T65：`vscode.rebaseBaseline` —— 脏缓冲的**人工交接**通道（契约 §4.7 / §6.2）。
 *
 * 背景：`document-write-policy.judge()` 的 ① 把"有 taint 且缓冲区脏"判成 `-32011`，
 * 而 `establishBaseline()` 此前**全仓零生产调用点** —— 于是脏缓冲一旦被冻结就永远解不开，
 * v2 里"人工交接后重建基线"那句话没有落地。这条控制面就是把那根线接上，代价是
 * 它必须比"随手调一次"严得多：
 *
 *  - **四元确认**：`version` / `incarnation` / `contentHash` 三个都必须与**当前实测**一致
 *    （调用方手里那份"我以为文档长这样"不算证据）；
 *  - **同门**：它挂在 `WRITE_METHODS` 上，所以 `-32010` 那道凭证门照走；
 *  - **不写盘**：它只改内存里的基线，磁盘一个字节都不许动。
 *
 * 变异测试（铁律 9）针对本文件的 ★ 用例：
 *  - 把四元任一比对删掉 → "② 任一不符" 变红；
 *  - 删掉 `grantGate(...)` 复核 → "③ 换一个 grant" 变红；
 *  - `establishBaseline` 不传 `dirtyOwned: true` → "① 四元全对随后写放行" 变红
 *    （判序 ⑥ `attribution-unknown`）；
 *  - 让 rebase 顺手写一次盘 → "① ... 不写盘" 变红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore, documentContentHash } from '../../dsh-vscode-kit/src/grant.js'
import { pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'
import { createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架：真文件系统 + 假宿主（只实现这条控制面 + applyEdit 需要的口）
// ---------------------------------------------------------------------------

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)
const ID_B = 'c'.repeat(32)
const EPOCH_B = 'd'.repeat(32)

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-t66-rebase-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'hello world\nsecond line\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 假宿主。`dirty` / `version` / `incarnation` 是**可改的实测事实**：
 * 用例靠它们模拟"人改了缓冲区"（`setDirty`）和"关掉重开"（`setVersion` + `setIncarnation`）。
 */
function makeHost(roots, { trusted = true, dirty = false, version = 9, incarnation = 'inc-1' } = {}) {
  const calls = []
  const state = { dirty, version, incarnation }
  return {
    calls,
    state,
    setDirty: (v) => { state.dirty = v },
    setVersion: (v) => { state.version = v },
    setIncarnation: (s) => { state.incarnation = s },
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(roots[0], p)),
    workspaceRoots: () => roots.slice(),
    // 同源观察器已安装（否则 judge 的 ② observation-gap 会先短路，测不到 taint）。
    observeTextChanges: () => ({ dispose() {} }),
    isTrusted: () => trusted,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    readDocumentState: async (abs, { includeText = false } = {}) => {
      const text = readFileSync(abs, 'utf8')
      return {
        version: state.version,
        incarnation: state.incarnation,
        isDirty: state.dirty,
        eol: text.includes('\r\n') ? 'crlf' : 'lf',
        lineCount: text.split('\n').length,
        textLength: text.length,
        byteLength: Buffer.byteLength(text, 'utf8'),
        ...(includeText === true ? { text } : {}),
      }
    },
    readRangeText: async () => 'hello',
    readDocumentShape: async (abs, lines = []) => ({ lineCount: 2, lineLengths: lines.map(() => 11) }),
    applyEditText: async (abs, range, text) => {
      calls.push({ abs, range, text })
      return { applied: true, documentPath: abs }
    },
    log: () => {},
  }
}

/** 授权表：A 绑在 `linkA`（`allowDirtySave` 打开 —— ⑤ 那道门还要它），B 绑在 `linkB`。 */
function rebaseEnv({ root, trusted = true, dirty = true, version = 9, incarnation = 'inc-1' } = {}) {
  const linkA = { name: 'link-a' }
  const linkB = { name: 'link-b' }
  const grants = new GrantStore()
  grants.adopt({ id: ID_A, epoch: EPOCH_A, link: linkA, allowDirtySave: true })
  grants.adopt({ id: ID_B, epoch: EPOCH_B, link: linkB })
  const host = makeHost([root], { trusted, dirty, version, incarnation })
  const caps = createCapabilities(host, { grants })
  return { grants, host, caps, linkA, linkB, file: join(root, 'a.js') }
}

const GRANT_A = { id: ID_A, epoch: EPOCH_A }

/** 当前实测四元（测试自己算一遍，好让"全对"与"差一个"都写得明白）。 */
function measured(host, file) {
  const text = readFileSync(file, 'utf8')
  return {
    version: host.state.version,
    incarnation: host.state.incarnation,
    contentHash: documentContentHash(text),
  }
}

function rebaseParams(file, extra = {}) {
  // 线上口径：`expectedVersion` / `expectedIncarnation` 是写类方法无条件必填的锚点字段。
  const base = {
    file,
    expectedVersion: 9,
    expectedIncarnation: 'inc-1',
    contentHash: documentContentHash('hello world\nsecond line\n'),
    grant: GRANT_A,
  }
  return { ...base, ...extra }
}

function editParams(file, extra = {}) {
  return {
    file,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    text: 'HELLO',
    expectedVersion: 9,
    expectedIncarnation: 'inc-1',
    grant: GRANT_A,
    ...extra,
  }
}

async function expectCode(promise, code, label) {
  try {
    await promise
  } catch (err) {
    assert.equal(err.code, code, `${label}: expected ${code}, got ${err.code} (${err.message})`)
    return err
  }
  assert.fail(`${label}: expected ${code}, but the call succeeded`)
}

/** 把这份文档冻成"脏 + 来源不明"——就是真机上 `-32011` 的样子。 */
function freeze(caps, file) {
  const key = pathIdentityKey(file)
  caps.writePolicy.markForeign(key, { version: 9, incarnation: 'inc-1' })
  return key
}

// ---------------------------------------------------------------------------
// ① 四元全对 → 清基线，随后写放行（且 rebase 自己不写盘）
// ---------------------------------------------------------------------------

test('★ T65① 四元全对 → 清基线，随后写放行；rebase 本身不写盘', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root })
    const key = freeze(caps, file)
    const before = readFileSync(file, 'utf8')

    // 冻结态先坐实：脏缓冲 + taint ⇒ -32011（否则后面的"放行"没有对照）。
    const frozen = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file), { link: linkA }),
      ERR.DOCUMENT_DIRTY, 'frozen: applyEdit',
    )
    assert.equal(frozen.data.reason, 'foreign-change')
    assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change')

    const m = measured(host, file)
    const res = await caps.dispatch('vscode.rebaseBaseline', rebaseParams(file, {
      expectedVersion: m.version,
      expectedIncarnation: m.incarnation,
      contentHash: m.contentHash,
    }), { link: linkA })

    assert.equal(res.ok, true)
    assert.equal(res.file, file)
    assert.equal(res.version, m.version)
    assert.equal(res.incarnation, m.incarnation)
    assert.equal('applied' in res, false, 'rebase 没有"已应用"这种语义')
    assert.equal('saved' in res, false, 'rebase 不写盘')
    assert.equal('quarantined' in res, false)

    // 不写盘：磁盘字节没变、宿主一次编辑都没收到。
    assert.equal(readFileSync(file, 'utf8'), before, '★ rebase 不许动磁盘')
    assert.equal(host.calls.length, 0, '★ rebase 不许借道 applyEdit')

    // 基线换了，taint 清了，脏内容被"人工确认"成这份。
    const after = caps.writePolicy.inspect(key)
    assert.equal(after.taint, null, 'taint 必须清掉')
    assert.equal(after.dirtyOwned, true, '四元确认过的脏内容归桥接自己管，否则 ⑥ 永远拒')
    assert.equal(after.baselineVersion, m.version)
    assert.equal(after.baselineIncarnation, m.incarnation)
    assert.equal(after.baselineContentHash, m.contentHash, '基线要记住"人工确认的是哪一份内容"')

    // 放行：同一发写现在过了。
    const ok = await caps.dispatch('vscode.applyEdit', editParams(file), { link: linkA })
    assert.equal(ok.applied, true, '清完基线，写就得放行（这才是 rebase 的意义）')
    assert.equal(host.calls.length, 1)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ② 任一不符 → 拒且 taint 保留（写仍 -32011）
// ---------------------------------------------------------------------------

test('★ T65② 四元任一不符 → -32602 rebase-anchor-mismatch，taint 保留、写仍 -32011', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root })
    const key = freeze(caps, file)
    const m = measured(host, file)

    const stale = [
      ['version', { expectedVersion: m.version + 1 }],
      ['incarnation', { expectedIncarnation: 'inc-other' }],
      ['contentHash', { contentHash: documentContentHash('something else\n') }],
    ]
    for (const [label, patch] of stale) {
      const err = await expectCode(caps.dispatch('vscode.rebaseBaseline', rebaseParams(file, {
        expectedVersion: m.version,
        expectedIncarnation: m.incarnation,
        contentHash: m.contentHash,
        ...patch,
      }), { link: linkA }), ERR.INVALID_PARAMS, `mismatch ${label}`)
      assert.equal(err.data.reason, 'rebase-anchor-mismatch', `${label}: 要拒得有名有姓`)
      assert.deepEqual(err.data.mismatch, [label], `${label}: 差了哪个字段要写在错误里`)
      assert.equal(err.data.taintKept, true, `${label}: taint 必须保留`)
      assert.equal(err.data.actual.version, m.version, '把实测值交回去，调用方不必再读一遍')
      assert.equal(err.data.actual.incarnation, m.incarnation)
      assert.equal(err.data.actual.contentHash, m.contentHash)
      assert.equal(err.data.retryable, false)

      // 拒了就是拒了：taint 一点没动，写还是 -32011。
      assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change', `${label}: 不许顺手清 taint`)
      const still = await expectCode(
        caps.dispatch('vscode.applyEdit', editParams(file), { link: linkA }),
        ERR.DOCUMENT_DIRTY, `${label}: applyEdit`,
      )
      assert.equal(still.data.reason, 'foreign-change')
    }
    assert.equal(host.calls.length, 0, '三次被拒都不许落一次编辑')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ③ 换一个 grant 调 rebase → 拒
// ---------------------------------------------------------------------------

test('★ T65③ 换一个 grant 调 rebase → -32010，且 taint 保留', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root })
    const key = freeze(caps, file)
    const m = measured(host, file)
    const good = rebaseParams(file, {
      expectedVersion: m.version,
      expectedIncarnation: m.incarnation,
      contentHash: m.contentHash,
    })

    // B 的凭证是**真的**（有效 id/epoch），只是绑在另一条连接上。
    const foreign = await expectCode(
      caps.dispatch('vscode.rebaseBaseline', { ...good, grant: { id: ID_B, epoch: EPOCH_B } }, { link: linkA }),
      ERR.EDIT_NOT_BOUND, 'foreign grant',
    )
    assert.equal(foreign.data.row, 6, '凭证属于另一条连接 = 七行表的第 6 行')
    assert.equal(foreign.data.missing, undefined, '名正言顺的凭证不该被标成 missing')

    // 编造的凭证、撤销的凭证，各有一条自己的拒法。
    const bogus = await expectCode(
      caps.dispatch('vscode.rebaseBaseline', { ...good, grant: { id: 'f'.repeat(32), epoch: EPOCH_A } }, { link: linkA }),
      ERR.EDIT_NOT_BOUND, 'bogus grant',
    )
    assert.equal(bogus.data.missing, undefined)

    assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change', '越权调用不许动基线')
    assert.equal(host.calls.length, 0)

    // 对照：换成 A 的凭证就通 —— 拒的是"换了凭证"，不是"rebase 不能用"。
    const ok = await caps.dispatch('vscode.rebaseBaseline', good, { link: linkA })
    assert.equal(ok.ok, true)
    assert.equal(caps.writePolicy.inspect(key).taint, null)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ④ 缓冲区自己变脏不能代替 rebase
// ---------------------------------------------------------------------------

test('★ T65④ isDirty 转 true 不能代替 rebase：不调就是不给写', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root, dirty: false })
    const key = freeze(caps, file)

    // 干净缓冲本来不受 taint 管（T62 修订），所以先用"变脏"把 ① 那条门撞开。
    host.setDirty(true)
    const dirty = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file), { link: linkA }),
      ERR.DOCUMENT_DIRTY, 'dirty without rebase',
    )
    assert.equal(dirty.data.reason, 'foreign-change', '★ 光变脏不解冻结：rebase 才是那条通道')
    assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change')
    assert.equal(caps.writePolicy.inspect(key).dirtyOwned, false)
    assert.equal(host.calls.length, 0)

    // 同一份"脏"事实，走一次四元确认就放行 —— 说明拒的确实是"没确认"，不是"脏"。
    const m = measured(host, file)
    await caps.dispatch('vscode.rebaseBaseline', rebaseParams(file, {
      expectedVersion: m.version,
      expectedIncarnation: m.incarnation,
      contentHash: m.contentHash,
    }), { link: linkA })
    const ok = await caps.dispatch('vscode.applyEdit', editParams(file), { link: linkA })
    assert.equal(ok.applied, true)
    assert.equal(host.calls.length, 1)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ⑤ 关掉重开（version 归 1、incarnation 变）不能代替 rebase
// ---------------------------------------------------------------------------

test('★ T65⑤ 关重开不能代替 rebase：旧 taint 跨实例保留，四元得按新实例重报', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root })
    const key = freeze(caps, file)
    const old = measured(host, file)

    // 关掉重开：version 归 1、incarnation 换新的（VS Code 里就是这两件事一起发生）。
    host.setVersion(1)
    host.setIncarnation('inc-reopened')
    assert.notEqual(host.state.incarnation, old.incarnation)

    const reopenParams = editParams(file, { expectedVersion: 1, expectedIncarnation: 'inc-reopened' })
    const still = await expectCode(
      caps.dispatch('vscode.applyEdit', reopenParams, { link: linkA }),
      ERR.DOCUMENT_DIRTY, 'after reopen: applyEdit',
    )
    assert.equal(still.data.reason, 'foreign-change', '★ 重开不能把冻结抹掉（冻结来自"来源不明"，不是实例号）')
    assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change')

    // 拿旧实例的四元来确认也不通：version 与 incarnation 都不符，等于没确认。
    const staleErr = await expectCode(caps.dispatch('vscode.rebaseBaseline', rebaseParams(file, {
      expectedVersion: old.version,
      expectedIncarnation: old.incarnation,
      contentHash: old.contentHash,
    }), { link: linkA }), ERR.INVALID_PARAMS, 'old anchors after reopen')
    assert.equal(staleErr.data.reason, 'rebase-anchor-mismatch')
    assert.deepEqual(staleErr.data.mismatch.slice().sort(), ['incarnation', 'version'])

    // 按**新**实例的四元确认 → 才放行。
    const fresh = measured(host, file)
    const res = await caps.dispatch('vscode.rebaseBaseline', rebaseParams(file, {
      expectedVersion: fresh.version,
      expectedIncarnation: fresh.incarnation,
      contentHash: fresh.contentHash,
    }), { link: linkA })
    assert.equal(res.ok, true)
    assert.equal(res.version, 1)
    assert.equal(res.incarnation, 'inc-reopened')
    const ok = await caps.dispatch('vscode.applyEdit', reopenParams, { link: linkA })
    assert.equal(ok.applied, true, '人工交接之后才恢复可写')
    assert.equal(host.calls.length, 1)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// 补充：这条控制面自己的门（信任 / 形状 / 交不出整份内容就别确认）
// ---------------------------------------------------------------------------

test('★ T65 rebase：不可信来源 → -32006；没法算 contentHash → -32602 且 taint 保留', async () => {
  const ws = tempWorkspace()
  try {
    const untrusted = rebaseEnv({ root: ws.root, trusted: false })
    await expectCode(
      untrusted.caps.dispatch('vscode.rebaseBaseline', rebaseParams(untrusted.file), { link: untrusted.linkA }),
      ERR.UNTRUSTED_WORKSPACE, 'untrusted',
    )

    // 交不出整份文本（这里用"文件在 rebase 前被读成超限"的等价形态：readDocumentState 不回 text）
    const { caps, host, linkA, file } = rebaseEnv({ root: ws.root })
    const key = freeze(caps, file)
    const original = caps.handlers['vscode.getDocumentState']
    assert.equal(typeof original, 'function')
    host.readDocumentState = async () => ({
      version: 9, incarnation: 'inc-1', isDirty: true, eol: 'lf', lineCount: 2,
      textLength: 24, byteLength: 24, // 故意不回 text
    })
    const err = await expectCode(
      caps.dispatch('vscode.rebaseBaseline', rebaseParams(file), { link: linkA }),
      ERR.INVALID_PARAMS, 'no text',
    )
    assert.equal(err.data.reason, 'content-hash-unavailable')
    assert.equal(err.data.taintKept, true)
    assert.equal(caps.writePolicy.inspect(key).taint.reason, 'foreign-change', '算不出指纹就不许放行')
  } finally { ws.dispose() }
})
