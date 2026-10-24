/**
 * `vscode.applyEdit` + 会话授权绑定门（`-32010`）的测试。
 *
 * 两个层次各测一半，缺一不可：
 *  ① **能力层**（`createCapabilities`）：参数/路径/坐标校验、执行前复核、
 *     返回形状（`saved:false`）—— 用真文件系统 + 假宿主。
 *  ② **连接层**（`createConnector`）：真 TCP + 真 kit server，验 `bridge.grant` /
 *     `bridge.grantRevoke` 入站、断线即失效、两道门串起来的端到端形状。
 *
 * 变异测试（铁律 9）针对的就是这个文件里的 ★ 用例：
 *   - 摘掉发送前门（`index.js` 的 `_writeGate`）→ kit 侧 `editing-grant.test.js` 变红；
 *   - 摘掉执行前复核（`capabilities.js` 的 `grantGate(method, params, ctx)`）→ 本文件变红；
 *   - 坐标转两次（`toApiRange` 再减一）→ 本文件变红。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { startBridgeServer } from '../../dsh-vscode-kit/src/server.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { createCapabilities, CAPABILITIES, toApiRange } from '../src/capabilities.js'
import { createConnector } from '../src/connector.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

/** 真工作区：`<tmp>/ws/` 里放一个 a.js，外加一个在根之外的 secret.js。 */
function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-apply-edit-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'hello world\nsecond line\n')
  writeFileSync(join(base, 'secret.js'), 'outside\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/** 假宿主的默认"文档版本"（T30：`applyEdit` 的 `expectedVersion` 必须与它一致）。 */
const DEFAULT_VERSION = 1

/**
 * 假宿主的默认"文档实例身份"（T34 引入；**T35 起 `expectedIncarnation` 无条件必填**）。
 *
 * 脚手架默认带上它，理由与 `DEFAULT_VERSION` 相同：本文件绝大多数用例要验的不是
 * "锚点缺失"而是范围/路径/授权/身份之类的别的东西，缺锚点会在**锚点形状门**就短路，
 * 那些性质根本跑不到。想造化身场景的用例自己覆盖（`editParams(file, { expectedIncarnation: 'x' })`
 * 或改 `host.setIncarnation`）。
 */
const DEFAULT_INCARNATION = 'inc-default'

/** 假 VS Code 宿主（真文件系统校验 + 记录 applyEditText 调用）。 */
function makeHost(
  roots,
  {
    trusted = true, applied = true, applyEditText, documentShape,
    version = DEFAULT_VERSION, incarnation = DEFAULT_INCARNATION,
  } = {},
) {
  const calls = []
  // 每个文件一个可改的版本号（T30）：`host.setVersion(abs, n)` 模拟"缓冲区被人改过"。
  const versions = new Map()
  const versionOf = (abs) => (versions.has(abs) ? versions.get(abs) : version)
  // 每个文件一个可改的化身（T34）：`host.setIncarnation(abs, s)` 模拟"关掉再打开"。
  const incarnations = new Map()
  const incarnationOf = (abs) => (incarnations.has(abs) ? incarnations.get(abs) : incarnation)
  const host = {
    calls,
    versions,
    versionOf,
    setVersion: (abs, v) => { versions.set(abs, v) },
    incarnations,
    incarnationOf,
    setIncarnation: (abs, s) => { incarnations.set(abs, s) },
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
    // 文档状态（T30）：版本号来自 `versions`（默认 DEFAULT_VERSION），其余字段按磁盘文本算。
    // 想造"版本不符 / 超限 / 脏文档"的场景就改 `versions` 或覆盖本方法。
    readDocumentState: async (abs, { includeText = false } = {}) => {
      const text = readFileSync(abs, 'utf8')
      return {
        version: versionOf(abs),
        // T34/T35：读侧报的化身，与写侧比对的是同一份"文档实例"身份。
        incarnation: incarnationOf(abs),
        isDirty: false,
        eol: text.includes('\r\n') ? 'crlf' : 'lf',
        lineCount: text.split('\n').length,
        textLength: text.length,
        byteLength: Buffer.byteLength(text, 'utf8'),
        ...(includeText === true ? { text } : {}),
      }
    },
    // 目标范围当前文本（T30 的 `expectedRangeText` 比对用），**0-based** range。
    readRangeText: async (abs, range) => {
      const lines = readFileSync(abs, 'utf8').split('\n')
      const at = (i) => lines[i] ?? ''
      if (range.start.line === range.end.line) {
        return at(range.start.line).slice(range.start.column, range.end.column)
      }
      const parts = [at(range.start.line).slice(range.start.column)]
      for (let i = range.start.line + 1; i < range.end.line; i += 1) parts.push(at(i))
      parts.push(at(range.end.line).slice(0, range.end.column))
      return parts.join('\n')
    },
    // 范围边界检查的数据源（评审 F8）：按真文件的行数/行长报形状（"文档"= 磁盘内容，
    // 单测里没有未落盘的缓冲区）。想造越界场景就传 documentShape 覆盖。
    readDocumentShape: documentShape ?? (async (abs, lines = []) => {
      const linesInFile = readFileSync(abs, 'utf8').split(/\r?\n/)
      return {
        lineCount: linesInFile.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= linesInFile.length
          ? linesInFile[n - 1].length
          : null)),
      }
    }),
    // 真适配器（vscode-host.js）写后从编辑器取 `document.uri.fsPath` 报回来；假宿主单测没有
    // 编辑器，就按"编辑器把它落到了我收到的这个路径"如实回报 —— **必须报**，因为能力层现在
    // 拿文档身份当判据（评审 R3-1）：不报就是 -32603 document-identity-unavailable。
    // 想造"写到别处"或"报不出身份"的场景就传 applyEditText 覆盖。
    applyEditText: applyEditText ?? (async (abs, range, text) => {
      calls.push({ abs, range, text })
      return { applied, documentPath: abs }
    }),
    log: () => {},
  }
  return host
}

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)

/** 一套"已授权"的环境：能力层 + 授权表 + 活连接。 */
function grantedEnv({
  root, trusted = true, applied = true, link = { name: 'link-a' }, documentShape, applyEditText,
  version = DEFAULT_VERSION,
} = {}) {
  const grants = new GrantStore()
  grants.adopt({ id: ID_A, epoch: EPOCH_A, link })
  const host = makeHost([root], { trusted, applied, documentShape, applyEditText, version })
  const caps = createCapabilities(host, { grants })
  return { grants, host, caps, link }
}

const FILE = (root) => join(root, 'a.js')

/**
 * 入口参数一律 1-based（协议对外口径）。
 *
 * T30 起 `expectedVersion` 是**必填**字段，所以脚手架默认带上 `DEFAULT_VERSION`；
 * ★ **T35 起 `expectedIncarnation` 同样无条件必填**（缺/空串/非字符串 → `-32602`
 * `reason:'expected-incarnation-missing'`），所以脚手架也默认带上 `DEFAULT_INCARNATION`。
 * 想造版本冲突的用例自己覆盖（`editParams(file, { expectedVersion: 0 })`），
 * 想造化身场景的用例覆盖 `expectedIncarnation`（传 `undefined` 就是"漏字段"）。
 */
function editParams(file, extra = {}) {
  return {
    file,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    text: 'HELLO',
    expectedVersion: DEFAULT_VERSION,
    expectedIncarnation: DEFAULT_INCARNATION,
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

// ---------------------------------------------------------------------------
// ① 能力层
// ---------------------------------------------------------------------------

test('applyEdit 正常路径：1-based → 0-based 只转一次，返回 saved:false', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const file = FILE(ws.root)
    const res = await caps.dispatch('vscode.applyEdit', editParams(file, {
      range: { start: { line: 2, column: 3 }, end: { line: 2, column: 8 } },
      text: 'HELLO',
    }), { link })

    assert.equal(res.applied, true)
    assert.equal(res.saved, false, 'saved 必须是 false（这一刀不落盘）')
    assert.equal(res.textLength, 5)
    assert.equal(res.file, file, 'file 回传规范化绝对路径')

    // ★ 坐标只减一次：入口 line 2/column 3 → API line 1/column 2。
    assert.equal(host.calls.length, 1)
    assert.deepEqual(host.calls[0].range, {
      start: { line: 1, column: 2 },
      end: { line: 1, column: 7 },
    })
    // 缓冲区没被保存：文件内容一个字节都没变。
    assert.equal(readFileSync(file, 'utf8'), 'hello world\nsecond line\n')
  } finally { ws.dispose() }
})

test('toApiRange 是纯减法，且 applyEdit 只调用它一次（二次转换会错行）', () => {
  assert.deepEqual(toApiRange({ start: { line: 1, column: 1 }, end: { line: 3, column: 4 } }), {
    start: { line: 0, column: 0 }, end: { line: 2, column: 3 },
  })
})

test('宿主拒绝编辑（applied:false）→ 如实回 applied:false，不当成功', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv({ root: ws.root, applied: false })
    const res = await caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link })
    assert.equal(res.applied, false)
    assert.equal(res.saved, false)
  } finally { ws.dispose() }
})

test('参数校验：file/text/range 不合法 → -32602（范围校验属参数层，不是业务判断）', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv({ root: ws.root })
    const file = FILE(ws.root)
    const cases = [
      ['file 缺失', editParams(undefined)],
      ['file 空串', editParams('  ')],
      ['text 非字符串', editParams(file, { text: 42 })],
      ['range 缺失', editParams(file, { range: undefined })],
      ['line 为 0（1-based 不允许）', editParams(file, { range: { start: { line: 0, column: 1 }, end: { line: 1, column: 2 } } })],
      ['column 非整数', editParams(file, { range: { start: { line: 1, column: 1.5 }, end: { line: 1, column: 2 } } })],
      ['反向范围', editParams(file, { range: { start: { line: 3, column: 1 }, end: { line: 2, column: 9 } } })],
      ['同行 col 反向', editParams(file, { range: { start: { line: 1, column: 9 }, end: { line: 1, column: 2 } } })],
    ]
    for (const [label, params] of cases) {
      await expectCode(caps.dispatch('vscode.applyEdit', params, { link }), ERR.INVALID_PARAMS, label)
    }
    assert.equal((await caps.dispatch('vscode.applyEdit', editParams(file), { link })).applied, true)
  } finally { ws.dispose() }
})

test('路径守卫：工作区外拒 -32602，不存在的文件 -32003', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv({ root: ws.root })
    const outside = join(ws.base, 'secret.js')
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(outside), { link }), ERR.INVALID_PARAMS, 'outside')
    assert.equal(err.data.reason, 'outside-workspace')
    // 相对路径锚在工作区根，允许
    assert.equal((await caps.dispatch('vscode.applyEdit', editParams('a.js'), { link })).applied, true)
    await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'nope.js')), { link }),
      ERR.NOT_FOUND, 'missing')
  } finally { ws.dispose() }
})

test('路径守卫：符号链接一律拒（不当"解析后放行"）', async (t) => {
  const ws = tempWorkspace()
  try {
    const linkPath = join(ws.root, 'link.js')
    try {
      symlinkSync(join(ws.base, 'secret.js'), linkPath, 'file')
    } catch (err) {
      // Windows 未开开发者模式时建符号链接要管理员权限：跳过，不留假绿。
      t.skip(`cannot create symlink here: ${err.code ?? err.message}`)
      return
    }
    const { caps, link } = grantedEnv({ root: ws.root })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(linkPath), { link }), ERR.INVALID_PARAMS, 'symlink')
    assert.equal(err.data.reason, 'symlink')
  } finally { ws.dispose() }
})

test('★ F1 工作区根本身是 junction → -32602 link-root，写宿主零调用', async (t) => {
  const ws = tempWorkspace()
  try {
    // base/real 是真目录；base/rootj 是指向它的 junction（Windows 不需管理员权限）。
    const real = join(ws.base, 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'a.js'), 'hello world\nsecond line\n')
    const rootj = join(ws.base, 'rootj')
    try {
      symlinkSync(real, rootj, 'junction')
    } catch (err) {
      t.skip(`cannot create junction here: ${err.code ?? err.message}`)
      return
    }
    // 字面根 = junction。F1 的病根正是"realpath(根) 把 reals 当新根" → 一路放行。
    const { host, caps, link } = grantedEnv({ root: rootj })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(rootj, 'a.js')), { link }),
      ERR.INVALID_PARAMS, 'junction-root')
    assert.equal(err.data.reason, 'link-root', '根是链接就说明「工作区内」这个前提本身失效')
    assert.equal(host.calls.length, 0, '任何拒绝路径都不得触碰写宿主')
  } finally { ws.dispose() }
})

test('★ F1 工作区根的**祖先**是 junction → -32602 link-root（链要走到卷根）', async (t) => {
  const ws = tempWorkspace()
  try {
    const realDir = join(ws.base, 'realdir')
    mkdirSync(join(realDir, 'ws'), { recursive: true })
    writeFileSync(join(realDir, 'ws', 'a.js'), 'hello world\nsecond line\n')
    const anc = join(ws.base, 'anc')
    try {
      symlinkSync(realDir, anc, 'junction')
    } catch (err) {
      t.skip(`cannot create junction here: ${err.code ?? err.message}`)
      return
    }
    // 根本身是普通目录，但它的父级是 junction —— 只查根会漏掉这一种。
    const root = join(anc, 'ws')
    const { host, caps, link } = grantedEnv({ root })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(root, 'a.js')), { link }),
      ERR.INVALID_PARAMS, 'junction-ancestor')
    assert.equal(err.data.reason, 'link-root')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('★ F1 工作区根是符号链接 → -32602 link-root（与 junction 同等对待）', async (t) => {
  const ws = tempWorkspace()
  try {
    const real = join(ws.base, 'real2')
    mkdirSync(real)
    writeFileSync(join(real, 'a.js'), 'hello world\nsecond line\n')
    const linkRoot = join(ws.base, 'linkroot')
    try {
      symlinkSync(real, linkRoot, 'dir')
    } catch (err) {
      t.skip(`cannot create dir symlink here: ${err.code ?? err.message}`)
      return
    }
    const { host, caps, link } = grantedEnv({ root: linkRoot })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(linkRoot, 'a.js')), { link }),
      ERR.INVALID_PARAMS, 'symlink-root')
    assert.equal(err.data.reason, 'link-root')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('★ F6 多根工作区一律拒写（不"匹配到哪个根就写哪个"）', async () => {
  const ws = tempWorkspace()
  const ws2 = tempWorkspace()
  try {
    writeFileSync(join(ws2.root, 'b.js'), 'other\n')
    const { host, caps, grants, link } = grantedEnv({ root: ws.root })
    // 第二个根接进来：同一个相对路径在两个窗口里可能是两个不同的文件，
    // 而 grant 只绑一个窗口 —— 挑一个写下去等于替用户选文件。
    host.workspaceRoots = () => [ws.root, ws2.root]
    for (const target of ['a.js', 'b.js', join(ws.root, 'a.js'), join(ws2.root, 'b.js')]) {
      const err = await expectCode(
        caps.dispatch('vscode.applyEdit', editParams(target), { link }),
        ERR.INTERNAL, `multi-root:${target}`)
      assert.equal(err.data.reason, 'multi-root')
    }
    assert.equal(host.calls.length, 0, '多根下宿主一次都不许被调')
    assert.equal(grants.size, 1, '拒绝不消耗凭证')
  } finally { ws.dispose(); ws2.dispose() }
})

test('★ F8 范围越界（end.line 超文档行数）→ -32602，不把非法范围交给宿主', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const file = FILE(ws.root) // a.js：3 行（"hello world" / "second line" / ""）
    const beyond = editParams(file, {
      range: { start: { line: 1, column: 1 }, end: { line: 9, column: 1 } },
    })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', beyond, { link }), ERR.INVALID_PARAMS, 'line-beyond')
    assert.equal(err.data.reason, 'range-beyond-document')

    // 行长越界同样是参数错误：宿主会自己 clamp，clamp 之后就"写错地方还报成功"。
    const longCol = editParams(file, {
      range: { start: { line: 1, column: 99 }, end: { line: 1, column: 120 } },
    })
    const err2 = await expectCode(
      caps.dispatch('vscode.applyEdit', longCol, { link }), ERR.INVALID_PARAMS, 'col-beyond')
    assert.equal(err2.data.reason, 'range-beyond-line')
    assert.equal(host.calls.length, 0, '非法范围绝不许变成一次真实写入')
  } finally { ws.dispose() }
})

test('★ F8 宿主读不出文档形状 → -32603 失败闭合（不跳过校验直接写）', async () => {
  const ws = tempWorkspace()
  try {
    const host = makeHost([ws.root], { documentShape: undefined })
    delete host.readDocumentShape // 老宿主：没有形状数据源
    const grants = new GrantStore()
    const link = { name: 'link-a' }
    grants.adopt({ id: ID_A, epoch: EPOCH_A, link })
    const caps = createCapabilities(host, { grants })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link }),
      ERR.INTERNAL, 'no-shape-source')
    assert.equal(err.data.hostField, 'readDocumentShape', '说清楚宿主缺哪个字段')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('未信任工作区：-32006 优先于绑定门（工作区不可信时连凭证都不讨论）', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = grantedEnv({ root: ws.root, trusted: false })
    // 连 grant 都不带
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root), { grant: undefined }), { link }),
      ERR.UNTRUSTED_WORKSPACE, 'untrusted')
    assert.equal(err.code, -32006)
  } finally { ws.dispose() }
})

test('★ 发送前的门：不带 grant 的写入 → -32010 no-grant，宿主一次都没被调', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root), { grant: undefined }), { link }),
      ERR.EDIT_NOT_BOUND, 'no-grant')
    assert.equal(err.data.reason, 'no-grant')
    assert.equal(err.data.method, 'vscode.applyEdit')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('★ 执行前复核：分派之后 grant 被撤销 → 仍必须在动手前拦下（零写入）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, grants, link } = grantedEnv({ root: ws.root })
    // 绕过 dispatch 的门，直接进 handler —— 模拟"门过了、await 缝隙里被撤销"。
    grants.revoke(ID_A, 'revoked')
    const err = await expectCode(
      caps.handlers['vscode.applyEdit'](editParams(FILE(ws.root)), { link }),
      ERR.EDIT_NOT_BOUND, 'revoked-before-write')
    assert.equal(err.data.reason, 'grant-revoked')
    assert.equal(host.calls.length, 0, '复核失败后宿主绝不能被调用')
  } finally { ws.dispose() }
})

test('★ 执行前复核：grant 绑在别的连接上 → grant-generation-stale', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps } = grantedEnv({ root: ws.root })
    const err = await expectCode(
      caps.handlers['vscode.applyEdit'](editParams(FILE(ws.root)), { link: { name: 'link-b' } }),
      ERR.EDIT_NOT_BOUND, 'other-link')
    assert.equal(err.data.reason, 'grant-generation-stale')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('★ 执行前复核：epoch 对不上 → grant-generation-stale', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({ root: ws.root })
    const err = await expectCode(
      caps.handlers['vscode.applyEdit'](
        editParams(FILE(ws.root), { grant: { id: ID_A, epoch: 'c'.repeat(32) } }), { link }),
      ERR.EDIT_NOT_BOUND, 'epoch')
    assert.equal(err.data.reason, 'grant-generation-stale')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('★ 执行前复核：目标窗口已没了 → target-gone（连接消失由墓碑表达，无外部抢跑）', async () => {
  const ws = tempWorkspace()
  try {
    const grants = new GrantStore()
    const link = { name: 'link-a' }
    grants.adopt({ id: ID_A, epoch: EPOCH_A, link })
    const host = makeHost([ws.root])
    const caps = createCapabilities(host, { grants })
    // 目标窗口消失 = 承载连接断了 = 该连接上的 grant 全部墓碑化（§6.1.1 行 3）。
    // 评审 F4：存活检查必须在**规定顺序**里判 —— 不许在外层用"活连接"抢先短路，
    // 否则多因同时命中时（墓碑 + epoch 错）回答的因由就取决于外层顺序了。
    grants.closeLink(link)
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link }),
      ERR.EDIT_NOT_BOUND, 'target-gone')
    // 评审 F4：扩展侧的行 3 理由是 `grant-generation-stale`（契约 ①-c 表第 3 行）——
    // `target-gone` 是 **DSH 在途** 那一条的理由（§6.1 ③ 表），两侧措辞本就不同。
    assert.equal(err.data.reason, 'grant-generation-stale')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('读操作不要求授权：没有 grant 时读能力照常过门（不是 -32010）', async () => {
  const ws = tempWorkspace()
  try {
    const { caps } = grantedEnv({ root: ws.root })
    // 没有活动编辑器 → -32003（业务上"没东西可选"），而不是 -32010（凭证问题）。
    await expectCode(caps.dispatch('vscode.getSelection', {}, {}), ERR.NOT_FOUND, 'getSelection')
    assert.deepEqual(await caps.dispatch('vscode.listOpenEditors', {}, {}),
      { editors: [], total: 0, truncated: false })
    assert.deepEqual(await caps.dispatch('vscode.getDiagnostics', {}, {}),
      { total: 0, files: [], truncated: false })
  } finally { ws.dispose() }
})

test('能力清单里登记了 applyEdit（§5.1：没声明返回清单的能力不许进 CAPABILITIES）', () => {
  assert.ok(CAPABILITIES.includes('vscode.applyEdit'))
})

// ---------------------------------------------------------------------------
// ② 连接层：真 TCP + 真 kit server
// ---------------------------------------------------------------------------

function waitFor(fn, { timeoutMs = 5000, intervalMs = 20, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve() } else if (Date.now() - started > timeoutMs) {
        clearInterval(iv); reject(new Error(`timed out waiting for ${label}`))
      }
    }, intervalMs)
    iv.unref?.()
  })
}

async function startServer(home) {
  const server = await startBridgeServer({
    dshHome: home,
    dshVersion: '0.2.1-rc.2',
    capabilities: ['bridge.ping', 'bridge.hello', 'bridge.grant', 'bridge.grantRevoke'],
    portRange: [7580, 7589],
    onRequest: (method) => {
      if (method === 'bridge.ping') return { pong: true }
      if (method === 'bridge.hello') return { ok: true, protocolVersion: 1 }
      throw new Error(`unexpected ${method}`)
    },
  })
  return server
}

/** 起一个"编辑器侧"：真 connector + 能力层，返回收口。 */
async function startEditor({ home, root, trusted = true }) {
  const grants = new GrantStore()
  const linkState = { link: null }
  const host = makeHost([root], { trusted })
  // 评审 F4：写入门不再接受 getLiveLink —— 连接存活只能按规定顺序从墓碑里读。
  const caps = createCapabilities(host, { grants })
  const conn = createConnector({
    dispatch: caps.dispatch, grants, linkState, dshHome: home, pollIntervalMs: 20,
    isTrusted: () => trusted,
  })
  await conn.reconnect()
  return { grants, linkState, host, conn, caps }
}

test('bridge.grant 入站：存下 DSH 发来的 id/epoch，之后的写入放行', async () => {
  const ws = tempWorkspace()
  const home = join(ws.base, 'home')
  mkdirSync(home)
  const server = await startServer(home)
  const ed = await startEditor({ home, root: ws.root })
  try {
    await waitFor(() => server.trusted.size === 1, { label: 'link' })
    const [link] = [...server.trusted]
    const id = 'd'.repeat(32); const epoch = 'e'.repeat(32)
    link.notify('bridge.grant', { grant: { id, epoch, sessionId: 's1' } }, { withToken: true })
    await waitFor(() => ed.grants.lookup(id)?.kind === 'active', { label: 'grant adopted' })

    const res = await link.request('vscode.applyEdit', {
      file: 'a.js',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
      text: 'HELLO',
      // T30：写入必须带版本锚点（真链路上这条也是必填项，缺了会被 -32602 拒）。
      expectedVersion: ed.host.versionOf(join(ws.root, 'a.js')),
      // ★ T35：化身锚点同样无条件必填 —— 这就是真链路上那份"两条锚点一起"的形状。
      expectedIncarnation: ed.host.incarnationOf(join(ws.root, 'a.js')),
      grant: { id, epoch },
    })
    assert.equal(res.applied, true)
    assert.equal(res.saved, false)
    assert.equal(ed.host.calls.length, 1, '宿主应被调用一次')
    // ★ 执行前复核拿到的 range 必须是 0-based（只转一次）
    assert.deepEqual(ed.host.calls[0].range, {
      start: { line: 0, column: 0 }, end: { line: 0, column: 5 },
    })
  } finally { ed.conn.stop(); await server.close(); ws.dispose() }
})

test('bridge.grant 形状不对 → -32602（本端只存 DSH 生成的 128-bit hex）', async () => {
  const ws = tempWorkspace()
  const home = join(ws.base, 'home')
  mkdirSync(home)
  const server = await startServer(home)
  const ed = await startEditor({ home, root: ws.root })
  try {
    await waitFor(() => server.trusted.size === 1, { label: 'link' })
    const [link] = [...server.trusted]
    const err = await expectCode(
      link.request('bridge.grant', { grant: { id: 'short', epoch: 'e'.repeat(32) } }),
      ERR.INVALID_PARAMS, 'bad-shape')
    assert.equal(err.data.method, 'bridge.grant')
    assert.equal(ed.grants.size, 0)
  } finally { ed.conn.stop(); await server.close(); ws.dispose() }
})

test('★ 断线即失效：连接消失后同一份 grant 的写入 → -32010（不依赖 DSH 补发）', async () => {
  const ws = tempWorkspace()
  const home = join(ws.base, 'home')
  mkdirSync(home)
  const server = await startServer(home)
  const ed = await startEditor({ home, root: ws.root })
  try {
    await waitFor(() => server.trusted.size === 1, { label: 'link' })
    const [link] = [...server.trusted]
    const id = 'f'.repeat(32); const epoch = '1'.repeat(32)
    link.notify('bridge.grant', { grant: { id, epoch, sessionId: 's1' } }, { withToken: true })
    await waitFor(() => ed.grants.lookup(id)?.kind === 'active', { label: 'grant adopted' })
    const edLink = ed.linkState.link
    assert.ok(edLink, '编辑器侧应记住承载连接的对象')

    // DSH 侧连接断掉 → 编辑器侧必须**本地**把 grant 置 disconnected。
    link.socket.destroy()
    await waitFor(() => ed.grants.lookup(id)?.kind === 'tombstone', { label: 'grant invalidated' })
    assert.equal(ed.linkState.link, null, '活连接槽必须被清空')

    const params = {
      file: 'a.js',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      text: 'x',
      grant: { id, epoch },
    }
    // 承载连接没了 → 契约 ①-c 第 3 行（扩展侧 `grant-generation-stale`）；
    // 关键是它**失败闭合**：绝不许"退回当前活跃编辑器"执行。
    const err = await expectCode(ed.caps.dispatch('vscode.applyEdit', params, { link: edLink }),
      ERR.EDIT_NOT_BOUND, 'after-disconnect')
    assert.equal(err.data.reason, 'grant-generation-stale')
    assert.equal(ed.host.calls.length, 0)
  } finally { ed.conn.stop(); await server.close(); ws.dispose() }
})

test('bridge.grantRevoke 入站：撤销后写入 → -32010 grant-revoked，且幂等', async () => {
  const ws = tempWorkspace()
  const home = join(ws.base, 'home')
  mkdirSync(home)
  const server = await startServer(home)
  const ed = await startEditor({ home, root: ws.root })
  try {
    await waitFor(() => server.trusted.size === 1, { label: 'link' })
    const [link] = [...server.trusted]
    const id = '2'.repeat(32); const epoch = '3'.repeat(32)
    link.notify('bridge.grant', { grant: { id, epoch, sessionId: 's1' } }, { withToken: true })
    await waitFor(() => ed.grants.lookup(id)?.kind === 'active', { label: 'grant adopted' })

    assert.deepEqual(await link.request('bridge.grantRevoke', { id }), { ok: true, revoked: true })
    // 幂等：撤销第二次不报错，只是 revoked:false。
    assert.deepEqual(await link.request('bridge.grantRevoke', { id }), { ok: true, revoked: false })

    const err = await expectCode(link.request('vscode.applyEdit', {
      file: 'a.js',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      text: 'x',
      grant: { id, epoch },
    }), ERR.EDIT_NOT_BOUND, 'after-revoke')
    assert.equal(err.data.reason, 'grant-revoked')
    assert.equal(ed.host.calls.length, 0)
  } finally { ed.conn.stop(); await server.close(); ws.dispose() }
})

test('未信任工作区经真实链路：门在信任之前跑（凭证先说），带合法 grant 才轮到 -32006', async () => {
  const ws = tempWorkspace()
  const home = join(ws.base, 'home')
  mkdirSync(home)
  const server = await startServer(home)
  const ed = await startEditor({ home, root: ws.root, trusted: false })
  const params = {
    file: 'a.js',
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    text: 'x',
  }
  try {
    await waitFor(() => server.trusted.size === 1, { label: 'link' })
    const [link] = [...server.trusted]

    // ① 没凭证：**仍然是 -32006**（评审 F7）。
    //    旧实现让连接层的绑定门抢在信任检查前面，于是同一个"工作区没被信任"的事实
    //    会随「带不带 grant」变成两种回答 —— 调用方据此分不清"我该去信任工作区"
    //    还是"我该去申请凭证"。信任是更前置的前提，所以门要先问它。
    const noGrant = await expectCode(link.request('vscode.applyEdit', params),
      ERR.UNTRUSTED_WORKSPACE, 'untrusted-no-grant')
    assert.equal(noGrant.code, -32006)

    // ② 带合法 grant：门过了，轮到信任检查 → -32006。宿主一次都没被调。
    const id = '4'.repeat(32); const epoch = '5'.repeat(32)
    link.notify('bridge.grant', { grant: { id, epoch, sessionId: 's1' } }, { withToken: true })
    await waitFor(() => ed.grants.lookup(id)?.kind === 'active', { label: 'grant adopted' })
    const bot = await expectCode(
      link.request('vscode.applyEdit', { ...params, grant: { id, epoch } }),
      ERR.UNTRUSTED_WORKSPACE, 'untrusted-with-grant')
    assert.equal(bot.code, -32006)
    assert.equal(ed.host.calls.length, 0, '未信任工作区里宿主绝不能被调用')
  } finally { ed.conn.stop(); await server.close(); ws.dispose() }
})

// ---------------------------------------------------------------------------
// ①-d 检查之后的窗口（评审 R2-1）与判据更换（评审 R3-1）
//
// 三条用例针对**同一个**时间窗口的不同落点：
//   - 换目录发生在 `await readDocumentShape`（打开文档，真实让出点）→ 写前重验拦住，
//     写宿主零调用；
//   - 换目录发生在 `applyEditText` 内部且**持续到写后复核**（真机上就是 VS Code 落盘那
//     一刻）→ 拦不住发生，写后 re-realpath 采样到差异，`-32603 path-changed-after-write`；
//   - 换目录发生在 `applyEditText` 内部但**写完立刻换回**（ABA）→ 写后 re-realpath 看到的
//     还是原路径，**它看不出来**。这条由"写入文档身份"兜住（`-32602
//     document-identity-mismatch`）：文件系统没有记忆，缓冲区身份有。
//
// 所以：写后复核是**采样**，不是"所有替换都会被它发现"的保证 —— 别把它写成后者。
// 用 junction 而不是符号链接：Windows 上建 junction 不需要管理员/开发者模式，
// 这几条用例因此在 CI 上真的会跑（建不出来就 skip，绝不假绿）。
// ---------------------------------------------------------------------------

/** 把工作区根换成指向 `<base>/outside` 的 junction；返回 false 表示本机建不出来。 */
function swapRootToJunction(ws) {
  const outside = join(ws.base, 'outside')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'a.js'), 'outside content\nsecond line\n')
  const stash = join(ws.base, 'ws_stashed')
  renameSync(ws.root, stash)
  try {
    symlinkSync(outside, ws.root, 'junction')
    return { outside, stash }
  } catch {
    renameSync(stash, ws.root) // 还原，不留半换状态
    return null
  }
}

/** 把 junction 摘掉、把原工作区换回来（ABA 的 A）。必须真的摘链接，不能递归删。 */
function unswapRoot(ws, swapped) {
  try { rmdirSync(ws.root) } catch { rmSync(ws.root, { force: true }) }
  renameSync(swapped.stash, ws.root)
}

test('★ R2-1 读文档形状期间目录被换成 junction → 写前重验拦住，写宿主零调用', async (t) => {
  const ws = tempWorkspace()
  try {
    let swapped = null
    const { host, caps, link } = grantedEnv({
      root: ws.root,
      // 这个 await 就是审查指出的窗口：形状"读完"时，目录已经不是刚才验过的那个了。
      documentShape: async (abs, lines = []) => {
        swapped = swapRootToJunction(ws)
        return { lineCount: 3, lineLengths: lines.map(() => 5) }
      },
    })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link }),
      ERR.INVALID_PARAMS, 'path-changed')
    if (!swapped) { t.skip('cannot create junction here'); return }
    assert.equal(err.data.reason, 'path-changed', '窗口内换了目标：说的是"位置变了"，不是"参数错了"')
    assert.equal(host.calls.length, 0, '写前重验失败 → 一个字节都不交给写宿主')
  } finally { ws.dispose() }
})

test('★ R2-1 目录在写期间被换掉且未换回 → 写后复核采样到差异，不报成功（-32603 path-changed-after-write）', async (t) => {
  const ws = tempWorkspace()
  try {
    let swapped = null
    const { host, caps, link } = grantedEnv({
      root: ws.root,
      applyEditText: async (abs, range, text) => {
        host.calls.push({ abs, range, text })
        // 真机的样子：applyEdit 内部落盘时，目录已经被换成了 junction。
        swapped = swapRootToJunction(ws)
        // 编辑器如实报它写到的那个文档（junction 后面的 outside）。
        const documentPath = swapped ? join(swapped.outside, 'a.js') : abs
        return { applied: true, documentPath }
      },
    })
    let result = null
    let thrown = null
    try {
      result = await caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link })
    } catch (err) { thrown = err }
    if (!swapped) { t.skip('cannot create junction here'); return }
    assert.equal(host.calls.length, 1, '写入确实发生过（这一步拦不住发生，只保证不静默成功）')
    assert.ok(thrown, '路径被换掉之后**不许**返回成功结果')
    assert.equal(thrown.code, ERR.INTERNAL)
    assert.equal(thrown.data.reason, 'path-changed-after-write')
    assert.notEqual(result?.applied, true, 'applied 绝不能是 true')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ①-d' 写入文档身份（评审 R3-1）—— ABA 的判据
// ---------------------------------------------------------------------------

test('★ R3-1 ABA：写下时目录是 junction、写完立刻换回 → 写后复核看不出来，文档身份拦得住（-32602）', async (t) => {
  const ws = tempWorkspace()
  try {
    let swapped = null
    let sawDuringWrite = null
    const { host, caps, link } = grantedEnv({
      root: ws.root,
      // 评审的复刻：检查时是好的 → 宿主调用瞬间路径是 junction（写到工作区外）
      // → 立刻换回 → 写后 re-realpath 又看到原路径。写后复核在这一步必然是**通过**的，
      // 所以只有"这次编辑落在哪个文档"能说明问题。
      applyEditText: async (abs, range, text) => {
        host.calls.push({ abs, range, text })
        swapped = swapRootToJunction(ws)
        if (!swapped) return { applied: false, documentPath: abs }
        const documentPath = join(swapped.outside, 'a.js') // 编辑器：我写的是这个文档
        writeFileSync(documentPath, text)                  // 真的写到工作区外
        sawDuringWrite = documentPath
        unswapRoot(ws, swapped)                            // 立刻换回（ABA 的第二个 A）
        return { applied: true, documentPath }
      },
    })
    let result = null
    let thrown = null
    try {
      result = await caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link })
    } catch (err) { thrown = err }
    if (!swapped) { t.skip('cannot create junction here'); return }

    assert.equal(host.calls.length, 1, '写入确实发生过')
    assert.ok(result === null, `ABA 不许返回成功结果，实际拿到 ${JSON.stringify(result)}`)
    assert.ok(thrown, '必须抛错')
    // 关键：理由必须是"写入文档与验证路径不一致"，**不是**写后复核的 path-changed-after-write。
    // 换回之后 re-realpath 看到的仍是原路径，所以写后复核在这条序列里是放行的 ——
    // 这正是评审说的"写后复核看不出来"，也是这两条判据的分界。
    assert.equal(thrown.code, ERR.INVALID_PARAMS)
    assert.equal(thrown.data.reason, 'document-identity-mismatch')
    assert.equal(thrown.data.mayHaveApplied, true, '写可能已经落在工作区外 → 调用方需要人工核实')
    assert.equal(thrown.data.retryable, false)
    assert.match(thrown.message, /is not the path that was verified/,
      '错误要说清"写入文档与验证路径不一致"')
    assert.ok(thrown.message.includes(sawDuringWrite),
      `错误里要点名实际写入的文档（${sawDuringWrite}）：${thrown.message}`)
    assert.equal(readFileSync(join(swapped.outside, 'a.js'), 'utf8'), 'HELLO',
      '工作区外确实被写到了 —— 这才是要报出来的事实')
  } finally { ws.dispose() }
})

test('★ R3-1 适配器报不出文档身份 → 失败闭合 -32603，不报 applied:true', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = grantedEnv({
      root: ws.root,
      // 某些实现拿不到 "document.uri.fsPath" 这类身份（评审 R3-1 ③）：不许编一个
      // "就是我传进去的路径"糊过去，只能失败闭合。
      applyEditText: async (abs, range, text) => {
        host.calls.push({ abs, range, text })
        return { applied: true }
      },
    })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link }),
      ERR.INTERNAL, 'document-identity-unavailable')
    assert.equal(err.data.reason, 'document-identity-unavailable')
    assert.equal(err.data.mayHaveApplied, true, '已经写了，但落点不可确认')
    assert.equal(err.data.retryable, false)
    assert.match(err.message, /cannot confirm which document was written/)
    assert.equal(host.calls.length, 1, '写确实发生过（失败闭合要说实话：可能已经写入）')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ①-e 文档形状的完整性（评审 R2-3）
// ---------------------------------------------------------------------------

test('★ R2-3 行长信息缺失/畸形 → -32603，且不调用 applyEditText（缺失≠无上界）', async () => {
  const variants = [
    ['lineLengths 整个缺失', { lineCount: 3 }],
    ['lineLengths 不是数组', { lineCount: 3, lineLengths: 'nope' }],
    ['两个端点只回了一条', { lineCount: 3, lineLengths: [5] }],
    ['端点长度是 null', { lineCount: 3, lineLengths: [null, 5] }],
    ['端点长度是负数', { lineCount: 3, lineLengths: [-1, 5] }],
    ['端点长度是 NaN', { lineCount: 3, lineLengths: [NaN, 5] }],
    ['端点长度不是整数', { lineCount: 3, lineLengths: [1.5, 5] }],
    ['端点长度不是数字', { lineCount: 3, lineLengths: [{}, 5] }],
  ]
  for (const [label, shape] of variants) {
    const ws = tempWorkspace()
    try {
      const { host, caps, link } = grantedEnv({ root: ws.root, documentShape: async () => shape })
      const err = await expectCode(
        caps.dispatch('vscode.applyEdit', editParams(FILE(ws.root)), { link }),
        ERR.INTERNAL, label)
      assert.equal(host.calls.length, 0, `${label}: 没有上界就不许把范围交给写宿主`)
      if (Array.isArray(shape.lineLengths)) {
        assert.equal(err.data.reason, 'line-length-unavailable', `${label}: 说清楚是"没有行长可用"`)
      }
    } finally { ws.dispose() }
  }
})

test('★ R2-3 判序不变：行数越界先报 -32602 range-beyond-document（即便行长也缺）', async () => {
  const ws = tempWorkspace()
  try {
    // 形状连行长都没有，但 end.line 超了文档 —— 调用方可以自证的错先说话。
    const { host, caps, link } = grantedEnv({
      root: ws.root, documentShape: async () => ({ lineCount: 3 }),
    })
    const beyond = editParams(FILE(ws.root), {
      range: { start: { line: 1, column: 1 }, end: { line: 9, column: 1 } },
    })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', beyond, { link }), ERR.INVALID_PARAMS, 'line-beyond-first')
    assert.equal(err.data.reason, 'range-beyond-document')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})
