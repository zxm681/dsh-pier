/**
 * T34（扩展侧）：**文档化身身份 `incarnation`** —— 版本号复用再也不能骗过锚点。
 *
 * ## 守的是 T5 的 Q3
 *
 * `TextDocument.version` 是**每个文档实例**自己的计数器：关掉再打开（或撤销回到初始态）
 * 拿到的是新实例，版本又从 1 开始数。于是"旧实例的版本 1"与"新实例的版本 1"数字相等，
 * 版本门放行，按旧视角算的坐标落进新缓冲区 —— 这一半只能由**实例身份**拦住。
 *
 * 三条线：
 *  ① `getDocumentState` 报 `incarnation`，同一实例稳定、重开后必然变化；
 *  ② `applyEdit` 的 `expectedIncarnation` 不符 → `-32012` + `reason:'incarnation-mismatch'`；
 *     前置（③b，宿主零写入）与事务内（⑦，**零构造 edit**）各来一次；
 *  ③ 没给 `expectedIncarnation` 的调用方（**T35 起：含旧版扩展**）→ `-32602`、
 *     宿主零调用 —— 有意的不兼容收紧，理由见 `capabilities.js` 的 `readExpectedIncarnation`：
 *     没有实例身份就证明不了"写的是同一个文档实例"。
 *
 * 与 T32 的分工：`version` 证明"内容没被改过"，`incarnation` 证明"还是那一份文档"。
 * 两道门独立，任何一道单独被拆掉都该有用例变红（见本卡的三次变异记录）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'

import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'
import { PEER_FEATURE_DOCUMENT_INCARNATION } from '../../dsh-vscode-kit/src/index.js'
import { PEER_FEATURES } from '../src/connector.js'
import { applyEditAtomically } from '../src/edit-transaction.js'
import { createCapabilities } from '../src/capabilities.js'

// ---------------------------------------------------------------------------
// 脚手架：**文档实例**（id + version），可以在两次读之间被"关掉重开"
// ---------------------------------------------------------------------------

const ID_A = 'a'.repeat(32)
const EPOCH_A = 'b'.repeat(32)

function tempWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-t34-incarnation-'))
  const root = join(base, 'ws')
  mkdirSync(root)
  writeFileSync(join(root, 'a.js'), 'line1\nline2\nline3\n')
  return { base, root, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/**
 * 假宿主：每个文件只有一个"当前打开的文档实例"。
 *
 * `reopen()` 就是真机上"关掉再打开"的等价物：**新 id、version 回到 1、内容重新从磁盘读**
 * —— 与 T5 真机数据一致（新文件 version 全 1；重载后 1→2 是因为磁盘上已有改动）。
 * `hooks.beforeTransaction` 挂在 `applyEditText` 入口，即"能力层 ③ 已经判完、事务还没开始"
 * 的那个让出点（真实世界里用户在 A 窗口关闭文件、又在 B 窗口打开它，就发生在这里）。
 */
function makeHost(root, abs, { hooks = {} } = {}) {
  let instance = { id: 'inc-v1', version: 1, text: readFileSync(abs, 'utf8') }
  /** 递增的实例序号 —— 每次 reopen 换一个 id，但**版本永远回到 1**（这才是坑）。 */
  let serial = 1
  const calls = []   // 调用 `applyEditText` 的次数（= 宿主被要求写入的次数）
  const edits = []   // 事务里真正**构造**出来的 edit 数（= 有没有动缓冲区）

  const host = {
    calls,
    edits,
    instance: () => instance,
    /** 关掉再打开：新实例、版本复用、内容按磁盘（这部分模拟"没落盘的改动丢了"）。 */
    reopen() {
      serial += 1
      instance = { id: `inc-v${serial}`, version: 1, text: readFileSync(abs, 'utf8') }
      return instance
    },
    /** 测试用：不换实例，只把版本推到 n（模拟同一个实例上的编辑）。 */
    bump(version, text) {
      instance = { ...instance, version, text: text ?? instance.text }
      return instance
    },
    fileExists: (p) => { try { return existsSync(p) && statSync(p).isFile() } catch { return false } },
    resolvePath: (p) => (isAbsolute(p) ? normalize(p) : join(root, p)),
    workspaceRoots: () => [root],
    isTrusted: () => true,
    openTextDocument: async () => {},
    openExternalFile: async () => {},
    activeEditor: () => null,
    collectDiagnostics: () => [],
    listEditors: () => [],
    log: () => {},
    readDocumentState: async (p, { includeText = false } = {}) => ({
      version: instance.version,
      incarnation: instance.id,
      isDirty: false,
      eol: 'lf',
      lineCount: instance.text.split('\n').length,
      textLength: instance.text.length,
      byteLength: Buffer.byteLength(instance.text, 'utf8'),
      ...(includeText === true ? { text: instance.text } : {}),
    }),
    readDocumentShape: async (p, lines = []) => {
      // 真机这里是一个 await（打开文档、可能要加载文本）—— 重开就发生在这个缝里。
      if (hooks.afterStateRead) {
        const fn = hooks.afterStateRead
        hooks.afterStateRead = null
        fn()
      }
      const buf = instance.text.split('\n')
      return {
        lineCount: buf.length,
        lineLengths: lines.map((n) => (n >= 1 && n <= buf.length ? buf[n - 1].length : null)),
      }
    },
    readRangeText: async () => '',
    /**
     * 与 `vscode-host.js` 同构：先把"编辑器"拿到手（此刻的实例！），再交给**真事务**
     * 在 `edit(callback)` 的同步 callback 里判版本与化身。
     */
    applyEditText: async (p, range, text, expectedVersion, expectedIncarnation) => {
      calls.push({ range, text, expectedVersion, expectedIncarnation })
      if (hooks.beforeTransaction) {
        const fn = hooks.beforeTransaction
        hooks.beforeTransaction = null
        fn()
      }
      const doc = { version: instance.version, id: instance.id, text: instance.text, uri: { fsPath: p } }
      const editor = {
        document: doc,
        edit: async (cb) => {
          let constructed = false
          cb({
            replace: (r, value) => {
              constructed = true
              const buf = doc.text.split('\n')
              const head = buf[r.start.line].slice(0, r.start.column)
              const tail = buf[r.end.line].slice(r.end.column)
              doc.text = [
                ...buf.slice(0, r.start.line),
                ...(head + value + tail).split('\n'),
                ...buf.slice(r.end.line + 1),
              ].join('\n')
              doc.version += 1
            },
          })
          if (constructed) {
            edits.push({ expectedIncarnation })
            instance = { ...instance, version: doc.version, text: doc.text }
          }
          return constructed ? true : false
        },
      }
      const outcome = await applyEditAtomically({
        editor,
        file: p,
        expectedVersion,
        expectedIncarnation,
        readIncarnation: (d) => d.id,
        apply: (builder) => builder.replace(rangeToApi(range), text),
      })
      return outcome
    },
  }
  return host
}

/** 0-based → 能力层已经转好的 1-based 等价物（本测试的 range 始终在单行内）。 */
function rangeToApi(range) {
  return range
}

function setup({ root, hooks } = {}) {
  const abs = join(root, 'a.js')
  const link = { name: 'link-t34' }
  const store = new GrantStore()
  store.adopt({ id: ID_A, epoch: EPOCH_A, link })
  const host = makeHost(root, abs, { hooks })
  const caps = createCapabilities(host, { grants: store })
  return { host, caps, link, abs, store }
}

function writeParams(abs, extra = {}) {
  return {
    file: abs,
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 6 } },
    text: 'LINE2',
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
// ① 形状：getDocumentState 报化身；同一实例稳定，重开后必变（版本仍是 1）
// ---------------------------------------------------------------------------

test('★ T34 getDocumentState 报 incarnation：同一实例稳定、重开后换 id（而 version 复用回 1）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, abs } = setup({ root: ws.root })
    host.bump(5)
    const a = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    const b = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    assert.equal(typeof a.incarnation, 'string', '锚点必须带实例身份')
    assert.equal(a.incarnation.length > 0, true)
    assert.equal(a.incarnation, b.incarnation, '同一实例两次读必须是同一个 id')

    host.reopen()
    const c = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    assert.equal(c.version, 1, '关掉重开后版本复用回 1 —— 这正是版本门挡不住的情形')
    assert.notEqual(c.incarnation, a.incarnation, '实例身份必须变')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ② 重开 + 版本复用 → -32012 incarnation-mismatch（前置门：宿主零写入）
// ---------------------------------------------------------------------------

test('★ T34 重开文档 version 复用 → -32012 incarnation-mismatch（前置门，宿主零写入）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, abs } = setup({ root: ws.root })
    const anchor = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    assert.equal(anchor.version, 1)

    // 关掉再打开：新实例、版本又是 1 —— 只按数字判，这次写入会被放行。
    host.reopen()

    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', writeParams(abs, {
        expectedVersion: anchor.version,
        expectedIncarnation: anchor.incarnation,
      }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '旧锚点写新实例')
    assert.equal(err.data.reason, 'incarnation-mismatch')
    assert.equal(err.data.expected, anchor.incarnation)
    assert.equal(host.calls.length, 0, '前置门就拦住了：宿主一次都没被要求写入')
    assert.equal(host.edits.length, 0)
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ③ 同一情形，若能力层的前置门被绕过 → **事务内**仍要拦住，且零构造 edit
// ---------------------------------------------------------------------------

test('★ T34 重开发生在判定与提交之间 → 事务内拦下，零构造 edit（版本数字相等！）', async () => {
  const ws = tempWorkspace()
  try {
    // `afterStateRead` = 能力层 ③③b 判完、④ 的 readDocumentShape 里那个 await。
    const hooks = { afterStateRead: null }
    const { host, caps, link, abs } = setup({ root: ws.root, hooks })
    const anchor = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    // 让"重开"正好发生在 ③ 判完之后、事务开始之前。
    hooks.afterStateRead = () => host.reopen()

    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', writeParams(abs, {
        expectedVersion: anchor.version,
        expectedIncarnation: anchor.incarnation,
      }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '事务内化身不符')
    assert.equal(err.data.reason, 'incarnation-mismatch',
      '版本数字相等（都是 1），只有化身能说明换了实例')
    assert.equal(host.calls.length, 1, '这次宿主**被调用过**（缝在 ③ 之后）')
    assert.equal(host.edits.length, 0, '一个 edit 都不许构造 —— 零构造 = 零写入')
    assert.equal(host.instance().text, 'line1\nline2\nline3\n', '缓冲区一个字符都没变')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ④ 同一实例正常路径：两个锚点一起给，写入成功且不保存
// ---------------------------------------------------------------------------

test('★ T34 同一实例正常路径：version + incarnation 一起给 → applied，saved:false', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, abs } = setup({ root: ws.root })
    host.bump(4)
    const anchor = await caps.dispatch('vscode.getDocumentState', { file: abs }, { link })
    const result = await caps.dispatch('vscode.applyEdit', writeParams(abs, {
      expectedVersion: anchor.version,
      expectedIncarnation: anchor.incarnation,
    }), { link })
    assert.equal(result.applied, true)
    assert.equal(result.saved, false, '只改缓冲区，绝不保存')
    assert.equal(host.edits.length, 1)
    assert.equal(host.calls[0].expectedIncarnation, anchor.incarnation,
      '化身必须原样传到写宿主 —— 否则事务里那道判定没有输入')
    assert.equal(host.instance().text, 'line1\nLINE2\nline3\n')
  } finally { ws.dispose() }
})

// ---------------------------------------------------------------------------
// ⑤ 向后兼容 + 常量同源
// ---------------------------------------------------------------------------

test('★ T35 收紧：不给 expectedIncarnation ⇒ -32602、宿主零调用（旧版扩展从此不能写）', async () => {
  const ws = tempWorkspace()
  try {
    const { host, caps, link, abs, store } = setup({ root: ws.root })
    // ★ T35 前这里是"纯版本锚点的写：成功，宿主收到 undefined"。
    //   那正是 H1 的一半：省略字段 ⇒ 事务只剩整数版本比较，两个窗口版本数字相同
    //   就能按另一窗口的视图覆盖人工内容。现在它必须**在调用写宿主之前**被拒。
    const err = await expectCode(
      caps.dispatch('vscode.applyEdit', writeParams(abs, { expectedVersion: 1 }), { link }),
      ERR.INVALID_PARAMS, '缺化身锚点',
    )
    assert.equal(err.data.reason, 'expected-incarnation-missing')
    assert.equal(host.calls.length, 0, '宿主一次都没被调用（不是"写了再回滚"）')

    // 空串 / 非字符串同样参数错：空串会让"宿主读不到化身"与"调用方给了空串"匹配成功。
    for (const bad of ['', 7, null, {}]) {
      const e = await expectCode(
        caps.dispatch('vscode.applyEdit',
          writeParams(abs, { expectedVersion: 1, expectedIncarnation: bad }), { link }),
        ERR.INVALID_PARAMS, `畸形化身 ${JSON.stringify(bad)}`,
      )
      assert.equal(e.data.reason, 'expected-incarnation-not-a-non-empty-string')
    }
    assert.equal(host.calls.length, 0, '畸形化身也一个字节都没写')

    // 宿主不报 incarnation（老适配器）：getDocumentState 就不该出现这个键。
    const legacy = createCapabilities(
      { ...host, readDocumentState: async () => ({
        version: 1, isDirty: false, eol: 'lf', lineCount: 3, textLength: 18, byteLength: 18,
      }) },
      { grants: store },
    )
    const state = await legacy.dispatch('vscode.getDocumentState', { file: abs }, { link })
    assert.equal('incarnation' in state, false, '宿主没有化身就不许编一个')
    assert.equal(state.version, 1)

    // 给了化身但宿主还没有（老适配器）→ 失败闭合：读不到 ≠ 匹配。
    // ★ 这是被接受的代价：拿不到"是不是同一份文档"的保证就拒写，而不是少判一半。
    const err2 = await expectCode(
      legacy.dispatch('vscode.applyEdit', writeParams(abs, {
        expectedVersion: 1, expectedIncarnation: 'inc-x',
      }), { link }),
      ERR.DOCUMENT_VERSION_CONFLICT, '宿主没有化身却给了化身',
    )
    assert.equal(err2.data.reason, 'incarnation-mismatch')
  } finally { ws.dispose() }
})

test('★ T34 两条 hello 常量同源：bridge 的 PEER_FEATURES 与 kit 的 feature 名逐字一致', () => {
  // 跨包重复的字符串字面量只能靠断言守住 —— 它是"要不要强制化身锚点"的开关。
  assert.deepEqual(PEER_FEATURES.slice(), [PEER_FEATURE_DOCUMENT_INCARNATION])
})
