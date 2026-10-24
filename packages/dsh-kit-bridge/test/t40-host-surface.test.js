/**
 * 宿主注入面的**静态**守门（T40 的真实回归换来的一条测试，T44 扩了一条）。
 *
 * ## 为什么需要它
 *
 * `capabilities.js` 里所有宿主能力都是 `host.<field>(...)` 调用，而宿主对象是
 * `vscode-host.js` 里一个**手写的 `return {...}`**。这个形状没有任何类型约束：
 * 漏一个字段，单测**一定全绿**（每个测试自带假宿主，假宿主永远"什么都有"），
 * 而真机上是 `host.fileExists is not a function` 这种裸 TypeError ——
 * 它不会在 `openFile` 的前置检查里报出来，而是直接把整个能力打挂。
 *
 * 2026-10-24 就真发生了：T40 往返回面追加 `readFileBytes` / `confirmDelete` /
 * `deleteFile` 时把 `fileExists` 漏掉了，四门全绿，真机第一跑
 * `openFile:text`、`getDiagnostics:singleFile` 全红。**只有真机能抓到它**，
 * 而这条静态检查能把同类问题在单测阶段就抓住。
 *
 * ## 判据
 *
 * 1. `capabilities.js` 里出现的每个 `host.<name>` 都必须在 `vscode-host.js`
 *    的 `createHost` 返回面里登记（否则真机必抛 TypeError）。
 * 2. 反向也查一份**关键字段**清单：这几个字段是安全门的输入（信任、根目录、路径
 *    解析、磁盘 stat、字节读取、人工确认、归档本身），任何一个从返回面消失都必须变红——
 *    哪怕 `capabilities.js` 暂时没引用到（比如有人先注释掉调用再准备重构）。
 * 3. **（T44）宿主面不许有删除方法**，并且整个 `src/` 里不许出现删除调用。
 *    语义裁决已经改成"移进隔离区、永不删"，把 `deleteFile` 加回来（哪怕只是"暂时
 *    留着备用"）就等于把不可逆动作重新放回能力路径。
 *
 * 这是文本检查，不是类型检查：它挡的是"漏登记/偷偷加回来"，不挡语义写错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src')

const capabilitiesSrc = readFileSync(join(SRC, 'capabilities.js'), 'utf8')
const hostSrc = readFileSync(join(SRC, 'vscode-host.js'), 'utf8')

/** 从 `vscode-host.js` 里抽出 `createHost` 的返回面（手写对象）字段名。 */
function hostSurface() {
  // 定位 `return {` 块：以 `quarantineRename,` 那一行（T44 之后独有的标记）收敛，
  // 避免读到 `readDiskStat` 之类"函数内部的 return {"。
  const marker = '    quarantineRename,\n'
  const at = hostSrc.indexOf(marker)
  assert.ok(at > 0, 'vscode-host.js 的返回面里找不到 quarantineRename —— 是不是改了返回结构？')
  const open = hostSrc.lastIndexOf('  return {', at)
  assert.ok(open > 0, 'quarantineRename 前找不到 createHost 的 return {')
  const close = hostSrc.indexOf('\n  }\n', at)
  assert.ok(close > at, 'return { 块没有结束标记')
  const block = hostSrc.slice(open, close)
  const names = new Set()
  for (const line of block.split('\n')) {
    const m = /^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*[:,]/.exec(line)
    if (m) names.add(m[1])
  }
  return names
}

test('T40 宿主面：capabilities.js 用到的每个 host.<field> 都在宿主返回面里登记', () => {
  const provided = hostSurface()
  const used = new Set()
  for (const m of capabilitiesSrc.matchAll(/\bhost\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1])
  // `host.log` 是可选（`host.log ?? (()=>{})`），示例里也仍应登记。
  assert.ok(used.size >= 8, `解析出的宿主字段太少（${used.size}），检查正则是否失效`)

  const missing = [...used].filter((name) => !provided.has(name)).sort()
  assert.deepEqual(missing, [], `这些字段 capabilities.js 在用、宿主却没暴露：${missing.join(', ')}`)
})

test('T40 宿主面：安全门依赖的关键字段一个都不许从返回面消失', () => {
  const provided = hostSurface()
  const critical = [
    'fileExists',       // openFile 的存在性检查 + 归档前的原名占用判断
    'resolvePath',      // 路径解析（所有能力的入口）
    'workspaceRoots',   // 路径守卫的单根判据
    'isTrusted',        // 工作区信任（-32006）
    'readDocumentShape',
    'readDocumentState',
    'readRangeText',
    'applyEditText',
    'readDiskStat',     // T39 磁盘锚点
    'saveDocument',     // T39 落盘
    'readFileBytes',    // T40 内容快照
    'confirmDelete',    // T40 人工确认
    'quarantineRename', // T44 归档（唯一的"移动"）
    'ensureDirectory',  // T44 隔离目录
    'readFileIdentity', // T44 对象身份（(dev, ino)，不是 hash）
    'log',
  ]
  const missing = critical.filter((name) => !provided.has(name))
  assert.deepEqual(missing, [], `宿主返回面少了关键字段：${missing.join(', ')}`)
})

test('★ T44 宿主面**没有**删除方法，src/ 里也没有任何删除调用', () => {
  const provided = hostSurface()
  const banned = ['deleteFile', 'delete', 'del', 'rm', 'unlink', 'removeFile', 'trashFile']
  for (const name of banned) {
    assert.equal(provided.has(name), false, `宿主面不许暴露 ${name}（T44：只归档，不销毁）`)
  }

  // 静态面之外再扫一遍源码：宿主层/能力层只要出现删除调用就红。
  // 口径是"调用"，不是注释里的词 —— 所以每条都带 `(`，并且先剥掉注释。
  // （历史注释里确实还写着 `workspace.fs.delete`：那是解释"为什么不再这么做"的正文；
  //  剥注释就是为了让检查盯代码，不盯说明文。）
  const forbidden = /\bworkspace\.fs\.delete\b|\bunlink(?:Sync)?\s*\(|\brm(?:Sync)?\s*\(|\brmdir(?:Sync)?\s*\(/
  const files = readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()
  assert.ok(files.length > 3, `src/ 里只扫到 ${files.length} 个文件，检查目录`)
  for (const file of files) {
    let source = stripComments(readFileSync(join(SRC, file), 'utf8'))
    // T68 唯一窄口由跨 packages 的专用静态门逐点检查，其余禁令不变。
    if (file === 'vscode-host.js') {
      source = source.replace(/async function removeCreatedInThisCall\(absPath, identity\) \{[\s\S]*?\n\}/, '')
    }
    const hit = forbidden.exec(source)
    assert.equal(hit, null, `${file} 里出现了删除调用：${hit?.[0]}（T44：能力不许删任何字节）`)
  }
})

/** 剥掉块注释与行注释（只为上面的源码扫描服务，不是 JS 词法分析器）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}
