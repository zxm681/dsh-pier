import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCapabilities, CAPABILITIES } from '../src/capabilities.js'
import { GrantStore } from '../../dsh-vscode-kit/src/grant.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../work/t68-fixtures')
fs.mkdirSync(fixtures, { recursive: true })
const root = fs.mkdtempSync(join(fixtures, 'bridge-'))
const api = {
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }] },
}
globalThis.__t68 = api
registerHooks({ resolve(spec, ctx, next) {
  if (spec !== 'vscode') return next(spec, ctx)
  return { shortCircuit: true, url: 'data:text/javascript,export const workspace=globalThis.__t68.workspace' }
} })
const { createHost } = await import('../src/vscode-host.js')
const grant = { id: 'a'.repeat(32), epoch: 'b'.repeat(32) }
let seq = 0
function env(options = {}) {
  const host = createHost()
  const calls = { create: 0 }
  const primitive = host.createFileExclusive
  host.createFileExclusive = (...args) => { calls.create++; return primitive(...args) }
  const link = {}
  const grants = new GrantStore()
  grants.adopt({ ...grant, link })
  if (options.roots) host.workspaceRoots = () => options.roots
  const caps = createCapabilities(host, { grants })
  const file = join(root, `new-${++seq}.txt`)
  const run = (extra = {}) => caps.dispatch('vscode.createFile', { file, text: '中文😀\r\n', expectedDisk: null, grant, ...extra }, { link })
  return { host, caps, run, file, link, calls }
}
const checkError = (code, reason) => (err) => {
  assert.equal(err.code, code)
  assert.equal(err.data?.reason, reason)
  return true
}
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('T68 正向：真实 wx 宿主，字段齐全、disk 实测、原文无损、不打开文档', async () => {
  const e = env()
  assert.ok(CAPABILITIES.includes('vscode.createFile'))
  const result = await e.run()
  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'created', 'disk', 'file'])
  assert.equal(result.created, true)
  assert.equal(result.file, e.file)
  assert.equal(result.bytes, Buffer.byteLength('中文😀\r\n'))
  assert.equal(result.disk.size, result.bytes)
  const st = fs.statSync(e.file)
  assert.deepEqual(result.disk, { mtime: Math.floor(st.mtimeMs), size: st.size })
  assert.equal(fs.readFileSync(e.file, 'utf8'), '中文😀\r\n')
  assert.equal(e.calls.create, 1)
})

test('T68 已存在不覆盖：原文件 sha256 不变（wx 不是 w）', async () => {
  const e = env()
  fs.writeFileSync(e.file, 'USER_DATA', { flag: 'wx' })
  const before = hash(e.file)
  await assert.rejects(e.run(), checkError(-32013, 'exists'))
  assert.equal(hash(e.file), before, 'existing sha256 must not change')
})

test('T68 parent-missing：路径守卫拒且目录确实没有创建、宿主零调用', async () => {
  const e = env()
  const parent = join(root, `missing-${++seq}`)
  await assert.rejects(e.run({ file: join(parent, 'x.txt') }), checkError(-32602, 'parent-missing'))
  assert.equal(fs.existsSync(parent), false)
  assert.equal(e.calls.create, 0)
})

test('T68 宿主也绝不 mkdir：直接缺父目录 → parent-missing、无目录残件', async () => {
  const parent = join(root, `direct-missing-${++seq}`)
  await assert.rejects(createHost().createFileExclusive(join(parent, 'x.txt'), Buffer.from('x')),
    checkError(-32602, 'parent-missing'))
  assert.equal(fs.existsSync(parent), false, 'parent must remain absent')
})

test('T68 1 MiB UTF-8 正好通过，+1 字节拒且宿主零调用', async () => {
  const e = env()
  const text = '界'.repeat(349525) + 'a'
  assert.equal(Buffer.byteLength(text), 1024 * 1024)
  const result = await e.run({ text })
  assert.equal(result.bytes, 1024 * 1024)
  const over = env()
  await assert.rejects(over.run({ text: text + 'a' }), checkError(-32602, 'payload-too-large'))
  assert.equal(over.calls.create, 0)
  assert.equal(fs.existsSync(over.file), false)
})

test('T68 text 必填字符串但允许空串；孤立代理项拒绝，不替换 U+FFFD', async () => {
  const e = env()
  assert.equal((await e.run({ text: '' })).disk.size, 0)
  for (const text of [undefined, null, 3, {}, '\ud800', '\udc00', '\ud800x']) {
    const bad = env()
    await assert.rejects(bad.run({ text }), checkError(-32602,
      typeof text === 'string' ? 'not-encodable' : 'text-not-a-string'))
    assert.equal(bad.calls.create, 0)
  }
})

test('T68 expectedDisk 缺失与非 null 一律拒，宿主零调用', async () => {
  for (const expectedDisk of [undefined, {}, { mtime: 0, size: 0 }, false, 0]) {
    const e = env()
    await assert.rejects(e.run({ expectedDisk }), checkError(-32602,
      expectedDisk === undefined ? 'expected-disk-missing' : 'expected-disk-not-null'))
    assert.equal(e.calls.create, 0)
  }
})

test('T68 symlink/junction 父目录与链接末段拒，宿主零调用', async () => {
  const target = join(root, `target-${++seq}`)
  fs.mkdirSync(target)
  const linkDir = join(root, `link-${++seq}`)
  fs.symlinkSync(target, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
  for (const file of [linkDir, join(linkDir, 'x.txt')]) {
    const e = env()
    await assert.rejects(e.run({ file }), checkError(-32602, 'symlink'))
    assert.equal(e.calls.create, 0)
  }
})

test('T68 根外/UNC/多根拒绝，宿主零调用，reason 沿用既有集合', async () => {
  const e = env()
  for (const file of [join(root, '..', 'outside.txt'), '//localhost/C$/outside.txt']) {
    await assert.rejects(e.run({ file }), checkError(-32602, 'outside-workspace'))
  }
  const multi = env({ roots: [root, join(root, 'other')] })
  await assert.rejects(multi.run(), checkError(-32603, 'multi-root'))
  assert.equal(e.calls.create + multi.calls.create, 0)
})

test('T68 根 junction 拒 link-root，realpath 段名变化拒 alias（含短名映射）', async (t) => {
  const linkRoot = join(root, `root-link-${++seq}`)
  const rootTarget = join(root, `root-target-${++seq}`)
  fs.mkdirSync(rootTarget)
  fs.symlinkSync(rootTarget, linkRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const linked = env({ roots: [linkRoot] })
  await assert.rejects(linked.run({ file: join(linkRoot, 'new.txt') }), checkError(-32602, 'link-root'))
  assert.equal(linked.calls.create, 0)
  const realpath = fs.realpathSync
  t.mock.method(fs, 'realpathSync', (p) => p === root ? join(root, 'different-segment') : realpath(p))
  const aliased = env()
  await assert.rejects(aliased.run(), checkError(-32602, 'alias'))
  assert.equal(aliased.calls.create, 0)
})

test('T68 缺 grant → -32010 data.missing=grant，宿主零调用', async () => {
  const e = env()
  await assert.rejects(e.run({ grant: undefined }), (err) => {
    assert.equal(err.code, -32010)
    assert.equal(err.data?.missing, 'grant')
    return true
  })
  assert.equal(e.calls.create, 0)
  await assert.rejects(createCapabilities(e.host).dispatch('vscode.createFile', {
    file: e.file, text: '', expectedDisk: null,
  }, { link: e.link }), (err) => err.code === -32010 && err.data?.missing === 'grant')
  assert.equal(e.calls.create, 0)
})

// 注入真实 FileHandle 的 write/sync/close 失败；其余步骤仍用真实 fs。
function faultOpen(t, fault) {
  const open = fsp.open.bind(fsp)
  t.mock.method(fsp, 'open', async (...args) => {
    const handle = await open(...args)
    return fault(handle, args[0])
  })
}

test('T68 失败清理：写入部分字节后失败，先 close 再清理，路径不存在', async (t) => {
  let closed = false
  faultOpen(t, (h) => ({
    stat: (...a) => h.stat(...a), sync: () => h.sync(),
    write: async (...a) => { await h.write(...a); throw Object.assign(new Error('injected-write-failure'), { code: 'EIO' }) },
    close: async () => { await h.close(); closed = true },
  }))
  const lstat = fsp.lstat.bind(fsp)
  t.mock.method(fsp, 'lstat', (...args) => { assert.equal(closed, true, 'close must precede cleanup lstat'); return lstat(...args) })
  const e = env()
  await assert.rejects(e.run(), (err) => {
    assert.equal(err.code, -32603)
    assert.equal(err.data?.hostCode, 'EIO')
    assert.deepEqual(err.data?.cleanup, { removed: true })
    return true
  })
  assert.equal(fs.existsSync(e.file), false, 'failed creation must be absent')
})

test('T68 身份被替换不删：dev/ino 任何一个变化 → identity-changed', async (t) => {
  faultOpen(t, (h, file) => ({
    stat: (...a) => h.stat(...a), sync: () => h.sync(),
    write: async () => { throw Object.assign(new Error('injected-write-failure'), { code: 'EIO' }) },
    close: async () => {
      await h.close()
      fs.renameSync(file, file + '.failed-original')
      fs.writeFileSync(file, 'REPLACEMENT_USER_DATA', { flag: 'wx' })
    },
  }))
  const e = env()
  await assert.rejects(e.run(), (err) => {
    assert.deepEqual(err.data?.cleanup, { removed: false, reason: 'identity-changed' })
    return true
  })
  assert.equal(fs.readFileSync(e.file, 'utf8'), 'REPLACEMENT_USER_DATA', 'replacement must not be removed')
})

for (const field of ['dev', 'ino']) {
  test(`T68 清理必须同时校验 dev 与 ino：仅 ${field} 变化也不删`, async (t) => {
    faultOpen(t, (h) => ({
      stat: (...a) => h.stat(...a), sync: () => h.sync(),
      write: async () => { throw new Error('injected') }, close: () => h.close(),
    }))
    const lstat = fsp.lstat.bind(fsp)
    t.mock.method(fsp, 'lstat', async (...args) => {
      const st = await lstat(...args)
      return { ...st, [field]: st[field] + 1n }
    })
    const e = env()
    await assert.rejects(e.run(), (err) => {
      assert.equal(err.data?.cleanup?.reason, 'identity-changed')
      return true
    })
    assert.equal(fs.existsSync(e.file), true)
  })
}

test('T68 sync/close 异常同样进入失败清理；成功路径不清理', async (t) => {
  for (const phase of ['sync', 'close']) {
    const sub = await t.test(phase, async (s) => {
      faultOpen(s, (h) => ({
        stat: (...a) => h.stat(...a), write: (...a) => h.write(...a),
        sync: async () => { if (phase === 'sync') throw new Error('injected-sync'); await h.sync() },
        close: async () => { await h.close(); if (phase === 'close') throw new Error('injected-close') },
      }))
      const e = env()
      await assert.rejects(e.run(), (err) => err.data?.cleanup?.removed === true)
      assert.equal(fs.existsSync(e.file), false)
    })
    void sub
  }
})

test('T68 fstat/清理失败诚实回报，不在拿不到身份时删除', async (t) => {
  await t.test('fstat-failed', async (s) => {
    let closed = false
    faultOpen(s, (h) => ({
      stat: async () => { throw new Error('injected-fstat') },
      close: async () => { await h.close(); closed = true },
    }))
    const e = env()
    await assert.rejects(e.run(), (err) => {
      assert.equal(err.data?.cleanup?.reason, 'identity-unavailable')
      return true
    })
    assert.equal(closed, true)
    assert.equal(fs.existsSync(e.file), true)
  })
  await t.test('lstat-failed', async (s) => {
    faultOpen(s, (h) => ({
      stat: (...a) => h.stat(...a), close: () => h.close(),
      write: async () => { throw new Error('injected-write') },
    }))
    s.mock.method(fsp, 'lstat', async () => { throw Object.assign(new Error('injected-lstat'), { code: 'EACCES' }) })
    const e = env()
    await assert.rejects(e.run(), (err) => {
      assert.deepEqual(err.data?.cleanup, { removed: false, reason: 'cleanup-failed', hostCode: 'EACCES' })
      return true
    })
    assert.equal(fs.existsSync(e.file), true)
  })
})

test('T68 短写必须写完整再 fsync；同路径并发仅一次成功', async (t) => {
  faultOpen(t, (h) => ({
    stat: (...a) => h.stat(...a), sync: () => h.sync(), close: () => h.close(),
    write: (bytes, offset, length, position) => h.write(bytes, offset, Math.min(2, length), position),
  }))
  const e = env()
  const results = await Promise.allSettled([e.run(), e.run()])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.find((r) => r.status === 'rejected').reason.data.reason, 'exists')
  assert.equal(fs.readFileSync(e.file, 'utf8'), '中文😀\r\n')
})
