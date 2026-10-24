import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCapabilities, CAPABILITIES } from '../src/capabilities.js'
import { ERR } from '../../dsh-vscode-kit/src/protocol.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-kit-caps-'))
}

/** 假宿主：记录调用，返回可控结果。 */
function fakeHost(overrides = {}) {
  const calls = []
  const host = {
    calls,
    fileExists: (p) => { calls.push(['fileExists', p]); return /\.(txt|js)$/.test(p) },
    resolvePath: (p) => { calls.push(['resolvePath', p]); return p.startsWith('/') ? p : `/ws/${p}` },
    workspaceRoots: () => ['/ws'],
    // A2（T62）：本桥接**没有同源变更观察器就不许写**（observation-gap）。这些用假宿主
    // 的用例关心的是别的东西（编辑语义 / 锚点 / 删除），所以给一个"什么都不发生"的真实
    // 观察器：宿主确实实现了这个口，只是这个假宿主永远不报变更。
    observeTextChanges: () => ({ dispose() {} }),
    isTrusted: () => true,
    openTextDocument: async (p, o) => { calls.push(['openTextDocument', p, o]) },
    openExternalFile: async (p) => { calls.push(['openExternalFile', p]) },
    activeEditor: () => ({
      file: '/ws/a.js', text: 'sel', start: { line: 2, character: 4 },
      end: { line: 2, character: 7 }, isEmpty: false,
    }),
    // 0-based 入，由 capabilities 层转 1-based
    collectDiagnostics: (abs) => {
      calls.push(['collectDiagnostics', abs])
      const all = [
        {
          file: '/ws/a.js',
          diagnostics: [
            { severity: 'error', line: 0, character: 2, message: 'boom', source: 'ts', code: 1001 },
            { severity: 'warning', line: 3, character: 0, message: 'meh' },
          ],
        },
        {
          file: '/ws/b.js',
          diagnostics: [{ severity: 'error', line: 7, character: 1, message: 'other' }],
        },
      ]
      return abs ? all.filter((e) => e.file === abs) : all
    },
    listEditors: () => {
      calls.push(['listEditors'])
      return [
        { file: '/ws/a.js', isActive: true, isDirty: false, languageId: 'javascript' },
        { file: '/ws/b.js', isActive: false, isDirty: true },
      ]
    },
    log: () => {},
    ...overrides,
  }
  return host
}

test('CAPABILITIES 与 handlers 完全对应（不多不少）', () => {
  // 不硬编码清单：锁的是「声明与实现一致」这个不变量。
  // 早期写成 deepEqual(CAPABILITIES, ['vscode.openFile','vscode.getSelection'])，
  // 每加一个能力就误报一次——测试要防的是漏实现，不是清单变化。
  const { handlers } = createCapabilities(fakeHost())
  assert.deepEqual([...CAPABILITIES].sort(), Object.keys(handlers).sort())
})

test('openFile：默认 1-based 入参转 0-based，path 输出绝对路径', async () => {
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  const r = await dispatch('vscode.openFile', { path: 'a.txt', line: 5, column: 3 })
  assert.deepEqual(r, { opened: true, path: '/ws/a.txt', mode: 'text' })
  const open = host.calls.find((c) => c[0] === 'openTextDocument')
  assert.deepEqual(open[2], { line: 4, column: 2, preview: false })
})

test('openFile：非法/缺失 line、column 退回文件开头，不抛错', async () => {
  const host = fakeHost()
  const { dispatch } = createCapabilities(host)
  await dispatch('vscode.openFile', { path: 'a.txt', line: 0, column: -3 })
  const open = host.calls.find((c) => c[0] === 'openTextDocument')
  assert.deepEqual(open[2], { line: 0, column: 0, preview: false })
})

test('openFile：二进制扩展名走系统打开，不用文本编辑器（#33）', async () => {
  const host = fakeHost({ fileExists: () => true })
  const { dispatch } = createCapabilities(host)
  const r = await dispatch('vscode.openFile', { path: 'pic.png' })
  assert.equal(r.mode, 'external')
  assert.ok(host.calls.some((c) => c[0] === 'openExternalFile'))
  assert.ok(!host.calls.some((c) => c[0] === 'openTextDocument'))
})

test('openFile：文件不存在 → -32003，且带结构化 path', async () => {
  const { dispatch } = createCapabilities(fakeHost({ fileExists: () => false }))
  await assert.rejects(
    dispatch('vscode.openFile', { path: 'nope.txt' }),
    (e) => e.code === ERR.NOT_FOUND && e.data.path === '/ws/nope.txt',
  )
})

test('openFile：path 缺失/空白 → -32602', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  await assert.rejects(dispatch('vscode.openFile', {}),
    (e) => e.code === ERR.INVALID_PARAMS)
  await assert.rejects(dispatch('vscode.openFile', { path: '   ' }),
    (e) => e.code === ERR.INVALID_PARAMS)
})

test('getSelection：0-based 内部坐标转成 1-based 对外', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  const r = await dispatch('vscode.getSelection', {})
  assert.deepEqual(r, {
    text: 'sel',
    file: '/ws/a.js',
    start: { line: 3, column: 5 },
    end: { line: 3, column: 8 },
    isEmpty: false,
  })
})

test('getSelection：无活动编辑器 → -32003 no active editor', async () => {
  const { dispatch } = createCapabilities(fakeHost({ activeEditor: () => null }))
  await assert.rejects(dispatch('vscode.getSelection', {}),
    (e) => e.code === ERR.NOT_FOUND && /no active editor/.test(e.message))
})

test('getDiagnostics：工作区全部，坐标转 1-based，severity 用字符串', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  const r = await dispatch('vscode.getDiagnostics', {})
  assert.equal(r.total, 3)
  assert.equal(r.truncated, false)
  assert.deepEqual(r.files[0], {
    file: '/ws/a.js',
    diagnostics: [
      { severity: 'error', line: 1, column: 3, message: 'boom', source: 'ts', code: 1001 },
      { severity: 'warning', line: 4, column: 1, message: 'meh' },
    ],
  })
  assert.equal(r.files[1].file, '/ws/b.js')
  assert.equal(r.files[1].diagnostics[0].line, 8)
})

test('getDiagnostics：给了 path 就只查那个文件', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  const r = await dispatch('vscode.getDiagnostics', { path: 'a.js' })
  assert.equal(r.total, 2)
  assert.deepEqual(r.files.map((f) => f.file), ['/ws/a.js'])
})

test('getDiagnostics：severity 过滤 + limit 截断', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  const onlyErr = await dispatch('vscode.getDiagnostics', { severity: 'error' })
  assert.equal(onlyErr.total, 2)
  assert.ok(onlyErr.files.every((f) => f.diagnostics.every((d) => d.severity === 'error')))

  const limited = await dispatch('vscode.getDiagnostics', { limit: 1 })
  assert.equal(limited.total, 1)
  assert.equal(limited.truncated, true)
})

test('getDiagnostics：非法 severity → -32602；path 不存在 → -32003', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  await assert.rejects(dispatch('vscode.getDiagnostics', { severity: 'fatal' }),
    (e) => e.code === ERR.INVALID_PARAMS)
  await assert.rejects(dispatch('vscode.getDiagnostics', { path: 'nope.md' }),
    (e) => e.code === ERR.NOT_FOUND)
})

test('listOpenEditors：带 active/dirty 标记与截断信息', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  const r = await dispatch('vscode.listOpenEditors', {})
  assert.equal(r.total, 2)
  assert.deepEqual(r.editors[0], {
    file: '/ws/a.js', isActive: true, isDirty: false, languageId: 'javascript',
  })
  // b.js 没有 languageId，字段应缺省而不是 undefined
  assert.equal('languageId' in r.editors[1], false)

  const one = await dispatch('vscode.listOpenEditors', { limit: 1 })
  assert.equal(one.editors.length, 1)
  assert.equal(one.truncated, true)
})

test('未实现的方法 → -32005（不是 -32601：区分降级与编程错误）', async () => {
  const { dispatch } = createCapabilities(fakeHost())
  await assert.rejects(dispatch('vscode.diff', {}),
    (e) => e.code === ERR.UNSUPPORTED && /not implemented/.test(e.message))
})

test('未信任工作区：所有能力一律 -32006，且不触碰宿主动作', async () => {
  const host = fakeHost({ isTrusted: () => false })
  const { dispatch } = createCapabilities(host)
  for (const method of CAPABILITIES) {
    await assert.rejects(dispatch(method, { path: 'a.txt' }),
      (e) => e.code === ERR.UNTRUSTED_WORKSPACE, `${method} should refuse in untrusted workspace`)
  }
  assert.ok(!host.calls.some((c) => c[0] === 'openTextDocument'))
})

test('出口路径规范化：Windows 小写盘符统一成大写（回归：真机自检踩到）', async () => {
  // 真机上 VSCode 的 uri.fsPath 把盘符小写成 c:\...，而 openFile 回传调用方传入的 C:\...，
  // 于是消费者按字符串比较同一个文件会失败。协议出口必须只有一种写法。
  const host = fakeHost({
    activeEditor: () => ({
      file: 'c:\ws\a.js', text: 'x', isEmpty: false,
      start: { line: 0, character: 0 }, end: { line: 0, character: 1 },
    }),
    listEditors: () => [{ file: 'c:\ws\b.js', isActive: false }],
    collectDiagnostics: () => ([{
      file: 'c:\ws\a.js',
      diagnostics: [{ severity: 'error', line: 0, character: 0, message: 'boom' }],
    }]),
  })
  const { dispatch } = createCapabilities(host)

  const sel = await dispatch('vscode.getSelection', {})
  assert.equal(sel.file, 'C:\ws\a.js', 'getSelection 应大写盘符')

  const list = await dispatch('vscode.listOpenEditors', {})
  assert.equal(list.editors[0].file, 'C:\ws\b.js', 'listOpenEditors 应大写盘符')

  const diag = await dispatch('vscode.getDiagnostics', {})
  assert.equal(diag.files[0].file, 'C:\ws\a.js', 'getDiagnostics 应大写盘符')
})
