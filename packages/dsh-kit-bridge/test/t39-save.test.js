/**
 * `vscode.save`（T39 / 契约 §6.2.1 Tier 3）—— 能力层测试。
 *
 * 这个文件守的是「**落盘之前**能拦住多少」以及「**落了盘之后**说真话」：
 *
 *  ★① 磁盘锚点不符 → `-32013`，且宿主**零次** `saveDocument`（用调用计数证明，
 *     不是看返回值猜）。
 *  ★② 缓冲区脏、grant 上没有 `allowDirtySave` → `-32012 reason:'buffer-dirty'`，
 *     零落盘。**`params.allowDirtySave:true` 也救不了**（同文件里有一条专门打这个）。
 *  ★③ grant 带 `allowDirtySave` → 脏缓冲区能保存；返回体的 `disk` 是**保存后重新
 *     stat 的真值**，假宿主在保存时把 mtime/size 改了，所以「回显参数」的实现在这条
 *     上必然红。
 *
 * 反向（"测试在睡觉"）由铁律 9 的变异测试证明：把 `assertDiskMatches` 改成恒通过，
 * ★① 必须变红（原始失败输出见交付说明）。
 *
 * 脚手架与 `apply-edit.test.js` 同构（真临时目录 + 假宿主 + 假授权表），
 * 但假宿主多两样落盘专用的注入面：`readDiskStat` 与 `saveDocument`。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { pathIdentityKey } from '../../dsh-vscode-kit/src/paths.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { validateResponse } from '../../dsh-vscode-kit/src/response-contract.js'
import { CAPABILITIES, createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)
const DEFAULT_VERSION = 1
const DEFAULT_INCARNATION = 'inc-default'

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-save-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'hello world\nsecond line\n')
  writeFileSync(join(base, 'secret.js'), 'outside\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 假宿主。磁盘状态是一张**可变**的表（`setDisk(abs, {mtime,size})`），
 * 因为本文件要验"锚点对不上"和"保存后真值"，两者都要求磁盘可被改。
 */
function makeHost(roots, {
  trusted = true,
  version = DEFAULT_VERSION,
  incarnation = DEFAULT_INCARNATION,
  isDirty = false,
  untitled = false,
  saveResult = true,
  onSave,
} = {}) {
  const calls = { readDocumentState: 0, readDiskStat: 0, save: 0 }
  const disk = new Map()
  const state = { version, incarnation, isDirty, untitled }
  const host = {
    calls,
    disk,
    state,
    setDisk: (abs, value) => { disk.set(abs, value) },
    setVersion: (v) => { state.version = v },
    setIncarnation: (s) => { state.incarnation = s },
    setDirty: (v) => { state.isDirty = v },
    /** 保存时"磁盘发生了变化"：模拟 mtime/size 真的被写新。 */
    onSave,
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(roots[0], p)),
    workspaceRoots: () => roots.slice(),
    // A2（T62）：本桥接**没有同源变更观察器就不许写**（observation-gap）。这些用假宿主
    // 的用例关心的是别的东西（编辑语义 / 锚点 / 删除），所以给一个"什么都不发生"的真实
    // 观察器：宿主确实实现了这个口，只是这个假宿主永远不报变更。
    observeTextChanges: () => ({ dispose() {} }),
    isTrusted: () => trusted,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    readDocumentShape: async (abs, lines = []) => {
      const linesInFile = readFileSync(abs, 'utf8').split(/\r?\n/)
      return {
        lineCount: linesInFile.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= linesInFile.length
          ? linesInFile[n - 1].length
          : null)),
      }
    },
    readDocumentState: async (abs) => {
      calls.readDocumentState += 1
      const text = readFileSync(abs, 'utf8')
      return {
        version: state.version,
        incarnation: state.incarnation,
        isDirty: state.isDirty,
        eol: 'lf',
        lineCount: text.split('\n').length,
        textLength: text.length,
        byteLength: Buffer.byteLength(text, 'utf8'),
        untitled: state.untitled,
      }
    },
    // T39：磁盘真值源。null = 此刻 stat 不到（文件被删/被锁）。
    readDiskStat: async (abs) => {
      calls.readDiskStat += 1
      return disk.has(abs) ? disk.get(abs) : null
    },
    // T39：落盘点。默认模拟"保存把磁盘写新了"，返回值与真适配器同形。
    saveDocument: async (target, anchors = {}) => {
      calls.save += 1
      if (onSave) onSave({ target, anchors, disk, state })
      const abs = typeof target === 'string' ? target : target.abs
      if (typeof saveResult === 'string') {
        // 非布尔：模拟宿主适配器违约（能力层必须判 -32009，不许当成功形状猜）。
        return { saved: saveResult, documentPath: abs }
      }
      return {
        saved: saveResult,
        documentPath: abs,
        version: state.version + 1,
        incarnation: state.incarnation,
      }
    },
    log: () => {},
  }
  return host
}

/** 一张"与磁盘此刻一致"的锚点（默认从真文件取，保证不冲突）。 */
function diskAnchorOf(abs) {
  const st = statSync(abs)
  return { mtime: Math.floor(st.mtimeMs), size: st.size }
}

function grantedEnv({
  root, link = { name: 'link-a' }, allowDirtySave = false, ...hostOpts
} = {}) {
  const grants = new GrantStore()
  grants.adopt({ id: ID_A, epoch: EPOCH_A, link, allowDirtySave })
  const host = makeHost([root], hostOpts)
  const caps = createCapabilities(host, { grants })
  const file = join(root, 'a.js')
  // 磁盘锚点的默认值 = 真实 stat，用例想造冲突自己覆盖。
  host.setDisk(file, diskAnchorOf(file))
  return { grants, host, caps, link, file }
}

/** 入口参数：双锚点 + 磁盘锚点全给，`grant` 指向上面的授权记录。 */
function saveParams(file, host, extra = {}) {
  return {
    file,
    expectedVersion: DEFAULT_VERSION,
    expectedIncarnation: DEFAULT_INCARNATION,
    expectedDisk: host.disk.get(file),
    grant: { id: ID_A, epoch: EPOCH_A },
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

// ─────────────────────────────────────────────────────────────────────────────
// ★ 三条主用例
// ─────────────────────────────────────────────────────────────────────────────

test('★ T39 ① 磁盘锚点不符 → -32013，宿主零次 saveDocument（不是"保存失败"，是"根本没保存"）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    // 磁盘在读取锚点之后被外部改过：mtime + 1 秒、size + 7。
    const stale = { mtime: host.disk.get(file).mtime + 1000, size: host.disk.get(file).size + 7 }
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host, { expectedDisk: stale }), { link }),
      ERR.DISK_STATE_CONFLICT,
      '过期磁盘锚点',
    )
    assert.equal(err.data?.method, 'vscode.save')
    assert.equal(err.data?.file, file, 'data.file 是规范化绝对路径')
    assert.deepEqual(err.data?.expected, stale, 'data.expected 原样回传调用方的锚点')
    assert.deepEqual(err.data?.actual, host.disk.get(file), 'data.actual 是保存前这次 stat 的真值')
    assert.equal(err.data?.retryable, undefined, '不标 retryable 的 true：磁盘冲突永不自动重试')
    // ★ 关键：一个字都没写。用调用计数证明（回显式实现会在这里就落盘再报错）。
    assert.equal(host.calls.save, 0, '磁盘锚点不符时宿主 saveDocument 必须零调用')
    assert.equal(readFileSync(file, 'utf8'), 'hello world\nsecond line\n', '磁盘内容必须原样')
  } finally {
    ws.dispose()
  }
})

test('★ T62 ② 缓冲区脏且 grant 无 dirty 授权 → -32011 dirty-quarantine（params 里的位不算授权）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, isDirty: true })
    const params = saveParams(file, host, {
      // ★ v2：这个参数**已经不存在**。调用方塞进来只是为了让下面证明"它一点用都没有"。
      allowDirtySave: true,
    })
    const err = await expectCode(
      caps.dispatch('vscode.save', params, { link }),
      ERR.DOCUMENT_DIRTY,
      '脏缓冲区 + grant 无 dirty 授权',
    )
    // ★ 语义变更（v1→v2，报告里逐条列出）：脏缓冲的拒绝从 `-32012 reason:buffer-dirty`
    //   改成本码。`-32012` 的处置是"重读锚点重发"，而"缓冲里有别人的字"重发多少次都还在。
    assert.equal(err.data?.reason, 'dirty-quarantine')
    assert.equal(err.data?.method, 'vscode.save')
    assert.equal(err.data?.isDirty, true)
    assert.equal(err.data?.retryable, false, '这不是可以自动重试的失败')
    assert.equal(err.data?.mayHaveApplied, false, '还没碰宿主')
    assert.equal(err.data?.recovery, 'human-rebase')
    // 旧参数**不生效**：既不放行，也不再出现在诊断字段里（不是"忽略但记一笔许可"）。
    assert.equal(err.data?.allowDirtySave, undefined, 'v2 不再有这个名字')
    assert.equal(host.calls.save, 0, '门拒绝时不得落盘')
    assert.equal(readFileSync(file, 'utf8'), 'hello world\nsecond line\n')
  } finally {
    ws.dispose()
  }
})

test('★ T62 ③ 脏的**是自己写的**（bridge-correlated）+ grant 授权 → 能保存；disk 是保存后重新 stat 的真值', async () => {
  const ws = tempWorkspace()
  try {
    // 保存时磁盘被写新（mtime +1234、size 变大）—— 回显 expectedDisk 的实现必红。
    const AFTER = { mtime: 1_700_000_000_123, size: 4242 }
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      isDirty: true,
      allowDirtySave: true,
      onSave: ({ disk, state }) => {
        disk.set(file, AFTER)
        state.isDirty = false
      },
    })
    // 造出"这份脏是桥接自己写的"证据：走生产同一条路（写入窗口 + 归属结论）。
    // A1 的账本会在真实 `vscode.applyEdit` 之后给出 `bridge-correlated`，
    // 这里直接把同一条结论交给同一扇门 —— 门本身没有第二条入口。
    const key = pathIdentityKey(file)
    caps.writePolicy.beginWrite(key, { method: 'vscode.applyEdit' })
    caps.writePolicy.endWrite(key, {
      verdict: { attribution: 'bridge-correlated', after: { version: host.state.version, incarnation: host.state.incarnation, dirty: true } },
    })
    const before = host.disk.get(file)
    const res = await caps.dispatch('vscode.save', saveParams(file, host), { link })

    assert.equal(res.saved, true)
    assert.equal(res.file, file)
    assert.equal(res.dirtyBefore, true, '保存前缓冲区是脏的（这正是"自己写的脏"那条许可）')
    assert.deepEqual(res.disk, AFTER, '★ disk 必须是保存后重新 stat 的真值，不是回显 expectedDisk')
    assert.notDeepEqual(res.disk, before, '假宿主在保存时改了磁盘，回显参数会回到 before')
    assert.equal(res.dirtyAfter, false, '保存后缓冲区干净')
    assert.equal(host.calls.save, 1)
    // 返回体同时要过 kit 侧的响应校验（同一份形状，两侧各判一次）。
    assert.doesNotThrow(() => validateResponse('vscode.save', res))
  } finally {
    ws.dispose()
  }
})

test('★ T62 ③b 脏的**不是自己写的**（哪怕 grant 授权了）→ 仍然 -32011，一个字节都不落盘', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({
      root: ws.root, isDirty: true, allowDirtySave: true,
    })
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.DOCUMENT_DIRTY,
      '脏且归属不明',
    )
    // 授权表里那条 allowDirtySave 只回答"允许在脏缓冲上写吗"，回答不了
    // "这份脏是谁写的"。后者没有证据 ⇒ 失败闭合（首版无逃逸口）。
    assert.equal(err.data?.reason, 'attribution-unknown')
    assert.equal(err.data?.attribution, 'unknown')
    assert.equal(host.calls.save, 0)
    assert.equal(readFileSync(file, 'utf8'), 'hello world\nsecond line\n')
  } finally {
    ws.dispose()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 其余失败态：每一条都要求"宿主零调用"或"如实报告"
// ─────────────────────────────────────────────────────────────────────────────

test('磁盘锚点缺失/形状坏 → -32602，宿主零调用（本地形状门先短路）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    for (const [expectedDisk, reason] of [
      [undefined, 'expected-disk-missing'],
      [null, 'expected-disk-not-an-object'],
      ['x', 'expected-disk-not-an-object'],
      [{ mtime: 1 }, 'expected-disk-size-not-a-number'],
      [{ mtime: 1.5, size: 1 }, 'expected-disk-mtime-not-a-non-negative-integer'],
      [{ mtime: 1, size: -1 }, 'expected-disk-size-not-a-non-negative-integer'],
    ]) {
      const err = await expectCode(
        caps.dispatch('vscode.save', saveParams(file, host, { expectedDisk }), { link }),
        ERR.INVALID_PARAMS,
        `expectedDisk=${JSON.stringify(expectedDisk)}`,
      )
      assert.equal(err.data?.reason, reason)
    }
    assert.equal(host.calls.readDocumentState, 0, '形状门在一切宿主往返之前')
    assert.equal(host.calls.save, 0)
  } finally {
    ws.dispose()
  }
})

test('双锚点必填：版本/化身缺失或错值 → -32602 / -32012，且零落盘', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const missing = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host, { expectedVersion: undefined }), { link }),
      ERR.INVALID_PARAMS, '缺 expectedVersion',
    )
    assert.equal(missing.data?.reason, 'expected-version-missing')
    const noInc = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host, { expectedIncarnation: '' }), { link }),
      ERR.INVALID_PARAMS, '空 expectedIncarnation',
    )
    assert.equal(noInc.data?.reason, 'expected-incarnation-not-a-non-empty-string')
    const staleVersion = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host, { expectedVersion: 2 }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '版本不符',
    )
    assert.equal(staleVersion.data?.reason, undefined, '版本冲突沿用 applyEdit 的形状（data.expected/actual）')
    assert.deepEqual([staleVersion.data?.expected, staleVersion.data?.actual], [2, DEFAULT_VERSION])
    host.setIncarnation('inc-other') // 版本仍对、实例换了 → 只该栽在化身上
    const staleInc = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '化身不符',
    )
    assert.equal(staleInc.data?.reason, 'incarnation-mismatch')
    assert.equal(host.calls.save, 0, '三种锚点问题都必须在落盘之前')
  } finally {
    ws.dispose()
  }
})

test('无 grant / 撤销后 / 未信任 → -32010 或 -32006，零落盘', async () => {
  const ws = tempWorkspace()
  try {
    const { grants, host, caps, link, file } = grantedEnv({ root: ws.root })
    const noGrant = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host, { grant: undefined }), { link }),
      ERR.EDIT_NOT_BOUND, '无 grant',
    )
    assert.equal(noGrant.data?.reason, 'no-grant')

    // 执行前复核（区别于 dispatch 入口的那道门）：授权在能力层内部被吊销。
    grants.revoke(ID_A, 'revoked')
    const revoked = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.EDIT_NOT_BOUND, '撤销后',
    )
    assert.equal(revoked.data?.reason, 'grant-revoked')
    assert.equal(host.calls.save, 0)

    // 未信任：`assertTrusted` 的既有形状只带 method（不新造 reason 字段）。
    const untrusted = grantedEnv({ root: ws.root, trusted: false })
    const err = await expectCode(
      untrusted.caps.dispatch('vscode.save', saveParams(file, untrusted.host), { link }),
      ERR.UNTRUSTED_WORKSPACE, '未信任工作区',
    )
    assert.equal(err.data?.method, 'vscode.save')
    assert.equal(untrusted.host.calls.save, 0)
  } finally {
    ws.dispose()
  }
})

test('untitled 文档 → -32602 reason:untitled-document，零落盘', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, untitled: true })
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.INVALID_PARAMS, 'untitled',
    )
    assert.equal(err.data?.reason, 'untitled-document')
    assert.equal(host.calls.save, 0)
  } finally {
    ws.dispose()
  }
})

test('宿主 save() 解析 false → -32603 host-save-failed（saved 谓词只许 true）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, saveResult: false })
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.INTERNAL, 'save() === false',
    )
    assert.equal(err.data?.reason, 'host-save-failed')
    assert.equal(err.data?.mayHaveApplied, false, 'false 明确表示没写下去')
    assert.equal(host.calls.save, 1, '确实调用了宿主（失败来自落盘点本身）')
  } finally {
    ws.dispose()
  }
})

test('宿主 save() 返回非布尔 → -32009（成功外形的错误结果，不许猜成成功）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, saveResult: 'true' })
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.INVALID_RESPONSE, 'save() 返回字符串',
    )
    assert.equal(err.data?.field, 'saved')
  } finally {
    ws.dispose()
  }
})

test('磁盘 stat 拿不到 → -32013（actual:null）；保存后 stat 拿不到 → -32603 disk-stat-unavailable', async () => {
  const ws = tempWorkspace()
  try {
    const gone = grantedEnv({ root: ws.root })
    const wishedFor = { ...gone.host.disk.get(gone.file) } // 锚点必须给（形状门先判）
    gone.host.disk.delete(gone.file)
    const err = await expectCode(
      gone.caps.dispatch('vscode.save',
        saveParams(gone.file, gone.host, { expectedDisk: wishedFor }), { link: gone.link }),
      ERR.DISK_STATE_CONFLICT, '磁盘文件在保存前消失',
    )
    assert.equal(err.data?.actual, null, 'actual:null 是"文件已不在"，不是"没检查"')
    assert.equal(gone.host.calls.save, 0)

    const vanished = grantedEnv({
      root: ws.root,
      onSave: ({ disk }) => { disk.clear() },
    })
    const unavailable = await expectCode(
      vanished.caps.dispatch('vscode.save', saveParams(vanished.file, vanished.host), { link: vanished.link }),
      ERR.INTERNAL, '保存后 stat 不到',
    )
    assert.equal(unavailable.data?.reason, 'disk-stat-unavailable')
    assert.equal(unavailable.data?.mayHaveApplied, true, '已经调过 save()，不许说"没写"')
  } finally {
    ws.dispose()
  }
})

test('路径越界 → -32602；能力清单与 handler 表都登记了 vscode.save', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const outside = join(ws.base, 'secret.js')
    host.setDisk(outside, { mtime: 1, size: 1 })
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(outside, host), { link }),
      ERR.INVALID_PARAMS, '工作区外',
    )
    assert.equal(err.data?.reason, 'outside-workspace')
    assert.equal(host.calls.save, 0)

    assert.ok(CAPABILITIES.includes('vscode.save'))
    assert.equal(Object.keys(caps.handlers).sort().join() === [...CAPABILITIES].sort().join(), true)
  } finally {
    ws.dispose()
  }
})

test('干净缓冲区不需要 allowDirtySave：dirtyBefore:false 正常保存', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      onSave: ({ disk }) => { disk.set(file, { mtime: 1_700_000_000_999, size: 100 }) },
    })
    const res = await caps.dispatch('vscode.save', saveParams(file, host), { link })
    assert.equal(res.saved, true)
    assert.equal(res.dirtyBefore, false)
    assert.deepEqual(res.disk, { mtime: 1_700_000_000_999, size: 100 })
    assert.doesNotThrow(() => validateResponse('vscode.save', res))
  } finally {
    ws.dispose()
  }
})

test('★ T62 ④ 保存后缓冲**仍是脏的**（formatOnSave 之类）→ 回执如实说 mayHaveApplied:true，并且立刻冻结该文件', async () => {
  const ws = tempWorkspace()
  try {
    const AFTER = { mtime: 1_700_000_000_321, size: 777 }
    // 保存参与者把磁盘写新了，缓冲区**没被清干净**（真机上 formatOnSave 之后
    // 仍 isDirty:true 是见过的形态）。此时字已经落盘 —— 本门拦不住，只能如实报。
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      isDirty: true,
      allowDirtySave: true,
      onSave: ({ disk }) => { disk.set(file, AFTER) },
    })
    const key = pathIdentityKey(file)
    caps.writePolicy.beginWrite(key, { method: 'vscode.applyEdit' })
    caps.writePolicy.endWrite(key, {
      verdict: {
        attribution: 'bridge-correlated',
        after: { version: host.state.version, incarnation: host.state.incarnation, dirty: true },
      },
    })

    const res = await caps.dispatch('vscode.save', saveParams(file, host), { link })
    assert.equal(res.saved, true, '写确实发生了，不许谎报失败')
    assert.equal(res.dirtyAfter, true, '★ 保存后缓冲还是脏的，回执必须说出来')
    assert.equal(res.postSave?.reason, 'attribution-unknown')
    assert.equal(res.postSave?.mayHaveApplied, true,
      '★ 已经落盘了 —— 报"零应用"就是撒谎（变异 M5 把这句改成 false，本条必红）')
    assert.equal(res.postSave?.retryable, false, '内容来源不明时重试没有意义')
    assert.equal(host.calls.save, 1)
    assert.doesNotThrow(() => validateResponse('vscode.save', res))

    // 冻结真的生效：这个文件的下一次写被拒（同一份 grant、同一份参数都不行），
    // 而且拒绝发生在宿主之前 —— 已经落过一次盘的文件不能继续被写。
    const err = await expectCode(
      caps.dispatch('vscode.save', saveParams(file, host), { link }),
      ERR.DOCUMENT_DIRTY,
      '保存后仍脏 → 冻结',
    )
    assert.equal(err.data?.reason, 'attribution-unknown')
    assert.equal(err.data?.isDirty, true)
    assert.equal(host.calls.save, 1, '★ 第二次保存压根没碰宿主')
  } finally {
    ws.dispose()
  }
})
