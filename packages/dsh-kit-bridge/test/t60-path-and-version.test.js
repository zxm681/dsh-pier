/**
 * ★ T60 缺陷①②：bridge 侧的两条根因。
 *
 * ① **事件对外路径形态**：`editor-events.js` 的 `fileOf()` 以前直接返回宿主
 *    `doc.uri.fsPath`（Windows 盘符**小写**），而 RPC 出口（`capabilities.js` 的
 *    `canonicalPath`）是**大写**。同一份白名单在两处比较，静默失配。
 *    现在两处共用一个实现（`dsh-vscode-kit/src/paths.js`），且白名单在**收进来那一步**
 *    就规范 —— 老 DSH 发小写盘符照样命中。
 *
 * ② **版本自报**：`connector.js` 里曾手写 `EXTENSION_VERSION = '0.3.1'`，而
 *    `package.json` 已经 `0.3.2`；发版只改清单，`hello` 继续说旧号。
 *    现在 `EXTENSION_VERSION` 运行时读 `package.json`（`version.js`），不存在第二份。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEditorEvents } from '../src/editor-events.js'
import { EXTENSION_VERSION, readExtensionVersion, bridgePackageJsonPath } from '../src/version.js'
import { CLIENT_ID } from '../src/connector.js'
import { canonicalPath } from '../../dsh-vscode-kit/src/paths.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const names = ['onDidOpenTextDocument', 'onDidCloseTextDocument', 'onDidSaveTextDocument',
  'onDidChangeTextDocument', 'onDidChangeTextEditorSelection', 'onDidChangeTextEditorVisibleRanges',
  'onDidChangeVisibleTextEditors', 'onDidChangeTabs', 'onDidChangeActiveTextEditor', 'onDidChangeWindowState']

/** 宿主报出来的 `fsPath` —— Windows 上是**小写盘符**形态。 */
const HOST_PATH = 'd:/ws/a.txt'

function doc({ file = HOST_PATH, text = 'abc' } = {}) {
  return { text, version: 1, isDirty: false,
    uri: { fsPath: file, scheme: 'file', toString: () => `file:${file}` },
    getText() { return this.text } }
}

function fixture({ filter, documents = [doc()] } = {}) {
  const callbacks = new Map(names.map((n) => [n, new Set()]))
  const delivered = []
  const host = {
    documents, visible: [], tabList: [], isTrusted: () => true,
    textDocuments: () => host.documents, visibleTextEditors: () => host.visible,
    tabs: () => host.tabList, tabUris: (t) => t.uris,
    incarnationOf: () => 'inc-1', textLength: (d) => d.text.length,
    ...Object.fromEntries(names.map((n) => [n, (fn) => {
      callbacks.get(n).add(fn)
      return { dispose: () => callbacks.get(n).delete(fn) }
    }])),
  }
  const collector = createEditorEvents({ host, filter,
    emit: (type, payload) => delivered.push({ type, payload }),
    timers: { setTimeout: (fn) => ({ fn, unref() {} }), clearTimeout: () => {} },
  })
  const fire = (n, value) => { for (const fn of callbacks.get(n)) fn(value) }
  return { collector, delivered, fire, d: documents[0],
    open() { fire('onDidOpenTextDocument', this.d) },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 事件路径形态
// ─────────────────────────────────────────────────────────────────────────────

test('★ T60 ①-1：事件 payload.file 是**规范形态**，与 listOpenEditors 的写法一致', () => {
  const f = fixture({ filter: { roots: ['D:/ws'], textMode: 'delta', files: ['D:/ws/a.txt'] } })
  f.collector.activate()
  f.open()

  const opened = f.delivered.find((e) => e.type === 'documentOpened')
  assert.ok(opened, '前置：文件必须真被开出事件')
  assert.equal(opened.payload.file, 'D:/ws/a.txt',
    '宿主给的是小写盘符；对外可见面必须统一成一种写法（大写盘符），否则消费者拿 listOpenEditors 的返回值去比就失配')
  f.collector.dispose()
})

test('★ T60 ①-2：白名单用**小写盘符**写（老 DSH）时也要命中 —— 收进来那一步就规范', () => {
  const f = fixture({ filter: { roots: ['D:/ws'], textMode: 'delta', files: ['d:/ws/a.txt'] } })
  f.collector.activate()
  f.open()
  // 走正文门：正文允许列表也来自 policy，若比较口径不一致，正文会被判成"别的文件"。
  const d = f.d
  d.text = 'abX'; d.version += 1
  f.fire('onDidChangeTextDocument', {
    document: d, contentChanges: [{ rangeOffset: 2, rangeLength: 1, text: 'X',
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } } }],
  })

  const change = f.delivered.filter((e) => e.type === 'documentChanged').at(-1)
  assert.ok(change, '白名单命中的文件必须有事件')
  assert.equal(change.payload.file, 'D:/ws/a.txt')
  assert.equal(change.payload.changes?.[0]?.text, 'X',
    '正文门用的是同一套比较：白名单命中的文件，正文不该被 strip 掉')
  f.collector.dispose()
})

test('★ T60 ①-3（反面控制）：白名单外的文件仍然被挡，且 tabsChanged 的 files 也是规范形态', () => {
  const f = fixture({ filter: { roots: ['D:/ws'], textMode: 'delta', files: ['D:/ws/a.txt'] } })
  f.collector.activate()

  f.fire('onDidOpenTextDocument', doc({ file: 'd:/ws/other.txt' }))
  assert.equal(f.delivered.filter((e) => e.type === 'documentOpened').length, 0,
    '不在白名单里的文件不许因为"统一形态"而漏进来')

  f.fire('onDidChangeTabs', { opened: [{ uris: [{ fsPath: HOST_PATH }], group: { viewColumn: 1 }, isPreview: false }], closed: [] })
  const tabs = f.delivered.filter((e) => e.type === 'tabsChanged').at(-1)
  assert.deepEqual(tabs.payload.opened[0].files, ['D:/ws/a.txt'],
    'tabsChanged 里的 files 同样是"对外可见路径"')
  f.collector.dispose()
})

test('★ T60 ①-4：canonicalPath 只在 win32 改盘符，且幂等（形态规则仅此一条）', () => {
  assert.equal(canonicalPath('d:/ws/a.txt', 'win32'), 'D:/ws/a.txt')
  assert.equal(canonicalPath('D:/ws/a.txt', 'win32'), 'D:/ws/a.txt')
  assert.equal(canonicalPath('d:/WS/A.TXT', 'win32'), 'D:/WS/A.TXT', '段名大小写不属于"形态"问题，一个字都不改')
  assert.equal(canonicalPath('d:/ws/a.txt', 'linux'), 'd:/ws/a.txt', 'POSIX 没有盘符，原样返回')
})

// ─────────────────────────────────────────────────────────────────────────────
// ② 版本自报
// ─────────────────────────────────────────────────────────────────────────────

test('★ T60 ②-1：EXTENSION_VERSION 与 package.json 同源（不是手写的第二份）', () => {
  assert.equal(EXTENSION_VERSION, manifest.version,
    'hello 自报的版本必须等于扩展清单版本；手写一份必然漂移（0.3.1 vs 0.3.2 就是这么来的）')
  assert.equal(readExtensionVersion(), manifest.version)
  // 清单在**模块目录的上一层**（源码 `src/` 与打包 `out/` 是同一个相对位置），不是模块目录自己里面。
  assert.equal(bridgePackageJsonPath(), join(here, '..', 'package.json'))
})

test('★ T60 ②-2：清单定位在源码布局（src/）与打包布局（out/）下都指向扩展根', () => {
  // 源码：src/version.js → <pkg>/package.json；打包：out/extension.cjs（__dirname = <pkg>/out）
  // → <pkg>/package.json。用临时目录把两种布局都摆出来验证，不依赖本仓库是否已经 build 过。
  const root = mkdtempSync(join(tmpdir(), 't60-version-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9-exp' }))
    for (const layout of ['src', 'out']) {
      const dir = join(root, layout)
      mkdirSync(dir)
      assert.equal(readExtensionVersion(bridgePackageJsonPath(dir)), '9.9.9-exp',
        `${layout}/ 布局下必须读到扩展根的清单`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('★ T60 ②-3：读不到清单时回 0.0.0-unknown，绝不回一个"看起来合理"的版本号', () => {
  assert.equal(readExtensionVersion(join(here, 'no-such-dir', 'package.json')), '0.0.0-unknown')
})

test('★ T60 ②-4：扩展清单版本是语义化版本，且 CLIENT_ID 未变（别顺手改身份）', () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.equal(CLIENT_ID, 'dsh-kit-bridge')
})
