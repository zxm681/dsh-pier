import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const packages = join(dirname(fileURLToPath(import.meta.url)), '../..')
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? sources(join(dir, e.name)) : e.isFile() && /\.[cm]?js$/.test(e.name) ? [join(dir, e.name)] : [])
}

test('T68 唯一 unlink 调用点：packages/*/src 全扫描，仅 removeCreatedInThisCall 且有双身份校验', () => {
  const files = readdirSync(packages, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => existsSync(join(packages, e.name, 'src')) ? sources(join(packages, e.name, 'src')) : [])
  assert.ok(files.length > 20, 'must scan all package sources')
  const hits = []
  const legacySyncRemovals = []
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    // 既有 discovery.js 的 rmSync 管理发现元数据，不在本卡改动内；不新增/放宽该面。
    assert.equal(/\b(?:rm|rmdir|copyFile|copyFileSync)\s*\(/.test(source), false,
      `${relative(packages, file)}: forbidden removal/copy call`)
    for (const m of source.matchAll(/\brmSync\s*\(/g)) legacySyncRemovals.push(relative(packages, file).replace(/\\/g, '/'))
    for (const m of source.matchAll(/\bunlink(?:Sync)?\s*\(/g)) hits.push({ file, source, at: m.index })
  }
  assert.deepEqual(legacySyncRemovals, Array(4).fill('dsh-vscode-kit/src/discovery.js'), 'no additional synchronous removal surface')
  assert.equal(hits.length, 1, 'exactly one unlink call in packages/*/src')
  const hit = hits[0]
  assert.equal(relative(packages, hit.file).replace(/\\/g, '/'), 'dsh-kit-bridge/src/vscode-host.js')
  const match = /async function removeCreatedInThisCall\(absPath, identity\) \{[\s\S]*?\n\}/.exec(hit.source)
  assert.ok(match, 'cleanup helper must remain private, identifiable and bounded')
  assert.ok(hit.at > match.index && hit.at < match.index + match[0].length, 'unlink must be inside cleanup helper')
  const body = match[0]
  assert.match(body, /lstat\(absPath, \{ bigint: true \}\)/)
  assert.match(body, /current\.dev !== identity\.dev \|\| current\.ino !== identity\.ino/)
  assert.match(body, /return \{ removed: false, reason: 'identity-changed' \}/)
  assert.ok(body.indexOf('identity-changed') < body.indexOf('fsp.unlink('), 'identity guard must precede unlink')
})

test('T68 清理只挂 createFileExclusive catch，先 close；无 mkdir/provider writeFile/成功路径清理', () => {
  const host = stripComments(readFileSync(join(packages, 'dsh-kit-bridge/src/vscode-host.js'), 'utf8'))
  const start = host.indexOf('  async function createFileExclusive(')
  const end = host.indexOf('\n  async function ensureDirectory(', start)
  const body = host.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.match(body, /fsp\.open\(absPath, 'wx'\)/)
  assert.doesNotMatch(body, /\bmkdir(?:Sync)?\s*\(|writeFile\s*\(/)
  const catchAt = body.indexOf('} catch (err)')
  const cleanAt = body.indexOf('removeCreatedInThisCall(')
  assert.ok(cleanAt > catchAt, 'cleanup must only be in createFile failure path')
  assert.ok(body.indexOf('await handle.close()', catchAt) < cleanAt, 'close before cleanup')
  const allCalls = [...host.matchAll(/\bremoveCreatedInThisCall\s*\(/g)]
  assert.equal(allCalls.length, 2, 'one declaration and exactly one private failure-path call')
})
