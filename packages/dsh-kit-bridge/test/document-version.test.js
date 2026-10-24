/**
 * 文档版本锚点（T30）：`vscode.applyEdit` 的 `expectedVersion` / `expectedRangeText`
 * 与读侧能力 `vscode.getDocumentState`。
 *
 * 这个文件守两条线：
 *  ① **安全线**：没有版本锚点的写入、版本过期的写入、范围内容不符的写入，都必须在
 *     `host.applyEditText` **之前**停下（"宿主零调用"是本文件出现最多的断言）。
 *  ② **形状线**：`getDocumentState` 的字段、`textUnavailable` 的语义（超限 = **整份不给**，
 *     绝不截断后当全文）、失败码与 `openFile` 同族。
 *
 * 判序也是契约（卡里定死的）：路径 → 版本 → range 形状/越界 → expectedRangeText → 写宿主。
 * 第 ⑥⑦ 组用例专门测"两种错同时存在时先报哪个"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { CAPABILITIES, MAX_TEXT_BYTES, createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架
// ---------------------------------------------------------------------------

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-t30-version-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'hello world\nsecond line\n')
  writeFileSync(join(base, 'secret.js'), 'outside\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)

/**
 * 假宿主：文档状态（版本 / 文本）可以**直接改**，用来造版本冲突与大文件。
 * `docs` 里没有的文件按磁盘内容惰性初始化（版本默认 1）。
 */
function makeHost(roots, { trusted = true } = {}) {
  const calls = []
  const docs = new Map()
  const doc = (abs) => {
    if (!docs.has(abs)) {
      const text = readFileSync(abs, 'utf8')
      // ★ T35：化身无条件必填 ⇒ 假文档必须带实例身份（`edit(abs,{incarnation})` 换它）。
      docs.set(abs, { version: 1, incarnation: 'inc-t30', text, isDirty: false, eol: 'lf', byteLength: null })
    }
    return docs.get(abs)
  }
  const host = {
    calls,
    docs,
    /** 测试用：直接改"编辑器里的文档"（版本 / 文本 / 字节数 / 脏标记）。 */
    edit(abs, { version, text, byteLength, isDirty, incarnation } = {}) {
      const d = doc(abs)
      if (text !== undefined) d.text = text
      if (incarnation !== undefined) d.incarnation = incarnation
      if (version !== undefined) d.version = version
      if (byteLength !== undefined) d.byteLength = byteLength
      if (isDirty !== undefined) d.isDirty = isDirty
      return d
    },
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
      const buf = doc(abs).text.split('\n')
      return {
        lineCount: buf.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= buf.length ? buf[n - 1].length : null)),
      }
    },
    readDocumentState: async (abs, { includeText = false } = {}) => {
      const d = doc(abs)
      return {
        version: d.version,
        incarnation: d.incarnation,
        isDirty: d.isDirty,
        eol: d.eol,
        lineCount: d.text.split('\n').length,
        textLength: d.text.length,
        byteLength: d.byteLength ?? Buffer.byteLength(d.text, 'utf8'),
        ...(includeText === true ? { text: d.text } : {}),
      }
    },
    readRangeText: async (abs, range) => {
      const buf = doc(abs).text.split('\n')
      const at = (i) => buf[i] ?? ''
      if (range.start.line === range.end.line) {
        return at(range.start.line).slice(range.start.column, range.end.column)
      }
      const parts = [at(range.start.line).slice(range.start.column)]
      for (let i = range.start.line + 1; i < range.end.line; i += 1) parts.push(at(i))
      parts.push(at(range.end.line).slice(0, range.end.column))
      return parts.join('\n')
    },
    applyEditText: async (abs, range, text) => {
      calls.push({ abs, range, text })
      const d = doc(abs)
      const buf = d.text.split('\n')
      const head = buf[range.start.line].slice(0, range.start.column)
      const tail = buf[range.end.line].slice(range.end.column)
      d.text = [...buf.slice(0, range.start.line), ...(head + text + tail).split('\n'),
        ...buf.slice(range.end.line + 1)].join('\n')
      d.version += 1
      return { applied: true, documentPath: abs }
    },
    log: () => {},
  }
  return host
}

function setup({ root, grants = true, ...hostOpts } = {}) {
  const link = { name: 'link-t30' }
  const store = grants ? new GrantStore() : null
  if (store) store.adopt({ id: ID_A, epoch: EPOCH_A, link })
  const host = makeHost([root], hostOpts)
  const caps = createCapabilities(host, store ? { grants: store } : {})
  return { host, caps, grants: store, link }
}

/** 写入参数（1-based 坐标；`expectedVersion` 默认 1 = 假宿主初值）。 */
function editParams(file, extra = {}) {
  return {
    file,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    text: 'HELLO',
    expectedVersion: 1,
    expectedIncarnation: 'inc-t30',
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
// ① 参数层：expectedVersion 必填、必须是整数 ≥ 0
// ---------------------------------------------------------------------------

test('T30 ★ expectedVersion 缺失 → -32602（必填，不是可选）；宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js'), { expectedVersion: undefined }), { link }),
      ERR.INVALID_PARAMS, 'missing')
    assert.equal(err.data.reason, 'expected-version-missing')
    assert.equal(host.calls.length, 0, '缺锚点的写入一次都不许碰到宿主')
  } finally { ws.dispose() }
})

test('T30 ★ expectedVersion 形状不对（字符串 / 小数 / 负数 / null）→ -32602，各自给得出原因', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    const cases = [
      ['1', 'expected-version-not-a-number'],
      [1.5, 'expected-version-not-an-integer'],
      [-1, 'expected-version-negative'],
      [null, 'expected-version-not-a-number'],
    ]
    for (const [value, reason] of cases) {
      const err = await expectCode(
        caps.dispatch('vscode.applyEdit', editParams(file, { expectedVersion: value }), { link }),
        ERR.INVALID_PARAMS, `expectedVersion=${JSON.stringify(value)}`)
      assert.equal(err.data.reason, reason)
    }
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ② 版本冲突：-32012，data 三个数，宿主零调用
// ---------------------------------------------------------------------------

test('T30 ★ 版本不符 → -32012 document-version-conflict（data: file/expected/actual），宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    host.edit(file, { version: 3 })      // 缓冲区被人改过三次

    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, { expectedVersion: 1 }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'stale')
    assert.equal(err.data.file, file)
    assert.equal(err.data.expected, 1)
    assert.equal(err.data.actual, 3)
    assert.equal(host.calls.length, 0, '冲突必须在写宿主之前拦下 —— 否则就是 T4 那个静默覆盖')
    assert.equal(host.docs.get(file).text, readFileSync(file, 'utf8'), '缓冲区内容不许被动过')
  } finally { ws.dispose() }
})

test('T30 ★ 版本相符 → 正常写入（一次宿主调用，坐标只转一次）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    host.edit(file, { version: 7 })
    const res = await caps.dispatch('vscode.applyEdit', editParams(file, { expectedVersion: 7 }), { link })
    assert.equal(res.applied, true)
    assert.equal(res.saved, false)
    assert.equal(host.calls.length, 1)
    assert.deepEqual(host.calls[0].range, {
      start: { line: 0, column: 0 }, end: { line: 0, column: 5 },
    }, '0-based range（T30 没有改动坐标转换的口径）')
    assert.equal(host.docs.get(file).text.split('\n')[0], 'HELLO world')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ③ expectedRangeText：可选，但给了就必须逐字相等
// ---------------------------------------------------------------------------

test('T30 ★ expectedRangeText 不符 → -32012（reason:range-text-mismatch），宿主零调用', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    // 版本对得上（1），但那一块实际是 `hello` 而不是 `HELLO-OLD`。
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, { expectedRangeText: 'HELLO-OLD' }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'range-text')
    assert.equal(err.data.reason, 'range-text-mismatch')
    assert.equal(err.data.file, file)
    assert.equal(err.data.expectedVersion, 1)
    assert.equal(err.data.actualVersion, 1)
    assert.equal(err.data.expectedTextLength, 'HELLO-OLD'.length)
    assert.equal(err.data.actualTextLength, 'hello'.length)
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('T30 ★ expectedRangeText 相符 → 正常写入；非字符串 → -32602（不许静默降级成"没给"）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    const ok = await caps.dispatch('vscode.applyEdit',
      editParams(file, { expectedRangeText: 'hello' }), { link })
    assert.equal(ok.applied, true)
    assert.equal(host.calls.length, 1)

    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, { expectedRangeText: 42 }), { link }),
      ERR.INVALID_PARAMS, 'range-text-type')
    assert.equal(err.data.reason, 'expected-range-text-not-a-string')
    assert.equal(host.calls.length, 1, '参数错也不许写')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ④ 判序：路径 → 版本 → range 形状/越界 → expectedRangeText
// ---------------------------------------------------------------------------

test('T30 ★ 判序：版本不符 + 范围越界 → 先报版本（-32012），不是 -32602', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    host.edit(file, { version: 9 })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, {
        expectedVersion: 1,
    expectedIncarnation: 'inc-t30',
        range: { start: { line: 1, column: 1 }, end: { line: 99, column: 1 } },
      }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, 'version-before-range')
    assert.equal(err.data.actual, 9)
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('T30 ★ 判序：路径越界 + 版本不符 → 先报路径（-32602），路径不合法时连版本都不讨论', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(ws.base, 'secret.js'), { expectedVersion: 1 }), { link }),
      ERR.INVALID_PARAMS, 'path-before-version')
    assert.match(String(err.data.reason ?? ''), /outside|escape|root/, '工作区外 → 路径守卫先发话')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('T30 ★ 判序：expectedRangeText 在越界之后判 —— 范围先越界时报 -32602', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, {
        expectedRangeText: 'nonsense',
        range: { start: { line: 1, column: 90 }, end: { line: 1, column: 99 } },
      }), { link }),
      ERR.INVALID_PARAMS, 'range-before-text')
    assert.equal(err.data.reason, 'range-beyond-line')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ⑤ 宿主缺件 / 坏形状：失败闭合，绝不当成"没有版本冲突"
// ---------------------------------------------------------------------------

test('T30 ★ 宿主没有 readDocumentState → -32603 失败闭合（没有锚点就不许写）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    delete host.readDocumentState
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(join(ws.root, 'a.js')), { link }),
      ERR.INTERNAL, 'no-state-source')
    assert.equal(err.data.hostField, 'readDocumentState')
    assert.equal(host.calls.length, 0)
  } finally { ws.dispose() }
})

test('T30 ★ 宿主回的 version 是字符串/负数 → -32603（不许拿坏版本去比）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root })
    const file = join(ws.root, 'a.js')
    const original = host.readDocumentState
    host.readDocumentState = async () => ({
      version: '1', isDirty: false, eol: 'lf', lineCount: 1, textLength: 0, byteLength: 0,
    })
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file), { link }), ERR.INTERNAL, 'bad-version')
    assert.deepEqual(err.data.fields, ['version'])

    host.readDocumentState = async () => ({
      version: -2, isDirty: false, eol: 'lf', lineCount: 1, textLength: 0, byteLength: 0,
    })
    await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file), { link }), ERR.INTERNAL, 'negative-version')
    assert.equal(host.calls.length, 0)
    host.readDocumentState = original
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ⑥ getDocumentState：形状 / 大文件 / 路径
// ---------------------------------------------------------------------------

test('T30 ★ getDocumentState 形状：version 来自 TextDocument.version，行数/长度/eol 齐全', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link } = setup({ root: ws.root, grants: false })
    const file = join(ws.root, 'a.js')
    host.edit(file, { version: 12, isDirty: true })
    const state = await caps.dispatch('vscode.getDocumentState', { file }, { link })
    // ★ T35：`incarnation` 是写侧必填锚点的来源，必须在读侧形状里（T34 起有，T35 起更不可缺）。
    assert.deepEqual(Object.keys(state).sort(),
      ['eol', 'file', 'incarnation', 'isDirty', 'lineCount', 'textLength', 'version'])
    assert.equal(state.version, 12)
    assert.equal(state.incarnation, 'inc-t30', '化身原样透出，不加工')
    assert.equal(state.isDirty, true)
    assert.equal(state.eol, 'lf')
    assert.equal(state.lineCount, 3)
    assert.equal(state.textLength, 'hello world\nsecond line\n'.length)
    assert.equal(state.file, file, '出口路径规范化')
    assert.equal('text' in state, false, '不请求 includeText 就不给文本')
    assert.equal('textUnavailable' in state, false)
  } finally { ws.dispose() }
})

test('T30 ★ getDocumentState(includeText:true) → 返回**整份**文本，长度自洽', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = setup({ root: ws.root, grants: false })
    const file = join(ws.root, 'a.js')
    const state = await caps.dispatch('vscode.getDocumentState', { file, includeText: true }, { link })
    assert.equal(state.text, 'hello world\nsecond line\n')
    assert.equal(state.text.length, state.textLength)
    assert.equal('textUnavailable' in state, false)
  } finally { ws.dispose() }
})

test('T30 ★ 大文件（>8MiB）→ 不返回 text、改 textUnavailable:true，绝不截断当全文', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = setup({ root: ws.root, grants: false })
    const file = join(ws.root, 'a.js')
    // 假宿主报一个超限的 byteLength，但内部只有一小段文本 —— 正好用来验"整份不给"：
    // 如果实现是"截断到上限再返回"，这里会拿到 text 而不是 textUnavailable。
    const capsWithBig = createCapabilities({
      fileExists: (p) => existsSync(p) && statSync(p).isFile(),
      resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(ws.root, p)),
      workspaceRoots: () => [ws.root],
      isTrusted: () => true,
      openTextDocument: async () => {},
      openExternalFile: async () => {},
      activeEditor: () => null,
      collectDiagnostics: () => [],
      listEditors: () => [],
      readDocumentShape: async () => ({ lineCount: 1, lineLengths: [1] }),
      readRangeText: async () => '',
      readDocumentState: async (abs, { includeText = false } = {}) => ({
        version: 1,
        isDirty: false,
        eol: 'lf',
        lineCount: 1,
        textLength: 11,
        byteLength: MAX_TEXT_BYTES + 1,
        ...(includeText === true ? { text: 'hello world' } : {}),
      }),
      applyEditText: async () => ({ applied: true, documentPath: null }),
      log: () => {},
    }, {})
    const big = await capsWithBig.dispatch('vscode.getDocumentState', { file, includeText: true }, { link })
    assert.equal(big.textUnavailable, true, '超限必须显式说"文本没给"')
    assert.equal('text' in big, false, '**绝不许**截断后当全文返回')
    assert.equal(big.textLength, 11, '元信息照旧给（版本/长度/行数不受影响）')
    assert.equal(big.version, 1)

    // 不超过上限的同一份文档（对照）：必须给文本。证明上面那条不是因为"没实现"。
    const small = await caps.dispatch('vscode.getDocumentState', { file, includeText: true }, { link })
    assert.equal(small.text, 'hello world\nsecond line\n')
  } finally { ws.dispose() }
})

test('T30 ★ getDocumentState 路径守卫与 openFile 同族：越界 -32602、不存在 -32003；includeText 非布尔 -32602', async () => {
  const ws = tempWorkspace()
  try {
    const { caps, link } = setup({ root: ws.root, grants: false })
    const outside = await expectCode(
      caps.dispatch('vscode.getDocumentState', { file: join(ws.base, 'secret.js') }, { link }),
      ERR.INVALID_PARAMS, 'outside')
    assert.match(String(outside.data.reason ?? ''), /outside|escape|root/)

    const missing = await expectCode(
      caps.dispatch('vscode.getDocumentState', { file: join(ws.root, 'nope.js') }, { link }),
      ERR.NOT_FOUND, 'missing')
    assert.equal(missing.data.path, join(ws.root, 'nope.js'))

    const bad = await expectCode(
      caps.dispatch('vscode.getDocumentState', { file: join(ws.root, 'a.js'), includeText: 'yes' }, { link }),
      ERR.INVALID_PARAMS, 'includeText')
    assert.equal(bad.data.reason, 'include-text-not-a-boolean')
  } finally { ws.dispose() }
})

test('T30 ★ getDocumentState 不需要 grant（纯读），CAPABILITIES 里有它', async () => {
  const ws = tempWorkspace()
  try {
    // grants=false：能力层连授权表都没有，写类方法一律 -32010，读照样可用。
    const { caps, link } = setup({ root: ws.root, grants: false })
    const file = join(ws.root, 'a.js')
    const state = await caps.dispatch('vscode.getDocumentState', { file }, { link })
    assert.equal(state.version, 1)
    // 同环境下写入必须仍然被绑定门拦住（证明"读不要授权"没有把写也放开）。
    await expectCode(
      caps.dispatch('vscode.applyEdit', editParams(file, { grant: undefined }), { link }),
      ERR.EDIT_NOT_BOUND, 'read-not-write')
    assert.equal(CAPABILITIES.includes('vscode.getDocumentState'), true)
    assert.equal(CAPABILITIES.includes('vscode.applyEdit'), true)
  } finally { ws.dispose() }
})
