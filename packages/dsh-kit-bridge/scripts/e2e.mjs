/**
 * 真机 E2E：不打桩，跑真进程 + 真 TCP + 真打包产物。
 *
 * 和单测的区别很关键：
 *  - 单测在**同一进程**里用假 ctx / 假 host，验证逻辑；
 *  - 这里起**两个真实进程**（DSH 侧插件进程 + 扩展侧进程），中间只有 loopback TCP
 *    和真实发现文件。打样阶段最该验的就是「跨进程、跨运行时」这段，
 *    因为它最容易在单测里被同一进程的内存假象蒙住。
 *
 * 用法：node scripts/e2e.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here)
const kitRoot = join(pkgRoot, '..', 'dsh-vscode-kit')

const home = mkdtempSync(join(tmpdir(), 'dsh-kit-e2e-'))
const children = []
const log = (who, msg) => console.log(`[${who}] ${msg}`)

function launch(script, name, env = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: pkgRoot,
    env: { ...process.env, DSH_HOME: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // 累积全部输出：断言常常在事件发生之后才挂监听，只靠一次性监听会漏。
  child.output = ''
  children.push(child)
  child.stdout.on('data', (b) => {
    const s = String(b)
    child.output += s
    s.split('\n').filter(Boolean).forEach((l) => log(name, l))
  })
  child.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => log(name, `ERR ${l}`)))
  return child
}

/** 等 stdout 出现某行（或超时）。先查已累积输出，避免「事件早于监听」的竞态。 */
function waitLine(child, re, name, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (re.test(child.output)) return resolve()
    const t = setTimeout(() => {
      child.stdout.off('data', onData)
      reject(new Error(`${name}: timeout waiting for ${re}`))
    }, timeoutMs)
    const onData = () => {
      if (re.test(child.output)) { clearTimeout(t); child.stdout.off('data', onData); resolve() }
    }
    child.stdout.on('data', onData)
  })
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// ---- 两个 fixture：DSH 侧 / 扩展侧 ----
const dshSide = join(home, 'dsh-side.mjs')
writeFileSync(dshSide, `
import { apply } from '${toUrl(join(kitRoot, 'src/index.js'))}'
const ctx = {
  provide: (n, v) => { globalThis.__svc = v },
  effect: (fn) => { globalThis.__dispose = fn() },
}
const handle = apply(ctx, { dshHome: process.env.DSH_HOME, onLog: (lv, m) => console.log(lv + ': ' + m) })
await handle.boot
console.log('READY port=' + handle.kit.server.port)
// 对外暴露一个 RPC 入口让本脚本驱动：从 stdin 读命令
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', async (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    try {
      const r = await handle.kit.request(req.method, req.params ?? {}, { timeoutMs: 10000 })
      console.log('RESULT ' + JSON.stringify({ id: req.id, result: r }))
    } catch (e) {
      console.log('RESULT ' + JSON.stringify({ id: req.id, error: { code: e.code, message: e.message } }))
    }
  }
})
`)

const editorSide = join(home, 'editor-side.mjs')
writeFileSync(editorSide, `
import { createCapabilities } from '${toUrl(join(pkgRoot, 'src/capabilities.js'))}'
import { createConnector } from '${toUrl(join(pkgRoot, 'src/connector.js'))}'
// 假 VS Code 宿主：把“打开的文件”记到 stdout，供 E2E 断言
const host = {
  fileExists: () => true,
  resolvePath: (p) => (p.startsWith('/') ? p : '/ws/' + p),
  workspaceRoots: () => ['/ws'],
  isTrusted: () => true,
  openTextDocument: async (p, o) => console.log('OPENED ' + JSON.stringify({ path: p, ...o })),
  openExternalFile: async (p) => console.log('EXTERNAL ' + p),
  activeEditor: () => ({ file: '/ws/e2e.js', text: 'selected-text', start: { line: 4, character: 0 }, end: { line: 4, character: 13 }, isEmpty: false }),
  // 0-based：capabilities 层应转成 1-based（line 1 → 对外 2）
  collectDiagnostics: () => ([{ file: '/ws/e2e.js', diagnostics: [{ severity: 'error', line: 1, character: 3, message: 'e2e-err', source: 'e2e' }] }]),
  listEditors: () => ([
    { file: '/ws/e2e.js', isActive: true, isDirty: false, languageId: 'javascript' },
    { file: '/ws/other.js', isActive: false, isDirty: true },
  ]),
  log: (m) => console.log('host: ' + m),
}
const { dispatch } = createCapabilities(host)
const conn = createConnector({
  dispatch, dshHome: process.env.DSH_HOME, pollIntervalMs: 100,
  log: (m) => console.log('conn: ' + m),
  onStateChange: (s) => console.log('STATE ' + s.state + (s.port ? ' port=' + s.port : '')),
})
console.log('STATE ' + conn.state.state + ' (initial)')
conn.start()
// 关键：connector 的轮询定时器与 socket 都 unref() 了 —— 库不许延长宿主进程寿命。
// 真实宿主（VSCode 扩展宿主）自己就是长活的；这个 fixture 是裸 node，
// 必须自己挂一个 keepalive，否则 start() 之后进程立刻优雅退出。
setInterval(() => {}, 1000)
`)

function toUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '')
}

let dshProc
let edProc
try {
  log('e2e', `DSH_HOME=${home}`)

  // 1) 先起编辑器侧：它必须在没有 DSH 的情况下保持 idle（真实冷启动路径）
  edProc = launch(editorSide, 'editor')
  await waitLine(edProc, /STATE idle/, 'editor', 8000)
  check('无 DSH 时编辑器保持 idle 不崩', true)

  // 2) 起 DSH 侧
  dshProc = launch(dshSide, 'dsh')
  await waitLine(dshProc, /READY port=(\d+)/, 'dsh', 15000)
  check('DSH 侧插件启动并监听', true)

  // 3) 编辑器轮询应发现并连上
  await waitLine(edProc, /STATE ready/, 'editor', 15000)
  check('编辑器自动发现并连上 DSH（跨进程）', true)

  // 4) 发现文件确实是 0600 且字段齐全
  const [file] = (await import('node:fs')).readdirSync(join(home, 'dsh-vscode-kit'))
  const info = JSON.parse(readFileSync(join(home, 'dsh-vscode-kit', file), 'utf8'))
  check('发现文件字段齐全', !!(info.port && info.token && info.pid && info.protocolVersion === 1),
    `port=${info.port} proto=${info.protocolVersion}`)
  check('token 是 64 位 hex', /^[0-9a-f]{64}$/.test(info.token))

  // 5) 驱动：DSH 侧请求编辑器打开文件
  const opened = await rpc(dshProc, { id: 1, method: 'vscode.openFile', params: { path: 'e2e/target.txt', line: 7, column: 2 } })
  check('vscode.openFile 跨进程成功', opened.result?.opened === true, JSON.stringify(opened.result ?? opened.error))
  const openedLine = await waitLine(edProc, /OPENED/, 'editor', 5000).then(() => true, () => false)
  check('编辑器侧真的执行了打开动作', openedLine)

  // 6) 驱动：取选区
  const sel = await rpc(dshProc, { id: 2, method: 'vscode.getSelection' })
  check('vscode.getSelection 跨进程成功', sel.result?.text === 'selected-text',
    JSON.stringify(sel.result ?? sel.error))
  check('选区坐标 1-based', sel.result?.start?.line === 5 && sel.result?.start?.column === 1,
    JSON.stringify(sel.result?.start))

  // 7) 新能力：诊断与打开编辑器列表也要跨进程真通
  const diag = await rpc(dshProc, { id: 4, method: 'vscode.getDiagnostics', params: {} })
  check('vscode.getDiagnostics 跨进程成功',
    diag.result?.total === 1 && diag.result.files[0].diagnostics[0].line === 2,
    JSON.stringify(diag.result ?? diag.error))
  const editors = await rpc(dshProc, { id: 5, method: 'vscode.listOpenEditors', params: {} })
  check('vscode.listOpenEditors 跨进程成功',
    editors.result?.total === 2 && editors.result.editors.some((e) => e.isActive),
    JSON.stringify(editors.result ?? editors.error))

  // 8) 未实现能力 → -32005
  const bad = await rpc(dshProc, { id: 3, method: 'vscode.diff' })
  check('未实现能力回 -32005', bad.error?.code === -32005, JSON.stringify(bad.error))

  // 9) 杀掉 DSH 侧，编辑器应回到 idle 并可重连
  dshProc.kill()
  await new Promise((r) => setTimeout(r, 800))
  const dsh2 = launch(dshSide, 'dsh2')
  await waitLine(dsh2, /READY port=(\d+)/, 'dsh2', 15000)
  await waitLine(edProc, /STATE ready/, 'editor', 15000)
  check('DSH 重启后编辑器自动重连', true)
} catch (err) {
  check('E2E 未抛异常', false, err?.message ?? String(err))
} finally {
  for (const c of children) { try { c.kill() } catch { /* ignore */ } }
  rmSync(home, { recursive: true, force: true })
}

/** 通过 stdin 驱动 DSH 侧 fixture，返回 RESULT 行解析结果。 */
function rpc(child, req) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`rpc ${req.method} timed out`)), 12000)
    const onData = (b) => {
      const s = String(b)
      const m = s.match(/RESULT (\{.*\})/)
      if (!m) return
      const parsed = JSON.parse(m[1])
      if (parsed.id !== req.id) return
      clearTimeout(t)
      child.stdout.off('data', onData)
      resolve(parsed)
    }
    child.stdout.on('data', onData)
    child.stdin.write(JSON.stringify(req) + '\n')
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`)
process.exit(failed.length === 0 ? 0 : 1)
