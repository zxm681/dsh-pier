/**
 * `vscode.deleteFile`（T40 / 契约 §6.2.1 Tier 4）—— 能力层测试。
 *
 * 这是本项目**第一条不可逆能力**的测试，所以它守的东西与前几个文件不同：
 * 前几个文件守的是"别改错"，这个文件守的是"**别删掉**"和"删之前把话说清楚"。
 *
 * 四条★核心（契约 §6.2.5 的三件套 + 磁盘锚点，每一件都有独立的"文件仍在"断言 ——
 * 只看错误码不够：一个先删再报错的实现能通过所有错误码断言）：
 *  ★① 目录 → `-32602 reason:'recursive-delete-unsupported'`，宿主零调用
 *  ★② symlink / junction 本身 → `-32602 reason:'symlink'`
 *  ★③ 确认被取消 → `-32002 declined`（**本项目第一次真正抛这个码**）且文件仍在
 *  ★④ 快照读不到 → `-32603 reason:'snapshot-unavailable'` 且文件仍在
 *  ★⑤ 过期磁盘锚点 → `-32013` 且文件仍在
 *
 * 另有两条是**删除独有**的诚实性测试（契约 §6.2.4）：
 *  ★⑦ 确认超时 → `-32004 reason:'confirm-timeout'`，且**迟到的"同意"不生效**
 *     （等 200ms 让人点下去，文件必须还在、`deleteFile` 必须零调用）；
 *  ★⑨ 确认期间字节被改（mtime/size 恰好不变）→ `-32013 reason:'bytes-changed'`。
 *
 * 反向（"测试在睡觉"）由铁律 9 的变异测试证明：
 *  ① 把确认结果改成恒真 → ★③ 变红；② 把快照失败改成"照删" → ★④ 变红。
 *  原始失败输出见 `work/t40-mutation/t40-m1.log` 与 `t40-m2.log`。
 *
 * T44 语义裁决（评审 T43 B1-a/B1-b 之后）：这条能力**不删任何字节**，只把目标移进
 * `<工作区根>/.dsh-quarantine/` 并把归档后的实测 sha256 交回来。于是：
 *   ★D1 `quarantined:true` + `from`/`to`：移动真的发生了，`from` 不在了、`to` 在；
 *   ★D2 `quarantinedSha256` 必须来自**移动之后**的实测；与 `confirmedSha256` 不同就
 *        `bytesChanged:true` 并如实说明"两份都在"（open-writer / provider 两个窗口都落这条）；
 *   ★D3 归档后认出的**不是同一个对象**（(dev, ino) 变了）→ `-32013`，两份文件都在；
 *   ★D4 宿主面**没有**删除方法：`calls.delete` 在每条成功路径上都必须是 0；
 *   ★D5 跨卷 `EXDEV` → `-32603 reason:'quarantine-failed'`，原件原地不动（绝不 copy+delete）；
 *   ★D6 同名冲突 → 追加随机后缀，已存在的隔离文件一个都不许被覆盖。
 *
 * T44 的变异证据在 `work/t44-mutation/`（每条都真的让对应断言变红，见交付说明）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync, writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'

import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { validateResponse } from '../../dsh-vscode-kit/src/response-contract.js'
import {
  CAPABILITIES, DELETE_BACKUP_MAX_BYTES, DELETE_SNAPSHOT_MAX_BYTES, createCapabilities,
} from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)
const DEFAULT_VERSION = 1
const DEFAULT_INCARNATION = 'inc-default'
const FIXTURE_TEXT = 'line one\nline two\n'

function sha256OfFile(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-delete-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.txt'), FIXTURE_TEXT)
  writeFileSync(join(base, 'secret.txt'), 'outside\n')
  mkdirSync(join(root, 'dir'))
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 假宿主 —— t39 的面上多三件归档要用的东西：`readFileBytes` / `confirmDelete` /
 * `quarantineRename`，外加 T44 的 `ensureDirectory` 与 `readFileIdentity`。
 *
 * 三个设计要点：
 *  - **没有删除方法**（T44）。这里故意留一个 `deleteFile` 陷阱：它计数并抛错，
 *    于是"实现偷偷去删"立刻变成失败，而不是静默通过 —— 静默会让实现以为自己删成功了。
 *  - `quarantineRename` **真的** `renameSync`：假装的 rename 证明不了"验的是被移走的那一个"。
 *  - `readFileIdentity` 用真 `statSync(..., { bigint: true })`：T44 的对象判据必须对着
 *    **真 inode** 才能测；假造一个 (dev, ino) 就成了自证。
 */
function makeHost(roots, {
  trusted = true,
  version = DEFAULT_VERSION,
  incarnation = DEFAULT_INCARNATION,
  isDirty = false,
  untitled = false,
  confirmChoice = 'delete',
  confirmDelayMs = 0,
  readError = null,
  readTooLarge = false,
  onConfirm,
  // T42 / 评审 B1 的两个注入点：`onQuarantineRename` 在**真的 rename 之后**跑（用它在
  // "已归档、还没验"的窗口里替换隔离体）；`onBeforeQuarantineRename` 在 rename 之前跑
  // （用它在"最后一次预验之后、rename 之前"顶名 —— 覆盖 B1-b）。
  onQuarantineRename,
  onBeforeQuarantineRename,
  renameFails = null,
} = {}) {
  const calls = {
    readDocumentState: 0, readDiskStat: 0, readFileBytes: 0, confirm: 0, delete: 0,
    quarantine: 0, ensureDir: 0, identity: 0,
  }
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
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(roots[0], p)),
    workspaceRoots: () => roots.slice(),
    isTrusted: () => trusted,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    readDocumentShape: async () => ({ lineCount: 1, lineLengths: [] }),
    readDocumentState: async () => {
      calls.readDocumentState += 1
      return {
        version: state.version,
        incarnation: state.incarnation,
        isDirty: state.isDirty,
        eol: 'lf',
        lineCount: 2,
        textLength: 18,
        byteLength: 18,
        untitled: state.untitled,
      }
    },
    readDiskStat: async (abs) => {
      calls.readDiskStat += 1
      // 真宿主 stat 的是**磁盘上那个名字**；隔离名不在 `disk` 锚点表里，必须按真磁盘
      // stat 一次 —— 否则"验隔离体"这一步在测试里永远读不到东西，新回归会变成假绿。
      if (disk.has(abs)) return disk.get(abs)
      try {
        const st = statSync(abs)
        return { mtime: Math.floor(st.mtimeMs), size: st.size }
      } catch { return null }
    },
    // T40：快照读。`readTooLarge` / `readError` 用来造"读不到就不归档"的两种形态。
    readFileBytes: async (abs, opts = {}) => {
      calls.readFileBytes += 1
      if (readError) throw readError
      if (readTooLarge) return { tooLarge: true, size: opts?.maxBytes + 1 }
      const buffer = readFileSync(abs)
      if (opts?.maxBytes && buffer.length > opts.maxBytes) {
        return { tooLarge: true, size: buffer.length }
      }
      return { tooLarge: false, size: buffer.length, buffer }
    },
    // T40：人工确认。`confirmChoice: 'delete'` 模拟人点了归档；其它值 = 取消/关掉。
    // `confirmDelayMs` 用来演"迟到的同意"：超时之后才 resolve。
    confirmDelete: async (abs, meta) => {
      calls.confirm += 1
      if (onConfirm) onConfirm({ abs, meta, calls })
      if (confirmDelayMs > 0) await new Promise((r) => setTimeout(r, confirmDelayMs))
      return { choice: confirmChoice }
    },
    // T44：隔离目录。`mkdirSync({recursive:true})` 对已存在的目录是 no-op，正好是
    // `createDirectory` 的语义。
    ensureDirectory: async (abs) => {
      calls.ensureDir += 1
      mkdirSync(abs, { recursive: true })
      return { created: true }
    },
    // T42 / 评审 B1：归档改名。真的 `renameSync`；`renameFails` 用来演"跨卷/权限"
    // 这类结构性失败。
    quarantineRename: async (from, to) => {
      calls.quarantine += 1
      if (onBeforeQuarantineRename) onBeforeQuarantineRename({ from, to, calls })
      if (renameFails) throw renameFails
      renameSync(from, to)
      if (onQuarantineRename) onQuarantineRename({ from, to, calls })
      return { renamed: true }
    },
    // T44：对象的身份判据。真 stat，出任何错都当"看不见"（和真宿主返回 null 一致）。
    readFileIdentity: (abs) => {
      calls.identity += 1
      try {
        const st = statSync(abs, { bigint: true })
        return { dev: st.dev.toString(), ino: st.ino.toString() }
      } catch { return null }
    },
    // T44：宿主面**不再有**删除方法。这个陷阱只负责"你居然还敢调"这件事。
    deleteFile: async () => {
      calls.delete += 1
      throw new Error('host.deleteFile 不该再存在（T44：只归档，不删除）')
    },
    log: () => {},
  }
  return host
}

/** 一张"与磁盘此刻一致"的锚点。 */
function diskAnchorOf(abs) {
  const st = statSync(abs)
  return { mtime: Math.floor(st.mtimeMs), size: st.size }
}

function grantedEnv({
  root, link = { name: 'link-a' }, allowDirtySave = false, deleteConfirmTimeoutMs, ...hostOpts
} = {}) {
  const grants = new GrantStore()
  grants.adopt({ id: ID_A, epoch: EPOCH_A, link, allowDirtySave })
  const host = makeHost([root], hostOpts)
  const caps = createCapabilities(host, {
    grants,
    ...(deleteConfirmTimeoutMs === undefined ? {} : { deleteConfirmTimeoutMs }),
  })
  const file = join(root, 'a.txt')
  host.setDisk(file, diskAnchorOf(file))
  return { grants, host, caps, link, file }
}

/** 入口参数：双锚点 + 磁盘锚点 + grant 全给。 */
function deleteParams(file, host, extra = {}) {
  return {
    file,
    expectedVersion: DEFAULT_VERSION,
    expectedIncarnation: DEFAULT_INCARNATION,
    expectedDisk: host.disk.get(file) ?? diskAnchorOf(file),
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

/** "宿主什么都没做"的统一断言：确认框、隔离目录、删除陷阱全零。 */
function assertHostUntouched(host, label) {
  assert.equal(host.calls.confirm, 0, `${label}: 不该弹确认框（宿主零调用）`)
  assert.equal(host.calls.ensureDir, 0, `${label}: 不该建隔离目录（宿主零调用）`)
  assert.equal(host.calls.delete, 0, `${label}: 宿主面没有删除方法可调（T44）`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ ① 目录、② symlink：形态门（⑯）
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ① 目标是目录 → -32602 reason:recursive-delete-unsupported，宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const dir = join(ws.root, 'dir')
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(dir, host), { link }),
      ERR.INVALID_PARAMS,
      '目录',
    )
    // 专用 reason：删除对目录的处置是"改路径"，不是"这里只能写文件"（§6.2.4 ③）。
    assert.equal(err.data?.reason, 'recursive-delete-unsupported')
    assert.equal(err.data?.method, 'vscode.deleteFile')
    assertHostUntouched(host, '目录')
    // 目录本身必须还在（而且里面没被动过）。
    assert.equal(existsSync(dir), true, '目录必须原样还在')
    assert.equal(host.calls.readFileBytes, 0, '连内容都不该读')
    assert.equal(host.calls.readDocumentState, 0, '形态门排在双锚点之前（§6.2.1 的 ⑯ 在前）')
  } finally { ws.dispose() }
})

test('★ T40 ② 目标本身是 symlink / junction → -32602 reason:symlink，宿主零调用', async (t) => {
  const ws = tempWorkspace()
  try {
    const linkPath = join(ws.root, 'link.txt')
    // 指向工作区**内**的真实文件也不行：删掉一个链接 = 删掉一个"指向别处"的入口，
    // 爆炸半径无法从路径上评估（§6.2.4 ④）。
    try {
      symlinkSync(join(ws.root, 'a.txt'), linkPath, 'file')
    } catch (err) {
      // Windows 未开开发者模式时建文件符号链接要管理员权限：跳过，不留假绿。
      t.skip(`cannot create symlink here: ${err.code ?? err.message}`)
      return
    }
    const { host, caps, link } = grantedEnv({ root: ws.root })
    host.setDisk(linkPath, diskAnchorOf(linkPath))
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(linkPath, host), { link }),
      ERR.INVALID_PARAMS,
      'symlink',
    )
    assert.equal(err.data?.reason, 'symlink')
    assertHostUntouched(host, 'symlink')
    assert.equal(existsSync(linkPath), true, '链接本身必须还在')
    assert.equal(existsSync(join(ws.root, 'a.txt')), true, '链接目标必须原样还在')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ ③ 确认被取消 —— 本项目**第一次**真正抛 -32002
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ③ 用户取消确认 → -32002 declined，文件仍在，deleteFile 零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, confirmChoice: 'not-confirmed' })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.DECLINED,
      '取消确认',
    )
    assert.equal(err.data?.method, 'vscode.deleteFile')
    assert.equal(err.data?.choice, 'not-confirmed', '回显人的选择（诊断用）')
    assert.equal(err.data?.mayHaveApplied, false, '人拒绝了就必须说清"什么都没发生"')
    assert.equal(host.calls.confirm, 1, '确认框只弹一次')
    assert.equal(host.calls.delete, 0, '人没同意 ⇒ deleteFile 必须零调用')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '文件内容必须一个字都没变')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ ④ 快照读不到 —— "读不到就不删"
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ④ 快照读不到 → -32603 reason:snapshot-unavailable，文件仍在，且不打扰人', async () => {
  const ws = tempWorkspace()
  try {
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const { host, caps, link, file } = grantedEnv({ root: ws.root, readError: eacces })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.INTERNAL,
      '快照读不到',
    )
    assert.equal(err.data?.reason, 'snapshot-unavailable')
    assert.equal(err.data?.why, 'unreadable')
    assert.equal(err.data?.mayHaveApplied, false, '没有快照就没有恢复材料 ⇒ 什么都没删')
    assert.equal(host.calls.delete, 0, '读不到内容 ⇒ deleteFile 必须零调用')
    // 快照(⑱)排在确认(⑰)之前：读不到就不要去打扰人（否则人点了删除才被告知删不了）。
    assert.equal(host.calls.confirm, 0, '读不到内容时不该弹确认框')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '文件必须原样还在')
  } finally { ws.dispose() }
})

test('★ T42 I1 超过交付上限（1 MiB）→ -32603 reason:backup-undeliverable，且**不许删**', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    // 1 MiB 之上 1 字节：这里刻意写死字面量（**不跟随常量**）—— 若有人把交付上限改大到
    // 读上限（旧行为），这条必须变红；跟着常量走就会一起漂移成假绿。
    const OVER = 1024 * 1024 + 1
    writeFileSync(file, Buffer.alloc(OVER, 0x61))
    host.setDisk(file, diskAnchorOf(file))
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.INTERNAL,
      '超过交付上限',
    )
    assert.equal(err.data?.reason, 'backup-undeliverable', '这是"交不出备份"，不是"读不到"')
    assert.equal(err.data?.why, 'too-large')
    assert.equal(err.data?.maxBytes, 1024 * 1024)
    assert.equal(err.data?.size, OVER)
    assert.equal(err.data?.backup?.delivered, false, '返回体必须明确说自己没交备份')
    assert.equal(err.data?.mayHaveApplied, false)
    assert.equal(host.calls.delete, 0, '交不出整份字节 ⇒ 不许删')
    assert.equal(host.calls.quarantine, 0, '连隔离都不该做')
    assert.equal(host.calls.confirm, 0, '交不出备份 ⇒ 不许打扰人（确认之前就拒）')
    assert.equal(statSync(file).size, OVER, '文件必须原样还在')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ ⑤ 过期磁盘锚点
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ⑤ 过期 expectedDisk → -32013（措辞是 delete 不是 save），文件仍在，宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const stale = { mtime: host.disk.get(file).mtime + 1000, size: host.disk.get(file).size + 3 }
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host, { expectedDisk: stale }), { link }),
      ERR.DISK_STATE_CONFLICT,
      '过期磁盘锚点',
    )
    assert.equal(err.data?.method, 'vscode.deleteFile')
    assert.deepEqual(err.data?.expected, stale, 'data.expected 原样回传调用方的锚点')
    // 措辞必须是删除侧的：save 那句"要不要覆盖它"会把人引向一个不存在的选项。
    assert.match(err.message, /nothing was deleted/, '必须说清"什么都没删"')
    assert.doesNotMatch(err.message, /overwrite/, '删除没有"覆盖"这个出路')
    assertHostUntouched(host, '过期锚点')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '文件必须原样还在')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ ⑦ 确认超时：独立长超时 + **超时作废许可**
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ⑦ 确认超时 → -32004 reason:confirm-timeout，且迟到的"同意"不生效', async () => {
  const ws = tempWorkspace()
  try {
    // 确认超时 60ms，人 200ms 才点下去 —— 那次"同意"必须落空。
    const { host, caps, link, file } = grantedEnv({
      root: ws.root, confirmDelayMs: 200, confirmChoice: 'delete', deleteConfirmTimeoutMs: 60,
    })
    const started = Date.now()
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.TIMEOUT,
      '确认超时',
    )
    const elapsed = Date.now() - started
    assert.equal(err.data?.reason, 'confirm-timeout')
    assert.equal(err.data?.timeoutMs, 60)
    assert.equal(err.data?.mayHaveApplied, false)
    // 超时是**自己的**长超时（60ms），不是请求级 30s —— 报的是 confirm-timeout 而不是断线。
    assert.ok(elapsed < 190, `必须在确认超时那一刻就返回（实测 ${elapsed}ms）`)

    // ★ 关键：等那个"迟到的同意"到点，再看一遍 —— 文件必须还在、delete 必须零调用。
    await new Promise((r) => setTimeout(r, 260))
    assert.equal(host.calls.delete, 0, '迟到的同意不得生效（许可已在超时那一刻作废）')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '超时后文件必须原样还在')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ ⑧ 正常路径：真的删掉，并且把不可逆性写进返回值
// ─────────────────────────────────────────────────────────────────────────────

test('★ T40 ⑧ 确认通过 → 归档进 .dsh-quarantine：原名没了、字节在隔离体里、一个都没删', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const before = sha256OfFile(file)
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })

    // T44 语义：成功 = 归档，不是销毁。
    assert.equal(res.quarantined, true)
    assert.equal(res.file, file)
    assert.equal(res.from, file)
    assert.equal(Object.hasOwn(res, 'deleted'), false, '旧的 deleted 字段必须消失')
    assert.equal(Object.hasOwn(res, 'trashed'), false, '跟回收站无关了')
    assert.equal(Object.hasOwn(res, 'useTrash'), false)

    // ★D1 隔离目录：<工作区根>/.dsh-quarantine/<UTC yyyyMMdd-HHmmss>-<原名>
    assert.match(basename(res.to), /^\d{8}-\d{6}-a\.txt$/, `隔离名不对：${res.to}`)
    assert.equal(dirname(res.to), join(ws.root, '.dsh-quarantine'))
    assert.equal(existsSync(file), false, '原名不在了（被移走，不是被删）')
    assert.equal(readFileSync(res.to, 'utf8'), FIXTURE_TEXT, '隔离体就是原字节')

    // 三个 hash 的口径：确认时 = 归档后 = 快照。没变就不许说"变了"。
    assert.equal(res.confirmedSha256, before)
    assert.equal(res.quarantinedSha256, before, 'quarantinedSha256 必须来自移动之后的实测')
    assert.equal(res.snapshot.sha256, before)
    assert.equal(res.confirmedByteLength, 18)
    assert.equal(res.quarantinedByteLength, 18)
    assert.equal(res.bytesChanged, false)
    assert.equal(Object.hasOwn(res, 'bytesChangedNote'), false, '没变就别解释')

    assert.equal(res.quarantine.path, res.to)
    assert.equal(res.quarantine.original, file)
    assert.equal(res.quarantine.restored, false)
    assert.equal(res.quarantine.retained, true, '成功时隔离体就是要保留的那一份')
    assert.equal(res.nameCollision, false)

    // ★D4：整条成功路径上一次删除调用都没有（宿主面那个陷阱一次都没被摸到）。
    assert.equal(host.calls.delete, 0, '归档路径上不该有任何删除调用')
    assert.equal(host.calls.ensureDir, 1, '隔离目录建一次')
    assert.ok(host.calls.identity >= 2, '对象身份至少取两次：移动前一次、移动后一次')
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally { ws.dispose() }
})

test('★ T40 ⑧b 返回体合同：缺 quarantined / 自相矛盾的 bytesChanged 都是畸形响应（-32009）', () => {
  const Q = 'D:/ws/.dsh-quarantine/20251021-101010-a.txt'
  const good = {
    quarantined: true,
    file: 'D:/ws/a.txt',
    from: 'D:/ws/a.txt',
    to: Q,
    confirmedSha256: 'a'.repeat(64),
    confirmedByteLength: 18,
    quarantinedSha256: 'a'.repeat(64),
    quarantinedByteLength: 18,
    bytesChanged: false,
    snapshot: {
      sha256: 'a'.repeat(64), byteLength: 18, encoding: 'utf8', textLength: 18, text: FIXTURE_TEXT,
    },
    backup: { delivered: true, form: 'utf8-text', byteLength: 18, sha256: 'a'.repeat(64) },
    quarantine: { path: Q, original: 'D:/ws/a.txt', restored: false, retained: true },
    nameCollision: false,
  }
  // 合同自测的正面样本必须过 —— 否则下面七条"应该拒"的断言可能只是因为样本本来就坏。
  assert.doesNotThrow(() => validateResponse('vscode.deleteFile', good), '正面样本必须过')

  const bad = (mutate) => { const copy = structuredClone(good); mutate(copy); return copy }
  const cases = [
    ['缺 quarantined（旧合同的 deleted:true）', bad((o) => { delete o.quarantined; o.deleted = true })],
    ['bytesChanged:false 但两个 hash 不同', bad((o) => { o.quarantinedSha256 = 'b'.repeat(64) })],
    ['bytesChanged:true 却不解释', bad((o) => {
      o.quarantinedSha256 = 'b'.repeat(64); o.bytesChanged = true
    })],
    ['confirmed 与快照不是同一份字节', bad((o) => { o.confirmedSha256 = 'c'.repeat(64) })],
    ['from === to（根本没搬）', bad((o) => { o.to = o.from })],
    ['正文不是整份', bad((o) => { o.snapshot.text = 'line one' })],
    ['binary 却带 text（两种形态混着给）', bad((o) => {
      o.snapshot.encoding = 'binary'
      o.snapshot.base64 = Buffer.from(FIXTURE_TEXT).toString('base64')
      o.snapshot.byteLength = 18
      o.backup.form = 'base64'
    })],
  ]
  for (const [label, payload] of cases) {
    assert.throws(
      () => validateResponse('vscode.deleteFile', payload),
      (err) => {
        assert.equal(err.code, ERR.INVALID_RESPONSE, `${label}: 被判成畸形响应`)
        return true
      },
      label,
    )
  }
})

test('★ T40 ⑨ 确认期间字节被改（mtime/size 恰好不变）→ -32013 reason:bytes-changed，文件仍在', async () => {
  const ws = tempWorkspace()
  try {
    // 人在看确认框时，另一个进程把内容换成**同样长度**的另一段文字，并把 mtime 改回去。
    // 磁盘锚点 {mtime,size} 完全看不出来 —— 只有重读 + sha256 能看出来。
    const anchor = diskAnchorOf(join(ws.root, 'a.txt'))
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      onConfirm: ({ abs }) => {
        writeFileSync(abs, 'LINE ONE\nLINE TWO\n') // 同样 18 字节
        // 把 mtime 掰回原值：模拟"同 size 同时刻"的替换（磁盘锚点完全看不出来）。
        const t = new Date(anchor.mtime)
        utimesSync(abs, t, t)
      },
    })
    host.setDisk(file, anchor)
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host, { expectedDisk: anchor }), { link }),
      ERR.DISK_STATE_CONFLICT,
      '确认期间字节被改',
    )
    assert.equal(err.data?.reason, 'bytes-changed')
    // data 里两份材料都要有：调用方得能说清"人看的那份"和"盘上这份"分别是哪个。
    assert.equal(err.data?.expected?.byteLength, anchor.size)
    assert.notEqual(err.data?.actual?.sha256, err.data?.expected?.sha256, '两份 sha256 必须不同')
    assert.equal(host.calls.delete, 0, '人看的那份已经不是盘上这份 ⇒ 不许删')
    assert.equal(readFileSync(file, 'utf8'), 'LINE ONE\nLINE TWO\n', '被换掉的内容必须原样留着（没删）')
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// 其余门：意图门 / 绑定门 / untitled / 宿主撒谎 / 正文体积
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ★ T42 / 评审 B1：**先隔离再验再删** —— 两条能变红的交错回归
// ─────────────────────────────────────────────────────────────────────────────

test('★ T44 D2 provider 消费窗口：归档之后有人就地改写隔离体 → bytesChanged:true，两份都在', async () => {
  const ws = tempWorkspace()
  try {
    const NEW_BYTES = 'NEW_NO_BACKUP!!!\n\n' // 同样 18 字节：长度骗得过，hash 骗不过
    let seen = null
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      // 模拟"另一个扩展/进程在归档之后、验收之前改了这个名字下的内容"（评审 B1-a 的
      // provider 窗口）。旧实现到这里会把这 18 字节当"要删的东西"删掉且不留备份；
      // 现在的实现不删任何东西，只负责如实报告"变了"。
      onQuarantineRename: ({ to }) => {
        if (!to.includes('.dsh-quarantine')) return
        seen = to
        writeFileSync(to, NEW_BYTES)
      },
    })
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })

    assert.equal(res.quarantined, true)
    assert.equal(res.bytesChanged, true, '实测与确认时不同就必须说"变了"')
    assert.equal(res.confirmedSha256, createHash('sha256').update(FIXTURE_TEXT).digest('hex'))
    assert.equal(res.quarantinedSha256, createHash('sha256').update(NEW_BYTES).digest('hex'))
    assert.equal(res.quarantinedByteLength, 18, '长度没变 —— 只有"移动之后重新测"才看得出来')
    assert.match(res.bytesChangedNote, /snapshot/, '必须说明确认时那份在哪')
    assert.equal(seen, res.to)
    // ★D1/D4：两份字节都在（响应里的 snapshot + 磁盘上的 to），删除调用为零。
    assert.ok(existsSync(res.to), '隔离体必须在')
    assert.equal(readFileSync(res.to, 'utf8'), NEW_BYTES)
    assert.equal(res.snapshot.text, FIXTURE_TEXT, '确认时那份字节仍在响应里')
    assert.equal(host.calls.delete, 0)
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally { ws.dispose() }
})

test('★ T44 D3 归档后认出的不是同一个对象 → -32013 target-replaced-before-quarantine', async () => {
  const ws = tempWorkspace()
  try {
    const occupant = 'occupant\n'
    let seen = null
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      onQuarantineRename: ({ to }) => {
        if (!to.includes('.dsh-quarantine')) return
        seen = to
        // 把真隔离体挪走，在同一隔离名上放**另一个对象**，再把原名占掉：
        // 于是"归还"也会失败，实现只能保留并交出真实路径。
        renameSync(to, `${to}.real`)
        writeFileSync(to, 'impostor\n')
        writeFileSync(file, occupant)
      },
    })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.DISK_STATE_CONFLICT,
      '隔离体被换成另一个对象',
    )
    assert.equal(err.data?.reason, 'target-replaced-before-quarantine')
    assert.notEqual(err.data?.identity?.expected?.ino, err.data?.identity?.actual?.ino,
      '(dev, ino) 不同才是判据（不是 hash）')
    assert.equal(err.data?.mayHaveApplied, false)
    // 三份都在：真隔离体（.real）、顶名的 impostor（隔离名）、占位者（原名）。
    assert.ok(existsSync(`${seen}.real`), '真隔离体必须保留')
    assert.equal(readFileSync(`${seen}.real`, 'utf8'), FIXTURE_TEXT, '一个字节都没丢')
    assert.equal(readFileSync(seen, 'utf8'), 'impostor\n', '别人的文件也不许删')
    assert.equal(readFileSync(file, 'utf8'), occupant)
    // 归还不成 → 隔离体保留并说出原因（不是默默消失）。
    assert.equal(err.data?.quarantine?.restored, false)
    assert.equal(err.data?.quarantine?.retained, true)
    assert.equal(err.data?.quarantine?.reason, 'original-occupied')
    assert.equal(host.calls.delete, 0)
  } finally { ws.dispose() }
})

test('★ T44 D3b 最后一次预验之后、rename 之前顶名（**同字节同长度**）→ -32013，两张都在', async () => {
  const ws = tempWorkspace()
  try {
    let stash = null
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      // 评审 B1-b 的窗口：字节预验已经过了，rename 还没发生。这里把原件改名走、
      // 用**完全相同**的字节顶回原名 —— hash / 长度 / 磁盘锚点全都看不出来，
      // 只有"这是不是同一个对象"能看出来。
      onBeforeQuarantineRename: ({ from }) => {
        stash = `${from}.orig`
        const { mtimeMs } = statSync(from)
        renameSync(from, stash)
        writeFileSync(from, FIXTURE_TEXT)
        utimesSync(from, new Date(mtimeMs), new Date(mtimeMs))
      },
    })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.DISK_STATE_CONFLICT,
      'rename 之前顶名',
    )
    // B1-b：这是磁盘状态冲突（-32013），不是内部错误（-32603）。
    assert.equal(err.data?.reason, 'target-replaced-before-quarantine')
    assert.equal(err.data?.mayHaveApplied, false)
    assert.notEqual(err.data?.identity?.expected?.ino, err.data?.identity?.actual?.ino)
    assert.equal(err.data?.quarantine?.restored, true, '不是要的那个人 → 原样还回原名')
    // 两张都在：原件（改了名）与被还回去的顶名者。
    assert.equal(readFileSync(stash, 'utf8'), FIXTURE_TEXT, '原件一个字节都没少')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '顶名者被还回原名，也没删')
    assert.equal(host.calls.delete, 0)
    assert.match(err.message, /both files are still on disk/)
  } finally { ws.dispose() }
})

test('T40 意图门：脏缓冲区且 grant 无 allowDirtySave → -32012 reason:buffer-dirty，文件仍在', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, isDirty: true })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host, { allowDirtySave: true }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT,
      '脏缓冲区',
    )
    assert.equal(err.data?.reason, 'buffer-dirty')
    // params 里的同名位不算授权（与 T39 同一条结论，删除更不容许自己给自己授权）。
    assert.equal(err.data?.allowDirtySave, false)
    assertHostUntouched(host, '脏缓冲区')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT)
  } finally { ws.dispose() }
})

test('T40 意图门：grant 带 allowDirtySave 时脏缓冲区可以归档（记录上是授权方给的）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, isDirty: true, allowDirtySave: true })
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })
    assert.equal(res.quarantined, true)
    assert.equal(existsSync(file), false, '原名字没了，但字节在隔离体里')
    assert.equal(readFileSync(res.to, 'utf8'), FIXTURE_TEXT)
    assert.equal(host.calls.delete, 0)
  } finally { ws.dispose() }
})

test('T40 绑定门：没有 grant → -32010，且**连确认框都不弹**', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const params = deleteParams(file, host)
    delete params.grant
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', params, { link }),
      ERR.EDIT_NOT_BOUND,
      '无 grant',
    )
    assert.equal(err.data?.reason, 'no-grant')
    // 未授权的删除连"骚扰人一下"都不该发生：门在 handler 之前（dispatch 判序）。
    assertHostUntouched(host, '无 grant')
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT)
  } finally { ws.dispose() }
})

test('T40 untitled 文档 → -32602 reason:untitled-document（没有盘上的文件可删）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root, untitled: true })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.INVALID_PARAMS,
      'untitled',
    )
    assert.equal(err.data?.reason, 'untitled-document')
    assertHostUntouched(host, 'untitled')
  } finally { ws.dispose() }
})

test('T44 隔离名上没有对象（rename 说成了，东西不在那儿）→ -32603 reason:quarantine-not-observed', async () => {
  const ws = tempWorkspace()
  try {
    let moved = null
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      onQuarantineRename: ({ to }) => {
        if (!to.includes('.dsh-quarantine')) return
        moved = `${to}.moved`
        renameSync(to, moved) // 宿主说"移好了"，但那份东西不在它说的名字上
      },
    })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.INTERNAL,
      '隔离体不见踪影',
    )
    assert.equal(err.data?.reason, 'quarantine-not-observed')
    // 不能报"删了"：东西还在磁盘上，只是不在那个名字下。
    assert.equal(Object.hasOwn(err.data ?? {}, 'deleted'), false)
    assert.ok(existsSync(moved))
    assert.equal(readFileSync(moved, 'utf8'), FIXTURE_TEXT, '字节没丢（我们从不删）')
    assert.equal(host.calls.delete, 0)
  } finally { ws.dispose() }
})

test('★ T42 I1 大文本（300 KiB，仍在交付上限内）必须**整份**交付，且能逐字节恢复', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    // 旧实现把 >1 MiB 的正文省成 sha256 —— 这里取一个"很大但交得出"的量级，
    // 证明判据不是"越大越不回"，而是"能不能整份交出去"。
    const text = 'x'.repeat(300 * 1024)
    writeFileSync(file, text)
    host.setDisk(file, diskAnchorOf(file))
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })
    assert.equal(res.snapshot.encoding, 'utf8')
    assert.equal(Object.hasOwn(res.snapshot, 'text'), true, '整份正文必须在响应里')
    assert.equal(res.snapshot.text, text, '一个字符都不能少')
    assert.equal(res.snapshot.textLength, text.length)
    assert.equal(res.backup.delivered, true)
    assert.equal(res.backup.form, 'utf8-text')
    // 自证：从响应里交出的正文重算 sha256，必须等于它声明的 sha256（"交付"而非"提过"）。
    assert.equal(
      createHash('sha256').update(Buffer.from(res.snapshot.text, 'utf8')).digest('hex'),
      res.snapshot.sha256,
      '交付出去的字节重算 hash 必须对得上',
    )
    assert.equal(existsSync(file), false)
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally { ws.dispose() }
})

test('T42 I1 二进制文件：encoding:binary + 整份 base64（不是替换字符版"正文"）', async () => {
  const ws = tempWorkspace()
  try {
    const bin = join(ws.root, 'blob.bin')
    // 0x80 0xFF 不是合法 UTF-8 → 往返不无损 → binary。
    const bytes = Buffer.from([0x00, 0x80, 0xff, 0xfe, 0x41, 0x00])
    writeFileSync(bin, bytes)
    const { host, caps, link } = grantedEnv({ root: ws.root })
    host.setDisk(bin, diskAnchorOf(bin))
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(bin, host), { link })
    assert.equal(res.snapshot.encoding, 'binary')
    assert.equal(Object.hasOwn(res.snapshot, 'text'), false, '二进制不给"正文"（替换字符版更坏）')
    assert.equal(Object.hasOwn(res.snapshot, 'textLength'), false)
    assert.equal(res.snapshot.byteLength, bytes.length)
    assert.equal(res.backup.form, 'base64')
    // 自证：base64 反解回来必须逐字节等于原文件。
    const restored = Buffer.from(res.snapshot.base64, 'base64')
    assert.deepEqual(restored, bytes, 'base64 必须能反解出原始字节')
    assert.equal(createHash('sha256').update(restored).digest('hex'), res.snapshot.sha256)
    assert.equal(existsSync(bin), false)
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally { ws.dispose() }
})

// ─────────────────────────────────────────────────────────────────────────────
// T44 的窗口回归：三类"别人也在碰同一个文件"的竞态，一条都不许变成删除
// ─────────────────────────────────────────────────────────────────────────────

test('★ T44 D2 open-writer 窗口：归档前就握着的写句柄，在归档后写入 → bytesChanged:true，隔离体在', async () => {
  const ws = tempWorkspace()
  let fd = null
  try {
    const NEW_BYTES = 'NEW_NO_BACKUP!!!\n\n' // 18 字节，长度完全一致
    const { host, caps, link, file } = grantedEnv({
      root: ws.root,
      onQuarantineRename: ({ to }) => {
        if (!to.includes('.dsh-quarantine')) return
        // 评审 B1-a 的 open-writer：句柄在归档**之前**就打开了，rename 不会让它失效，
        // 所以"验完之后"写进去的字节会落在隔离体上。旧实现此时把新字节连同旧字节一起
        // 删掉；现在的实现根本不删，只把"变了"如实报出来。
        writeSync(fd, Buffer.from(NEW_BYTES), 0, 18, 0)
      },
    })
    fd = openSync(file, 'r+')
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })

    assert.equal(res.quarantined, true)
    assert.equal(res.bytesChanged, true)
    assert.equal(res.confirmedByteLength, 18)
    assert.equal(res.quarantinedByteLength, 18)
    assert.equal(res.quarantinedSha256, createHash('sha256').update(NEW_BYTES).digest('hex'))
    assert.equal(host.calls.delete, 0, '这条窗口下也一次都没删')
    // 两份都在：确认时那份在 snapshot 里，改过的这份在隔离体里。
    assert.equal(res.snapshot.text, FIXTURE_TEXT)
    assert.ok(existsSync(res.to))
    assert.equal(readFileSync(res.to, 'utf8'), NEW_BYTES)
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally {
    if (fd !== null) closeSync(fd)
    ws.dispose()
  }
})

test('★ T44 D6 同名冲突 → 追加随机后缀；已存在的隔离文件一个都不许被覆盖', async () => {
  const ws = tempWorkspace()
  try {
    const dir = join(ws.root, '.dsh-quarantine')
    mkdirSync(dir, { recursive: true })
    const stampOf = (offsetMs) => {
      const d = new Date(Date.now() + offsetMs)
      const two = (n) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`
        + `-${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`
    }
    // 把"此刻"附近的几个候选名全占掉（隔离名是 UTC 秒级时间戳，写死某一秒会变成
    // "某天早上才失败"的测试；预占 ±1 秒 + 下一秒就与真实调用窗口无关了）。
    const older = 'older archive\n'
    const occupied = []
    for (const off of [-1000, 0, 1000, 2000]) {
      const p = join(dir, `${stampOf(off)}-a.txt`)
      if (occupied.includes(p)) continue
      writeFileSync(p, older)
      occupied.push(p)
    }

    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const res = await caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link })

    assert.equal(res.nameCollision, true, '冲突必须报出来（诊断用）')
    assert.match(basename(res.to), /^\d{8}-\d{6}-a\.txt-[0-9a-f]{8}$/, `后缀不对：${res.to}`)
    for (const p of occupied) {
      assert.equal(readFileSync(p, 'utf8'), older, `已存在的隔离文件不许覆盖：${p}`)
    }
    assert.equal(readFileSync(res.to, 'utf8'), FIXTURE_TEXT, '这次归档的字节必须落在新名字上')
    assert.equal(host.calls.delete, 0)
    assert.doesNotThrow(() => validateResponse('vscode.deleteFile', res))
  } finally { ws.dispose() }
})

test('★ T44 D5 跨卷（EXDEV）→ -32603 quarantine-failed：原件不动，且绝不用 copy+delete 顶替', async () => {
  const ws = tempWorkspace()
  try {
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), {
      data: { hostCode: 'EXDEV' },
    })
    const { host, caps, link, file } = grantedEnv({ root: ws.root, renameFails: exdev })
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', deleteParams(file, host), { link }),
      ERR.INTERNAL,
      '跨卷',
    )
    assert.equal(err.data?.reason, 'quarantine-failed')
    assert.equal(err.data?.hostCode, 'EXDEV')
    assert.equal(err.data?.crossVolume, true, '要能一眼看出是跨卷，不是权限')
    // ★D5：原件原地不动，而且**一次删除调用都没有**（copy+delete 的替代方案在这里被禁掉）。
    assert.equal(existsSync(file), true)
    assert.equal(readFileSync(file, 'utf8'), FIXTURE_TEXT, '一个字节都不许动')
    assert.equal(host.calls.delete, 0, 'EXDEV 不许退化成 copy+delete')
    assert.equal(err.data?.mayHaveApplied, false)
    assert.match(err.message, /cross-volume/)
  } finally { ws.dispose() }
})

test('T40 能力清单登记：CAPABILITIES 与 handlers 都有 vscode.deleteFile', () => {
  const ws = tempWorkspace()
  try {
    assert.ok(CAPABILITIES.includes('vscode.deleteFile'))
    const { caps } = grantedEnv({ root: ws.root })
    assert.equal(typeof caps.handlers['vscode.deleteFile'], 'function')
  } finally { ws.dispose() }
})

test('T40 锚点缺失：expectedDisk 必填（-32602），缺 grant 之外的锚点同族', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, file } = grantedEnv({ root: ws.root })
    const params = deleteParams(file, host)
    delete params.expectedDisk
    const err = await expectCode(
      caps.dispatch('vscode.deleteFile', params, { link }),
      ERR.INVALID_PARAMS,
      '缺 expectedDisk',
    )
    assert.equal(err.data?.reason, 'expected-disk-missing')
    assertHostUntouched(host, '缺 expectedDisk')
  } finally { ws.dispose() }
})
