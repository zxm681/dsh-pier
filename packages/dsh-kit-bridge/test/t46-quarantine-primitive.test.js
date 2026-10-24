/**
 * T46 回归：隔离归档用的**原语**本身不许退化（评审 T45 / B45-1）。
 *
 * ## 为什么这批测试必须打真实宿主适配器
 *
 * `test/t40-delete.test.js` 里 T44 的那几条用的是**假 host**（直接给
 * `createCapabilities` 一个对象，`quarantineRename` 是测试自己写的 `renameSync`）。
 * 那种测法能证明"能力层把 EXDEV 映射对了"，但**证明不了原语本身没有退化**：
 * 退化发生在 VS Code 的文件服务里 —— `workspace.fs.rename` 在跨卷时落进
 * `pfs.Promises.rename` 的 EXDEV 分支，**copy + rimraf(source)**，且不把 EXDEV
 * 交回来。假 host 没有那条分支，于是 T44 五条全绿、底层照样删过一次
 * （`work/t45-probes/output.log:8–10` 的 copy=1 / delete=1 就是这么来的）。
 *
 * 所以这里按 `work/t45-probes/narrow.mjs` 的路子：**真实的** `vscode-host.js`
 * + **假 `vscode` 模块**（`registerHooks` 把 `vscode` 短路成一个 data: 模块）。
 * 假 provider 老老实实实现了上游那条**退化**语义并计数 —— 修好之后它一次都不该
 * 被调用（`provider.renames === 0`），这就是"零删除"的可判据形式。
 *
 * ## 变异口径
 *
 * 把 `quarantineRename` 换回 `vscode.workspace.fs.rename` 之后，前两条会立刻变红
 * （`provider.renames` / `provider.deletes` 变成 1）。证据在
 * `work/t46-mutation/`：删计数的原始失败信息 + `cp` 还原 + `diff -q`。
 */

import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ORIGINAL = 'ORIGINAL_SECRET'

/** 全部增删改只落在这个 fixture 目录下（用完不清理，便于人工复核）。 */
const root = fs.mkdtempSync(join(tmpdir(), 'dsh-t46-quarantine-'))

/**
 * 假 provider 的计数器 —— 本文件的核心判据都读它。
 * `renames`：`workspace.fs.rename` 被调用了几次（**必须 0**）。
 * `copies` / `deletes`：上游退化分支里"复制一次、删一次"的计数（**必须 0**）。
 */
const seen = { renames: 0, copies: 0, deletes: 0 }

/** 当前测试想注入的宿主错误（null = 正常搬），由 `stubRename` 设置。 */
let hostRenameFault = null

const safe = (p) => {
  const abs = resolve(p)
  assert.ok(abs.startsWith(resolve(root)), `fixture 边界被突破：${p}`)
}

/**
 * 假 `vscode` 模块。`workspace.fs.rename` 实现的是**上游退化语义**：跨卷时复制 + 删源，
 * 而且不报 EXDEV。这正是 T45 复现出来的那条分支，也是本文件要盯死的那条分支。
 */
const api = {
  Uri: { file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }) },
  EndOfLine: { CRLF: 2 },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: root } }],
    // A2（T62）：真宿主用 `onDidChangeTextDocument` 当同源变更观察器；缺了它能力层会判
    // 「没有证据源」而统一拒写（observation-gap），那会把本文件要验的原语问题盖掉。
    onDidChangeTextDocument: () => ({ dispose() {} }),
    openTextDocument: async () => api.__doc,
    fs: {
      createDirectory: async (uri) => { safe(uri.fsPath); fs.mkdirSync(uri.fsPath, { recursive: true }) },
      // ★ 退化桩：**不抛 EXDEV**，而是"先复制、再删源"（VS Code `pfs.Promises.rename`）。
      rename: async (from, to, opts) => {
        safe(from.fsPath); safe(to.fsPath)
        assert.equal(opts?.overwrite, false, 'provider rename 必须显式 overwrite:false')
        seen.renames += 1
        fs.copyFileSync(from.fsPath, to.fsPath)
        seen.copies += 1
        fs.unlinkSync(from.fsPath)
        seen.deletes += 1
      },
      delete: async () => { seen.deletes += 1; throw new Error('forbidden workspace.fs.delete') },
      copy: async () => { seen.copies += 1; throw new Error('forbidden workspace.fs.copy') },
    },
  },
  window: { showWarningMessage: async () => '删除' },
}
globalThis.__t46 = api
registerHooks({
  resolve(spec, ctx, next) {
    if (spec !== 'vscode') return next(spec, ctx)
    const body = 'export const Uri=globalThis.__t46.Uri;export const workspace=globalThis.__t46.workspace;'
      + 'export const window=globalThis.__t46.window;export const EndOfLine=globalThis.__t46.EndOfLine;'
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(body)}` }
  },
})

const { createHost } = await import('../src/vscode-host.js')
const { createCapabilities } = await import('../src/capabilities.js')
const { GrantStore } = await import('../../dsh-vscode-kit/src/grant.js')

/**
 * 把 `fs.promises.rename` 换成可控实现 —— 宿主用的就是这颗对象上的方法
 * （`vscode-host.js` 里 `promises as fsp` 取的是同一个对象，且**调用时才查表**），
 * 所以这里能如实注入 EXDEV / EPERM，而不必伪造整个文件系统。
 */
function stubRename(t, impl) {
  const original = fsp.rename
  fsp.rename = impl
  t.after(() => { fsp.rename = original })
}

/** 走**真实**宿主 + 真实能力层跑一次 `vscode.deleteFile`。 */
async function deleteThroughBridge(file) {
  const host = createHost({ appendLine: () => {} })
  api.__doc = {
    uri: api.Uri.file(file),
    version: 1,
    isDirty: false,
    eol: 1,
    lineCount: 1,
    lineAt: () => ({ text: ORIGINAL }),
    getText: () => ORIGINAL,
  }
  const state = await host.readDocumentState(file)
  const st = fs.statSync(file)
  const link = {}
  const grants = new GrantStore()
  grants.adopt({ id: 'c'.repeat(32), epoch: 'd'.repeat(32), link })
  const caps = createCapabilities(host, { grants })
  const params = {
    file,
    expectedVersion: 1,
    expectedIncarnation: state.incarnation,
    expectedDisk: { mtime: Math.floor(st.mtimeMs), size: st.size },
    grant: { id: 'c'.repeat(32), epoch: 'd'.repeat(32) },
  }
  try {
    return { result: await caps.dispatch('vscode.deleteFile', params, { link }), host }
  } catch (err) {
    return { error: { code: err.code, data: err.data }, host }
  }
}

const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
const quarantineDir = () => join(root, '.dsh-quarantine')

/**
 * ★ 主回归：跨卷注入 `EXDEV` → `-32603 quarantine-failed`，**删除调用计数 0**，原件仍在。
 *
 * 这条在变异下必须变红：把原语换回 `workspace.fs.rename` 之后，走的是上面那个
 * 复制+删源的退化桩，`seen.deletes` 从 0 变 1（原始失败信息见 `work/t46-mutation/`）。
 */
test('★ T46 D1 跨卷 EXDEV → -32603 quarantine-failed，provider 未被调用、删除计数 0、原件不动', async (t) => {
  seen.renames = 0; seen.copies = 0; seen.deletes = 0
  const file = join(root, 'exdev.txt')
  fs.writeFileSync(file, ORIGINAL)
  // 只对"搬进隔离区"的这一次注入 EXDEV（其它 rename 走真实现）。
  stubRename(t, async (from, to) => {
    if (resolve(to).startsWith(resolve(quarantineDir()))) {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
    }
    return fs.promises.rename(from, to)
  })

  const { error } = await deleteThroughBridge(file)

  // ── 判据 1：**原语没有退化**（先查删除计数，变异时最先在这里变红）──
  assert.equal(seen.deletes, 0, '删除调用计数必须是 0（T46：任何分支都不许删）')
  assert.equal(seen.copies, 0, '复制调用计数必须是 0')
  assert.equal(seen.renames, 0,
    'provider 的 rename 一次都不许被调用：跨卷绕过它才不会被 copy+delete 掉')

  // ── 判据 2：错误契约如实 ──
  assert.equal(error?.code, -32603)
  assert.equal(error?.data?.reason, 'quarantine-failed')
  assert.equal(error?.data?.hostCode, 'EXDEV')
  assert.equal(error?.data?.crossVolume, true)
  assert.equal(error?.data?.mayHaveApplied, false)

  // ── 判据 3：两份都在该在的地方（原件原处、隔离区里没有半成品）──
  assert.equal(read(file), ORIGINAL, '原件必须原地不动、正文不动')
  const qdir = quarantineDir()
  assert.equal(fs.existsSync(qdir) ? fs.readdirSync(qdir).length : 0, 0,
    '隔离区里不许出现任何东西（EXDEV 就是"什么都没发生"）')
})

/**
 * 目标已存在 → **不覆盖**，原件不动，报 `EEXIST`（宿主层）。
 *
 * 为什么探目标而不是信 `rename` 的覆盖语义：POSIX 上 `rename(2)` 会**静默覆盖**，
 * 拿"拒绝删错文件"的机会去顶掉另一份字节是反向的数据丢失。
 */
test('T46 D2 目标已存在 → EEXIST、不覆盖、原件不动', async (t) => {
  seen.renames = 0; seen.copies = 0; seen.deletes = 0
  const src = join(root, 'occupied-src.txt')
  const dest = join(root, 'occupied-dest.txt')
  fs.writeFileSync(src, ORIGINAL)
  fs.writeFileSync(dest, 'ALREADY_THERE')
  stubRename(t, fs.promises.rename.bind(fsp))

  const host = createHost({ appendLine: () => {} })
  let error = null
  try {
    await host.quarantineRename(src, dest)
  } catch (err) {
    error = { code: err.code, data: err.data }
  }

  assert.equal(error?.code, -32603)
  assert.equal(error?.data?.reason, 'quarantine-rename-failed')
  assert.equal(error?.data?.hostCode, 'EEXIST', '目标已存在必须报 EEXIST（不是 EXDEV，也不是成功）')
  assert.equal(read(src), ORIGINAL, '原件不许被动')
  assert.equal(read(dest), 'ALREADY_THERE', '目标字节不许被顶掉')
  assert.equal(seen.renames, 0, '这次连 provider 都不该被碰到')
  assert.equal(seen.deletes, 0)
})

/** 权限/已存在竞态（Windows 上 rename 到已存在目标就是 EPERM）→ 与 EXDEV 分开映射。 */
test('T46 D2b EPERM 与 EXDEV 分开映射（同一个 reason，不同 hostCode）', async (t) => {
  seen.renames = 0; seen.deletes = 0
  const src = join(root, 'eperm-src.txt')
  const dest = join(root, 'eperm-dest.txt')
  fs.writeFileSync(src, ORIGINAL)
  stubRename(t, async () => {
    throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
  })

  const host = createHost({ appendLine: () => {} })
  let error = null
  try {
    await host.quarantineRename(src, dest)
  } catch (err) {
    error = { code: err.code, data: err.data }
  }

  assert.equal(error?.code, -32603)
  assert.equal(error?.data?.hostCode, 'EPERM')
  assert.equal(error?.data?.crossVolume, undefined, 'EPERM 不是跨卷，别冒充 EXDEV')
  assert.equal(read(src), ORIGINAL)
  assert.equal(read(dest), null, '失败就是失败：目标上不许有半成品')
  assert.equal(seen.deletes, 0)
})

/**
 * 正常路径：同卷搬家用的是 `fs.promises.rename`，provider 一次都没被调用，
 * 并且搬完之后**两份字节一致**（搬家不是复制，也不是删除）。
 */
test('★ T46 D3 正常归档走 fs.promises.rename：provider 未被调用、字节无损', async (t) => {
  seen.renames = 0; seen.copies = 0; seen.deletes = 0
  const file = join(root, 'happy.txt')
  fs.writeFileSync(file, ORIGINAL)

  const { result, error } = await deleteThroughBridge(file)

  assert.equal(seen.renames, 0, 'provider rename 一次都不许被调用')
  assert.equal(seen.deletes, 0, '删除调用计数必须是 0')
  assert.equal(error, undefined)
  assert.equal(result.quarantined, true)
  assert.equal(result.bytesChanged, false)
  assert.equal(fs.existsSync(file), false, '归档后原名下不该还有文件')
  assert.equal(read(result.to), ORIGINAL, '隔离体必须原样')
  assert.equal(read(result.to + '.dsh-deleted'), null)
})
